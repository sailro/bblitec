#include <bblite/features/external_renderables.hpp>

#include "pal_gpu_backend.hpp"
#include "pal_gpu_scene_blocks.hpp"

#include "pal_sdl_gpu_offscreen.hpp"
#include "pal_sdl_gpu_webgpu.hpp"

#include <stdexcept>

namespace bbl::pal {

/**
 * `engine._device` from `createEngine` on: the WebGPU subset over the SDL_GPU
 * device the engine's canvas shares with its presentation host, which the
 * scene renderer binds to the same device later (`sdl_engine_webgpu_device`).
 */
void bind_sdl_gpu_engine_webgpu_device(Engine& engine) {
    auto* shared = dynamic_cast<SdlOffscreenDevice*>(engine.source_gpu_device.get());
    if (!shared)
        throw std::runtime_error(
            "The engine's WebGPU device requires a canvas on an SDL_GPU presentation host.");
#if BBLITE_EXTERNAL_RENDERABLES
    configure_engine_scene_layout(engine);
#endif
    static_cast<void>(sdl_engine_webgpu_device(engine, shared->device));
}

} // namespace bbl::pal
