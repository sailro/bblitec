#define main generated_main
#include "program.hpp"
#undef main
#include <cassert>
#include "expected.hpp"

namespace {
unsigned saves = 0, loads = 0, writes = 0;
std::string saved;
bbl::Engine* selected_engine = nullptr;

void check_dialog(bbl::Engine& engine, const bbl::pal::FileDialogOptions& options) {
    if (!selected_engine) selected_engine = &engine;
    assert(selected_engine == &engine);
    assert(options.suggested_name == "world.voxelsave.json");
    assert(options.filter_pattern == "*.json");
}
}

namespace bbl {
Engine create_engine(EngineOptions) { return {}; }
}

namespace bbl::pal {
std::optional<std::string> choose_save_file(Engine& engine, const FileDialogOptions& options) {
    check_dialog(engine, options);
    assert(options.title == "Save Voxel World");
    if (++saves == 1) return {};
    return "selected/world.json";
}

void write_selected_file_atomically(const std::string& path, std::string_view text) {
    assert(path == "selected/world.json");
    if (text != expected_json) throw std::runtime_error("Unexpected saved JSON: " + std::string(text));
    if (++writes == 2) throw std::runtime_error("injected write failure");
    saved = text;
}

std::optional<SelectedFileSnapshot> choose_open_file(Engine& engine, const FileDialogOptions& options) {
    check_dialog(engine, options);
    assert(options.title == "Load Voxel World");
    if (++loads == 1) return {};
    std::string text = saved;
    switch (loads) {
        case 4: text.replace(text.find("\"v\":1"), 5, "\"v\":2"); break;
        case 5: text = "{"; break;
        case 6: text += " trailing"; break;
        case 7: text = "null"; break;
        default: break;
    }
    SelectedFileSnapshot result;
    result.display_name = "world.json";
    result.bytes.assign(text.begin(), text.end());
    return result;
}
}

int main() {
    assert(generated_main() == 0);
    assert(saves == 3 && writes == 2 && loads == 7);
    assert(saved == expected_json);
}
