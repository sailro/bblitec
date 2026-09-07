#include <bblite/pal_system_fonts.hpp>
#include <RmlUi/Core.h>
#include <RmlUi/Core/FontEngineInterface.h>
#include <RmlUi/Core/TextShapingContext.h>
#include <RmlUi/Core/Factory.h>
#include <RmlUi/Core/ElementScroll.h>
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
    double elapsed = 0;
    double GetElapsedTime() override { return elapsed; }
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
    document->SetStyleSheetContainer(Rml::Factory::InstanceStyleSheetString(
        ".centered{position:absolute;left:50%;top:0;width:200px;height:40px;transform:translateX(-50%);transition:transform 0.05s;}"
        ".centered:active{transform:translateX(-50%) translateY(1px);}"
    ));
    document->SetInnerRML("<div id='control' class='centered'>Short</div><div id='sibling' class='centered'>Sibling</div>");
    auto* control = document->GetElementById("control");
    auto* sibling = document->GetElementById("sibling");
    const auto update = [&] { layout->Update(); layout->Render(); };
    const auto centered = [&](Rml::Element& element) {
        const auto offset = element.GetAbsoluteOffset(Rml::BoxArea::Border);
        const auto size = element.GetBox().GetSize(Rml::BoxArea::Border);
        Rml::Vector2f center{400.0f, offset.y + size.y * 0.5f};
        assert(element.Project(center));
        assert(std::abs(center.x - (offset.x + size.x * 0.5f)) < 0.01f);
    };
    update();
    centered(*control);
    control->SetPseudoClass("active", true);
    system.elapsed = 0.01;
    update();
    system.elapsed = 0.1;
    update();
    control->SetPseudoClass("active", false);
    system.elapsed = 0.11;
    update();
    system.elapsed = 0.2;
    update();
    // A transition must not mutate the shared authored percentage into the
    // old pixel width, either on this element or another selector match.
    control->SetProperty("width", "300px");
    sibling->SetProperty("width", "400px");
    update();
    centered(*control);
    centered(*sibling);

    // A centered column starts scrolling on a short/high-density viewport.
    // An unstyled RmlUi vertical scrollbar consumes the entire panel width.
    document->SetAttribute("style", "width:100%;height:100%;font-family:fixture;font-size:16dp;pointer-events:none;");
    document->SetStyleSheetContainer(Rml::Factory::InstanceStyleSheetString(
        std::string(bbl::pal::ui_user_agent_css) +
        ".menu{position:absolute;top:0;left:0;width:100%;height:100%;display:flex;align-items:center;justify-content:center;}"
        ".menu-panel{width:420dp;max-width:92vw;max-height:92vh;overflow:auto;display:flex;flex-direction:column;align-items:center;padding:34dp 30dp;}"
        ".menu-title{font-size:32dp;line-height:1.05;text-align:center;margin:0 0 10dp;}"
        ".menu-buttons{width:100%;display:flex;flex-direction:column;gap:10dp;}"
        ".menu-item{height:48dp;flex-shrink:0;}"
        ".menu-credit{height:180dp;flex-shrink:0;}"
    ));
    document->SetInnerRML(
        "<div class='menu'><div class='menu-panel' id='menu-panel'>"
        "<h1 class='menu-title' id='menu-title'>ANTIGRAVITY<div>RACER</div></h1>"
        "<div class='menu-buttons' id='menu-buttons'>"
        "<div class='menu-item'>Race (1 Player)</div><div class='menu-item'>Split-Screen (2 Players)</div>"
        "<div class='menu-item'>Test Track</div><div class='menu-item'>Attract Mode</div>"
        "<div class='menu-item' id='last-item'>Track Editor</div></div>"
        "<div class='menu-credit'>Credits</div></div></div>");
    auto* panel = document->GetElementById("menu-panel");
    auto* buttons = document->GetElementById("menu-buttons");
    auto* menu_title = document->GetElementById("menu-title");
    struct Viewport { int width, height; float density; bool overflow; };
    for (const auto view : {
        Viewport{2560, 1440, 1.f, false}, Viewport{1280, 720, 1.f, false},
        Viewport{1280, 720, 2.f, true}, Viewport{3840, 2300, 2.f, false},
        Viewport{1280, 720, 2.f, true}, Viewport{640, 360, 1.f, true},
        Viewport{2560, 1440, 1.f, false},
    }) {
        layout->SetDimensions({view.width, view.height});
        layout->SetDensityIndependentPixelRatio(view.density);
        update();
        auto* scroll = panel->GetElementScroll();
        const float scrollbar = scroll->GetScrollbarSize(Rml::ElementScroll::VERTICAL);
        const float content_width = buttons->GetBox().GetSize().x / view.density;
        std::cout << "scrollbar layout: " << view.width << 'x' << view.height
                  << " density=" << view.density << " scrollbar=" << scrollbar
                  << " content-width=" << content_width << std::endl;
        assert(content_width >= 400.f && content_width <= 420.f);
        assert(menu_title->GetBox().GetSize().y / view.density < 80.f);
        assert(scroll->GetScrollbarSize(Rml::ElementScroll::HORIZONTAL) == 0.f);
        assert(view.overflow ? (scrollbar > 0.f && scrollbar / view.density <= 20.f) : scrollbar == 0.f);
        if (view.overflow) {
            auto* vertical = scroll->GetScrollbar(Rml::ElementScroll::VERTICAL);
            Rml::Element* thumb = nullptr;
            for (int i = 0; i < vertical->GetNumChildren(true); ++i) {
                if (vertical->GetChild(i)->GetTagName() == "sliderbar") thumb = vertical->GetChild(i);
            }
            assert(thumb);
            const auto thumb_size = thumb->GetBox().GetSize();
            assert(thumb_size.x > 0.f && thumb_size.x <= scrollbar && thumb_size.y > 0.f);
            assert(thumb->GetComputedValues().background_color().alpha > 0);
            layout->SetDefaultScrollBehavior(Rml::ScrollBehavior::Instant, 1.f);
            const auto position = thumb->GetAbsoluteOffset(Rml::BoxArea::Content) + thumb_size * 0.5f;
            layout->ProcessMouseMove(int(position.x), int(position.y), 0);
            layout->ProcessMouseWheel(2.f, 0);
            update();
            assert(panel->GetScrollTop() > 0.f);
            panel->SetScrollTop(0.f);
            update();
            layout->ProcessMouseMove(int(position.x), int(position.y), 0);
            layout->ProcessMouseButtonDown(0, 0);
            layout->ProcessMouseMove(int(position.x), int(position.y + 40.f * view.density), 0);
            layout->ProcessMouseButtonUp(0, 0);
            update();
            assert(panel->GetScrollTop() > 0.f);
            panel->SetScrollTop(panel->GetScrollHeight());
            update();
            auto* last = document->GetElementById("last-item");
            const float last_bottom = last->GetAbsoluteOffset(Rml::BoxArea::Border).y + last->GetBox().GetSize().y;
            assert(last_bottom <= panel->GetAbsoluteOffset(Rml::BoxArea::Padding).y + panel->GetClientHeight());
            panel->SetScrollTop(0.f);
        }
    }

    // Both axes reserve space, then release it when overflow disappears.
    document->SetInnerRML("<div id='scroll-box' style='width:200dp;height:100dp;overflow:auto;'>"
        "<div id='scroll-content' style='width:400dp;height:300dp;'></div></div>");
    for (const float density : {1.f, 2.f}) {
        layout->SetDensityIndependentPixelRatio(density);
        update();
        auto* box = document->GetElementById("scroll-box");
        auto* scroll = box->GetElementScroll();
        for (const auto axis : {Rml::ElementScroll::VERTICAL, Rml::ElementScroll::HORIZONTAL}) {
            const float size = scroll->GetScrollbarSize(axis) / density;
            assert(size > 0.f && size <= 20.f);
        }
        assert(box->GetClientWidth() / density >= 180.f);
        assert(box->GetClientHeight() / density >= 80.f);
    }
    auto* content = document->GetElementById("scroll-content");
    content->SetProperty("width", "100dp");
    content->SetProperty("height", "40dp");
    update();
    auto* scroll = document->GetElementById("scroll-box")->GetElementScroll();
    assert(scroll->GetScrollbarSize(Rml::ElementScroll::VERTICAL) == 0.f);
    assert(scroll->GetScrollbarSize(Rml::ElementScroll::HORIZONTAL) == 0.f);
    Rml::Shutdown();
    std::cout << "ui-font-spacing-check: ok\n";
}
