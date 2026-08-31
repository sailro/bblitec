#include <bblite/pal_ui.hpp>

#include <RmlUi/Core.h>
#include <RmlUi/Core/Event.h>
#include <RmlUi/Core/EventListener.h>
#include <RmlUi/Core/FileInterface.h>
#include <RmlUi/Core/RenderInterface.h>
#include <SDL3/SDL.h>
#include <SDL3_image/SDL_image.h>

#include "RmlUi_Platform_SDL.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <cstdio>
#include <filesystem>
#include <memory>
#include <numbers>
#include <sstream>
#include <stdexcept>
#include <unordered_map>
#include <utility>
#include <vector>

namespace bbl {
namespace {

UiElementRecord& ui_element(Engine& engine, UiElementHandle handle) {
    if (handle.value >= engine.ui_elements.size()) {
        throw std::runtime_error("Native UI element handle is out of range.");
    }
    return engine.ui_elements[handle.value];
}

void mark_ui_changed(Engine& engine) {
    ++engine.ui_revision;
}

} // namespace

UiElementHandle ui_create_element(Engine& engine, std::string_view tag) {
    if (tag.empty()) {
        throw std::runtime_error("Native UI element tag cannot be empty.");
    }
    const UiElementHandle handle{
        static_cast<std::uint32_t>(engine.ui_elements.size())};
    UiElementRecord element;
    element.tag = std::string(tag);
    if (tag == "canvas") element.canvas.emplace();
    engine.ui_elements.push_back(std::move(element));
    mark_ui_changed(engine);
    return handle;
}

UiElementHandle ui_get_element_by_id(
    Engine& engine,
    std::string_view id) {
    for (std::uint32_t index = 0; index < engine.ui_elements.size(); ++index) {
        const auto attribute = engine.ui_elements[index].attributes.find("id");
        if (
            attribute != engine.ui_elements[index].attributes.end() &&
            attribute->second == id) {
            return UiElementHandle{index};
        }
    }
    throw std::runtime_error(
        "Audited native host UI element id was not materialized: " +
        std::string(id));
}

void ui_set_text(
    Engine& engine,
    UiElementHandle element,
    std::string text) {
    UiElementRecord& record = ui_element(engine, element);
    if (record.text == text && record.inner_rml.empty()) return;
    record.text = std::move(text);
    record.inner_rml.clear();
    mark_ui_changed(engine);
}

void ui_set_inner_rml(
    Engine& engine,
    UiElementHandle element,
    std::string markup) {
    UiElementRecord& record = ui_element(engine, element);
    if (record.inner_rml == markup && record.text.empty()) return;
    record.inner_rml = std::move(markup);
    record.text.clear();
    mark_ui_changed(engine);
}

void ui_set_attribute(
    Engine& engine,
    UiElementHandle element,
    std::string name,
    std::string value) {
    if (name.empty()) {
        throw std::runtime_error("Native UI attribute name cannot be empty.");
    }
    UiElementRecord& record = ui_element(engine, element);
    const auto existing = record.attributes.find(name);
    if (
        existing != record.attributes.end() &&
        existing->second == value) {
        return;
    }
    record.attributes.insert_or_assign(std::move(name), std::move(value));
    mark_ui_changed(engine);
}

void ui_set_style_property(
    Engine& engine,
    UiElementHandle element,
    std::string name,
    std::string value) {
    if (name.empty()) {
        throw std::runtime_error("Native UI style property name cannot be empty.");
    }
    UiElementRecord& record = ui_element(engine, element);
    const auto existing = record.style_properties.find(name);
    if (
        existing != record.style_properties.end() &&
        existing->second == value) {
        return;
    }
    record.style_properties.insert_or_assign(
        std::move(name),
        std::move(value));
    mark_ui_changed(engine);
}

void ui_toggle_class(
    Engine& engine,
    UiElementHandle element,
    std::string name,
    bool enabled) {
    if (name.empty()) {
        throw std::runtime_error("Native UI class name cannot be empty.");
    }
    UiElementRecord& record = ui_element(engine, element);
    std::vector<std::string> classes;
    std::istringstream input(record.attributes["class"]);
    for (std::string token; input >> token;) {
        if (token != name) classes.push_back(std::move(token));
    }
    if (enabled) classes.push_back(std::move(name));
    std::string joined;
    for (const std::string& token : classes) {
        if (!joined.empty()) joined += ' ';
        joined += token;
    }
    if (record.attributes["class"] == joined) return;
    record.attributes.insert_or_assign("class", std::move(joined));
    mark_ui_changed(engine);
}

void ui_add_class_style(
    Engine& engine,
    std::string class_name,
    std::string style) {
    if (class_name.empty()) {
        throw std::runtime_error("Native UI class style name cannot be empty.");
    }
    engine.ui_class_style_rules.push_back(
        {std::move(class_name), std::move(style)});
    mark_ui_changed(engine);
}

UiElementHandle ui_append_child(
    Engine& engine,
    UiElementHandle parent,
    UiElementHandle child) {
    UiElementRecord& parent_record = ui_element(engine, parent);
    UiElementRecord& child_record = ui_element(engine, child);
    if (parent.value == child.value) {
        throw std::runtime_error("A native UI element cannot contain itself.");
    }
    for (
        UiElementHandle ancestor = parent;
        ancestor.value != invalid_handle;
        ancestor = ui_element(engine, ancestor).parent) {
        if (ancestor.value == child.value) {
            throw std::runtime_error(
                "A native UI element cannot contain one of its ancestors.");
        }
    }
    if (
        child_record.parent.value != invalid_handle ||
        child_record.attached_to_root) {
        throw std::runtime_error(
            "Reparenting an attached native UI element is not implemented.");
    }
    child_record.parent = parent;
    parent_record.children.push_back(child);
    mark_ui_changed(engine);
    return child;
}

UiElementHandle ui_append_to_root(
    Engine& engine,
    UiElementHandle child) {
    UiElementRecord& record = ui_element(engine, child);
    if (
        record.parent.value != invalid_handle ||
        record.attached_to_root) {
        throw std::runtime_error(
            "A native UI element may only be attached to one parent.");
    }
    record.attached_to_root = true;
    mark_ui_changed(engine);
    return child;
}

void ui_replace_children(Engine& engine, UiElementHandle parent) {
    UiElementRecord& record = ui_element(engine, parent);
    for (const UiElementHandle child : record.children) {
        ui_element(engine, child).parent = {};
    }
    if (
        record.children.empty() &&
        record.text.empty() &&
        record.inner_rml.empty()) {
        return;
    }
    record.children.clear();
    record.text.clear();
    record.inner_rml.clear();
    mark_ui_changed(engine);
}

void ui_remove(Engine& engine, UiElementHandle element) {
    UiElementRecord& record = ui_element(engine, element);
    if (record.parent.value != invalid_handle) {
        UiElementRecord& parent = ui_element(engine, record.parent);
        parent.children.erase(
            std::remove_if(
                parent.children.begin(),
                parent.children.end(),
                [element](UiElementHandle child) {
                    return child.value == element.value;
                }),
            parent.children.end());
        record.parent = {};
    }
    record.attached_to_root = false;
    mark_ui_changed(engine);
}

void ui_on_click(
    Engine& engine,
    UiElementHandle element,
    std::function<void()> callback) {
    if (!callback) {
        throw std::runtime_error("Native UI click callback is empty.");
    }
    ui_element(engine, element).click_callbacks.push_back(
        std::move(callback));
    mark_ui_changed(engine);
}

void ui_on_event(
    Engine& engine,
    UiElementHandle element,
    std::string event,
    std::function<void()> callback) {
    if (event.empty() || !callback) {
        throw std::runtime_error("Native UI event registration is invalid.");
    }
    ui_element(engine, element).event_callbacks[std::move(event)].push_back(
        std::move(callback));
    mark_ui_changed(engine);
}

namespace {

UiElementRecord::CanvasState& ui_canvas(
    Engine& engine,
    UiElementHandle element) {
    UiElementRecord& record = ui_element(engine, element);
    if (!record.canvas) {
        throw std::runtime_error("Canvas2D operation requires a canvas element.");
    }
    return *record.canvas;
}

UiElementRecord::CanvasPoint canvas_point(
    const UiElementRecord::CanvasState& canvas,
    double x,
    double y) {
    return {x * canvas.scale_x, y * canvas.scale_y};
}

double cross(
    UiElementRecord::CanvasPoint a,
    UiElementRecord::CanvasPoint b) {
    return a.x * b.y - a.y * b.x;
}

void reset_canvas(
    UiElementRecord::CanvasState& canvas,
    double width,
    double height) {
    canvas = {};
    canvas.width = std::max(0.0, std::floor(width));
    canvas.height = std::max(0.0, std::floor(height));
}

} // namespace

void ui_canvas_set_width(
    Engine& engine,
    UiElementHandle element,
    double width) {
    auto& canvas = ui_canvas(engine, element);
    reset_canvas(canvas, width, canvas.height);
}

void ui_canvas_set_height(
    Engine& engine,
    UiElementHandle element,
    double height) {
    auto& canvas = ui_canvas(engine, element);
    reset_canvas(canvas, canvas.width, height);
}

double ui_canvas_width(Engine& engine, UiElementHandle element) {
    return ui_canvas(engine, element).width;
}

double ui_canvas_height(Engine& engine, UiElementHandle element) {
    return ui_canvas(engine, element).height;
}

void ui_canvas_set_fill_style(
    Engine& engine,
    UiElementHandle element,
    std::string value) {
    ui_canvas(engine, element).fill_style = std::move(value);
}

void ui_canvas_set_stroke_style(
    Engine& engine,
    UiElementHandle element,
    std::string value) {
    ui_canvas(engine, element).stroke_style = std::move(value);
}

void ui_canvas_set_line_width(
    Engine& engine,
    UiElementHandle element,
    double value) {
    ui_canvas(engine, element).line_width = std::max(0.0, value);
}

void ui_canvas_set_line_join(
    Engine& engine,
    UiElementHandle element,
    std::string value) {
    ui_canvas(engine, element).line_join = std::move(value);
}

void ui_canvas_set_line_cap(
    Engine& engine,
    UiElementHandle element,
    std::string value) {
    ui_canvas(engine, element).line_cap = std::move(value);
}

void ui_canvas_scale(
    Engine& engine,
    UiElementHandle element,
    double x,
    double y) {
    auto& canvas = ui_canvas(engine, element);
    canvas.scale_x *= x;
    canvas.scale_y *= y;
}

void ui_canvas_clear_rect(
    Engine& engine,
    UiElementHandle element,
    double,
    double,
    double,
    double) {
    // The reached overlays clear their full backing store once per update.
    // Keep clearRect bounded to that retained-frame behavior for now.
    ui_canvas(engine, element).draws.clear();
}

void ui_canvas_begin_path(Engine& engine, UiElementHandle element) {
    auto& canvas = ui_canvas(engine, element);
    canvas.path.clear();
    canvas.path_closed = false;
}

void ui_canvas_move_to(
    Engine& engine,
    UiElementHandle element,
    double x,
    double y) {
    auto& canvas = ui_canvas(engine, element);
    // The current slice has one sub-path per beginPath.
    canvas.path.clear();
    canvas.path.push_back(canvas_point(canvas, x, y));
    canvas.path_closed = false;
}

void ui_canvas_line_to(
    Engine& engine,
    UiElementHandle element,
    double x,
    double y) {
    auto& canvas = ui_canvas(engine, element);
    canvas.path.push_back(canvas_point(canvas, x, y));
}

void ui_canvas_close_path(Engine& engine, UiElementHandle element) {
    ui_canvas(engine, element).path_closed = true;
}

void ui_canvas_arc_to(
    Engine& engine,
    UiElementHandle element,
    double x1,
    double y1,
    double x2,
    double y2,
    double radius) {
    auto& canvas = ui_canvas(engine, element);
    const auto p1 = canvas_point(canvas, x1, y1);
    const auto p2 = canvas_point(canvas, x2, y2);
    const double scaled_radius = radius *
        (std::abs(canvas.scale_x) + std::abs(canvas.scale_y)) * 0.5;
    if (canvas.path.empty() || scaled_radius <= 0.0) {
        canvas.path.push_back(p1);
        return;
    }
    const auto p0 = canvas.path.back();
    auto unit = [](UiElementRecord::CanvasPoint value) {
        const double length = std::hypot(value.x, value.y);
        return length > 1e-9
            ? UiElementRecord::CanvasPoint{value.x / length, value.y / length}
            : UiElementRecord::CanvasPoint{};
    };
    const auto u1 = unit({p0.x - p1.x, p0.y - p1.y});
    const auto u2 = unit({p2.x - p1.x, p2.y - p1.y});
    const double dot = std::clamp(u1.x * u2.x + u1.y * u2.y, -1.0, 1.0);
    const double angle = std::acos(dot);
    if (angle < 1e-6 || std::abs(angle - std::numbers::pi) < 1e-6) {
        canvas.path.push_back(p1);
        return;
    }
    const double tangent = scaled_radius / std::tan(angle * 0.5);
    const UiElementRecord::CanvasPoint start{
        p1.x + u1.x * tangent,
        p1.y + u1.y * tangent};
    const UiElementRecord::CanvasPoint end{
        p1.x + u2.x * tangent,
        p1.y + u2.y * tangent};
    const auto bisector = unit({u1.x + u2.x, u1.y + u2.y});
    const double centre_distance = scaled_radius / std::sin(angle * 0.5);
    const UiElementRecord::CanvasPoint centre{
        p1.x + bisector.x * centre_distance,
        p1.y + bisector.y * centre_distance};
    canvas.path.push_back(start);
    double a0 = std::atan2(start.y - centre.y, start.x - centre.x);
    double a1 = std::atan2(end.y - centre.y, end.x - centre.x);
    double delta = a1 - a0;
    if (cross(u1, u2) < 0.0) {
        while (delta < 0.0) delta += 2.0 * std::numbers::pi;
    } else {
        while (delta > 0.0) delta -= 2.0 * std::numbers::pi;
    }
    constexpr int segments = 6;
    for (int index = 1; index <= segments; ++index) {
        const double angle_at = a0 + delta * index / segments;
        canvas.path.push_back({
            centre.x + std::cos(angle_at) * scaled_radius,
            centre.y + std::sin(angle_at) * scaled_radius});
    }
}

void ui_canvas_arc(
    Engine& engine,
    UiElementHandle element,
    double x,
    double y,
    double radius,
    double start,
    double end,
    bool anticlockwise) {
    auto& canvas = ui_canvas(engine, element);
    double delta = end - start;
    if (!anticlockwise) {
        while (delta < 0.0) delta += 2.0 * std::numbers::pi;
        if (delta > 2.0 * std::numbers::pi) delta = 2.0 * std::numbers::pi;
    } else {
        while (delta > 0.0) delta -= 2.0 * std::numbers::pi;
        if (delta < -2.0 * std::numbers::pi) delta = -2.0 * std::numbers::pi;
    }
    const int segments = std::max(
        4,
        static_cast<int>(std::ceil(std::abs(delta) * 24.0 /
            (2.0 * std::numbers::pi))));
    for (int index = 0; index <= segments; ++index) {
        const double angle = start + delta * index / segments;
        canvas.path.push_back(canvas_point(
            canvas,
            x + std::cos(angle) * radius,
            y + std::sin(angle) * radius));
    }
}

void ui_canvas_fill(Engine& engine, UiElementHandle element) {
    auto& canvas = ui_canvas(engine, element);
    if (canvas.path.size() < 3) return;
    canvas.draws.push_back({
        UiElementRecord::CanvasDrawCommand::Kind::Fill,
        canvas.path,
        canvas.fill_style,
        0.0,
        true,
        false,
        false});
}

void ui_canvas_stroke(Engine& engine, UiElementHandle element) {
    auto& canvas = ui_canvas(engine, element);
    if (canvas.path.size() < 2) return;
    canvas.draws.push_back({
        UiElementRecord::CanvasDrawCommand::Kind::Stroke,
        canvas.path,
        canvas.stroke_style,
        canvas.line_width *
            (std::abs(canvas.scale_x) + std::abs(canvas.scale_y)) * 0.5,
        canvas.path_closed,
        canvas.line_join == "round",
        canvas.line_cap == "round"});
}

namespace pal {
namespace {

class UiEventListener final : public Rml::EventListener {
public:
    UiEventListener(
        Engine& engine,
        UiElementHandle element,
        std::string event)
        : engine(engine), element(element), event_type(std::move(event)) {}

    void ProcessEvent(Rml::Event& event) override {
        // Copy the callback list so a callback may safely mutate UI state.
        const UiElementRecord& record = ui_element(engine, element);
        const auto callbacks = event_type == "click"
            ? record.click_callbacks
            : record.event_callbacks.at(event_type);
        for (const auto& callback : callbacks) callback();
        event.StopPropagation();
    }

private:
    Engine& engine;
    UiElementHandle element;
    std::string event_type;
};

struct FontChoice {
    std::filesystem::path path;
    std::filesystem::path bold_path;
    std::string css_family;
};

FontChoice system_ui_font() {
#if defined(_WIN32)
    const FontChoice candidates[] = {
        {
            "C:/Windows/Fonts/segoeui.ttf",
            "C:/Windows/Fonts/segoeuib.ttf",
            "'Segoe UI'"},
        {
            "C:/Windows/Fonts/arial.ttf",
            "C:/Windows/Fonts/arialbd.ttf",
            "Arial"},
    };
#elif defined(__APPLE__)
    const FontChoice candidates[] = {
        {
            "/System/Library/Fonts/Supplemental/Arial.ttf",
            "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
            "Arial"},
        {
            "/System/Library/Fonts/Helvetica.ttc",
            "/System/Library/Fonts/Helvetica.ttc",
            "Helvetica"},
    };
#else
    const FontChoice candidates[] = {
        {
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
            "'DejaVu Sans'"},
        {
            "/usr/share/fonts/TTF/DejaVuSans.ttf",
            "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
            "'DejaVu Sans'"},
    };
#endif
    for (const FontChoice& candidate : candidates) {
        if (std::filesystem::exists(candidate.path)) return candidate;
    }
    throw std::runtime_error(
        "RmlUi could not find a supported system sans-serif font.");
}

std::vector<std::filesystem::path> system_ui_fallback_fonts() {
#if defined(_WIN32)
    return {"C:/Windows/Fonts/seguisym.ttf"};
#elif defined(__APPLE__)
    return {
        "/System/Library/Fonts/Apple Symbols.ttf",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"};
#else
    return {
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/TTF/DejaVuSans.ttf"};
#endif
}

void replace_all(
    std::string& text,
    std::string_view needle,
    std::string_view replacement) {
    std::size_t position = 0;
    while ((position = text.find(needle, position)) != std::string::npos) {
        text.replace(position, needle.size(), replacement);
        position += replacement.size();
    }
}

std::string rml_css_color_alpha(std::string value) {
    // RmlUi's legacy rgba() parser expects all four channels in 0..255,
    // while browser CSS uses a fractional alpha. Translate only that alpha
    // and leave the rest of the declaration untouched.
    std::size_t position = 0;
    while ((position = value.find("rgba(", position)) != std::string::npos) {
        const std::size_t end = value.find(')', position + 5);
        if (end == std::string::npos) break;
        const std::string function = value.substr(position, end - position + 1);
        double red = 0.0;
        double green = 0.0;
        double blue = 0.0;
        double alpha = 0.0;
        if (
            std::sscanf(
                function.c_str(),
                "rgba(%lf,%lf,%lf,%lf)",
                &red,
                &green,
                &blue,
                &alpha) == 4 &&
            alpha >= 0.0 &&
            alpha <= 1.0) {
            char translated[80]{};
            std::snprintf(
                translated,
                sizeof(translated),
                "rgba(%d,%d,%d,%d)",
                static_cast<int>(std::lround(red)),
                static_cast<int>(std::lround(green)),
                static_cast<int>(std::lround(blue)),
                static_cast<int>(std::lround(alpha * 255.0)));
            value.replace(position, function.size(), translated);
            position += std::char_traits<char>::length(translated);
        } else {
            position = end + 1;
        }
    }
    return value;
}

Rml::ColourbPremultiplied canvas_color(std::string_view source) {
    double red = 0.0;
    double green = 0.0;
    double blue = 0.0;
    double alpha = 1.0;
    const std::string value(source);
    if (value.size() == 4 && value[0] == '#') {
        auto nibble = [](char digit) {
            if (digit >= '0' && digit <= '9') return digit - '0';
            if (digit >= 'a' && digit <= 'f') return digit - 'a' + 10;
            if (digit >= 'A' && digit <= 'F') return digit - 'A' + 10;
            return 0;
        };
        red = nibble(value[1]) * 17;
        green = nibble(value[2]) * 17;
        blue = nibble(value[3]) * 17;
    } else if (value.size() == 7 && value[0] == '#') {
        unsigned parsed_red = 0;
        unsigned parsed_green = 0;
        unsigned parsed_blue = 0;
        if (std::sscanf(
                value.c_str(),
                "#%02x%02x%02x",
                &parsed_red,
                &parsed_green,
                &parsed_blue) != 3) {
            return {};
        }
        red = parsed_red;
        green = parsed_green;
        blue = parsed_blue;
    } else if (
        std::sscanf(
            value.c_str(),
            "rgba(%lf,%lf,%lf,%lf)",
            &red,
            &green,
            &blue,
            &alpha) != 4) {
        return {};
    }
    alpha = std::clamp(alpha, 0.0, 1.0);
    const auto channel = [alpha](double component) {
        return static_cast<Rml::byte>(std::clamp(
            std::lround(component * alpha),
            0l,
            255l));
    };
    return {
        channel(red),
        channel(green),
        channel(blue),
        static_cast<Rml::byte>(std::lround(alpha * 255.0))};
}

struct CanvasMesh {
    Rml::Vector<Rml::Vertex> vertices;
    Rml::Vector<int> indices;
};

int append_canvas_vertex(
    CanvasMesh& mesh,
    double x,
    double y,
    Rml::ColourbPremultiplied color) {
    const int index = static_cast<int>(mesh.vertices.size());
    mesh.vertices.push_back({
        {static_cast<float>(x), static_cast<float>(y)},
        color,
        {0.0f, 0.0f}});
    return index;
}

void append_canvas_disk(
    CanvasMesh& mesh,
    UiElementRecord::CanvasPoint centre,
    double radius,
    Rml::ColourbPremultiplied color) {
    constexpr int segment_count = 12;
    const int centre_index = append_canvas_vertex(
        mesh,
        centre.x,
        centre.y,
        color);
    int previous = append_canvas_vertex(
        mesh,
        centre.x + radius,
        centre.y,
        color);
    for (int segment = 1; segment <= segment_count; ++segment) {
        const double angle =
            2.0 * std::numbers::pi * segment / segment_count;
        const int current = append_canvas_vertex(
            mesh,
            centre.x + std::cos(angle) * radius,
            centre.y + std::sin(angle) * radius,
            color);
        mesh.indices.insert(
            mesh.indices.end(),
            {centre_index, previous, current});
        previous = current;
    }
}

CanvasMesh canvas_mesh(
    const UiElementRecord::CanvasDrawCommand& draw,
    double scale_x,
    double scale_y) {
    CanvasMesh mesh;
    if (draw.points.empty()) return mesh;
    std::vector<UiElementRecord::CanvasPoint> points;
    points.reserve(draw.points.size());
    for (const auto point : draw.points) {
        points.push_back({point.x * scale_x, point.y * scale_y});
    }
    const auto color = canvas_color(draw.color);
    if (draw.kind == UiElementRecord::CanvasDrawCommand::Kind::Fill) {
        if (points.size() < 3) return mesh;
        const int first = append_canvas_vertex(
            mesh,
            points[0].x,
            points[0].y,
            color);
        for (std::size_t index = 1; index + 1 < points.size(); ++index) {
            const int left = append_canvas_vertex(
                mesh,
                points[index].x,
                points[index].y,
                color);
            const int right = append_canvas_vertex(
                mesh,
                points[index + 1].x,
                points[index + 1].y,
                color);
            mesh.indices.insert(mesh.indices.end(), {first, left, right});
        }
        return mesh;
    }

    const double half_width = draw.line_width *
        (std::abs(scale_x) + std::abs(scale_y)) * 0.25;
    const std::size_t segment_count =
        draw.closed ? points.size() : points.size() - 1;
    for (std::size_t segment = 0; segment < segment_count; ++segment) {
        const auto a = points[segment];
        const auto b = points[(segment + 1) % points.size()];
        const double length = std::hypot(b.x - a.x, b.y - a.y);
        if (length <= 1e-9) continue;
        const double nx = -(b.y - a.y) * half_width / length;
        const double ny = (b.x - a.x) * half_width / length;
        const int base = static_cast<int>(mesh.vertices.size());
        append_canvas_vertex(mesh, a.x + nx, a.y + ny, color);
        append_canvas_vertex(mesh, a.x - nx, a.y - ny, color);
        append_canvas_vertex(mesh, b.x - nx, b.y - ny, color);
        append_canvas_vertex(mesh, b.x + nx, b.y + ny, color);
        mesh.indices.insert(
            mesh.indices.end(),
            {base, base + 1, base + 2, base, base + 2, base + 3});
    }
    if (draw.round_join) {
        const std::size_t first = draw.closed ? 0 : 1;
        const std::size_t last = draw.closed
            ? points.size()
            : points.size() - 1;
        for (std::size_t index = first; index < last; ++index) {
            append_canvas_disk(mesh, points[index], half_width, color);
        }
    }
    if (draw.round_cap && !draw.closed) {
        append_canvas_disk(mesh, points.front(), half_width, color);
        append_canvas_disk(mesh, points.back(), half_width, color);
    }
    return mesh;
}

} // namespace

struct ProjectedUiElement {
    Rml::Element* element = nullptr;
    std::string text;
    std::string inner_rml;
    std::unordered_map<std::string, std::string> attributes;
    std::unordered_map<std::string, std::string> style_properties;
    std::string resolved_style;
    bool text_wrapped = false;
    bool click_listener_attached = false;
    std::unordered_map<std::string, bool> event_listeners_attached;
};

/**
 * CPU-side RmlUi renderer. It deliberately owns no graphics API objects:
 * RmlUi compiles retained geometry here and each PAL renderer consumes the
 * resulting self-contained frame using its own targets, sample count, and
 * compositing rules.
 */
class UiRenderRecorder final : public Rml::RenderInterface {
public:
    void begin_frame(std::uint32_t width, std::uint32_t height) {
        frame = {};
        frame.width = width;
        frame.height = height;
        scissor_enabled = false;
        scissor = Rml::Rectanglei::FromSize(Rml::Vector2i{
            static_cast<int>(width), static_cast<int>(height)});
        transform = Rml::Matrix4f::Identity();
    }

    Rml::CompiledGeometryHandle CompileGeometry(
        Rml::Span<const Rml::Vertex> vertices,
        Rml::Span<const int> indices) override {
        auto geometry = std::make_unique<Geometry>();
        geometry->vertices.assign(vertices.begin(), vertices.end());
        geometry->indices.assign(indices.begin(), indices.end());
        return reinterpret_cast<Rml::CompiledGeometryHandle>(
            geometry.release());
    }

    void RenderGeometry(
        Rml::CompiledGeometryHandle handle,
        Rml::Vector2f translation,
        Rml::TextureHandle texture_handle) override {
        if (!handle) return;
        const Geometry& geometry = *reinterpret_cast<const Geometry*>(handle);
        if (geometry.vertices.empty() || geometry.indices.empty()) return;

        const std::uint32_t base_vertex =
            static_cast<std::uint32_t>(frame.vertices.size());
        const std::uint32_t first_index =
            static_cast<std::uint32_t>(frame.indices.size());
        frame.vertices.reserve(frame.vertices.size() + geometry.vertices.size());
        frame.indices.reserve(frame.indices.size() + geometry.indices.size());

        for (const Rml::Vertex& source : geometry.vertices) {
            Rml::Vector4f position{
                source.position.x + translation.x,
                source.position.y + translation.y,
                0.0f,
                1.0f};
            position = transform * position;
            if (std::abs(position.w) > 1e-7f) {
                position.x /= position.w;
                position.y /= position.w;
            }
            frame.vertices.push_back(UiRenderVertex{
                position.x,
                position.y,
                source.colour.red,
                source.colour.green,
                source.colour.blue,
                source.colour.alpha,
                source.tex_coord.x,
                source.tex_coord.y});
        }
        for (const int index : geometry.indices) {
            if (index < 0) continue;
            frame.indices.push_back(
                base_vertex + static_cast<std::uint32_t>(index));
        }

        std::uint64_t texture_id = 0;
        if (texture_handle) {
            const Texture& texture =
                *reinterpret_cast<const Texture*>(texture_handle);
            texture_id = texture.id;
            if (std::none_of(
                    frame.textures.begin(),
                    frame.textures.end(),
                    [texture_id](const UiRenderTexture& entry) {
                        return entry.id == texture_id;
                    })) {
                frame.textures.push_back(UiRenderTexture{
                    texture.id,
                    texture.width,
                    texture.height,
                    texture.rgba});
            }
        }

        const Rml::Rectanglei active_scissor = scissor_enabled
            ? scissor
            : Rml::Rectanglei::FromSize(Rml::Vector2i{
                  static_cast<int>(frame.width),
                  static_cast<int>(frame.height)});
        frame.draws.push_back(UiRenderDraw{
            first_index,
            static_cast<std::uint32_t>(frame.indices.size()) - first_index,
            texture_id,
            active_scissor.Left(),
            active_scissor.Top(),
            static_cast<std::uint32_t>(std::max(0, active_scissor.Width())),
            static_cast<std::uint32_t>(std::max(0, active_scissor.Height()))});
    }

    void ReleaseGeometry(Rml::CompiledGeometryHandle handle) override {
        delete reinterpret_cast<Geometry*>(handle);
    }

    Rml::TextureHandle LoadTexture(
        Rml::Vector2i& texture_dimensions,
        const Rml::String& source) override {
        Rml::FileInterface* files = Rml::GetFileInterface();
        const Rml::FileHandle file = files->Open(source);
        if (!file) return {};
        files->Seek(file, 0, SEEK_END);
        const std::size_t size = files->Tell(file);
        files->Seek(file, 0, SEEK_SET);
        std::vector<Rml::byte> encoded(size);
        files->Read(encoded.data(), size, file);
        files->Close(file);

        const std::size_t extension_offset = source.rfind('.');
        const Rml::String extension = extension_offset == Rml::String::npos
            ? Rml::String{}
            : source.substr(extension_offset + 1);
        SDL_Surface* surface = IMG_LoadTyped_IO(
            SDL_IOFromConstMem(encoded.data(), static_cast<int>(size)),
            true,
            extension.c_str());
        if (!surface) return {};
        if (surface->format != SDL_PIXELFORMAT_RGBA32) {
            SDL_Surface* converted =
                SDL_ConvertSurface(surface, SDL_PIXELFORMAT_RGBA32);
            SDL_DestroySurface(surface);
            surface = converted;
            if (!surface) return {};
        }

        texture_dimensions = {surface->w, surface->h};
        std::vector<Rml::byte> pixels(
            static_cast<std::size_t>(surface->w) * surface->h * 4);
        const auto* source_pixels =
            static_cast<const Rml::byte*>(surface->pixels);
        for (int y = 0; y < surface->h; ++y) {
            std::memcpy(
                pixels.data() + static_cast<std::size_t>(y) * surface->w * 4,
                source_pixels + static_cast<std::size_t>(y) * surface->pitch,
                static_cast<std::size_t>(surface->w) * 4);
        }
        SDL_DestroySurface(surface);

        // SDL_image returns straight alpha. RmlUi vertices and every backend
        // consumer use premultiplied-alpha composition.
        for (std::size_t offset = 0; offset < pixels.size(); offset += 4) {
            const int alpha = pixels[offset + 3];
            pixels[offset] = static_cast<Rml::byte>(pixels[offset] * alpha / 255);
            pixels[offset + 1] = static_cast<Rml::byte>(pixels[offset + 1] * alpha / 255);
            pixels[offset + 2] = static_cast<Rml::byte>(pixels[offset + 2] * alpha / 255);
        }
        return GenerateTexture(pixels, texture_dimensions);
    }

    Rml::TextureHandle GenerateTexture(
        Rml::Span<const Rml::byte> source,
        Rml::Vector2i source_dimensions) override {
        if (
            source_dimensions.x <= 0 ||
            source_dimensions.y <= 0 ||
            source.empty()) {
            return {};
        }
        auto texture = std::make_unique<Texture>();
        texture->id = next_texture_id++;
        texture->width = static_cast<std::uint32_t>(source_dimensions.x);
        texture->height = static_cast<std::uint32_t>(source_dimensions.y);
        texture->rgba = std::make_shared<const std::vector<std::uint8_t>>(
            source.begin(),
            source.end());
        return reinterpret_cast<Rml::TextureHandle>(texture.release());
    }

    void ReleaseTexture(Rml::TextureHandle handle) override {
        delete reinterpret_cast<Texture*>(handle);
    }

    void EnableScissorRegion(bool enable) override {
        scissor_enabled = enable;
    }

    void SetScissorRegion(Rml::Rectanglei region) override {
        scissor = region;
    }

    void SetTransform(const Rml::Matrix4f* new_transform) override {
        transform = new_transform ? *new_transform : Rml::Matrix4f::Identity();
    }

    UiRenderFrame frame;

private:
    struct Geometry {
        std::vector<Rml::Vertex> vertices;
        std::vector<int> indices;
    };

    struct Texture {
        std::uint64_t id = 0;
        std::uint32_t width = 0;
        std::uint32_t height = 0;
        std::shared_ptr<const std::vector<std::uint8_t>> rgba;
    };

    Rml::Rectanglei scissor{};
    Rml::Matrix4f transform = Rml::Matrix4f::Identity();
    std::uint64_t next_texture_id = 1;
    bool scissor_enabled = false;
};

struct UiRmlRuntime {
    UiRmlRuntime(
        Engine& engine,
        SDL_Window* window,
        std::uint32_t width,
        std::uint32_t height)
        : engine(engine),
          window(window),
          system_interface(window) {
        try {
            Rml::SetSystemInterface(&system_interface);
            Rml::SetRenderInterface(&render_interface);
            if (!Rml::Initialise()) {
                throw std::runtime_error("RmlUi initialization failed.");
            }
            initialized = true;

            const FontChoice font = system_ui_font();
            if (!Rml::LoadFontFace(font.path.string())) {
                throw std::runtime_error(
                    "RmlUi failed to load UI font: " + font.path.string());
            }
            if (
                !font.bold_path.empty() &&
                std::filesystem::exists(font.bold_path) &&
                !Rml::LoadFontFace(font.bold_path.string())) {
                throw std::runtime_error(
                    "RmlUi failed to load bold UI font: " +
                    font.bold_path.string());
            }
            for (const std::filesystem::path& fallback :
                 system_ui_fallback_fonts()) {
                if (
                    std::filesystem::exists(fallback) &&
                    !Rml::LoadFontFace(fallback.string(), true)) {
                    throw std::runtime_error(
                        "RmlUi failed to load fallback UI font: " +
                        fallback.string());
                }
            }
            css_font_family = font.css_family;
            context = Rml::CreateContext(
                "bblite-ui",
                Rml::Vector2i{
                    static_cast<int>(width),
                    static_cast<int>(height)});
            if (!context) {
                throw std::runtime_error("RmlUi context creation failed.");
            }
            document = context->CreateDocument();
            if (!document) {
                throw std::runtime_error("RmlUi document creation failed.");
            }
            document->SetAttribute(
                "style",
                "width:100%;height:100%;font-family:" + css_font_family +
                    ";font-size:16px;");
            document->Show(
                Rml::ModalFlag::None,
                Rml::FocusFlag::None,
                Rml::ScrollFlag::None);
            sync_tree();
            context->Update();
        } catch (...) {
            if (initialized) {
                Rml::Shutdown();
                initialized = false;
            }
            throw;
        }
    }

    ~UiRmlRuntime() {
        if (initialized) {
            Rml::Shutdown();
        }
    }

    void ensure_projection_size() {
        if (projected_elements.size() < engine.ui_elements.size()) {
            projected_elements.resize(engine.ui_elements.size());
        }
    }

    std::string projected_attribute_value(
        std::string_view name,
        const std::string& source_value) const {
        std::string value = source_value;
        if (name == "style") {
            replace_all(value, "sans-serif", css_font_family);
            value = rml_css_color_alpha(std::move(value));
        }
        return value;
    }

    static bool has_class(
        const UiElementRecord& record,
        std::string_view class_name) {
        const auto attribute = record.attributes.find("class");
        if (attribute == record.attributes.end()) return false;
        std::istringstream classes(attribute->second);
        for (std::string token; classes >> token;) {
            if (token == class_name) return true;
        }
        return false;
    }

    std::string resolved_style_attribute(
        const UiElementRecord& record) const {
        std::string style;
        const auto append = [&style](std::string_view declaration) {
            if (declaration.empty()) return;
            if (!style.empty() && style.back() != ';') style += ';';
            style += declaration;
        };

        // RmlUi deliberately defaults every unknown tag to inline. Restore
        // the small browser user-agent tag surface reached by our retained
        // DOM so a source `div` remains a block without spelling display.
        if (record.tag == "div" || record.tag == "canvas") {
            append("display:block;");
        } else if (record.tag == "button") {
            // Browser user-agent styles size button percentages against the
            // border box. RmlUi's generic unknown-tag default is content-box.
            append("display:inline-block;box-sizing:border-box;");
        }
        for (const UiClassStyleRule& rule : engine.ui_class_style_rules) {
            if (has_class(record, rule.class_name)) append(rule.style);
        }
        const auto inline_style = record.attributes.find("style");
        if (inline_style != record.attributes.end()) {
            append(inline_style->second);
        }
        return projected_attribute_value("style", style);
    }

    bool text_needs_flex_wrapper(
        const UiElementRecord& record,
        const std::string& resolved_style) const {
        const auto dynamic_display = record.style_properties.find("display");
        if (dynamic_display != record.style_properties.end()) {
            return dynamic_display->second == "flex";
        }
        const std::size_t position = resolved_style.rfind("display:");
        return position != std::string::npos &&
            resolved_style.compare(position + 8, 4, "flex") == 0;
    }

    void append_text_content(
        Rml::Element& parent,
        const std::string& text,
        bool wrapped) {
        if (!wrapped) {
            parent.AppendChild(document->CreateTextNode(text));
            return;
        }
        Rml::ElementPtr wrapper = document->CreateElement("span");
        wrapper->AppendChild(document->CreateTextNode(text));
        parent.AppendChild(std::move(wrapper));
    }

    void attach_listeners(
        ProjectedUiElement& projected,
        UiElementHandle handle) {
        const UiElementRecord& record = ui_element(engine, handle);
        if (
            !projected.click_listener_attached &&
            !record.click_callbacks.empty()) {
            auto listener = std::make_unique<UiEventListener>(
                engine,
                handle,
                "click");
            projected.element->AddEventListener("click", listener.get());
            listeners.push_back(std::move(listener));
            projected.click_listener_attached = true;
        }
        for (const auto& [event, callbacks] : record.event_callbacks) {
            if (
                callbacks.empty() ||
                projected.event_listeners_attached[event]) {
                continue;
            }
            auto listener = std::make_unique<UiEventListener>(
                engine,
                handle,
                event);
            projected.element->AddEventListener(event, listener.get());
            listeners.push_back(std::move(listener));
            projected.event_listeners_attached[event] = true;
        }
    }

    void append_element(Rml::Element& parent, UiElementHandle handle) {
        ensure_projection_size();
        const UiElementRecord& record = ui_element(engine, handle);
        Rml::ElementPtr element = document->CreateElement(record.tag);
        if (!element) {
            throw std::runtime_error(
                "RmlUi could not create element tag '" + record.tag + "'.");
        }
        Rml::Element* raw = element.get();
        ProjectedUiElement& projected = projected_elements[handle.value];
        projected = {};
        projected.element = raw;
        for (const auto& [name, source_value] : record.attributes) {
            if (name == "style") continue;
            raw->SetAttribute(
                name,
                projected_attribute_value(name, source_value));
        }
        projected.resolved_style = resolved_style_attribute(record);
        if (!projected.resolved_style.empty()) {
            raw->SetAttribute("style", projected.resolved_style);
        }
        for (const auto& [name, value] : record.style_properties) {
            raw->SetProperty(name, rml_css_color_alpha(value));
        }
        if (!record.inner_rml.empty()) {
            raw->SetInnerRML(record.inner_rml);
        } else if (!record.text.empty()) {
            projected.text_wrapped = text_needs_flex_wrapper(
                record, projected.resolved_style);
            append_text_content(
                *raw, record.text, projected.text_wrapped);
        }
        projected.text = record.text;
        projected.inner_rml = record.inner_rml;
        projected.attributes = record.attributes;
        projected.style_properties = record.style_properties;
        attach_listeners(projected, handle);
        for (const UiElementHandle child : record.children) {
            append_element(*raw, child);
        }
        parent.AppendChild(std::move(element));
    }

    void mark_reachable(
        UiElementHandle handle,
        std::vector<bool>& reachable) const {
        if (
            handle.value >= reachable.size() ||
            reachable[handle.value]) {
            return;
        }
        reachable[handle.value] = true;
        for (const UiElementHandle child :
             engine.ui_elements[handle.value].children) {
            mark_reachable(child, reachable);
        }
    }

    void clear_projected_subtree(UiElementHandle handle) {
        if (handle.value >= projected_elements.size()) return;
        for (const UiElementHandle child :
             engine.ui_elements[handle.value].children) {
            clear_projected_subtree(child);
        }
        projected_elements[handle.value] = {};
    }

    void update_element(UiElementHandle handle) {
        ProjectedUiElement& projected = projected_elements[handle.value];
        UiElementRecord& record = ui_element(engine, handle);
        Rml::Element& raw = *projected.element;

        for (const auto& [name, old_value] : projected.attributes) {
            static_cast<void>(old_value);
            if (name != "style" && !record.attributes.contains(name)) {
                raw.RemoveAttribute(name);
            }
        }
        for (const auto& [name, value] : record.attributes) {
            if (name == "style") continue;
            const auto existing = projected.attributes.find(name);
            if (
                existing == projected.attributes.end() ||
                existing->second != value) {
                raw.SetAttribute(
                    name,
                    projected_attribute_value(name, value));
            }
        }
        const std::string resolved_style =
            resolved_style_attribute(record);
        const bool resolved_style_changed =
            projected.resolved_style != resolved_style;
        if (resolved_style_changed) {
            if (resolved_style.empty()) {
                raw.RemoveAttribute("style");
            } else {
                raw.SetAttribute("style", resolved_style);
            }
            projected.resolved_style = resolved_style;
        }
        projected.attributes = record.attributes;

        for (const auto& [name, old_value] : projected.style_properties) {
            static_cast<void>(old_value);
            if (!record.style_properties.contains(name)) {
                raw.RemoveProperty(name);
            }
        }
        for (const auto& [name, value] : record.style_properties) {
            const auto existing = projected.style_properties.find(name);
            if (
                resolved_style_changed ||
                existing == projected.style_properties.end() ||
                existing->second != value) {
                raw.SetProperty(name, rml_css_color_alpha(value));
            }
        }
        projected.style_properties = record.style_properties;

        const bool text_wrapped = text_needs_flex_wrapper(
            record, projected.resolved_style);
        if (
            projected.text != record.text ||
            projected.inner_rml != record.inner_rml ||
            projected.text_wrapped != text_wrapped) {
            // The lowered surface currently models either text or element
            // children, matching every reached scene. Keep the owning element
            // stable while replacing only its text node so hover, active, and
            // pointer-capture state survive per-frame HUD updates.
            if (!record.children.empty()) {
                throw std::runtime_error(
                    "Mixed text and element children are not implemented in native UI.");
            }
            while (raw.GetNumChildren() > 0) {
                Rml::ElementPtr removed = raw.RemoveChild(raw.GetChild(0));
            }
            if (!record.inner_rml.empty()) {
                raw.SetInnerRML(record.inner_rml);
            } else if (!record.text.empty()) {
                append_text_content(raw, record.text, text_wrapped);
            }
            projected.text = record.text;
            projected.inner_rml = record.inner_rml;
            projected.text_wrapped = text_wrapped;
        }

        attach_listeners(projected, handle);
        for (const UiElementHandle child : record.children) {
            if (!projected_elements[child.value].element) {
                append_element(raw, child);
            } else {
                update_element(child);
            }
        }
    }

    void sync_tree() {
        ensure_projection_size();
        std::vector<bool> reachable(engine.ui_elements.size(), false);
        for (
            std::uint32_t index = 0;
            index < engine.ui_elements.size();
            ++index) {
            if (engine.ui_elements[index].attached_to_root) {
                mark_reachable(UiElementHandle{index}, reachable);
            }
        }

        for (
            std::uint32_t index = 0;
            index < projected_elements.size();
            ++index) {
            if (
                !projected_elements[index].element ||
                reachable[index]) {
                continue;
            }
            const UiElementHandle parent =
                engine.ui_elements[index].parent;
            if (
                parent.value != invalid_handle &&
                parent.value < reachable.size() &&
                !reachable[parent.value]) {
                continue;
            }
            Rml::Element* raw = projected_elements[index].element;
            Rml::Element* raw_parent = raw->GetParentNode();
            if (raw_parent) {
                Rml::ElementPtr removed = raw_parent->RemoveChild(raw);
            }
            clear_projected_subtree(UiElementHandle{index});
        }

        for (
            std::uint32_t index = 0;
            index < engine.ui_elements.size();
            ++index) {
            if (!engine.ui_elements[index].attached_to_root) continue;
            const UiElementHandle handle{index};
            if (!projected_elements[index].element) {
                append_element(*document, handle);
            } else {
                update_element(handle);
            }
        }
        projected_revision = engine.ui_revision;
    }

    void render_canvases() {
        for (
            std::uint32_t index = 0;
            index < engine.ui_elements.size();
            ++index) {
            const UiElementRecord& record = engine.ui_elements[index];
            if (
                !record.canvas ||
                index >= projected_elements.size() ||
                !projected_elements[index].element) {
                continue;
            }
            Rml::Element& element = *projected_elements[index].element;
            const Rml::Vector2f offset = element.GetAbsoluteOffset(
                Rml::BoxArea::Content);
            const double layout_width = element.GetClientWidth();
            const double layout_height = element.GetClientHeight();
            if (
                record.canvas->width <= 0.0 ||
                record.canvas->height <= 0.0 ||
                layout_width <= 0.0 ||
                layout_height <= 0.0) {
                continue;
            }
            const double scale_x = layout_width / record.canvas->width;
            const double scale_y = layout_height / record.canvas->height;
            for (const auto& draw : record.canvas->draws) {
                CanvasMesh mesh = canvas_mesh(draw, scale_x, scale_y);
                if (mesh.vertices.empty() || mesh.indices.empty()) continue;
                const Rml::CompiledGeometryHandle geometry =
                    render_interface.CompileGeometry(
                        mesh.vertices,
                        mesh.indices);
                if (!geometry) continue;
                render_interface.RenderGeometry(
                    geometry,
                    offset,
                    Rml::TextureHandle{});
                render_interface.ReleaseGeometry(geometry);
            }
        }
    }

    Engine& engine;
    SDL_Window* window = nullptr;
    SystemInterface_SDL system_interface;
    UiRenderRecorder render_interface;
    Rml::Context* context = nullptr;
    Rml::ElementDocument* document = nullptr;
    std::vector<std::unique_ptr<UiEventListener>> listeners;
    std::vector<ProjectedUiElement> projected_elements;
    std::uint64_t projected_revision = invalid_handle;
    std::string css_font_family;
    bool initialized = false;
};

UiRmlRuntime* create_ui_rml_runtime(
    Engine& engine,
    SDL_Window* window,
    std::uint32_t width,
    std::uint32_t height) {
    return new UiRmlRuntime(engine, window, width, height);
}

void destroy_ui_rml_runtime(UiRmlRuntime* runtime) noexcept {
    delete runtime;
}

bool handle_ui_rml_event(UiRmlRuntime& runtime, SDL_Event& event) {
    return RmlSDL::InputEventHandler(runtime.context, runtime.window, event);
}

void update_ui_rml_runtime(
    UiRmlRuntime& runtime,
    std::uint32_t width,
    std::uint32_t height) {
    runtime.context->SetDimensions(Rml::Vector2i{
        static_cast<int>(width),
        static_cast<int>(height)});
    if (runtime.projected_revision != runtime.engine.ui_revision) {
        runtime.sync_tree();
    }
    runtime.context->Update();
}

const UiRenderFrame& record_ui_rml_frame(
    UiRmlRuntime& runtime,
    std::uint32_t width,
    std::uint32_t height) {
    runtime.render_interface.begin_frame(width, height);
    // Canvas overlays are below the regular retained DOM controls in the
    // racer (speed lines at z=9, HUD/minimap at z=10). Queue their geometry
    // first, then let RmlUi draw the interactive tree above it.
    runtime.render_canvases();
    runtime.context->Render();
    return runtime.render_interface.frame;
}

} // namespace pal
} // namespace bbl
