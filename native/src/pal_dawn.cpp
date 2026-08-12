// Dawn (WebGPU) render backend. Renders through the same pinned Dawn
// commit as the Tint shader compiler so native output shares the
// browser reference's compiler and rasterization stack. Bring-up
// skeleton: window surface, device, clear, and screenshot capture.

#include <bblite/pal.hpp>
#include <bblite/pal_gpu.hpp>
#include <bblite/runtime.hpp>

#if defined(BBLITE_HAS_DAWN) && BBLITE_HAS_DAWN

#include <SDL3/SDL.h>
#include <SDL3_image/SDL_image.h>
#include <webgpu/webgpu.h>

#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>

namespace bbl::pal {

namespace {

std::string view_text(WGPUStringView view) {
    if (!view.data) return {};
    return view.length == WGPU_STRLEN
        ? std::string(view.data)
        : std::string(view.data, view.length);
}

[[noreturn]] void dawn_error(const std::string& message) {
    throw std::runtime_error("Dawn backend: " + message);
}

struct DawnState {
    SDL_Window* window = nullptr;
    WGPUInstance instance = nullptr;
    WGPUAdapter adapter = nullptr;
    WGPUDevice device = nullptr;
    WGPUQueue queue = nullptr;
    WGPUSurface surface = nullptr;
    std::string uncaptured_error;

    ~DawnState() {
        if (surface) wgpuSurfaceRelease(surface);
        if (queue) wgpuQueueRelease(queue);
        if (device) wgpuDeviceRelease(device);
        if (adapter) wgpuAdapterRelease(adapter);
        if (instance) wgpuInstanceRelease(instance);
        if (window) SDL_DestroyWindow(window);
    }
};

void wait_for(WGPUInstance instance, WGPUFuture future) {
    WGPUFutureWaitInfo wait_info{};
    wait_info.future = future;
    const WGPUWaitStatus status =
        wgpuInstanceWaitAny(instance, 1, &wait_info, UINT64_MAX);
    if (status != WGPUWaitStatus_Success) {
        dawn_error("wgpuInstanceWaitAny failed.");
    }
}

void save_capture_png(
    const std::vector<std::uint8_t>& pixels,
    std::uint32_t width,
    std::uint32_t height,
    std::uint32_t bytes_per_row,
    const std::string& path) {
    SDL_Surface* surface = SDL_CreateSurface(
        static_cast<int>(width),
        static_cast<int>(height),
        SDL_PIXELFORMAT_ABGR8888);
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

} // namespace

bool run_dawn_engine(Engine& engine) {
    if (engine.registered_scenes.empty() || !engine.registered_scenes.front()) {
        throw std::runtime_error("Dawn renderer requires a registered scene.");
    }
    Scene& scene = *engine.registered_scenes.front();
    const std::string animation_seek =
        environment_variable("BBLITE_ANIMATION_SEEK_SECONDS");
    if (!animation_seek.empty()) {
        const float time = std::strtof(animation_seek.c_str(), nullptr);
        for (const auto& seek : scene.animation_seekers) {
            seek(time);
        }
    }
    if (!SDL_Init(SDL_INIT_VIDEO | SDL_INIT_EVENTS)) {
        dawn_error(std::string("SDL_Init: ") + SDL_GetError());
    }

    DawnState state;
    const bool hidden_test_pass =
        environment_variable("BBLITE_TEST_PASS") == "1";
    state.window = SDL_CreateWindow(
        engine.options.title.c_str(),
        engine.options.width,
        engine.options.height,
        hidden_test_pass
            ? SDL_WINDOW_RESIZABLE | SDL_WINDOW_NOT_FOCUSABLE
            : SDL_WINDOW_RESIZABLE);
    if (!state.window) {
        dawn_error(std::string("SDL_CreateWindow: ") + SDL_GetError());
    }

    // The instance must opt into timed waits for the synchronous
    // bring-up pattern used below.
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
        auto* dawn_state = static_cast<DawnState*>(userdata1);
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
    WGPURequestDeviceCallbackInfo device_callback =
        WGPU_REQUEST_DEVICE_CALLBACK_INFO_INIT;
    device_callback.mode = WGPUCallbackMode_WaitAnyOnly;
    device_callback.callback = [](
                                   WGPURequestDeviceStatus status,
                                   WGPUDevice device,
                                   WGPUStringView message,
                                   void* userdata1,
                                   void*) {
        auto* dawn_state = static_cast<DawnState*>(userdata1);
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

    const std::uint32_t width =
        static_cast<std::uint32_t>(engine.options.width);
    const std::uint32_t height =
        static_cast<std::uint32_t>(engine.options.height);
    WGPUSurfaceConfiguration surface_configuration =
        WGPU_SURFACE_CONFIGURATION_INIT;
    surface_configuration.device = state.device;
    surface_configuration.format = WGPUTextureFormat_BGRA8Unorm;
    surface_configuration.usage = WGPUTextureUsage_RenderAttachment;
    surface_configuration.width = width;
    surface_configuration.height = height;
    surface_configuration.presentMode = WGPUPresentMode_Immediate;
    wgpuSurfaceConfigure(state.surface, &surface_configuration);

    const std::string screenshot_path =
        environment_variable("BBLITE_SCREENSHOT");
    const long screenshot_frame = [&] {
        const std::string value =
            environment_variable("BBLITE_SCREENSHOT_FRAME");
        return value.empty() ? 0L : std::strtol(value.c_str(), nullptr, 10);
    }();
    const long limit = [&] {
        const std::string value = environment_variable("BBLITE_MAX_FRAMES");
        return value.empty() ? 0L : std::strtol(value.c_str(), nullptr, 10);
    }();

    bool screenshot_saved = false;
    bool running = true;
    long frame = 0;
    constexpr long capture_grace_frames = 8;
    while (running &&
           (limit <= 0 || frame < limit ||
            (!screenshot_path.empty() && !screenshot_saved &&
             frame < limit + capture_grace_frames))) {
        SDL_Event event;
        while (SDL_PollEvent(&event)) {
            if (event.type == SDL_EVENT_QUIT) running = false;
        }
        const float delta_ms =
            scene.fixed_delta_ms > 0.0f ? scene.fixed_delta_ms : 16.0f;
        for (const auto& callback : scene.before_render) {
            callback(delta_ms);
        }

        WGPUSurfaceTexture surface_texture = WGPU_SURFACE_TEXTURE_INIT;
        wgpuSurfaceGetCurrentTexture(state.surface, &surface_texture);
        if (
            surface_texture.status !=
                WGPUSurfaceGetCurrentTextureStatus_SuccessOptimal &&
            surface_texture.status !=
                WGPUSurfaceGetCurrentTextureStatus_SuccessSuboptimal) {
            dawn_error("wgpuSurfaceGetCurrentTexture failed.");
        }
        WGPUTextureView surface_view =
            wgpuTextureCreateView(surface_texture.texture, nullptr);

        const bool capture_frame =
            frame >= screenshot_frame &&
            !screenshot_saved &&
            !screenshot_path.empty();
        WGPUTexture capture_texture = nullptr;
        WGPUTextureView capture_view = nullptr;
        if (capture_frame) {
            WGPUTextureDescriptor capture_descriptor =
                WGPU_TEXTURE_DESCRIPTOR_INIT;
            capture_descriptor.usage =
                WGPUTextureUsage_RenderAttachment |
                WGPUTextureUsage_CopySrc;
            capture_descriptor.size = {width, height, 1};
            capture_descriptor.format = WGPUTextureFormat_RGBA8Unorm;
            capture_texture =
                wgpuDeviceCreateTexture(state.device, &capture_descriptor);
            capture_view = wgpuTextureCreateView(capture_texture, nullptr);
        }

        WGPUCommandEncoder encoder =
            wgpuDeviceCreateCommandEncoder(state.device, nullptr);
        const WGPUColor clear_color{
            scene.clear_color.r,
            scene.clear_color.g,
            scene.clear_color.b,
            scene.clear_color.a,
        };
        const auto clear_pass = [&](WGPUTextureView target) {
            WGPURenderPassColorAttachment color_attachment =
                WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
            color_attachment.view = target;
            color_attachment.loadOp = WGPULoadOp_Clear;
            color_attachment.storeOp = WGPUStoreOp_Store;
            color_attachment.clearValue = clear_color;
            WGPURenderPassDescriptor pass_descriptor =
                WGPU_RENDER_PASS_DESCRIPTOR_INIT;
            pass_descriptor.colorAttachmentCount = 1;
            pass_descriptor.colorAttachments = &color_attachment;
            WGPURenderPassEncoder pass =
                wgpuCommandEncoderBeginRenderPass(
                    encoder,
                    &pass_descriptor);
            wgpuRenderPassEncoderEnd(pass);
            wgpuRenderPassEncoderRelease(pass);
        };
        clear_pass(surface_view);
        WGPUBuffer readback = nullptr;
        const std::uint32_t bytes_per_row = (width * 4 + 255) & ~255u;
        if (capture_frame) {
            clear_pass(capture_view);
            WGPUBufferDescriptor readback_descriptor =
                WGPU_BUFFER_DESCRIPTOR_INIT;
            readback_descriptor.usage =
                WGPUBufferUsage_CopyDst | WGPUBufferUsage_MapRead;
            readback_descriptor.size =
                static_cast<std::uint64_t>(bytes_per_row) * height;
            readback =
                wgpuDeviceCreateBuffer(state.device, &readback_descriptor);
            WGPUTexelCopyTextureInfo copy_source =
                WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
            copy_source.texture = capture_texture;
            WGPUTexelCopyBufferInfo copy_destination =
                WGPU_TEXEL_COPY_BUFFER_INFO_INIT;
            copy_destination.layout.bytesPerRow = bytes_per_row;
            copy_destination.layout.rowsPerImage = height;
            copy_destination.buffer = readback;
            const WGPUExtent3D copy_size{width, height, 1};
            wgpuCommandEncoderCopyTextureToBuffer(
                encoder,
                &copy_source,
                &copy_destination,
                &copy_size);
        }

        WGPUCommandBuffer command =
            wgpuCommandEncoderFinish(encoder, nullptr);
        wgpuQueueSubmit(state.queue, 1, &command);
        wgpuCommandBufferRelease(command);
        wgpuCommandEncoderRelease(encoder);

        if (capture_frame) {
            WGPUBufferMapCallbackInfo map_callback =
                WGPU_BUFFER_MAP_CALLBACK_INFO_INIT;
            map_callback.mode = WGPUCallbackMode_WaitAnyOnly;
            map_callback.callback = [](
                                        WGPUMapAsyncStatus status,
                                        WGPUStringView message,
                                        void* userdata1,
                                        void*) {
                if (status != WGPUMapAsyncStatus_Success) {
                    auto* error = static_cast<std::string*>(userdata1);
                    if (error->empty()) *error = view_text(message);
                }
            };
            map_callback.userdata1 = &state.uncaptured_error;
            wait_for(
                state.instance,
                wgpuBufferMapAsync(
                    readback,
                    WGPUMapMode_Read,
                    0,
                    static_cast<std::size_t>(bytes_per_row) * height,
                    map_callback));
            const void* mapped = wgpuBufferGetConstMappedRange(
                readback,
                0,
                static_cast<std::size_t>(bytes_per_row) * height);
            if (!mapped) dawn_error("buffer map returned no data.");
            std::vector<std::uint8_t> pixels(
                static_cast<const std::uint8_t*>(mapped),
                static_cast<const std::uint8_t*>(mapped) +
                    static_cast<std::size_t>(bytes_per_row) * height);
            wgpuBufferUnmap(readback);
            save_capture_png(
                pixels,
                width,
                height,
                bytes_per_row,
                screenshot_path);
            screenshot_saved = true;
        }
        if (readback) wgpuBufferRelease(readback);
        if (capture_view) wgpuTextureViewRelease(capture_view);
        if (capture_texture) wgpuTextureRelease(capture_texture);

        wgpuSurfacePresent(state.surface);
        wgpuTextureViewRelease(surface_view);
        wgpuTextureRelease(surface_texture.texture);
        wgpuInstanceProcessEvents(state.instance);
        if (!state.uncaptured_error.empty()) {
            dawn_error("uncaptured error: " + state.uncaptured_error);
        }
        ++frame;
    }
    SDL_DestroyWindow(state.window);
    state.window = nullptr;
    return true;
}

} // namespace bbl::pal

#endif
