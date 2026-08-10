#include <bblite/pal.hpp>
#include <bblite/runtime.hpp>

#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <stdexcept>
#include <utility>

#if defined(BBLITE_HAS_SDL) && BBLITE_HAS_SDL
#include <SDL3/SDL_filesystem.h>
#endif

namespace bbl::pal {

Engine create_engine(EngineOptions options) {
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
#if defined(BBLITE_HAS_SDL) && BBLITE_HAS_SDL
    const char* base_path = SDL_GetBasePath();
    if (!base_path || !*base_path) {
        throw std::runtime_error("SDL_GetBasePath failed.");
    }
    return std::filesystem::path(base_path).lexically_normal().string();
#else
    return std::filesystem::current_path().string();
#endif
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
