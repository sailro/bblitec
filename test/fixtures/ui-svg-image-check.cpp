#define main generated_main
#include "../../artifacts/ui-svg-image/program.hpp"
#undef main
#include "pal_ui_rml.cpp"
#include <cassert>
#include <fstream>
#include <iterator>

namespace bbl {
std::string asset_path(const std::string& path) { return "artifacts/ui-svg-image/" + path; }
} // namespace bbl
namespace bbl::pal {
std::vector<std::uint8_t> read_binary_file(const std::string& path) {
    std::ifstream file(path, std::ios::binary);
    if (!file)
        throw std::runtime_error("Missing fixture asset " + path);
    return {std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>()};
}
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

namespace {
void check(bool condition, const char* message) {
    if (!condition) {
        std::fprintf(stderr, "%s\n", message);
        throw std::runtime_error(message);
    }
}

struct Paint {
    float red = 0, green = 0, blue = 0, alpha = 0;
};

/** The premultiplied colour the frame composites at a window pixel's centre (nearest texels). */
Paint paint_at(const bbl::pal::UiRenderFrame& frame, int px, int py) {
    const float x = float(px) + .5f, y = float(py) + .5f;
    Paint paint;
    for (const auto& draw : frame.draws) {
        const bbl::pal::UiRenderTexture* texture = nullptr;
        for (const auto& candidate : frame.textures)
            if (draw.texture_id != 0 && candidate.id == draw.texture_id)
                texture = &candidate;
        for (std::uint32_t i = draw.first_index; i + 2 < draw.first_index + draw.index_count + 1;
             i += 3) {
            const auto& a = frame.vertices[frame.indices[i]];
            const auto& b = frame.vertices[frame.indices[i + 1]];
            const auto& c = frame.vertices[frame.indices[i + 2]];
            const float area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
            if (std::abs(area) < 1e-6f)
                continue;
            const float wb = ((x - a.x) * (c.y - a.y) - (y - a.y) * (c.x - a.x)) / area;
            const float wc = ((b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x)) / area;
            const float wa = 1 - wb - wc;
            if (wa < 0 || wb < 0 || wc < 0)
                continue;
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
            const float source_alpha = a.alpha / 255.f * texel[3], keep = 1 - source_alpha;
            paint.red = a.red / 255.f * texel[0] + paint.red * keep;
            paint.green = a.green / 255.f * texel[1] + paint.green * keep;
            paint.blue = a.blue / 255.f * texel[2] + paint.blue * keep;
            paint.alpha = source_alpha + paint.alpha * keep;
        }
    }
    return paint;
}

bool solid(const Paint& paint, float red, float green, float blue) {
    return std::abs(paint.red - red) < .02f && std::abs(paint.green - green) < .02f &&
           std::abs(paint.blue - blue) < .02f && std::abs(paint.alpha - 1) < .02f;
}
} // namespace

int main() try {
    using namespace bbl;
    check(SDL_Init(SDL_INIT_VIDEO), "SDL initialization");
    SDL_Window* window = SDL_CreateWindow("SVG image", 320, 240, SDL_WINDOW_HIDDEN);
    check(window && generated_main() == 0, "program");
    {
        auto& engine = pal::window_document_engine();
        pal::UiRmlRuntime runtime(engine, window, 320, 240);
        const auto& frame = pal::record_ui_rml_frame(runtime, 320, 240);
        check(solid(paint_at(frame, 20, 10), 1, 0, 0), "the stretched image fills its rectangle");
        check(solid(paint_at(frame, 10, 5), 1, 0, 0) && solid(paint_at(frame, 29, 14), 1, 0, 0),
              "preserveAspectRatio none reaches every corner");
        check(paint_at(frame, 9, 10).alpha < .02f && paint_at(frame, 30, 10).alpha < .02f &&
                  paint_at(frame, 20, 4).alpha < .02f && paint_at(frame, 20, 15).alpha < .02f,
              "nothing paints outside the image rectangle");
        check(solid(paint_at(frame, 20, 25), 0, 1, 0), "meet centres the square raster");
        check(paint_at(frame, 12, 25).alpha < .02f && paint_at(frame, 27, 25).alpha < .02f,
              "meet letterboxes inside the rectangle");
        check(solid(paint_at(frame, 2, 34), 0, 0, 1), "shapes keep painting beside images");
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
} catch (const std::exception& error) {
    std::fprintf(stderr, "SVG image failure: %s\n", error.what());
    return 1;
}
