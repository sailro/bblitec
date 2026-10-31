// The one rule both backends' UI compositors share: how a recorded draw's
// scissor meets the frame.
#pragma once
#include <bblite/features/has_ui.hpp>

#if BBLITE_HAS_UI
#include <bblite/pal_ui.hpp>
#endif

#include <algorithm>
#include <cmath>
#include <cstdint>
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
#endif

} // namespace bbl::pal
