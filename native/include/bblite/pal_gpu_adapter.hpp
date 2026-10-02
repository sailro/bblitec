#pragma once

#include <charconv>
#include <cstdint>
#include <string>

namespace bbl::pal {

/** Immutable native metadata, copied between realms without GPU or JavaScript ownership. */
struct GpuAdapterInfo {
    std::string vendor;
    std::string architecture;
    std::string device;
    std::string description;
};

inline std::string gpu_adapter_hex_id(std::uint32_t id) {
    if (!id)
        return {};
    char digits[8];
    const auto result = std::to_chars(digits, digits + sizeof(digits), id, 16);
    return "0x" + std::string(digits, result.ptr);
}

/** PCI vendor IDs name chip vendors; unlisted IDs retain their numeric identity. */
inline std::string gpu_adapter_vendor(std::uint32_t id) {
    switch (id) {
    case 0x1002:
        return "amd";
    case 0x1010:
        return "imgtec";
    case 0x106b:
        return "apple";
    case 0x10de:
        return "nvidia";
    case 0x13b5:
        return "arm";
    case 0x14e4:
        return "broadcom";
    case 0x5143:
        return "qualcomm";
    case 0x8086:
        return "intel";
    default:
        return gpu_adapter_hex_id(id);
    }
}

} // namespace bbl::pal
