#pragma once

#include <bblite/runtime.hpp>

#include <map>
#include <tuple>

namespace bbl {

/** Target/type/capture identity and phase traversal share the ordinary registry's
 * mutation and once rules. The owning realm supplies callback cleanup/reporting. */
template <typename Event>
class DomEventListeners {
  public:
    using Listeners = PlatformEventListeners<void(const Event&)>;
    using Callback = Listeners::Callback;

    void add(DomEventTarget target, std::string type, std::size_t identity,
        Callback callback, bool capture = false, bool once = false, bool passive = false) {
        const auto entry = js::make_gc_shared<Listener>(std::move(callback), passive);
        auto wrapper = js::make_closure(std::tuple{entry}, [](auto& captures, const Event& event) {
            const auto& listener = std::get<0>(captures);
            auto& state = *event.dom;
            const bool previous = state.passive_listener;
            state.passive_listener = listener->passive;
            struct Restore {
                DomEventState& state;
                bool previous;
                ~Restore() { state.passive_listener = previous; }
            } restore{state, previous};
            listener->callback(event);
        });
        listeners_[key(target, std::move(type), capture)].add(identity, std::move(wrapper), once);
    }

    void remove(DomEventTarget target, std::string type, std::size_t identity, bool capture = false) {
        const auto found = listeners_.find(key(target, std::move(type), capture));
        if (found != listeners_.end()) found->second.remove(identity);
    }

    template <typename Invoke>
    void dispatch(const Event& event, Invoke&& invoke) {
        if (!event.dom) throw std::logic_error("DOM dispatch requires an owned event path.");
        auto& state = *event.dom;
        if (state.dispatching) throw std::logic_error("The same event is already being dispatched.");
        state.dispatching = true;
        struct Reset {
            DomEventState& state;
            ~Reset() {
                state.phase = 0;
                state.current_target.reset();
                state.path.clear();
                state.propagation_stopped = false;
                state.immediate_propagation_stopped = false;
                state.dispatching = false;
            }
        } reset{state};
        const auto path = state.path;
        const auto deliver = [&](DomEventTarget target, bool capture, double phase) {
            if (state.propagation_stopped) return;
            state.phase = phase;
            state.current_target = target;
            const auto found = listeners_.find(key(target, state.type, capture));
            if (found == listeners_.end()) return;
            found->second.dispatch_while([&] { return !state.immediate_propagation_stopped; }, invoke, event);
        };
        for (auto item = path.rbegin(); item != path.rend(); ++item)
            deliver(*item, true, *item == state.target ? 2 : 1);
        for (const auto& item : path)
            if (item == state.target || state.bubbles) deliver(item, false, item == state.target ? 2 : 3);
    }

    void dispatch(const Event& event) {
        dispatch(event, [](Callback& callback, const Event& value) { callback(value); });
    }

#if defined(BBLITE_WORKERS) && BBLITE_WORKERS
    void gc_trace(const js::TraceVisitor& visitor) const {
        for (const auto& [identity, listeners] : listeners_) {
            (void)identity;
            listeners.gc_trace(visitor);
        }
    }
#endif

  private:
    struct Listener {
        Listener(Callback callback, bool passive) : callback(std::move(callback)), passive(passive) {}
        Callback callback;
        bool passive;
#if defined(BBLITE_WORKERS) && BBLITE_WORKERS
        void gc_trace(const js::TraceVisitor& visitor) const { visitor(callback); }
#endif
    };
    using Key = std::tuple<DomEventTargetKind, std::uint32_t, std::string, bool>;
    static Key key(DomEventTarget target, std::string type, bool capture) {
        return {target.kind, target.element, std::move(type), capture};
    }
    std::map<Key, Listeners> listeners_;
};

} // namespace bbl
