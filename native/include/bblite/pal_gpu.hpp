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

#if defined(BBLITE_HAS_DAWN) && BBLITE_HAS_DAWN
bool run_dawn_engine(Engine& engine);
#else
inline bool run_dawn_engine(Engine&) {
    return false;
}
#endif

} // namespace bbl::pal
