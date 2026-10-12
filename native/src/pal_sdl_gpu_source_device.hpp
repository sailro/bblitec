#pragma once

#include "pal_sdl_gpu_offscreen.hpp"

namespace bbl::pal {

inline void bind_sdl_source_device(Engine& engine, const DeviceOptions& options,
                                   SdlGpuDevice& state) {
    if (engine.device_disposed || engine.source_gpu_host_closed)
        throw std::runtime_error("A disposed or closed source GPU device cannot be replaced.");
    if (!engine.source_gpu_device) {
        struct Lease {
            std::shared_ptr<SdlWindowRun::Resources> window;
            std::unique_ptr<SdlGpuDevice> native;
            SdlOffscreenDevice adapter;
            explicit Lease(std::unique_ptr<SdlGpuDevice> value)
                : window(active_window_run ? active_window_run->retain_resources() : nullptr),
                  native(std::move(value)), adapter(native->device) {
                adapter.window_device = native.get();
                adapter.window_resources = window;
                if (window) {
                    native->owns_window = false;
                    native->sdl_initialized = false;
                }
            }
        };
        auto native = std::make_unique<SdlGpuDevice>();
        create_sdl_gpu_device(engine.options, options, *native);
        auto lease = std::make_shared<Lease>(std::move(native));
        engine.source_gpu_device = std::shared_ptr<OffscreenDevice>(lease, &lease->adapter);
    }
    auto* adapter = dynamic_cast<SdlOffscreenDevice*>(engine.source_gpu_device.get());
    if (!adapter || !adapter->window_device)
        throw std::runtime_error("Cannot replace an engine's live GPU device with SDL GPU.");
    state.source_owner = engine.source_gpu_device;
    const auto& device = *adapter->window_device;
    if (active_window_run && adapter->window_resources)
        active_window_run->use_resources(adapter->window_resources);
    state.device = device.device;
    state.window = device.window;
    state.swapchain_format = device.swapchain_format;
    state.owns_device = false;
    state.owns_window = false;
}

} // namespace bbl::pal
