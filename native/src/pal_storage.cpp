// Web Storage's platform half: the durable per-user key/value store the
// browser gives a page as `localStorage`. Compiled only into a scene that
// reaches it (`storage:local`), so every other executable carries neither
// the filesystem code nor the preference directory it would create.
//
// Where it lives is SDL's answer, not ours: `SDL_GetPrefPath` is the one
// cross-platform "where may this program write" service, and everything
// this file stores sits under a single bblitec namespace inside it.
//
// A key is arbitrary JavaScript text and a filename is not, so a key is
// encoded rather than used: every byte outside `[A-Za-z0-9-]` becomes
// `_` plus two hex digits. `_` is itself encoded, which makes the mapping
// injective -- two keys cannot land on one file -- and leaves no `.`, no
// separator and no reserved character, so no key can name a path outside
// the root or a filename the host refuses.

#include <bblite/pal.hpp>

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <stdexcept>
#include <string>
#include <system_error>

#include <SDL3/SDL.h>

#include "pal_file_io.hpp"

namespace bbl::pal {

namespace {

/** The organisation/application pair every bblitec build stores under. */
constexpr const char* kPrefOrganisation = "bblitec";
constexpr const char* kPrefApplication = "web-storage";
constexpr const char* kEntrySuffix = ".localstorage";

/**
 * A stored value is a whole document held in memory by the scene that
 * wrote it, so anything past this is a corrupt or foreign file rather
 * than something a `getItem` should try to return.
 */
constexpr std::uintmax_t kMaximumEntryBytes = 64u * 1024u * 1024u;

/** An encoded name longer than this cannot be stored on every host. */
constexpr std::size_t kMaximumEncodedNameLength = 180;

[[nodiscard]] std::string encode_key(const std::string& key) {
    static constexpr char kHex[] = "0123456789ABCDEF";
    std::string encoded;
    encoded.reserve(key.size() + 1);
    // A leading letter so the empty key -- which JavaScript allows -- is
    // still a valid file name, and so no encoded name can begin with a
    // character a host treats specially.
    encoded.push_back('k');
    for (const char raw : key) {
        const auto byte = static_cast<unsigned char>(raw);
        const bool literal =
            (byte >= 'a' && byte <= 'z') ||
            (byte >= 'A' && byte <= 'Z') ||
            (byte >= '0' && byte <= '9') ||
            byte == '-';
        if (literal) {
            encoded.push_back(raw);
            continue;
        }
        encoded.push_back('_');
        encoded.push_back(kHex[(byte >> 4) & 0xFu]);
        encoded.push_back(kHex[byte & 0xFu]);
    }
    if (encoded.size() > kMaximumEncodedNameLength) {
        throw std::runtime_error(
            "Local storage key is too long to store on this platform.");
    }
    return encoded;
}

/**
 * The storage root, created on demand. `BBLITE_LOCAL_STORAGE_ROOT`
 * redirects it so a test never touches the user's own preferences.
 */
[[nodiscard]] const std::filesystem::path& storage_root() {
    static const std::filesystem::path root = [] {
        const std::string override_root =
            environment_variable("BBLITE_LOCAL_STORAGE_ROOT");
        std::filesystem::path resolved;
        if (!override_root.empty()) {
            resolved = detail::utf8_file_path(override_root);
        } else {
            char* preferences =
                SDL_GetPrefPath(kPrefOrganisation, kPrefApplication);
            if (!preferences || !*preferences) {
                if (preferences) SDL_free(preferences);
                throw std::runtime_error(
                    "SDL_GetPrefPath failed, so local storage has no home.");
            }
            const std::string utf8(preferences);
            SDL_free(preferences);
            resolved = detail::utf8_file_path(utf8);
        }
        std::error_code error;
        std::filesystem::create_directories(resolved, error);
        if (error && !std::filesystem::is_directory(resolved)) {
            throw std::runtime_error(
                "Unable to create the local storage directory: " +
                error.message() + ".");
        }
        return resolved;
    }();
    return root;
}

[[nodiscard]] std::filesystem::path entry_path(const std::string& key) {
    return storage_root() / (encode_key(key) + kEntrySuffix);
}

} // namespace

std::optional<std::string> read_local_storage(const std::string& key) {
    const std::filesystem::path path = entry_path(key);
    std::error_code error;
    const bool exists = std::filesystem::exists(path, error);
    if (error) {
        // Absent is a `null` read; anything else is a real failure and is
        // not quietly turned into one.
        if (error == std::errc::no_such_file_or_directory) {
            return std::nullopt;
        }
        throw std::runtime_error(
            "Unable to read local storage entry: " + error.message() + ".");
    }
    if (!exists) return std::nullopt;
    return detail::read_text_file_bounded(
        path,
        kMaximumEntryBytes,
        "local storage entry");
}

void write_local_storage(const std::string& key, const std::string& value) {
    const std::filesystem::path path = entry_path(key);
    detail::write_file_atomically(
        path,
        value,
        static_cast<std::size_t>(kMaximumEntryBytes),
        "local storage entry");
}

void remove_local_storage(const std::string& key) {
    const std::filesystem::path path = entry_path(key);
    std::error_code error;
    // `remove` answers false for an absent entry, which `removeItem` on a
    // key that was never set is: nothing to do, and no failure.
    std::filesystem::remove(path, error);
    if (error) {
        throw std::runtime_error(
            "Unable to remove a local storage entry: " + error.message() +
            ".");
    }
}

} // namespace bbl::pal
