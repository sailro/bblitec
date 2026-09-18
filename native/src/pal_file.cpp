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

#include "pal_file_dialog.hpp"
#include "pal_platform_events.hpp"
#if defined(SDL_PLATFORM_IOS)
#include "pal_file_ios.hpp"
#endif

namespace bbl::pal {
namespace {

// A host dialog takes the mouse. Leave pointer lock through the same transition
// as every other loss so pointerlockchange remains observable before it opens.
void release_pointer_lock_for_dialog(Engine& engine) {
    if (!engine.pointer_locked && !engine.pointer_lock_requested) return;
    SDL_Window* window = SDL_GetKeyboardFocus();
    if (!window) window = SDL_GetMouseFocus();
    engine.pointer_lock_requested = false;
    sync_pointer_lock(window, engine);
}

#if !defined(SDL_PLATFORM_IOS)
[[nodiscard]] std::string sdl_filter_pattern(std::string_view pattern) {
    const auto extensions = detail::file_dialog_extensions(pattern);
    if (extensions.empty()) return "*";
    std::string result;
    for (const auto& extension : extensions) {
        if (!result.empty()) result.push_back(';');
        result += extension;
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
#endif

} // namespace

bool save_file(
    Engine& engine,
    const FileDialogOptions& options,
    std::span<const std::uint8_t> bytes,
    const std::function<void()>& validate) {
    require_runtime_execution("file selection");
    if (bytes.size() > detail::maximum_selected_file_bytes) {
        throw std::runtime_error("Selected file exceeds the native write bound.");
    }
    std::optional<std::string> path;
    const auto override_path = environment_variable("BBLITE_FILE_DIALOG_SAVE_PATH");
    if (!override_path.empty()) path = override_path;
    else {
        release_pointer_lock_for_dialog(engine);
#if defined(SDL_PLATFORM_IOS)
        if (validate) validate();
        return export_ios_file(options, bytes);
#else
        path = choose_sdl_file(options, true);
#endif
    }
    if (!path) return false;
    if (validate) validate();
    detail::write_file_atomically(detail::utf8_file_path(*path), bytes,
        detail::maximum_selected_file_bytes, "selected file");
    return true;
}

bool save_file(
    Engine& engine,
    const FileDialogOptions& options,
    std::string_view text,
    const std::function<void()>& validate) {
    return save_file(engine, options,
        std::span<const std::uint8_t>(reinterpret_cast<const std::uint8_t*>(text.data()), text.size()), validate);
}

std::optional<SelectedFileSnapshot> choose_open_file(
    Engine& engine,
    const FileDialogOptions& options) {
    require_runtime_execution("file selection");
    const auto override_path = environment_variable("BBLITE_FILE_DIALOG_OPEN_PATH");
    if (!override_path.empty()) return detail::selected_file_snapshot(detail::utf8_file_path(override_path));
    release_pointer_lock_for_dialog(engine);
#if defined(SDL_PLATFORM_IOS)
    return choose_ios_open_file(options);
#else
    const auto path = choose_sdl_file(options, false);
    return path ? std::optional(detail::selected_file_snapshot(detail::utf8_file_path(*path))) : std::nullopt;
#endif
}

void write_selected_file_atomically(
    const std::string& path,
    const std::vector<std::uint8_t>& bytes) {
    require_runtime_execution("a selected-file write");
    detail::write_file_atomically(
        detail::utf8_file_path(path),
        std::span<const std::uint8_t>(bytes),
        detail::maximum_selected_file_bytes,
        "selected file");
}

void write_selected_file_atomically(
    const std::string& path,
    std::string_view text) {
    require_runtime_execution("a selected-file write");
    detail::write_file_atomically(
        detail::utf8_file_path(path),
        text,
        detail::maximum_selected_file_bytes,
        "selected file");
}

} // namespace bbl::pal
