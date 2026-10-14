#pragma once

#include <bblite/pal_canvas.hpp>
#include <bblite/pal_worker.hpp>
#include <bblite/pal_ui.hpp>
#include <bblite/pal_window_objects.hpp>
#include <bblite/pal_application_errors.hpp>
#include <bblite/js_promise.hpp>

namespace bbl::pal {

/** Window APIs are owned by the application realm. Their native compositor
 * consumes immutable snapshots and never accesses these objects or callbacks. */
Engine& window_document_engine();
const void* window_document_identity();
js::Promise<js::PromiseVoid> window_clipboard_write(std::string text);
/**
 * `alert(message)` (`confirm` false) and `confirm(message)`: a modal SDL message box on the
 * Window thread, parented to the window, blocking this realm until it closes. True when the
 * user accepted a confirmation.
 */
bool window_message_box(bool confirm, std::string message);
/**
 * `element.requestFullscreen()` for the document element or the primary canvas: the window
 * goes fullscreen, then the promise settles and a `fullscreenchange` task follows. Another
 * element rejects with NotSupportedError; a window that cannot go fullscreen, with TypeError.
 */
js::Promise<js::PromiseVoid> window_request_fullscreen(UiElementHandle element);
/** `document.exitFullscreen()`: TypeError without a fullscreen element. */
js::Promise<js::PromiseVoid> window_exit_fullscreen();
js::Nullable<UiElementHandle> window_fullscreen_element();
/** `fullscreenchange` listeners of the document; false for a duplicate listener. */
bool window_on_fullscreen_change(std::uint64_t identity, js::Callback<void()> callback, bool once,
                                 ListenerLeasePtr lease = {});
void window_off_fullscreen_change(std::uint64_t identity);
void window_location_reload();
std::string window_location_search(const std::string& initial);
void window_location_set_search(const std::string& value);
/**
 * `location.assign(target)` resolved against `current` (the document's href): a URL naming this
 * document (same scheme, credentials, host, port and path) navigates to its query, as setting
 * `location.search` does; another document throws a NotSupportedError DOMException.
 */
void window_location_assign(const std::string& target, const std::string& current);
/** Publish document changes to the display; `wait` also adopts the layout it computes for them. */
void update_window_document(bool wait = true);
double window_device_pixel_ratio();
UiClientRect window_viewport_size();
struct ScreenMetrics {
    double width = 0, height = 0, available_width = 0, available_height = 0, color_depth = 0;
    bool operator==(const ScreenMetrics&) const = default;
};
ScreenMetrics window_screen_metrics();
InputCapabilities window_input_capabilities();
const void* window_screen_identity();
UiClientRect window_element_size(UiElementHandle element);
/** False for a duplicate listener. */
bool window_on_application_error(bool rejection, std::uint64_t identity,
                                 ApplicationErrors::Callback callback, bool once,
                                 ListenerLeasePtr lease = {});
void window_off_application_error(bool rejection, std::uint64_t identity);
std::shared_ptr<CanvasElement> window_canvas(UiElementHandle element);
/** The source's canvas readiness marker gates measured capture, never rendering. */
void window_defer_capture_until_canvas_ready();

int run_window_application(WorkerEntry initialize, EngineOptions options);

} // namespace bbl::pal
