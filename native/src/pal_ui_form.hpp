#pragma once
#include <bblite/pal_system_fonts.hpp>
#include <ft2build.h>
#include FT_FREETYPE_H
#include <cmath>
#include <fstream>
#include <iterator>
#include <map>
#include <optional>
#include <tuple>
#include <vector>

namespace bbl::pal {
// Browser text controls retain fractional advances even when their glyph masks
// are grid fitted. RmlUi's default font engine stores integer glyph advances.
// For a fixed-pitch face the difference is one uniform spacing adjustment.
class TextFormMetrics {
public:
    TextFormMetrics() {
        if (FT_Init_FreeType(&library)) throw std::runtime_error("Text form font metrics initialization failed.");
    }
    ~TextFormMetrics() { FT_Done_FreeType(library); }
    TextFormMetrics(const TextFormMetrics&) = delete;
    TextFormMetrics& operator=(const TextFormMetrics&) = delete;

    std::optional<float> spacing(const std::string& family, int weight, float size) {
        const auto key = std::tuple{family, weight, size};
        const auto found = cache.find(key);
        if (found != cache.end()) return found->second;
        return cache.emplace(key, measure(family, weight, size)).first->second;
    }
private:
    std::optional<float> measure(const std::string& family, int weight, float size) {
        const auto descriptor = find_system_font(family, weight);
        if (!descriptor) return std::nullopt;
        std::ifstream input(descriptor->path, std::ios::binary);
        const std::vector<unsigned char> bytes((std::istreambuf_iterator<char>(input)), {});
        FT_Face face = nullptr;
        if (FT_New_Memory_Face(library, bytes.data(), static_cast<FT_Long>(bytes.size()), descriptor->face_index, &face))
            throw std::runtime_error("Text form font metrics could not open the resolved face.");
        struct Release { FT_Face face; ~Release() { FT_Done_Face(face); } } release{face};
        if (!FT_IS_FIXED_WIDTH(face)) return std::nullopt;
        const auto glyph = FT_Get_Char_Index(face, ' ');
        if (FT_Load_Glyph(face, glyph, FT_LOAD_NO_SCALE))
            throw std::runtime_error("Text form design advance lookup failed.");
        const float design = static_cast<float>(face->glyph->metrics.horiAdvance) * size / face->units_per_EM;
        if (FT_Set_Pixel_Sizes(face, 0, static_cast<FT_UInt>(std::lround(size))) || FT_Load_Glyph(face, glyph, FT_LOAD_DEFAULT))
            throw std::runtime_error("Text form hinted advance lookup failed.");
        const float hinted = static_cast<float>(face->glyph->advance.x) / 64.f;
        return design - hinted;
    }
    FT_Library library = nullptr;
    std::map<std::tuple<std::string, int, float>, std::optional<float>> cache;
};
} // namespace bbl::pal
