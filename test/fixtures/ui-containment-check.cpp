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
#include <vector>

namespace bbl::pal {
std::string asset_path(std::string_view) {
    throw std::runtime_error("Unexpected fixture asset read");
}
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
} // namespace bbl::pal

int main() {
    using namespace bbl;
    using namespace bbl::pal;
    assert(SDL_Init(SDL_INIT_VIDEO));
    auto* window = SDL_CreateWindow("Containment fixture", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
    int failures = 0;
    for (const auto& test : contain_cases) {
        Engine engine;
        const auto host = ui_create_element(engine, "div");
        ui_set_attribute(engine, host, "style", std::string(contain_host_style));
        ui_append_to_root(engine, host);
        const auto box = ui_create_element(engine, "div");
        const std::string contain =
            test.contain.empty() ? std::string() : "contain:" + std::string(test.contain) + ";";
        ui_set_attribute(engine, box, "style", contain + std::string(contain_box_style));
        ui_append_child(engine, host, box);
        std::vector<UiElementHandle> parts{box};
        for (const auto style : contain_child_styles) {
            const auto child = ui_create_element(engine, "div");
            ui_set_attribute(engine, child, "style", std::string(style));
            ui_append_child(engine, box, child);
            parts.push_back(child);
        }
        UiRmlRuntime runtime(engine, window, 640, 480);
        update_ui_rml_runtime(runtime, 640, 480);
        const auto element = [&](UiElementHandle handle) {
            return runtime.projected_elements.at(handle.value).element;
        };
        const auto origin = element(host)->GetAbsoluteOffset(Rml::BoxArea::Border);
        for (std::size_t part = 0; part < parts.size(); ++part) {
            auto* rml = element(parts[part]);
            const auto offset = rml->GetAbsoluteOffset(Rml::BoxArea::Border) - origin;
            const auto size = rml->GetBox().GetSize(Rml::BoxArea::Border);
            const std::array<double, 4> actual{offset.x, offset.y, size.x, size.y};
            bool equal = true;
            for (std::size_t lane = 0; lane < actual.size(); ++lane)
                equal = equal && std::abs(actual[lane] - test.rects[part][lane]) < 0.02;
            if (!equal) {
                ++failures;
                std::fprintf(stderr, "%s part %zu: native %g %g %g %g; browser %g %g %g %g\n",
                             test.name.data(), part, actual[0], actual[1], actual[2], actual[3],
                             test.rects[part][0], test.rects[part][1], test.rects[part][2],
                             test.rects[part][3]);
            }
        }
        const auto hits = [&](Rml::Vector2f point, UiElementHandle expected) {
            const auto target = ui_element_from_point(engine, point.x, point.y);
            return target && target->kind == DomEventTargetKind::Element &&
                           target->element == expected.value
                       ? 1
                       : 0;
        };
        // The child under the box's background is hit where the box is its stacking context.
        auto* under = element(parts[3]);
        const auto under_center = under->GetAbsoluteOffset(Rml::BoxArea::Border) +
                                  under->GetBox().GetSize(Rml::BoxArea::Border) * 0.5f;
        const int under_hit = hits(under_center, parts[3]);
        // The wide child is hit past the box's right edge unless paint containment clips it.
        auto* boxed = element(box);
        auto* wide = element(parts[2]);
        const Rml::Vector2f past{boxed->GetAbsoluteOffset(Rml::BoxArea::Border).x +
                                     boxed->GetBox().GetSize(Rml::BoxArea::Border).x + 4.f,
                                 wide->GetAbsoluteOffset(Rml::BoxArea::Border).y + 5.f};
        const int wide_hit = hits(past, parts[2]);
        if (under_hit != test.under_hit || wide_hit != test.wide_hit) {
            ++failures;
            std::fprintf(stderr, "%s: native under/wide hits %d %d; browser %d %d\n",
                         test.name.data(), under_hit, wide_hit, test.under_hit, test.wide_hit);
        }
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
    return failures == 0 ? 0 : 1;
}
