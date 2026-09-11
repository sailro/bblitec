#include "pal_ui_rml.cpp"
#include <RmlUi/Core/ElementScroll.h>
#include <cassert>

namespace bbl::pal {
std::string asset_path(std::string_view) { throw std::runtime_error("Unexpected fixture asset read"); }
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
}

std::string text_content(Rml::Element& element) {
    if (auto* text = dynamic_cast<Rml::ElementText*>(&element)) return text->GetText();
    std::string result;
    for (int i = 0; i < element.GetNumChildren(); ++i) result += text_content(*element.GetChild(i));
    return result;
}

int main() {
    using namespace bbl;
    SDL_SetAssertionHandler([](const SDL_AssertData* data, void*) {
        std::cerr << "SDL assertion: " << data->condition << " at " << data->filename << ':' << data->linenum << '\n';
        return SDL_ASSERTION_ABORT;
    }, nullptr);
    assert(SDL_Init(SDL_INIT_VIDEO));
    SDL_Window* window = SDL_CreateWindow("UI markup fixture", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        Engine engine;
        const auto detached = ui_create_element(engine, "div");
        const auto root = ui_create_element(engine, "div");
        const auto child = ui_create_element(engine, "span");
        ui_set_attribute(engine, detached, "id", "target");
        ui_set_attribute(engine, child, "id", "target");
        assert(!ui_find_element_by_id(engine, "target"));
        ui_append_child(engine, root, child);
        ui_append_to_root(engine, root);
        assert(ui_find_element_by_id(engine, "target")->value == child.value);
        ui_append_to_root(engine, detached);
        assert(ui_find_element_by_id(engine, "target")->value == child.value);
        ui_append_to_root(engine, root);
        assert(ui_find_element_by_id(engine, "target")->value == detached.value);
        ui_remove(engine, detached);
        assert(ui_find_element_by_id(engine, "target")->value == child.value);
        ui_remove(engine, root);
        assert(!ui_find_element_by_id(engine, "target") && !ui_find_element_by_id(engine, ""));
        const auto markup = ui_create_element(engine, "div");
        ui_set_inner_rml(engine, markup, "<span>a&rsquo;b&mdash;c</span>");
        ui_append_to_root(engine, markup);
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        auto* projected = runtime.projected_elements.at(markup.value).element;
        assert(projected);
        assert(text_content(*projected) == "a\xE2\x80\x99" "b\xE2\x80\x94" "c");
        ui_set_inner_rml(engine, markup, "<span>&ldquo;new&rdquo;&nbsp;&copy;&hellip;</span>");
        pal::update_ui_rml_runtime(runtime, 640, 480);
        assert(runtime.projected_elements.at(markup.value).element == projected);
        assert(text_content(*projected) == "\xE2\x80\x9Cnew\xE2\x80\x9D\xC2\xA0\xC2\xA9\xE2\x80\xA6");
        ui_set_text(engine, markup, "literal &rsquo; <span> &mdash;");
        pal::update_ui_rml_runtime(runtime, 640, 480);
        assert(text_content(*projected) == "literal &rsquo; <span> &mdash;");
        const std::string emoji_text = "literal &rsquo; <span> &mdash; \xF0\x9F\x8E\xAE";
        ui_set_text(engine, markup, emoji_text);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        assert(text_content(*projected) == emoji_text);
    }
    {
        Engine engine;
        const auto sheet = ui_create_element(engine, "style");
        ui_add_class_style(engine, sheet, "history", "scrollbar-width:thin;");
        ui_add_style_rule(engine, sheet, UiStyleSelectorKind::Class, "history", {}, {}, false, -1,
            "width:12px;height:10px;", UiScrollbarPart::Scrollbar);
        ui_add_style_rule(engine, sheet, UiStyleSelectorKind::Class, "history", {}, {}, false, -1,
            "background-color:#abcdef;", UiScrollbarPart::Thumb);
        ui_add_style_rule(engine, sheet, UiStyleSelectorKind::Class, "history", {}, {}, true, -1,
            "background-color:#fedcba;", UiScrollbarPart::Thumb);
        ui_append_to_root(engine, sheet);
        const auto root = ui_create_element(engine, "div");
        ui_set_attribute(engine, root, "style", "scrollbar-color:rgb(33, 66, 99) transparent;");
        const auto panel = ui_create_element(engine, "div");
        ui_set_attribute(engine, panel, "class", "history");
        ui_set_attribute(engine, panel, "style", "width:160px;height:100px;overflow:auto;");
        ui_set_inner_rml(engine, panel,
            "<div style='width:300px;height:260px;'>"
            "<div id='nested' style='width:60px;height:60px;overflow:auto;'>"
            "<div style='width:180px;height:180px;'></div></div></div>");
        ui_append_child(engine, root, panel);
        ui_append_to_root(engine, root);
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        auto* owner = runtime.projected_elements.at(panel.value).element;
        auto* nested = runtime.document->GetElementById("nested");
        const auto scrollbar = [](Rml::Element* element, Rml::ElementScroll::Orientation axis) {
            return element->GetElementScroll()->GetScrollbar(axis);
        };
        const auto thumb = [&](Rml::Element* element) {
            auto* bar = scrollbar(element, Rml::ElementScroll::VERTICAL);
            for (int i = 0; i < bar->GetNumChildren(true); ++i) {
                if (bar->GetChild(i)->GetTagName() == "sliderbar") return bar->GetChild(i);
            }
            return static_cast<Rml::Element*>(nullptr);
        };
        const auto expect_size = [](Rml::Element* element, float vertical, float horizontal) {
            assert(std::abs(element->GetElementScroll()->GetScrollbarSize(Rml::ElementScroll::VERTICAL) - vertical) < .01f);
            assert(std::abs(element->GetElementScroll()->GetScrollbarSize(Rml::ElementScroll::HORIZONTAL) - horizontal) < .01f);
        };
        expect_size(owner, 8, 8);
        expect_size(nested, 16, 16); // Width does not inherit; colors do.
        assert(thumb(owner)->GetComputedValues().background_color() == Rml::Colourb(33, 66, 99));
        assert(thumb(nested)->GetComputedValues().background_color() == Rml::Colourb(33, 66, 99));
        assert(std::abs(owner->GetClientWidth() - 152) < .01f);
        ui_set_style_property(engine, panel, "scrollbar-width", "none");
        pal::update_ui_rml_runtime(runtime, 640, 480);
        expect_size(owner, 0, 0);
        owner->SetScrollTop(50);
        assert(owner->GetScrollTop() == 50);
        assert(std::abs(owner->GetClientWidth() - 160) < .01f);
        ui_set_style_property(engine, panel, "scrollbar-width", "auto");
        ui_set_style_property(engine, panel, "scrollbar-color", "auto");
        pal::update_ui_rml_runtime(runtime, 640, 480);
        expect_size(owner, 12, 10);
        expect_size(nested, 16, 16); // Vendor rules cannot leak into a descendant.
        assert(thumb(owner)->GetComputedValues().background_color() == Rml::Colourb(0xab, 0xcd, 0xef));
        thumb(owner)->SetPseudoClass("hover", true);
        runtime.context->Update();
        assert(thumb(owner)->GetComputedValues().background_color() == Rml::Colourb(0xfe, 0xdc, 0xba));
        ui_remove(engine, sheet);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        expect_size(owner, 16, 16);
    }
    {
        Engine engine;
        const auto box = ui_create_element(engine, "div");
        ui_set_attribute(engine, box, "style",
            "position:absolute;left:250px;top:10px;width:40px;height:40px;"
            "border:6px transparent;padding:4px;background-color:#f01234;");
        ui_append_to_root(engine, box);
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        auto* element = runtime.projected_elements.at(box.value).element;
        for (const auto& [clip, area] : std::array{
                 std::pair{"border-box", Rml::BoxArea::Border},
                 std::pair{"padding-box", Rml::BoxArea::Padding},
                 std::pair{"content-box", Rml::BoxArea::Content},
                 std::pair{"border-box", Rml::BoxArea::Border}}) {
            ui_set_style_property(engine, box, "background-clip", clip);
            pal::update_ui_rml_runtime(runtime, 640, 480);
            const auto& frame = pal::record_ui_rml_frame(runtime, 640, 480);
            float min_x = 1e6f, max_x = -1e6f;
            for (const auto& vertex : frame.vertices) {
                if (vertex.red == 0xf0 && vertex.green == 0x12 && vertex.blue == 0x34 && vertex.alpha == 255) {
                    min_x = std::min(min_x, vertex.x); max_x = std::max(max_x, vertex.x);
                }
            }
            const auto offset = element->GetAbsoluteOffset(area);
            const auto size = element->GetBox().GetSize(area);
            assert(std::abs(min_x - offset.x) < .01f);
            assert(std::abs(max_x - offset.x - size.x) < .01f);
        }
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
}
