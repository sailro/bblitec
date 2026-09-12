#include "pal_ui_rml.cpp"
#include <cassert>

namespace bbl {
std::string asset_path(const std::string& path) { return "artifacts/ui-object-fit/" + path; }
}
namespace bbl::pal {
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
}

void expect_near(float actual, float expected) { assert(std::abs(actual - expected) < .01f); }

int main() {
    using namespace bbl;
    assert(SDL_Init(SDL_INIT_VIDEO));
    SDL_Window* window = SDL_CreateWindow("Object fitting fixture", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        Engine engine;
        const auto image = ui_create_element(engine, "img");
        ui_set_attribute(engine, image, "src", "wide.png");
        ui_set_attribute(engine, image, "width", "17");
        ui_set_attribute(engine, image, "height", "23");
        ui_set_attribute(engine, image, "style", "position:absolute;left:10px;top:20px;width:100px;height:100px;");
        ui_append_to_root(engine, image);
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        const auto expect_quad = [&](float left, float top, float right, float bottom, float u0 = 0, float v0 = 0, float u1 = 1, float v1 = 1) {
            const auto& frame = pal::record_ui_rml_frame(runtime, 640, 480);
            const pal::UiRenderDraw* image_draw = nullptr;
            for (const auto& draw : frame.draws) if (draw.texture_id) { assert(!image_draw); image_draw = &draw; }
            assert(image_draw && image_draw->index_count == 6);
            float min_x = 1e6f, min_y = 1e6f, max_x = -1e6f, max_y = -1e6f;
            float min_u = 1e6f, min_v = 1e6f, max_u = -1e6f, max_v = -1e6f;
            for (auto i = image_draw->first_index; i < image_draw->first_index + image_draw->index_count; ++i) {
                const auto& vertex = frame.vertices[frame.indices[i]];
                min_x = std::min(min_x, vertex.x); max_x = std::max(max_x, vertex.x);
                min_y = std::min(min_y, vertex.y); max_y = std::max(max_y, vertex.y);
                min_u = std::min(min_u, vertex.u); max_u = std::max(max_u, vertex.u);
                min_v = std::min(min_v, vertex.v); max_v = std::max(max_v, vertex.v);
            }
            expect_near(min_x, left); expect_near(min_y, top); expect_near(max_x, right); expect_near(max_y, bottom);
            expect_near(min_u, u0); expect_near(min_v, v0); expect_near(max_u, u1); expect_near(max_v, v1);
        };
        const auto fit = [&](const char* value) {
            ui_set_style_property(engine, image, "object-fit", value);
            pal::update_ui_rml_runtime(runtime, 640, 480);
        };
        fit("fill"); expect_quad(10, 20, 110, 120);
        fit("contain"); expect_quad(10, 45, 110, 95);
        fit("cover"); expect_quad(10, 20, 110, 120, .25f, 0, .75f, 1);
        fit("none"); expect_quad(10, 20, 110, 120, .25f, 0, .75f, 1);
        fit("scale-down"); expect_quad(10, 45, 110, 95);
        auto* raw = runtime.projected_elements.at(image.value).element;
        expect_near(raw->GetClientWidth(), 100); expect_near(raw->GetClientHeight(), 100);
        ui_set_style_property(engine, image, "width", "300px");
        ui_set_style_property(engine, image, "height", "200px");
        fit("scale-down"); expect_quad(60, 70, 260, 170);
        fit("contain"); expect_quad(10, 45, 310, 195);
        ui_set_style_property(engine, image, "width", "100px");
        ui_set_style_property(engine, image, "height", "80px");
        fit("none"); expect_quad(10, 20, 110, 100, .25f, .1f, .75f, .9f);
        ui_set_style_property(engine, image, "height", "100px");
        ui_set_attribute(engine, image, "src", "tall.png");
        fit("cover"); expect_quad(10, 20, 110, 120, 0, .25f, 1, .75f);
        fit(""); expect_quad(10, 20, 110, 120);
        ui_set_attribute(engine, image, "src", "wide.png");
        fit("none");
        runtime.context->SetDensityIndependentPixelRatio(2);
        runtime.context->Update();
        expect_quad(20, 40, 220, 240, .25f, 0, .75f, 1);
        runtime.context->SetDensityIndependentPixelRatio(1);
        runtime.context->Update();
        bool refused = false;
        try { fit("stretch"); } catch (const std::runtime_error&) { refused = true; }
        assert(refused);
        fit("fill");
        const auto canvas = ui_create_element(engine, "canvas");
        ui_canvas_set_width(engine, canvas, 20);
        ui_set_style_property(engine, canvas, "object-fit", "contain");
        ui_append_to_root(engine, canvas);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        refused = false;
        try { pal::record_ui_rml_frame(runtime, 640, 480); } catch (const std::runtime_error&) { refused = true; }
        assert(refused);
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
}
