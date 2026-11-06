#include "pal_ui_rml.cpp"
#include <cassert>

namespace bbl::pal {
std::string asset_path(std::string_view) { throw std::runtime_error("Unexpected asset read"); }
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
} // namespace bbl::pal

int main() {
    using namespace bbl;
    assert(SDL_Init(SDL_INIT_VIDEO));
    auto* window = SDL_CreateWindow("Fractional text layout", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        Engine engine;
        const auto panel = ui_create_element(engine, "div");
        ui_set_attribute(engine, panel, "style",
                         "position:absolute;min-width:180px;--bbl-intrinsic-min-width:180px;");
        ui_append_to_root(engine, panel);
        const auto make_button = [&](const char* width) {
            const auto handle = ui_create_element(engine, "button");
            ui_set_attribute(
                engine, handle, "style",
                std::string(
                    "font-family:system-ui;font-size:11.52px;padding:0;border:0;white-space:nowrap;width:") +
                    width + ";");
            ui_set_text(engine, handle, "WWWWWWWWWWWWWWWWWWWW");
            return handle;
        };
        const auto percent = make_button("100%");
        ui_append_child(engine, panel, percent);
        // A rule's width under the element's own auto width: the intrinsic pass keeps the auto.
        const auto sheet = ui_create_element(engine, "style");
        ui_add_class_style(engine, sheet, "sized", "width:300px;");
        ui_append_child(engine, ui_document_root(engine, UiDocumentPart::Head), sheet);
        const auto shrunk = ui_create_element(engine, "div");
        ui_set_attribute(engine, shrunk, "class", "sized");
        ui_set_attribute(engine, shrunk, "style",
                         "position:absolute;top:200px;width:auto;min-width:20px;"
                         "--bbl-intrinsic-min-width:20px;");
        ui_append_to_root(engine, shrunk);
        const auto shrunk_child = make_button("100%");
        ui_append_child(engine, shrunk, shrunk_child);
        const auto automatic = make_button("auto");
        ui_set_style_property(engine, automatic, "position", "absolute");
        ui_set_style_property(engine, automatic, "top", "100px");
        ui_append_to_root(engine, automatic);
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        const auto width = [&](UiElementHandle handle) {
            return runtime.projected_elements.at(handle.value)
                .element->GetBox()
                .GetSize(Rml::BoxArea::Border)
                .x;
        };
        for (const char* size : {"11.52px", "12.8px", "15.2px"}) {
            ui_set_style_property(engine, percent, "font-size", size);
            ui_set_style_property(engine, automatic, "font-size", size);
            pal::update_ui_rml_runtime(runtime, 640, 480);
            // Leave less than one pixel around the independently measured text.
            // The old integer-size compensation incorrectly expands this box.
            const float minimum = std::ceil(width(automatic));
            const auto minimum_css = std::to_string(minimum) + "px";
            ui_set_attribute(engine, panel, "style",
                             "position:absolute;min-width:" + minimum_css +
                                 ";--bbl-intrinsic-min-width:" + minimum_css + ";");
            pal::update_ui_rml_runtime(runtime, 640, 480);
            assert(runtime.projected_elements.at(panel.value).intrinsic_width.applied);
            // The percentage child contributes its actual max-content width.
            // Fractional sizing needs no additional scale compensation.
            assert(std::abs(width(panel) - minimum) < .01f);
            assert(std::abs(width(percent) - width(panel)) < 1.f);
            assert(runtime.projected_elements.at(shrunk.value).intrinsic_width.applied);
            assert(width(shrunk) < 300.f && std::abs(width(shrunk) - width(shrunk_child)) < 1.f);
        }
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
}
