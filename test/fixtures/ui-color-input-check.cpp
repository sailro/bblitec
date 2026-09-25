#include "pal_ui_rml.cpp"
#include <cassert>
#include <fstream>

namespace bbl::pal {
std::string asset_path(std::string_view) {
    throw std::runtime_error("Unexpected fixture asset read");
}
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
} // namespace bbl::pal

int main() {
    using namespace bbl;
    assert(SDL_Init(SDL_INIT_VIDEO));
    SDL_Window* window = SDL_CreateWindow("UI color fixture", 1280, 720, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        Engine engine;
        int clicks = 0;
        bool prevent_activation = true;
        on_dom_pointer(engine, DomEventTarget::document(), "click", 1,
                       [&](const PlatformMouseEvent& event) {
                           ++clicks;
                           if (prevent_activation)
                               event.prevent_default();
                       });
        const auto input = ui_create_element(engine, "input");
        ui_set_attribute(engine, input, "type", "color");
        assert(ui_get_form_value(engine, input) == "#000000");
        ui_set_form_value(engine, input, "invalid");
        assert(ui_get_form_value(engine, input) == "#000000");
        ui_set_form_value(engine, input, "#27AE60");
        assert(ui_get_form_value(engine, input) == "#27ae60");
        ui_set_attribute(engine, input, "style", "position:absolute;left:20px;top:20px;");
        ui_append_to_root(engine, input);
        std::string events;
        for (const char* name : {"input", "change"})
            ui_on_event(engine, input, name, [&, name](const PlatformMouseEvent&) {
                events += std::string(name) + ":" + ui_get_form_value(engine, input) + ";";
            });
        pal::UiRmlRuntime runtime(engine, window, 1280, 720);
        pal::update_ui_rml_runtime(runtime, 1280, 720);
        auto* raw =
            dynamic_cast<pal::UiColorInput*>(runtime.projected_elements.at(input.value).element);
        assert(raw && raw->GetValue() == "#27ae60" && events.empty());
        assert(raw->GetProperty<Rml::Colourb>("background-color") == Rml::Colourb(239, 239, 239));
        const auto swatch_vertices = [&](Rml::Colourb color) {
            const auto& frame = pal::record_ui_rml_frame(runtime, 1280, 720);
            std::vector<pal::UiRenderVertex> selected;
            for (const auto& vertex : frame.vertices)
                if (vertex.red == color.red && vertex.green == color.green &&
                    vertex.blue == color.blue && vertex.alpha == 255)
                    selected.push_back(vertex);
            return selected;
        };
        auto swatch = swatch_vertices({39, 174, 96});
        assert(swatch.size() == 4);
        const auto content = raw->GetAbsoluteOffset(Rml::BoxArea::Content);
        const auto content_size = raw->GetBox().GetSize(Rml::BoxArea::Content);
        const float density = runtime.context->GetDensityIndependentPixelRatio();
        float left = swatch.front().x, top = swatch.front().y, right = left, bottom = top;
        for (const auto& vertex : swatch) {
            left = std::min(left, vertex.x);
            top = std::min(top, vertex.y);
            right = std::max(right, vertex.x);
            bottom = std::max(bottom, vertex.y);
        }
        assert(left == content.x + 3 * density && top == content.y + 5 * density);
        assert(right == content.x + content_size.x - 3 * density &&
               bottom == content.y + content_size.y - 5 * density);
        runtime.context->ProcessMouseMove(35, 30, 0);
        runtime.context->ProcessMouseButtonDown(0, 0);
        runtime.context->ProcessMouseButtonUp(0, 0);
        assert(!runtime.color_popup && clicks == 1);
        prevent_activation = false;
        runtime.context->ProcessMouseButtonDown(0, 0);
        runtime.context->ProcessMouseButtonUp(0, 0);
        assert(runtime.color_popup && !runtime.color_popup->closed());
        assert(clicks == 2);
        pal::update_ui_rml_runtime(runtime, 1280, 720);
        // The picker is a separate document. Its button and editable text
        // must retain dark ink even when the source control inherits white.
        for (const char* id : {"apply", "cancel", "hex"}) {
            auto* control = runtime.color_popup->element()->GetElementById(id);
            assert(control->GetComputedValues().color() == Rml::Colourb(17, 17, 17));
            assert(control->GetFontFaceHandle());
            assert(control->GetBox().GetEdge(Rml::BoxArea::Border, Rml::BoxEdge::Left) == 1);
            if (std::string_view(id) != "hex") {
                auto* text = control->GetChild(0);
                assert(text && text->GetComputedValues().color() == Rml::Colourb(17, 17, 17));
            }
        }
        {
            const auto& frame = pal::record_ui_rml_frame(runtime, 1280, 720);
            for (const char* id : {"apply", "cancel"}) {
                auto* control = runtime.color_popup->element()->GetElementById(id);
                const auto position = control->GetAbsoluteOffset(Rml::BoxArea::Border);
                const auto size = control->GetBox().GetSize(Rml::BoxArea::Border);
                bool has_ink = false;
                for (const auto& draw : frame.draws) {
                    if (!draw.texture_id)
                        continue;
                    for (std::uint32_t index = draw.first_index;
                         index < draw.first_index + draw.index_count; ++index) {
                        const auto& vertex = frame.vertices.at(frame.indices.at(index));
                        has_ink |= vertex.red == 17 && vertex.green == 17 && vertex.blue == 17 &&
                                   vertex.alpha == 255 && vertex.x > position.x &&
                                   vertex.x < position.x + size.x && vertex.y > position.y &&
                                   vertex.y < position.y + size.y;
                    }
                }
                assert(has_ink);
            }
        }
        const auto click_popup = [&](const char* id) {
            pal::update_ui_rml_runtime(runtime, 1280, 720);
            auto* target = runtime.color_popup->element()->GetElementById(id);
            const auto center = target->GetAbsoluteOffset(Rml::BoxArea::Border) +
                                target->GetBox().GetSize(Rml::BoxArea::Border) * .5f;
            runtime.context->ProcessMouseMove(static_cast<int>(center.x),
                                              static_cast<int>(center.y), 0);
            runtime.context->ProcessMouseButtonDown(0, 0);
            runtime.context->ProcessMouseButtonUp(0, 0);
        };
        {
            std::ofstream positions("artifacts/ui-color-input/control-rects.json");
            positions << "{\"viewport\":[1280,720],\"controls\":{";
            bool first = true;
            for (const char* id : {"hex", "apply", "cancel", "red", "green", "blue"}) {
                auto* target = runtime.color_popup->element()->GetElementById(id);
                const auto position = target->GetAbsoluteOffset(Rml::BoxArea::Border);
                const auto size = target->GetBox().GetSize(Rml::BoxArea::Border);
                if (!first)
                    positions << ',';
                first = false;
                positions << '\"' << id << "\":[" << position.x << ',' << position.y << ','
                          << size.x << ',' << size.y << ']';
            }
            positions << "}}";
        }
        const auto change = [&](const char* id, const char* value) {
            auto* control = rmlui_dynamic_cast<Rml::ElementFormControl*>(
                runtime.color_popup->element()->GetElementById(id));
            assert(control);
            control->SetValue(value);
            control->DispatchEvent("change", {});
        };
        change("red", "255");
        assert(ui_get_form_value(engine, input) == "#ffae60");
        assert(events == "input:#ffae60;");
        change("hex", "#123XYZ");
        assert(ui_get_form_value(engine, input) == "#ffae60");
        click_popup("apply");
        assert(!runtime.color_popup->closed());
        change("hex", "#123ABC");
        assert(events == "input:#ffae60;input:#123abc;");
        click_popup("apply");
        assert(runtime.color_popup->closed());
        assert(events == "input:#ffae60;input:#123abc;change:#123abc;");
        pal::update_ui_rml_runtime(runtime, 1280, 720);
        const auto accepted_events = events;
        ui_set_form_value(engine, input, "#ABCDEF");
        pal::update_ui_rml_runtime(runtime, 1280, 720);
        assert(raw->GetValue() == "#abcdef" && events == accepted_events);
        assert(swatch_vertices({171, 205, 239}).size() == 4);
        assert(raw->GetProperty<Rml::Colourb>("background-color") == Rml::Colourb(239, 239, 239));
        raw->Click();
        assert(!runtime.color_popup->closed());
        change("hex", "#000000");
        click_popup("cancel");
        assert(runtime.color_popup->closed() && ui_get_form_value(engine, input) == "#abcdef");
        assert(events == accepted_events + "input:#000000;input:#abcdef;");
        pal::update_ui_rml_runtime(runtime, 1280, 720);
        ui_set_boolean_attribute(engine, input, "disabled", true);
        pal::update_ui_rml_runtime(runtime, 1280, 720);
        raw->Click();
        assert(runtime.color_popup->closed());
        ui_set_boolean_attribute(engine, input, "disabled", false);
        pal::update_ui_rml_runtime(runtime, 1280, 720);
        raw->Click();
        assert(!runtime.color_popup->closed());
        ui_remove(engine, input);
        pal::update_ui_rml_runtime(runtime, 1280, 720);
        assert(runtime.color_popup->closed());
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
}
