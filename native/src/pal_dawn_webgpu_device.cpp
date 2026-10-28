#include <bblite/features/external_renderables.hpp>

#include "pal_gpu_backend.hpp"
#include "pal_gpu_scene_blocks.hpp"

#include "pal_dawn_shared.hpp"
#include "pal_dawn_webgpu.hpp"

#include <stdexcept>

namespace bbl::pal {

/**
 * `engine._device` from `createEngine` on: the WebGPU subset over the Dawn
 * device the engine's canvas shares with its presentation host, which the
 * scene renderer binds to the same queue later (`dawn_engine_webgpu_device`).
 */
void bind_dawn_engine_webgpu_device(Engine& engine) {
    auto* shared = dynamic_cast<DawnOffscreenDevice*>(engine.source_gpu_device.get());
    if (!shared)
        throw std::runtime_error(
            "The engine's WebGPU device requires a canvas on a Dawn presentation host.");
#if BBLITE_EXTERNAL_RENDERABLES
    configure_engine_scene_layout(engine);
#endif
    static_cast<void>(
        dawn_engine_webgpu_device(engine, shared->instance, shared->device, shared->queue));
}

} // namespace bbl::pal
