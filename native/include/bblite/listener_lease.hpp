#pragma once

#include <functional>
#include <memory>
#include <utility>

namespace bbl {

/**
 * The DOM "removed" flag of one event listener added with an AbortSignal. Its registry entry owns
 * the lease; the signal's abort algorithm holds it weakly, so neither side keeps the other alive.
 * Abort sets `removed`; a registry that removes the listener first ends the lease, which drops
 * the abort algorithm through `release`.
 */
struct ListenerLease {
    bool removed = false;
    std::function<void()> release;

    void end() {
        removed = true;
        if (auto drop = std::exchange(release, nullptr))
            drop();
    }
};

using ListenerLeasePtr = std::shared_ptr<ListenerLease>;

} // namespace bbl
