// SDL_GPU encoding of `createSsaoTask` frames. Dawn's twin is
// pal_dawn_scene_ssao.cpp; the plan walk both share is pal_gpu_ssao.hpp.
#include "pal_gpu_common.hpp"
#include "pal_gpu_ssao.hpp"
#include <bblite/features/has_ssao.hpp>

#include "pal_sdl_gpu_scene.hpp"

#if BBLITE_HAS_SSAO
#include "pal_sdl_gpu_compute_pipeline.hpp"
#include "pal_sdl_gpu_timestamp.hpp"

#include <cstring>
#include <map>
#include <optional>
#include <string>
#include <utility>

namespace bbl::pal {
inline namespace sdl_scene {

namespace {

/** One plan program on this device. */
struct SdlSsaoProgram {
    std::shared_ptr<SdlComputePipeline> compute;
    OwnedSdlPipeline render{nullptr, {nullptr}};
    PinnedStageSlots vertex_slots;
    PinnedStageSlots fragment_slots;
};

/**
 * One task's owned textures and buffers, by their plan index, made for its
 * source extent as the modes it ran first used them: a mode switch keeps
 * what both modes use.
 */
struct SdlSsaoTask {
    SsaoTaskTracking tracking;
    std::vector<SDL_GPUTexture*> textures;
    std::vector<SsaoTextureExtent> extents;
    /**
     * Single-level copies of chained textures, by texture and level. SDL_GPU
     * binds whole textures, so a pass that reads one level of a chain -- the
     * pin's `createView({ baseMipLevel, mipLevelCount: 1 })` -- reads a copy
     * of that level, made right before the pass; texel copies are exact.
     */
    std::vector<std::vector<SDL_GPUTexture*>> level_copies;
    std::vector<SDL_GPUBuffer*> buffers;
    std::vector<std::uint32_t> buffer_bytes;
};

} // namespace

struct GpuSsaoState {
    SDL_GPUDevice* device = nullptr;
    std::vector<std::optional<SdlSsaoProgram>> programs;
    std::vector<SDL_GPUSampler*> samplers;
    /** Bound with a texture the stage reads through `textureLoad` only. */
    SDL_GPUSampler* fallback = nullptr;
    /** `enablePbrSsao`'s neutral visibility (a 1x1 white texture) and `getNearestSampler`. */
    SDL_GPUTexture* neutral = nullptr;
    SDL_GPUSampler* nearest = nullptr;
    /** Zeros a buffer clear uploads; never written after it is filled. */
    SDL_GPUTransferBuffer* zeros = nullptr;
    std::uint32_t zero_bytes = 0;
    std::vector<SdlSsaoTask> tasks;
    std::uint64_t identities = 0;

    explicit GpuSsaoState(SDL_GPUDevice* value) : device(value) {}
    GpuSsaoState(const GpuSsaoState&) = delete;
    GpuSsaoState& operator=(const GpuSsaoState&) = delete;
    ~GpuSsaoState() {
        for (SdlSsaoTask& task : tasks)
            release_resources(task);
        for (SDL_GPUSampler* sampler : samplers)
            if (sampler)
                SDL_ReleaseGPUSampler(device, sampler);
        if (fallback)
            SDL_ReleaseGPUSampler(device, fallback);
        if (neutral)
            SDL_ReleaseGPUTexture(device, neutral);
        if (nearest)
            SDL_ReleaseGPUSampler(device, nearest);
        if (zeros)
            SDL_ReleaseGPUTransferBuffer(device, zeros);
    }

    void release_resources(SdlSsaoTask& task) {
        for (SDL_GPUTexture* texture : task.textures)
            if (texture)
                SDL_ReleaseGPUTexture(device, texture);
        for (auto& levels : task.level_copies)
            for (SDL_GPUTexture* texture : levels)
                if (texture)
                    SDL_ReleaseGPUTexture(device, texture);
        for (SDL_GPUBuffer* buffer : task.buffers)
            if (buffer)
                SDL_ReleaseGPUBuffer(device, buffer);
        task.textures.clear();
        task.level_copies.clear();
        task.extents.clear();
        task.buffers.clear();
        task.buffer_bytes.clear();
    }
};

namespace {

SDL_GPUTextureFormat ssao_format(std::string_view name) {
    for (const SdlNamedTextureFormat& entry : sdl_webgpu_formats)
        if (entry.name == name)
            return entry.format;
    throw std::runtime_error("SSAO texture format '" + std::string(name) +
                             "' has no SDL_GPU format.");
}

bool integer_format(std::string_view name) {
    return name.ends_with("uint") || name.ends_with("sint");
}

/**
 * How a texture the pin binds for sampling reads in SDL_GPU: integer
 * textures load through storage-texture slots, which SDL_GPU does not admit
 * beside sampler usage.
 */
SDL_GPUTextureUsageFlags ssao_read_usage(std::string_view format) {
    return integer_format(format) ? SDL_GPU_TEXTUREUSAGE_COMPUTE_STORAGE_READ |
                                        SDL_GPU_TEXTUREUSAGE_GRAPHICS_STORAGE_READ
                                  : SDL_GPU_TEXTUREUSAGE_SAMPLER;
}

/**
 * The pin's `GPUTextureUsage` bits as SDL_GPU usages; every texture is a
 * colour target too, so it starts cleared as WebGPU's zero-initialized
 * textures do.
 */
SDL_GPUTextureUsageFlags ssao_usage(const upstream::SsaoTextureInfo& texture) {
    SDL_GPUTextureUsageFlags usage = 0;
    if (texture.usage & 4u)
        usage |= ssao_read_usage(texture.format);
    if (texture.usage & 8u)
        usage |= SDL_GPU_TEXTUREUSAGE_COMPUTE_STORAGE_WRITE;
    if (texture.usage & 16u || texture.format != "rgba32float")
        usage |= SDL_GPU_TEXTUREUSAGE_COLOR_TARGET;
    return usage;
}

/** The pin's `GPUBufferUsage` bits as SDL_GPU usages: STORAGE reads in every stage and writes in compute. */
SDL_GPUBufferUsageFlags ssao_buffer_usage(const upstream::SsaoBufferInfo& buffer) {
    SDL_GPUBufferUsageFlags usage = 0;
    if (buffer.usage & 128u)
        usage |= SDL_GPU_BUFFERUSAGE_COMPUTE_STORAGE_READ |
                 SDL_GPU_BUFFERUSAGE_COMPUTE_STORAGE_WRITE |
                 SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ;
    if (buffer.usage & 256u)
        usage |= SDL_GPU_BUFFERUSAGE_INDIRECT;
    return usage;
}

SDL_GPUTexture* create_ssao_texture(SDL_GPUDevice* device, std::string_view format,
                                    SDL_GPUTextureUsageFlags usage, std::uint32_t width,
                                    std::uint32_t height, std::uint32_t levels) {
    SDL_GPUTextureCreateInfo info{};
    info.type = SDL_GPU_TEXTURETYPE_2D;
    info.format = ssao_format(format);
    info.usage = usage;
    info.width = width;
    info.height = height;
    info.layer_count_or_depth = 1;
    info.num_levels = levels;
    info.sample_count = SDL_GPU_SAMPLECOUNT_1;
    SDL_GPUTexture* texture = SDL_CreateGPUTexture(device, &info);
    if (!texture)
        gpu_error("SDL_CreateGPUTexture SSAO");
    return texture;
}

/** Uploads zeros over a buffer's first `bytes`: WebGPU's zero-initialized buffer and `clearBuffer`. */
void clear_ssao_buffer(GpuSsaoState& ssao, SDL_GPUCommandBuffer* command, SDL_GPUBuffer* buffer,
                       std::uint32_t bytes) {
    if (ssao.zero_bytes < bytes) {
        if (ssao.zeros)
            SDL_ReleaseGPUTransferBuffer(ssao.device, ssao.zeros);
        SDL_GPUTransferBufferCreateInfo info{};
        info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD;
        info.size = bytes;
        ssao.zeros = SDL_CreateGPUTransferBuffer(ssao.device, &info);
        if (!ssao.zeros)
            gpu_error("SDL_CreateGPUTransferBuffer SSAO zeros");
        void* mapped = SDL_MapGPUTransferBuffer(ssao.device, ssao.zeros, false);
        if (!mapped)
            gpu_error("SDL_MapGPUTransferBuffer SSAO zeros");
        std::memset(mapped, 0, bytes);
        SDL_UnmapGPUTransferBuffer(ssao.device, ssao.zeros);
        ssao.zero_bytes = bytes;
    }
    SdlCopyPass pass{SDL_BeginGPUCopyPass(command)};
    if (!pass)
        gpu_error("SDL_BeginGPUCopyPass SSAO buffer clear");
    SDL_GPUTransferBufferLocation from{};
    from.transfer_buffer = ssao.zeros;
    SDL_GPUBufferRegion to{};
    to.buffer = buffer;
    to.size = bytes;
    SDL_UploadToGPUBuffer(pass, &from, &to, false);
    pass.end();
}

/**
 * Every texture and buffer the mode uses, made where missing: a resize
 * replaces them all, each colour-target level and buffer starting cleared.
 */
void prepare_ssao_resources(GpuSsaoState& ssao, SdlSsaoTask& task,
                            const upstream::SsaoPlanInfo& plan, const upstream::SsaoModeInfo& mode,
                            SDL_GPUCommandBuffer* command, std::uint32_t width,
                            std::uint32_t height, bool resized) {
    if (resized || task.textures.size() != plan.textures.size()) {
        ssao.release_resources(task);
        task.textures.assign(plan.textures.size(), nullptr);
        task.level_copies.resize(plan.textures.size());
        task.buffers.assign(plan.buffers.size(), nullptr);
        task.buffer_bytes.assign(plan.buffers.size(), 0u);
        for (const upstream::SsaoTextureInfo& info : plan.textures)
            task.extents.push_back(ssao_texture_extent(info, width, height));
    }
    for (const std::uint32_t index : mode.textures) {
        if (task.textures[index])
            continue;
        const upstream::SsaoTextureInfo& info = plan.textures[index];
        const SsaoTextureExtent& extent = task.extents[index];
        const SDL_GPUTextureUsageFlags usage = ssao_usage(info);
        SDL_GPUTexture* texture = create_ssao_texture(ssao.device, info.format, usage, extent.width,
                                                      extent.height, extent.levels);
        task.textures[index] = texture;
        task.level_copies[index].assign(extent.levels, nullptr);
        if (!(usage & SDL_GPU_TEXTUREUSAGE_COLOR_TARGET))
            continue;
        for (std::uint32_t level = 0; level < extent.levels; ++level) {
            SDL_GPUColorTargetInfo clear{};
            clear.texture = texture;
            clear.mip_level = level;
            clear.load_op = SDL_GPU_LOADOP_CLEAR;
            clear.store_op = SDL_GPU_STOREOP_STORE;
            SdlRenderPass pass{SDL_BeginGPURenderPass(command, &clear, 1, nullptr)};
            pass.end();
        }
    }
    const SsaoTextureExtent working = ssao_working_extent(mode, width, height);
    for (const std::uint32_t index : mode.buffers) {
        const std::uint32_t bytes = ssao_buffer_bytes(plan.buffers[index], working);
        if (task.buffers[index] && task.buffer_bytes[index] == bytes)
            continue;
        if (task.buffers[index])
            SDL_ReleaseGPUBuffer(ssao.device, task.buffers[index]);
        SDL_GPUBufferCreateInfo info{};
        info.usage = ssao_buffer_usage(plan.buffers[index]);
        info.size = bytes;
        task.buffers[index] = SDL_CreateGPUBuffer(ssao.device, &info);
        if (!task.buffers[index])
            gpu_error("SDL_CreateGPUBuffer SSAO");
        task.buffer_bytes[index] = bytes;
        clear_ssao_buffer(ssao, command, task.buffers[index], bytes);
    }
}

SDL_GPUSampler* ssao_sampler(GpuSsaoState& ssao, std::uint32_t index) {
    if (ssao.samplers.size() <= index)
        ssao.samplers.resize(index + 1u, nullptr);
    if (ssao.samplers[index])
        return ssao.samplers[index];
    const upstream::SsaoSamplerInfo& info = upstream::ssao_sampler_infos[index];
    SDL_GPUSamplerCreateInfo sampler{};
    sampler.min_filter = info.min_linear ? SDL_GPU_FILTER_LINEAR : SDL_GPU_FILTER_NEAREST;
    sampler.mag_filter = info.mag_linear ? SDL_GPU_FILTER_LINEAR : SDL_GPU_FILTER_NEAREST;
    sampler.mipmap_mode = SDL_GPU_SAMPLERMIPMAPMODE_NEAREST;
    sampler.address_mode_u = sampler.address_mode_v = sampler.address_mode_w =
        SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
    sampler.max_lod = 32.0f; // WebGPU's GPUSamplerDescriptor default.
    ssao.samplers[index] = SDL_CreateGPUSampler(ssao.device, &sampler);
    if (!ssao.samplers[index])
        gpu_error("SDL_CreateGPUSampler SSAO");
    return ssao.samplers[index];
}

SDL_GPUSampler* fallback_sampler(GpuSsaoState& ssao) {
    if (!ssao.fallback) {
        SDL_GPUSamplerCreateInfo sampler{};
        sampler.address_mode_u = sampler.address_mode_v = sampler.address_mode_w =
            SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
        ssao.fallback = SDL_CreateGPUSampler(ssao.device, &sampler);
        if (!ssao.fallback)
            gpu_error("SDL_CreateGPUSampler SSAO texture load");
    }
    return ssao.fallback;
}

const SdlSsaoProgram& ssao_program(GpuSsaoState& ssao, std::uint32_t index) {
    if (ssao.programs.size() <= index)
        ssao.programs.resize(index + 1u);
    std::optional<SdlSsaoProgram>& slot = ssao.programs[index];
    if (slot)
        return *slot;
    const upstream::SsaoProgramInfo& info = upstream::ssao_program_infos[index];
    SdlSsaoProgram program;
    if (info.compute) {
        program.compute = load_sdl_gpu_compute_pipeline(ssao.device, std::string(info.stem),
                                                        std::string(info.entry));
    } else {
        program.vertex_slots = read_pinned_stage_slots(std::string(info.vertex_stem));
        program.fragment_slots = read_pinned_stage_slots(std::string(info.stem));
        auto vertex = load_shader(ssao.device, std::string(info.vertex_stem),
                                  SDL_GPU_SHADERSTAGE_VERTEX, program.vertex_slots);
        auto fragment = load_shader(ssao.device, std::string(info.stem),
                                    SDL_GPU_SHADERSTAGE_FRAGMENT, program.fragment_slots);
        std::vector<SDL_GPUColorTargetDescription> targets;
        for (const std::string_view format : info.targets) {
            SDL_GPUColorTargetDescription target{};
            target.format = ssao_format(format);
            targets.push_back(target);
        }
        SDL_GPUGraphicsPipelineCreateInfo pipeline{};
        pipeline.vertex_shader = vertex.get();
        pipeline.fragment_shader = fragment.get();
        pipeline.primitive_type = SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
        pipeline.rasterizer_state.fill_mode = SDL_GPU_FILLMODE_FILL;
        pipeline.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_NONE;
        pipeline.multisample_state.sample_count = SDL_GPU_SAMPLECOUNT_1;
        pipeline.target_info.color_target_descriptions = targets.data();
        pipeline.target_info.num_color_targets = static_cast<Uint32>(targets.size());
        program.render = OwnedSdlPipeline{
            create_sdl_gpu_graphics_pipeline(ssao.device, vertex, &pipeline), {ssao.device}};
        if (!program.render)
            gpu_error("SDL_CreateGPUGraphicsPipeline SSAO");
    }
    slot = std::move(program);
    return *slot;
}

/** The layout entry of a program's binding. */
std::size_t layout_index(const upstream::SsaoProgramInfo& program, std::uint32_t group,
                         std::uint32_t binding) {
    if (group == 0)
        for (std::size_t index = 0; index < program.layout.size(); ++index)
            if (program.layout[index].binding == binding)
                return index;
    throw std::runtime_error("An SSAO stage reads group " + std::to_string(group) + " binding " +
                             std::to_string(binding) + ", which its plan does not lay out.");
}

/** The task's sources a frame reads: depth, and the normal and velocity inputs it has. */
struct SdlSsaoSources {
    SDL_GPUTexture* depth = nullptr;
    SDL_GPUTexture* normal = nullptr;
    SDL_GPUTexture* velocity = nullptr;
};

/** Encodes one plan frame of one task into a command buffer. */
class SdlSsaoEncoder {
public:
    SdlSsaoEncoder(GpuSsaoState& ssao, SdlSsaoTask& task, const upstream::SsaoPlanInfo& plan,
                   const upstream::SsaoModeInfo& mode, const SsaoFrameDecision& decision,
                   SDL_GPUCommandBuffer* command, const SdlSsaoSources& sources,
                   const SsaoTextureExtent& working)
        : ssao_(ssao), task_(task), plan_(plan), mode_(mode), decision_(decision),
          command_(command), sources_(sources), working_(working) {}

    void pass(const upstream::SsaoPassInfo& pass, std::uint32_t level) {
        switch (pass.stage) {
        case upstream::SsaoPassStage::compute:
            compute(pass, level);
            return;
        case upstream::SsaoPassStage::render:
        case upstream::SsaoPassStage::clear:
            render(pass, level);
            return;
        case upstream::SsaoPassStage::clear_buffer: {
            const auto index = static_cast<std::size_t>(pass.buffer);
            clear_ssao_buffer(ssao_, command_, task_.buffers.at(index),
                              task_.buffer_bytes.at(index));
            return;
        }
        }
    }

private:
    GpuSsaoState& ssao_;
    SdlSsaoTask& task_;
    const upstream::SsaoPlanInfo& plan_;
    const upstream::SsaoModeInfo& mode_;
    const SsaoFrameDecision& decision_;
    SDL_GPUCommandBuffer* command_;
    SdlSsaoSources sources_;
    SsaoTextureExtent working_;
    StageTextureBindingScratch texture_scratch_;
    std::vector<SDL_GPUBuffer*> storage_scratch_;

    SsaoResolvedView view(std::uint32_t index, std::uint32_t level) const {
        return resolve_ssao_view(mode_, index, level, task_.extents);
    }

    SDL_GPUBuffer* buffer(const upstream::SsaoResourceInfo& resource) const {
        if (resource.kind != upstream::SsaoResourceKind::buffer)
            throw std::runtime_error("An SSAO stage binds a non-buffer at a storage buffer slot.");
        return task_.buffers.at(resource.index);
    }

    /** The texture a read binds: a source, an owned texture, or a level's copy. */
    SDL_GPUTexture* read_texture(const SsaoResolvedView& view) {
        switch (view.source) {
        case upstream::SsaoTextureSource::depth:
            return sources_.depth;
        case upstream::SsaoTextureSource::normal:
            if (!sources_.normal)
                throw std::runtime_error("An SSAO pass reads a normal input the task has none of.");
            return sources_.normal;
        case upstream::SsaoTextureSource::velocity:
            if (!sources_.velocity)
                throw std::runtime_error(
                    "An SSAO pass reads a velocity input the task has none of.");
            return sources_.velocity;
        case upstream::SsaoTextureSource::owned:
            break;
        }
        if (!view.single_level_of_chain) {
            if (view.base_mip != 0)
                throw std::runtime_error("An SSAO pass reads a chain from a level past its first.");
            return task_.textures.at(view.texture);
        }
        SDL_GPUTexture*& copy = task_.level_copies.at(view.texture).at(view.base_mip);
        const upstream::SsaoTextureInfo& info = plan_.textures[view.texture];
        const SsaoTextureExtent extent =
            ssao_level_extent(task_.extents[view.texture], view.base_mip);
        if (!copy)
            copy = create_ssao_texture(ssao_.device, info.format, ssao_read_usage(info.format),
                                       extent.width, extent.height, 1u);
        SDL_GPUTextureLocation from{};
        from.texture = task_.textures.at(view.texture);
        from.mip_level = view.base_mip;
        SDL_GPUTextureLocation to{};
        to.texture = copy;
        SdlCopyPass pass{SDL_BeginGPUCopyPass(command_)};
        if (!pass)
            gpu_error("SDL_BeginGPUCopyPass SSAO level");
        SDL_CopyGPUTextureToTexture(pass, &from, &to, extent.width, extent.height, 1, false);
        pass.end();
        return copy;
    }

    /** A written view: an owned texture's level. */
    std::pair<SDL_GPUTexture*, std::uint32_t> write_target(const SsaoResolvedView& view) const {
        if (view.source != upstream::SsaoTextureSource::owned || view.mip_count != 1u)
            throw std::runtime_error(
                "An SSAO pass writes other than one level of its own texture.");
        return {task_.textures.at(view.texture), view.base_mip};
    }

    std::span<const float> uniform(const upstream::SsaoResourceInfo& resource,
                                   std::size_t& bytes) const {
        const auto block = static_cast<upstream::SsaoUniformBlock>(resource.index);
        for (const upstream::SsaoUniformInfo& info : plan_.uniforms)
            if (info.block == block) {
                bytes = info.bytes;
                return ssao_uniform_block(decision_, block);
            }
        throw std::runtime_error("An SSAO pass binds a uniform block its plan does not write.");
    }

    void compute(const upstream::SsaoPassInfo& pass, std::uint32_t level) {
        const upstream::SsaoProgramInfo& info = upstream::ssao_program_infos[pass.program];
        const SdlComputePipeline& pipeline = *ssao_program(ssao_, pass.program).compute;
        std::vector<SDL_GPUTextureSamplerBinding> sampled(pipeline.counts[0],
                                                          {nullptr, fallback_sampler(ssao_)});
        std::vector<SDL_GPUTexture*> readonly(pipeline.counts[1], nullptr);
        std::vector<SDL_GPUBuffer*> readonly_buffers(pipeline.counts[2], nullptr);
        std::vector<SDL_GPUStorageTextureReadWriteBinding> writable(pipeline.counts[3]);
        std::vector<SDL_GPUStorageBufferReadWriteBinding> writable_buffers(pipeline.counts[4]);
        for (const SdlComputeSlot& slot : pipeline.slots) {
            if (slot.workgroup_counts)
                throw std::runtime_error("An SSAO compute stage reads its workgroup counts.");
            const std::size_t entry = layout_index(info, slot.group, slot.binding);
            const upstream::SsaoResourceInfo& resource = pass.resources[entry];
            switch (slot.kind) {
            case 'b': {
                std::size_t bytes = 0;
                const auto data = uniform(resource, bytes);
                SdlGpuWriteDevice{}.write_compute_uniform(command_, slot.index, data.data(),
                                                          static_cast<Uint32>(bytes));
                break;
            }
            case 't': {
                // A texture's row names its sampler (`encode_sdl_gpu_compute`).
                auto& pair = sampled.at(slot.index);
                pair.texture = read_texture(view(resource.index, level));
                if (slot.sampler_group >= 0) {
                    const std::size_t sampler =
                        layout_index(info, static_cast<std::uint32_t>(slot.sampler_group),
                                     static_cast<std::uint32_t>(slot.sampler_binding));
                    pair.sampler = ssao_sampler(ssao_, pass.resources[sampler].index);
                }
                break;
            }
            case 's':
                break;
            case 'i':
                readonly.at(slot.index) = read_texture(view(resource.index, level));
                break;
            case 'j': {
                const auto [texture, mip] = write_target(view(resource.index, level));
                writable.at(slot.index) = {texture, mip, 0, false, 0, 0, 0};
                break;
            }
            case 'r':
                readonly_buffers.at(slot.index) = buffer(resource);
                break;
            case 'w':
                writable_buffers.at(slot.index) = {buffer(resource), false, 0, 0, 0};
                break;
            default:
                throw std::runtime_error("An SSAO compute stage binds an unrepresented slot.");
            }
        }
        // A dispatch writing a storage view covers that view's level; one
        // writing buffers alone covers the working extent.
        SsaoTextureExtent extent = working_;
        if (pass.domain >= 0) {
            const SsaoResolvedView domain =
                view(pass.resources[static_cast<std::size_t>(pass.domain)].index, level);
            extent = ssao_level_extent(task_.extents[domain.texture], domain.base_mip);
        }
        SdlComputePass encoded{SDL_BeginGPUComputePass(
            command_, writable.data(), static_cast<Uint32>(writable.size()),
            writable_buffers.data(), static_cast<Uint32>(writable_buffers.size()))};
        if (!encoded)
            gpu_error("SDL_BeginGPUComputePass SSAO");
        SDL_BindGPUComputePipeline(encoded, pipeline.handle);
        if (!sampled.empty())
            SDL_BindGPUComputeSamplers(encoded, 0, sampled.data(),
                                       static_cast<Uint32>(sampled.size()));
        if (!readonly.empty())
            SDL_BindGPUComputeStorageTextures(encoded, 0, readonly.data(),
                                              static_cast<Uint32>(readonly.size()));
        if (!readonly_buffers.empty())
            SDL_BindGPUComputeStorageBuffers(encoded, 0, readonly_buffers.data(),
                                             static_cast<Uint32>(readonly_buffers.size()));
        SDL_DispatchGPUCompute(encoded, (extent.width + info.workgroup_x - 1u) / info.workgroup_x,
                               (extent.height + info.workgroup_y - 1u) / info.workgroup_y, 1u);
        encoded.end();
    }

    void render(const upstream::SsaoPassInfo& pass, std::uint32_t level) {
        const bool draws = pass.stage == upstream::SsaoPassStage::render;
        const upstream::SsaoProgramInfo* info =
            draws ? &upstream::ssao_program_infos[pass.program] : nullptr;
        const SdlSsaoProgram* program = draws ? &ssao_program(ssao_, pass.program) : nullptr;
        // Every texture a stage reads resolves before the pass: a level copy
        // is a copy pass of its own.
        std::vector<SDL_GPUTexture*> reads(pass.resources.size(), nullptr);
        for (std::size_t index = 0; index < pass.resources.size(); ++index)
            if (pass.resources[index].kind == upstream::SsaoResourceKind::view)
                reads[index] = read_texture(view(pass.resources[index].index, level));
        std::vector<SDL_GPUColorTargetInfo> targets;
        for (const upstream::SsaoAttachmentInfo& attachment : pass.attachments) {
            const auto [texture, mip] = write_target(view(attachment.view, level));
            SDL_GPUColorTargetInfo target{};
            target.texture = texture;
            target.mip_level = mip;
            target.load_op = SDL_GPU_LOADOP_CLEAR;
            target.store_op = SDL_GPU_STOREOP_STORE;
            target.clear_color = SDL_FColor{
                static_cast<float>(attachment.clear[0]), static_cast<float>(attachment.clear[1]),
                static_cast<float>(attachment.clear[2]), static_cast<float>(attachment.clear[3])};
            targets.push_back(target);
        }
        if (draws) {
            for (const auto* stage : {&program->vertex_slots, &program->fragment_slots}) {
                const bool fragment = stage == &program->fragment_slots;
                push_stage_uniforms(command_, *stage, fragment, "SSAO stage",
                                    [&](const std::string& name, std::size_t) {
                                        const std::size_t entry =
                                            binding_entry(*info, *stage, name);
                                        std::size_t bytes = 0;
                                        const auto data = uniform(pass.resources[entry], bytes);
                                        return PinnedStageBlock{data.data(), bytes};
                                    });
            }
        }
        SdlRenderPass encoded{SDL_BeginGPURenderPass(command_, targets.data(),
                                                     static_cast<Uint32>(targets.size()), nullptr)};
        if (!encoded)
            gpu_error("SDL_BeginGPURenderPass SSAO");
        if (draws) {
            SDL_BindGPUGraphicsPipeline(encoded, program->render.get());
            for (const auto* stage : {&program->vertex_slots, &program->fragment_slots}) {
                const bool fragment = stage == &program->fragment_slots;
                const auto texture = [&](const std::string& name, std::size_t slot) {
                    const std::size_t entry = binding_entry(*info, *stage, name);
                    SDL_GPUSampler* sampler = fallback_sampler(ssao_);
                    if (slot < stage->samplers.size() && !stage->samplers[slot].empty()) {
                        const std::size_t paired =
                            binding_entry(*info, *stage, stage->samplers[slot]);
                        sampler = ssao_sampler(ssao_, pass.resources[paired].index);
                    }
                    return SDL_GPUTextureSamplerBinding{reads.at(entry), sampler};
                };
                bind_stage_textures(encoded, *stage, fragment, "SSAO stage", texture_scratch_,
                                    texture, texture);
                bind_stage_storage(encoded, *stage, fragment, "SSAO stage", storage_scratch_,
                                   [&](const std::string& name, std::size_t) {
                                       return buffer(
                                           pass.resources[binding_entry(*info, *stage, name)]);
                                   });
            }
            if (pass.buffer >= 0)
                SDL_DrawGPUPrimitivesIndirect(
                    encoded, task_.buffers.at(static_cast<std::size_t>(pass.buffer)), 0, 1);
            else
                count_gpu_draw(SDL_DrawGPUPrimitives, encoded, 3, 1, 0, 0);
        }
        encoded.end();
    }

    /**
     * The layout entry a stage's resource is bound at: the sidecar names each
     * slot by the module's own identifier, which the plan carries per entry.
     */
    static std::size_t binding_entry(const upstream::SsaoProgramInfo& info, const PinnedStageSlots&,
                                     const std::string& name) {
        for (std::size_t index = 0; index < info.layout.size(); ++index)
            if (info.layout[index].name == name)
                return index;
        throw std::runtime_error("An SSAO stage slot '" + name + "' has no plan binding.");
    }
};

} // namespace

GpuSsaoState& ssao_state(GpuState& state) {
    if (!state.ssao)
        state.ssao = std::make_shared<GpuSsaoState>(state.device);
    return *state.ssao;
}

void record_ssao_task(GpuState& state, Engine& engine, TaskHandle handle,
                      SDL_GPUCommandBuffer* command, SDL_GPUTexture* depth, SDL_GPUTexture* normal,
                      SDL_GPUTexture* velocity, std::uint32_t velocity_width,
                      std::uint32_t velocity_height, std::uint32_t width, std::uint32_t height,
                      GpuTaskTimingSequence& timing) {
    SsaoTaskOptions& options = handle_at(engine.frame_tasks, handle).ssao;
    GpuSsaoState& ssao = ssao_state(state);
    if (ssao.tasks.size() <= handle.value)
        ssao.tasks.resize(handle.value + 1u);
    SdlSsaoTask& task = ssao.tasks[handle.value];
    const SsaoFramePlan frame =
        plan_ssao_frame(options, task.tracking, ssao.identities, width, height, depth, normal,
                        velocity, velocity_width, velocity_height);
    const upstream::SsaoPlanInfo& plan = upstream::ssao_plan_infos[options.plan];
    const upstream::SsaoModeInfo& mode = plan.modes[frame.mode];
    prepare_ssao_resources(ssao, task, plan, mode, command, width, height, frame.resized);
    const SsaoFrameDecision decision = upstream::ssao_frame(engine, options, frame.inputs);
    SdlSsaoEncoder encoder(ssao, task, plan, mode, decision, command, {depth, normal, velocity},
                           ssao_working_extent(mode, width, height));
    // Each of the pin's passes gets its timestamps around the native passes
    // that encode it.
    std::optional<GpuTaskPassTimestamps> span;
    for (const SsaoPassInstance& instance :
         ssao_pass_instances(ssao_decision_passes(mode, decision), task.extents)) {
        if (instance.opens) {
            span = timing.pass();
            if (span && span->begin)
                encode_sdl_gpu_timestamp(command, *span->begin);
        }
        encoder.pass(*instance.pass, instance.level);
        if (instance.closes && span) {
            encode_sdl_gpu_timestamp(command, span->end);
            span.reset();
        }
    }
}

SDL_GPUTexture* ssao_output_texture(GpuState& state, const Engine& engine, TaskHandle handle) {
    const SsaoTaskOptions& options = handle_at(engine.frame_tasks, handle).ssao;
    GpuSsaoState& ssao = ssao_state(state);
    if (handle.value >= ssao.tasks.size() || ssao.tasks[handle.value].textures.empty())
        throw std::runtime_error("An SSAO output is read before its task executed.");
    const SdlSsaoTask& task = ssao.tasks[handle.value];
    const upstream::SsaoModeInfo& mode =
        upstream::ssao_plan_infos[options.plan].modes[task.tracking.mode];
    return task.textures.at(mode.output);
}

SDL_GPUTextureSamplerBinding ssao_pbr_binding(GpuState& state, const Engine& engine,
                                              TaskHandle handle, const ShaderPassMatrices* pass) {
    GpuSsaoState& ssao = ssao_state(state);
    if (!ssao.nearest) {
        // `getNearestSampler`: nearest filtering over WebGPU's defaults.
        SDL_GPUSamplerCreateInfo sampler{};
        sampler.address_mode_u = sampler.address_mode_v = sampler.address_mode_w =
            SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
        sampler.max_lod = 32.0f;
        ssao.nearest = SDL_CreateGPUSampler(ssao.device, &sampler);
        if (!ssao.nearest)
            gpu_error("SDL_CreateGPUSampler PBR SSAO");
    }
    const SsaoTaskOptions& options = handle_at(engine.frame_tasks, handle).ssao;
    const SsaoPbrSampling sampling =
        handle.value < ssao.tasks.size()
            ? ssao_pbr_sampling(engine, options, ssao.tasks[handle.value].tracking, pass)
            : SsaoPbrSampling{};
    if (sampling.use_output)
        return {ssao_output_texture(state, engine, handle), ssao.nearest};
    if (!ssao.neutral)
        ssao.neutral = upload_texture(ssao.device, TextureData{}, false, {255, 255, 255, 255});
    return {ssao.neutral, ssao.nearest};
}

} // namespace sdl_scene
} // namespace bbl::pal
#endif
