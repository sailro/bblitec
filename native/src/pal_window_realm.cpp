#include <bblite/features/has_audio.hpp>
#include <bblite/features/has_browser_file.hpp>
#include <bblite/features/has_engine.hpp>
#include <bblite/features/has_pbr_renderer.hpp>

#include <bblite/pal_window_realm.hpp>
#include <bblite/pal.hpp>
#include <bblite/pal_animation_frame.hpp>
#include <bblite/pal_location.hpp>
#include <bblite/js_url.hpp>
#include "pal_window_presenter.hpp"
#include "pal_window_frame_clock.hpp"
#include "pal_gpu_frame.hpp"
#include "pal_platform_events.hpp"
#include "pal_system_preferences.hpp"
#include "pal_window.hpp"
#include "pal_gpu_dispatch.hpp"
#include "pal_file_io.hpp"
#if BBLITE_HAS_AUDIO
#include <bblite/pal_audio.hpp>
#endif
#if BBLITE_HAS_PBR_RENDERER
#include "pal_camera_controls.hpp"
#endif

#include <algorithm>
#include <atomic>
#include <bit>
#include <charconv>
#include <optional>
#include <string_view>
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

/** `final_frame` is the frame the final screenshot waits for, in its own count. */
std::vector<WindowScreenshotCheckpoint> window_screenshot_checkpoints(std::string_view source,
                                                                      const FrameOptions& options,
                                                                      long final_frame) {
    if (source.empty())
        return {};
    if (options.screenshot_path.empty())
        throw std::invalid_argument("BBLITE_SCREENSHOT_FRAMES requires BBLITE_SCREENSHOT.");
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
            frame >= final_frame || (!checkpoints.empty() && frame <= checkpoints.back().frame))
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

    void capture_form_state(Engine& engine) {
        if (ui_get_attribute(engine, element, "type") == "checkbox")
            checked = ui_get_checked(engine, element);
        else if (handle_at(engine.ui_elements, element).tag == "select") {
            selected_option = UiElementHandle{};
            for (const auto option : handle_at(engine.ui_elements, element).children)
                if (ui_get_selected(engine, option)) {
                    selected_option = option;
                    break;
                }
        } else
            form_value = ui_get_form_value(engine, element);
    }
};
struct WindowDomEvent final : ExternalEvent {
    std::shared_ptr<DomEventBatch> batch;
};

/**
 * Focus the display resolved natively, such as a press on a control. The
 * realm owns the document it publishes back, so it records this state; its
 * listeners receive the focus and blur events on their own channel.
 */
struct WindowFocusEvent final : ExternalEvent {
    UiElementHandle element;
    bool visible = false;
};
/** Only pointer and key event structs are copied; SDL events containing
 * pointers are never admitted to the realm mailbox. */
struct WindowPointerEvent final : ExternalEvent {
    UiElementHandle element;
    SDL_Event pointer{};
    SDL_MouseButtonFlags buttons = 0;
};
/** The page visibility the display observed, recorded on the realm's document. */
struct WindowVisibilityEvent final : ExternalEvent {
    bool hidden = false;
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
/**
 * The window state a page fullscreen request or exit asks for (none keeps it, ordered after
 * earlier requests), and the platform's failure.
 */
struct FullscreenRequest final : CompletionEvent {
    std::optional<bool> fullscreen;
    std::string error;
    FullscreenRequest(std::uint64_t id, std::optional<bool> value)
        : CompletionEvent(id), fullscreen(value) {}
};
/** The display ended page fullscreen itself: Escape, or the system left window fullscreen. */
struct WindowFullscreenExit final : ExternalEvent {};
/** An alert or confirmation the realm waits on while the Window thread shows it. */
struct MessageBoxRequest {
    bool confirm = false;
    std::string message;
    std::optional<bool> answer;
    std::string error;
};
struct DocumentSnapshot {
    struct TextUpdate {
        UiElementHandle element;
        std::string text;
    };
    struct CanvasUpdate {
        UiElementHandle element;
        UiElementRecord::CanvasState state;
    };
    std::optional<std::vector<TextUpdate>> text_updates;
    std::vector<CanvasUpdate> canvas_updates;
    Engine::DocumentRoots document_roots;
    std::vector<UiElementRecord> elements;
    std::vector<ListenerNames> listeners;
    std::vector<UiElementHandle> roots;
    std::vector<UiStyleRule> styles;
    std::uint64_t style_revision = 0;
    UiElementHandle focused_element{};
    std::uint64_t focus_revision = 0;
    bool focus_visible = true;
    UiElementHandle text_selection{};
    std::uint64_t text_selection_revision = 0;
    std::set<std::string> dom_event_types;
    std::set<std::uint32_t> dom_pointer_elements;
    /** The realm's pointer capture state, which the display targets input by. */
    std::shared_ptr<DomPointerCaptures> pointer_captures;
};
struct LayoutSnapshot {
    std::vector<UiClientRect> rectangles;
    std::vector<UiContentBox> content_boxes;
    /** Computed styles of the elements the realm requested, by element. */
    std::vector<UiComputedStyle> styles;
    /** `UiElementRecord::pointer_states` the display's last update styled with, by element. */
    std::vector<std::uint8_t> pointer_states;
    std::uint32_t width = 0, height = 0;
    double pixel_ratio = 1;
    ScreenMetrics screen;
    InputCapabilities input;
    bool equals(const LayoutSnapshot& other) const {
        return width == other.width && height == other.height && pixel_ratio == other.pixel_ratio &&
               screen == other.screen && input == other.input && rectangles == other.rectangles &&
               content_boxes == other.content_boxes && styles == other.styles &&
               pointer_states == other.pointer_states;
    }
};

/**
 * `BBLITE_CAPTURE_SETTLE` (`data-attribute=value|value;milliseconds`): the
 * canvas state a capture waits on, held for the settle time. An application
 * whose content arrives over the network reaches it at a different frame on
 * every run, so the capture follows the state rather than a frame.
 */
struct CaptureSettle {
    std::string attribute;
    std::vector<std::string> values;
    double milliseconds = 0;
};

const std::optional<CaptureSettle>& capture_settle() {
    static const std::optional<CaptureSettle> settle = []() -> std::optional<CaptureSettle> {
        const std::string text = environment_variable("BBLITE_CAPTURE_SETTLE");
        if (text.empty())
            return std::nullopt;
        const auto equals = text.find('=');
        const auto separator = text.rfind(';');
        CaptureSettle parsed;
        const auto [end, error] =
            separator == std::string::npos
                ? std::from_chars_result{text.data(), std::errc::invalid_argument}
                : std::from_chars(text.data() + separator + 1, text.data() + text.size(),
                                  parsed.milliseconds);
        if (equals == std::string::npos || separator < equals || error != std::errc{} ||
            end != text.data() + text.size() || parsed.milliseconds < 0)
            throw std::runtime_error(
                "BBLITE_CAPTURE_SETTLE must read data-attribute=value|value;milliseconds.");
        parsed.attribute = text.substr(0, equals);
        std::string_view values(text.data() + equals + 1, separator - equals - 1);
        for (std::size_t start = 0; start <= values.size();) {
            const auto bar = values.find('|', start);
            const auto stop = bar == std::string_view::npos ? values.size() : bar;
            parsed.values.emplace_back(values.substr(start, stop - start));
            start = stop + 1;
        }
        return parsed;
    }();
    return settle;
}

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
    std::optional<GpuAdapterInfo> graphics_adapter_info() const override {
        return graphics ? graphics->adapter_info() : std::nullopt;
    }
    std::shared_ptr<CanvasEndpoint> create_endpoint(std::uint64_t width,
                                                    std::uint64_t height) override {
        if (width > 16384 || height > 16384)
            throw InvalidCanvasState("Native canvas allocation exceeds 16384 pixels.");
        auto endpoint = std::make_shared<CanvasEndpoint>(
            std::make_shared<OffscreenSurface>(
                static_cast<std::uint32_t>(std::max<std::uint64_t>(1, width)),
                static_cast<std::uint32_t>(std::max<std::uint64_t>(1, height)), animation_frames,
                capture_frame_count, capture_ready),
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
    std::shared_ptr<std::atomic<bool>> capture_ready =
        std::make_shared<std::atomic<bool>>(!capture_settle());
    /** When `capture_ready` last became true, and how long the active settles hold it. */
    std::atomic<double> capture_ready_since = 0;
    std::atomic<double> capture_settle_milliseconds = 0;
    std::shared_ptr<AnimationFrameSource> animation_frames =
        std::make_shared<AnimationFrameSource>();
    std::shared_ptr<EventLoop::Inbox> inbox = std::make_shared<EventLoop::Inbox>();
    std::mutex mutex;
    std::string capture_failure;
    std::condition_variable wake;
    std::unique_ptr<DocumentSnapshot> pending;
    std::vector<std::unique_ptr<ClipboardWrite>> clipboard_writes;
    std::vector<std::unique_ptr<FullscreenRequest>> fullscreen_requests;
    /** The realm's pending message box, answered in place; guarded by `mutex`. */
    std::shared_ptr<MessageBoxRequest> message_box;
    std::uint64_t requested = 0, completed = 0;
    /** Document input posted and handled, guarded by `mutex`. Except for mouse
     * motion, each transaction and its native default's events (click, input,
     * change, toggle) finish before the display handles the next event or
     * presents. Mouse motion remains ordered without blocking presentation. */
    std::uint64_t input_posted = 0, input_handled = 0;
    std::shared_ptr<const LayoutSnapshot> layout;
    std::atomic<bool> screen_requested = false;
    std::atomic<bool> reload_requested = false;
    std::shared_ptr<WindowLocation> location;
    std::unordered_map<std::uint32_t, std::shared_ptr<CanvasEndpoint>> canvases;
    std::vector<std::weak_ptr<OffscreenSurface>> endpoints;
    bool stopping = false;
};

/**
 * `BBLITE_MESSAGE_BOX_RESPONSE`: `accept` or `dismiss` answers every message box without
 * showing it, for noninteractive runs.
 */
std::optional<bool> message_box_response() {
    const auto text = environment_variable("BBLITE_MESSAGE_BOX_RESPONSE");
    if (text.empty())
        return std::nullopt;
    if (text != "accept" && text != "dismiss")
        throw std::runtime_error("BBLITE_MESSAGE_BOX_RESPONSE must be accept or dismiss.");
    return text == "accept";
}

/** A modal SDL message box on this, the Window's thread: true when a confirmation is accepted. */
bool show_message_box(SDL_Window* window, const MessageBoxRequest& request) {
    const SDL_MessageBoxButtonData confirm_buttons[] = {
        {SDL_MESSAGEBOX_BUTTON_RETURNKEY_DEFAULT, 1, "OK"},
        {SDL_MESSAGEBOX_BUTTON_ESCAPEKEY_DEFAULT, 0, "Cancel"},
    };
    const SDL_MessageBoxButtonData alert_button{
        SDL_MESSAGEBOX_BUTTON_RETURNKEY_DEFAULT | SDL_MESSAGEBOX_BUTTON_ESCAPEKEY_DEFAULT, 1, "OK"};
    const char* title = window ? SDL_GetWindowTitle(window) : "";
    const SDL_MessageBoxData data{
        SDL_MESSAGEBOX_INFORMATION | SDL_MESSAGEBOX_BUTTONS_LEFT_TO_RIGHT,
        window,
        title,
        request.message.c_str(),
        request.confirm ? 2 : 1,
        request.confirm ? confirm_buttons : &alert_button,
        nullptr,
    };
    int button = -1;
    if (!SDL_ShowMessageBox(&data, &button))
        throw std::runtime_error("SDL message box failed: " + std::string(SDL_GetError()));
    return request.confirm && button == 1;
}

/** Answers the realm's pending message box, if any; a platform failure throws in the realm. */
void serve_message_box(WindowServices& services, SDL_Window* window) {
    std::shared_ptr<MessageBoxRequest> request;
    {
        std::lock_guard lock(services.mutex);
        request = std::exchange(services.message_box, nullptr);
    }
    if (!request)
        return;
    std::optional<bool> answer;
    std::string error;
    if (const auto response = message_box_response())
        answer = request->confirm && *response;
    else
        try {
            answer = show_message_box(window, *request);
        } catch (const std::exception& failure) {
            error = failure.what();
        }
    {
        std::lock_guard lock(services.mutex);
        request->answer = answer;
        request->error = std::move(error);
    }
    services.wake.notify_all();
}

/**
 * The Window thread's page fullscreen: whether the page holds it, and whether entering it
 * made a windowed window fullscreen, so leaving restores the window rather than leaving a
 * fullscreen the window already had (mobile windows, a window the user made fullscreen).
 */
struct PageFullscreen {
    bool active = false;
    bool restore_windowed = false;

    static bool window_fullscreen(SDL_Window* window) {
        return (SDL_GetWindowFlags(window) & SDL_WINDOW_FULLSCREEN) != 0;
    }
    /** Applies `fullscreen` to the window: empty, or SDL's failure. */
    static std::string set_window(SDL_Window* window, bool fullscreen) {
        if (!SDL_SetWindowFullscreen(window, fullscreen))
            return SDL_GetError();
        // Asynchronous window systems apply the state later; wait for it, bounded by SDL.
        static_cast<void>(SDL_SyncWindow(window));
        return {};
    }
    std::string enter(SDL_Window* window) {
        if (active)
            return {};
        const bool windowed = !window_fullscreen(window);
        auto error = windowed ? set_window(window, true) : std::string();
        if (error.empty()) {
            active = true;
            restore_windowed = windowed;
        }
        return error;
    }
    std::string leave(SDL_Window* window) {
        active = false;
        return std::exchange(restore_windowed, false) ? set_window(window, false) : std::string();
    }
};

/** Applies the realm's fullscreen requests in order and posts each one's completion. */
void serve_fullscreen_requests(WindowServices& services, SDL_Window* window,
                               PageFullscreen& fullscreen) {
    std::vector<std::unique_ptr<FullscreenRequest>> requests;
    {
        std::lock_guard lock(services.mutex);
        requests.swap(services.fullscreen_requests);
    }
    for (auto& request : requests) {
        if (request->fullscreen)
            request->error =
                *request->fullscreen ? fullscreen.enter(window) : fullscreen.leave(window);
        services.inbox->post(std::move(request));
    }
}

/**
 * The display ending page fullscreen itself, as browsers do: an Escape press (consumed) or the
 * window leaving fullscreen. True when `event` was consumed.
 */
bool end_page_fullscreen(WindowServices& services, SDL_Window* window, PageFullscreen& fullscreen,
                         const SDL_Event& event) {
    if (!fullscreen.active)
        return false;
    const bool escape =
        event.type == SDL_EVENT_KEY_DOWN && event.key.key == SDLK_ESCAPE && !event.key.repeat;
    // A leave event left behind by an earlier exit arrives after a later enter; the window's
    // present state tells them apart.
    const bool left = event.type == SDL_EVENT_WINDOW_LEAVE_FULLSCREEN &&
                      !PageFullscreen::window_fullscreen(window);
    if (!escape && !left)
        return false;
    if (escape) {
        if (const auto error = fullscreen.leave(window); !error.empty())
            throw std::runtime_error("Leaving page fullscreen failed: " + error);
    } else
        fullscreen = {};
    services.inbox->post(std::make_unique<WindowFullscreenExit>());
    return escape;
}

/** The display's latest pointer states on the current realm's document. */
void adopt_window_pointer_states();

struct WindowDocument {
    explicit WindowDocument(std::shared_ptr<WindowServices> host, EngineOptions options)
        : host(std::move(host)) {
        // An engine-less Window application never creates an engine.
        report_build_stamp();
        engine.options = std::move(options);
        engine.ui_attribute_changed = [this](UiElementHandle element,
                                             const std::string& attribute) {
            for (const auto& observer : mutation_observers)
                observer->notify(element, attribute);
            if (attribute == "data-ready" || attribute == "data-error" ||
                (capture_settle() && attribute == capture_settle()->attribute))
                update_capture_ready();
        };
        engine.ui_measure_element = [](Engine& owner, UiElementHandle element) {
            if (&owner != &window_document_engine())
                throw std::logic_error("A Window layout read requires its owning realm.");
            return window_element_size(element);
        };
        engine.ui_adopt_pointer_states = [](Engine& owner) {
            if (&owner != &window_document_engine())
                throw std::logic_error("A Window selector state read requires its owning realm.");
            adopt_window_pointer_states();
        };
        static_cast<void>(ui_document_root(engine, UiDocumentPart::Html));
    }
    std::shared_ptr<WindowServices> host;
    bool wait_for_canvas_ready = false;
    /**
     * The capture's canvas settles, as the browser harness waits on them: the data-ready gate
     * (`data-ready="true"`, at once) and the registered settle. Each holds when any canvas
     * (GPU or retained Canvas2D) carries one of its values; the capture waits until all hold for
     * the longest settle time, and any canvas's nonempty `data-error` fails a bounded run.
     */
    void update_capture_ready() {
        static const CaptureSettle canvas_ready{"data-ready", {"true"}, 0};
        std::vector<const CaptureSettle*> settles;
        if (wait_for_canvas_ready)
            settles.push_back(&canvas_ready);
        if (const auto& settle = capture_settle())
            settles.push_back(&*settle);
        if (settles.empty())
            return;
        std::vector<bool> held(settles.size(), false);
        double milliseconds = 0;
        std::string failure;
        for (std::uint32_t index = 0; index < engine.ui_elements.size(); ++index) {
            if (handle_at(engine.ui_elements, UiElementHandle{index}).tag != "canvas")
                continue;
            for (std::size_t row = 0; row < settles.size(); ++row)
                held[row] =
                    held[row] || std::ranges::find(settles[row]->values,
                                                   ui_get_attribute(engine, UiElementHandle{index},
                                                                    settles[row]->attribute)) !=
                                     settles[row]->values.end();
            if (failure.empty())
                failure = ui_get_attribute(engine, UiElementHandle{index}, "data-error");
        }
        for (const auto* settle : settles)
            milliseconds = std::max(milliseconds, settle->milliseconds);
        const bool ready = std::ranges::all_of(held, [](bool value) { return value; });
        host->capture_settle_milliseconds.store(milliseconds);
        if (!host->capture_ready->exchange(ready) && ready)
            host->capture_ready_since.store(monotonic_milliseconds());
        std::lock_guard lock(host->mutex);
        host->capture_failure = std::move(failure);
    }
    Engine engine;
    std::uint64_t published_revision = std::numeric_limits<std::uint64_t>::max();
    std::uint64_t published_text_revision = 0;
    std::uint64_t published_canvas_revision = 0;
    std::uint64_t published_focus_revision = std::numeric_limits<std::uint64_t>::max();
    std::uint64_t published_text_selection_revision = 0;
    std::uint64_t published_input_revision = 0;
    std::shared_ptr<const LayoutSnapshot> layout;
    std::unordered_map<std::uint32_t, std::shared_ptr<CanvasElement>> canvases;
    struct InputTarget {
        explicit InputTarget(const std::shared_ptr<Engine>& engine) : engine(engine) {}
        std::weak_ptr<Engine> engine;
#if BBLITE_HAS_PBR_RENDERER
        /** The camera controls' gesture state, as a standalone driver keeps it per surface. */
        CameraPointerState camera;
        SurfaceCameraPointerState surfaces;
#endif
    };
    std::unordered_map<std::uint32_t, InputTarget> input_targets;
    std::vector<std::shared_ptr<ResizeObserver>> observers;
    std::vector<std::shared_ptr<MutationObserver>> mutation_observers;
    std::vector<std::shared_ptr<MediaQueryList>> media;
    /** The first canvas an engine was created on. */
    std::optional<std::uint32_t> primary_canvas;
    /** Fullscreen elements, the document's fullscreen element last. */
    std::vector<UiElementHandle> fullscreen;
    PlatformEventListeners<void()> fullscreen_listeners;
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
snapshot_document(const Engine& engine, std::optional<std::uint64_t> text_since = std::nullopt,
                  std::uint64_t canvas_since = 0) {
    auto snapshot = std::make_unique<DocumentSnapshot>();
    if (text_since) {
        auto& updates = snapshot->text_updates.emplace();
        for (std::uint32_t index = 0; index < engine.ui_elements.size(); ++index) {
            const auto& record = engine.ui_elements[index];
            if (record.text_revision > *text_since)
                updates.push_back({UiElementHandle{index}, record.text});
            if (record.canvas && record.canvas->draw_revision > canvas_since)
                snapshot->canvas_updates.push_back({UiElementHandle{index}, *record.canvas});
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
            if (!callbacks->empty())
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
        if (native.file_change_callbacks || native.file_input ||
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
    snapshot->focused_element = engine.ui_focused_element;
    snapshot->focus_revision = engine.ui_focus_revision;
    snapshot->focus_visible = engine.ui_focus_visible;
    snapshot->text_selection = engine.ui_text_selection;
    snapshot->text_selection_revision = engine.ui_text_selection_revision;
    if (engine.dom_input) {
        snapshot->dom_event_types = engine.dom_input->event_types;
        snapshot->dom_pointer_elements = engine.dom_input->pointer_elements;
        snapshot->pointer_captures = engine.dom_input->pointer_captures;
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
        for (auto& update : snapshot.canvas_updates)
            engine.ui_elements.at(update.element.value).canvas = std::move(update.state);
        return;
    }
    engine.ui_elements = std::move(snapshot.elements);
    engine.ui_root_children = std::move(snapshot.roots);
    engine.ui_document_roots = snapshot.document_roots;
    engine.ui_host_style_rules = std::move(snapshot.styles);
    engine.ui_style_revision = snapshot.style_revision;
    engine.ui_focused_element = snapshot.focused_element;
    engine.ui_focus_revision = snapshot.focus_revision;
    engine.ui_focus_visible = snapshot.focus_visible;
    engine.ui_text_selection = snapshot.text_selection;
    engine.ui_text_selection_revision = snapshot.text_selection_revision;
    if (snapshot.pointer_captures)
        dom_input(engine).pointer_captures = std::move(snapshot.pointer_captures);
    if (!snapshot.dom_event_types.empty()) {
        auto& input = dom_input(engine);
        input.event_types = std::move(snapshot.dom_event_types);
        input.pointer_elements = std::move(snapshot.dom_pointer_elements);
        input.batch_sink = [post_input](std::shared_ptr<DomEventBatch> batch) {
            auto event = std::make_unique<WindowDomEvent>();
            event->batch = std::move(batch);
            post_input(std::move(event));
        };
        input.pointer_sink = [post_input, &engine](const PlatformMouseEvent& payload) {
            if ((payload.dom->type == "input" || payload.dom->type == "change") &&
                payload.dom->target.kind == DomEventTargetKind::Element) {
                auto event = std::make_unique<WindowEvent>();
                event->element = UiElementHandle{payload.dom->target.element};
                event->type = payload.dom->type;
                event->mouse = payload;
                event->capture_form_state(engine);
                post_input(std::move(event));
                return;
            }
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
            auto& listeners = target.event_callbacks[name];
            listeners = std::make_shared<UiEventListeners>();
            listeners->add([post_input, &engine, element, name](const PlatformMouseEvent& pointer) {
                auto event = std::make_unique<WindowEvent>();
                event->element = element;
                event->type = name;
                event->mouse = pointer;
                if (name == "toggle")
                    event->open = ui_has_attribute(engine, element, "open");
                if (name == "input" || name == "change")
                    event->capture_form_state(engine);
                post_input(std::move(event));
            });
        }
    }
    ++engine.ui_revision;
}

namespace {
/** The periodic document tick: publishes without waiting for the display. */
void tick_document_changes() {
    update_window_document(false);
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
    EventLoop::current().set_timeout(tick_document_changes, 16);
}
} // namespace

void tick_document() {
    // The initial document is on display before the realm continues.
    update_window_document();
    tick_document_changes();
}

#if BBLITE_HAS_PBR_RENDERER
/**
 * A canvas's input for its engine's camera controls, through the dispatcher the standalone
 * drivers use: owned controls (`attachFreeControl` and kin) take pointer and key events first,
 * otherwise the first scene's legacy controls take pointer events.
 */
void dispatch_camera_input(Engine& engine, const SDL_Event& event,
                           WindowDocument::InputTarget& target) {
    CameraRecord* primary = nullptr;
    if (!engine.scenes().empty() && engine.scenes().front()) {
        const auto camera = engine.scenes().front()->camera;
        if (camera.value < engine.cameras.size())
            primary = &handle_at(engine.cameras, camera);
    }
    dispatch_surface_camera_pointer(engine, event, primary, target.camera, target.surfaces);
}
#endif

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
#if BBLITE_HAS_PBR_RENDERER
                dispatch_camera_input(*engine, packet.pointer, target);
#endif
            }
#if BBLITE_HAS_PBR_RENDERER
            target.camera = {};
            target.surfaces = {};
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
    if (event.type == SDL_EVENT_KEY_DOWN || event.type == SDL_EVENT_KEY_UP) {
        // The document's listeners already had the key; the display forwards it to the canvas
        // holding keyboard focus only when neither they nor the retained UI consumed it.
#if BBLITE_HAS_PBR_RENDERER
        dispatch_camera_input(*engine, event, target->second);
#endif
        return;
    }
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
    dispatch_camera_input(*engine, event, target->second);
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
    if (!doc.primary_canvas)
        doc.primary_canvas = entry->first;
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
void window_location_assign(const std::string& target, const std::string& current) {
    const js::Url page(current);
    const js::Url destination(target, &page);
    if (destination.protocol() != page.protocol() || destination.username() != page.username() ||
        destination.password() != page.password() || destination.host() != page.host() ||
        destination.pathname() != page.pathname())
        throw js::make_dom_exception("location.assign navigates only within this document by "
                                     "its query; " +
                                         destination.href() + " is another document.",
                                     "NotSupportedError");
    window_location_set_search(destination.search());
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
bool window_message_box(bool confirm, std::string message) {
    auto& host = *current_document().host;
    auto request = std::make_shared<MessageBoxRequest>();
    request->confirm = confirm;
    request->message = std::move(message);
    std::unique_lock lock(host.mutex);
    if (host.stopping)
        throw WorkerTerminated{};
    host.message_box = request;
    host.wake.notify_all();
    host.wake.wait(lock, [&] {
        return host.stopping || request->answer.has_value() || !request->error.empty();
    });
    if (!request->error.empty())
        throw std::runtime_error(request->error);
    if (!request->answer)
        throw WorkerTerminated{};
    return *request->answer;
}
namespace {
/** Fires `fullscreenchange` at the document's listeners in its own task. */
void queue_fullscreen_change() {
    EventLoop::current().post([] {
        auto& loop = EventLoop::current();
        current_document().fullscreen_listeners.dispatch_with(
            [&](auto& listener) { loop.dispatch_callback([callback = listener] { callback(); }); });
    });
}
/** The display ended page fullscreen: the document fully exits it. */
void exit_page_fullscreen() {
    auto& stack = current_document().fullscreen;
    if (stack.empty())
        return;
    stack.clear();
    queue_fullscreen_change();
}
/**
 * Asks the Window thread for a window state (none keeps it) after earlier requests; `settle`
 * runs on this realm with the platform's failure, empty on success.
 */
void request_window_fullscreen(std::optional<bool> fullscreen,
                               std::function<void(const std::string&)> settle) {
    auto& host = *current_document().host;
    auto& loop = EventLoop::current();
    const auto id = loop.register_completion(
        [settle = std::move(settle)](std::unique_ptr<ExternalEvent> event) {
            const auto* completion = dynamic_cast<const FullscreenRequest*>(event.get());
            if (!completion)
                throw std::logic_error("Incorrect fullscreen completion payload.");
            settle(completion->error);
        });
    try {
        auto request = std::make_unique<FullscreenRequest>(id, fullscreen);
        std::lock_guard lock(host.mutex);
        if (host.stopping)
            throw WorkerTerminated{};
        host.fullscreen_requests.push_back(std::move(request));
    } catch (...) {
        loop.cancel_completion(id);
        throw;
    }
}
} // namespace
js::Promise<js::PromiseVoid> window_request_fullscreen(UiElementHandle element) {
    auto& doc = current_document();
    js::Promise<js::PromiseVoid> result;
    try {
        if (element != ui_document_root(doc.engine, UiDocumentPart::Html) &&
            !(doc.primary_canvas && element.value == *doc.primary_canvas))
            throw js::make_dom_exception(
                "Native fullscreen admits the document element and the primary canvas.",
                "NotSupportedError");
        if (!ui_is_connected(doc.engine, element))
            std::rethrow_exception(
                js::make_error("TypeError", "Fullscreen requires a connected element."));
        request_window_fullscreen(true, [element, result](const std::string& error) {
            if (!error.empty()) {
                result.reject(js::make_error("TypeError", "Fullscreen request failed: " + error));
                return;
            }
            auto& stack = current_document().fullscreen;
            const bool current = !stack.empty() && stack.back() == element;
            if (!current) {
                std::erase(stack, element);
                stack.push_back(element);
            }
            result.resolve(js::PromiseVoid{});
            if (!current)
                queue_fullscreen_change();
        });
    } catch (const WorkerTerminated&) {
        throw;
    } catch (...) {
        result.reject(std::current_exception());
    }
    return result;
}
js::Promise<js::PromiseVoid> window_exit_fullscreen() {
    auto& doc = current_document();
    js::Promise<js::PromiseVoid> result;
    try {
        if (doc.fullscreen.empty())
            std::rethrow_exception(js::make_error("TypeError", "Document not active"));
        // Below the top element the window stays fullscreen.
        const bool nested = doc.fullscreen.size() > 1;
        request_window_fullscreen(nested ? std::nullopt : std::optional(false),
                                  [nested, result](const std::string& error) {
                                      auto& stack = current_document().fullscreen;
                                      const bool changed = !stack.empty();
                                      if (nested && changed)
                                          stack.pop_back();
                                      else
                                          stack.clear();
                                      if (error.empty())
                                          result.resolve(js::PromiseVoid{});
                                      else
                                          result.reject(js::make_error(
                                              "TypeError", "Leaving fullscreen failed: " + error));
                                      if (changed)
                                          queue_fullscreen_change();
                                  });
    } catch (const WorkerTerminated&) {
        throw;
    } catch (...) {
        result.reject(std::current_exception());
    }
    return result;
}
js::Nullable<UiElementHandle> window_fullscreen_element() {
    const auto& stack = current_document().fullscreen;
    return stack.empty() ? js::Nullable<UiElementHandle>()
                         : js::Nullable<UiElementHandle>(stack.back());
}
bool window_on_fullscreen_change(std::uint64_t identity, js::Callback<void()> callback, bool once,
                                 ListenerLeasePtr lease) {
    return current_document().fullscreen_listeners.add(identity, std::move(callback), once,
                                                       std::move(lease));
}
void window_off_fullscreen_change(std::uint64_t identity) {
    current_document().fullscreen_listeners.remove(identity);
}
bool window_on_application_error(bool rejection, std::uint64_t identity,
                                 ApplicationErrors::Callback callback, bool once,
                                 ListenerLeasePtr lease) {
    return current_document().errors->add(rejection, identity, std::move(callback), once,
                                          std::move(lease));
}
void window_off_application_error(bool rejection, std::uint64_t identity) {
    current_document().errors->remove(rejection, identity);
}
void update_window_document(bool wait) {
    auto& doc = current_document();
    auto& host = *doc.host;
    const auto await_display = [&host](std::unique_lock<std::mutex>& lock, std::uint64_t revision) {
        host.wake.wait(lock, [&] { return host.stopping || host.completed >= revision; });
        if (host.stopping)
            throw WorkerTerminated{};
    };
    // One snapshot is applied at a time, since a text-only snapshot is a delta
    // over the one before it. Without waiting, changes stay unpublished until
    // the display has applied that earlier snapshot.
    bool publish = true;
    {
        std::unique_lock lock(host.mutex);
        if (host.stopping)
            throw WorkerTerminated{};
        if (host.completed < host.requested) {
            if (wait)
                await_display(lock, host.requested);
            else
                publish = false;
        }
    }
    // Snapshot source state on its owner before taking the presentation lock.
    const auto input_revision = doc.engine.dom_input ? doc.engine.dom_input->revision : 0;
    const auto text_since =
        doc.published_input_revision == input_revision &&
                doc.published_focus_revision == doc.engine.ui_focus_revision &&
                doc.published_text_selection_revision == doc.engine.ui_text_selection_revision &&
                doc.engine.ui_only_text_changed_since(doc.published_revision,
                                                      doc.published_text_revision)
            ? std::optional(doc.published_text_revision)
            : std::nullopt;
    auto snapshot =
        publish && (doc.published_revision != doc.engine.ui_revision ||
                    doc.published_input_revision != input_revision ||
                    doc.published_canvas_revision != doc.engine.ui_canvas_revision ||
                    doc.published_focus_revision != doc.engine.ui_focus_revision ||
                    doc.published_text_selection_revision != doc.engine.ui_text_selection_revision)
            ? snapshot_document(doc.engine, text_since, doc.published_canvas_revision)
            : nullptr;
    std::unique_lock lock(host.mutex);
    if (host.stopping)
        throw WorkerTerminated{};
    if (snapshot) {
        host.pending = std::move(snapshot);
        const auto revision = ++host.requested;
        doc.published_revision = doc.engine.ui_revision;
        doc.published_text_revision = doc.engine.ui_text_revision;
        doc.published_canvas_revision = doc.engine.ui_canvas_revision;
        doc.published_focus_revision = doc.engine.ui_focus_revision;
        doc.published_text_selection_revision = doc.engine.ui_text_selection_revision;
        doc.published_input_revision = input_revision;
        host.wake.notify_all();
        if (wait)
            await_display(lock, revision);
    }
    const auto layout = host.layout;
    lock.unlock();
    if (doc.layout != layout && layout) {
        doc.layout = layout;
        for (std::size_t index = 0;
             index < layout->rectangles.size() && index < doc.engine.ui_elements.size(); ++index) {
            doc.engine.ui_elements[index].client_rect = layout->rectangles[index];
            doc.engine.ui_elements[index].content_box = layout->content_boxes[index];
            doc.engine.ui_elements[index].computed_style = layout->styles[index];
            doc.engine.ui_elements[index].pointer_states = layout->pointer_states[index];
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
namespace {
std::shared_ptr<const LayoutSnapshot> window_host_layout() {
    auto& doc = current_document();
    {
        const std::lock_guard lock(doc.host->mutex);
        if (doc.host->stopping)
            throw WorkerTerminated{};
        // Display metrics do not depend on pending DOM or canvas writes.
        // Leave doc.layout adoption to update_window_document, which also
        // propagates rectangles and canvas sizes to the owning realm.
        if (doc.host->layout)
            return doc.host->layout;
    }
    // The first read still needs the host's initial layout and display scale.
    update_window_document();
    return doc.layout;
}
} // namespace

double window_device_pixel_ratio() {
    const auto layout = window_host_layout();
    return layout ? layout->pixel_ratio : 1;
}
InputCapabilities window_input_capabilities() {
    const auto layout = window_host_layout();
    if (!layout)
        throw std::logic_error("Window input has no layout snapshot.");
    return layout->input;
}
UiClientRect window_viewport_size() {
    const auto layout = window_host_layout();
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
namespace {
void adopt_window_pointer_states() {
    auto& doc = current_document();
    std::shared_ptr<const LayoutSnapshot> layout;
    {
        const std::lock_guard lock(doc.host->mutex);
        if (doc.host->stopping)
            throw WorkerTerminated{};
        layout = doc.host->layout;
    }
    // Only pointer states: rectangles and styles still adopt with their
    // published document in update_window_document.
    for (std::size_t index = 0;
         layout && index < layout->pointer_states.size() && index < doc.engine.ui_elements.size();
         ++index)
        doc.engine.ui_elements[index].pointer_states = layout->pointer_states[index];
}
} // namespace
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
    box.offset_width /= layout->pixel_ratio;
    box.offset_height /= layout->pixel_ratio;
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
    doc.update_capture_ready();
    handle_at(doc.engine.ui_elements, element).external_gpu_canvas = true;
    ++doc.engine.ui_revision;
    {
        std::lock_guard lock(doc.host->mutex);
        doc.host->canvases.emplace(element.value, std::move(endpoint));
    }
    return canvas;
}
void window_defer_capture_until_canvas_ready() {
    auto& doc = current_document();
    doc.wait_for_canvas_ready = true;
    doc.update_capture_ready();
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
void MutationObserver::observe(UiElementHandle element,
                               std::optional<std::vector<std::string>> filter) {
    if (observed_.empty()) {
        auto owner = self_.lock();
        if (!owner)
            throw std::logic_error("MutationObserver requires its Window realm factory.");
        current_document().mutation_observers.push_back(std::move(owner));
    }
    observed_.insert_or_assign(element.value, std::move(filter));
}
void MutationObserver::disconnect() {
    observed_.clear();
    pending_ = false;
    std::erase_if(current_document().mutation_observers,
                  [this](const auto& observer) { return observer.get() == this; });
}
void MutationObserver::notify(UiElementHandle element, const std::string& attribute) {
    const auto entry = observed_.find(element.value);
    if (entry == observed_.end() ||
        (entry->second && std::find(entry->second->begin(), entry->second->end(), attribute) ==
                              entry->second->end()) ||
        pending_)
        return;
    pending_ = true;
    EventLoop::current().queue_microtask([weak = self_] {
        if (auto owner = weak.lock(); owner && owner->pending_) {
            owner->pending_ = false;
            EventLoop::current().dispatch_callback(owner->callback_);
        }
    });
}
std::shared_ptr<MutationObserver> create_mutation_observer(MutationObserver::Callback callback) {
    auto observer = js::make_gc_shared<MutationObserver>(std::move(callback));
    observer->self_ = observer;
    return observer;
}
std::shared_ptr<MediaQueryList> create_media_query(std::string query) {
    auto media =
        js::make_gc_shared<MediaQueryList>(std::move(query), window_device_pixel_ratio,
                                           system_reduced_motion, window_input_capabilities);
    current_document().media.push_back(media);
    return media;
}

static Iteration<int> window_application_iterations(WorkerEntry initialize, EngineOptions options) {
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
        // The final screenshot counts engine frames under engine-frame
        // capture, presented frames otherwise; checkpoints count the same.
        const long final_frame = capture_frame_count ? static_cast<long>(capture_frame_count - 1)
                                                     : std::max(0L, frame_options.screenshot_frame);
        const auto screenshot_checkpoints = window_screenshot_checkpoints(
            environment_variable("BBLITE_SCREENSHOT_FRAMES"), frame_options, final_frame);
        for (const auto& checkpoint : screenshot_checkpoints) {
            std::filesystem::remove(detail::utf8_file_path(checkpoint.path));
            std::filesystem::remove(detail::utf8_file_path(checkpoint.path + ".build-stamp"));
        }
        if (!SDL_Init(SDL_INIT_VIDEO | SDL_INIT_EVENTS))
            throw std::runtime_error(SDL_GetError());
        struct Quit {
            ~Quit() {
                if (!active_sdl_application)
                    SDL_Quit();
            }
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
#if BBLITE_HAS_AUDIO
            // SDL initializes audio on this, its main thread, once for the run:
            // right after the application realm starts, whose device opens wait for it.
            audio_announce_subsystem();
#endif
            std::thread application([&] {
                try {
                    const js::RealmScope state;
                    EventLoop loop(services->inbox);
#if !BBLITE_HAS_ENGINE
                    // No engine startup will select this realm's capture clock.
                    if (frame_options.frame_delta_ms > 0)
                        loop.use_fixed_animation_time(frame_options.frame_delta_ms);
#endif
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
                        if (const auto* visibility =
                                dynamic_cast<WindowVisibilityEvent*>(packet.get())) {
                            EventLoop::current().dispatch_callback([&] {
                                set_document_hidden(window_document_engine(), visibility->hidden);
                            });
                            return;
                        }
                        if (dynamic_cast<WindowFullscreenExit*>(packet.get())) {
                            exit_page_fullscreen();
                            return;
                        }
                        // Acknowledge document input however its dispatch ends,
                        // so the display can finish any pending input wait.
                        const auto handled = js::finally([&] {
                            {
                                const std::lock_guard lock(services->mutex);
                                ++services->input_handled;
                            }
                            services->wake.notify_all();
                        });
                        if (const auto* focus = dynamic_cast<WindowFocusEvent*>(packet.get())) {
                            ui_record_focus(window_document_engine(), focus->element,
                                            focus->visible);
                            return;
                        }
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
                        if (event->mouse.dom) {
                            dom_input(engine).pointer.dispatch(
                                event->mouse,
                                [](auto& callback, const auto& payload) {
                                    EventLoop::current().dispatch_callback(
                                        [&] { callback(payload); });
                                },
                                &engine);
                            return;
                        }
                        const auto& record = handle_at(engine.ui_elements, event->element);
                        if (event->type == "click") {
                            const auto callbacks = record.click_callbacks;
                            for (const auto& callback : callbacks)
                                EventLoop::current().dispatch_callback(callback);
                        } else if (const auto found = record.event_callbacks.find(event->type);
                                   found != record.event_callbacks.end()) {
                            const auto listeners = found->second;
                            listeners->dispatch_with(
                                [](auto& callback, const PlatformMouseEvent& pointer) {
                                    EventLoop::current().dispatch_callback(
                                        [&] { callback(pointer); });
                                },
                                event->mouse);
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
                            dispatch_page_lifecycle(
                                window_document_engine(), [&](auto& callback, const auto& payload) {
                                    loop.dispatch_callback([&] { callback(payload); });
                                });
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
#if BBLITE_HAS_AUDIO
            audio_initialize_subsystem();
#endif
            std::unordered_map<std::uint32_t, OffscreenFrame> latest;
            PageFullscreen page_fullscreen;
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
            // The canvas a primary press last reached holds keyboard focus, as the pinned
            // controls' tabindex lets a pressed canvas take it; a press elsewhere takes it
            // away. A released key goes where its press went.
            UiElementHandle keyboard_canvas{};
            std::map<SDL_Scancode, UiElementHandle> held_keys;
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
                if (SDL_HasMouse()) {
                    next_layout.input = {PointerPrecision::Fine, true};
                } else {
                    int count = 0;
                    auto* touches = SDL_GetTouchDevices(&count);
                    if (!touches)
                        throw std::runtime_error(std::string("SDL_GetTouchDevices: ") +
                                                 SDL_GetError());
                    SDL_free(touches);
                    next_layout.input = {
                        count > 0 ? PointerPrecision::Coarse : PointerPrecision::None, false};
                }
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
                next_layout.content_boxes.resize(display.ui_elements.size());
                next_layout.styles.resize(display.ui_elements.size());
                next_layout.pointer_states.resize(display.ui_elements.size());
                for (std::size_t index = 0; index < display.ui_elements.size(); ++index) {
                    next_layout.rectangles[index] = display.ui_elements[index].client_rect;
                    next_layout.content_boxes[index] = display.ui_elements[index].content_box;
                    next_layout.styles[index] = display.ui_elements[index].computed_style;
                    next_layout.pointer_states[index] = display.ui_elements[index].pointer_states;
                }
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
            // A listener's alert or confirm waits on this thread too.
            const auto await_input = [&] {
                for (;;) {
                    std::unique_lock lock(services->mutex);
                    services->wake.wait(lock, [&] {
                        return services->input_handled == services->input_posted || finished ||
                               services->pending || services->message_box;
                    });
                    if (services->input_handled == services->input_posted || finished)
                        return;
                    const bool message_box = services->message_box != nullptr;
                    lock.unlock();
                    if (message_box)
                        serve_message_box(*services, window.get());
                    else if (!update_layout())
                        SDL_Delay(1);
                }
            };
            long presented = 0;
            bool final_screenshot_saved = false;
            auto next_checkpoint = screenshot_checkpoints.begin();
            const bool trace_window =
                runtime_trace_enabled() || environment_variable("BBLITE_WINDOW_TRACE") == "1";
            std::optional<EventLoop::Clock::time_point> next_repaint;
            std::optional<AnimationFrameSource::Batch> repaint_batch;
            bool running = true;
            while (running && !finished) {
                co_yield true;
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
                serve_message_box(*services, window.get());
                serve_fullscreen_requests(*services, window.get(), page_fullscreen);
                SDL_Event event;
                for (;;) {
                    if (!poll_sdl_event(&event))
                        break;
                    if (is_emulated_pointer_event(event))
                        continue;
                    if (event.type == SDL_EVENT_QUIT ||
                        event.type == SDL_EVENT_WINDOW_CLOSE_REQUESTED)
                        running = false;
                    if (frame_options.test_pass && is_platform_input_event(event) &&
                        !is_replayed_ui_event(event))
                        continue;
                    if (end_page_fullscreen(*services, window.get(), page_fullscreen, event))
                        continue;
                    end_press_mouse_capture(event);
                    // Mouse motion has no cancelable native default. Keep its
                    // source callbacks ordered in the realm mailbox without
                    // making worker presentation wait for a busy Window realm.
                    const bool move = event.type == SDL_EVENT_MOUSE_MOTION;
                    if (auto batch = prepare_dom_platform_input(display, event)) {
                        // The script's listeners decide the native default.
                        dispatch_dom_batch(display, batch);
                        if (!move)
                            await_input();
                        if (finished)
                            break;
                        if (!move && batch->default_prevented) {
                            end_withheld_ui_press(display, event);
                            continue;
                        }
                    }
                    const auto focused = display.ui_focused_element;
                    const bool focus_visible = display.ui_focus_visible;
                    const bool reaches_canvas = handle_ui_rml_event(*ui, event);
                    if (display.ui_focused_element != focused ||
                        display.ui_focus_visible != focus_visible) {
                        auto focus = std::make_unique<WindowFocusEvent>();
                        focus->element = display.ui_focused_element;
                        focus->visible = display.ui_focus_visible;
                        services->post_input(std::move(focus));
                    }
                    // Complete synchronous native-default transactions,
                    // including any click, input or change events they posted.
                    if (!move)
                        await_input();
                    if (finished)
                        break;
                    if (const auto hidden = window_visibility(event)) {
                        auto packet = std::make_unique<WindowVisibilityEvent>();
                        packet->hidden = *hidden;
                        services->inbox->post(std::move(packet));
                    }
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
                    if (event.type == SDL_EVENT_KEY_DOWN || event.type == SDL_EVENT_KEY_UP) {
                        UiElementHandle target{};
                        if (event.type == SDL_EVENT_KEY_UP) {
                            if (const auto held = held_keys.find(event.key.scancode);
                                held != held_keys.end()) {
                                target = held->second;
                                held_keys.erase(held);
                            }
                        } else if (reaches_canvas && keyboard_canvas.value != invalid_handle) {
                            target = keyboard_canvas;
                            held_keys.insert_or_assign(event.key.scancode, target);
                        }
                        if (target.value != invalid_handle) {
                            auto packet = std::make_unique<WindowPointerEvent>();
                            packet->element = target;
                            packet->pointer = event;
                            services->inbox->post(std::move(packet));
                        }
                        continue;
                    }
                    const bool down = event.type == SDL_EVENT_MOUSE_BUTTON_DOWN;
                    const bool up = event.type == SDL_EVENT_MOUSE_BUTTON_UP;
                    const bool wheel = event.type == SDL_EVENT_MOUSE_WHEEL;
                    if (down && event.button.button == SDL_BUTTON_LEFT)
                        keyboard_canvas = {};
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
                        if (event.button.button == SDL_BUTTON_LEFT)
                            keyboard_canvas = target;
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
                    if ((frame_options.max_frames > 0 || !frame_options.screenshot_path.empty()) &&
                        !services->capture_failure.empty())
                        throw std::runtime_error("Source canvas initialization failed: " +
                                                 services->capture_failure);
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
                const bool source_ready =
                    services->capture_ready->load() &&
                    monotonic_milliseconds() - services->capture_ready_since.load() >=
                        services->capture_settle_milliseconds.load() &&
                    std::all_of(frames.begin(), frames.end(),
                                [](const auto& canvas) { return canvas.frame.capture_ready; });
                // Engine frames every canvas has rendered, or presented
                // frames without engine-frame capture or canvases.
                const bool engine_count = capture_frame_count && !frames.empty();
                const std::uint64_t engine_frames =
                    engine_count
                        ? std::min_element(frames.begin(), frames.end(),
                                           [](const auto& left, const auto& right) {
                                               return left.frame.sequence < right.frame.sequence;
                                           })
                              ->frame.sequence
                        : 0;
                const auto frame_reached = [&](long frame) {
                    return engine_count ? engine_frames > static_cast<std::uint64_t>(frame)
                                        : presented >= frame;
                };
                const bool capture_ready = !final_screenshot_saved && frame_reached(final_frame);
                const bool checkpoint_ready = next_checkpoint != screenshot_checkpoints.end() &&
                                              frame_reached(next_checkpoint->frame);
                const bool capture = canvases_ready && source_ready &&
                                     !frame_options.screenshot_path.empty() &&
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
                        screenshot_path = checkpoint_ready ? next_checkpoint->path
                                                           : frame_options.screenshot_path;
                    const double present_started = cpu_profile ? monotonic_milliseconds() : 0;
                    did_present = presenter->present(
                        frames, canvas_capture ? *canvas_capture : recorded, screenshot_path);
                    if (cpu_profile)
                        present_ms = monotonic_milliseconds() - present_started;
                    if (did_present && capture && checkpoint_ready) {
                        const std::string_view stamp = bblite_build_stamp();
                        detail::write_file_atomically(
                            detail::utf8_file_path(next_checkpoint->path + ".build-stamp"), stamp,
                            stamp.size(), "Screenshot checkpoint build stamp");
                        ++next_checkpoint;
                    }
                    if (did_present && capture && !checkpoint_ready)
                        final_screenshot_saved = true;
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
                    if (capture_frame_count ? final_screenshot_saved
                                            : source_ready && frame_options.frame_budget() > 0 &&
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
                co_return 0;
            // The reloaded document starts outside fullscreen.
            if (const auto error = page_fullscreen.leave(window.get()); !error.empty())
                throw std::runtime_error("Leaving page fullscreen failed: " + error);
            location->commit_reload();
        }
    } catch (...) {
        co_return report_uncaught_error(std::current_exception());
    }
}
int run_window_application(WorkerEntry initialize, EngineOptions options) {
    try {
        return run_sdl_application(window_application_iterations(initialize, std::move(options)),
                                   read_frame_options().interactive());
    } catch (...) {
        return report_uncaught_error(std::current_exception());
    }
}
} // namespace bbl::pal
