#include <bblite/text_layout.hpp>
#include <hb.h>
#include <hb-ot.h>
#include <limits>
#include <stdexcept>

namespace bbl::pal {
namespace {
struct Font {
    hb_font_t* font = nullptr;
    hb_buffer_t* buffer = hb_buffer_create();
    ~Font() { if (font) hb_font_destroy(font); hb_buffer_destroy(buffer); }
};
}
std::shared_ptr<TextLayoutFont> create_text_layout_font(std::span<const std::uint8_t> bytes) {
    if (bytes.size() > std::numeric_limits<unsigned>::max()) throw std::runtime_error("Text font exceeds HarfBuzz size limits.");
    hb_blob_t* blob = hb_blob_create(reinterpret_cast<const char*>(bytes.data()), static_cast<unsigned>(bytes.size()), HB_MEMORY_MODE_DUPLICATE, nullptr, nullptr);
    hb_face_t* face = hb_face_create(blob, 0);
    hb_blob_destroy(blob);
    auto owner = std::make_shared<Font>();
    owner->font = hb_font_create(face);
    const auto upem = hb_face_get_upem(face);
    const auto glyphs = hb_face_get_glyph_count(face);
    hb_face_destroy(face);
    if (!glyphs || !upem || !hb_buffer_allocation_successful(owner->buffer)) throw std::runtime_error("HarfBuzz could not initialize the pinned font.");
    hb_ot_font_set_funcs(owner->font);
    hb_font_set_scale(owner->font, static_cast<int>(upem), static_cast<int>(upem));
    hb_codepoint_t space = 0;
    static_cast<void>(hb_font_get_nominal_glyph(owner->font, 32, &space));
    auto result = std::make_shared<TextLayoutFont>();
    result->backend = std::move(owner);
    result->units_per_em = upem;
    result->space_glyph = space;
    return result;
}

std::u32string text_codepoints(std::string_view text) {
    std::u32string result;
    for (std::size_t i = 0; i < text.size();) {
        const auto first = static_cast<unsigned char>(text[i++]);
        char32_t code = first;
        unsigned continuation = 0;
        if (first >= 0xc2 && first <= 0xdf) { code &= 0x1f; continuation = 1; }
        else if (first >= 0xe0 && first <= 0xef) { code &= 0x0f; continuation = 2; }
        else if (first >= 0xf0 && first <= 0xf4) { code &= 0x07; continuation = 3; }
        else if (first >= 0x80) throw std::runtime_error("Text input is not valid UTF-8.");
        for (unsigned j = 0; j < continuation; ++j) {
            if (i >= text.size() || (static_cast<unsigned char>(text[i]) & 0xc0) != 0x80) throw std::runtime_error("Text input is not valid UTF-8.");
            code = (code << 6) | (static_cast<unsigned char>(text[i++]) & 0x3f);
        }
        if ((continuation == 1 && code < 0x80) || (continuation == 2 && code < 0x800) ||
            (continuation == 3 && code < 0x10000) || (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff)
            throw std::runtime_error("Text input is not valid UTF-8.");
        result.push_back(code);
    }
    return result;
}

void text_shape(const TextLayoutFont& font, const std::u32string& input, TextShapeOutput& output) {
    if (input.size() > static_cast<std::size_t>(std::numeric_limits<int>::max())) throw std::runtime_error("Text input exceeds HarfBuzz size limits.");
    auto& owner = *std::static_pointer_cast<Font>(font.backend);
    hb_buffer_reset(owner.buffer);
    hb_buffer_set_cluster_level(owner.buffer, HB_BUFFER_CLUSTER_LEVEL_MONOTONE_CHARACTERS);
    hb_buffer_set_content_type(owner.buffer, HB_BUFFER_CONTENT_TYPE_UNICODE);
    for (std::size_t i = 0; i < input.size(); ++i) hb_buffer_add(owner.buffer, static_cast<hb_codepoint_t>(input[i]), static_cast<unsigned>(i));
    hb_buffer_guess_segment_properties(owner.buffer);
    hb_shape(owner.font, owner.buffer, nullptr, 0);
    if (!hb_buffer_allocation_successful(owner.buffer)) throw std::runtime_error("HarfBuzz shaping allocation failed.");
    unsigned count = 0;
    const auto* infos = hb_buffer_get_glyph_infos(owner.buffer, &count);
    const auto* positions = hb_buffer_get_glyph_positions(owner.buffer, nullptr);
    output.infos.clear(); output.positions.clear();
    output.infos.reserve(count); output.positions.reserve(count);
    for (unsigned i = 0; i < count; ++i) {
        output.infos.push_back({static_cast<double>(infos[i].codepoint), static_cast<double>(input.at(infos[i].cluster)), static_cast<double>(infos[i].cluster)});
        output.positions.push_back({static_cast<double>(positions[i].x_advance), static_cast<double>(positions[i].x_offset), static_cast<double>(positions[i].y_offset)});
    }
}
} // namespace bbl::pal
