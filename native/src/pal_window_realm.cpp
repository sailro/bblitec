#include <bblite/pal_window_realm.hpp>
#include <bblite/pal.hpp>
#include <bblite/pal_animation_frame.hpp>
#include "pal_window_presenter.hpp"
#include "pal_gpu_shared.hpp"
#include "pal_platform_events.hpp"
#include "pal_system_preferences.hpp"
#if BBLITE_HAS_PBR_RENDERER
#include "pal_camera_controls.hpp"
#endif

#include <atomic>
#include <bit>
#include <condition_variable>
#include <iostream>
#include <sstream>
#include <iomanip>
#include <thread>

namespace bbl::pal {
namespace {
struct WindowEvent final : ExternalEvent {
    UiElementHandle element;
    std::string type;
    PlatformMouseEvent mouse;
};
struct WindowDomEvent final : ExternalEvent {
    std::shared_ptr<DomEventBatch> batch;
};
/** Only mouse event structs are copied; SDL events containing pointers are
 * never admitted to the realm mailbox. */
struct WindowPointerEvent final : ExternalEvent {
    UiElementHandle element;
    SDL_Event pointer{};
    SDL_MouseButtonFlags buttons = 0;
};
struct ListenerNames { bool click = false; std::vector<std::string> events; };
struct ClipboardWrite final : CompletionEvent {
    std::string text;
    std::string error;
    ClipboardWrite(std::uint64_t id, std::string value) : CompletionEvent(id), text(std::move(value)) {}
};
struct DocumentSnapshot {
    Engine::DocumentRoots document_roots;
    std::vector<UiElementRecord> elements;
    std::vector<ListenerNames> listeners;
    std::vector<UiElementHandle> roots;
    std::vector<UiStyleRule> styles;
    std::uint64_t style_revision = 0;
    std::set<std::string> dom_event_types;
};
struct LayoutSnapshot {
    std::vector<UiClientRect> rectangles;
    std::uint32_t width = 0, height = 0;
    double pixel_ratio = 1;
    ScreenMetrics screen;
    bool equals(const LayoutSnapshot& other) const {
        return width == other.width && height == other.height && pixel_ratio == other.pixel_ratio && screen == other.screen &&
            rectangles.size() == other.rectangles.size() && std::equal(rectangles.begin(), rectangles.end(), other.rectangles.begin(),
                [](const auto& left, const auto& right) { return left.left == right.left && left.top == right.top && left.width == right.width && left.height == right.height; });
    }
};

/** Only native records cross this mailbox. Source callbacks are removed on
 * their owning thread before a snapshot becomes visible to the window. */
struct WindowServices final : CanvasProvider {
    explicit WindowServices(std::shared_ptr<OffscreenDevice> graphics, std::uint64_t capture_frame_count)
        : graphics(std::move(graphics)), capture_frame_count(capture_frame_count) {}
    std::shared_ptr<AnimationFrameSource> animation_frame_source() const override { return animation_frames; }
    std::shared_ptr<CanvasEndpoint> create_endpoint(std::uint64_t width, std::uint64_t height) override {
        if (width > 16384 || height > 16384) throw InvalidCanvasState("Native canvas allocation exceeds 16384 pixels.");
        auto endpoint = std::make_shared<CanvasEndpoint>(std::make_shared<OffscreenSurface>(
            static_cast<std::uint32_t>(std::max<std::uint64_t>(1, width)),
            static_cast<std::uint32_t>(std::max<std::uint64_t>(1, height)), animation_frames, capture_frame_count), graphics);
        std::lock_guard lock(mutex);
        if (stopping) throw WorkerTerminated{};
        std::erase_if(endpoints, [](const auto& surface) { return surface.expired(); });
        endpoints.push_back(endpoint->surface);
        return endpoint;
    }
    void stop() {
        {
            std::lock_guard lock(mutex);
            stopping = true;
            for (const auto& endpoint : endpoints) if (const auto surface = endpoint.lock()) surface->close();
        }
        inbox->terminate();
        wake.notify_all();
    }
    std::shared_ptr<OffscreenDevice> graphics;
    const std::uint64_t capture_frame_count;
    std::shared_ptr<AnimationFrameSource> animation_frames = std::make_shared<AnimationFrameSource>();
    std::shared_ptr<EventLoop::Inbox> inbox = std::make_shared<EventLoop::Inbox>();
    std::mutex mutex;
    std::condition_variable wake;
    std::unique_ptr<DocumentSnapshot> pending;
    std::vector<std::unique_ptr<ClipboardWrite>> clipboard_writes;
    std::uint64_t requested = 0, completed = 0;
    std::shared_ptr<const LayoutSnapshot> layout;
    std::atomic<bool> screen_requested = false;
    std::atomic<bool> reload_requested = false;
    std::unordered_map<std::uint32_t, std::shared_ptr<CanvasEndpoint>> canvases;
    std::vector<std::weak_ptr<OffscreenSurface>> endpoints;
    bool stopping = false;
};

struct WindowDocument {
    explicit WindowDocument(std::shared_ptr<WindowServices> host, EngineOptions options)
        : host(std::move(host)) {
        engine.options = std::move(options);
        static_cast<void>(ui_document_root(engine, UiDocumentPart::Html));
    }
    std::shared_ptr<WindowServices> host;
    Engine engine;
    std::uint64_t published_revision = std::numeric_limits<std::uint64_t>::max();
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
    if (!document) throw std::logic_error("Window API used outside its application realm.");
    return *document;
}

std::unique_ptr<DocumentSnapshot> snapshot_document(const Engine& engine) {
    auto snapshot = std::make_unique<DocumentSnapshot>();
    snapshot->elements.reserve(engine.ui_elements.size());
    snapshot->listeners.reserve(engine.ui_elements.size());
    for (const auto& source : engine.ui_elements) {
        auto& native = snapshot->elements.emplace_back(source);
        ListenerNames names;
        names.click = !native.click_callbacks.empty();
        for (const auto& [name, callbacks] : native.event_callbacks) if (!callbacks.empty()) names.events.push_back(name);
        native.click_callbacks.clear();
        native.event_callbacks.clear();
#if defined(BBLITE_HAS_BROWSER_FILE) && BBLITE_HAS_BROWSER_FILE
        if (!native.file_change_callbacks.empty() || native.file_input || native.download_url.slot != invalid_handle) {
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
    if (engine.dom_input) snapshot->dom_event_types = engine.dom_input->event_types;
    return snapshot;
}

void apply_document(Engine& engine, DocumentSnapshot snapshot, const std::shared_ptr<EventLoop::Inbox>& inbox) {
    engine.ui_elements = std::move(snapshot.elements);
    engine.ui_root_children = std::move(snapshot.roots);
    engine.ui_document_roots = snapshot.document_roots;
    engine.ui_host_style_rules = std::move(snapshot.styles);
    engine.ui_style_revision = snapshot.style_revision;
    if (!snapshot.dom_event_types.empty()) {
        auto& input = dom_input(engine);
        input.event_types = std::move(snapshot.dom_event_types);
        input.batch_sink = [inbox](std::shared_ptr<DomEventBatch> batch) {
            auto event = std::make_unique<WindowDomEvent>();
            event->batch = std::move(batch);
            inbox->post(std::move(event));
        };
        input.pointer_sink = [inbox](const PlatformMouseEvent& payload) {
            auto event = std::make_unique<WindowDomEvent>();
            event->batch = std::make_shared<DomEventBatch>();
            event->batch->add(payload);
            inbox->post(std::move(event));
        };
    }
    for (std::size_t index = 0; index < snapshot.listeners.size(); ++index) {
        const UiElementHandle element{static_cast<std::uint32_t>(index)};
        auto& target = engine.ui_elements[index];
        if (target.external_gpu_canvas) {
            target.inner_rml = "<img src=\"bbl-canvas://" + std::to_string(index) +
                "\" style=\"width:100%;height:100%;display:block;pointer-events:none;\"/>";
        }
        if (snapshot.listeners[index].click) target.click_callbacks.push_back([inbox, element] {
            auto event = std::make_unique<WindowEvent>();
            event->element = element; event->type = "click";
            inbox->post(std::move(event));
        });
        for (const auto& name : snapshot.listeners[index].events) {
            target.event_callbacks[name].push_back([inbox, element, name](const PlatformMouseEvent& pointer) {
                auto event = std::make_unique<WindowEvent>();
                event->element = element; event->type = name; event->mouse = pointer;
                inbox->post(std::move(event));
            });
        }
    }
    ++engine.ui_revision;
}

void tick_document() {
    update_window_document();
    auto& doc = current_document();
    const auto observers = doc.observers;
    for (const auto& observer : observers) observer->deliver();
    // A list only the document still holds, with no listener to deliver
    // to, is one the script has let go of.
    std::erase_if(doc.media, [](const std::shared_ptr<MediaQueryList>& query) {
        return query.use_count() == 1 && !query->retained();
    });
    const auto media = doc.media;
    for (const auto& query : media) query->deliver();
    EventLoop::current().set_timeout(tick_document, 16);
}

void dispatch_canvas_input(const WindowPointerEvent& packet) {
    auto& doc = current_document();
    if (packet.pointer.type == SDL_EVENT_WINDOW_FOCUS_LOST) {
#if BBLITE_HAS_PBR_RENDERER
        for (auto& [index, target] : doc.input_targets) { (void)index; target.camera = {}; }
#endif
        return;
    }
    const auto target = doc.input_targets.find(packet.element.value);
    if (target == doc.input_targets.end()) return;
    const auto engine = target->second.engine.lock();
    if (!engine) return;
    const auto& event = packet.pointer;
    if (event.type == SDL_EVENT_MOUSE_MOTION) {
        const PlatformMouseEvent mouse{.button = -1, .buttons = dom_mouse_buttons(event.motion.state),
            .client_x = event.motion.x, .client_y = event.motion.y,
            .movement_x = event.motion.xrel, .movement_y = event.motion.yrel};
        dispatch_platform_mouse_move(*engine, mouse);
    } else if (event.type == SDL_EVENT_MOUSE_BUTTON_DOWN || event.type == SDL_EVENT_MOUSE_BUTTON_UP) {
        const PlatformMouseEvent mouse{.button = static_cast<double>(event.button.button - 1), .buttons = dom_mouse_buttons(packet.buttons),
            .client_x = event.button.x, .client_y = event.button.y};
        dispatch_platform_mouse_button(*engine, mouse, event.type == SDL_EVENT_MOUSE_BUTTON_DOWN);
    } else if (event.type == SDL_EVENT_MOUSE_WHEEL) {
        dispatch_platform_wheel_event(*engine, dom_wheel_delta_y(event.wheel), event.wheel.mouse_x, event.wheel.mouse_y);
    }
#if BBLITE_HAS_PBR_RENDERER
    if (engine->registered_scenes.empty() || !engine->registered_scenes.front()) return;
    const auto camera = engine->registered_scenes.front()->camera;
    if (camera.value < engine->cameras.size()) handle_camera_pointer_event(event, handle_at(engine->cameras, camera), target->second.camera);
#endif
}
} // namespace

void bind_canvas_engine(const std::shared_ptr<CanvasElement>& canvas, const std::shared_ptr<Engine>& engine) {
    auto& doc = current_document();
    const auto entry = std::find_if(doc.canvases.begin(), doc.canvases.end(), [&](const auto& value) { return value.second == canvas; });
    if (entry == doc.canvases.end()) throw InvalidCanvasState("Engine canvas is not attached to this Window.");
    doc.input_targets.insert_or_assign(entry->first, WindowDocument::InputTarget(engine));
    const auto box = window_element_size({entry->first});
    const auto width = static_cast<std::uint32_t>(std::max(1.0, std::round(box.width * window_device_pixel_ratio())));
    const auto height = static_cast<std::uint32_t>(std::max(1.0, std::round(box.height * window_device_pixel_ratio())));
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
js::Promise<js::PromiseVoid> window_clipboard_write(std::string text) {
    auto& doc = current_document();
    auto& loop = EventLoop::current();
    js::Promise<js::PromiseVoid> result;
    const auto id = loop.register_completion([result](std::unique_ptr<ExternalEvent> event) {
        const auto* completion = dynamic_cast<const ClipboardWrite*>(event.get());
        if (!completion) throw std::logic_error("Incorrect clipboard completion payload.");
        if (completion->error.empty()) result.resolve(js::PromiseVoid{});
        else result.reject(std::make_exception_ptr(std::runtime_error(completion->error)));
    });
    try {
        auto request = std::make_unique<ClipboardWrite>(id, std::move(text));
        std::lock_guard lock(doc.host->mutex);
        if (doc.host->stopping) throw WorkerTerminated{};
        doc.host->clipboard_writes.push_back(std::move(request));
    } catch (...) {
        loop.cancel_completion(id);
        result.reject(std::current_exception());
    }
    return result;
}
void window_on_application_error(bool rejection, std::uint64_t identity, ApplicationErrors::Callback callback, bool once) {
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
    auto snapshot = doc.published_revision != doc.engine.ui_revision || doc.published_input_revision != input_revision
        ? snapshot_document(doc.engine) : nullptr;
    std::unique_lock lock(host.mutex);
    if (host.stopping) throw WorkerTerminated{};
    if (snapshot) {
        host.pending = std::move(snapshot);
        const auto revision = ++host.requested;
        doc.published_revision = doc.engine.ui_revision;
        doc.published_input_revision = input_revision;
        host.wake.wait(lock, [&] { return host.stopping || host.completed >= revision; });
        if (host.stopping) throw WorkerTerminated{};
    }
    const auto layout = host.layout;
    lock.unlock();
    if (doc.layout != layout && layout) {
        doc.layout = layout;
        for (std::size_t index = 0; index < layout->rectangles.size() && index < doc.engine.ui_elements.size(); ++index) {
            doc.engine.ui_elements[index].client_rect = layout->rectangles[index];
        }
        for (const auto& [index, canvas] : doc.canvases) {
            if (index >= layout->rectangles.size()) continue;
            const auto& box = layout->rectangles[index];
            if (box.width > 0 && box.height > 0) canvas->resize_layout(
                static_cast<std::uint32_t>(std::round(box.width)), static_cast<std::uint32_t>(std::round(box.height)));
            const auto target = doc.input_targets.find(index);
            if (target != doc.input_targets.end()) if (const auto engine = target->second.engine.lock()) {
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
    if (!layout) throw std::logic_error("Window viewport has no layout snapshot.");
    return {0, 0, std::round(layout->width / layout->pixel_ratio), std::round(layout->height / layout->pixel_ratio)};
}
ScreenMetrics window_screen_metrics() {
    auto& doc = current_document();
    if (!doc.host->screen_requested.exchange(true)) ++doc.engine.ui_revision;
    update_window_document();
    if (!doc.layout) throw std::logic_error("Window screen has no layout snapshot.");
    return doc.layout->screen;
}
const void* window_screen_identity() { return std::addressof(current_document().screen_identity); }
UiClientRect window_element_size(UiElementHandle element) {
    update_window_document();
    const auto& layout = current_document().layout;
    if (!layout || element.value >= layout->rectangles.size()) throw std::out_of_range("Window element has no layout box.");
    auto box = handle_at(layout->rectangles, element);
    box.left /= layout->pixel_ratio; box.top /= layout->pixel_ratio;
    box.width /= layout->pixel_ratio; box.height /= layout->pixel_ratio;
    return box;
}
std::shared_ptr<CanvasElement> window_canvas(UiElementHandle element) {
    auto& doc = current_document();
    if (element.value >= doc.engine.ui_elements.size() || handle_at(doc.engine.ui_elements, element).tag != "canvas") {
        throw InvalidCanvasState("Window element is not a canvas.");
    }
    const auto found = doc.canvases.find(element.value);
    if (found != doc.canvases.end()) return found->second;
    // A DOM canvas starts with its backing-store default, independent of CSS
    // layout. Engine creation sizes its own context; transfer preserves this
    // value until the receiving source explicitly changes it.
    auto endpoint = doc.host->create_endpoint(300, 150);
    auto canvas = js::make_gc_shared<CanvasElement>(endpoint);
    doc.canvases.emplace(element.value, canvas);
    handle_at(doc.engine.ui_elements, element).external_gpu_canvas = true;
    ++doc.engine.ui_revision;
    { std::lock_guard lock(doc.host->mutex); doc.host->canvases.emplace(element.value, std::move(endpoint)); }
    return canvas;
}

void ResizeObserver::observe(UiElementHandle element) {
    if (observed_.empty()) {
        auto owner = self_.lock();
        if (!owner) throw std::logic_error("ResizeObserver must be created by its Window realm.");
        current_document().observers.push_back(std::move(owner));
    }
    observed_.try_emplace(element.value, UiClientRect{-1, -1, -1, -1});
}
void ResizeObserver::unobserve(UiElementHandle element) {
    observed_.erase(element.value);
    if (observed_.empty()) disconnect();
}
void ResizeObserver::disconnect() {
    observed_.clear();
    std::erase_if(current_document().observers, [this](const auto& observer) { return observer.get() == this; });
}
void ResizeObserver::deliver() {
    bool changed = false;
    for (auto& [index, prior] : observed_) {
        const auto next = window_element_size({index});
        changed |= prior.width != next.width || prior.height != next.height;
        prior = next;
    }
    if (changed) EventLoop::current().dispatch_callback(callback_);
}
std::shared_ptr<ResizeObserver> create_resize_observer(ResizeObserver::Callback callback) {
    auto observer = js::make_gc_shared<ResizeObserver>(std::move(callback));
    observer->self_ = observer;
    return observer;
}
std::shared_ptr<MediaQueryList> create_media_query(std::string query) {
    auto media = js::make_gc_shared<MediaQueryList>(std::move(query), window_device_pixel_ratio, system_reduced_motion);
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
            if (consumed != capture_frame_text.size() || frame < 0 || frame > 1000000 || frame_options.screenshot_path.empty()) {
                throw std::invalid_argument("BBLITE_CAPTURE_ENGINE_FRAME requires a screenshot and a frame in [0, 1000000].");
            }
            capture_frame_count = static_cast<std::uint64_t>(frame) + 1;
        }
        if (!SDL_Init(SDL_INIT_VIDEO | SDL_INIT_EVENTS)) throw std::runtime_error(SDL_GetError());
        struct Quit { ~Quit() { SDL_Quit(); } } quit;
        using Window = std::unique_ptr<SDL_Window, decltype(&SDL_DestroyWindow)>;
        Window window(SDL_CreateWindow(options.title.c_str(), options.width, options.height, SDL_WINDOW_RESIZABLE | SDL_WINDOW_HIGH_PIXEL_DENSITY |
            (frame_options.test_pass ? SDL_WINDOW_NOT_FOCUSABLE : 0)), &SDL_DestroyWindow);
        if (!window) throw std::runtime_error(SDL_GetError());
        std::shared_ptr<WindowPresenter> presenter;
        const bool dawn = environment_variable("BBLITE_GPU_BACKEND") == "dawn";
#if BBLITE_HAS_DAWN
        if (dawn) presenter = create_window_dawn_presenter(window.get());
#endif
#if BBLITE_HAS_SDL_GPU
        if (!dawn) presenter = create_window_sdl_presenter(window.get());
#endif
        if (!presenter) throw std::runtime_error("Requested Window GPU backend is unavailable.");
        // Reload replaces realm-owned state while keeping the native window and device.
        for (;;) {
            auto services = std::make_shared<WindowServices>(std::shared_ptr<OffscreenDevice>(presenter, &presenter->device()), capture_frame_count);
            Engine display;
            display.options = options;
            std::unique_ptr<UiRmlRuntime, decltype(&destroy_ui_rml_runtime)> ui(
                create_ui_rml_runtime(display, window.get(), options.width, options.height), &destroy_ui_rml_runtime);
            std::atomic<bool> finished = false;
            std::exception_ptr application_error;
            std::jthread application([&] {
                try {
                    const js::RealmScope state;
                    EventLoop loop(services->inbox);
                    WindowDocument owner(services, options);
                    document = &owner;
                    struct Reset { ~Reset() { document = nullptr; } } reset;
                    WorkerRealm realm(loop, {}, services);
                    ApplicationErrors errors(loop);
                    owner.errors = &errors;
                    realm.on_platform_event([](std::unique_ptr<ExternalEvent> packet) {
                        if (const auto* event = dynamic_cast<WindowDomEvent*>(packet.get())) {
                            event->batch->dispatch(window_document_engine(), [](auto& callback, const auto& payload) {
                                EventLoop::current().dispatch_callback([&] { callback(payload); });
                            });
                            return;
                        }
                        if (const auto* pointer = dynamic_cast<WindowPointerEvent*>(packet.get())) {
                            EventLoop::current().dispatch_callback([&] { dispatch_canvas_input(*pointer); });
                            return;
                        }
                        const auto* event = dynamic_cast<WindowEvent*>(packet.get());
                        if (!event) throw std::logic_error("Unknown Window event.");
                        auto& engine = window_document_engine();
                        if (event->element.value >= engine.ui_elements.size()) return;
                        const auto& record = handle_at(engine.ui_elements, event->element);
                        if (event->type == "click") {
                            const auto callbacks = record.click_callbacks;
                            for (const auto& callback : callbacks) EventLoop::current().dispatch_callback(callback);
                        } else if (const auto found = record.event_callbacks.find(event->type); found != record.event_callbacks.end()) {
                            const auto callbacks = found->second;
                            for (const auto& callback : callbacks) EventLoop::current().dispatch_callback([&] { callback(event->mouse); });
                        }
                    });
                    loop.run([&] { initialize(realm); tick_document(); });
                } catch (const WorkerTerminated&) {
                } catch (...) { application_error = std::current_exception(); }
                finished = true;
            });
            struct Stop { std::shared_ptr<WindowServices> services; ~Stop() { services->stop(); } } stop{services};
            std::unordered_map<std::uint32_t, OffscreenFrame> latest;
            PlatformInputReplay input_replay;
            LayoutSnapshot next_layout;
            std::shared_ptr<const LayoutSnapshot> layout;
            UiElementHandle pointer_capture{};
            SDL_MouseButtonFlags pointer_buttons = 0;
            std::optional<SDL_Event> pending_input;
            std::shared_ptr<DomEventBatch> pending_dispatch;
            long presented = 0;
            const bool trace_window = runtime_trace_enabled() || environment_variable("BBLITE_WINDOW_TRACE") == "1";
            bool running = true;
            while (running && !finished) {
                std::vector<std::unique_ptr<ClipboardWrite>> clipboard_writes;
                {
                    std::lock_guard lock(services->mutex);
                    clipboard_writes.swap(services->clipboard_writes);
                }
                for (auto& request : clipboard_writes) {
                    {
                        const auto text = std::move(request->text);
                        if (!SDL_SetClipboardText(text.c_str())) request->error = SDL_GetError();
                    }
                    services->inbox->post(std::move(request));
                }
                SDL_Event event;
                for (;;) {
                    if (pending_input) {
                        if (!pending_dispatch->ready()) break;
                        event = *pending_input;
                        pending_input.reset();
                        const bool prevented = pending_dispatch->default_prevented;
                        pending_dispatch.reset();
                        if (prevented) continue;
                    } else {
                        if (!SDL_PollEvent(&event)) break;
                        if (event.type == SDL_EVENT_QUIT || event.type == SDL_EVENT_WINDOW_CLOSE_REQUESTED) running = false;
                        if (frame_options.test_pass && is_platform_input_event(event) && !is_replayed_ui_event(event)) continue;
                        if (auto batch = prepare_dom_platform_input(display, event)) {
                            dispatch_dom_batch(display, batch);
                            if (!batch->ready()) {
                                // prepare_dom_platform_input only admits SDL payloads
                                // containing no borrowed pointers. Other events remain
                                // in SDL's queue until this default action is resolved.
                                pending_input = event;
                                pending_dispatch = std::move(batch);
                                break;
                            }
                            if (batch->default_prevented) continue;
                        }
                    }
                    const bool reaches_canvas = handle_ui_rml_event(*ui, event);
                    if (event.type == SDL_EVENT_WINDOW_FOCUS_LOST) {
                        pointer_capture = {}; pointer_buttons = 0;
                        auto packet = std::make_unique<WindowPointerEvent>();
                        packet->pointer = event;
                        services->inbox->post(std::move(packet));
                    }
                    const bool move = event.type == SDL_EVENT_MOUSE_MOTION;
                    const bool down = event.type == SDL_EVENT_MOUSE_BUTTON_DOWN;
                    const bool up = event.type == SDL_EVENT_MOUSE_BUTTON_UP;
                    const bool wheel = event.type == SDL_EVENT_MOUSE_WHEEL;
                    if (!(move || down || up || wheel) || (!reaches_canvas && pointer_capture.value == invalid_handle)) continue;
                    if (!layout) continue;
                    const double x = move ? event.motion.x : wheel ? event.wheel.mouse_x : event.button.x;
                    const double y = move ? event.motion.y : wheel ? event.wheel.mouse_y : event.button.y;
                    auto target = pointer_capture;
                    if (target.value == invalid_handle) {
                        for (std::size_t index = 0; index < display.ui_elements.size(); ++index) {
                            if (!display.ui_elements[index].external_gpu_canvas || index >= layout->rectangles.size()) continue;
                            const auto& box = layout->rectangles[index];
                            if (x * layout->pixel_ratio >= box.left && y * layout->pixel_ratio >= box.top &&
                                x * layout->pixel_ratio < box.left + box.width && y * layout->pixel_ratio < box.top + box.height) {
                                target = {static_cast<std::uint32_t>(index)}; break;
                            }
                        }
                    }
                    if (target.value == invalid_handle || target.value >= layout->rectangles.size()) continue;
                    if (down) { pointer_capture = target; pointer_buttons |= SDL_BUTTON_MASK(event.button.button); }
                    if (up) { pointer_buttons &= ~SDL_BUTTON_MASK(event.button.button); if (!pointer_buttons) pointer_capture = {}; }
                    const auto& box = handle_at(layout->rectangles, target);
                    auto packet = std::make_unique<WindowPointerEvent>();
                    packet->element = target;
                    packet->pointer = event;
                    packet->buttons = pointer_buttons;
                    const auto left = static_cast<float>(box.left / layout->pixel_ratio), top = static_cast<float>(box.top / layout->pixel_ratio);
                    if (move) { packet->pointer.motion.x -= left; packet->pointer.motion.y -= top; }
                    else if (wheel) { packet->pointer.wheel.mouse_x -= left; packet->pointer.wheel.mouse_y -= top; }
                    else { packet->pointer.button.x -= left; packet->pointer.button.y -= top; }
                    services->inbox->post(std::move(packet));
                }
                int width = 0, height = 0;
                if (!SDL_GetWindowSizeInPixels(window.get(), &width, &height)) throw std::runtime_error(SDL_GetError());
                if (width <= 0 || height <= 0) { SDL_Delay(1); continue; }
                std::unique_ptr<DocumentSnapshot> snapshot;
                std::uint64_t revision = 0;
                {
                    std::lock_guard lock(services->mutex);
                    snapshot = std::move(services->pending);
                    revision = services->requested;
                }
                if (snapshot) apply_document(display, std::move(*snapshot), services->inbox);
                update_ui_rml_runtime(*ui, width, height);
                next_layout.width = width; next_layout.height = height;
                const auto density = SDL_GetWindowDisplayScale(window.get());
                next_layout.pixel_ratio = density > 0 ? density : 1;
                if (services->screen_requested.load()) {
                    const auto display_id = SDL_GetDisplayForWindow(window.get());
                    SDL_Rect bounds{}, available{};
                    const auto* mode = SDL_GetCurrentDisplayMode(display_id);
                    int bits = 0;
                    Uint32 red = 0, green = 0, blue = 0, alpha = 0;
                    if (!SDL_GetDisplayBounds(display_id, &bounds) || !SDL_GetDisplayUsableBounds(display_id, &available) ||
                        !mode || !SDL_GetMasksForPixelFormat(mode->format, &bits, &red, &green, &blue, &alpha))
                        throw std::runtime_error(std::string("Unable to query display metrics: ") + SDL_GetError());
                    const auto scale = next_layout.pixel_ratio;
                    next_layout.screen = {std::round(bounds.w / scale), std::round(bounds.h / scale),
                        std::round(available.w / scale), std::round(available.h / scale),
                        static_cast<double>(std::popcount(red) + std::popcount(green) + std::popcount(blue))};
                }
                next_layout.rectangles.resize(display.ui_elements.size());
                for (std::size_t index = 0; index < display.ui_elements.size(); ++index) next_layout.rectangles[index] = display.ui_elements[index].client_rect;
                if (!layout || !layout->equals(next_layout)) layout = std::make_shared<LayoutSnapshot>(next_layout);
                std::vector<WindowCanvasFrame> frames;
                bool canvases_ready = false;
                {
                    std::lock_guard lock(services->mutex);
                    services->layout = layout;
                    services->completed = revision;
                    for (const auto& [index, canvas] : services->canvases) {
                        if (auto frame = canvas->surface->take_frame()) latest.insert_or_assign(index, std::move(*frame));
                        if (const auto found = latest.find(index); found != latest.end() && index < layout->rectangles.size()) {
                            frames.push_back({UiElementHandle{index}, found->second});
                        }
                    }
                    canvases_ready = revision > 0 && frames.size() == services->canvases.size();
                }
                services->wake.notify_all();
                const bool capture_ready = capture_frame_count && !frames.empty() ? std::all_of(frames.begin(), frames.end(),
                    [&](const auto& canvas) { return canvas.frame.sequence == capture_frame_count; }) :
                    presented == std::max(0L, frame_options.screenshot_frame);
                const bool capture = canvases_ready && !frame_options.screenshot_path.empty() && capture_ready;
                bool did_present = false;
                if (presenter->can_present()) {
                    const auto& recorded = record_ui_rml_frame(*ui, width, height);
                    std::optional<UiRenderFrame> canvas_capture;
                    if (capture && !frame_options.capture_ui) {
                        canvas_capture = recorded;
                        std::erase_if(canvas_capture->draws, [&](const auto& draw) {
                            return std::none_of(recorded.textures.begin(), recorded.textures.end(), [&](const auto& texture) {
                                return texture.id == draw.texture_id && texture.external_canvas != invalid_handle;
                            });
                        });
                        canvas_capture->backdrops.clear();
                        canvas_capture->composites.clear();
                        canvas_capture->operations.clear();
                        canvas_capture->layer_count = 0;
                        for (auto& draw : canvas_capture->draws) draw.layer = 0;
                    }
                    did_present = presenter->present(frames, canvas_capture ? *canvas_capture : recorded, capture ? frame_options.screenshot_path : std::string{});
                }
                if (did_present) services->animation_frames->tick(EventLoop::Clock::now());
                if (did_present && canvases_ready) {
                    input_replay.dispatch(presented, window.get(), display);
                    if (trace_window && presented % runtime_trace_interval() == 0) {
                        std::ostringstream trace;
                        trace << std::setprecision(15) << "[bblite trace] window frame=" << presented << " now-ms="
                            << std::chrono::duration<double, std::milli>(EventLoop::Clock::now().time_since_epoch()).count();
                        for (const auto& canvas : frames) trace << " canvas=" << canvas.element.value << ':' << canvas.frame.sequence
                            << '@' << canvas.frame.width << 'x' << canvas.frame.height;
                        trace << '\n';
                        std::cerr << trace.str();
                    }
                    ++presented;
                    if (capture_frame_count ? capture : frame_options.max_frames > 0 && presented >= frame_options.max_frames) running = false;
                }
                SDL_Delay(1);
            }
            services->stop();
            application.join();
            if (application_error) std::rethrow_exception(application_error);
            if (!services->reload_requested) return 0;
        }
    } catch (const std::exception& error) {
        std::cerr << "Babylon Lite Window error: " << error.what() << '\n';
        return 1;
    }
}
} // namespace bbl::pal
