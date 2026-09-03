// Host file dialogs plus bounded selected-file snapshots. This translation
// unit is selected only by browser:file, so an executable that never reaches
// Blob downloads, file inputs, or the legacy voxel picker carries no dialog
// or writable-file surface.

#include <bblite/pal.hpp>
#include <bblite/runtime.hpp>

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <exception>
#include <filesystem>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include <SDL3/SDL.h>

#include "pal_file_io.hpp"
#include "pal_platform_events.hpp"

namespace bbl::pal {
namespace {

constexpr std::size_t kMaximumSelectedFileBytes = 64u * 1024u * 1024u;

// A host dialog takes the mouse. Leave pointer lock through the same transition
// as every other loss so pointerlockchange remains observable before it opens.
void release_pointer_lock_for_dialog(Engine& engine) {
    if (!engine.pointer_locked && !engine.pointer_lock_requested) return;
    SDL_Window* window = SDL_GetKeyboardFocus();
    if (!window) window = SDL_GetMouseFocus();
    engine.pointer_lock_requested = false;
    sync_pointer_lock(window, engine);
}

[[nodiscard]] std::string sdl_filter_pattern(std::string_view pattern) {
    if (pattern == "*.*" || pattern == "*") return "*";
    std::string result;
    std::size_t begin = 0;
    while (begin <= pattern.size()) {
        const std::size_t separator = pattern.find(';', begin);
        const std::string_view item = pattern.substr(
            begin,
            separator == std::string_view::npos
                ? std::string_view::npos
                : separator - begin);
        if (
            item.size() <= 2u ||
            item[0] != '*' ||
            item[1] != '.') {
            throw std::runtime_error(
                "Native file dialog received an invalid extension filter.");
        }
        if (!result.empty()) result.push_back(';');
        result.append(item.substr(2u));
        if (separator == std::string_view::npos) break;
        begin = separator + 1u;
    }
    return result;
}

struct DialogResult {
    std::mutex mutex;
    std::optional<std::string> path;
    std::exception_ptr failure;
    std::atomic<bool> complete = false;
};

void SDLCALL receive_dialog_result(
    void* userdata,
    const char* const* files,
    int) noexcept {
    auto& result = *static_cast<DialogResult*>(userdata);
    try {
        std::lock_guard lock(result.mutex);
        if (!files) {
            throw std::runtime_error(
                "SDL file dialog failed: " + std::string(SDL_GetError()) + ".");
        }
        if (files[0]) result.path = files[0];
    } catch (...) {
        std::lock_guard lock(result.mutex);
        result.failure = std::current_exception();
    }
    result.complete.store(true, std::memory_order_release);
}

void set_dialog_property(
    bool accepted,
    SDL_PropertiesID properties,
    std::string_view property) {
    if (!accepted) {
        SDL_DestroyProperties(properties);
        throw std::runtime_error(
            "Unable to set SDL file-dialog property '" +
            std::string(property) + "': " + SDL_GetError() + ".");
    }
}

[[nodiscard]] std::optional<std::string> choose_sdl_file(
    const FileDialogOptions& options,
    bool save) {
    const std::string pattern = sdl_filter_pattern(options.filter_pattern);
    SDL_DialogFileFilter filter{
        options.filter_name.c_str(),
        pattern.c_str(),
    };
    const SDL_PropertiesID properties = SDL_CreateProperties();
    if (properties == 0) {
        throw std::runtime_error(
            "Unable to create SDL file-dialog properties: " +
            std::string(SDL_GetError()) + ".");
    }
    set_dialog_property(
        SDL_SetPointerProperty(
            properties,
            SDL_PROP_FILE_DIALOG_FILTERS_POINTER,
            &filter),
        properties,
        SDL_PROP_FILE_DIALOG_FILTERS_POINTER);
    set_dialog_property(
        SDL_SetNumberProperty(
            properties,
            SDL_PROP_FILE_DIALOG_NFILTERS_NUMBER,
            1),
        properties,
        SDL_PROP_FILE_DIALOG_NFILTERS_NUMBER);
    SDL_Window* window = SDL_GetKeyboardFocus();
    if (!window) window = SDL_GetMouseFocus();
    if (window) {
        set_dialog_property(
            SDL_SetPointerProperty(
                properties,
                SDL_PROP_FILE_DIALOG_WINDOW_POINTER,
                window),
            properties,
            SDL_PROP_FILE_DIALOG_WINDOW_POINTER);
    }
    if (!options.title.empty()) {
        set_dialog_property(
            SDL_SetStringProperty(
                properties,
                SDL_PROP_FILE_DIALOG_TITLE_STRING,
                options.title.c_str()),
            properties,
            SDL_PROP_FILE_DIALOG_TITLE_STRING);
    }
    if (save && !options.suggested_name.empty()) {
        set_dialog_property(
            SDL_SetStringProperty(
                properties,
                SDL_PROP_FILE_DIALOG_LOCATION_STRING,
                options.suggested_name.c_str()),
            properties,
            SDL_PROP_FILE_DIALOG_LOCATION_STRING);
    }

    DialogResult result;
    SDL_ShowFileDialogWithProperties(
        save ? SDL_FILEDIALOG_SAVEFILE : SDL_FILEDIALOG_OPENFILE,
        receive_dialog_result,
        &result,
        properties);
    // SDL's Linux portal backend needs event pumping, but consuming queued
    // application events here would re-enter scene/UI callbacks inside click().
    while (!result.complete.load(std::memory_order_acquire)) {
        SDL_PumpEvents();
        SDL_Delay(10u);
    }
    SDL_DestroyProperties(properties);
    std::lock_guard lock(result.mutex);
    if (result.failure) std::rethrow_exception(result.failure);
    return std::move(result.path);
}

[[nodiscard]] std::string display_name(
    const std::filesystem::path& path) {
    const std::u8string utf8 = path.filename().u8string();
    if (utf8.empty()) {
        throw std::runtime_error(
            "The selected file has no stable display name.");
    }
    return std::string(
        reinterpret_cast<const char*>(utf8.data()),
        utf8.size());
}

[[nodiscard]] std::optional<std::string> choose_file_path(
    Engine& engine,
    const FileDialogOptions& options,
    bool save) {
    const std::string override_path = environment_variable(
        save
            ? "BBLITE_FILE_DIALOG_SAVE_PATH"
            : "BBLITE_FILE_DIALOG_OPEN_PATH");
    if (!override_path.empty()) return override_path;
    release_pointer_lock_for_dialog(engine);
    return choose_sdl_file(options, save);
}

} // namespace

std::optional<std::string> choose_save_file(
    Engine& engine,
    const FileDialogOptions& options) {
    return choose_file_path(engine, options, true);
}

std::optional<SelectedFileSnapshot> choose_open_file(
    Engine& engine,
    const FileDialogOptions& options) {
    const std::optional<std::string> selected =
        choose_file_path(engine, options, false);
    if (!selected) return std::nullopt;
    const std::filesystem::path path = detail::utf8_file_path(*selected);
    return SelectedFileSnapshot{
        .bytes = detail::read_binary_file_bounded(
            path,
            kMaximumSelectedFileBytes,
            "selected file"),
        .display_name = display_name(path),
    };
}

void write_selected_file_atomically(
    const std::string& path,
    const std::vector<std::uint8_t>& bytes) {
    detail::write_file_atomically(
        detail::utf8_file_path(path),
        std::span<const std::uint8_t>(bytes),
        kMaximumSelectedFileBytes,
        "selected file");
}

void write_selected_file_atomically(
    const std::string& path,
    std::string_view text) {
    detail::write_file_atomically(
        detail::utf8_file_path(path),
        text,
        kMaximumSelectedFileBytes,
        "selected file");
}

} // namespace bbl::pal
