// The smallest helpers every GPU unit shares: the draw counter a
// device-recovery build keeps, the `npos` sentinel, the program-cache walk
// and the `.slots` sidecar reading. Reads only activation macros.
#pragma once
#include <bblite/features/device_recovery.hpp>

#include <bblite/runtime.hpp>

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <optional>
#include <memory>
#include <span>
#include <string>
#include <string_view>
#include <type_traits>
#include <utility>
#include <vector>

namespace bbl::pal {

/** A non-owning reference to a callable a pass invokes synchronously: no allocation. */
template <class Signature> class FunctionRef;
template <class Result, class... Args> class FunctionRef<Result(Args...)> {
public:
    template <class Callable>
        requires(!std::is_same_v<std::remove_cvref_t<Callable>, FunctionRef>)
    FunctionRef(Callable& callable) noexcept
        : object_(const_cast<void*>(static_cast<const void*>(std::addressof(callable)))),
          call_([](void* object, Args... args) -> Result {
              return (*static_cast<Callable*>(object))(std::forward<Args>(args)...);
          }) {}
    Result operator()(Args... args) const { return call_(object_, std::forward<Args>(args)...); }

private:
    void* object_;
    Result (*call_)(void*, Args...);
};

/** A pass's external renderables (pal_external_renderables.hpp), named in every build. */
class ExternalRenderablePass;

/** A non-owning draw list for one command in an ordered pass. */
template <class Command> struct BorrowedDrawList {
    std::span<const Command> commands;
    explicit BorrowedDrawList(const Command& command) : commands(&command, 1) {}
    explicit BorrowedDrawList(std::span<const Command> run) : commands(run) {}
};

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

/**
 * Each line of a `.slots` sidecar -- the file bblite-tint writes beside every
 * compiled stage -- without its line ending or trailing spaces. SDL_GPU reads
 * the register lines for its dense slots, Dawn the `@binding` lines for its
 * reflected layouts; both read the file through this one walk.
 */
template <typename Visit> inline void for_each_sidecar_line(std::string_view text, Visit visit) {
    for (std::size_t start = 0; start < text.size();) {
        const std::size_t end = std::min(text.find('\n', start), text.size());
        std::string_view line = text.substr(start, end - start);
        while (!line.empty() && (line.back() == '\r' || line.back() == ' '))
            line.remove_suffix(1);
        visit(line);
        start = end + 1;
    }
}

/** One sidecar line's space-separated words. */
inline std::vector<std::string_view> sidecar_words(std::string_view line) {
    std::vector<std::string_view> words;
    for (std::size_t start = 0; start < line.size();) {
        const std::size_t end = std::min(line.find(' ', start), line.size());
        if (end > start)
            words.push_back(line.substr(start, end - start));
        start = end + 1;
    }
    return words;
}

/**
 * A sidecar's decimal register or binding index, or none for text that is not
 * one. Sidecars are generated build artifacts, but a stale or malformed one
 * must still fail in bounded space: the index is capped before anything is
 * sized by it, where `stoul("-4")` would wrap to a huge value and a resize to
 * it would consume the machine before startup could report the error.
 */
inline std::optional<std::uint32_t> parse_sidecar_index(std::string_view digits) {
    constexpr std::uint32_t max_sidecar_index = 4096;
    if (digits.empty())
        return std::nullopt;
    std::uint32_t value = 0;
    for (const char digit : digits) {
        if (digit < '0' || digit > '9')
            return std::nullopt;
        value = value * 10 + static_cast<std::uint32_t>(digit - '0');
        if (value > max_sidecar_index)
            return std::nullopt;
    }
    return value;
}

} // namespace bbl::pal
