#pragma once

#include <bblite/runtime.hpp>

#include <algorithm>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

struct SDL_Window;
union SDL_Event;

namespace bbl {

/** DOM-lowering entry points. They mutate only the retained UI IR. */
UiElementHandle ui_create_element(Engine& engine, std::string_view tag);
UiElementHandle ui_get_element_by_id(
    Engine& engine,
    std::string_view id);
UiClientRect ui_get_client_rect(
    Engine& engine,
    UiElementHandle element);
void ui_set_text(
    Engine& engine,
    UiElementHandle element,
    std::string text);
void ui_set_inner_rml(
    Engine& engine,
    UiElementHandle element,
    std::string markup);
UiElementHandle ui_query_markup(
    Engine& engine,
    UiElementHandle owner,
    std::uint32_t node_id,
    std::string_view tag);
std::string ui_get_attribute(
    Engine& engine,
    UiElementHandle element,
    std::string_view name);
std::string ui_escape_rml(std::string_view text);
void ui_set_attribute(
    Engine& engine,
    UiElementHandle element,
    std::string name,
    std::string value);
void ui_set_style_property(
    Engine& engine,
    UiElementHandle element,
    std::string name,
    std::string value);
std::string ui_get_style_property(
    Engine& engine,
    UiElementHandle element,
    std::string_view name);
void ui_toggle_class(
    Engine& engine,
    UiElementHandle element,
    std::string name,
    bool enabled);
void ui_add_class_style(
    Engine& engine,
    UiElementHandle stylesheet,
    std::string class_name,
    std::string style);
void ui_clear_style_rules(
    Engine& engine,
    UiElementHandle stylesheet);
void ui_add_id_style(
    Engine& engine,
    UiElementHandle stylesheet,
    std::string id,
    std::string style);
void ui_add_style_rule(
    Engine& engine,
    UiElementHandle stylesheet,
    UiStyleSelectorKind selector,
    std::string primary,
    std::string secondary,
    std::string tag,
    bool hover,
    double max_width,
    std::string style);
void ui_add_host_style_rule(
    Engine& engine,
    UiStyleSelectorKind selector,
    std::string primary,
    std::string secondary,
    std::string tag,
    bool hover,
    double max_width,
    std::string style,
    bool focus_visible = false);
js::Array<UiElementHandle> ui_query_class(
    Engine& engine,
    UiElementHandle root,
    std::string_view class_name);
UiElementHandle ui_append_child(
    Engine& engine,
    UiElementHandle parent,
    UiElementHandle child);
UiElementHandle ui_append_to_root(
    Engine& engine,
    UiElementHandle child);
void ui_replace_children(Engine& engine, UiElementHandle parent);
void ui_remove(Engine& engine, UiElementHandle element);
void ui_on_click(
    Engine& engine,
    UiElementHandle element,
    std::function<void()> callback);
/** Programmatic HTMLElement.click(), including reached default actions. */
void ui_click(Engine& engine, UiElementHandle element);
void ui_focus(Engine& engine, UiElementHandle element, bool visible = true);
UiElementHandle ui_active_element(Engine& engine);
#if defined(BBLITE_HAS_BROWSER_FILE) && BBLITE_HAS_BROWSER_FILE
void ui_set_download_url(
    Engine& engine,
    UiElementHandle element,
    ObjectUrlHandle url);
void ui_set_download_name(
    Engine& engine,
    UiElementHandle element,
    std::string name);
void ui_set_file_input(Engine& engine, UiElementHandle element);
void ui_set_file_accept(
    Engine& engine,
    UiElementHandle element,
    std::string accept);
void ui_on_file_change(
    Engine& engine,
    UiElementHandle element,
    std::function<void()> callback);
#endif
void ui_on_event(
    Engine& engine,
    UiElementHandle element,
    std::string event,
    std::function<void(const PlatformMouseEvent&)> callback);

/** Bounded Canvas2D command IR used by retained UI canvas elements. */
void ui_canvas_set_width(Engine&, UiElementHandle, double);
void ui_canvas_set_height(Engine&, UiElementHandle, double);
double ui_canvas_width(Engine&, UiElementHandle);
double ui_canvas_height(Engine&, UiElementHandle);
void ui_canvas_set_fill_style(Engine&, UiElementHandle, std::string);
void ui_canvas_set_stroke_style(Engine&, UiElementHandle, std::string);
void ui_canvas_set_line_width(Engine&, UiElementHandle, double);
void ui_canvas_set_line_join(Engine&, UiElementHandle, std::string);
void ui_canvas_set_line_cap(Engine&, UiElementHandle, std::string);
void ui_canvas_scale(Engine&, UiElementHandle, double, double);
void ui_canvas_clear_rect(Engine&, UiElementHandle, double, double, double, double);
void ui_canvas_begin_path(Engine&, UiElementHandle);
void ui_canvas_move_to(Engine&, UiElementHandle, double, double);
void ui_canvas_line_to(Engine&, UiElementHandle, double, double);
void ui_canvas_close_path(Engine&, UiElementHandle);
void ui_canvas_arc_to(Engine&, UiElementHandle, double, double, double, double, double);
void ui_canvas_arc(Engine&, UiElementHandle, double, double, double, double, double, bool);
void ui_canvas_fill(Engine&, UiElementHandle);
void ui_canvas_stroke(Engine&, UiElementHandle);
void ui_canvas_set_image_smoothing(Engine&, UiElementHandle, bool);
void ui_canvas_put_image_data(
    Engine&,
    UiElementHandle,
    const js::U8Array&,
    double,
    double,
    double,
    double);
void ui_canvas_draw_image(
    Engine&,
    UiElementHandle,
    UiElementHandle,
    double,
    double,
    double,
    double);
void ui_canvas_set_font(Engine&, UiElementHandle, std::string);
void ui_canvas_set_text_baseline(Engine&, UiElementHandle, std::string);
void ui_canvas_set_shadow_color(Engine&, UiElementHandle, std::string);
void ui_canvas_set_shadow_blur(Engine&, UiElementHandle, double);
void ui_canvas_fill_text(
    Engine&,
    UiElementHandle,
    std::string,
    double,
    double);

namespace pal {

/** Backend-neutral vertex stream recorded from RmlUi. */
struct UiRenderVertex {
    float x = 0.0f;
    float y = 0.0f;
    std::uint8_t red = 0;
    std::uint8_t green = 0;
    std::uint8_t blue = 0;
    std::uint8_t alpha = 0;
    float u = 0.0f;
    float v = 0.0f;
};

struct UiRenderTexture {
    std::uint64_t id = 0;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    std::shared_ptr<const std::vector<std::uint8_t>> rgba;
};

struct UiRenderDraw {
    std::uint32_t first_index = 0;
    std::uint32_t index_count = 0;
    std::uint64_t texture_id = 0;
    std::int32_t scissor_x = 0;
    std::int32_t scissor_y = 0;
    std::uint32_t scissor_width = 0;
    std::uint32_t scissor_height = 0;
    bool nearest_sampling = false;
};

/** A backdrop snapshot and separable blur, ordered between ordinary UI draws. */
struct UiBackdrop {
    static constexpr std::uint32_t sample_index_count = 6;

    std::uint32_t before_draw = 0;
    std::int32_t left = 0;
    std::int32_t top = 0;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    std::uint32_t blur_width = 0;
    std::uint32_t blur_height = 0;
    std::uint32_t sample_index = 0;
    std::uint32_t kernel_index_count = 0;
    std::uint32_t composite_index_count = 0;

    std::uint32_t horizontal_index() const {
        return sample_index + sample_index_count;
    }
    std::uint32_t vertical_index() const {
        return horizontal_index() + kernel_index_count;
    }
    std::uint32_t composite_index() const {
        return vertical_index() + kernel_index_count;
    }
};

/**
 * One self-contained RmlUi frame. GPU backends upload the aggregate geometry,
 * cache textures by id, and own all render-target/sample-count decisions.
 */
struct UiRenderFrame {
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    std::vector<UiRenderVertex> vertices;
    std::vector<std::uint32_t> indices;
    std::vector<UiRenderTexture> textures;
    std::vector<UiRenderDraw> draws;
    std::vector<UiBackdrop> backdrops;
    /**
     * First index of the trailing full-frame quad the recorder appends after
     * the RmlUi draws. No entry in `draws` references it: the scene renderers
     * draw its six indices to composite their resolved transparent UI layer
     * over the frame, and consumers that blend `draws` straight into their
     * target (the sprite drivers) carry it inert.
     */
    std::uint32_t composite_first_index = 0;
};

inline void append_ui_quad(
    UiRenderFrame& frame,
    float left,
    float top,
    float right,
    float bottom,
    std::uint8_t color) {
    const std::uint32_t base =
        static_cast<std::uint32_t>(frame.vertices.size());
    frame.vertices.insert(
        frame.vertices.end(),
        {
            UiRenderVertex{left, top, color, color, color, 255, 0, 0},
            UiRenderVertex{right, top, color, color, color, 255, 1, 0},
            UiRenderVertex{right, bottom, color, color, color, 255, 1, 1},
            UiRenderVertex{left, bottom, color, color, color, 255, 0, 1},
        });
    frame.indices.insert(
        frame.indices.end(),
        {
            base,
            base + 1,
            base + 2,
            base,
            base + 2,
            base + 3,
        });
}

/** Browser host chrome for a programmatically focused render canvas. */
inline void append_canvas_focus_outline(UiRenderFrame& frame) {
    if (frame.width < 2u || frame.height < 2u) return;
    const std::uint32_t first_index =
        static_cast<std::uint32_t>(frame.indices.size());
    frame.vertices.reserve(frame.vertices.size() + 16u);
    frame.indices.reserve(frame.indices.size() + 24u);
    const float width = static_cast<float>(frame.width);
    const float height = static_cast<float>(frame.height);
    append_ui_quad(frame, 0, 0, width, 1, 16);
    append_ui_quad(frame, 0, height - 1, width, height, 16);
    append_ui_quad(frame, 0, 1, 1, height - 1, 16);
    append_ui_quad(frame, width - 1, 1, width, height - 1, 16);
    frame.draws.push_back(UiRenderDraw{
        first_index,
        static_cast<std::uint32_t>(frame.indices.size()) - first_index,
        0,
        0,
        0,
        frame.width,
        frame.height,
        false});
}

inline bool ui_frame_uses_texture(
    const UiRenderFrame& frame,
    std::uint64_t id) {
    return std::any_of(
        frame.textures.begin(),
        frame.textures.end(),
        [id](const UiRenderTexture& texture) {
            return texture.id == id;
        });
}

/** Opaque RmlUi projection of an engine's retained UI tree. */
struct UiRmlRuntime;

UiRmlRuntime* create_ui_rml_runtime(
    Engine& engine,
    SDL_Window* window,
    std::uint32_t width,
    std::uint32_t height);
void destroy_ui_rml_runtime(UiRmlRuntime* runtime) noexcept;

/** Returns true when the event should continue to the canvas/scene. */
bool handle_ui_rml_event(UiRmlRuntime& runtime, SDL_Event& event);
void update_ui_rml_runtime(
    UiRmlRuntime& runtime,
    std::uint32_t width,
    std::uint32_t height);
/** Record RmlUi output; the active GPU renderer consumes the returned frame. */
const UiRenderFrame& record_ui_rml_frame(
    UiRmlRuntime& runtime,
    std::uint32_t width,
    std::uint32_t height);

} // namespace pal
} // namespace bbl
