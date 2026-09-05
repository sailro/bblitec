#include <bblite/pal_system_fonts.hpp>
#include <RmlUi/Core.h>
#include <RmlUi/Core/FontEngineInterface.h>
#include <RmlUi/Core/TextShapingContext.h>
#include <RmlUi/Core/Factory.h>
#include "pal_ui_defaults.hpp"
#include "pal_ui_text.hpp"
#include <cassert>
#include <cmath>
#include <iostream>

struct Recorder final : Rml::RenderInterface {
    Rml::CompiledGeometryHandle CompileGeometry(Rml::Span<const Rml::Vertex>, Rml::Span<const int>) override { return 1; }
    void RenderGeometry(Rml::CompiledGeometryHandle, Rml::Vector2f, Rml::TextureHandle) override {}
    void ReleaseGeometry(Rml::CompiledGeometryHandle) override {}
    Rml::TextureHandle LoadTexture(Rml::Vector2i&, const Rml::String&) override { return 0; }
    Rml::TextureHandle GenerateTexture(Rml::Span<const Rml::byte>, Rml::Vector2i) override { return 1; }
    void ReleaseTexture(Rml::TextureHandle) override {}
    void EnableScissorRegion(bool) override {}
    void SetScissorRegion(Rml::Rectanglei) override {}
};

struct System final : Rml::SystemInterface {
    bool LogMessage(Rml::Log::Type, const Rml::String& message) override {
        std::cerr << message << '\n';
        return false;
    }
};

int main() {
    // RGB and alpha must use the same rounding after CSS opacity. A white
    // channel may never exceed its alpha, including at the half-byte edge.
    for (int alpha = 0; alpha <= 255; ++alpha) {
        const Rml::Colourb white(255, 255, 255, static_cast<Rml::byte>(alpha));
        for (const float opacity : {0.0f, 0.001f, 0.002f, 0.25f, 0.5f, 0.75f, 1.0f}) {
            const auto color = white.ToPremultiplied(opacity);
            const auto expected = static_cast<Rml::byte>(alpha * opacity + 0.5f);
            assert(color.alpha == expected);
            assert(color.red == color.alpha && color.green == color.alpha && color.blue == color.alpha);
        }
    }
    const std::string arrow = "\xE2\x96\xB6";
    const std::string pause = "\xE2\x8F\xB8";
    const std::string controller = "\xF0\x9F\x8E\xAE";
    const std::string vs15 = "\xEF\xB8\x8E";
    const std::string vs16 = "\xEF\xB8\x8F";
    const std::string open = "<span style=\"font-family:bbl-emoji;line-height:0;\">";
    using bbl::pal::ui_normalize_emoji_presentation;
    using bbl::pal::ui_text_needs_emoji_normalization;
    assert(!ui_text_needs_emoji_normalization("Speed < 100 & laps > 2"));
    assert(!ui_text_needs_emoji_normalization(arrow + pause));
    assert(ui_text_needs_emoji_normalization(controller));
    assert(ui_text_needs_emoji_normalization(arrow + vs16));
    assert(ui_text_needs_emoji_normalization(controller + vs15));
    assert(ui_text_needs_emoji_normalization("#" + vs16));
    assert(ui_normalize_emoji_presentation("plain ASCII") == "plain ASCII");
    assert(ui_normalize_emoji_presentation("#" + vs16) == open + "#</span>");
    assert(ui_normalize_emoji_presentation(arrow + pause) == arrow + pause);
    assert(ui_normalize_emoji_presentation(controller) == open + controller + "</span>");
    assert(ui_normalize_emoji_presentation(arrow + vs16) == open + arrow + "</span>");
    assert(ui_normalize_emoji_presentation(controller + vs15) == controller);
    const std::string attributed = "<span title=\"a > " + controller + vs16 + "\">";
    assert(ui_normalize_emoji_presentation(attributed + controller + "</span>") ==
        attributed + open + controller + "</span></span>");
    assert(ui_normalize_emoji_presentation(attributed + "text</span>") ==
        attributed + "text</span>");
    assert(ui_normalize_emoji_presentation("before " + controller + " between " + arrow + vs16 + " after") ==
        "before " + open + controller + "</span> between " + open + arrow + "</span> after");
    Recorder recorder;
    System system;
    Rml::SetSystemInterface(&system);
    Rml::SetRenderInterface(&recorder);
    assert(Rml::Initialise());
    const auto font = bbl::pal::find_system_font("Segoe UI", 400);
    assert(font);
    assert(Rml::LoadFontFace(font->path.string(), "fixture", Rml::Style::FontStyle::Normal,
        Rml::Style::FontWeight::Normal, false, font->face_index));
    auto* engine = Rml::GetFontEngineInterface();
    auto face = engine->GetFontFaceHandle("fixture", Rml::Style::FontStyle::Normal, Rml::Style::FontWeight::Normal, 16);
    const Rml::String language = "en";
    Rml::TextShapingContext context{language};
    const int baseline = engine->GetStringWidth(face, "1111111111111111", context);
    for (const float spacing : {0.25f, -0.25f, 2.5f}) {
        context.letter_spacing = spacing;
        assert(engine->GetStringWidth(face, "1111111111111111", context) == baseline + int(16 * spacing));
    }
    const auto bold = bbl::pal::find_system_font("Segoe UI", 700);
    assert(bold);
    assert(Rml::LoadFontFace(bold->path.string(), "fixture", Rml::Style::FontStyle::Normal,
        Rml::Style::FontWeight::Bold, false, bold->face_index));
    auto* layout = Rml::CreateContext("heading-defaults", {800, 600});
    assert(layout);
    auto* document = layout->CreateDocument();
    document->SetAttribute("style", "width:800px;height:600px;font-family:fixture;font-size:16px;line-height:1.32;");
    document->SetStyleSheetContainer(Rml::Factory::InstanceStyleSheetString(
        std::string(bbl::pal::ui_user_agent_css) +
        ".panel{width:340px;padding:28px;}"
        ".panel h2{margin:0 0 18px;font-size:20px;letter-spacing:0.15em;}"
        ".items{height:40px;}"
        ".custom{display:inline;font-weight:400;font-size:12px;margin:0;}"));
    document->SetInnerRML("<div class='panel'><h2 id='title'>PAUSED</h2><div class='items' id='items'></div></div>"
        "<h1 id='default-title'>Heading</h1><h2 class='custom' id='override'>Inline</h2>");
    document->Show();
    layout->Update();
    auto* title = document->GetElementById("title");
    auto* items = document->GetElementById("items");
    assert(title && items);
    assert(title->GetComputedValues().display() == Rml::Style::Display::Block);
    assert(title->GetComputedValues().font_weight() == Rml::Style::FontWeight::Bold);
    const float gap = items->GetAbsoluteOffset(Rml::BoxArea::Border).y -
        title->GetAbsoluteOffset(Rml::BoxArea::Border).y - title->GetBox().GetSize(Rml::BoxArea::Border).y;
    assert(std::abs(gap - 18.0f) < 0.01f);
    const auto& heading = document->GetElementById("default-title")->GetComputedValues();
    assert(heading.display() == Rml::Style::Display::Block);
    assert(heading.font_weight() == Rml::Style::FontWeight::Bold && heading.font_size() == 32.0f);
    const auto& overridden = document->GetElementById("override")->GetComputedValues();
    assert(overridden.display() == Rml::Style::Display::Inline);
    assert(overridden.font_weight() == Rml::Style::FontWeight::Normal && overridden.font_size() == 12.0f);
    Rml::Shutdown();
    std::cout << "ui-font-spacing-check: ok\n";
}
