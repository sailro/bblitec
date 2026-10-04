#include "pal_ui_rml.cpp"
#include "pal_window_realm.cpp"
#include "pal_media_query.cpp"
#include "window-frame-unit-fixture.hpp"
#include <cassert>

namespace bbl::pal {
int fixture_run_window_application(WorkerEntry initialize, EngineOptions options);
void fixture_update_window_document(bool wait = true);
std::shared_ptr<Engine> create_realm_engine(EngineOptions options,
                                            const std::shared_ptr<CanvasElement>& canvas);
} // namespace bbl::pal
#define run_window_application fixture_run_window_application
#define update_window_document fixture_update_window_document
#define main generated_main
#include "../../artifacts/implicit-engine-canvas/program.hpp"
#undef main
#undef run_window_application
#undef update_window_document

namespace {
int engines_created = 0;
}

namespace bbl {
void set_canvas_dataset(Engine&, std::string, std::string) {
    throw std::logic_error("Unexpected fixture input replay");
}
} // namespace bbl

namespace bbl::pal {
std::shared_ptr<Engine> create_realm_engine(EngineOptions options,
                                            const std::shared_ptr<CanvasElement>& canvas) {
    // GPU/device creation and layout sizing are outside this document-owner fixture.
    auto& owner = current_document();
    assert(owner.canvases.size() == 1 && owner.canvases.begin()->second == canvas);
    ++engines_created;
    auto engine = std::make_shared<Engine>();
    engine->options = std::move(options);
    return engine;
}
void fixture_update_window_document(bool) {
    // There is no display thread in this CPU fixture to acknowledge layout.
    update_window_document(false);
}
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
    auto services = std::make_shared<WindowServices>(std::make_shared<OffscreenDevice>(), 1);
    WorkerRealm realm(loop, "", services);
    WindowDocument owner(services, std::move(options));
    document = &owner;
    loop.on_error([](std::exception_ptr error) { std::rethrow_exception(error); });
    loop.run([&] { initialize(realm); });
    assert(engines_created == 1);
    assert(owner.canvases.size() == 1);
    assert(owner.wait_for_canvas_ready && services->capture_ready->load());
    const auto canvas = ui_get_element_by_id(owner.engine, "renderCanvas");
    assert(ui_get_attribute(owner.engine, canvas, "data-ready") == "true");
    const auto body = ui_document_root(owner.engine, UiDocumentPart::Body);
    assert(ui_get_attribute(owner.engine, body, "data-started") == "true");
    assert(ui_get_attribute(owner.engine, body, "data-caught") == "expected startup failure");
    assert(ui_get_attribute(owner.engine, body, "data-failure").empty());
    document = nullptr;
    return 0;
}
} // namespace bbl::pal

int main() { assert(generated_main() == 0); }
