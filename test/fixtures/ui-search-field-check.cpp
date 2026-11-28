#include <SDL3/SDL.h>
// Match the browser fixture's deviceScaleFactor=1 independently of the host display.
static float fixture_display_scale(SDL_Window*) { return 1.f; }
#define SDL_GetWindowDisplayScale fixture_display_scale
#include "pal_ui_rml.cpp"
#undef SDL_GetWindowDisplayScale
#include "cases.hpp"

#include <cassert>
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <string>
#include <vector>

namespace bbl::pal {
std::string asset_path(std::string_view) {
    throw std::runtime_error("Unexpected fixture asset read");
}
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
} // namespace bbl::pal

namespace {

Rml::Element* cancel_button(Rml::Element* field) {
    for (int index = 0; index < field->GetNumChildren(true); ++index)
        if (field->GetChild(index)->GetTagName() == "searchcancel")
            return field->GetChild(index);
    throw std::runtime_error("Search field without a cancel button");
}

/** Mean and largest difference of a texture over white against Chromium's red channel. */
std::pair<double, int> pixel_error(const bbl::pal::UiRenderTexture& texture,
                                   const std::vector<int>& expected) {
    double sum = 0;
    int largest = 0;
    for (std::size_t index = 0; index < expected.size(); ++index) {
        const auto* pixel = texture.rgba->data() + index * 4;
        const int red = pixel[0] + 255 - pixel[3];
        const int error = std::abs(red - expected[index]);
        sum += error;
        largest = std::max(largest, error);
    }
    return {sum / static_cast<double>(expected.size()), largest};
}

} // namespace

int main() try {
    using namespace bbl;
    using namespace bbl::pal;
    assert(SDL_Init(SDL_INIT_VIDEO));
    auto* window = SDL_CreateWindow("Search field fixture", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
    int failures = 0;
    {
        Engine engine;
        std::vector<UiElementHandle> fields;
        for (std::size_t index = 0; index < search_cases.size(); ++index) {
            const auto& item = search_cases[index];
            const auto field = ui_create_element(engine, "input");
            ui_set_attribute(engine, field, "type", "search");
            ui_set_attribute(engine, field, "value", "abc");
            // Each field where Chromium's line placed it.
            ui_set_attribute(
                engine, field, "style",
                std::string(item.style) + ";position:absolute;margin:0;left:" +
                    std::to_string(item.field[0]) + "px;top:" +
                    std::to_string(item.field[1] + search_row_height * static_cast<double>(index)) +
                    "px");
            ui_append_to_root(engine, field);
            fields.push_back(field);
        }
        const auto other = ui_create_element(engine, "input");
        ui_set_attribute(engine, other, "style", "position:absolute;left:400px;top:440px");
        ui_append_to_root(engine, other);
        std::string events;
        for (const char* name : {"input", "change", "search"})
            ui_on_event(engine, fields[0], name, [&, name](const PlatformMouseEvent&) {
                events += std::string(name) + ":" + ui_get_form_value(engine, fields[0]) + ";";
            });

        UiRmlRuntime runtime(engine, window, 640, 480);
        update_ui_rml_runtime(runtime, 640, 480);
        const auto element = [&](UiElementHandle handle) {
            return runtime.projected_elements.at(handle.value).element;
        };
        // The texture a draw paints as a side-pixel square at (left, top), where Chromium paints it.
        const auto drawn = [&](int side, float left, float top) -> const UiRenderTexture* {
            const auto& frame = runtime.render_interface.frame;
            for (const auto& draw : frame.draws) {
                const auto found =
                    std::find_if(frame.textures.begin(), frame.textures.end(),
                                 [&](const UiRenderTexture& entry) {
                                     return entry.id == draw.texture_id &&
                                            entry.width == static_cast<std::uint32_t>(side) &&
                                            entry.height == static_cast<std::uint32_t>(side) &&
                                            entry.rgba;
                                 });
                if (found == frame.textures.end() || draw.index_count == 0)
                    continue;
                float x = 1e9f, y = 1e9f;
                for (std::uint32_t index = 0; index < draw.index_count; ++index) {
                    const auto& vertex = frame.vertices[frame.indices[draw.first_index + index]];
                    x = std::min(x, vertex.x);
                    y = std::min(y, vertex.y);
                }
                if (x == left && y == top)
                    return &*found;
            }
            return nullptr;
        };
        const auto check_pixels = [&](const char* name, const std::array<double, 4>& button,
                                      double row_top, const std::vector<int>& expected) {
            static_cast<void>(record_ui_rml_frame(runtime, 640, 480));
            const int side = static_cast<int>(std::lround(button[2]));
            const auto* texture = drawn(side, static_cast<float>(std::round(button[0])),
                                        static_cast<float>(std::round(button[1] + row_top)));
            if (!texture) {
                ++failures;
                std::fprintf(stderr, "%s: no %dpx button drawn where Chromium paints it\n", name,
                             side);
                return;
            }
            const auto [mean, largest] = pixel_error(*texture, expected);
            if (mean > 1.0 || largest > 4) {
                ++failures;
                std::fprintf(stderr, "%s pixels: mean %.3f largest %d\n", name, mean, largest);
            }
        };

        // Geometry and paint: each field focused in turn shows its button.
        for (std::size_t index = 0; index < search_cases.size(); ++index) {
            const auto& item = search_cases[index];
            auto* field = element(fields[index]);
            field->Focus();
            update_ui_rml_runtime(runtime, 640, 480);
            auto* button = cancel_button(field);
            const auto origin = field->GetAbsoluteOffset(Rml::BoxArea::Border);
            const auto size = field->GetBox().GetSize(Rml::BoxArea::Border);
            const auto offset = button->GetAbsoluteOffset(Rml::BoxArea::Border) - origin;
            const auto side = button->GetBox().GetSize(Rml::BoxArea::Border);
            const std::array<double, 7> actual{
                size.x, size.y, offset.x, offset.y, side.x, side.y, field->GetClipAreaRightInset()};
            const std::array<double, 7> browser{item.field[2],
                                                item.field[3],
                                                item.button[0] - item.field[0],
                                                item.button[1] - item.field[1],
                                                item.button[2],
                                                item.button[3],
                                                item.reserve};
            for (std::size_t lane = 0; lane < actual.size(); ++lane)
                if (std::abs(actual[lane] - browser[lane]) > 0.02) {
                    ++failures;
                    std::fprintf(stderr,
                                 "case %zu: native field %g x %g, button at %g,%g sized %g x %g, "
                                 "reserve %g; browser %g x %g, %g,%g, %g x %g, %g\n",
                                 index, actual[0], actual[1], actual[2], actual[3], actual[4],
                                 actual[5], actual[6], browser[0], browser[1], browser[2],
                                 browser[3], browser[4], browser[5], browser[6]);
                    break;
                }
            check_pixels(("case " + std::to_string(index)).c_str(), item.button,
                         search_row_height * static_cast<double>(index), item.pixels);
        }

        auto* first = element(fields[0]);
        auto* button = cancel_button(first);
        const auto center = button->GetAbsoluteOffset(Rml::BoxArea::Border) +
                            button->GetBox().GetSize(Rml::BoxArea::Border) * .5f;
        const auto pointer = [&](bool over) {
            const int x = over ? static_cast<int>(center.x) : 600,
                      y = over ? static_cast<int>(center.y) : 470;
            runtime.context->ProcessMouseMove(x, y, 0);
            update_ui_rml_runtime(runtime, 640, 480);
            // The button takes the pointer once hovering the field shows it.
            runtime.context->ProcessMouseMove(x, y, 0);
        };
        const auto reset = [&](const char* value, bool focus) {
            ui_set_form_value(engine, fields[0], value);
            element(other)->Focus();
            if (focus)
                first->Focus();
            update_ui_rml_runtime(runtime, 640, 480);
            events.clear();
        };

        for (const auto& state : search_visibility) {
            ui_set_boolean_attribute(engine, fields[0], "disabled", state.disabled);
            reset(std::string(state.value).c_str(), state.focus);
            pointer(state.hover);
            update_ui_rml_runtime(runtime, 640, 480);
            const auto& computed = button->GetComputedValues();
            const bool shown = computed.opacity() == 1.f &&
                               computed.pointer_events() != Rml::Style::PointerEvents::None;
            if (shown != state.shown) {
                ++failures;
                std::fprintf(stderr, "visibility %s: native %d, browser %d\n",
                             std::string(state.name).c_str(), shown, state.shown);
            }
        }
        ui_set_boolean_attribute(engine, fields[0], "disabled", false);

        // Pressed: a press held on the button paints the pressed image.
        reset("abc", false);
        pointer(true);
        runtime.context->ProcessMouseButtonDown(0, 0);
        update_ui_rml_runtime(runtime, 640, 480);
        check_pixels("pressed", search_cases[0].button, 0, search_pressed_pixels);
        runtime.context->ProcessMouseButtonUp(0, 0);
        update_ui_rml_runtime(runtime, 640, 480);

        const auto expect = [&](const char* name, std::string_view browser) {
            if (events != browser) {
                ++failures;
                std::fprintf(stderr, "%s events: native '%s', browser '%s'\n", name, events.c_str(),
                             std::string(browser).c_str());
            }
        };
        const auto click = [&] {
            pointer(true);
            runtime.context->ProcessMouseButtonDown(0, 0);
            runtime.context->ProcessMouseButtonUp(0, 0);
            // The frame after the press projects its edit.
            update_ui_rml_runtime(runtime, 640, 480);
        };
        reset("abc", false);
        click();
        expect("click", search_click_events);
        if (ui_get_form_value(engine, fields[0]) != "" || !first->IsPseudoClassSet("focus")) {
            ++failures;
            std::fprintf(stderr, "click: the field is not emptied and focused\n");
        }
        reset("abc", true);
        runtime.context->ProcessKeyDown(Rml::Input::KI_ESCAPE, 0);
        update_ui_rml_runtime(runtime, 640, 480);
        expect("escape", search_escape_events);
        reset("", true);
        runtime.context->ProcessKeyDown(Rml::Input::KI_ESCAPE, 0);
        update_ui_rml_runtime(runtime, 640, 480);
        expect("escape-empty", search_escape_empty_events);
        reset("", true);
        click();
        expect("click-empty", search_click_empty_events);

        // Enter: typing then Enter fires search from a task after the key's own events.
        std::string before_task;
        pal::EventLoop loop;
        loop.run([&] {
            reset("", true);
            runtime.context->ProcessTextInput("q");
            runtime.context->ProcessKeyDown(Rml::Input::KI_RETURN, 0);
            before_task = events;
            // Enter's search task runs before this one.
            pal::EventLoop::current().post([&] { loop.close(); });
        });
        const auto searches = [](std::string_view log) {
            std::string result;
            for (std::size_t start = 0; start < log.size();) {
                const auto end = log.find(';', start) + 1;
                if (log.substr(start, 7) == "search:")
                    result += log.substr(start, end - start);
                start = end;
            }
            return result;
        };
        if (before_task.find("search:") != std::string::npos ||
            searches(events) != searches(search_enter_events)) {
            ++failures;
            std::fprintf(stderr, "enter events: native '%s' (before its task '%s'), browser '%s'\n",
                         events.c_str(), before_task.c_str(),
                         std::string(search_enter_events).c_str());
        }
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
    if (failures > 0) {
        std::fprintf(stderr, "%d search field checks differ from Chromium\n", failures);
        return 1;
    }
    return 0;
} catch (const std::exception& error) {
    std::fprintf(stderr, "%s\n", error.what());
    return 1;
}