#pragma once

#if !defined(BBLITE_WORKERS) || !BBLITE_WORKERS
#error Worker runtime requires BBLITE_WORKERS for isolated JavaScript state.
#endif

#include <bblite/js_structured_clone.hpp>
#include <bblite/pal_event_loop.hpp>
#include <bblite/pal_host_services.hpp>
#include <bblite/pal_animation_frame.hpp>
#include <bblite/runtime.hpp>

#include <iostream>

namespace bbl::pal {

class WorkerRealm;
using WorkerEntry = void (*)(WorkerRealm&);

/** One event and one deserialization memo, shared by all recipient listeners. */
class WorkerMessageEvent {
  public:
    explicit WorkerMessageEvent(SerializedMessage message) : reader_(std::move(message)) {}
    template <typename T> T data() { return js::clone_read<T>(reader_, reader_.root()); }
  private:
    CloneReader reader_;
};
using WorkerMessage = std::shared_ptr<WorkerMessageEvent>;

struct WorkerErrorEvent {
    std::string message;
    std::string filename;
    unsigned line = 0;
    unsigned column = 0;
    bool default_prevented = false;
    void prevent_default() { default_prevented = true; }
};

namespace worker_detail {
struct Address {
    std::shared_ptr<EventLoop::Inbox> inbox;
    std::uint64_t target = 0;
};
struct Packet final : ExternalEvent {
    using Contents = std::variant<SerializedMessage, WorkerErrorEvent, std::monostate>;
    Packet(std::uint64_t target, Contents contents) : target(target), contents(std::move(contents)) {}
    std::uint64_t target;
    Contents contents;
};
inline void post(const Address& address, Packet::Contents contents) {
    address.inbox->post(std::make_unique<Packet>(address.target, std::move(contents)));
}
} // namespace worker_detail

/** Parent-realm object. Its callback state is never captured by the worker thread. */
class Worker {
  public:
    using MessageCallback = js::Callback<void(const WorkerMessage&)>;
    using ErrorCallback = js::Callback<void(WorkerErrorEvent&)>;
    explicit Worker(std::shared_ptr<EventLoop::Inbox> inbox)
        : inbox_(std::move(inbox)), owner_(std::this_thread::get_id()) {}
    ~Worker() {
        terminate();
        if (thread_.joinable()) thread_.join();
    }
    void post_message(SerializedMessage message) {
        require_owner();
        worker_detail::post({inbox_, 0}, std::move(message));
    }
    void terminate() { inbox_->terminate(); }
    void add_message_listener(MessageCallback callback, bool once = false) {
        require_owner();
        message_listeners_.add(callback.identity(), std::move(callback), once);
    }
    void remove_message_listener(const MessageCallback& callback) {
        require_owner(); message_listeners_.remove(callback.identity());
    }
    void add_error_listener(ErrorCallback callback, bool once = false) {
        require_owner(); error_listeners_.add(callback.identity(), std::move(callback), once);
    }
    void remove_error_listener(const ErrorCallback& callback) {
        require_owner(); error_listeners_.remove(callback.identity());
    }
    void gc_trace(const js::TraceVisitor& visitor) const { visitor(message_listeners_); visitor(error_listeners_); }

  private:
    friend class WorkerRealm;
    void require_owner() const {
        if (owner_ != std::this_thread::get_id()) throw std::logic_error("Worker object crossed realm ownership.");
    }
    void message(EventLoop& loop, SerializedMessage value) {
        auto event = std::make_shared<WorkerMessageEvent>(std::move(value));
        dispatch_platform_event(loop, message_listeners_, event);
    }
    bool error(EventLoop& loop, WorkerErrorEvent& event) {
        dispatch_platform_event(loop, error_listeners_, event);
        return event.default_prevented;
    }
    std::shared_ptr<EventLoop::Inbox> inbox_;
    std::thread::id owner_;
    std::thread thread_;
    PlatformEventListeners<void(const WorkerMessage&)> message_listeners_;
    PlatformEventListeners<void(WorkerErrorEvent&)> error_listeners_;
};

/** Platform services for one source realm, including computation-only workers. */
class WorkerRealm {
  public:
    explicit WorkerRealm(EventLoop& loop, std::string name = {}, std::shared_ptr<HostServices> services = {})
        : WorkerRealm(loop, std::move(name), std::nullopt, std::move(services)) {}
    WorkerRealm(const WorkerRealm&) = delete;
    WorkerRealm& operator=(const WorkerRealm&) = delete;
    ~WorkerRealm() {
        for (auto& [id, worker] : workers_) { static_cast<void>(id); worker->terminate(); }
        for (auto& [id, worker] : workers_) {
            static_cast<void>(id);
            if (worker->thread_.joinable()) worker->thread_.join();
        }
        loop_.on_event({});
        loop_.on_error({});
        current_ = nullptr;
    }
    static WorkerRealm& current() {
        if (!current_) throw std::logic_error("No current Worker realm.");
        return *current_;
    }
    EventLoop& loop() { return loop_; }
    const std::string& name() const { return name_; }
    const std::shared_ptr<HostServices>& host_services() const { return host_services_; }

    EventLoop::AnimationFrameId request_animation_frame(EventLoop::AnimationCallback callback) {
        require_owner();
        if (!animation_subscribed_) {
            const auto frames = host_services_ ? host_services_->animation_frame_source() : nullptr;
            if (!frames) throw std::runtime_error("Animation frames require an owner Window's repaint source.");
            frames->subscribe(loop_.inbox());
            animation_subscribed_ = true;
        }
        return loop_.request_animation_frame(std::move(callback));
    }


    std::shared_ptr<Worker> create_worker(WorkerEntry entry, std::string name = {}) {
        require_owner();
        if (!entry) throw std::invalid_argument("Worker module entry is missing.");
        const auto id = next_worker_++;
        auto inbox = std::make_shared<EventLoop::Inbox>();
        // Allocate a traced parent object before starting the thread.
        auto worker = js::make_gc_shared<Worker>(inbox);
        workers_.emplace(id, worker);
        const worker_detail::Address parent{loop_.inbox(), id};
        const auto origin = EventLoop::Clock::now();
        try {
            worker->thread_ = std::thread([inbox, parent, entry, name = std::move(name), origin, services = host_services_] {
                try {
                    const js::RealmScope state;
                    EventLoop loop(inbox, origin);
                    WorkerRealm realm(loop, name, parent, services);
                    loop.run([&] { entry(realm); });
                } catch (const WorkerTerminated&) {
                } catch (const std::exception& error) {
                    worker_detail::post(parent, WorkerErrorEvent{error.what(), {}, 0, 0, false});
                } catch (...) {
                    worker_detail::post(parent, WorkerErrorEvent{"Unhandled native worker failure", {}, 0, 0, false});
                }
                worker_detail::post(parent, std::monostate{});
            });
        } catch (...) {
            workers_.erase(id);
            throw;
        }
        return worker;
    }

    void add_message_listener(Worker::MessageCallback callback, bool once = false) {
        require_owner(); messages_.add(callback.identity(), std::move(callback), once);
    }
    void remove_message_listener(const Worker::MessageCallback& callback) {
        require_owner(); messages_.remove(callback.identity());
    }
    void post_message(SerializedMessage message) {
        require_owner();
        if (!parent_) throw std::logic_error("The application realm has no parent worker channel.");
        worker_detail::post(*parent_, std::move(message));
    }
    void close() { loop_.close(); }
    void on_platform_event(EventLoop::EventHandler callback) { require_owner(); platform_handler_ = std::move(callback); }

  private:
    WorkerRealm(EventLoop& loop, std::string name, std::optional<worker_detail::Address> parent, std::shared_ptr<HostServices> services)
        : loop_(loop), name_(std::move(name)), parent_(std::move(parent)), owner_(std::this_thread::get_id()), host_services_(std::move(services)) {
        if (!js::realm_state.active) throw std::logic_error("Worker services require an active JavaScript realm.");
        if (current_) throw std::logic_error("Two Worker service owners cannot share a realm.");
        current_ = this;
        loop_.on_event([this](std::unique_ptr<ExternalEvent> event) { deliver(std::move(event)); });
        loop_.on_error([this](std::exception_ptr error) { report(error); });
    }
    void require_owner() const {
        if (owner_ != std::this_thread::get_id()) throw std::logic_error("Worker services crossed realm ownership.");
    }
    void report(std::exception_ptr error) {
        try { std::rethrow_exception(error); }
        catch (const WorkerTerminated&) { throw; }
        catch (const std::exception& problem) {
            WorkerErrorEvent event{problem.what(), {}, 0, 0, false};
            if (parent_) worker_detail::post(*parent_, std::move(event));
            else std::cerr << "Uncaught application error: " << event.message << '\n';
        }
    }
    void deliver(std::unique_ptr<ExternalEvent> external) {
        auto* packet = dynamic_cast<worker_detail::Packet*>(external.get());
        if (!packet) {
            if (!platform_handler_) throw std::logic_error("Unknown realm platform event.");
            const auto handler = platform_handler_;
            handler(std::move(external));
            return;
        }
        if (packet->target == 0) {
            auto* message = std::get_if<SerializedMessage>(&packet->contents);
            if (!message) throw std::logic_error("Invalid parent-to-worker packet.");
            auto event = std::make_shared<WorkerMessageEvent>(std::move(*message));
            dispatch_platform_event(loop_, messages_, event);
            return;
        }
        const auto found = workers_.find(packet->target);
        if (found == workers_.end()) return;
        const auto worker = found->second;
        if (std::holds_alternative<std::monostate>(packet->contents)) {
            if (worker->thread_.joinable()) worker->thread_.join();
            workers_.erase(found);
            return;
        }
        if (worker->inbox_->terminated()) return;
        if (auto* message = std::get_if<SerializedMessage>(&packet->contents)) worker->message(loop_, std::move(*message));
        else if (auto* error = std::get_if<WorkerErrorEvent>(&packet->contents)) {
            if (!worker->error(loop_, *error)) {
                if (parent_) worker_detail::post(*parent_, std::move(*error));
                else std::cerr << "Uncaught worker error: " << error->message << '\n';
            }
        }
        js::collect_at_frame_boundary();
    }

    EventLoop& loop_;
    inline static thread_local WorkerRealm* current_ = nullptr;
    std::string name_;
    std::optional<worker_detail::Address> parent_;
    std::thread::id owner_;
    std::shared_ptr<HostServices> host_services_;
    bool animation_subscribed_ = false;
    std::uint64_t next_worker_ = 1;
    std::map<std::uint64_t, std::shared_ptr<Worker>> workers_;
    PlatformEventListeners<void(const WorkerMessage&)> messages_;
    EventLoop::EventHandler platform_handler_;
};

} // namespace bbl::pal
