#include <bblite/pal_system_fonts.hpp>
#include <RmlUi/Core.h>
#include <RmlUi/Core/FontFaceCache.h>
#include <RmlUi/Core/FontGlyph.h>
#include "pal_ui_font_system.hpp"
#include "pal_ui_font_win32.hpp"
#include <ft2build.h>
#include FT_FREETYPE_H
#include <cassert>
#include <cmath>
#include <limits>
#include <map>
#include <memory>
#include <vector>

namespace {
struct Recorder final : Rml::RenderInterface {
    std::map<Rml::TextureHandle, std::vector<Rml::byte>> textures;
    std::size_t next = 1;
    Rml::TextureHandle drawn = 0;
    Rml::CompiledGeometryHandle CompileGeometry(Rml::Span<const Rml::Vertex>,
                                                Rml::Span<const int>) override {
        return next++;
    }
    void RenderGeometry(Rml::CompiledGeometryHandle, Rml::Vector2f,
                        Rml::TextureHandle texture) override {
        drawn = texture;
    }
    void ReleaseGeometry(Rml::CompiledGeometryHandle) override {}
    Rml::TextureHandle LoadTexture(Rml::Vector2i&, const Rml::String&) override { return 0; }
    Rml::TextureHandle GenerateTexture(Rml::Span<const Rml::byte> bytes, Rml::Vector2i) override {
        const auto id = next++;
        textures.emplace(id, std::vector<Rml::byte>(bytes.begin(), bytes.end()));
        return id;
    }
    void ReleaseTexture(Rml::TextureHandle id) override { assert(textures.erase(id) == 1); }
    void EnableScissorRegion(bool) override {}
    void SetScissorRegion(Rml::Rectanglei) override {}
};

void check_cache() {
    Rml::FontFaceCache<int, int, 4> cache;
    const auto request = [&](int key) {
        return cache.Get(key, [=] { return std::make_shared<int>(key); });
    };
    auto held = request(1);
    const std::weak_ptr<int> evicted = request(2);
    for (int i = 3; i < 100; ++i)
        request(i);
    assert(evicted.expired());
    assert(request(1) == held);
    // A live handle keeps its identity after leaving the hot set.
    for (int i = 100; i < 200; ++i)
        request(i);
    assert(request(1) == held);
    cache.Clear([](int& value) { value = -1; });
    assert(*held == -1 && request(1) != held);

    Rml::FontGlyph copy;
    std::weak_ptr<Rml::byte[]> bitmap;
    {
        Rml::FontGlyph glyph;
        glyph.bitmap_owned_data.reset(new Rml::byte[1]{123});
        glyph.bitmap_data = glyph.bitmap_owned_data.get();
        bitmap = glyph.bitmap_owned_data;
        copy = glyph;
    }
    assert(!bitmap.expired() && copy.bitmap_data[0] == 123);
    copy = {};
    assert(bitmap.expired());
}

void check_engine(bool windows) {
    Recorder recorder;
    Rml::SystemInterface system;
    Rml::SetSystemInterface(&system);
    Rml::SetRenderInterface(&recorder);
    assert(Rml::Initialise());
    auto* freetype = Rml::GetFontEngineInterface();
    auto* renderer = freetype;
#if defined(_WIN32)
    std::unique_ptr<bbl::pal::Win32UiFontEngine> platform;
    if (windows) {
        platform = std::make_unique<bbl::pal::Win32UiFontEngine>(*renderer);
        renderer = platform.get();
    }
#endif
    bbl::pal::SystemUiFontEngine engine(*renderer, "fixture");
    Rml::SetFontEngineInterface(&engine);
    const auto font = bbl::pal::find_system_font(
#if defined(_WIN32)
        "Segoe UI",
#elif defined(__APPLE__)
        "Helvetica",
#else
        "sans-serif",
#endif
        400);
    assert(font);
    assert(engine.LoadFontFace(font->path.string(), font->face_index, "fixture",
                               Rml::Style::FontStyle::Normal, Rml::Style::FontWeight::Normal,
                               false));
    const auto fallback_font = bbl::pal::find_system_font(
#if defined(_WIN32)
        "Segoe UI Symbol",
#elif defined(__APPLE__)
        "Apple Symbols",
#else
        "Noto Sans Symbols 2",
#endif
        400);
    assert(fallback_font);
    assert(engine.LoadFontFace(fallback_font->path.string(), fallback_font->face_index, "symbols",
                               Rml::Style::FontStyle::Normal, Rml::Style::FontWeight::Normal,
                               true));
    FT_Library coverage_library = nullptr;
    FT_Face primary_face = nullptr, symbol_face = nullptr;
    assert(FT_Init_FreeType(&coverage_library) == 0);
    assert(FT_New_Face(coverage_library, font->path.string().c_str(), font->face_index,
                       &primary_face) == 0);
    assert(FT_New_Face(coverage_library, fallback_font->path.string().c_str(),
                       fallback_font->face_index, &symbol_face) == 0);
    FT_UInt glyph_index = 0;
    FT_ULong missing_point = FT_Get_First_Char(symbol_face, &glyph_index);
    while (glyph_index &&
           (missing_point < 0x2000 || FT_Get_Char_Index(primary_face, missing_point)))
        missing_point = FT_Get_Next_Char(symbol_face, missing_point, &glyph_index);
    assert(glyph_index);
    const auto symbol = Rml::StringUtilities::ToUTF8(static_cast<Rml::Character>(missing_point));
    FT_Done_Face(symbol_face);
    FT_Done_Face(primary_face);
    FT_Done_FreeType(coverage_library);
    const auto request = [&](float size) {
        return renderer->GetFontFaceHandle("fixture", Rml::Style::FontStyle::Normal,
                                           Rml::Style::FontWeight::Normal, size);
    };
    assert(!request(0) && !request(-1) && !request(std::numeric_limits<float>::quiet_NaN()) &&
           !request(std::numeric_limits<float>::infinity()));
    auto fractional = request(11.52f);
    const auto integral = request(11.f);
    assert(fractional && integral && fractional != integral && request(11.52f) == fractional);
    assert(renderer->GetFontMetrics(fractional).size == 11.52f);
    const Rml::String language = "en";
    const Rml::TextShapingContext shaping{language};
    const Rml::String text(16, 'W');
    const auto width = [&](Rml::FontFaceHandle handle) {
        return renderer->GetStringWidth(handle, text, shaping, Rml::Character::Null);
    };
    const float fractional_width = width(fractional);
    const auto measure = [&](Rml::StringView value) {
        return renderer->GetStringWidth(fractional, value, shaping, Rml::Character::Null);
    };
    std::weak_ptr<void> fallback_sized;
    {
        auto symbols = freetype->GetFontFaceHandle("symbols", Rml::Style::FontStyle::Normal,
                                                   Rml::Style::FontWeight::Normal, 11.52f);
        fallback_sized = symbols;
        const float symbol_width =
            freetype->GetStringWidth(symbols, symbol, shaping, Rml::Character::Null);
        assert(symbol_width > 0 && std::abs(measure(symbol) - symbol_width) < .001f);
        assert(std::abs(measure("A" + symbol + "B") -
                        (measure("A") + symbol_width + measure("B"))) < .001f);
    }
    assert(fractional_width > width(integral));
    assert(request(.5f) && renderer->GetFontMetrics(request(.5f)).size == .5f);
    assert(width(request(.5f)) < width(request(1.f)));
    if (!windows) {
        // Independent FreeType metrics at the requested 26.6 size, with no CSS integer cast.
        FT_Library library = nullptr;
        FT_Face face = nullptr;
        assert(FT_Init_FreeType(&library) == 0);
        assert(FT_New_Face(library, font->path.string().c_str(), font->face_index, &face) == 0);
        assert(FT_Set_Char_Size(face, 0, static_cast<FT_F26Dot6>(std::lround(11.52 * 64)), 0, 0) ==
               0);
        assert(FT_Load_Char(face, 'W', FT_LOAD_COLOR) == 0);
        assert(std::abs(fractional_width - 16.0 * face->glyph->linearHoriAdvance / 65536.0) < .001);
        FT_Done_Face(face);
        FT_Done_FreeType(library);
    }
    auto* layout = Rml::CreateContext("fractional", {640, 240});
    assert(layout);
    auto* document = layout->CreateDocument();
    document->SetAttribute("style", "font-family:fixture;font-size:11.52px;");
    document->SetInnerRML("<div id='parent'><span id='child'>WWWW</span></div>");
    document->Show();
    layout->Update();
    auto* parent = document->GetElementById("parent");
    auto* child = document->GetElementById("child");
    assert(renderer->GetFontMetrics(child->GetFontFaceHandle()).size == 11.52f);
    auto* text_element = rmlui_dynamic_cast<Rml::ElementText*>(child->GetChild(0));
    assert(text_element);
    Rml::String words = "i";
    for (int i = 0; i < 31; ++i)
        words += " i";
    text_element->SetText(words);
    const float exact_width =
        renderer->GetStringWidth(fractional, words, shaping, Rml::Character::Null);
    Rml::String line;
    int length = 0;
    float line_width = 0;
    text_element->GenerateLine(line, length, line_width, 0, exact_width + .1f, 0, true, true,
                               false);
    assert(line == words && std::abs(line_width - exact_width) < .1f);
    auto detached = parent->RemoveChild(child);
    const auto detached_face = detached->GetFontFaceHandle();

    const auto pixels = [&](Rml::FontFaceHandle handle, const Rml::String& value) {
        Rml::TexturedMeshList meshes;
        assert(renderer->GenerateString(layout->GetRenderManager(), handle, {}, value, {0, 30},
                                        Rml::Colourb{255, 255, 255}.ToPremultiplied(), 1, shaping,
                                        meshes) > 0);
        assert(!meshes.empty());
        auto geometry = layout->GetRenderManager().MakeGeometry(std::move(meshes[0].mesh));
        geometry.Render({}, meshes[0].texture);
        return recorder.textures.at(recorder.drawn);
    };
    const auto fallback_pixels = pixels(fractional, symbol);
    const auto original_pixels = pixels(fractional, "W");
    assert(original_pixels != pixels(integral, "W"));
    std::vector<std::weak_ptr<void>> old_sizes;
    for (int i = 0; i < 128; ++i) {
        auto face = request(12.f + float(i) / 128.f);
        old_sizes.emplace_back(face);
        pixels(face, symbol);
        parent->SetProperty("font-size", std::to_string(12.f + float(i) / 128.f) + "px");
        layout->Update();
    }
    std::size_t live = 0;
    for (const auto& face : old_sizes)
        live += !face.expired();
    assert(live <= 32);
    assert(fallback_sized.expired());
    assert(pixels(fractional, symbol) == fallback_pixels);
    assert(width(fractional) == fractional_width && pixels(fractional, "W") == original_pixels);
    assert(detached->GetFontFaceHandle() == detached_face);
    parent->AppendChild(std::move(detached));
    parent->SetProperty("font-size", "11.25px");
    layout->Update();
    assert(renderer->GetFontMetrics(child->GetFontFaceHandle()).size == 11.25f);
    parent->SetProperty("font-size", "11.52dp");
    layout->SetDensityIndependentPixelRatio(1.25f);
    layout->Update();
    assert(std::abs(renderer->GetFontMetrics(child->GetFontFaceHandle()).size - 14.4f) < .0001f);
    parent->SetProperty("font-size", "0px");
    layout->Update();
    assert(!child->GetFontFaceHandle());
    Rml::ReleaseFontResources();
    assert(recorder.textures.empty());
    assert(request(11.52f) != fractional);
    Rml::Shutdown();
    assert(recorder.textures.empty());
}
} // namespace

int main() {
    check_cache();
    check_engine(false);
#if defined(_WIN32)
    check_engine(true);
#endif
}
