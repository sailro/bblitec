#define main generated_main
#include "../../artifacts/ui-video/program.hpp"
#undef main
#include "pal_ui_rml.cpp"
#include <cmath>
#include <cstdio>
#include <fstream>

namespace bbl {
std::string asset_path(const std::string& path) { return "artifacts/ui-video/public/" + path; }
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
} // namespace bbl::pal
#define FIXTURE_APPLICATION_TIMEOUT_MS 5000
#include "realm-application-fixture.hpp"

int main() try {
    using namespace bbl;
    const auto check = [](bool pass, const char* message) {
        if (!pass)
            throw std::runtime_error(message);
    };
    check(SDL_Init(SDL_INIT_VIDEO), "SDL initialization");
    SDL_Window* window = SDL_CreateWindow("UI video fixture", 640, 480, SDL_WINDOW_HIDDEN);
    check(window != nullptr, "Window creation");
    {
        auto& engine = pal::window_document_engine();
        check(generated_main() == 0, "program");
        // The members read back; play() rejected after the error event; the failed source
        // rejected a second play() at once; load() without src left it paused.
        const auto& log = ui_element(engine, ui_get_element_by_id(engine, "log")).text;
        if (log != "pmwu|ENnl")
            std::fprintf(stderr, "log: %s\n", log.c_str());
        check(log == "pmwu|ENnl", "video element members and play()");
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        auto* raw =
            runtime.projected_elements.at(ui_get_element_by_id(engine, "clip").value).element;
        check(raw && raw->GetTagName() == "video", "the video is projected as a video");
        // RmlUi renders the poster as an img renders its src; the media source is not projected.
        check(raw->GetAttribute<Rml::String>("src", "") == "/poster.png",
              "the poster is the rendered image");
        // The width and height attributes reserve the box over the decoded poster's 40x20.
        const auto size = raw->GetBox().GetSize(Rml::BoxArea::Content);
        if (std::abs(size.x - 160) > 0.01f || std::abs(size.y - 90) > 0.01f)
            std::fprintf(stderr, "size: %gx%g\n", size.x, size.y);
        check(std::abs(size.x - 160) < 0.01f && std::abs(size.y - 90) < 0.01f,
              "the dimension attributes reserve the box");
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
} catch (const std::exception& error) {
    std::fprintf(stderr, "UI video failure: %s\n", error.what());
    return 1;
}
