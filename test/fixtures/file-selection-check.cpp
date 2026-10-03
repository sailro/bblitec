#define main generated_main
#include "../../artifacts/file-selection/program.hpp"
#undef main
#include "pal_ui_rml.cpp"

namespace bbl::pal {
std::string asset_path(std::string_view) { throw std::runtime_error("Unexpected asset read"); }
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
Engine& window_document_engine() {
    static Engine engine;
    return engine;
}
const void* window_document_identity() {
    static const int identity = 0;
    return &identity;
}
std::optional<SelectedFileSnapshot> choose_open_file(Engine&, const FileDialogOptions&) {
    static unsigned calls = 0;
    if (++calls == 1)
        return SelectedFileSnapshot{{'o', 'w', 'n', 'e', 'd'}, "selected.json"};
    return std::nullopt;
}
bool save_file(Engine&, const FileDialogOptions&, std::span<const std::uint8_t>,
               const std::function<void()>&) {
    throw std::runtime_error("Unexpected file save");
}
int run_window_application(WorkerEntry initialize, EngineOptions) {
    const js::RealmScope scope;
    EventLoop loop;
    WorkerRealm realm(loop);
    std::exception_ptr failure;
    loop.on_error([&](std::exception_ptr error) {
        failure = error;
        loop.close();
    });
    loop.run([&] { initialize(realm); });
    if (failure)
        std::rethrow_exception(failure);
    return 0;
}
} // namespace bbl::pal

int main() { return generated_main(); }
