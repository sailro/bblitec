// The smallest helpers every GPU unit shares: the draw counter a
// device-recovery build keeps, the `npos` sentinel and the program-cache
// walk. Reads only activation macros.
#pragma once
#include <bblite/features/device_recovery.hpp>

#include <bblite/runtime.hpp>

#include <cstddef>
#include <limits>
#include <utility>
#include <vector>

namespace bbl::pal {

#if BBLITE_DEVICE_RECOVERY
inline thread_local Engine* draw_count_engine = nullptr;
struct DrawCountScope {
    Engine* previous;
    explicit DrawCountScope(Engine& engine) : previous(draw_count_engine) {
        draw_count_engine = &engine;
    }
    ~DrawCountScope() { draw_count_engine = previous; }
};
#endif

template <typename Function, typename... Args>
inline void count_gpu_draw(Function function, Args&&... args) {
#if BBLITE_DEVICE_RECOVERY
    if (draw_count_engine)
        ++draw_count_engine->draw_call_count;
#endif
    function(std::forward<Args>(args)...);
}

/**
 * The `std::size_t` sentinel this file's comments already call `npos`: an
 * unresolved variant, an unbuilt program, a draw outside any geometry task.
 * Defined once so the backends and the selectors spell the absence the same
 * way instead of repeating the `numeric_limits` incantation per site.
 */
inline constexpr std::size_t npos = std::numeric_limits<std::size_t>::max();

/**
 * The find-or-create walk both backends' post-process program caches share:
 * a linear scan of a small grown vector under the caller's own key equality,
 * then the caller's builder appended once. Returns the entry's INDEX because
 * the vector grows -- a pointer is reallocated out from under a pass the
 * moment a later pass creates a second program. The program types and their
 * keys stay each backend's own: SDL_GPU's key omits the bind-group shape
 * (`extra_textures`, `uniform_binding`, `uniform_size`) that Dawn's layout
 * bakes in, which is why the template takes a match predicate rather than a
 * key struct.
 */
template <typename Program, typename Matches, typename Build>
inline std::size_t find_or_create_program(std::vector<Program>& programs, Matches matches,
                                          Build build) {
    for (std::size_t index = 0; index < programs.size(); ++index) {
        if (matches(programs[index]))
            return index;
    }
    programs.push_back(build());
    return programs.size() - 1;
}

} // namespace bbl::pal
