#pragma once

// Dawn mechanics shared by the renderers that draw through it.
//
// Bringing a Dawn device up — SDL window, instance, HWND surface, adapter,
// device, queue, surface configuration — knows nothing about Babylon, and it
// is identical for every renderer. It lived inside `run_dawn_engine` while
// the scene renderer was the only one; the sprite renderer is the second, and
// it is a separate translation unit because a sprite-only scene generates no
// camera or render-plan headers for the scene renderer to include.
//
// The device request carries the two limits a caller may need raised. Both
// are the scene renderer's (instanced vertex attributes, geometry-MRT colour
// budget) and both default to the WebGPU defaults, so a renderer that needs
// neither passes nothing.

#include <bblite/pal.hpp>
#include <bblite/runtime.hpp>

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>

#include <SDL3/SDL.h>
#include <SDL3_image/SDL_image.h>
#include <webgpu/webgpu.h>

#if defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#endif

#ifndef BBLITE_GPU_SHADER_DIR
#define BBLITE_GPU_SHADER_DIR "shaders"
#endif

namespace bbl::pal {

inline std::string view_text(WGPUStringView view) {
    if (!view.data) return {};
    return view.length == WGPU_STRLEN
        ? std::string(view.data)
        : std::string(view.data, view.length);
}

inline WGPUStringView string_view(const char* text) {
    return WGPUStringView{text, WGPU_STRLEN};
}

[[noreturn]] inline void dawn_error(const std::string& message) {
    throw std::runtime_error("Dawn backend: " + message);
}

/**
 * Upload RGBA8 texels as a sampled 2D texture.
 *
 * Shared because a sprite atlas and a custom shader's extra texture are the
 * same upload: tightly packed rows, no mip chain, no sRGB view.
 */
inline WGPUTexture upload_dawn_rgba_texture(
    WGPUDevice device,
    WGPUQueue queue,
    const std::uint8_t* rgba,
    std::size_t bytes,
    std::uint32_t width,
    std::uint32_t height) {
    WGPUTextureDescriptor descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
    descriptor.dimension = WGPUTextureDimension_2D;
    descriptor.format = WGPUTextureFormat_RGBA8Unorm;
    descriptor.usage =
        WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
    descriptor.size = WGPUExtent3D{width, height, 1};
    WGPUTexture texture = wgpuDeviceCreateTexture(device, &descriptor);
    if (!texture) dawn_error("wgpuDeviceCreateTexture rgba texture");
    WGPUTexelCopyTextureInfo destination =
        WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
    destination.texture = texture;
    WGPUTexelCopyBufferLayout layout{};
    layout.bytesPerRow = width * 4u;
    layout.rowsPerImage = height;
    const WGPUExtent3D size{width, height, 1};
    wgpuQueueWriteTexture(
        queue, &destination, rgba, bytes, &layout, &size);
    return texture;
}

inline void wait_for(WGPUInstance instance, WGPUFuture future) {
    WGPUFutureWaitInfo wait_info{};
    wait_info.future = future;
    const WGPUWaitStatus status =
        wgpuInstanceWaitAny(instance, 1, &wait_info, UINT64_MAX);
    if (status != WGPUWaitStatus_Success) {
        dawn_error("wgpuInstanceWaitAny failed.");
    }
}

/** The device-level state every Dawn renderer holds. */
struct DawnDevice {
    SDL_Window* window = nullptr;
    WGPUInstance instance = nullptr;
    WGPUAdapter adapter = nullptr;
    WGPUDevice device = nullptr;
    WGPUQueue queue = nullptr;
    WGPUSurface surface = nullptr;
    WGPUTextureFormat surface_format = WGPUTextureFormat_BGRA8Unorm;
    std::string uncaptured_error;
};

struct DawnDeviceOptions {
    bool hidden_test_pass = false;
    /** Benchmarks present immediately; everything else keeps vsync. */
    bool immediate_present = false;
    /** Zero leaves the WebGPU default in place. */
    std::uint32_t max_vertex_attributes = 0;
    std::uint32_t max_color_attachment_bytes_per_sample = 0;
};

inline void create_dawn_device(
    const EngineOptions& engine_options,
    const DawnDeviceOptions& options,
    DawnDevice& state) {
    if (!SDL_Init(SDL_INIT_VIDEO | SDL_INIT_EVENTS)) {
        dawn_error(std::string("SDL_Init: ") + SDL_GetError());
    }
    state.window = SDL_CreateWindow(
        engine_options.title.c_str(),
        engine_options.width,
        engine_options.height,
        options.hidden_test_pass
            ? SDL_WINDOW_RESIZABLE | SDL_WINDOW_NOT_FOCUSABLE
            : SDL_WINDOW_RESIZABLE);
    if (!state.window) {
        dawn_error(std::string("SDL_CreateWindow: ") + SDL_GetError());
    }

#if defined(_WIN32)
    // Every Dawn shape can reach FXC: builds without built DXC compile
    // through it exclusively, and DXC builds fall back to it when Dawn
    // force-disables use_dxc on adapters below shader model 6. Dawn
    // resolves d3dcompiler_47.dll via absolute-path candidates (module
    // and executable directories) and a final bare-name LoadLibraryEx
    // whose LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR flag is invalid for
    // relative names (ERROR_INVALID_PARAMETER), so with no compiler
    // DLL beside the executable it never reaches System32. Preloading
    // here makes Dawn's own load return the already-loaded module, so
    // packages ship no FXC; the application directory keeps priority
    // over System32, preserving the Chrome-style "ship the exact SDK
    // compiler" override.
    LoadLibraryExW(
        L"d3dcompiler_47.dll",
        nullptr,
        LOAD_LIBRARY_SEARCH_APPLICATION_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
#endif

    static const WGPUInstanceFeatureName instance_features[] = {
        WGPUInstanceFeatureName_TimedWaitAny,
    };
    WGPUInstanceDescriptor instance_descriptor =
        WGPU_INSTANCE_DESCRIPTOR_INIT;
    instance_descriptor.requiredFeatureCount = 1;
    instance_descriptor.requiredFeatures = instance_features;
    state.instance = wgpuCreateInstance(&instance_descriptor);
    if (!state.instance) dawn_error("wgpuCreateInstance failed.");

    void* hwnd = SDL_GetPointerProperty(
        SDL_GetWindowProperties(state.window),
        SDL_PROP_WINDOW_WIN32_HWND_POINTER,
        nullptr);
    void* hinstance = SDL_GetPointerProperty(
        SDL_GetWindowProperties(state.window),
        SDL_PROP_WINDOW_WIN32_INSTANCE_POINTER,
        nullptr);
    if (!hwnd) dawn_error("SDL window exposes no Win32 HWND.");
    WGPUSurfaceSourceWindowsHWND surface_source =
        WGPU_SURFACE_SOURCE_WINDOWS_HWND_INIT;
    surface_source.hinstance = hinstance;
    surface_source.hwnd = hwnd;
    WGPUSurfaceDescriptor surface_descriptor{};
    surface_descriptor.nextInChain = &surface_source.chain;
    state.surface =
        wgpuInstanceCreateSurface(state.instance, &surface_descriptor);
    if (!state.surface) dawn_error("wgpuInstanceCreateSurface failed.");

    WGPURequestAdapterOptions adapter_options =
        WGPU_REQUEST_ADAPTER_OPTIONS_INIT;
#if defined(BBLITE_DAWN_DXC) && BBLITE_DAWN_DXC
    // Chrome's Dawn compiles HLSL with DXC (dxcompiler.dll and
    // dxil.dll ship beside the browser); enable the same adapter
    // toggle so native shader codegen matches the reference captures.
    // Libraries built without DAWN_USE_BUILT_DXC force-ignore the
    // toggle with a console warning, so FXC-only builds skip the
    // request entirely.
    static const char* adapter_toggles[] = {"use_dxc"};
    WGPUDawnTogglesDescriptor toggles = WGPU_DAWN_TOGGLES_DESCRIPTOR_INIT;
    toggles.chain.sType = WGPUSType_DawnTogglesDescriptor;
    toggles.enabledToggleCount = 1;
    toggles.enabledToggles = adapter_toggles;
    adapter_options.nextInChain = &toggles.chain;
#endif
    adapter_options.powerPreference = WGPUPowerPreference_HighPerformance;
    adapter_options.backendType = WGPUBackendType_D3D12;
    adapter_options.compatibleSurface = state.surface;
    WGPURequestAdapterCallbackInfo adapter_callback =
        WGPU_REQUEST_ADAPTER_CALLBACK_INFO_INIT;
    adapter_callback.mode = WGPUCallbackMode_WaitAnyOnly;
    adapter_callback.callback = [](
                                    WGPURequestAdapterStatus status,
                                    WGPUAdapter adapter,
                                    WGPUStringView message,
                                    void* userdata1,
                                    void*) {
        auto* dawn_state = static_cast<DawnDevice*>(userdata1);
        if (status == WGPURequestAdapterStatus_Success) {
            dawn_state->adapter = adapter;
        } else {
            dawn_state->uncaptured_error = view_text(message);
        }
    };
    adapter_callback.userdata1 = &state;
    wait_for(
        state.instance,
        wgpuInstanceRequestAdapter(
            state.instance,
            &adapter_options,
            adapter_callback));
    if (!state.adapter) {
        dawn_error("no D3D12 adapter: " + state.uncaptured_error);
    }

    WGPUDeviceDescriptor device_descriptor = WGPU_DEVICE_DESCRIPTOR_INIT;
    // The pinned engine requests float32-filterable whenever the
    // adapter offers it; the depth-copy r32float texture relies on it.
    // Primitive-index unlocks the triangle-cluster diagnostic shader's
    // `enable primitive_index` directive (attribution captures only).
    std::array<WGPUFeatureName, 2> device_features{};
    std::size_t device_feature_count = 0;
    if (wgpuAdapterHasFeature(
            state.adapter,
            WGPUFeatureName_Float32Filterable)) {
        device_features[device_feature_count++] =
            WGPUFeatureName_Float32Filterable;
    }
    if (wgpuAdapterHasFeature(
            state.adapter,
            WGPUFeatureName_PrimitiveIndex)) {
        device_features[device_feature_count++] =
            WGPUFeatureName_PrimitiveIndex;
    }
    device_descriptor.requiredFeatureCount = device_feature_count;
    device_descriptor.requiredFeatures = device_features.data();
    WGPULimits required_limits = WGPU_LIMITS_INIT;
    bool needs_limits = false;
    if (options.max_vertex_attributes > 0) {
        required_limits.maxVertexAttributes =
            options.max_vertex_attributes;
        needs_limits = true;
    }
    if (options.max_color_attachment_bytes_per_sample > 0) {
        required_limits.maxColorAttachmentBytesPerSample =
            options.max_color_attachment_bytes_per_sample;
        needs_limits = true;
    }
    if (needs_limits) {
        device_descriptor.requiredLimits = &required_limits;
    }
    device_descriptor.uncapturedErrorCallbackInfo.callback =
        [](
            WGPUDevice const*,
            WGPUErrorType,
            WGPUStringView message,
            void* userdata1,
            void*) {
            auto* error = static_cast<std::string*>(userdata1);
            if (error->empty()) *error = view_text(message);
        };
    device_descriptor.uncapturedErrorCallbackInfo.userdata1 =
        &state.uncaptured_error;
    // An explicit device-lost callback keeps Dawn from warning at
    // device creation that none was set. Destroyed is the expected
    // teardown transition; any other reason funnels into the same
    // first-error capture the uncaptured-error callback uses and is
    // thrown at frame end.
    device_descriptor.deviceLostCallbackInfo.mode =
        WGPUCallbackMode_AllowSpontaneous;
    device_descriptor.deviceLostCallbackInfo.callback =
        [](
            WGPUDevice const*,
            WGPUDeviceLostReason reason,
            WGPUStringView message,
            void* userdata1,
            void*) {
            if (reason == WGPUDeviceLostReason_Destroyed) return;
            auto* error = static_cast<std::string*>(userdata1);
            if (error->empty()) {
                *error = "device lost: " + view_text(message);
            }
        };
    device_descriptor.deviceLostCallbackInfo.userdata1 =
        &state.uncaptured_error;
    WGPURequestDeviceCallbackInfo device_callback =
        WGPU_REQUEST_DEVICE_CALLBACK_INFO_INIT;
    device_callback.mode = WGPUCallbackMode_WaitAnyOnly;
    device_callback.callback = [](
                                   WGPURequestDeviceStatus status,
                                   WGPUDevice device,
                                   WGPUStringView message,
                                   void* userdata1,
                                   void*) {
        auto* dawn_state = static_cast<DawnDevice*>(userdata1);
        if (status == WGPURequestDeviceStatus_Success) {
            dawn_state->device = device;
        } else {
            dawn_state->uncaptured_error = view_text(message);
        }
    };
    device_callback.userdata1 = &state;
    wait_for(
        state.instance,
        wgpuAdapterRequestDevice(
            state.adapter,
            &device_descriptor,
            device_callback));
    if (!state.device) {
        dawn_error("device creation failed: " + state.uncaptured_error);
    }
    state.queue = wgpuDeviceGetQueue(state.device);

    WGPUSurfaceConfiguration surface_configuration =
        WGPU_SURFACE_CONFIGURATION_INIT;
    surface_configuration.device = state.device;
    surface_configuration.format = state.surface_format;
    surface_configuration.usage =
        WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_CopySrc;
    surface_configuration.width =
        static_cast<std::uint32_t>(engine_options.width);
    surface_configuration.height =
        static_cast<std::uint32_t>(engine_options.height);
    // Present with vsync like the SDL_GPU backend so the per-frame
    // camera inertia integrates identically across backends;
    // benchmarks keep immediate present (the recorded frame-time
    // numbers depend on it).
    surface_configuration.presentMode = options.immediate_present
        ? WGPUPresentMode_Immediate
        : WGPUPresentMode_Fifo;
    wgpuSurfaceConfigure(state.surface, &surface_configuration);
}

inline WGPUShaderModule load_wgsl_module(
    WGPUDevice device,
    const std::string& base_name) {
    const std::string shader_override =
        environment_variable("BBLITE_GPU_SHADER_DIR");
    const std::string shader_root = shader_override.empty()
        ? join_path(executable_directory(), BBLITE_GPU_SHADER_DIR)
        : shader_override;
    const std::vector<std::uint8_t> bytes = read_binary_file(
        join_path(shader_root, base_name + ".native.wgsl"));
    const std::string source(
        reinterpret_cast<const char*>(bytes.data()),
        bytes.size());
    WGPUShaderSourceWGSL wgsl = WGPU_SHADER_SOURCE_WGSL_INIT;
    wgsl.code = WGPUStringView{source.c_str(), source.size()};
    WGPUShaderModuleDescriptor descriptor{};
    descriptor.nextInChain = &wgsl.chain;
    descriptor.label = string_view(base_name.c_str());
    WGPUShaderModule module =
        wgpuDeviceCreateShaderModule(device, &descriptor);
    if (!module) {
        dawn_error("wgpuDeviceCreateShaderModule " + base_name);
    }
    return module;
}

/**
 * A sampler from a record's `TextureSamplerState`, the Dawn mirror of the
 * SDL_GPU header's `create_texture_sampler`: every renderer that binds a
 * record-described texture (material slots, sprite atlases) derives the
 * descriptor here instead of hardcoding one.
 */
inline WGPUSampler create_texture_sampler(
    WGPUDevice device,
    const TextureSamplerState& sampler) {
    const auto filter = [](TextureFilter value) {
        return value == TextureFilter::nearest
            ? WGPUFilterMode_Nearest
            : WGPUFilterMode_Linear;
    };
    const auto address = [](TextureAddressMode value) {
        return value == TextureAddressMode::clamp
            ? WGPUAddressMode_ClampToEdge
            : value == TextureAddressMode::mirror
                ? WGPUAddressMode_MirrorRepeat
                : WGPUAddressMode_Repeat;
    };
    WGPUSamplerDescriptor descriptor = WGPU_SAMPLER_DESCRIPTOR_INIT;
    descriptor.minFilter = filter(sampler.min_filter);
    descriptor.magFilter = filter(sampler.mag_filter);
    descriptor.mipmapFilter =
        sampler.mipmap_mode == TextureMipmapMode::nearest
            ? WGPUMipmapFilterMode_Nearest
            : WGPUMipmapFilterMode_Linear;
    descriptor.addressModeU = address(sampler.address_u);
    descriptor.addressModeV = address(sampler.address_v);
    // Mirror the pinned descriptor exactly: W stays at the WebGPU
    // clamp default, and only the noMip path overrides the LOD clamp
    // (gltf-sampler-desc.ts leaves lodMaxClamp at the default 32
    // otherwise).
    if (sampler.max_lod < 32.0f) {
        descriptor.lodMaxClamp = sampler.max_lod;
    }
    descriptor.maxAnisotropy = static_cast<std::uint16_t>(
        std::max(1.0f, sampler.max_anisotropy));
    WGPUSampler result = wgpuDeviceCreateSampler(device, &descriptor);
    if (!result) dawn_error("wgpuDeviceCreateSampler material");
    return result;
}

inline void save_capture_png(
    const std::vector<std::uint8_t>& pixels,
    std::uint32_t width,
    std::uint32_t height,
    std::uint32_t bytes_per_row,
    bool bgra,
    const std::string& path) {
    SDL_Surface* surface = SDL_CreateSurface(
        static_cast<int>(width),
        static_cast<int>(height),
        bgra ? SDL_PIXELFORMAT_ARGB8888 : SDL_PIXELFORMAT_ABGR8888);
    if (!surface) {
        dawn_error(std::string("SDL_CreateSurface: ") + SDL_GetError());
    }
    for (std::uint32_t row = 0; row < height; ++row) {
        std::memcpy(
            static_cast<std::uint8_t*>(surface->pixels) +
                static_cast<std::size_t>(row) * surface->pitch,
            pixels.data() +
                static_cast<std::size_t>(row) * bytes_per_row,
            static_cast<std::size_t>(width) * 4);
    }
    const bool saved = IMG_SavePNG(surface, path.c_str());
    SDL_DestroySurface(surface);
    if (!saved) {
        dawn_error(std::string("IMG_SavePNG: ") + SDL_GetError());
    }
}

} // namespace bbl::pal
