#include "pal_ui_rml.cpp"

namespace bbl::pal {
std::string asset_path(std::string_view) {
    throw std::runtime_error("Unexpected fixture asset read");
}
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
} // namespace bbl::pal

int main() try {
    using namespace bbl;
    const auto check = [](bool pass, const char* message) {
        if (!pass)
            throw std::runtime_error(message);
    };
    const auto expectNear = [&](float actual, float expected, const char* message) {
        if (std::abs(actual - expected) > 0.1f) {
            std::fprintf(stderr, "%s: %.3f != %.3f\n", message, actual, expected);
            check(false, message);
        }
    };
    check(SDL_Init(SDL_INIT_VIDEO), "SDL initialization");
    auto* window = SDL_CreateWindow("Range parts fixture", 640, 480, SDL_WINDOW_HIDDEN);
    check(window != nullptr, "Window creation");
    {
        Engine engine;
        const auto sheet = ui_create_element(engine, "style");
        ui_append_to_root(engine, sheet);
        const auto rule = [&](std::string owner, UiRangePart part, std::string style,
                              bool hover = false) {
            ui_add_style_rule(engine, sheet, UiStyleSelectorKind::Class, std::move(owner), {}, {},
                              hover, -1, std::move(style), UiScrollbarPart::None, false, false,
                              UiMotionPreference::Any, {}, UiGeneratedPart::None, std::nullopt,
                              part);
        };
        rule(
            "level", UiRangePart::Thumb,
            "appearance:none;width:18px;height:18px;margin-top:-4px;background-color:red;border-radius:4px;");
        rule("level", UiRangePart::Thumb, "background-color:green;", true);
        rule("track", UiRangePart::Track,
             "height:10px;background-color:#888888;border-radius:5px;");
        const auto add = [&](const char* classes, int top) {
            auto control = ui_create_element(engine, "input");
            ui_set_attribute(engine, control, "type", "range");
            ui_set_attribute(engine, control, "class", classes);
            ui_set_attribute(engine, control, "value", "50");
            ui_set_attribute(
                engine, control, "style",
                "position:absolute;left:20px;top:" + std::to_string(top) +
                    "px;width:120px;height:10px;margin:0;appearance:none;background-color:#888888;");
            ui_append_to_root(engine, control);
            return control;
        };
        const auto first = add("level", 20), second = add("level track", 60),
                   plain = add("plain", 100);
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        const auto update = [&] { pal::update_ui_rml_runtime(runtime, 640, 480); };
        update();
        const auto raw = [&](UiElementHandle handle) {
            return runtime.projected_elements.at(handle.value).element;
        };
        const auto part = [&](UiElementHandle handle, const char* tag) {
            auto* parent = raw(handle);
            for (int index = 0; index < parent->GetNumChildren(true); ++index)
                if (parent->GetChild(index)->GetTagName() == tag)
                    return parent->GetChild(index);
            throw std::runtime_error("Missing control part");
        };
        auto* thumb = part(first, "sliderbar");
        expectNear(thumb->GetBox().GetSize(Rml::BoxArea::Border).x, 18,
                   "author thumb width overrides user-agent defaults");
        expectNear(thumb->GetAbsoluteOffset().x, 71, "midpoint uses the authored thumb width");
        expectNear(thumb->GetAbsoluteOffset().y, 14,
                   "auto track takes the thumb margin-box height");
        expectNear(part(second, "sliderbar")->GetAbsoluteOffset().y, 56,
                   "explicit track preserves its own centered height");
        expectNear(part(plain, "sliderbar")->GetBox().GetSize().x, 16,
                   "unmatched thumb retains default width");
        check(thumb->GetProperty(Rml::PropertyId::BackgroundColor)->Get<Rml::Colourb>().red == 255,
              "authored thumb paints");
        const auto& frame = pal::record_ui_rml_frame(runtime, 640, 480);
        std::size_t painted_themes = 0;
        for (const auto& texture : frame.textures)
            if (texture.width == 120 && texture.height == 10 && texture.rgba) {
                bool painted = false;
                for (std::size_t index = 3; index < texture.rgba->size(); index += 4)
                    painted = painted || texture.rgba->at(index) != 0;
                painted_themes += painted;
            }
        check(painted_themes == 1, "only the unmatched native thumb emits theme pixels");
        runtime.context->ProcessMouseMove(78, 22, 0);
        update();
        check(thumb->GetProperty(Rml::PropertyId::BackgroundColor)->Get<Rml::Colourb>().green ==
                  128,
              "thumb hover participates in live cascade");
        check(raw(first)->Focus(), "custom range can focus");
        auto* control = rmlui_dynamic_cast<Rml::ElementFormControl*>(raw(first));
        check(control != nullptr, "range control");
        runtime.context->ProcessKeyDown(Rml::Input::KI_RIGHT, 0);
        runtime.context->ProcessKeyUp(Rml::Input::KI_RIGHT, 0);
        update();
        check(std::stof(control->GetValue()) == 51, "custom range keyboard increments");
        ui_set_attribute(engine, first, "value", "100");
        update();
        expectNear(thumb->GetAbsoluteOffset().x, 122,
                   "maximum value uses the current thumb bounds");
        rule("level", UiRangePart::Thumb, "width:24px;height:20px;margin-top:0;");
        update();
        expectNear(thumb->GetBox().GetSize().x, 24, "stylesheet change reformats the thumb");
        expectNear(thumb->GetAbsoluteOffset().x, 116, "resized maximum endpoint");
        ui_set_attribute(engine, first, "disabled", "");
        update();
        runtime.context->ProcessKeyDown(Rml::Input::KI_LEFT, 0);
        runtime.context->ProcessKeyUp(Rml::Input::KI_LEFT, 0);
        update();
        check(std::stof(control->GetValue()) == 100, "disabled custom range preserves value");
        ui_remove(engine, sheet);
        update();
        expectNear(thumb->GetBox().GetSize().x, 16,
                   "sheet removal restores default thumb dimensions");
        check(thumb->GetProperty<int>("appearance") == 0,
              "sheet removal restores native thumb appearance");
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
} catch (const std::exception& error) {
    std::fprintf(stderr, "Range parts failure: %s\n", error.what());
    return 1;
}
