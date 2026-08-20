#pragma once

// SDL_GPU mechanics shared by the renderers that draw through it.
//
// These are the operations every SDL_GPU path needs and none of them knows
// anything about Babylon: report a failure, load a compiled shader, upload
// or refresh a buffer, upload a 2D texture, build a sampler, read a target
// back as a PNG. They lived inside the PBR renderer's translation unit
// while it was the only one; the sprite renderer is the second, and it is
// a separate translation unit because a sprite-only scene generates no
// camera or render-plan headers for the PBR one to include.

#include <bblite/pal.hpp>
#include <bblite/runtime.hpp>

#include <cstdint>
#include <cstring>
#include <fstream>
#include <stdexcept>
#include <string>
#include <vector>

#include <SDL3/SDL.h>
#include <SDL3/SDL_gpu.h>
#include <SDL3_image/SDL_image.h>

#ifndef BBLITE_GPU_SHADER_DIR
#define BBLITE_GPU_SHADER_DIR "shaders"
#endif

namespace bbl::pal {

[[noreturn]] inline void gpu_error(const char* operation) {
    throw std::runtime_error(std::string(operation) + ": " + SDL_GetError());
}

inline void save_texture_png(
    SDL_GPUDevice* device,
    SDL_GPUCommandBuffer* command,
    SDL_GPUTexture* swapchain,
    SDL_GPUTextureFormat format,
    std::uint32_t width,
    std::uint32_t height,
    const std::string& path,
    const std::string& raw_path = {}) {
    const std::uint32_t bytes_per_pixel =
        format == SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT
            ? 8u
            : format == SDL_GPU_TEXTUREFORMAT_R16_FLOAT
                ? 2u
                : 4u;
    const std::uint32_t source_row_bytes = width * bytes_per_pixel;
    const std::uint32_t aligned_row_bytes =
        (source_row_bytes + 255u) & ~255u;
    SDL_GPUTransferBufferCreateInfo transfer_info{};
    transfer_info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_DOWNLOAD;
    transfer_info.size = aligned_row_bytes * height;
    SDL_GPUTransferBuffer* transfer = SDL_CreateGPUTransferBuffer(device, &transfer_info);
    if (!transfer) gpu_error("SDL_CreateGPUTransferBuffer screenshot");

    SDL_GPUCopyPass* copy = SDL_BeginGPUCopyPass(command);
    const SDL_GPUTextureRegion source{
        swapchain, 0, 0, 0, 0, 0, width, height, 1};
    const SDL_GPUTextureTransferInfo destination{
        transfer, 0, aligned_row_bytes / bytes_per_pixel, height};
    SDL_DownloadFromGPUTexture(copy, &source, &destination);
    SDL_EndGPUCopyPass(copy);
    SDL_GPUFence* fence = SDL_SubmitGPUCommandBufferAndAcquireFence(command);
    if (!fence) {
        SDL_ReleaseGPUTransferBuffer(device, transfer);
        gpu_error("SDL_SubmitGPUCommandBufferAndAcquireFence");
    }
    if (!SDL_WaitForGPUFences(device, true, &fence, 1)) {
        SDL_ReleaseGPUFence(device, fence);
        SDL_ReleaseGPUTransferBuffer(device, transfer);
        gpu_error("SDL_WaitForGPUFences");
    }

    const auto* mapped = static_cast<const std::uint8_t*>(
        SDL_MapGPUTransferBuffer(device, transfer, false));
    if (!mapped) {
        SDL_ReleaseGPUFence(device, fence);
        SDL_ReleaseGPUTransferBuffer(device, transfer);
        gpu_error("SDL_MapGPUTransferBuffer screenshot");
    }
    if (
        !raw_path.empty() &&
        format == SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT) {
        std::ofstream raw(raw_path, std::ios::binary);
        if (!raw) {
            SDL_UnmapGPUTransferBuffer(device, transfer);
            SDL_ReleaseGPUFence(device, fence);
            SDL_ReleaseGPUTransferBuffer(device, transfer);
            throw std::runtime_error(
                "Unable to open HDR diagnostic output '" + raw_path + "'.");
        }
        write_readback_raw_rows(
            raw,
            mapped,
            height,
            aligned_row_bytes,
            source_row_bytes);
    }
    const std::uint32_t output_row_bytes = width * 4;
    // The shared row conversion (pal_gpu_shared.hpp); only the SDL_GPU
    // format enum is translated here.
    const ReadbackFormatClass format_class =
        format == SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT
            ? ReadbackFormatClass::rgba16_float
            : format == SDL_GPU_TEXTUREFORMAT_R16_FLOAT
                ? ReadbackFormatClass::r16_float
                : format == SDL_GPU_TEXTUREFORMAT_B8G8R8A8_UNORM ||
                        format == SDL_GPU_TEXTUREFORMAT_B8G8R8A8_UNORM_SRGB
                    ? ReadbackFormatClass::bgra8
                    : ReadbackFormatClass::rgba8;
    std::vector<std::uint8_t> rgba = convert_readback_rows(
        mapped,
        width,
        height,
        aligned_row_bytes,
        format_class);
    SDL_UnmapGPUTransferBuffer(device, transfer);
    SDL_Surface* surface = SDL_CreateSurfaceFrom(
        static_cast<int>(width),
        static_cast<int>(height),
        SDL_PIXELFORMAT_RGBA32,
        rgba.data(),
        static_cast<int>(output_row_bytes));
    if (!surface) {
        SDL_ReleaseGPUFence(device, fence);
        SDL_ReleaseGPUTransferBuffer(device, transfer);
        gpu_error("SDL_CreateSurfaceFrom screenshot");
    }
    const bool saved = IMG_SavePNG(surface, path.c_str());
    SDL_DestroySurface(surface);
    SDL_ReleaseGPUFence(device, fence);
    SDL_ReleaseGPUTransferBuffer(device, transfer);
    if (!saved) gpu_error("IMG_SavePNG screenshot");
}

/**
 * What the shader step's compaction pass assigned, read back at load.
 *
 * SDL_GPU addresses uniforms by a per-stage slot and textures by a per-stage
 * index, so this backend needs the order the compaction produced. It cannot be
 * derived from the WGSL: a stage may declare a block it never reads -- the pin's
 * unlit fragment declares its mesh block for the `mli()` helper and then takes
 * no light path -- and Tint strips it, so the source over-counts. The remap
 * writes a `.slots` file beside each stage naming every register by the pin's
 * own identifier, and this reads it. Both compaction passes write one: a
 * custom sprite fragment declares the layer block and the `fx` block, and
 * which of them survives is the caller's own WGSL to decide.
 */
struct PinnedStageSlots {
    /** Uniform blocks in slot order: `scene`, `lights`, `mesh`, `material`. */
    std::vector<std::string> uniforms;
    /** Texture names in binding order; each one's sampler is bound with it. */
    std::vector<std::string> textures;
    /** Storage buffer names in storage-slot order -- the morph arms'. */
    std::vector<std::string> storage;
};

inline PinnedStageSlots read_pinned_stage_slots(const std::string& base_name) {
    const std::string shader_override =
        environment_variable("BBLITE_GPU_SHADER_DIR");
    const std::string shader_root = shader_override.empty()
        ? join_path(executable_directory(), BBLITE_GPU_SHADER_DIR)
        : shader_override;
    const std::vector<std::uint8_t> bytes =
        read_binary_file(join_path(shader_root, base_name + ".slots"));
    PinnedStageSlots slots;
    std::string line;
    const auto take = [&]() {
        const std::size_t space = line.find(' ');
        if (line.empty() || space == std::string::npos) return;
        const std::string reg = line.substr(0, space);
        std::string name = line.substr(space + 1);
        while (!name.empty() && (name.back() == '\r' || name.back() == ' ')) {
            name.pop_back();
        }
        // Placed at its own register index rather than appended: the sidecar
        // lists declarations in the order they appear in the HLSL, which is not
        // register order. A lit fragment's reads `b0 scene`, `b3 material`,
        // `b2 mesh`, `b1 lights`, and appending pushed `material` where the
        // shader wanted `lights` -- 9.238 MAD, while an unlit fragment happened
        // to declare its two blocks in index order and so looked correct.
        const std::size_t index =
            static_cast<std::size_t>(std::stoul(reg.substr(1)));
        // `b` is a uniform slot and `t` a texture; `s` is the sampler paired
        // with the texture of the same index, which SDL_GPU binds together.
        // `r` is a storage buffer at its storage slot, which shares the SRV
        // space after the sampled textures.
        std::vector<std::string>* target = reg[0] == 'b'
            ? &slots.uniforms
            : reg[0] == 't'
                ? &slots.textures
                : reg[0] == 'r' ? &slots.storage : nullptr;
        if (!target) return;
        if (target->size() <= index) target->resize(index + 1);
        (*target)[index] = name;
    };
    for (const std::uint8_t byte : bytes) {
        if (byte == '\n') {
            take();
            line.clear();
            continue;
        }
        line.push_back(static_cast<char>(byte));
    }
    take();
    return slots;
}

/**
 * Where a stage keeps a uniform block, or -1 when the compiled shader has
 * none.
 *
 * A custom sprite or billboard program declares the family's own block and
 * the `fx` block; a body that owns its alpha reads neither, and a block a
 * stage does not read is dropped on the way to the compiled shader. So which
 * of them exists, and at which of this stage's dense slots, is a question
 * only the compaction pass can answer -- which is what it writes beside the
 * stage.
 */
inline int stage_uniform_slot(
    const PinnedStageSlots& slots,
    const char* block_name) {
    for (std::size_t index = 0; index < slots.uniforms.size(); ++index) {
        if (slots.uniforms[index] == block_name) {
            return static_cast<int>(index);
        }
    }
    return -1;
}

/**
 * Bind the storage buffers a stage kept, in the sidecar's own slot order.
 *
 * Every caller answers the same two questions — which names this stage
 * survived with, and which buffer each names — so only the resolver differs;
 * a name it cannot map fails loudly rather than binding a neighbour.
 */
template <typename Resolve>
inline void bind_stage_storage(
    SDL_GPURenderPass* pass,
    const PinnedStageSlots& slots,
    bool fragment,
    const char* what,
    Resolve resolve) {
    if (slots.storage.empty()) return;
    std::vector<SDL_GPUBuffer*> buffers;
    buffers.reserve(slots.storage.size());
    for (const std::string& name : slots.storage) {
        SDL_GPUBuffer* buffer = resolve(name);
        if (!buffer) {
            gpu_error(
                (std::string(what) +
                 " declares an unmapped storage buffer '" + name + "'.")
                    .c_str());
        }
        buffers.push_back(buffer);
    }
    if (fragment) {
        SDL_BindGPUFragmentStorageBuffers(
            pass,
            0,
            buffers.data(),
            static_cast<Uint32>(buffers.size()));
        return;
    }
    SDL_BindGPUVertexStorageBuffers(
        pass,
        0,
        buffers.data(),
        static_cast<Uint32>(buffers.size()));
}

/**
 * Bind the texture/sampler pairs a stage kept, in the sidecar's own order.
 *
 * The storage twin above says why the resolver is the parameter, and this is
 * the same walk over the other list: SDL_GPU binds a texture and its sampler
 * as one pair at a dense index, so the sampler names never reach the sidecar
 * and the resolver answers for the pair.
 */
template <typename Resolve>
inline void bind_stage_textures(
    SDL_GPURenderPass* pass,
    const PinnedStageSlots& slots,
    bool fragment,
    Resolve resolve) {
    if (slots.textures.empty()) return;
    std::vector<SDL_GPUTextureSamplerBinding> bindings;
    bindings.reserve(slots.textures.size());
    for (const std::string& name : slots.textures) {
        bindings.push_back(resolve(name));
    }
    if (fragment) {
        SDL_BindGPUFragmentSamplers(
            pass,
            0,
            bindings.data(),
            static_cast<Uint32>(bindings.size()));
        return;
    }
    SDL_BindGPUVertexSamplers(
        pass,
        0,
        bindings.data(),
        static_cast<Uint32>(bindings.size()));
}

/** One block a stage's resolver named: its bytes, or none. */
struct PinnedStageBlock {
    const void* data = nullptr;
    std::size_t bytes = 0;
};

/**
 * Push the uniform blocks a stage kept, in the sidecar's own slot order.
 *
 * The composed families differ only in which blocks they can name — the walk,
 * the slot index and the stage split are the same for all of them, which is
 * why the resolver is the parameter and a name it cannot map fails loudly
 * rather than pushing a neighbour's bytes.
 */
template <typename Resolve>
inline void push_stage_uniforms(
    SDL_GPUCommandBuffer* command,
    const PinnedStageSlots& slots,
    bool fragment,
    const char* what,
    Resolve resolve) {
    for (std::size_t slot = 0; slot < slots.uniforms.size(); ++slot) {
        const PinnedStageBlock block = resolve(slots.uniforms[slot]);
        if (!block.data) {
            gpu_error(
                (std::string(what) + " declares an unmapped uniform block '" +
                 slots.uniforms[slot] + "'.")
                    .c_str());
        }
        if (fragment) {
            SDL_PushGPUFragmentUniformData(
                command,
                static_cast<Uint32>(slot),
                block.data,
                static_cast<Uint32>(block.bytes));
            continue;
        }
        SDL_PushGPUVertexUniformData(
            command,
            static_cast<Uint32>(slot),
            block.data,
            static_cast<Uint32>(block.bytes));
    }
}

/** Push `bytes` at `slot`, or nothing when the stage kept no such block. */
inline void push_stage_uniform(
    SDL_GPUCommandBuffer* command,
    int slot,
    const void* data,
    std::size_t bytes) {
    if (slot < 0) return;
    SDL_PushGPUFragmentUniformData(
        command,
        static_cast<Uint32>(slot),
        data,
        static_cast<Uint32>(bytes));
}

inline SDL_GPUShader* load_shader(
    SDL_GPUDevice* device,
    const char* base_name,
    SDL_GPUShaderStage stage,
    std::uint32_t samplers,
    std::uint32_t uniform_buffers,
    const char* entrypoint_override = nullptr,
    std::uint32_t storage_buffers = 0,
    // A texture read without a sampler. SDL packs these after the
    // sampler pairs in the same register space, which is why the count
    // belongs to the shader rather than to the bind call.
    std::uint32_t storage_textures = 0) {
    const SDL_GPUShaderFormat supported = SDL_GetGPUShaderFormats(device);
    SDL_GPUShaderFormat format = SDL_GPU_SHADERFORMAT_INVALID;
    const char* extension = nullptr;
    const char* entrypoint = nullptr;
    if (supported & SDL_GPU_SHADERFORMAT_DXIL) {
        format = SDL_GPU_SHADERFORMAT_DXIL;
        extension = ".dxil";
        entrypoint = "main";
    } else if (supported & SDL_GPU_SHADERFORMAT_SPIRV) {
        format = SDL_GPU_SHADERFORMAT_SPIRV;
        extension = ".spv";
        entrypoint = "main";
    } else if (supported & SDL_GPU_SHADERFORMAT_MSL) {
        format = SDL_GPU_SHADERFORMAT_MSL;
        extension = ".msl";
        entrypoint = "main0";
    } else {
        throw std::runtime_error("SDL_GPU backend has no supported bblitec shader format.");
    }
    if (entrypoint_override) {
        entrypoint = entrypoint_override;
    }
    const std::string shader_override =
        environment_variable("BBLITE_GPU_SHADER_DIR");
    const std::string shader_root = shader_override.empty()
        ? join_path(executable_directory(), BBLITE_GPU_SHADER_DIR)
        : shader_override;
    const std::vector<std::uint8_t> code = read_binary_file(
        join_path(
            shader_root,
            std::string(base_name) + extension));
    SDL_GPUShaderCreateInfo info{};
    info.code_size = code.size();
    info.code = code.data();
    info.entrypoint = entrypoint;
    info.format = format;
    info.stage = stage;
    info.num_samplers = samplers;
    info.num_uniform_buffers = uniform_buffers;
    info.num_storage_buffers = storage_buffers;
    info.num_storage_textures = storage_textures;
    SDL_GPUShader* shader = SDL_CreateGPUShader(device, &info);
    if (!shader) gpu_error("SDL_CreateGPUShader");
    return shader;
}

inline SDL_GPUBuffer* upload_buffer(
    SDL_GPUDevice* device,
    SDL_GPUBufferUsageFlags usage,
    const void* data,
    std::size_t size) {
    SDL_GPUBufferCreateInfo buffer_info{};
    buffer_info.usage = usage;
    buffer_info.size = static_cast<Uint32>(size);
    SDL_GPUBuffer* buffer = SDL_CreateGPUBuffer(device, &buffer_info);
    if (!buffer) gpu_error("SDL_CreateGPUBuffer");

    SDL_GPUTransferBufferCreateInfo transfer_info{};
    transfer_info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD;
    transfer_info.size = static_cast<Uint32>(size);
    SDL_GPUTransferBuffer* transfer = SDL_CreateGPUTransferBuffer(device, &transfer_info);
    if (!transfer) gpu_error("SDL_CreateGPUTransferBuffer");
    void* mapped = SDL_MapGPUTransferBuffer(device, transfer, false);
    if (!mapped) gpu_error("SDL_MapGPUTransferBuffer");
    std::memcpy(mapped, data, size);
    SDL_UnmapGPUTransferBuffer(device, transfer);

    SDL_GPUCommandBuffer* command = SDL_AcquireGPUCommandBuffer(device);
    if (!command) gpu_error("SDL_AcquireGPUCommandBuffer");
    SDL_GPUCopyPass* copy = SDL_BeginGPUCopyPass(command);
    SDL_GPUTransferBufferLocation source{transfer, 0};
    SDL_GPUBufferRegion destination{buffer, 0, static_cast<Uint32>(size)};
    SDL_UploadToGPUBuffer(copy, &source, &destination, false);
    SDL_EndGPUCopyPass(copy);
    if (!SDL_SubmitGPUCommandBuffer(command)) gpu_error("SDL_SubmitGPUCommandBuffer");
    SDL_ReleaseGPUTransferBuffer(device, transfer);
    return buffer;
}

inline void update_buffer(
    SDL_GPUDevice* device,
    SDL_GPUBuffer* buffer,
    const void* data,
    std::size_t size) {
    SDL_GPUTransferBufferCreateInfo transfer_info{};
    transfer_info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD;
    transfer_info.size = static_cast<Uint32>(size);
    SDL_GPUTransferBuffer* transfer =
        SDL_CreateGPUTransferBuffer(device, &transfer_info);
    if (!transfer) gpu_error("SDL_CreateGPUTransferBuffer");
    void* mapped =
        SDL_MapGPUTransferBuffer(device, transfer, false);
    if (!mapped) gpu_error("SDL_MapGPUTransferBuffer");
    std::memcpy(mapped, data, size);
    SDL_UnmapGPUTransferBuffer(device, transfer);

    SDL_GPUCommandBuffer* command =
        SDL_AcquireGPUCommandBuffer(device);
    if (!command) gpu_error("SDL_AcquireGPUCommandBuffer");
    SDL_GPUCopyPass* copy = SDL_BeginGPUCopyPass(command);
    const SDL_GPUTransferBufferLocation source{transfer, 0};
    const SDL_GPUBufferRegion destination{
        buffer,
        0,
        static_cast<Uint32>(size),
    };
    SDL_UploadToGPUBuffer(
        copy,
        &source,
        &destination,
        true);
    SDL_EndGPUCopyPass(copy);
    if (!SDL_SubmitGPUCommandBuffer(command)) {
        gpu_error("SDL_SubmitGPUCommandBuffer");
    }
    SDL_ReleaseGPUTransferBuffer(device, transfer);
}

inline SDL_GPUSampler* create_texture_sampler(
    SDL_GPUDevice* device,
    const TextureSamplerState& sampler) {
    const auto filter = [](TextureFilter value) {
        return value == TextureFilter::nearest
            ? SDL_GPU_FILTER_NEAREST
            : SDL_GPU_FILTER_LINEAR;
    };
    const auto address = [](TextureAddressMode value) {
        return value == TextureAddressMode::clamp
            ? SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE
            : value == TextureAddressMode::mirror
                ? SDL_GPU_SAMPLERADDRESSMODE_MIRRORED_REPEAT
                : SDL_GPU_SAMPLERADDRESSMODE_REPEAT;
    };
    SDL_GPUSamplerCreateInfo info{};
    info.min_filter = filter(sampler.min_filter);
    info.mag_filter = filter(sampler.mag_filter);
    info.mipmap_mode =
        sampler.mipmap_mode == TextureMipmapMode::nearest
            ? SDL_GPU_SAMPLERMIPMAPMODE_NEAREST
            : SDL_GPU_SAMPLERMIPMAPMODE_LINEAR;
    info.address_mode_u = address(sampler.address_u);
    info.address_mode_v = address(sampler.address_v);
    info.address_mode_w = SDL_GPU_SAMPLERADDRESSMODE_REPEAT;
    info.max_anisotropy = sampler.max_anisotropy;
    info.max_lod = sampler.max_lod;
    info.enable_anisotropy = sampler.max_anisotropy > 1.0f;
    SDL_GPUSampler* result = SDL_CreateGPUSampler(device, &info);
    if (!result) gpu_error("SDL_CreateGPUSampler material texture");
    return result;
}

inline SDL_GPUTexture* upload_2d_texture(
    SDL_GPUDevice* device,
    const void* bytes,
    std::size_t byte_size,
    std::uint32_t width,
    std::uint32_t height,
    SDL_GPUTextureFormat format,
    const char* label) {
    SDL_GPUTextureCreateInfo texture_info{};
    texture_info.type = SDL_GPU_TEXTURETYPE_2D;
    texture_info.format = format;
    texture_info.usage = SDL_GPU_TEXTUREUSAGE_SAMPLER;
    texture_info.width = width;
    texture_info.height = height;
    texture_info.layer_count_or_depth = 1;
    texture_info.num_levels = 1;
    texture_info.sample_count = SDL_GPU_SAMPLECOUNT_1;
    SDL_GPUTexture* texture = SDL_CreateGPUTexture(device, &texture_info);
    if (!texture) gpu_error(label);

    SDL_GPUTransferBufferCreateInfo transfer_info{};
    transfer_info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD;
    transfer_info.size = static_cast<Uint32>(byte_size);
    SDL_GPUTransferBuffer* transfer = SDL_CreateGPUTransferBuffer(device, &transfer_info);
    if (!transfer) gpu_error(label);
    void* mapped = SDL_MapGPUTransferBuffer(device, transfer, false);
    if (!mapped) gpu_error(label);
    std::memcpy(mapped, bytes, byte_size);
    SDL_UnmapGPUTransferBuffer(device, transfer);

    SDL_GPUCommandBuffer* command = SDL_AcquireGPUCommandBuffer(device);
    if (!command) gpu_error(label);
    SDL_GPUCopyPass* copy = SDL_BeginGPUCopyPass(command);
    const SDL_GPUTextureTransferInfo source{
        transfer, 0, width, height};
    const SDL_GPUTextureRegion destination{
        texture, 0, 0, 0, 0, 0,
        width, height, 1};
    SDL_UploadToGPUTexture(copy, &source, &destination, false);
    SDL_EndGPUCopyPass(copy);
    if (!SDL_SubmitGPUCommandBuffer(command)) gpu_error(label);
    SDL_ReleaseGPUTransferBuffer(device, transfer);
    return texture;
}

/**
 * The fragment textures a sprite-family pass binds, in declaration order:
 * the atlas, then whatever a custom shader named.
 *
 * Built once when the pass is, because none of it changes per frame, and
 * shared by both families because the order is the composed program's rather
 * than either family's.
 */
inline std::vector<SDL_GPUTextureSamplerBinding> sprite_fragment_textures(
    SDL_GPUDevice* device,
    SDL_GPUTexture* atlas,
    SDL_GPUSampler* atlas_sampler,
    const std::vector<PixelsTexture>& extras,
    const char* label) {
    std::vector<SDL_GPUTextureSamplerBinding> textures;
    textures.reserve(1u + extras.size());
    textures.push_back(
        SDL_GPUTextureSamplerBinding{atlas, atlas_sampler});
    for (const PixelsTexture& extra : extras) {
        textures.push_back(SDL_GPUTextureSamplerBinding{
            upload_2d_texture(
                device,
                extra.rgba.data(),
                extra.rgba.size(),
                extra.width,
                extra.height,
                SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM,
                label),
            create_texture_sampler(device, extra.sampler)});
    }
    return textures;
}

/** Releases what {@link sprite_fragment_textures} built, atlas included. */
inline void release_sprite_fragment_textures(
    SDL_GPUDevice* device,
    std::vector<SDL_GPUTextureSamplerBinding>& textures) {
    for (const SDL_GPUTextureSamplerBinding& binding : textures) {
        if (binding.texture) {
            SDL_ReleaseGPUTexture(device, binding.texture);
        }
        if (binding.sampler) {
            SDL_ReleaseGPUSampler(device, binding.sampler);
        }
    }
    textures.clear();
}

} // namespace bbl::pal
