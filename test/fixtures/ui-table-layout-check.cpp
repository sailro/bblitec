#include <SDL3/SDL.h>
// Match the browser fixture's deviceScaleFactor=1 independently of the host display.
static float fixture_display_scale(SDL_Window*) { return 1.f; }
#define SDL_GetWindowDisplayScale fixture_display_scale
#include "pal_ui_rml.cpp"
#undef SDL_GetWindowDisplayScale
#include "cases.hpp"

#include <cassert>
#include <cmath>
#include <cstdio>
#include <functional>
#include <vector>

namespace bbl::pal {
std::string asset_path(std::string_view) {
    throw std::runtime_error("Unexpected fixture asset read");
}
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
} // namespace bbl::pal

namespace {

/** Lays out a table `build` makes and returns the error its layout refused with. */
std::string refusal(SDL_Window* window,
                    const std::function<void(bbl::Engine&, bbl::UiElementHandle)>& build) {
    using namespace bbl;
    using namespace bbl::pal;
    Engine engine;
    const auto table = ui_create_element(engine, "table");
    build(engine, table);
    ui_append_to_root(engine, table);
    try {
        UiRmlRuntime runtime(engine, window, 640, 480);
        update_ui_rml_runtime(runtime, 640, 480);
    } catch (const std::runtime_error& error) {
        return error.what();
    }
    return {};
}

bbl::UiElementHandle append(bbl::Engine& engine, bbl::UiElementHandle parent, const char* tag,
                            const char* style = "") {
    const auto element = bbl::ui_create_element(engine, tag);
    if (*style)
        bbl::ui_set_attribute(engine, element, "style", style);
    bbl::ui_append_child(engine, parent, element);
    return element;
}

} // namespace

int main() {
    using namespace bbl;
    using namespace bbl::pal;
    assert(SDL_Init(SDL_INIT_VIDEO));
    auto* window = SDL_CreateWindow("Table layout fixture", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
    int failures = 0;
    {
        Engine engine;
        std::vector<UiElementHandle> hosts;
        for (const auto style : table_case_hosts) {
            const auto host = ui_create_element(engine, "div");
            ui_set_attribute(engine, host, "style", std::string(style));
            ui_append_to_root(engine, host);
            hosts.push_back(host);
        }
        std::vector<UiElementHandle> elements(table_nodes.size());
        for (std::size_t index = 0; index < table_nodes.size(); ++index) {
            const auto& node = table_nodes[index];
            const auto parent = node.parent < 0 ? hosts[static_cast<std::size_t>(node.case_index)]
                                                : elements[static_cast<std::size_t>(node.parent)];
            if (node.tag.empty()) {
                ui_append_text(engine, parent, std::string(node.text));
                continue;
            }
            elements[index] = ui_create_element(engine, node.tag);
            if (!node.style.empty())
                ui_set_attribute(engine, elements[index], "style", std::string(node.style));
            if (!node.colspan.empty())
                ui_set_attribute(engine, elements[index], "colspan", std::string(node.colspan));
            ui_append_child(engine, parent, elements[index]);
        }
        UiRmlRuntime runtime(engine, window, 640, 480);
        update_ui_rml_runtime(runtime, 640, 480);
        const double scale = runtime.density_ratio;
        std::size_t expected = 0;
        for (std::size_t index = 0; index < table_nodes.size(); ++index) {
            const auto& node = table_nodes[index];
            if (node.tag.empty())
                continue;
            const auto& browser = table_expected[expected++];
            auto* host = runtime.projected_elements
                             .at(hosts[static_cast<std::size_t>(node.case_index)].value)
                             .element;
            auto* element = runtime.projected_elements.at(elements[index].value).element;
            assert(host && element);
            const auto offset = element->GetAbsoluteOffset(Rml::BoxArea::Border) -
                                host->GetAbsoluteOffset(Rml::BoxArea::Border);
            const auto size = element->GetBox().GetSize(Rml::BoxArea::Border);
            const std::array<double, 4> actual{offset.x / scale, offset.y / scale, size.x / scale,
                                               size.y / scale};
            bool equal = true;
            for (std::size_t lane = 0; lane < actual.size(); ++lane)
                equal = equal && std::abs(actual[lane] - browser[lane]) < 0.02;
            if (!equal) {
                ++failures;
                std::fprintf(
                    stderr,
                    "%s <%s> #%zu: native %.4g %.4g %.4g %.4g; browser %.4g %.4g %.4g %.4g\n",
                    table_case_names[static_cast<std::size_t>(node.case_index)].data(),
                    std::string(node.tag).c_str(), index, actual[0], actual[1], actual[2],
                    actual[3], browser[0], browser[1], browser[2], browser[3]);
            }
        }
    }
    const auto expect_refusal = [&](const char* name, const std::string& error, const char* text) {
        if (error.find(text) == std::string::npos) {
            ++failures;
            std::fprintf(stderr, "%s: expected a refusal naming '%s', got '%s'\n", name, text,
                         error.c_str());
        }
    };
    expect_refusal("collapsed border",
                   refusal(window,
                           [](Engine& engine, UiElementHandle table) {
                               ui_set_attribute(engine, table, "style", "border-collapse:collapse");
                               const auto row =
                                   append(engine, append(engine, table, "tbody"), "tr");
                               append(engine, row, "td", "border:1px solid black");
                           }),
                   "Collapsed table borders");
    expect_refusal("footer first",
                   refusal(window,
                           [](Engine& engine, UiElementHandle table) {
                               append(engine, append(engine, table, "tfoot"), "tr");
                               append(engine, append(engine, table, "tbody"), "tr");
                           }),
                   "A table footer group before other rows");
    expect_refusal("baseline cell",
                   refusal(window,
                           [](Engine& engine, UiElementHandle table) {
                               const auto row =
                                   append(engine, append(engine, table, "tbody"), "tr");
                               append(engine, row, "td", "vertical-align:baseline");
                           }),
                   "vertical-align");
    expect_refusal("stray content",
                   refusal(window, [](Engine& engine,
                                      UiElementHandle table) { append(engine, table, "div"); }),
                   "Content outside the table structure");
    SDL_DestroyWindow(window);
    SDL_Quit();
    return failures == 0 ? 0 : 1;
}
