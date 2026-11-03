#pragma once

// The per-user storage root Web Storage and IndexedDB keep their files under, and the encoding
// that turns a source-chosen name into a file name there.
//
// Where it lives is SDL's answer, not ours: `SDL_GetPrefPath` is the one cross-platform "where
// may this program write" service, and everything stored sits under a single bblitec namespace
// inside it.
//
// A name is arbitrary JavaScript text and a filename is not, so a name is encoded rather than
// used: every byte outside `[A-Za-z0-9-]` becomes `_` plus two hex digits. `_` is itself encoded,
// which makes the mapping injective -- two names cannot land on one file -- and leaves no `.`, no
// separator and no reserved character, so no name can name a path outside the root or a filename
// the host refuses.

#include <bblite/pal.hpp>

#include <cstddef>
#include <filesystem>
#include <stdexcept>
#include <string>
#include <string_view>
#include <system_error>

#include <SDL3/SDL.h>

#include "pal_file_io.hpp"

namespace bbl::pal::detail {

/** The organisation/application pair every bblitec build stores under. */
inline constexpr const char* kPrefOrganisation = "bblitec";
inline constexpr const char* kPrefApplication = "web-storage";

/** An encoded name longer than this cannot be stored on every host. */
inline constexpr std::size_t kMaximumEncodedNameLength = 180;

[[nodiscard]] inline std::string encode_storage_name(const std::string& name, const char* what) {
    static constexpr char kHex[] = "0123456789ABCDEF";
    std::string encoded;
    encoded.reserve(name.size() + 1);
    // A leading letter so the empty name -- which JavaScript allows -- is still a valid file
    // name, and so no encoded name can begin with a character a host treats specially.
    encoded.push_back('k');
    for (const char raw : name) {
        const auto byte = static_cast<unsigned char>(raw);
        const bool literal = (byte >= 'a' && byte <= 'z') || (byte >= 'A' && byte <= 'Z') ||
                             (byte >= '0' && byte <= '9') || byte == '-';
        if (literal) {
            encoded.push_back(raw);
            continue;
        }
        encoded.push_back('_');
        encoded.push_back(kHex[(byte >> 4) & 0xFu]);
        encoded.push_back(kHex[byte & 0xFu]);
    }
    if (encoded.size() > kMaximumEncodedNameLength)
        throw std::runtime_error(std::string(what) + " is too long to store on this platform.");
    return encoded;
}

/** `directory` and its parents, created unless they exist; `what` names it in the refusal. */
inline void create_storage_directory(const std::filesystem::path& directory,
                                     std::string_view what) {
    std::error_code error;
    std::filesystem::create_directories(directory, error);
    if (error && !std::filesystem::is_directory(directory))
        throw std::runtime_error("Unable to create the " + std::string(what) +
                                 " directory: " + error.message() + ".");
}

/**
 * The storage root, created on demand. `BBLITE_LOCAL_STORAGE_ROOT` redirects it so a test never
 * touches the user's own preferences.
 */
[[nodiscard]] inline const std::filesystem::path& storage_root() {
    static const std::filesystem::path root = [] {
        const std::string override_root = environment_variable("BBLITE_LOCAL_STORAGE_ROOT");
        std::filesystem::path resolved;
        if (!override_root.empty()) {
            resolved = utf8_file_path(override_root);
        } else {
            char* preferences = SDL_GetPrefPath(kPrefOrganisation, kPrefApplication);
            if (!preferences || !*preferences) {
                if (preferences)
                    SDL_free(preferences);
                throw std::runtime_error("SDL_GetPrefPath failed, so local storage has no home.");
            }
            const std::string utf8(preferences);
            SDL_free(preferences);
            resolved = utf8_file_path(utf8);
        }
        create_storage_directory(resolved, "local storage");
        return resolved;
    }();
    return root;
}

/** One storage service's own directory under the root, created on demand. */
[[nodiscard]] inline std::filesystem::path storage_directory(std::string_view name,
                                                             std::string_view what) {
    auto directory = storage_root() / name;
    create_storage_directory(directory, what);
    return directory;
}

} // namespace bbl::pal::detail
