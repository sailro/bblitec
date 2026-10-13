#pragma once

#include <bblite/js_callback.hpp>
#include <bblite/listener_lease.hpp>

#include <algorithm>
#include <concepts>
#include <cstddef>
#include <list>
#include <utility>

namespace bbl {

/**
 * DOM event listeners keyed by JavaScript callback identity (`Key`, with whatever else
 * distinguishes two registrations of one callback).
 *
 * List nodes stay stable while callbacks add or remove listeners. Each
 * dispatch records the next sequence number and ignores later additions;
 * removals tombstone entries until the outermost dispatch finishes. A
 * one-shot listener is tombstoned before invocation, matching DOM reentrancy.
 * A listener added with a lease is also removed once its AbortSignal aborts.
 */
template <typename Signature, typename Key = std::size_t> class PlatformEventListeners;

template <typename Key, typename... Args> class PlatformEventListeners<void(Args...), Key> {
public:
    using Callback = js::Callback<void(Args...)>;

    /** False when a live listener already has `identity`; that one keeps its own lease. */
    bool add(Key identity, Callback callback, bool once = false,
             ListenerLeasePtr lease = {}) {
        retire_aborted();
        const auto duplicate =
            std::find_if(entries_.begin(), entries_.end(), [identity](const auto& entry) {
                return live(entry) && !entry.handler && entry.identity == identity;
            });
        if (duplicate != entries_.end())
            return false;
        entries_.push_back(Entry{identity, next_sequence_++, std::move(callback), true, once, false,
                                 std::move(lease)});
        return true;
    }

    void remove(Key identity) {
        retire_aborted();
        for (Entry& entry : entries_)
            if (!entry.handler && entry.identity == identity && entry.active)
                deactivate(entry);
        compact_if_idle();
    }

    /** Replacements retain the event handler's original listener position. */
    void set_handler(Callback callback) {
        for (Entry& entry : entries_) {
            if (!entry.handler || !entry.active)
                continue;
            if (callback) {
                entry.callback = std::move(callback);
            } else {
                entry.active = false;
                needs_compaction_ = true;
                compact_if_idle();
            }
            return;
        }
        if (callback)
            entries_.push_back(
                Entry{Key{}, next_sequence_++, std::move(callback), true, false, true, {}});
    }

    void clear() {
        for (Entry& entry : entries_)
            if (entry.active)
                deactivate(entry);
        compact_if_idle();
    }

    [[nodiscard]] bool empty() const noexcept { return entries_.empty(); }

    bool add(Callback callback, bool once = false)
        requires std::same_as<Key, std::size_t>
    {
        const auto identity = callback.identity();
        return add(identity, std::move(callback), once);
    }

    void gc_trace(const js::TraceVisitor& visitor) const {
        for (const Entry& entry : entries_)
            visitor(entry.callback);
    }

    void dispatch(Args... args) {
        dispatch_with([](Callback& callback, Args... values) { callback(values...); }, args...);
    }

    /** The owning event loop supplies exception reporting and callback cleanup. */
    template <typename Invoke> void dispatch_with(Invoke&& invoke, Args... args) {
        dispatch_while([] { return true; }, std::forward<Invoke>(invoke), args...);
    }

    /** A stopped dispatch must not consume a later once-listener. */
    template <typename Continue, typename Invoke>
    void dispatch_while(Continue&& proceed, Invoke&& invoke, Args... args) {
        const std::size_t boundary = next_sequence_;
        ++dispatch_depth_;
        try {
            for (Entry& entry : entries_) {
                if (entry.sequence >= boundary)
                    break;
                if (!entry.active)
                    continue;
                // An earlier listener of this dispatch may have aborted this one's signal.
                if (!live(entry)) {
                    deactivate(entry);
                    continue;
                }
                if (!proceed())
                    break;
                if (entry.once)
                    deactivate(entry);
                invoke(entry.callback, args...);
            }
        } catch (...) {
            --dispatch_depth_;
            compact_if_idle();
            throw;
        }
        --dispatch_depth_;
        compact_if_idle();
    }

private:
    struct Entry {
        Key identity{};
        std::size_t sequence = 0;
        Callback callback;
        bool active = true;
        bool once = false;
        bool handler = false;
        ListenerLeasePtr lease;
    };
    [[nodiscard]] static bool live(const Entry& entry) noexcept {
        return entry.active && !(entry.lease && entry.lease->removed);
    }
    /** Removal by the registry ends the lease, dropping its signal's abort algorithm. */
    void deactivate(Entry& entry) {
        entry.active = false;
        needs_compaction_ = true;
        if (entry.lease)
            entry.lease->end();
    }
    /** Aborted listeners leave the list at its next mutation or dispatch. */
    void retire_aborted() {
        for (Entry& entry : entries_)
            if (entry.active && !live(entry))
                deactivate(entry);
        compact_if_idle();
    }
    void compact_if_idle() {
        if (dispatch_depth_ != 0 || !needs_compaction_)
            return;
        std::erase_if(entries_, [](const Entry& entry) { return !entry.active; });
        needs_compaction_ = false;
    }

    std::list<Entry> entries_;
    std::size_t next_sequence_ = 0;
    std::size_t dispatch_depth_ = 0;
    bool needs_compaction_ = false;
};

} // namespace bbl
