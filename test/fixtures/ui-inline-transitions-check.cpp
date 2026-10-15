#include "pal_ui_rml.cpp"
#include <cassert>

namespace {
double fixture_time = 1000;
} // namespace

namespace bbl::pal {
std::string asset_path(std::string_view) {
    throw std::runtime_error("Unexpected fixture asset read");
}
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return fixture_time; }
} // namespace bbl::pal

namespace {
using namespace bbl;

void check(bool condition, const char* message) {
    if (!condition) {
        std::fprintf(stderr, "%s at %g ms\n", message, fixture_time);
        throw std::runtime_error(message);
    }
}

bool close_to(float actual, float expected, const char* what) {
    if (std::abs(actual - expected) <= .6f)
        return true;
    std::fprintf(stderr, "%s %.3f expected %.3f\n", what, actual, expected);
    return false;
}

// CSS cubic-bezier() in Bernstein form, solved by bisection.
double bezier(double x1, double y1, double x2, double y2, double x) {
    double low = 0, high = 1, s = 0.5;
    for (int i = 0; i < 100; ++i) {
        s = (low + high) / 2;
        const double sx = 3 * x1 * s * (1 - s) * (1 - s) + 3 * x2 * s * s * (1 - s) + s * s * s;
        (sx < x ? low : high) = s;
    }
    return 3 * y1 * s * (1 - s) * (1 - s) + 3 * y2 * s * s * (1 - s) + s * s * s;
}

struct EndCounter final : Rml::EventListener {
    int ended = 0;
    void ProcessEvent(Rml::Event&) override { ++ended; }
};

/** Whether any untextured draw of the recorded frame covers a window pixel's centre. */
bool covered(const pal::UiRenderFrame& frame, int px, int py) {
    const float x = float(px) + .5f, y = float(py) + .5f;
    for (const auto& draw : frame.draws)
        for (std::uint32_t i = draw.first_index; i + 2 < draw.first_index + draw.index_count + 1;
             i += 3) {
            const auto& a = frame.vertices[frame.indices[i]];
            const auto& b = frame.vertices[frame.indices[i + 1]];
            const auto& c = frame.vertices[frame.indices[i + 2]];
            const auto side = [&](const pal::UiRenderVertex& p, const pal::UiRenderVertex& q) {
                return (q.x - p.x) * (y - p.y) - (q.y - p.y) * (x - p.x);
            };
            const float ab = side(a, b), bc = side(b, c), ca = side(c, a);
            if ((ab >= 0 && bc >= 0 && ca >= 0) || (ab <= 0 && bc <= 0 && ca <= 0))
                return true;
        }
    return false;
}
} // namespace

int main() try {
    check(SDL_Init(SDL_INIT_VIDEO), "SDL initialization");
    auto* window = SDL_CreateWindow("Inline transitions fixture", 640, 480, SDL_WINDOW_HIDDEN);
    check(window != nullptr, "window");
    {
        Engine engine;
        const auto make = [&](const char* style, const char* classes) {
            auto h = ui_create_element(engine, "div");
            ui_set_attribute(engine, h, "style", style);
            ui_set_attribute(engine, h, "class", classes);
            ui_append_to_root(engine, h);
            return h;
        };
        const auto sheet = ui_create_element(engine, "style");
        ui_append_to_root(engine, sheet);
        ui_add_class_style(engine, sheet, "knob",
                           "position:absolute;top:0;left:0;width:10px;height:10px;"
                           "background-color:#ff0000;transition:left 100ms linear;");
        ui_add_class_style(engine, sheet, "fill",
                           "position:absolute;top:40px;left:0;width:100px;height:10px;"
                           "background-color:#00ff00;transition:clip-path 100ms linear;");
        ui_add_class_style(engine, sheet, "fade",
                           "position:absolute;top:80px;left:0;width:10px;height:10px;"
                           "transition:opacity 100ms ease-in 50ms;");
        ui_add_class_style(engine, sheet, "grow",
                           "position:absolute;top:120px;left:0;height:10px;"
                           "transition:width 100ms linear;");
        ui_add_class_style(engine, sheet, "pinned",
                           "position:absolute;top:160px;width:10px;height:10px;left:0;"
                           "transition:left 100ms linear;");
        ui_add_class_style(engine, sheet, "moved", "left:60px;");
        const auto knob = make("", "knob");
        const auto fill = make("clip-path:inset(0 50% 0 0);", "fill");
        const auto fade = make("", "fade");
        const auto grow = make("width:50px;", "grow");
        const auto pinned = make("left:30px;", "pinned");

        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        const auto raw = [&](auto h) { return runtime.projected_elements.at(h.value).element; };
        const auto at = [&](double milliseconds) {
            fixture_time = milliseconds;
            pal::update_ui_rml_runtime(runtime, 640, 480);
        };
        const auto left = [&](auto h) { return raw(h)->GetAbsoluteOffset(Rml::BoxArea::Border).x; };
        EndCounter knob_ends, pinned_ends;
        raw(knob)->AddEventListener(Rml::EventId::Transitionend, &knob_ends);
        raw(pinned)->AddEventListener(Rml::EventId::Transitionend, &pinned_ends);
        at(1000);

        // style.left = ... animates from the current value and keeps the declaration.
        ui_set_style_property(engine, knob, "left", "100px");
        at(1000);
        check(close_to(left(knob), 0, "knob start"),
              "an inline write starts from the current value");
        at(1050);
        check(close_to(left(knob), 50, "knob midpoint"), "the inline transition is linear");
        at(1100);
        at(1200);
        check(close_to(left(knob), 100, "knob end"), "the transition ends at the declaration");
        check(knob_ends.ended == 1, "transitionend fires once");
        at(1300);
        check(close_to(left(knob), 100, "knob kept") && knob_ends.ended == 1,
              "the declaration holds after the transition");

        // A write while running restarts from the running value; the replaced one never ends.
        ui_set_style_property(engine, knob, "left", "0px");
        at(1300);
        at(1325);
        check(close_to(left(knob), 75, "knob reversing"), "the new transition runs");
        ui_set_style_property(engine, knob, "left", "100px");
        at(1325);
        check(close_to(left(knob), 75, "knob reversed"),
              "a reversal starts from the running value");
        at(1500);
        check(close_to(left(knob), 100, "knob back") && knob_ends.ended == 2,
              "only the completed transition ends");

        // Removing the declaration transitions to the rule value.
        static_cast<void>(ui_remove_style_property(engine, knob, "left"));
        at(1500);
        at(1550);
        check(close_to(left(knob), 50, "knob removal"), "removal transitions to the rule value");
        at(1700);
        check(close_to(left(knob), 0, "knob rule") && knob_ends.ended == 3,
              "removal ends at the rule value");

        // A clip-path write animates between insets, like the slider fill.
        ui_set_style_property(engine, fill, "clip-path", "inset(0 0 0 0)");
        at(1700);
        at(1750);
        {
            const auto& frame = pal::record_ui_rml_frame(runtime, 640, 480);
            check(covered(frame, 70, 45) && !covered(frame, 80, 45),
                  "the clip-path is half-way at a 25% right inset");
        }
        at(1900);
        check(covered(pal::record_ui_rml_frame(runtime, 640, 480), 98, 45),
              "the clip-path ends uncovered");

        // Delay and easing come from the after-change transition list.
        ui_set_style_property(engine, fade, "opacity", "0");
        at(1900);
        at(1925);
        check(close_to(raw(fade)->GetComputedValues().opacity() * 100, 100, "fade delayed"),
              "the delay holds the start value");
        at(2000);
        const double eased = 1 - bezier(0.42, 0, 1, 1, 0.5);
        check(close_to(raw(fade)->GetComputedValues().opacity() * 100, float(eased * 100),
                       "fade eased"),
              "ease-in after the delay");
        at(2100);
        check(close_to(raw(fade)->GetComputedValues().opacity() * 100, 0, "fade end"),
              "the opacity ends at the declaration");

        // cssText replaces declarations through the style attribute.
        ui_set_attribute(engine, grow, "style", "width:100px;");
        at(2100);
        at(2150);
        check(close_to(raw(grow)->GetBox().GetSize().x, 75, "grow midpoint"),
              "a cssText write transitions");
        at(2300);
        check(close_to(raw(grow)->GetBox().GetSize().x, 100, "grow end"),
              "the cssText declaration holds");

        // A rule change under an inline declaration does not move the element.
        ui_toggle_class(engine, pinned, "moved", true);
        at(2300);
        at(2350);
        check(close_to(left(pinned), 30, "pinned") && pinned_ends.ended == 0,
              "an inline declaration wins over a changed rule without a transition");
        at(2500);
        check(close_to(left(pinned), 30, "pinned end"), "the inline declaration still holds");
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
} catch (const std::exception& error) {
    std::fprintf(stderr, "Inline transitions failure: %s\n", error.what());
    return 1;
}
