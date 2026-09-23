#pragma once

#include <bblite/runtime.hpp>
#if defined(BBLITE_GPU_TASK_TIMING) && BBLITE_GPU_TASK_TIMING
#include <bblite/pal_gpu_task_timing.hpp>
#endif
#if defined(BBLITE_WORKERS) && BBLITE_WORKERS
#include <bblite/pal_offscreen.hpp>
#endif

namespace bbl::pal {

inline void dispose_engine_retirements(Engine& engine) {
    if (engine.dispose_gpu_retirements)
        engine.dispose_gpu_retirements();
}
inline void unconfigure_engine_surfaces(Engine& engine) {
    engine.registered_scenes.clear();
    engine.registered_frame_graph_contexts.clear();
    engine.registered_effect_renderers.clear();
#if defined(BBLITE_WORKERS) && BBLITE_WORKERS
    if (engine.offscreen_run)
        engine.offscreen_run->discard_pending();
#endif
}
inline void dispose_engine_managed_resources(Engine& engine) {
    if (engine.dispose_managed_resources)
        engine.dispose_managed_resources();
}
inline void dispose_engine_storage_buffers(Engine& engine) {
    if (engine.dispose_storage_buffers)
        engine.dispose_storage_buffers(engine);
}
inline void destroy_engine_device(Engine& engine) {
#if defined(BBLITE_GPU_TASK_TIMING) && BBLITE_GPU_TASK_TIMING
    if (engine.gpu_task_timing) {
        auto& timing = *engine.gpu_task_timing;
        if (timing.disable)
            timing.disable();
        timing.disable = {};
        timing.timer.reset();
        timing.device.reset();
        timing.supported = false;
    }
#endif
    engine.device_disposed = true;
    engine.renderer_restart_requested = false;
    engine.native_resource_owners.clear();
    if (engine.device_recovery) {
        engine.device_recovery->disposed = true;
        engine.device_recovery->registrations.clear();
        engine.device_recovery->error_listeners.clear();
    }
#if defined(BBLITE_WORKERS) && BBLITE_WORKERS
    // The Window owns the shared transport. This engine releases its lease;
    // suspended renderer activations retain theirs until the stopped frame exits.
    if (engine.offscreen_run)
        engine.offscreen_run->invalidate_device();
    engine.offscreen_run.reset();
#endif
}

} // namespace bbl::pal
