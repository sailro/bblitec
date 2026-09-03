#pragma once

// Web Storage's JavaScript half. `localStorage` is a browser object with
// no Babylon declaration behind it, so like `setTimeout` it is a platform
// service rather than a lowered pinned module: the three reached methods
// map to the PAL's durable key/value store, and nothing above this line
// names a path or a file.
//
// The shapes are the browser's. `getItem` answers a nullable string, so
// the absent key stays distinguishable from the empty one and the source's
// own `if (!raw)` decides over both. `setItem` and `removeItem` return
// nothing and throw when the platform could not store the change, which is
// where a browser throws its quota error -- so a scene's `try`/`catch`
// around a save observes the same arm.
//
// Included only by a scene that reaches storage (`localStorageReached`).

#include <bblite/js_data.hpp>
#include <bblite/pal.hpp>

#include <optional>
#include <string>
#include <utility>

namespace bbl::js {

[[nodiscard]] inline Nullable<std::string> local_storage_get_item(
    const std::string& key) {
    std::optional<std::string> stored = pal::read_local_storage(key);
    if (!stored) return Nullable<std::string>{};
    return Nullable<std::string>{std::move(*stored)};
}

inline void local_storage_set_item(
    const std::string& key,
    const std::string& value) {
    pal::write_local_storage(key, value);
}

inline void local_storage_remove_item(const std::string& key) {
    pal::remove_local_storage(key);
}

} // namespace bbl::js
