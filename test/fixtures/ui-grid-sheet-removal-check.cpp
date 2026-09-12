#define BBLITE_WORKERS 1
#define BBLITE_OFFSCREEN_SURFACES 1
#define main generated_main
#include "../../artifacts/ui-grid-sheet-removal/program.hpp"
#undef main
#include "pal_ui_rml.cpp"
#include <cassert>

namespace bbl::pal {
std::string asset_path(std::string_view) { throw std::runtime_error("Unexpected fixture asset read"); }
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
Engine& window_document_engine() { static Engine document; return document; }
int run_window_application(WorkerEntry initialize, EngineOptions) {
    const js::RealmScope scope;
    EventLoop loop;
    WorkerRealm realm(loop);
    std::exception_ptr failure;
    loop.on_error([&](std::exception_ptr error) { failure = error; loop.close(); });
    loop.run([&] { initialize(realm); });
    if (failure) std::rethrow_exception(failure);
    return 0;
}
}

int main() {
    using namespace bbl;
    assert(generated_main() == 0);
    assert(SDL_Init(SDL_INIT_VIDEO));
    auto* window = SDL_CreateWindow("Stylesheet removal", 320, 240, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        auto& engine = pal::window_document_engine();
        pal::UiRmlRuntime runtime(engine, window, 320, 240);
        const auto root = ui_get_element_by_id(engine, "tiles");
        const auto first = ui_get_element_by_id(engine, "first");
        const auto second = ui_get_element_by_id(engine, "second");
        auto* first_raw = runtime.projected_elements.at(first.value).element;
        auto* second_raw = runtime.projected_elements.at(second.value).element;
        assert(first_raw->GetClientWidth() == 24.f);
        assert(second_raw->GetAbsoluteOffset().x - first_raw->GetAbsoluteOffset().x == 27.f);
        assert(runtime.projected_elements.at(root.value).children_container);
        ui_click(engine, first);
        pal::update_ui_rml_runtime(runtime, 320, 240);
        assert(runtime.projected_elements.at(first.value).element == first_raw);
        assert(runtime.projected_elements.at(second.value).element == second_raw);
        assert(!runtime.projected_elements.at(root.value).children_container);
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
}
