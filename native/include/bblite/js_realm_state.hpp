#pragma once

#include <bblite/js_gc.hpp>

#include <cstdint>
#include <limits>
#include <optional>
#include <stdexcept>
#include <vector>

namespace bbl::js {

/** Reached only in worker-enabled builds; ordinary JS operations keep their ABI. */
struct RealmState {
    std::uint32_t random = 1;
    std::size_t callback_identity = std::numeric_limits<std::size_t>::max() / 2;
    std::vector<void (*)()> clear_scratch;
    bool active = false;
};
inline thread_local RealmState realm_state;

class RealmScope {
  public:
    RealmScope() {
        if (realm_state.active) throw std::logic_error("Two JavaScript realms cannot share one active thread.");
        realm_state.active = true;
        realm_state.random = 1;
        realm_state.callback_identity = std::numeric_limits<std::size_t>::max() / 2;
    }
    RealmScope(const RealmScope&) = delete;
    RealmScope& operator=(const RealmScope&) = delete;
    ~RealmScope() {
        for (auto clear : realm_state.clear_scratch) clear();
        realm_state.clear_scratch.clear();
        realm_state.active = false;
    }
  private:
    CollectOnExit collect_;
};

template <typename T> T& realm_scratch() {
    static thread_local std::optional<T> value;
    if (!realm_state.active) throw std::logic_error("JavaScript scratch storage requires an active realm.");
    if (!value) {
        value.emplace();
        realm_state.clear_scratch.push_back([] { value.reset(); });
    }
    return *value;
}

} // namespace bbl::js
