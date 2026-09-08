#pragma once

#include <bblite/pal_canvas.hpp>
#include <bblite/pal_worker.hpp>
#include <bblite/pal_ui.hpp>

namespace bbl::pal {

/** Window APIs are owned by the application realm. Their native compositor
 * consumes immutable snapshots and never accesses these objects or callbacks. */
Engine& window_document_engine();
void update_window_document();
double window_device_pixel_ratio();
UiClientRect window_element_size(UiElementHandle element);
std::shared_ptr<CanvasElement> window_canvas(UiElementHandle element);

class ResizeObserver {
  public:
    using Callback = js::Callback<void()>;
    explicit ResizeObserver(Callback callback) : callback_(std::move(callback)) {}
    void observe(UiElementHandle element);
    void unobserve(UiElementHandle element);
    void disconnect();
    void deliver();
    void gc_trace(const js::TraceVisitor& visitor) const { visitor(callback_); }
  private:
    friend std::shared_ptr<ResizeObserver> create_resize_observer(Callback callback);
    // Managed aliases are allocated inside a GC block, so std::enable_shared_from_this
    // cannot discover their control block. The factory supplies this weak identity.
    std::weak_ptr<ResizeObserver> self_;
    Callback callback_;
    std::unordered_map<std::uint32_t, UiClientRect> observed_;
};

class MediaQueryList {
  public:
    explicit MediaQueryList(std::string query);
    void add_change_listener(js::Callback<void()> callback);
    void deliver();
    /**
     * Whether the document must keep this list alive on the script's
     * behalf: a `matchMedia` result that registered a change listener stays
     * reachable through the window, as it does in a browser, while one the
     * script dropped without listening is retired at the next tick.
     */
    [[nodiscard]] bool retained() const noexcept { return !listeners_.empty(); }
    void gc_trace(const js::TraceVisitor& visitor) const { visitor(listeners_); }
  private:
    double resolution_ = 0;
    bool matches_ = false;
    PlatformEventListeners<void()> listeners_;
};

std::shared_ptr<ResizeObserver> create_resize_observer(ResizeObserver::Callback callback);
std::shared_ptr<MediaQueryList> create_media_query(std::string query);
int run_window_application(WorkerEntry initialize, EngineOptions options);

} // namespace bbl::pal
