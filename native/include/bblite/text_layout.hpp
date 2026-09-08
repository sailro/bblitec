#pragma once
#include <bblite/text.hpp>
#include <cstdint>
#include <string_view>

namespace bbl {
struct TextLayoutFont {
    std::shared_ptr<void> backend;
    double units_per_em = 0;
    double space_glyph = 0;
};
struct TextLayoutOptions {
    double max_width = std::numeric_limits<double>::infinity();
    double line_height = 1.2;
    std::string align = "left";
    double letter_spacing = 0;
    double tab_size = 4;
};
struct TextShapeInfo { double glyph_id = 0, codepoint = 0, cluster = 0; };
struct TextShapePosition { double x_advance = 0, x_offset = 0, y_offset = 0; };
struct TextShapeOutput {
    std::vector<TextShapeInfo> infos;
    std::vector<TextShapePosition> positions;
};
struct TextPlacedGlyph { double glyph_id = 0, x = 0, y = 0; };
struct TextLayoutResult {
    std::vector<TextPlacedGlyph> glyphs;
    double pixels_per_font_unit = 0, width = 0, height = 0;
};
struct TextLiveData {
    std::shared_ptr<TextLayoutFont> font;
    double font_size = 0;
    TextLayoutOptions options;
    std::vector<double> glyph_slots, slots, free_slots;
    std::vector<float> instances, styles;
    std::array<double, 4> color{1, 1, 1, 1};
    double instance_count = 0, style_count = 0, slot_count = 0;
    double version = 0, style_version = 0, layout_version = 0, dirty_start = 0, dirty_end = 0;
};
namespace pal {
std::shared_ptr<TextLayoutFont> create_text_layout_font(std::span<const std::uint8_t> bytes);
std::u32string text_codepoints(std::string_view text);
void text_shape(const TextLayoutFont& font, const std::u32string& input, TextShapeOutput& output);
}
} // namespace bbl
