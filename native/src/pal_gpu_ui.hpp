// The rules both backends' UI compositors share: how a recorded draw's
// scissor meets the frame, and how a segment's draws split into runs.
#pragma once
#include <bblite/features/has_ui.hpp>

#include <bblite/pal.hpp>
#include "pal_gpu_frame.hpp"
#if BBLITE_HAS_UI
#include <bblite/pal_ui.hpp>
#endif

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <limits>
#include <optional>

namespace bbl::pal {

#if BBLITE_HAS_UI
/** A recorded UI draw's scissor, clamped to the frame it was recorded in. */
struct UiScissorRect {
    int left = 0;
    int top = 0;
    int width = 0;
    int height = 0;
};

/**
 * One recorded UI draw's scissor rectangle, clamped to the frame extent, or
 * nothing for a draw the clamp empties (or that carries no indices). Shared
 * so the two backend compositors cannot drift on how a recorded rectangle
 * meets the surface.
 */
inline std::optional<UiScissorRect> clamped_ui_scissor(const UiRenderDraw& draw,
                                                       std::uint32_t frame_width,
                                                       std::uint32_t frame_height) {
    const int left = std::clamp(draw.scissor_x, 0, static_cast<int>(frame_width));
    const int top = std::clamp(draw.scissor_y, 0, static_cast<int>(frame_height));
    const int right = std::clamp(draw.scissor_x + static_cast<int>(draw.scissor_width), 0,
                                 static_cast<int>(frame_width));
    const int bottom = std::clamp(draw.scissor_y + static_cast<int>(draw.scissor_height), 0,
                                  static_cast<int>(frame_height));
    if (right <= left || bottom <= top || draw.index_count == 0) {
        return std::nullopt;
    }
    return UiScissorRect{left, top, right - left, bottom - top};
}

/**
 * The pixels a layer segment's draws reach: each draw's vertex bounds within its scissor,
 * joined. The segment's composite covers only these.
 */
class UiReachedRect {
public:
    void add(const UiRenderFrame& frame, const UiRenderDraw& draw, const UiScissorRect& scissor) {
        float x0 = std::numeric_limits<float>::max(), y0 = x0;
        float x1 = std::numeric_limits<float>::lowest(), y1 = x1;
        for (std::uint32_t index = draw.first_index; index < draw.first_index + draw.index_count;
             ++index) {
            const UiRenderVertex& vertex = frame.vertices[frame.indices[index]];
            x0 = std::min(x0, vertex.x);
            y0 = std::min(y0, vertex.y);
            x1 = std::max(x1, vertex.x);
            y1 = std::max(y1, vertex.y);
        }
        const int l = std::max(scissor.left, static_cast<int>(std::floor(x0)));
        const int t = std::max(scissor.top, static_cast<int>(std::floor(y0)));
        const int r = std::min(scissor.left + scissor.width, static_cast<int>(std::ceil(x1)));
        const int b = std::min(scissor.top + scissor.height, static_cast<int>(std::ceil(y1)));
        if (r <= l || b <= t)
            return;
        left_ = std::min(left_, l);
        top_ = std::min(top_, t);
        right_ = std::max(right_, r);
        bottom_ = std::max(bottom_, b);
    }
    [[nodiscard]] std::optional<UiScissorRect> rect() const {
        if (right_ <= left_ || bottom_ <= top_)
            return std::nullopt;
        return UiScissorRect{left_, top_, right_ - left_, bottom_ - top_};
    }

private:
    int left_ = std::numeric_limits<int>::max(), top_ = left_;
    int right_ = std::numeric_limits<int>::min(), bottom_ = right_;
};

/** How one run of a segment's draws meets its target. */
enum class UiRunComposition {
    /** Each draw blends straight into the target: a single-sample consumer's, or canvases. */
    blend,
    /** Multisampled over the destination's clear colour, resolved straight into the destination. */
    direct,
    /** Multisampled into the transparent layer, resolved, and composited over the target. */
    layered,
};

/** The runs of one frame per composition. */
struct UiRunCounts {
    std::uint32_t blend = 0, direct = 0, layered = 0;
    bool operator==(const UiRunCounts&) const = default;
};

/**
 * Splits a segment's draws [begin, end) into runs and names how each composes. A multisampled
 * consumer's engine canvas draws (`canvas(index)`) are resolved frames: they blend between the
 * multisampled runs around them. Its first run resolves straight into the destination while
 * `replaceable` (the segment draws into a destination that holds only its clear colour); every
 * other multisampled run goes through the layer.
 */
template <typename Canvas, typename Run>
void for_each_ui_run(std::size_t begin, std::size_t end, bool multisampled, bool replaceable,
                     Canvas&& canvas, UiRunCounts& counts, Run&& run) {
    const auto canvas_draw = [&](std::size_t index) { return multisampled && canvas(index); };
    for (std::size_t first = begin; first < end;) {
        const bool canvases = canvas_draw(first);
        std::size_t last = first + 1;
        while (last < end && canvas_draw(last) == canvases)
            ++last;
        const UiRunComposition composition = !multisampled || canvases ? UiRunComposition::blend
                                             : replaceable             ? UiRunComposition::direct
                                                                       : UiRunComposition::layered;
        ++(composition == UiRunComposition::blend    ? counts.blend
           : composition == UiRunComposition::direct ? counts.direct
                                                     : counts.layered);
        replaceable = false;
        run(first, last, composition);
        first = last;
    }
}

/** The destination history and canvas classification shared by every UI consumer. */
class UiRunPolicy {
public:
    UiRunCounts counts;

    template <typename Textures, typename Run>
    void segment(const UiRenderFrame& frame, std::size_t begin, std::size_t end, bool multisampled,
                 bool root, bool destination_clear, bool external_textures,
                 const Textures& textures, Run&& run) {
        const bool replaceable = destination_clear && root && !destination_drawn_;
        destination_drawn_ |= root;
        for_each_ui_run(
            begin, end, multisampled, replaceable,
            [&](std::size_t index) {
                const auto id = frame.draws[index].texture_id;
                return external_textures && id && !textures.contains(id);
            },
            counts, std::forward<Run>(run));
    }

    void operation(const UiRenderFrame& frame, const UiRenderOperation& operation) {
        destination_drawn_ |= operation.kind == UiRenderOperation::Kind::Backdrop ||
                              (operation.kind == UiRenderOperation::Kind::Composite &&
                               frame.composites[operation.index].destination == 0);
    }

private:
    bool destination_drawn_ = false;
};

/** Backend-independent target/resolve and clear choice for one run. */
template <typename Target, typename Color> struct UiRunTargets {
    Target draw{}, resolve{};
    std::optional<Color> clear;
};

template <typename Target, typename Color>
UiRunTargets<Target, Color> ui_run_targets(UiRunComposition composition, Target destination,
                                           Target layer, Target multisample,
                                           std::optional<Color> destination_clear) {
    if (composition == UiRunComposition::blend)
        return {destination, {}, {}};
    const bool layered = composition == UiRunComposition::layered;
    const Target resolved = layered ? layer : destination;
    return {multisample ? multisample : resolved, multisample ? resolved : Target{},
            layered ? Color{} : destination_clear};
}

/**
 * BBLITE_MEM_PROFILE=1: one line per page UI target a compositor allocates, and one per frame
 * whose runs compose differently from the frame before, so a run reports what its paths hold.
 */
class UiTargetProfile {
public:
    explicit UiTargetProfile(const char* backend) : backend_(backend) {}
    void allocated(const char* target, std::uint32_t width, std::uint32_t height,
                   std::uint32_t samples, std::uint32_t texel_bytes) const {
        if (enabled_)
            std::fprintf(stderr,
                         "[mem][ui-target] backend=%s target=%s width=%u height=%u samples=%u "
                         "bytes=%llu\n",
                         backend_, target, width, height, samples,
                         static_cast<unsigned long long>(width) * height * samples * texel_bytes);
    }
    void composed(const UiRunCounts& counts) {
        if (!enabled_ || last_ == counts)
            return;
        last_ = counts;
        std::fprintf(stderr, "[mem][ui-runs] backend=%s blend=%u direct=%u layered=%u\n", backend_,
                     counts.blend, counts.direct, counts.layered);
    }

private:
    const char* backend_;
    bool enabled_ = MemoryProfile::enabled();
    std::optional<UiRunCounts> last_;
};
#endif

} // namespace bbl::pal
