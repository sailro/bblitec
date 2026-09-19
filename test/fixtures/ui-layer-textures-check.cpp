#include "pal_ui_rml.cpp"
#include <cassert>

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
    UiRenderRecorder recorder;
    const auto quad = [&](float x, float y, float width, float height,
                          Rml::ColourbPremultiplied color) {
        Rml::Mesh mesh;
        Rml::MeshUtilities::GenerateQuad(mesh, {x, y}, {width, height}, color, {0, 0}, {1, 1});
        return recorder.CompileGeometry(mesh.vertices, mesh.indices);
    };
    const auto full = quad(4, 6, 24, 20, {255, 255, 255, 255});
    const auto red = quad(4, 6, 24, 20, {128, 0, 0, 128});
    const auto blue = quad(4, 6, 24, 20, {0, 0, 255, 255});
    const auto hole = quad(10, 10, 8, 8, {255, 255, 255, 255});
    recorder.begin_frame(64, 64);
    recorder.EnableScissorRegion(true);
    recorder.SetScissorRegion(Rml::Rectanglei::FromPositionSize({4, 6}, {24, 20}));
    recorder.PushLayer();
    recorder.RenderGeometry(red, {}, {});
    recorder.EnableClipMask(true);
    recorder.RenderToClipMask(Rml::ClipMaskOperation::SetInverse, hole, {});
    recorder.RenderGeometry(blue, {}, {});
    const auto saved = recorder.SaveLayerAsTexture();
    recorder.PopLayer();
    recorder.EnableClipMask(false);
    assert(saved && recorder.frame.draws.empty() && recorder.frame.operations.empty() &&
           recorder.frame.layer_count == 0);
    recorder.RenderGeometry(full, {}, saved);
    assert(recorder.frame.draws.size() == 1 && recorder.frame.textures.size() == 1);
    const auto first_texture = recorder.frame.textures[0];
    assert(first_texture.width == 24 && first_texture.height == 20);
    const auto pixel = [&](const UiRenderTexture& texture, int x, int y) {
        std::array<std::uint8_t, 4> result{};
        std::copy_n(texture.rgba->data() + (static_cast<std::size_t>(y) * texture.width + x) * 4, 4,
                    result.begin());
        return result;
    };
    assert((pixel(first_texture, 1, 1) == std::array<std::uint8_t, 4>{0, 0, 255, 255}));
    assert((pixel(first_texture, 8, 8) == std::array<std::uint8_t, 4>{128, 0, 0, 128}));
    // Pixels on a shared triangle edge receive exactly one source-over blend.
    assert((pixel(first_texture, 10, 10) == std::array<std::uint8_t, 4>{128, 0, 0, 128}));
    recorder.begin_frame(64, 64);
    recorder.RenderGeometry(full, {}, saved);
    assert(recorder.frame.textures[0].id == first_texture.id &&
           recorder.frame.textures[0].rgba == first_texture.rgba);
    const auto outer = recorder.PushLayer();
    recorder.RenderGeometry(full, {}, saved);
    const auto inner = recorder.PushLayer();
    recorder.RenderGeometry(blue, {}, {});
    Rml::Dictionary parameters;
    parameters["value"] = .5f;
    const auto opacity = recorder.CompileFilter("opacity", parameters);
    const std::array filters{opacity};
    recorder.CompositeLayers(inner, outer, Rml::BlendMode::Blend, {filters.data(), filters.size()});
    recorder.PopLayer();
    const auto composed = recorder.SaveLayerAsTexture();
    recorder.PopLayer();
    recorder.RenderGeometry(full, {}, composed);
    assert(recorder.frame.draws.size() == 2 && recorder.frame.operations.empty());
    const auto& mixed = recorder.frame.textures.back();
    const auto center = pixel(mixed, 12, 12);
    assert(center[0] == 64 && center[2] == 128 && center[3] == 192);
    recorder.ReleaseFilter(opacity);
    recorder.ReleaseTexture(composed);
    recorder.ReleaseTexture(saved);
    for (const auto geometry : {full, red, blue, hole})
        recorder.ReleaseGeometry(geometry);

    assert(SDL_Init(SDL_INIT_VIDEO));
    auto* window = SDL_CreateWindow("Saved layer fixture", 320, 240, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        Engine engine;
        const auto panel = ui_create_element(engine, "div");
        ui_set_attribute(
            engine, panel, "style",
            "position:absolute;left:40px;top:40px;width:64px;height:48px;border-radius:12px;background-color:white;box-shadow:inset 0 0 0 4px red, 6px 8px 0 2px blue;");
        ui_append_to_root(engine, panel);
        UiRmlRuntime runtime(engine, window, 320, 240);
        const auto& frame = record_ui_rml_frame(runtime, 320, 240);
        assert(frame.draws.size() == 1 && frame.textures.size() == 1 && frame.operations.empty());
        const auto texture = frame.textures[0];
        assert((pixel(texture, 2, 20) == std::array<std::uint8_t, 4>{255, 0, 0, 255}));
        assert((pixel(texture, 20, 20) == std::array<std::uint8_t, 4>{255, 255, 255, 255}));
        assert((pixel(texture, 67, 20) == std::array<std::uint8_t, 4>{0, 0, 255, 255}));
        for (int y = 12; y < 36; ++y)
            for (int x = 12; x < 52; ++x)
                assert((pixel(texture, x, y) == std::array<std::uint8_t, 4>{255, 255, 255, 255}));
        bool covered_edge = false;
        for (std::size_t index = 3; index < texture.rgba->size(); index += 4)
            covered_edge =
                covered_edge || (texture.rgba->at(index) > 0 && texture.rgba->at(index) < 255);
        assert(covered_edge);
        assert(record_ui_rml_frame(runtime, 320, 240).textures[0].id == texture.id);
        ui_set_style_property(engine, panel, "--Ink", "rgba(0,0,255,.5)");
        ui_set_style_property(engine, panel, "box-shadow", "2px 3px 8px var(--Ink)");
        update_ui_rml_runtime(runtime, 320, 240);
        const auto& blurred = record_ui_rml_frame(runtime, 320, 240);
        assert(blurred.textures[0].id != texture.id && blurred.operations.empty());
        const auto& bytes = *blurred.textures[0].rgba;
        bool soft_blue = false;
        for (std::size_t index = 0; index < bytes.size(); index += 4)
            soft_blue =
                soft_blue || (bytes[index] == 0 && bytes[index + 2] > 0 && bytes[index + 3] < 128);
        assert(soft_blue);
        ui_set_style_property(engine, panel, "--Ink", "red");
        update_ui_rml_runtime(runtime, 320, 240);
        const auto changed_id = record_ui_rml_frame(runtime, 320, 240).textures[0].id;
        ui_set_style_property(engine, panel, "width", "120px");
        update_ui_rml_runtime(runtime, 320, 240);
        assert(record_ui_rml_frame(runtime, 320, 240).textures[0].id != changed_id);
        ui_set_style_property(engine, panel, "box-shadow", "none");
        update_ui_rml_runtime(runtime, 320, 240);
        assert(record_ui_rml_frame(runtime, 320, 240).textures.empty());
        ui_set_style_property(engine, panel, "width", "100px");
        ui_set_style_property(engine, panel, "height", "120px");
        ui_set_style_property(engine, panel, "box-shadow", "0 30px 80px black");
        update_ui_rml_runtime(runtime, 320, 240);
        const auto& clipped = record_ui_rml_frame(runtime, 320, 240);
        const auto& clipped_texture = clipped.textures.at(0);
        const auto& shadow_draw = clipped.draws.at(0);
        const auto& first_vertex = clipped.vertices.at(clipped.indices.at(shadow_draw.first_index));
        float left = first_vertex.x, right = left;
        float top = first_vertex.y, bottom = top;
        for (std::uint32_t index = shadow_draw.first_index;
             index < shadow_draw.first_index + shadow_draw.index_count; ++index) {
            const auto& vertex = clipped.vertices.at(clipped.indices.at(index));
            left = std::min(left, vertex.x);
            right = std::max(right, vertex.x);
            top = std::min(top, vertex.y);
            bottom = std::max(bottom, vertex.y);
        }
        assert(right - left == clipped_texture.width);
        assert(bottom - top == clipped_texture.height);
        const auto clipped_id = clipped_texture.id;
        update_ui_rml_runtime(runtime, 640, 480);
        const auto& expanded = record_ui_rml_frame(runtime, 640, 480);
        assert(expanded.textures.at(0).id != clipped_id);
        assert(expanded.textures.at(0).width > 320 && expanded.textures.at(0).height > 240);
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
}
