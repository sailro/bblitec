#include "pal_ui_rml.cpp"
#include "pal_platform_events.hpp"
#include "finger-events.hpp"
#include <cmath>
#include <cstdio>

namespace {
std::string diagnostic_insets;
int diagnostic_reads = 0;
} // namespace

namespace bbl::pal {
std::string asset_path(std::string_view) {
    throw std::runtime_error("Unexpected fixture asset read");
}
std::string environment_variable(const char* name) {
    if (std::string_view(name) != "BBLITE_SAFE_AREA_INSETS")
        return {};
    ++diagnostic_reads;
    return diagnostic_insets;
}
double performance_milliseconds() { return 0; }
} // namespace bbl::pal

int main() try {
    using namespace bbl;
    const auto check = [](bool pass, const char* message) {
        if (!pass)
            throw std::runtime_error(message);
    };
    {
        Engine first, second;
        diagnostic_insets = "1,2,3,4";
        check(pal::diagnostic_safe_area_insets(first) == std::array{1, 2, 3, 4},
              "the runtime owns its diagnostic safe-area snapshot");
        diagnostic_insets = "4,3,2,1";
        check(pal::diagnostic_safe_area_insets(first) == std::array{1, 2, 3, 4} &&
                  diagnostic_reads == 1,
              "window updates do not reread diagnostic environment state");
        check(pal::diagnostic_safe_area_insets(second) == std::array{4, 3, 2, 1} &&
                  diagnostic_reads == 2,
              "independent runtimes do not share a process-global override");
        diagnostic_insets.clear();
    }
    const pal::UiSafeAreaInsets notch{44, 0, 34, 0};
    check(pal::rml_css_environment("calc(90px + env(safe-area-inset-bottom))", notch) ==
              "calc(90px + 34.000000px)",
          "a safe-area inset is the window's");
    check(pal::rml_css_environment("max(12px, env( safe-area-inset-top , 1px ))", notch) ==
              "max(12px, 44.000000px)",
          "a defined variable ignores its fallback");
    check(pal::rml_css_environment("env(keyboard-inset-height, env(safe-area-inset-left, 3px))",
                                   notch) == "0.000000px",
          "an undefined variable takes its fallback");
    check(pal::rml_css_environment("content:'env(x)'", notch) == "content:'env(x)'",
          "strings keep their text");
    bool refused = false;
    try {
        static_cast<void>(pal::rml_css_environment("env(titlebar-area-x)", notch));
    } catch (const std::runtime_error&) {
        refused = true;
    }
    check(refused, "an undefined variable without a fallback refuses");

    check(SDL_Init(SDL_INIT_VIDEO), "SDL initialization");
    SDL_Window* window = SDL_CreateWindow("UI environment fixture", 640, 480, SDL_WINDOW_HIDDEN);
    check(window != nullptr, "Window creation");
    // A window with unsafe edges: `viewport-fit=auto` lays the page out in the safe rectangle,
    // which the window letterboxes with the page's canvas background; `cover` spans the window.
    for (const bool cover : {false, true}) {
        Engine engine;
        engine.ui_viewport_fit_cover = cover;
        const auto sheet = ui_create_element(engine, "style");
        ui_add_style_rule(engine, sheet,
                          UiStyleRule{.selector = UiStyleSelectorKind::Sequence,
                                      .primary = "body",
                                      .style = "margin:0;height:100vh;background-color:#204060;",
                                      .sequence = {{UiSelectorRelation::Self,
                                                    {{UiSelectorTestKind::Tag, "body", ""}}}}});
        ui_append_to_root(engine, sheet);
        const auto bar = ui_create_element(engine, "div");
        ui_set_style_property(engine, bar, "position", "absolute");
        ui_set_style_property(engine, bar, "left", "0");
        ui_set_style_property(engine, bar, "top", "0");
        ui_set_style_property(engine, bar, "width", "100vw");
        ui_set_style_property(engine, bar, "height", "10px");
        ui_set_style_property(engine, bar, "background-color", "#ff0000");
        // Retained elements are hit targets only where the page makes them one.
        ui_set_style_property(engine, bar, "pointer-events", "auto");
        ui_append_to_root(engine, bar);
        const auto canvas = ui_create_element(engine, "canvas");
        ui_set_style_property(engine, canvas, "position", "absolute");
        ui_set_style_property(engine, canvas, "left", "100px");
        ui_set_style_property(engine, canvas, "top", "50px");
        ui_set_style_property(engine, canvas, "width", "200px");
        ui_set_style_property(engine, canvas, "height", "100px");
        ui_append_to_root(engine, canvas);
        ui_element(engine, canvas).client_rect_requested = true;
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        // A phone's safe rectangle: 40 px in from the sides, 20 from the top and the bottom.
        pal::update_engine_canvas_metrics(engine, 640, 480, 1, 1,
                                          pal::WindowSafeArea{{40, 20, 560, 440}, 640, 480});
        pal::update_ui_rml_runtime(runtime, 640, 480);
        const PixelViewport page =
            cover ? PixelViewport{0, 0, 640, 480} : PixelViewport{40, 20, 560, 440};
        check(engine.ui_page_viewport.pixels == page,
              "the page viewport is the safe rectangle under auto, the window under cover");
        check(engine.canvas_client_width == page.width &&
                  engine.canvas_client_height == page.height,
              "the client extent is the page viewport's");
        check(runtime.context->GetDimensions() == Rml::Vector2i{page.width, page.height},
              "the document lays out in the page viewport");
        const auto bar_size = runtime.projected_elements.at(bar.value).element->GetBox().GetSize(
            Rml::BoxArea::Border);
        check(std::abs(bar_size.x - static_cast<float>(page.width)) < .01f,
              "viewport units measure the page viewport");
        // Engine canvases present from the viewport's origin.
        check(presented_canvas_rect(ui_element(engine, canvas), engine.ui_page_viewport, 640,
                                    480) == PixelViewport{page.x + 100, page.y + 50, 200, 100},
              "a canvas presents at its layout box from the viewport's origin");
        // Paint: the page's draws move to the origin; the letterbox shows the canvas
        // background (the body's, over white) around a page inside the safe area.
        const pal::UiRenderFrame& frame = pal::record_ui_rml_frame(runtime, 640, 480);
        check(frame.width == 640 && frame.height == 480, "the frame is the window's");
        float bar_left = 1e9f, bar_top = 1e9f;
        bool letterbox_painted = false;
        for (const auto& draw : frame.draws)
            for (std::uint32_t index = draw.first_index;
                 index < draw.first_index + draw.index_count; ++index) {
                const auto& vertex = frame.vertices[frame.indices[index]];
                if (vertex.red == 255 && vertex.green == 0 && vertex.blue == 0) {
                    bar_left = std::min(bar_left, vertex.x);
                    bar_top = std::min(bar_top, vertex.y);
                }
                if (vertex.red == 0x20 && vertex.green == 0x40 && vertex.blue == 0x60 &&
                    vertex.alpha == 255 && (vertex.x < page.x || vertex.y < page.y))
                    letterbox_painted = true;
                check(draw.scissor_x >= 0 && draw.scissor_y >= 0, "scissors stay in the frame");
            }
        check(bar_left == static_cast<float>(page.x) && bar_top == static_cast<float>(page.y),
              "page geometry draws from the viewport's origin");
        check(letterbox_painted != cover, "only a page inside the safe area is letterboxed");
        // Hit testing: input arrives in window coordinates and reaches the page from the
        // viewport's origin.
        const auto window_id = SDL_GetWindowID(window);
        const auto pointer = [&](SDL_EventType type, float x, float y) {
            SDL_Event event{};
            event.type = type;
            if (type == SDL_EVENT_MOUSE_MOTION) {
                event.motion.windowID = window_id;
                event.motion.x = x;
                event.motion.y = y;
            } else if (type == SDL_EVENT_MOUSE_WHEEL) {
                event.wheel.windowID = window_id;
                event.wheel.mouse_x = x;
                event.wheel.mouse_y = y;
            } else {
                event.button.windowID = window_id;
                event.button.button = SDL_BUTTON_LEFT;
                event.button.down = type == SDL_EVENT_MOUSE_BUTTON_DOWN;
                event.button.x = x;
                event.button.y = y;
            }
            return event;
        };
        const auto touch = [&](SDL_EventType type, SDL_FingerID finger, float x, float y) {
            return finger_event(type, 7, finger, x / 640.0f, y / 480.0f, window_id);
        };
        auto motion = pointer(SDL_EVENT_MOUSE_MOTION, page.x + 5.0f, page.y + 5.0f);
        check(pal::page_platform_event(engine, motion) && motion.motion.x == 5 &&
                  motion.motion.y == 5,
              "pointers move into the page");
        check(runtime.context->GetElementAtPoint(Rml::Vector2f{motion.motion.x, motion.motion.y} *
                                                 runtime.density_ratio) ==
                  runtime.projected_elements.at(bar.value).element,
              "a pointer over the bar hits it");
        auto finger = touch(SDL_EVENT_FINGER_DOWN, 1, page.x + 280.0f, page.y + 110.0f);
        finger.tfinger.dx = 56.0f / 640.0f;
        check(pal::page_platform_event(engine, finger) &&
                  std::abs(finger.tfinger.x * page.width - 280) < .01f &&
                  std::abs(finger.tfinger.y * page.height - 110) < .01f &&
                  std::abs(finger.tfinger.dx * page.width - 56) < .01f,
              "touches are fractions of the page viewport");
        // Under auto the page receives no press, touch or wheel in the letterbox; a press it
        // received keeps its moves and release outside, as pointer and touch capture do.
        const auto receives = [&](SDL_Event event) {
            return pal::page_platform_event(engine, event);
        };
        const bool letterbox = !cover;
        check(receives(pointer(SDL_EVENT_MOUSE_MOTION, 10, 10)) == !letterbox,
              "a pointer in the letterbox moves outside the page");
        check(receives(pointer(SDL_EVENT_MOUSE_WHEEL, 10, 10)) == !letterbox,
              "a wheel in the letterbox reaches no page");
        check(receives(pointer(SDL_EVENT_MOUSE_BUTTON_DOWN, 10, 10)) == !letterbox &&
                  receives(pointer(SDL_EVENT_MOUSE_MOTION, page.x + 5.0f, page.y + 5.0f)) &&
                  receives(pointer(SDL_EVENT_MOUSE_BUTTON_UP, page.x + 5.0f, page.y + 5.0f)) ==
                      !letterbox,
              "a press in the letterbox keeps no release");
        check(receives(pointer(SDL_EVENT_MOUSE_BUTTON_DOWN, page.x + 5.0f, page.y + 5.0f)) &&
                  receives(pointer(SDL_EVENT_MOUSE_MOTION, 10, 10)) &&
                  receives(pointer(SDL_EVENT_MOUSE_BUTTON_UP, 10, 10)) &&
                  receives(pointer(SDL_EVENT_MOUSE_MOTION, 10, 10)) == !letterbox,
              "a press the page received keeps its moves and release outside");
        check(receives(touch(SDL_EVENT_FINGER_UP, 1, 10, 10)),
              "a touch the page received keeps its release outside");
        check(receives(touch(SDL_EVENT_FINGER_DOWN, 2, 10, 10)) == !letterbox &&
                  receives(touch(SDL_EVENT_FINGER_MOTION, 2, page.x + 5.0f, page.y + 5.0f)) ==
                      !letterbox &&
                  receives(touch(SDL_EVENT_FINGER_UP, 2, page.x + 5.0f, page.y + 5.0f)) ==
                      !letterbox,
              "a touch in the letterbox reaches no page");
        check(receives(touch(SDL_EVENT_FINGER_DOWN, 3, page.x + 5.0f, page.y + 5.0f)) &&
                  receives(touch(SDL_EVENT_FINGER_MOTION, 3, 10, 10)) &&
                  receives(touch(SDL_EVENT_FINGER_UP, 3, 10, 10)),
              "a touch the page received keeps its moves and release outside");
        // A 2D-host page: its text and sprite contexts draw the page's canvas in the page
        // viewport, the whole window under cover, which an authored canvas filling the page
        // presents in exactly.
        const PageCanvas drawn = page_canvas(engine.ui_page_viewport, 640, 480);
        check(drawn.letterboxed == letterbox && drawn.rect == page,
              "2D contexts draw in the safe rectangle under auto and the window under cover");
        ui_set_style_property(engine, canvas, "left", "0");
        ui_set_style_property(engine, canvas, "top", "0");
        ui_set_style_property(engine, canvas, "width", "100vw");
        ui_set_style_property(engine, canvas, "height", "100vh");
        pal::update_ui_rml_runtime(runtime, 640, 480);
        check(presented_canvas_rect(ui_element(engine, canvas), engine.ui_page_viewport, 640,
                                    480) == drawn.rect,
              "a canvas filling the page presents where 2D contexts draw");
        // env() reports the insets only under cover.
        check(pal::rml_css_environment("env(safe-area-inset-left)", runtime.read_safe_area()) ==
                  (cover ? "40.000000px" : "0.000000px"),
              "env() insets are the window's under cover only");
    }
    {
        // A page without env() reads no safe area.
        Engine engine;
        engine.ui_viewport_fit_cover = true;
        const auto panel = ui_create_element(engine, "div");
        ui_set_style_property(engine, panel, "width", "calc(40px + 2px)");
        ui_append_to_root(engine, panel);
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        check(!runtime.safe_area_insets, "a page without env() reads no safe area");
    }
    {
        Engine engine;
        engine.ui_viewport_fit_cover = true;
        const auto sheet = ui_create_element(engine, "style");
        ui_add_class_style(engine, sheet, "bar",
                           "padding:0 max(14px, env(safe-area-inset-right)) "
                           "max(12px, env(safe-area-inset-bottom)) 0;height:10px;");
        ui_append_to_root(engine, sheet);
        const auto bar = ui_create_element(engine, "div");
        ui_set_attribute(engine, bar, "class", "bar");
        ui_set_style_property(engine, bar, "width", "calc(40px + env(safe-area-inset-left))");
        ui_append_to_root(engine, bar);
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        pal::update_engine_canvas_metrics(engine, 640, 480, 1, 1,
                                          pal::window_safe_area(window, engine));
        pal::update_ui_rml_runtime(runtime, 640, 480);
        // A desktop window's safe area is the whole window, as a desktop
        // browser's insets are zero.
        check(runtime.safe_area_insets && *runtime.safe_area_insets == pal::UiSafeAreaInsets{},
              "a desktop window has no insets");
        const auto size = runtime.projected_elements.at(bar.value).element->GetBox().GetSize(
            Rml::BoxArea::Border);
        if (std::abs(size.x - 54) >= .01f || std::abs(size.y - 22) >= .01f)
            std::fprintf(stderr, "bar %gx%g\n", size.x, size.y);
        check(std::abs(size.x - 54) < .01f && std::abs(size.y - 22) < .01f,
              "rule and inline style env() resolve before their math");
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
} catch (const std::exception& error) {
    std::fprintf(stderr, "UI environment failure: %s\n", error.what());
    return 1;
}
