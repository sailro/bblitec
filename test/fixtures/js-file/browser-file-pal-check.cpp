#include <bblite/js_file.hpp>

#include "pal_file_io.hpp"
#include "pal_platform_events.hpp"

#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace {

std::string open_override;
std::string save_override;

void require(bool condition, std::string_view message) {
    if (!condition) throw std::runtime_error(std::string(message));
}

template <typename Work>
void require_throws(Work&& work, std::string_view message) {
    bool threw = false;
    try {
        work();
    } catch (const std::runtime_error&) {
        threw = true;
    }
    require(threw, message);
}

void write_text(const std::filesystem::path& path, std::string_view text) {
    std::ofstream stream(path, std::ios::binary | std::ios::trunc);
    if (!stream) throw std::runtime_error("Unable to create scratch file.");
    stream.write(text.data(), static_cast<std::streamsize>(text.size()));
    if (!stream) throw std::runtime_error("Unable to write scratch file.");
}

} // namespace

namespace bbl::pal {

std::string environment_variable(const char* name) {
    const std::string_view key(name);
    if (key == "BBLITE_FILE_DIALOG_OPEN_PATH") return open_override;
    if (key == "BBLITE_FILE_DIALOG_SAVE_PATH") return save_override;
    return {};
}

} // namespace bbl::pal

int main(int argc, char** argv) {
    require(argc == 2, "scratch root argument");
    const std::filesystem::path root = argv[1];
    const std::filesystem::path selected_path = root / "selected.json";
    const std::filesystem::path other_path = root / "other.json";
    write_text(selected_path, "selected bytes");
    write_text(other_path, "replacement bytes");

    open_override = selected_path.string();
    bbl::Engine engine;
    int once_dispatches = 0;
    int later_dispatches = 0;
    engine.pointer_lock_change_callbacks.add(
        1u,
        [once = std::make_shared<bool>(false),
         &engine,
         &once_dispatches,
         &later_dispatches]() {
            if (*once) return;
            *once = true;
            ++once_dispatches;
            engine.pointer_lock_change_callbacks.add(
                2u,
                [&later_dispatches]() { ++later_dispatches; });
        });
    bbl::pal::dispatch_pointer_lock_change(engine);
    require(
        once_dispatches == 1 && later_dispatches == 0,
        "dialog-induced pointer-lock dispatch snapshots listeners");
    bbl::pal::dispatch_pointer_lock_change(engine);
    bbl::pal::dispatch_pointer_lock_change(engine);
    require(
        once_dispatches == 1 && later_dispatches == 2,
        "one-shot state survives snapshots and later transitions");
    engine.pointer_lock_change_callbacks.clear();
    int remover_dispatches = 0;
    int removed_dispatches = 0;
    engine.pointer_lock_change_callbacks.add(
        3u,
        [&]() {
            ++remover_dispatches;
            engine.pointer_lock_change_callbacks.remove(4u);
        });
    engine.pointer_lock_change_callbacks.add(
        4u,
        [&]() { ++removed_dispatches; });
    bbl::pal::dispatch_pointer_lock_change(engine);
    require(
        remover_dispatches == 1 && removed_dispatches == 0,
        "removal suppresses a later listener in the active dispatch");
    engine.pointer_lock_change_callbacks.clear();
    int native_once_dispatches = 0;
    engine.pointer_lock_change_callbacks.add(
        5u,
        [&]() { ++native_once_dispatches; },
        true);
    bbl::pal::dispatch_pointer_lock_change(engine);
    bbl::pal::dispatch_pointer_lock_change(engine);
    require(
        native_once_dispatches == 1,
        "registry-owned once removes the listener before invocation");
    engine.pointer_lock_change_callbacks.add(
        5u,
        [&]() { ++native_once_dispatches; });
    bbl::pal::dispatch_pointer_lock_change(engine);
    require(
        native_once_dispatches == 2,
        "a fired one-shot listener may be registered again");
    engine.pointer_lock_change_callbacks.clear();
    engine.canvas_client_width = 100.0;
    engine.canvas_client_height = 80.0;
    int canvas_mouse_downs = 0;
    int canvas_mouse_ups = 0;
    engine.mouse_down_callbacks.add(
        6u,
        [&](const bbl::PlatformMouseEvent&) { ++canvas_mouse_downs; });
    engine.mouse_up_callbacks.add(
        7u,
        [&](const bbl::PlatformMouseEvent&) { ++canvas_mouse_ups; });
    const bbl::PlatformMouseEvent outside{
        .button = 0.0,
        .buttons = 1.0,
        .client_x = -1.0,
        .client_y = -1.0,
    };
    bbl::pal::dispatch_platform_mouse_button(engine, outside, true);
    bbl::pal::dispatch_platform_mouse_button(engine, outside, false);
    require(
        canvas_mouse_downs == 0 && canvas_mouse_ups == 0,
        "host-decoration mouse buttons do not reach canvas listeners");
    const bbl::PlatformMouseEvent inside{
        .button = 0.0,
        .buttons = 1.0,
        .client_x = 50.0,
        .client_y = 40.0,
    };
    bbl::pal::dispatch_platform_mouse_button(engine, inside, true);
    bbl::pal::dispatch_platform_mouse_button(engine, inside, false);
    require(
        canvas_mouse_downs == 1 && canvas_mouse_ups == 1,
        "client-area mouse buttons reach canvas listeners");
    engine.mouse_down_callbacks.clear();
    engine.mouse_up_callbacks.clear();

    const bbl::pal::FileDialogOptions options{
        .title = "Open file",
        .suggested_name = "",
        .filter_name = "JSON files",
        .filter_pattern = "*.json",
    };
    std::optional<bbl::pal::SelectedFileSnapshot> selected =
        bbl::pal::choose_open_file(engine, options);
    require(selected.has_value(), "environment-selected file");
    require(selected->display_name == "selected.json", "stable display name");

    bbl::BrowserFileHandle file;
    bbl::js::replace_browser_file(engine, file, std::move(*selected));
    require(
        bbl::js::file_text(engine, file) == "selected bytes",
        "initial File.text snapshot");

    const std::filesystem::path save_path = root / "saved.json";
    save_override = save_path.string();
    const std::optional<std::string> chosen_save =
        bbl::pal::choose_save_file(engine, options);
    require(
        chosen_save.has_value() && *chosen_save == save_override,
        "environment-selected save file");
    bbl::pal::write_selected_file_atomically(
        *chosen_save,
        std::string_view("saved bytes"));
    require(
        bbl::pal::detail::read_text_file_bounded(
            save_path,
            64u,
            "saved file") == "saved bytes",
        "real PAL atomic save");

    write_text(selected_path, "replacement bytes");
    require(
        bbl::js::file_text(engine, file) == "selected bytes",
        "File.text cannot follow pathname replacement");

    std::filesystem::remove(selected_path);
    std::error_code symlink_error;
    std::filesystem::create_symlink(other_path, selected_path, symlink_error);
    if (!symlink_error) {
        require(
            bbl::js::file_text(engine, file) == "selected bytes",
            "File.text cannot follow a post-selection symlink");
        require_throws(
            [&]() {
                static_cast<void>(
                    bbl::pal::choose_open_file(engine, options));
            },
            "a picker result that resolves to a symlink is rejected");
    }

    const std::filesystem::path oversized = root / "oversized.bin";
    {
        std::ofstream stream(oversized, std::ios::binary | std::ios::trunc);
        stream.seekp(64 * 1024 * 1024);
        stream.put('\0');
    }
    open_override = oversized.string();
    require_throws(
        [&]() {
            static_cast<void>(bbl::pal::choose_open_file(engine, options));
        },
        "selected-file bound is checked before allocation");

    std::cout << "browser-file-pal-check: ok\n";
    return 0;
}
