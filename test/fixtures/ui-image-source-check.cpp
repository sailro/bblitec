#define main generated_main
#include "../../artifacts/ui-image-source/program.hpp"
#undef main
#include "pal_ui_rml.cpp"
#include <cstdio>
#include <fstream>

namespace bbl {
std::string asset_path(const std::string& path) { return "artifacts/ui-image-source/" + path; }
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
void update_window_document(bool) {}
// A landscape viewport.
UiClientRect window_viewport_size() { return {0, 0, 640, 480, 640, 480}; }
int run_window_application(WorkerEntry initialize, EngineOptions) {
    const js::RealmScope scope;
    EventLoop loop;
    WorkerRealm realm(loop);
    loop.run([&] { initialize(realm); });
    return 0;
}
} // namespace bbl::pal

int main() try {
    using namespace bbl;
    if (generated_main() != 0)
        throw std::runtime_error("The generated program failed");
    auto& engine = pal::window_document_engine();
    const auto source = [&](const char* id) {
        return ui_get_attribute(engine, ui_get_element_by_id(engine, id), "src");
    };
    // The same orientation test selects opposite host data attributes.
    const auto first = source("art"), second = source("other");
    if (!((first == "tile.png" && second == "tall.png") ||
          (first == "tall.png" && second == "tile.png")))
        throw std::runtime_error("image sources were not selected at run time: " + first + ", " +
                                 second);
} catch (const std::exception& error) {
    std::fprintf(stderr, "Image source: %s\n", error.what());
    return 1;
}
