// Web Storage's platform half: the durable per-user key/value store the
// browser gives a page as `localStorage`. Compiled only into a scene that
// reaches it (`storage:local`), so every other executable carries neither
// the filesystem code nor the preference directory it would create.
//
// One file per key under the per-user storage root, named by the injective
// encoding IndexedDB's database files share (pal_storage_root.hpp).

#include <bblite/pal.hpp>

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <stdexcept>
#include <string>
#include <system_error>

#include "pal_file_io.hpp"
#include "pal_storage_root.hpp"

namespace bbl::pal {

namespace {

constexpr const char* kEntrySuffix = ".localstorage";

/**
 * A stored value is a whole document held in memory by the scene that
 * wrote it, so anything past this is a corrupt or foreign file rather
 * than something a `getItem` should try to return.
 */
constexpr std::uintmax_t kMaximumEntryBytes = 64u * 1024u * 1024u;

[[nodiscard]] std::filesystem::path entry_path(const std::string& key) {
    return detail::storage_root() /
           (detail::encode_storage_name(key, "Local storage key") + kEntrySuffix);
}

} // namespace

std::optional<std::string> read_local_storage(const std::string& key) {
    require_runtime_execution("external storage input");
    const std::filesystem::path path = entry_path(key);
    auto bytes = detail::file_read_value(
        detail::try_read_binary_file_bounded(path, kMaximumEntryBytes, "local storage entry"));
    if (!bytes)
        return std::nullopt;
    return std::string(bytes->begin(), bytes->end());
}

void write_local_storage(const std::string& key, const std::string& value) {
    require_runtime_execution("external storage output");
    const std::filesystem::path path = entry_path(key);
    detail::write_file_atomically(path, value, static_cast<std::size_t>(kMaximumEntryBytes),
                                  "local storage entry");
}

void remove_local_storage(const std::string& key) {
    require_runtime_execution("external storage output");
    const std::filesystem::path path = entry_path(key);
    std::error_code error;
    // `remove` answers false for an absent entry, which `removeItem` on a
    // key that was never set is: nothing to do, and no failure.
    std::filesystem::remove(path, error);
    if (error) {
        throw std::runtime_error("Unable to remove a local storage entry: " + error.message() +
                                 ".");
    }
}

} // namespace bbl::pal
