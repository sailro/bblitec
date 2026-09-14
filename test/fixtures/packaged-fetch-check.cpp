#include <bblite/pal_packaged_fetch.hpp>
#include <fstream>
#include <iterator>

namespace bbl {
std::string asset_path(const std::string& path) { return path; }
}

namespace bbl::pal {
std::vector<std::uint8_t> read_binary_file(const std::string& path) {
    std::ifstream stream(path, std::ios::binary);
    if (!stream) throw std::runtime_error("Cannot read packaged file.");
    return {std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>()};
}
}
