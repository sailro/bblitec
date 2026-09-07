#pragma once

#include <bblite/runtime.hpp>
#include <array>
#include <functional>
#include <memory>
#include <span>
#include <string>
#include <vector>

namespace bbl {

// Packed instance words include integer bit fields. They stay bytes across the
// generation/runtime boundary, including when identical assets share storage.
struct TextStream {
    std::vector<std::uint8_t> bytes;
    std::size_t count = 0;
    std::size_t stride_bytes = 0;
    std::size_t capacity_bytes = 0;
};
struct TextAtlasTexture {
    std::vector<std::uint8_t> bytes;
    std::size_t width = 0;
    std::size_t height = 0;
    std::size_t used_texels = 0;
};
struct TextAtlas {
    std::string curve_set_id;
    double version = 0;
    TextAtlasTexture curves;
    TextAtlasTexture bands;
    TextStream metadata;
};
struct TextDrawGroup {
    std::size_t atlas_index = 0;
    std::string group_key;
    std::size_t slot_start = 0;
    std::size_t slot_count = 0;
    std::size_t live_count = 0;
    // The pin owns this cache on TextData, shared by all its renderables.
    std::shared_ptr<void> bind_group;
    double bind_group_version = -1;
};
struct TextDataPayload {
    double width = 0;
    double height = 0;
    double version = 0;
    double style_version = 0;
    double layout_version = 0;
    std::size_t dirty_start = 0;
    std::size_t dirty_end = 0;
    TextStream instances;
    TextStream styles;
    std::vector<TextAtlas> atlases;
    std::vector<TextDrawGroup> groups;
};
struct TextAtlasGpuState {
    std::function<void()> destroy_curves;
    std::function<void()> destroy_bands;
    std::function<void()> destroy_metadata;
};
struct TextDataState {
    std::shared_ptr<const TextDataPayload> payload;
    std::vector<TextDrawGroup> groups;
    std::size_t instance_count = 0;
    std::size_t style_count = 0;
    double version = 0;
    double style_version = 0;
    double layout_version = 0;
    std::size_t dirty_start = 0;
    std::size_t dirty_end = 0;
    // DefaultTextData owns its atlas storage. Disposing just TextData leaves it.
    std::vector<std::shared_ptr<TextAtlasGpuState>> atlas_gpu;
};
using TextData = std::shared_ptr<TextDataState>;

struct TextQuaternion { double x = 0, y = 0, z = 0, w = 1; };
struct TextRenderableOptions {
    std::optional<Vec3d> position;
    std::optional<TextQuaternion> rotation_quaternion;
    std::optional<Vec3d> scaling;
    std::optional<double> opacity;
    std::optional<bool> ignore_depth;
    std::optional<double> order;
};
// Resource callbacks are native backend leases, never source JS closures. A
// retained DrawBinding can keep this state after renderable disposal, as upstream.
struct TextGpuState {
    std::function<void()> destroy_uniform;
    std::function<void()> destroy_instances;
    std::function<void()> destroy_styles;
    double uploaded_camera_version = -1;
    double uploaded_aspect = -1;
    double uploaded_viewport_w = 0;
    double uploaded_viewport_h = 0;
    double uploaded_opacity = std::numeric_limits<double>::quiet_NaN();
};
struct TextRenderableState {
    TextData data;
    Vec3d position;
    TextQuaternion rotation_quaternion;
    Vec3d scaling;
    Vec3d rotation;
    double quaternion_version = 0;
    double synced_quaternion_version = -1;
    double world_version = 0;
    bool world_cached = false;
    std::array<float, 16> world{};
    bool wm_dirty = true;
    double opacity = 1;
    bool ignore_depth = false;
    double order = 200;
    bool is_transparent = true;
    double version = 0;
    std::shared_ptr<TextGpuState> gpu;
};
using TextRenderable = std::shared_ptr<TextRenderableState>;

struct TextCameraInput {
    const std::array<float, 16>& view_projection;
    double change_key;
    double effective_aspect;
};
using TextUniformWrite = std::function<void(std::size_t, std::span<const std::uint8_t>)>;

} // namespace bbl
