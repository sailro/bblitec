#define main generated_main
#include "../../artifacts/ui-markup-operands/program.hpp"
#undef main
#include "pal_ui_rml.cpp"
#include "browser.hpp"
#include <cstdio>
#include <fstream>
#include <iterator>
#include <sstream>

namespace bbl {
std::string asset_path(const std::string& path) {
    return "artifacts/ui-markup-operands/public/" + path;
}
} // namespace bbl
namespace bbl::pal {
std::vector<std::uint8_t> read_binary_file(const std::string& path) {
    std::ifstream file(path, std::ios::binary);
    if (!file)
        throw std::runtime_error("Missing fixture file: " + path);
    return {std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>()};
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

namespace {

/** The element and text tree under `element`, spelled as the browser fixture spells the DOM's. */
std::string serialize(Rml::Element& element) {
    std::string result;
    for (int index = 0; index < element.GetNumChildren(); ++index) {
        auto& child = *element.GetChild(index);
        if (auto* text = dynamic_cast<Rml::ElementText*>(&child)) {
            result += text->GetText();
            continue;
        }
        const std::string tag = child.GetTagName();
        std::string classes;
        std::istringstream names(child.GetAttribute<std::string>("class", ""));
        for (std::string name; names >> name;)
            classes += (classes.empty() ? "" : " ") + name;
        result += "<" + tag + (classes.empty() ? "" : " class=\"" + classes + "\"");
        if (child.HasAttribute("src"))
            result += " src=\"" + child.GetAttribute<std::string>("src", "") + "\"";
        result += ">" + serialize(child) + "</" + tag + ">";
    }
    return result;
}

} // namespace

int main() try {
    using namespace bbl;
    if (!SDL_Init(SDL_INIT_VIDEO))
        throw std::runtime_error("SDL initialization");
    SDL_Window* window =
        SDL_CreateWindow("UI markup operands fixture", 640, 480, SDL_WINDOW_HIDDEN);
    if (!window)
        throw std::runtime_error("Window creation");
    int failures = 0;
    {
        auto& engine = pal::window_document_engine();
        if (generated_main() != 0)
            throw std::runtime_error("program");
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        for (const auto& [id, browser] : browser_trees) {
            auto* card = runtime.document->GetElementById(std::string(id));
            if (!card)
                throw std::runtime_error("missing card " + std::string(id));
            const auto native = serialize(*card);
            if (native != browser) {
                ++failures;
                std::fprintf(stderr, "%s: native %s\n   browser %s\n", std::string(id).c_str(),
                             native.c_str(), std::string(browser).c_str());
            }
        }
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
    return failures == 0 ? 0 : 1;
} catch (const std::exception& error) {
    std::fprintf(stderr, "%s\n", error.what());
    return 1;
}
