#include <bblite/pal_system_fonts.hpp>
#include <RmlUi/Core.h>
#include "pal_ui_font_win32.hpp"
#include <cassert>
#include <iostream>
#include <map>

struct Recorder final : Rml::RenderInterface {
    struct Texture { Rml::Vector2i size; std::vector<Rml::byte> bytes; };
    std::map<Rml::TextureHandle, Texture> textures;
    std::size_t next = 1;
    Rml::CompiledGeometryHandle CompileGeometry(Rml::Span<const Rml::Vertex>, Rml::Span<const int>) override { return next++; }
    void RenderGeometry(Rml::CompiledGeometryHandle, Rml::Vector2f, Rml::TextureHandle) override {}
    void ReleaseGeometry(Rml::CompiledGeometryHandle) override {}
    Rml::TextureHandle LoadTexture(Rml::Vector2i&, const Rml::String&) override { return 0; }
    Rml::TextureHandle GenerateTexture(Rml::Span<const Rml::byte> bytes, Rml::Vector2i size) override {
        const auto id = next++; textures.emplace(id, Texture{size, {bytes.begin(), bytes.end()}}); return id;
    }
    void ReleaseTexture(Rml::TextureHandle id) override { assert(textures.erase(id) == 1); }
    void EnableScissorRegion(bool) override {}
    void SetScissorRegion(Rml::Rectanglei) override {}
};

int main() {
    Recorder recorder;
    Rml::SystemInterface system;
    Rml::SetSystemInterface(&system);
    Rml::SetRenderInterface(&recorder);
    assert(Rml::Initialise());
    bbl::pal::Win32UiFontEngine engine(*Rml::GetFontEngineInterface());
    Rml::SetFontEngineInterface(&engine);
    for (const auto family : {"Consolas", "Segoe UI"}) {
        const auto font = bbl::pal::find_system_font(family, 400); assert(font);
        assert(engine.LoadFontFace(font->path.string(), font->face_index, family, Rml::Style::FontStyle::Normal, Rml::Style::FontWeight::Normal, false));
    }
    const auto consolas = engine.GetFontFaceHandle("consolas", Rml::Style::FontStyle::Normal, Rml::Style::FontWeight::Normal, 13);
    const auto segoe = engine.GetFontFaceHandle("segoe ui", Rml::Style::FontStyle::Normal, Rml::Style::FontWeight::Normal, 13);
    assert(consolas && segoe);
    const auto& metrics = engine.GetFontMetrics(consolas);
    assert(metrics.ascent == 12 && metrics.descent == 3);
    const Rml::String language = "en-us";
    Rml::TextShapingContext context{language};
    assert(engine.GetStringWidth(consolas, "ABCDEFGHIJKLMNOPQRSTUVWXYZ", context, Rml::Character::Null) == 186);
    // Browser widths: OpenType GPOS differs from the font's legacy kern table.
    assert(engine.GetStringWidth(segoe, "WeightWeightWeightWeightWeightWeightWeightWeightWeightWeight", context, Rml::Character::Null) == 410);
    assert(engine.GetStringWidth(segoe, "OpacityOpacityOpacityOpacityOpacityOpacityOpacityOpacityOpacityOpacity", context, Rml::Character::Null) == 439);
    context.font_kerning = Rml::Style::FontKerning::None;
    assert(engine.GetStringWidth(segoe, "WeightWeightWeightWeightWeightWeightWeightWeightWeightWeight", context, Rml::Character::Null) == 415);
    context.font_kerning = Rml::Style::FontKerning::Auto;
    auto* layout = Rml::CreateContext("font-coverage", {320, 100}); assert(layout);
    {
        Rml::TexturedMeshList meshes;
        engine.GenerateString(layout->GetRenderManager(), consolas, 0, "A", {10, 20}, Rml::Colourb{230,237,243}.ToPremultiplied(), 1, context, meshes);
        assert(meshes.size() == 1 && meshes[0].mesh.vertices.size() == 4);
        auto geometry = layout->GetRenderManager().MakeGeometry(std::move(meshes[0].mesh));
        geometry.Render({}, meshes[0].texture);
        assert(recorder.textures.size() == 1);
        const auto& texture = recorder.textures.begin()->second;
        assert(texture.size == Rml::Vector2i(9,8));
        // Chromium's DirectWrite bitmap strike, default grid-fit, A8 sRGB mask.
        const std::array<unsigned,9> first_row{0,0,0,156,255,188,0,0,0};
        for (std::size_t x = 0; x < first_row.size(); ++x)
            for (unsigned channel = 0; channel < 4; ++channel) assert(texture.bytes[x * 4 + channel] == first_row[x]);
        const auto retained = meshes.size();
        engine.GenerateString(layout->GetRenderManager(), consolas, 0, "B", {10, 38.2f}, Rml::Colourb{230,237,243}.ToPremultiplied(), 1, context, meshes);
        assert(meshes.size() > retained); // Adding a line must preserve earlier line meshes.
    }
    Rml::Shutdown();
    assert(recorder.textures.empty());
    std::cout << "ui-win32-font-check: ok\n";
}
