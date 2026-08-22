#include <bblite/pal.hpp>
#include <bblite/runtime.hpp>
#include <bblite/upstream/build_stamp.hpp>

#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <stdexcept>
#include <utility>

#include <SDL3/SDL_filesystem.h>

namespace bbl::pal {

std::string environment_variable(const char* name);

// Every scene reaches the engine through here, so this is where the
// executable reports which sources it was built from. bblitec sets
// BBLITE_BUILD_STAMP_OUT before a measured run and refuses the result
// when the stamp no longer matches the generated tree on disk.
static void report_build_stamp() {
    const std::string path =
        environment_variable("BBLITE_BUILD_STAMP_OUT");
    if (path.empty()) {
        return;
    }
    std::ofstream stream(path, std::ios::binary | std::ios::trunc);
    if (!stream) {
        throw std::runtime_error(
            "Unable to write the build stamp to '" + path + "'.");
    }
    stream << BBLITE_BUILD_STAMP;
}

Engine create_engine(EngineOptions options) {
    report_build_stamp();
    Engine engine;
    engine.options = std::move(options);
    return engine;
}

std::vector<std::uint8_t> read_binary_file(const std::string& path) {
    std::ifstream stream(path, std::ios::binary);
    if (!stream) {
        throw std::runtime_error("Unable to open file '" + path + "'.");
    }
    return std::vector<std::uint8_t>(
        std::istreambuf_iterator<char>(stream),
        std::istreambuf_iterator<char>());
}

std::string join_path(const std::string& root, const std::string& relative_path) {
    return (std::filesystem::path(root) / relative_path).lexically_normal().string();
}

std::string parent_path(const std::string& path) {
    return std::filesystem::path(path).parent_path().string();
}

std::string executable_directory() {
    const char* base_path = SDL_GetBasePath();
    if (!base_path || !*base_path) {
        throw std::runtime_error("SDL_GetBasePath failed.");
    }
    return std::filesystem::path(base_path).lexically_normal().string();
}

std::string environment_variable(const char* name) {
#if defined(_MSC_VER)
    char* value = nullptr;
    std::size_t length = 0;
    if (_dupenv_s(&value, &length, name) != 0 || !value) {
        return {};
    }
    std::string result(value);
    std::free(value);
    return result;
#else
    const char* value = std::getenv(name);
    return value ? value : "";
#endif
}

double monotonic_milliseconds() {
    const auto now = std::chrono::steady_clock::now().time_since_epoch();
    return std::chrono::duration<double, std::milli>(now).count();
}

} // namespace bbl::pal
