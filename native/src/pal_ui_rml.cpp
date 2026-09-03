#include <bblite/pal_ui.hpp>
#if defined(BBLITE_HAS_BROWSER_FILE) && BBLITE_HAS_BROWSER_FILE
#include <bblite/js_file.hpp>
#endif
#include <bblite/js_data.hpp>
#include <bblite/pal.hpp>
#include <bblite/pal_system_fonts.hpp>

#include <RmlUi/Core.h>
#include <RmlUi/Core/Event.h>
#include <RmlUi/Core/EventListener.h>
#include <RmlUi/Core/Factory.h>
#include <RmlUi/Core/FileInterface.h>
#include <RmlUi/Core/FontEngineInterface.h>
#include <RmlUi/Core/Geometry.h>
#include <RmlUi/Core/RenderInterface.h>
#include <RmlUi/Core/TextShapingContext.h>
#include <SDL3/SDL.h>
#include <SDL3_image/SDL_image.h>

#include "RmlUi_Platform_SDL.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cctype>
#include <cstdlib>
#include <cstring>
#include <cstdio>
#include <iterator>
#include <memory>
#include <numbers>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <unordered_map>
#include <utility>
#include <vector>

namespace bbl {
namespace {

char ascii_lower(char value) {
    return value >= 'A' && value <= 'Z'
        ? static_cast<char>(value + ('a' - 'A'))
        : value;
}

bool ascii_iequals(std::string_view left, std::string_view right) {
    return
        left.size() == right.size() &&
        std::equal(
            left.begin(),
            left.end(),
            right.begin(),
            [](char lhs, char rhs) {
                return ascii_lower(lhs) == ascii_lower(rhs);
            });
}

std::string_view trim_css_token(std::string_view value) {
    const std::size_t first = value.find_first_not_of(" \t\r\n");
    if (first == std::string_view::npos) return {};
    const std::size_t last = value.find_last_not_of(" \t\r\n");
    return value.substr(first, last - first + 1);
}

std::string normalized_css_keyword(std::string_view value) {
    return js::string_lower(std::string(trim_css_token(value)));
}

bool is_concrete_authored_width(std::string_view value) {
    const std::string keyword = normalized_css_keyword(value);
    return
        !keyword.empty() &&
        keyword != "auto" &&
        keyword != "initial" &&
        keyword != "inherit" &&
        keyword != "revert" &&
        keyword != "revert-layer" &&
        keyword != "unset";
}

UiElementRecord& ui_element(Engine& engine, UiElementHandle handle) {
    if (handle.value >= engine.ui_elements.size()) {
        throw std::runtime_error("Native UI element handle is out of range.");
    }
    return engine.ui_elements[handle.value];
}

void mark_ui_changed(Engine& engine) {
    ++engine.ui_revision;
}

#if defined(BBLITE_HAS_BROWSER_FILE) && BBLITE_HAS_BROWSER_FILE
void release_browser_file_subtree(
    Engine& engine,
    UiElementHandle element) {
    UiElementRecord& record = ui_element(engine, element);
    record.selected_file = {};
    for (const UiElementHandle child : record.children) {
        release_browser_file_subtree(engine, child);
    }
}
#endif

bool ui_record_has_class(
    const UiElementRecord& record,
    std::string_view class_name) {
    const auto attribute = record.attributes.find("class");
    if (attribute == record.attributes.end()) return false;
    const std::string_view classes = attribute->second;
    std::size_t position = 0;
    while (position < classes.size()) {
        while (
            position < classes.size() &&
            std::isspace(static_cast<unsigned char>(classes[position]))) {
            ++position;
        }
        const std::size_t begin = position;
        while (
            position < classes.size() &&
            !std::isspace(static_cast<unsigned char>(classes[position]))) {
            ++position;
        }
        if (
            begin < position &&
            classes.substr(begin, position - begin) == class_name) {
            return true;
        }
    }
    return false;
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

UiClientRect ui_get_client_rect(
    Engine& engine,
    UiElementHandle element) {
    UiElementRecord& record = ui_element(engine, element);
    record.client_rect_requested = true;
    return record.client_rect;
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

std::string ui_escape_rml(std::string_view text) {
    std::string escaped;
    escaped.reserve(text.size());
    for (const char character : text) {
        switch (character) {
        case '&': escaped += "&amp;"; break;
        case '<': escaped += "&lt;"; break;
        case '>': escaped += "&gt;"; break;
        case '"': escaped += "&quot;"; break;
        case '\'': escaped += "&#39;"; break;
        default: escaped += character; break;
        }
    }
    return escaped;
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
    const bool replaces_style =
        name == "style" && !record.style_properties.empty();
    if (
        existing != record.attributes.end() &&
        existing->second == value &&
        !replaces_style) {
        return;
    }
    if (name == "style") record.style_properties.clear();
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

std::string ui_get_style_property(
    Engine& engine,
    UiElementHandle element,
    std::string_view name) {
    const UiElementRecord& record = ui_element(engine, element);
    const auto dynamic = record.style_properties.find(std::string(name));
    if (dynamic != record.style_properties.end()) return dynamic->second;
    const auto attribute = record.attributes.find("style");
    if (attribute == record.attributes.end()) return {};
    const std::string_view source = attribute->second;
    for (std::size_t start = 0; start <= source.size();) {
        const std::size_t end = source.find(';', start);
        const std::string_view declaration = source.substr(
            start,
            end == std::string_view::npos
                ? std::string_view::npos
                : end - start);
        const std::size_t colon = declaration.find(':');
        if (
            colon != std::string_view::npos &&
            ascii_iequals(
                trim_css_token(declaration.substr(0, colon)),
                name)) {
            return std::string(
                trim_css_token(declaration.substr(colon + 1)));
        }
        if (end == std::string_view::npos) break;
        start = end + 1;
    }
    return {};
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
    const auto attribute = record.attributes.find("class");
    const std::string current = attribute == record.attributes.end()
        ? std::string{}
        : attribute->second;
    std::vector<std::string> classes;
    std::istringstream input(current);
    bool present = false;
    for (std::string token; input >> token;) {
        present = present || token == name;
        classes.push_back(std::move(token));
    }
    if (present == enabled) return;
    if (enabled) {
        classes.push_back(std::move(name));
    } else {
        classes.erase(
            std::remove(classes.begin(), classes.end(), name),
            classes.end());
    }
    std::string joined;
    for (const std::string& token : classes) {
        if (!joined.empty()) joined += ' ';
        joined += token;
    }
    record.attributes.insert_or_assign("class", std::move(joined));
    mark_ui_changed(engine);
}

void ui_add_class_style(
    Engine& engine,
    UiElementHandle stylesheet,
    std::string class_name,
    std::string style) {
    if (class_name.empty()) {
        throw std::runtime_error("Native UI class style name cannot be empty.");
    }
    ui_add_style_rule(
        engine,
        stylesheet,
        UiStyleSelectorKind::Class,
        std::move(class_name),
        {},
        {},
        false,
        -1.0,
        std::move(style));
}

void ui_clear_style_rules(
    Engine& engine,
    UiElementHandle stylesheet) {
    UiElementRecord& owner = ui_element(engine, stylesheet);
    if (owner.tag != "style") {
        throw std::runtime_error(
            "Native UI stylesheet rules require a <style> element.");
    }
    if (owner.style_rules.empty()) return;
    owner.style_rules.clear();
    mark_ui_changed(engine);
}

void ui_add_id_style(
    Engine& engine,
    UiElementHandle stylesheet,
    std::string id,
    std::string style) {
    if (id.empty()) {
        throw std::runtime_error("Native UI id style name cannot be empty.");
    }
    ui_add_style_rule(
        engine,
        stylesheet,
        UiStyleSelectorKind::Id,
        std::move(id),
        {},
        {},
        false,
        -1.0,
        std::move(style));
}

void ui_add_style_rule(
    Engine& engine,
    UiElementHandle stylesheet,
    UiStyleSelectorKind selector,
    std::string primary,
    std::string secondary,
    std::string tag,
    bool hover,
    double max_width,
    std::string style) {
    UiElementRecord& owner = ui_element(engine, stylesheet);
    if (owner.tag != "style") {
        throw std::runtime_error(
            "A native UI stylesheet rule must belong to a <style> element.");
    }
    if (primary.empty() || style.empty()) {
        throw std::runtime_error(
            "A native UI stylesheet rule must have a target and declarations.");
    }
    owner.style_rules.push_back({
        selector,
        std::move(primary),
        std::move(secondary),
        std::move(tag),
        std::move(style),
        max_width,
        hover});
    mark_ui_changed(engine);
}

void ui_add_host_class_style(
    Engine& engine,
    std::string class_name,
    std::string style) {
    if (class_name.empty() || style.empty()) {
        throw std::runtime_error(
            "A native host UI class rule must have a target and declarations.");
    }
    engine.ui_host_style_rules.push_back({
        UiStyleSelectorKind::Class,
        std::move(class_name),
        {},
        {},
        std::move(style),
        -1.0,
        false});
    mark_ui_changed(engine);
}

js::Array<UiElementHandle> ui_query_class(
    Engine& engine,
    UiElementHandle root,
    std::string_view class_name) {
    if (class_name.empty()) {
        throw std::runtime_error("Native UI class query cannot be empty.");
    }
    static_cast<void>(ui_element(engine, root));
    js::Array<UiElementHandle> result;
    const auto visit = [&](const auto& self, UiElementHandle parent) -> void {
        for (const UiElementHandle child : ui_element(engine, parent).children) {
            if (ui_record_has_class(ui_element(engine, child), class_name)) {
                result.push_back(child);
            }
            self(self, child);
        }
    };
    visit(visit, root);
    return result;
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
    if (record.parent.value != invalid_handle) {
        throw std::runtime_error(
            "A native UI element may only be attached to one parent.");
    }
    if (record.attached_to_root) {
        const auto existing = std::find_if(
            engine.ui_root_children.begin(),
            engine.ui_root_children.end(),
            [child](UiElementHandle candidate) {
                return candidate.value == child.value;
            });
        if (
            existing != engine.ui_root_children.end() &&
            std::next(existing) == engine.ui_root_children.end()) {
            return child;
        }
        if (existing != engine.ui_root_children.end()) {
            engine.ui_root_children.erase(existing);
        }
        engine.ui_root_children.push_back(child);
        mark_ui_changed(engine);
        return child;
    }
    record.attached_to_root = true;
    engine.ui_root_children.push_back(child);
    mark_ui_changed(engine);
    return child;
}

void ui_replace_children(Engine& engine, UiElementHandle parent) {
    UiElementRecord& record = ui_element(engine, parent);
    for (const UiElementHandle child : record.children) {
#if defined(BBLITE_HAS_BROWSER_FILE) && BBLITE_HAS_BROWSER_FILE
        release_browser_file_subtree(engine, child);
#endif
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
    const bool changed =
        record.parent.value != invalid_handle || record.attached_to_root;
    if (!changed) return;
#if defined(BBLITE_HAS_BROWSER_FILE) && BBLITE_HAS_BROWSER_FILE
    release_browser_file_subtree(engine, element);
#endif
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
    if (record.attached_to_root) {
        engine.ui_root_children.erase(
            std::remove_if(
                engine.ui_root_children.begin(),
                engine.ui_root_children.end(),
                [element](UiElementHandle child) {
                    return child.value == element.value;
                }),
            engine.ui_root_children.end());
        record.attached_to_root = false;
    }
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

void ui_click(Engine& engine, UiElementHandle element) {
    // Copy first, matching event dispatch: a callback may mutate the retained
    // element or register another callback without invalidating this event.
    const auto callbacks = ui_element(engine, element).click_callbacks;
    for (const auto& callback : callbacks) callback();
#if defined(BBLITE_HAS_BROWSER_FILE) && BBLITE_HAS_BROWSER_FILE
    // Default actions carry the stable handle because opening a dialog can
    // synchronously release pointer lock and run callbacks that grow this arena.
    const std::string tag = ui_element(engine, element).tag;
    if (tag == "a") {
        js::click_download_anchor(engine, element);
    } else if (tag == "input") {
        js::click_file_input(engine, element);
    }
#endif
}

#if defined(BBLITE_HAS_BROWSER_FILE) && BBLITE_HAS_BROWSER_FILE
void ui_set_download_url(
    Engine& engine,
    UiElementHandle element,
    ObjectUrlHandle url) {
    UiElementRecord& record = ui_element(engine, element);
    if (record.tag != "a") {
        throw std::runtime_error(
            "A native download URL may be assigned only to an <a> element.");
    }
    // Validate at assignment and again at click, where revocation is observable.
    static_cast<void>(js::object_url_record(engine, url));
    record.download_url = url;
    mark_ui_changed(engine);
}

void ui_set_download_name(
    Engine& engine,
    UiElementHandle element,
    std::string name) {
    UiElementRecord& record = ui_element(engine, element);
    if (record.tag != "a") {
        throw std::runtime_error(
            "A native download name may be assigned only to an <a> element.");
    }
    record.download_name = std::move(name);
    mark_ui_changed(engine);
}

void ui_set_file_input(Engine& engine, UiElementHandle element) {
    UiElementRecord& record = ui_element(engine, element);
    if (record.tag != "input") {
        throw std::runtime_error(
            "Native file input type may be assigned only to an <input>.");
    }
    record.file_input = true;
    record.attributes["type"] = "file";
    mark_ui_changed(engine);
}

void ui_set_file_accept(
    Engine& engine,
    UiElementHandle element,
    std::string accept) {
    UiElementRecord& record = ui_element(engine, element);
    if (record.tag != "input" || !record.file_input) {
        throw std::runtime_error(
            "Native file accept requires an <input type=\"file\">.");
    }
    record.file_accept = std::move(accept);
    record.attributes["accept"] = record.file_accept;
    mark_ui_changed(engine);
}

void ui_on_file_change(
    Engine& engine,
    UiElementHandle element,
    std::function<void()> callback) {
    UiElementRecord& record = ui_element(engine, element);
    if (record.tag != "input" || !record.file_input || !callback) {
        throw std::runtime_error(
            "Native file change registration requires an <input type=\"file\"> and callback.");
    }
    record.file_change_callbacks.push_back(std::move(callback));
    mark_ui_changed(engine);
}
#endif

void ui_on_event(
    Engine& engine,
    UiElementHandle element,
    std::string event,
    std::function<void(const PlatformMouseEvent&)> callback) {
    if (event.empty() || !callback) {
        throw std::runtime_error("Native UI event registration is invalid.");
    }
    UiElementRecord& record = ui_element(engine, element);
    record.event_callbacks[std::move(event)].push_back(std::move(callback));
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
    const std::uint64_t next_pixel_revision = canvas.pixel_revision + 1;
    canvas = {};
    canvas.width = std::max(0.0, std::floor(width));
    canvas.height = std::max(0.0, std::floor(height));
    canvas.pixel_revision = next_pixel_revision;
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
    UiElementRecord::CanvasDrawCommand draw;
    draw.kind = UiElementRecord::CanvasDrawCommand::Kind::Fill;
    draw.points = canvas.path;
    draw.color = canvas.fill_style;
    draw.line_width = 0.0;
    draw.closed = true;
    canvas.draws.push_back(std::move(draw));
}

void ui_canvas_stroke(Engine& engine, UiElementHandle element) {
    auto& canvas = ui_canvas(engine, element);
    if (canvas.path.size() < 2) return;
    UiElementRecord::CanvasDrawCommand draw;
    draw.kind = UiElementRecord::CanvasDrawCommand::Kind::Stroke;
    draw.points = canvas.path;
    draw.color = canvas.stroke_style;
    draw.line_width = canvas.line_width *
        (std::abs(canvas.scale_x) + std::abs(canvas.scale_y)) * 0.5;
    draw.closed = canvas.path_closed;
    draw.round_join = canvas.line_join == "round";
    draw.round_cap = canvas.line_cap == "round";
    canvas.draws.push_back(std::move(draw));
}

void ui_canvas_set_image_smoothing(
    Engine& engine,
    UiElementHandle element,
    bool enabled) {
    ui_canvas(engine, element).image_smoothing_enabled = enabled;
}

void ui_canvas_put_image_data(
    Engine& engine,
    UiElementHandle element,
    const js::U8Array& source,
    double source_width,
    double source_height,
    double destination_x,
    double destination_y) {
    auto& canvas = ui_canvas(engine, element);
    const int width = std::max(0, static_cast<int>(std::floor(source_width)));
    const int height = std::max(0, static_cast<int>(std::floor(source_height)));
    const int target_width =
        std::max(0, static_cast<int>(std::floor(canvas.width)));
    const int target_height =
        std::max(0, static_cast<int>(std::floor(canvas.height)));
    const std::size_t required =
        static_cast<std::size_t>(width) * height * 4;
    if (source.size() < required) {
        throw std::runtime_error(
            "Canvas ImageData RGBA storage is smaller than its dimensions.");
    }
    const std::size_t target_size =
        static_cast<std::size_t>(target_width) * target_height * 4;
    if (canvas.pixels.size() != target_size) {
        canvas.pixels.assign(target_size, 0);
    }
    const int dx = static_cast<int>(std::floor(destination_x));
    const int dy = static_cast<int>(std::floor(destination_y));
    for (int y = 0; y < height; ++y) {
        const int target_y = dy + y;
        if (target_y < 0 || target_y >= target_height) continue;
        for (int x = 0; x < width; ++x) {
            const int target_x = dx + x;
            if (target_x < 0 || target_x >= target_width) continue;
            const std::size_t source_offset =
                (static_cast<std::size_t>(y) * width + x) * 4;
            const std::size_t target_offset =
                (static_cast<std::size_t>(target_y) * target_width + target_x) * 4;
            const std::uint8_t alpha = source[source_offset + 3];
            canvas.pixels[target_offset] = static_cast<std::uint8_t>(
                static_cast<unsigned>(source[source_offset]) * alpha / 255);
            canvas.pixels[target_offset + 1] = static_cast<std::uint8_t>(
                static_cast<unsigned>(source[source_offset + 1]) * alpha / 255);
            canvas.pixels[target_offset + 2] = static_cast<std::uint8_t>(
                static_cast<unsigned>(source[source_offset + 2]) * alpha / 255);
            canvas.pixels[target_offset + 3] = alpha;
        }
    }
    ++canvas.pixel_revision;
}

void ui_canvas_draw_image(
    Engine& engine,
    UiElementHandle destination,
    UiElementHandle source,
    double x,
    double y,
    double width,
    double height) {
    // Validate both handles now so a stale/off-type source cannot escape into
    // the backend-neutral frame recorder.
    static_cast<void>(ui_canvas(engine, source));
    auto& canvas = ui_canvas(engine, destination);
    UiElementRecord::CanvasDrawCommand draw;
    draw.kind = UiElementRecord::CanvasDrawCommand::Kind::Blit;
    draw.source = source;
    const auto point = canvas_point(canvas, x, y);
    draw.destination_x = point.x;
    draw.destination_y = point.y;
    draw.destination_width = width * canvas.scale_x;
    draw.destination_height = height * canvas.scale_y;
    draw.nearest_sampling = !canvas.image_smoothing_enabled;
    canvas.draws.push_back(std::move(draw));
}

void ui_canvas_set_font(
    Engine& engine,
    UiElementHandle element,
    std::string value) {
    ui_canvas(engine, element).font = std::move(value);
}

void ui_canvas_set_text_baseline(
    Engine& engine,
    UiElementHandle element,
    std::string value) {
    ui_canvas(engine, element).text_baseline = std::move(value);
}

void ui_canvas_set_shadow_color(
    Engine& engine,
    UiElementHandle element,
    std::string value) {
    ui_canvas(engine, element).shadow_color = std::move(value);
}

void ui_canvas_set_shadow_blur(
    Engine& engine,
    UiElementHandle element,
    double value) {
    ui_canvas(engine, element).shadow_blur = std::max(0.0, value);
}

void ui_canvas_fill_text(
    Engine& engine,
    UiElementHandle element,
    std::string text,
    double x,
    double y) {
    auto& canvas = ui_canvas(engine, element);
    char* end = nullptr;
    const double parsed = std::strtod(canvas.font.c_str(), &end);
    const double font_size = end != canvas.font.c_str() && parsed > 0.0
        ? parsed
        : 10.0;
    UiElementRecord::CanvasDrawCommand draw;
    draw.kind = UiElementRecord::CanvasDrawCommand::Kind::Text;
    draw.color = canvas.fill_style;
    const auto point = canvas_point(canvas, x, y);
    draw.destination_x = point.x;
    draw.destination_y = point.y;
    draw.font_size = font_size *
        (std::abs(canvas.scale_x) + std::abs(canvas.scale_y)) * 0.5;
    draw.font_family = canvas.font;
    draw.text_baseline = canvas.text_baseline;
    draw.text = std::move(text);
    draw.shadow_color = canvas.shadow_color;
    draw.shadow_blur = canvas.shadow_blur *
        (std::abs(canvas.scale_x) + std::abs(canvas.scale_y)) * 0.5;
    canvas.draws.push_back(std::move(draw));
}

namespace pal {
namespace {

class UiEventListener final : public Rml::EventListener {
public:
    UiEventListener(
        Engine& engine,
        UiElementHandle element,
        std::string event,
        bool& default_prevented)
        : engine(engine),
          element(element),
          event_type(std::move(event)),
          default_prevented(default_prevented) {}

    void ProcessEvent(Rml::Event& event) override {
        // Copy the callback list so a callback may safely mutate UI state.
        if (event_type == "click") {
            ui_click(engine, element);
        } else {
            float fallback_x = 0.0f;
            float fallback_y = 0.0f;
            const SDL_MouseButtonFlags pressed =
                SDL_GetMouseState(&fallback_x, &fallback_y);
            const int source_button =
                event.GetParameter<int>("button", -1);
            const PlatformMouseEvent pointer{
                .button = source_button == 1
                    ? 2.0
                    : source_button == 2
                      ? 1.0
                      : static_cast<double>(source_button),
                .buttons =
                    ((pressed & SDL_BUTTON_LMASK) != 0 ? 1.0 : 0.0) +
                    ((pressed & SDL_BUTTON_RMASK) != 0 ? 2.0 : 0.0) +
                    ((pressed & SDL_BUTTON_MMASK) != 0 ? 4.0 : 0.0) +
                    ((pressed & SDL_BUTTON_X1MASK) != 0 ? 8.0 : 0.0) +
                    ((pressed & SDL_BUTTON_X2MASK) != 0 ? 16.0 : 0.0),
                .client_x = static_cast<double>(
                    event.GetParameter<int>(
                        "mouse_x",
                        static_cast<int>(fallback_x))),
                .client_y = static_cast<double>(
                    event.GetParameter<int>(
                        "mouse_y",
                        static_cast<int>(fallback_y))),
            };
            const auto callbacks =
                ui_element(engine, element).event_callbacks.at(event_type);
            for (const auto& callback : callbacks) callback(pointer);
            if (pointer.default_prevented) {
                default_prevented = true;
            }
        }
        event.StopPropagation();
    }

private:
    Engine& engine;
    UiElementHandle element;
    std::string event_type;
    bool& default_prevented;
};

/** Keep RmlUi animations on the same clock as browser-facing scene time. */
class UiSystemInterface final : public SystemInterface_SDL {
public:
    explicit UiSystemInterface(SDL_Window* window)
        : SystemInterface_SDL(window) {}

    double GetElapsedTime() override {
        return ::bbl::pal::performance_milliseconds() / 1000.0;
    }
};

std::optional<SystemFontFace> first_system_font(
    std::initializer_list<std::string_view> families,
    int weight) {
    for (const std::string_view family : families) {
        if (auto face = find_system_font(family, weight)) return face;
    }
    return std::nullopt;
}

std::optional<SystemFontFace> system_ui_font(int weight) {
#if defined(_WIN32)
    return first_system_font({"Segoe UI", "Arial"}, weight);
#elif defined(__APPLE__)
    return first_system_font(
        {"SF Pro Text", "Helvetica Neue", "Arial"},
        weight);
#else
    return find_system_font("sans-serif", weight);
#endif
}

std::optional<SystemFontFace> generic_sans_font(int weight) {
#if defined(_WIN32)
    return first_system_font({"Arial", "Segoe UI"}, weight);
#elif defined(__APPLE__)
    return first_system_font({"Arial", "Helvetica Neue"}, weight);
#else
    return find_system_font("sans-serif", weight);
#endif
}

std::optional<SystemFontFace> system_monospace_font(int weight) {
#if defined(_WIN32)
    return first_system_font({"Consolas", "Courier New"}, weight);
#elif defined(__APPLE__)
    return first_system_font({"Menlo", "Courier New"}, weight);
#else
    return find_system_font("monospace", weight);
#endif
}

std::optional<SystemFontFace> system_ui_fallback_font() {
#if defined(_WIN32)
    return find_system_font("Segoe UI Symbol", 400);
#elif defined(__APPLE__)
    return first_system_font({"Apple Symbols", "Arial Unicode MS"}, 400);
#else
    return first_system_font(
        {"Noto Sans Symbols 2", "Noto Sans Symbols", "sans-serif"},
        400);
#endif
}

std::string quote_css_font_family(std::string family) {
    if (family.find_first_of(" \t'\"\\") == std::string::npos) return family;
    std::string quoted = "\"";
    quoted.reserve(family.size() + 2);
    for (const char character : family) {
        if (character == '\\' || character == '\"') quoted += '\\';
        quoted += character;
    }
    return quoted + "\"";
}

void load_rml_font(
    const SystemFontFace& face,
    std::string_view registered_family,
    int weight,
    bool fallback = false) {
    if (!Rml::LoadFontFace(
            face.path.string(),
            std::string(registered_family),
            Rml::Style::FontStyle::Normal,
            static_cast<Rml::Style::FontWeight>(weight),
            fallback,
            face.face_index)) {
        throw std::runtime_error(
            "RmlUi failed to load discovered font face: " +
            face.path.string());
    }
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

bool css_identifier_character(char character) {
    return std::isalnum(static_cast<unsigned char>(character)) ||
        character == '-' || character == '_';
}

void replace_css_identifier(
    std::string& text,
    std::string_view identifier,
    std::string_view replacement) {
    std::size_t position = 0;
    while ((position = text.find(identifier, position)) != std::string::npos) {
        const bool starts_identifier =
            position > 0 && css_identifier_character(text[position - 1]);
        const std::size_t end = position + identifier.size();
        const bool continues_identifier =
            end < text.size() && css_identifier_character(text[end]);
        if (starts_identifier || continues_identifier) {
            position = end;
            continue;
        }
        text.replace(position, identifier.size(), replacement);
        position += replacement.size();
    }
}

std::string rml_css_animation_easing(std::string value) {
    // RmlUi exposes the same animation shorthand, but names its tween curves
    // differently and does not implement CSS steps(). Translate the browser
    // timing vocabulary reached by the demos. A linear interpolation across
    // the platformer's adjacent 49%/50% opacity keys remains an effectively
    // instantaneous blink while preserving the declared period.
    std::size_t position = 0;
    while ((position = value.find("steps(", position)) != std::string::npos) {
        const std::size_t end = value.find(')', position + 6);
        if (end == std::string::npos) break;
        value.replace(position, end - position + 1, "linear-in-out");
        position += 13;
    }
    replace_css_identifier(value, "step-start", "linear-in-out");
    replace_css_identifier(value, "step-end", "linear-in-out");
    replace_css_identifier(value, "ease-in-out", "sine-in-out");
    replace_css_identifier(value, "ease-in", "sine-in");
    replace_css_identifier(value, "ease-out", "sine-out");
    replace_css_identifier(value, "ease", "sine-in-out");
    replace_css_identifier(value, "linear", "linear-in-out");
    return value;
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

std::string rml_css_density_units(std::string value) {
    // The Rml context and recorded vertices use drawable pixels. Browser CSS
    // px, however, are density-independent CSS pixels. Rml's dp unit is the
    // exact equivalent once the context is given SDL's display scale.
    for (std::size_t index = 1; index + 1 < value.size(); ++index) {
        if (
            value[index] == 'p' &&
            value[index + 1] == 'x' &&
            (std::isdigit(static_cast<unsigned char>(value[index - 1])) ||
             value[index - 1] == '.')) {
            value[index] = 'd';
            value[index + 1] = 'p';
        }
    }
    return value;
}

std::string take_css_declaration(
    std::string& style,
    std::string_view requested_name) {
    std::string retained;
    std::string result;
    const std::string_view source = style;
    for (std::size_t start = 0; start <= source.size();) {
        const std::size_t end = source.find(';', start);
        const std::string_view declaration = source.substr(
            start,
            end == std::string_view::npos
                ? std::string_view::npos
                : end - start);
        const std::size_t colon = declaration.find(':');
        if (
            colon != std::string_view::npos &&
            ascii_iequals(
                trim_css_token(declaration.substr(0, colon)),
                requested_name)) {
            result = std::string(
                trim_css_token(declaration.substr(colon + 1)));
        } else if (!trim_css_token(declaration).empty()) {
            if (!retained.empty()) retained += ';';
            retained += declaration;
        }
        if (end == std::string_view::npos) break;
        start = end + 1;
    }
    style = std::move(retained);
    return result;
}

bool is_private_ui_declaration(std::string_view declaration) {
    const std::size_t first = declaration.find_first_not_of(" \t\r\n");
    return
        first != std::string_view::npos &&
        declaration.substr(first).starts_with("--bbl-");
}

std::string filter_private_ui_declarations(
    std::string_view style,
    bool retain_private) {
    std::string result;
    std::size_t start = 0;
    int parenthesis_depth = 0;
    for (std::size_t index = 0; index <= style.size(); ++index) {
        const char character = index < style.size() ? style[index] : ';';
        if (character == '(') ++parenthesis_depth;
        if (character == ')') --parenthesis_depth;
        if (index < style.size() &&
            (character != ';' || parenthesis_depth > 0)) {
            continue;
        }
        const std::string_view declaration = style.substr(start, index - start);
        if (
            !declaration.empty() &&
            is_private_ui_declaration(declaration) == retain_private) {
            if (!result.empty()) result += ';';
            result += declaration;
        }
        start = index + 1;
    }
    return result;
}

bool ui_record_has_id(
    const UiElementRecord& record,
    std::string_view id) {
    const auto attribute = record.attributes.find("id");
    return
        attribute != record.attributes.end() &&
        attribute->second == id;
}

bool ui_style_rule_matches(
    const Engine& engine,
    UiElementHandle handle,
    const UiStyleRule& rule) {
    if (handle.value >= engine.ui_elements.size()) return false;
    const UiElementRecord& record = engine.ui_elements[handle.value];
    switch (rule.selector) {
    case UiStyleSelectorKind::Class:
        return ui_record_has_class(record, rule.primary);
    case UiStyleSelectorKind::Id:
        return ui_record_has_id(record, rule.primary);
    case UiStyleSelectorKind::CompoundClass:
        return
            ui_record_has_class(record, rule.primary) &&
            ui_record_has_class(record, rule.secondary);
    case UiStyleSelectorKind::ClassDescendantTag:
        if (record.tag != rule.tag) return false;
        break;
    case UiStyleSelectorKind::IdDescendantClass:
        if (!ui_record_has_class(record, rule.secondary)) return false;
        break;
    }

    for (
        UiElementHandle ancestor = record.parent;
        ancestor.value != invalid_handle;
        ancestor = engine.ui_elements[ancestor.value].parent) {
        const UiElementRecord& ancestor_record =
            engine.ui_elements[ancestor.value];
        if (
            rule.selector == UiStyleSelectorKind::ClassDescendantTag &&
            ui_record_has_class(ancestor_record, rule.primary)) {
            return true;
        }
        if (
            rule.selector == UiStyleSelectorKind::IdDescendantClass &&
            ui_record_has_id(ancestor_record, rule.primary)) {
            return true;
        }
    }
    return false;
}

std::string ui_style_rule_selector(const UiStyleRule& rule) {
    std::string selector;
    switch (rule.selector) {
    case UiStyleSelectorKind::Class:
        selector = "." + rule.primary;
        break;
    case UiStyleSelectorKind::Id:
        selector = "#" + rule.primary;
        break;
    case UiStyleSelectorKind::CompoundClass:
        selector = "." + rule.primary + "." + rule.secondary;
        break;
    case UiStyleSelectorKind::ClassDescendantTag:
        selector = "." + rule.primary + " " + rule.tag;
        break;
    case UiStyleSelectorKind::IdDescendantClass:
        selector = "#" + rule.primary + " ." + rule.secondary;
        break;
    }
    if (rule.hover) selector += ":hover";
    return selector;
}

std::uint32_t ui_style_rule_specificity(const UiStyleRule& rule) {
    std::uint32_t ids = 0;
    std::uint32_t classes = rule.hover ? 1u : 0u;
    std::uint32_t tags = 0;
    switch (rule.selector) {
    case UiStyleSelectorKind::Class:
        ++classes;
        break;
    case UiStyleSelectorKind::Id:
        ++ids;
        break;
    case UiStyleSelectorKind::CompoundClass:
        classes += 2;
        break;
    case UiStyleSelectorKind::ClassDescendantTag:
        ++classes;
        ++tags;
        break;
    case UiStyleSelectorKind::IdDescendantClass:
        ++ids;
        ++classes;
        break;
    }
    return (ids << 16u) | (classes << 8u) | tags;
}

struct CascadedUiDeclaration {
    std::uint32_t specificity = 0;
    std::size_t source_order = 0;
    std::string value;
};

void consider_cascaded_declaration(
    CascadedUiDeclaration& current,
    std::string value,
    std::uint32_t specificity,
    std::size_t source_order) {
    if (
        value.empty() ||
        (!current.value.empty() &&
         (specificity < current.specificity ||
          (specificity == current.specificity &&
           source_order < current.source_order)))) {
        return;
    }
    current = {
        specificity,
        source_order,
        std::move(value)};
}

struct ProjectedUiStyleSource {
    std::string private_declarations;
    std::string display;
    std::string justification;
    bool declares_pointer_events = false;
};

struct GridMetadata {
    std::string columns;
    std::string cell_width;
    std::string width;
    std::string gap;
    std::string row_height;
    std::string row_count;
    std::string justification;
};

GridMetadata take_grid_metadata(std::string& style) {
    return {
        take_css_declaration(style, "--bbl-grid-columns"),
        take_css_declaration(style, "--bbl-grid-cell-width"),
        take_css_declaration(style, "--bbl-grid-width"),
        take_css_declaration(style, "--bbl-grid-gap"),
        take_css_declaration(style, "--bbl-grid-row-height"),
        take_css_declaration(style, "--bbl-grid-row-count"),
        take_css_declaration(style, "--bbl-grid-justify-content"),
    };
}

ProjectedUiStyleSource project_ui_style_source(std::string_view style) {
    ProjectedUiStyleSource result;
    result.private_declarations =
        filter_private_ui_declarations(style, true);
    std::string private_probe = result.private_declarations;
    const GridMetadata grid = take_grid_metadata(private_probe);
    const bool projects_grid = !grid.width.empty();
    std::string public_probe =
        filter_private_ui_declarations(style, false);
    result.declares_pointer_events =
        !take_css_declaration(public_probe, "pointer-events").empty();
    result.display = projects_grid
        ? std::string("grid")
        : normalized_css_keyword(
              take_css_declaration(public_probe, "display"));
    result.justification =
        projects_grid && !grid.justification.empty()
            ? normalized_css_keyword(grid.justification)
            : normalized_css_keyword(take_css_declaration(
                  public_probe,
                  "justify-content"));
    return result;
}

std::string take_grid_children_style(std::string& style) {
    const GridMetadata grid = take_grid_metadata(style);
    if (grid.width.empty()) return {};
    std::string result =
        "display:flex;flex-wrap:wrap;width:" + grid.width +
        ";gap:" + (grid.gap.empty() ? "0dp" : grid.gap) + ";";
    if (grid.justification == "center") {
        result += "margin-left:auto;margin-right:auto;";
    } else if (grid.justification == "end") {
        result += "margin-left:auto;margin-right:0;";
    }
    return result;
}

std::string take_intrinsic_min_width(std::string& style) {
    return take_css_declaration(style, "--bbl-intrinsic-min-width");
}

std::string take_crosshair_color(std::string& style) {
    return take_css_declaration(style, "--bbl-crosshair");
}

std::string take_inset_outline(std::string& style) {
    return take_css_declaration(style, "--bbl-inset-outline");
}

bool is_inline_level(Rml::Style::Display display) {
    return
        display == Rml::Style::Display::Inline ||
        display == Rml::Style::Display::InlineBlock ||
        display == Rml::Style::Display::InlineFlex ||
        display == Rml::Style::Display::InlineTable;
}

struct GradientTextColor {
    double red = 0.0;
    double green = 0.0;
    double blue = 0.0;
};

struct GradientTextStyle {
    std::string palette;
    std::string duration;
    std::string scale;

    bool operator==(const GradientTextStyle&) const = default;
};

GradientTextStyle take_gradient_text_style(std::string& style) {
    return {
        take_css_declaration(style, "--bbl-text-gradient"),
        take_css_declaration(style, "--bbl-text-gradient-duration"),
        take_css_declaration(style, "--bbl-text-gradient-scale")};
}

std::vector<GradientTextColor> gradient_text_colors(
    std::string_view palette) {
    std::vector<GradientTextColor> result;
    std::size_t start = 0;
    while (start <= palette.size()) {
        const std::size_t end = palette.find('|', start);
        const std::string color(palette.substr(
            start,
            end == std::string_view::npos
                ? palette.size() - start
                : end - start));
        unsigned red = 0;
        unsigned green = 0;
        unsigned blue = 0;
        if (
            color.size() == 7 &&
            std::sscanf(
                color.c_str(),
                "#%02x%02x%02x",
                &red,
                &green,
                &blue) == 3) {
            result.push_back({
                static_cast<double>(red),
                static_cast<double>(green),
                static_cast<double>(blue)});
        }
        if (end == std::string_view::npos) break;
        start = end + 1;
    }
    return result;
}

bool project_rml_style_property(std::string_view name) {
    // RmlUi implements box-shadow through render layers, clip masks, and a
    // blur filter. The backend-neutral recorder intentionally exposes only
    // ordinary geometry and textures today, so forwarding this property
    // produces the unfiltered white mask instead of a shadow. Static CSS is
    // lowered with the same omission; keep dynamic style writes consistent.
    return name != "box-shadow";
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
    Rml::ColourbPremultiplied color,
    float texture_x = 0.0f,
    float texture_y = 0.0f) {
    const int index = static_cast<int>(mesh.vertices.size());
    mesh.vertices.push_back({
        {static_cast<float>(x), static_cast<float>(y)},
        color,
        {texture_x, texture_y}});
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
    if (
        draw.kind == UiElementRecord::CanvasDrawCommand::Kind::Blit ||
        draw.kind == UiElementRecord::CanvasDrawCommand::Kind::Text) {
        return mesh;
    }
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

CanvasMesh canvas_blit_mesh(
    const UiElementRecord::CanvasDrawCommand& draw,
    double scale_x,
    double scale_y) {
    CanvasMesh mesh;
    const double left = draw.destination_x * scale_x;
    const double top = draw.destination_y * scale_y;
    const double right = left + draw.destination_width * scale_x;
    const double bottom = top + draw.destination_height * scale_y;
    if (right <= left || bottom <= top) return mesh;
    const Rml::ColourbPremultiplied white{255, 255, 255, 255};
    append_canvas_vertex(mesh, left, top, white, 0.0f, 0.0f);
    append_canvas_vertex(mesh, right, top, white, 1.0f, 0.0f);
    append_canvas_vertex(mesh, right, bottom, white, 1.0f, 1.0f);
    append_canvas_vertex(mesh, left, bottom, white, 0.0f, 1.0f);
    mesh.indices = {0, 1, 2, 0, 2, 3};
    return mesh;
}

std::array<std::uint8_t, 7> canvas_glyph(char character) {
    switch (character) {
        case '0': return {14, 17, 19, 21, 25, 17, 14};
        case '1': return {4, 12, 4, 4, 4, 4, 14};
        case '2': return {14, 17, 1, 2, 4, 8, 31};
        case '3': return {30, 1, 1, 14, 1, 1, 30};
        case '4': return {2, 6, 10, 18, 31, 2, 2};
        case '5': return {31, 16, 16, 30, 1, 1, 30};
        case '6': return {14, 16, 16, 30, 17, 17, 14};
        case '7': return {31, 1, 2, 4, 8, 8, 8};
        case '8': return {14, 17, 17, 14, 17, 17, 14};
        case '9': return {14, 17, 17, 15, 1, 1, 14};
        case 'I': return {31, 4, 4, 4, 4, 4, 31};
        case 'K': return {17, 18, 20, 24, 20, 18, 17};
        case 'L': return {16, 16, 16, 16, 16, 16, 31};
        case 'S': return {15, 16, 16, 14, 1, 1, 30};
        case '/': return {1, 1, 2, 4, 8, 16, 16};
        case ' ': return {};
        default: return {14, 17, 1, 2, 4, 0, 4};
    }
}

void append_canvas_rectangle(
    CanvasMesh& mesh,
    double left,
    double top,
    double right,
    double bottom,
    Rml::ColourbPremultiplied color) {
    const int base = static_cast<int>(mesh.vertices.size());
    append_canvas_vertex(mesh, left, top, color);
    append_canvas_vertex(mesh, right, top, color);
    append_canvas_vertex(mesh, right, bottom, color);
    append_canvas_vertex(mesh, left, bottom, color);
    mesh.indices.insert(
        mesh.indices.end(),
        {base, base + 1, base + 2, base, base + 2, base + 3});
}

CanvasMesh canvas_text_mesh(
    const UiElementRecord::CanvasDrawCommand& draw,
    double scale_x,
    double scale_y) {
    CanvasMesh mesh;
    const double cell = std::max(0.5, draw.font_size / 7.0);
    const auto append_text = [&draw, &mesh, cell, scale_x, scale_y](
                                 Rml::ColourbPremultiplied color,
                                 double padding) {
        double cursor = draw.destination_x;
        for (const char character : draw.text) {
            const auto rows = canvas_glyph(
                character >= 'a' && character <= 'z'
                    ? static_cast<char>(character - 'a' + 'A')
                    : character);
            for (std::size_t row = 0; row < rows.size(); ++row) {
                for (int column = 0; column < 5; ++column) {
                    if ((rows[row] & (1u << (4 - column))) == 0) continue;
                    const double left = cursor + column * cell;
                    const double top = draw.destination_y + row * cell;
                    append_canvas_rectangle(
                        mesh,
                        (left - padding) * scale_x,
                        (top - padding) * scale_y,
                        (left + cell + padding) * scale_x,
                        (top + cell + padding) * scale_y,
                        color);
                }
            }
            cursor += cell * 6.0;
        }
    };
    const auto shadow = canvas_color(draw.shadow_color);
    if (shadow.alpha > 0 && draw.shadow_blur > 0.0) {
        append_text(shadow, std::min(cell * 0.45, draw.shadow_blur * 0.2));
    }
    append_text(canvas_color(draw.color), 0.0);
    return mesh;
}

} // namespace

struct ProjectedUiElement {
    Rml::Element* element = nullptr;
    Rml::Element* children_container = nullptr;
    std::vector<Rml::Element*> gradient_text_elements;
    std::vector<GradientTextColor> gradient_text_colors;
    GradientTextStyle gradient_text_style;
    std::string text;
    std::string inner_rml;
    std::unordered_map<std::string, std::string> attributes;
    std::unordered_map<std::string, std::string> style_properties;
    std::string resolved_style;
    std::string grid_children_style;
    std::string intrinsic_min_width;
    std::string crosshair_color;
    std::string inset_outline;
    Rml::Element* inset_outline_element = nullptr;
    bool inset_outline_positioned_parent = false;
    bool text_wrapped = false;
    bool intrinsic_width_applied = false;
    bool hovered = false;
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
    ~UiRenderRecorder() override {
        for (const auto& [key, cached] : retained_canvas_textures) {
            static_cast<void>(key);
            ReleaseTexture(cached.handle);
        }
    }

    void begin_frame(std::uint32_t width, std::uint32_t height) {
        frame.width = width;
        frame.height = height;
        frame.vertices.clear();
        frame.indices.clear();
        frame.textures.clear();
        frame.draws.clear();
        frame.composite_first_index = 0;
        scissor_enabled = false;
        scissor = Rml::Rectanglei::FromSize(Rml::Vector2i{
            static_cast<int>(width), static_cast<int>(height)});
        transform = Rml::Matrix4f::Identity();
    }

    /**
     * Appends the full-frame composite quad both scene renderers draw to
     * blend their resolved transparent UI layer over the frame. Recorded
     * here, once, so both GPU backends upload the frame's aggregate geometry
     * verbatim instead of copying it to append the quad themselves. No
     * `UiRenderDraw` references these vertices, so consumers that blend the
     * draws straight into their target carry them inert.
     */
    void append_composite_quad() {
        frame.composite_first_index =
            static_cast<std::uint32_t>(frame.indices.size());
        append_ui_quad(
            frame,
            0,
            0,
            static_cast<float>(frame.width),
            static_cast<float>(frame.height),
            255);
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
            static_cast<std::uint32_t>(std::max(0, active_scissor.Height())),
            nearest_sampling});
    }

    void RenderGeometryWithSampling(
        Rml::CompiledGeometryHandle handle,
        Rml::Vector2f translation,
        Rml::TextureHandle texture_handle,
        bool nearest) {
        const bool previous = nearest_sampling;
        nearest_sampling = nearest;
        RenderGeometry(handle, translation, texture_handle);
        nearest_sampling = previous;
    }

    Rml::TextureHandle retained_canvas_texture(
        UiElementHandle handle,
        const UiElementRecord::CanvasState& canvas) {
        const std::uint32_t width = static_cast<std::uint32_t>(
            std::max(0.0, std::floor(canvas.width)));
        const std::uint32_t height = static_cast<std::uint32_t>(
            std::max(0.0, std::floor(canvas.height)));
        if (
            width == 0 ||
            height == 0 ||
            canvas.pixels.size() !=
                static_cast<std::size_t>(width) * height * 4) {
            return {};
        }
        auto found = retained_canvas_textures.find(handle.value);
        if (
            found != retained_canvas_textures.end() &&
            found->second.revision == canvas.pixel_revision &&
            found->second.width == width &&
            found->second.height == height) {
            return found->second.handle;
        }
        if (found != retained_canvas_textures.end()) {
            ReleaseTexture(found->second.handle);
            retained_canvas_textures.erase(found);
        }
        const Rml::TextureHandle texture = GenerateTexture(
            canvas.pixels,
            Rml::Vector2i{
                static_cast<int>(width),
                static_cast<int>(height)});
        if (texture) {
            retained_canvas_textures.emplace(
                handle.value,
                RetainedCanvasTexture{
                    texture,
                    canvas.pixel_revision,
                    width,
                    height});
        }
        return texture;
    }

    void ReleaseGeometry(Rml::CompiledGeometryHandle handle) override {
        delete reinterpret_cast<Geometry*>(handle);
    }

    Rml::TextureHandle LoadTexture(
        Rml::Vector2i& texture_dimensions,
        const Rml::String& source) override {
        Rml::FileInterface* files = Rml::GetFileInterface();
        Rml::FileHandle file = files->Open(source);
        if (
            !file &&
            !source.empty() &&
            source.front() != '/' &&
            source.front() != '\\' &&
            source.find("..") == Rml::String::npos &&
            source.find(":") == Rml::String::npos) {
            file = files->Open(asset_path(source));
        }
        if (!file) {
            return {};
        }
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
        if (!surface) {
            return {};
        }
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

    Rml::CompiledShaderHandle CompileShader(
        const Rml::String& name,
        const Rml::Dictionary& parameters) override {
        auto shader = std::make_unique<GradientShader>();
        const bool repeating = Rml::Get(parameters, "repeating", false);

        if (name == "linear-gradient") {
            shader->function = repeating
                ? GradientFunction::repeating_linear
                : GradientFunction::linear;
            shader->p = Rml::Get(parameters, "p0", Rml::Vector2f{0.0f});
            shader->v =
                Rml::Get(parameters, "p1", Rml::Vector2f{0.0f}) - shader->p;
        } else if (name == "radial-gradient") {
            shader->function = repeating
                ? GradientFunction::repeating_radial
                : GradientFunction::radial;
            shader->p = Rml::Get(
                parameters,
                "center",
                Rml::Vector2f{0.0f});
            const Rml::Vector2f radius = Rml::Get(
                parameters,
                "radius",
                Rml::Vector2f{1.0f});
            shader->v = {
                std::abs(radius.x) > 1e-7f ? 1.0f / radius.x : 0.0f,
                std::abs(radius.y) > 1e-7f ? 1.0f / radius.y : 0.0f};
        } else if (name == "conic-gradient") {
            shader->function = repeating
                ? GradientFunction::repeating_conic
                : GradientFunction::conic;
            shader->p = Rml::Get(
                parameters,
                "center",
                Rml::Vector2f{0.0f});
            const float angle = Rml::Get(parameters, "angle", 0.0f);
            shader->v = {std::cos(angle), std::sin(angle)};
        } else {
            return {};
        }

        const auto stops = parameters.find("color_stop_list");
        if (
            stops == parameters.end() ||
            stops->second.GetType() != Rml::Variant::COLORSTOPLIST) {
            return {};
        }
        const Rml::ColorStopList& stop_list =
            stops->second.GetReference<Rml::ColorStopList>();
        shader->stop_positions.reserve(stop_list.size());
        shader->stop_colors.reserve(stop_list.size());
        for (const Rml::ColorStop& stop : stop_list) {
            if (stop.position.unit != Rml::Unit::NUMBER) return {};
            shader->stop_positions.push_back(stop.position.number);
            shader->stop_colors.push_back(stop.color);
        }
        if (shader->stop_positions.empty()) return {};
        return reinterpret_cast<Rml::CompiledShaderHandle>(shader.release());
    }

    void RenderShader(
        Rml::CompiledShaderHandle shader_handle,
        Rml::CompiledGeometryHandle geometry_handle,
        Rml::Vector2f translation,
        Rml::TextureHandle) override {
        if (!shader_handle || !geometry_handle) return;
        auto& shader = *reinterpret_cast<GradientShader*>(shader_handle);
        const Geometry& source =
            *reinterpret_cast<const Geometry*>(geometry_handle);
        if (source.vertices.empty() || source.indices.empty()) return;

        Rml::Vector2f minimum = source.vertices.front().tex_coord;
        Rml::Vector2f maximum = minimum;
        for (const Rml::Vertex& vertex : source.vertices) {
            minimum.x = std::min(minimum.x, vertex.tex_coord.x);
            minimum.y = std::min(minimum.y, vertex.tex_coord.y);
            maximum.x = std::max(maximum.x, vertex.tex_coord.x);
            maximum.y = std::max(maximum.y, vertex.tex_coord.y);
        }
        const Rml::Vector2f extent = maximum - minimum;
        const std::uint32_t width = static_cast<std::uint32_t>(std::clamp(
            std::ceil(std::abs(extent.x)),
            1.0f,
            4096.0f));
        const std::uint32_t height = static_cast<std::uint32_t>(std::clamp(
            std::ceil(std::abs(extent.y)),
            1.0f,
            4096.0f));

        if (
            !shader.texture || shader.minimum != minimum ||
            shader.maximum != maximum || shader.width != width ||
            shader.height != height) {
            if (shader.texture) ReleaseTexture(shader.texture);
            std::vector<Rml::byte> pixels(
                static_cast<std::size_t>(width) * height * 4);
            for (std::uint32_t y = 0; y < height; ++y) {
                for (std::uint32_t x = 0; x < width; ++x) {
                    const Rml::Vector2f coordinate{
                        minimum.x +
                            (static_cast<float>(x) + 0.5f) * extent.x /
                                static_cast<float>(width),
                        minimum.y +
                            (static_cast<float>(y) + 0.5f) * extent.y /
                                static_cast<float>(height)};
                    const Rml::ColourbPremultiplied color =
                        sample_gradient(shader, coordinate);
                    const std::size_t offset =
                        (static_cast<std::size_t>(y) * width + x) * 4;
                    pixels[offset] = color.red;
                    pixels[offset + 1] = color.green;
                    pixels[offset + 2] = color.blue;
                    pixels[offset + 3] = color.alpha;
                }
            }
            shader.texture = GenerateTexture(
                pixels,
                Rml::Vector2i{
                    static_cast<int>(width),
                    static_cast<int>(height)});
            shader.minimum = minimum;
            shader.maximum = maximum;
            shader.width = width;
            shader.height = height;
        }

        Geometry geometry = source;
        for (Rml::Vertex& vertex : geometry.vertices) {
            vertex.tex_coord = {
                std::abs(extent.x) > 1e-7f
                    ? (vertex.tex_coord.x - minimum.x) / extent.x
                    : 0.5f,
                std::abs(extent.y) > 1e-7f
                    ? (vertex.tex_coord.y - minimum.y) / extent.y
                    : 0.5f};
        }
        RenderGeometry(
            reinterpret_cast<Rml::CompiledGeometryHandle>(&geometry),
            translation,
            shader.texture);
    }

    void ReleaseShader(Rml::CompiledShaderHandle shader_handle) override {
        auto* shader = reinterpret_cast<GradientShader*>(shader_handle);
        if (!shader) return;
        if (shader->texture) ReleaseTexture(shader->texture);
        delete shader;
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

    struct RetainedCanvasTexture {
        Rml::TextureHandle handle{};
        std::uint64_t revision = 0;
        std::uint32_t width = 0;
        std::uint32_t height = 0;
    };

    enum class GradientFunction {
        linear,
        radial,
        conic,
        repeating_linear,
        repeating_radial,
        repeating_conic,
    };

    struct GradientShader {
        GradientFunction function = GradientFunction::linear;
        Rml::Vector2f p{};
        Rml::Vector2f v{};
        std::vector<float> stop_positions;
        std::vector<Rml::ColourbPremultiplied> stop_colors;
        Rml::TextureHandle texture{};
        Rml::Vector2f minimum{};
        Rml::Vector2f maximum{};
        std::uint32_t width = 0;
        std::uint32_t height = 0;
    };

    static Rml::ColourbPremultiplied sample_gradient(
        const GradientShader& shader,
        Rml::Vector2f coordinate) {
        float amount = 0.0f;
        const Rml::Vector2f offset = coordinate - shader.p;
        switch (shader.function) {
            case GradientFunction::linear:
            case GradientFunction::repeating_linear: {
                const float squared_length =
                    shader.v.x * shader.v.x + shader.v.y * shader.v.y;
                if (squared_length > 1e-7f) {
                    amount =
                        (shader.v.x * offset.x + shader.v.y * offset.y) /
                        squared_length;
                }
                break;
            }
            case GradientFunction::radial:
            case GradientFunction::repeating_radial:
                amount = std::sqrt(
                    shader.v.x * offset.x * shader.v.x * offset.x +
                    shader.v.y * offset.y * shader.v.y * offset.y);
                break;
            case GradientFunction::conic:
            case GradientFunction::repeating_conic: {
                const float x =
                    shader.v.x * offset.x + shader.v.y * offset.y;
                const float y =
                    -shader.v.y * offset.x + shader.v.x * offset.y;
                amount = 0.5f +
                    std::atan2(-x, y) /
                        (2.0f * std::numbers::pi_v<float>);
                break;
            }
        }

        if (
            shader.function == GradientFunction::repeating_linear ||
            shader.function == GradientFunction::repeating_radial ||
            shader.function == GradientFunction::repeating_conic) {
            const float begin = shader.stop_positions.front();
            const float period = shader.stop_positions.back() - begin;
            if (std::abs(period) > 1e-7f) {
                amount = begin + std::fmod(std::fmod(amount - begin, period) + period, period);
            }
        }

        Rml::ColourbPremultiplied color = shader.stop_colors.front();
        for (std::size_t index = 1; index < shader.stop_colors.size(); ++index) {
            const float begin = shader.stop_positions[index - 1];
            const float end = shader.stop_positions[index];
            float factor = amount >= end ? 1.0f : 0.0f;
            if (std::abs(end - begin) > 1e-7f) {
                factor = std::clamp((amount - begin) / (end - begin), 0.0f, 1.0f);
            }
            color = Rml::Math::RoundedLerp(
                factor, color, shader.stop_colors[index]);
        }
        return color;
    }

    Rml::Rectanglei scissor{};
    Rml::Matrix4f transform = Rml::Matrix4f::Identity();
    std::uint64_t next_texture_id = 1;
    bool scissor_enabled = false;
    bool nearest_sampling = false;
    std::unordered_map<std::uint32_t, RetainedCanvasTexture>
        retained_canvas_textures;
};

struct UiRmlRuntime {
    UiRmlRuntime(
        Engine& engine,
        SDL_Window* window,
        std::uint32_t width,
        std::uint32_t height)
        : engine(engine),
          window(window),
          system_interface(window),
          viewport_width(width),
          viewport_height(height) {
        try {
            Rml::SetSystemInterface(&system_interface);
            Rml::SetRenderInterface(&render_interface);
            if (!Rml::Initialise()) {
                throw std::runtime_error("RmlUi initialization failed.");
            }
            initialized = true;

            const std::optional<SystemFontFace> system_regular =
                system_ui_font(400);
            if (!system_regular) {
                throw std::runtime_error(
                    "The platform font service could not resolve system-ui.");
            }
            const std::string system_family = system_regular->family;
            const auto load_system_weight = [
                &system_family](int resolved_weight, int registered_weight) {
                const std::optional<SystemFontFace> face =
                    find_system_font(system_family, resolved_weight);
                if (!face) {
                    throw std::runtime_error(
                        "The platform font service could not resolve '" +
                        system_family + "' at weight " +
                        std::to_string(resolved_weight) + ".");
                }
                load_rml_font(
                    *face,
                    system_family,
                    registered_weight);
            };
            load_rml_font(*system_regular, system_family, 400);
            load_system_weight(700, 700);
            // Chromium's Windows system-ui mapping selects Segoe UI
            // Semibold for weights 500/600 and Segoe UI Black for 800/900.
            // RmlUi otherwise picks the nearest face by numeric distance.
            load_system_weight(600, 500);
            load_system_weight(600, 600);
            load_system_weight(900, 800);
            load_system_weight(900, 900);
            if (const auto fallback = system_ui_fallback_font();
                fallback &&
                (fallback->path != system_regular->path ||
                 fallback->face_index != system_regular->face_index)) {
                load_rml_font(*fallback, fallback->family, 400, true);
            }
            css_font_family = quote_css_font_family(system_family);

            const std::optional<SystemFontFace> sans_regular =
                generic_sans_font(400);
            if (!sans_regular || sans_regular->family == system_family) {
                css_sans_family = css_font_family;
            } else {
                load_rml_font(
                    *sans_regular,
                    sans_regular->family,
                    400);
                const auto sans_bold =
                    find_system_font(sans_regular->family, 700);
                if (!sans_bold) {
                    throw std::runtime_error(
                        "The platform font service could not resolve bold '" +
                        sans_regular->family + "'.");
                }
                load_rml_font(*sans_bold, sans_regular->family, 700);
                css_sans_family =
                    quote_css_font_family(sans_regular->family);
            }

            const std::optional<SystemFontFace> monospace_regular =
                system_monospace_font(400);
            if (monospace_regular) {
                load_rml_font(
                    *monospace_regular,
                    monospace_regular->family,
                    400);
                const auto monospace_bold =
                    find_system_font(monospace_regular->family, 700);
                if (!monospace_bold) {
                    throw std::runtime_error(
                        "The platform font service could not resolve bold '" +
                        monospace_regular->family + "'.");
                }
                load_rml_font(
                    *monospace_bold,
                    monospace_regular->family,
                    700);
                css_monospace_family =
                    quote_css_font_family(monospace_regular->family);
            } else {
                css_monospace_family = css_font_family;
            }

            // Doom names Courier New explicitly rather than relying on the
            // generic monospace face. Load it when the platform exposes it.
            if (const auto courier = find_system_font("Courier New", 400);
                courier &&
                (!monospace_regular ||
                 courier->family != monospace_regular->family)) {
                load_rml_font(*courier, "Courier New", 400);
                if (const auto courier_bold =
                        find_system_font("Courier New", 700)) {
                    load_rml_font(*courier_bold, "Courier New", 700);
                }
            }
            context = Rml::CreateContext(
                "bblite-ui",
                Rml::Vector2i{
                    static_cast<int>(width),
                    static_cast<int>(height)});
            if (!context) {
                throw std::runtime_error("RmlUi context creation failed.");
            }
            update_density_ratio();
            document = context->CreateDocument();
            if (!document) {
                throw std::runtime_error("RmlUi document creation failed.");
            }
            document->SetAttribute(
                "style",
                "width:100%;height:100%;font-family:" + css_font_family +
                    ";font-size:16dp;line-height:1.32;pointer-events:none;");
            sync_style_sheet();
            document->Show(
                Rml::ModalFlag::None,
                Rml::FocusFlag::None,
                Rml::ScrollFlag::None);
            sync_tree();
            update_gradient_text();
            context->Update();
            static_cast<void>(sync_hover_states());
            if (sync_svg_current_colors()) {
                context->Update();
            }
            update_intrinsic_widths();
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

    bool update_density_ratio() {
        const float display_scale = SDL_GetWindowDisplayScale(window);
        const float next_density_ratio =
            display_scale > 0.0f ? display_scale : 1.0f;
        if (density_ratio == next_density_ratio) return false;
        density_ratio = next_density_ratio;
        context->SetDensityIndependentPixelRatio(density_ratio);
        return true;
    }

    std::string project_css(std::string value) const {
        replace_all(value, "system-ui", css_font_family);
        replace_all(value, "sans-serif", css_sans_family);
        replace_all(value, "ui-monospace", css_monospace_family);
        replace_all(value, "monospace", css_monospace_family);
        value = rml_css_animation_easing(std::move(value));
        value = rml_css_density_units(std::move(value));
        return rml_css_color_alpha(std::move(value));
    }

    std::string projected_attribute_value(
        std::string_view name,
        const std::string& source_value) const {
        std::string value = source_value;
        if (name == "style") {
            value = project_css(std::move(value));
        }
        return value;
    }

    static std::string keyframes_from(std::string_view source) {
        std::string keyframes;
        std::size_t search = 0;
        while ((search = source.find("@keyframes", search)) !=
               std::string_view::npos) {
            const std::size_t opening = source.find('{', search + 10);
            if (opening == std::string_view::npos) break;
            int depth = 0;
            std::size_t cursor = opening;
            for (; cursor < source.size(); ++cursor) {
                if (source[cursor] == '{') {
                    ++depth;
                } else if (source[cursor] == '}' && --depth == 0) {
                    ++cursor;
                    break;
                }
            }
            if (depth != 0) break;
            keyframes.append(source.substr(search, cursor - search));
            keyframes.push_back('\n');
            search = cursor;
        }
        return keyframes;
    }

    template <typename Callback>
    void for_each_active_style_element(Callback&& callback) const {
        for (const UiElementHandle handle : engine.ui_root_children) {
            if (handle.value >= engine.ui_elements.size()) continue;
            const UiElementRecord& record = engine.ui_elements[handle.value];
            if (record.tag == "style" && record.attached_to_root) {
                callback(record);
            }
        }
    }

    template <typename Callback>
    void for_each_active_style_rule(Callback&& callback) const {
        for (const UiStyleRule& rule : engine.ui_host_style_rules) {
            callback(rule);
        }
        for_each_active_style_element([&callback](
                                          const UiElementRecord& record) {
            for (const UiStyleRule& rule : record.style_rules) {
                callback(rule);
            }
        });
    }

    bool style_rule_media_matches(const UiStyleRule& rule) const {
        return
            rule.max_width < 0.0 ||
            static_cast<double>(viewport_width) /
                    std::max(1.0f, density_ratio) <=
                rule.max_width;
    }

    template <typename Callback>
    std::size_t for_each_matching_style_rule(
        UiElementHandle handle,
        Callback&& callback) const {
        std::size_t source_order = 0;
        for_each_active_style_rule([&](const UiStyleRule& rule) {
            const std::size_t rule_order = source_order++;
            const bool hovered =
                handle.value < projected_elements.size() &&
                projected_elements[handle.value].element &&
                projected_elements[handle.value].element->
                    IsPseudoClassSet("hover");
            if (
                (rule.hover && !hovered) ||
                !style_rule_media_matches(rule) ||
                !ui_style_rule_matches(engine, handle, rule)) {
                return;
            }
            callback(rule, rule_order);
        });
        return source_order;
    }

    void sync_style_sheet() {
        // Browser user-agent defaults belong below author rules. Keeping them
        // in this sheet rather than on each element also lets :hover and media
        // rules participate in the ordinary RmlUi cascade.
        std::string source =
            "div,canvas{display:block;}\n"
            "button{display:inline-block;box-sizing:border-box;"
            "text-align:center;}\n";
        const auto append_rule = [&source](const UiStyleRule& rule) {
            const std::string public_style =
                filter_private_ui_declarations(rule.style, false);
            if (public_style.empty()) return;
            if (rule.max_width >= 0.0) {
                source += "@media (max-width:";
                source += std::to_string(rule.max_width);
                source += "px){";
            }
            source += ui_style_rule_selector(rule);
            source += "{";
            source += public_style;
            source += "}";
            if (rule.max_width >= 0.0) source += "}";
            source += "\n";
        };
        for_each_active_style_rule(append_rule);
        for_each_active_style_element([&source](
                                          const UiElementRecord& record) {
            source += keyframes_from(record.text);
        });
        source = project_css(std::move(source));
        if (
            source == projected_style_sheet_source &&
            document->GetStyleSheetContainer()) {
            return;
        }
        projected_style_sheet_source = source;
        // Inline decorators still need a StyleSheet instance to resolve
        // their registered instancers. Keep an empty container when no
        // reached <style> element contributes keyframes.
        const std::string style_sheet_source = source.empty()
            ? "body {}"
            : source;
        auto style_sheet =
            Rml::Factory::InstanceStyleSheetString(style_sheet_source);
        if (!style_sheet) {
            throw std::runtime_error(
                "RmlUi could not create the retained UI stylesheet.");
        }
        document->SetStyleSheetContainer(std::move(style_sheet));
    }

    std::string resolved_style_attribute(
        UiElementHandle handle,
        const UiElementRecord& record,
        std::string* resolved_display = nullptr) const {
        std::string style;
        const auto append = [&style](std::string_view declaration) {
            if (declaration.empty()) return;
            if (!style.empty() && style.back() != ';') style += ';';
            style += declaration;
        };

        struct PrivateRule {
            std::uint32_t specificity = 0;
            std::size_t source_order = 0;
            std::string declarations;
        };
        std::vector<PrivateRule> private_rules;
        CascadedUiDeclaration display;
        CascadedUiDeclaration justification;
        bool source_declares_pointer_events = false;
        std::size_t source_order = for_each_matching_style_rule(
            handle,
            [&](const UiStyleRule& rule, std::size_t rule_order) {
            const std::uint32_t specificity =
                ui_style_rule_specificity(rule);
            ProjectedUiStyleSource source =
                project_ui_style_source(rule.style);
            if (!source.private_declarations.empty()) {
                private_rules.push_back({
                    specificity,
                    rule_order,
                    std::move(source.private_declarations)});
            }
            consider_cascaded_declaration(
                display,
                std::move(source.display),
                specificity,
                rule_order);
            consider_cascaded_declaration(
                justification,
                std::move(source.justification),
                specificity,
                rule_order);
            source_declares_pointer_events =
                source_declares_pointer_events ||
                source.declares_pointer_events;
        });
        std::stable_sort(
            private_rules.begin(),
            private_rules.end(),
            [](const PrivateRule& left, const PrivateRule& right) {
                if (left.specificity != right.specificity) {
                    return left.specificity < right.specificity;
                }
                return left.source_order < right.source_order;
            });
        for (const PrivateRule& rule : private_rules) {
            append(rule.declarations);
        }
        const auto inline_style = record.attributes.find("style");
        if (inline_style != record.attributes.end()) {
            ProjectedUiStyleSource source =
                project_ui_style_source(inline_style->second);
            constexpr std::uint32_t inline_specificity = 0xffffffffu;
            consider_cascaded_declaration(
                display,
                std::move(source.display),
                inline_specificity,
                source_order);
            consider_cascaded_declaration(
                justification,
                std::move(source.justification),
                inline_specificity,
                source_order);
            append(inline_style->second);
        }
        constexpr std::uint32_t cssom_specificity = 0xffffffffu;
        if (const auto dynamic_display =
                record.style_properties.find("display");
            dynamic_display != record.style_properties.end()) {
            consider_cascaded_declaration(
                display,
                normalized_css_keyword(dynamic_display->second),
                cssom_specificity,
                source_order + 1);
        }
        if (const auto dynamic_justification =
                record.style_properties.find("justify-content");
            dynamic_justification != record.style_properties.end()) {
            consider_cascaded_declaration(
                justification,
                normalized_css_keyword(dynamic_justification->second),
                cssom_specificity,
                source_order + 1);
        }
        if (resolved_display) {
            *resolved_display = display.value;
        }

        const auto remove_grid_metadata = [&style]() {
            static_cast<void>(take_grid_metadata(style));
        };
        if (!display.value.empty() && display.value != "grid") {
            remove_grid_metadata();
        } else if (!display.value.empty()) {
            static_cast<void>(take_css_declaration(
                style, "--bbl-grid-justify-content"));
            std::string resolved_justification =
                !justification.value.empty()
                    ? justification.value
                    : std::string("start");
            if (
                resolved_justification == "normal" ||
                resolved_justification == "flex-start" ||
                resolved_justification == "left") {
                resolved_justification = "start";
            } else if (
                resolved_justification == "flex-end" ||
                resolved_justification == "right") {
                resolved_justification = "end";
            }
            if (
                resolved_justification != "start" &&
                resolved_justification != "center" &&
                resolved_justification != "end") {
                throw std::runtime_error(
                    "Native fixed-grid justify-content is outside "
                    "start/center/end.");
            }
            append(
                "--bbl-grid-justify-content:" +
                resolved_justification + ";");
        }
        // The retained document covers the viewport, but browser overlays do
        // not replace the scene canvas as an input target. Keep ordinary UI
        // transparent to hit-testing and opt reached listeners back in. An
        // explicit source pointer-events declaration still wins.
        std::string pointer_events_probe = style;
        const bool has_pointer_events =
            record.style_properties.contains("pointer-events") ||
            !take_css_declaration(
                 pointer_events_probe,
                 "pointer-events").empty() ||
            source_declares_pointer_events;
        if (
            !has_pointer_events &&
            (!record.click_callbacks.empty() ||
             !record.event_callbacks.empty())             ) {
                 append("pointer-events:auto;");
             }
             if (
                 !record.text.empty() &&
                 style.find("--bbl-text-gradient:") != std::string::npos &&
            style.find("position:") == std::string::npos) {
            append("position:relative;");
        }
        return projected_attribute_value("style", style);
    }

    bool text_needs_flex_wrapper(
        std::string_view resolved_display) const {
        const std::string display =
            normalized_css_keyword(resolved_display);
        return display == "flex" || display == "inline-flex";
    }

    void append_text_content(
        ProjectedUiElement& projected,
        Rml::Element& parent,
        const std::string& text,
        bool wrapped) {
        projected.gradient_text_elements.clear();
        projected.gradient_text_colors = ::bbl::pal::gradient_text_colors(
            projected.gradient_text_style.palette);
        const bool gradient_text =
            projected.gradient_text_colors.size() > 1;
        if (!wrapped && !gradient_text) {
            parent.AppendChild(document->CreateTextNode(text));
            return;
        }

        Rml::ElementPtr wrapper = document->CreateElement("span");
        if (gradient_text) {
            wrapper->SetAttribute(
                "style",
                "position:relative;white-space:nowrap;");
        }
        if (gradient_text) {
            for (const char character : text) {
                Rml::ElementPtr glyph = document->CreateElement("span");
                Rml::Element* raw_glyph = glyph.get();
                raw_glyph->SetProperty(
                    "color",
                    projected.gradient_text_style.palette.substr(
                        0,
                        projected.gradient_text_style.palette.find('|')));
                const std::string glyph_text = character == ' '
                    ? std::string{"\xC2\xA0"}
                    : std::string(1, character);
                raw_glyph->AppendChild(document->CreateTextNode(glyph_text));
                wrapper->AppendChild(std::move(glyph));
                projected.gradient_text_elements.push_back(raw_glyph);
            }
        } else {
            wrapper->AppendChild(document->CreateTextNode(text));
        }
        parent.AppendChild(std::move(wrapper));
    }

    void append_crosshair(
        ProjectedUiElement& projected,
        Rml::Element& parent,
        const std::string& color) {
        // Use the same ordinary retained bar markup as the Doom HUD. The
        // compiler marker only bridges CSS layered-background syntax into a
        // representation RmlUi supports; rendering stays on the established
        // inner-RML path rather than adding a crosshair renderer primitive.
        parent.SetInnerRML(
            "<div style=\"position:absolute;left:10px;top:0;"
            "width:2px;height:22px;background-color:" + color +
            ";\"></div>"
            "<div style=\"position:absolute;left:0;top:10px;"
            "width:22px;height:2px;background-color:" + color +
            ";\"></div>");
        projected.crosshair_color = color;
    }

    void sync_inset_outline(
        ProjectedUiElement& projected,
        Rml::Element& parent,
        const std::string& outline) {
        std::string position_probe = projected.resolved_style;
        const bool authored_position =
            !take_css_declaration(position_probe, "position").empty() ||
            projected.style_properties.contains("position");
        if (
            projected.inset_outline_positioned_parent &&
            (outline.empty() || authored_position)) {
            parent.RemoveProperty("position");
            projected.inset_outline_positioned_parent = false;
            if (const auto authored =
                    projected.style_properties.find("position");
                authored != projected.style_properties.end()) {
                parent.SetProperty(
                    "position",
                    project_css(authored->second));
            }
        }
        if (
            !outline.empty() &&
            !authored_position &&
            !projected.inset_outline_positioned_parent) {
            parent.SetProperty("position", "relative");
            projected.inset_outline_positioned_parent = true;
        }
        if (
            projected.inset_outline == outline &&
            (outline.empty() ||
             (projected.inset_outline_element &&
              projected.inset_outline_element->GetParentNode() == &parent))) {
            return;
        }
        if (projected.inset_outline_element) {
            Rml::Element* element = projected.inset_outline_element;
            if (element->GetParentNode() == &parent) {
                Rml::ElementPtr removed = parent.RemoveChild(element);
            }
            projected.inset_outline_element = nullptr;
        }
        projected.inset_outline = outline;
        if (outline.empty()) return;

        Rml::ElementPtr element =
            document->CreateElement("bbl-inset-outline");
        projected.inset_outline_element = element.get();
        projected.inset_outline_element->SetAttribute(
            "style",
            "position:absolute;top:0;right:0;bottom:0;left:0;"
            "pointer-events:none;border:" + outline + ";");
        parent.AppendChild(std::move(element));
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
                "click",
                default_prevented);
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
                event,
                default_prevented);
            projected.element->AddEventListener(event, listener.get());
            listeners.push_back(std::move(listener));
            projected.event_listeners_attached[event] = true;
        }
    }

    std::vector<Rml::ElementPtr> detach_authored_children(
        Rml::Element& parent,
        const UiElementRecord& record) {
        std::vector<Rml::ElementPtr> children;
        children.reserve(record.children.size());
        for (const UiElementHandle child : record.children) {
            if (
                child.value >= projected_elements.size() ||
                ui_element(engine, child).tag == "style") {
                continue;
            }
            Rml::Element* element = projected_elements[child.value].element;
            if (element && element->GetParentNode() == &parent) {
                children.push_back(parent.RemoveChild(element));
            }
        }
        return children;
    }

    void sync_grid_children_container(
        ProjectedUiElement& projected,
        Rml::Element& raw,
        const UiElementRecord& record,
        const std::string& style) {
        if (projected.grid_children_style == style) return;
        if (!style.empty() && !projected.children_container) {
            std::vector<Rml::ElementPtr> children =
                detach_authored_children(raw, record);
            Rml::ElementPtr container =
                document->CreateElement("bbl-grid-children");
            if (!container) {
                throw std::runtime_error(
                    "RmlUi could not create the fixed-grid child container.");
            }
            projected.children_container = container.get();
            projected.children_container->SetAttribute("style", style);
            for (Rml::ElementPtr& child : children) {
                projected.children_container->AppendChild(std::move(child));
            }
            raw.AppendChild(std::move(container));
        } else if (style.empty() && projected.children_container) {
            std::vector<Rml::ElementPtr> children =
                detach_authored_children(
                    *projected.children_container,
                    record);
            Rml::ElementPtr removed =
                raw.RemoveChild(projected.children_container);
            projected.children_container = nullptr;
            for (Rml::ElementPtr& child : children) {
                raw.AppendChild(std::move(child));
            }
            static_cast<void>(removed);
        } else if (projected.children_container) {
            projected.children_container->SetAttribute("style", style);
        }
        projected.grid_children_style = style;
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
        std::string resolved_display;
        projected.resolved_style =
            resolved_style_attribute(handle, record, &resolved_display);
        projected.intrinsic_min_width =
            take_intrinsic_min_width(projected.resolved_style);
        projected.grid_children_style =
            take_grid_children_style(projected.resolved_style);
        projected.crosshair_color =
            take_crosshair_color(projected.resolved_style);
        projected.inset_outline =
            take_inset_outline(projected.resolved_style);
        projected.gradient_text_style =
            take_gradient_text_style(projected.resolved_style);
        if (!projected.resolved_style.empty()) {
            raw->SetAttribute("style", projected.resolved_style);
        }
        for (const auto& [name, value] : record.style_properties) {
            if (!project_rml_style_property(name)) continue;
            raw->SetProperty(name, project_css(value));
        }
        if (!record.inner_rml.empty()) {
            raw->SetInnerRML(record.inner_rml);
        } else if (!record.text.empty()) {
            projected.text_wrapped = text_needs_flex_wrapper(
                resolved_display);
            append_text_content(
                projected,
                *raw,
                record.text,
                projected.text_wrapped);
        }
        if (!projected.crosshair_color.empty()) {
            if (
                !record.text.empty() || !record.inner_rml.empty() ||
                !record.children.empty()) {
                throw std::runtime_error(
                    "A retained crosshair cannot also carry source content.");
            }
            append_crosshair(
                projected,
                *raw,
                projected.crosshair_color);
        }
        projected.text = record.text;
        projected.inner_rml = record.inner_rml;
        projected.attributes = record.attributes;
        projected.style_properties = record.style_properties;
        attach_listeners(projected, handle);
        Rml::Element* children_parent = raw;
        if (!projected.grid_children_style.empty()) {
            Rml::ElementPtr children_container =
                document->CreateElement("bbl-grid-children");
            projected.children_container = children_container.get();
            projected.children_container->SetAttribute(
                "style", projected.grid_children_style);
            raw->AppendChild(std::move(children_container));
            children_parent = projected.children_container;
        }
        for (const UiElementHandle child : record.children) {
            if (ui_element(engine, child).tag == "style") continue;
            append_element(*children_parent, child);
        }
        sync_inset_outline(
            projected,
            *raw,
            projected.inset_outline);
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

    void sync_projected_root_order() {
        std::vector<std::uint32_t> desired;
        for (const UiElementHandle handle : engine.ui_root_children) {
            if (
                handle.value < engine.ui_elements.size() &&
                engine.ui_elements[handle.value].attached_to_root &&
                engine.ui_elements[handle.value].tag != "style") {
                desired.push_back(handle.value);
            }
        }
        if (desired == projected_root_order) return;

        std::vector<Rml::ElementPtr> roots;
        roots.reserve(desired.size());
        for (const std::uint32_t index : desired) {
            Rml::Element* element = projected_elements[index].element;
            if (element && element->GetParentNode() == document) {
                roots.push_back(document->RemoveChild(element));
            }
        }
        for (Rml::ElementPtr& root : roots) {
            document->AppendChild(std::move(root));
        }
        projected_root_order = std::move(desired);
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
        std::string resolved_display;
        std::string resolved_style =
            resolved_style_attribute(handle, record, &resolved_display);
        const std::string intrinsic_min_width =
            take_intrinsic_min_width(resolved_style);
        const std::string grid_children_style =
            take_grid_children_style(resolved_style);
        const std::string crosshair_color =
            take_crosshair_color(resolved_style);
        const bool crosshair_changed =
            projected.crosshair_color != crosshair_color;
        const std::string inset_outline =
            take_inset_outline(resolved_style);
        const GradientTextStyle gradient_text_style =
            take_gradient_text_style(resolved_style);
        const bool gradient_text_style_changed =
            projected.gradient_text_style != gradient_text_style;
        const bool resolved_style_changed =
            projected.resolved_style != resolved_style;
        if (
            !projected.intrinsic_min_width.empty() &&
            intrinsic_min_width.empty()) {
            raw.RemoveProperty("width");
        }
        if (resolved_style_changed) {
            if (resolved_style.empty()) {
                raw.RemoveAttribute("style");
            } else {
                raw.SetAttribute("style", resolved_style);
            }
            projected.resolved_style = resolved_style;
        }
        sync_grid_children_container(
            projected,
            raw,
            record,
            grid_children_style);
        projected.intrinsic_min_width = intrinsic_min_width;
        projected.attributes = record.attributes;

        for (const auto& [name, old_value] : projected.style_properties) {
            static_cast<void>(old_value);
            if (!record.style_properties.contains(name)) {
                raw.RemoveProperty(name);
            }
        }
        for (const auto& [name, value] : record.style_properties) {
            if (!project_rml_style_property(name)) continue;
            const auto existing = projected.style_properties.find(name);
            if (
                resolved_style_changed ||
                existing == projected.style_properties.end() ||
                existing->second != value) {
                raw.SetProperty(name, project_css(value));
            }
        }
        projected.style_properties = record.style_properties;

        const bool text_wrapped =
            !record.text.empty() &&
            text_needs_flex_wrapper(resolved_display);
        if (
            projected.text != record.text ||
            projected.inner_rml != record.inner_rml ||
            projected.text_wrapped != text_wrapped ||
            crosshair_changed ||
            gradient_text_style_changed) {
            // The lowered surface currently models either text or element
            // children, matching every reached scene. Keep the owning element
            // stable while replacing only its text node so hover, active, and
            // pointer-capture state survive per-frame HUD updates.
            if (
                !record.children.empty() &&
                (!record.text.empty() || !record.inner_rml.empty())) {
                throw std::runtime_error(
                    "Mixed text and element children are not implemented in native UI: <" +
                    record.tag + "> text='" + record.text + "' inner_rml='" +
                    record.inner_rml + "' children=" +
                    std::to_string(record.children.size()) + ".");
            }
            while (raw.GetNumChildren() > 0) {
                projected.inset_outline_element = nullptr;
                Rml::ElementPtr removed = raw.RemoveChild(raw.GetChild(0));
            }
            projected.gradient_text_elements.clear();
            projected.gradient_text_colors.clear();
            projected.gradient_text_style = gradient_text_style;
            if (!record.inner_rml.empty()) {
                raw.SetInnerRML(record.inner_rml);
            } else if (!record.text.empty()) {
                append_text_content(
                    projected,
                    raw,
                    record.text,
                    text_wrapped);
            }
            if (!crosshair_color.empty()) {
                if (
                    !record.text.empty() || !record.inner_rml.empty() ||
                    !record.children.empty()) {
                    throw std::runtime_error(
                        "A retained crosshair cannot also carry source content.");
                }
                append_crosshair(
                    projected,
                    raw,
                    crosshair_color);
            }
            projected.text = record.text;
            projected.inner_rml = record.inner_rml;
            projected.text_wrapped = text_wrapped;
        }
        projected.crosshair_color = crosshair_color;
        projected.gradient_text_style = gradient_text_style;

        attach_listeners(projected, handle);
        Rml::Element& children_parent = projected.children_container
            ? *projected.children_container
            : raw;
        for (const UiElementHandle child : record.children) {
            if (ui_element(engine, child).tag == "style") continue;
            if (!projected_elements[child.value].element) {
                append_element(children_parent, child);
            } else {
                update_element(child);
            }
        }
        sync_inset_outline(projected, raw, inset_outline);
    }

    void sync_tree() {
        ensure_projection_size();
        std::vector<bool> reachable(engine.ui_elements.size(), false);
        for (const UiElementHandle handle : engine.ui_root_children) {
            if (
                handle.value < engine.ui_elements.size() &&
                engine.ui_elements[handle.value].attached_to_root) {
                mark_reachable(handle, reachable);
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

        for (const UiElementHandle handle : engine.ui_root_children) {
            if (handle.value >= engine.ui_elements.size()) continue;
            const std::uint32_t index = handle.value;
            if (!engine.ui_elements[index].attached_to_root) continue;
            if (engine.ui_elements[index].tag == "style") continue;
            if (!projected_elements[index].element) {
                append_element(*document, handle);
            } else {
                update_element(handle);
            }
        }
        sync_projected_root_order();
        refresh_current_color_svg_elements();
        projected_revision = engine.ui_revision;
    }

    bool has_active_authored_width(
        UiElementHandle handle,
        const UiElementRecord& record) const {
        CascadedUiDeclaration width;
        std::size_t source_order = for_each_matching_style_rule(
            handle,
            [&](const UiStyleRule& rule, std::size_t rule_order) {
            std::string style =
                filter_private_ui_declarations(rule.style, false);
            consider_cascaded_declaration(
                width,
                take_css_declaration(style, "width"),
                ui_style_rule_specificity(rule),
                rule_order);
        });
        constexpr std::uint32_t inline_specificity = 0xffffffffu;
        if (const auto inline_style = record.attributes.find("style");
            inline_style != record.attributes.end()) {
            std::string style = filter_private_ui_declarations(
                inline_style->second,
                false);
            consider_cascaded_declaration(
                width,
                take_css_declaration(style, "width"),
                inline_specificity,
                source_order);
        }
        if (const auto dynamic_width =
                record.style_properties.find("width");
            dynamic_width != record.style_properties.end()) {
            consider_cascaded_declaration(
                width,
                dynamic_width->second,
                inline_specificity,
                source_order + 1);
        }
        return !width.value.empty() &&
            is_concrete_authored_width(width.value);
    }

    bool sync_hover_states() {
        bool changed = false;
        for (ProjectedUiElement& projected : projected_elements) {
            if (!projected.element) continue;
            const bool hovered =
                projected.element->IsPseudoClassSet("hover");
            if (projected.hovered == hovered) continue;
            projected.hovered = hovered;
            changed = true;
        }
        return changed;
    }

    void update_intrinsic_widths() {
        struct IntrinsicChild {
            Rml::Element* element = nullptr;
            std::string width;
        };
        struct IntrinsicParent {
            Rml::Element* element = nullptr;
            UiElementHandle handle{};
            std::string minimum;
            std::vector<IntrinsicChild> children;
        };

        bool cleared_width = false;
        for (
            std::uint32_t index = 0;
            index < projected_elements.size() &&
            index < engine.ui_elements.size();
            ++index) {
            ProjectedUiElement& projected = projected_elements[index];
            if (!projected.element || !projected.intrinsic_width_applied) {
                continue;
            }
            projected.element->RemoveProperty("width");
            if (const auto dynamic_width =
                    engine.ui_elements[index].style_properties.find("width");
                dynamic_width !=
                engine.ui_elements[index].style_properties.end()) {
                projected.element->SetProperty(
                    "width",
                    project_css(dynamic_width->second));
            }
            projected.intrinsic_width_applied = false;
            cleared_width = true;
        }
        if (cleared_width) context->Update();

        std::vector<IntrinsicParent> parents;
        for (
            std::uint32_t index = 0;
            index < projected_elements.size();
            ++index) {
            ProjectedUiElement& projected = projected_elements[index];
            if (!projected.element || projected.intrinsic_min_width.empty()) {
                continue;
            }
            if (has_active_authored_width(
                    UiElementHandle{index},
                    engine.ui_elements[index])) {
                continue;
            }

            IntrinsicParent parent{
                projected.element,
                UiElementHandle{index},
                projected.intrinsic_min_width,
                {}};
            for (const UiElementHandle child_handle :
                 engine.ui_elements[index].children) {
                if (
                    child_handle.value >= projected_elements.size() ||
                    !projected_elements[child_handle.value].element) {
                    continue;
                }
                Rml::Element* child =
                    projected_elements[child_handle.value].element;
                const Rml::Style::ComputedValues& computed =
                    child->GetComputedValues();
                if (
                    is_inline_level(computed.display()) &&
                    computed.width().type == Rml::Style::Width::Percentage &&
                    computed.position() != Rml::Style::Position::Absolute &&
                    computed.position() != Rml::Style::Position::Fixed) {
                    std::string child_style =
                        projected_elements[child_handle.value].resolved_style;
                    std::string width =
                        take_css_declaration(child_style, "width");
                    const UiElementRecord& child_record =
                        engine.ui_elements[child_handle.value];
                    if (const auto dynamic_width =
                            child_record.style_properties.find("width");
                        dynamic_width != child_record.style_properties.end()) {
                        width = project_css(dynamic_width->second);
                    }
                    parent.children.push_back({child, std::move(width)});
                }
            }
            if (!parent.children.empty()) {
                parents.push_back(std::move(parent));
            }
        }
        if (parents.empty()) return;

        // CSS max-content sizing treats percentage widths as auto when the
        // containing block is itself shrink-to-fit. RmlUi exposes no intrinsic
        // measurement API, so perform the equivalent bounded layout pass.
        for (IntrinsicParent& parent : parents) {
            parent.element->SetProperty("width", parent.minimum);
            for (const IntrinsicChild& child : parent.children) {
                child.element->SetProperty("width", "auto");
            }
        }
        context->Update();

        for (IntrinsicParent& parent : parents) {
            float max_content_width =
                parent.element->GetBox().GetSize(Rml::BoxArea::Content).x;
            float inline_run_width = 0.0f;

            for (const UiElementHandle child_handle :
                 engine.ui_elements[parent.handle.value].children) {
                if (
                    child_handle.value >= projected_elements.size() ||
                    !projected_elements[child_handle.value].element) {
                    continue;
                }
                Rml::Element* child =
                    projected_elements[child_handle.value].element;
                const Rml::Style::ComputedValues& computed =
                    child->GetComputedValues();
                if (
                    computed.display() == Rml::Style::Display::None ||
                    computed.position() == Rml::Style::Position::Absolute ||
                    computed.position() == Rml::Style::Position::Fixed) {
                    continue;
                }
                const Rml::Box& box = child->GetBox();
                float content_width =
                    box.GetSize(Rml::BoxArea::Content).x;
                const UiElementRecord& child_record =
                    engine.ui_elements[child_handle.value];
                if (
                    !child_record.text.empty() &&
                    child_record.children.empty()) {
                    // RmlUi's default font engine selects integer-sized font
                    // handles. Compensate its max-content measurement for a
                    // fractional CSS font size while retaining the actual box
                    // frame and margins measured by RmlUi.
                    const float integer_font_size =
                        std::floor(computed.font_size());
                    if (integer_font_size > 0.0f) {
                        content_width *=
                            computed.font_size() / integer_font_size;
                    }
                }
                const float outer_width =
                    content_width +
                    box.GetSize(Rml::BoxArea::Border).x -
                    box.GetSize(Rml::BoxArea::Content).x +
                    box.GetEdge(Rml::BoxArea::Margin, Rml::BoxEdge::Left) +
                    box.GetEdge(Rml::BoxArea::Margin, Rml::BoxEdge::Right);
                if (is_inline_level(computed.display())) {
                    inline_run_width += outer_width;
                } else {
                    max_content_width = std::max(
                        max_content_width,
                        std::max(inline_run_width, outer_width));
                    inline_run_width = 0.0f;
                }
            }
            max_content_width = std::max(max_content_width, inline_run_width);
            parent.element->SetProperty(
                "width", std::to_string(max_content_width) + "px");
            projected_elements[parent.handle.value].intrinsic_width_applied =
                true;

            for (const IntrinsicChild& child : parent.children) {
                if (child.width.empty()) {
                    child.element->RemoveProperty("width");
                } else {
                    child.element->SetProperty("width", child.width);
                }
            }
        }
        context->Update();
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
                CanvasMesh mesh;
                Rml::TextureHandle texture{};
                if (
                    draw.kind ==
                    UiElementRecord::CanvasDrawCommand::Kind::Blit) {
                    if (draw.source.value >= engine.ui_elements.size()) {
                        continue;
                    }
                    const UiElementRecord& source =
                        engine.ui_elements[draw.source.value];
                    if (!source.canvas) continue;
                    mesh = canvas_blit_mesh(draw, scale_x, scale_y);
                    texture = render_interface.retained_canvas_texture(
                        draw.source,
                        *source.canvas);
                    if (!texture) continue;
                } else if (
                    draw.kind ==
                    UiElementRecord::CanvasDrawCommand::Kind::Text) {
                    if (render_canvas_text(draw, offset, scale_x, scale_y)) {
                        continue;
                    }
                    mesh = canvas_text_mesh(draw, scale_x, scale_y);
                } else {
                    mesh = canvas_mesh(draw, scale_x, scale_y);
                }
                if (mesh.vertices.empty() || mesh.indices.empty()) continue;
                const Rml::CompiledGeometryHandle geometry =
                    render_interface.CompileGeometry(
                        mesh.vertices,
                        mesh.indices);
                if (!geometry) continue;
                render_interface.RenderGeometryWithSampling(
                    geometry,
                    offset,
                    texture,
                    draw.nearest_sampling);
                render_interface.ReleaseGeometry(geometry);
            }
        }
    }

    bool render_canvas_text(
        const UiElementRecord::CanvasDrawCommand& draw,
        Rml::Vector2f canvas_offset,
        double scale_x,
        double scale_y) {
        Rml::FontEngineInterface* fonts = Rml::GetFontEngineInterface();
        if (!fonts || !context || draw.text.empty()) return false;

        const double layout_scale =
            (std::abs(scale_x) + std::abs(scale_y)) * 0.5;
        const int font_size = std::max(
            1,
            static_cast<int>(std::lround(draw.font_size * layout_scale)));
        const bool monospace =
            draw.font_family.find("monospace") != std::string::npos;
        const std::string& family = monospace
            ? css_monospace_family
            : css_font_family;
        const Rml::FontFaceHandle face = fonts->GetFontFaceHandle(
            family,
            Rml::Style::FontStyle::Normal,
            Rml::Style::FontWeight::Normal,
            font_size);
        if (!face) return false;

        const Rml::FontMetrics& metrics = fonts->GetFontMetrics(face);
        float baseline = canvas_offset.y +
            static_cast<float>(draw.destination_y * scale_y);
        if (draw.text_baseline == "top") {
            baseline += metrics.ascent;
        } else if (draw.text_baseline == "middle") {
            baseline += (metrics.ascent - metrics.descent) * 0.5f;
        } else if (
            draw.text_baseline == "bottom" ||
            draw.text_baseline == "ideographic") {
            baseline -= metrics.descent;
        }
        const float left = canvas_offset.x +
            static_cast<float>(draw.destination_x * scale_x);
        const Rml::String language;
        const Rml::TextShapingContext shaping{language};
        Rml::RenderManager& render_manager = context->GetRenderManager();

        const auto render_text = [&](Rml::Vector2f position,
                                     Rml::ColourbPremultiplied color) {
            Rml::TexturedMeshList meshes;
            fonts->GenerateString(
                render_manager,
                face,
                {},
                draw.text,
                position,
                color,
                1.0f,
                shaping,
                meshes);
            for (Rml::TexturedMesh& textured_mesh : meshes) {
                Rml::Geometry geometry = render_manager.MakeGeometry(
                    std::move(textured_mesh.mesh));
                geometry.Render({}, textured_mesh.texture);
            }
        };

        const Rml::Vector2f position{left, baseline};
        const Rml::ColourbPremultiplied shadow =
            canvas_color(draw.shadow_color);
        if (shadow.alpha > 0 && draw.shadow_blur > 0.0) {
            const float radius = std::max(
                1.0f,
                static_cast<float>(
                    std::min(draw.shadow_blur * layout_scale * 0.35, 2.0)));
            render_text(position + Rml::Vector2f{-radius, 0.0f}, shadow);
            render_text(position + Rml::Vector2f{radius, 0.0f}, shadow);
            render_text(position + Rml::Vector2f{0.0f, -radius}, shadow);
            render_text(position + Rml::Vector2f{0.0f, radius}, shadow);
        }
        render_text(position, canvas_color(draw.color));
        return true;
    }

    void update_gradient_text() {
        const double now = system_interface.GetElapsedTime();
        for (ProjectedUiElement& projected : projected_elements) {
            const std::size_t glyph_count =
                projected.gradient_text_elements.size();
            const std::size_t color_count =
                projected.gradient_text_colors.size();
            if (glyph_count == 0 || color_count < 2) continue;

            char* duration_end = nullptr;
            const double duration = std::strtod(
                projected.gradient_text_style.duration.c_str(),
                &duration_end);
            const double phase =
                duration_end != projected.gradient_text_style.duration.c_str() &&
                    duration > 0.0
                ? std::fmod((now / duration) * 2.0, 1.0)
                : 0.0;
            char* scale_end = nullptr;
            const double parsed_scale = std::strtod(
                projected.gradient_text_style.scale.c_str(),
                &scale_end);
            const double scale =
                scale_end != projected.gradient_text_style.scale.c_str() &&
                    parsed_scale > 0.0
                ? parsed_scale / 100.0
                : 1.0;
            const auto sample_palette = [color_count, &projected](
                                            double position) {
                position = std::fmod(position, 1.0);
                if (position < 0.0) position += 1.0;
                const double palette_position =
                    position * static_cast<double>(color_count - 1);
                const std::size_t left = std::min(
                    static_cast<std::size_t>(palette_position),
                    color_count - 2);
                const double amount = palette_position - left;
                const GradientTextColor& a =
                    projected.gradient_text_colors[left];
                const GradientTextColor& b =
                    projected.gradient_text_colors[left + 1];
                return GradientTextColor{
                    a.red + (b.red - a.red) * amount,
                    a.green + (b.green - a.green) * amount,
                    a.blue + (b.blue - a.blue) * amount};
            };
            for (std::size_t index = 0; index < glyph_count; ++index) {
                const double glyph_position = glyph_count > 1
                    ? static_cast<double>(index) /
                        static_cast<double>(glyph_count - 1) / scale
                    : 0.0;
                // One Rml glyph cannot carry a clipped gradient. Average a
                // few samples across its visual interval rather than taking
                // a single high-saturation point from the palette.
                GradientTextColor average{};
                constexpr int sample_count = 5;
                const double half_extent = glyph_count > 1
                    ? 0.45 /
                        (static_cast<double>(glyph_count - 1) * scale)
                    : 0.0;
                for (int sample = 0; sample < sample_count; ++sample) {
                    const double across =
                        static_cast<double>(sample) /
                            static_cast<double>(sample_count - 1) *
                            2.0 -
                        1.0;
                    const GradientTextColor color = sample_palette(
                        glyph_position + phase + across * half_extent);
                    average.red += color.red / sample_count;
                    average.green += color.green / sample_count;
                    average.blue += color.blue / sample_count;
                }
                const auto channel = [](double value) {
                    return static_cast<unsigned>(std::clamp(
                        std::lround(value),
                        0l,
                        255l));
                };
                char color[8]{};
                std::snprintf(
                    color,
                    sizeof(color),
                    "#%02x%02x%02x",
                    channel(average.red),
                    channel(average.green),
                    channel(average.blue));
                projected.gradient_text_elements[index]->SetProperty(
                    "color",
                    color);
            }
        }
    }

    void sync_client_rects(bool all_elements) {
        for (
            std::uint32_t index = 0;
            index < projected_elements.size() &&
            index < engine.ui_elements.size();
            ++index) {
            UiElementRecord& record = engine.ui_elements[index];
            if (!all_elements && !record.client_rect_requested) continue;
            Rml::Element* element = projected_elements[index].element;
            if (!element) {
                record.client_rect = {};
                continue;
            }
            const Rml::Vector2f offset = element->GetAbsoluteOffset(
                Rml::BoxArea::Border);
            record.client_rect = {
                static_cast<double>(offset.x),
                static_cast<double>(offset.y),
                static_cast<double>(element->GetClientWidth()),
                static_cast<double>(element->GetClientHeight())};
        }
    }

    void refresh_current_color_svg_elements() {
        Rml::ElementList svg_elements;
        document->GetElementsByTagName(svg_elements, "svg");
        current_color_svg_elements.clear();
        current_color_svg_elements.reserve(svg_elements.size());
        for (Rml::Element* element : svg_elements) {
            if (element->HasAttribute("data-bbl-current-color")) {
                current_color_svg_elements.push_back(element);
            }
        }
    }

    bool sync_svg_current_colors() {
        bool changed = false;
        for (Rml::Element* element : current_color_svg_elements) {
            const Rml::Style::ComputedValues& computed =
                element->GetComputedValues();
            const Rml::Colourb color = computed.color();
            const Rml::Colourb image_color = computed.image_color();
            if (color == image_color) continue;
            const std::string value =
                "rgba(" + std::to_string(color.red) + "," +
                std::to_string(color.green) + "," +
                std::to_string(color.blue) + "," +
                std::to_string(color.alpha) + ")";
            if (!element->SetProperty("image-color", value)) {
                throw std::runtime_error(
                    "RmlUi could not apply inherited currentColor to inline SVG.");
            }
            changed = true;
        }
        return changed;
    }

    Engine& engine;
    SDL_Window* window = nullptr;
    UiSystemInterface system_interface;
    UiRenderRecorder render_interface;
    Rml::Context* context = nullptr;
    Rml::ElementDocument* document = nullptr;
    std::vector<std::unique_ptr<UiEventListener>> listeners;
    std::vector<ProjectedUiElement> projected_elements;
    std::vector<Rml::Element*> current_color_svg_elements;
    std::vector<std::uint32_t> projected_root_order;
    std::uint64_t projected_revision = invalid_handle;
    std::string css_font_family;
    std::string css_sans_family;
    std::string css_monospace_family;
    std::string projected_style_sheet_source;
    float density_ratio = 0.0f;
    std::uint32_t viewport_width = 0;
    std::uint32_t viewport_height = 0;
    bool default_prevented = false;
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
    // Pointer lock belongs exclusively to the scene canvas. Letting RmlUi
    // inspect relative-mode packets can both consume the application's look
    // events and ask SDL to show a UI cursor while the browser contract says
    // it must remain hidden.
    if (
        runtime.engine.pointer_locked &&
        (event.type == SDL_EVENT_MOUSE_MOTION ||
         event.type == SDL_EVENT_MOUSE_BUTTON_DOWN ||
         event.type == SDL_EVENT_MOUSE_BUTTON_UP ||
         event.type == SDL_EVENT_MOUSE_WHEEL)) {
        return true;
    }
    runtime.default_prevented = false;
    Rml::Element* previous_focus = runtime.context->GetFocusElement();
    const bool result =
        RmlSDL::InputEventHandler(runtime.context, runtime.window, event);
    if (
        runtime.default_prevented &&
        event.type == SDL_EVENT_MOUSE_BUTTON_DOWN) {
        Rml::Element* current_focus = runtime.context->GetFocusElement();
        if (previous_focus) {
            previous_focus->Focus();
        } else if (current_focus) {
            current_focus->Blur();
        }
    }
    return result;
}

void update_ui_rml_runtime(
    UiRmlRuntime& runtime,
    std::uint32_t width,
    std::uint32_t height) {
    const bool dimensions_changed =
        runtime.viewport_width != width ||
        runtime.viewport_height != height;
    runtime.viewport_width = width;
    runtime.viewport_height = height;
    runtime.context->SetDimensions(Rml::Vector2i{
        static_cast<int>(width),
        static_cast<int>(height)});
    const bool density_changed = runtime.update_density_ratio();
    const bool tree_changed =
        runtime.projected_revision != runtime.engine.ui_revision;
    if (tree_changed) {
        runtime.sync_style_sheet();
        runtime.sync_tree();
    }
    runtime.update_gradient_text();
    runtime.context->Update();
    const bool hover_changed = runtime.sync_hover_states();
    if (hover_changed) {
        // Public :hover declarations are handled by RmlUi itself. Re-run the
        // private structural projection so fixed-grid metadata and synthetic
        // intrinsic widths observe the same active selector set.
        runtime.sync_tree();
        runtime.context->Update();
    }
    if (runtime.sync_svg_current_colors()) {
        runtime.context->Update();
    }
    if (
        tree_changed ||
        density_changed ||
        dimensions_changed ||
        hover_changed) {
        runtime.update_intrinsic_widths();
    }
    runtime.sync_client_rects(
        tree_changed ||
        density_changed ||
        dimensions_changed ||
        hover_changed);
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
    if (runtime.engine.canvas_focused) {
        append_canvas_focus_outline(runtime.render_interface.frame);
    }
    runtime.render_interface.append_composite_quad();
    return runtime.render_interface.frame;
}

} // namespace pal
} // namespace bbl
