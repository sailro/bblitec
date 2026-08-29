#pragma once

// GPU picking on Dawn. The contract is stated once in
// `pal_sdl_gpu_picking.hpp`; what differs here is only the API layer, and
// the two facts WebGPU adds:
//
//   * the pin's groups map natively, so the mesh pass declares group 0 for
//     the scene block and group 1 for the per-candidate block, and the
//     cloud pass declares the pin's own three. SDL_GPU reaches the same
//     bindings through the `.slots` sidecar because its stages went through
//     a register remap; nothing here does.
//   * a readback is a mapped buffer rather than a fenced download, so the
//     pick waits on `wgpuBufferMapAsync` where SDL waits on a fence.
//
// The per-candidate block is rewritten between draws, which WebGPU forbids
// inside a pass: every candidate therefore owns its own slice of one
// uniform buffer, bound at a dynamic offset the pass advances. SDL_GPU
// pushes the same bytes per draw and needs no such buffer.

#include <bblite/runtime.hpp>

#include "pal_dawn_shared.hpp"
#include "pal_gpu_shared.hpp"

#include <array>
#include <cstdint>
#include <cstring>
#include <vector>

namespace bbl::pal {

/**
 * The pin's `MeshUniforms` at WebGPU's 256-byte dynamic-offset alignment,
 * so one buffer can carry every candidate's block.
 *
 * The scene block needs no twin: `PickSceneUniforms` in
 * `pal_gpu_shared.hpp` is the pin's own layout and both backends upload it
 * unchanged. Only this one differs, and only in its stride -- which the
 * language computes from `alignas` rather than a hand-counted tail, so a
 * field added here cannot silently move it.
 */
struct alignas(256) DawnPickMeshUniforms {
    std::array<float, 16> world{};
    std::uint32_t pick_id = 0;
};
static_assert(
    sizeof(DawnPickMeshUniforms) == 256,
    "a pick candidate's block is one dynamic-offset stride");

/** The one-pixel target set and the buffer its id and depth are mapped from. */
struct DawnPickTargets {
    WGPUTexture color = nullptr;
    WGPUTextureView color_view = nullptr;
    WGPUTexture depth_color = nullptr;
    WGPUTextureView depth_color_view = nullptr;
    WGPUTexture depth = nullptr;
    WGPUTextureView depth_view = nullptr;
    WGPUBuffer staging = nullptr;
};

inline void release_dawn_pick_targets(DawnPickTargets& targets) {
    for (WGPUTextureView* view :
         {&targets.color_view,
          &targets.depth_color_view,
          &targets.depth_view}) {
        if (*view) wgpuTextureViewRelease(*view);
        *view = nullptr;
    }
    for (WGPUTexture* texture :
         {&targets.color, &targets.depth_color, &targets.depth}) {
        if (*texture) wgpuTextureRelease(*texture);
        *texture = nullptr;
    }
    if (targets.staging) wgpuBufferRelease(targets.staging);
    targets.staging = nullptr;
}

inline void ensure_dawn_pick_targets(
    WGPUDevice device,
    DawnPickTargets& targets) {
    if (targets.color) return;
    const auto attachment =
        [&](WGPUTextureFormat format,
            WGPUTextureUsage extra) -> WGPUTexture {
        WGPUTextureDescriptor descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
        descriptor.dimension = WGPUTextureDimension_2D;
        descriptor.format = format;
        descriptor.usage = WGPUTextureUsage_RenderAttachment | extra;
        descriptor.size = WGPUExtent3D{1, 1, 1};
        WGPUTexture texture = wgpuDeviceCreateTexture(device, &descriptor);
        if (!texture) dawn_error("pick attachment");
        return texture;
    };
    const auto view = [](WGPUTexture texture) -> WGPUTextureView {
        WGPUTextureViewDescriptor descriptor =
            WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
        WGPUTextureView created =
            wgpuTextureCreateView(texture, &descriptor);
        if (!created) dawn_error("pick attachment view");
        return created;
    };
    targets.color = attachment(
        WGPUTextureFormat_RGBA8Unorm, WGPUTextureUsage_CopySrc);
    targets.color_view = view(targets.color);
    targets.depth_color = attachment(
        WGPUTextureFormat_R32Float, WGPUTextureUsage_CopySrc);
    targets.depth_color_view = view(targets.depth_color);
    targets.depth =
        attachment(WGPUTextureFormat_Depth24Plus, WGPUTextureUsage_None);
    targets.depth_view = view(targets.depth);

    WGPUBufferDescriptor staging = WGPU_BUFFER_DESCRIPTOR_INIT;
    staging.usage = WGPUBufferUsage_CopyDst | WGPUBufferUsage_MapRead;
    staging.size = 512;
    targets.staging = wgpuDeviceCreateBuffer(device, &staging);
    if (!targets.staging) dawn_error("pick staging buffer");
}

/** The mesh pass's two groups, in the pin's own order. */
inline WGPUBindGroupLayout create_dawn_pick_scene_layout(
    WGPUDevice device) {
    WGPUBindGroupLayoutEntry entry = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
    entry.binding = 0;
    entry.visibility = WGPUShaderStage_Vertex | WGPUShaderStage_Fragment;
    entry.buffer.type = WGPUBufferBindingType_Uniform;
    WGPUBindGroupLayoutDescriptor descriptor =
        WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
    descriptor.entryCount = 1;
    descriptor.entries = &entry;
    WGPUBindGroupLayout layout =
        wgpuDeviceCreateBindGroupLayout(device, &descriptor);
    if (!layout) dawn_error("pick scene bind group layout");
    return layout;
}

inline WGPUBindGroupLayout create_dawn_pick_mesh_layout(
    WGPUDevice device) {
    WGPUBindGroupLayoutEntry entry = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
    entry.binding = 0;
    entry.visibility = WGPUShaderStage_Vertex | WGPUShaderStage_Fragment;
    entry.buffer.type = WGPUBufferBindingType_Uniform;
    entry.buffer.hasDynamicOffset = true;
    entry.buffer.minBindingSize = sizeof(DawnPickMeshUniforms);
    WGPUBindGroupLayoutDescriptor descriptor =
        WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
    descriptor.entryCount = 1;
    descriptor.entries = &entry;
    WGPUBindGroupLayout layout =
        wgpuDeviceCreateBindGroupLayout(device, &descriptor);
    if (!layout) dawn_error("pick mesh bind group layout");
    return layout;
}

/** The pin's own pair of attachments, shared by both pick pipelines. */
inline void fill_dawn_pick_targets(
    std::array<WGPUColorTargetState, 2>& targets) {
    for (WGPUColorTargetState& target : targets) {
        target = WGPU_COLOR_TARGET_STATE_INIT;
        target.writeMask = WGPUColorWriteMask_All;
    }
    targets[0].format = WGPUTextureFormat_RGBA8Unorm;
    targets[1].format = WGPUTextureFormat_R32Float;
}

} // namespace bbl::pal
