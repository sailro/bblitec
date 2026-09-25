// The one rule both backends' UI compositors share: how a recorded draw's
// scissor meets the frame.
#pragma once
#include <bblite/features/has_ui.hpp>

#if BBLITE_HAS_UI
#include <bblite/pal_ui.hpp>
#endif

#include <algorithm>
#include <cstdint>
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
#endif

} // namespace bbl::pal
