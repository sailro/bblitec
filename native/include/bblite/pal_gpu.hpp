#pragma once
#include <bblite/pal_frame_driver.hpp>

namespace bbl {
struct Engine;
}

namespace bbl::pal {

// Renderer entry points. Each is defined by its backend's unit, which CMake
// compiles only when both that backend and that renderer family are
// selected; `pal_gpu_dispatch.hpp` is the one place taking their addresses.
SceneRun run_gpu_engine(Engine& engine);
SceneRun run_dawn_engine(Engine& engine);

// The shared 2D frame host presents sprite renderers or a primary Canvas2D
// surface. Neither requires a SceneContext or the scene renderer.
void run_sprite_gpu_engine(Engine& engine);
void run_sprite_dawn_engine(Engine& engine);

// The pure fullscreen-effect path. An EffectRenderer is its own rendering
// context on the engine rather than part of a scene, exactly as a
// SpriteRenderer is, so a scene registering one and no SceneContext draws
// from here and compiles no scene renderer at all.
void run_effect_gpu_engine(Engine& engine);
void run_effect_dawn_engine(Engine& engine);

// A standalone frame graph is a rendering context with ordered tasks and no
// SceneContext, camera, mesh renderer, or material renderer.
void run_frame_graph_gpu_engine(Engine& engine);
void run_frame_graph_dawn_engine(Engine& engine);

} // namespace bbl::pal
