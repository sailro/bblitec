#pragma once
#include <bblite/pal_frame_driver.hpp>

namespace bbl {
struct Engine;
}

namespace bbl::pal {

#if defined(BBLITE_HAS_PBR_RENDERER) && BBLITE_HAS_PBR_RENDERER && \
    defined(BBLITE_HAS_SDL_GPU) && BBLITE_HAS_SDL_GPU
SceneRun run_gpu_engine(Engine& engine);
#else
inline SceneRun run_gpu_engine(Engine&) {
    BBLITE_RUN_RETURN(false);
}
#endif

// Both scene renderers need a registered scene, so a scene-less build
// compiles neither and the declaration follows the same condition.
#if defined(BBLITE_HAS_DAWN) && BBLITE_HAS_DAWN && \
    defined(BBLITE_HAS_PBR_RENDERER) && BBLITE_HAS_PBR_RENDERER
SceneRun run_dawn_engine(Engine& engine);
#else
inline SceneRun run_dawn_engine(Engine&) {
    BBLITE_RUN_RETURN(false);
}
#endif

// The shared 2D frame host presents sprite renderers or a primary Canvas2D
// surface. Neither requires a SceneContext or the scene renderer.
#if (BBLITE_HAS_SPRITE_RENDERER || BBLITE_HAS_CANVAS_RENDERER) && \
    defined(BBLITE_HAS_SDL_GPU) && BBLITE_HAS_SDL_GPU
bool run_sprite_gpu_engine(Engine& engine);
#else
inline bool run_sprite_gpu_engine(Engine&) {
    return false;
}
#endif

#if (BBLITE_HAS_SPRITE_RENDERER || BBLITE_HAS_CANVAS_RENDERER) && \
    defined(BBLITE_HAS_DAWN) && BBLITE_HAS_DAWN
bool run_sprite_dawn_engine(Engine& engine);
#else
inline bool run_sprite_dawn_engine(Engine&) {
    return false;
}
#endif

// The pure fullscreen-effect path. An EffectRenderer is its own rendering
// context on the engine rather than part of a scene, exactly as a
// SpriteRenderer is, so a scene registering one and no SceneContext draws
// from here and compiles no scene renderer at all.
#if defined(BBLITE_HAS_EFFECT_RENDERER) && BBLITE_HAS_EFFECT_RENDERER && \
    defined(BBLITE_HAS_SDL_GPU) && BBLITE_HAS_SDL_GPU
bool run_effect_gpu_engine(Engine& engine);
#else
inline bool run_effect_gpu_engine(Engine&) {
    return false;
}
#endif

#if defined(BBLITE_HAS_EFFECT_RENDERER) && BBLITE_HAS_EFFECT_RENDERER && \
    defined(BBLITE_HAS_DAWN) && BBLITE_HAS_DAWN
bool run_effect_dawn_engine(Engine& engine);
#else
inline bool run_effect_dawn_engine(Engine&) {
    return false;
}
#endif

// A standalone frame graph is a rendering context with ordered tasks and no
// SceneContext, camera, mesh renderer, or material renderer.
#if defined(BBLITE_HAS_FRAME_GRAPH_RENDERER) && BBLITE_HAS_FRAME_GRAPH_RENDERER && \
    defined(BBLITE_HAS_SDL_GPU) && BBLITE_HAS_SDL_GPU
bool run_frame_graph_gpu_engine(Engine& engine);
#else
inline bool run_frame_graph_gpu_engine(Engine&) {
    return false;
}
#endif

#if defined(BBLITE_HAS_FRAME_GRAPH_RENDERER) && BBLITE_HAS_FRAME_GRAPH_RENDERER && \
    defined(BBLITE_HAS_DAWN) && BBLITE_HAS_DAWN
bool run_frame_graph_dawn_engine(Engine& engine);
#else
inline bool run_frame_graph_dawn_engine(Engine&) {
    return false;
}
#endif

} // namespace bbl::pal
