#include "pal_ui_rml.cpp"
#include <cassert>

namespace bbl::pal {
std::string asset_path(std::string_view) {
    throw std::runtime_error("Unexpected fixture asset read");
}
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
} // namespace bbl::pal

namespace {
void expectNear(float actual, float expected, const char* message) {
    if (std::abs(actual - expected) > .1f) {
        std::fprintf(stderr, "%s: %.3f expected %.3f\n", message, actual, expected);
        throw std::runtime_error(message);
    }
}
void check(bool condition, const char* message) {
    if (!condition)
        throw std::runtime_error(message);
}
} // namespace

int main() try {
    using namespace bbl;
    assert(SDL_Init(SDL_INIT_VIDEO));
    auto* window = SDL_CreateWindow("Aspect ratio fixture", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        Engine engine;
        const auto make = [&](const char* style) {
            auto h = ui_create_element(engine, "div");
            ui_set_attribute(engine, h, "style", style);
            return h;
        };
        // A card thumbnail: a hidden-overflow column flex item at full width.
        const auto sheet = ui_create_element(engine, "style");
        ui_append_to_root(engine, sheet);
        ui_add_class_style(
            engine, sheet, "thumb",
            "aspect-ratio: 16 / 9; width: 100%; position: relative; overflow: hidden;");
        auto card =
            make("position:absolute;left:0;top:0;width:320px;display:flex;flex-direction:column;");
        auto main = make("display:flex;flex-direction:column;width:100%;");
        auto thumb = make("");
        ui_set_attribute(engine, thumb, "class", "thumb");
        auto body = make("height:30px;");
        ui_append_child(engine, main, thumb);
        ui_append_child(engine, main, body);
        ui_append_child(engine, card, main);
        ui_append_to_root(engine, card);

        auto blocks = make("position:absolute;left:330px;top:0;width:300px;");
        auto stretched = make("aspect-ratio:2;");
        auto bordered =
            make("width:200px;padding:10px;box-sizing:border-box;aspect-ratio:2;overflow:hidden;");
        auto from_height = make("height:50px;aspect-ratio:3;overflow:hidden;");
        auto capped = make("width:200px;aspect-ratio:1;max-height:120px;overflow:hidden;");
        auto growing = make("width:100px;aspect-ratio:4;");
        ui_append_child(engine, growing, make("height:60px;"));
        auto clipped = make("width:100px;aspect-ratio:4;overflow:hidden;");
        ui_append_child(engine, clipped, make("height:60px;"));
        auto minimum = make("width:100px;aspect-ratio:4;min-height:0;");
        ui_append_child(engine, minimum, make("height:60px;"));
        for (auto h : {stretched, bordered, from_height, capped, growing, clipped, minimum})
            ui_append_child(engine, blocks, h);
        ui_append_to_root(engine, blocks);

        auto column = make(
            "position:absolute;left:0;top:300px;width:240px;display:flex;flex-direction:column;");
        auto stretched_item = make("aspect-ratio:2;overflow:hidden;");
        ui_append_child(engine, column, stretched_item);
        ui_append_to_root(engine, column);
        auto centered = make("position:absolute;left:0;top:420px;width:300px;display:flex;"
                             "align-items:center;justify-content:center;aspect-ratio:16/10;");
        ui_append_child(engine, centered, make("width:20px;height:10px;"));
        ui_append_to_root(engine, centered);

        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        const auto raw = [&](auto h) { return runtime.projected_elements.at(h.value).element; };
        const auto update = [&] { pal::update_ui_rml_runtime(runtime, 640, 480); };
        const auto size = [&](auto h) { return raw(h)->GetBox().GetSize(Rml::BoxArea::Border); };
        update();
        expectNear(size(thumb).x, 320, "thumbnail fills its column");
        expectNear(size(thumb).y, 180, "thumbnail height follows 16 / 9");
        expectNear(raw(body)->GetAbsoluteOffset().y - raw(thumb)->GetAbsoluteOffset().y, 180,
                   "the next column item follows the ratio height");
        expectNear(size(stretched).x, 300, "a block stretches its auto width");
        expectNear(size(stretched).y, 150, "the stretched width sets the height");
        expectNear(size(bordered).y, 100, "border-box sizing relates border boxes");
        expectNear(size(from_height).x, 150, "a definite height sets the auto width");
        expectNear(size(capped).y, 120, "max-height clamps the ratio height");
        expectNear(size(growing).y, 60, "visible content exceeds the automatic minimum");
        expectNear(size(clipped).y, 25, "a scroll container keeps the ratio height");
        expectNear(size(minimum).y, 25, "an authored min-height keeps the ratio height");
        expectNear(size(stretched_item).x, 240, "a column stretches the item width");
        expectNear(size(stretched_item).y, 120, "the stretched width sets the item height");
        expectNear(size(centered).y, 187.5f, "a flex container takes the ratio height");

        ui_set_style_property(engine, stretched, "aspect-ratio", "auto 1/3");
        update();
        expectNear(size(stretched).y, 900, "auto && ratio applies to a non-replaced box");
        ui_set_style_property(engine, stretched, "aspect-ratio", "1 / 0");
        update();
        expectNear(size(stretched).y, 0, "a degenerate ratio behaves as auto");
        ui_set_style_property(engine, stretched, "aspect-ratio", "");
        ui_set_style_property(engine, thumb, "width", "160px");
        update();
        expectNear(size(stretched).y, 0, "removing the ratio restores content sizing");
        expectNear(size(thumb).y, 90, "the ratio follows a live width");

        auto grid = make("display:grid;width:100px;");
        ui_append_child(engine, grid, make("aspect-ratio:1;"));
        ui_append_to_root(engine, grid);
        bool refused = false;
        try {
            update();
        } catch (const std::runtime_error& error) {
            refused =
                std::string(error.what()).find("aspect-ratio on grid items") != std::string::npos;
        }
        check(refused, "grid items refuse aspect-ratio");
    }
    {
        Engine engine;
        auto row = ui_create_element(engine, "div");
        ui_set_attribute(engine, row, "style", "display:flex;width:300px;height:40px;");
        auto item = ui_create_element(engine, "div");
        ui_set_attribute(engine, item, "style", "aspect-ratio:2;");
        ui_append_child(engine, row, item);
        ui_append_to_root(engine, row);
        bool refused = false;
        try {
            pal::UiRmlRuntime runtime(engine, window, 640, 480);
        } catch (const std::runtime_error& error) {
            refused =
                std::string(error.what()).find("aspect-ratio on a flex item") != std::string::npos;
        }
        check(refused, "a stretched definite row cross size refuses");
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
} catch (const std::exception& error) {
    std::fprintf(stderr, "Aspect ratio failure: %s\n", error.what());
    return 1;
}
