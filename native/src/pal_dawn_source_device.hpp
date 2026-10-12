#pragma once

#include "pal_dawn_shared.hpp"

namespace bbl::pal {

/** A source device outlives scene resources and the callbacks whose userdata it owns. */
inline void bind_dawn_source_device(Engine& engine, const DeviceOptions& options,
                                    DawnDevice& state) {
    if (engine.device_disposed || engine.source_gpu_host_closed)
        throw std::runtime_error("A disposed or closed source GPU device cannot be replaced.");
    if (!engine.source_gpu_device) {
        struct Lease {
            std::shared_ptr<SdlWindowRun::Resources> window;
            std::unique_ptr<DawnDevice> native;
            DawnOffscreenDevice adapter;
            explicit Lease(std::unique_ptr<DawnDevice> value)
                : window(active_window_run ? active_window_run->retain_resources() : nullptr),
                  native(std::move(value)), adapter(*native) {
                adapter.window_device = native.get();
                adapter.window_resources = window;
                if (window) {
                    native->owns_window = false;
                    native->sdl_initialized = false;
                }
            }
        };
        auto native = std::make_unique<DawnDevice>();
        create_dawn_device(engine.options, options, *native);
        auto lease = std::make_shared<Lease>(std::move(native));
        engine.source_gpu_device = std::shared_ptr<OffscreenDevice>(lease, &lease->adapter);
    }
    auto* adapter = dynamic_cast<DawnOffscreenDevice*>(engine.source_gpu_device.get());
    if (!adapter || !adapter->window_device)
        throw std::runtime_error("Cannot replace an engine's live GPU device with Dawn.");
    state.source_owner = engine.source_gpu_device;
    const auto& device = *adapter->window_device;
    if (device.is_lost())
        throw std::runtime_error("A lost or disposed source GPU device cannot be replaced.");
    WGPULimits limits = WGPU_LIMITS_INIT;
    if (wgpuDeviceGetLimits(device.device, &limits) != WGPUStatus_Success ||
        options.max_vertex_attributes > limits.maxVertexAttributes ||
        options.max_color_attachment_bytes_per_sample > limits.maxColorAttachmentBytesPerSample)
        throw std::runtime_error("The engine GPU device limits do not satisfy this renderer.");
    if (active_window_run && adapter->window_resources)
        active_window_run->use_resources(adapter->window_resources);
    state.shared_owner = &device;
    state.instance = device.instance;
    state.adapter = device.adapter;
    state.device = device.device;
    state.queue = device.queue;
    state.surface = device.surface;
    wgpuInstanceAddRef(state.instance);
    wgpuAdapterAddRef(state.adapter);
    wgpuDeviceAddRef(state.device);
    wgpuQueueAddRef(state.queue);
    if (state.surface)
        wgpuSurfaceAddRef(state.surface);
    state.window = device.window;
    state.owns_window = false;
    state.surface_format = device.surface_format;
    state.present_mode = device.present_mode;
    state.surface_width = device.surface_width;
    state.surface_height = device.surface_height;
#if defined(__ANDROID__)
    state.android_window = device.android_window;
    if (state.android_window)
        ANativeWindow_acquire(state.android_window);
#endif
}

} // namespace bbl::pal
