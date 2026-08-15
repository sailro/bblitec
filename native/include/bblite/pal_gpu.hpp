#pragma once

namespace bbl {
struct Engine;
}

namespace bbl::pal {

#if defined(BBLITE_HAS_PBR_RENDERER) && BBLITE_HAS_PBR_RENDERER && \
    defined(BBLITE_HAS_SDL_GPU) && BBLITE_HAS_SDL_GPU
bool run_gpu_engine(Engine& engine);
#else
inline bool run_gpu_engine(Engine&) {
    return false;
}
#endif

// Both scene renderers need a registered scene, so a scene-less build
// compiles neither and the declaration follows the same condition.
#if defined(BBLITE_HAS_DAWN) && BBLITE_HAS_DAWN && \
    defined(BBLITE_HAS_PBR_RENDERER) && BBLITE_HAS_PBR_RENDERER
bool run_dawn_engine(Engine& engine);
#else
inline bool run_dawn_engine(Engine&) {
    return false;
}
#endif

// The pure-2D sprite path. A scene reaching it registers a SpriteRenderer
// on the engine rather than a SceneContext, so it is selected by what the
// engine holds rather than by a flag.
#if defined(BBLITE_HAS_SPRITE_RENDERER) && BBLITE_HAS_SPRITE_RENDERER && \
    defined(BBLITE_HAS_SDL_GPU) && BBLITE_HAS_SDL_GPU
bool run_sprite_gpu_engine(Engine& engine);
#else
inline bool run_sprite_gpu_engine(Engine&) {
    return false;
}
#endif

#if defined(BBLITE_HAS_SPRITE_RENDERER) && BBLITE_HAS_SPRITE_RENDERER && \
    defined(BBLITE_HAS_DAWN) && BBLITE_HAS_DAWN
bool run_sprite_dawn_engine(Engine& engine);
#else
inline bool run_sprite_dawn_engine(Engine&) {
    return false;
}
#endif

} // namespace bbl::pal
