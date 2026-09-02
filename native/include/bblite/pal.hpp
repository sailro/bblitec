#pragma once

#include <cstdint>
#include <optional>
#include <string>
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
    std::string default_extension;
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
std::optional<std::string> choose_save_file(
    Engine& engine,
    const FileDialogOptions& options);
std::optional<std::string> choose_open_file(
    Engine& engine,
    const FileDialogOptions& options);
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
