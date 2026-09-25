#pragma once
#include "pal_gpu_images.hpp"
#include <bblite/features/has_gamepad.hpp>

#include "pal_sdl_gpu_device.hpp"
#include "pal_sdl_gpu_writes.hpp"
#include "pal_sdl_gpu_resources.hpp"
#include "pal_owned_gpu_record.hpp"
#include "pal_device_options.hpp"
#include "pal_gpu_common.hpp"
#include "pal_sdl_gpu_formats.hpp"

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
#include <bblite/upstream/pinned_depth_state.hpp>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <memory>
#include <fstream>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

#include <SDL3/SDL.h>
#include <SDL3/SDL_gpu.h>
#if defined(__ANDROID__)
#include <vulkan/vulkan.h>
#endif
#if BBLITE_VISUAL_CAPTURE
#include <SDL3_image/SDL_image.h>
#endif

namespace bbl::pal {

[[noreturn]] inline void gpu_error(const char* operation) {
    throw GpuTransportError(std::string(operation) + ": " + SDL_GetError());
}

inline SDL_GPUTexture* create_frame_texture(SDL_GPUDevice* device, SDL_GPUTextureFormat format,
                                            SDL_GPUSampleCount samples, std::uint32_t width,
                                            std::uint32_t height, SDL_GPUTextureUsageFlags usage,
                                            std::uint32_t layers = 1) {
    SDL_GPUTextureCreateInfo info{};
    // A layered attachment is an ARRAY texture: the cascaded shadow map is
    // the reached one, and its receiver declares `texture_depth_2d_array`,
    // so the texture type is what SDL_GPU resolves that register against.
    info.type = layers > 1 ? SDL_GPU_TEXTURETYPE_2D_ARRAY : SDL_GPU_TEXTURETYPE_2D;
    info.format = format;
    info.usage = usage;
    info.width = width;
    info.height = height;
    info.layer_count_or_depth = layers;
    info.num_levels = 1;
    info.sample_count = samples;
    SDL_GPUTexture* texture = SDL_CreateGPUTexture(device, &info);
    if (!texture)
        gpu_error("SDL_CreateGPUTexture frame graph");
    return texture;
}

#if BBLITE_VISUAL_CAPTURE
inline void save_texture_png(SDL_GPUDevice* device, SdlGpuCommand& command,
                             SDL_GPUTexture* swapchain, SDL_GPUTextureFormat format,
                             std::uint32_t width, std::uint32_t height, const std::string& path,
                             const std::string& raw_path = {}) {
    const std::uint32_t bytes_per_pixel = format == SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT ? 8u
                                          : format == SDL_GPU_TEXTUREFORMAT_R16_FLOAT        ? 2u
                                                                                             : 4u;
    const std::uint32_t source_row_bytes = width * bytes_per_pixel;
    const std::uint32_t aligned_row_bytes = (source_row_bytes + 255u) & ~255u;
    SDL_GPUTransferBufferCreateInfo transfer_info{};
    transfer_info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_DOWNLOAD;
    transfer_info.size = aligned_row_bytes * height;
    OwnedSdlTransfer transfer{SDL_CreateGPUTransferBuffer(device, &transfer_info), {device}};
    if (!transfer)
        gpu_error("SDL_CreateGPUTransferBuffer screenshot");

    SdlCopyPass copy{SDL_BeginGPUCopyPass(command)};
    if (!copy)
        gpu_error("SDL_BeginGPUCopyPass screenshot");
    const SDL_GPUTextureRegion source{swapchain, 0, 0, 0, 0, 0, width, height, 1};
    const SDL_GPUTextureTransferInfo destination{transfer.get(), 0,
                                                 aligned_row_bytes / bytes_per_pixel, height};
    SDL_DownloadFromGPUTexture(copy, &source, &destination);
    copy.end();
    OwnedSdlFence fence{command.submit_with_fence(), {device}};
    if (!fence) {
        gpu_error("SDL_SubmitGPUCommandBufferAndAcquireFence");
    }
    if (!wait_sdl_gpu_fence(device, fence.get())) {
        gpu_error("SDL_WaitForGPUFences");
    }

    const auto* mapped =
        static_cast<const std::uint8_t*>(SDL_MapGPUTransferBuffer(device, transfer.get(), false));
    if (!mapped) {
        gpu_error("SDL_MapGPUTransferBuffer screenshot");
    }
    const auto unmap = js::finally([&] {
        if (mapped)
            SDL_UnmapGPUTransferBuffer(device, transfer.get());
    });
    if (!raw_path.empty() && format == SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT) {
        std::ofstream raw(raw_path, std::ios::binary);
        if (!raw) {
            throw std::runtime_error("Unable to open HDR diagnostic output '" + raw_path + "'.");
        }
        write_readback_raw_rows(raw, mapped, height, aligned_row_bytes, source_row_bytes);
    }
    const std::uint32_t output_row_bytes = width * 4;
    // The shared row conversion (shared GPU helpers); only the SDL_GPU
    // format enum is translated here.
    const ReadbackFormatClass format_class =
        format == SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT ? ReadbackFormatClass::rgba16_float
        : format == SDL_GPU_TEXTUREFORMAT_R16_FLOAT        ? ReadbackFormatClass::r16_float
        : format == SDL_GPU_TEXTUREFORMAT_B8G8R8A8_UNORM ||
                format == SDL_GPU_TEXTUREFORMAT_B8G8R8A8_UNORM_SRGB
            ? ReadbackFormatClass::bgra8
            : ReadbackFormatClass::rgba8;
    std::vector<std::uint8_t> rgba =
        convert_readback_rows(mapped, width, height, aligned_row_bytes, format_class);
    SDL_UnmapGPUTransferBuffer(device, transfer.get());
    mapped = nullptr;
    SDL_Surface* surface = SDL_CreateSurfaceFrom(static_cast<int>(width), static_cast<int>(height),
                                                 SDL_PIXELFORMAT_RGBA32, rgba.data(),
                                                 static_cast<int>(output_row_bytes));
    if (!surface) {
        gpu_error("SDL_CreateSurfaceFrom screenshot");
    }
    const bool saved = IMG_SavePNG(surface, path.c_str());
    SDL_DestroySurface(surface);
    if (!saved)
        gpu_error("IMG_SavePNG screenshot");
}
#else
inline void save_texture_png(SDL_GPUDevice*, SdlGpuCommand& command, SDL_GPUTexture*,
                             SDL_GPUTextureFormat, std::uint32_t, std::uint32_t, const std::string&,
                             const std::string& = {}) {
    if (!command.submit())
        gpu_error("SDL_SubmitGPUCommandBuffer");
}
#endif

/**
 * The slots bblite-tint assigned a compiled stage, read back at load.
 *
 * SDL_GPU addresses uniforms by a per-stage slot and textures by a per-stage
 * index, so this backend needs the order the compiled stage kept. It cannot be
 * derived from the WGSL: a stage may declare a block it never reads -- the pin's
 * unlit fragment declares its mesh block for the `mli()` helper and then takes
 * no light path -- and Tint strips it, so the source over-counts. bblite-tint
 * writes a `.slots` file beside each stage naming every register by the pin's
 * own identifier, and this reads it: a custom sprite fragment declares the
 * layer block and the `fx` block, and which of them survives is the caller's
 * own WGSL to decide.
 */
struct PinnedStageSlots {
    /** Original locations ordered by the SPIR-V module's compacted locations. */
    std::optional<std::vector<Uint32>> spirv_inputs;
    /** The entry point the stage's module declared, as the sidecar names it. */
    std::string entry_point;
    /** Uniform blocks in slot order: `scene`, `lights`, `mesh`, `material`. */
    std::vector<std::string> uniforms;
    /** Texture names in binding order; each one's sampler is bound with it. */
    std::vector<std::string> textures;
    /** Storage buffer names in storage-slot order -- the morph arms'. */
    std::vector<std::string> storage;
    /** Integer texture loads, after sampled textures and before buffers. */
    std::vector<std::string> storage_textures;
};

inline PinnedStageSlots read_pinned_stage_slots(const std::string& base_name) {
    const std::string shader_override = environment_variable("BBLITE_GPU_SHADER_DIR");
    const std::string shader_root = shader_override.empty()
                                        ? join_path(executable_directory(), BBLITE_GPU_SHADER_DIR)
                                        : shader_override;
    const std::vector<std::uint8_t> bytes =
        read_binary_file(join_path(shader_root, base_name + ".slots"));
    PinnedStageSlots slots;
    const auto take = [&](std::string_view line) {
        constexpr std::string_view input_tag = "@spirv-inputs";
        if (line == input_tag || line.starts_with("@spirv-inputs ")) {
            if (slots.spirv_inputs)
                throw std::runtime_error("Duplicate SPIR-V input layout in " + base_name);
            auto& inputs = slots.spirv_inputs.emplace();
            line.remove_prefix(input_tag.size());
            while (!line.empty()) {
                line.remove_prefix(1);
                const auto end = std::min(line.find(' '), line.size());
                const auto location = parse_sidecar_index(line.substr(0, end));
                if (!location || (!inputs.empty() && inputs.back() >= *location))
                    throw std::runtime_error("Malformed SPIR-V input layout in " + base_name);
                inputs.push_back(*location);
                line.remove_prefix(end);
            }
            return;
        }
        const std::size_t space = line.find(' ');
        if (line.empty() || space == std::string_view::npos)
            return;
        const std::string_view reg = line.substr(0, space);
        const std::string name(line.substr(space + 1));
        if (reg == "@entry") {
            slots.entry_point = name;
            return;
        }
        // Placed at its own register index rather than appended: the sidecar
        // lists declarations in the order they appear in the HLSL, which is not
        // register order. A lit fragment's reads `b0 scene`, `b3 material`,
        // `b2 mesh`, `b1 lights`, and appending pushed `material` where the
        // shader wanted `lights` -- 9.238 MAD, while an unlit fragment happened
        // to declare its two blocks in index order and so looked correct.
        // `b` is a uniform slot and `t` a texture; `s` is the sampler paired
        // with the texture of the same index, which SDL_GPU binds together.
        // `i` is an integer texture load; `r` is a storage buffer. Their
        // own slot indices follow the sampled textures in the SRV space.
        std::vector<std::string>* target = reg[0] == 'b'   ? &slots.uniforms
                                           : reg[0] == 't' ? &slots.textures
                                           : reg[0] == 'r' ? &slots.storage
                                           : reg[0] == 'i' ? &slots.storage_textures
                                                           : nullptr;
        if (!target)
            return;
        const std::optional<std::uint32_t> index = parse_sidecar_index(reg.substr(1));
        if (!index) {
            throw std::runtime_error("Malformed shader slot '" + std::string(reg) + "' in " +
                                     base_name + ".slots.");
        }
        if (target->size() <= *index)
            target->resize(*index + 1);
        (*target)[*index] = name;
    };
    for_each_sidecar_line(
        std::string_view(reinterpret_cast<const char*>(bytes.data()), bytes.size()), take);
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
 * only the compiled stage can answer -- which is what bblite-tint writes
 * beside it.
 */
inline int stage_uniform_slot(const PinnedStageSlots& slots, const char* block_name) {
    for (std::size_t index = 0; index < slots.uniforms.size(); ++index) {
        if (slots.uniforms[index] == block_name) {
            return static_cast<int>(index);
        }
    }
    return -1;
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
inline std::vector<SDL_GPUTextureSamplerBinding>
resolve_stage_textures(const PinnedStageSlots& slots, const char* what, Resolve resolve) {
    std::vector<SDL_GPUTextureSamplerBinding> bindings;
    bindings.reserve(slots.textures.size());
    for (std::size_t slot = 0; slot < slots.textures.size(); ++slot) {
        const std::string& name = slots.textures[slot];
        const SDL_GPUTextureSamplerBinding binding = resolve(name, slot);
        // The refusal its storage and uniform siblings carry: a resolver
        // that produced no texture must fail by name here, not bind null.
        if (!binding.texture) {
            gpu_error(
                (std::string(what) + " declares an unresolved texture '" + name + "'.").c_str());
        }
        bindings.push_back(binding);
    }
    return bindings;
}

template <typename Resolve>
inline void bind_stage_textures(SDL_GPURenderPass* pass, const PinnedStageSlots& slots,
                                bool fragment, const char* what, Resolve resolve) {
    if (!slots.textures.empty()) {
        const auto bindings = resolve_stage_textures(slots, what, resolve);
        if (fragment) {
            SDL_BindGPUFragmentSamplers(pass, 0, bindings.data(),
                                        static_cast<Uint32>(bindings.size()));
        } else {
            SDL_BindGPUVertexSamplers(pass, 0, bindings.data(),
                                      static_cast<Uint32>(bindings.size()));
        }
    }
    if (slots.storage_textures.empty())
        return;
    std::vector<SDL_GPUTexture*> bindings;
    bindings.reserve(slots.storage_textures.size());
    for (std::size_t slot = 0; slot < slots.storage_textures.size(); ++slot) {
        const std::string& name = slots.storage_textures[slot];
        SDL_GPUTexture* texture = resolve(name, slot).texture;
        if (!texture) {
            gpu_error(
                (std::string(what) + " declares an unresolved storage texture '" + name + "'.")
                    .c_str());
        }
        bindings.push_back(texture);
    }
    if (fragment) {
        SDL_BindGPUFragmentStorageTextures(pass, 0, bindings.data(),
                                           static_cast<Uint32>(bindings.size()));
        return;
    }
    SDL_BindGPUVertexStorageTextures(pass, 0, bindings.data(),
                                     static_cast<Uint32>(bindings.size()));
}

/**
 * The storage sibling of the shared `push_stage_uniforms` /
 * `bind_stage_textures` walks: the same order, the same by-name refusal
 * and the same slot index handed to the resolver, with the pointer list
 * living in a caller-owned scratch (`GpuState::storage_binding_scratch`)
 * instead of a vector allocated per non-empty stage per draw. Node-morph
 * and shadow stages carry different slot counts, so the scratch refills
 * to each stage's own list and only its capacity persists.
 */
template <typename Resolve>
inline void resolve_stage_storage(const PinnedStageSlots& slots, const char* what,
                                  std::vector<SDL_GPUBuffer*>& scratch, Resolve resolve) {
    scratch.clear();
    scratch.reserve(slots.storage.size());
    for (std::size_t slot = 0; slot < slots.storage.size(); ++slot) {
        const std::string& name = slots.storage[slot];
        SDL_GPUBuffer* buffer = resolve(name, slot);
        if (!buffer) {
            gpu_error((std::string(what) + " declares an unmapped storage buffer '" + name + "'.")
                          .c_str());
        }
        scratch.push_back(buffer);
    }
}

template <typename Resolve>
inline void bind_stage_storage(SDL_GPURenderPass* pass, const PinnedStageSlots& slots,
                               bool fragment, const char* what,
                               std::vector<SDL_GPUBuffer*>& scratch, Resolve resolve) {
    if (slots.storage.empty())
        return;
    resolve_stage_storage(slots, what, scratch, resolve);
    if (fragment) {
        SDL_BindGPUFragmentStorageBuffers(pass, 0, scratch.data(),
                                          static_cast<Uint32>(scratch.size()));
        return;
    }
    SDL_BindGPUVertexStorageBuffers(pass, 0, scratch.data(), static_cast<Uint32>(scratch.size()));
}

// A shared blend tuple in this API's state; the operation is always add
// (`transparent_blend` / `ground_blend`, pal_gpu_shared.hpp). Shared so the
// family headers can call it too.
inline SDL_GPUColorTargetBlendState blend_state_from(const BlendFactors& factors) {
    SDL_GPUColorTargetBlendState blend{};
    blend.enable_blend = true;
    blend.color_blend_op = SDL_GPU_BLENDOP_ADD;
    blend.alpha_blend_op = SDL_GPU_BLENDOP_ADD;
    blend.src_color_blendfactor = gpu_blend_factor(factors.src_color);
    blend.dst_color_blendfactor = gpu_blend_factor(factors.dst_color);
    blend.src_alpha_blendfactor = gpu_blend_factor(factors.src_alpha);
    blend.dst_alpha_blendfactor = gpu_blend_factor(factors.dst_alpha);
    return blend;
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
 * rather than pushing a neighbour's bytes. The walk hands the resolver the
 * slot index it is visiting, so a resolver that answers by cached row reads
 * it instead of counting calls.
 */
template <typename Resolve>
inline void push_stage_uniforms(SDL_GPUCommandBuffer* command, const PinnedStageSlots& slots,
                                bool fragment, const char* what, Resolve resolve) {
    for (std::size_t slot = 0; slot < slots.uniforms.size(); ++slot) {
        const PinnedStageBlock block = resolve(slots.uniforms[slot], slot);
        if (!block.data) {
            gpu_error((std::string(what) + " declares an unmapped uniform block '" +
                       slots.uniforms[slot] + "'.")
                          .c_str());
        }
        if (fragment) {
            SdlGpuWriteDevice{}.write_fragment_uniform(
                command, static_cast<Uint32>(slot), block.data, static_cast<Uint32>(block.bytes));
            continue;
        }
        SdlGpuWriteDevice{}.write_vertex_uniform(command, static_cast<Uint32>(slot), block.data,
                                                 static_cast<Uint32>(block.bytes));
    }
}

/** Push `bytes` at `slot`, or nothing when the stage kept no such block. */
inline void push_stage_uniform(SDL_GPUCommandBuffer* command, int slot, const void* data,
                               std::size_t bytes) {
    if (slot < 0)
        return;
    SdlGpuWriteDevice{}.write_fragment_uniform(command, static_cast<Uint32>(slot), data,
                                               static_cast<Uint32>(bytes));
}

/** The vertex-stage twin of `push_stage_uniform`. */
inline void push_vertex_stage_uniform(SDL_GPUCommandBuffer* command, int slot, const void* data,
                                      std::size_t bytes) {
    if (slot < 0)
        return;
    SdlGpuWriteDevice{}.write_vertex_uniform(command, static_cast<Uint32>(slot), data,
                                             static_cast<Uint32>(bytes));
}

/** A device for the offline compiler's DXIL, SPIR-V or MSL stages. Its SPIR-V
 *  is version 1.3, Tint's minimum, which a Vulkan 1.1 instance consumes; SDL's
 *  default instance requests 1.0. The other backends ignore the Vulkan options. */
inline SDL_GPUDevice* create_compiled_shader_device(bool debug) {
    SDL_GPUVulkanOptions vulkan{};
    vulkan.vulkan_api_version = (1u << 22) | (1u << 12); // VK_MAKE_API_VERSION(0, 1, 1, 0)
    const auto properties = SDL_CreateProperties();
    SDL_SetBooleanProperty(properties, SDL_PROP_GPU_DEVICE_CREATE_SHADERS_DXIL_BOOLEAN, true);
    SDL_SetBooleanProperty(properties, SDL_PROP_GPU_DEVICE_CREATE_SHADERS_SPIRV_BOOLEAN, true);
    SDL_SetBooleanProperty(properties, SDL_PROP_GPU_DEVICE_CREATE_SHADERS_MSL_BOOLEAN, true);
    SDL_SetBooleanProperty(properties, SDL_PROP_GPU_DEVICE_CREATE_DEBUGMODE_BOOLEAN, debug);
    SDL_SetPointerProperty(properties, SDL_PROP_GPU_DEVICE_CREATE_VULKAN_OPTIONS_POINTER, &vulkan);
    SDL_GPUDevice* device = SDL_CreateGPUDeviceWithProperties(properties);
    SDL_DestroyProperties(properties);
    return device;
}

inline void create_sdl_gpu_device(const EngineOptions& engine_options, const DeviceOptions& options,
                                  SdlGpuDevice& state) {
    SDL_InitFlags init_flags = SDL_INIT_VIDEO | SDL_INIT_EVENTS;
#if BBLITE_HAS_GAMEPAD
    init_flags |= SDL_INIT_GAMEPAD;
#endif
    if (!initialize_run_sdl(init_flags))
        gpu_error("SDL_Init");
    state.sdl_initialized = true;
    state.window = acquire_run_window(
        engine_options, options.hidden_test_pass ? SDL_WINDOW_RESIZABLE | SDL_WINDOW_NOT_FOCUSABLE
                                                 : SDL_WINDOW_RESIZABLE);
    if (!state.window)
        gpu_error("SDL_CreateWindow");
#if defined(__ANDROID__)
    // Prefer helper invocations for discard, retaining derivatives at masked
    // edges. The Vulkan 1.1 fallback device does not enable this feature.
    VkPhysicalDeviceVulkan13Features features{};
    features.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_3_FEATURES;
    features.shaderDemoteToHelperInvocation = VK_TRUE;
    SDL_GPUVulkanOptions vulkan{};
    vulkan.vulkan_api_version = VK_API_VERSION_1_3;
    vulkan.feature_list = &features;
    const auto properties = SDL_CreateProperties();
    SDL_SetBooleanProperty(properties, SDL_PROP_GPU_DEVICE_CREATE_SHADERS_SPIRV_BOOLEAN, true);
    SDL_SetBooleanProperty(properties, SDL_PROP_GPU_DEVICE_CREATE_DEBUGMODE_BOOLEAN,
                           options.gpu_debug);
    SDL_SetPointerProperty(properties, SDL_PROP_GPU_DEVICE_CREATE_VULKAN_OPTIONS_POINTER, &vulkan);
    state.device = SDL_CreateGPUDeviceWithProperties(properties);
    SDL_DestroyProperties(properties);
    if (state.device)
        SDL_SetBooleanProperty(SDL_GetGPUDeviceProperties(state.device), "bblite.shader.demote",
                               true);
#endif
    if (!state.device)
        state.device = create_compiled_shader_device(options.gpu_debug);
    if (!state.device)
        gpu_error("SDL_CreateGPUDevice");
    if (!SDL_ClaimWindowForGPUDevice(state.device, state.window)) {
        gpu_error("SDL_ClaimWindowForGPUDevice");
    }
    state.window_claimed = true;
    state.swapchain_format = SDL_GetGPUSwapchainTextureFormat(state.device, state.window);
    if (options.immediate_present &&
        SDL_WindowSupportsGPUPresentMode(state.device, state.window,
                                         SDL_GPU_PRESENTMODE_IMMEDIATE)) {
        if (!SDL_SetGPUSwapchainParameters(state.device, state.window,
                                           SDL_GPU_SWAPCHAINCOMPOSITION_SDR,
                                           SDL_GPU_PRESENTMODE_IMMEDIATE)) {
            gpu_error("SDL_SetGPUSwapchainParameters");
        }
    }
    if (!SDL_SetGPUAllowedFramesInFlight(state.device, 3)) {
        gpu_error("SDL_SetGPUAllowedFramesInFlight");
    }
}

inline OwnedSdlShader
load_shader(SDL_GPUDevice* device, const char* base_name, SDL_GPUShaderStage stage,
            std::uint32_t samplers, std::uint32_t uniform_buffers,
            const char* entrypoint_override = nullptr, std::uint32_t storage_buffers = 0,
            // A texture read without a sampler. SDL packs these after the
            // sampler pairs in the same register space, which is why the count
            // belongs to the shader rather than to the bind call.
            std::uint32_t storage_textures = 0, const PinnedStageSlots* reflected = nullptr) {
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
        extension = stage == SDL_GPU_SHADERSTAGE_FRAGMENT &&
                            SDL_GetBooleanProperty(SDL_GetGPUDeviceProperties(device),
                                                   "bblite.shader.demote", false)
                        ? ".demote.spv"
                        : ".spv";
        entrypoint = "main";
    } else if (supported & SDL_GPU_SHADERFORMAT_MSL) {
        format = SDL_GPU_SHADERFORMAT_MSL;
        extension = ".msl";
        entrypoint = "main0";
    } else {
        throw std::runtime_error("SDL_GPU backend has no supported bblitec shader format.");
    }
    if (entrypoint_override && format != SDL_GPU_SHADERFORMAT_MSL) {
        entrypoint = entrypoint_override;
    }
    const std::string shader_override = environment_variable("BBLITE_GPU_SHADER_DIR");
    const std::string shader_root = shader_override.empty()
                                        ? join_path(executable_directory(), BBLITE_GPU_SHADER_DIR)
                                        : shader_override;
    std::vector<std::uint8_t> code =
        read_binary_file(join_path(shader_root, std::string(base_name) + extension));
    std::optional<std::vector<Uint32>> inputs;
    const bool compact_inputs =
        format == SDL_GPU_SHADERFORMAT_SPIRV && stage == SDL_GPU_SHADERSTAGE_VERTEX;
    if (compact_inputs) {
        inputs =
            reflected ? reflected->spirv_inputs : read_pinned_stage_slots(base_name).spirv_inputs;
        if (!inputs)
            throw std::runtime_error("SPIR-V shader has no compiled vertex layout: " +
                                     std::string(base_name));
    }
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
    if (!shader) {
        throw std::runtime_error(std::string("SDL_CreateGPUShader ") + base_name + extension +
                                 " (" + entrypoint + "): " + SDL_GetError());
    }
    return OwnedSdlShader{shader, {device, std::move(inputs)}};
}

/**
 * A stage created entirely from its sidecar: the entry point the module
 * declared, and the uniform, texture and storage counts the compiled stage
 * kept. Nothing about the stage is restated here, so a module the pin
 * reshapes reaches the device as the pin wrote it.
 */
inline OwnedSdlShader load_shader(SDL_GPUDevice* device, const std::string& stem,
                                  SDL_GPUShaderStage stage, const PinnedStageSlots& slots) {
    if (slots.entry_point.empty()) {
        throw std::runtime_error("Shader stage " + stem + ".slots names no entry point.");
    }
    return load_shader(device, stem.c_str(), stage,
                       static_cast<std::uint32_t>(slots.textures.size()),
                       static_cast<std::uint32_t>(slots.uniforms.size()), slots.entry_point.c_str(),
                       static_cast<std::uint32_t>(slots.storage.size()),
                       static_cast<std::uint32_t>(slots.storage_textures.size()), &slots);
}

/** A compiled stage and the sidecar it was created from. */
struct PinnedStage {
    OwnedSdlShader shader;
    PinnedStageSlots slots;
};

/** Read a stage's sidecar and create the stage from it. */
inline PinnedStage load_pinned_stage(SDL_GPUDevice* device, const std::string& stem,
                                     SDL_GPUShaderStage stage) {
    PinnedStageSlots slots = read_pinned_stage_slots(stem);
    OwnedSdlShader shader = load_shader(device, stem, stage, slots);
    return {std::move(shader), std::move(slots)};
}

inline SDL_FColor gpu_clear_color(SDL_GPUDevice* device, SDL_GPUTextureFormat format,
                                  SDL_FColor color) {
    if ((format == SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM ||
         format == SDL_GPU_TEXTUREFORMAT_B8G8R8A8_UNORM) &&
        std::strcmp(SDL_GetGPUDeviceDriver(device), "metal") == 0) {
        // Metal fast clears can truncate fractional UNORM values.
        const auto channel = [](float value) {
            return std::nearbyint(std::clamp(value, 0.0f, 1.0f) * 255.0f) / 255.0f;
        };
        return {channel(color.r), channel(color.g), channel(color.b), channel(color.a)};
    }
    return color;
}

inline void generate_texture_mipmaps(SDL_GPUDevice* device, SDL_GPUCommandBuffer* command,
                                     SDL_GPUTexture* texture, std::uint32_t width,
                                     std::uint32_t height, std::uint32_t mip_levels,
                                     std::uint32_t layers = 1) {
    if (mip_levels <= 1)
        return;
    if (std::strcmp(SDL_GetGPUDeviceDriver(device), "metal") != 0) {
        SDL_GenerateMipmapsForGPUTexture(command, texture);
        return;
    }
    // Metal's built-in mip generator averages encoded sRGB. The pinned
    // recordMipmaps samples each preceding level through an sRGB-aware blit.
    for (std::uint32_t layer = 0; layer < layers; ++layer) {
        for (std::uint32_t mip = 1; mip < mip_levels; ++mip) {
            SDL_GPUBlitInfo blit{};
            blit.source = {texture,
                           mip - 1,
                           layer,
                           0,
                           0,
                           std::max(1u, width >> (mip - 1)),
                           std::max(1u, height >> (mip - 1))};
            blit.destination = {
                texture, mip, layer, 0, 0, std::max(1u, width >> mip), std::max(1u, height >> mip)};
            blit.load_op = SDL_GPU_LOADOP_DONT_CARE;
            blit.filter = SDL_GPU_FILTER_LINEAR;
            SDL_BlitGPUTexture(command, &blit);
        }
    }
}

/**
 * Copy bytes into a texture that already exists.
 *
 * The upload half of `upload_2d_texture` below, split out because a payload
 * that changes per frame -- the clustered light field's three data textures --
 * needs the copy without a second allocation.
 */
inline void write_sdl_gpu_buffer(SDL_GPUDevice* device, SDL_GPUBuffer* buffer, std::size_t offset,
                                 std::span<const std::uint8_t> bytes, bool cycle) {
    if (!device || !buffer)
        throw std::runtime_error("SDL buffer write has no resource.");
    const auto count = gpu_u32(bytes.size()), start = gpu_u32(offset);
    if (count > std::numeric_limits<Uint32>::max() - start)
        throw std::runtime_error("SDL buffer write exceeds the native API size range.");
    if (bytes.empty())
        return;
    SDL_GPUTransferBufferCreateInfo info{};
    info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD;
    info.size = count;
    OwnedSdlTransfer transfer{SDL_CreateGPUTransferBuffer(device, &info), {device}};
    if (!transfer)
        gpu_error("SDL_CreateGPUTransferBuffer buffer write");
    void* mapped = SDL_MapGPUTransferBuffer(device, transfer.get(), false);
    if (!mapped)
        gpu_error("SDL_MapGPUTransferBuffer buffer write");
    std::memcpy(mapped, bytes.data(), bytes.size());
    SDL_UnmapGPUTransferBuffer(device, transfer.get());
    SdlGpuCommand command{SDL_AcquireGPUCommandBuffer(device)};
    if (!command)
        gpu_error("SDL_AcquireGPUCommandBuffer buffer write");
    SdlCopyPass copy{SDL_BeginGPUCopyPass(command)};
    if (!copy)
        gpu_error("SDL_BeginGPUCopyPass buffer write");
    const SDL_GPUTransferBufferLocation source{transfer.get(), 0};
    const SDL_GPUBufferRegion destination{buffer, start, count};
    SDL_UploadToGPUBuffer(copy, &source, &destination, cycle);
    copy.end();
    if (!command.submit())
        gpu_error("SDL_SubmitGPUCommandBuffer buffer write");
}

inline void write_sdl_gpu_texture(SDL_GPUDevice* device, SDL_GPUTexture* texture,
                                  std::span<const std::uint8_t> bytes,
                                  const GpuTextureWriteLayout& layout, const GpuWriteExtent& extent,
                                  std::uint32_t mip_levels, SdlTextureTransferCache* cache) {
    if (!device || !texture)
        throw std::runtime_error("SDL texture write has no resource.");
    if (!extent.width || !extent.height || !extent.depth_or_array_layers)
        return;
    if (extent.depth_or_array_layers != 1)
        throw std::runtime_error("This SDL texture destination accepts one image per write.");
    const auto count = gpu_u32(bytes.size());
    SDL_GPUTransferBufferCreateInfo info{};
    info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD;
    info.size = count;
    OwnedSdlTransfer temporary{nullptr, {device}};
    SDL_GPUTransferBuffer* transfer = nullptr;
    if (cache) {
        if (!cache->transfer || cache->capacity < count) {
            if (cache->transfer)
                SDL_ReleaseGPUTransferBuffer(device, std::exchange(cache->transfer, nullptr));
            cache->capacity = 0;
            cache->transfer = SDL_CreateGPUTransferBuffer(device, &info);
            if (!cache->transfer)
                gpu_error("SDL_CreateGPUTransferBuffer texture write");
            cache->capacity = count;
        }
        transfer = cache->transfer;
    } else {
        temporary.reset(SDL_CreateGPUTransferBuffer(device, &info));
        transfer = temporary.get();
        if (!transfer)
            gpu_error("SDL_CreateGPUTransferBuffer texture write");
    }
    void* mapped = SDL_MapGPUTransferBuffer(device, transfer, cache != nullptr);
    if (!mapped)
        gpu_error("SDL_MapGPUTransferBuffer texture write");
    std::memcpy(mapped, bytes.data(), bytes.size());
    SDL_UnmapGPUTransferBuffer(device, transfer);
    SdlGpuCommand command{SDL_AcquireGPUCommandBuffer(device)};
    if (!command)
        gpu_error("SDL_AcquireGPUCommandBuffer texture write");
    SdlCopyPass copy{SDL_BeginGPUCopyPass(command)};
    if (!copy)
        gpu_error("SDL_BeginGPUCopyPass texture write");
    const SDL_GPUTextureTransferInfo source{transfer, gpu_u32(layout.offset), extent.width,
                                            layout.rows_per_image.value_or(extent.height)};
    const SDL_GPUTextureRegion destination{texture, 0, 0, 0, 0, 0, extent.width, extent.height, 1};
    SDL_UploadToGPUTexture(copy, &source, &destination, cache != nullptr);
    copy.end();
    generate_texture_mipmaps(device, command, texture, extent.width, extent.height, mip_levels);
    if (!command.submit())
        gpu_error("SDL_SubmitGPUCommandBuffer texture write");
}

/** A texture write recorded in a caller's copy pass, retaining its transfer through submission. */
struct SdlCopyTextureDestination final : GpuObject {
    SDL_GPUDevice* device;
    SDL_GPUCopyPass* pass;
    SDL_GPUTextureRegion target;
    std::vector<OwnedSdlTransfer>& transfers;
    Uint32 pixels_per_row, rows_per_layer;
    std::size_t flip_row_bytes;
    SdlCopyTextureDestination(SDL_GPUDevice* owner, SDL_GPUCopyPass* command,
                              const SDL_GPUTextureRegion& destination,
                              std::vector<OwnedSdlTransfer>& leases, Uint32 pixels = 0,
                              Uint32 rows = 0, std::size_t flipped_row = 0)
        : device(owner), pass(command), target(destination), transfers(leases),
          pixels_per_row(pixels), rows_per_layer(rows), flip_row_bytes(flipped_row) {}
    const void* device_identity() const override { return device; }
    void write_texture_bytes(std::span<const std::uint8_t> bytes,
                             const GpuTextureWriteLayout& layout,
                             const GpuWriteExtent& extent) override {
        if (!pass || !target.texture)
            throw std::runtime_error("SDL texture write has no copy destination.");
        if (flip_row_bytes && (layout.offset != 0 || extent.height > bytes.size() / flip_row_bytes))
            throw std::runtime_error("SDL flipped image exceeds its source bytes.");
        SDL_GPUTransferBufferCreateInfo info{};
        info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD;
        info.size = gpu_u32(bytes.size());
        OwnedSdlTransfer transfer{SDL_CreateGPUTransferBuffer(device, &info), {device}};
        if (!transfer)
            gpu_error("SDL_CreateGPUTransferBuffer texture batch");
        void* mapped = SDL_MapGPUTransferBuffer(device, transfer.get(), false);
        if (!mapped)
            gpu_error("SDL_MapGPUTransferBuffer texture batch");
        if (flip_row_bytes) {
            for (std::size_t row = 0; row < extent.height; ++row)
                std::memcpy(static_cast<std::uint8_t*>(mapped) + row * flip_row_bytes,
                            bytes.data() + (extent.height - row - 1) * flip_row_bytes,
                            flip_row_bytes);
        } else {
            std::memcpy(mapped, bytes.data(), bytes.size());
        }
        SDL_UnmapGPUTransferBuffer(device, transfer.get());
        const SDL_GPUTextureTransferInfo source{
            transfer.get(), gpu_u32(layout.offset), pixels_per_row ? pixels_per_row : extent.width,
            rows_per_layer ? rows_per_layer : layout.rows_per_image.value_or(extent.height)};
        auto destination = target;
        destination.w = extent.width;
        destination.h = extent.height;
        destination.d = extent.depth_or_array_layers;
        SDL_UploadToGPUTexture(pass, &source, &destination, false);
        transfers.push_back(std::move(transfer));
    }
};

inline void upload_2d_texture_into(SDL_GPUDevice* device, SDL_GPUTexture* texture,
                                   const void* bytes, std::size_t byte_size, std::uint32_t width,
                                   std::uint32_t height, const char*,
                                   std::uint32_t mip_levels = 1) {
    if (!bytes && byte_size)
        throw std::runtime_error("SDL texture write has no source bytes.");
    SdlTextureDestination destination{device, texture, mip_levels};
    SdlGpuWriteDevice{device}.write_texture(
        destination, {static_cast<const std::uint8_t*>(bytes), byte_size}, {}, {width, height, 1});
}

/**
 * Collect small buffer creates and rewrites into one SDL_GPU copy pass.
 *
 * Dynamic scenes can add or animate hundreds of independent meshes in one
 * callback. Submitting one command buffer per vertex/index buffer turns that
 * portable operation into a multi-second frame on some drivers. The browser
 * queues the same writes before one queue submission; this batch gives the
 * SDL backend the same command-boundary shape without changing scene data.
 */
class GpuBufferUploadBatch : public SdlGpuWriteDevice {
public:
    explicit GpuBufferUploadBatch(SDL_GPUDevice* owner) : SdlGpuWriteDevice(owner) {}

    GpuBufferUploadBatch(const GpuBufferUploadBatch&) = delete;
    GpuBufferUploadBatch& operator=(const GpuBufferUploadBatch&) = delete;

    // The transfer buffer persists across submits, so a batch that
    // outlives its frame loop stops paying a create/release per frame;
    // SDL defers the actual release past any submit still reading it.
    ~GpuBufferUploadBatch() override {
        if (transfer_) {
            SDL_ReleaseGPUTransferBuffer(device, transfer_);
        }
    }

    SDL_GPUBuffer* upload(SDL_GPUBufferUsageFlags usage, const void* data, std::size_t size) {
        SDL_GPUBufferCreateInfo buffer_info{};
        buffer_info.usage = usage;
        buffer_info.size = static_cast<Uint32>(size);
        SDL_GPUBuffer* buffer = SDL_CreateGPUBuffer(device, &buffer_info);
        if (!buffer)
            gpu_error("SDL_CreateGPUBuffer");
        write_buffer(buffer, 0, data, size, false, size);
        return buffer;
    }

    void update(SDL_GPUBuffer* buffer, const void* data, std::size_t size) {
        write_buffer(buffer, 0u, data, size, true);
    }

    void update(SDL_GPUBuffer* buffer, std::size_t destination_offset, const void* data,
                std::size_t size) {
        // A region rewrite must preserve bytes outside the destination. A
        // cycled backing store has no such contents, so only the legacy
        // whole-buffer arm above may request cycling.
        write_buffer(buffer, destination_offset, data, size, false);
    }

    void submit() {
        if (uploads_.empty())
            return;
        if (transfer_capacity_ < bytes_size_) {
            if (transfer_) {
                SDL_ReleaseGPUTransferBuffer(device, transfer_);
                transfer_ = nullptr;
            }
            SDL_GPUTransferBufferCreateInfo transfer_info{};
            transfer_info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD;
            transfer_info.size = static_cast<Uint32>(bytes_size_);
            transfer_ = SDL_CreateGPUTransferBuffer(device, &transfer_info);
            if (!transfer_) {
                gpu_error("SDL_CreateGPUTransferBuffer buffer batch");
            }
            transfer_capacity_ = bytes_size_;
        }
        // Cycling hands back a fresh backing store when the previous
        // submit still reads the kept transfer buffer, which is what
        // makes reuse across submits safe.
        void* mapped = SDL_MapGPUTransferBuffer(device, transfer_, true);
        if (!mapped)
            gpu_error("SDL_MapGPUTransferBuffer buffer batch");
        std::memcpy(mapped, bytes_.get(), bytes_size_);
        SDL_UnmapGPUTransferBuffer(device, transfer_);

        SdlGpuCommand command{SDL_AcquireGPUCommandBuffer(device)};
        if (!command) {
            gpu_error("SDL_AcquireGPUCommandBuffer buffer batch");
        }
        SdlCopyPass copy{SDL_BeginGPUCopyPass(command)};
        if (!copy)
            gpu_error("SDL_BeginGPUCopyPass buffer batch");
        for (const StagedUpload& upload : uploads_) {
            const SDL_GPUTransferBufferLocation source{
                transfer_,
                static_cast<Uint32>(upload.offset),
            };
            const SDL_GPUBufferRegion destination{
                upload.buffer,
                static_cast<Uint32>(upload.destination_offset),
                static_cast<Uint32>(upload.size),
            };
            SDL_UploadToGPUBuffer(copy, &source, &destination, upload.cycle);
        }
        copy.end();
        if (!command.submit()) {
            gpu_error("SDL_SubmitGPUCommandBuffer buffer batch");
        }
        uploads_.clear();
        bytes_size_ = 0;
    }

private:
    struct Destination final : GpuObject {
        GpuBufferUploadBatch& batch;
        SDL_GPUBuffer* buffer;
        bool cycle;
        std::optional<std::size_t> capacity;
        Destination(GpuBufferUploadBatch& owner, SDL_GPUBuffer* value, bool reuse,
                    std::optional<std::size_t> extent)
            : batch(owner), buffer(value), cycle(reuse), capacity(extent) {}
        const void* device_identity() const override { return batch.device; }
        std::optional<std::size_t> buffer_capacity() const override { return capacity; }
        void write_buffer_bytes(std::size_t offset, std::span<const std::uint8_t> bytes) override {
            batch.stage(buffer, offset, bytes.data(), bytes.size(), cycle);
        }
    };
    void write_buffer(SDL_GPUBuffer* buffer, std::size_t offset, const void* data, std::size_t size,
                      bool cycle, std::optional<std::size_t> capacity = {}) {
        if (!buffer || (!data && size))
            throw std::runtime_error("SDL buffer write has no resource or source bytes.");
        gpu_u32(offset);
        gpu_u32(size);
        if (size > std::numeric_limits<Uint32>::max() - offset)
            throw std::runtime_error("SDL buffer write exceeds the native API size range.");
        Destination destination{*this, buffer, cycle, capacity};
        GpuDevice::write_buffer(destination, offset,
                                {static_cast<const std::uint8_t*>(data), size});
    }

    void stage(SDL_GPUBuffer* buffer, std::size_t destination_offset, const void* data,
               std::size_t size, bool cycle) {
        constexpr std::size_t alignment = 4;
        const std::size_t offset = (bytes_size_ + alignment - 1) & ~(alignment - 1);
        const std::size_t required = offset + size;
        if (required > bytes_capacity_) {
            // Grow like a vector, but without the value-initialization
            // `resize` performs: a streaming frame stages several megabytes
            // of vertices that the memcpy below overwrites in full, and the
            // memset the standard container would run first was a third
            // pass over every byte for nothing.
            const std::size_t capacity = std::max(required, bytes_capacity_ * 2);
            auto grown = std::make_unique_for_overwrite<std::uint8_t[]>(capacity);
            if (bytes_size_ > 0) {
                std::memcpy(grown.get(), bytes_.get(), bytes_size_);
            }
            bytes_ = std::move(grown);
            bytes_capacity_ = capacity;
        }
        std::memcpy(bytes_.get() + offset, data, size);
        bytes_size_ = required;
        uploads_.push_back(StagedUpload{
            .buffer = buffer,
            .offset = offset,
            .destination_offset = destination_offset,
            .size = size,
            .cycle = cycle,
        });
    }

    struct StagedUpload {
        SDL_GPUBuffer* buffer = nullptr;
        std::size_t offset = 0;
        std::size_t destination_offset = 0;
        std::size_t size = 0;
        bool cycle = false;
    };

    // Kept across submits and grown when a frame stages more; released by
    // the destructor.
    SDL_GPUTransferBuffer* transfer_ = nullptr;
    std::size_t transfer_capacity_ = 0;
    std::vector<StagedUpload> uploads_;
    // The staged bytes of one submit; grown without initialization (see
    // `stage`) and reused across submits like the transfer buffer.
    std::unique_ptr<std::uint8_t[]> bytes_;
    std::size_t bytes_size_ = 0;
    std::size_t bytes_capacity_ = 0;
};

inline SDL_GPUBuffer* upload_buffer(SDL_GPUDevice* device, SDL_GPUBufferUsageFlags usage,
                                    const void* data, std::size_t size) {
    SDL_GPUBufferCreateInfo info{};
    info.usage = usage;
    info.size = gpu_u32(size);
    OwnedSdlBuffer buffer{SDL_CreateGPUBuffer(device, &info), {device}};
    if (!buffer)
        gpu_error("SDL_CreateGPUBuffer");
    if (!data && size)
        throw std::runtime_error("SDL buffer write has no source bytes.");
    SdlBufferDestination destination{device, buffer.get(), false};
    SdlGpuWriteDevice{device}.write_buffer(destination, 0,
                                           {static_cast<const std::uint8_t*>(data), size});
    return buffer.release();
}
inline void update_buffer(SDL_GPUDevice* device, SDL_GPUBuffer* buffer, const void* data,
                          std::size_t size) {
    if (!data && size)
        throw std::runtime_error("SDL buffer write has no source bytes.");
    SdlBufferDestination destination{device, buffer, true};
    SdlGpuWriteDevice{device}.write_buffer(destination, 0,
                                           {static_cast<const std::uint8_t*>(data), size});
}

inline SDL_GPUSampler* create_texture_sampler(SDL_GPUDevice* device,
                                              const TextureSamplerState& sampler) {
    SDL_GPUSamplerCreateInfo info{};
    info.min_filter = gpu_filter(sampler.min_filter);
    info.mag_filter = gpu_filter(sampler.mag_filter);
    info.mipmap_mode = gpu_mipmap_mode(sampler.mipmap_mode);
    info.address_mode_u = gpu_address_mode(sampler.address_u);
    info.address_mode_v = gpu_address_mode(sampler.address_v);
    // Mirror the pinned descriptor exactly, as the Dawn twin does: the
    // pin never sets addressModeW, so W stays at the WebGPU clamp
    // default, and only the noMip path overrides the LOD clamp
    // (gltf-sampler-desc.ts leaves lodMaxClamp at the default 32
    // otherwise).
    info.address_mode_w = SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
    info.max_anisotropy = sampler.max_anisotropy;
    info.max_lod = std::min(sampler.max_lod, 32.0f);
    info.enable_anisotropy = sampler.max_anisotropy > 1.0f;
    SDL_GPUSampler* result = SDL_CreateGPUSampler(device, &info);
    if (!result)
        gpu_error("SDL_CreateGPUSampler material texture");
    return result;
}

inline SDL_GPUTexture*
upload_2d_texture(SDL_GPUDevice* device, const void* bytes, std::size_t byte_size,
                  std::uint32_t width, std::uint32_t height, SDL_GPUTextureFormat format,
                  const char* label,
                  // The chain the pinned loader built, which the caller reads off its own
                  // record rather than inferring here: `loadSpriteAtlas` turns mips off
                  // and the atlas a node-particle texture.get() block builds leaves them on.
                  // Generating the levels needs the texture.get() to be a colour target too.
                  std::uint32_t mip_levels = 1u,
                  SDL_GPUTextureUsageFlags read_usage = SDL_GPU_TEXTUREUSAGE_SAMPLER) {
    SDL_GPUTextureCreateInfo texture_info{};
    texture_info.type = SDL_GPU_TEXTURETYPE_2D;
    texture_info.format = format;
    texture_info.usage =
        mip_levels > 1u ? (read_usage | SDL_GPU_TEXTUREUSAGE_COLOR_TARGET) : read_usage;
    texture_info.width = width;
    texture_info.height = height;
    texture_info.layer_count_or_depth = 1;
    texture_info.num_levels = mip_levels;
    texture_info.sample_count = SDL_GPU_SAMPLECOUNT_1;
    OwnedSdlTexture texture{SDL_CreateGPUTexture(device, &texture_info), {device}};
    if (!texture.get())
        gpu_error(label);

    upload_2d_texture_into(device, texture.get(), bytes, byte_size, width, height, label,
                           texture_info.num_levels);
    return texture.release();
}

/**
 * The fragment textures a sprite-family pass binds, in declaration order:
 * the atlas, then whatever a custom shader named.
 *
 * Built once when the pass is, because none of it changes per frame, and
 * shared by both families because the order is the composed program's rather
 * than either family's.
 */
inline void append_sprite_fragment_textures(SDL_GPUDevice* device,
                                            std::vector<SDL_GPUTextureSamplerBinding>& textures,
                                            const std::vector<PixelsTexture>& extras,
                                            const char* label) {
    // The caller's owning pass releases partially populated entries on failure.
    textures.reserve(textures.size() + extras.size());
    for (const PixelsTexture& extra : extras) {
        auto& binding = textures.emplace_back();
        binding.texture = upload_2d_texture(device, extra.rgba.data(), extra.rgba.size(),
                                            extra.width, extra.height,
                                            extra.srgb ? SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM_SRGB
                                                       : SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM,
                                            label);
        binding.sampler = create_texture_sampler(device, extra.sampler);
    }
}

/**
 * Select the dense texture list a compacted sprite-family fragment kept.
 *
 * The owning list is always atlas followed by descriptor extras. DXIL may
 * remove any unused resource and renumber the survivors, so the sidecar's
 * names, rather than that original order, decide what SDL binds.
 */
inline std::vector<SDL_GPUTextureSamplerBinding>
select_sprite_fragment_textures(const PinnedStageSlots& slots,
                                const std::vector<SDL_GPUTextureSamplerBinding>& textures,
                                const std::vector<std::string>& extra_names, const char* what) {
    if (textures.size() != extra_names.size() + 1u) {
        throw std::runtime_error(std::string(what) + " texture metadata is inconsistent.");
    }
    std::vector<SDL_GPUTextureSamplerBinding> selected;
    selected.reserve(slots.textures.size());
    for (const std::string& resource : slots.textures) {
        std::size_t texture_index = 0u;
        if (resource != "atlasTex") {
            const auto found =
                std::find_if(extra_names.begin(), extra_names.end(),
                             [&](const std::string& name) { return resource == name + "Tex"; });
            if (found == extra_names.end()) {
                throw std::runtime_error(std::string(what) + " declares an unresolved texture '" +
                                         resource + "'.");
            }
            texture_index = 1u + static_cast<std::size_t>(found - extra_names.begin());
        }
        selected.push_back(textures[texture_index]);
    }
    return selected;
}

/** Releases owned bindings, including partially populated entries. */
inline void release_sprite_fragment_textures(SDL_GPUDevice* device,
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
