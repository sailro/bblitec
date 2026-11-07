#include "pal_ui_rml.cpp"
#include <cassert>
#undef assert
#define assert(condition)                                                                          \
    do {                                                                                           \
        if (!(condition))                                                                          \
            throw std::runtime_error(#condition);                                                  \
    } while (false)

namespace bbl {
std::string asset_path(const std::string&) {
    return "corpus/babylon-lite/lab/public/playroom/ui/kick.png";
}
} // namespace bbl
namespace bbl::pal {
std::string asset_path(std::string_view) {
    return "corpus/babylon-lite/lab/public/playroom/ui/kick.png";
}
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
} // namespace bbl::pal

int main() try {

    using namespace bbl;
    assert(SDL_Init(SDL_INIT_VIDEO));
    auto* window = SDL_CreateWindow("UI backgrounds", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        Engine engine;
        const auto parent = ui_create_element(engine, "div");
        ui_set_attribute(
            engine, parent, "style",
            "position:absolute;left:20px;top:20px;width:100px;height:80px;bbl-background-image:\"fixture.png\";bbl-background-size:0px 0px;bbl-background-repeat:no-repeat;bbl-background-position:center center;background-color:#123456;");
        ui_append_to_root(engine, parent);
        const auto child = ui_create_element(engine, "button");
        ui_set_attribute(
            engine, child, "style",
            "position:absolute;left:0px;top:0px;width:100px;height:80px;border-width:0px;padding:0px;bbl-background-image:inherit;bbl-background-size:contain;bbl-background-repeat:inherit;bbl-background-position:inherit;background-color:inherit;scale:0.5;bbl-transform:translate(10px, 20px);");
        ui_append_child(engine, parent, child);
        const auto unstyled = ui_create_element(engine, "span");
        ui_append_child(engine, parent, unstyled);
        const auto normal = ui_create_element(engine, "div");
        ui_set_attribute(
            engine, normal, "style",
            "width:20px;height:20px;transform:translateX(5px);decorator:linear-gradient(red, blue);background-color:#abcdef;");
        ui_append_to_root(engine, normal);
        const auto warning = ui_create_element(engine, "div");
        ui_set_attribute(
            engine, warning, "style",
            "position:absolute;left:50%;top:50%;padding:10px;background-color:black;--bbl-absolute-inline:1;");
        ui_set_attribute(engine, warning, "hidden", "");
        ui_append_to_root(engine, warning);
        // Each CSS-wide keyword on every PAL longhand, as sheets and a run-time shorthand write it.
        const auto keywords = ui_create_element(engine, "div");
        ui_set_attribute(
            engine, keywords, "style",
            "position:absolute;left:200px;top:20px;width:100px;height:80px;background-clip:padding-box;bbl-background-image:\"fixture.png\";bbl-background-size:contain;bbl-background-repeat:no-repeat;bbl-background-position:center center;background-color:#123456;");
        ui_append_to_root(engine, keywords);
        const auto keyword_child = [&](std::string_view keyword) {
            std::string style = "position:absolute;left:0px;top:0px;width:50px;height:40px;";
            for (const std::string_view longhand :
                 {"background-clip", "bbl-background-image", "bbl-background-size",
                  "bbl-background-position", "bbl-background-repeat", "bbl-background-origin",
                  "bbl-background-attachment", "background-color"})
                style += std::string(longhand) + ":" + std::string(keyword) + ";";
            const auto child = ui_create_element(engine, "div");
            ui_set_attribute(engine, child, "style", style);
            ui_append_child(engine, keywords, child);
            return child;
        };
        const auto inherits = keyword_child("inherit");
        const auto initial = keyword_child("initial");
        const auto unset = keyword_child("UNSET");
        const auto reverted = keyword_child("revert");
        const auto written = ui_create_element(engine, "div");
        ui_append_child(engine, keywords, written);
        // The declarations src/compiler/ui-projection.ts emitUiBackgroundShorthand emits.
        const auto write_background = [&](const std::string& shorthand) {
            for (const auto& [longhand, initial_value] :
                 {std::pair{"background-clip", "border-box"},
                  std::pair{"bbl-background-image", "none"},
                  std::pair{"bbl-background-size", "auto"},
                  std::pair{"bbl-background-position", "0% 0%"},
                  std::pair{"bbl-background-repeat", "repeat"},
                  std::pair{"bbl-background-origin", "padding-box"},
                  std::pair{"bbl-background-attachment", "scroll"}})
                ui_set_style_property(engine, written, longhand,
                                      ui_background_longhand(shorthand, initial_value));
            ui_set_background(engine, written, shorthand);
        };
        assert(ui_background_longhand(" Inherit ", "none") == " Inherit ");
        assert(ui_background_longhand("#123456", "none") == "none");
        write_background("inherit");

        pal::UiRmlRuntime runtime(engine, window, 640, 480);

        const auto update = [&] { pal::update_ui_rml_runtime(runtime, 640, 480); };
        auto* rawParent = runtime.projected_elements.at(parent.value).element;
        auto* rawChild = runtime.projected_elements.at(child.value).element;
        auto* rawNormal = runtime.projected_elements.at(normal.value).element;
        auto* rawUnstyled = runtime.projected_elements.at(unstyled.value).element;
        auto* rawWarning = runtime.projected_elements.at(warning.value).element;
        update();
        assert(rawWarning->GetProperty("display")->ToString() == "none");
        assert(rawParent->GetProperty("decorator")->ToString() == "none");
        assert(!rawUnstyled->GetLocalProperty("decorator"));
        assert(rawUnstyled->GetComputedValues().background_color().alpha == 0);
        assert(rawChild->GetProperty("decorator")->ToString().find("fixture.png") !=
               std::string::npos);
        assert(rawChild->GetComputedValues().background_color() == Rml::Colourb(0x12, 0x34, 0x56));
        const auto transform = rawChild->GetProperty<Rml::TransformPtr>("transform");
        assert(transform && transform->GetNumPrimitives() == 2);
        assert(transform->GetPrimitive(0).type == Rml::TransformPrimitive::SCALE2D);
        assert(transform->GetPrimitive(0).scale_2d.values[0] == 0.5f);
        assert(transform->GetPrimitive(1).type == Rml::TransformPrimitive::TRANSLATE2D);
        const auto normalTransform = rawNormal->GetProperty<Rml::TransformPtr>("transform");
        const auto normalDecorator = rawNormal->GetProperty("decorator")->ToString();
        assert(normalTransform && normalTransform->GetNumPrimitives() == 1);
        assert(normalDecorator.find("linear-gradient") != std::string::npos);
        const auto raw = [&](UiElementHandle element) {
            return runtime.projected_elements.at(element.value).element;
        };
        const auto clip = [](Rml::Element* element) {
            return element->GetProperty(Rml::PropertyId::BackgroundClip)->Get<int>();
        };
        const int padding_box = clip(raw(keywords));
        assert(padding_box != 0);
        for (auto* element : {raw(inherits), raw(written)}) {
            assert(element->GetComputedValues().background_color() ==
                   Rml::Colourb(0x12, 0x34, 0x56));
            assert(element->GetProperty("decorator")->ToString().find("fixture.png") !=
                   std::string::npos);
            assert(clip(element) == padding_box);
        }
        for (auto* element : {raw(initial), raw(unset), raw(reverted)}) {
            assert(element->GetComputedValues().background_color().alpha == 0);
            assert(!element->GetLocalProperty("decorator"));
            assert(clip(element) == 0);
        }
        const auto& frame = pal::record_ui_rml_frame(runtime, 640, 480);
        assert(std::any_of(frame.draws.begin(), frame.draws.end(),
                           [](const auto& draw) { return draw.texture_id != 0; }));
        // A colour after a keyword resets the clip.
        write_background("#abcdef");
        update();
        assert(raw(written)->GetComputedValues().background_color() ==
               Rml::Colourb(0xab, 0xcd, 0xef));
        assert(!raw(written)->GetLocalProperty("decorator"));
        assert(clip(raw(written)) == 0);
        ui_set_style_property(engine, parent, "background-color", "#abcdef");
        ui_set_style_property(engine, parent, "bbl-zero-clip", "1");
        update();
        assert(rawChild->GetComputedValues().background_color() == Rml::Colourb(0xab, 0xcd, 0xef));
        assert(rawParent->GetBox().GetSize().x == 100.f && rawParent->GetBox().GetSize().y == 80.f);
        assert(rawChild->IsVisible() && rawChild->Focus());
        assert(rawParent->GetComputedValues().group_opacity() == 0);
        assert(rawChild->GetComputedValues().group_opacity() == 0);
        assert(runtime.context->GetElementAtPoint({75, 65}) != rawChild);
        ui_set_style_property(engine, parent, "bbl-zero-clip", "0");
        ui_set_style_property(engine, child, "scale", "1");
        ui_set_style_property(engine, child, "bbl-transform", "none");
        ui_set_style_property(engine, child, "bbl-background-image", "none");
        update();
        assert(rawParent->GetComputedValues().group_opacity() == 1);
        assert(rawChild->GetComputedValues().group_opacity() == 1);
        assert(!rawChild->GetProperty<Rml::TransformPtr>("transform"));
        assert(rawNormal->GetProperty<Rml::TransformPtr>("transform") == normalTransform);
        assert(rawNormal->GetProperty("decorator")->ToString() == normalDecorator);
        assert(rawNormal->GetComputedValues().background_color() == Rml::Colourb(0xab, 0xcd, 0xef));
        ui_remove_attribute(engine, warning, "hidden");
        update();
        assert(rawWarning->GetProperty("display")->ToString() == "inline-block");
        ui_set_style_property(engine, warning, "display", "block");
        ui_set_attribute(engine, warning, "hidden", "");
        update();
        assert(rawWarning->GetProperty("display")->ToString() == "block");
        static_cast<void>(ui_remove_style_property(engine, warning, "display"));
        update();
        assert(rawWarning->GetProperty("display")->ToString() == "none");
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
} catch (const std::exception& error) {
    std::fprintf(stderr, "%s\n", error.what());
    return 1;
}
