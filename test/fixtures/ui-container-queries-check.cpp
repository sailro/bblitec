#include "pal_ui_rml.cpp"

namespace bbl::pal {
std::string asset_path(std::string_view) {
    throw std::runtime_error("Unexpected fixture asset read");
}
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
} // namespace bbl::pal

int main() try {
    using namespace bbl;
    const auto check = [](bool result, const char* message) {
        if (!result)
            throw std::runtime_error(message);
    };
    const auto expect = [&](float actual, float wanted, const char* message) {
        if (std::abs(actual - wanted) > .1f) {
            std::fprintf(stderr, "%s: %.3f != %.3f\n", message, actual, wanted);
            check(false, message);
        }
    };
    check(SDL_Init(SDL_INIT_VIDEO), "SDL initialization");
    auto* window = SDL_CreateWindow("Container query fixture", 640, 480, SDL_WINDOW_HIDDEN);
    check(window != nullptr, "Window creation");
    {
        Engine engine;
        const auto make = [&](const char* style, const char* classes = "") {
            auto h = ui_create_element(engine, "div");
            ui_set_attribute(engine, h, "style", style);
            ui_set_attribute(engine, h, "class", classes);
            return h;
        };
        const auto sheet = ui_create_element(engine, "style");
        ui_append_to_root(engine, sheet);
        ui_add_class_style(engine, sheet, "cell", "height:20px;width:40px;background:blue;");
        ui_add_style_rule(engine, sheet, UiStyleSelectorKind::CompoundClass, "cell", "special", {},
                          false, -1, "width:90px;");
        ui_add_style_rule(engine, sheet, UiStyleSelectorKind::Class, "cell", {}, {}, false, -1,
                          "width:80px;background:red;", UiScrollbarPart::None, false, false,
                          UiMotionPreference::Any, {}, UiGeneratedPart::None, {}, UiRangePart::None,
                          320);
        ui_add_style_rule(engine, sheet, UiStyleSelectorKind::Class, "cell", {}, {}, false, -1,
                          "--bbl-crosshair:#123456;", UiScrollbarPart::None, false, false,
                          UiMotionPreference::Any, {}, UiGeneratedPart::None, {}, UiRangePart::None,
                          250);
        ui_add_style_rule(engine, sheet, UiStyleSelectorKind::Sequence, ".marker", {}, {}, false,
                          -1, "display:block;width:7px;height:9px;background:green;",
                          UiScrollbarPart::None, false, false, UiMotionPreference::Any,
                          {{UiSelectorRelation::Self, {{UiSelectorTestKind::Class, "marker", {}}}}},
                          UiGeneratedPart::Before,
                          UiGeneratedContent{true, {{UiContentPartKind::Text, "!"}}},
                          UiRangePart::None, 320);
        const auto outer = make(
            "position:absolute;left:10px;top:10px;width:400px;padding:20px;container-type:inline-size;");
        ui_set_attribute(engine, outer, "class", "marker");
        const auto child = make("", "cell");
        ui_append_child(engine, outer, child);
        const auto inner = make("width:200px;container-type:inline-size;");
        ui_append_child(engine, outer, inner);
        const auto grandchild = make("", "cell");
        ui_append_child(engine, inner, grandchild);
        ui_append_to_root(engine, outer);
        const auto orphan = make("position:absolute;left:460px;top:10px;", "cell");
        ui_append_to_root(engine, orphan);
        const auto intrinsic = make(
            "position:absolute;left:10px;top:200px;display:inline-block;container-type:inline-size;padding:5px;");
        const auto wide = make("width:500px;height:25px;margin-top:10px;");
        ui_append_child(engine, intrinsic, wide);
        ui_append_to_root(engine, intrinsic);
        const auto flex = make("position:absolute;left:10px;top:300px;display:flex;width:300px;");
        const auto grow = make("container-type:inline-size;flex:1 1 0;min-width:0;");
        const auto fixed = make("width:100px;height:20px;flex-shrink:0;");
        ui_append_child(engine, grow, make("width:600px;height:30px;"));
        ui_append_child(engine, flex, grow);
        ui_append_child(engine, flex, fixed);
        ui_append_to_root(engine, flex);
        const auto inline_flex = make(
            "position:absolute;left:350px;top:300px;display:inline-flex;min-width:60px;container-type:inline-size;");
        ui_append_child(engine, inline_flex, make("width:500px;height:20px;"));
        ui_append_to_root(engine, inline_flex);
        const auto inline_grid = make(
            "position:absolute;left:450px;top:300px;display:inline-grid;width:80px;grid-template-columns:1fr;container-type:inline-size;");
        ui_append_child(engine, inline_grid, make("width:500px;height:20px;"));
        ui_append_to_root(engine, inline_grid);
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        const auto raw = [&](UiElementHandle h) {
            return runtime.projected_elements.at(h.value).element;
        };
        const auto update = [&](int width = 640) {
            pal::update_ui_rml_runtime(runtime, width, 480);
        };
        const auto before = [&]() {
            for (int i = 0; i < raw(outer)->GetNumChildren(); ++i)
                if (raw(outer)->GetChild(i)->GetPseudoElement() ==
                    Rml::Element::PseudoElement::Before)
                    return raw(outer)->GetChild(i);
            return static_cast<Rml::Element*>(nullptr);
        };
        update();
        expect(raw(child)->GetClientWidth(), 40, "wide parent does not match");
        check(before() == nullptr, "generated content does not match a wide originating container");
        expect(raw(grandchild)->GetClientWidth(), 80, "nearest narrow container matches");
        expect(raw(orphan)->GetClientWidth(), 40, "no ancestor does not match the viewport");
        expect(raw(intrinsic)->GetBox().GetSize().x, 0,
               "inline containment excludes intrinsic child width");
        expect(raw(intrinsic)->GetBox().GetSize().y, 35,
               "inline containment retains content height and prevents margin collapse");
        expect(raw(grow)->GetBox().GetSize().x, 200,
               "flex inline containment does not use child max-content");
        expect(raw(inline_flex)->GetBox().GetSize().x, 60,
               "intrinsic containment retains an explicit minimum");
        expect(raw(inline_grid)->GetBox().GetSize().x, 80,
               "intrinsic containment retains an explicit width");
        ui_set_style_property(engine, outer, "width", "320px");
        update();
        expect(raw(child)->GetClientWidth(), 80,
               "inclusive query uses content box without padding");
        ui_set_style_property(engine, outer, "width", "240px");
        update();
        check(!runtime.projected_elements.at(child.value).crosshair_color.empty(),
              "query-dependent private presentation observes settled geometry");
        ui_set_style_property(engine, outer, "width", "260px");
        update();
        check(runtime.projected_elements.at(child.value).crosshair_color.empty(),
              "private-only query thresholds invalidate presentation");
        ui_set_style_property(engine, outer, "width", "320px");
        update();
        check(before() != nullptr, "pseudo-elements can query their originating container");
        expect(before()->GetClientWidth(), 7,
               "generated content and native styles share container conditions");
        ui_set_attribute(engine, child, "class", "cell special");
        update();
        expect(raw(child)->GetClientWidth(), 90,
               "container condition adds no selector specificity");
        ui_set_attribute(engine, child, "class", "cell");
        update();
        ui_set_style_property(engine, inner, "width", "380px");
        update();
        expect(raw(grandchild)->GetClientWidth(), 40,
               "nearest wide container prevents matching an outer narrow one");
        ui_set_style_property(engine, inner, "container-type", "normal");
        update();
        expect(raw(grandchild)->GetClientWidth(), 80,
               "container type reset exposes the outer container");
        expect(static_cast<float>(ui_get_client_rect(engine, grandchild).width), 80,
               "synchronous DOM measurement sees the settled query result");
        ui_set_style_property(engine, inner, "container-type", "inline-size");
        update();
        expect(raw(grandchild)->GetClientWidth(), 40,
               "container type restoration selects the nearest ancestor");
        ui_set_style_property(engine, inner, "display", "inline");
        update();
        expect(raw(grandchild)->GetClientWidth(), 80,
               "non-atomic inline boxes do not establish size containers");
        ui_set_style_property(engine, inner, "display", "block");
        update();
        expect(raw(grandchild)->GetClientWidth(), 40,
               "display restoration restores size containment");
        ui_set_style_property(engine, outer, "width", "321px");
        update();
        expect(raw(child)->GetClientWidth(), 40, "query reverts after container resize");
        check(before() == nullptr,
              "generated content is removed when a container query stops matching");
        ui_set_style_property(engine, outer, "width", "320px");
        update(1200);
        expect(raw(child)->GetClientWidth(), 80,
               "viewport changes do not replace containing-block queries");
        ui_remove(engine, sheet);
        update();
        expect(raw(child)->GetClientWidth(), 320, "sheet removal restores ordinary block width");
        ui_append_to_root(engine, sheet);
        update();
        expect(raw(child)->GetClientWidth(), 80, "sheet reattachment restores conditions");
        check(raw(child)->GetParentNode() == raw(outer),
              "container queries retain authored parent identity");
        raw(outer)->SetProperty("width", "240px");
        update();
        check(!runtime.projected_elements.at(child.value).crosshair_color.empty(),
              "native size changes invalidate private query presentation without a DOM write");
        raw(outer)->SetProperty("width", "321px");
        update();
        check(before() == nullptr, "native size changes remove conditional generated content");
        expect(static_cast<float>(ui_get_client_rect(engine, child).width), 40,
               "native query changes refresh cached DOM geometry");
        raw(outer)->SetProperty("width", "320px");
        update();
        runtime.context->SetDensityIndependentPixelRatio(2.f);
        runtime.context->Update();
        expect(raw(child)->GetClientWidth(), 160,
               "container thresholds and widths share density-independent units");
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
} catch (const std::exception& error) {
    std::fprintf(stderr, "%s\n", error.what());
    return 1;
}
