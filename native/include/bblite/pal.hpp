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
std::vector<std::uint8_t> read_binary_file(const std::string& path);
std::string join_path(const std::string& root, const std::string& relative_path);
std::string parent_path(const std::string& path);
std::string executable_directory();
std::string environment_variable(const char* name);
double monotonic_milliseconds();

} // namespace bbl::pal
