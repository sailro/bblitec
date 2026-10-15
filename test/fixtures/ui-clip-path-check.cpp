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
using pal::UiLayerComposite;
using pal::UiRenderFrame;
using pal::UiRenderTexture;
using pal::UiRenderVertex;

void check(bool condition, const char* message) {
    if (!condition) {
        std::fprintf(stderr, "%s\n", message);
        throw std::runtime_error(message);
    }
}

bool inside(const UiRenderVertex& a, const UiRenderVertex& b, const UiRenderVertex& c, float x,
            float y) {
    const auto side = [&](const UiRenderVertex& p, const UiRenderVertex& q) {
        return (q.x - p.x) * (y - p.y) - (q.y - p.y) * (x - p.x);
    };
    const float ab = side(a, b), bc = side(b, c), ca = side(c, a);
    return (ab >= 0 && bc >= 0 && ca >= 0) || (ab <= 0 && bc <= 0 && ca <= 0);
}

/**
 * The paint a recorded layer receives at a window pixel's centre: whether any
 * draw's geometry covers it, and the premultiplied colour its draws composite
 * in order (vertex colour times the nearest texel). Both GPU backends
 * rasterize this geometry as recorded, so this is their coverage.
 */
struct Paint {
    bool covered = false;
    float red = 0, green = 0, blue = 0, alpha = 0;
};
Paint paint_at(const UiRenderFrame& frame, int px, int py, std::uint32_t layer = 0) {
    const float x = float(px) + .5f, y = float(py) + .5f;
    Paint paint;
    for (const auto& draw : frame.draws) {
        if (draw.layer != layer || x < float(draw.scissor_x) || y < float(draw.scissor_y) ||
            x >= float(draw.scissor_x) + float(draw.scissor_width) ||
            y >= float(draw.scissor_y) + float(draw.scissor_height))
            continue;
        const UiRenderTexture* texture = nullptr;
        for (const auto& candidate : frame.textures)
            if (draw.texture_id != 0 && candidate.id == draw.texture_id)
                texture = &candidate;
        for (std::uint32_t i = draw.first_index; i + 2 < draw.first_index + draw.index_count + 1;
             i += 3) {
            const auto& a = frame.vertices[frame.indices[i]];
            const auto& b = frame.vertices[frame.indices[i + 1]];
            const auto& c = frame.vertices[frame.indices[i + 2]];
            if (!inside(a, b, c, x, y))
                continue;
            paint.covered = true;
            const float area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
            if (std::abs(area) < 1e-6f)
                continue;
            const float wb = ((x - a.x) * (c.y - a.y) - (y - a.y) * (c.x - a.x)) / area;
            const float wc = ((b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x)) / area;
            const float wa = 1 - wb - wc;
            std::array<float, 4> texel{1, 1, 1, 1};
            if (texture && texture->rgba && texture->width && texture->height) {
                const float u = wa * a.u + wb * b.u + wc * c.u, v = wa * a.v + wb * b.v + wc * c.v;
                const auto column = std::clamp<std::int64_t>(
                    std::int64_t(u * float(texture->width)), 0, texture->width - 1);
                const auto row = std::clamp<std::int64_t>(std::int64_t(v * float(texture->height)),
                                                          0, texture->height - 1);
                const auto offset = std::size_t(row * texture->width + column) * 4;
                for (std::size_t channel = 0; channel < 4; ++channel)
                    texel[channel] = texture->rgba->at(offset + channel) / 255.f;
            }
            const float red = a.red / 255.f * texel[0], green = a.green / 255.f * texel[1];
            const float blue = a.blue / 255.f * texel[2], source_alpha = a.alpha / 255.f * texel[3];
            const float keep = 1 - source_alpha;
            paint.red = red + paint.red * keep;
            paint.green = green + paint.green * keep;
            paint.blue = blue + paint.blue * keep;
            paint.alpha = source_alpha + paint.alpha * keep;
        }
    }
    return paint;
}

bool solid(const Paint& paint, float red, float green, float blue) {
    return paint.covered && std::abs(paint.red - red) < .01f &&
           std::abs(paint.green - green) < .01f && std::abs(paint.blue - blue) < .01f &&
           std::abs(paint.alpha - 1) < .01f;
}

bool composite_covers(const UiRenderFrame& frame, const UiLayerComposite& composite, int px,
                      int py) {
    const float x = float(px) + .5f, y = float(py) + .5f;
    for (std::uint32_t i = composite.first_index;
         i + 2 < composite.first_index + composite.index_count + 1; i += 3)
        if (inside(frame.vertices[frame.indices[i]], frame.vertices[frame.indices[i + 1]],
                   frame.vertices[frame.indices[i + 2]], x, y))
            return true;
    return false;
}
} // namespace

int main() try {
    check(SDL_Init(SDL_INIT_VIDEO), "SDL initialization");
    auto* window = SDL_CreateWindow("Clip path fixture", 640, 480, SDL_WINDOW_HIDDEN);
    check(window != nullptr, "window");
    {
        Engine engine;
        const auto make = [&](const char* style) {
            auto h = ui_create_element(engine, "div");
            ui_set_attribute(engine, h, "style", style);
            return h;
        };
        const auto sheet = ui_create_element(engine, "style");
        ui_append_to_root(engine, sheet);
        // A notched button: the polygon clips its background, box shadow and overflowing child.
        ui_add_class_style(engine, sheet, "notched",
                           "clip-path:polygon(6px 0,100% 0,100% calc(100% - 6px),"
                           "calc(100% - 6px) 100%,0 100%,0 6px);box-shadow:0 0 0 8px #00ff00;");
        auto notched = make("position:absolute;left:20px;top:20px;width:100px;height:60px;"
                            "background-color:#ff0000;pointer-events:auto;");
        ui_set_attribute(engine, notched, "class", "notched");
        auto overflow = make("position:absolute;left:50px;top:-20px;width:80px;height:40px;"
                             "background-color:#0000ff;pointer-events:auto;");
        ui_append_child(engine, notched, overflow);
        ui_append_to_root(engine, notched);
        auto inset = make("position:absolute;left:150px;top:20px;width:48px;height:48px;"
                          "background-color:#00ff00;clip-path: inset(6px);");
        ui_append_to_root(engine, inset);
        auto slider = make("position:absolute;left:220px;top:20px;width:200px;height:10px;"
                           "background-color:#0000ff;");
        ui_append_to_root(engine, slider);
        auto hidden = make("position:absolute;left:20px;top:120px;width:50px;height:50px;"
                           "background-color:#ff0000;clip-path:inset(0 100% 0 0);");
        ui_append_child(engine, hidden,
                        make("position:absolute;left:60px;top:0;width:20px;"
                             "height:20px;background-color:#0000ff;"));
        ui_append_to_root(engine, hidden);
        auto star = make("position:absolute;left:300px;top:120px;width:100px;height:100px;"
                         "background-color:#ff0000;"
                         "clip-path:polygon(50% 0,79% 90%,2% 35%,98% 35%,21% 90%);");
        ui_append_to_root(engine, star);
        auto filtered =
            make("position:absolute;left:450px;top:120px;width:60px;height:60px;"
                 "background-color:#00ff00;filter:brightness(1);clip-path:inset(10px);");
        ui_append_to_root(engine, filtered);
        ui_add_class_style(engine, sheet, "closed",
                           "clip-path:inset(0px);transition:clip-path 100ms linear;");
        ui_add_class_style(engine, sheet, "open",
                           "clip-path:inset(20px);transition:clip-path 100ms linear;");
        ui_add_class_style(engine, sheet, "bare", "transition:clip-path 100ms linear;");
        ui_add_class_style(engine, sheet, "shaped",
                           "clip-path:inset(20px);transition:clip-path 100ms linear;");
        auto animated = make("position:absolute;left:100px;top:300px;width:60px;height:60px;"
                             "background-color:#00ff00;");
        ui_set_attribute(engine, animated, "class", "closed");
        ui_append_to_root(engine, animated);
        auto swapped = make("position:absolute;left:200px;top:300px;width:60px;height:60px;"
                            "background-color:#00ff00;");
        ui_set_attribute(engine, swapped, "class", "bare");
        ui_append_to_root(engine, swapped);

        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        const auto raw = [&](auto h) { return runtime.projected_elements.at(h.value).element; };
        const auto update = [&] { pal::update_ui_rml_runtime(runtime, 640, 480); };
        const auto frame = [&]() -> const UiRenderFrame& {
            return pal::record_ui_rml_frame(runtime, 640, 480);
        };
        ui_set_style_property(engine, slider, "clip-path",
                              "inset(0 calc(100% - 26px - 0.2500 * (100% - 52px)) 0 0)");
        update();
        {
            const auto& painted = frame();
            check(solid(paint_at(painted, 70, 50), 1, 0, 0),
                  "polygon interior keeps the background");
            check(!paint_at(painted, 22, 22).covered, "top-left notch clips everything");
            check(!paint_at(painted, 117, 77).covered, "bottom-right notch clips everything");
            check(solid(paint_at(painted, 117, 50), 1, 0, 0), "right edge interior");
            check(!paint_at(painted, 16, 50).covered, "box shadow outside the polygon is clipped");
            check(solid(paint_at(painted, 80, 25), 0, 0, 1), "child inside the polygon paints");
            check(!paint_at(painted, 80, 10).covered, "child above the box is clipped");
            check(!paint_at(painted, 135, 25).covered, "child beyond the box is clipped");
            check(!paint_at(painted, 152, 22).covered, "inset corner clipped");
            check(!paint_at(painted, 155, 25).covered, "inset edge clipped");
            check(solid(paint_at(painted, 156, 26), 0, 1, 0), "inset interior paints");
            check(!paint_at(painted, 193, 63).covered, "inset far edge clipped");
            check(solid(paint_at(painted, 282, 25), 0, 0, 1), "calc inset keeps the filled part");
            check(!paint_at(painted, 283, 25).covered, "calc inset clips past the knob centre");
            check(!paint_at(painted, 40, 140).covered && !paint_at(painted, 90, 130).covered,
                  "an empty clip region hides the element and its descendants");
            check(solid(paint_at(painted, 350, 125), 1, 0, 0), "star tip paints");
            check(solid(paint_at(painted, 350, 170), 1, 0, 0), "nonzero fills the star centre");
            check(!paint_at(painted, 302, 122).covered, "outside the star is clipped");
            // Filters apply before clipping: the layer keeps the full box and its composite clips it.
            const auto& composite = painted.composites.at(0);
            check(paint_at(painted, 452, 122, composite.source).covered,
                  "the filter layer is not clipped by its own clip-path");
            check(!composite_covers(painted, composite, 452, 122) &&
                      composite_covers(painted, composite, 480, 150),
                  "the filter composite takes the clip-path");
        }
        auto* context = runtime.context;
        check(context->GetElementAtPoint({70, 50}) == raw(notched), "hit inside the polygon");
        check(context->GetElementAtPoint({80, 25}) == raw(overflow), "hit on the clipped-in child");
        check(context->GetElementAtPoint({22, 22}) != raw(notched), "the notch does not hit");
        check(context->GetElementAtPoint({135, 25}) != raw(overflow),
              "a child outside the clip region does not hit");

        ui_set_style_property(engine, star, "clip-path",
                              "polygon(evenodd,50% 0,79% 90%,2% 35%,98% 35%,21% 90%)");
        ui_set_style_property(engine, inset, "clip-path", "inset(0 10px 20% 5%)");
        ui_set_style_property(engine, hidden, "clip-path", "none");
        update();
        {
            const auto& painted = frame();
            check(!paint_at(painted, 350, 170).covered, "evenodd leaves the star centre empty");
            check(solid(paint_at(painted, 350, 125), 1, 0, 0), "evenodd star tip paints");
            check(solid(paint_at(painted, 152, 30), 0, 1, 0) && !paint_at(painted, 151, 30).covered,
                  "percentage left inset");
            check(solid(paint_at(painted, 187, 30), 0, 1, 0) && !paint_at(painted, 188, 30).covered,
                  "pixel right inset");
            check(solid(paint_at(painted, 160, 57), 0, 1, 0) && !paint_at(painted, 160, 58).covered,
                  "percentage bottom inset");
            check(solid(paint_at(painted, 40, 140), 1, 0, 0),
                  "removing the clip-path shows the element");
        }

        // A class change transitions between inset() shapes value by value; a shape and none
        // swap at the midpoint.
        ui_set_attribute(engine, animated, "class", "open");
        ui_set_attribute(engine, swapped, "class", "shaped");
        update();
        fixture_time = 1040;
        update();
        check(solid(paint_at(frame(), 202, 302), 0, 1, 0), "none holds before the midpoint");
        fixture_time = 1050;
        update();
        {
            const auto& painted = frame();
            check(solid(paint_at(painted, 111, 311), 0, 1, 0) &&
                      !paint_at(painted, 109, 309).covered,
                  "the transition is half-way at 10px");
            check(!paint_at(painted, 202, 302).covered, "the shape applies from the midpoint");
        }
        fixture_time = 1100;
        update();
        fixture_time = 1101;
        update();
        check(!paint_at(frame(), 111, 311).covered && solid(paint_at(frame(), 121, 321), 0, 1, 0),
              "the transition ends at 20px");

        ui_set_style_property(engine, star, "clip-path", "circle(40%)");
        bool refused = false;
        try {
            update();
            static_cast<void>(frame());
        } catch (const std::runtime_error& error) {
            refused = std::string(error.what()).find("UI clip-path") != std::string::npos;
        }
        check(refused, "unsupported shapes refuse");
    }
    {
        // The engine surface is presented as an opaque rectangle beneath the page.
        Engine engine;
        const auto parent = ui_create_element(engine, "div");
        ui_set_attribute(engine, parent, "style",
                         "position:absolute;left:0;top:0;width:100px;height:100px;"
                         "clip-path:inset(10px);");
        const auto surface = ui_create_element(engine, "canvas");
        ui_set_attribute(engine, surface, "style", "display:block;width:100px;height:100px;");
        ui_append_child(engine, parent, surface);
        ui_append_to_root(engine, parent);
        engine.surface_canvas = surface;
        bool refused = false;
        try {
            pal::UiRmlRuntime runtime(engine, window, 640, 480);
            static_cast<void>(ui_get_client_rect(engine, surface));
            pal::update_ui_rml_runtime(runtime, 640, 480);
            static_cast<void>(pal::record_ui_rml_frame(runtime, 640, 480));
        } catch (const std::runtime_error& error) {
            refused = std::string(error.what()).find("under a clip-path") != std::string::npos;
        }
        check(refused, "an engine canvas under a clip-path refuses");
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
} catch (const std::exception& error) {
    std::fprintf(stderr, "Clip path failure: %s\n", error.what());
    return 1;
}
