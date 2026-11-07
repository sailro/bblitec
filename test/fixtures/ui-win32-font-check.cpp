#include <bblite/pal_system_fonts.hpp>
#include <RmlUi/Core.h>
#include "pal_ui_font_win32.hpp"
#include <cassert>
#include <iostream>
#include <map>

struct Recorder final : Rml::RenderInterface {
    struct Texture {
        Rml::Vector2i size;
        std::vector<Rml::byte> bytes;
    };
    std::map<Rml::TextureHandle, Texture> textures;
    std::map<Rml::CompiledGeometryHandle, std::vector<Rml::Vertex>> geometry;
    std::vector<Rml::Vertex> drawn;
    std::size_t next = 1;
    Rml::CompiledGeometryHandle CompileGeometry(Rml::Span<const Rml::Vertex> vertices,
                                                Rml::Span<const int>) override {
        const auto handle = next++;
        geometry.emplace(handle, std::vector<Rml::Vertex>(vertices.begin(), vertices.end()));
        return handle;
    }
    void RenderGeometry(Rml::CompiledGeometryHandle handle, Rml::Vector2f translation,
                        Rml::TextureHandle) override {
        for (auto vertex : geometry.at(handle)) {
            vertex.position += translation;
            drawn.push_back(vertex);
        }
    }
    void ReleaseGeometry(Rml::CompiledGeometryHandle handle) override { geometry.erase(handle); }
    Rml::TextureHandle LoadTexture(Rml::Vector2i&, const Rml::String&) override { return 0; }
    Rml::TextureHandle GenerateTexture(Rml::Span<const Rml::byte> bytes,
                                       Rml::Vector2i size) override {
        const auto id = next++;
        textures.emplace(id, Texture{size, {bytes.begin(), bytes.end()}});
        return id;
    }
    void ReleaseTexture(Rml::TextureHandle id) override { assert(textures.erase(id) == 1); }
    void EnableScissorRegion(bool) override {}
    void SetScissorRegion(Rml::Rectanglei) override {}
};

int main() {
    assert(_putenv_s("BBLITE_CPU_PROFILE", "1") == 0);
    Recorder recorder;
    Rml::SystemInterface system;
    Rml::SetSystemInterface(&system);
    Rml::SetRenderInterface(&recorder);
    assert(Rml::Initialise());
    bbl::pal::Win32UiFontEngine engine(*Rml::GetFontEngineInterface());
    Rml::SetFontEngineInterface(&engine);
    for (const auto family : {"Consolas", "Segoe UI"}) {
        const auto font = bbl::pal::find_system_font(family, 400);
        assert(font);
        assert(engine.LoadFontFace(font->path.string(), font->face_index, family,
                                   Rml::Style::FontStyle::Normal, Rml::Style::FontWeight::Normal,
                                   false));
    }
    const auto consolas = engine.GetFontFaceHandle("consolas", Rml::Style::FontStyle::Normal,
                                                   Rml::Style::FontWeight::Normal, 13);
    const auto segoe = engine.GetFontFaceHandle("segoe ui", Rml::Style::FontStyle::Normal,
                                                Rml::Style::FontWeight::Normal, 13);
    assert(consolas && segoe);
    const auto& metrics = engine.GetFontMetrics(consolas);
    assert(metrics.ascent == 12 && metrics.descent == 3);
    const Rml::String language = "en-us";
    Rml::TextShapingContext context{language};
    const auto measured = [&](Rml::FontFaceHandle face, Rml::StringView value,
                              const Rml::TextShapingContext& shaping) {
        return engine.GetStringWidth(face, value, shaping, Rml::Character::Null);
    };
    engine.take_cpu_sample();
    const float cache_width = measured(segoe, "Cache", context);
    assert(engine.take_cpu_sample().shapes == 1);
    assert(measured(segoe, "Cache", context) == cache_width);
    auto sample = engine.take_cpu_sample();
    assert(sample.shapes == 0 && sample.mapping == 0 && sample.cache_hits == 1);
    assert(measured(consolas, "Cache", context) > 0);
    assert(engine.take_cpu_sample().shapes == 1); // Font source and size belong to the Face.
    context.letter_spacing = 1.25f;
    assert(measured(segoe, "Cache", context) > cache_width);
    assert(engine.take_cpu_sample().shapes == 1);
    context.letter_spacing = 0;
    context.text_direction = Rml::Style::Direction::Rtl;
    assert(measured(segoe, "Cache", context) == cache_width);
    assert(engine.take_cpu_sample().shapes == 1);
    context.text_direction = Rml::Style::Direction::Auto;
    {
        Rml::String temporary_language = "tr";
        const Rml::TextShapingContext localized{temporary_language};
        assert(measured(segoe, "Cache", localized) == cache_width);
        assert(engine.take_cpu_sample().shapes == 1);
        temporary_language = "ar";
        assert(measured(segoe, "Cache", localized) == cache_width);
        assert(engine.take_cpu_sample().shapes == 1);
    }
    const Rml::String turkish = "tr";
    assert(measured(segoe, "Cache", Rml::TextShapingContext{turkish}) == cache_width);
    sample = engine.take_cpu_sample();
    assert(sample.shapes == 0 && sample.cache_hits == 1); // Keys own language bytes.
    engine.GetStringWidth(segoe, "Cache", context, Rml::Character{'A'});
    sample = engine.take_cpu_sample();
    assert(sample.width_fallback == 0 && sample.shapes == 2);
    const Rml::String missing = "\xf4\x8f\xbf\xbf";
    engine.GetStringWidth(segoe, missing, context, Rml::Character::Null);
    engine.GetStringWidth(segoe, missing, context, Rml::Character::Null);
    sample = engine.take_cpu_sample();
    assert(sample.width_fallback == 2 && sample.cache_hits == 0 && sample.mapping == 2);

    // A finite hot set must evict old runs, and oversized runs must remain uncached.
    for (int index = 0; index < 260; ++index)
        engine.GetStringWidth(segoe, "Cache entry " + std::to_string(index), context,
                              Rml::Character::Null);
    assert(engine.take_cpu_sample().cache_evictions > 0);
    assert(measured(segoe, "Cache", context) == cache_width);
    assert(engine.take_cpu_sample().shapes == 1);
    const Rml::String oversized(15000, 'A');
    const auto oversized_width =
        engine.GetStringWidth(segoe, oversized, context, Rml::Character::Null);
    assert(engine.GetStringWidth(segoe, oversized, context, Rml::Character::Null) ==
           oversized_width);
    sample = engine.take_cpu_sample();
    assert(sample.shapes == 2 && sample.cache_oversized == 2 && sample.cache_hits == 0);
    const auto larger = engine.GetFontFaceHandle("segoe ui", Rml::Style::FontStyle::Normal,
                                                 Rml::Style::FontWeight::Normal, 14);
    assert(larger);
    for (int index = 0; index < 80; ++index)
        engine.GetStringWidth(larger, Rml::String(120, 'A') + std::to_string(index), context,
                              Rml::Character::Null);
    // Fewer than 256 entries still evict when owned strings/vectors exceed 64 KiB.
    assert(engine.take_cpu_sample().cache_evictions > 0);
    assert(std::abs(engine.GetStringWidth(consolas, "ABCDEFGHIJKLMNOPQRSTUVWXYZ", context,
                                          Rml::Character::Null) -
                    186) < .5f);
    // Browser widths: OpenType GPOS differs from the font's legacy kern table.
    assert(std::abs(engine.GetStringWidth(
                        segoe, "WeightWeightWeightWeightWeightWeightWeightWeightWeightWeight",
                        context, Rml::Character::Null) -
                    410) < .5f);
    assert(std::abs(engine.GetStringWidth(
                        segoe,
                        "OpacityOpacityOpacityOpacityOpacityOpacityOpacityOpacityOpacityOpacity",
                        context, Rml::Character::Null) -
                    439) < .5f);
    context.font_kerning = Rml::Style::FontKerning::None;
    assert(std::abs(engine.GetStringWidth(
                        segoe, "WeightWeightWeightWeightWeightWeightWeightWeightWeightWeight",
                        context, Rml::Character::Null) -
                    415) < .5f);
    context.font_kerning = Rml::Style::FontKerning::Auto;
    auto* layout = Rml::CreateContext("font-coverage", {320, 100});
    assert(layout);
    {
        // A missing emoji must not change the renderer of the surrounding text.
        const Rml::String tool = "\xf0\x9f\x9b\xa0";
        const auto color = Rml::Colourb{230, 237, 243}.ToPremultiplied();
        Rml::TexturedMeshList ordinary, mixed;
        const float a = engine.GenerateString(layout->GetRenderManager(), segoe, 0, "A", {0, 20},
                                              color, 1, context, ordinary);
        const float missing_width = measured(segoe, tool, context);
        const float b = measured(segoe, "B", context);
        engine.take_cpu_sample();
        const float width =
            engine.GenerateString(layout->GetRenderManager(), segoe, 0, "A" + tool + "B", {0, 20},
                                  color, 1, context, mixed);
        sample = engine.take_cpu_sample();
        assert(sample.generate_fallback == 1 && sample.cache_hits == 2);
        assert(std::abs(width - (a + missing_width + b)) < .001f);
        assert(std::abs(measured(segoe, "A" + tool + "B", context) - width) < .001f);
        assert(mixed.size() >= 3 && ordinary.size() == 1);
        assert(mixed[0].texture == ordinary[0].texture);
        for (std::size_t i = 0; i < 4; ++i)
            assert(mixed[0].mesh.vertices[i].position == ordinary[0].mesh.vertices[i].position);
        // A combining sequence follows its missing base into fallback as one unit.
        engine.take_cpu_sample();
        measured(segoe, "A" + missing + "\xcc\x81" + "B", context);
        sample = engine.take_cpu_sample();
        assert(sample.width_fallback == 1 && sample.cache_hits == 2);
    }
    {
        measured(consolas, "A", context);
        engine.take_cpu_sample();
        Rml::TexturedMeshList meshes;
        engine.GenerateString(layout->GetRenderManager(), consolas, 0, "A", {10, 20},
                              Rml::Colourb{230, 237, 243}.ToPremultiplied(), 1, context, meshes);
        assert(meshes.size() == 1 && meshes[0].mesh.vertices.size() == 4);
        sample = engine.take_cpu_sample();
        assert(sample.shapes == 0 && sample.cache_hits == 1); // Rendering reuses measured shaping.
        Rml::TexturedMeshList shifted;
        engine.GenerateString(layout->GetRenderManager(), consolas, 0, "A", {20, 25},
                              Rml::Colourb{230, 237, 243}.ToPremultiplied(), 1, context, shifted);
        assert(shifted.size() == 1);
        for (std::size_t vertex = 0; vertex < shifted[0].mesh.vertices.size(); ++vertex)
            assert(shifted[0].mesh.vertices[vertex].position ==
                   meshes[0].mesh.vertices[vertex].position + Rml::Vector2f(10, 5));
        assert(engine.take_cpu_sample().cache_hits == 1);
        Rml::TexturedMeshList recolored;
        const auto color = Rml::Colourb{80, 237, 243}.ToPremultiplied();
        engine.GenerateString(layout->GetRenderManager(), consolas, 0, "A", {10, 20}, color, 1,
                              context, recolored);
        assert(recolored.size() == 1 && recolored[0].mesh.vertices[0].colour == color);
        assert(recolored[0].mesh.vertices[0].position == meshes[0].mesh.vertices[0].position);
        assert(engine.take_cpu_sample().cache_hits == 1);
        auto geometry = layout->GetRenderManager().MakeGeometry(std::move(meshes[0].mesh));
        geometry.Render({}, meshes[0].texture);
        assert(recorder.textures.size() == 1);
        const auto& texture = recorder.textures.begin()->second;
        assert(texture.size == Rml::Vector2i(9, 8));
        // Chromium's DirectWrite bitmap strike, default grid-fit, A8 sRGB mask.
        const std::array<unsigned, 9> first_row{0, 0, 0, 156, 255, 188, 0, 0, 0};
        for (std::size_t x = 0; x < first_row.size(); ++x)
            for (unsigned channel = 0; channel < 4; ++channel)
                assert(texture.bytes[x * 4 + channel] == first_row[x]);
        const auto retained = meshes.size();
        engine.GenerateString(layout->GetRenderManager(), consolas, 0, "B", {10, 38.2f},
                              Rml::Colourb{230, 237, 243}.ToPremultiplied(), 1, context, meshes);
        assert(meshes.size() > retained); // Adding a line must preserve earlier line meshes.
    }
    {
        auto* document = layout->CreateDocument();
        document->SetAttribute("style", "font-family:segoe ui;font-size:13px;line-height:17px;");
        document->SetInnerRML("<div id='positioned' style='position:absolute;'>A</div>");
        document->Show();
        auto* positioned = document->GetElementById("positioned");
        auto* text = rmlui_dynamic_cast<Rml::ElementText*>(positioned->GetChild(0));
        assert(text);
        // Rasterization uses the final subpixel origin, including ancestor
        // movement. Rounding only the geometry's translation selects the
        // wrong glyph coverage and can shift it by a pixel.
        for (const auto position : {Rml::Vector2f{10.25f, 20.25f},
                                    {10.75f, 20.75f},
                                    {-0.25f, 20.25f},
                                    {11.75f, 21.75f}}) {
            positioned->SetProperty("left", std::to_string(position.x) + "px");
            positioned->SetProperty("top", std::to_string(position.y) + "px");
            layout->Update();
            recorder.drawn.clear();
            layout->Render();
            const auto origin = text->GetAbsoluteOffset() + text->GetLines().at(0).position;
            Rml::TexturedMeshList expected;
            engine.GenerateString(layout->GetRenderManager(), text->GetFontFaceHandle(), 0, "A",
                                  origin, text->GetComputedValues().color().ToPremultiplied(), 1,
                                  context, expected);
            assert(expected.size() == 1 && recorder.drawn.size() == 4);
            for (std::size_t index = 0; index < recorder.drawn.size(); ++index) {
                const auto actual = recorder.drawn[index].position;
                const auto wanted = expected[0].mesh.vertices[index].position;
                if (actual != wanted) {
                    std::cerr << "fractional text: " << actual.x << ',' << actual.y
                              << " != " << wanted.x << ',' << wanted.y << '\n';
                    throw std::runtime_error("Text raster phase excludes its absolute position");
                }
            }
        }
        for (const char* effect : {"shadow(2px 3px #000)", "glow(0px 4px 1px 2px #123456)"}) {
            assert(text->SetProperty("font-effect", effect));
            layout->Update();
            const auto* property = text->GetProperty(Rml::PropertyId::FontEffect);
            assert(property);
            const auto list = property->Get<Rml::FontEffectsPtr>();
            assert(list && list->list.size() == 1);
            const auto face = text->GetFontFaceHandle();
            const auto effects = engine.PrepareFontEffects(face, list->list);
            Rml::TexturedMeshList plain, decorated;
            const auto color = Rml::Colourb{230, 237, 243}.ToPremultiplied();
            const auto width = engine.GenerateString(layout->GetRenderManager(), face, 0, "AV",
                                                     {10.25f, 30.75f}, color, 1, context, plain);
            engine.take_cpu_sample();
            const auto decorated_width =
                engine.GenerateString(layout->GetRenderManager(), face, effects, "AV",
                                      {10.25f, 30.75f}, color, 1, context, decorated);
            assert(engine.take_cpu_sample().generate_fallback == 0);
            assert(width == decorated_width && decorated.size() > plain.size());
            if (!list->list.front()->HasUniqueTexture())
                assert(decorated.front().texture == plain.front().texture);
            // Applying a shadow must leave the foreground glyphs, shaping,
            // quarter-pixel coverage and advance unchanged.
            for (std::size_t index = 0; index < plain.size(); ++index) {
                const auto& front = decorated[decorated.size() - plain.size() + index];
                assert(front.texture == plain[index].texture);
                assert(front.mesh == plain[index].mesh);
            }
        }
    }
    Rml::RemoveContext("font-coverage");
    Rml::ReleaseFontResources();
    const auto reloaded = engine.GetFontFaceHandle("segoe ui", Rml::Style::FontStyle::Normal,
                                                   Rml::Style::FontWeight::Normal, 13);
    assert(reloaded);
    engine.take_cpu_sample();
    assert(measured(reloaded, "Cache", context) == cache_width);
    assert(engine.take_cpu_sample().shapes == 1); // Released handles retain no shaped runs.
    Rml::Shutdown();
    assert(recorder.textures.empty());
    std::cout << "ui-win32-font-check: ok\n";
}
