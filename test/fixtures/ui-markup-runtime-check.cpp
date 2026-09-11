#include "pal_ui_rml.cpp"
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
        const auto markup = ui_create_element(engine, "div");
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
    SDL_DestroyWindow(window);
    SDL_Quit();
}
