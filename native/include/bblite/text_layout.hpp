#pragma once
#include <bblite/text.hpp>
#include <cstdint>
#include <functional>
#include <memory>
#include <span>
#include <string>
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
    double num_glyphs = 0;
    std::string curve_set_id;
    /** A fresh `GlyphStorage` holding every outline of the font, packed at generation. */
    std::function<std::shared_ptr<GlyphStorage>()> packaged_storage;
};

/** text-shaper's `Font.scaleForSize(size)`: pixels per font unit. */
[[nodiscard]] inline double text_scale_for_size(const TextLayoutFont& font, double size) {
    return size / font.units_per_em;
}

/**
 * text-shaper's `UnicodeBuffer`: the codepoints to shape, each with the
 * cluster value `addStr` gave it.
 */
struct TextShapeInput {
    std::vector<char32_t> codepoints;
    std::vector<double> clusters;
    void clear() {
        codepoints.clear();
        clusters.clear();
    }
    /**
     * `addStr(text, startCluster)`: the text's codepoints, its UTF-16
     * surrogate pairs joined, clustered from `start` one per codepoint.
     */
    void add_str(const std::string& text, double start) {
        const auto units = js::string_code_units(text);
        double cluster = start;
        for (std::size_t index = 0; index < units.size(); ++index) {
            char32_t point = units[index];
            if (point >= 0xd800u && point <= 0xdbffu && index + 1 < units.size() &&
                units[index + 1] >= 0xdc00u && units[index + 1] <= 0xdfffu)
                point = 0x10000u + ((point - 0xd800u) << 10u) + (units[++index] - 0xdc00u);
            codepoints.push_back(point);
            clusters.push_back(cluster);
            cluster += 1;
        }
    }
};
/** One shaped glyph: its glyph id, the codepoint its cluster starts with, the cluster. */
struct TextShapeInfo {
    double glyph_id = 0, codepoint = 0, cluster = 0;
};
struct TextShapePosition {
    double x_advance = 0, x_offset = 0, y_offset = 0;
};
/** text-shaper's `GlyphBuffer`: the shaped glyphs and their positions. */
struct TextShapeOutput {
    js::Array<TextShapeInfo> infos;
    js::Array<TextShapePosition> positions;
};
namespace pal {
std::shared_ptr<TextLayoutFont> create_text_layout_font(std::span<const std::uint8_t> bytes);
/** text-shaper's `Font.glyphId(codepoint)`: the nominal glyph, 0 when the font has none. */
double text_glyph_id(const TextLayoutFont& font, double codepoint);
/** text-shaper's `shapeInto(font, input, output)`, through HarfBuzz. */
void text_shape(const TextLayoutFont& font, const TextShapeInput& input, TextShapeOutput& output);
} // namespace pal
} // namespace bbl
