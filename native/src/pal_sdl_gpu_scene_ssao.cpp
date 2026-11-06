// SDL_GPU encoding of `createSsaoTask` frames. Dawn's twin is
// pal_dawn_scene_ssao.cpp; the frame walk both share is pal_gpu_ssao.hpp.
#include "pal_gpu_common.hpp"
#include "pal_gpu_ssao.hpp"
#include <bblite/features/has_ssao.hpp>

#include "pal_sdl_gpu_scene.hpp"

#if BBLITE_HAS_SSAO
#include "pal_sdl_gpu_canvas.hpp"
#include "pal_sdl_gpu_compute_pipeline.hpp"
#include "pal_sdl_gpu_pinned_program.hpp"
#include "pal_sdl_gpu_timestamp.hpp"
#include "pal_sdl_gpu_webgpu.hpp"

#include <array>
#include <optional>
#include <string>
#include <utility>

namespace bbl::pal {
inline namespace sdl_scene {

namespace {

using OwnedSdlSampler =
    std::unique_ptr<SDL_GPUSampler, SdlGpuDeleter<SDL_GPUSampler, SDL_ReleaseGPUSampler>>;

/** One plan program on this device. */
struct SdlSsaoProgram {
    std::shared_ptr<SdlComputePipeline> compute;
    OwnedSdlPipeline render{nullptr, {nullptr}};
    PinnedStageSlots vertex_slots;
    PinnedStageSlots fragment_slots;
};

/** One task's owned textures and buffers (`SsaoTaskResources`) on this device. */
struct SdlSsaoTask : SsaoTaskResources<OwnedSdlTexture, OwnedSdlBuffer> {
    /**
     * Single-level copies of chained textures, by texture and level. SDL_GPU
     * binds whole textures, so a pass that reads one level of a chain -- the
     * pin's `createView({ baseMipLevel, mipLevelCount: 1 })` -- reads a copy
     * of that level, made right before the pass; texel copies are exact.
     */
    std::vector<std::vector<OwnedSdlTexture>> level_copies;
};

/** The bindings one pass encodes, reused across passes and frames. */
struct SdlSsaoScratch {
    std::vector<SDL_GPUTextureSamplerBinding> sampled;
    std::vector<SDL_GPUTexture*> readonly;
    std::vector<SDL_GPUBuffer*> readonly_buffers;
    std::vector<SDL_GPUStorageTextureReadWriteBinding> writable;
    std::vector<SDL_GPUStorageBufferReadWriteBinding> writable_buffers;
    std::vector<SDL_GPUTexture*> reads;
    std::vector<SDL_GPUColorTargetInfo> targets;
    StageTextureBindingScratch textures;
    std::vector<SDL_GPUBuffer*> storage;
};

} // namespace

struct GpuSsaoState {
    SDL_GPUDevice* device = nullptr;
    std::vector<std::optional<SdlSsaoProgram>> programs;
    /**
     * One sampler per minification and magnification filter pair: clamped,
     * nearest mips, WebGPU's default LOD ceiling. The plan's samplers are
     * among them, and so is `getNearestSampler`, which also stands for a
     * stage that reads its texture through `textureLoad` only.
     */
    std::array<OwnedSdlSampler, 4> samplers;
    /** `enablePbrSsao`'s neutral visibility (a 1x1 white texture). */
    OwnedSdlTexture neutral{nullptr, {nullptr}};
    /** The zero bytes a buffer clear copies (`ensure_sdl_webgpu_zeros`). */
    std::shared_ptr<SdlWebGpuOwner> zeros = std::make_shared<SdlWebGpuOwner>();
    std::vector<SdlSsaoTask> tasks;
    std::uint64_t identities = 0;
    /** This device's identity, which the owners made on it carry. */
    std::uint64_t device_identity = ++identities;
    SdlSsaoScratch scratch;

    explicit GpuSsaoState(SDL_GPUDevice* value) : device(value) { zeros->device = value; }
    GpuSsaoState(const GpuSsaoState&) = delete;
    GpuSsaoState& operator=(const GpuSsaoState&) = delete;
    ~GpuSsaoState() { zeros->retire(); }
};

namespace {

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

OwnedSdlTexture create_ssao_texture(SDL_GPUDevice* device, std::string_view format,
                                    SDL_GPUTextureUsageFlags usage, std::uint32_t width,
                                    std::uint32_t height, std::uint32_t levels) {
    return OwnedSdlTexture{create_frame_texture(device, sdl_named_texture_format(format),
                                                SDL_GPU_SAMPLECOUNT_1, width, height, usage, 1,
                                                false, levels),
                           {device}};
}

/** Zeros a buffer's first `bytes`: WebGPU's zero-initialized buffer and `clearBuffer`. */
void clear_ssao_buffer(GpuSsaoState& ssao, SDL_GPUCommandBuffer* command, SDL_GPUBuffer* buffer,
                       std::uint32_t bytes) {
    ensure_sdl_webgpu_zeros(*ssao.zeros, bytes);
    SdlCopyPass pass{SDL_BeginGPUCopyPass(command)};
    if (!pass)
        gpu_error("SDL_BeginGPUCopyPass SSAO buffer clear");
    record_sdl_webgpu_zeros(*ssao.zeros, pass, buffer, 0, bytes);
    pass.end();
}

SDL_GPUSampler* ssao_sampler(GpuSsaoState& ssao, bool min_linear, bool mag_linear) {
    OwnedSdlSampler& slot = ssao.samplers[(min_linear ? 2u : 0u) + (mag_linear ? 1u : 0u)];
    if (slot)
        return slot.get();
    SDL_GPUSamplerCreateInfo sampler{};
    sampler.min_filter = min_linear ? SDL_GPU_FILTER_LINEAR : SDL_GPU_FILTER_NEAREST;
    sampler.mag_filter = mag_linear ? SDL_GPU_FILTER_LINEAR : SDL_GPU_FILTER_NEAREST;
    sampler.mipmap_mode = SDL_GPU_SAMPLERMIPMAPMODE_NEAREST;
    sampler.address_mode_u = sampler.address_mode_v = sampler.address_mode_w =
        SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
    sampler.max_lod = 32.0f; // WebGPU's GPUSamplerDescriptor default.
    slot = OwnedSdlSampler{SDL_CreateGPUSampler(ssao.device, &sampler), {ssao.device}};
    if (!slot)
        gpu_error("SDL_CreateGPUSampler SSAO");
    return slot.get();
}

/** A plan sampler. */
SDL_GPUSampler* ssao_sampler(GpuSsaoState& ssao, std::uint32_t index) {
    const upstream::SsaoSamplerInfo& info = upstream::ssao_sampler_infos[index];
    return ssao_sampler(ssao, info.min_linear, info.mag_linear);
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
        std::vector<SDL_GPUTextureFormat> formats;
        for (const std::string_view format : info.targets)
            formats.push_back(sdl_named_texture_format(format));
        program.render = create_sdl_fullscreen_pipeline(ssao.device, vertex, fragment, formats,
                                                        "SDL_CreateGPUGraphicsPipeline SSAO");
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

/**
 * The layout entry a stage's resource is bound at: the sidecar names each
 * slot by the module's own identifier, which the plan carries per entry.
 */
std::size_t binding_entry(const upstream::SsaoProgramInfo& info, const std::string& name) {
    for (std::size_t index = 0; index < info.layout.size(); ++index)
        if (info.layout[index].name == name)
            return index;
    throw std::runtime_error("An SSAO stage slot '" + name + "' has no plan binding.");
}

/** Encodes one pass instance of a plan frame into a command buffer. */
class SdlSsaoEncoder {
public:
    SdlSsaoEncoder(GpuSsaoState& ssao, SdlSsaoTask& task, const SsaoFrame& frame,
                   SDL_GPUCommandBuffer* command, const SsaoSources<SDL_GPUTexture*>& sources)
        : ssao_(ssao), task_(task), frame_(frame), command_(command), sources_(sources),
          scratch_(ssao.scratch) {}

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
            clear_ssao_buffer(ssao_, command_, task_.buffers.at(index).get(),
                              task_.buffer_bytes.at(index));
            return;
        }
        }
    }

private:
    GpuSsaoState& ssao_;
    SdlSsaoTask& task_;
    const SsaoFrame& frame_;
    SDL_GPUCommandBuffer* command_;
    const SsaoSources<SDL_GPUTexture*>& sources_;
    SdlSsaoScratch& scratch_;

    SsaoResolvedView view(std::uint32_t index, std::uint32_t level) const {
        return resolve_ssao_view(frame_.mode, index, level, task_.extents);
    }

    SDL_GPUBuffer* buffer(const upstream::SsaoResourceInfo& resource) const {
        if (resource.kind != upstream::SsaoResourceKind::buffer)
            throw std::runtime_error("An SSAO stage binds a non-buffer at a storage buffer slot.");
        return task_.buffers.at(resource.index).get();
    }

    /** The texture a read binds: a source, an owned texture, or a level's copy. */
    SDL_GPUTexture* read_texture(const SsaoResolvedView& view) {
        if (const auto source = ssao_source_texture(view, sources_))
            return *source;
        if (!view.single_level_of_chain) {
            if (view.base_mip != 0)
                throw std::runtime_error("An SSAO pass reads a chain from a level past its first.");
            return task_.textures.at(view.texture).get();
        }
        const SsaoTextureExtent& chain = task_.extents[view.texture];
        auto& copies = task_.level_copies.at(view.texture);
        if (copies.size() < chain.levels)
            copies.resize(chain.levels);
        OwnedSdlTexture& copy = copies[view.base_mip];
        const std::string_view format = frame_.plan.textures[view.texture].format;
        const SsaoTextureExtent extent = ssao_level_extent(chain, view.base_mip);
        if (!copy)
            copy = create_ssao_texture(ssao_.device, format, ssao_read_usage(format), extent.width,
                                       extent.height, 1u);
        SDL_GPUTextureLocation from{};
        from.texture = task_.textures.at(view.texture).get();
        from.mip_level = view.base_mip;
        SDL_GPUTextureLocation to{};
        to.texture = copy.get();
        SdlCopyPass pass{SDL_BeginGPUCopyPass(command_)};
        if (!pass)
            gpu_error("SDL_BeginGPUCopyPass SSAO level");
        SDL_CopyGPUTextureToTexture(pass, &from, &to, extent.width, extent.height, 1, false);
        pass.end();
        return copy.get();
    }

    /** A written view: an owned texture's level. */
    std::pair<SDL_GPUTexture*, std::uint32_t> write_target(const SsaoResolvedView& view) const {
        if (view.source != upstream::SsaoTextureSource::owned || view.mip_count != 1u)
            throw std::runtime_error(
                "An SSAO pass writes other than one level of its own texture.");
        return {task_.textures.at(view.texture).get(), view.base_mip};
    }

    void compute(const upstream::SsaoPassInfo& pass, std::uint32_t level) {
        const upstream::SsaoProgramInfo& info = upstream::ssao_program_infos[pass.program];
        const SdlComputePipeline& pipeline = *ssao_program(ssao_, pass.program).compute;
        SDL_GPUSampler* nearest = ssao_sampler(ssao_, false, false);
        scratch_.sampled.assign(pipeline.counts[0], {nullptr, nearest});
        scratch_.readonly.assign(pipeline.counts[1], nullptr);
        scratch_.readonly_buffers.assign(pipeline.counts[2], nullptr);
        scratch_.writable.assign(pipeline.counts[3], {});
        scratch_.writable_buffers.assign(pipeline.counts[4], {});
        for (const SdlComputeSlot& slot : pipeline.slots) {
            if (slot.workgroup_counts)
                throw std::runtime_error("An SSAO compute stage reads its workgroup counts.");
            const std::size_t entry = layout_index(info, slot.group, slot.binding);
            const upstream::SsaoResourceInfo& resource = pass.resources[entry];
            switch (slot.kind) {
            case 'b': {
                std::size_t bytes = 0;
                const auto data = frame_.uniform(resource, bytes);
                SdlGpuWriteDevice{}.write_compute_uniform(command_, slot.index, data.data(),
                                                          static_cast<Uint32>(bytes));
                break;
            }
            case 't': {
                // A texture's row names its sampler (`encode_sdl_gpu_compute`).
                auto& pair = scratch_.sampled.at(slot.index);
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
                scratch_.readonly.at(slot.index) = read_texture(view(resource.index, level));
                break;
            case 'j': {
                const auto [texture, mip] = write_target(view(resource.index, level));
                scratch_.writable.at(slot.index) = {texture, mip, 0, false, 0, 0, 0};
                break;
            }
            case 'r':
                scratch_.readonly_buffers.at(slot.index) = buffer(resource);
                break;
            case 'w':
                scratch_.writable_buffers.at(slot.index) = {buffer(resource), false, 0, 0, 0};
                break;
            default:
                throw std::runtime_error("An SSAO compute stage binds an unrepresented slot.");
            }
        }
        const auto groups =
            ssao_dispatch_groups(frame_.mode, pass, level, task_.extents, frame_.working);
        SdlComputePass encoded{SDL_BeginGPUComputePass(
            command_, scratch_.writable.data(), static_cast<Uint32>(scratch_.writable.size()),
            scratch_.writable_buffers.data(),
            static_cast<Uint32>(scratch_.writable_buffers.size()))};
        if (!encoded)
            gpu_error("SDL_BeginGPUComputePass SSAO");
        SDL_BindGPUComputePipeline(encoded, pipeline.handle);
        if (!scratch_.sampled.empty())
            SDL_BindGPUComputeSamplers(encoded, 0, scratch_.sampled.data(),
                                       static_cast<Uint32>(scratch_.sampled.size()));
        if (!scratch_.readonly.empty())
            SDL_BindGPUComputeStorageTextures(encoded, 0, scratch_.readonly.data(),
                                              static_cast<Uint32>(scratch_.readonly.size()));
        if (!scratch_.readonly_buffers.empty())
            SDL_BindGPUComputeStorageBuffers(encoded, 0, scratch_.readonly_buffers.data(),
                                             static_cast<Uint32>(scratch_.readonly_buffers.size()));
        SDL_DispatchGPUCompute(encoded, groups[0], groups[1], 1u);
        encoded.end();
    }

    void render(const upstream::SsaoPassInfo& pass, std::uint32_t level) {
        const bool draws = pass.stage == upstream::SsaoPassStage::render;
        const upstream::SsaoProgramInfo* info =
            draws ? &upstream::ssao_program_infos[pass.program] : nullptr;
        const SdlSsaoProgram* program = draws ? &ssao_program(ssao_, pass.program) : nullptr;
        // Every texture a stage reads resolves before the pass: a level copy
        // is a copy pass of its own.
        scratch_.reads.assign(pass.resources.size(), nullptr);
        for (std::size_t index = 0; index < pass.resources.size(); ++index)
            if (pass.resources[index].kind == upstream::SsaoResourceKind::view)
                scratch_.reads[index] = read_texture(view(pass.resources[index].index, level));
        scratch_.targets.clear();
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
            scratch_.targets.push_back(target);
        }
        if (draws) {
            for (const auto* stage : {&program->vertex_slots, &program->fragment_slots}) {
                const bool fragment = stage == &program->fragment_slots;
                push_stage_uniforms(command_, *stage, fragment, "SSAO stage",
                                    [&](const std::string& name, std::size_t) {
                                        std::size_t bytes = 0;
                                        const auto data = frame_.uniform(
                                            pass.resources[binding_entry(*info, name)], bytes);
                                        return PinnedStageBlock{data.data(), bytes};
                                    });
            }
        }
        SdlRenderPass encoded{SDL_BeginGPURenderPass(command_, scratch_.targets.data(),
                                                     static_cast<Uint32>(scratch_.targets.size()),
                                                     nullptr)};
        if (!encoded)
            gpu_error("SDL_BeginGPURenderPass SSAO");
        if (draws) {
            SDL_BindGPUGraphicsPipeline(encoded, program->render.get());
            SDL_GPUSampler* nearest = ssao_sampler(ssao_, false, false);
            for (const auto* stage : {&program->vertex_slots, &program->fragment_slots}) {
                const bool fragment = stage == &program->fragment_slots;
                const auto texture = [&](const std::string& name, std::size_t slot) {
                    SDL_GPUSampler* sampler = nearest;
                    if (slot < stage->samplers.size() && !stage->samplers[slot].empty())
                        sampler = ssao_sampler(
                            ssao_,
                            pass.resources[binding_entry(*info, stage->samplers[slot])].index);
                    return SDL_GPUTextureSamplerBinding{
                        scratch_.reads.at(binding_entry(*info, name)), sampler};
                };
                bind_stage_textures(encoded, *stage, fragment, "SSAO stage", scratch_.textures,
                                    texture, texture);
                bind_stage_storage(encoded, *stage, fragment, "SSAO stage", scratch_.storage,
                                   [&](const std::string& name, std::size_t) {
                                       return buffer(pass.resources[binding_entry(*info, name)]);
                                   });
            }
            if (pass.buffer >= 0)
                SDL_DrawGPUPrimitivesIndirect(
                    encoded, task_.buffers.at(static_cast<std::size_t>(pass.buffer)).get(), 0, 1);
            else
                count_gpu_draw(SDL_DrawGPUPrimitives, encoded, 3, 1, 0, 0);
        }
        encoded.end();
    }
};

/** Makes the owned texture a plan row names, each colour-target level cleared. */
OwnedSdlTexture make_ssao_texture(GpuSsaoState& ssao, SDL_GPUCommandBuffer* command,
                                  const upstream::SsaoTextureInfo& info,
                                  const SsaoTextureExtent& extent) {
    const SDL_GPUTextureUsageFlags usage = ssao_usage(info);
    OwnedSdlTexture texture = create_ssao_texture(ssao.device, info.format, usage, extent.width,
                                                  extent.height, extent.levels);
    if (usage & SDL_GPU_TEXTUREUSAGE_COLOR_TARGET)
        for (std::uint32_t level = 0; level < extent.levels; ++level) {
            SDL_GPUColorTargetInfo clear{};
            clear.texture = texture.get();
            clear.mip_level = level;
            clear.load_op = SDL_GPU_LOADOP_CLEAR;
            clear.store_op = SDL_GPU_STOREOP_STORE;
            SdlRenderPass pass{SDL_BeginGPURenderPass(command, &clear, 1, nullptr)};
            pass.end();
        }
    return texture;
}

/** Makes the storage buffer a plan row names, cleared. */
OwnedSdlBuffer make_ssao_buffer(GpuSsaoState& ssao, SDL_GPUCommandBuffer* command,
                                const upstream::SsaoBufferInfo& info, std::uint32_t bytes) {
    SDL_GPUBufferCreateInfo create{};
    create.usage = ssao_buffer_usage(info);
    create.size = bytes;
    OwnedSdlBuffer buffer{SDL_CreateGPUBuffer(ssao.device, &create), {ssao.device}};
    if (!buffer)
        gpu_error("SDL_CreateGPUBuffer SSAO");
    clear_ssao_buffer(ssao, command, buffer.get(), bytes);
    return buffer;
}

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
    GpuSsaoState& ssao = ssao_state(state);
    SdlSsaoTask& task = ssao_task_resources(ssao.tasks, handle);
    const SsaoSources<SDL_GPUTexture*> sources{depth, normal, velocity};
    record_ssao_frame(
        engine, handle, task, ssao.identities, ssao.device_identity,
        {depth, normal, velocity, velocity_width, velocity_height}, width, height, timing,
        [&](const upstream::SsaoPlanInfo& plan, const upstream::SsaoModeInfo& mode, bool resized) {
            prepare_ssao_resources(
                task, plan, mode, width, height, resized, [&] { task.level_copies.clear(); },
                [&](const upstream::SsaoTextureInfo& info, const SsaoTextureExtent& extent) {
                    return make_ssao_texture(ssao, command, info, extent);
                },
                [&](const upstream::SsaoBufferInfo& info, std::uint32_t bytes) {
                    return make_ssao_buffer(ssao, command, info, bytes);
                });
            task.level_copies.resize(plan.textures.size());
        },
        [](const SsaoFrame&) {},
        // Each of the pin's passes gets its timestamps around the native
        // passes that encode it.
        [&](const SsaoFrame& frame, const SsaoPassInstance& instance,
            const GpuTimestampWrite* begin, const GpuTimestampWrite* end) {
            if (begin)
                encode_sdl_gpu_timestamp(command, *begin);
            SdlSsaoEncoder(ssao, task, frame, command, sources)
                .pass(*instance.pass, instance.level);
            if (end)
                encode_sdl_gpu_timestamp(command, *end);
        });
}

namespace {

/** The texture a task publishes as `outputTexture`, once it executed. */
SDL_GPUTexture* ssao_output_texture(GpuState& state, const Engine& engine, TaskHandle handle) {
    GpuSsaoState& ssao = ssao_state(state);
    const std::uint32_t output = ssao_output_index(engine, handle, ssao.tasks);
    return ssao.tasks[handle.value].textures.at(output).get();
}

/** What `enablePbrSsao`'s plugin samples for a material in a pass (`ssao_pbr_sampling`). */
SdlDynamicPluginBinding ssao_pbr_binding(GpuState& state, const Engine& engine,
                                         const MaterialRecord& material,
                                         const ShaderPassMatrices* pass) {
    GpuSsaoState& ssao = ssao_state(state);
    // `getNearestSampler` for both, and the neutral `createSolidTexture2D(engine, 1, 1, 1, 1)`.
    SDL_GPUSampler* nearest = ssao_sampler(ssao, false, false);
    const SsaoPbrSampling sampling = ssao_pbr_sampling(engine, material, ssao.tasks, pass);
    if (sampling.use_output)
        return {{ssao_output_texture(state, engine, sampling.task), nearest}, sampling.version};
    if (!ssao.neutral)
        ssao.neutral = OwnedSdlTexture{
            upload_texture(ssao.device, TextureData{}, false, {255, 255, 255, 255}), {ssao.device}};
    return {{ssao.neutral.get(), nearest}, sampling.version};
}

[[maybe_unused]] const bool ssao_owner_registered =
    SdlTaskOutputOwners::add(FrameTaskKind::ssao, {&ssao_output_texture, &ssao_pbr_binding});

} // namespace

} // namespace sdl_scene
} // namespace bbl::pal
#endif
