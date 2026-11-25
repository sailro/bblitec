#pragma once

#include <bblite/features/workers.hpp>

#if !BBLITE_WORKERS
#error Worker runtime requires BBLITE_WORKERS for isolated JavaScript state.
#endif

#include <bblite/js_accessor.hpp>
#include <bblite/js_structured_clone.hpp>
#include <bblite/js_promise.hpp>
#include <bblite/js_generator.hpp>
#include <bblite/js_gpu_adapter.hpp>
#include <bblite/pal_event_loop.hpp>
#include <bblite/pal_host_services.hpp>
#include <bblite/pal_animation_frame.hpp>
#include <bblite/runtime.hpp>
#include <bblite/uncaught_error.hpp>

#include <array>
#include <cstdint>
#include <deque>
#include <iostream>
#include <mutex>
#include <span>

namespace bbl::pal {

class WorkerRealm;
using WorkerEntry = void (*)(WorkerRealm&);

/** The global's host accessors a program redefines (`src/compiler/host-globals.ts`). */
enum class HostAccessor : std::uint8_t { device_pixel_ratio, count };

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
    Packet(std::uint64_t target, Contents contents)
        : target(target), contents(std::move(contents)) {}
    std::uint64_t target;
    Contents contents;
};
inline void post(const Address& address, Packet::Contents contents) {
    address.inbox->post(std::make_unique<Packet>(address.target, std::move(contents)));
}
/** A wake of one enabled port of the receiving realm, which takes the next message of its queue. */
struct PortTask final : ExternalEvent {
    explicit PortTask(std::uint64_t value) : port(value) {}
    std::uint64_t port;
};
/**
 * The state two entangled MessagePorts share across realms. A message waits
 * in its receiving side's queue, so it moves with a transferred port; the
 * side's receiver is the realm task queue of the port that enabled it.
 */
struct PortPair {
    struct Side {
        std::deque<SerializedMessage> queue;
        std::optional<Address> receiver;
    };
    std::mutex mutex;
    bool entangled = true;
    std::array<Side, 2> sides;
};
inline void wake(const Address& address) {
    address.inbox->post(std::make_unique<PortTask>(address.target));
}
} // namespace worker_detail

/** A realm-owned target of `message` and `messageerror` events: a Worker or a MessagePort. */
class MessageEventTarget {
public:
    using MessageCallback = js::Callback<void(const WorkerMessage&)>;
    void set_message_handler(MessageCallback callback) {
        require_owner();
        message_listeners_.set_handler(std::move(callback));
    }
    void add_message_listener(MessageCallback callback, bool once = false) {
        require_owner();
        message_listeners_.add(std::move(callback), once);
    }
    void remove_message_listener(const MessageCallback& callback) {
        require_owner();
        message_listeners_.remove(callback.identity());
    }
    /** Kept as the handler; a native message decodes at its typed read, so none fires. */
    void set_messageerror_handler(MessageCallback callback) {
        require_owner();
        messageerror_listeners_.set_handler(std::move(callback));
    }
    void add_messageerror_listener(MessageCallback callback, bool once = false) {
        require_owner();
        messageerror_listeners_.add(std::move(callback), once);
    }
    void remove_messageerror_listener(const MessageCallback& callback) {
        require_owner();
        messageerror_listeners_.remove(callback.identity());
    }
    void gc_trace(const js::TraceVisitor& visitor) const {
        visitor(message_listeners_);
        visitor(messageerror_listeners_);
    }

protected:
    /** `crossed`: the error a use from another realm's thread throws. */
    explicit MessageEventTarget(const char* crossed)
        : crossed_(crossed), owner_(std::this_thread::get_id()) {}
    void require_owner() const {
        if (owner_ != std::this_thread::get_id())
            throw std::logic_error(crossed_);
    }
    void dispatch_message(EventLoop& loop, SerializedMessage value) {
        auto event = std::make_shared<WorkerMessageEvent>(std::move(value));
        dispatch_platform_event(loop, message_listeners_, event);
    }

private:
    const char* crossed_;
    std::thread::id owner_;
    PlatformEventListeners<void(const WorkerMessage&)> message_listeners_;
    PlatformEventListeners<void(const WorkerMessage&)> messageerror_listeners_;
};

/** Parent-realm object. Its callback state is never captured by the worker thread. */
class Worker : public MessageEventTarget {
public:
    using ErrorCallback = js::Callback<void(WorkerErrorEvent&)>;
    explicit Worker(std::shared_ptr<EventLoop::Inbox> inbox)
        : MessageEventTarget("Worker object crossed realm ownership."), inbox_(std::move(inbox)) {}
    ~Worker() {
        terminate();
        if (thread_.joinable())
            thread_.join();
    }
    void post_message(SerializedMessage message) {
        require_owner();
        worker_detail::post({inbox_, 0}, std::move(message));
    }
    void terminate() { inbox_->terminate(); }
    void add_error_listener(ErrorCallback callback, bool once = false) {
        require_owner();
        error_listeners_.add(std::move(callback), once);
    }
    void set_error_handler(ErrorCallback callback) {
        require_owner();
        error_listeners_.set_handler(std::move(callback));
    }
    void remove_error_listener(const ErrorCallback& callback) {
        require_owner();
        error_listeners_.remove(callback.identity());
    }
    void gc_trace(const js::TraceVisitor& visitor) const {
        MessageEventTarget::gc_trace(visitor);
        visitor(error_listeners_);
    }

private:
    friend class WorkerRealm;
    bool error(EventLoop& loop, WorkerErrorEvent& event) {
        dispatch_platform_event(loop, error_listeners_, event);
        return event.default_prevented;
    }
    std::shared_ptr<EventLoop::Inbox> inbox_;
    std::thread thread_;
    PlatformEventListeners<void(WorkerErrorEvent&)> error_listeners_;
};

struct TransferredPort final : TransferredResource {
    TransferredPort(std::shared_ptr<worker_detail::PortPair> value, std::size_t index)
        : pair(std::move(value)), side(index) {}
    std::shared_ptr<worker_detail::PortPair> pair;
    std::size_t side;
};

/**
 * One realm's MessagePort: an end of an entangled pair. Its message queue is
 * enabled by `start()` or by setting `onmessage`; each message is then a task
 * of this realm. `close()` disentangles both ends without an event. A
 * `messageerror` never fires: a native message decodes at its typed read.
 */
class MessagePort final : public Transferable, public MessageEventTarget {
public:
    MessagePort(std::shared_ptr<worker_detail::PortPair> pair, std::size_t side)
        : MessageEventTarget("MessagePort object crossed realm ownership."), pair_(std::move(pair)),
          side_(side) {}
    static std::shared_ptr<MessagePort> create(std::shared_ptr<worker_detail::PortPair> pair,
                                               std::size_t side) {
        auto port = js::make_gc_shared<MessagePort>(std::move(pair), side);
        port->self_ = port;
        return port;
    }
    static std::shared_ptr<MessagePort> receive(TransferredPort payload) {
        return create(std::move(payload.pair), payload.side);
    }

    /** A message to the entangled port; one sent while that port is transferred waits in its queue. */
    template <typename T>
    void post_message(const T& value, std::span<Transferable* const> transfers = {}) {
        require_owner();
        // A message transferring its own target port is serialized, then discarded.
        bool doomed = false;
        for (const auto* transferable : transfers) {
            if (transferable == this)
                throw DataCloneError("A MessagePort cannot transfer itself.");
            const auto* port = dynamic_cast<const MessagePort*>(transferable);
            doomed = doomed || (port && pair_ && port->pair_ == pair_);
        }
        auto message = js::serialize_message(value, transfers);
        if (doomed || !pair_)
            return;
        std::lock_guard lock(pair_->mutex);
        if (!pair_->entangled)
            return;
        auto& peer = pair_->sides[1 - side_];
        peer.queue.push_back(std::move(message));
        if (peer.receiver)
            worker_detail::wake(*peer.receiver);
    }
    void start();
    void close();
    /** Setting `onmessage` enables the queue, as `start()` does. */
    void set_message_handler(MessageCallback callback) {
        MessageEventTarget::set_message_handler(std::move(callback));
        start();
    }
    std::unique_ptr<TransferredResource> transfer() override {
        require_owner();
        if (!pair_)
            throw DataCloneError("A closed or transferred MessagePort cannot be transferred.");
        auto payload = std::make_unique<TransferredPort>(pair_, side_);
        {
            std::lock_guard lock(pair_->mutex);
            pair_->sides[side_].receiver.reset();
        }
        pair_.reset();
        release();
        return payload;
    }

private:
    friend class WorkerRealm;
    void release();
    void dispatch_next(EventLoop& loop) {
        if (!pair_)
            return;
        std::optional<SerializedMessage> message;
        {
            std::lock_guard lock(pair_->mutex);
            auto& queue = pair_->sides[side_].queue;
            if (queue.empty())
                return;
            message = std::move(queue.front());
            queue.pop_front();
        }
        dispatch_message(loop, std::move(*message));
    }
    std::weak_ptr<MessagePort> self_;
    std::shared_ptr<worker_detail::PortPair> pair_;
    std::size_t side_;
    /** The realm's registration while the queue is enabled. */
    std::uint64_t id_ = 0;
};

/** `new MessageChannel()`: two entangled ports of the current realm. */
class MessageChannel {
public:
    MessageChannel() {
        auto pair = std::make_shared<worker_detail::PortPair>();
        port1_ = MessagePort::create(pair, 0);
        port2_ = MessagePort::create(std::move(pair), 1);
    }
    const std::shared_ptr<MessagePort>& port1() const { return port1_; }
    const std::shared_ptr<MessagePort>& port2() const { return port2_; }
    void gc_trace(const js::TraceVisitor& visitor) const {
        visitor(port1_);
        visitor(port2_);
    }

private:
    std::shared_ptr<MessagePort> port1_;
    std::shared_ptr<MessagePort> port2_;
};
inline std::shared_ptr<MessageChannel> create_message_channel() {
    return js::make_gc_shared<MessageChannel>();
}

/** Platform services for one source realm, including computation-only workers. */
class WorkerRealm {
public:
    explicit WorkerRealm(EventLoop& loop, std::string name = {},
                         std::shared_ptr<HostServices> services = {})
        : WorkerRealm(loop, std::move(name), std::nullopt, std::move(services)) {}
    WorkerRealm(const WorkerRealm&) = delete;
    WorkerRealm& operator=(const WorkerRealm&) = delete;
    ~WorkerRealm() {
        run_teardown("WorkerRealm teardown", [this] {
            ports_.clear();
            for (auto& [id, worker] : workers_) {
                static_cast<void>(id);
                worker->terminate();
            }
            for (auto& [id, worker] : workers_) {
                static_cast<void>(id);
                if (worker->thread_.joinable())
                    worker->thread_.join();
            }
            loop_.on_event({});
            loop_.on_error({});
        });
        current_ = nullptr;
    }
    static WorkerRealm& current() {
        if (!current_)
            throw std::logic_error("No current Worker realm.");
        return *current_;
    }
    EventLoop& loop() { return loop_; }
    const std::string& name() const { return name_; }
    const std::shared_ptr<HostServices>& host_services() const { return host_services_; }
    const void* graphics_identity() const {
        require_owner();
        return host_services_ ? host_services_->graphics_identity() : nullptr;
    }
    /** Promise reactions run on this realm; only immutable native strings cross the host boundary. */
    auto request_graphics_adapter(const js::Nullable<std::string>& power_preference = std::nullopt,
                                  bool force_fallback = false,
                                  const js::Nullable<std::string>& feature_level = std::nullopt,
                                  bool xr_compatible = false) {
        require_owner();
        using Result = js::Nullable<GpuAdapterHandle>;
        using Promise = js::Promise<Result>;
        try {
            if ((power_preference.has_value() && *power_preference != "high-performance") ||
                force_fallback || (feature_level.has_value() && *feature_level != "core") ||
                xr_compatible)
                throw std::runtime_error(
                    "GPU adapter options do not select the native host's high-performance core device.");
            const auto info =
                host_services_ ? host_services_->graphics_adapter_info() : std::nullopt;
            return Promise::resolved(info ? Result{js::make_ref<GpuAdapterRecord>(GpuAdapterRecord{
                                                js::make_ref<GpuAdapterInfo>(*info)})}
                                          : Result{std::nullopt});
        } catch (...) {
            return Promise::rejected(std::current_exception());
        }
    }

    EventLoop::AnimationFrameId request_animation_frame(EventLoop::AnimationCallback callback) {
        require_owner();
        if (!animation_subscribed_) {
            const auto frames = host_services_ ? host_services_->animation_frame_source() : nullptr;
            if (!frames)
                throw std::runtime_error(
                    "Animation frames require an owner Window's repaint source.");
            frames->subscribe(loop_.inbox());
            animation_subscribed_ = true;
        }
        return loop_.request_animation_frame(std::move(callback));
    }

    std::shared_ptr<Worker> create_worker(WorkerEntry entry, std::string name = {}) {
        require_owner();
        if (!entry)
            throw std::invalid_argument("Worker module entry is missing.");
        const auto id = next_worker_++;
        auto inbox = std::make_shared<EventLoop::Inbox>();
        // Allocate a traced parent object before starting the thread.
        auto worker = js::make_gc_shared<Worker>(inbox);
        workers_.emplace(id, worker);
        const worker_detail::Address parent{loop_.inbox(), id};
        const auto origin = EventLoop::Clock::now();
        try {
            worker->thread_ = std::thread([inbox, parent, entry, name = std::move(name), origin,
                                           services = host_services_] {
                try {
                    const js::RealmScope state;
                    EventLoop loop(inbox, origin);
                    WorkerRealm realm(loop, name, parent, services);
                    loop.run([&] { entry(realm); });
                } catch (const WorkerTerminated&) {
                } catch (const std::exception& error) {
                    worker_detail::post(parent, WorkerErrorEvent{error.what(), {}, 0, 0, false});
                } catch (...) {
                    worker_detail::post(
                        parent,
                        WorkerErrorEvent{"Unhandled native worker failure", {}, 0, 0, false});
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
        require_owner();
        messages_.add(std::move(callback), once);
    }
    void remove_message_listener(const Worker::MessageCallback& callback) {
        require_owner();
        messages_.remove(callback.identity());
    }
    void post_message(SerializedMessage message) {
        require_owner();
        if (!parent_)
            throw std::logic_error("The application realm has no parent worker channel.");
        worker_detail::post(*parent_, std::move(message));
    }
    void close() { loop_.close(); }
    /** An enabled port stays alive while its realm can deliver to it. */
    std::uint64_t enable_port(std::shared_ptr<MessagePort> port) {
        require_owner();
        const auto id = next_port_++;
        ports_.emplace(id, std::move(port));
        return id;
    }
    void release_port(std::uint64_t id) {
        require_owner();
        ports_.erase(id);
    }
    void on_platform_event(EventLoop::EventHandler callback) {
        require_owner();
        platform_handler_ = std::move(callback);
    }
    /**
     * A host accessor of this realm's global: a Window host provides each
     * when the realm starts; a realm without one (a worker global) reads
     * undefined.
     */
    void provide_host_accessor(HostAccessor accessor, double (*provider)()) {
        require_owner();
        host_accessors_.at(static_cast<std::size_t>(accessor)).provider = provider;
    }
    /** `Object.defineProperty(globalThis, name, { get })`: later reads run it. */
    void define_host_accessor(HostAccessor accessor, js::Callback<double()> getter,
                              bool configurable) {
        require_owner();
        auto& defined = host_accessors_.at(static_cast<std::size_t>(accessor)).defined;
        if (!defined)
            defined.emplace();
        defined->define(js::Accessor<double>(std::move(getter), {}), configurable);
    }
    [[nodiscard]] js::Nullable<double> host_accessor(HostAccessor accessor) const {
        require_owner();
        const auto& slot = host_accessors_.at(static_cast<std::size_t>(accessor));
        if (slot.defined)
            return slot.defined->get();
        return slot.provider ? js::Nullable<double>(slot.provider()) : std::nullopt;
    }
    /** The realm this thread runs, if any. */
    static WorkerRealm* current_if_any() { return current_; }

private:
    WorkerRealm(EventLoop& loop, std::string name, std::optional<worker_detail::Address> parent,
                std::shared_ptr<HostServices> services)
        : loop_(loop), name_(std::move(name)), parent_(std::move(parent)),
          owner_(std::this_thread::get_id()), host_services_(std::move(services)) {
        if (!js::realm_state.active)
            throw std::logic_error("Worker services require an active JavaScript realm.");
        if (current_)
            throw std::logic_error("Two Worker service owners cannot share a realm.");
        current_ = this;
        loop_.on_event([this](std::unique_ptr<ExternalEvent> event) { deliver(std::move(event)); });
        loop_.on_error([this](std::exception_ptr error) { report(error); });
    }
    void require_owner() const {
        if (owner_ != std::this_thread::get_id())
            throw std::logic_error("Worker services crossed realm ownership.");
    }
    void report(std::exception_ptr error) {
        try {
            std::rethrow_exception(error);
        } catch (const WorkerTerminated&) {
            throw;
        } catch (...) {
            WorkerErrorEvent event{exception_message(std::current_exception()), {}, 0, 0, false};
            if (parent_)
                worker_detail::post(*parent_, std::move(event));
            else
                std::cerr << uncaught_error_prefix << event.message << '\n';
        }
    }
    void deliver(std::unique_ptr<ExternalEvent> external) {
        if (const auto* task = dynamic_cast<const worker_detail::PortTask*>(external.get())) {
            const auto found = ports_.find(task->port);
            if (found == ports_.end())
                return;
            // A listener may close the port, releasing the realm's reference.
            const auto port = found->second;
            port->dispatch_next(loop_);
            js::collect_at_frame_boundary();
            return;
        }
        auto* packet = dynamic_cast<worker_detail::Packet*>(external.get());
        if (!packet) {
            if (!platform_handler_)
                throw std::logic_error("Unknown realm platform event.");
            const auto handler = platform_handler_;
            handler(std::move(external));
            return;
        }
        if (packet->target == 0) {
            auto* message = std::get_if<SerializedMessage>(&packet->contents);
            if (!message)
                throw std::logic_error("Invalid parent-to-worker packet.");
            auto event = std::make_shared<WorkerMessageEvent>(std::move(*message));
            dispatch_platform_event(loop_, messages_, event);
            return;
        }
        const auto found = workers_.find(packet->target);
        if (found == workers_.end())
            return;
        const auto worker = found->second;
        if (std::holds_alternative<std::monostate>(packet->contents)) {
            if (worker->thread_.joinable())
                worker->thread_.join();
            workers_.erase(found);
            return;
        }
        if (worker->inbox_->terminated())
            return;
        if (auto* message = std::get_if<SerializedMessage>(&packet->contents))
            worker->dispatch_message(loop_, std::move(*message));
        else if (auto* error = std::get_if<WorkerErrorEvent>(&packet->contents)) {
            if (!worker->error(loop_, *error)) {
                if (parent_)
                    worker_detail::post(*parent_, std::move(*error));
                else
                    std::cerr << "Uncaught worker error: " << error->message << '\n';
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
    struct HostAccessorSlot {
        double (*provider)() = nullptr;
        std::optional<js::Accessor<double>> defined;
    };
    std::array<HostAccessorSlot, static_cast<std::size_t>(HostAccessor::count)> host_accessors_{};
    bool animation_subscribed_ = false;
    std::uint64_t next_worker_ = 1;
    std::map<std::uint64_t, std::shared_ptr<Worker>> workers_;
    std::uint64_t next_port_ = 1;
    std::map<std::uint64_t, std::shared_ptr<MessagePort>> ports_;
    PlatformEventListeners<void(const WorkerMessage&)> messages_;
    EventLoop::EventHandler platform_handler_;
};

inline void MessagePort::start() {
    require_owner();
    if (id_ || !pair_)
        return;
    auto& realm = WorkerRealm::current();
    id_ = realm.enable_port(self_.lock());
    std::lock_guard lock(pair_->mutex);
    auto& side = pair_->sides[side_];
    side.receiver = worker_detail::Address{realm.loop().inbox(), id_};
    for (std::size_t index = 0; index < side.queue.size(); ++index)
        worker_detail::wake(*side.receiver);
}

inline void MessagePort::close() {
    require_owner();
    if (!pair_)
        return;
    std::deque<SerializedMessage> discarded;
    {
        // Messages already queued to the other end stay deliverable.
        std::lock_guard lock(pair_->mutex);
        pair_->entangled = false;
        auto& side = pair_->sides[side_];
        discarded.swap(side.queue);
        side.receiver.reset();
    }
    pair_.reset();
    release();
}

inline void MessagePort::release() {
    if (id_)
        WorkerRealm::current().release_port(std::exchange(id_, 0));
}

/** A host accessor of the running realm's global; undefined outside a Window realm. */
inline js::Nullable<double> realm_host_accessor(HostAccessor accessor) {
    const WorkerRealm* realm = WorkerRealm::current_if_any();
    return realm ? realm->host_accessor(accessor) : std::nullopt;
}

} // namespace bbl::pal

namespace bbl::js {
template <> struct CloneCodec<std::shared_ptr<pal::MessagePort>> {
    using Port = std::shared_ptr<pal::MessagePort>;
    static pal::CloneId write(pal::CloneWriter& writer, const Port& port) {
        if (!port)
            return writer.add(pal::CloneNull{});
        return writer.transferable(*port);
    }
    static Port read(pal::CloneReader& reader, pal::CloneId id) {
        if (std::holds_alternative<pal::CloneNull>(reader.node(id)))
            return {};
        if (const auto* port = reader.recalled<Port>(id))
            return *port;
        auto resource = reader.take_transfer(id);
        auto* payload = dynamic_cast<pal::TransferredPort*>(resource.get());
        if (!payload)
            throw pal::DataCloneError("Transferred resource is not a MessagePort.");
        auto port = pal::MessagePort::receive(std::move(*payload));
        reader.remember(id, port);
        return port;
    }
};
} // namespace bbl::js
