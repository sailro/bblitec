#pragma once
#include <bblite/text.hpp>

namespace bbl {
/** The pin's `TextLayer`; `createTextLayer` (lowered) writes every field. */
struct TextLayerState {
    TextData data;
    Vec2d position_px{};
    double rotation_rad = 0, scale = 0, order = 0, opacity = 0, coverage_gamma = 0;
    bool visible = false;
    double version = 0;
};
using TextLayer = std::shared_ptr<TextLayerState>;
// The renderer, its options and its per-layer GPU records are the pin's own
// (`upstream_text_records.hpp`); the renderer handle is `text_gpu.hpp`'s.
} // namespace bbl
