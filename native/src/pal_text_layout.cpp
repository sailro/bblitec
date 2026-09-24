#include <bblite/text_layout.hpp>
#include <hb.h>
#include <hb-ot.h>
#include <algorithm>
#include <limits>
#include <stdexcept>

namespace bbl::pal {
namespace {
struct Font {
    hb_font_t* font = nullptr;
    hb_buffer_t* buffer = hb_buffer_create();
    ~Font() {
        if (font)
            hb_font_destroy(font);
        hb_buffer_destroy(buffer);
    }
};
} // namespace
std::shared_ptr<TextLayoutFont> create_text_layout_font(std::span<const std::uint8_t> bytes) {
    if (bytes.size() > std::numeric_limits<unsigned>::max())
        throw std::runtime_error("Text font exceeds HarfBuzz size limits.");
    hb_blob_t* blob = hb_blob_create(reinterpret_cast<const char*>(bytes.data()),
                                     static_cast<unsigned>(bytes.size()), HB_MEMORY_MODE_DUPLICATE,
                                     nullptr, nullptr);
    hb_face_t* face = hb_face_create(blob, 0);
    hb_blob_destroy(blob);
    auto owner = std::make_shared<Font>();
    owner->font = hb_font_create(face);
    const auto upem = hb_face_get_upem(face);
    const auto glyphs = hb_face_get_glyph_count(face);
    hb_face_destroy(face);
    if (!glyphs || !upem || !hb_buffer_allocation_successful(owner->buffer))
        throw std::runtime_error("HarfBuzz could not initialize the pinned font.");
    hb_ot_font_set_funcs(owner->font);
    hb_font_set_scale(owner->font, static_cast<int>(upem), static_cast<int>(upem));
    auto result = std::make_shared<TextLayoutFont>();
    result->backend = std::move(owner);
    result->units_per_em = upem;
    result->num_glyphs = glyphs;
    return result;
}

double text_glyph_id(const TextLayoutFont& font, double codepoint) {
    if (!(codepoint >= 0 && codepoint <= 0x10ffff) ||
        codepoint != static_cast<double>(static_cast<hb_codepoint_t>(codepoint)))
        return 0;
    auto& owner = *std::static_pointer_cast<Font>(font.backend);
    hb_codepoint_t glyph = 0;
    return hb_font_get_nominal_glyph(owner.font, static_cast<hb_codepoint_t>(codepoint), &glyph)
               ? static_cast<double>(glyph)
               : 0.0;
}

void text_shape(const TextLayoutFont& font, const TextShapeInput& input, TextShapeOutput& output) {
    const auto count = input.codepoints.size();
    if (count > static_cast<std::size_t>(std::numeric_limits<int>::max()))
        throw std::runtime_error("Text input exceeds HarfBuzz size limits.");
    auto& owner = *std::static_pointer_cast<Font>(font.backend);
    hb_buffer_reset(owner.buffer);
    hb_buffer_set_cluster_level(owner.buffer, HB_BUFFER_CLUSTER_LEVEL_MONOTONE_CHARACTERS);
    hb_buffer_set_content_type(owner.buffer, HB_BUFFER_CONTENT_TYPE_UNICODE);
    for (std::size_t i = 0; i < count; ++i) {
        const double cluster = input.clusters[i];
        if (!(cluster >= 0 && cluster <= std::numeric_limits<unsigned>::max()))
            throw std::runtime_error("Text shaping cluster exceeds HarfBuzz limits.");
        hb_buffer_add(owner.buffer, static_cast<hb_codepoint_t>(input.codepoints[i]),
                      static_cast<unsigned>(cluster));
    }
    hb_buffer_guess_segment_properties(owner.buffer);
    hb_shape(owner.font, owner.buffer, nullptr, 0);
    if (!hb_buffer_allocation_successful(owner.buffer))
        throw std::runtime_error("HarfBuzz shaping allocation failed.");
    unsigned shaped = 0;
    const auto* infos = hb_buffer_get_glyph_infos(owner.buffer, &shaped);
    const auto* positions = hb_buffer_get_glyph_positions(owner.buffer, nullptr);
    // A glyph's codepoint is the first input codepoint of its cluster.
    const bool ordered = std::is_sorted(input.clusters.begin(), input.clusters.end());
    const auto source = [&](unsigned cluster) -> double {
        const auto value = static_cast<double>(cluster);
        const auto found =
            ordered ? std::lower_bound(input.clusters.begin(), input.clusters.end(), value)
                    : std::find(input.clusters.begin(), input.clusters.end(), value);
        if (found == input.clusters.end() || *found != value)
            throw std::runtime_error("HarfBuzz returned a cluster outside the shaped input.");
        return static_cast<double>(
            input.codepoints[static_cast<std::size_t>(found - input.clusters.begin())]);
    };
    output.infos.clear();
    output.positions.clear();
    output.infos.reserve(shaped);
    output.positions.reserve(shaped);
    for (unsigned i = 0; i < shaped; ++i) {
        output.infos.push_back({static_cast<double>(infos[i].codepoint), source(infos[i].cluster),
                                static_cast<double>(infos[i].cluster)});
        output.positions.push_back({static_cast<double>(positions[i].x_advance),
                                    static_cast<double>(positions[i].x_offset),
                                    static_cast<double>(positions[i].y_offset)});
    }
}
} // namespace bbl::pal
