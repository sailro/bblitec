#pragma once
// Browser-compatible raster rules adapted from Skia b6d106297ff9ef2ff8094033695d045e87775581
// (src/ports/SkScalerContext_win_dw.cpp, src/core/SkMaskGamma.cpp).
// BSD-3-Clause notice: native/notices/Skia.txt.
#if defined(_WIN32)
#include "pal_win32_text.hpp"
#include <RmlUi/Core/CallbackTexture.h>
#include <RmlUi/Core/FontEngineInterface.h>
#include <RmlUi/Core/MeshUtilities.h>
#include <RmlUi/Core/RenderManager.h>
#include <RmlUi/Core/StringUtilities.h>
#include <dwrite_2.h>
#include <wrl/client.h>
#include <algorithm>
#include <array>
#include <cmath>
#include <map>
#include <memory>
#include <stdexcept>
#include <tuple>
#include <vector>

namespace bbl::pal {
// Windows font discovery, design metrics and rasterization are platform work.
// The registered RmlUi engine retains color glyphs, fallback faces and effects.
// Ordinary outline/bitmap text uses the same DirectWrite modes as Chromium's
// SkScalerContext_DW, including default grid fitting in the legacy API.
class Win32UiFontEngine final : public Rml::FontEngineInterface {
    template<class T> using ComPtr = Microsoft::WRL::ComPtr<T>;
    static void check(HRESULT result, const char* operation) {
        if (FAILED(result)) throw std::runtime_error(std::string("DirectWrite UI font: ") + operation);
    }
    struct Table {
        IDWriteFontFace* face;
        const std::uint8_t* bytes = nullptr;
        UINT32 length = 0;
        void* context = nullptr;
        Table(IDWriteFontFace* face, UINT32 tag) : face(face) {
            BOOL exists = FALSE;
            check(face->TryGetFontTable(tag, reinterpret_cast<const void**>(&bytes), &length, &context, &exists), "font table lookup");
            if (!exists) length = 0;
        }
        ~Table() { if (context) face->ReleaseFontTable(context); }
        std::uint16_t u16(std::size_t offset) const { return offset + 2 <= length ? static_cast<std::uint16_t>((bytes[offset] << 8) | bytes[offset + 1]) : 0; }
        std::uint32_t u32(std::size_t offset) const { return (std::uint32_t(u16(offset)) << 16) | u16(offset + 2); }
    };
    struct SourceFace {
        std::string family;
        Rml::Style::FontStyle style;
        Rml::Style::FontWeight weight;
        ComPtr<IDWriteFontFace> face;
        bool color = false;
    };
    struct Glyph {
        Rml::Vector2f origin, dimensions;
        std::unique_ptr<Rml::CallbackTextureSource> texture;
    };
    struct Face {
        SourceFace* source;
        Rml::FontMetrics metrics;
        DWRITE_RENDERING_MODE rendering = DWRITE_RENDERING_MODE_NATURAL_SYMMETRIC;
        std::map<std::tuple<UINT16, int, unsigned>, Glyph> glyphs;
    };
    struct ScriptAnalysis final : IDWriteTextAnalysisSource, IDWriteTextAnalysisSink {
        const std::wstring& text;
        std::wstring locale;
        DWRITE_READING_DIRECTION direction;
        std::vector<DWRITE_SCRIPT_ANALYSIS> scripts;
        std::vector<UINT8> levels;
        ScriptAnalysis(const std::wstring& text, std::wstring locale, DWRITE_READING_DIRECTION direction)
            : text(text), locale(std::move(locale)), direction(direction), scripts(text.size()), levels(text.size()) {}
        HRESULT STDMETHODCALLTYPE QueryInterface(REFIID id, void** out) override {
            *out = nullptr;
            if (id == __uuidof(IUnknown) || id == __uuidof(IDWriteTextAnalysisSource)) *out = static_cast<IDWriteTextAnalysisSource*>(this);
            else if (id == __uuidof(IDWriteTextAnalysisSink)) *out = static_cast<IDWriteTextAnalysisSink*>(this);
            return *out ? S_OK : E_NOINTERFACE;
        }
        ULONG STDMETHODCALLTYPE AddRef() override { return 1; }
        ULONG STDMETHODCALLTYPE Release() override { return 1; }
        HRESULT STDMETHODCALLTYPE GetTextAtPosition(UINT32 position, const WCHAR** value, UINT32* length) noexcept override {
            *value = position < text.size() ? text.data() + position : nullptr;
            *length = position < text.size() ? static_cast<UINT32>(text.size()) - position : 0; return S_OK;
        }
        HRESULT STDMETHODCALLTYPE GetTextBeforePosition(UINT32 position, const WCHAR** value, UINT32* length) noexcept override {
            *value = position && position <= text.size() ? text.data() : nullptr; *length = *value ? position : 0; return S_OK;
        }
        DWRITE_READING_DIRECTION STDMETHODCALLTYPE GetParagraphReadingDirection() noexcept override { return direction; }
        HRESULT STDMETHODCALLTYPE GetLocaleName(UINT32 position, UINT32* length, const WCHAR** value) noexcept override {
            *length = static_cast<UINT32>(text.size()) - position; *value = locale.c_str(); return S_OK;
        }
        HRESULT STDMETHODCALLTYPE GetNumberSubstitution(UINT32 position, UINT32* length, IDWriteNumberSubstitution** value) noexcept override {
            *length = static_cast<UINT32>(text.size()) - position; *value = nullptr; return S_OK;
        }
        HRESULT STDMETHODCALLTYPE SetScriptAnalysis(UINT32 position, UINT32 length, const DWRITE_SCRIPT_ANALYSIS* value) noexcept override {
            std::fill_n(scripts.begin() + position, length, *value); return S_OK;
        }
        HRESULT STDMETHODCALLTYPE SetLineBreakpoints(UINT32, UINT32, const DWRITE_LINE_BREAKPOINT*) noexcept override { return S_OK; }
        HRESULT STDMETHODCALLTYPE SetBidiLevel(UINT32 position, UINT32 length, UINT8, UINT8 resolved) noexcept override {
            std::fill_n(levels.begin() + position, length, resolved); return S_OK;
        }
        HRESULT STDMETHODCALLTYPE SetNumberSubstitution(UINT32, UINT32, IDWriteNumberSubstitution*) noexcept override { return S_OK; }
    };
    static std::string lower(std::string value) {
        std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        return value;
    }
    static DWRITE_RENDERING_MODE rendering_mode(IDWriteFontFace* face, int size) {
        Table gasp(face, DWRITE_MAKE_OPENTYPE_TAG('g','a','s','p'));
        int minimum = size, maximum = size, version = -1, flags = 0;
        if (gasp.length >= 4 && gasp.u16(0) <= 1 && gasp.u16(2) <= 1024 && 4u + 4u * gasp.u16(2) <= gasp.length) {
            int previous = -1;
            for (unsigned i = 0; i < gasp.u16(2); ++i) {
                const int upper = gasp.u16(4 + i * 4);
                if (previous < size && size <= upper) { version = gasp.u16(0); flags = gasp.u16(6 + i * 4); if (flags == 1) { minimum = previous + 1; maximum = upper; } break; }
                previous = upper;
            }
        }
        Table eblc(face, DWRITE_MAKE_OPENTYPE_TAG('E','B','L','C'));
        if (eblc.length >= 8 && eblc.u32(0) == 0x20000 && eblc.u32(4) <= 1024 && 8u + 48u * eblc.u32(4) <= eblc.length) {
            for (unsigned i = 0; i < eblc.u32(4); ++i) {
                const unsigned p = 8 + 48 * i;
                const int ppem = eblc.bytes[p + 44];
                if (ppem == eblc.bytes[p + 45] && minimum <= ppem && ppem <= maximum && eblc.u16(p + 42) >= eblc.u16(p + 40) + 3)
                    return DWRITE_RENDERING_MODE_GDI_CLASSIC;
            }
        }
        Table ebsc(face, DWRITE_MAKE_OPENTYPE_TAG('E','B','S','C'));
        if (ebsc.length >= 8 && ebsc.u32(0) == 0x20000 && ebsc.u32(4) <= 1024 && 8u + 28u * ebsc.u32(4) <= ebsc.length) {
            for (unsigned i = 0; i < ebsc.u32(4); ++i) {
                const unsigned p = 8 + 28 * i;
                const int ppem = ebsc.bytes[p + 24];
                if (ppem == ebsc.bytes[p + 25] && minimum <= ppem && ppem <= maximum) return DWRITE_RENDERING_MODE_GDI_CLASSIC;
            }
        }
        if (version >= 1) return flags & 8 ? DWRITE_RENDERING_MODE_NATURAL_SYMMETRIC : DWRITE_RENDERING_MODE_NATURAL;
        Table maxp(face, DWRITE_MAKE_OPENTYPE_TAG('m','a','x','p'));
        const bool hinted = maxp.length >= 32 && maxp.u32(0) == 0x10000 && maxp.u16(26) != 0;
        return size > 20 || !hinted ? DWRITE_RENDERING_MODE_NATURAL_SYMMETRIC : DWRITE_RENDERING_MODE_NATURAL;
    }
    // Skia's three-bit luminance buckets and sRGB pre-blend. Coverage is
    // premultiplied once by RmlUi; the source foreground color stays separate.
    static std::array<std::uint8_t, 256> coverage_table(unsigned green) {
        const unsigned bucket = green >> 5;
        const float source = static_cast<float>((bucket << 5) | (bucket << 2) | (bucket >> 1)) / 255.f;
        const auto linear = [](float value) { return value <= .04045f ? value / 12.92f : std::pow((value + .055f) / 1.055f, 2.4f); };
        const auto encoded = [](float value) { return value <= .0031308f ? value * 12.92f : 1.055f * std::pow(value, 1.f / 2.4f) - .055f; };
        const float destination = 1.f - source, source_linear = linear(source), destination_linear = linear(destination);
        std::array<std::uint8_t, 256> result{};
        for (unsigned i = 0; i < result.size(); ++i) {
            const float raw = static_cast<float>(i) / 255.f;
            const float alpha = raw + (1.f - raw) * (128.f / 255.f) * destination_linear * raw;
            const float corrected = std::abs(source - destination) < 1.f / 256.f ? alpha
                : (encoded(source_linear * alpha + destination_linear * (1.f - alpha)) - destination) / (source - destination);
            result[i] = static_cast<std::uint8_t>(std::clamp(std::lround(corrected * 255.f), 0l, 255l));
        }
        return result;
    }
    Glyph& glyph(Face& face, UINT16 index, int quarter, unsigned green) {
        const auto key = std::tuple{index, quarter, green >> 5};
        if (auto found = face.glyphs.find(key); found != face.glyphs.end()) return found->second;
        FLOAT advance = 0;
        const DWRITE_GLYPH_OFFSET offset{};
        const DWRITE_GLYPH_RUN run{face.source->face.Get(), static_cast<float>(face.metrics.size), 1, &index, &advance, &offset, FALSE, 0};
        const DWRITE_MATRIX transform{1,0,0,1,quarter * .25f,0};
        ComPtr<IDWriteGlyphRunAnalysis> analysis;
        check(factory->CreateGlyphRunAnalysis(&run, 1.f, &transform, face.rendering,
            DWRITE_MEASURING_MODE_NATURAL, 0, 0, &analysis), "glyph rasterization");
        RECT rect{};
        check(analysis->GetAlphaTextureBounds(DWRITE_TEXTURE_CLEARTYPE_3x1, &rect), "glyph bounds");
        const int width = rect.right - rect.left, height = rect.bottom - rect.top;
        Glyph value{{static_cast<float>(rect.left), static_cast<float>(rect.top)}, {static_cast<float>(width), static_cast<float>(height)}, {}};
        if (width && height) {
            std::vector<std::uint8_t> mask(static_cast<std::size_t>(width) * height * 3);
            check(analysis->CreateAlphaTexture(DWRITE_TEXTURE_CLEARTYPE_3x1, &rect, mask.data(), static_cast<UINT32>(mask.size())), "glyph coverage");
            const auto table = coverage_table(green);
            std::vector<Rml::byte> pixels(static_cast<std::size_t>(width) * height * 4);
            for (std::size_t p = 0; p < mask.size() / 3; ++p) {
                const auto alpha = table[(static_cast<unsigned>(mask[p * 3]) + mask[p * 3 + 1] + mask[p * 3 + 2]) / 3];
                for (unsigned c = 0; c < 4; ++c) pixels[p * 4 + c] = alpha;
            }
            value.texture = std::make_unique<Rml::CallbackTextureSource>([pixels = std::move(pixels), width, height](const Rml::CallbackTextureInterface& out) {
                return out.GenerateTexture(pixels, {width, height});
            });
        }
        return face.glyphs.emplace(key, std::move(value)).first->second;
    }
    bool indices(Face& face, Rml::StringView text, std::vector<UINT16>& output) const {
        std::vector<UINT32> points;
        for (auto it = Rml::StringIteratorU8(text); it; ++it) if (static_cast<UINT32>(*it) >= 32) points.push_back(static_cast<UINT32>(*it));
        output.resize(points.size());
        if (points.empty()) return true;
        check(face.source->face->GetGlyphIndices(points.data(), static_cast<UINT32>(points.size()), output.data()), "glyph mapping");
        return std::none_of(output.begin(), output.end(), [](UINT16 value) { return value == 0; });
    }
    float shape(Face& face, Rml::StringView text, const Rml::TextShapingContext& context,
        std::vector<UINT16>& glyphs, std::vector<Rml::Vector2f>& positions) const {
        auto wide = utf8_to_wide(std::string_view(text.begin(), text.size()));
        if (!wide) throw std::runtime_error("DirectWrite text is not UTF-8.");
        wide->erase(std::remove_if(wide->begin(), wide->end(), [](wchar_t c) { return c < 32; }), wide->end());
        glyphs.clear(); positions.clear();
        if (wide->empty()) return 0;
        auto locale = utf8_to_wide(context.language);
        ScriptAnalysis analysis(*wide, locale && !locale->empty() ? *locale : L"en-us",
            context.text_direction == Rml::Style::Direction::Rtl ? DWRITE_READING_DIRECTION_RIGHT_TO_LEFT : DWRITE_READING_DIRECTION_LEFT_TO_RIGHT);
        const auto count = static_cast<UINT32>(wide->size());
        check(analyzer->AnalyzeScript(&analysis, 0, count, &analysis), "script analysis");
        check(analyzer->AnalyzeBidi(&analysis, 0, count, &analysis), "direction analysis");
        float width = 0;
        for (UINT32 start = 0; start < count;) {
            UINT32 end = start + 1;
            while (end < count && analysis.scripts[end].script == analysis.scripts[start].script && analysis.levels[end] == analysis.levels[start]) ++end;
            const UINT32 length = end - start, capacity = length * 3 / 2 + 16;
            const bool rtl = (analysis.levels[start] & 1) != 0;
            std::vector<UINT16> clusters(length), mapped(capacity);
            std::vector<DWRITE_SHAPING_TEXT_PROPERTIES> text_properties(length);
            std::vector<DWRITE_SHAPING_GLYPH_PROPERTIES> glyph_properties(capacity);
            DWRITE_FONT_FEATURE kern{DWRITE_FONT_FEATURE_TAG_KERNING, context.font_kerning == Rml::Style::FontKerning::None ? 0u : 1u};
            const DWRITE_TYPOGRAPHIC_FEATURES features{&kern, 1};
            const DWRITE_TYPOGRAPHIC_FEATURES* feature_pointer = &features;
            UINT32 actual = 0;
            check(analyzer->GetGlyphs(wide->data() + start, length, face.source->face.Get(), FALSE, rtl,
                &analysis.scripts[start], analysis.locale.c_str(), nullptr, &feature_pointer, &length, 1, capacity,
                clusters.data(), text_properties.data(), mapped.data(), glyph_properties.data(), &actual), "OpenType glyph mapping");
            std::vector<FLOAT> advances(actual); std::vector<DWRITE_GLYPH_OFFSET> offsets(actual);
            check(analyzer->GetGlyphPlacements(wide->data() + start, clusters.data(), text_properties.data(), length,
                mapped.data(), glyph_properties.data(), actual, face.source->face.Get(), static_cast<float>(face.metrics.size),
                FALSE, rtl, &analysis.scripts[start], analysis.locale.c_str(), &feature_pointer, &length, 1,
                advances.data(), offsets.data()), "OpenType glyph placement");
            for (UINT32 ordered = 0; ordered < actual; ++ordered) {
                const UINT32 i = rtl ? actual - ordered - 1 : ordered;
                glyphs.push_back(mapped[i]); positions.push_back({width + offsets[i].advanceOffset, -offsets[i].ascenderOffset});
                width += advances[i] + context.letter_spacing;
            }
            start = end;
        }
        return width;
    }
public:
    explicit Win32UiFontEngine(Rml::FontEngineInterface& fallback) : fallback(fallback) {
        check(DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED, __uuidof(IDWriteFactory), reinterpret_cast<IUnknown**>(factory.GetAddressOf())), "factory initialization");
        check(factory->CreateTextAnalyzer(&analyzer), "text analyzer initialization");
    }
    void Shutdown() override { faces.clear(); sources.clear(); fallback.Shutdown(); }
    bool LoadFontFace(const Rml::String& path, int index, bool is_fallback, Rml::Style::FontWeight weight) override { return fallback.LoadFontFace(path, index, is_fallback, weight); }
    bool LoadFontFace(Rml::Span<const Rml::byte> data, int index, const Rml::String& family, Rml::Style::FontStyle style, Rml::Style::FontWeight weight, bool is_fallback) override { return fallback.LoadFontFace(data, index, family, style, weight, is_fallback); }
    bool LoadFontFace(const Rml::String& path, int index, const Rml::String& family, Rml::Style::FontStyle style, Rml::Style::FontWeight weight, bool is_fallback) override {
        if (!fallback.LoadFontFace(path, index, family, style, weight, is_fallback)) return false;
        const auto wide = utf8_to_wide(path);
        if (!wide) throw std::runtime_error("DirectWrite font path is not UTF-8.");
        ComPtr<IDWriteFontFile> file;
        check(factory->CreateFontFileReference(wide->c_str(), nullptr, &file), "font file reference");
        BOOL supported; DWRITE_FONT_FILE_TYPE file_type; DWRITE_FONT_FACE_TYPE face_type; UINT32 count;
        check(file->Analyze(&supported, &file_type, &face_type, &count), "font file analysis");
        if (!supported || index < 0 || static_cast<UINT32>(index) >= count) throw std::runtime_error("DirectWrite cannot represent the registered font face.");
        auto source = std::make_unique<SourceFace>(); source->family = lower(family); source->style = style; source->weight = weight;
        auto* raw = file.Get();
        check(factory->CreateFontFace(face_type, 1, &raw, static_cast<UINT32>(index), DWRITE_FONT_SIMULATIONS_NONE, &source->face), "font face creation");
        ComPtr<IDWriteFontFace2> color;
        source->color = SUCCEEDED(source->face.As(&color)) && color->IsColorFont();
        sources.push_back(std::move(source));
        return true;
    }
    Rml::FontFaceHandle GetFontFaceHandle(const Rml::String& family, Rml::Style::FontStyle style, Rml::Style::FontWeight weight, int size) override {
        const auto handle = fallback.GetFontFaceHandle(family, style, weight, size);
        if (!handle || faces.contains(handle)) return handle;
        SourceFace* source = nullptr;
        for (auto& candidate : sources) if (candidate->family == lower(family) && candidate->style == style &&
            (!source || std::abs(static_cast<int>(candidate->weight) - static_cast<int>(weight)) < std::abs(static_cast<int>(source->weight) - static_cast<int>(weight)))) source = candidate.get();
        if (!source || source->color) return handle;
        DWRITE_FONT_METRICS original; source->face->GetMetrics(&original);
        const float scale = static_cast<float>(size) / original.designUnitsPerEm;
        auto metrics = fallback.GetFontMetrics(handle);
        metrics.ascent = std::round(original.ascent * scale); metrics.descent = std::round(original.descent * scale);
        metrics.line_spacing = metrics.ascent + metrics.descent + std::round(original.lineGap * scale);
        metrics.x_height = original.xHeight * scale;
        faces.emplace(handle, Face{source, metrics, rendering_mode(source->face.Get(), size), {}});
        return handle;
    }
    Rml::FontEffectsHandle PrepareFontEffects(Rml::FontFaceHandle handle, const Rml::FontEffectList& effects) override { return fallback.PrepareFontEffects(handle, effects); }
    const Rml::FontMetrics& GetFontMetrics(Rml::FontFaceHandle handle) override { const auto found = faces.find(handle); return found == faces.end() ? fallback.GetFontMetrics(handle) : found->second.metrics; }
    int GetStringWidth(Rml::FontFaceHandle handle, Rml::StringView text, const Rml::TextShapingContext& context, Rml::Character prior) override {
        const auto found = faces.find(handle); std::vector<UINT16> mapped;
        if (found == faces.end() || prior != Rml::Character::Null || !indices(found->second, text, mapped)) return fallback.GetStringWidth(handle, text, context, prior);
        std::vector<Rml::Vector2f> positions;
        return static_cast<int>(std::lround(std::max(shape(found->second, text, context, mapped, positions), 0.f)));
    }
    int GenerateString(Rml::RenderManager& manager, Rml::FontFaceHandle handle, Rml::FontEffectsHandle effects, Rml::StringView text, Rml::Vector2f position,
        Rml::ColourbPremultiplied color, float opacity, const Rml::TextShapingContext& context, Rml::TexturedMeshList& meshes) override {
        const auto found = faces.find(handle); std::vector<UINT16> mapped;
        if (found == faces.end() || effects || !indices(found->second, text, mapped)) {
            Rml::TexturedMeshList retained;
            const int width = fallback.GenerateString(manager, handle, effects, text, position, color, opacity, context, retained);
            for (auto& mesh : retained) meshes.push_back(std::move(mesh));
            return width;
        }
        auto& face = found->second; std::vector<Rml::Vector2f> positions;
        const float width = shape(face, text, context, mapped, positions);
        std::map<Glyph*, std::size_t> groups;
        for (std::size_t i = 0; i < mapped.size(); ++i) {
            const float x = position.x + positions[i].x;
            const int packed = static_cast<int>(std::floor(x * 4 + .5f)), whole = static_cast<int>(std::floor(packed / 4.f)), quarter = packed - whole * 4;
            auto& raster = glyph(face, mapped[i], quarter, color.alpha ? static_cast<unsigned>(color.green) * 255 / color.alpha : 0);
            if (!raster.texture) continue;
            auto group = groups.find(&raster);
            if (group == groups.end()) { const auto index = meshes.size(); meshes.emplace_back(); meshes.back().texture = raster.texture->GetTexture(manager); group = groups.emplace(&raster, index).first; }
            Rml::MeshUtilities::GenerateQuad(meshes[group->second].mesh, Rml::Vector2f(static_cast<float>(whole), std::round(position.y + positions[i].y)) + raster.origin,
                raster.dimensions, color, {0,0}, {1,1});
        }
        return static_cast<int>(std::lround(std::max(width, 0.f)));
    }
    int GetVersion(Rml::FontFaceHandle handle) override { return fallback.GetVersion(handle); }
    void ReleaseFontResources() override { faces.clear(); fallback.ReleaseFontResources(); }
private:
    Rml::FontEngineInterface& fallback;
    ComPtr<IDWriteFactory> factory;
    ComPtr<IDWriteTextAnalyzer> analyzer;
    std::vector<std::unique_ptr<SourceFace>> sources;
    std::map<Rml::FontFaceHandle, Face> faces;
};
} // namespace bbl::pal
#endif
