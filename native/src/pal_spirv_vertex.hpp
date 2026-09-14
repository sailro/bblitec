#pragma once
#include <cstdint>
#include <cstring>
#include <map>
#include <stdexcept>
#include <vector>

namespace bbl::pal {
// Compact only vertex-buffer inputs. Stage outputs retain the locations used
// by the independently compiled fragment shader.
inline std::map<std::uint32_t, std::uint32_t> compact_spirv_vertex_inputs(std::vector<std::uint8_t>& bytes) {
    if (bytes.size() < 20 || bytes.size() % 4) throw std::runtime_error("Invalid SPIR-V module.");
    std::vector<std::uint32_t> words(bytes.size() / 4);
    std::memcpy(words.data(), bytes.data(), bytes.size());
    if (words[0] != 0x07230203) throw std::runtime_error("Invalid SPIR-V magic.");
    std::map<std::uint32_t, std::uint32_t> locations;
    std::map<std::uint32_t, std::size_t> location_offsets;
    std::map<std::uint32_t, std::uint32_t> input_types, pointees, type_opcodes;
    const auto walk = [&](auto&& visit) {
        for (std::size_t i = 5; i < words.size();) {
            const auto count = words[i] >> 16, opcode = words[i] & 0xffff;
            if (!count || i + count > words.size()) throw std::runtime_error("Invalid SPIR-V instruction.");
            visit(i, opcode, count);
            i += count;
        }
    };
    walk([&](std::size_t i, std::uint32_t opcode, std::uint32_t count) {
        if (opcode == 59 && count >= 4 && words[i + 3] == 1) { // OpVariable Input
            input_types.emplace(words[i + 2], words[i + 1]);
        }
        if (opcode >= 19 && opcode <= 32 && count >= 2) type_opcodes.emplace(words[i + 1], opcode);
        if (opcode == 32 && count == 4) pointees.emplace(words[i + 1], words[i + 3]); // OpTypePointer
        if (opcode == 71 && count == 4 && words[i + 2] == 30) { // OpDecorate Location
            locations.emplace(words[i + 1], words[i + 3]); location_offsets.emplace(words[i + 1], i + 3);
        }
    });
    std::map<std::uint32_t, std::uint32_t> mapping;
    for (const auto& [id, location] : locations) if (input_types.contains(id)) {
        const auto opcode = type_opcodes.at(pointees.at(input_types.at(id)));
        if (opcode != 21 && opcode != 22 && opcode != 23)
            throw std::runtime_error("SPIR-V vertex input must be a scalar or vector.");
        mapping.emplace(location, 0);
    }
    std::uint32_t next = 0;
    for (auto& [location, compact] : mapping) { (void)location; compact = next++; }
    for (const auto& [id, location] : locations) if (input_types.contains(id)) {
        const auto compact = mapping.at(location);
        std::memcpy(bytes.data() + location_offsets.at(id) * 4, &compact, sizeof(compact));
    }
    return mapping;
}
}
