#pragma once

#include <bblite/runtime.hpp>

#include <cstddef>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>

// WebGPU's usage and stage bits and texel layouts, as every WebGPU-shaped
// device on either backend (the WebGPU subset, text) reads a descriptor's.

namespace bbl::pal {

/** The texel of an uncompressed WebGPU format: its size and whether it is integer. */
struct WebGpuTexelLayout {
    std::size_t bytes;
    bool integer;
};

inline WebGpuTexelLayout webgpu_texel_layout(std::string_view format) {
    static constexpr std::pair<std::string_view, WebGpuTexelLayout> layouts[] = {
        {"r8unorm", {1, false}},         {"r16float", {2, false}},   {"rgba8unorm", {4, false}},
        {"rgba8unorm-srgb", {4, false}}, {"rgba8snorm", {4, false}}, {"bgra8unorm", {4, false}},
        {"bgra8unorm-srgb", {4, false}}, {"rg16float", {4, false}},  {"r32float", {4, false}},
        {"rgba16float", {8, false}},     {"rg32float", {8, false}},  {"rg32uint", {8, true}},
        {"rgba32float", {16, false}}};
    for (const auto& [name, layout] : layouts)
        if (name == format)
            return layout;
    throw std::runtime_error("Texture format '" + std::string(format) + "' has no texel layout.");
}

/** `GPUBufferUsage` bits. */
namespace webgpu_buffer_usage {
inline constexpr std::uint32_t map_read = 0x1, map_write = 0x2, copy_src = 0x4, copy_dst = 0x8,
                               index = 0x10, vertex = 0x20, uniform = 0x40, storage = 0x80,
                               indirect = 0x100, query_resolve = 0x200;
} // namespace webgpu_buffer_usage
/** `GPUTextureUsage` bits. */
namespace webgpu_texture_usage {
inline constexpr std::uint32_t copy_src = 0x1, copy_dst = 0x2, texture_binding = 0x4,
                               storage_binding = 0x8, render_attachment = 0x10;
} // namespace webgpu_texture_usage
/** `GPUShaderStage` bits. */
namespace webgpu_shader_stage {
inline constexpr std::uint32_t vertex = 0x1, fragment = 0x2, compute = 0x4;
} // namespace webgpu_shader_stage

inline std::uint32_t webgpu_flags(double value) { return gpu_u32(gpu_size(value)); }

/** Whether a descriptor's `usage` carries `bit`. */
inline bool webgpu_usage_has(double usage, std::uint32_t bit) {
    return (webgpu_flags(usage) & bit) != 0;
}

} // namespace bbl::pal
