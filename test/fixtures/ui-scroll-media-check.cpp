#include "pal_ui_rml.cpp"

namespace bbl::pal {
std::string asset_path(std::string_view) {
    throw std::runtime_error("Unexpected fixture asset read");
}
std::string environment_variable(const char*) { return {}; }
double fixture_time_ms = 0;
double performance_milliseconds() { return fixture_time_ms; }
} // namespace bbl::pal

int main() try {
    using namespace bbl;
    const auto check = [](bool pass, const char* message) {
        if (!pass)
            throw std::runtime_error(message);
    };
    const auto expectNear = [&](float actual, float expected, const char* message) {
        if (std::abs(actual - expected) > 0.1f) {
            std::fprintf(stderr, "%s: %.3f != %.3f\n", message, actual, expected);
            check(false, message);
        }
    };
    check(SDL_Init(SDL_INIT_VIDEO), "SDL initialization");
    auto* window = SDL_CreateWindow("Scroll and media fixture", 640, 480, SDL_WINDOW_HIDDEN);
    check(window != nullptr, "Window creation");
    {
        Engine engine;
        const auto add = [&](const char* style, UiElementHandle parent = UiElementHandle{}) {
            auto value = ui_create_element(engine, "div");
            ui_set_attribute(engine, value, "style", style);
            if (parent.value == invalid_handle)
                ui_append_to_root(engine, value);
            else
                ui_append_child(engine, parent, value);
            return value;
        };
        const auto panel = add(
            "position:absolute;left:20px;top:20px;width:120px;height:100px;display:flex;align-content:start;");
        ui_set_attribute(engine, panel, "class", "panel");
        add("width:70px;height:20px;flex-shrink:0;", panel);
        const auto second = add("width:70px;height:20px;flex-shrink:0;", panel);
        const auto outer = add(
            "position:absolute;left:200px;top:20px;width:100px;height:100px;overflow:auto;pointer-events:auto;");
        const auto inner = add("width:80px;height:60px;overflow:auto;", outer);
        const auto leaf = add("width:20px;height:20px;overscroll-behavior:none;", inner);
        add("width:300px;height:300px;", outer);
        const auto gutter = add(
            "position:absolute;left:400px;top:20px;width:100px;height:80px;overflow-y:auto;scrollbar-gutter:stable;scrollbar-width:thin;");
        const auto gutter_content = add("height:20px;", gutter);
        const auto sheet = ui_create_element(engine, "style");
        ui_append_to_root(engine, sheet);
        ui_add_class_style(engine, sheet, "panel", "flex-wrap:nowrap;background-color:green;");
        ui_add_style_rule(engine, sheet, UiStyleSelectorKind::Class, "panel", {}, {}, false, 480,
                          "flex-wrap:wrap;margin-left:14px;text-align:right;background-color:red;");
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        const auto update = [&](int width = 640) {
            pal::fixture_time_ms += 100;
            pal::update_ui_rml_runtime(runtime, width, 480);
        };
        update();
        const auto raw = [&](UiElementHandle handle) {
            return runtime.projected_elements.at(handle.value).element;
        };
        expectNear(raw(second)->GetAbsoluteOffset().y, 20, "wide viewport stays on one flex line");
        update(400);
        expectNear(raw(second)->GetAbsoluteOffset().y, 40,
                   "media flex-wrap creates the second line");
        expectNear(raw(panel)->GetAbsoluteOffset().x, 34, "media physical margin applies");
        check(raw(panel)->GetComputedValues().text_align() == Rml::Style::TextAlign::Right,
              "media text alignment applies");
        check(raw(panel)->GetProperty(Rml::PropertyId::BackgroundColor)->Get<Rml::Colourb>().red ==
                  255,
              "media paint applies");
        update();
        expectNear(raw(panel)->GetAbsoluteOffset().x, 20, "wide viewport removes media margin");
        expectNear(raw(second)->GetAbsoluteOffset().y, 20, "wide viewport removes media wrapping");
        update(400);
        ui_remove(engine, sheet);
        update(400);
        expectNear(raw(panel)->GetAbsoluteOffset().x, 20,
                   "sheet removal restores layout inside the query");

        auto* raw_outer = raw(outer);
        auto* raw_inner = raw(inner);
        auto* raw_leaf = raw(leaf);
        Rml::Vector2f allowed;
        check(raw_leaf->GetClosestScrollableContainer({0, 1}, &allowed) == raw_outer,
              "visible leaf containment is ignored and auto passes a zero-extent scroller");
        ui_set_style_property(engine, inner, "overscroll-behavior-y", "contain");
        update();
        check(raw_leaf->GetClosestScrollableContainer({0, 1}, &allowed) == raw_inner &&
                  allowed.y == 0,
              "vertical containment consumes the empty scroller boundary");
        check(raw_leaf->GetClosestScrollableContainer({1, 1}, &allowed) == raw_outer &&
                  allowed == Rml::Vector2f(1, 0),
              "vertical containment preserves horizontal movement");
        runtime.context->SetDefaultScrollBehavior(Rml::ScrollBehavior::Instant, 1);
        runtime.context->ProcessMouseMove(205, 25, 0);
        runtime.context->ProcessMouseWheel(Rml::Vector2f{0, 1}, 0);
        expectNear(raw_outer->GetScrollTop(), 0, "contained wheel does not move the ancestor");
        runtime.context->ProcessMouseWheel(Rml::Vector2f{1, 1}, 0);
        check(raw_outer->GetScrollLeft() > 0, "other wheel axis scrolls");
        expectNear(raw_outer->GetScrollTop(), 0, "diagonal wheel retains vertical containment");
        raw_outer->SetScrollLeft(0);
        runtime.context->ProcessMouseMove(205, 25, 0);
        runtime.context->ProcessMouseButtonDown(2, 0);
        runtime.context->ProcessMouseMove(245, 65, 0);
        update();
        check(raw_outer->GetScrollLeft() > 0, "middle-button scrolling retains the allowed axis");
        expectNear(raw_outer->GetScrollTop(), 0,
                   "middle-button scrolling preserves axis containment");
        runtime.context->ProcessMouseButtonDown(2, 0);
        runtime.context->ProcessMouseButtonUp(2, 0);
        raw_outer->SetScrollLeft(0);
        runtime.context->ProcessTouchStart(Rml::TouchList{{1, {205, 25}}}, 0);
        pal::fixture_time_ms += 100;
        runtime.context->ProcessTouchMove(Rml::TouchList{{1, {195, 15}}}, 0);
        check(raw_outer->GetScrollLeft() > 0, "native touch scrolling retains the allowed axis");
        expectNear(raw_outer->GetScrollTop(), 0,
                   "native touch scrolling preserves axis containment");
        runtime.context->ProcessTouchEnd(Rml::TouchList{{1, {195, 15}}}, 0);
        update();
        expectNear(raw_outer->GetScrollTop(), 0, "touch inertia preserves axis containment");
        runtime.context->ProcessMouseWheel(Rml::Vector2f{0, 0}, 0);
        raw_outer->SetScrollLeft(0);
        ui_set_style_property(engine, inner, "overscroll-behavior", "none auto");
        update();
        check(raw_inner->GetComputedValues().overscroll_behavior_x() ==
                  Rml::Style::OverscrollBehavior::None,
              "shorthand first axis");
        check(raw_inner->GetComputedValues().overscroll_behavior_y() ==
                  Rml::Style::OverscrollBehavior::Auto,
              "shorthand second axis replaces earlier longhand");
        runtime.context->ProcessMouseMove(205, 25, 0);
        runtime.context->ProcessMouseWheel(Rml::Vector2f{0, 1}, 0);
        check(raw_outer->GetScrollTop() > 0, "auto restores ancestor wheel scrolling");
        ui_remove_style_property(engine, inner, "overscroll-behavior");
        update();
        check(raw_inner->GetComputedValues().overscroll_behavior_x() ==
                  Rml::Style::OverscrollBehavior::Auto,
              "shorthand removal restores both axes");

        auto* raw_gutter = raw(gutter);
        const auto scrollbar = [&] {
            return raw_gutter->GetElementScroll()->GetScrollbar(Rml::ElementScroll::VERTICAL);
        };
        expectNear(raw_gutter->GetClientWidth(), 92,
                   "stable gutter reserves the thin scrollbar width without overflow");
        expectNear(raw(gutter_content)->GetBox().GetSize().x, 92,
                   "block children use the reserved content width");
        check(scrollbar() && !scrollbar()->IsVisible(),
              "empty stable gutter has no scrollbar painting or hit target");
        ui_set_style_property(engine, gutter_content, "height", "200px");
        update();
        expectNear(raw_gutter->GetClientWidth(), 92, "overflow preserves stable content width");
        check(scrollbar()->IsVisible(), "overflow paints the reserved scrollbar");
        ui_set_style_property(engine, gutter_content, "height", "20px");
        update();
        expectNear(raw_gutter->GetClientWidth(), 92, "shrinking content retains the gutter");
        check(!scrollbar()->IsVisible(), "shrinking content hides the scrollbar");
        ui_set_style_property(engine, gutter, "overflow-y", "hidden");
        update();
        expectNear(raw_gutter->GetClientWidth(), 92, "hidden overflow retains a stable gutter");
        check(!scrollbar()->IsVisible(), "hidden overflow does not paint a scrollbar");
        ui_set_style_property(engine, gutter, "scrollbar-gutter", "auto");
        update();
        expectNear(raw_gutter->GetClientWidth(), 100, "auto releases the empty gutter");
        ui_set_style_property(engine, gutter, "display", "flex");
        ui_set_style_property(engine, gutter, "scrollbar-gutter", "stable");
        update();
        expectNear(raw_gutter->GetClientWidth(), 92, "flex layout reserves the same gutter");
        ui_set_style_property(engine, gutter, "scrollbar-width", "none");
        update();
        expectNear(raw_gutter->GetClientWidth(), 100, "hidden scrollbars reserve no gutter width");
        ui_set_style_property(engine, gutter, "scrollbar-width", "auto");
        ui_set_style_property(engine, gutter, "overflow", "visible");
        update();
        expectNear(raw_gutter->GetClientWidth(), 100,
                   "visible overflow ignores gutter reservation");
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
} catch (const std::exception& error) {
    std::fprintf(stderr, "Scroll/media failure: %s\n", error.what());
    return 1;
}
