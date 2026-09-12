#include "pal_ui_rml.cpp"
#include <cassert>

namespace bbl {
std::string asset_path(const std::string& path) { return "artifacts/ui-border-image/" + path; }
}
namespace bbl::pal {
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
}

void expect_near(float actual, float expected) { assert(std::abs(actual - expected) < .01f); }

int main() {
    using namespace bbl;
    assert(SDL_Init(SDL_INIT_VIDEO));
    SDL_Window* window = SDL_CreateWindow("UI border image fixture", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        Engine engine;
        const auto box = ui_create_element(engine, "div");
        ui_set_attribute(engine, box, "style",
            "position:absolute;left:20px;top:30px;box-sizing:border-box;width:100px;height:80px;"
            "border:4px red;background-color:blue;background-clip:padding-box;");
        ui_append_to_root(engine, box);
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        const auto frame_for = [&](const char* slices, const char* widths) -> const pal::UiRenderFrame& {
            ui_set_style_property(engine, box, "border-image", std::string("url(\"frame4px.png\") ") + slices +
                " / " + widths + " / 0 0 0 0 stretch");
            pal::update_ui_rml_runtime(runtime, 640, 480);
            return pal::record_ui_rml_frame(runtime, 640, 480);
        };
        const auto quads = [](const pal::UiRenderFrame& frame) {
            std::vector<std::array<pal::UiRenderVertex, 4>> result;
            for (const auto& draw : frame.draws) {
                if (draw.texture_id == 0) continue;
                for (std::uint32_t i = draw.first_index; i < draw.first_index + draw.index_count; i += 6) {
                    // MeshUtilities' quad triangles refer to four consecutive vertices.
                    const auto begin = *std::min_element(frame.indices.begin() + i, frame.indices.begin() + i + 6);
                    result.push_back({frame.vertices[begin], frame.vertices[begin + 1], frame.vertices[begin + 2], frame.vertices[begin + 3]});
                }
            }
            return result;
        };
        const auto& first = frame_for("3 3 3 3", "1 1 1 1");
        assert(first.textures.size() == 1);
        const auto& texture = first.textures.front();
        assert(texture.width == 12 && texture.height == 12 && texture.rgba);
        assert((*texture.rgba)[0] == 120 && (*texture.rgba)[1] == 60 && (*texture.rgba)[2] == 30 && (*texture.rgba)[3] == 128);
        auto tiles = quads(first);
        assert(tiles.size() == 8);
        float painted_area = 0;
        for (const auto& tile : tiles) {
            float left = tile[0].x, right = left, top = tile[0].y, bottom = top;
            for (const auto& v : tile) { left = std::min(left, v.x); right = std::max(right, v.x); top = std::min(top, v.y); bottom = std::max(bottom, v.y); }
            assert(right <= 24.01f || left >= 115.99f || bottom <= 34.01f || top >= 105.99f);
            painted_area += (right - left) * (bottom - top);
        }
        expect_near(painted_area, 100 * 80 - 92 * 72);
        expect_near(tiles.front()[0].x, 20); expect_near(tiles.front()[0].y, 30);
        float max_u = 0, max_v = 0;
        for (const auto& v : tiles.front()) { max_u = std::max(max_u, v.u); max_v = std::max(max_v, v.v); }
        expect_near(max_u, .25f); expect_near(max_v, .25f);
        for (const auto& v : first.vertices) assert(!(v.red == 255 && v.green == 0 && v.blue == 0));

        tiles = quads(frame_for("25% 25% 25% 25%", "auto auto auto auto"));
        expect_near(tiles.front()[1].x - tiles.front()[0].x, 3);
        tiles = quads(frame_for("3 3 3 3", "10% 10% 10% 10%"));
        expect_near(tiles.front()[1].x - tiles.front()[0].x, 10);
        ui_set_style_property(engine, box, "width", "120px");
        pal::update_ui_rml_runtime(runtime, 640, 480);
        tiles = quads(pal::record_ui_rml_frame(runtime, 640, 480));
        expect_near(tiles.front()[1].x - tiles.front()[0].x, 12);

        // Vertical overlap reduces horizontal widths by the same factor.
        tiles = quads(frame_for("3 3 3 3", "60px 20px 60px 20px"));
        assert(tiles.size() == 6);
        expect_near(tiles.front()[1].x - tiles.front()[0].x, 20 * (80.0f / 120));
        tiles = quads(frame_for("8 8 8 8", "4px 4px 4px 4px"));
        assert(tiles.size() == 4); // Source overlap suppresses middle regions.
        frame_for("3 3 3 3", "1 1 1 1");
        ui_set_style_property(engine, box, "border-width", "6px");
        ui_set_style_property(engine, box, "opacity", "0.5");
        pal::update_ui_rml_runtime(runtime, 640, 480);
        tiles = quads(pal::record_ui_rml_frame(runtime, 640, 480));
        expect_near(tiles.front()[1].x - tiles.front()[0].x, 6);
        assert(tiles.front()[0].alpha == 128 && tiles.front()[0].red == 128);

        frame_for("3 3 3 3", "4px 4px 4px 4px");
        runtime.context->SetDensityIndependentPixelRatio(2);
        runtime.context->Update();
        tiles = quads(pal::record_ui_rml_frame(runtime, 640, 480));
        expect_near(tiles.front()[1].x - tiles.front()[0].x, 8);
        runtime.context->SetDensityIndependentPixelRatio(1);
        runtime.context->Update();

        ui_set_style_property(engine, box, "border-image", "none");
        pal::update_ui_rml_runtime(runtime, 640, 480);
        const auto& reset = pal::record_ui_rml_frame(runtime, 640, 480);
        assert(quads(reset).empty());
        assert(std::any_of(reset.vertices.begin(), reset.vertices.end(), [](const auto& v) {
            return v.red == 128 && v.green == 0 && v.blue == 0 && v.alpha == 128;
        }));

        // No layout dimension changes here: auto slices still follow density.
        auto* raw = runtime.projected_elements.at(box.value).element;
        raw->SetProperty("width", "100px"); raw->SetProperty("height", "80px");
        raw->SetProperty("border-width", "0px");
        raw->SetProperty("border-image", "url(\"frame4px.png\") 3 3 3 3 / auto auto auto auto / 0 0 0 0 stretch");
        runtime.context->Update();
        tiles = quads(pal::record_ui_rml_frame(runtime, 640, 480));
        expect_near(tiles.front()[1].x - tiles.front()[0].x, 3);
        runtime.context->SetDensityIndependentPixelRatio(2);
        runtime.context->Update();
        tiles = quads(pal::record_ui_rml_frame(runtime, 640, 480));
        expect_near(tiles.front()[1].x - tiles.front()[0].x, 6);

        // Large finite widths reduce before conversion to vertex precision.
        raw->SetProperty("border-image", "url(\"frame4px.png\") 3 3 3 3 / 3e38dp 3e38dp 3e38dp 3e38dp / 0 0 0 0 stretch");
        runtime.context->Update();
        tiles = quads(pal::record_ui_rml_frame(runtime, 640, 480));
        assert(tiles.size() == 6);
        expect_near(tiles.front()[1].x - tiles.front()[0].x, 40);
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
}
