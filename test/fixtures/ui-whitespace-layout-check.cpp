#define main generated_main
#include "../../artifacts/ui-whitespace-layout/program.hpp"
#undef main
#include "pal_ui_rml.cpp"
#include <cmath>
#include <cstdio>

namespace bbl::pal {
std::string asset_path(std::string_view) {
    throw std::runtime_error("Unexpected fixture asset read");
}
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 1000; }
Engine& window_document_engine() {
    static Engine document;
    return document;
}
void update_window_document(bool) {}
} // namespace bbl::pal
#include "realm-application-fixture.hpp"

int main() try {
    using namespace bbl;
    const auto check = [](bool pass, const char* message) {
        if (!pass)
            throw std::runtime_error(message);
    };
    check(SDL_Init(SDL_INIT_VIDEO), "SDL initialization");
    SDL_Window* window =
        SDL_CreateWindow("UI white space layout fixture", 640, 480, SDL_WINDOW_HIDDEN);
    check(window != nullptr, "Window creation");
    {
        auto& engine = pal::window_document_engine();
        check(generated_main() == 0, "program");
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        const auto element = [&](const char* id) {
            return runtime.projected_elements.at(ui_get_element_by_id(engine, id).value).element;
        };
        const auto size = [&](const char* id) {
            return element(id)->GetBox().GetSize(Rml::BoxArea::Border);
        };
        const auto same = [](float left, float right) { return std::abs(left - right) < 0.01f; };
        const auto block_gap = [&](const char* id) {
            Rml::Element* first = nullptr;
            Rml::Element* second = nullptr;
            for (int index = 0; index < element(id)->GetNumChildren(); ++index) {
                auto* child = element(id)->GetChild(index);
                if (child->IsClassSet("first"))
                    first = child;
                if (child->IsClassSet("second"))
                    second = child;
            }
            if (!first || !second)
                throw std::runtime_error("missing stacked blocks");
            return second->GetAbsoluteOffset(Rml::BoxArea::Border).y -
                   (first->GetAbsoluteOffset(Rml::BoxArea::Border).y +
                    first->GetBox().GetSize(Rml::BoxArea::Border).y);
        };
        if (!same(size("spaced").x, size("tight").x))
            std::fprintf(stderr, "flex label %g, without the space %g\n", size("spaced").x,
                         size("tight").x);
        check(same(size("spaced").x, size("tight").x),
              "a flex item's trailing space hangs at its line end");
        check(same(size("trailing").x, size("bare").x),
              "a trailing space inside an inline box hangs at the line end");
        check(same(size("credit").x, size("credit-bare").x) &&
                  same(size("credit").y, size("credit-bare").y),
              "a hanging space never wraps a shrink-to-fit line");
        if (!same(block_gap("blocks"), 12.f))
            std::fprintf(stderr, "block gap %g\n", block_gap("blocks"));
        check(same(block_gap("blocks"), 12.f) && same(block_gap("flow"), 12.f),
              "white space between blocks leaves their margins collapsing");
        check(same(size("blocks").y, size("flow").y), "white space between blocks takes no height");
        if (!same(block_gap("hidden-between"), 12.f))
            std::fprintf(stderr, "gap over hidden blocks %g\n", block_gap("hidden-between"));
        check(same(block_gap("hidden-between"), 12.f) &&
                  same(size("hidden-between").y, size("flow").y),
              "white space around hidden blocks collapses away");
        check(same(size("cells").x, size("packed").x) && same(size("cells").y, size("packed").y),
              "white space in a grid container generates no grid items");
        if (size("words").x < size("glued").x + 2.f || size("words-wrap").x < size("glued").x + 2.f)
            std::fprintf(stderr, "spaced words %g and %g, glued %g\n", size("words").x,
                         size("words-wrap").x, size("glued").x);
        check(size("words").x >= size("glued").x + 2.f &&
                  same(size("words").x, size("words-wrap").x),
              "white space between inline boxes renders one space");
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
} catch (const std::exception& error) {
    std::fprintf(stderr, "UI white space layout failure: %s\n", error.what());
    return 1;
}
