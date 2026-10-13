#include "pal_ui_rml.cpp"
#include <cassert>

namespace bbl::pal {
std::string asset_path(std::string_view) {
    throw std::runtime_error("Unexpected fixture asset read");
}
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
} // namespace bbl::pal

namespace {
std::vector<std::string> navigations;
void navigate(const std::string& url) { navigations.push_back(url); }
void refuse(const std::string& url) { throw std::runtime_error("location.assign refused " + url); }
} // namespace

int main() {
    using namespace bbl;
    assert(SDL_Init(SDL_INIT_VIDEO));
    SDL_Window* window = SDL_CreateWindow("UI link fixture", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        Engine engine;
        ui_set_link_navigation(engine, navigate);
        const auto link = [&](const char* href, const char* target, int top) {
            const auto anchor = ui_create_element(engine, "a");
            ui_set_attribute(
                engine, anchor, "style",
                "position:absolute;display:block;left:20px;width:100px;height:40px;top:" +
                    std::to_string(top) + "px;");
            if (href)
                ui_set_attribute(engine, anchor, "href", href);
            if (target)
                ui_set_attribute(engine, anchor, "target", target);
            ui_append_to_root(engine, anchor);
            return anchor;
        };
        const auto same = link("?quality=low", nullptr, 20);
        const auto self = link("?quality=high", "_SELF", 80);
        const auto blank = link("https://example.test/", "_blank", 140);
        const auto bare = link(nullptr, nullptr, 200);
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        // Programmatic activation: a link targeting this context navigates; another context
        // and an anchor without href have no native default action.
        ui_click(engine, same);
        ui_click(engine, self);
        ui_click(engine, blank);
        ui_click(engine, bare);
        assert((navigations == std::vector<std::string>{"?quality=low", "?quality=high"}));
        // A user click on a link without listeners takes the same default action.
        const auto click = [&](int y) {
            runtime.context->ProcessMouseMove(40, y, 0);
            runtime.context->ProcessMouseButtonDown(0, 0);
            runtime.context->ProcessMouseButtonUp(0, 0);
        };
        click(40);
        click(160);
        assert(navigations.size() == 3 && navigations.back() == "?quality=low");
        // An href written after projection makes the anchor a link.
        ui_set_attribute(engine, bare, "href", "?late=1");
        pal::update_ui_rml_runtime(runtime, 640, 480);
        click(220);
        assert(navigations.size() == 4 && navigations.back() == "?late=1");
        // The navigation's refusal reaches the activation.
        ui_set_link_navigation(engine, refuse);
        bool refused = false;
        try {
            ui_click(engine, same);
        } catch (const std::runtime_error& error) {
            refused = std::string(error.what()) == "location.assign refused ?quality=low";
        }
        assert(refused);
    }
    {
        Engine engine;
        const auto anchor = ui_create_element(engine, "a");
        ui_set_attribute(engine, anchor, "href", "?quality=low");
        bool refused = false;
        try {
            ui_click(engine, anchor);
        } catch (const std::logic_error&) {
            refused = true;
        }
        assert(refused);
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
}
