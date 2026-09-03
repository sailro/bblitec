#include <bblite/js_file.hpp>

#include "pal_file_io.hpp"

#include <cstdint>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iostream>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace {

std::optional<std::string> save_path;
std::optional<bbl::pal::SelectedFileSnapshot> open_file;
bbl::pal::FileDialogOptions last_save_options;
bbl::pal::FileDialogOptions last_open_options;
std::function<void(bbl::Engine&)> save_dialog_hook;
std::function<void(bbl::Engine&)> open_dialog_hook;
std::vector<std::uint8_t> written;
std::string readable = R"({"ok":true})";
bool fail_write = false;
int writes = 0;

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

} // namespace

namespace bbl::pal {

std::optional<std::string> choose_save_file(
    Engine& engine,
    const FileDialogOptions& options) {
    last_save_options = options;
    if (save_dialog_hook) save_dialog_hook(engine);
    return save_path;
}

std::optional<SelectedFileSnapshot> choose_open_file(
    Engine& engine,
    const FileDialogOptions& options) {
    last_open_options = options;
    if (open_dialog_hook) open_dialog_hook(engine);
    return open_file;
}

void write_selected_file_atomically(
    const std::string&,
    const std::vector<std::uint8_t>& bytes) {
    ++writes;
    if (fail_write) throw std::runtime_error("injected write failure");
    written = bytes;
}

void write_selected_file_atomically(
    const std::string&,
    std::string_view text) {
    ++writes;
    if (fail_write) throw std::runtime_error("injected write failure");
    written.assign(text.begin(), text.end());
}

} // namespace bbl::pal

int main(int argc, char** argv) {
    require(argc == 2, "scratch root argument");
    const std::filesystem::path root = argv[1];

    bbl::js::U8Array bytes(2u);
    bytes[0] = 0u;
    bytes[1] = 255u;
    const bbl::js::Blob blob(
        {
            bbl::js::blob_part_string("A"),
            bbl::js::blob_part_bytes(bytes),
            bbl::js::blob_part_string("Z"),
        },
        "Application/JSON");
    require(blob.size() == 4u, "Blob size");
    require(blob.type() == "application/json", "Blob MIME normalization");
    require(
        blob.bytes() == std::vector<std::uint8_t>({'A', 0u, 255u, 'Z'}),
        "Blob concatenation order");

    bbl::Engine engine;
    const bbl::ObjectUrlHandle first =
        bbl::js::create_object_url(engine, blob);
    const bbl::ObjectUrlHandle second =
        bbl::js::create_object_url(engine, blob);
    require(
        first.slot != second.slot || first.generation != second.generation,
        "object URL identity");

    const bbl::UiElementHandle anchor_handle{
        static_cast<std::uint32_t>(engine.ui_elements.size())};
    bbl::UiElementRecord anchor;
    anchor.tag = "a";
    anchor.download_url = first;
    anchor.download_name = "map.json";
    engine.ui_elements.push_back(std::move(anchor));
    save_path.reset();
    writes = 0;
    bbl::js::click_download_anchor(engine, anchor_handle);
    require(writes == 0, "save cancellation writes nothing");
    require(
        last_save_options.suggested_name == "map.json" &&
            last_save_options.filter_pattern == "*.json",
        "safe save dialog suggestion and filter");

    save_path = "chosen.json";
    save_dialog_hook = [first](bbl::Engine& current) {
        const bbl::js::Blob extra(
            {bbl::js::blob_part_string("growth")},
            "text/plain");
        for (std::size_t index = 0; index < 256u; ++index) {
            static_cast<void>(bbl::js::create_object_url(current, extra));
            current.ui_elements.emplace_back();
        }
        bbl::js::revoke_object_url(current, first);
    };
    bbl::js::click_download_anchor(engine, anchor_handle);
    save_dialog_hook = {};
    require(
        writes == 1 && written == blob.bytes(),
        "download snapshots payload before dialog callbacks");
    require_throws(
        [&]() { bbl::js::click_download_anchor(engine, anchor_handle); },
        "revocation after activation is visible to a later click");

    bbl::js::revoke_object_url(engine, first);
    bbl::js::revoke_object_url(engine, first);
    require_throws(
        [&]() { bbl::js::click_download_anchor(engine, anchor_handle); },
        "revoked URL click");
    const bbl::ObjectUrlHandle reused =
        bbl::js::create_object_url(engine, blob);
    require(
        reused.slot == first.slot && reused.generation != first.generation,
        "generation-safe URL slot reuse");
    engine.ui_elements[anchor_handle.value].download_url = reused;
    fail_write = true;
    require_throws(
        [&]() { bbl::js::click_download_anchor(engine, anchor_handle); },
        "save failure surfaces");
    fail_write = false;
    bbl::js::revoke_object_url(engine, second);
    bbl::js::revoke_object_url(engine, reused);

    const bbl::UiElementHandle input_handle{
        static_cast<std::uint32_t>(engine.ui_elements.size())};
    bbl::UiElementRecord input;
    input.tag = "input";
    input.file_input = true;
    input.file_accept = "application/json,.json";
    require_throws(
        []() {
            static_cast<void>(
                bbl::js::detail::open_options(
                    "application/x-unknown,.json"));
        },
        "mixed unmappable MIME filter is rejected defensively");
    engine.ui_elements.push_back(std::move(input));
    int changes = 0;
    std::string selected_text;
    engine.ui_elements[input_handle.value].file_change_callbacks.push_back(
        [&]() {
            ++changes;
            const bbl::js::FileList files =
                bbl::js::input_files(engine, input_handle);
            require(files.length() == 1u, "selected FileList length");
            const bbl::BrowserFileHandle file =
                bbl::js::file_at(files, 0u);
            require(static_cast<bool>(file), "files[0]");
            selected_text = bbl::js::file_text(engine, file);
            if (changes == 1) {
                for (std::size_t index = 0; index < 256u; ++index) {
                    engine.ui_elements.emplace_back();
                }
            }
        });

    open_file.reset();
    bbl::js::click_file_input(engine, input_handle);
    require(changes == 0, "open cancellation fires no change");
    require(
        bbl::js::input_files(engine, input_handle).length() == 0u,
        "open cancellation leaves files empty");

    open_file = bbl::pal::SelectedFileSnapshot{
        .bytes = std::vector<std::uint8_t>(
            readable.begin(),
            readable.end()),
        .display_name = "selected.json",
    };
    open_dialog_hook = [](bbl::Engine& current) {
        for (std::size_t index = 0; index < 256u; ++index) {
            current.ui_elements.emplace_back();
        }
    };
    bbl::js::click_file_input(engine, input_handle);
    open_dialog_hook = {};
    require(changes == 1, "selection fires change exactly once");
    require(selected_text == readable, "File.text success");
    require(
        last_open_options.filter_pattern == "*.json",
        "accept filter");
    open_file.reset();
    bbl::js::click_file_input(engine, input_handle);
    require(changes == 1, "cancel after selection fires no change");
    require(
        bbl::js::file_text(
            engine,
            bbl::js::file_at(
                bbl::js::input_files(engine, input_handle),
                0u)) == readable,
        "cancel preserves prior selected File");

    open_file = bbl::pal::SelectedFileSnapshot{
        .bytes = {'n', 'e', 'w'},
        .display_name = "new.json",
    };
    open_dialog_hook = [input_handle](bbl::Engine& current) {
        current.ui_elements[input_handle.value].file_input = false;
        current.ui_elements.emplace_back();
    };
    require_throws(
        [&]() { bbl::js::click_file_input(engine, input_handle); },
        "input type is revalidated after dialog callbacks");
    open_dialog_hook = {};
    engine.ui_elements[input_handle.value].file_input = true;
    require(changes == 1, "failed revalidation preserves prior selection");

    bbl::js::FileList retained =
        bbl::js::input_files(engine, input_handle);
    bbl::js::click_file_input(engine, input_handle);
    require(changes == 2, "replacement fires change exactly once");
    require(
        bbl::js::file_text(engine, bbl::js::file_at(retained, 0u)) == readable,
        "a retained old FileList keeps its immutable snapshot");
    require(
        engine.browser_file_storage->snapshot_count() == 2u &&
            engine.browser_file_storage->retained_bytes() ==
                readable.size() + 3u,
        "retained old File and replacement own exactly two snapshots");

    for (int index = 0; index < 32; ++index) {
        const std::string replacement =
            "replacement-" + std::to_string(index);
        open_file = bbl::pal::SelectedFileSnapshot{
            .bytes = std::vector<std::uint8_t>(
                replacement.begin(),
                replacement.end()),
            .display_name = "replacement.json",
        };
        bbl::js::click_file_input(engine, input_handle);
        require(
            engine.browser_file_storage->snapshot_count() == 2u &&
                engine.browser_file_storage->retained_bytes() ==
                    readable.size() + replacement.size(),
            "repeated replacement reuses the unshared current snapshot");
    }

    engine.ui_elements[input_handle.value].selected_file = {};
    require(
        engine.browser_file_storage->snapshot_count() == 1u &&
            engine.browser_file_storage->retained_bytes() == readable.size(),
        "element cleanup releases its current snapshot");
    require(
        bbl::js::file_text(engine, bbl::js::file_at(retained, 0u)) == readable,
        "retained File outlives element cleanup");
    retained.first = {};
    require(
        engine.browser_file_storage->snapshot_count() == 0u &&
            engine.browser_file_storage->retained_bytes() == 0u,
        "last FileList handle reclaims the old payload");
    require_throws(
        [&]() {
            static_cast<void>(
                bbl::js::file_text(
                    engine,
                    bbl::BrowserFileHandle{}));
        },
        "absent File handle surfaces without an aliasable slot");

    bbl::Engine capped_engine;
    capped_engine.browser_file_storage =
        std::make_shared<bbl::BrowserFileStorage>(6u);
    const bbl::UiElementHandle capped_input_handle{
        static_cast<std::uint32_t>(capped_engine.ui_elements.size())};
    bbl::UiElementRecord capped_input;
    capped_input.tag = "input";
    capped_input.file_input = true;
    capped_engine.ui_elements.push_back(std::move(capped_input));
    int capped_changes = 0;
    capped_engine.ui_elements[capped_input_handle.value]
        .file_change_callbacks.push_back([&capped_changes]() {
            ++capped_changes;
        });
    open_file = bbl::pal::SelectedFileSnapshot{
        .bytes = {'f', 'o', 'u', 'r'},
        .display_name = "four.txt",
    };
    bbl::js::click_file_input(capped_engine, capped_input_handle);
    bbl::js::FileList capped_retained =
        bbl::js::input_files(capped_engine, capped_input_handle);
    open_file = bbl::pal::SelectedFileSnapshot{
        .bytes = {'n', 'e', 'w'},
        .display_name = "new.txt",
    };
    require_throws(
        [&]() {
            bbl::js::click_file_input(capped_engine, capped_input_handle);
        },
        "aggregate cap refuses a replacement while the old File is retained");
    require(
        capped_changes == 1 &&
            bbl::js::file_text(
                capped_engine,
                bbl::js::file_at(
                    bbl::js::input_files(
                        capped_engine,
                        capped_input_handle),
                    0u)) == "four",
        "cap refusal preserves the current selection and dispatch count");
    capped_retained.first = {};
    bbl::js::click_file_input(capped_engine, capped_input_handle);
    require(
        capped_changes == 2 &&
            capped_engine.browser_file_storage->snapshot_count() == 1u &&
            capped_engine.browser_file_storage->retained_bytes() == 3u,
        "releasing the old File recovers aggregate capacity");
    capped_engine.ui_elements[capped_input_handle.value].selected_file = {};
    require(
        capped_engine.browser_file_storage->snapshot_count() == 0u &&
            capped_engine.browser_file_storage->retained_bytes() == 0u,
        "capped engine reclaims its final selection");

    const std::filesystem::path target = root / "atomic.json";
    {
        std::ofstream initial(target, std::ios::binary);
        initial << "old";
    }
    const std::filesystem::path predictable_collision =
        std::filesystem::path(target.string() + ".tmp");
    {
        std::ofstream collision(predictable_collision, std::ios::binary);
        collision << "attacker";
    }
    const std::filesystem::path forced_staging =
        root / "forced-stage.tmp";
    const std::string forced_replacement = "forced";
    bbl::pal::detail::write_file_atomically_with_staging_paths(
        target,
        std::span<const std::uint8_t>{
            reinterpret_cast<const std::uint8_t*>(
                forced_replacement.data()),
            forced_replacement.size()},
        16u,
        "collision test",
        [&](const std::filesystem::path&, std::size_t attempt) {
            return attempt == 0u
                ? predictable_collision
                : forced_staging;
        });
    require(
        bbl::pal::detail::read_text_file_bounded(
            target,
            16u,
            "collision result") == forced_replacement,
        "exclusive staging retries a colliding name");
    require(
        !std::filesystem::exists(forced_staging),
        "successful collision retry commits its staging file");
    const std::string replacement = "new";
    bbl::pal::detail::write_file_atomically(
        target,
        replacement,
        16u,
        "test file");
    require(
        bbl::pal::detail::read_text_file_bounded(target, 16u, "test file") ==
            replacement,
        "atomic replacement");
    require(
        bbl::pal::detail::read_text_file_bounded(
            predictable_collision,
            16u,
            "collision sentinel") == "attacker",
        "predictable staging collision is untouched");

    const std::filesystem::path staging_victim =
        root / "staging-victim.json";
    const std::filesystem::path staging_symlink =
        root / "forced-stage-link.tmp";
    const std::filesystem::path staging_after_symlink =
        root / "forced-stage-after-link.tmp";
    {
        std::ofstream victim(staging_victim, std::ios::binary);
        victim << "victim";
    }
    std::error_code staging_symlink_error;
    std::filesystem::create_symlink(
        staging_victim,
        staging_symlink,
        staging_symlink_error);
    if (!staging_symlink_error) {
        bbl::pal::detail::write_file_atomically_with_staging_paths(
            target,
            std::span<const std::uint8_t>{
                reinterpret_cast<const std::uint8_t*>(replacement.data()),
                replacement.size()},
            16u,
            "staging symlink test",
            [&](const std::filesystem::path&, std::size_t attempt) {
                return attempt == 0u
                    ? staging_symlink
                    : staging_after_symlink;
            });
        require(
            bbl::pal::detail::read_text_file_bounded(
                staging_victim,
                16u,
                "staging victim") == "victim",
            "exclusive staging never follows an existing symlink");
        require(
            std::filesystem::is_symlink(staging_symlink),
            "colliding staging symlink remains untouched");
    }

    const std::filesystem::path directory_target = root / "directory";
    std::filesystem::create_directories(directory_target);
    require_throws(
        [&]() {
            bbl::pal::detail::write_file_atomically(
                directory_target,
                replacement,
                16u,
                "test file");
        },
        "atomic commit failure surfaces");
    require(
        std::filesystem::is_directory(directory_target),
        "atomic failure leaves destination unchanged");
    for (const auto& entry : std::filesystem::directory_iterator(root)) {
        require(
            !entry.path().filename().string().starts_with(".bblite-write-"),
            "atomic failure removes randomized staging file");
    }

    const std::filesystem::path outside = root / "outside.json";
    const std::filesystem::path linked_target = root / "linked.json";
    {
        std::ofstream outside_stream(outside, std::ios::binary);
        outside_stream << "outside";
    }
    std::error_code symlink_error;
    std::filesystem::create_symlink(outside, linked_target, symlink_error);
    if (!symlink_error) {
        bbl::pal::detail::write_file_atomically(
            linked_target,
            replacement,
            16u,
            "symlink destination");
        require(
            bbl::pal::detail::read_text_file_bounded(
                outside,
                16u,
                "outside file") == "outside",
            "atomic replacement never follows a destination symlink");
        require(
            bbl::pal::detail::read_text_file_bounded(
                linked_target,
                16u,
                "replaced symlink") == replacement,
            "atomic replacement replaces the symlink itself");
    }
    require_throws(
        [&]() {
            static_cast<void>(
                bbl::pal::detail::read_text_file_bounded(
                    target,
                    2u,
                    "test file"));
        },
        "bounded read failure");

    std::cout << "browser-file-check: ok\n";
    return 0;
}
