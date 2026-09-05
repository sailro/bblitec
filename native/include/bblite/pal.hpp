#pragma once

// CMake selects these for each build. Direct native fixtures use the full PAL.
#ifndef BBLITE_VISUAL_CAPTURE
#define BBLITE_VISUAL_CAPTURE 1
#endif
#ifndef BBLITE_HAS_IMAGE_DECODER
#define BBLITE_HAS_IMAGE_DECODER 1
#endif

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace bbl {
struct Engine;
struct EngineOptions;
}

namespace bbl::pal {

struct FileDialogOptions {
    std::string title;
    std::string suggested_name;
    std::string filter_name;
    std::string filter_pattern;
};

/** Bytes and display metadata captured while an open-file choice is accepted. */
struct SelectedFileSnapshot {
    std::vector<std::uint8_t> bytes;
    std::string display_name;
};

Engine create_engine(EngineOptions options);
void run_engine(Engine& engine);
/**
 * The generated build stamp, behind one function so only its own tiny
 * translation unit (pal_build_stamp.cpp) includes the generated header:
 * every other PAL object stays byte-identical across scenes and a
 * compiler cache can serve it.
 */
const char* bblite_build_stamp();
std::vector<std::uint8_t> read_binary_file(const std::string& path);
std::string join_path(const std::string& root, const std::string& relative_path);
std::string parent_path(const std::string& path);
std::string executable_directory();
std::string environment_variable(const char* name);
/**
 * Durable per-user key/value storage: the platform service behind Web
 * Storage. The root is the host's own preference directory
 * (`SDL_GetPrefPath`) under one bblitec namespace, so nothing outside PAL
 * names a path and no scene decides where its data lives.
 *
 * A read of an absent key answers `std::nullopt`; a write replaces the
 * value atomically; removing an absent key succeeds. Every other failure
 * throws, because a silent one would let a scene believe it saved.
 */
std::optional<std::string> read_local_storage(const std::string& key);
void write_local_storage(const std::string& key, const std::string& value);
void remove_local_storage(const std::string& key);
std::optional<std::string> choose_save_file(
    Engine& engine,
    const FileDialogOptions& options);
std::optional<SelectedFileSnapshot> choose_open_file(
    Engine& engine,
    const FileDialogOptions& options);
/**
 * File contents selected for opening are returned above as a bounded immutable
 * snapshot. Writes stage beside the destination and replace it atomically.
 */
void write_selected_file_atomically(
    const std::string& path,
    const std::vector<std::uint8_t>& bytes);
void write_selected_file_atomically(
    const std::string& path,
    std::string_view text);
double monotonic_milliseconds();
// Browser-facing `performance.now()`. In ordinary runs this is the same
// monotonic clock; fixed-delta captures advance it deterministically.
double performance_milliseconds();
void advance_performance_milliseconds(float delta_ms);
/**
 * The process's resident working set in bytes, or 0 where the platform
 * has no query. Read by the BBLITE_MEM_PROFILE frame line, which is how a
 * long run shows whether the runtime's memory settles.
 */
std::size_t process_working_set_bytes();

} // namespace bbl::pal
