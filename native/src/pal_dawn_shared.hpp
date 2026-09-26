#pragma once
#include <bblite/features/compute_buffers.hpp>
#include <bblite/features/compute_mipmaps.hpp>
#include <bblite/features/compute_shaders.hpp>
#include <bblite/features/compute_textures.hpp>
#include <bblite/features/gpu_task_timing.hpp>
#include <bblite/features/has_gamepad.hpp>
#include <bblite/features/offscreen_surfaces.hpp>
#include <bblite/features/storage_readback.hpp>

#include "pal_dawn_device.hpp"
#include "pal_dawn_resources.hpp"
#include "pal_owned_gpu_record.hpp"
#include "pal_device_options.hpp"
#include "pal_gpu_common.hpp"
#include "pal_dawn_completion.hpp"
#include "pal_dawn_formats.hpp"
#if BBLITE_GPU_TASK_TIMING
#include "pal_dawn_gpu_timestamp.hpp"
#endif
#if BBLITE_COMPUTE_SHADERS
#include "pal_dawn_compute_pipeline.hpp"
#endif
#if BBLITE_COMPUTE_TEXTURES
#include "pal_dawn_compute_texture.hpp"
#endif
#if BBLITE_COMPUTE_MIPMAPS
#include "pal_dawn_compute_mipmaps.hpp"
#endif

#if BBLITE_COMPUTE_SHADERS || BBLITE_COMPUTE_MIPMAPS
#include "pal_dawn_compute_commands.hpp"
#endif
#if BBLITE_COMPUTE_BUFFERS
#include "pal_dawn_storage_buffer.hpp"
#if BBLITE_STORAGE_READBACK
#include "pal_dawn_storage_readback.hpp"
#endif
#endif

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
#include <bblite/js_data.hpp>
#include <bblite/upstream/pinned_depth_state.hpp>

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <map>
#include <optional>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include <SDL3/SDL.h>
#if BBLITE_VISUAL_CAPTURE
#include <SDL3_image/SDL_image.h>
#endif
#include <webgpu/webgpu.h>

#if defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#endif

namespace bbl::pal {

// A shared blend tuple in this API's state; the operation is always add
// (`transparent_blend` / `ground_blend`, pal_gpu_shared.hpp). Shared so the
// family headers can call it too.
inline WGPUBlendState blend_state_from(const BlendFactors& factors) {
    WGPUBlendState blend{};
    blend.color.operation = WGPUBlendOperation_Add;
    blend.color.srcFactor = dawn_blend_factor(factors.src_color);
    blend.color.dstFactor = dawn_blend_factor(factors.dst_color);
    blend.alpha.operation = WGPUBlendOperation_Add;
    blend.alpha.srcFactor = dawn_blend_factor(factors.src_alpha);
    blend.alpha.dstFactor = dawn_blend_factor(factors.dst_alpha);
    return blend;
}

inline WGPUStringView string_view(const char* text) { return WGPUStringView{text, WGPU_STRLEN}; }

/**
 * `Count` vertex attributes, each starting from WGPU_VERTEX_ATTRIBUTE_INIT
 * rather than `{}`: WGPUVertexFormat has no zero enumerator, so only the
 * header's own initializer spells the unset format. Callers assign every
 * attribute before a layout reads it.
 */
template <std::size_t Count> std::array<WGPUVertexAttribute, Count> vertex_attribute_array() {
    // Bound once: MSVC does not parse the header's initializer macro inside
    // a pack expansion.
    const WGPUVertexAttribute unset = WGPU_VERTEX_ATTRIBUTE_INIT;
    return [&unset]<std::size_t... Index>(std::index_sequence<Index...>) {
        return std::array<WGPUVertexAttribute, Count>{{(static_cast<void>(Index), unset)...}};
    }(std::make_index_sequence<Count>{});
}

[[noreturn]] inline void dawn_error(const std::string& message) {
    throw GpuTransportError("Dawn backend: " + message);
}

/**
 * Upload RGBA8 texels as a sampled 2D texture.
 *
 * Shared because a sprite atlas and a custom shader's extra texture are the
 * same upload: tightly packed rows, optionally decoded through sRGB.
 * `mip_levels` is the
 * chain the pinned loader built -- one for `loadSpriteAtlas`, the full
 * chain for the `loadTexture2D` a particle graph's texture block reaches --
 * and the caller generates the levels, because the blit that fills them is
 * the frame state's.
 */
inline WGPUTexture upload_dawn_rgba_texture(WGPUDevice device, WGPUQueue queue,
                                            const std::uint8_t* rgba, std::size_t bytes,
                                            std::uint32_t width, std::uint32_t height,
                                            std::uint32_t mip_levels = 1, bool srgb = false) {
    WGPUTextureDescriptor descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
    descriptor.dimension = WGPUTextureDimension_2D;
    descriptor.format = srgb ? WGPUTextureFormat_RGBA8UnormSrgb : WGPUTextureFormat_RGBA8Unorm;
    descriptor.usage = mip_levels > 1
                           ? (WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst |
                              WGPUTextureUsage_RenderAttachment)
                           : (WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst);
    descriptor.mipLevelCount = mip_levels;
    descriptor.size = WGPUExtent3D{width, height, 1};
    DawnTexture texture{wgpuDeviceCreateTexture(device, &descriptor)};
    if (!texture)
        dawn_error("wgpuDeviceCreateTexture rgba texture");
    WGPUTexelCopyTextureInfo destination = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
    destination.texture = texture;
    WGPUTexelCopyBufferLayout layout{};
    layout.bytesPerRow = width * 4u;
    layout.rowsPerImage = height;
    const WGPUExtent3D size{width, height, 1};
    DawnGpuDevice{queue}.write_texture(&destination, rgba, bytes, &layout, &size);
    return texture.release();
}

/**
 * Serves a custom shader's extra texture pair by the names the pin's
 * composer declares it under -- `<name>Tex` and `<name>Samp` -- from the
 * uploads kept in the descriptor's own order. False for any other name.
 */
inline bool serve_dawn_extra_texture(std::string_view declared,
                                     const std::vector<std::string>& names,
                                     const std::vector<DawnSampledTexture>& extras,
                                     WGPUBindGroupEntry& entry) {
    for (std::size_t index = 0; index < names.size() && index < extras.size(); ++index) {
        if (declared == names[index] + "Tex") {
            entry.textureView = extras[index].view;
            return true;
        }
        if (declared == names[index] + "Samp") {
            entry.sampler = extras[index].sampler;
            return true;
        }
    }
    return false;
}

inline void wait_for(WGPUInstance instance, WGPUFuture future) {
    constexpr std::uint64_t maximum_wait_nanoseconds = 60ull * 1'000'000'000ull;
    WGPUFutureWaitInfo wait_info{};
    wait_info.future = future;
    const WGPUWaitStatus status =
        wgpuInstanceWaitAny(instance, 1, &wait_info, maximum_wait_nanoseconds);
    if (status != WGPUWaitStatus_Success) {
        dawn_error("wgpuInstanceWaitAny failed.");
    }
}

/** A synchronous readback mapping; every exit, including decode failure, unmaps it. */
class DawnReadbackMap {
public:
    DawnReadbackMap(DawnDevice& state, WGPUBuffer buffer, std::size_t size) : buffer_(buffer) {
        WGPUBufferMapCallbackInfo callback = WGPU_BUFFER_MAP_CALLBACK_INFO_INIT;
        callback.mode = WGPUCallbackMode_WaitAnyOnly;
        callback.userdata1 = &state.uncaptured_error;
        callback.callback = [](WGPUMapAsyncStatus status, WGPUStringView message, void* userdata,
                               void*) {
            if (status != WGPUMapAsyncStatus_Success) {
                auto& error = *static_cast<std::string*>(userdata);
                if (error.empty()) {
                    error = "readback map failed: " + view_text(message);
                }
            }
        };
        wait_for(state.instance, wgpuBufferMapAsync(buffer, WGPUMapMode_Read, 0, size, callback));
        if (!state.uncaptured_error.empty()) {
            wgpuBufferUnmap(buffer);
            dawn_error(state.uncaptured_error);
        }
        const auto* bytes =
            static_cast<const std::uint8_t*>(wgpuBufferGetConstMappedRange(buffer, 0, size));
        if (!bytes) {
            wgpuBufferUnmap(buffer);
            dawn_error("readback map returned no data.");
        }
        bytes_ = {bytes, size};
    }
    DawnReadbackMap(const DawnReadbackMap&) = delete;
    DawnReadbackMap& operator=(const DawnReadbackMap&) = delete;
    ~DawnReadbackMap() { wgpuBufferUnmap(buffer_); }
    [[nodiscard]] std::span<const std::uint8_t> bytes() const { return bytes_; }

private:
    WGPUBuffer buffer_;
    std::span<const std::uint8_t> bytes_;
};

#if BBLITE_OFFSCREEN_SURFACES
class SharedDawnErrors {
public:
    void report(std::string message) {
        std::lock_guard lock(mutex_);
        if (message_.empty())
            message_ = std::move(message);
    }
    void check() const {
        std::lock_guard lock(mutex_);
        if (!message_.empty())
            dawn_error(message_);
    }

private:
    mutable std::mutex mutex_;
    std::string message_;
};

struct DawnOffscreenDevice final : OffscreenDevice {
    const void* device_identity() const override { return queue; }
#if BBLITE_GPU_TASK_TIMING
    bool supports_gpu_timestamps() const override {
        return wgpuDeviceHasFeature(device, WGPUFeatureName_TimestampQuery) != 0;
    }
    std::shared_ptr<GpuTimestampQuerySet>
    create_gpu_timestamp_query_set(std::uint32_t count) override {
        return std::make_shared<DawnGpuTimestampQuerySet>(instance, device, queue, count);
    }
    std::shared_ptr<GpuTimestampReadback>
    resolve_gpu_timestamps(const std::shared_ptr<GpuTimestampQuerySet>& query_set,
                           std::uint32_t count) override {
        const auto queries = std::dynamic_pointer_cast<DawnGpuTimestampQuerySet>(query_set);
        if (!queries || queries->device != device)
            throw std::runtime_error("GPU timestamp query set belongs to a different device.");
        return std::make_shared<DawnGpuTimestampReadback>(queries, count);
    }
#endif
#if BBLITE_COMPUTE_SHADERS || BBLITE_COMPUTE_MIPMAPS
    void submit_compute_commands(std::span<const ComputeCommand> commands) override {
        submit_dawn_compute_commands(device, queue, commands);
    }
#endif
#if BBLITE_COMPUTE_MIPMAPS
    std::map<std::string, std::shared_ptr<ComputeMipmapPipeline>> mipmap_pipelines;
    std::shared_ptr<ComputeMipmapPipeline>
    prepare_compute_mipmap_pipeline(const std::string& format, const std::string& code) override {
        auto& result = mipmap_pipelines[format];
        if (!result)
            result = create_dawn_compute_mipmap_pipeline(device, format, code);
        return result;
    }
    std::shared_ptr<ComputeMipmapLevel>
    prepare_compute_mipmap_level(const std::shared_ptr<ComputeMipmapPipeline>& pipeline,
                                 const std::shared_ptr<ComputeTextureAllocation>& allocation,
                                 const ComputeTextureDescriptor&, std::uint32_t source_mip,
                                 std::uint32_t target_mip,
                                 std::uint32_t base_array_layer) override {
        return create_dawn_compute_mipmap_level(device, queue, pipeline, allocation, source_mip,
                                                target_mip, base_array_layer);
    }
#endif
#if BBLITE_STORAGE_READBACK
    std::shared_ptr<StorageReadback>
    create_storage_readback(const StorageReadbackDescriptor& descriptor) override {
        return std::make_shared<DawnStorageReadback>(instance, device, queue, descriptor);
    }
#endif
    explicit DawnOffscreenDevice(const DawnDevice& value)
        : instance(value.instance), adapter(value.adapter), device(value.device),
          queue(value.queue), surface_format(value.surface_format) {}
    ComputeShaderLimits compute_shader_limits() const override {
        WGPULimits limits = WGPU_LIMITS_INIT;
        if (wgpuDeviceGetLimits(device, &limits) != WGPUStatus_Success)
            throw std::runtime_error("Dawn compute shader limits are unavailable.");
        return {static_cast<double>(limits.maxBindGroups),
                static_cast<double>(limits.maxBindingsPerBindGroup),
                static_cast<double>(limits.maxUniformBuffersPerShaderStage),
                static_cast<double>(limits.maxStorageBuffersPerShaderStage),
                static_cast<double>(limits.maxDynamicUniformBuffersPerPipelineLayout),
                static_cast<double>(limits.maxDynamicStorageBuffersPerPipelineLayout),
                static_cast<double>(limits.maxSampledTexturesPerShaderStage),
                static_cast<double>(limits.maxSamplersPerShaderStage),
                static_cast<double>(limits.maxStorageTexturesPerShaderStage),
                static_cast<double>(limits.minStorageBufferOffsetAlignment),
                static_cast<double>(limits.maxStorageBufferBindingSize),
                static_cast<double>(limits.maxUniformBufferBindingSize),
                static_cast<double>(limits.maxComputeWorkgroupsPerDimension)};
    }
#if BBLITE_COMPUTE_SHADERS
    std::shared_ptr<ComputeGroupLayout>
    create_compute_group_layout(const ComputeGroupLayoutDescriptor& descriptor) override {
        return create_dawn_compute_group_layout(device, descriptor);
    }
    std::shared_ptr<ComputePipelineLayout>
    create_compute_pipeline_layout(const ComputePipelineLayoutDescriptor& descriptor) override {
        return create_dawn_compute_pipeline_layout(device, descriptor);
    }
    std::shared_ptr<ComputeShaderModule>
    create_compute_shader_module(const ComputeShaderModuleDescriptor& descriptor,
                                 const std::string&) override {
        return create_dawn_compute_shader_module(device, descriptor);
    }
    std::shared_ptr<ComputePipeline>
    create_compute_pipeline(const ComputePipelineDescriptor& descriptor) override {
        return create_dawn_compute_pipeline(device, descriptor);
    }
    std::shared_ptr<ComputeBindGroup>
    create_compute_bind_group(const ComputeBindGroupDescriptor& descriptor) override {
        return create_dawn_compute_bind_group(device, descriptor);
    }
    void dispatch_compute(const ComputeDispatch& dispatch) override {
        dispatch_dawn_compute(device, queue, dispatch);
    }
#endif
#if BBLITE_COMPUTE_BUFFERS
    double minimum_uniform_buffer_offset_alignment() const override {
        WGPULimits limits = WGPU_LIMITS_INIT;
        if (wgpuDeviceGetLimits(device, &limits) != WGPUStatus_Success)
            throw std::runtime_error("Dawn uniform buffer limits are unavailable.");
        return static_cast<double>(limits.minUniformBufferOffsetAlignment);
    }
    double maximum_storage_buffer_size() const override {
        WGPULimits limits = WGPU_LIMITS_INIT;
        if (wgpuDeviceGetLimits(device, &limits) != WGPUStatus_Success)
            throw std::runtime_error("Dawn storage buffer limits are unavailable.");
        return static_cast<double>(limits.maxBufferSize);
    }
    std::shared_ptr<StorageBufferAllocation>
    create_storage_buffer(const StorageBufferDescriptor& options,
                          std::optional<std::span<const std::uint8_t>> initial) override {
        return create_dawn_storage_buffer(device, queue, options, initial);
    }
#endif
#if BBLITE_COMPUTE_TEXTURES
    ComputeTextureCapabilities compute_texture_capabilities() const override {
        WGPULimits limits = WGPU_LIMITS_INIT;
        if (wgpuDeviceGetLimits(device, &limits) != WGPUStatus_Success)
            throw std::runtime_error("Dawn compute texture limits are unavailable.");
        return {{static_cast<double>(limits.maxTextureDimension1D),
                 static_cast<double>(limits.maxTextureDimension2D),
                 static_cast<double>(limits.maxTextureDimension3D),
                 static_cast<double>(limits.maxTextureArrayLayers)},
                wgpuDeviceHasFeature(device, WGPUFeatureName_Float32Filterable) != 0,
                wgpuDeviceHasFeature(device, WGPUFeatureName_TextureFormatsTier1) != 0};
    }
    void create_compute_texture(const ComputeTextureDescriptor& options,
                                ComputeTextureCreated complete) override {
        create_dawn_compute_texture(device, options, std::move(complete));
    }
#endif
    std::unique_ptr<OffscreenCompletion>
    on_submitted_work_done(std::function<void(std::exception_ptr)> complete) override {
        auto state = std::make_shared<DawnCompletionState>(std::move(complete));
        WGPUQueueWorkDoneCallbackInfo callback = WGPU_QUEUE_WORK_DONE_CALLBACK_INFO_INIT;
        callback.mode = WGPUCallbackMode_WaitAnyOnly;
        callback.userdata1 = new std::shared_ptr<DawnCompletionState>(state);
        callback.callback = [](WGPUQueueWorkDoneStatus status, WGPUStringView message,
                               void* userdata, void*) {
            const std::unique_ptr<std::shared_ptr<DawnCompletionState>> handler(
                static_cast<std::shared_ptr<DawnCompletionState>*>(userdata));
            (*handler)->deliver(status == WGPUQueueWorkDoneStatus_Success
                                    ? std::exception_ptr{}
                                    : std::make_exception_ptr(std::runtime_error(
                                          "GPU queue completion failed: " + view_text(message))));
        };
        const auto future = wgpuQueueOnSubmittedWorkDone(queue, callback);
        return std::make_unique<DawnFutureCompletion>(instance, future, std::move(state));
    }
    const WGPUInstance instance;
    const WGPUAdapter adapter;
    const WGPUDevice device;
    const WGPUQueue queue;
    const WGPUTextureFormat surface_format;
};
#endif

struct DawnDeviceHost {
#if BBLITE_OFFSCREEN_SURFACES
    SDL_Window* window = nullptr;
    SharedDawnErrors* shared_errors = nullptr;
#endif
};

inline void select_dawn_surface_configuration(DawnDevice& state, const DeviceOptions& options) {
    WGPUSurfaceCapabilities capabilities = WGPU_SURFACE_CAPABILITIES_INIT;
    if (wgpuSurfaceGetCapabilities(state.surface, state.adapter, &capabilities) !=
        WGPUStatus_Success) {
        dawn_error("surface capabilities are unavailable.");
    }
    auto free_capabilities = js::finally(
        [&capabilities]() noexcept { wgpuSurfaceCapabilitiesFreeMembers(capabilities); });
    state.surface_format = WGPUTextureFormat_Undefined;
    for (const auto preferred : {WGPUTextureFormat_BGRA8Unorm, WGPUTextureFormat_RGBA8Unorm}) {
        for (std::size_t index = 0; index < capabilities.formatCount; ++index) {
            if (capabilities.formats[index] == preferred)
                state.surface_format = preferred;
        }
        if (state.surface_format != WGPUTextureFormat_Undefined)
            break;
    }
    if (state.surface_format == WGPUTextureFormat_Undefined) {
        dawn_error("surface supports neither BGRA8Unorm nor RGBA8Unorm.");
    }
    constexpr auto usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_CopySrc;
    if ((capabilities.usages & usage) != usage) {
        dawn_error("surface does not support rendering with GPU readback.");
    }
    state.present_mode = WGPUPresentMode_Fifo;
    if (options.immediate_present) {
        for (std::size_t index = 0; index < capabilities.presentModeCount; ++index) {
            if (capabilities.presentModes[index] == WGPUPresentMode_Immediate) {
                state.present_mode = WGPUPresentMode_Immediate;
                return;
            }
        }
        std::cerr << "Dawn: immediate presentation is unavailable; using FIFO.\n";
    }
}

inline bool refresh_dawn_android_surface([[maybe_unused]] DawnDevice& state) {
#if defined(__ANDROID__)
    if (!state.window)
        return false;
    const auto properties = SDL_GetWindowProperties(state.window);
    ANativeWindow* window = nullptr;
    {
        if (!SDL_LockProperties(properties))
            dawn_error(SDL_GetError());
        auto unlock = js::finally([properties]() noexcept { SDL_UnlockProperties(properties); });
        window = static_cast<ANativeWindow*>(
            SDL_GetPointerProperty(properties, SDL_PROP_WINDOW_ANDROID_WINDOW_POINTER, nullptr));
        // SDL replaces this handle on resume, even when the drawable size is unchanged.
        // Retain it before the Java thread can release SDL's reference.
        if (window && window != state.android_window)
            ANativeWindow_acquire(window);
    }
    if (!window) {
        state.release_surface();
        return false;
    }
    if (window == state.android_window)
        return false;
    state.release_surface();
    state.android_window = window;
    WGPUSurfaceSourceAndroidNativeWindow source = WGPU_SURFACE_SOURCE_ANDROID_NATIVE_WINDOW_INIT;
    source.window = window;
    WGPUSurfaceDescriptor descriptor{};
    descriptor.nextInChain = &source.chain;
    state.surface = wgpuInstanceCreateSurface(state.instance, &descriptor);
    if (!state.surface)
        dawn_error("wgpuInstanceCreateSurface failed.");
    return true;
#else
    return false;
#endif
}

inline void configure_dawn_surface(DawnDevice& state, std::uint32_t width, std::uint32_t height) {
#if BBLITE_OFFSCREEN_SURFACES
    if (OffscreenRun::current()) {
        state.surface_width = width;
        state.surface_height = height;
        return;
    }
#endif
    WGPUSurfaceConfiguration configuration = WGPU_SURFACE_CONFIGURATION_INIT;
    configuration.device = state.device;
    configuration.format = state.surface_format;
    configuration.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_CopySrc;
    configuration.width = width;
    configuration.height = height;
    configuration.presentMode = state.present_mode;
    wgpuSurfaceConfigure(state.surface, &configuration);
    state.surface_width = width;
    state.surface_height = height;
}

/** An external display clock paces rendering; mailbox avoids a second FIFO display wait. */
inline void set_dawn_display_paced(DawnDevice& state, bool display_paced) {
    auto mode = WGPUPresentMode_Fifo;
    if (display_paced) {
        WGPUSurfaceCapabilities capabilities = WGPU_SURFACE_CAPABILITIES_INIT;
        if (wgpuSurfaceGetCapabilities(state.surface, state.adapter, &capabilities) !=
            WGPUStatus_Success)
            dawn_error("surface presentation capabilities are unavailable.");
        auto free_capabilities = js::finally(
            [&capabilities]() noexcept { wgpuSurfaceCapabilitiesFreeMembers(capabilities); });
        for (std::size_t index = 0; index < capabilities.presentModeCount; ++index)
            if (capabilities.presentModes[index] == WGPUPresentMode_Mailbox)
                mode = WGPUPresentMode_Mailbox;
    }
    if (mode == state.present_mode)
        return;
    state.present_mode = mode;
    configure_dawn_surface(state, state.surface_width, state.surface_height);
}

inline bool resize_dawn_surface(DawnDevice& state, std::uint32_t width, std::uint32_t height) {
    const bool resized = width != state.surface_width || height != state.surface_height;
    const bool replaced = refresh_dawn_android_surface(state);
    if (state.window && !state.surface)
        return false;
    if (resized || replaced)
        configure_dawn_surface(state, width, height);
    return resized;
}

/** Reconfigure the surface without rebuilding render targets on a same-size Android resume. */
inline bool resize_dawn_surface(DawnDevice& state, const EngineOptions& options) {
    if (options.width <= 0 || options.height <= 0)
        return false;
    return resize_dawn_surface(state, static_cast<std::uint32_t>(options.width),
                               static_cast<std::uint32_t>(options.height));
}

inline bool acquire_dawn_surface_texture(DawnDevice& state, WGPUSurfaceTexture& texture) {
    texture = WGPU_SURFACE_TEXTURE_INIT;
    if (!state.surface)
        return false;
    wgpuSurfaceGetCurrentTexture(state.surface, &texture);
    if (texture.status == WGPUSurfaceGetCurrentTextureStatus_SuccessOptimal ||
        texture.status == WGPUSurfaceGetCurrentTextureStatus_SuccessSuboptimal) {
        if (!texture.texture)
            dawn_error("surface acquisition returned no texture.");
#if defined(__ANDROID__)
        state.surface_recovery_pending = false;
#endif
        return true;
    }
    if (auto value = std::exchange(texture.texture, nullptr))
        wgpuTextureRelease(value);
    if (texture.status == WGPUSurfaceGetCurrentTextureStatus_Timeout ||
        texture.status == WGPUSurfaceGetCurrentTextureStatus_Outdated)
        return false;
#if defined(__ANDROID__)
    // Surface destruction can race this frame after SDL event polling. Retry once
    // after the next poll, which blocks through pause and exposes the resumed window.
    if (texture.status == WGPUSurfaceGetCurrentTextureStatus_Lost &&
        !state.surface_recovery_pending) {
        state.release_surface();
        state.surface_recovery_pending = true;
        return false;
    }
#endif
    dawn_error("wgpuSurfaceGetCurrentTexture failed (status " +
               std::to_string(static_cast<int>(texture.status)) + "): " + state.uncaptured_error);
}

inline void create_dawn_device(const EngineOptions& engine_options, const DeviceOptions& options,
                               DawnDevice& state,
                               [[maybe_unused]] const DawnDeviceHost& host = {}) {
#if BBLITE_OFFSCREEN_SURFACES
    if (auto* run = OffscreenRun::current()) {
        auto* shared = dynamic_cast<DawnOffscreenDevice*>(&run->device());
        if (!shared)
            dawn_error("Offscreen surface does not own a Dawn device.");
        if (!wgpuDeviceHasFeature(shared->device, WGPUFeatureName_ImplicitDeviceSynchronization)) {
            dawn_error("Offscreen device was created without implicit device synchronization.");
        }
        WGPULimits limits = WGPU_LIMITS_INIT;
        if (wgpuDeviceGetLimits(shared->device, &limits) != WGPUStatus_Success ||
            options.max_vertex_attributes > limits.maxVertexAttributes ||
            options.max_color_attachment_bytes_per_sample >
                limits.maxColorAttachmentBytesPerSample) {
            dawn_error("Shared offscreen device limits do not satisfy this renderer.");
        }
        // Immutable device/queue handles may cross realms. Every engine's
        // scene records and renderer resources remain on its owning thread.
        state.instance = shared->instance;
        state.adapter = shared->adapter;
        state.device = shared->device;
        state.queue = shared->queue;
        wgpuInstanceAddRef(state.instance);
        wgpuAdapterAddRef(state.adapter);
        wgpuDeviceAddRef(state.device);
        wgpuQueueAddRef(state.queue);
        state.surface_format = shared->surface_format;
        state.surface_width = static_cast<std::uint32_t>(engine_options.width);
        state.surface_height = static_cast<std::uint32_t>(engine_options.height);
        return;
    }
#endif
    SDL_InitFlags init_flags = SDL_INIT_VIDEO | SDL_INIT_EVENTS;
#if BBLITE_HAS_GAMEPAD
    init_flags |= SDL_INIT_GAMEPAD;
#endif
    if (!initialize_run_sdl(init_flags)) {
        dawn_error(std::string("SDL_Init: ") + SDL_GetError());
    }
    state.sdl_initialized = true;
#if BBLITE_OFFSCREEN_SURFACES
    state.owns_window = !host.window;
    // The presentation host owns SDL and its window.
    if (host.window)
        state.sdl_initialized = false;
#endif
    state.window =
#if BBLITE_OFFSCREEN_SURFACES
        host.window ? host.window :
#endif
                    acquire_run_window(
                        engine_options,
                        (options.hidden_test_pass ? SDL_WINDOW_RESIZABLE | SDL_WINDOW_NOT_FOCUSABLE
                                                  : SDL_WINDOW_RESIZABLE)
#if defined(__APPLE__)
                            | SDL_WINDOW_METAL
#endif
                    );
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
    LoadLibraryExW(L"d3dcompiler_47.dll", nullptr,
                   LOAD_LIBRARY_SEARCH_APPLICATION_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
#endif

    static const WGPUInstanceFeatureName instance_features[] = {
        WGPUInstanceFeatureName_TimedWaitAny,
    };
    WGPUInstanceDescriptor instance_descriptor = WGPU_INSTANCE_DESCRIPTOR_INIT;
    instance_descriptor.requiredFeatureCount = 1;
    instance_descriptor.requiredFeatures = instance_features;
    state.instance = wgpuCreateInstance(&instance_descriptor);
    if (!state.instance)
        dawn_error("wgpuCreateInstance failed.");

#if defined(__ANDROID__)
    refresh_dawn_android_surface(state);
    if (!state.surface)
        dawn_error("SDL window exposes no Android native window.");
#else
    WGPUSurfaceDescriptor surface_descriptor{};
#if defined(_WIN32)
    void* hwnd = SDL_GetPointerProperty(SDL_GetWindowProperties(state.window),
                                        SDL_PROP_WINDOW_WIN32_HWND_POINTER, nullptr);
    void* hinstance = SDL_GetPointerProperty(SDL_GetWindowProperties(state.window),
                                             SDL_PROP_WINDOW_WIN32_INSTANCE_POINTER, nullptr);
    if (!hwnd)
        dawn_error("SDL window exposes no Win32 HWND.");
    WGPUSurfaceSourceWindowsHWND surface_source = WGPU_SURFACE_SOURCE_WINDOWS_HWND_INIT;
    surface_source.hinstance = hinstance;
    surface_source.hwnd = hwnd;
    surface_descriptor.nextInChain = &surface_source.chain;
#elif defined(__APPLE__)
    state.metal_view = SDL_Metal_CreateView(state.window);
    if (!state.metal_view)
        dawn_error(std::string("SDL_Metal_CreateView: ") + SDL_GetError());
    WGPUSurfaceSourceMetalLayer metal_source = WGPU_SURFACE_SOURCE_METAL_LAYER_INIT;
    metal_source.layer = SDL_Metal_GetLayer(state.metal_view);
    if (!metal_source.layer)
        dawn_error("SDL Metal view exposes no CAMetalLayer.");
    surface_descriptor.nextInChain = &metal_source.chain;
#elif defined(__linux__)
    const auto window_properties = SDL_GetWindowProperties(state.window);
    WGPUSurfaceSourceXlibWindow xlib_source = WGPU_SURFACE_SOURCE_XLIB_WINDOW_INIT;
    WGPUSurfaceSourceWaylandSurface wayland_source = WGPU_SURFACE_SOURCE_WAYLAND_SURFACE_INIT;
    const char* video_driver = SDL_GetCurrentVideoDriver();
    if (video_driver && SDL_strcmp(video_driver, "x11") == 0) {
        xlib_source.display =
            SDL_GetPointerProperty(window_properties, SDL_PROP_WINDOW_X11_DISPLAY_POINTER, nullptr);
        xlib_source.window = static_cast<uint64_t>(
            SDL_GetNumberProperty(window_properties, SDL_PROP_WINDOW_X11_WINDOW_NUMBER, 0));
        if (!xlib_source.display || !xlib_source.window)
            dawn_error("SDL window exposes no X11 surface.");
        surface_descriptor.nextInChain = &xlib_source.chain;
    } else if (video_driver && SDL_strcmp(video_driver, "wayland") == 0) {
        wayland_source.display = SDL_GetPointerProperty(
            window_properties, SDL_PROP_WINDOW_WAYLAND_DISPLAY_POINTER, nullptr);
        wayland_source.surface = SDL_GetPointerProperty(
            window_properties, SDL_PROP_WINDOW_WAYLAND_SURFACE_POINTER, nullptr);
        if (!wayland_source.display || !wayland_source.surface)
            dawn_error("SDL window exposes no Wayland surface.");
        surface_descriptor.nextInChain = &wayland_source.chain;
    } else {
        dawn_error("Dawn on Linux requires an SDL X11 or Wayland window.");
    }
#else
    dawn_error("Dawn surface integration is unavailable on this platform.");
#endif
    state.surface = wgpuInstanceCreateSurface(state.instance, &surface_descriptor);
    if (!state.surface)
        dawn_error("wgpuInstanceCreateSurface failed.");
#endif

    WGPURequestAdapterOptions adapter_options = WGPU_REQUEST_ADAPTER_OPTIONS_INIT;
#if BBLITE_DAWN_DXC
    // This pin's Dawn compiles HLSL with DXC and loads the matching
    // validator DLL first; enable the same adapter toggle so native
    // shader codegen matches the reference captures.
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
#if defined(_WIN32)
    adapter_options.backendType = WGPUBackendType_D3D12;
#elif defined(__APPLE__)
    adapter_options.backendType = WGPUBackendType_Metal;
#elif defined(__ANDROID__) || defined(__linux__)
    adapter_options.backendType = WGPUBackendType_Vulkan;
#endif
    adapter_options.compatibleSurface = state.surface;
    WGPURequestAdapterCallbackInfo adapter_callback = WGPU_REQUEST_ADAPTER_CALLBACK_INFO_INIT;
    adapter_callback.mode = WGPUCallbackMode_WaitAnyOnly;
    adapter_callback.callback = [](WGPURequestAdapterStatus status, WGPUAdapter adapter,
                                   WGPUStringView message, void* userdata1, void*) {
        auto* dawn_state = static_cast<DawnDevice*>(userdata1);
        if (status == WGPURequestAdapterStatus_Success) {
            dawn_state->adapter = adapter;
        } else {
            dawn_state->uncaptured_error = view_text(message);
        }
    };
    adapter_callback.userdata1 = &state;
    wait_for(state.instance,
             wgpuInstanceRequestAdapter(state.instance, &adapter_options, adapter_callback));
    if (!state.adapter) {
        dawn_error("no compatible GPU adapter: " + state.uncaptured_error);
    }

    WGPUDeviceDescriptor device_descriptor = WGPU_DEVICE_DESCRIPTOR_INIT;
    // `engine.ts` requests each optional feature the adapter offers rather
    // than the ones a scene reaches, so a later enable call needs no second
    // device; this asks for the features that arm of the list this port uses.
    // Float32-filterable is what the depth-copy r32float texture relies on,
    // primitive-index unlocks the triangle-cluster diagnostic shader's
    // `enable primitive_index` directive (attribution captures only), and
    // BC/ASTC are the compressed formats used by packaged texture candidates.
    constexpr std::array optional_features{
        WGPUFeatureName_Float32Filterable,    WGPUFeatureName_PrimitiveIndex,
        WGPUFeatureName_TextureCompressionBC, WGPUFeatureName_TextureCompressionASTC,
        WGPUFeatureName_TimestampQuery,
    };
    // Only requested features are listed: WGPUFeatureName has no zero
    // enumerator to pad a fixed array with.
    std::vector<WGPUFeatureName> device_features;
    device_features.reserve(optional_features.size() + 1);
    for (const WGPUFeatureName feature : optional_features) {
        if (wgpuAdapterHasFeature(state.adapter, feature)) {
            device_features.push_back(feature);
        }
    }
#if BBLITE_OFFSCREEN_SURFACES
    if (host.shared_errors) {
        // A shared native device requires Dawn's explicit threading feature.
        // Command encoders still belong exclusively to their creating thread.
        if (!wgpuAdapterHasFeature(state.adapter, WGPUFeatureName_ImplicitDeviceSynchronization)) {
            dawn_error("adapter lacks implicit device synchronization for offscreen producers.");
        }
        device_features.push_back(WGPUFeatureName_ImplicitDeviceSynchronization);
    }
#endif
    device_descriptor.requiredFeatureCount = device_features.size();
    device_descriptor.requiredFeatures = device_features.data();
    WGPULimits required_limits = WGPU_LIMITS_INIT;
    bool needs_limits = false;
    if (options.max_vertex_attributes > 0) {
        required_limits.maxVertexAttributes = options.max_vertex_attributes;
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
        [](WGPUDevice const*, WGPUErrorType, WGPUStringView message, void* userdata1, void*) {
            auto* error = static_cast<std::string*>(userdata1);
            if (error->empty())
                *error = view_text(message);
        };
    device_descriptor.uncapturedErrorCallbackInfo.userdata1 = &state.uncaptured_error;
    // An explicit device-lost callback keeps Dawn from warning at
    // device creation that none was set. Destroyed is the expected
    // teardown transition; any other reason funnels into the same
    // first-error capture the uncaptured-error callback uses and is
    // thrown at frame end.
    device_descriptor.deviceLostCallbackInfo.mode = WGPUCallbackMode_AllowSpontaneous;
    device_descriptor.deviceLostCallbackInfo.callback =
        [](WGPUDevice const*, WGPUDeviceLostReason reason, WGPUStringView message, void* userdata1,
           void*) {
            if (reason == WGPUDeviceLostReason_Destroyed)
                return;
            auto* device_state = static_cast<DawnDevice*>(userdata1);
            if (device_state->uncaptured_error.empty()) {
                device_state->uncaptured_error = "device lost: " + view_text(message);
            }
            device_state->device_lost = true;
        };
    device_descriptor.deviceLostCallbackInfo.userdata1 = &state;
#if BBLITE_OFFSCREEN_SURFACES
    if (host.shared_errors) {
        device_descriptor.uncapturedErrorCallbackInfo.callback =
            [](WGPUDevice const*, WGPUErrorType, WGPUStringView message, void* errors, void*) {
                static_cast<SharedDawnErrors*>(errors)->report(view_text(message));
            };
        device_descriptor.uncapturedErrorCallbackInfo.userdata1 = host.shared_errors;
        device_descriptor.deviceLostCallbackInfo.callback =
            [](WGPUDevice const*, WGPUDeviceLostReason reason, WGPUStringView message, void* errors,
               void*) {
                if (reason != WGPUDeviceLostReason_Destroyed) {
                    static_cast<SharedDawnErrors*>(errors)->report("device lost: " +
                                                                   view_text(message));
                }
            };
        device_descriptor.deviceLostCallbackInfo.userdata1 = host.shared_errors;
    }
#endif
    WGPURequestDeviceCallbackInfo device_callback = WGPU_REQUEST_DEVICE_CALLBACK_INFO_INIT;
    device_callback.mode = WGPUCallbackMode_WaitAnyOnly;
    device_callback.callback = [](WGPURequestDeviceStatus status, WGPUDevice device,
                                  WGPUStringView message, void* userdata1, void*) {
        auto* dawn_state = static_cast<DawnDevice*>(userdata1);
        if (status == WGPURequestDeviceStatus_Success) {
            dawn_state->device = device;
        } else {
            dawn_state->uncaptured_error = view_text(message);
        }
    };
    device_callback.userdata1 = &state;
    wait_for(state.instance,
             wgpuAdapterRequestDevice(state.adapter, &device_descriptor, device_callback));
    if (!state.device) {
        dawn_error("device creation failed: " + state.uncaptured_error);
    }
    state.queue = wgpuDeviceGetQueue(state.device);

    // Present with vsync like the SDL_GPU backend so the per-frame
    // camera inertia integrates identically across backends;
    // benchmarks keep immediate present (the recorded frame-time
    // numbers depend on it).
    select_dawn_surface_configuration(state, options);
    configure_dawn_surface(state, static_cast<std::uint32_t>(engine_options.width),
                           static_cast<std::uint32_t>(engine_options.height));
}

/** A deployed shader artifact: `<stem><suffix>` in the shader directory. */
inline std::vector<std::uint8_t> read_dawn_shader_file(const std::string& base_name,
                                                       std::string_view suffix) {
    const std::string shader_override = environment_variable("BBLITE_GPU_SHADER_DIR");
    const std::string shader_root = shader_override.empty()
                                        ? join_path(executable_directory(), BBLITE_GPU_SHADER_DIR)
                                        : shader_override;
    return read_binary_file(join_path(shader_root, base_name + std::string(suffix)));
}

inline WGPUShaderModule load_wgsl_module(WGPUDevice device, const std::string& base_name) {
    const std::vector<std::uint8_t> bytes = read_dawn_shader_file(base_name, ".native.wgsl");
    const std::string source(reinterpret_cast<const char*>(bytes.data()), bytes.size());
    WGPUShaderSourceWGSL wgsl = WGPU_SHADER_SOURCE_WGSL_INIT;
    wgsl.code = WGPUStringView{source.c_str(), source.size()};
    WGPUShaderModuleDescriptor descriptor{};
    descriptor.nextInChain = &wgsl.chain;
    descriptor.label = string_view(base_name.c_str());
    DawnShaderModule module{wgpuDeviceCreateShaderModule(device, &descriptor)};
    if (!module) {
        dawn_error("wgpuDeviceCreateShaderModule " + base_name);
    }
    return module.release();
}

/** One bit per binding index, for a `DawnLayoutBindingModel` set. */
constexpr std::uint64_t dawn_binding_bit(std::uint32_t binding) {
    return std::uint64_t{1} << binding;
}

/** A stage a layout reflects: the deployed stem and the stage it runs as. */
struct DawnLayoutStage {
    std::string_view stem;
    WGPUShaderStage stage;
};

/**
 * What a layout needs beyond the module's own declarations: how the site
 * binds a group. WGSL states a buffer's type but not whether a pass binds it
 * at a dynamic offset, and a texture's sample type but not whether the
 * format bound there filters -- an rgba32float texture read through
 * `textureSampleLevel` is `unfilterable-float`, and the sampler that
 * reads it `non-filtering`, only because of that format. Each set holds
 * `dawn_binding_bit`s of the group's bindings.
 */
struct DawnLayoutBindingModel {
    std::uint64_t dynamic_offsets = 0;
    /** Float textures whose format does not filter, and their samplers. */
    std::uint64_t unfilterable = 0;
};

/**
 * One `@binding` line of a stage's `.slots` sidecar: the layout shape
 * the shader step reflected off the stage's module, visibility aside,
 * and the name the module declares the binding under.
 */
struct DawnReflectedBinding {
    std::uint32_t group = 0;
    std::string name;
    WGPUBindGroupLayoutEntry entry = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
    /** A resource the shader may write, which no vertex stage may see. */
    bool writable = false;
};

inline WGPUTextureViewDimension dawn_reflected_view_dimension(std::string_view value,
                                                              std::string_view stem) {
    static constexpr std::pair<std::string_view, WGPUTextureViewDimension> dimensions[] = {
        {"1d", WGPUTextureViewDimension_1D},
        {"2d", WGPUTextureViewDimension_2D},
        {"2d-array", WGPUTextureViewDimension_2DArray},
        {"3d", WGPUTextureViewDimension_3D},
        {"cube", WGPUTextureViewDimension_Cube},
        {"cube-array", WGPUTextureViewDimension_CubeArray}};
    for (const auto& [name, dimension] : dimensions)
        if (name == value)
            return dimension;
    dawn_error(std::string(stem) + ".slots names view dimension '" + std::string(value) + "'.");
}

inline WGPUTextureSampleType dawn_reflected_sample_type(std::string_view value,
                                                        std::string_view stem) {
    static constexpr std::pair<std::string_view, WGPUTextureSampleType> types[] = {
        {"float", WGPUTextureSampleType_Float},
        {"unfilterable-float", WGPUTextureSampleType_UnfilterableFloat},
        {"depth", WGPUTextureSampleType_Depth},
        {"sint", WGPUTextureSampleType_Sint},
        {"uint", WGPUTextureSampleType_Uint}};
    for (const auto& [name, type] : types)
        if (name == value)
            return type;
    dawn_error(std::string(stem) + ".slots names sample type '" + std::string(value) + "'.");
}

/** Parses one `@binding <group> <binding> <name> <resource...>` line. */
inline DawnReflectedBinding parse_dawn_reflected_binding(std::string_view line,
                                                         std::string_view stem) {
    std::vector<std::string_view> words;
    for (std::size_t start = 0; start < line.size();) {
        const std::size_t end = std::min(line.find(' ', start), line.size());
        if (end > start)
            words.push_back(line.substr(start, end - start));
        start = end + 1;
    }
    const auto malformed = [&]() -> DawnReflectedBinding {
        dawn_error(std::string(stem) + ".slots has a malformed layout line '" + std::string(line) +
                   "'.");
    };
    const auto number = [&](std::string_view word) {
        const std::optional<std::uint32_t> value = parse_sidecar_index(word);
        if (!value)
            malformed();
        return value.value_or(0u);
    };
    if (words.size() < 5)
        return malformed();
    DawnReflectedBinding row;
    row.group = number(words[1]);
    row.entry.binding = number(words[2]);
    row.name = words[3];
    const std::string_view resource = words[4];
    if (resource == "uniform" && words.size() == 5) {
        row.entry.buffer.type = WGPUBufferBindingType_Uniform;
    } else if (resource == "storage" && words.size() == 6) {
        row.writable = words[5] == "read_write";
        if (!row.writable && words[5] != "read")
            return malformed();
        row.entry.buffer.type =
            row.writable ? WGPUBufferBindingType_Storage : WGPUBufferBindingType_ReadOnlyStorage;
    } else if (resource == "sampler" && words.size() == 6) {
        if (words[5] != "filtering" && words[5] != "comparison")
            return malformed();
        row.entry.sampler.type = words[5] == "comparison" ? WGPUSamplerBindingType_Comparison
                                                          : WGPUSamplerBindingType_Filtering;
    } else if (resource == "texture" && words.size() == 8) {
        if (words[7] != "single" && words[7] != "multisampled")
            return malformed();
        row.entry.texture.sampleType = dawn_reflected_sample_type(words[5], stem);
        row.entry.texture.viewDimension = dawn_reflected_view_dimension(words[6], stem);
        row.entry.texture.multisampled = words[7] == "multisampled";
    } else if (resource == "storage-texture") {
        // No reached render stage writes a storage texture; the compute
        // families lay theirs out from the pin's own binding descriptors.
        dawn_error(std::string(stem) + " declares a storage texture at @group(" +
                   std::to_string(row.group) + ") @binding(" + std::to_string(row.entry.binding) +
                   "), which no reflected render layout represents.");
    } else {
        return malformed();
    }
    return row;
}

/** Every `@binding` line of a deployed stage's `.slots` sidecar. */
inline std::vector<DawnReflectedBinding> read_dawn_reflected_bindings(std::string_view stem) {
    const std::vector<std::uint8_t> bytes = read_dawn_shader_file(std::string(stem), ".slots");
    const std::string_view text(reinterpret_cast<const char*>(bytes.data()), bytes.size());
    constexpr std::string_view prefix = "@binding ";
    std::vector<DawnReflectedBinding> rows;
    for_each_sidecar_line(text, [&](std::string_view line) {
        if (line.starts_with(prefix))
            rows.push_back(parse_dawn_reflected_binding(line, stem));
    });
    return rows;
}

/** Whether two stages declare one binding as the same resource. */
inline bool same_dawn_binding_shape(const WGPUBindGroupLayoutEntry& left,
                                    const WGPUBindGroupLayoutEntry& right) {
    return left.buffer.type == right.buffer.type && left.sampler.type == right.sampler.type &&
           left.texture.sampleType == right.texture.sampleType &&
           left.texture.viewDimension == right.texture.viewDimension &&
           left.texture.multisampled == right.texture.multisampled;
}

/** One entry of a reflected group layout, and the name its modules declare it under. */
struct DawnReflectedLayoutEntry {
    WGPUBindGroupLayoutEntry entry;
    std::string name;
};

/**
 * Group `group` of a pipeline, laid out from what its stages' modules
 * declare there -- the `@binding` lines the shader step reflected into each
 * stage's `.slots` sidecar -- and the site's binding model, in binding order.
 *
 * A binding is visible to every stage whose module declares it, except that
 * no vertex stage sees a resource the shader may write. A texture one stage
 * samples and another only loads is filterable in both. Two stages that
 * declare one binding as different resources or under different names, and a
 * binding model naming a binding the group does not declare as that kind of
 * resource, refuse.
 */
inline std::vector<DawnReflectedLayoutEntry>
dawn_reflected_layout(std::span<const DawnLayoutStage> stages, std::uint32_t group,
                      const DawnLayoutBindingModel& model = {}) {
    std::vector<DawnReflectedLayoutEntry> named;
    const std::string label = [&] {
        std::string joined;
        for (const DawnLayoutStage& stage : stages)
            joined += (joined.empty() ? "" : "+") + std::string(stage.stem);
        return joined + " @group(" + std::to_string(group) + ")";
    }();
    for (const DawnLayoutStage& stage : stages) {
        for (DawnReflectedBinding row : read_dawn_reflected_bindings(stage.stem)) {
            if (row.group != group)
                continue;
            const WGPUShaderStage visibility = row.writable && stage.stage == WGPUShaderStage_Vertex
                                                   ? WGPUShaderStage_None
                                                   : stage.stage;
            const auto found = std::find_if(named.begin(), named.end(), [&](const auto& declared) {
                return declared.entry.binding == row.entry.binding;
            });
            if (found == named.end()) {
                row.entry.visibility = visibility;
                named.push_back({row.entry, std::move(row.name)});
                continue;
            }
            if (found->name != row.name)
                dawn_error(label + " binding " + std::to_string(row.entry.binding) +
                           " is declared under different names by its stages.");
            WGPUBindGroupLayoutEntry* const existing = &found->entry;
            const bool float_pair =
                existing->texture.sampleType != WGPUTextureSampleType_BindingNotUsed &&
                row.entry.texture.sampleType != WGPUTextureSampleType_BindingNotUsed &&
                existing->texture.viewDimension == row.entry.texture.viewDimension &&
                existing->texture.multisampled == row.entry.texture.multisampled &&
                (existing->texture.sampleType == WGPUTextureSampleType_Float ||
                 existing->texture.sampleType == WGPUTextureSampleType_UnfilterableFloat) &&
                (row.entry.texture.sampleType == WGPUTextureSampleType_Float ||
                 row.entry.texture.sampleType == WGPUTextureSampleType_UnfilterableFloat);
            if (!float_pair && !same_dawn_binding_shape(*existing, row.entry))
                dawn_error(label + " binding " + std::to_string(row.entry.binding) +
                           " is declared as different resources by its stages.");
            if (float_pair && row.entry.texture.sampleType == WGPUTextureSampleType_Float)
                existing->texture.sampleType = WGPUTextureSampleType_Float;
            existing->visibility |= visibility;
        }
    }
    const auto claim = [&](std::uint64_t bits, const char* what, auto&& accepts, auto&& apply) {
        for (std::uint32_t binding = 0; bits != 0; ++binding, bits >>= 1) {
            if (!(bits & 1))
                continue;
            const auto found = std::find_if(named.begin(), named.end(), [&](const auto& declared) {
                return declared.entry.binding == binding;
            });
            if (found == named.end() || !accepts(found->entry))
                dawn_error(label + " binds " + std::to_string(binding) + " " + what +
                           ", which its modules do not declare there.");
            apply(found->entry);
        }
    };
    claim(
        model.dynamic_offsets, "at a dynamic offset",
        [](const WGPUBindGroupLayoutEntry& entry) {
            return entry.buffer.type != WGPUBufferBindingType_BindingNotUsed;
        },
        [](WGPUBindGroupLayoutEntry& entry) { entry.buffer.hasDynamicOffset = true; });
    claim(
        model.unfilterable, "as an unfilterable texture or its sampler",
        [](const WGPUBindGroupLayoutEntry& entry) {
            return entry.texture.sampleType == WGPUTextureSampleType_Float ||
                   entry.texture.sampleType == WGPUTextureSampleType_UnfilterableFloat ||
                   entry.sampler.type == WGPUSamplerBindingType_Filtering;
        },
        [](WGPUBindGroupLayoutEntry& entry) {
            if (entry.sampler.type == WGPUSamplerBindingType_Filtering)
                entry.sampler.type = WGPUSamplerBindingType_NonFiltering;
            else
                entry.texture.sampleType = WGPUTextureSampleType_UnfilterableFloat;
        });
    for (const DawnReflectedLayoutEntry& declared : named) {
        if (declared.entry.visibility == WGPUShaderStage_None)
            dawn_error(label + " binding " + std::to_string(declared.entry.binding) +
                       " is writable and declared only by a vertex stage.");
    }
    std::sort(named.begin(), named.end(), [](const auto& left, const auto& right) {
        return left.entry.binding < right.entry.binding;
    });
    return named;
}

/** The entries of `dawn_reflected_layout`, as a group layout takes them. */
inline std::vector<WGPUBindGroupLayoutEntry>
dawn_reflected_layout_entries(std::span<const DawnLayoutStage> stages, std::uint32_t group,
                              const DawnLayoutBindingModel& model = {}) {
    std::vector<WGPUBindGroupLayoutEntry> entries;
    for (const DawnReflectedLayoutEntry& declared : dawn_reflected_layout(stages, group, model))
        entries.push_back(declared.entry);
    return entries;
}

/** How many groups a pipeline over `stages` lays out: one past the highest declared. */
inline std::uint32_t dawn_reflected_group_count(std::span<const DawnLayoutStage> stages) {
    std::uint32_t count = 0;
    for (const DawnLayoutStage& stage : stages) {
        for (const DawnReflectedBinding& row : read_dawn_reflected_bindings(stage.stem))
            count = std::max(count, row.group + 1u);
    }
    return count;
}

/** The group layout `dawn_reflected_layout_entries` describes; the caller owns it. */
inline WGPUBindGroupLayout create_dawn_reflected_layout(WGPUDevice device,
                                                        std::span<const DawnLayoutStage> stages,
                                                        std::uint32_t group,
                                                        const DawnLayoutBindingModel& model = {}) {
    const std::vector<WGPUBindGroupLayoutEntry> entries =
        dawn_reflected_layout_entries(stages, group, model);
    WGPUBindGroupLayoutDescriptor descriptor = WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
    descriptor.entryCount = entries.size();
    descriptor.entries = entries.data();
    WGPUBindGroupLayout layout = wgpuDeviceCreateBindGroupLayout(device, &descriptor);
    if (!layout)
        dawn_error("reflected bind group layout for @group(" + std::to_string(group) + ")");
    return layout;
}

/**
 * A bind group over `layout`, whose entries `declared` lists: each binding
 * takes the resource `serve(name, entry)` fills in for the name the module
 * declares it under. A binding the site cannot serve -- `serve` returns
 * false -- refuses, naming it.
 */
template <typename Serve>
WGPUBindGroup create_dawn_named_group(WGPUDevice device, WGPUBindGroupLayout layout,
                                      std::span<const DawnReflectedLayoutEntry> declared,
                                      std::uint32_t group, Serve&& serve) {
    std::vector<WGPUBindGroupEntry> entries;
    for (const DawnReflectedLayoutEntry& binding : declared) {
        WGPUBindGroupEntry entry = WGPU_BIND_GROUP_ENTRY_INIT;
        entry.binding = binding.entry.binding;
        if (!serve(std::string_view(binding.name), entry)) {
            dawn_error("@group(" + std::to_string(group) + ") @binding(" +
                       std::to_string(binding.entry.binding) + ") '" + binding.name +
                       "' is declared by a module this pass does not bind it for.");
        }
        entries.push_back(entry);
    }
    WGPUBindGroupDescriptor descriptor = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    descriptor.layout = layout;
    descriptor.entryCount = entries.size();
    descriptor.entries = entries.data();
    WGPUBindGroup bound = wgpuDeviceCreateBindGroup(device, &descriptor);
    if (!bound)
        dawn_error("reflected bind group for @group(" + std::to_string(group) + ")");
    return bound;
}

/** `create_dawn_named_group` over what `stages` declare in group `group`. */
template <typename Serve>
WGPUBindGroup create_dawn_reflected_group(WGPUDevice device, WGPUBindGroupLayout layout,
                                          std::span<const DawnLayoutStage> stages,
                                          std::uint32_t group, Serve&& serve) {
    const std::vector<DawnReflectedLayoutEntry> declared = dawn_reflected_layout(stages, group);
    return create_dawn_named_group(device, layout, declared, group, std::forward<Serve>(serve));
}

/**
 * The pinned mip generator (`src/texture/generate-mipmaps.ts`): one blit
 * pipeline per format over the deployed `mip-blit` module, sampling each
 * level from the one above with the bilinear sampler.
 *
 * It lives at the device level rather than on the scene driver's state
 * because two drivers build atlases the pinned `loadTexture2D` gave a mip
 * chain: the scene renderer's billboard passes, and the pure-2D sprite
 * driver's layers over a node-particle texture.
 */
struct DawnMipGenerator {
    DawnShaderModule module;
    DawnSampler sampler;
    std::map<WGPUTextureFormat, DawnRenderPipeline> pipelines;
};

inline void release_dawn_mip_generator(DawnMipGenerator& mips) {
    mips.pipelines.clear();
    mips.sampler.reset();
    mips.module.reset();
}

/**
 * The pin's bilinear sampler (`resource/samplers.ts` getBilinearSampler):
 * linear filters and WebGPU-default clamp addressing. The mip generator and
 * the transmission grab's single-sample arm both sample through it.
 */
inline WGPUSampler create_dawn_bilinear_sampler(WGPUDevice device) {
    WGPUSamplerDescriptor sampler_descriptor = WGPU_SAMPLER_DESCRIPTOR_INIT;
    sampler_descriptor.magFilter = WGPUFilterMode_Linear;
    sampler_descriptor.minFilter = WGPUFilterMode_Linear;
    return require_dawn_resource(wgpuDeviceCreateSampler(device, &sampler_descriptor),
                                 "bilinear sampler");
}

inline WGPURenderPipeline mip_pipeline_for(WGPUDevice device, DawnMipGenerator& mips,
                                           WGPUTextureFormat format) {
    const auto existing = mips.pipelines.find(format);
    if (existing != mips.pipelines.end())
        return existing->second;
    if (!mips.module) {
        // The pin's module, deployed whole: both stages enter where the
        // module declares its entry points.
        mips.module = load_wgsl_module(device, "mip-blit.frag");
        mips.sampler = create_dawn_bilinear_sampler(device);
    }
    WGPURenderPipelineDescriptor descriptor = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    descriptor.vertex.module = mips.module;
    descriptor.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    WGPUColorTargetState color_target = WGPU_COLOR_TARGET_STATE_INIT;
    color_target.format = format;
    WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
    fragment.module = mips.module;
    fragment.targetCount = 1;
    fragment.targets = &color_target;
    descriptor.fragment = &fragment;
    DawnRenderPipeline pipeline{require_dawn_resource(
        wgpuDeviceCreateRenderPipeline(device, &descriptor), "mip blit pipeline")};
    const auto result = pipeline.get();
    mips.pipelines.emplace(format, std::move(pipeline));
    return result;
}

// The pinned generator blits one face at a time for cube textures
// (recordMipmaps' optional layer): views become single-layer 2D. The
// record variant encodes into a caller-owned encoder (the pinned
// recordMipmaps) so mid-frame chains stay ordered with the frame.
inline void record_mipmaps(WGPUDevice device, DawnMipGenerator& mips, WGPUCommandEncoder encoder,
                           WGPUTexture texture, WGPUTextureFormat format, std::uint32_t mip_count,
                           std::int32_t face = -1) {
    if (mip_count <= 1)
        return;
    WGPURenderPipeline pipeline = mip_pipeline_for(device, mips, format);
    DawnBindGroupLayout layout{
        require_dawn_resource(wgpuRenderPipelineGetBindGroupLayout(pipeline, 0), "mip layout")};
    for (std::uint32_t level = 1; level < mip_count; ++level) {
        WGPUTextureViewDescriptor source_descriptor = WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
        source_descriptor.baseMipLevel = level - 1;
        source_descriptor.mipLevelCount = 1;
        WGPUTextureViewDescriptor target_descriptor = WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
        target_descriptor.baseMipLevel = level;
        target_descriptor.mipLevelCount = 1;
        if (face >= 0) {
            source_descriptor.dimension = WGPUTextureViewDimension_2D;
            source_descriptor.baseArrayLayer = static_cast<std::uint32_t>(face);
            source_descriptor.arrayLayerCount = 1;
            target_descriptor.dimension = WGPUTextureViewDimension_2D;
            target_descriptor.baseArrayLayer = static_cast<std::uint32_t>(face);
            target_descriptor.arrayLayerCount = 1;
        }
        DawnTextureView source{create_dawn_texture_view(texture, &source_descriptor)};
        DawnTextureView target{create_dawn_texture_view(texture, &target_descriptor)};

        std::array<WGPUBindGroupEntry, 2> entries{};
        entries[0] = WGPU_BIND_GROUP_ENTRY_INIT;
        entries[0].binding = 0;
        entries[0].textureView = source;
        entries[1] = WGPU_BIND_GROUP_ENTRY_INIT;
        entries[1].binding = 1;
        entries[1].sampler = mips.sampler;
        WGPUBindGroupDescriptor bind_descriptor = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        bind_descriptor.layout = layout;
        bind_descriptor.entryCount = entries.size();
        bind_descriptor.entries = entries.data();
        DawnBindGroup bind_group{require_dawn_resource(
            wgpuDeviceCreateBindGroup(device, &bind_descriptor), "mip binding")};

        WGPURenderPassColorAttachment color_attachment = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
        color_attachment.view = target;
        color_attachment.loadOp = WGPULoadOp_Clear;
        color_attachment.storeOp = WGPUStoreOp_Store;
        WGPURenderPassDescriptor pass_descriptor = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
        pass_descriptor.colorAttachmentCount = 1;
        pass_descriptor.colorAttachments = &color_attachment;
        DawnRenderPass pass{require_dawn_resource(
            wgpuCommandEncoderBeginRenderPass(encoder, &pass_descriptor), "mip render pass")};
        wgpuRenderPassEncoderSetPipeline(pass, pipeline);
        wgpuRenderPassEncoderSetBindGroup(pass, 0, bind_group, 0, nullptr);
        wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0);
        wgpuRenderPassEncoderEnd(pass);
    }
}

/** The whole chain in one submitted encoder, for a texture uploaded once. */
inline void generate_mipmaps(WGPUDevice device, WGPUQueue queue, DawnMipGenerator& mips,
                             WGPUTexture texture, WGPUTextureFormat format, std::uint32_t mip_count,
                             std::int32_t face = -1) {
    if (mip_count <= 1)
        return;
    DawnCommandEncoder encoder{
        require_dawn_resource(wgpuDeviceCreateCommandEncoder(device, nullptr), "mip encoder")};
    record_mipmaps(device, mips, encoder, texture, format, mip_count, face);
    DawnCommandBuffer command{
        require_dawn_resource(wgpuCommandEncoderFinish(encoder, nullptr), "mip command")};
    const auto submitted = command.get();
    wgpuQueueSubmit(queue, 1, &submitted);
}

/**
 * A sampler from a record's `TextureSamplerState`, the Dawn mirror of the
 * SDL_GPU header's `create_texture_sampler`: every renderer that binds a
 * record-described texture (material slots, sprite atlases) derives the
 * descriptor here instead of hardcoding one.
 */
inline WGPUSampler create_texture_sampler(WGPUDevice device, const TextureSamplerState& sampler) {
    WGPUSamplerDescriptor descriptor = WGPU_SAMPLER_DESCRIPTOR_INIT;
    descriptor.minFilter = dawn_filter_mode(sampler.min_filter);
    descriptor.magFilter = dawn_filter_mode(sampler.mag_filter);
    descriptor.mipmapFilter = dawn_mipmap_filter_mode(sampler.mipmap_mode);
    descriptor.addressModeU = dawn_address_mode(sampler.address_u);
    descriptor.addressModeV = dawn_address_mode(sampler.address_v);
    // Mirror the pinned descriptor exactly: W stays at the WebGPU
    // clamp default, and only the noMip path overrides the LOD clamp
    // (gltf-sampler-desc.ts leaves lodMaxClamp at the default 32
    // otherwise).
    if (sampler.max_lod < 32.0f) {
        descriptor.lodMaxClamp = sampler.max_lod;
    }
    descriptor.maxAnisotropy = static_cast<std::uint16_t>(std::max(1.0f, sampler.max_anisotropy));
    DawnSampler result{wgpuDeviceCreateSampler(device, &descriptor)};
    if (!result)
        dawn_error("wgpuDeviceCreateSampler material");
    return result.release();
}

/** Uploads one extra texture with the sampler its record carries. */
inline DawnSampledTexture upload_dawn_extra_texture(WGPUDevice device, WGPUQueue queue,
                                                    const PixelsTexture& extra) {
    DawnSampledTexture texture;
    texture.texture = upload_dawn_rgba_texture(device, queue, extra.rgba.data(), extra.rgba.size(),
                                               extra.width, extra.height, 1, extra.srgb);
    texture.view = create_dawn_texture_view(texture.texture, nullptr);
    texture.sampler = create_texture_sampler(device, extra.sampler);
    texture.uploaded_version = extra.version;
    return texture;
}

/** Replaces the base level of an existing dynamic extra texture. */
inline void update_dawn_extra_texture(WGPUQueue queue, DawnSampledTexture& uploaded,
                                      const PixelsTexture& extra) {
    WGPUTexelCopyTextureInfo destination = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
    destination.texture = uploaded.texture;
    WGPUTexelCopyBufferLayout layout{};
    layout.bytesPerRow = extra.width * 4u;
    layout.rowsPerImage = extra.height;
    const WGPUExtent3D size{extra.width, extra.height, 1};
    DawnGpuDevice{queue}.write_texture(&destination, extra.rgba.data(), extra.rgba.size(), &layout,
                                       &size);
    uploaded.uploaded_version = extra.version;
}

/** Releases what {@link upload_dawn_extra_texture} built. */
inline void release_dawn_extra_textures(std::vector<DawnSampledTexture>& extras) { extras.clear(); }

/**
 * The frame's surface texture, read back and written as a PNG.
 *
 * A capture is what a measured run *produces*, so like everything else that
 * decides what a measured run does it is stated once and every driver calls
 * it: the scene renderer, the sprite driver and the effect driver each have
 * exactly one screenshot to take and no reason to spell the readback three
 * ways. The copy is recorded into the caller's encoder, so this is two
 * halves either side of the submit -- {@link begin_dawn_surface_capture}
 * before it, {@link finish_dawn_surface_capture} after.
 */
struct DawnSurfaceCapture {
    DawnBuffer readback;
    std::uint32_t bytes_per_row = 0;
};

#if BBLITE_VISUAL_CAPTURE
inline DawnSurfaceCapture begin_dawn_surface_capture(WGPUDevice device, WGPUCommandEncoder encoder,
                                                     WGPUTexture surface, std::uint32_t width,
                                                     std::uint32_t height) {
    DawnSurfaceCapture capture;
    capture.bytes_per_row = (width * 4 + 255) & ~255u;
    WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
    descriptor.usage = WGPUBufferUsage_CopyDst | WGPUBufferUsage_MapRead;
    descriptor.size = static_cast<std::uint64_t>(capture.bytes_per_row) * height;
    capture.readback = wgpuDeviceCreateBuffer(device, &descriptor);
    WGPUTexelCopyTextureInfo source = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
    source.texture = surface;
    WGPUTexelCopyBufferInfo destination = WGPU_TEXEL_COPY_BUFFER_INFO_INIT;
    destination.layout.bytesPerRow = capture.bytes_per_row;
    destination.layout.rowsPerImage = height;
    destination.buffer = capture.readback;
    const WGPUExtent3D extent{width, height, 1};
    wgpuCommandEncoderCopyTextureToBuffer(encoder, &source, &destination, &extent);
    return capture;
}

inline void save_capture_png(std::span<const std::uint8_t> pixels, std::uint32_t width,
                             std::uint32_t height, std::uint32_t bytes_per_row, bool bgra,
                             const std::string& path) {
    SDL_Surface* surface =
        SDL_CreateSurface(static_cast<int>(width), static_cast<int>(height),
                          bgra ? SDL_PIXELFORMAT_ARGB8888 : SDL_PIXELFORMAT_ABGR8888);
    if (!surface) {
        dawn_error(std::string("SDL_CreateSurface: ") + SDL_GetError());
    }
    for (std::uint32_t row = 0; row < height; ++row) {
        std::memcpy(static_cast<std::uint8_t*>(surface->pixels) +
                        static_cast<std::size_t>(row) * surface->pitch,
                    pixels.data() + static_cast<std::size_t>(row) * bytes_per_row,
                    static_cast<std::size_t>(width) * 4);
    }
    bool saved = false;
    {
        std::lock_guard lock(image_decoder_mutex());
        saved = IMG_SavePNG(surface, path.c_str());
    }
    SDL_DestroySurface(surface);
    if (!saved) {
        dawn_error(std::string("IMG_SavePNG: ") + SDL_GetError());
    }
}

/**
 * The second half of {@link begin_dawn_surface_capture}: map the readback
 * the frame's submit filled, write the PNG, and free it.
 *
 * The map failure lands in `state.uncaptured_error` rather than throwing from
 * the callback, which is how every Dawn wait in this backend reports one.
 */
inline void finish_dawn_surface_capture(DawnDevice& state, const DawnSurfaceCapture& capture,
                                        std::uint32_t width, std::uint32_t height,
                                        const std::string& path) {
    const std::size_t size = static_cast<std::size_t>(capture.bytes_per_row) * height;
    const DawnReadbackMap mapped(state, capture.readback, size);
    save_capture_png(mapped.bytes(), width, height, capture.bytes_per_row,
                     state.surface_format == WGPUTextureFormat_BGRA8Unorm, path);
}

#else
inline DawnSurfaceCapture begin_dawn_surface_capture(WGPUDevice, WGPUCommandEncoder, WGPUTexture,
                                                     std::uint32_t, std::uint32_t) {
    return {};
}
inline void save_capture_png(const std::vector<std::uint8_t>&, std::uint32_t, std::uint32_t,
                             std::uint32_t, bool, const std::string&) {}
inline void finish_dawn_surface_capture(DawnDevice&, const DawnSurfaceCapture&, std::uint32_t,
                                        std::uint32_t, const std::string&) {}
#endif

} // namespace bbl::pal
