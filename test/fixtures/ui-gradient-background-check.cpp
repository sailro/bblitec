#include "pal_ui_rml.cpp"
#include "../../artifacts/ui-gradient-background/styles.hpp"

namespace bbl::pal {
std::string asset_path(std::string_view) { throw std::runtime_error("Unexpected asset read"); }
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
} // namespace bbl::pal

int main() try {
    using namespace bbl;
    const auto check = [](bool ok, const char* message) {
        if (!ok)
            throw std::runtime_error(message);
    };
    check(SDL_Init(SDL_INIT_VIDEO), "SDL initialization");
    auto* window = SDL_CreateWindow("Gradient layers", 640, 480, SDL_WINDOW_HIDDEN);
    check(window != nullptr, "Window creation");
    {
        Engine engine;
        const auto owner = ui_create_element(engine, "div");
        ui_set_attribute(
            engine, owner, "style",
            std::string("position:absolute;left:20px;top:30px;width:80px;height:60px;") + layers);
        ui_append_to_root(engine, owner);
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        auto* raw = runtime.projected_elements.at(owner.value).element;
        const auto update = [&] { pal::update_ui_rml_runtime(runtime, 640, 480); };
        const auto bounds = [&](const pal::UiRenderFrame& frame, std::size_t index, float x,
                                float y, float width, float height) {
            const auto& draw = frame.draws.at(index);
            float left = 10000, top = 10000, right = -10000, bottom = -10000;
            for (std::uint32_t i = 0; i < draw.index_count; ++i) {
                const auto& vertex = frame.vertices.at(frame.indices.at(draw.first_index + i));
                left = std::min(left, vertex.x);
                top = std::min(top, vertex.y);
                right = std::max(right, vertex.x);
                bottom = std::max(bottom, vertex.y);
            }
            if (std::abs(left - x) > .01f || std::abs(top - y) > .01f ||
                std::abs(right - left - width) > .01f || std::abs(bottom - top - height) > .01f)
                throw std::runtime_error("Layer rectangle differs: " + std::to_string(left) + "," +
                                         std::to_string(top) + "," + std::to_string(right - left) +
                                         "," + std::to_string(bottom - top));
        };
        update();
        const auto& frame = pal::record_ui_rml_frame(runtime, 640, 480);
        check(frame.draws.size() == 2, "Two independently painted layers");
        bounds(frame, 0, 60, 84, 40, 6);
        bounds(frame, 1, 58, 44, 4, 32);
        check(raw->GetNumChildren(true) == 0 && raw->Matches(":empty"),
              "Backgrounds create no DOM children");
        ui_set_style_property(engine, owner, "opacity", "0.9");
        update();
        const auto& translucent = pal::record_ui_rml_frame(runtime, 640, 480);
        for (const auto& draw : translucent.draws)
            for (std::uint32_t i = 0; i < draw.index_count; ++i) {
                const auto& vertex =
                    translucent.vertices.at(translucent.indices.at(draw.first_index + i));
                if (vertex.alpha != 230)
                    throw std::runtime_error("Gradient opacity differs: " +
                                             std::to_string(vertex.alpha));
            }
        ui_set_style_property(engine, owner, "opacity", "1");
        const auto child = ui_create_element(engine, "span");
        ui_set_attribute(engine, child, "style",
                         "display:block;width:3px;height:3px;background-color:white;");
        ui_append_child(engine, owner, child);
        update();
        const auto& with_child = pal::record_ui_rml_frame(runtime, 640, 480);
        check(with_child.draws.size() == 3, "Authored content remains above backgrounds");
        bounds(with_child, 2, 20, 30, 3, 3);
        check(raw->GetNumChildren(true) == 1 && raw->Matches(":has(> span:only-child)"),
              "Authored selector identity");
        ui_set_style_property(engine, owner, "width", "160px");
        update();
        bounds(pal::record_ui_rml_frame(runtime, 640, 480), 1, 98, 44, 4, 32);
        ui_set_attribute(
            engine, owner, "style",
            std::string("position:absolute;left:20px;top:30px;width:160px;height:60px;") + resized);
        update();
        const auto& changed = pal::record_ui_rml_frame(runtime, 640, 480);
        bounds(changed, 0, 60, 52.5f, 80, 15);
        const auto texture =
            std::find_if(changed.textures.begin(), changed.textures.end(), [&](const auto& entry) {
                return entry.id == changed.draws.front().texture_id;
            });
        check(texture != changed.textures.end(), "Gradient texture exists");
        check(texture->rgba->at(0) > texture->rgba->at(2), "Gradient starts red at its own origin");
        const auto last = (texture->width - 1) * 4;
        check(texture->rgba->at(last) < texture->rgba->at(last + 2),
              "Gradient ends blue at its own extent");
        // CSS math over a percentage sizes and places a layer against its paint box.
        ui_set_attribute(
            engine, owner, "style",
            "position:absolute;left:20px;top:30px;width:160px;height:60px;"
            "--bbl-background-image:linear-gradient(red,blue) padding-box / calc(100% - 6px) "
            "calc(100% - 12px) / 6px 6px;");
        update();
        bounds(pal::record_ui_rml_frame(runtime, 640, 480), 0, 26, 36, 154, 48);
        ui_set_attribute(
            engine, owner, "style",
            "position:absolute;left:20px;top:30px;width:160px;height:60px;"
            "--bbl-background-image:linear-gradient(red,blue) padding-box / 40px 10px / "
            "calc(100% - 4px) 0px;");
        update();
        bounds(pal::record_ui_rml_frame(runtime, 640, 480), 0, 136, 30, 40, 10);
        // A repeating layer tiles its paint box from its placed position (columns from 10 - 40 =
        // -30 to 130, rows 0 to 40): 5 x 3 tiles, the edge ones cut by the paint box.
        ui_set_attribute(
            engine, owner, "style",
            "position:absolute;left:20px;top:30px;width:160px;height:60px;"
            "--bbl-background-image:linear-gradient(red,blue) padding-box repeat / 40px 20px / "
            "10px 0px;");
        update();
        {
            const auto& tiled = pal::record_ui_rml_frame(runtime, 640, 480);
            std::size_t tiles = 0;
            for (const auto& draw : tiled.draws) {
                if (!draw.texture_id)
                    continue;
                ++tiles;
                for (std::uint32_t i = 0; i < draw.index_count; ++i) {
                    const auto& vertex = tiled.vertices.at(tiled.indices.at(draw.first_index + i));
                    check(vertex.x > 19.9f && vertex.x < 180.1f && vertex.y > 29.9f &&
                              vertex.y < 90.1f,
                          "Repeated tiles stay inside the paint box");
                }
            }
            check(tiles == 15, "A repeating layer draws one tile per covered cell");
        }
        // Placed in the padding box and clipped to the rounded border box (CSS background-origin
        // and background-clip): the layer reaches under the border and loses its corners.
        ui_set_attribute(
            engine, owner, "style",
            "position:absolute;left:20px;top:30px;width:160px;height:60px;"
            "border:6px solid transparent;border-radius:20px;"
            "--bbl-background-image:linear-gradient(red,blue) border-box / calc(100% + 4px) "
            "calc(100% + 4px) / -2px -2px / padding-box;");
        update();
        const auto& rounded = pal::record_ui_rml_frame(runtime, 640, 480);
        const auto layer = static_cast<std::size_t>(
            std::find_if(rounded.draws.begin(), rounded.draws.end(),
                         [](const auto& draw) { return draw.texture_id != 0; }) -
            rounded.draws.begin());
        check(layer < rounded.draws.size(), "The layer draws");
        bounds(rounded, layer, 24, 34, 164, 64);
        const auto& draw = rounded.draws[layer];
        for (std::uint32_t i = 0; i < draw.index_count; ++i) {
            const auto& vertex = rounded.vertices.at(rounded.indices.at(draw.first_index + i));
            check(std::hypot(vertex.x - 24, vertex.y - 34) > 2,
                  "The rounded clip removes the layer's corner");
        }
        ui_set_attribute(
            engine, owner, "style",
            "width:160px;height:60px;--bbl-background-image:linear-gradient(red,blue) padding-box / 0dp 10dp / 50% 50%;");
        update();
        check(pal::record_ui_rml_frame(runtime, 640, 480).draws.size() == 1,
              "Zero-sized image paints nothing");
        ui_set_attribute(engine, owner, "style",
                         "width:160px;height:60px;--bbl-background-image:none;");
        update();
        check(pal::record_ui_rml_frame(runtime, 640, 480).draws.size() == 1 &&
                  raw->GetNumChildren(true) == 1,
              "Layer removal preserves content");
        // The background shorthand written at run time: gradient layers are the cascaded
        // image, a colour after the shorthand's image reset removes them.
        ui_set_attribute(engine, owner, "style", "width:160px;height:60px;");
        ui_set_background(engine, owner,
                          "radial-gradient(circle at 38% 32%, rgba(255,255,255,0.55), "
                          "rgba(255,255,255,0) 60%), linear-gradient(#b6a884, #b6a884)");
        update();
        check(pal::record_ui_rml_frame(runtime, 640, 480).draws.size() == 3,
              "Written gradient layers paint");
        ui_set_style_property(engine, owner, "--bbl-background-image", "none");
        ui_set_background(engine, owner, "#cdaa6b");
        update();
        const auto& colored = pal::record_ui_rml_frame(runtime, 640, 480);
        check(colored.draws.size() == 2 && colored.draws.front().texture_id == 0,
              "A written colour replaces the layers");
        ui_set_background(engine, owner, " None ");
        update();
        check(pal::record_ui_rml_frame(runtime, 640, 480).draws.size() == 1,
              "A written none paints no background");
        // A padding-box clip is the plain layer's own paint box; a content-box clip refuses.
        ui_set_attribute(
            engine, owner, "style",
            "position:absolute;left:20px;top:30px;width:160px;height:60px;padding:10px;"
            "--bbl-background-image:linear-gradient(red,blue);background-clip:padding-box;");
        update();
        const auto& padded = pal::record_ui_rml_frame(runtime, 640, 480);
        const auto clipped = static_cast<std::size_t>(
            std::find_if(padded.draws.begin(), padded.draws.end(),
                         [](const auto& draw) { return draw.texture_id != 0; }) -
            padded.draws.begin());
        check(clipped < padded.draws.size(), "The clipped layer draws");
        bounds(padded, clipped, 20, 30, 180, 80);
        bool refused = false;
        try {
            ui_set_background(engine, owner,
                              "linear-gradient(red,blue) center / 4px 4px no-repeat");
        } catch (const std::runtime_error&) {
            refused = true;
        }
        check(refused, "A written layer box refuses");
        ui_set_style_property(engine, owner, "background-clip", "content-box");
        refused = false;
        try {
            update();
        } catch (const std::runtime_error&) {
            refused = true;
        }
        check(refused, "A content-box clip of a plain layer refuses");
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
} catch (const std::exception& error) {
    std::fprintf(stderr, "%s\n", error.what());
    return 1;
}
