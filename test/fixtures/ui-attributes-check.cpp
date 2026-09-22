#define BBLITE_WORKERS 1
#define BBLITE_OFFSCREEN_SURFACES 1
#define main generated_main
#include "../../artifacts/ui-attributes/program.hpp"
#undef main
#include "pal_ui_rml.cpp"
#include <cassert>
#include <fstream>

namespace bbl {
std::string asset_path(const std::string& path) { return "artifacts/ui-attributes/" + path; }
} // namespace bbl
namespace bbl::pal {
std::vector<std::uint8_t> read_binary_file(const std::string& path) {
    std::ifstream stream(path, std::ios::binary);
    if (!stream)
        throw std::runtime_error("Unable to read fixture image: " + path);
    return {std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>()};
}
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
Engine& window_document_engine() {
    static Engine document;
    return document;
}
int run_window_application(WorkerEntry initialize, EngineOptions) {
    const js::RealmScope scope;
    EventLoop loop;
    WorkerRealm realm(loop);
    loop.run([&] { initialize(realm); });
    return 0;
}
} // namespace bbl::pal

int main() {
    using namespace bbl;
    assert(SDL_Init(SDL_INIT_VIDEO));
    SDL_Window* window = SDL_CreateWindow("Attribute fixture", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window && generated_main() == 0);
    pal::EventLoop loop;
    std::exception_ptr failure;
    loop.on_error([&](std::exception_ptr error) {
        failure = error;
        loop.close();
    });
    loop.run([&] {
        {
            auto& engine = pal::window_document_engine();
            const auto panel = ui_get_element_by_id(engine, "panel");
            assert(!ui_has_attribute(engine, panel, "style"));
            assert(!ui_has_attribute(engine, panel, "class"));
            assert(!ui_has_attribute(engine, panel, "hidden"));
            assert(ui_element(engine, panel).style_properties.empty());
            const auto image = ui_create_element(engine, "img");
            ui_set_attribute(engine, image, "src", "tile.png");
            ui_set_attribute(engine, image, "style", "width:20px;height:20px");
            ui_append_to_root(engine, image);
            pal::UiRmlRuntime runtime(engine, window, 640, 480);
            auto* raw_image = runtime.projected_elements.at(image.value).element;
            auto* raw_panel = runtime.projected_elements.at(panel.value).element;
            const auto has_texture = [&] {
                const auto& frame = pal::record_ui_rml_frame(runtime, 640, 480);
                return std::any_of(frame.draws.begin(), frame.draws.end(),
                                   [](const auto& draw) { return draw.texture_id != 0; });
            };
            assert(has_texture());
            ui_remove_attribute(engine, image, "SRC");
            pal::update_ui_rml_runtime(runtime, 640, 480);
            assert(!has_texture() && !raw_image->HasAttribute("src"));
            assert(runtime.projected_elements.at(image.value).element == raw_image);
            const auto revision = engine.ui_revision;
            ui_remove_attribute(engine, image, "src");
            assert(engine.ui_revision == revision);
            ui_set_attribute(engine, image, "src", "tile.png");
            pal::update_ui_rml_runtime(runtime, 640, 480);
            assert(has_texture());
            ui_set_attribute(engine, panel, "style", "height:40px");
            ui_set_style_property(engine, panel, "height", "60px");
            pal::update_ui_rml_runtime(runtime, 640, 480);
            assert(raw_panel->GetClientHeight() == 60.f);
            ui_remove_attribute(engine, panel, "style");
            pal::update_ui_rml_runtime(runtime, 640, 480);
            assert(raw_panel->GetClientHeight() != 60.f);
            assert(ui_get_style_property(engine, panel, "height").empty());
            assert(!raw_panel->HasAttribute("style"));
        }
        loop.queue_microtask([&] { loop.close(); });
    });
    if (failure)
        std::rethrow_exception(failure);
    SDL_DestroyWindow(window);
    SDL_Quit();
}
