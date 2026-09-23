#include "pal_ui_rml.cpp"
#include <cassert>

namespace bbl::pal {
std::string asset_path(std::string_view) {
    throw std::runtime_error("Unexpected fixture asset read");
}
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
} // namespace bbl::pal

int main() {
    using namespace bbl;
    using namespace bbl::pal;
    assert(SDL_Init(SDL_INIT_VIDEO));
    auto* window = SDL_CreateWindow("Text update fixture", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        Engine engine;
        const auto parent = ui_create_element(engine, "div");
        ui_set_attribute(engine, parent, "style", "font-size:16px;display:block;");
        ui_append_to_root(engine, parent);
        const auto leaf = [&](const char* style) {
            const auto handle = ui_create_element(engine, "span");
            ui_set_attribute(engine, handle, "style", style);
            ui_set_text(engine, handle, "Short");
            ui_append_child(engine, parent, handle);
            return handle;
        };
        const auto plain = leaf("display:inline-block;");
        const auto flex = leaf("display:flex;");
        const auto grid = leaf("display:grid;grid-template-columns:1fr;");
        const auto outlined = leaf("display:inline-block;--bbl-outline:1px solid red;");
        UiRmlRuntime runtime(engine, window, 640, 480);
        const auto update = [&] { update_ui_rml_runtime(runtime, 640, 480); };
        const auto raw = [&](UiElementHandle handle) {
            return runtime.projected_elements.at(handle.value).element;
        };
        const auto text = [&](UiElementHandle handle) {
            auto* element = raw(handle)->GetChild(0);
            if (runtime.projected_elements.at(handle.value).text_wrapped)
                element = element->GetChild(0);
            auto* result = dynamic_cast<Rml::ElementText*>(element);
            assert(result);
            return result;
        };
        update();
        auto* plain_text = text(plain);
        auto* flex_text = text(flex);
        auto* grid_text = text(grid);
        auto* flex_wrapper = raw(flex)->GetChild(0);
        auto* grid_wrapper = raw(grid)->GetChild(0);
        const auto initial_width = raw(plain)->GetBox().GetSize().x;
        ui_set_text(engine, plain, "A much longer plain label");
        ui_set_text(engine, flex, "Changed flex label");
        ui_set_text(engine, grid, "Changed grid label");
        update();
        assert(text(plain) == plain_text && text(flex) == flex_text && text(grid) == grid_text);
        assert(raw(flex)->GetChild(0) == flex_wrapper && raw(grid)->GetChild(0) == grid_wrapper);
        assert(plain_text->GetText() == "A much longer plain label");
        assert(raw(plain)->GetBox().GetSize().x > initial_width * 2);
        assert(raw(outlined)->QuerySelector("bbl-outline"));
        static_cast<void>(record_ui_rml_frame(runtime, 640, 480));

        // An inherited font change in the same batch must still project style.
        const auto previous_width = raw(plain)->GetBox().GetSize().x;
        ui_set_text(engine, plain, "A much longer plain label!");
        ui_set_attribute(engine, parent, "style", "font-size:32px;display:block;");
        assert(!engine.ui_only_text_changed_since(runtime.projected_revision,
                                                  runtime.projected_text_revision));
        update();
        assert(raw(plain)->GetComputedValues().font_size() == 32);
        assert(raw(plain)->GetBox().GetSize().x > previous_width * 1.8f);

        // Empty and whitespace transitions may change :empty and wrapper display.
        ui_set_text(engine, plain, "");
        assert(!engine.ui_only_text_changed_since(runtime.projected_revision,
                                                  runtime.projected_text_revision));
        update();
        assert(raw(plain)->Matches(":empty"));
        ui_set_text(engine, plain, "Restored");
        ui_set_text(engine, flex, " ");
        update();
        assert(!raw(plain)->Matches(":empty"));
        assert(raw(flex)->GetChild(0)->GetComputedValues().display() == Rml::Style::Display::None);
        ui_set_text(engine, flex, "Visible");
        update();
        assert(raw(flex)->GetChild(0)->GetComputedValues().display() != Rml::Style::Display::None);

        // Emoji presentation needs the existing markup projection.
        const std::string emoji = "Heart \xe2\x9d\xa4\xef\xb8\x8f";
        assert(ui_text_needs_emoji_normalization(emoji));
        ui_set_text(engine, plain, emoji);
        assert(!engine.ui_only_text_changed_since(runtime.projected_revision,
                                                  runtime.projected_text_revision));
        update();
        assert(raw(plain)->GetChild(0)->GetTagName() == "span");
        static_cast<void>(record_ui_rml_frame(runtime, 640, 480));
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
}
