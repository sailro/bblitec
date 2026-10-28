#pragma once

#include <bblite/pal.hpp>
#include <bblite/pal_frame_driver.hpp>

#include <bblite/js_realm_state.hpp>

#include <array>
#include <cstdint>
#include <memory>
#include <stdexcept>
#include <vector>

namespace bbl {
struct Engine;
struct EnvironmentState;
struct GpuObject;
struct TextureData;
struct TextureSamplerState;
} // namespace bbl

namespace bbl::pal {
struct LibraryEnvironmentViews;

// Each backend's entry points, defined by its own units, which CMake
// compiles only when both that backend and that family are selected;
// `pal_gpu_dispatch.hpp` is the one place taking their addresses.

// Renderer entry points.
SceneRun run_gpu_engine(Engine& engine);
SceneRun run_dawn_engine(Engine& engine);

// The shared 2D frame host presents sprite renderers or a primary Canvas2D
// surface. Neither requires a SceneContext or the scene renderer.
SceneRun run_sprite_gpu_engine(Engine& engine);
SceneRun run_sprite_dawn_engine(Engine& engine);

// The pure fullscreen-effect path. An EffectRenderer is its own rendering
// context on the engine rather than part of a scene, exactly as a
// SpriteRenderer is, so a scene registering one and no SceneContext draws
// from here and compiles no scene renderer at all.
SceneRun run_effect_gpu_engine(Engine& engine);
SceneRun run_effect_dawn_engine(Engine& engine);

// A standalone frame graph is a rendering context with ordered tasks and no
// SceneContext, camera, mesh renderer, or material renderer.
SceneRun run_frame_graph_gpu_engine(Engine& engine);
SceneRun run_frame_graph_dawn_engine(Engine& engine);

// `engine._device` from `createEngine` on: `Engine::webgpu_device` over the
// device the engine's canvas shares with its presentation host.
void bind_sdl_gpu_engine_webgpu_device(Engine& engine);
void bind_dawn_engine_webgpu_device(Engine& engine);

/**
 * A material image a backend uploaded onto the engine's WebGPU-subset device
 * with its own scene-texture upload, and its size: `library_texture`'s
 * backend half (pal_library_textures.cpp).
 */
struct LibraryImage {
    std::shared_ptr<GpuObject> texture;
    double width = 0;
    double height = 0;
};

/** The texel an undecodable library image uploads as, as the renderer's material uploads take it. */
inline constexpr std::array<std::uint8_t, 4> library_fallback_texel{255, 255, 255, 255};

/**
 * The realm's `Value` for one live `device`, made on first use and dropped
 * once the device is: what a device's library uploads share without the
 * device owning it.
 */
template <class Value, class Device> Value& device_scratch(const std::shared_ptr<Device>& device) {
    struct Entry {
        std::weak_ptr<Device> device;
        Value value;
    };
    auto& entries = js::realm_scratch<std::vector<Entry>>();
    std::erase_if(entries, [](const Entry& entry) { return entry.device.expired(); });
    for (auto& entry : entries)
        if (entry.device.lock() == device)
            return entry.value;
    return entries.emplace_back(Entry{device, {}}).value;
}

// A lowered library's material images, their samplers and its scene
// environment on `Engine::webgpu_device`, uploaded by the backend's own
// scene-texture routines (library_runtime.hpp; pal_library_textures.cpp
// dispatches).
LibraryImage sdl_gpu_library_image(Engine& engine, const TextureData& data);
LibraryImage dawn_library_image(Engine& engine, const TextureData& data);
std::shared_ptr<GpuObject> sdl_gpu_library_sampler(Engine& engine,
                                                   const TextureSamplerState& sampler);
std::shared_ptr<GpuObject> dawn_library_sampler(Engine& engine, const TextureSamplerState& sampler);
LibraryEnvironmentViews sdl_gpu_library_environment_views(Engine& engine,
                                                          const EnvironmentState& environment);
LibraryEnvironmentViews dawn_library_environment_views(Engine& engine,
                                                       const EnvironmentState& environment);

inline bool use_dawn_backend() {
#if BBLITE_HAS_SDL_GPU
    constexpr bool has_sdl = true;
#else
    constexpr bool has_sdl = false;
#endif
#if BBLITE_HAS_DAWN
    constexpr bool has_dawn = true;
#else
    constexpr bool has_dawn = false;
#endif
    const auto requested = environment_variable("BBLITE_GPU_BACKEND");
    if (!requested.empty() && requested != "sdl_gpu" && requested != "dawn") {
        throw std::invalid_argument("BBLITE_GPU_BACKEND must be sdl_gpu or dawn.");
    }
    const bool dawn = requested == "dawn" || (requested.empty() && !has_sdl);
    if ((dawn && !has_dawn) || (!dawn && !has_sdl)) {
        throw std::runtime_error(dawn ? "Dawn is not compiled into this build."
                                      : "SDL_GPU is not compiled into this build.");
    }
    return dawn;
}

} // namespace bbl::pal
