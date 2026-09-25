#include <bblite/features/has_browser_file.hpp>
#include <bblite/features/has_pbr_renderer.hpp>

#include <bblite/pal_window_realm.hpp>
#include <bblite/pal.hpp>
#include <bblite/pal_animation_frame.hpp>
#include <bblite/pal_location.hpp>
#include "pal_window_presenter.hpp"
#include "pal_window_frame_clock.hpp"
#include "pal_gpu_frame.hpp"
#include "pal_platform_events.hpp"
#include "pal_system_preferences.hpp"
#include "pal_window.hpp"
#include "pal_gpu_dispatch.hpp"
#include "pal_file_io.hpp"
#if BBLITE_HAS_PBR_RENDERER
#include "pal_camera_controls.hpp"
#endif

#include <atomic>
#include <bit>
#include <charconv>
#include <condition_variable>
#include <iostream>
#include <sstream>
#include <iomanip>
#include <thread>

namespace bbl::pal {
namespace {
struct WindowScreenshotCheckpoint {
    long frame;
    std::string path;
};

std::vector<WindowScreenshotCheckpoint> window_screenshot_checkpoints(std::string_view source,
                                                                      const FrameOptions& options,
                                                                      bool captures_engine_frames) {
    if (source.empty())
        return {};
    if (options.screenshot_path.empty() || captures_engine_frames)
        throw std::invalid_argument(
            "BBLITE_SCREENSHOT_FRAMES requires BBLITE_SCREENSHOT and presentation-frame capture.");
    const auto final_path = detail::utf8_file_path(options.screenshot_path);
    std::vector<WindowScreenshotCheckpoint> checkpoints;
    std::size_t begin = 0;
    while (begin <= source.size()) {
        const auto separator = source.find(',', begin);
        const auto end = separator == std::string_view::npos ? source.size() : separator;
        const auto token = source.substr(begin, end - begin);
        long frame = 0;
        const auto parsed = std::from_chars(token.data(), token.data() + token.size(), frame);
        if (token.empty() || token.front() < '0' || token.front() > '9' ||
            parsed.ec != std::errc{} || parsed.ptr != token.data() + token.size() ||
            frame >= options.screenshot_frame ||
            (!checkpoints.empty() && frame <= checkpoints.back().frame))
            throw std::invalid_argument(
                "BBLITE_SCREENSHOT_FRAMES requires ordered unique nonnegative integers before BBLITE_SCREENSHOT_FRAME.");
        auto path = final_path;
        path.replace_extension(".frame-" + std::to_string(frame) + ".png");
        const auto encoded = path.u8string();
        checkpoints.push_back({frame, std::string(encoded.begin(), encoded.end())});
        if (separator == std::string_view::npos)
            break;
        begin = separator + 1;
    }
    return checkpoints;
}

struct WindowEvent final : ExternalEvent {
    UiElementHandle element;
    std::string type;
    PlatformMouseEvent mouse;
    std::optional<std::string> form_value;
    std::optional<bool> checked;
    std::optional<UiElementHandle> selected_option;
    std::optional<bool> open;
};
struct WindowDomEvent final : ExternalEvent {
    std::shared_ptr<DomEventBatch> batch;
};
/** Only pointer event structs are copied; SDL events containing pointers are
 * never admitted to the realm mailbox. */
struct WindowPointerEvent final : ExternalEvent {
    UiElementHandle element;
    SDL_Event pointer{};
    SDL_MouseButtonFlags buttons = 0;
};
struct ListenerNames {
    bool click = false;
    std::vector<std::string> events;
};
struct ClipboardWrite final : CompletionEvent {
    std::string text;
    std::string error;
    ClipboardWrite(std::uint64_t id, std::string value)
        : CompletionEvent(id), text(std::move(value)) {}
};
struct DocumentSnapshot {
    struct TextUpdate {
        UiElementHandle element;
        std::string text;
    };
    std::optional<std::vector<TextUpdate>> text_updates;
    Engine::DocumentRoots document_roots;
    std::vector<UiElementRecord> elements;
    std::vector<ListenerNames> listeners;
    std::vector<UiElementHandle> roots;
    std::vector<UiStyleRule> styles;
    std::uint64_t style_revision = 0;
    std::set<std::string> dom_event_types;
    std::set<std::uint32_t> dom_pointer_elements;
};
struct LayoutSnapshot {
    std::vector<UiClientRect> rectangles;
    std::uint32_t width = 0, height = 0;
    double pixel_ratio = 1;
    ScreenMetrics screen;
    bool equals(const LayoutSnapshot& other) const {
        return width == other.width && height == other.height && pixel_ratio == other.pixel_ratio &&
               screen == other.screen && rectangles.size() == other.rectangles.size() &&
               std::equal(rectangles.begin(), rectangles.end(), other.rectangles.begin(),
                          [](const auto& left, const auto& right) {
                              return left.left == right.left && left.top == right.top &&
                                     left.width == right.width && left.height == right.height;
                          });
    }
};

/** Only native records cross this mailbox. Source callbacks are removed on
 * their owning thread before a snapshot becomes visible to the window. */
struct WindowServices final : CanvasProvider {
    explicit WindowServices(std::shared_ptr<OffscreenDevice> graphics,
                            std::uint64_t capture_frame_count)
        : graphics(std::move(graphics)), capture_frame_count(capture_frame_count) {}
    std::shared_ptr<AnimationFrameSource> animation_frame_source() const override {
        return animation_frames;
    }
    const void* graphics_identity() const override { return graphics.get(); }
    std::shared_ptr<CanvasEndpoint> create_endpoint(std::uint64_t width,
                                                    std::uint64_t height) override {
        if (width > 16384 || height > 16384)
            throw InvalidCanvasState("Native canvas allocation exceeds 16384 pixels.");
        auto endpoint = std::make_shared<CanvasEndpoint>(
            std::make_shared<OffscreenSurface>(
                static_cast<std::uint32_t>(std::max<std::uint64_t>(1, width)),
                static_cast<std::uint32_t>(std::max<std::uint64_t>(1, height)), animation_frames,
                capture_frame_count),
            graphics);
        std::lock_guard lock(mutex);
        if (stopping)
            throw WorkerTerminated{};
        std::erase_if(endpoints, [](const auto& surface) { return surface.expired(); });
        endpoints.push_back(endpoint->surface);
        return endpoint;
    }
    void post_input(std::unique_ptr<ExternalEvent> event) {
        {
            std::lock_guard lock(mutex);
            ++input_posted;
        }
        inbox->post(std::move(event));
    }
    void stop() {
        {
            std::lock_guard lock(mutex);
            stopping = true;
            for (const auto& endpoint : endpoints)
                if (const auto surface = endpoint.lock())
                    surface->close();
        }
        inbox->terminate();
        wake.notify_all();
    }
    std::shared_ptr<OffscreenDevice> graphics;
    const std::uint64_t capture_frame_count;
    std::shared_ptr<AnimationFrameSource> animation_frames =
        std::make_shared<AnimationFrameSource>();
    std::shared_ptr<EventLoop::Inbox> inbox = std::make_shared<EventLoop::Inbox>();
    std::mutex mutex;
    std::condition_variable wake;
    std::unique_ptr<DocumentSnapshot> pending;
    std::vector<std::unique_ptr<ClipboardWrite>> clipboard_writes;
    std::uint64_t requested = 0, completed = 0;
    /** Document input the display posted, and how much of it the realm has
     * handled. One input event's DOM transaction, including the events its
     * native default posts (click, input, change, toggle), completes before
     * the display handles the next event or presents, as a browser dispatches
     * them within one task. Both are guarded by `mutex`. */
    std::uint64_t input_posted = 0, input_handled = 0;
    std::shared_ptr<const LayoutSnapshot> layout;
    std::atomic<bool> screen_requested = false;
    std::atomic<bool> reload_requested = false;
    std::shared_ptr<WindowLocation> location;
    std::unordered_map<std::uint32_t, std::shared_ptr<CanvasEndpoint>> canvases;
    std::vector<std::weak_ptr<OffscreenSurface>> endpoints;
    bool stopping = false;
};

struct WindowDocument {
    explicit WindowDocument(std::shared_ptr<WindowServices> host, EngineOptions options)
        : host(std::move(host)) {
        engine.options = std::move(options);
        engine.ui_measure_element = [](Engine& owner, UiElementHandle element) {
            if (&owner != &window_document_engine())
                throw std::logic_error("A Window layout read requires its owning realm.");
            return window_element_size(element);
        };
        static_cast<void>(ui_document_root(engine, UiDocumentPart::Html));
    }
    std::shared_ptr<WindowServices> host;
    Engine engine;
    std::uint64_t published_revision = std::numeric_limits<std::uint64_t>::max();
    std::uint64_t published_text_revision = 0;
    std::uint64_t published_input_revision = 0;
    std::shared_ptr<const LayoutSnapshot> layout;
    std::unordered_map<std::uint32_t, std::shared_ptr<CanvasElement>> canvases;
    struct InputTarget {
        explicit InputTarget(const std::shared_ptr<Engine>& engine) : engine(engine) {}
        std::weak_ptr<Engine> engine;
#if BBLITE_HAS_PBR_RENDERER
        CameraPointerState camera;
#endif
    };
    std::unordered_map<std::uint32_t, InputTarget> input_targets;
    std::vector<std::shared_ptr<ResizeObserver>> observers;
    std::vector<std::shared_ptr<MediaQueryList>> media;
    ApplicationErrors* errors = nullptr;
    const bool screen_identity = true;
};
thread_local WindowDocument* document = nullptr;
WindowDocument& current_document() {
    if (!document)
        throw std::logic_error("Window API used outside its application realm.");
    return *document;
}

std::unique_ptr<DocumentSnapshot>
snapshot_document(const Engine& engine, std::optional<std::uint64_t> text_since = std::nullopt) {
    auto snapshot = std::make_unique<DocumentSnapshot>();
    if (text_since) {
        auto& updates = snapshot->text_updates.emplace();
        for (std::uint32_t index = 0; index < engine.ui_elements.size(); ++index) {
            const auto& record = engine.ui_elements[index];
            if (record.text_revision > *text_since)
                updates.push_back({UiElementHandle{index}, record.text});
        }
        return snapshot;
    }
    snapshot->elements.reserve(engine.ui_elements.size());
    snapshot->listeners.reserve(engine.ui_elements.size());
    for (const auto& source : engine.ui_elements) {
        auto& native = snapshot->elements.emplace_back(source);
        native.text_revision = 0;
        native.image_request.reset();
        ListenerNames names;
        names.click = !native.click_callbacks.empty();
        for (const auto& [name, callbacks] : native.event_callbacks)
            if (!callbacks.empty())
                names.events.push_back(name);
        if (native.tag == "details" &&
            std::find(names.events.begin(), names.events.end(), "toggle") == names.events.end())
            names.events.push_back("toggle");
        const auto input_type = native.attributes.find("type");
        if ((native.tag == "input" || native.tag == "textarea" || native.tag == "select") &&
            (input_type == native.attributes.end() || input_type->second != "file") &&
            std::find(names.events.begin(), names.events.end(), "input") == names.events.end())
            names.events.push_back("input");
        native.click_callbacks.clear();
        native.event_callbacks.clear();
#if BBLITE_HAS_BROWSER_FILE
        if (!native.file_change_callbacks.empty() || native.file_input ||
            native.download_url.slot != invalid_handle) {
            throw std::runtime_error("Window realm file actions are not admitted.");
        }
#endif
        native.client_rect_requested = true;
        snapshot->listeners.push_back(std::move(names));
    }
    snapshot->roots = engine.ui_root_children;
    snapshot->document_roots = engine.ui_document_roots;
    snapshot->styles = engine.ui_host_style_rules;
    snapshot->style_revision = engine.ui_style_revision;
    if (engine.dom_input) {
        snapshot->dom_event_types = engine.dom_input->event_types;
        snapshot->dom_pointer_elements = engine.dom_input->pointer_elements;
    }
    return snapshot;
}

/** `post_input` delivers a document input packet to the realm and counts it
 * as input the display waits on (WindowServices::post_input). */
void apply_document(Engine& engine, DocumentSnapshot snapshot,
                    const std::function<void(std::unique_ptr<ExternalEvent>)>& post_input) {
    if (snapshot.text_updates) {
        for (auto& update : *snapshot.text_updates)
            ui_set_text(engine, update.element, std::move(update.text));
        return;
    }
    engine.ui_elements = std::move(snapshot.elements);
    engine.ui_root_children = std::move(snapshot.roots);
    engine.ui_document_roots = snapshot.document_roots;
    engine.ui_host_style_rules = std::move(snapshot.styles);
    engine.ui_style_revision = snapshot.style_revision;
    if (!snapshot.dom_event_types.empty()) {
        auto& input = dom_input(engine);
        input.event_types = std::move(snapshot.dom_event_types);
        input.pointer_elements = std::move(snapshot.dom_pointer_elements);
        input.batch_sink = [post_input](std::shared_ptr<DomEventBatch> batch) {
            auto event = std::make_unique<WindowDomEvent>();
            event->batch = std::move(batch);
            post_input(std::move(event));
        };
        input.pointer_sink = [post_input](const PlatformMouseEvent& payload) {
            auto event = std::make_unique<WindowDomEvent>();
            event->batch = std::make_shared<DomEventBatch>();
            event->batch->add(payload);
            post_input(std::move(event));
        };
    }
    for (std::size_t index = 0; index < snapshot.listeners.size(); ++index) {
        const UiElementHandle element{static_cast<std::uint32_t>(index)};
        auto& target = engine.ui_elements[index];
        if (target.external_gpu_canvas) {
            target.inner_rml =
                "<img src=\"bbl-canvas://" + std::to_string(index) +
                "\" style=\"width:100%;height:100%;display:block;pointer-events:none;\"/>";
        }
        if (snapshot.listeners[index].click)
            target.click_callbacks.push_back([post_input, element] {
                auto event = std::make_unique<WindowEvent>();
                event->element = element;
                event->type = "click";
                post_input(std::move(event));
            });
        for (const auto& name : snapshot.listeners[index].events) {
            target.event_callbacks[name].push_back([post_input, &engine, element,
                                                    name](const PlatformMouseEvent& pointer) {
                auto event = std::make_unique<WindowEvent>();
                event->element = element;
                event->type = name;
                event->mouse = pointer;
                if (name == "toggle")
                    event->open = ui_has_attribute(engine, element, "open");
                if (name == "input" || name == "change") {
                    if (ui_get_attribute(engine, element, "type") == "checkbox")
                        event->checked = ui_get_checked(engine, element);
                    else if (handle_at(engine.ui_elements, element).tag == "select") {
                        event->selected_option = UiElementHandle{};
                        for (const auto option : handle_at(engine.ui_elements, element).children)
                            if (ui_get_selected(engine, option)) {
                                event->selected_option = option;
                                break;
                            }
                    } else
                        event->form_value = ui_get_form_value(engine, element);
                }
                post_input(std::move(event));
            });
        }
    }
    ++engine.ui_revision;
}

void tick_document() {
    update_window_document();
    auto& doc = current_document();
    const auto observers = doc.observers;
    for (const auto& observer : observers)
        observer->deliver();
    // A list only the document still holds, with no listener to deliver
    // to, is one the script has let go of.
    std::erase_if(doc.media, [](const std::shared_ptr<MediaQueryList>& query) {
        return query.use_count() == 1 && !query->retained();
    });
    const auto media = doc.media;
    for (const auto& query : media)
        query->deliver();
    EventLoop::current().set_timeout(tick_document, 16);
}

void dispatch_canvas_input(const WindowPointerEvent& packet) {
    auto& doc = current_document();
    if (packet.pointer.type == SDL_EVENT_WINDOW_FOCUS_LOST) {
        for (auto& [index, target] : doc.input_targets) {
            (void)index;
            if (auto engine = target.engine.lock()) {
                if (const auto batch = prepare_dom_platform_input(*engine, packet.pointer)) {
                    dispatch_dom_batch(*engine, batch);
                    dispatch_touch_defaults(*engine, *batch);
                }
            }
#if BBLITE_HAS_PBR_RENDERER
            target.camera = {};
#endif
        }
        return;
    }
    const auto target = doc.input_targets.find(packet.element.value);
    if (target == doc.input_targets.end())
        return;
    const auto engine = target->second.engine.lock();
    if (!engine)
        return;
    const auto& event = packet.pointer;
    if (is_touch_event(event)) {
        const auto batch = prepare_dom_platform_input(*engine, event);
        dispatch_dom_batch(*engine, batch);
        if (!batch->ready())
            throw std::logic_error("Canvas touch callbacks cannot defer their defaults.");
        dispatch_touch_defaults(*engine, *batch);
        if (batch->default_prevented)
            return;
    } else if (event.type == SDL_EVENT_MOUSE_MOTION) {
        const PlatformMouseEvent mouse{.button = -1,
                                       .buttons = dom_mouse_buttons(event.motion.state),
                                       .client_x = event.motion.x,
                                       .client_y = event.motion.y,
                                       .movement_x = event.motion.xrel,
                                       .movement_y = event.motion.yrel};
        dispatch_platform_mouse_move(*engine, mouse);
    } else if (event.type == SDL_EVENT_MOUSE_BUTTON_DOWN ||
               event.type == SDL_EVENT_MOUSE_BUTTON_UP) {
        const PlatformMouseEvent mouse{.button = static_cast<double>(event.button.button - 1),
                                       .buttons = dom_mouse_buttons(packet.buttons),
                                       .client_x = event.button.x,
                                       .client_y = event.button.y};
        dispatch_platform_mouse_button(*engine, mouse, event.type == SDL_EVENT_MOUSE_BUTTON_DOWN);
    } else if (event.type == SDL_EVENT_MOUSE_WHEEL) {
        dispatch_platform_wheel_event(*engine, dom_wheel_delta_y(event.wheel), event.wheel.mouse_x,
                                      event.wheel.mouse_y);
    }
#if BBLITE_HAS_PBR_RENDERER
    if (engine->registered_scenes.empty() || !engine->registered_scenes.front())
        return;
    const auto camera = engine->registered_scenes.front()->camera;
    if (camera.value < engine->cameras.size())
        handle_camera_pointer_event(event, handle_at(engine->cameras, camera),
                                    target->second.camera, engine->canvas_client_width,
                                    engine->canvas_client_height);
#endif
}
} // namespace

void bind_canvas_engine(const std::shared_ptr<CanvasElement>& canvas,
                        const std::shared_ptr<Engine>& engine) {
    auto& doc = current_document();
    const auto entry = std::find_if(doc.canvases.begin(), doc.canvases.end(),
                                    [&](const auto& value) { return value.second == canvas; });
    if (entry == doc.canvases.end())
        throw InvalidCanvasState("Engine canvas is not attached to this Window.");
    doc.input_targets.insert_or_assign(entry->first, WindowDocument::InputTarget(engine));
    const auto box = window_element_size({entry->first});
    const auto width = static_cast<std::uint32_t>(
        std::max(1.0, std::round(box.width * window_device_pixel_ratio())));
    const auto height = static_cast<std::uint32_t>(
        std::max(1.0, std::round(box.height * window_device_pixel_ratio())));
    canvas->resize_layout(width, height);
    engine->options.width = width;
    engine->options.height = height;
    engine->canvas_client_width = box.width;
    engine->canvas_client_height = box.height;
}

Engine& window_document_engine() { return current_document().engine; }
const void* window_document_identity() { return std::addressof(current_document()); }
void window_location_reload() {
    current_document().host->reload_requested = true;
    EventLoop::current().close();
}
std::string window_location_search(const std::string& initial) {
    auto& location = *current_document().host->location;
    if (!location.current_search) {
        const auto measured_query = environment_variable("BBLITE_LOCATION_SEARCH");
        return location.search(measured_query.empty() ? initial : measured_query);
    }
    return location.search(initial);
}
void window_location_set_search(const std::string& value) {
    current_document().host->location->navigate(value);
    window_location_reload();
}
js::Promise<js::PromiseVoid> window_clipboard_write(std::string text) {
    auto& doc = current_document();
    auto& loop = EventLoop::current();
    js::Promise<js::PromiseVoid> result;
    const auto id = loop.register_completion([result](std::unique_ptr<ExternalEvent> event) {
        const auto* completion = dynamic_cast<const ClipboardWrite*>(event.get());
        if (!completion)
            throw std::logic_error("Incorrect clipboard completion payload.");
        if (completion->error.empty())
            result.resolve(js::PromiseVoid{});
        else
            result.reject(std::make_exception_ptr(std::runtime_error(completion->error)));
    });
    try {
        auto request = std::make_unique<ClipboardWrite>(id, std::move(text));
        std::lock_guard lock(doc.host->mutex);
        if (doc.host->stopping)
            throw WorkerTerminated{};
        doc.host->clipboard_writes.push_back(std::move(request));
    } catch (...) {
        loop.cancel_completion(id);
        result.reject(std::current_exception());
    }
    return result;
}
void window_on_application_error(bool rejection, std::uint64_t identity,
                                 ApplicationErrors::Callback callback, bool once) {
    current_document().errors->add(rejection, identity, std::move(callback), once);
}
void window_off_application_error(bool rejection, std::uint64_t identity) {
    current_document().errors->remove(rejection, identity);
}
void update_window_document() {
    auto& doc = current_document();
    auto& host = *doc.host;
    // Snapshot source state on its owner before taking the presentation lock.
    const auto input_revision = doc.engine.dom_input ? doc.engine.dom_input->revision : 0;
    const auto text_since = doc.published_input_revision == input_revision &&
                                    doc.engine.ui_only_text_changed_since(
                                        doc.published_revision, doc.published_text_revision)
                                ? std::optional(doc.published_text_revision)
                                : std::nullopt;
    auto snapshot = doc.published_revision != doc.engine.ui_revision ||
                            doc.published_input_revision != input_revision
                        ? snapshot_document(doc.engine, text_since)
                        : nullptr;
    std::unique_lock lock(host.mutex);
    if (host.stopping)
        throw WorkerTerminated{};
    if (snapshot) {
        host.pending = std::move(snapshot);
        const auto revision = ++host.requested;
        doc.published_revision = doc.engine.ui_revision;
        doc.published_text_revision = doc.engine.ui_text_revision;
        doc.published_input_revision = input_revision;
        host.wake.notify_all();
        host.wake.wait(lock, [&] { return host.stopping || host.completed >= revision; });
        if (host.stopping)
            throw WorkerTerminated{};
    }
    const auto layout = host.layout;
    lock.unlock();
    if (doc.layout != layout && layout) {
        doc.layout = layout;
        for (std::size_t index = 0;
             index < layout->rectangles.size() && index < doc.engine.ui_elements.size(); ++index) {
            doc.engine.ui_elements[index].client_rect = layout->rectangles[index];
        }
        for (const auto& [index, canvas] : doc.canvases) {
            if (index >= layout->rectangles.size())
                continue;
            const auto& box = layout->rectangles[index];
            if (box.width > 0 && box.height > 0)
                canvas->resize_layout(static_cast<std::uint32_t>(std::round(box.width)),
                                      static_cast<std::uint32_t>(std::round(box.height)));
            const auto target = doc.input_targets.find(index);
            if (target != doc.input_targets.end())
                if (const auto engine = target->second.engine.lock()) {
                    engine->canvas_client_width = box.width / layout->pixel_ratio;
                    engine->canvas_client_height = box.height / layout->pixel_ratio;
                }
        }
    }
}
double window_device_pixel_ratio() {
    update_window_document();
    const auto& doc = current_document();
    return doc.layout ? doc.layout->pixel_ratio : 1;
}
UiClientRect window_viewport_size() {
    update_window_document();
    const auto& layout = current_document().layout;
    if (!layout)
        throw std::logic_error("Window viewport has no layout snapshot.");
    return {0, 0, std::round(layout->width / layout->pixel_ratio),
            std::round(layout->height / layout->pixel_ratio)};
}
ScreenMetrics window_screen_metrics() {
    auto& doc = current_document();
    if (!doc.host->screen_requested.exchange(true))
        ++doc.engine.ui_revision;
    update_window_document();
    if (!doc.layout)
        throw std::logic_error("Window screen has no layout snapshot.");
    return doc.layout->screen;
}
const void* window_screen_identity() { return std::addressof(current_document().screen_identity); }
UiClientRect window_element_size(UiElementHandle element) {
    update_window_document();
    const auto& layout = current_document().layout;
    if (!layout || element.value >= layout->rectangles.size())
        throw std::out_of_range("Window element has no layout box.");
    auto box = handle_at(layout->rectangles, element);
    box.left /= layout->pixel_ratio;
    box.top /= layout->pixel_ratio;
    box.width /= layout->pixel_ratio;
    box.height /= layout->pixel_ratio;
    return box;
}
std::shared_ptr<CanvasElement> window_canvas(UiElementHandle element) {
    auto& doc = current_document();
    if (element.value >= doc.engine.ui_elements.size() ||
        handle_at(doc.engine.ui_elements, element).tag != "canvas") {
        throw InvalidCanvasState("Window element is not a canvas.");
    }
    const auto found = doc.canvases.find(element.value);
    if (found != doc.canvases.end())
        return found->second;
    // A DOM canvas starts with its backing-store default, independent of CSS
    // layout. Engine creation sizes its own context; transfer preserves this
    // value until the receiving source explicitly changes it.
    auto endpoint = doc.host->create_endpoint(300, 150);
    auto canvas = js::make_gc_shared<CanvasElement>(endpoint);
    doc.canvases.emplace(element.value, canvas);
    handle_at(doc.engine.ui_elements, element).external_gpu_canvas = true;
    ++doc.engine.ui_revision;
    {
        std::lock_guard lock(doc.host->mutex);
        doc.host->canvases.emplace(element.value, std::move(endpoint));
    }
    return canvas;
}

void ResizeObserver::observe(UiElementHandle element) {
    if (observed_.empty()) {
        auto owner = self_.lock();
        if (!owner)
            throw std::logic_error("ResizeObserver must be created by its Window realm.");
        current_document().observers.push_back(std::move(owner));
    }
    observed_.try_emplace(element.value, UiClientRect{-1, -1, -1, -1});
}
void ResizeObserver::unobserve(UiElementHandle element) {
    observed_.erase(element.value);
    if (observed_.empty())
        disconnect();
}
void ResizeObserver::disconnect() {
    observed_.clear();
    std::erase_if(current_document().observers,
                  [this](const auto& observer) { return observer.get() == this; });
}
void ResizeObserver::deliver() {
    bool changed = false;
    for (auto& [index, prior] : observed_) {
        const auto next = window_element_size({index});
        changed |= prior.width != next.width || prior.height != next.height;
        prior = next;
    }
    if (changed)
        EventLoop::current().dispatch_callback(callback_);
}
std::shared_ptr<ResizeObserver> create_resize_observer(ResizeObserver::Callback callback) {
    auto observer = js::make_gc_shared<ResizeObserver>(std::move(callback));
    observer->self_ = observer;
    return observer;
}
std::shared_ptr<MediaQueryList> create_media_query(std::string query) {
    auto media = js::make_gc_shared<MediaQueryList>(std::move(query), window_device_pixel_ratio,
                                                    system_reduced_motion);
    current_document().media.push_back(media);
    return media;
}

int run_window_application(WorkerEntry initialize, EngineOptions options) {
    try {
        const auto frame_options = read_frame_options();
        const auto capture_frame_text = environment_variable("BBLITE_CAPTURE_ENGINE_FRAME");
        std::uint64_t capture_frame_count = 0;
        if (!capture_frame_text.empty()) {
            std::size_t consumed = 0;
            const auto frame = std::stoll(capture_frame_text, &consumed);
            if (consumed != capture_frame_text.size() || frame < 0 || frame > 1000000 ||
                frame_options.screenshot_path.empty()) {
                throw std::invalid_argument(
                    "BBLITE_CAPTURE_ENGINE_FRAME requires a screenshot and a frame in [0, 1000000].");
            }
            capture_frame_count = static_cast<std::uint64_t>(frame) + 1;
        }
        const auto screenshot_checkpoints =
            window_screenshot_checkpoints(environment_variable("BBLITE_SCREENSHOT_FRAMES"),
                                          frame_options, capture_frame_count != 0);
        for (const auto& checkpoint : screenshot_checkpoints) {
            std::filesystem::remove(detail::utf8_file_path(checkpoint.path));
            std::filesystem::remove(detail::utf8_file_path(checkpoint.path + ".build-stamp"));
        }
        if (!SDL_Init(SDL_INIT_VIDEO | SDL_INIT_EVENTS))
            throw std::runtime_error(SDL_GetError());
        struct Quit {
            ~Quit() { SDL_Quit(); }
        } quit;
        configure_run_surface(options);
        using Window = std::unique_ptr<SDL_Window, decltype(&SDL_DestroyWindow)>;
        Window window(
            SDL_CreateWindow(
                options.title.c_str(), options.width, options.height,
                run_window_flags(SDL_WINDOW_RESIZABLE | SDL_WINDOW_HIGH_PIXEL_DENSITY |
                                     (frame_options.test_pass ? SDL_WINDOW_NOT_FOCUSABLE : 0),
                                 options)),
            &SDL_DestroyWindow);
        if (!window)
            throw std::runtime_error(SDL_GetError());
        const GpuBackend& backend = selected_gpu_backend();
        const std::shared_ptr<WindowPresenter> presenter =
            backend.create_window_presenter ? backend.create_window_presenter(window.get())
                                            : nullptr;
        if (!presenter)
            throw std::runtime_error("Requested Window GPU backend is unavailable.");
        const bool cpu_profile = environment_variable("BBLITE_CPU_PROFILE") == "1";
        // A frame budget or capture bounds the run: a clock that stops ticking fails it.
        WindowFrameClock compositor_clock(cpu_profile, capture_frame_count != 0 ||
                                                           frame_options.frame_budget() > 0);
        presenter->set_display_paced(compositor_clock.available());
        // Reload replaces realm-owned state while keeping the native window and device.
        const auto location = std::make_shared<WindowLocation>();
        for (;;) {
            auto services = std::make_shared<WindowServices>(
                std::shared_ptr<OffscreenDevice>(presenter, &presenter->device()),
                capture_frame_count);
            services->location = location;
            Engine display;
            display.options = options;
            dom_input(display).canvas_background = false;
            std::unique_ptr<UiRmlRuntime, decltype(&destroy_ui_rml_runtime)> ui(
                create_ui_rml_runtime(display, window.get(), options.width, options.height),
                &destroy_ui_rml_runtime);
            std::atomic<bool> finished = false;
            std::exception_ptr application_error;
            std::thread application([&] {
                try {
                    const js::RealmScope state;
                    EventLoop loop(services->inbox);
                    WindowDocument owner(services, options);
                    document = &owner;
                    struct Reset {
                        ~Reset() { document = nullptr; }
                    } reset;
                    WorkerRealm realm(loop, {}, services);
                    ApplicationErrors errors(loop);
                    owner.errors = &errors;
                    realm.on_platform_event([services](std::unique_ptr<ExternalEvent> packet) {
                        if (const auto* pointer = dynamic_cast<WindowPointerEvent*>(packet.get())) {
                            EventLoop::current().dispatch_callback(
                                [&] { dispatch_canvas_input(*pointer); });
                            return;
                        }
                        // Every other packet is document input the display posted
                        // and waits on: acknowledge it however its dispatch ends.
                        const auto handled = js::finally([&] {
                            {
                                const std::lock_guard lock(services->mutex);
                                ++services->input_handled;
                            }
                            services->wake.notify_all();
                        });
                        if (const auto* event = dynamic_cast<WindowDomEvent*>(packet.get())) {
                            event->batch->dispatch(window_document_engine(),
                                                   [](auto& callback, const auto& payload) {
                                                       EventLoop::current().dispatch_callback(
                                                           [&] { callback(payload); });
                                                   });
                            return;
                        }
                        const auto* event = dynamic_cast<WindowEvent*>(packet.get());
                        if (!event)
                            throw std::logic_error("Unknown Window event.");
                        auto& engine = window_document_engine();
                        if (event->element.value >= engine.ui_elements.size())
                            return;
                        if (event->checked)
                            ui_set_checked(engine, event->element, *event->checked);
                        if (event->open)
                            ui_set_boolean_attribute(engine, event->element, "open", *event->open);
                        if (event->selected_option)
                            ui_set_selection(engine, event->element, *event->selected_option);
                        if (event->form_value)
                            ui_set_form_value(engine, event->element, *event->form_value);
                        const auto& record = handle_at(engine.ui_elements, event->element);
                        if (event->type == "click") {
                            const auto callbacks = record.click_callbacks;
                            for (const auto& callback : callbacks)
                                EventLoop::current().dispatch_callback(callback);
                        } else if (const auto found = record.event_callbacks.find(event->type);
                                   found != record.event_callbacks.end()) {
                            const auto callbacks = found->second;
                            for (const auto& callback : callbacks)
                                EventLoop::current().dispatch_callback(
                                    [&] { callback(event->mouse); });
                        }
                    });
                    loop.run(
                        [&] {
                            initialize(realm);
                            // The initial document includes startup's microtasks,
                            // before presentation begins consuming Window input.
                            loop.after_microtasks(tick_document);
                        },
                        [&] {
                            auto& engine = window_document_engine();
                            if (engine.dom_input) {
                                const auto event = window_pagehide_event();
                                engine.dom_input->pointer.dispatch(
                                    event,
                                    [&](auto& callback, const auto& payload) {
                                        loop.dispatch_callback([&] { callback(payload); });
                                    },
                                    &engine);
                            }
                        });
                } catch (const WorkerTerminated&) {
                } catch (...) {
                    application_error = std::current_exception();
                }
                {
                    const std::lock_guard lock(services->mutex);
                    finished = true;
                }
                services->wake.notify_all();
            });
            // Shutdown uses the realm inbox rather than a C++ stop token. Keep
            // the join exception-safe without requiring libc++'s newer jthread.
            struct Stop {
                std::shared_ptr<WindowServices> services;
                std::thread& application;
                ~Stop() {
                    services->stop();
                    if (application.joinable())
                        application.join();
                }
            } stop{services, application};
            std::unordered_map<std::uint32_t, OffscreenFrame> latest;
            PlatformInputReplay input_replay;
            LayoutSnapshot next_layout;
            std::shared_ptr<const LayoutSnapshot> layout;
            const auto canvas_at = [&](double x, double y) -> UiElementHandle {
                for (std::size_t index = 0;
                     index < display.ui_elements.size() && index < layout->rectangles.size();
                     ++index) {
                    const auto& box = layout->rectangles[index];
                    if (display.ui_elements[index].external_gpu_canvas && x >= box.left &&
                        y >= box.top && x < box.left + box.width && y < box.top + box.height)
                        return {static_cast<std::uint32_t>(index)};
                }
                return {};
            };
            UiElementHandle pointer_capture{};
            std::map<std::pair<std::uint64_t, std::uint64_t>, UiElementHandle> touch_captures;
            SDL_MouseButtonFlags pointer_buttons = 0;
            int width = 0, height = 0;
            const auto update_layout = [&] {
                if (!SDL_GetWindowSizeInPixels(window.get(), &width, &height))
                    throw std::runtime_error(SDL_GetError());
                if (width <= 0 || height <= 0)
                    return false;
                std::unique_ptr<DocumentSnapshot> snapshot;
                std::uint64_t revision = 0;
                {
                    std::lock_guard lock(services->mutex);
                    snapshot = std::move(services->pending);
                    revision = services->requested;
                }
                if (snapshot)
                    apply_document(display, std::move(*snapshot),
                                   [services](std::unique_ptr<ExternalEvent> event) {
                                       services->post_input(std::move(event));
                                   });
                update_ui_rml_runtime(*ui, width, height);
                next_layout.width = width;
                next_layout.height = height;
                const auto density = SDL_GetWindowDisplayScale(window.get());
                next_layout.pixel_ratio = density > 0 ? density : 1;
                const auto pixel_density = SDL_GetWindowPixelDensity(window.get());
                update_engine_canvas_metrics(display, width, height, next_layout.pixel_ratio,
                                             pixel_density > 0 ? pixel_density : 1);
                if (services->screen_requested.load()) {
                    const auto display_id = SDL_GetDisplayForWindow(window.get());
                    SDL_Rect bounds{}, available{};
                    const auto* mode = SDL_GetCurrentDisplayMode(display_id);
                    int bits = 0;
                    Uint32 red = 0, green = 0, blue = 0, alpha = 0;
                    if (!SDL_GetDisplayBounds(display_id, &bounds) ||
                        !SDL_GetDisplayUsableBounds(display_id, &available) || !mode ||
                        !SDL_GetMasksForPixelFormat(mode->format, &bits, &red, &green, &blue,
                                                    &alpha))
                        throw std::runtime_error(std::string("Unable to query display metrics: ") +
                                                 SDL_GetError());
                    const auto scale = next_layout.pixel_ratio;
                    next_layout.screen = {
                        std::round(bounds.w / scale), std::round(bounds.h / scale),
                        std::round(available.w / scale), std::round(available.h / scale),
                        static_cast<double>(std::popcount(red) + std::popcount(green) +
                                            std::popcount(blue))};
                }
                next_layout.rectangles.resize(display.ui_elements.size());
                for (std::size_t index = 0; index < display.ui_elements.size(); ++index)
                    next_layout.rectangles[index] = display.ui_elements[index].client_rect;
                if (!layout || !layout->equals(next_layout))
                    layout = std::make_shared<LayoutSnapshot>(next_layout);
                {
                    const std::lock_guard lock(services->mutex);
                    services->layout = layout;
                    services->completed = revision;
                }
                services->wake.notify_all();
                return true;
            };
            // Waits until the realm has handled every document input packet
            // posted so far. Source callbacks can synchronously request layout:
            // serve those requests while waiting, without spending a
            // presentation or repaint tick on the acknowledgement.
            const auto await_input = [&] {
                for (;;) {
                    std::unique_lock lock(services->mutex);
                    services->wake.wait(lock, [&] {
                        return services->input_handled == services->input_posted || finished ||
                               services->pending;
                    });
                    if (services->input_handled == services->input_posted || finished)
                        return;
                    lock.unlock();
                    if (!update_layout())
                        SDL_Delay(1);
                }
            };
            long presented = 0;
            const bool trace_window =
                runtime_trace_enabled() || environment_variable("BBLITE_WINDOW_TRACE") == "1";
            std::optional<EventLoop::Clock::time_point> next_repaint;
            std::optional<AnimationFrameSource::Batch> repaint_batch;
            bool running = true;
            while (running && !finished) {
                const double started = cpu_profile ? monotonic_milliseconds() : 0;
                std::vector<std::unique_ptr<ClipboardWrite>> clipboard_writes;
                {
                    std::lock_guard lock(services->mutex);
                    clipboard_writes.swap(services->clipboard_writes);
                }
                for (auto& request : clipboard_writes) {
                    {
                        const auto text = std::move(request->text);
                        if (!SDL_SetClipboardText(text.c_str()))
                            request->error = SDL_GetError();
                    }
                    services->inbox->post(std::move(request));
                }
                SDL_Event event;
                for (;;) {
                    if (!SDL_PollEvent(&event))
                        break;
                    if (is_emulated_pointer_event(event))
                        continue;
                    if (event.type == SDL_EVENT_QUIT ||
                        event.type == SDL_EVENT_WINDOW_CLOSE_REQUESTED)
                        running = false;
                    if (frame_options.test_pass && is_platform_input_event(event) &&
                        !is_replayed_ui_event(event))
                        continue;
                    if (auto batch = prepare_dom_platform_input(display, event)) {
                        // The script's listeners decide the native default.
                        dispatch_dom_batch(display, batch);
                        await_input();
                        if (finished)
                            break;
                        if (batch->default_prevented)
                            continue;
                    }
                    const bool reaches_canvas = handle_ui_rml_event(*ui, event);
                    // The events the native default posted (a button's click, a
                    // control's input and change) finish before the next event.
                    await_input();
                    if (finished)
                        break;
                    if (event.type == SDL_EVENT_WINDOW_FOCUS_LOST) {
                        pointer_capture = {};
                        pointer_buttons = 0;
                        touch_captures.clear();
                        auto packet = std::make_unique<WindowPointerEvent>();
                        packet->pointer = event;
                        services->inbox->post(std::move(packet));
                    }
                    if (is_touch_event(event)) {
                        if (!layout)
                            continue;
                        const auto key = std::pair{event.tfinger.touchID, event.tfinger.fingerID};
                        auto found = touch_captures.find(key);
                        if (event.type == SDL_EVENT_FINGER_DOWN && reaches_canvas) {
                            const auto target = canvas_at(event.tfinger.x * layout->width,
                                                          event.tfinger.y * layout->height);
                            if (target.value != invalid_handle)
                                found = touch_captures.insert_or_assign(key, target).first;
                        }
                        if (found == touch_captures.end())
                            continue;
                        const auto target = found->second;
                        if (event.type == SDL_EVENT_FINGER_UP ||
                            event.type == SDL_EVENT_FINGER_CANCELED)
                            touch_captures.erase(found);
                        if (target.value >= layout->rectangles.size())
                            continue;
                        const auto& box = layout->rectangles[target.value];
                        if (box.width <= 0 || box.height <= 0)
                            continue;
                        auto packet = std::make_unique<WindowPointerEvent>();
                        packet->element = target;
                        packet->pointer = event;
                        auto& touch = packet->pointer.tfinger;
                        touch.x =
                            static_cast<float>((touch.x * layout->width - box.left) / box.width);
                        touch.y =
                            static_cast<float>((touch.y * layout->height - box.top) / box.height);
                        touch.dx *= static_cast<float>(layout->width / box.width);
                        touch.dy *= static_cast<float>(layout->height / box.height);
                        services->inbox->post(std::move(packet));
                        continue;
                    }
                    const bool move = event.type == SDL_EVENT_MOUSE_MOTION;
                    const bool down = event.type == SDL_EVENT_MOUSE_BUTTON_DOWN;
                    const bool up = event.type == SDL_EVENT_MOUSE_BUTTON_UP;
                    const bool wheel = event.type == SDL_EVENT_MOUSE_WHEEL;
                    if (!(move || down || up || wheel) ||
                        (!reaches_canvas && pointer_capture.value == invalid_handle))
                        continue;
                    if (!layout)
                        continue;
                    const double x = move    ? event.motion.x
                                     : wheel ? event.wheel.mouse_x
                                             : event.button.x;
                    const double y = move    ? event.motion.y
                                     : wheel ? event.wheel.mouse_y
                                             : event.button.y;
                    auto target = pointer_capture;
                    if (target.value == invalid_handle)
                        target = canvas_at(x * layout->pixel_ratio, y * layout->pixel_ratio);
                    if (target.value == invalid_handle || target.value >= layout->rectangles.size())
                        continue;
                    if (down) {
                        pointer_capture = target;
                        pointer_buttons |= SDL_BUTTON_MASK(event.button.button);
                    }
                    if (up) {
                        pointer_buttons &= ~SDL_BUTTON_MASK(event.button.button);
                        if (!pointer_buttons)
                            pointer_capture = {};
                    }
                    const auto& box = handle_at(layout->rectangles, target);
                    auto packet = std::make_unique<WindowPointerEvent>();
                    packet->element = target;
                    packet->pointer = event;
                    packet->buttons = pointer_buttons;
                    const auto left = static_cast<float>(box.left / layout->pixel_ratio),
                               top = static_cast<float>(box.top / layout->pixel_ratio);
                    if (move) {
                        packet->pointer.motion.x -= left;
                        packet->pointer.motion.y -= top;
                    } else if (wheel) {
                        packet->pointer.wheel.mouse_x -= left;
                        packet->pointer.wheel.mouse_y -= top;
                    } else {
                        packet->pointer.button.x -= left;
                        packet->pointer.button.y -= top;
                    }
                    services->inbox->post(std::move(packet));
                }
                if (finished)
                    break;
                const double input_finished = cpu_profile ? monotonic_milliseconds() : 0;
                if (!update_layout()) {
                    SDL_Delay(1);
                    continue;
                }
                const double layout_finished = cpu_profile ? monotonic_milliseconds() : 0;
                // Release completed image leases before waking their producers.
                const bool presenter_ready = presenter->can_present();
                if (compositor_clock.available()) {
                    if (const auto timestamp = compositor_clock.take_latest())
                        next_repaint = timestamp;
                    if (!repaint_batch && next_repaint) {
                        repaint_batch = services->animation_frames->tick(*next_repaint);
                        next_repaint.reset();
                    }
                    // RAF callbacks can synchronously request layout. Keep pumping
                    // the host until their submissions finish, or the next display
                    // heartbeat bounds the wait for a slow realm.
                    if (!repaint_batch || (!repaint_batch->ready() && !next_repaint)) {
                        compositor_clock.wait_for(std::chrono::milliseconds(1));
                        continue;
                    }
                }
                std::vector<WindowCanvasFrame> frames;
                bool canvases_ready = false;
                {
                    std::lock_guard lock(services->mutex);
                    for (const auto& [index, canvas] : services->canvases) {
                        if (auto frame = canvas->surface->take_frame())
                            latest.insert_or_assign(index, std::move(*frame));
                        if (const auto found = latest.find(index);
                            found != latest.end() && index < layout->rectangles.size()) {
                            frames.push_back({UiElementHandle{index}, found->second});
                        }
                    }
                    canvases_ready =
                        services->completed > 0 && frames.size() == services->canvases.size();
                }
                services->wake.notify_all();
                const bool capture_ready =
                    capture_frame_count && !frames.empty()
                        ? std::all_of(frames.begin(), frames.end(),
                                      [&](const auto& canvas) {
                                          return canvas.frame.sequence == capture_frame_count;
                                      })
                        : presented == std::max(0L, frame_options.screenshot_frame);
                const auto checkpoint = std::find_if(
                    screenshot_checkpoints.begin(), screenshot_checkpoints.end(),
                    [presented](const auto& value) { return value.frame == presented; });
                const bool checkpoint_ready = checkpoint != screenshot_checkpoints.end();
                const bool capture = canvases_ready && !frame_options.screenshot_path.empty() &&
                                     (capture_ready || checkpoint_ready);
                bool did_present = false;
                double record_ms = 0, present_ms = 0;
                if (presenter_ready) {
                    const double record_started = cpu_profile ? monotonic_milliseconds() : 0;
                    const auto& recorded = record_ui_rml_frame(*ui, width, height);
                    if (cpu_profile)
                        record_ms = monotonic_milliseconds() - record_started;
                    std::optional<UiRenderFrame> canvas_capture;
                    if (capture && !frame_options.capture_ui) {
                        canvas_capture = recorded;
                        std::erase_if(canvas_capture->draws, [&](const auto& draw) {
                            return std::none_of(recorded.textures.begin(), recorded.textures.end(),
                                                [&](const auto& texture) {
                                                    return texture.id == draw.texture_id &&
                                                           texture.external_canvas !=
                                                               invalid_handle;
                                                });
                        });
                        canvas_capture->backdrops.clear();
                        canvas_capture->composites.clear();
                        canvas_capture->operations.clear();
                        canvas_capture->layer_count = 0;
                        for (auto& draw : canvas_capture->draws)
                            draw.layer = 0;
                    }
                    std::string screenshot_path;
                    if (capture)
                        screenshot_path =
                            checkpoint_ready ? checkpoint->path : frame_options.screenshot_path;
                    const double present_started = cpu_profile ? monotonic_milliseconds() : 0;
                    did_present = presenter->present(
                        frames, canvas_capture ? *canvas_capture : recorded, screenshot_path);
                    if (cpu_profile)
                        present_ms = monotonic_milliseconds() - present_started;
                    if (did_present && capture && checkpoint_ready) {
                        const std::string_view stamp = bblite_build_stamp();
                        detail::write_file_atomically(
                            detail::utf8_file_path(checkpoint->path + ".build-stamp"), stamp,
                            stamp.size(), "Screenshot checkpoint build stamp");
                    }
                }
                if (did_present) {
                    if (compositor_clock.available()) {
                        repaint_batch.reset();
                    } else {
                        services->animation_frames->tick(EventLoop::Clock::now());
                    }
                }
                if (did_present && canvases_ready) {
                    if (cpu_profile &&
                        (presented % 30 == 0 || monotonic_milliseconds() - started >= 4))
                        std::fprintf(stderr,
                                     "[cpu][window] frame=%ld input_ms=%.3f layout_ms=%.3f "
                                     "ui_record_ms=%.3f present_ms=%.3f total_ms=%.3f\n",
                                     presented, input_finished - started,
                                     layout_finished - input_finished, record_ms, present_ms,
                                     monotonic_milliseconds() - started);
                    input_replay.dispatch(presented, window.get(), display);
                    if (trace_window && presented % runtime_trace_interval() == 0) {
                        std::ostringstream trace;
                        trace << std::setprecision(15)
                              << "[bblite trace] window frame=" << presented << " now-ms="
                              << std::chrono::duration<double, std::milli>(
                                     EventLoop::Clock::now().time_since_epoch())
                                     .count();
                        for (const auto& canvas : frames)
                            trace << " canvas=" << canvas.element.value << ':'
                                  << canvas.frame.sequence << '@' << canvas.frame.width << 'x'
                                  << canvas.frame.height;
                        trace << '\n';
                        std::cerr << trace.str();
                    }
                    ++presented;
                    if (capture_frame_count ? capture
                                            : frame_options.frame_budget() > 0 &&
                                                  presented >= frame_options.frame_budget())
                        running = false;
                }
                if (compositor_clock.available()) {
                    if (!did_present || !next_repaint)
                        compositor_clock.wait_for(std::chrono::milliseconds(1));
                } else {
                    SDL_Delay(1);
                }
            }
            services->stop();
            application.join();
            if (application_error)
                std::rethrow_exception(application_error);
            if (!services->reload_requested)
                return 0;
            location->commit_reload();
        }
    } catch (...) {
        return report_uncaught_error(std::current_exception());
    }
}
} // namespace bbl::pal
