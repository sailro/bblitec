#pragma once
#include <bblite/text.hpp>
#include <cstdint>
#include <functional>
#include <memory>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace bbl {
struct GlyphStorage;
/**
 * The pin's `Font`: HarfBuzz stands in for the text shaper at run time, and
 * the facts the shaper answered at generation (the family's curve-set id,
 * the packaged glyph repertoire) travel with it.
 */
struct TextLayoutFont {
    std::shared_ptr<void> backend;
    double units_per_em = 0;
    double space_glyph = 0;
    double num_glyphs = 0;
    std::string curve_set_id;
    /** A fresh `GlyphStorage` holding every outline of the font, packed at generation. */
    std::function<std::shared_ptr<GlyphStorage>()> packaged_storage;
};
struct TextShapeInfo {
    double glyph_id = 0, codepoint = 0, cluster = 0;
};
struct TextShapePosition {
    double x_advance = 0, x_offset = 0, y_offset = 0;
};
struct TextShapeOutput {
    std::vector<TextShapeInfo> infos;
    std::vector<TextShapePosition> positions;
};
namespace pal {
std::shared_ptr<TextLayoutFont> create_text_layout_font(std::span<const std::uint8_t> bytes);
std::u32string text_codepoints(std::string_view text);
void text_shape(const TextLayoutFont& font, const std::u32string& input, TextShapeOutput& output);
} // namespace pal
} // namespace bbl
