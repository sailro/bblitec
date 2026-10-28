#pragma once

// The PAL file read the fixtures' shader loaders and web platform go through.

#include <fstream>
#include <iterator>
#include <stdexcept>
#include <string>
#include <vector>

namespace bbl::pal {
std::vector<std::uint8_t> read_binary_file(const std::string& path) {
    std::ifstream file(path, std::ios::binary);
    if (!file)
        throw std::runtime_error("missing " + path);
    return {std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>()};
}
} // namespace bbl::pal
