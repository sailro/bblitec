/**
 * The clustered light field as one generated translation unit.
 *
 * The container and its lights are `runtime.hpp` records the emitted scene
 * fills, because both reached scenes build a thousand lights inside a loop.
 * What `addClusteredLightContainer` does is size the three data textures from
 * the light count -- the pin's own `buildClusteredLightGpuState` -- and what
 * each frame does is re-bin every light against the live camera, which is the
 * folded `addLightToClusters`.
 *
 * Two of the pin's per-frame guards fold away, and both for the same measured
 * reason: this port has no way to mutate a light after creating it.
 * `markClusteredLightContainerDirty` refuses at generation and no setter
 * exists, so `snapshotLight`'s change scan could only ever answer "nothing
 * moved". It is not ported and the container version is not read. What
 * remains is the pin's other half of the same test -- whether this frame
 * projects lights into different tiles than the last did -- which the two
 * matrices the cull reads answer directly.
 */
import type { LoweredSource, LoweringContext } from "./context.js";
import {
    clusteredAddLightToClusters,
    clusteredConstants,
    clusteredModule,
    clusteredProjectedBounds,
    clusteredScalarHelpers,
    clusteredSpotStride,
} from "./clustered-light-lowerer.js";

/** The clustered light field's generated header and translation unit. */
export function lowerClusteredLights(
    context: LoweringContext,
): LoweredSource {
    const header = `#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <vector>

#include "bblite/js_data.hpp"
#include "bblite/runtime.hpp"

namespace bbl::upstream {

${clusteredConstants(context)}

${clusteredScalarHelpers(context)}

${clusteredConeWriter(context)}

${clusteredProjectedBounds(context)}

${clusteredAddLightToClusters(context)}

/** \`buildClusteredLightGpuState\`'s sizing, once when the container is
 *  added: every clamp and ceiling in the pin's own order. */
void size_clustered_light_state(ClusteredLightContainer& container);

/** The pin's per-frame \`refresh\`: re-bin every light against the frame's
 *  own two matrices, and rewrite whatever payload that moved. */
void refresh_clustered_lights(
    ClusteredLightContainer& container,
    const std::array<float, 16>& view,
    const std::array<float, 16>& proj,
    double near_plane,
    double far_plane);

/** The container a handle names, for the backend that binds it. Const
 *  because a backend resolving a uniform block holds the engine that way,
 *  and mutable because the frame's re-bin writes through it. */
const ClusteredLightContainer* clustered_container(
    const Engine& engine,
    ClusteredLightContainerHandle handle);
ClusteredLightContainer* clustered_container(
    Engine& engine,
    ClusteredLightContainerHandle handle);

}  // namespace bbl::upstream

namespace bbl {

// The scene surface, at the pin's own four entry points.
ClusteredLightContainerHandle create_clustered_light_container(
    Engine& engine,
    double horizontal_tiles,
    double vertical_tiles,
    double z_slices);

void create_clustered_point_light(
    Engine& engine,
    ClusteredLightContainerHandle container,
    const Vec3d& position,
    const Vec3d& diffuse,
    double range,
    double intensity);

void create_clustered_spot_light(
    Engine& engine,
    ClusteredLightContainerHandle container,
    const Vec3d& position,
    const Vec3d& diffuse,
    double range,
    double intensity,
    const Vec3d& direction,
    double angle);

void add_clustered_light_container(
    Engine& engine,
    Scene& scene,
    ClusteredLightContainerHandle container);

}  // namespace bbl
`;
    const source = `// ${context.provenance(
        clusteredModule,
        "buildClusteredLightGpuState",
    )}
#include "bblite/upstream/clustered_light.hpp"

#include <cstring>
#include <stdexcept>

namespace bbl::upstream {

void size_clustered_light_state(ClusteredLightContainer& container) {
    // Every clamp and ceiling here is the pin's, in its order: each tile
    // count truncates through \`| 0\` and floors at one, and the data texture
    // is as wide as the widest of the three payloads it carries.
    const auto tiles = [](double value) {
        return static_cast<std::uint32_t>(std::max(
            1.0,
            static_cast<double>(static_cast<std::int32_t>(value))));
    };
    container.tile_count_x = tiles(container.horizontal_tiles);
    container.tile_count_y = tiles(container.vertical_tiles);
    container.slice_count = tiles(container.z_slices);
    const auto total = static_cast<std::uint32_t>(container.lights.size());
    const std::uint32_t batches = std::max(
        1u,
        static_cast<std::uint32_t>(std::ceil(
            static_cast<double>(total) /
            static_cast<double>(kClusterBatchSize))));
    container.light_texels = std::max(1u, total * container.stride());
    container.mask_texels = std::max(
        1u,
        container.tile_count_x * container.tile_count_y * batches);
    container.data_texture_width = std::min(
        kMaxDataTextureWidth,
        std::max(
            container.light_texels,
            std::max(container.slice_count, container.mask_texels)));
    const double width = static_cast<double>(container.data_texture_width);
    // One sizing rule, the pin's own \`textureElementCount\`, asked for the
    // element count and then for the row count -- so no backend derives an
    // extent of its own and the two cannot disagree.
    const auto sized = [&](std::uint32_t texels, std::uint32_t components) {
        return static_cast<std::uint32_t>(texture_element_count(
            static_cast<double>(texels),
            static_cast<double>(components),
            width));
    };
    container.light_rows =
        sized(container.light_texels, 1) / container.data_texture_width;
    container.slice_rows =
        sized(container.slice_count, 1) / container.data_texture_width;
    container.mask_rows =
        sized(container.mask_texels, 1) / container.data_texture_width;
    container.light_data.assign(sized(container.light_texels, 4), 0.0f);
    container.slice_data.assign(sized(container.slice_count, 4), 0u);
    container.mask_data.assign(sized(container.mask_texels, 1), 0u);
    container.params[0] = container.tile_count_x;
    container.params[1] = container.tile_count_y;
    container.params[2] = container.slice_count;
    container.params[3] = total;
    container.params[6] = container.data_texture_width;
    container.params[7] = batches;
}

void refresh_clustered_lights(
    ClusteredLightContainer& container,
    const std::array<float, 16>& view,
    const std::array<float, 16>& proj,
    double near_plane,
    double far_plane) {
    // The frame's own two matrices, which the caller already built. They are
    // also the dirty key: nothing else the pin's four proxies stand for can
    // move the tiles a light lands in.
    if (container.binned && container.last_view == view &&
        container.last_proj == proj) {
        return;
    }
    const double log_far_near = std::log(far_plane / near_plane);
    const double slices = static_cast<double>(container.slice_count);
    const double slice_scale = slices / log_far_near;
    const double slice_bias =
        -(slices * std::log(near_plane)) / log_far_near;

    // The pin collects the active lights, sorts them by view depth and bins
    // in that order -- the slice range it writes is a running min/max over
    // light INDEX, and the sorted position becomes that index, so the order
    // decides both what a slice spans and where each light's texels land.
    // The sort is stable for the reason the pin's is: \`Array.prototype.sort\`
    // has been spec-stable since ES2019, and a tie broken differently would
    // move pixels.
    struct ActiveLight {
        const ClusteredLight* light;
        double depth;
    };
    std::vector<ActiveLight> active;
    active.reserve(container.lights.size());
    for (const auto& light : container.lights) {
        if (light.range > 0.0 && light.intensity > 0.0) {
            active.push_back(
                {&light, clustered_view_z(light.position, view)});
        }
    }
    std::stable_sort(
        active.begin(),
        active.end(),
        [](const ActiveLight& a, const ActiveLight& b) {
            return a.depth < b.depth;
        });
    const auto active_batches = std::max(
        1u,
        static_cast<std::uint32_t>(std::ceil(
            static_cast<double>(active.size()) /
            static_cast<double>(kClusterBatchSize))));
    const auto active_mask_texels = std::min<std::size_t>(
        static_cast<std::size_t>(container.tile_count_x) *
            container.tile_count_y * active_batches,
        container.mask_data.size());
    // The pin clears its whole slice array. Only the live prefix is ever
    // written -- the seed loop below and \`add_light_to_clusters\` both stop
    // at \`slice_count\` -- so the padding it also clears is zero from the
    // \`assign\` above and stays so.
    std::fill(
        container.slice_data.begin(),
        container.slice_data.begin() +
            static_cast<std::ptrdiff_t>(container.slice_count) * 4,
        0u);
    std::fill(
        container.mask_data.begin(),
        container.mask_data.begin() +
            static_cast<std::ptrdiff_t>(active_mask_texels),
        0u);
    for (std::uint32_t i = 0; i < container.slice_count; i++) {
        const auto off = static_cast<std::size_t>(i) * 4;
        container.slice_data[off] = kEmptySliceFirst;
        container.slice_data[off + 1] = 0u;
    }
    for (std::size_t i = 0; i < active.size(); i++) {
        add_light_to_clusters(
            container.slice_data,
            container.mask_data,
            *active[i].light,
            active[i].depth,
            static_cast<double>(i),
            view,
            proj,
            static_cast<double>(container.tile_count_x),
            static_cast<double>(container.tile_count_y),
            static_cast<double>(container.slice_count),
            slice_scale,
            slice_bias,
            static_cast<double>(active_batches));
    }
    container.params[3] = static_cast<std::uint32_t>(active.size());
    // Two of the eight params lanes are floats over the same bytes, which is
    // what the pin's one \`ArrayBuffer(32)\` viewed as both a U32 and an F32
    // gives the shader.
    const float slice_scale_f = static_cast<float>(slice_scale);
    const float slice_bias_f = static_cast<float>(slice_bias);
    std::memcpy(&container.params[4], &slice_scale_f, sizeof(float));
    std::memcpy(&container.params[5], &slice_bias_f, sizeof(float));
    container.params[7] = active_batches;

    // The light payload in the pin's own texel order: position and range,
    // then colour and intensity, then the cone for a spot container.
    const auto stride = static_cast<std::size_t>(container.stride());
    for (std::size_t i = 0; i < active.size(); i++) {
        const auto& light = *active[i].light;
        const auto off = i * stride * 4;
        container.light_data[off] = static_cast<float>(light.position[0]);
        container.light_data[off + 1] = static_cast<float>(light.position[1]);
        container.light_data[off + 2] = static_cast<float>(light.position[2]);
        container.light_data[off + 3] = static_cast<float>(light.range);
        container.light_data[off + 4] = static_cast<float>(light.diffuse[0]);
        container.light_data[off + 5] = static_cast<float>(light.diffuse[1]);
        container.light_data[off + 6] = static_cast<float>(light.diffuse[2]);
        container.light_data[off + 7] = static_cast<float>(light.intensity);
        if (stride == 3) {
            write_clustered_cone(container.light_data, off, light);
        }
    }
    container.last_view = view;
    container.last_proj = proj;
    container.binned = true;
    container.upload_version++;
}

const ClusteredLightContainer* clustered_container(
    const Engine& engine,
    ClusteredLightContainerHandle handle) {
    return handle.value < engine.clustered_light_containers.size()
        ? &engine.clustered_light_containers[handle.value]
        : nullptr;
}

ClusteredLightContainer* clustered_container(
    Engine& engine,
    ClusteredLightContainerHandle handle) {
    return const_cast<ClusteredLightContainer*>(clustered_container(
        static_cast<const Engine&>(engine), handle));
}

}  // namespace bbl::upstream

namespace bbl {

ClusteredLightContainerHandle create_clustered_light_container(
    Engine& engine,
    double horizontal_tiles,
    double vertical_tiles,
    double z_slices) {
    auto& containers = engine.clustered_light_containers;
    containers.push_back(ClusteredLightContainer{});
    auto& container = containers.back();
    container.horizontal_tiles = horizontal_tiles;
    container.vertical_tiles = vertical_tiles;
    container.z_slices = z_slices;
    return ClusteredLightContainerHandle{
        static_cast<std::uint32_t>(containers.size() - 1)};
}

void create_clustered_point_light(
    Engine& engine,
    ClusteredLightContainerHandle handle,
    const Vec3d& position,
    const Vec3d& diffuse,
    double range,
    double intensity) {
    auto* container = upstream::clustered_container(engine, handle);
    if (!container) return;
    container->lights.push_back(ClusteredLight{
        {position.x, position.y, position.z},
        {diffuse.x, diffuse.y, diffuse.z},
        range,
        intensity,
        {},
        0.0,
        false});
}

void create_clustered_spot_light(
    Engine& engine,
    ClusteredLightContainerHandle handle,
    const Vec3d& position,
    const Vec3d& diffuse,
    double range,
    double intensity,
    const Vec3d& direction,
    double angle) {
    auto* container = upstream::clustered_container(engine, handle);
    if (!container) return;
    container->lights.push_back(ClusteredLight{
        {position.x, position.y, position.z},
        {diffuse.x, diffuse.y, diffuse.z},
        range,
        intensity,
        {direction.x, direction.y, direction.z},
        angle,
        true});
    container->has_spots = true;
}

void add_clustered_light_container(
    Engine& engine,
    Scene& scene,
    ClusteredLightContainerHandle handle) {
    auto* container = upstream::clustered_container(engine, handle);
    if (!container) {
        throw std::runtime_error(
            "addClusteredLightContainer: unknown container.");
    }
    scene.clustered_lights = handle;
    upstream::size_clustered_light_state(*container);
}

}  // namespace bbl
`;
    return {
        header,
        source,
        modulePath: clusteredModule,
        symbolName: "buildClusteredLightGpuState",
    };
}

/**
 * The spot cone's third texel, from `clustered-spot-support.ts`'s `_write`.
 *
 * Its two rules are the pin's and neither is guessable: the direction
 * normalizes through a RECIPROCAL multiply with a zero/unit-length shortcut
 * (`len === 0 || len === 1 ? 1 : 1 / len`, matching Babylon.js), and the cone
 * stores `cos(clamp(angle, 0, PI) * 0.5)`. A point light in a spot container
 * writes `w = -1`, the sentinel the fragment tests.
 *
 * `_write` is a property of an object literal built inside `spotSupport
 * ._create`, one nesting level past what `context.propertyFunction` resolves,
 * so it is restated here rather than folded. `clusteredSpotStride` anchors the
 * stride that decides whether it runs at all, so a pin that stopped writing a
 * third texel fails generation rather than leaving this dead.
 */
function clusteredConeWriter(context: LoweringContext): string {
    const stride = clusteredSpotStride(context);
    return `// ${context.provenance(
        "src/light/clustered-spot-support.ts",
        "_write",
    )}
// The pin's own spot stride is ${stride}: three texels per light, the third
// carrying the cone this writes.
inline void write_clustered_cone(
    std::vector<float>& data,
    std::size_t offset,
    const ClusteredLight& light) {
    if (!light.spot) {
        data[offset + 8] = 0.0f;
        data[offset + 9] = 0.0f;
        data[offset + 10] = 0.0f;
        data[offset + 11] = -1.0f;
        return;
    }
    const double dx = light.direction[0];
    const double dy = light.direction[1];
    const double dz = light.direction[2];
    const double len = std::sqrt(dx * dx + dy * dy + dz * dz);
    const double inv = (len == 0.0 || len == 1.0) ? 1.0 : 1.0 / len;
    data[offset + 8] = static_cast<float>(dx * inv);
    data[offset + 9] = static_cast<float>(dy * inv);
    data[offset + 10] = static_cast<float>(dz * inv);
    data[offset + 11] = static_cast<float>(std::cos(
        std::min(std::max(light.angle, 0.0), 3.141592653589793) * 0.5));
}`;
}
