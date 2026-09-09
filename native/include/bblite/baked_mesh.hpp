#pragma once

#include <array>
#include <bit>
#include <cstddef>
#include <cstdint>
#include <span>
#include <stdexcept>
#include <vector>

namespace bbl {

struct BakedMeshData {
    std::vector<float> positions;
    std::vector<float> normals;
    std::vector<float> uvs;
    std::vector<std::uint32_t> indices;
};

// Four little-endian u32 counts followed by f32 positions, normals, UVs and u32 indices.
inline BakedMeshData read_baked_mesh(std::span<const std::uint8_t> bytes) {
    if (bytes.size() < 16) throw std::runtime_error("Truncated baked mesh header.");
    const auto word = [&bytes](std::size_t offset) {
        return static_cast<std::uint32_t>(bytes[offset]) |
            (static_cast<std::uint32_t>(bytes[offset + 1]) << 8) |
            (static_cast<std::uint32_t>(bytes[offset + 2]) << 16) |
            (static_cast<std::uint32_t>(bytes[offset + 3]) << 24);
    };
    const std::array counts{word(0), word(4), word(8), word(12)};
    std::uint64_t size = 16;
    for (const auto count : counts) size += std::uint64_t{count} * 4;
    if (size != bytes.size()) throw std::runtime_error("Invalid baked mesh stream lengths.");
    std::size_t offset = 16;
    const auto floats = [&](std::uint32_t count) {
        std::vector<float> result(count);
        for (auto& value : result) {
            value = std::bit_cast<float>(word(offset));
            offset += 4;
        }
        return result;
    };
    BakedMeshData result;
    result.positions = floats(counts[0]);
    result.normals = floats(counts[1]);
    result.uvs = floats(counts[2]);
    result.indices.resize(counts[3]);
    for (auto& value : result.indices) {
        value = word(offset);
        offset += 4;
    }
    return result;
}

} // namespace bbl
