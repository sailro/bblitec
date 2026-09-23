#include "pal_ui_rml.cpp"
#include <cassert>

namespace bbl::pal {
std::string asset_path(std::string_view) {
    throw std::runtime_error("Unexpected fixture asset read");
}
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
} // namespace bbl::pal

int main() try {
    using namespace bbl;
    using namespace bbl::pal;
    assert(SDL_Init(SDL_INIT_VIDEO));
    auto* window = SDL_CreateWindow("Range retention fixture", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        Engine engine;
        const auto panel = ui_create_element(engine, "div");
        ui_set_attribute(engine, panel, "style",
                         "display:grid;grid-template-columns:1fr auto;width:236px;");
        ui_append_to_root(engine, panel);
        const auto label = ui_create_element(engine, "span");
        ui_set_text(engine, label, "Before");
        ui_append_child(engine, panel, label);
        const auto add_range = [&] {
            const auto handle = ui_create_element(engine, "input");
            ui_set_attribute(engine, handle, "type", "range");
            ui_set_attribute(engine, handle, "value", "50");
            ui_set_attribute(engine, handle, "style", "grid-column:1/3;width:100%;height:20px;");
            ui_append_child(engine, panel, handle);
            return handle;
        };
        auto range = add_range();
        UiRmlRuntime runtime(engine, window, 640, 480);
        const auto update = [&] { update_ui_rml_runtime(runtime, 640, 480); };
        const auto raw = [&] { return runtime.projected_elements.at(range.value).element; };
        const auto texture = [&](std::uint32_t width = 236) -> const UiRenderTexture& {
            for (const auto& candidate : runtime.render_interface.frame.textures)
                if (candidate.width == width && candidate.height == 20)
                    return candidate;
            throw std::runtime_error("Missing native range raster");
        };
        const auto render = [&] { static_cast<void>(record_ui_rml_frame(runtime, 640, 480)); };
        update();
        render();
        auto id = texture().id;
        for (int index = 0; index < 5; ++index) {
            ui_set_text(engine, label, "Unrelated text " + std::to_string(index));
            update();
            render();
            assert(texture().id == id);
        }
        ui_set_attribute(engine, range, "value", "75");
        update();
        render();
        assert(texture().id != id);
        id = texture().id;
        ui_set_attribute(engine, range, "disabled", "");
        update();
        render();
        assert(texture().id != id);
        id = texture().id;
        ui_set_style_property(engine, range, "appearance", "none");
        update();
        render();
        assert(texture().id != id);
        id = texture().id;
        ui_set_style_property(engine, range, "opacity", "0.5");
        update();
        render();
        assert(texture().id == id); // Opacity updates the quad, not its coverage texture.
        ui_set_style_property(engine, panel, "width", "180px");
        update();
        render();
        assert(texture(180).id != id);
        std::weak_ptr<const std::vector<std::uint8_t>> removed_pixels = texture(180).rgba;
        ui_remove(engine, range);
        update();
        render();
        assert(removed_pixels.expired());
        ui_set_style_property(engine, panel, "width", "236px");
        range = add_range();
        update();
        render();
        assert(texture().id != id);

        // Exercise RmlUi's documented generate-before-release overlap directly.
        UiRangeDecorator decorator;
        auto first = decorator.GenerateElementData(raw(), Rml::BoxArea::Content);
        runtime.render_interface.begin_frame(640, 480);
        decorator.RenderElement(raw(), first);
        id = texture().id;
        std::weak_ptr<const std::vector<std::uint8_t>> pixels = texture().rgba;
        auto second = decorator.GenerateElementData(raw(), Rml::BoxArea::Content);
        decorator.ReleaseElementData(first);
        runtime.render_interface.begin_frame(640, 480);
        decorator.RenderElement(raw(), second);
        assert(texture().id == id && !pixels.expired());
        auto third = decorator.GenerateElementData(raw(), Rml::BoxArea::Content);
        decorator.ReleaseElementData(second);
        runtime.render_interface.begin_frame(640, 480);
        decorator.RenderElement(raw(), third);
        assert(texture().id == id);
        decorator.ReleaseElementData(third);
        runtime.render_interface.begin_frame(640, 480);
        assert(pixels.expired());
        auto fresh = decorator.GenerateElementData(raw(), Rml::BoxArea::Content);
        decorator.RenderElement(raw(), fresh);
        assert(texture().id != id);
        decorator.ReleaseElementData(fresh);
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
} catch (const std::exception& error) {
    std::fprintf(stderr, "Range retention: %s\n", error.what());
    return 1;
}
