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
    std::string class_name,
    std::string style);
void ui_add_id_style(
    Engine& engine,
    std::string id,
    std::string style);
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
    /**
     * First index of the trailing full-frame quad the recorder appends after
     * the RmlUi draws. No entry in `draws` references it: the scene renderers
     * draw its six indices to composite their resolved transparent UI layer
     * over the frame, and consumers that blend `draws` straight into their
     * target (the sprite drivers) carry it inert.
     */
    std::uint32_t composite_first_index = 0;
};

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
