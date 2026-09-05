#pragma once

#include <cstdint>
#include <stdexcept>

namespace bbl::pal::audio_handles {

inline constexpr std::uint32_t max_component = 0xffffu;

inline void require_context_id(std::uint32_t context) {
    if (context == 0 || context > max_component) {
        throw std::runtime_error("Audio context handle space exhausted.");
    }
}

inline std::uint32_t pack(std::uint32_t context, std::uint32_t index) {
    require_context_id(context);
    if (index > max_component) {
        throw std::runtime_error("Too many audio nodes or buffers in one context.");
    }
    return (context << 16) | index;
}

constexpr std::uint32_t context_of(std::uint32_t packed) { return packed >> 16; }
constexpr std::uint32_t index_of(std::uint32_t packed) { return packed & max_component; }

} // namespace bbl::pal::audio_handles
