#pragma once

// Web Storage's JavaScript half. `localStorage` and `sessionStorage` are
// browser objects with no Babylon declaration behind them, so like
// `setTimeout` they are platform services rather than lowered pinned
// modules. Each area object carries its own three operations, so a stored
// `Storage` reference calls the area it was read from.
//
// The shapes are the browser's. `getItem` answers a nullable string, so
// the absent key stays distinguishable from the empty one and the source's
// own `if (!raw)` decides over both. `setItem` and `removeItem` return
// nothing and throw when the platform could not store the change, which is
// where a browser throws its quota error -- so a scene's `try`/`catch`
// around a save observes the same arm.
//
// Included only by a program that reaches `storage:local` or
// `storage:session`; only `local_storage_object` references the PAL's
// durable store, so a session-only program links no file code.

#include <bblite/js_data.hpp>
#include <bblite/pal.hpp>

#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
#include <utility>

namespace bbl::js {

[[nodiscard]] inline Nullable<std::string> local_storage_get_item(const std::string& key) {
    std::optional<std::string> stored = pal::read_local_storage(key);
    if (!stored)
        return Nullable<std::string>{};
    return Nullable<std::string>{std::move(*stored)};
}

inline void local_storage_set_item(const std::string& key, const std::string& value) {
    pal::write_local_storage(key, value);
}

inline void local_storage_remove_item(const std::string& key) { pal::remove_local_storage(key); }

/** `localStorage`: one object per realm over the PAL's durable per-user store. */
[[nodiscard]] inline Storage local_storage_object() {
    static thread_local const auto instance = make_ref<StorageArea>(
        StorageArea{&local_storage_get_item, &local_storage_set_item, &local_storage_remove_item});
    return instance;
}

namespace detail {

/**
 * The top-level browsing session's storage: process memory, never written to
 * disk. A Window realm recreated by reload or same-document navigation (on a
 * fresh thread) reads what the previous realm wrote; the process exit ends it.
 */
struct SessionStorageEntries {
    std::mutex mutex;
    std::unordered_map<std::string, std::string> values;
};

[[nodiscard]] inline SessionStorageEntries& session_storage_entries() {
    static SessionStorageEntries entries;
    return entries;
}

} // namespace detail

[[nodiscard]] inline Nullable<std::string> session_storage_get_item(const std::string& key) {
    auto& entries = detail::session_storage_entries();
    const std::scoped_lock lock(entries.mutex);
    const auto found = entries.values.find(key);
    if (found == entries.values.end())
        return Nullable<std::string>{};
    return Nullable<std::string>{found->second};
}

inline void session_storage_set_item(const std::string& key, const std::string& value) {
    auto& entries = detail::session_storage_entries();
    const std::scoped_lock lock(entries.mutex);
    entries.values.insert_or_assign(key, value);
}

inline void session_storage_remove_item(const std::string& key) {
    auto& entries = detail::session_storage_entries();
    const std::scoped_lock lock(entries.mutex);
    entries.values.erase(key);
}

/** `sessionStorage`: one object per realm over the session's entries. */
[[nodiscard]] inline Storage session_storage_object() {
    static thread_local const auto instance = make_ref<StorageArea>(StorageArea{
        &session_storage_get_item, &session_storage_set_item, &session_storage_remove_item});
    return instance;
}

} // namespace bbl::js
