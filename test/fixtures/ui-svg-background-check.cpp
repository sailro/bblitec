#define main generated_main
#include "../../artifacts/ui-svg-background/program.hpp"
#undef main
#include "pal_ui_rml.cpp"
#include <cassert>

namespace bbl {
std::string asset_path(const std::string& path) { return "artifacts/ui-svg-background/" + path; }
} // namespace bbl
namespace bbl::pal {
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
Engine& window_document_engine() {
    static Engine engine;
    return engine;
}
int run_window_application(WorkerEntry initialize, EngineOptions) {
    const js::RealmScope scope;
    EventLoop loop;
    WorkerRealm realm(loop);
    loop.run([&] { initialize(realm); });
    return 0;
}
} // namespace bbl::pal

int run() {
    using namespace bbl;
    assert(SDL_Init(SDL_INIT_VIDEO));
    SDL_Window* window = SDL_CreateWindow("SVG backgrounds", 320, 240, SDL_WINDOW_HIDDEN);
    assert(window && generated_main() == 0);
    {
        auto& engine = pal::window_document_engine();
        pal::UiRmlRuntime runtime(engine, window, 320, 240);
        pal::update_ui_rml_runtime(runtime, 320, 240);
        const auto decorator = [&](const char* id) {
            auto* raw =
                runtime.projected_elements.at(ui_get_element_by_id(engine, id).value).element;
            return raw->GetProperty("decorator")->ToString();
        };
        // The explicit size is the layer's own box, the image filling it at its offsets.
        const auto sized = decorator("chevron");
        if (sized.find("inline.svg") == std::string::npos ||
            sized.find("fill") == std::string::npos)
            throw std::runtime_error("Sized SVG background: " + sized);
        const auto contained = decorator("cursor");
        if (contained.find("inline.svg") == std::string::npos ||
            contained.find("contain") == std::string::npos)
            throw std::runtime_error("Contained SVG background: " + contained);
        // Both SVG images rasterize: the chevron's stroke and the square's fill.
        const auto& frame = pal::record_ui_rml_frame(runtime, 320, 240);
        const auto drawn = [&](std::uint8_t red, std::uint8_t green, std::uint8_t blue) {
            return std::any_of(frame.textures.begin(), frame.textures.end(),
                               [&](const auto& texture) {
                                   if (!texture.rgba)
                                       return false;
                                   const auto& rgba = *texture.rgba;
                                   for (std::size_t at = 0; at + 3 < rgba.size(); at += 4)
                                       if (rgba[at] == red && rgba[at + 1] == green &&
                                           rgba[at + 2] == blue && rgba[at + 3] == 255)
                                           return true;
                                   return false;
                               });
        };
        assert(drawn(0x5a, 0x46, 0x30));
        assert(drawn(255, 0, 0));
        const auto drawsTexture =
            std::count_if(frame.draws.begin(), frame.draws.end(),
                          [](const auto& draw) { return draw.texture_id != 0; });
        assert(drawsTexture >= 2);
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
}

int main() {
    try {
        return run();
    } catch (const std::exception& error) {
        std::fprintf(stderr, "%s\n", error.what());
        return 1;
    }
}
