#include "pal_ui_rml.cpp"
#include "pal_window_realm.cpp"
#include "pal_media_query.cpp"
#include "window-frame-unit-fixture.hpp"
#include <cassert>

namespace bbl::pal {
int fixture_run_window_application(WorkerEntry initialize, EngineOptions options);
}
#define run_window_application fixture_run_window_application
#define main generated_main
#include "../../artifacts/observer-constructor-values/program.hpp"
#undef main
#undef run_window_application

namespace bbl::pal {
std::string asset_path(std::string_view) { throw std::logic_error("Unexpected fixture asset"); }
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
double monotonic_milliseconds() { return 0; }
const char* bblite_build_stamp() { return "fixture"; }
void report_build_stamp() {}
std::shared_ptr<WindowPresenter> create_window_sdl_gpu_presenter(SDL_Window*) {
    throw std::logic_error("Unexpected fixture presenter");
}

int fixture_run_window_application(WorkerEntry initialize, EngineOptions options) {
    const js::RealmScope scope;
    EventLoop loop;
    WorkerRealm realm(loop);
    auto services = std::make_shared<WindowServices>(nullptr, 0);
    WindowDocument owner(services, std::move(options));
    document = &owner;
    std::exception_ptr failure;
    loop.on_error([&](std::exception_ptr error) {
        failure = error;
        loop.close();
    });
    loop.run([&] {
        initialize(realm);
        assert(owner.observers.size() == 2);
        // Supply the layout snapshot a presentation host would publish.
        auto layout = std::make_shared<LayoutSnapshot>();
        layout->rectangles.resize(owner.engine.ui_elements.size());
        layout->content_boxes.resize(owner.engine.ui_elements.size());
        layout->styles.resize(owner.engine.ui_elements.size());
        services->layout = layout;
        owner.published_revision = owner.engine.ui_revision;
        owner.published_text_revision = owner.engine.ui_text_revision;
        owner.published_canvas_revision = owner.engine.ui_canvas_revision;
        owner.published_focus_revision = owner.engine.ui_focus_revision;
        owner.published_text_selection_revision = owner.engine.ui_text_selection_revision;
        owner.published_input_revision =
            owner.engine.dom_input ? owner.engine.dom_input->revision : 0;
        for (const auto& observer : owner.observers) {
            observer->deliver();
            observer->deliver();
        }
    });
    document = nullptr;
    if (failure)
        std::rethrow_exception(failure);
    assert(owner.observers.empty());
    assert(owner.mutation_observers.empty());
    return 0;
}
} // namespace bbl::pal

namespace bbl {
void set_canvas_dataset(Engine&, std::string, std::string) {
    throw std::logic_error("Unexpected fixture input replay");
}
} // namespace bbl

int main() try {
    assert(generated_main() == 0);
    return 0;
} catch (const std::exception& error) {
    std::fprintf(stderr, "%s\n", error.what());
    return 1;
}
