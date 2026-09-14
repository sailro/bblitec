#include "pal_spirv_vertex.hpp"
#include <cassert>

int main() {
    // Scalar input at 0, instancing vector at 16; output at 19 and builtin input.
    const std::vector<std::uint32_t> words{
        0x07230203, 0x00010000, 0, 20, 0,
        (3u << 16) | 22, 1, 32,
        (4u << 16) | 23, 2, 1, 4,
        (4u << 16) | 32, 3, 1, 1,
        (4u << 16) | 32, 4, 1, 2,
        (4u << 16) | 32, 5, 3, 2,
        (4u << 16) | 71, 10, 30, 0,
        (4u << 16) | 71, 11, 30, 16,
        (4u << 16) | 71, 12, 30, 19,
        (4u << 16) | 71, 13, 11, 42,
        (4u << 16) | 59, 3, 10, 1,
        (4u << 16) | 59, 4, 11, 1,
        (4u << 16) | 59, 5, 12, 3,
        (4u << 16) | 59, 3, 13, 1,
    };
    std::vector<std::uint8_t> bytes(words.size() * 4);
    std::memcpy(bytes.data(), words.data(), bytes.size());
    const auto mapping = bbl::pal::compact_spirv_vertex_inputs(bytes);
    assert(mapping.size() == 2 && mapping.at(0) == 0 && mapping.at(16) == 1);
    auto expected = words;
    expected[31] = 1;
    assert(std::memcmp(bytes.data(), expected.data(), bytes.size()) == 0);
    bytes.pop_back();
    try { bbl::pal::compact_spirv_vertex_inputs(bytes); assert(false); }
    catch (const std::runtime_error&) {}
}
