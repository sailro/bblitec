#pragma once
#include <bblite/pal_offscreen.hpp>
#include <bblite/pal_ui.hpp>
#include <SDL3/SDL.h>
#include <memory>
#include <span>
#include <string>

namespace bbl::pal {
struct WindowCanvasFrame {
    UiElementHandle element;
    OffscreenFrame frame;
};

/** Canvas views share a submitted image; only their own quad's texture coordinates change. */
inline std::optional<UiRenderFrame>
window_canvas_views(const UiRenderFrame& source, std::span<const WindowCanvasFrame> canvases) {
    if (std::all_of(canvases.begin(), canvases.end(), [](const auto& canvas) {
            return canvas.frame.uv == std::array<float, 4>{0, 0, 1, 1};
        }))
        return std::nullopt;
    std::optional<UiRenderFrame> result;
    for (std::size_t draw_index = 0; draw_index < source.draws.size(); ++draw_index) {
        const auto& draw = source.draws[draw_index];
        const auto texture =
            std::find_if(source.textures.begin(), source.textures.end(),
                         [&](const auto& value) { return value.id == draw.texture_id; });
        if (texture == source.textures.end() || texture->external_canvas == invalid_handle)
            continue;
        const auto canvas = std::find_if(canvases.begin(), canvases.end(), [&](const auto& value) {
            return value.element.value == texture->external_canvas;
        });
        if (canvas == canvases.end() || canvas->frame.uv == std::array<float, 4>{0, 0, 1, 1})
            continue;
        if (!result)
            result = source;
        // Indices may share geometry with other draws. Give this view its own vertices.
        auto& target = result->draws[draw_index];
        target.first_index = static_cast<std::uint32_t>(result->indices.size());
        const auto& uv = canvas->frame.uv;
        for (std::uint32_t index = 0; index < draw.index_count; ++index) {
            auto vertex = source.vertices.at(source.indices.at(draw.first_index + index));
            vertex.u = uv[0] + vertex.u * uv[2];
            vertex.v = uv[1] + vertex.v * uv[3];
            result->indices.push_back(static_cast<std::uint32_t>(result->vertices.size()));
            result->vertices.push_back(vertex);
        }
    }
    return result;
}

/** OS-thread-only consumer. Frames contain native GPU leases, never JS values. */
class WindowPresenter {
public:
    virtual ~WindowPresenter() = default;
    virtual OffscreenDevice& device() = 0;
    /** Select presentation pacing before the first frame; the host owns the display clock. */
    virtual void set_display_paced(bool) {}
    virtual bool can_present() = 0;
    virtual bool present(std::span<const WindowCanvasFrame> frames, const UiRenderFrame& ui,
                         const std::string& capture) = 0;
};
std::shared_ptr<WindowPresenter> create_window_sdl_gpu_presenter(SDL_Window* window);
std::shared_ptr<WindowPresenter> create_window_dawn_presenter(SDL_Window* window);
} // namespace bbl::pal
