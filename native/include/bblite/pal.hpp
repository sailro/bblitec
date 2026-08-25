#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace bbl {
struct Engine;
struct EngineOptions;
}

namespace bbl::pal {

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
double monotonic_milliseconds();

} // namespace bbl::pal
