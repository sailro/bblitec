#define main generated_main
#include "../../artifacts/ui-svg/program.hpp"
#undef main
#include "pal_ui_rml.cpp"
#include <cassert>

namespace bbl::pal {
std::string asset_path(std::string_view) { throw std::runtime_error("Unexpected SVG asset read"); }
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
    SDL_Window* window = SDL_CreateWindow("Retained SVG", 320, 240, SDL_WINDOW_HIDDEN);
    assert(window && generated_main() == 0);
    {
        auto& engine = pal::window_document_engine();
        const auto svg = ui_get_element_by_id(engine, "icon");
        const auto circle = ui_element(engine, svg).children.at(0);
        assert(ui_element(engine, svg).svg_namespace && ui_element(engine, circle).svg_namespace);
        assert(ui_get_attribute(engine, circle, "r") == "6");
        pal::UiRmlRuntime runtime(engine, window, 320, 240);
        auto* raw = runtime.projected_elements.at(svg.value).element;
        assert(raw && raw->GetNumChildren() == 0);
        {
            // Each glyph sits on the arc in the face the UI resolves; the stroke is drawn first.
            const auto labels = ui_get_element_by_id(engine, "labels");
            const auto& markup = runtime.projected_elements.at(labels.value).svg_markup;
            std::size_t texts = 0;
            for (auto at = markup.find("<text x=\""); at != std::string::npos;
                 at = markup.find("<text x=\"", at + 1))
                ++texts;
            if (texts != 2 || markup.find(">OAK</text>") == std::string::npos ||
                markup.find("font-family=\"bbl-svg-face-") == std::string::npos ||
                markup.find("rotate=\"") == std::string::npos ||
                markup.find("fill=\"#f6e4bc\"") == std::string::npos)
                throw std::runtime_error("SVG text on a path: " + markup);
        }
        const auto pixels = [&] {
            const auto& frame = pal::record_ui_rml_frame(runtime, 320, 240);
            std::vector<std::uint8_t> result;
            for (const auto& draw : frame.draws) {
                if (!draw.texture_id)
                    continue;
                const auto found = std::find_if(
                    frame.textures.begin(), frame.textures.end(),
                    [&](const auto& texture) { return texture.id == draw.texture_id; });
                assert(found != frame.textures.end() && found->rgba && !found->rgba->empty());
                result.insert(result.end(), found->rgba->begin(), found->rgba->end());
                for (auto i = draw.first_index; i < draw.first_index + draw.index_count; ++i) {
                    const auto& vertex = frame.vertices.at(frame.indices.at(i));
                    result.insert(result.end(),
                                  {vertex.red, vertex.green, vertex.blue, vertex.alpha});
                }
            }
            return result;
        };
        const auto red = pixels();
        assert(std::any_of(red.begin(), red.end(), [](auto value) { return value != 0; }));
        assert(raw->GetComputedValues().image_color() == Rml::Colourb(255, 0, 0));
        ui_set_style_property(engine, svg, "color", "rgb(0,0,255)");
        pal::update_ui_rml_runtime(runtime, 320, 240);
        const auto blue = pixels();
        assert(blue != red && raw->GetComputedValues().image_color() == Rml::Colourb(0, 0, 255));
        ui_set_attribute(engine, circle, "r", "10");
        pal::update_ui_rml_runtime(runtime, 320, 240);
        const auto bigger = pixels();
        assert(bigger != blue && runtime.projected_elements.at(svg.value).element == raw);
        const auto rectangle = ui_create_svg_element(engine, "rect");
        for (const auto& [name, value] :
             std::array<std::pair<const char*, const char*>, 5>{{{"x", "2"},
                                                                 {"y", "2"},
                                                                 {"width", "20"},
                                                                 {"height", "20"},
                                                                 {"fill", "currentColor"}}})
            ui_set_attribute(engine, rectangle, name, value);
        ui_replace_children(engine, svg);
        ui_append_child(engine, svg, rectangle);
        pal::update_ui_rml_runtime(runtime, 320, 240);
        assert(pixels() != bigger && ui_element(engine, circle).parent.value == invalid_handle);
        ui_set_attribute(engine, rectangle, "fill", "#00ff00");
        ui_set_attribute(engine, rectangle, "stroke", " NONE ");
        pal::update_ui_rml_runtime(runtime, 320, 240);
        const auto green = pixels();
        assert(!raw->HasAttribute("data-bbl-current-color") &&
               raw->GetComputedValues().image_color() == Rml::Colourb(255, 255, 255));
        ui_set_attribute(engine, svg, "viewBox", "0 0 48 48");
        pal::update_ui_rml_runtime(runtime, 320, 240);
        assert(pixels() != green);
        ui_remove_attribute(engine, svg, "viewbox");
        assert(ui_has_attribute(engine, svg, "viewBox"));
        int refusal = 0;
        const auto refuses = [&refusal](auto action) {
            ++refusal;
            bool failed = false;
            try {
                action();
            } catch (const std::runtime_error&) {
                failed = true;
            }
            if (!failed)
                throw std::runtime_error("refusal " + std::to_string(refusal) + " did not refuse");
        };
        refuses([&] { static_cast<void>(ui_computed_style(engine, rectangle, "display")); });
        refuses([&] { ui_set_attribute(engine, rectangle, "href", "remote.svg"); });
        refuses([&] { ui_set_attribute(engine, rectangle, "fill", "url(#paint)"); });
        for (const auto* paint : {"inherit", "UNSET", "initial", "revert", "revert-layer",
                                  "var(--paint)", "rgb(var(--red),0,0)", "context-fill"})
            refuses([&] { ui_set_attribute(engine, rectangle, "fill", paint); });
        const auto html = ui_create_element(engine, "div");
        refuses([&] { ui_set_attribute(engine, html, "HIDDEN", "until-found"); });
        const auto style = ui_create_element(engine, "style");
        ui_set_attribute(engine, rectangle, "class", "painted");
        // A rule may set presentation properties on a shape, nothing else.
        ui_add_class_style(engine, style, "painted", "transform:scale(2);");
        ui_append_to_root(engine, style);
        refuses([&] { pal::update_ui_rml_runtime(runtime, 320, 240); });
        ui_remove(engine, style);
        const auto paints = ui_create_element(engine, "style");
        ui_add_class_style(engine, paints, "painted",
                           "fill:#0000ff;stroke:currentColor;stroke-width:2px;paint-order:stroke;"
                           "opacity:0.5;");
        ui_append_to_root(engine, paints);
        pal::update_ui_rml_runtime(runtime, 320, 240);
        {
            // The rule overrides the fill attribute; currentColor beside it is the root's color;
            // a stroke painted first is its own copy under the fill.
            const auto& markup = runtime.projected_elements.at(svg.value).svg_markup;
            const auto count = [&](std::string_view needle) {
                std::size_t found = 0;
                for (auto at = markup.find(needle); at != std::string::npos;
                     at = markup.find(needle, at + 1))
                    ++found;
                return found;
            };
            if (count("<rect") != 2 || count("fill=\"#0000ff\"") != 1 ||
                count("stroke=\"rgba(0,0,255,1.000000)\"") != 1 || count("opacity=\"0.5\"") != 2 ||
                raw->HasAttribute("data-bbl-current-color"))
                throw std::runtime_error("SVG presentation cascade: " + markup);
        }
        ui_remove(engine, paints);
        // currentColor beside a literal paint draws the root's color.
        ui_append_child(engine, svg, circle);
        pal::update_ui_rml_runtime(runtime, 320, 240);
        {
            const auto& markup = runtime.projected_elements.at(svg.value).svg_markup;
            if (markup.find("fill=\"rgba(0,0,255,1.000000)\"") == std::string::npos ||
                markup.find("fill=\"#00ff00\"") == std::string::npos ||
                raw->HasAttribute("data-bbl-current-color"))
                throw std::runtime_error("SVG mixed currentColor: " + markup);
        }
        ui_remove(engine, circle);
        on_dom_pointer(engine, DomEventTarget::node(circle.value), "click", 1,
                       [](const PlatformMouseEvent&) {});
        ui_append_child(engine, svg, circle);
        pal::update_ui_rml_runtime(runtime, 320, 240);
        {
            // A shape takes the pointer over its painted area, the root's own box elsewhere.
            const auto origin = raw->GetAbsoluteOffset(Rml::BoxArea::Content);
            // The circle's centre in its root's user space; the root, without a listener of its
            // own, passes the pointer through its box elsewhere.
            Rml::Vector2f view_origin;
            const auto view = runtime.svg_viewport(svg, view_origin);
            const auto at = [&](double x, double y) {
                const auto box = view.to_box({x, y});
                return origin + Rml::Vector2f{static_cast<float>(box.x), static_cast<float>(box.y)};
            };
            auto* centre = runtime.context->GetElementAtPoint(at(12, 12));
            const auto centre_path = runtime.event_path(centre);
            auto* outside = runtime.context->GetElementAtPoint(at(1, 1));
            if (centre != raw || centre_path.front() != DomEventTarget::node(circle.value) ||
                centre_path.at(1) != DomEventTarget::node(svg.value) || outside == raw)
                throw std::runtime_error("SVG shape hit testing");
        }
        {
            // Glyph cells take the pointer under a root that does not; the arc's empty centre
            // passes through it. The textPath is the target, inside its text.
            const auto labels = ui_get_element_by_id(engine, "labels");
            const auto label = ui_element(engine, labels).children.at(1);
            const auto run = ui_element(engine, label).children.at(0);
            ui_set_style_property(engine, labels, "pointer-events", "none");
            ui_set_style_property(engine, label, "pointer-events", "auto");
            on_dom_pointer(engine, DomEventTarget::node(label.value), "pointerenter", 2,
                           [](const PlatformMouseEvent&) {});
            static_cast<void>(ui_get_client_rect(engine, label));
            pal::update_ui_rml_runtime(runtime, 320, 240);
            auto* labels_raw = runtime.projected_elements.at(labels.value).element;
            const auto origin = labels_raw->GetAbsoluteOffset(Rml::BoxArea::Content);
            // The user origin is the box centre; the label's baseline crosses the arc's top.
            auto* glyph = runtime.context->GetElementAtPoint(origin + Rml::Vector2f{50, 6});
            const auto path = runtime.event_path(glyph);
            if (glyph != labels_raw || path.size() < 3 ||
                path[0] != DomEventTarget::node(run.value) ||
                path[1] != DomEventTarget::node(label.value) ||
                path[2] != DomEventTarget::node(labels.value))
                throw std::runtime_error("SVG glyph hit testing");
            if (runtime.context->GetElementAtPoint(origin + Rml::Vector2f{50, 50}) == labels_raw)
                throw std::runtime_error("SVG root pointer-events none takes the pointer");
            // Its bounding box is the glyphs' bounds: about the arc's top, no client box.
            const auto& rect = ui_element(engine, label).client_rect;
            if (!(rect.offset_width > 10 && rect.offset_width < 60 && rect.offset_height > 6 &&
                  rect.left > origin.x + 15 && rect.left + rect.offset_width < origin.x + 85 &&
                  rect.top < origin.y + 10 && rect.top + rect.offset_height > origin.y + 10 &&
                  rect.width == 0))
                throw std::runtime_error("SVG text bounds");
            ui_set_style_property(engine, labels, "pointer-events", "");
            ui_set_style_property(engine, label, "pointer-events", "");
        }
        ui_remove(engine, circle);
        ui_remove(engine, svg);
        pal::update_ui_rml_runtime(runtime, 320, 240);
        assert(!runtime.projected_elements.at(svg.value).element);
        // A percentage viewport is the root's size only under an author size.
        const auto flag = ui_create_element(engine, "span");
        ui_append_to_root(engine, flag);
        ui_set_inner_rml(
            engine, flag,
            "<svg class=\"flag\" viewBox=\"0 0 60 30\" data-bbl-viewport-width=\"100%\" "
            "preserveAspectRatio=\"none\"><rect width=\"60\" height=\"30\"/></svg>");
        bool refused = false;
        try {
            pal::update_ui_rml_runtime(runtime, 320, 240);
        } catch (const std::runtime_error&) {
            refused = true;
        }
        if (!refused)
            throw std::runtime_error("An unsized percentage viewport must refuse");
        const auto flag_style = ui_create_element(engine, "style");
        ui_append_to_root(engine, flag_style);
        ui_add_class_style(engine, flag_style, "flag", "display:block;width:18px;height:12px;");
        pal::update_ui_rml_runtime(runtime, 320, 240);
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
}

int main() {
    try {
        return run();
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
