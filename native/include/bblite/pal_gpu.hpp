#pragma once

namespace bbl {
struct Engine;
}

namespace bbl::pal {

#if defined(BBLITE_HAS_PBR_RENDERER) && BBLITE_HAS_PBR_RENDERER
bool run_gpu_engine(Engine& engine);
#else
inline bool run_gpu_engine(Engine&) {
    return false;
}
#endif

} // namespace bbl::pal
