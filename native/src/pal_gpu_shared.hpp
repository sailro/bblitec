// Vertex packing shared by the SDL_GPU and Dawn render backends.
// Moved verbatim from pal_sdl_gpu.cpp so both backends upload
// byte-identical vertex data.
#pragma once

#include <bblite/pal.hpp>
#include <bblite/pal_image.hpp>
#include <bblite/runtime.hpp>
#include <bblite/ts_runtime.hpp>
#include <bblite/upstream/render_capabilities.hpp>
// An always-emitted pinned read every scene shape carries: the surface
// sample count (the effect drivers compile with no renderer_plan.hpp, so it
// cannot ride that header).
#include <bblite/upstream/pinned_surface.hpp>
// The generated material texture-slot table both render backends execute:
// which record field fills each slot, its sRGB rule, its fallback texel and
// the pinned binding names it serves. Emitted for every scene beside the
// capability defines, so the include is unconditional.
#include <bblite/upstream/material_texture_slots.hpp>
// The render plan is generated only for scenes that register a
// SceneContext; a sprite-only scene has none, and reaches this header for
// the frame options, capture gate and clock alone.
#if defined(BBLITE_HAS_PBR_RENDERER) && BBLITE_HAS_PBR_RENDERER
#include <bblite/upstream/renderer_plan.hpp>
#endif
// Babylon Lite's own composed PBR variants: one entry per material feature
// set the scene's assets reach, each naming its compiled stages and the byte
// size of the per-variant material UBO the pin declares for it. Included here
// because both backends will bind them; a scene with no glTF materials
// reaches none and emits no header.
#if BBLITE_PBR_VARIANTS > 0
#include <bblite/upstream/pbr_variants.hpp>
#endif
// The Standard family's composed variants: the same shape, one entry per
// feature word the scene's materials and meshes reach, plus the selector and
// lowered UBO writers its support block appends. When no pbr_variants.hpp is
// emitted the header hoists the shared scene/lights/mesh mirrors itself, so
// the include order here (after the PBR header) is what keeps one definition.
#if BBLITE_STANDARD_VARIANTS > 0
#include <bblite/upstream/standard_variants.hpp>
#endif
// The pinned shadow family: the light-space matrices, the receiver block,
// the generator's defaults and the standard-Z depth state its map takes.
// None of that is a material family's, so the header and the depth state
// below ride `BBLITE_SHADOW_RECEIVERS` -- generation's own answer to "does
// this scene reach a shadow generator AND compose a receiver in SOME
// family". `BBLITE_SHADOWS_ESM` is a Standard conjunction, because what it
// gates includes the caster's own material view and only the Standard
// family has one -- so a scene reaching the ESM filter with no Standard
// variant is refused at generation rather than compiled to a define of
// zero.
#if BBLITE_SHADOW_RECEIVERS
#include <bblite/upstream/pinned_shadow.hpp>
#endif
#if BBLITE_SHADOWS_ESM
#include <bblite/upstream/esm_shadow.hpp>
#endif
#include <bblite/upstream/pinned_depth_state.hpp>

namespace bbl::pal {

inline std::string sprite_fragment_shader_name(
    std::uint32_t program) {
    if (program == 0u) return "sprite.frag";
    if (program == 1u) return "sprite_custom.frag";
    return "sprite_custom_" + std::to_string(program) + ".frag";
}

#if BBLITE_FLOATING_ORIGIN
/**
 * The scene's active camera, whose world translation IS the floating-origin
 * offset.
 *
 * The pin derives the offset from `scene.camera.worldMatrix` at the moment
 * of use rather than mirroring it into scene state, so this port reads it
 * the same way -- one accessor, so the mesh world, the view transpose and
 * the lights block cannot disagree about which camera the frame is
 * relative to. A scene with no camera yields the record default, whose
 * world is the identity, which is the pin's own zero offset.
 */
inline const CameraRecord& floating_origin_camera(
    const Scene& scene,
    const Engine& engine) {
    static const CameraRecord none{};
    return scene.camera.value < engine.cameras.size()
        ? engine.cameras[scene.camera.value]
        : none;
}

/**
 * That camera's world translation, which every consumer subtracts.
 *
 * In the camera's own width, not the float world matrix's: under the pin's
 * high-precision matrix the camera's storage is F64, so the offset is the
 * unrounded eye and every `large - large = small` runs at full width.
 */
inline Vec3d floating_origin_offset(
    const Scene& scene,
    const Engine& engine) {
    return upstream::arc_rotate_eye_position(
        floating_origin_camera(scene, engine));
}

/**
 * The positional light entries, rebuilt eye-relative.
 *
 * `applyLightFoOffset` rewrites each point (type 0) and spot (type 2) slot
 * from the light's own world translation minus the camera's, discarding the
 * absolute position the writer left there -- so the `large - large = small`
 * cancellation happens once, at full width, rather than in the shader
 * against an eye-relative `worldPos`. Direction-only entries (directional,
 * hemispheric) are left alone.
 */
inline void apply_light_floating_origin(
    std::vector<upstream::LightEntry>& entries,
    std::uint32_t count,
    const Scene& scene,
    const Engine& engine) {
    const Vec3d offset = floating_origin_offset(scene, engine);
    std::uint32_t written = 0;
    for (const LightHandle handle : scene.lights) {
        if (written >= count) break;
        if (handle.value >= engine.lights.size()) continue;
        const LightRecord& light = engine.lights[handle.value];
        // The pin's own test: the type tag in `vLightData.w`, 0 for a point
        // light and 2 for a spot. A direction-only entry is left alone.
        const float type = entries[written].vLightData[3];
        if (type == 0.0f || type == 2.0f) {
            // From the light's WORLD translation, which is what
            // `applyLightFoOffset` rewrites the slot from -- and what the
            // writer beside it already reads. `light.position` agrees for
            // an unparented light and would drift the moment one is not.
            // From `light.position`, which is the field the entry writer
            // composes its own local matrix from and the one every path
            // fills -- the glTF punctual-light emission writes the
            // flattened world there and leaves `local_matrix` alone, so
            // reading that instead would put an imported light at the
            // origin.
            entries[written].vLightData[0] =
                static_cast<float>(light.position.x - offset.x);
            entries[written].vLightData[1] =
                static_cast<float>(light.position.y - offset.y);
            entries[written].vLightData[2] =
                static_cast<float>(light.position.z - offset.z);
        }
        ++written;
    }
}
#endif

inline bool sprite_blend_equal(
    const SpriteBlendDescriptor& left,
    const SpriteBlendDescriptor& right) {
    return left.enabled == right.enabled &&
        left.color.src == right.color.src &&
        left.color.dst == right.color.dst &&
        left.alpha.src == right.alpha.src &&
        left.alpha.dst == right.alpha.dst;
}

/** Backend-neutral fixed/layout choices for one Sprite2D pipeline. */
struct SpriteLayerPipelinePlan {
    bool scroll = false;
    bool has_depth = false;
    bool depth_write = false;
    bool alpha_to_coverage = false;
    std::uint32_t instance_stride_bytes = 0;
};

inline SpriteLayerPipelinePlan sprite_layer_pipeline_plan(
    const Sprite2DLayerRecord& layer) {
    const bool has_depth =
        layer.depth_mode != Sprite2DDepthMode::none;
    return SpriteLayerPipelinePlan{
        layer.uv_scroll,
        has_depth,
        layer.depth_mode == Sprite2DDepthMode::test_write,
        layer.alpha_to_coverage,
        layer.instance_floats_per_sprite *
            static_cast<std::uint32_t>(sizeof(float))};
}

/** Fixed pipeline identity for layers targeting the same scene pass. */
inline bool sprite_scene_pipeline_compatible(
    const Sprite2DLayerRecord& left,
    const Sprite2DLayerRecord& right) {
    const SpriteLayerPipelinePlan left_plan =
        sprite_layer_pipeline_plan(left);
    const SpriteLayerPipelinePlan right_plan =
        sprite_layer_pipeline_plan(right);
    return sprite_blend_equal(left.blend, right.blend) &&
        left_plan.scroll == right_plan.scroll &&
        left_plan.has_depth == right_plan.has_depth &&
        left_plan.depth_write == right_plan.depth_write &&
        left_plan.alpha_to_coverage == right_plan.alpha_to_coverage &&
        left.custom_shader == right.custom_shader &&
        left.custom_textures.size() == right.custom_textures.size() &&
        left_plan.instance_stride_bytes ==
            right_plan.instance_stride_bytes;
}


#if defined(BBLITE_HAS_PBR_RENDERER) && BBLITE_HAS_PBR_RENDERER
/**
 * A pipeline cache key over a variant, its pipeline kind and the per-pass
 * flags that change fixed-function state.
 *
 * The multiplier separating the variant from the kind is the enum's own
 * size, so a kind added upstream widens every key instead of colliding with
 * one -- which the hand-rolled multipliers could not promise: the tightest
 * of them left five spare kinds, and nothing would have failed at the
 * sixth.
 */
inline std::size_t variant_pipeline_key(
    std::size_t variant,
    upstream::RenderPipelineKind kind,
    std::initializer_list<bool> flags) {
    std::size_t key = variant * upstream::render_pipeline_kind_count +
        static_cast<std::size_t>(kind);
    for (const bool flag : flags) key = key * 2 + (flag ? 1 : 0);
    return key;
}

/**
 * The variant an ESM caster pipeline is keyed by.
 *
 * A caster's colour format is its own generator's recorded row, so two
 * generators whose factories returned different formats must not share a
 * pipeline. Folding the generator's ESM ordinal into the VARIANT rather
 * than into the key is what keeps that fold independent of how many flags
 * `variant_pipeline_key` happens to pack -- the arithmetic used to be
 * restated per call site, each with its own list of `false`s to keep in
 * step.
 */
inline std::size_t esm_keyed_variant(
    std::size_t variant,
    std::size_t variant_count,
    std::uint32_t esm_shadow_index) {
    return esm_shadow_index == invalid_handle
        ? variant
        : variant + (esm_shadow_index + 1) * variant_count;
}
#endif

/**
 * The depth state one pass takes: the pin's own convention, or the shadow
 * target's exception to it.
 *
 * `createShadowRenderTarget` is the single place upstream names another
 * compare and another clear, and generation emits both from that descriptor
 * — so a pass asks here rather than either backend typing standard-Z out.
 */
inline DepthCompare pass_depth_compare(bool shadow_pass) {
#if BBLITE_SHADOW_RECEIVERS
    if (shadow_pass) return upstream::shadow_map_depth_compare;
#else
    (void)shadow_pass;
#endif
    return upstream::pinned_depth_compare;
}

inline float pass_depth_clear(bool shadow_pass) {
#if BBLITE_SHADOW_RECEIVERS
    if (shadow_pass) return upstream::shadow_map_depth_clear;
#else
    (void)shadow_pass;
#endif
    return upstream::pinned_depth_clear;
}


/**
 * How many samples a pass rasterizes at.
 *
 * The third field of the same exception: `createShadowRenderTarget` names
 * one sample, because a multisampled map would need a resolve before the
 * receiver could sample it and the pin builds none. Emitted from that
 * descriptor beside the compare and the clear, so all three answer from one
 * reading of the pin rather than two read and one typed.
 */
inline std::uint32_t pass_depth_samples(
    bool shadow_pass,
    std::uint32_t scene_samples) {
#if BBLITE_SHADOW_RECEIVERS
    if (shadow_pass) return upstream::shadow_map_samples;
#else
    (void)shadow_pass;
#endif
    return scene_samples;
}

} // namespace bbl::pal
// The node family's compiled graphs: one entry per graph the scene parsed,
// each naming its stages, its vertex inputs and its uniform block. It hoists
// the shared scene/lights mirrors when neither header above is emitted, so
// the include order continues the same one-definition rule.
#if BBLITE_NODE_VARIANTS > 0
#include <bblite/upstream/node_variants.hpp>
#endif

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <iomanip>
#include <iostream>
#include <limits>
#include <memory>
#include <stdexcept>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace bbl::pal {

/** Apply a cloned imported root after the mesh's own/deformation world. */
inline Vec3 rotate_outer_point(Vec3 point, const Vec3& rotation) {
    const float sin_x = std::sin(rotation.x);
    const float cos_x = std::cos(rotation.x);
    const float sin_y = std::sin(rotation.y);
    const float cos_y = std::cos(rotation.y);
    const float sin_z = std::sin(rotation.z);
    const float cos_z = std::cos(rotation.z);
    point = Vec3{
        point.x,
        point.y * cos_x - point.z * sin_x,
        point.y * sin_x + point.z * cos_x};
    point = Vec3{
        point.x * cos_y + point.z * sin_y,
        point.y,
        -point.x * sin_y + point.z * cos_y};
    return Vec3{
        point.x * cos_z - point.y * sin_z,
        point.x * sin_z + point.y * cos_z,
        point.z};
}

inline std::array<float, 16> outer_draw_world(
    std::array<float, 16> world,
    const MeshRecord& record) {
    if (
        record.outer_rotation.x != 0.0f ||
        record.outer_rotation.y != 0.0f ||
        record.outer_rotation.z != 0.0f) {
        for (std::size_t column = 0; column < 4; ++column) {
            const std::size_t offset = column * 4;
            const Vec3 rotated = rotate_outer_point(
                Vec3{world[offset], world[offset + 1], world[offset + 2]},
                record.outer_rotation);
            world[offset] = rotated.x;
            world[offset + 1] = rotated.y;
            world[offset + 2] = rotated.z;
        }
    }
    world[12] += record.outer_position.x;
    world[13] += record.outer_position.y;
    world[14] += record.outer_position.z;
    return world;
}

/** Column-major matrix product, matching the generated pinned multiply. */
inline std::array<float, 16> draw_matrix_product(
    const std::array<float, 16>& left,
    const std::array<float, 16>& right) {
    std::array<float, 16> result{};
    for (std::size_t column = 0; column < 4; ++column) {
        for (std::size_t row = 0; row < 4; ++row) {
            double sum = 0.0;
            for (std::size_t term = 0; term < 4; ++term) {
                sum += static_cast<double>(left[term * 4 + row]) *
                    static_cast<double>(right[column * 4 + term]);
            }
            result[column * 4 + row] = static_cast<float>(sum);
        }
    }
    return result;
}

/**
 * The floating-origin offset, or the zero vector when the mode is off.
 *
 * The `#if` lives here rather than at each call site for the same reason
 * `draw_world` below holds its own: a consumer asks what the offset is and
 * gets one answer, whichever build it is in.
 */
inline Vec3d frame_floating_origin_offset(
    [[maybe_unused]] const Scene& scene,
    [[maybe_unused]] const Engine& engine) {
#if BBLITE_FLOATING_ORIGIN
    return floating_origin_offset(scene, engine);
#else
    return Vec3d{};
#endif
}

/**
 * The world one draw carries, from the base world its family chose.
 *
 * Ordinarily that base IS the drawn world -- this port bakes a mesh's TRS
 * into its vertices, so the base carries only the conventions around it (the
 * PBR X mirror, a thin-instanced pool's parent, a skinned draw's palette
 * entry) -- and the clone offset is added after it.
 *
 * Under floating origin the vertices are LOCAL, so the mesh's own TRS comes
 * back into the matrix and the whole product is rebuilt eye-relative in
 * double. Every family asks here, so which frame a draw is in is one answer
 * rather than one per family.
 */
inline std::array<float, 16> draw_world(
    const std::array<float, 16>& base,
    const MeshRecord& record,
    [[maybe_unused]] const Scene& scene,
    [[maybe_unused]] const Engine& engine) {
#if BBLITE_FLOATING_ORIGIN
    return upstream::mesh_world_eye_relative(
        record,
        base,
        floating_origin_offset(scene, engine));
#else
#if defined(BBLITE_HAS_PBR_RENDERER) && BBLITE_HAS_PBR_RENDERER
    if (record.gpu_world_transform) {
        return outer_draw_world(
            draw_matrix_product(
                base,
                upstream::mesh_world_matrix(engine, record)),
            record);
    }
#endif
    return outer_draw_world(base, record);
#endif
}

#if BBLITE_GPU_INSTANCING
/**
 * The instance parent world one thin-instanced draw carries.
 *
 * The pin composes `finalWorld = mesh.world * instanceWorld` and uploads
 * the instance stream UNOFFSET -- `thin-instance-gpu.ts` packs it through
 * the precision-only `packMat4IntoF32`, never `packMat4IntoF32WithOffset`
 * -- so under floating origin the whole eye-relative subtraction belongs
 * to `mesh.world`, which is this matrix. Subtracting per instance as well
 * would bias the translation twice; scene 204's own source says so, and the
 * large-world page's "thin-instance per-instance world matrices" line is
 * the scene it is covered by rather than a second bake.
 *
 * Only the BASE differs between the two frames, so the frame itself stays
 * `draw_world`'s single answer. `build_instance_parent_world` composes the
 * record's TRS onto the recorded parent because a pooled mesh keeps LOCAL
 * vertices with the mode off, and `mesh_world_eye_relative` composes that
 * same TRS because every mesh keeps local vertices with it on -- so the
 * eye-relative base is the recorded parent alone and the TRS is composed
 * exactly once, in double, before the single float store.
 *
 * A record with no pool of its own is the case `build_instance_parent_world`
 * returns early for: nothing composes onto its recorded parent, and no draw
 * of it reaches the thin-instance vertex arm that reads this block, so it
 * takes the same answer in either frame rather than paying a compose the
 * shader never looks at.
 *
 * A pooled mesh asks once per DRAW of it -- once for the instance-parent
 * uniform the transcribed, depth-only and diagnostic pipelines read, once
 * for `standard_draw_world`'s mesh block -- and both get the same matrix. On
 * scene 204 that is twice a frame, because one pool is drawn through one
 * transcribed pipeline beside its Standard mesh block; a scene adding a
 * depth-only or shadow-caster pass over the same pool multiplies it, and
 * that is the condition to re-measure against. Deliberately not cached: the
 * answer is a pure function of the record and the eye, so a cache would be
 * ordering-dependent state on each backend's own mesh record, and the whole
 * duplicate is a 4x4 double multiply. Measured on scene 204, the corpus's
 * only such mesh: ~224 double operations against a 0.144 ms median frame,
 * under 0.2% of it and below the benchmark's own run-to-run spread. Cache it
 * when a scene makes it visible, not before.
 */
inline std::array<float, 16> instance_parent_draw_world(
    const MeshRecord& record,
    [[maybe_unused]] const Scene& scene,
    [[maybe_unused]] const Engine& engine) {
#if BBLITE_FLOATING_ORIGIN
    if (record.thin_instanced) {
        return draw_world(
            record.instance_parent_matrix, record, scene, engine);
    }
#endif
    return outer_draw_world(
        upstream::build_instance_parent_world(record), record);
}
#endif

/**
 * Whether another task binds this geometry task's depth.
 *
 * The pin hands that depth over as an eager wrapper target, so the borrowing
 * pass loads it — which only works if the task that wrote it stored it. The
 * answer belongs to the frame graph, so it is settled once with the task's
 * textures rather than re-scanned per frame.
 */
inline bool geometry_depth_is_borrowed(
    const Engine& engine,
    std::size_t task) {
    for (const FrameTaskRecord& record : engine.frame_tasks) {
        if (
            record.kind == FrameTaskKind::render &&
            record.render.depth.source ==
                RenderTextureSource::geometry_depth &&
            record.render.depth.task.value == task) {
            return true;
        }
    }
    return false;
}


/**
 * Whether a render target hands samplers its depth attachment.
 *
 * `rtt.ts` forks on `if (!rt._colorTexture || !rt._colorView)`: a target
 * that declared a colour format hands that attachment back, and one that
 * did not hands its depth. `has_color` is the compiler's record of the
 * declared format, written once by the lowered `create_render_target_texture`
 * from the descriptor, so the fork reads it rather than inferring the answer
 * from whichever textures a backend happens to have allocated.
 *
 * Both backends ask this, and only the handles they return differ.
 */
inline bool render_target_samples_depth(const RenderTargetRecord& record) {
    return !record.has_color;
}

/** The refusal both backends owe a depth-only target with no depth. */
[[noreturn]] inline void fail_render_target_has_no_texture() {
    throw std::runtime_error(
        "Depth-only render target has no color texture.");
}


/**
 * The pin's `gpUniforms` block, declared by a geometry-output variant whose
 * attachments include NORMALIZED_VIEW_DEPTH or LINEAR_VELOCITY
 * (`pbr-geometry-output-shader.ts` createPbrGeometryParamsFragment):
 * the task's previous-frame view-projection and the camera's near/far.
 * Unguarded because the geometry encode names it in both backends whatever
 * the variant count.
 */
struct PinnedGeometryParams {
    std::array<float, 16> previousViewProjection{};
    std::array<float, 4> cameraNearFar{};
};

// Where the per-instance streams sit in the shared attribute table both
// backends bind against. The matrix columns take the four lanes after the
// vertex attributes, and the RGBA stream a material with
// `useThinInstanceColors` reads takes the one after them -- the same
// numbers `src/shader-ir.ts` specializes the WGSL to, stated once here so
// the two backends cannot disagree about them.
inline constexpr std::uint32_t instance_matrix_first_location = 16;
inline constexpr std::uint32_t instance_color_location =
    instance_matrix_first_location + 4;

struct GpuVertex {
    float position[3];
    float normal[3];
    float tangent[4];
    float uv[2];
    float local_position[3];
    float uv2[2];
    float color[4];
    float local_normal[3];
#if BBLITE_GPU_DEFORMATION
    float joints[4];
    float weights[4];
    float morph_position_0[3];
    float morph_position_1[3];
    float morph_normal_0[3];
    float morph_normal_1[3];
    float morph_tangent_0[3];
    float morph_tangent_1[3];
#if BBLITE_PBR_VARIANTS > 0
    // The pin's own skinned vertex stage takes joint indices as integers where
    // the transcribed one takes them as floats. Both are carried while the two
    // paths coexist, and this sits last so no existing attribute offset moves;
    // the float pair goes away with the transcription.
    std::uint32_t joint_indices[4];
#endif
#endif
};
#if BBLITE_GPU_DEFORMATION && BBLITE_PBR_VARIANTS > 0
static_assert(sizeof(GpuVertex) == 216);
#elif BBLITE_GPU_DEFORMATION
static_assert(sizeof(GpuVertex) == 200);
#else
static_assert(sizeof(GpuVertex) == 96);
#endif

/**
 * Which vertex buffer a declared input comes from.
 *
 * The pin's own thin-instance fragment names two instance-stepped groups
 * beside the vertex one -- `ti-matrix` for the four world columns and
 * `ti-color` for the RGBA lane -- and both the transcribed path and the
 * composed variants bind that same set of slots, so the table lives beside
 * `GpuVertex` rather than inside either path's own guard.
 */
enum class VertexInputStream : std::uint32_t {
    vertex = 0,
    instance_matrix = 1,
    instance_color = 2,
};

/** The buffer slot both backends bind a stream at. */
inline constexpr std::uint32_t vertex_stream_slot(
    VertexInputStream stream) {
    return static_cast<std::uint32_t>(stream);
}

/**
 * The pin's own name for the buffer group a stream carries.
 *
 * This mapping is the only part of the layout that is ours: the pin declares
 * groups by name (`ti-matrix`, `ti-color`) and assigns no slot at all, so
 * which slot each binds at is the backend's answer and everything else --
 * stride, offset, step rate -- comes from the generated declaration.
 */
inline constexpr std::string_view vertex_stream_group(
    VertexInputStream stream) {
    switch (stream) {
        case VertexInputStream::instance_matrix:
            return "ti-matrix";
        case VertexInputStream::instance_color:
            return "ti-color";
        case VertexInputStream::vertex:
            break;
    }
    return "";
}

/**
 * One stream's element stride.
 *
 * The vertex stream's is ours -- it is `GpuVertex`. The instance-stepped
 * ones are the pin's, read from `pinned_instance_attributes`, which is
 * lowered from `createThinInstanceFragment`'s own `_arrayStride`
 * declarations. A stride the pin moves therefore moves here, in both
 * backends, without either one restating it.
 */
inline constexpr std::uint64_t vertex_stream_stride(
    [[maybe_unused]] VertexInputStream stream) {
#if BBLITE_GPU_INSTANCING
    if (stream != VertexInputStream::vertex) {
        return upstream::pinned_instance_group_stride(
            vertex_stream_group(stream));
    }
#endif
    return sizeof(GpuVertex);
}

/** Whether a stream steps per instance rather than per vertex. */
inline constexpr bool vertex_stream_is_instanced(
    VertexInputStream stream) {
    return stream != VertexInputStream::vertex;
}

#if BBLITE_GPU_INSTANCING
// The join between this backend's slots and the pin's groups. Naming a group
// here is how a slot is chosen; proving the name is the pin's is these three
// lines. A pin that renames a group leaves its stride lookup at zero, and one
// that adds a third leaves the list longer than the two streams this backend
// declares -- either way the build stops rather than binding the wrong buffer
// at the right slot.
static_assert(upstream::pinned_instance_groups.size() == 2);
static_assert(vertex_stream_stride(VertexInputStream::instance_matrix) != 0);
static_assert(vertex_stream_stride(VertexInputStream::instance_color) != 0);
#endif

/** The streams, in slot order, for a backend filling a buffer list. */
inline constexpr std::array<VertexInputStream, 3> vertex_streams{
    VertexInputStream::vertex,
    VertexInputStream::instance_matrix,
    VertexInputStream::instance_color,
};

// The generated `material_texture_slots` table's enums, translated against
// the record once for both backends. Everything a slot *means* — which
// field, which sRGB view, which fallback texel, which pinned names — is
// table data; what stays per backend is upload mechanics and the
// enum→API residue.

/** The record field one slot reads, or nullptr when the family has none. */
inline const TextureData* material_slot_texture(
    const MaterialRecord& material,
    upstream::MaterialTextureSource source,
    bool standard_material) {
    using Source = upstream::MaterialTextureSource;
    switch (source) {
        case Source::base_color:
            return &material.base_color_texture;
        case Source::specular_or_metallic_roughness:
            return standard_material
                ? &material.specular_texture
                : &material.metallic_roughness_texture;
        case Source::opacity_or_normal:
            return standard_material
                ? &material.opacity_texture
                : &material.normal_texture;
        case Source::ambient_or_emissive:
            return standard_material
                ? &material.ambient_texture
                : &material.emissive_texture;
        case Source::standard_emissive:
            return standard_material ? &material.emissive_texture : nullptr;
        case Source::spec_gloss:
            return standard_material ? nullptr : &material.spec_gloss_texture;
        case Source::transmission:
            return standard_material
                ? nullptr
                : &material.transmission_texture;
        case Source::thickness:
            return standard_material ? nullptr : &material.thickness_texture;
        case Source::clearcoat:
            return standard_material ? nullptr : &material.clearcoat_texture;
        case Source::clearcoat_roughness:
            return standard_material
                ? nullptr
                : &material.clearcoat_roughness_texture;
        case Source::clearcoat_normal:
            return standard_material
                ? nullptr
                : &material.clearcoat_normal_texture;
        case Source::sheen_color:
            return standard_material
                ? nullptr
                : &material.sheen_color_texture;
        case Source::sheen_roughness:
            return standard_material
                ? nullptr
                : &material.sheen_roughness_texture;
        case Source::iridescence:
            return standard_material
                ? nullptr
                : &material.iridescence_texture;
        case Source::iridescence_thickness:
            return standard_material
                ? nullptr
                : &material.iridescence_thickness_texture;
        case Source::metallic_reflectance:
            return standard_material
                ? nullptr
                : &material.metallic_reflectance_texture;
        case Source::reflectance:
            return standard_material
                ? nullptr
                : &material.reflectance_texture;
        case Source::occlusion_uv2:
            return !standard_material && material.occlusion_texture_uv2
                ? &material.occlusion_texture
                : nullptr;
        case Source::standard_bump:
            return standard_material ? &material.bump_texture : nullptr;
        case Source::standard_reflection:
            return standard_material
                ? &material.reflection_texture
                : nullptr;
        // Scene-owned resources carry no record field.
        case Source::environment_cube:
        case Source::brdf_lut:
        case Source::scene_color:
        case Source::bone_palette:
        case Source::clustered_lights:
        case Source::clustered_cells:
        case Source::clustered_indices:
            return nullptr;
    }
    return nullptr;
}

/** Whether one slot uploads through an sRGB view, per the table's rule. */
inline bool material_slot_srgb(
    upstream::MaterialTextureSrgb rule,
    const MaterialRecord* material,
    bool standard_material) {
    switch (rule) {
        case upstream::MaterialTextureSrgb::linear:
            return false;
        case upstream::MaterialTextureSrgb::srgb:
            return true;
        case upstream::MaterialTextureSrgb::srgb_unless_standard:
            return !standard_material;
        case upstream::MaterialTextureSrgb::base_color:
            // The slot's encoding is its TEXTURE's, which upstream stores as
            // the `Texture2D`'s own format: the record carries it for the
            // image and the fallback texel alike, so an image is not assumed
            // to be sRGB because it is an image. Standard uploads linear
            // whatever the record says.
            return !standard_material &&
                (material == nullptr || material->base_color_srgb);
    }
    return false;
}

/** The 1x1 texel an image-less slot uploads, per the table's rule. */
inline std::array<std::uint8_t, 4> material_slot_fallback(
    upstream::MaterialTextureFallback rule,
    const MaterialRecord* material,
    bool standard_material) {
    constexpr std::array<std::uint8_t, 4> white_texel{255, 255, 255, 255};
    constexpr std::array<std::uint8_t, 4> black_texel{0, 0, 0, 255};
    // A flat tangent-space normal, so a material with no map reads
    // (0, 0, 1) out of the sample and keeps its interpolated normal.
    constexpr std::array<std::uint8_t, 4> flat_normal_texel{
        128, 128, 255, 255};
    switch (rule) {
        case upstream::MaterialTextureFallback::white:
            return white_texel;
        case upstream::MaterialTextureFallback::black:
            return black_texel;
        case upstream::MaterialTextureFallback::flat_normal:
            return flat_normal_texel;
        case upstream::MaterialTextureFallback::white_or_flat_normal:
            return standard_material ? white_texel : flat_normal_texel;
        case upstream::MaterialTextureFallback::base_color_record:
            return !standard_material && material
                ? material->base_color_fallback
                : white_texel;
        case upstream::MaterialTextureFallback::orm_record:
            // The pinned ORM factor texel, so an animated metallic or
            // roughness factor multiplies the authored value rather than
            // white. Standard materials never carry one.
            return !standard_material && material
                ? material->orm_fallback
                : white_texel;
        case upstream::MaterialTextureFallback::white_or_emissive_factor: {
            if (standard_material) return white_texel;
            const bool has_emissive_factor = material &&
                (material->emissive_factor.r != 0.0f ||
                 material->emissive_factor.g != 0.0f ||
                 material->emissive_factor.b != 0.0f);
            return has_emissive_factor ? white_texel : black_texel;
        }
    }
    return white_texel;
}

/**
 * The table row serving one of the pin's own binding names, or nullptr.
 *
 * The names are Babylon's, the rows are generated, and this is where the
 * two meet for both backends' pinned bind paths. A variant that declares a
 * resource the table does not know fails by name rather than sampling
 * whatever sat at that index.
 */
inline const upstream::MaterialTextureSlot* material_slot_for_binding(
    std::string_view name) {
    for (
        const upstream::MaterialTextureSlot& slot :
        upstream::material_texture_slots) {
        if (slot.texture_name.empty()) continue;
        if (name == slot.texture_name || name == slot.sampler_name) {
            return &slot;
        }
    }
    return nullptr;
}

/**
 * The table row serving one slot source, or nullptr.
 *
 * The Standard family's generated `standard_binding_resources` rows carry
 * the pin's own std binding names (`dT`, `oT`, `rT`, ...) while the slot
 * table's names are the PBR pinned bindings, so a Standard row cannot be
 * resolved by name -- its declared `source` is the join key (the row
 * comment in pinned-standard-variants.ts says exactly that: a
 * "material_texture_slots row source").
 */
inline const upstream::MaterialTextureSlot* material_slot_for_source(
    upstream::MaterialTextureSource source) {
    for (
        const upstream::MaterialTextureSlot& slot :
        upstream::material_texture_slots) {
        if (slot.source == source) {
            return &slot;
        }
    }
    return nullptr;
}

#if BBLITE_GPU_DEFORMATION
// Vertex deformation uniforms shared by both render backends (moved
// verbatim from pal_sdl_gpu.cpp).
struct DeformationUniforms {
    std::array<std::array<float, 16>, 64> bone_matrices{};
    float morph_weights[4]{};
    float options[4]{};
};

inline DeformationUniforms build_deformation_uniforms(
    const MeshRecord& mesh,
    bool flat_normals) {
    DeformationUniforms result;
    for (std::array<float, 16>& matrix : result.bone_matrices) {
        matrix[0] = 1.0f;
        matrix[5] = 1.0f;
        matrix[10] = 1.0f;
        matrix[15] = 1.0f;
    }
    if (!mesh.gpu_deformation) return result;
    // A palette on the pin's own texture is read by the composed skeleton
    // stage, not from this block, so the bone lanes stay the identity:
    // filling them would be dead bytes, and this 64-matrix array could
    // not hold a larger palette anyway. The morph half still travels,
    // since the two transports are independent.
    if (!mesh.pinned_bone_palette) {
        // Sized by the loader from the skin's joint count, which
        // generation refuses above this array's length and the loader
        // refuses again for a BBLITE_ASSET_DIR override -- so the copy
        // cannot overrun and needs no third check here.
        std::copy(
            mesh.bone_matrices.begin(),
            mesh.bone_matrices.end(),
            result.bone_matrices.begin());
    }
    std::copy(
        mesh.morph_weights.begin(),
        mesh.morph_weights.end(),
        result.morph_weights);
    result.options[0] = 1.0f;
    result.options[1] = flat_normals ? 1.0f : 0.0f;
    return result;
}
#endif

/** `world * vec4(value, 1)`, the pin's own vertex-stage position multiply. */
inline Vec3 transform_position(
    const std::array<float, 16>& world,
    Vec3 value) {
    return Vec3{
        world[0] * value.x + world[4] * value.y + world[8] * value.z +
            world[12],
        world[1] * value.x + world[5] * value.y + world[9] * value.z +
            world[13],
        world[2] * value.x + world[6] * value.y + world[10] * value.z +
            world[14],
    };
}

/**
 * `world * vec4(value, 0)`, which is what both pinned templates apply to a
 * normal and a tangent alike — `pbr-template.ts` writes
 * `(finalWorld * vec4<f32>(normalize(normal), 0.0)).xyz` and
 * `standard-template.ts` the `mat3x3` of the same three columns. Neither
 * divides by the scale: the pin transforms a normal by the plain world
 * basis rather than by an inverse transpose, and a port that divided
 * agreed with it only where a normal lines up with a scaling axis.
 */
inline Vec3 transform_direction(
    const std::array<float, 16>& world,
    Vec3 value) {
    return Vec3{
        world[0] * value.x + world[4] * value.y + world[8] * value.z,
        world[1] * value.x + world[5] * value.y + world[9] * value.z,
        world[2] * value.x + world[6] * value.y + world[10] * value.z,
    };
}

inline Vec3 normalize_vec3(Vec3 value) {
    const float length = std::sqrt(
        value.x * value.x +
        value.y * value.y +
        value.z * value.z);
    return length > 0.000001f
        ? Vec3{
              value.x / length,
              value.y / length,
              value.z / length,
          }
        : Vec3{};
}

#if BBLITE_HAS_PICKING
// GPU picking's backend-independent half: the two shears the pin computes
// per pick, and the id encoding both attachments agree on. The pin puts
// these in `picking/gpu-picker.ts` and `picking/gs-picking-pipeline.ts`;
// each is lowered from its own body, and both backends read the same one.

/** The pin's `SceneUniforms`: the sheared VP, then the sampled pixel. */
struct PickSceneUniforms {
    std::array<float, 16> view_projection{};
    std::array<float, 2> fragment_coord{};
    std::array<float, 2> _pad{};
};

/** The pin's `MeshUniforms`: the world matrix, then the id. */
struct PickMeshUniforms {
    std::array<float, 16> world{};
    std::uint32_t pick_id = 0;
    std::array<std::uint32_t, 3> _pad{};
};

/**
 * The pin's whole scene block for one pick: `computePickVP` lowered from
 * its own body, then the two lanes its caller writes after it.
 *
 * The shear maps the sampled point to the one pixel the target has -- each
 * column's x and y scaled by the viewport extent and offset by the sample's
 * NDC, so the sample lands at the origin of a 1x1 clip volume. Upstream
 * fills `_pickVP[0..15]` here and `[16]`/`[17]` at the call site, then
 * uploads all twenty floats as one buffer; `PickSceneUniforms` is that
 * buffer, so the split does not survive into this port.
 */
inline PickSceneUniforms build_pick_scene_uniforms(
    const std::array<float, 16>& vp,
    double sample_x,
    double sample_y,
    double width,
    double height) {
    PickSceneUniforms out;
    const double ndc_x = 2.0 * sample_x / width - 1.0;
    const double ndc_y = 1.0 - 2.0 * sample_y / height;
    for (int column = 0; column < 4; ++column) {
        const auto base = static_cast<std::size_t>(column * 4);
        const double w3 = static_cast<double>(vp[base + 3]);
        out.view_projection[base] = static_cast<float>(
            width * (static_cast<double>(vp[base]) - ndc_x * w3));
        out.view_projection[base + 1] = static_cast<float>(
            height * (static_cast<double>(vp[base + 1]) - ndc_y * w3));
        out.view_projection[base + 2] = vp[base + 2];
        out.view_projection[base + 3] = vp[base + 3];
    }
    // The pin writes the sampled pixel's CENTRE; a discard predicate reads
    // it, and the default one does not -- but the block uploads whole.
    out.fragment_coord = {
        static_cast<float>(std::floor(sample_x) + 0.5),
        static_cast<float>(std::floor(sample_y) + 0.5)};
    return out;
}

/**
 * `computeGsPickMatrix`, lowered from its own body.
 *
 * The cloud's vertex stage already produced clip space, so its shear is a
 * post-multiply rather than a replacement projection: scale by the viewport
 * and translate by the sample's NDC.
 */
inline void compute_cloud_pick_matrix(
    std::array<float, 16>& out,
    double sample_x,
    double sample_y,
    double width,
    double height) {
    const double ndc_x = 2.0 * sample_x / width - 1.0;
    const double ndc_y = 1.0 - 2.0 * sample_y / height;
    out = {
        static_cast<float>(width), 0.0f, 0.0f, 0.0f,
        0.0f, static_cast<float>(height), 0.0f, 0.0f,
        0.0f, 0.0f, 1.0f, 0.0f,
        static_cast<float>(-ndc_x * width),
        static_cast<float>(-ndc_y * height),
        0.0f, 1.0f};
}

/**
 * One candidate the pick pass drew, in submission order.
 *
 * Upstream keeps mesh ranges and contributor ranges apart because a thin
 * instance makes a mesh's range wider than one id; nothing in the reached
 * slice does, so one id is one node and the two lists are one.
 */
struct PickRange {
    std::uint32_t id = 0;
    PickedNodeKind kind = PickedNodeKind::none;
    std::uint32_t index = invalid_handle;
};

/**
 * The id the one-pixel target held, resolved against what was drawn.
 *
 * Zero is the cleared attachment, which is upstream's "nothing here"; an
 * id no range claims cannot happen while the draw loop and the range list
 * agree, and saying so is cheaper than debugging a silent miss if they
 * ever stop agreeing.
 */
inline PickingInfo resolve_pick_result(
    const std::vector<PickRange>& ranges,
    std::uint32_t pick_id) {
    if (pick_id == 0) return PickingInfo{};
    for (const PickRange& range : ranges) {
        if (range.id != pick_id) continue;
        PickingInfo info;
        info.hit = true;
        info.picked_kind = range.kind;
        info.picked_index = range.index;
        return info;
    }
    throw std::runtime_error(
        "GPU pick read an id no candidate was drawn under.");
}

/** `encodeIdToColor`: the id's three bytes as unit floats. */
inline std::array<float, 3> encode_pick_id_to_color(std::uint32_t id) {
    return {
        static_cast<float>((id >> 16) & 0xFFu) / 255.0f,
        static_cast<float>((id >> 8) & 0xFFu) / 255.0f,
        static_cast<float>(id & 0xFFu) / 255.0f,
    };
}

/** The colour attachment's three bytes back into the id they encode. */
inline std::uint32_t decode_pick_id(const std::uint8_t* texel) {
    return (static_cast<std::uint32_t>(texel[0]) << 16) |
           (static_cast<std::uint32_t>(texel[1]) << 8) |
           static_cast<std::uint32_t>(texel[2]);
}

#endif

// The CPU vertex bake and the shader draw world compose a mesh's world
// through the pin's own `upstream::mesh_local_matrix`, which the render
// plan emits — so both belong to a scene that HAS a mesh renderer. A
// sprite-only, effect-only or scene-less program includes no render plan
// (see the guarded include at the top of this file) and calls neither.
#if defined(BBLITE_HAS_PBR_RENDERER) && BBLITE_HAS_PBR_RENDERER
inline std::vector<GpuVertex> transformed_vertices(
    const Engine& engine,
    const ModelGeometry& geometry,
    const MeshRecord& mesh) {
    // Thin-instanced meshes keep local-space vertices: the pinned vertex
    // stage composes mesh.world * instanceWorld, so the record transform
    // reaches the shader through the instance parent-world uniform
    // instead of the baked vertex positions. Baking through an identity
    // transform keeps the exact byte path older instanced scenes
    // validated (including the normal renormalization).
    static const MeshRecord identity_transform{};
    // A floating-origin scene keeps LOCAL vertices for the same reason a
    // thin-instanced mesh does: its transform reaches the vertex stage
    // through a matrix instead. Baking it here would quantize the
    // far-from-origin translation into float32 before the eye-relative
    // subtraction could recover the remainder -- which is the whole point
    // of the mode.
    const MeshRecord& trs =
#if BBLITE_FLOATING_ORIGIN
        identity_transform;
#else
        mesh.thin_instanced || mesh.gpu_world_transform
            ? identity_transform
            : mesh;
#endif
    const std::vector<ModelVertex>& source_vertices =
        (mesh.gpu_deformation || mesh.live_imported_transform) &&
                geometry.bind_vertices.size() ==
                    geometry.vertices.size()
            ? geometry.bind_vertices
            : geometry.vertices;
    // One composition per mesh: the record and its parent chain decide it,
    // so it sits above the loop rather than being rebuilt per vertex.
    const std::array<float, 16> world =
        upstream::mesh_world_matrix(engine, trs);
    std::vector<GpuVertex> result;
    result.reserve(source_vertices.size());
    for (
        std::size_t vertex_index = 0;
        vertex_index < source_vertices.size();
        ++vertex_index) {
        const ModelVertex& vertex =
            source_vertices[vertex_index];
        const ModelVertex& normal_vertex =
            mesh.gpu_deformation && geometry.flat_normals
                ? geometry.vertices[vertex_index]
                : vertex;
        // The pin's own vertex stage, performed here because this port bakes
        // a scene-code mesh's world into the buffer it draws: the matrix is
        // float32 exactly as `allocateMat4()` leaves it, so this multiply is
        // the arithmetic the GPU would have run on the same bytes.
        const Vec3 position =
            transform_position(world, vertex.position);
        const Vec3 normal = normalize_vec3(
            transform_direction(world, normal_vertex.normal));
        // `T_local` is the tangent's xyz; its `w` is the handedness the
        // bitangent reads and travels unchanged.
        const Vec3 tangent = normalize_vec3(
            transform_direction(
                world,
                Vec3{
                    vertex.tangent.x,
                    vertex.tangent.y,
                    vertex.tangent.z,
                }));
        result.push_back(GpuVertex{
            {position.x, position.y, position.z},
            {normal.x, normal.y, normal.z},
            {
                tangent.x,
                tangent.y,
                tangent.z,
                vertex.tangent.w,
            },
            {vertex.uv.x, vertex.uv.y},
            {
                vertex.local_position.x,
                vertex.local_position.y,
                vertex.local_position.z,
            },
            {vertex.uv2.x, vertex.uv2.y},
            {
                vertex.color.x,
                vertex.color.y,
                vertex.color.z,
                vertex.color.w,
            },
            {
                vertex.normal.x,
                vertex.normal.y,
                vertex.normal.z,
            },
#if BBLITE_GPU_DEFORMATION
            {
                static_cast<float>(vertex.joints[0]),
                static_cast<float>(vertex.joints[1]),
                static_cast<float>(vertex.joints[2]),
                static_cast<float>(vertex.joints[3]),
            },
            {
                mesh.gpu_deformation &&
                        vertex.weights.x +
                                vertex.weights.y +
                                vertex.weights.z +
                                vertex.weights.w <=
                            0.0f
                    ? 1.0f
                    : vertex.weights.x,
                vertex.weights.y,
                vertex.weights.z,
                vertex.weights.w,
            },
            {
                geometry.morph_positions.size() > 0
                    ? -geometry.morph_positions[0][vertex_index].x
                    : 0.0f,
                geometry.morph_positions.size() > 0
                    ? geometry.morph_positions[0][vertex_index].y
                    : 0.0f,
                geometry.morph_positions.size() > 0
                    ? geometry.morph_positions[0][vertex_index].z
                    : 0.0f,
            },
            {
                geometry.morph_positions.size() > 1
                    ? -geometry.morph_positions[1][vertex_index].x
                    : 0.0f,
                geometry.morph_positions.size() > 1
                    ? geometry.morph_positions[1][vertex_index].y
                    : 0.0f,
                geometry.morph_positions.size() > 1
                    ? geometry.morph_positions[1][vertex_index].z
                    : 0.0f,
            },
            {
                geometry.morph_normals.size() > 0
                    ? -geometry.morph_normals[0][vertex_index].x
                    : 0.0f,
                geometry.morph_normals.size() > 0
                    ? geometry.morph_normals[0][vertex_index].y
                    : 0.0f,
                geometry.morph_normals.size() > 0
                    ? geometry.morph_normals[0][vertex_index].z
                    : 0.0f,
            },
            {
                geometry.morph_normals.size() > 1
                    ? -geometry.morph_normals[1][vertex_index].x
                    : 0.0f,
                geometry.morph_normals.size() > 1
                    ? geometry.morph_normals[1][vertex_index].y
                    : 0.0f,
                geometry.morph_normals.size() > 1
                    ? geometry.morph_normals[1][vertex_index].z
                    : 0.0f,
            },
            {
                geometry.morph_tangents.size() > 0
                    ? -geometry.morph_tangents[0][vertex_index].x
                    : 0.0f,
                geometry.morph_tangents.size() > 0
                    ? geometry.morph_tangents[0][vertex_index].y
                    : 0.0f,
                geometry.morph_tangents.size() > 0
                    ? geometry.morph_tangents[0][vertex_index].z
                    : 0.0f,
            },
            {
                geometry.morph_tangents.size() > 1
                    ? -geometry.morph_tangents[1][vertex_index].x
                    : 0.0f,
                geometry.morph_tangents.size() > 1
                    ? geometry.morph_tangents[1][vertex_index].y
                    : 0.0f,
                geometry.morph_tangents.size() > 1
                    ? geometry.morph_tangents[1][vertex_index].z
                    : 0.0f,
            },
#if BBLITE_PBR_VARIANTS > 0
            {
                static_cast<std::uint32_t>(vertex.joints[0]),
                static_cast<std::uint32_t>(vertex.joints[1]),
                static_cast<std::uint32_t>(vertex.joints[2]),
                static_cast<std::uint32_t>(vertex.joints[3]),
            },
#endif
#endif
        });
    }
    return result;
}

/** Local-space vertex lanes for material families whose own world matrix is
 *  bound per draw. Keeping these immutable avoids rebaking and re-uploading
 *  a whole vertex buffer for every transform-only animation step. */
inline std::vector<GpuVertex> local_vertices(
    const Engine& engine,
    const ModelGeometry& geometry) {
    static const MeshRecord identity_transform{};
    return transformed_vertices(engine, geometry, identity_transform);
}
#endif

/** Find an exact immutable shader-geometry upload in a backend cache. */
template <typename SharedGeometry>
inline SharedGeometry* find_shared_shader_geometry(
    const std::vector<std::unique_ptr<SharedGeometry>>& cache,
    const std::vector<GpuVertex>& vertices,
    const std::vector<std::uint32_t>& indices) {
    const auto found = std::find_if(
        cache.begin(),
        cache.end(),
        [&](const std::unique_ptr<SharedGeometry>& candidate) {
            return candidate->vertices.size() == vertices.size() &&
                candidate->indices == indices &&
                (vertices.empty() ||
                 std::memcmp(
                     candidate->vertices.data(),
                     vertices.data(),
                     vertices.size() * sizeof(GpuVertex)) == 0);
        });
    return found == cache.end() ? nullptr : found->get();
}

/** Find the backend texture upload owned by one shader material. */
template <typename SharedTextures>
inline SharedTextures* find_shared_shader_material_textures(
    const std::vector<std::unique_ptr<SharedTextures>>& cache,
    MaterialHandle material) {
    const auto found = std::find_if(
        cache.begin(),
        cache.end(),
        [&](const std::unique_ptr<SharedTextures>& candidate) {
            return candidate->material.value == material.value;
        });
    return found == cache.end() ? nullptr : found->get();
}

/** Drops one mesh's reference to a backend-owned shared cache entry. */
template <typename Shared>
inline void release_shared_user(
    Shared*& shared,
    const char* underflow_message) {
    if (!shared) return;
    if (shared->users == 0) {
        throw std::runtime_error(underflow_message);
    }
    --shared->users;
    shared = nullptr;
}

/** Releases and erases cache entries after their last mesh retires. */
template <typename Cache, typename Release>
inline void prune_unused_shared(
    Cache& cache,
    Release release) {
    const auto unused = std::remove_if(
        cache.begin(),
        cache.end(),
        [&](const auto& entry) {
            if (entry->users != 0) return false;
            release(*entry);
            return true;
        });
    cache.erase(unused, cache.end());
}

/** Releases all backend objects in a cache during renderer teardown. */
template <typename Cache, typename Release>
inline void release_all_shared(
    Cache& cache,
    Release release) {
    for (const auto& entry : cache) {
        release(*entry);
    }
    cache.clear();
}

/**
 * The ordinary mesh TRS as a column-major world matrix.
 *
 * The same composition the CPU vertex bake reads, so moving a transform into
 * a shader uniform changes the storage location rather than the scene
 * meaning -- and, like the bake, it belongs to a scene that has a mesh
 * renderer to emit that composition.
 */
#if defined(BBLITE_HAS_PBR_RENDERER) && BBLITE_HAS_PBR_RENDERER
inline std::array<float, 16> shader_draw_world(
    const Engine& engine,
    const MeshRecord& mesh) {
    return outer_draw_world(
        upstream::mesh_world_matrix(engine, mesh),
        mesh);
}
#endif

/** The pin's projection-view product times one mesh world, preserving its
 *  explicit four-term accumulation order and float32 store boundary. */
inline std::array<float, 16> shader_matrix_product(
    const float* left,
    const std::array<float, 16>& world) {
    std::array<float, 16> result{};
    for (std::size_t column = 0; column < 4; ++column) {
        const double b0 = world[column * 4];
        const double b1 = world[column * 4 + 1];
        const double b2 = world[column * 4 + 2];
        const double b3 = world[column * 4 + 3];
        for (std::size_t row = 0; row < 4; ++row) {
            result[column * 4 + row] = static_cast<float>(
                (((static_cast<double>(left[row]) * b0 +
                   static_cast<double>(left[4 + row]) * b1) +
                  static_cast<double>(left[8 + row]) * b2) +
                 static_cast<double>(left[12 + row]) * b3));
        }
    }
    return result;
}

inline std::array<float, 16> shader_world_view_projection(
    const float* view_projection,
    const std::array<float, 16>& world) {
    return shader_matrix_product(view_projection, world);
}

inline std::optional<std::array<float, 16>> shader_world_view(
    const std::array<float, 16>* view,
    const std::array<float, 16>& world) {
    return view
        ? std::optional<std::array<float, 16>>{
              shader_matrix_product(view->data(), world)}
        : std::nullopt;
}

/**
 * One background-plan vertex (the skybox and ground quads) in GpuVertex
 * layout: the local-normal lane mirrors the normal and every deformation
 * lane stays zero. Both backends upload the plan quads from this one
 * packing, so the vertex bytes cannot differ between them.
 */
inline GpuVertex gpu_vertex_from(const ModelVertex& vertex) {
    return GpuVertex{
        {vertex.position.x, vertex.position.y, vertex.position.z},
        {vertex.normal.x, vertex.normal.y, vertex.normal.z},
        {
            vertex.tangent.x,
            vertex.tangent.y,
            vertex.tangent.z,
            vertex.tangent.w,
        },
        {vertex.uv.x, vertex.uv.y},
        {
            vertex.local_position.x,
            vertex.local_position.y,
            vertex.local_position.z,
        },
        {vertex.uv2.x, vertex.uv2.y},
        {vertex.color.x, vertex.color.y, vertex.color.z, vertex.color.w},
        {vertex.normal.x, vertex.normal.y, vertex.normal.z},
#if BBLITE_GPU_DEFORMATION
        {},  // joints
        {},  // weights
        {},  // morph position 0
        {},  // morph position 1
        {},  // morph normal 0
        {},  // morph normal 1
        {},  // morph tangent 0
        {},  // morph tangent 1
#if BBLITE_PBR_VARIANTS > 0
        {},  // integer joint indices
#endif
#endif
    };
}

#if BBLITE_PBR_VARIANTS > 0
/**
 * The same vertices in Babylon's own convention.
 *
 * Two facts make this necessary rather than cosmetic. The loader stores a glTF
 * mesh through the native X mirror and reconciles `tangent.w` against it, where
 * Babylon keeps position, normal and tangent unmirrored and carries the mirror
 * in the mesh block's world matrix -- the browser's own block for Scene 7 is
 * `diag(-1, 1, 1, 1)`, not the identity. And a mirror flips handedness, so a
 * bitangent built with `cross()` inside the pin's own vertex stage comes out
 * negated when it is fed pre-mirrored data. Undoing the mirror here, and pairing
 * it with the mirroring world matrix, is what lets the pin's stage run unedited.
 *
 * The morph deltas carry the same mirror and are undone with it.
 */
inline std::vector<GpuVertex> pinned_convention_vertices(
    const std::vector<GpuVertex>& source,
    bool mirrored_x) {
    std::vector<GpuVertex> result = source;
    for (GpuVertex& vertex : result) {
        vertex.position[0] = -vertex.position[0];
        vertex.normal[0] = -vertex.normal[0];
        vertex.tangent[0] = -vertex.tangent[0];
        // The local lanes stay untouched: the loader stores them RAW from
        // the glTF (no native mirror), which is exactly the pin's own
        // convention -- the LOCAL_POSITION geometry arm reads them as the
        // browser reads its unmirrored attribute.
        // `gltf-loader` multiplies the authored sign by -1 for a right-handed
        // node and by +1 for a mirrored one; the pin's stage wants the authored
        // value, so the same factor undoes it.
        vertex.tangent[3] *= mirrored_x ? 1.0f : -1.0f;
#if BBLITE_GPU_DEFORMATION
        vertex.morph_position_0[0] = -vertex.morph_position_0[0];
        vertex.morph_position_1[0] = -vertex.morph_position_1[0];
        vertex.morph_normal_0[0] = -vertex.morph_normal_0[0];
        vertex.morph_normal_1[0] = -vertex.morph_normal_1[0];
        vertex.morph_tangent_0[0] = -vertex.morph_tangent_0[0];
        vertex.morph_tangent_1[0] = -vertex.morph_tangent_1[0];
#endif
    }
    return result;
}

/**
 * The instance matrices paired with the PBR family's pinned vertex stream.
 *
 * That stream reverses the native vertex X mirror and the mesh block carries
 * it instead. Therefore its instance matrix is always the mirror conjugation
 * of the record's matrix. For glTF, the record already stores M*A*M and this
 * involutive operation recovers the authored A. For scene-code pools, the
 * record stores authored A and this produces M*A*M, which is what cancels the
 * pinned stream's extra vertex mirror. The ordinary/Standard instance stream
 * continues to consume the record bytes directly.
 */
inline std::vector<std::array<float, 16>> pinned_instance_matrices(
    const MeshRecord& record) {
    std::vector<std::array<float, 16>> result = record.instance_matrices;
    for (std::array<float, 16>& matrix : result) {
        for (std::size_t column = 0; column < 4; ++column) {
            for (std::size_t row = 0; row < 4; ++row) {
                if ((row == 0) != (column == 0)) {
                    matrix[column * 4 + row] =
                        -matrix[column * 4 + row];
                }
            }
        }
    }
    return result;
}

#endif

#if BBLITE_PINNED_MATERIALS
/**
 * Where one of Babylon Lite's own vertex-input names sits in our vertex.
 *
 * All three composed families declare their inputs by the pin's names, and
 * the pin numbers the locations densely per variant — an unskinned stage puts
 * nothing where a skinned one puts `joints`. So a PAL resolves each declared
 * name against the vertex we pack, and the table that answers it is a
 * property of `GpuVertex` rather than of a family or a backend.
 *
 * `lane` is the shape, which each backend maps to its own format enum;
 * `stream` says which buffer it comes from. The pin's own thin-instance
 * fragment names two instance-stepped groups -- `ti-matrix` at stride 64
 * for the four world columns and `ti-color` at stride 16 for the RGBA lane
 * -- so an input is in the vertex, in the matrix stream, or in the colour
 * stream, and those are the slots both backends already bind.
 */
enum class VertexInputLane {
    float2,
    float3,
    float4,
    uint4,
};

struct PinnedVertexInput {
    VertexInputLane lane = VertexInputLane::float3;
    std::uint64_t offset = 0;
    VertexInputStream stream = VertexInputStream::vertex;
    /** False when this vertex carries nothing under that name. */
    bool mapped = false;
};

/**
 * Resolve one declared input. `local_position` is the arm a LOCAL_POSITION
 * geometry variant takes: its varying reads the raw attribute, so the draw
 * binds the vertex's local lanes and its mesh block carries the real node
 * world.
 */
inline PinnedVertexInput pinned_vertex_input(
    std::string_view name,
    bool uses_local_position) {
    const auto at = [](VertexInputLane lane, std::size_t offset) {
        return PinnedVertexInput{
            lane,
            static_cast<std::uint64_t>(offset),
            VertexInputStream::vertex,
            true,
        };
    };
    if (name == "position") {
        return at(
            VertexInputLane::float3,
            uses_local_position ? offsetof(GpuVertex, local_position)
                                : offsetof(GpuVertex, position));
    }
    if (name == "normal") {
        return at(VertexInputLane::float3, offsetof(GpuVertex, normal));
    }
    if (name == "tangent") {
        return at(VertexInputLane::float4, offsetof(GpuVertex, tangent));
    }
    if (name == "uv") {
        return at(VertexInputLane::float2, offsetof(GpuVertex, uv));
    }
    if (name == "uv2") {
        return at(VertexInputLane::float2, offsetof(GpuVertex, uv2));
    }
    if (name == "color") {
        return at(VertexInputLane::float4, offsetof(GpuVertex, color));
    }
#if BBLITE_GPU_INSTANCING
    // The pin's own thin-instance attributes -- the four `ti-matrix` world
    // columns and the `ti-color` RGBA lane -- resolved from the declaration
    // that states their group and their offset within it, rather than from
    // names and arithmetic written here. Every one of them is a float4.
    if (
        const upstream::PinnedInstanceAttribute* declared =
            upstream::pinned_instance_attribute(name)) {
        return PinnedVertexInput{
            VertexInputLane::float4,
            declared->offset,
            declared->buffer_group == vertex_stream_group(
                                          VertexInputStream::instance_color)
                ? VertexInputStream::instance_color
                : VertexInputStream::instance_matrix,
            true,
        };
    }
#endif
#if BBLITE_GPU_DEFORMATION
    if (name == "weights") {
        return at(VertexInputLane::float4, offsetof(GpuVertex, weights));
    }
#if BBLITE_PBR_VARIANTS > 0
    // The pin takes joint indices as integers; the transcribed stage takes
    // them as floats, so the vertex carries both while the two coexist.
    if (name == "joints") {
        return at(VertexInputLane::uint4, offsetof(GpuVertex, joint_indices));
    }
#endif
#endif
    return PinnedVertexInput{};
}
#endif

#if BBLITE_PINNED_MATERIAL_VARIANTS
/** Whether a record draws through the pin's thin-instance arm: stamped by
 *  the scene setter or filled by the glTF EXT_mesh_gpu_instancing pool. */
inline bool pinned_record_instanced(const MeshRecord& record) {
    return record.thin_instanced || !record.instance_matrices.empty();
}

/**
 * Whether that pool also carries per-instance colours.
 *
 * `_computeMeshFeatures` reads `mesh.thinInstances.colors`, so this is what
 * the variant KEY asks and what each backend's binding asks, and the two
 * have to agree: a pipeline declaring the colour stream that no draw binds
 * is a validation failure, and the reverse silently shades white. One
 * predicate rather than five transcriptions of the same expression.
 */
inline bool pinned_record_instance_colored(const MeshRecord& record) {
    return !record.instance_colors.empty();
}

/**
 * Whether a task's draw lists contain a draw the pinned path owns — a PBR
 * draw, or a Standard one now that both families run Babylon's own composed
 * stages. A geometry task with none writes no pinned blocks at all. It lives
 * here rather than in the backend that asks: SDL_GPU stopped needing it when
 * the depth convention collapsed and the matrix seam went with it, and the
 * question is the backends' shared one whenever either asks it again.
 */
inline bool pinned_lists_have_pinned_draws(
    const upstream::RenderDrawLists& lists) {
    for (const upstream::RenderDrawList* list :
         {&lists.opaque, &lists.transparent}) {
        for (const upstream::RenderDrawCommand& draw : list->commands) {
            if (
                draw.item.material_kind ==
                    upstream::RenderMaterialKind::pbr ||
                draw.item.material_kind ==
                    upstream::RenderMaterialKind::standard) {
                return true;
            }
        }
    }
    return false;
}
#endif

#if BBLITE_PINNED_MATERIALS

/** The identity, for a skinned draw whose palette already carries everything,
 *  and for the two families whose vertices are baked with their world. */
inline std::array<float, 16> pinned_identity_world() {
    return {
        1.0f, 0.0f, 0.0f, 0.0f,
        0.0f, 1.0f, 0.0f, 0.0f,
        0.0f, 0.0f, 1.0f, 0.0f,
        0.0f, 0.0f, 0.0f, 1.0f,
    };
}

#endif

#if BBLITE_PBR_VARIANTS > 0
/** The pin's own per-mesh world matrix: the mirror its vertices do not carry. */
inline std::array<float, 16> pinned_mesh_world() {
    return {
        -1.0f, 0.0f, 0.0f, 0.0f,
        0.0f, 1.0f, 0.0f, 0.0f,
        0.0f, 0.0f, 1.0f, 0.0f,
        0.0f, 0.0f, 0.0f, 1.0f,
    };
}

/** Applies the PBR root X mirror after one native-convention world. */
inline std::array<float, 16> pinned_x_mirrored_world(
    std::array<float, 16> world) {
    world[0] = -world[0];
    world[1] = -world[1];
    world[2] = -world[2];
    world[3] = -world[3];
    return world;
}

#if BBLITE_GPU_INSTANCING
/**
 * The pin's mesh world for a thin-instanced draw: the instanced node's own
 * world in Babylon's convention.
 *
 * The pin composes `finalWorld = mesh.world * instanceWorld`; the instance
 * stream is local to the mesh, so `mesh.world` must include the record's TRS
 * as well as its recorded parent. `instance_parent_draw_world` is already the
 * shared Standard/transcribed answer for that product, including clone outer
 * transforms and the one floating-origin subtraction. Apply the PBR root
 * mirror after it: with column vectors this negates the completed world's
 * first column and leaves its translation intact. An identity node collapses
 * this to `pinned_mesh_world()`.
 */
inline std::array<float, 16> pinned_instanced_world(
    const MeshRecord& record,
    const Scene& scene,
    const Engine& engine) {
    return pinned_x_mirrored_world(
        instance_parent_draw_world(record, scene, engine));
}
#endif

/**
 * The pin's mesh-block world for one draw, whichever convention arm it rides.
 *
 * Skinned draws take the identity (the palette carries everything), an
 * animated no-skin mesh takes its single palette entry as the pin's
 * finalWorld, a thin-instanced or LOCAL_POSITION draw takes the real node
 * world beside unbaked position data, and everything else takes the bare
 * mirror over baked vertices. Shared because the same chain decides the
 * block in the SDL draw and both of Dawn's write sites.
 */
inline std::array<float, 16> pinned_draw_world(
    bool skeleton_draw,
    bool world_from_palette,
    bool uses_local_position,
    const MeshRecord& record,
    const Scene& scene,
    const Engine& engine) {
    if (skeleton_draw) {
        return draw_world(pinned_identity_world(), record, scene, engine);
    }
    if (world_from_palette) {
        return draw_world(record.bone_matrices[0], record, scene, engine);
    }
    if (record.gpu_world_transform) {
        // `pinned_convention_vertices` applies the Babylon X mirror to the
        // local stream. The live native world therefore precedes the mirror:
        // (world * mirror) * (mirror * local) == world * local.
        return outer_draw_world(
            draw_matrix_product(
                upstream::mesh_world_matrix(engine, record),
                pinned_mesh_world()),
            record);
    }
#if BBLITE_GPU_INSTANCING
    if (pinned_record_instanced(record)) {
        return pinned_instanced_world(record, scene, engine);
    }
#endif
    if (uses_local_position) {
        return draw_world(
            pinned_x_mirrored_world(record.instance_parent_matrix),
            record,
            scene,
            engine);
    }
    return draw_world(pinned_mesh_world(), record, scene, engine);
}
#endif

#if BBLITE_STANDARD_SHADOWS
/**
 * The composed group-2 rows one variant declares.
 *
 * `createShadowFragment` emits three per shadow-casting light and the
 * generated table stores them contiguously, so the slice is the variant's
 * own half-open range -- spelled here rather than at each backend's every
 * lookup. Both material families wrap that one core, so their rows are one
 * shape and a backend builds either family's group 2 from one walk.
 */
inline std::span<const upstream::PinnedShadowBinding> standard_shadow_rows(
    std::size_t variant) {
    const upstream::StandardVariantEntry& entry =
        upstream::standard_variants[variant];
    return {
        upstream::standard_shadow_bindings.data() +
            entry.first_shadow_binding,
        entry.shadow_binding_count,
    };
}

/** Whether a composed Standard variant carries the pin's shadow fragment. */
inline bool standard_variant_receives_shadows(std::size_t variant) {
    return upstream::standard_variants[variant].shadow_binding_count != 0;
}
#else
inline bool standard_variant_receives_shadows(std::size_t) { return false; }
#endif

#if BBLITE_PBR_SHADOWS
/** The same slice over the PBR family's own composed rows. */
inline std::span<const upstream::PinnedShadowBinding> pbr_shadow_rows(
    std::size_t variant) {
    const upstream::PbrVariantEntry& entry =
        upstream::pbr_variants[variant];
    return {
        upstream::pbr_shadow_bindings.data() + entry.first_shadow_binding,
        entry.shadow_binding_count,
    };
}

/** Whether a composed PBR variant carries the pin's shadow fragment. */
inline bool pbr_variant_receives_shadows(std::size_t variant) {
    return upstream::pbr_variants[variant].shadow_binding_count != 0;
}
#else
inline bool pbr_variant_receives_shadows(std::size_t) { return false; }
#endif

#if BBLITE_NODE_SHADOWS
/**
 * One node graph's receiver rows, the third family in the shared shape.
 *
 * `emitShadow` appends them to the GRAPH's own group 1 rather than opening
 * a group of its own, so they are bound beside the graph's textures rather
 * than as their own group -- but each row is the same reflected shape the
 * two composed families' are, and resolves through the same builders.
 */
inline std::span<const upstream::PinnedShadowBinding> node_shadow_rows(
    const upstream::NodeVariantEntry& entry) {
    return {
        upstream::node_shadow_bindings.data() + entry.first_shadow_binding,
        entry.shadow_binding_count,
    };
}
#endif

#if BBLITE_NODE_VARIANTS > 0
/**
 * A node graph's two compiled views, as one index.
 *
 * `buildNodeRenderables` compiles the receiver and, for a graph that casts,
 * an ESM caster from the same bodies. They differ by one binding row and by
 * their modules, so each backend keeps a resource per view rather than per
 * graph, and both agree on which slot is which here.
 */
#if BBLITE_NODE_SHADOWS
inline constexpr std::size_t node_variant_slot(
    std::size_t variant,
    bool caster) {
    return variant * 2 + (caster ? 1 : 0);
}

inline std::size_t node_variant_slots() {
    return upstream::node_variants.size() * 2;
}

/** The graph one slot names, and which of its two views. */
inline constexpr std::size_t node_slot_variant(std::size_t slot) {
    return slot / 2;
}

inline constexpr bool node_slot_is_caster(std::size_t slot) {
    return slot % 2 == 1;
}
#else
// A build composing no node caster has one view per graph, so the slot IS
// the variant and every backend's per-slot table keeps its old size.
inline constexpr std::size_t node_variant_slot(
    std::size_t variant,
    [[maybe_unused]] bool caster) {
    return variant;
}

inline std::size_t node_variant_slots() {
    return upstream::node_variants.size();
}

inline constexpr std::size_t node_slot_variant(std::size_t slot) {
    return slot;
}

inline constexpr bool node_slot_is_caster(std::size_t) { return false; }
#endif

/**
 * The two stems one slot's modules deploy under.
 *
 * Which of a graph's two compiled views a slot names decides both, so the
 * pair travels together rather than as a ternary per load site.
 */
inline upstream::NodeVariantStems node_variant_stems(std::size_t slot) {
    const upstream::NodeVariantEntry& entry =
        upstream::node_variants[node_slot_variant(slot)];
#if BBLITE_NODE_SHADOWS
    if (node_slot_is_caster(slot)) {
        return {entry.caster.vertex_stem, entry.caster.fragment_stem};
    }
#endif
    return {entry.vertex_stem, entry.fragment_stem};
}
#endif

#if BBLITE_SHADOW_RECEIVERS
/**
 * The casters `computeDirectionalLightMatrix` folds, as it reads them.
 *
 * The pin walks `Mesh` objects and takes `worldMatrix`, `boundMin` and
 * `boundMax` off each; composing a world matrix is this layer's, so the
 * carrier is filled here and the fold stays the pin's. A mesh with no
 * geometry takes the pin's own `?? [...]` fallback, which the generated
 * header carries from its literal.
 *
 * Not the ESM generator's alone: BOTH directional generators fit their
 * volume to the caster bounds, because a directional light has no position
 * to project from. Only the spot generator builds its volume from the
 * light, which is why this is gated on the receiver half rather than on
 * either filter.
 */
inline void fitted_shadow_casters(
    const Engine& engine,
    const ShadowGeneratorRecord& generator,
    std::vector<upstream::ShadowCaster>& casters) {
    casters.clear();
    casters.reserve(generator.caster_meshes.size());
    for (const MeshHandle handle : generator.caster_meshes) {
        if (handle.value >= engine.meshes.size()) continue;
        const MeshRecord& record = engine.meshes[handle.value];
        upstream::ShadowCaster caster;
        caster.world = upstream::shadow_caster_world(record);
        if (record.geometry < engine.geometries.size()) {
            const ModelGeometry& geometry =
                engine.geometries[record.geometry];
            caster.bounds_min = {
                geometry.bounds_min.x,
                geometry.bounds_min.y,
                geometry.bounds_min.z,
            };
            caster.bounds_max = {
                geometry.bounds_max.x,
                geometry.bounds_max.y,
                geometry.bounds_max.z,
            };
        } else {
            caster.bounds_min = upstream::shadow_caster_bounds_fallback_min;
            caster.bounds_max = upstream::shadow_caster_bounds_fallback_max;
        }
        casters.push_back(caster);
    }
}
#endif

#if BBLITE_SHADOW_RECEIVERS
/**
 * The scene's shadow generators, each with its light's own slot in
 * `scene.lights`.
 *
 * That slot IS the ordinal every shadow contract names. The pin composes a
 * receiver's group-2 rows as `shadowTex_<lightIndex>`, where `lightIndex`
 * is "the position of its light in `scene.lights`" -- so a scene whose
 * shadow-casting light is not its first light numbers its rows from the
 * light, not from a count of generators. Counting generators instead
 * agrees with the light order exactly while every light carries one, and
 * scene 207 -- an ambient hemispheric light beside a shadow-casting
 * directional -- is where the two part company.
 *
 * Stated once so a backend that keys densely and one that keys by handle
 * cannot disagree about which generator is light `n`.
 */
template <typename Visit>
inline void for_each_shadow_generator(
    const Scene& scene,
    const Engine& engine,
    Visit&& visit) {
    for (std::size_t slot = 0; slot < scene.lights.size(); ++slot) {
        const LightHandle light = scene.lights[slot];
        if (light.value >= engine.lights.size()) continue;
        const ShadowGeneratorHandle handle =
            engine.lights[light.value].shadow_generator;
        if (handle.value >= engine.shadow_generators.size()) continue;
        visit(handle, light, slot);
    }
}

/** The refresh's own carriers, kept by each backend across frames. */
struct ShadowRefreshState {
    /** Refilled per generator by the ESM caster fold, never reallocated. */
    std::vector<upstream::ShadowCaster> casters;
    /**
     * The receiver block each generator last uploaded, by handle, against
     * which the next frame's is compared. `renderPcfShadowMap` re-uploads
     * only when the light moved, and for a static one these 96 bytes are
     * identical every frame.
     */
    std::vector<upstream::ShadowInfoUniforms> blocks;
    /** Whether `blocks[handle]` holds an upload yet. */
    std::vector<bool> uploaded;
};

/**
 * Refresh every generator the scene's lights name, then hand each to the
 * backend.
 *
 * What is shared is the refresh and the dirty test: the ESM fit re-reads
 * its casters' world bounds every frame because it is sized to them and
 * not to the light, the PCF spot rebuilds from the light's live position
 * and direction, and the receiver block that falls out is re-uploaded only
 * when it moved. All of that is engine-side math with one right answer.
 *
 * What stays per backend is the resource each keeps for a generator, which
 * is what the visitor receives: the record, its own handle, its dense
 * position in the light order, the block, and whether that block is new.
 */
template <typename Visit>
inline void refresh_shadow_generators(
    const Scene& scene,
    Engine& engine,
    ShadowRefreshState& refresh,
    Visit&& visit) {
    if (refresh.blocks.size() < engine.shadow_generators.size()) {
        refresh.blocks.resize(engine.shadow_generators.size());
        refresh.uploaded.resize(engine.shadow_generators.size(), false);
    }
    // The pin's own floating-origin offset for a shadow map:
    // `renderPcfShadowMap` and `renderEsmShadowMap` each read the active
    // camera's world translation and build the light view and the caster fit
    // against it, so the map lands in the same eye-relative frame the mesh
    // worlds are packed into. Off the mode this is the zero vector, which is
    // the pin's own `foCam ? ... : 0`. A frame constant, so it is read once
    // here rather than per generator.
    const Vec3d eye = frame_floating_origin_offset(scene, engine);
    for_each_shadow_generator(
        scene,
        engine,
        [&](
            ShadowGeneratorHandle handle,
            LightHandle light,
            std::size_t slot) {
            ShadowGeneratorRecord& generator =
                engine.shadow_generators[handle.value];
#if BBLITE_SHADOWS_ESM
            if (generator.filter == ShadowFilter::esm_directional) {
                fitted_shadow_casters(engine, generator, refresh.casters);
                upstream::update_esm_directional_shadow(
                    generator,
                    engine.lights[light.value],
                    refresh.casters,
                    eye);
            } else
#endif
            // The third arm needs no define of its own: it shares every
            // resource the spot generator builds, and what it needs beside
            // them -- the caster fit -- is the receiver half's, not the
            // ESM's.
            if (generator.filter == ShadowFilter::pcf_directional) {
                fitted_shadow_casters(engine, generator, refresh.casters);
                if (
                    generator.csm_single_map &&
                    scene.camera.value < engine.cameras.size()) {
                    upstream::update_csm_single_map_shadow(
                        generator,
                        engine.lights[light.value],
                        engine.cameras[scene.camera.value],
                        static_cast<double>(engine.options.width) /
                            static_cast<double>(engine.options.height),
                        refresh.casters);
                } else {
                    upstream::update_pcf_directional_shadow(
                        generator,
                        engine.lights[light.value],
                        refresh.casters,
                        eye);
                }
            } else
            upstream::update_pcf_spot_shadow(
                generator,
                engine.lights[light.value],
                eye);
            const upstream::ShadowInfoUniforms block =
                upstream::shadow_info_block(generator);
            const bool moved = !refresh.uploaded[handle.value] ||
                std::memcmp(
                    &block,
                    &refresh.blocks[handle.value],
                    sizeof(block)) != 0;
            refresh.blocks[handle.value] = block;
            refresh.uploaded[handle.value] = true;
            visit(generator, handle, slot, block, moved);
        });
}
#endif


#if BBLITE_PINNED_MATERIALS
/**
 * The pin's per-pass scene block.
 *
 * Every member is the one the pin's own declaration names; the fragment reads
 * its view direction from `vEyePosition` and its reflection path from `view`,
 * both from the camera the pass renders with. Shared, because the block is the
 * pin's rather than either backend's: Dawn uploads it to a buffer and SDL_GPU
 * pushes it at a uniform slot, and neither should decide what is in it.
 */
inline upstream::SceneUniforms pinned_scene_block(
    const Scene& scene,
    const Engine& engine,
    const CameraRecord& camera,
    const std::array<float, 16>& view_projection) {
    upstream::SceneUniforms scene_block{};
    scene_block.viewProjection = view_projection;
    // The pin's fragment reads the view direction from `vEyePosition`, and its
    // reflection path from `view`. Both come from the camera the pass renders
    // with, the same one `build_pbr_uniforms` reads.
    const std::array<upstream::CameraMatrixScalar, 16> camera_world =
        upstream::camera_world_matrix(camera);
#if BBLITE_FLOATING_ORIGIN
    const Vec3d fo_offset = floating_origin_offset(scene, engine);
    const Vec3d fo_camera_eye =
        upstream::arc_rotate_eye_position(camera);
#endif
    scene_block.vEyePosition = {
#if BBLITE_FLOATING_ORIGIN
        // `writePassSceneUBO` writes `cameraWorld - offset` under floating
        // origin, and the offset IS this camera's world position -- so the
        // eye sits at the origin of the same frame the mesh worlds and the
        // view translation were put in. Written as the difference rather
        // than as zero because a render task drawing through a second
        // camera is relative to the scene camera, not to itself.
        // Both sides are the camera's own F64 world translation, so the
        // steady-state eye is exactly zero -- reading the left side off the
        // narrowed float world instead would leave half an ULP of the
        // large coordinate behind.
        static_cast<float>(fo_camera_eye.x - fo_offset.x),
        static_cast<float>(fo_camera_eye.y - fo_offset.y),
        static_cast<float>(fo_camera_eye.z - fo_offset.z),
#else
        static_cast<float>(camera_world[12]),
        static_cast<float>(camera_world[13]),
        static_cast<float>(camera_world[14]),
#endif
        1.0f,
    };
    scene_block.view = upstream::build_view_matrix(camera_world);
    scene_block.envRotationY = scene.environment.rotation_y;
    // `vImageInfos` is documented in the pin's own declaration as
    // exposureLinear, contrast, lodGenerationScale, toneMappingEnabled.
    scene_block.vImageInfos = {
        scene.environment.exposure,
        scene.environment.contrast,
        scene.environment.lod_generation_scale,
        // The pin's executeRenderTaskLinear stamps toneMappingEnabled = -1
        // while a transmission scene's retargeted linear passes run; every
        // composed fragment then skips its processing tail
        // (`if(scene.vImageInfos.w>=0.0)`) and the trailing
        // image-processing pass applies it once. The captured browser block
        // carries the same -1 (scene30 buffer#1).
        scene.transmission_enabled
            ? -1.0f
            : scene.environment.tone_mapping_enabled ? 1.0f : 0.0f,
    };
    scene_block.vFogInfos = {
        scene.fog_mode,
        scene.fog_start,
        scene.fog_end,
        scene.fog_density,
    };
    // `_packSceneUniforms` writes the canvas size into the block's two spare
    // lanes -- `vFogColor.w` and `_envPad0` -- for every scene, and a node
    // graph's ScreenSizeBlock is what reads them back. The size is the
    // engine's configured one, which is what `eng.canvas` reports.
    scene_block.vFogColor = {
        scene.fog_color.r,
        scene.fog_color.g,
        scene.fog_color.b,
        static_cast<float>(engine.options.width),
    };
    scene_block._envPad0 = static_cast<float>(engine.options.height);
    const std::array<std::array<float, 4>*, 9> harmonics{
        &scene_block.vSphericalL00,
        &scene_block.vSphericalL1_1,
        &scene_block.vSphericalL10,
        &scene_block.vSphericalL11,
        &scene_block.vSphericalL2_2,
        &scene_block.vSphericalL2_1,
        &scene_block.vSphericalL20,
        &scene_block.vSphericalL21,
        &scene_block.vSphericalL22,
    };
    for (std::size_t index = 0; index < harmonics.size(); ++index) {
        const Color3& band = scene.environment.spherical_harmonics[index];
        *harmonics[index] = {band.r, band.g, band.b, 0.0f};
    }
    return scene_block;
}

/**
 * The pin's per-pass lights block: a u32 count, three words of padding, then
 * MAX_LIGHTS entries.
 *
 * `fillLightsData` writes that count through a Float32Array view of the same
 * buffer, so it lands in the first four bytes. Returned as bytes because that is
 * what both a buffer upload and a uniform push take.
 */
inline std::vector<std::uint8_t> pinned_lights_block(
    const Scene& scene,
    const Engine& engine) {
    std::array<std::uint32_t, 4> header{};
    std::vector<upstream::LightEntry> entries(upstream::pinned_max_lights);
    std::uint32_t count = 0;
    for (const LightHandle handle : scene.lights) {
        if (count >= upstream::pinned_max_lights) break;
        if (handle.value >= engine.lights.size()) continue;
        const LightRecord& light = engine.lights[handle.value];
        // Which writer each kind takes is generated: the scene compiles arms
        // only for the kinds it reaches, so the mapping cannot be restated here.
        upstream::write_pinned_light(light, entries[count]);
        ++count;
    }
    header[0] = count;
#if BBLITE_FLOATING_ORIGIN
    apply_light_floating_origin(entries, count, scene, engine);
#endif
    std::vector<std::uint8_t> bytes(
        sizeof(header) + entries.size() * sizeof(upstream::LightEntry));
    std::memcpy(bytes.data(), header.data(), sizeof(header));
    std::memcpy(
        bytes.data() + sizeof(header),
        entries.data(),
        entries.size() * sizeof(upstream::LightEntry));
    return bytes;
}

// The pin's per-draw mesh block.
//
// `writeMeshLightSelection` decides its shape: the world matrix, the count of
// lights affecting this mesh, then their indices. Which lights those are comes
// from the generated `light_affects_mesh`, lowered from the pin's own
// `affectsMesh`, so this walks exactly the set the Standard slot writer walks.
/**
 * The pin's own per-mesh light selection (`writeMeshLightSelection`).
 *
 * Shared because the mesh block is not one struct: the material families
 * declare `MeshUniforms` and a node graph declares its own `MeshU` with a
 * shadow lane between the world matrix and the count. What they agree on is
 * this walk, so it is written once over whichever block's lanes.
 */
template <typename Block>
inline void pinned_mesh_light_selection(
    const Scene& scene,
    const Engine& engine,
    std::uint32_t mesh_index,
    Block& block) {
    std::uint32_t count = 0;
    std::uint32_t light_index = 0;
    for (const LightHandle handle : scene.lights) {
        if (light_index >= upstream::pinned_max_lights) break;
        if (handle.value >= engine.lights.size()) continue;
        if (
            upstream::light_affects_mesh(
                engine.lights[handle.value],
                mesh_index)) {
            block.li[count / 4][count % 4] = light_index;
            ++count;
        }
        ++light_index;
    }
    block.lc = count;
}

#if BBLITE_PINNED_MATERIAL_VARIANTS
inline upstream::MeshUniforms pinned_mesh_block(
    const Scene& scene,
    const Engine& engine,
    const std::array<float, 16>& world,
    std::uint32_t mesh_index) {
    upstream::MeshUniforms block{};
    block.world = world;
    pinned_mesh_light_selection(scene, engine, mesh_index, block);
    // The velocity geometry arm's tail. The native worlds are constant
    // frame to frame (node motion re-bakes vertices), so the previous
    // world is the world itself and the flag stays on: the composed
    // vertex then measures camera motion, which is what the pin's
    // tracked previous clip reduces to for a static world. The generic
    // lambda makes the access dependent: outside a template, both
    // `if constexpr` branches must compile, and most scenes' mirrored
    // MeshUniforms carries no velocity tail.
    [&](auto& dependent) {
        if constexpr (
            requires {
                dependent.previousWorld;
                dependent.velocityEnabled;
            }) {
            dependent.previousWorld = world;
            dependent.velocityEnabled = 1.0f;
        }
    }(block);
    return block;
}
#endif

#if BBLITE_NODE_VARIANTS > 0
/**
 * A node graph's per-draw mesh block (`node-renderable.ts`).
 *
 * The pin packs the mesh's world matrix, `receiveShadows ? 1 : 0` in the
 * shadow lane, and the same light selection every family uses. The world is
 * the identity because our vertices are baked with it, exactly as the
 * Standard family's are.
 *
 * The shadow lane is a VALUE here where it is a composition key for the
 * other two families: `node-shadow.ts` mixes each light's factor by it
 * (`mix(1.0, _sf[i], meshU.receivesShadow.x)`), so one composed module
 * draws a receiving mesh and a non-receiving one alike.
 */
inline upstream::NodeMeshUniforms node_mesh_block(
    const Scene& scene,
    const Engine& engine,
    std::uint32_t mesh_index) {
    upstream::NodeMeshUniforms block{};
    // The identity is the BAKE's answer, not a constant: this port bakes a
    // node mesh's TRS into its vertices, so the world carries nothing --
    // unless the floating-origin frame kept them local, which is exactly
    // what `draw_world` decides for every family alike.
    block.world = draw_world(
        pinned_identity_world(),
        engine.meshes[mesh_index],
        scene,
        engine);
    if (
        mesh_index < engine.meshes.size() &&
        engine.meshes[mesh_index].receives_shadows) {
        block.receivesShadow[0] = 1.0f;
    }
    pinned_mesh_light_selection(scene, engine, mesh_index, block);
    return block;
}
#endif
#endif

#if BBLITE_PBR_VARIANTS > 0

/**
 * The variant a draw composes, or `npos` when this scene cannot resolve one.
 *
 * The key is the pin's own: the material, the mesh's attributes, the light mode
 * with its single-light kind, and whether tone mapping is on. Two halves come
 * from generation because a PAL cannot recover them — the glTF material index,
 * which is a MaterialHandle only while every material comes from the composed
 * asset, and the attribute set, because our geometry record does not carry uv2
 * or vertex-colour presence. Both are checked rather than assumed: an
 * unresolved draw returns `npos` and takes the transcribed path.
 */
/**
 * Whether a composed variant has been measured to match, by property.
 *
 * The whole point of executing Babylon's own stages is that a difference is a
 * difference in inputs, not in a formula -- so a variant runs here only once the
 * inputs it needs have been measured against the browser's own buffers. Every
 * disqualifier below names an open measurement rather than a scene:
 *
 *  - an extension arm: each contributes its own material-UBO fields through a
 *    lowered writer that no capture has been diffed against.
 *  - `skeleton`: measured, not resolved. The browser's own palette for Scene 7 is
 *    `diag(100, 100, 100, 1)` (its bone texture upload in
 *    `artifacts/capture/scene7/tex-uploads.json`, rgba32float 48x1), so it
 *    carries no mirror and the loader's `native_matrix` conjugation is a no-op on
 *    it; the mesh block carries the mirror instead. Both vertex conventions were
 *    tried against that -- unmirrored 2.522 MAD, mirrored 1.954, against 0.056
 *    transcribed -- so neither the palette nor the mirror is the remaining
 *    difference. The next measurement is our own palette and mesh block dumped
 *    and diffed against those two captured buffers, not more algebra.
 *  - refraction: needs the scene-colour grab bound through the pin's own
 *    mid-pass break rather than our slot order.
 *  - skeleton or morph: the palette and the morph deltas both carry the mirror.
 *
 * Everything else takes the transcribed path, so widening this list is a
 * measurement rather than a rewrite.
 *
 * Shared by both backends: which draws Babylon's own stages can run is a
 * property of the scene and the variant, not of the API binding them, so a
 * second copy could only drift.
 */
/** Whether a variant's vertex stage samples the bone palette. */
inline bool pinned_variant_skeleton(std::size_t variant) {
    return upstream::pbr_variants[variant].key.find("skeleton") !=
        std::string_view::npos;
}

/**
 * The key one PBR draw composes under.
 *
 * Split from the lookup for the reason the Standard family's own key is: a
 * miss reports what it asked for, and recomputing the key at the error site
 * would print something subtly different -- the pin's own
 * `lightCount === 1 && !receiveShadows ? 1 : 2` fold and the mesh row's
 * feature-source redirect both happen here, after the raw reads.
 */
struct PinnedVariantKey {
    std::uint32_t material_index = 0;
    std::uint32_t material_view = 0;
    std::size_t mesh_features = 0;
    std::uint32_t light_mode = 0;
    std::string_view single_light_type;
    bool tone_mapping = false;
    /** Why the key is unusable, when it is; empty once `resolved`. */
    std::string refusal;
    bool resolved = false;
};

inline PinnedVariantKey pinned_variant_key(
    const Scene& scene,
    const Engine& engine,
    const upstream::RenderDrawCommand& draw) {
    PinnedVariantKey key;
    if (draw.item.material_kind != upstream::RenderMaterialKind::pbr) {
        key.refusal = "the draw names no PBR material";
        return key;
    }
    // The table names the FIRST `pbr_variant_material_count` handles: the
    // assets' materials in document order, then every scene-code creation in
    // creation order. What has to hold is that a handle the table names is
    // still the material generation composed for -- so what is checked is
    // the handle, not the count. Records appended past the table are the
    // shadow caster VIEWS `registerSceneWithShadowSupport` builds, and one
    // of those draws through its own no-colour variant rather than a row
    // here; a miss is then reported by the selector rather than guessed at.
    if (draw.item.material.value >= engine.materials.size()) {
        key.refusal = "the draw material handle is invalid";
        return key;
    }
    const MaterialRecord& draw_material =
        engine.materials[draw.item.material.value];
    key.material_view = draw_material.esm_shadow
        ? 2u
        : draw_material.no_color ? 1u : 0u;
    key.material_index =
        draw_material.source_material.value == invalid_handle
            ? draw.item.material.value
            : draw_material.source_material.value;
    if (key.material_index >= upstream::pbr_variant_material_count) {
        key.refusal = "material " + std::to_string(key.material_index) +
            " is past the " +
            std::to_string(upstream::pbr_variant_material_count) +
            " the composed table names";
        return key;
    }
    // The mesh half of the key comes per original renderable. Renderer
    // startup assigns its stable generated-table row and gives every clone
    // the same row, even when clone handles precede later imported meshes.
    std::uint32_t feature_mesh = draw.item.mesh.value;
    if (
        draw.item.mesh.value < engine.meshes.size() &&
        engine.meshes[draw.item.mesh.value]
                .composition_feature_row != invalid_handle) {
        feature_mesh = engine.meshes[draw.item.mesh.value]
            .composition_feature_row;
    }
    key.mesh_features =
        feature_mesh <
            upstream::pbr_renderable_mesh_features.size()
            ? upstream::pbr_renderable_mesh_features[feature_mesh]
            // Scene code can keep creating meshes after registration, all
            // from the fixed-set builders; a scene whose builders disagree
            // publishes npos here and such a draw refuses.
            : upstream::pbr_runtime_mesh_features;
    if (key.mesh_features == std::numeric_limits<std::size_t>::max()) {
        key.refusal =
            "the scene's runtime meshes carry no single attribute set";
        return key;
    }
    // Scene-code pools attach after generation recorded the mesh's static
    // attribute word. Match the pin's _computeMeshFeatures result at draw
    // time; EXT_mesh_gpu_instancing already carries the bit in the table, so
    // this idempotent OR covers both origins with one rule.
    if (draw.item.mesh.value < engine.meshes.size()) {
        const MeshRecord& record = engine.meshes[draw.item.mesh.value];
        if (pinned_record_instanced(record)) {
            key.mesh_features |= upstream::pinned_msh_has_thin_instances;
            // `_computeMeshFeatures` nests this under the pool and reads the
            // mesh's colour stream. Use the binding predicate too, so the
            // selected PBR stage and the stream each backend binds cannot
            // disagree about `instanceColor`.
            if (pinned_record_instance_colored(record)) {
                key.mesh_features |=
                    upstream::pinned_msh_has_instance_color;
            }
        }
        const std::size_t receive_shadows =
            static_cast<std::size_t>(
                upstream::pinned_msh_receive_shadows);
        if (record.receives_shadows) {
            key.mesh_features |= receive_shadows;
        } else {
            key.mesh_features &= ~receive_shadows;
        }
        // A shadow-caster material view is itself the shadow output. The
        // pin computes `receiveShadows` as `!shadowOutput && ...`, so its
        // no-colour/ESM views never splice the receiver fragment even when
        // their source mesh receives shadows in the main render task.
        if (key.material_view != 0u) {
            key.mesh_features &= ~receive_shadows;
        }
    }
    // The light mode, walked the way `writeMeshLightSelection` walks it: how
    // many of the scene's lights affect this mesh decides which arm the pin
    // composed.
    std::uint32_t light_count = 0;
    for (const LightHandle handle : scene.lights) {
        if (handle.value >= engine.lights.size()) continue;
        const LightRecord& light = engine.lights[handle.value];
        if (!upstream::light_affects_mesh(light, draw.item.mesh.value)) {
            continue;
        }
        ++light_count;
        key.single_light_type = upstream::pinned_single_light_type(light);
    }
    // The receive bit rides the mesh row rather than the material, which is
    // why it is read back from the mesh half of the key; the arm it selects
    // comes from the generated lookup generation composed against, so the
    // two cannot disagree about which variants exist.
    key.light_mode = upstream::pinned_pbr_light_mode(
        light_count,
        (key.mesh_features &
            static_cast<std::size_t>(upstream::pinned_msh_receive_shadows)) !=
            0);
    if (key.light_mode != 1) key.single_light_type = "";
    key.tone_mapping = scene.environment.tone_mapping_enabled;
    key.resolved = true;
    return key;
}

/**
 * What a failed PBR variant lookup was asked for.
 *
 * The same diagnostic the Standard family carries, built from the key the
 * lookup actually used rather than from a second derivation: a miss means
 * the runtime derivation and the composed selector table disagree, and a key
 * that differed from the one that missed would name the wrong half.
 */
inline std::string pinned_variant_request(
    const PinnedVariantKey& key,
    std::size_t geometry_task = std::numeric_limits<std::size_t>::max()) {
    if (!key.resolved) return "no key: " + key.refusal;
    return "material " + std::to_string(key.material_index) +
        ", view " + std::to_string(key.material_view) +
        ", mesh features " + std::to_string(key.mesh_features) +
        ", light mode " + std::to_string(key.light_mode) +
        ", single light '" + std::string(key.single_light_type) + "'" +
        ", tone mapping " + (key.tone_mapping ? "on" : "off") +
        ", geometry task " +
        (geometry_task == std::numeric_limits<std::size_t>::max()
             ? std::string("none")
             : std::to_string(geometry_task));
}

inline std::size_t pinned_variant_for_draw(
    const Scene& scene,
    const Engine& engine,
    const upstream::RenderDrawCommand& draw,
    // The geometry-output task the draw belongs to, npos for the colour
    // passes: the selector table keys on it, so a geometry draw resolves
    // its own MRT arm and never a colour variant.
    std::size_t geometry_task = std::numeric_limits<std::size_t>::max(),
    // Filled with the key the lookup used, so a miss reports that key
    // rather than a second derivation of it.
    PinnedVariantKey* key_out = nullptr) {
    if (upstream::pbr_variants.empty()) {
        return std::numeric_limits<std::size_t>::max();
    }
    // A mesh whose node transform is not baked into its vertices carries it
    // in the record's parent matrix, which the composed stages consume; a
    // record without it cannot resolve a variant and errors at the draw.
    bool has_bones = false;
    if (draw.item.mesh.value < engine.meshes.size()) {
        const MeshRecord& record = engine.meshes[draw.item.mesh.value];
        // An animated node needs no guard: the PAL re-transforms its vertices
        // on the CPU when `transform_version` moves, so the GPU always sees
        // world space and the pin's `finalWorld` stays the identity. An
        // instanced mesh resolves the pin's own thin-instance arm -- its
        // renderable features carry MSH_HAS_THIN_INSTANCES -- and the draw
        // binds the per-instance matrix buffer as the arm's second stream.
        // `bone_matrices` is not only a skin: the glTF loader pushes the mesh's
        // own world matrix into it for an *animated* mesh with no skin at all,
        // and the transcribed vertex stage takes the transform from there. A
        // non-skeleton variant reads no palette, so such a draw would lose its
        // animation — Scenes 39, 242 and 254 measured 4.2 to 11.9 MAD that way
        // against 0.000 transcribed. A skeleton variant reads the palette the
        // pin's own stage samples, so the check keys on the resolved variant
        // below rather than refusing every mesh that carries bones. Skins need
        // no `transform_version` guard either, animated node or not: the
        // pin's updater conjugates `invMeshWorld` into the palette at bind
        // time and excludes skinned-mesh nodes from scene-graph animation, so
        // every node motion a skin can see arrives through the joint worlds
        // our palette already carries. The 2.5 and 4.5 MAD once filed against
        // node-animated skins were the missing flat-normal fragment arm --
        // Scenes 255 and 245 measure 0.000 on both backends through this path
        // with the arm composed, and Scene 7 measures its pinned 0.047
        // against 0.056 transcribed.
        if (!record.bone_matrices.empty()) {
            has_bones = true;
        }
    }
    const PinnedVariantKey key = pinned_variant_key(scene, engine, draw);
    if (!key.resolved) return std::numeric_limits<std::size_t>::max();
    if (key_out) *key_out = key;
    // Every light mode. All three read the same lights block, whose writers index
    // the pin's own light world matrix; the block itself was diffed against the
    // browser's (`artifacts/capture/scene7/buffers.json`, 1040 bytes beside the
    // 368-byte scene block).
    // A transmission scene resolves the same table: its materials compose
    // with `_linearImageProcessing` (the pin's markPbrMaterialsLinear), so
    // every fragment guards its processing tail on `vImageInfos.w >= 0` and
    // the linear main pass runs with the lane at -1; the refraction arms
    // bind the existing 1024x1024 scene-colour grab through the variant's
    // own `refractionTexture` slot. The earlier 17.8-MAD refusal here was
    // the guard missing from the composed fragments, not pass structure.
    const std::size_t variant = upstream::pbr_variant_for(
        key.material_index,
        key.material_view,
        static_cast<std::uint32_t>(key.mesh_features),
        key.light_mode,
        key.single_light_type,
        key.tone_mapping,
        geometry_task);
    if (variant == std::numeric_limits<std::size_t>::max()) {
        return std::numeric_limits<std::size_t>::max();
    }
    // A skeleton variant needs the palette to exist or the deformation is
    // lost. The reverse -- a palette on a non-skeleton variant -- is the
    // animated no-skin mesh, whose single palette entry is the mesh's own
    // world; the draw passes it as the pin's finalWorld against the mirrored
    // buffer, the same convention the skinned draw measured.
    const bool skeleton_variant = pinned_variant_skeleton(variant);
    if (skeleton_variant && !has_bones) {
        return std::numeric_limits<std::size_t>::max();
    }
    return variant;
}

/**
 * The convention arms one pinned draw rides.
 *
 * A skinned draw takes the identity world with the MIRRORED vertex
 * buffer: the loader's palette is the mirror-conjugated
 * `jointWorld * IBM` (`M A M`), so against mirrored vertices the product
 * collapses to the browser's own `M * jointWorld * IBM * v_unmirrored`,
 * and adding the mirror world on top double-applies it -- the finding the
 * Dawn backend's captured mesh blocks localised (world = bare mirror,
 * palette translation 1.66 vs the browser's 0). An animated no-skin mesh
 * rides the same convention with one matrix: its palette entry is
 * `M * world * M`, passed as the pin's finalWorld against the mirrored
 * buffer. Derived once so the backends cannot disagree about which draw
 * takes which arm.
 */
struct PinnedDrawConventions {
    bool skeleton_draw;
    bool world_from_palette;
    bool mirrored_vertices;
};

inline PinnedDrawConventions pinned_draw_conventions(
    std::size_t variant,
    const MeshRecord& record) {
    const bool skeleton_draw = pinned_variant_skeleton(variant);
    const bool world_from_palette =
        !skeleton_draw && !record.bone_matrices.empty();
    return PinnedDrawConventions{
        skeleton_draw,
        world_from_palette,
        skeleton_draw || world_from_palette,
    };
}

/**
 * The pin's bone-palette texture shape: `skeleton-updater.ts` writes
 * `invMeshWorld * jointWorld * IBM` per bone into one rgba32float row,
 * four 16-byte texels per bone. Both backends size and fill their
 * palette texture from this; only the upload mechanics stay per API.
 */
struct BonePaletteLayout {
    std::uint32_t width;
    std::uint32_t height;
    // The whole palette, which for the single row is also the row pitch.
    std::uint32_t bytes;
};

inline BonePaletteLayout bone_palette_layout(std::uint32_t bones) {
    const std::uint32_t width = bones * 4u;
    return BonePaletteLayout{width, 1u, width * 16u};
}
#endif

#if defined(BBLITE_HAS_PBR_RENDERER) && BBLITE_HAS_PBR_RENDERER
/**
 * A shader material carrying fewer textures than its stage samples.
 *
 * Both backends raise it through their own error function, so the message
 * is composed once here the way `standard_variant_request` already is. It
 * describes a generation bug -- the record is filled by the compiled
 * `setShaderTexture` calls -- rather than a draw to skip.
 */
inline std::string shader_sampler_shortfall(
    const upstream::ShaderVariantInfo& info,
    std::size_t carried) {
    return "shader variant '" + std::string(info.name) + "' declares " +
        std::to_string(info.samplers.size()) +
        " sampler(s); the material carries " + std::to_string(carried) +
        " texture(s).";
}

/** A compiled stage keeping a register the material never declared. */
inline std::string shader_sampler_unmapped(
    const upstream::ShaderVariantInfo& info,
    const std::string& texture_name) {
    return "shader variant '" + std::string(info.name) +
        "' binds texture '" + texture_name +
        "', which its samplers option never declared.";
}
#endif

#if BBLITE_STANDARD_VARIANTS > 0
/** The pair `standard_variant_for` looks a draw up by, or none. */
struct StandardVariantKey {
    std::uint32_t features = 0;
    std::size_t mesh_features = 0;
    bool resolved = false;
};

/**
 * The key a draw composes under.
 *
 * Split from the lookup so a miss can report what it asked for: the two
 * numbers are the whole diagnosis, and recomputing them at the error site
 * would print something subtly different -- the no-color pass bit and the
 * thin-instance and morph mesh bits are ORed on here, after the raw reads.
 */
inline StandardVariantKey standard_variant_key(
    const Engine& engine,
    const upstream::RenderDrawCommand& draw) {
    StandardVariantKey key;
    if (
        draw.item.material_kind !=
            upstream::RenderMaterialKind::standard ||
        draw.item.material.value >= engine.materials.size()) {
        return key;
    }
    const MaterialRecord& material =
        engine.materials[draw.item.material.value];
    key.features = upstream::standard_material_features(material);
    if (material.no_color) {
        key.features |= upstream::standard_no_color_output_flag;
    }
#if BBLITE_SHADOWS_ESM
    if (material.esm_shadow) {
        // `createStandardEsmShadowMaterialView` clears the blend bit before
        // setting its own, so the key says both.
        key.features = (key.features &
            ~upstream::standard_alpha_blend_flag) |
            upstream::standard_esm_shadow_output_flag;
    }
#endif
    std::uint32_t feature_mesh = draw.item.mesh.value;
    if (
        draw.item.mesh.value < engine.meshes.size() &&
        engine.meshes[draw.item.mesh.value]
                .composition_feature_row != invalid_handle) {
        feature_mesh = engine.meshes[draw.item.mesh.value]
            .composition_feature_row;
    }
    key.mesh_features =
        feature_mesh <
            upstream::standard_renderable_mesh_features.size()
            ? upstream::standard_renderable_mesh_features[
                  feature_mesh]
            : upstream::standard_runtime_mesh_features;
    if (key.mesh_features == std::numeric_limits<std::size_t>::max()) {
        return key;
    }
    if (draw.item.mesh.value < engine.meshes.size()) {
        const MeshRecord& record = engine.meshes[draw.item.mesh.value];
        if (pinned_record_instanced(record)) {
            key.mesh_features |= upstream::std_msh_has_thin_instances;
            // `_computeMeshFeatures` reads `mesh.thinInstances.colors`, so
            // the colour bit arrives with the pool rather than with the
            // material: a coloured pool composes the Standard family's own
            // final-colour slot, an uncoloured one the plain fragment.
            if (pinned_record_instance_colored(record)) {
                key.mesh_features |=
                    upstream::std_msh_has_instance_color;
            }
        }
        const std::size_t receive_shadows =
            static_cast<std::size_t>(
                upstream::pinned_msh_receive_shadows);
        if (record.receives_shadows) {
            key.mesh_features |= receive_shadows;
        } else {
            key.mesh_features &= ~receive_shadows;
        }
    }
    // `rebuildSingle` computes `receiveShadows` as `!shadowOutput && ...`,
    // so a depth-only view of a mesh that also receives is composed without
    // the shadow fragment and its key carries no receive bit.
    if (
        material.no_color
#if BBLITE_SHADOWS_ESM
        || material.esm_shadow
#endif
    ) {
        key.mesh_features &= ~static_cast<std::size_t>(
            upstream::pinned_msh_receive_shadows);
    }
    if (
        draw.item.geometry < engine.geometries.size() &&
        !engine.geometries[draw.item.geometry].morph_positions.empty()) {
        key.mesh_features |= upstream::std_msh_has_morph_targets;
    }
    key.resolved = true;
    return key;
}

/**
 * What a failed Standard variant lookup was asked for.
 *
 * A miss means the runtime derivation and the composed selector table
 * disagree, which is what an upstream feature-derivation change looks like
 * from here.
 */
inline std::string standard_variant_request(
    const Engine& engine,
    const upstream::RenderDrawCommand& draw) {
    const StandardVariantKey key = standard_variant_key(engine, draw);
    if (!key.resolved) {
        if (draw.item.material.value >= engine.materials.size()) {
            return "no key: material handle " +
                std::to_string(draw.item.material.value) + " exceeds " +
                std::to_string(engine.materials.size()) +
                " runtime materials";
        }
        return "no key: runtime material flags standard=" +
            std::to_string(
                engine.materials[draw.item.material.value].standard_material) +
            ", shader=" +
            std::to_string(
                engine.materials[draw.item.material.value].shader_material) +
            ", draw kind=" +
            std::to_string(static_cast<std::uint32_t>(
                draw.item.material_kind));
    }
    return "features " + std::to_string(key.features) + ", mesh features " +
        std::to_string(key.mesh_features);
}

/**
 * The Standard variant a draw composes, or `npos` when none was emitted.
 *
 * The key is the pin's own feature word, derived from the record by the
 * generated `standard_material_features` — the same pinned
 * `_computeStandardMaterialFeatures` generation executed to compose — plus
 * the mesh bits: the static per-handle table with the pool and deformation
 * bits ORed on at draw time, because thin instances attach and morph
 * weights arrive after mesh creation. A no-color view's record ORs the
 * pass bit the composition keyed its depth-only rows on.
 */
inline std::size_t standard_variant_for_draw(
    const Scene& scene,
    const Engine& engine,
    const upstream::RenderDrawCommand& draw,
    std::size_t geometry_task = std::numeric_limits<std::size_t>::max(),
    // Filled with the derived key when the caller passes one, so the draw
    // can consume `key.features` instead of re-deriving it.
    StandardVariantKey* key_out = nullptr) {
    (void)scene;
    const StandardVariantKey key = standard_variant_key(engine, draw);
    if (key_out) *key_out = key;
    if (!key.resolved) {
        return std::numeric_limits<std::size_t>::max();
    }
    return upstream::standard_variant_for(
        key.features,
        static_cast<std::uint32_t>(key.mesh_features),
        geometry_task);
}

/**
 * The pin's mesh-block world for one Standard draw.
 *
 * The native side bakes a mesh's TRS into its vertices, so the pin's
 * `finalWorld` collapses to the identity — the Standard families carry no
 * glTF X-mirror. A thin-instanced draw keeps local vertices and rides the
 * pin's own `mesh.world * instanceWorld` product, so it takes the record's
 * parent TRS. A LOCAL_POSITION geometry variant reads the raw position
 * attribute, so its draw binds the unbaked local lanes and needs the
 * pin's node world back: the TRS the loader baked away and recorded in
 * `instance_parent_matrix` (the identity for a mesh that never had one —
 * scene 145's browser blocks carry exactly that TRS beside
 * localMatrix-applied vertex uploads, so `world * local` reproduces the
 * baked product). A record whose own transform is live bakes at packing
 * time instead and records no such world, so it is refused by name
 * rather than rendered with a silently-wrong varying.
 */
inline std::array<float, 16> standard_draw_world(
    const MeshRecord& record,
    bool uses_local_position,
    const Scene& scene,
    const Engine& engine) {
#if BBLITE_GPU_INSTANCING
    if (pinned_record_instanced(record)) {
        return instance_parent_draw_world(record, scene, engine);
    }
#endif
    if (uses_local_position) {
        const bool identity_transform =
            record.position.x == 0.0f && record.position.y == 0.0f &&
            record.position.z == 0.0f &&
            record.scaling.x == 1.0f && record.scaling.y == 1.0f &&
            record.scaling.z == 1.0f &&
            !record.has_rotation_quaternion &&
            record.rotation.x == 0.0f && record.rotation.y == 0.0f &&
            record.rotation.z == 0.0f;
        if (!identity_transform) {
            throw std::runtime_error(
                "A LOCAL_POSITION geometry variant over a transformed "
                "Standard mesh is not wired: the baked vertices and the "
                "raw position attribute disagree.");
        }
        return draw_world(
            record.instance_parent_matrix,
            record,
            scene,
            engine);
    }
    return draw_world(std::array<float, 16>{
        1.0f, 0.0f, 0.0f, 0.0f,
        0.0f, 1.0f, 0.0f, 0.0f,
        0.0f, 0.0f, 1.0f, 0.0f,
        0.0f, 0.0f, 0.0f, 1.0f,
    }, record, scene, engine);
}

/**
 * The Standard material block for one draw: the pin's own writer over the
 * record-filled props. A material-less item keeps the pin's defaults, the
 * way `createStandardMaterial` seeds them.
 */
inline upstream::StandardMaterialUniforms standard_material_block(
    const MaterialRecord* material,
    std::uint32_t features) {
    const upstream::StandardMaterialProps props = material
        ? upstream::standard_material_props(*material)
        : upstream::StandardMaterialProps{};
    upstream::StandardMaterialUniforms block{};
    upstream::write_standard_material(
        props,
        upstream::standard_texture_level(features),
        block);
    return block;
}

/** The vertex-stage UV block for one draw, by the pin's own writer. */
inline upstream::StandardUvTransformUniforms standard_uv_block(
    const MaterialRecord* material,
    std::uint32_t features) {
    const upstream::StandardMaterialProps props = material
        ? upstream::standard_material_props(*material)
        : upstream::StandardMaterialProps{};
    upstream::StandardUvTransformUniforms block{};
    upstream::write_standard_uv_transform(
        props,
        material != nullptr &&
            upstream::standard_uv_inverted(features, *material),
        block);
    return block;
}

#if defined(BBLITE_HAS_STANDARD_UV_TRANSFORM) && BBLITE_HAS_STANDARD_UV_TRANSFORM
/**
 * `stdUvTransformExt`'s own block, by the pin's own per-channel writer.
 *
 * The extension replaces the base `up` block's assignment in the vertex
 * stage rather than removing it, so both blocks bind on a marked material
 * and this one is what the varyings actually read.
 */
inline upstream::StandardUvTxUniforms standard_uv_transform_block(
    const MaterialRecord* material) {
    upstream::StandardUvTxUniforms block{};
    if (!material) return block;
    upstream::write_std_uv_transform_data(
        *material,
        upstream::standard_material_props(*material),
        block);
    return block;
}
#endif
#endif

#if BBLITE_GPU_MORPH_STORAGE
// Storage-buffer morph payloads shared by both render backends (moved
// verbatim from the two upload paths). Both backends must pack these
// byte-identically: the deltas are indexed by the shader as
// (target * vertexCount + vertex) * 6, and the weights blob carries a
// 16-byte header the shader reads before the float array.
inline std::vector<float> pack_morph_deltas(
    const ModelGeometry& geometry) {
    // Flat 6-float deltas indexed
    // (target * vertexCount + vertex) * 6, packed with the
    // same x negation as the vertex attributes.
    const std::size_t target_count = geometry.morph_positions.size();
    const std::size_t vertex_count = geometry.vertices.size();
    std::vector<float> deltas(
        target_count * vertex_count * 6,
        0.0f);
    for (
        std::size_t target = 0;
        target < target_count;
        ++target) {
        const std::vector<Vec3>& positions =
            geometry.morph_positions[target];
        for (
            std::size_t vertex = 0;
            vertex < vertex_count;
            ++vertex) {
            const std::size_t offset =
                (target * vertex_count + vertex) * 6;
            const Vec3 position =
                vertex < positions.size()
                    ? positions[vertex]
                    : Vec3{};
            const Vec3 normal =
                target < geometry.morph_normals.size() &&
                vertex <
                    geometry.morph_normals[target].size()
                    ? geometry.morph_normals[target][vertex]
                    : Vec3{};
            deltas[offset] = -position.x;
            deltas[offset + 1] = position.y;
            deltas[offset + 2] = position.z;
            deltas[offset + 3] = -normal.x;
            deltas[offset + 4] = normal.y;
            deltas[offset + 5] = normal.z;
        }
    }
    return deltas;
}

/**
 * The float array behind the weights blob's 16-byte header: one weight
 * per target, zero past the record's stored values. Split out because a
 * version-gated re-upload may rewrite just this span (the header is
 * constant after creation), and both backends must fill it identically.
 */
inline std::vector<float> morph_weight_values(
    const ModelGeometry& geometry,
    const MeshRecord& mesh_record) {
    const std::size_t target_count = geometry.morph_positions.size();
    std::vector<float> weights(target_count, 0.0f);
    for (
        std::size_t target = 0;
        target < target_count;
        ++target) {
        weights[target] =
            target < mesh_record.morph_storage_weights.size()
                ? mesh_record.morph_storage_weights[target]
                : 0.0f;
    }
    return weights;
}

inline std::vector<std::uint8_t> pack_morph_weights(
    const ModelGeometry& geometry,
    const MeshRecord& mesh_record) {
    const std::size_t target_count = geometry.morph_positions.size();
    const std::size_t vertex_count = geometry.vertices.size();
    std::vector<std::uint8_t> weights_blob(
        16 + target_count * sizeof(float),
        0);
    const std::uint32_t header[2] = {
        static_cast<std::uint32_t>(target_count),
        static_cast<std::uint32_t>(vertex_count),
    };
    std::memcpy(
        weights_blob.data(),
        header,
        sizeof(header));
    const std::vector<float> weights =
        morph_weight_values(geometry, mesh_record);
    if (target_count > 0) {
        std::memcpy(
            weights_blob.data() + 16,
            weights.data(),
            target_count * sizeof(float));
    }
    return weights_blob;
}
#endif

// The no-environment fallback face — the ported pinned contract both
// backends must agree on: a compiled-PBR scene with no environment binds a
// 1x1 cube of this colour, never zeros. (Dawn used to keep its
// zero-initialized startup cube here while SDL_GPU uploaded this face — a
// silent backend delta on any environment-less PBR scene.)
inline constexpr float environment_fallback_face[4] = {0.15f, 0.16f, 0.2f, 1.0f};

inline std::uint16_t float_to_half(float value) {
    std::uint32_t bits = 0;
    std::memcpy(&bits, &value, sizeof(bits));
    const std::uint16_t sign =
        static_cast<std::uint16_t>((bits >> 16) & 0x8000u);
    const std::uint32_t exponent = (bits >> 23) & 0xffu;
    const std::uint32_t mantissa = bits & 0x7fffffu;
    if (exponent == 0xffu) {
        return static_cast<std::uint16_t>(
            sign | (mantissa == 0 ? 0x7c00u : 0x7e00u));
    }
    const int half_exponent =
        static_cast<int>(exponent) - 127 + 15;
    if (half_exponent >= 0x1f) {
        return static_cast<std::uint16_t>(sign | 0x7c00u);
    }
    if (half_exponent <= 0) {
        if (half_exponent < -10) return sign;
        const std::uint32_t normalized = mantissa | 0x800000u;
        const int shift = 14 - half_exponent;
        const std::uint32_t rounded =
            (
                normalized +
                (1u << (shift - 1)) -
                1u +
                ((normalized >> shift) & 1u)) >>
            shift;
        return static_cast<std::uint16_t>(sign | rounded);
    }
    const std::uint32_t rounded =
        mantissa + 0xfffu + ((mantissa >> 13) & 1u);
    if ((rounded & 0x800000u) != 0) {
        const int next_exponent = half_exponent + 1;
        return static_cast<std::uint16_t>(
            next_exponent >= 0x1f
                ? sign | 0x7c00u
                : sign |
                    static_cast<std::uint16_t>(
                        next_exponent << 10));
    }
    return static_cast<std::uint16_t>(
        sign |
        static_cast<std::uint16_t>(half_exponent << 10) |
        static_cast<std::uint16_t>(rounded >> 13));
}

/** The fallback face in the decode's own storage type. */
inline std::vector<std::uint16_t> fallback_face_halves() {
    std::vector<std::uint16_t> face;
    face.reserve(4);
    for (const float channel : environment_fallback_face) {
        face.push_back(float_to_half(channel));
    }
    return face;
}

// The RGBD decode both render backends upload through.
inline std::vector<std::uint16_t> decode_rgbd(const TextureData& texture_data, int& width, int& height) {
    // src/loader-env/rgbd-decode.ts: the pin decodes into a
    // `texture_storage_2d<rgba16float, write>`, so a half is the decode's
    // result type, not a packing step a caller may skip. Returning halves
    // is what keeps every caller on the pin's precision -- the SDL_GPU
    // BRDF-LUT path used to upload these as RGBA32Float while the cube and
    // both Dawn paths packed to half, a silent backend delta.
    if (texture_data.bytes.empty()) {
        width = height = 1;
        return {0, 0, 0, float_to_half(1.0f)};
    }
    // The pin's `pow(c.rgb, vec3f(2.2))` reads a normalized byte, so it has
    // 256 possible arguments. Tabulating them is the same expression on the
    // same inputs -- bit-identical -- and takes the decode of an environment
    // off `std::pow` entirely.
    static const std::array<float, 256> gamma_expanded = [] {
        std::array<float, 256> table{};
        for (std::size_t byte = 0; byte < table.size(); ++byte) {
            table[byte] =
                std::pow(static_cast<float>(byte) / 255.0f, 2.2f);
        }
        return table;
    }();
    const std::uint16_t opaque = float_to_half(1.0f);
    const DecodedImage image = decode_image(ts::ArrayBuffer(texture_data.bytes));
    width = image.width;
    height = image.height;
    std::vector<std::uint16_t> result(static_cast<std::size_t>(width) * height * 4);
    for (std::size_t index = 0; index < image.rgba.size(); index += 4) {
        const float alpha = std::max(static_cast<float>(image.rgba[index + 3]) / 255.0f, 1.0f / 255.0f);
        for (std::size_t channel = 0; channel < 3; ++channel) {
            result[index + channel] = float_to_half(
                gamma_expanded[image.rgba[index + channel]] / alpha);
        }
        result[index + 3] = opaque;
    }
    return result;
}

/**
 * The warmup every renderer's benchmark discards before sampling: a
 * tenth of the requested frames, clamped to [10, 120]. One policy for
 * both GPU frame loops and their sprite variants, so the published
 * numbers of any two renderers cover the same measured span of a run.
 */
[[nodiscard]] inline long benchmark_warmup_frames(long benchmark_frames) {
    return benchmark_frames > 0
        ? std::min(120L, std::max(10L, benchmark_frames / 10))
        : 0;
}

// How a measured run is driven, parsed once for whichever backend runs it.
struct FrameOptions {
    std::string screenshot_path;
    std::string id_buffer_path;
    std::string cluster_buffer_path;
    std::string shader_directory;
    std::string copy_task_filter;
    std::string deformation_dump;
    // Where to write the frame's full CPU-side description
    // (pal_render_capture.hpp), for diffing against the browser's
    // instrumented capture.
    std::string render_capture_path;
    // Kept as written rather than pre-interpreted: the background and
    // ground flags accept "1"/"true" as well as "0"/"false", and the
    // methods below hold the differing defaults (a requested background
    // is off unless asked for, a requested ground is on unless refused).
    std::string background_flag;
    std::string ground_flag;
    bool gpu_debug = false;
    bool test_pass = false;
    bool single_sample = false;
    bool capture_ui = true;
    long screenshot_frame = 0;
    long max_frames = 0;
    long benchmark_frames = 0;
    double animation_seek_seconds = 0.0;
    float frame_delta_ms = 0.0f;

    /** Frames to run: a benchmark adds its warmup to the request. */
    [[nodiscard]] long frame_budget() const {
        return benchmark_frames > 0
            ? benchmark_frames + benchmark_warmup()
            : max_frames;
    }
    [[nodiscard]] bool benchmarking() const {
        return benchmark_frames > 0;
    }
    /**
     * Whether a benchmark was asked for at all. Present mode keys on the
     * request rather than the count, because the recorded frame-time
     * numbers depend on immediate present being selected before the
     * count is known to be positive.
     */
    bool benchmark_requested = false;
    [[nodiscard]] long benchmark_warmup() const {
        return benchmark_warmup_frames(benchmark_frames);
    }

    /**
     * Whether the run draws the environment background: only when asked
     * for, or when the scene enables it by default and the flag says
     * nothing. Both frame loops read the flags through these three
     * methods, so a run's flags cannot mean different draws per backend.
     */
    [[nodiscard]] bool background_enabled(
        const EnvironmentState& environment) const {
        return background_flag == "1" ||
            background_flag == "true" ||
            (background_flag.empty() &&
             environment.background_enabled_by_default);
    }
    /** The skybox draws with the background when the scene carries one. */
    [[nodiscard]] bool skybox_enabled(
        const EnvironmentState& environment) const {
        return background_enabled(environment) &&
            environment.has_skybox;
    }
    /** The scene's ground draws unless the flag refuses it. */
    [[nodiscard]] bool ground_enabled(
        const EnvironmentState& environment) const {
        return environment.has_ground &&
            ground_flag != "0" &&
            ground_flag != "false";
    }
};

inline long frame_option_number(const char* name) {
    const std::string value = environment_variable(name);
    return value.empty()
        ? 0L
        : std::strtol(value.c_str(), nullptr, 10);
}

inline FrameOptions read_frame_options() {
    FrameOptions options;
    options.screenshot_path = environment_variable("BBLITE_SCREENSHOT");
    options.id_buffer_path = environment_variable("BBLITE_ID_BUFFER");
    options.cluster_buffer_path =
        environment_variable("BBLITE_CLUSTER_BUFFER");
    options.shader_directory =
        environment_variable("BBLITE_GPU_SHADER_DIR");
    options.copy_task_filter = environment_variable("BBLITE_COPY_TASK");
    options.deformation_dump =
        environment_variable("BBLITE_DEFORMATION_DUMP");
    options.render_capture_path =
        environment_variable("BBLITE_RENDER_CAPTURE");
    options.gpu_debug = environment_variable("BBLITE_GPU_DEBUG") == "1";
    options.test_pass = environment_variable("BBLITE_TEST_PASS") == "1";
    options.single_sample = environment_variable("BBLITE_MSAA") == "1";
    options.capture_ui = environment_variable("BBLITE_CAPTURE_UI") != "0";
    options.background_flag = environment_variable("BBLITE_BACKGROUND");
    options.ground_flag = environment_variable("BBLITE_GROUND");
    options.screenshot_frame =
        frame_option_number("BBLITE_SCREENSHOT_FRAME");
    options.max_frames = frame_option_number("BBLITE_MAX_FRAMES");
    options.benchmark_frames =
        frame_option_number("BBLITE_BENCHMARK_FRAMES");
    options.benchmark_requested =
        !environment_variable("BBLITE_BENCHMARK_FRAMES").empty();
    const std::string seek =
        environment_variable("BBLITE_ANIMATION_SEEK_SECONDS");
    options.animation_seek_seconds =
        seek.empty() ? 0.0 : std::strtod(seek.c_str(), nullptr);
    const std::string frame_delta =
        environment_variable("BBLITE_FRAME_DELTA_MS");
    options.frame_delta_ms = frame_delta.empty()
        ? 0.0f
        : static_cast<float>(
              std::strtod(frame_delta.c_str(), nullptr));
    return options;
}

/**
 * A measured seek runs every registered animation seeker to the
 * requested time before the first frame; both frame loops apply the same
 * request so a seeked capture renders the same pose on either backend.
 */
inline void apply_animation_seek(
    const FrameOptions& options,
    const Scene& scene) {
    if (options.animation_seek_seconds == 0.0) return;
    const float time =
        static_cast<float>(options.animation_seek_seconds);
    for (const auto& seek : scene.animation_seekers) {
        seek(time);
    }
}

/**
 * The renderer that owns the frame's clear, re-derived per frame.
 *
 * Upstream `startEngine` walks `engine._renderingContexts` in registration
 * order and the first one clears. `disposeSpriteRenderer` unregisters, so
 * the owner is whoever is at the FRONT NOW rather than whoever was there
 * when the driver started -- a driver that read it once would keep clearing
 * with a disposed renderer's colour.
 *
 * With every renderer disposed there is no owner, and upstream simply draws
 * nothing while the canvas keeps its last pixels -- not an answer a
 * swapchain can give on its first frame. A default-constructed record
 * stands in, so the fallback is the pinned `createSpriteRenderer` default
 * (`clear` true, `clearValue ?? {0,0,0,1}`) read off the record's own
 * initializers rather than spelled again in each backend. No reached scene
 * disposes its last renderer.
 */
inline const SpriteRendererRecord& sprite_clear_owner(
    const Engine& engine) {
    static const SpriteRendererRecord none{};
    if (engine.registered_sprite_renderers.empty()) return none;
    return engine.sprite_renderers
        [engine.registered_sprite_renderers.front().value];
}

inline std::vector<std::size_t> sprite_layer_draw_order(
    const Engine& engine,
    const SpriteRendererRecord& renderer) {
    std::vector<std::size_t> draw_order(renderer.layers.size());
    for (std::size_t index = 0; index < draw_order.size(); ++index) {
        draw_order[index] = index;
    }
    std::stable_sort(
        draw_order.begin(),
        draw_order.end(),
        [&](std::size_t left, std::size_t right) {
            return engine.sprite_layers[renderer.layers[left].value].order <
                engine.sprite_layers[renderer.layers[right].value].order;
        });
    return draw_order;
}

/**
 * The program selection and pass rules for one billboard system, decided
 * once for both backends. The stems name the composed modules the shader
 * step deployed; the flags carry the pinned pairings — depth writes iff
 * cutout, the axis-locked vertex stage reading the system block for its
 * lock axis, and the mode-4 wrapper's second stock-Add pass. Backends
 * keep pipeline and bind mechanics only.
 */
struct BillboardDrawPlan {
    const char* vertex_stem;
    const char* fragment_stem;
    bool axis_locked;
    /** The pinned depth table pairs `transparent` with writes off, which
     *  is what makes the sorted draw order the composite, and `cutout`
     *  with writes on, which lets the GPU resolve overlap instead. */
    bool cutout_writes_depth;
    /** The axis-locked basis reads the system block in the vertex stage. */
    bool vertex_reads_system_block;
    std::uint32_t particle_passes;
};

inline BillboardDrawPlan billboard_draw_plan(
    const BillboardSystemRecord& system) {
    const bool axis_locked =
        system.orientation == BillboardOrientation::axis_locked;
    // The particle family's Multiply program is a module of the pin's own,
    // outside both sprite composers: it declares no fx block, and its
    // vertex stage travels with its fragment because the pin writes them
    // together.
    const bool particle_multiply = system.blend.particle_passes >= 1;
    // That pairing is exactly why it is exclusive: the program carries the
    // FACING basis and the pin's own body, so an axis-locked or custom
    // system reaching it would silently draw neither. The registrar
    // upstream only ever builds facing particle systems with no custom
    // shader, so this says so rather than picking a program that would be
    // wrong.
    if (particle_multiply && (axis_locked || system.custom_shader)) {
        throw std::runtime_error(
            "A node-particle Multiply blend draws the pin's own facing "
            "program; it has no axis-locked or custom-shader arm.");
    }
    const bool cutout =
        system.depth_mode == BillboardDepthMode::cutout;
    BillboardDrawPlan plan{};
    // Unlike the 2D layer, a custom billboard program brings its own
    // vertex stage: the pin's composer exposes the view distance and the
    // world position to a custom body, which the stock stage does not
    // write.
    plan.vertex_stem = particle_multiply
        ? "billboard_particle_multiply.vert"
        : system.custom_shader ? "billboard_custom.vert"
        : axis_locked          ? "billboard_axis_locked.vert"
                               : "billboard.vert";
    // The cutout arm discards below the cutoff; with alpha-to-coverage
    // the pin drops the discard and lets sample coverage carry the edge,
    // so that permutation shares the transparent stage.
    plan.fragment_stem = particle_multiply
        ? "billboard_particle_multiply.frag"
        : system.custom_shader ? "billboard_custom.frag"
        : cutout && !system.alpha_to_coverage ? "billboard_cutout.frag"
                                              : "billboard.frag";
    plan.axis_locked = axis_locked;
    plan.cutout_writes_depth = cutout;
    plan.vertex_reads_system_block = axis_locked;
    plan.particle_passes = system.blend.particle_passes;
    return plan;
}

/**
 * What a billboard pass last uploaded, so an unchanged frame re-uploads
 * nothing. The sorted order depends on both the view and the packed instance
 * rows. Dynamic systems may clear and refill the same count, so the record's
 * explicit version — not count — identifies the contents of the GPU buffer.
 */
struct BillboardUploadStamp {
    std::array<float, 16> view{};
    std::uint32_t count = 0;
    std::uint64_t instance_version = 0;
    bool uploaded = false;
#if BBLITE_FLOATING_ORIGIN
    /** The eye the anchors in the buffer were made relative to. */
    Vec3d fo_offset{};
#endif
};

/**
 * Whether the sorted instance buffer must be rebuilt and re-uploaded this
 * frame — the one gating rule, stated once for both backends. Only the
 * sort+upload is gated; the small per-frame UBO rebuilds beside it are
 * not. A cutout system is not sorted (it writes depth, so the GPU
 * resolves overlap and the pin uploads in logical insertion order), so
 * its buffer never depends on the view and uploads once per count.
 */
inline bool billboard_needs_upload(
    const BillboardSystemRecord& system,
    const BillboardUploadStamp& stamp,
    const std::array<float, 16>& view,
    [[maybe_unused]] Vec3d fo_offset) {
    if (system.count == 0) return false;
    if (
        !stamp.uploaded ||
        stamp.count != system.count ||
        stamp.instance_version != system.instance_version) {
        return true;
    }
#if BBLITE_FLOATING_ORIGIN
    // The anchors are uploaded eye-relative, so the offset is an input to
    // the bytes -- a cutout system, which otherwise uploads once per count
    // and never again, would hold the offset it first saw. The pin folds
    // the camera's own version into the same stamp for the same reason
    // (`lightFoVersion`, `wrapRenderableForFO`).
    if (
        stamp.fo_offset.x != fo_offset.x ||
        stamp.fo_offset.y != fo_offset.y ||
        stamp.fo_offset.z != fo_offset.z) {
        return true;
    }
#endif
    const bool cutout =
        system.depth_mode == BillboardDepthMode::cutout;
    return !(cutout || stamp.view == view);
}

inline void stamp_billboard_upload(
    BillboardUploadStamp& stamp,
    const BillboardSystemRecord& system,
    const std::array<float, 16>& view,
    [[maybe_unused]] Vec3d fo_offset) {
    stamp.view = view;
    stamp.count = system.count;
    stamp.instance_version = system.instance_version;
    stamp.uploaded = true;
#if BBLITE_FLOATING_ORIGIN
    stamp.fo_offset = fo_offset;
#endif
}

/**
 * The texture `setEffectTexture` stored for one declared binding name.
 *
 * The walk and the refusal are the pin's own `findTextureSlot` contract:
 * a binding the compiled fragment kept must have been set before the
 * first render, and a name the wrapper never stored fails by name rather
 * than binding a neighbour. Both backends resolve through this.
 */
inline const SolidTexture& effect_texture_for_binding(
    const EffectWrapperRecord& wrapper,
    std::string_view name) {
    for (const EffectTextureSlot& candidate : wrapper.textures) {
        if (candidate.name != name) continue;
        if (!candidate.set) break;
        return candidate.texture;
    }
    throw std::runtime_error(
        "Effect texture binding '" + std::string(name) +
        "' was not set before the first render.");
}

/**
 * The uniform floats a scene set must fill the block the descriptor
 * declared exactly: a short write leaves a stale or zero tail behind the
 * declared size, silently and differently per backend.
 */
inline void require_effect_uniform_size(
    const EffectWrapperRecord& wrapper,
    std::uint32_t uniform_bytes) {
    const std::size_t bytes =
        wrapper.uniform_values.size() * sizeof(float);
    if (bytes == uniform_bytes) return;
    throw std::runtime_error(
        "Effect uniforms carry " + std::to_string(bytes) +
        " bytes where the declared block takes " +
        std::to_string(uniform_bytes) + ".");
}

/**
 * The delta a scene's before-render callbacks advance by.
 *
 * A scene that sets `fixedDeltaMs` pins it, which is how the measured
 * animated scenes stay deterministic. Everything else advances by the
 * time the previous frame actually took, so an interactive run animates
 * at real speed. The first frame has no previous time and reports zero,
 * matching the pinned engine's first callback.
 *
 * Both backends drive callbacks from this: SDL_GPU measured the elapsed
 * time while Dawn passed a hardcoded 16 ms and never read the clock, so
 * a scene that integrated over the delta would have animated at a
 * different rate on each backend -- a divergence the differential would
 * have reported as a GPU-side difference.
 */
class FrameClock {
public:
    [[nodiscard]] float advance(float fixed_delta_ms) {
        const double now = monotonic_milliseconds();
        const bool first_frame = previous_ == 0.0;
        const float measured = previous_ > 0.0
            ? static_cast<float>(now - previous_)
            : 0.0f;
        previous_ = now;
        const float delta_ms =
            fixed_delta_ms > 0.0f && !first_frame
                ? fixed_delta_ms
                : measured;
        if (fixed_delta_ms > 0.0f) {
            advance_performance_milliseconds(delta_ms);
        }
        return delta_ms;
    }

private:
    double previous_ = 0.0;
};

/**
 * Decode a texture's bytes to RGBA, substituting a 1x1 fallback texel
 * when the scene carries none, and apply the pinned `invertY` flip. The
 * result is what both backends upload, so it is produced once.
 */
inline DecodedImage decode_uploadable_image(
    const TextureData& texture_data,
    const std::array<std::uint8_t, 4>& fallback) {
    DecodedImage image;
    if (texture_data.bytes.empty()) {
        image.width = image.height = 1;
        image.rgba.assign(fallback.begin(), fallback.end());
    } else if (texture_data.rgba_width && texture_data.rgba_height) {
        // Already texels: a `createTexture2DFromPixels` texture bound to a
        // material slot. Nothing to decode, and the size is the caller's.
        image.width = static_cast<int>(texture_data.rgba_width);
        image.height = static_cast<int>(texture_data.rgba_height);
        image.rgba = texture_data.bytes;
    } else {
        image = decode_image(ts::ArrayBuffer(texture_data.bytes));
    }
    if (texture_data.premultiply_alpha) {
        premultiply_image_alpha(image);
    }
    if (texture_data.invert_y && image.height > 1) {
        const std::size_t row_bytes =
            static_cast<std::size_t>(image.width) * 4;
        std::vector<std::uint8_t> row(row_bytes);
        for (int y = 0; y < image.height / 2; ++y) {
            std::uint8_t* top =
                image.rgba.data() +
                static_cast<std::size_t>(y) * row_bytes;
            std::uint8_t* bottom =
                image.rgba.data() +
                static_cast<std::size_t>(image.height - 1 - y) *
                    row_bytes;
            std::memcpy(row.data(), top, row_bytes);
            std::memcpy(top, bottom, row_bytes);
            std::memcpy(bottom, row.data(), row_bytes);
        }
    }
    return image;
}

/**
 * One compressed mip level's copy geometry, by the pin's own rules
 * (`ktx-loader.ts` uploadCompressed, `basis-loader.ts`).
 *
 * The copy extent is the block-padded size rather than the logical one:
 * a tail mip smaller than the block — 2x2 and 1x1 under a 4x4 block —
 * still occupies one whole block, and both WebGPU and D3D12 reject a
 * copy extent that is not a block multiple.
 */
struct CompressedMipCopy {
    std::uint32_t row_bytes;
    std::uint32_t block_rows;
    std::uint32_t width;
    std::uint32_t height;
};

inline CompressedMipCopy compressed_mip_copy(
    const CompressedTexture& texture,
    const CompressedMipLevel& mip) {
    const std::uint32_t blocks_per_row =
        (mip.width + texture.block_width - 1) / texture.block_width;
    const std::uint32_t block_rows =
        (mip.height + texture.block_height - 1) / texture.block_height;
    return CompressedMipCopy{
        blocks_per_row * texture.block_bytes,
        block_rows,
        blocks_per_row * texture.block_width,
        block_rows * texture.block_height,
    };
}

/**
 * The block-compressed formats this port uploads, as the pin's own WebGPU
 * format names resolve to.
 *
 * The generated table carries the pinned rows; this is the set both
 * backends can bind, so each translates one enumerator rather than
 * repeating the names. A name outside it is refused where the container is
 * parsed, which is the pin's own `if (!format) throw`.
 */
enum class CompressedBlockFormat {
    bc1_rgba_unorm,
    bc2_rgba_unorm,
    bc3_rgba_unorm,
    bc7_rgba_unorm,
    bc7_rgba_unorm_srgb,
};

inline CompressedBlockFormat compressed_block_format(std::string_view name) {
    if (name == "bc1-rgba-unorm") {
        return CompressedBlockFormat::bc1_rgba_unorm;
    }
    if (name == "bc2-rgba-unorm") {
        return CompressedBlockFormat::bc2_rgba_unorm;
    }
    if (name == "bc3-rgba-unorm") {
        return CompressedBlockFormat::bc3_rgba_unorm;
    }
    if (name == "bc7-rgba-unorm") {
        return CompressedBlockFormat::bc7_rgba_unorm;
    }
    if (name == "bc7-rgba-unorm-srgb") {
        return CompressedBlockFormat::bc7_rgba_unorm_srgb;
    }
    throw std::runtime_error(
        "No compressed texture format for '" + std::string(name) + "'.");
}

/**
 * Mip levels for a full chain over a base level:
 * 1 + floor(log2(max(width, height))), computed through double exactly as
 * both backends always have, so the same image sizes the same chain
 * everywhere. (The transmission grab's shortened chain is derived from
 * this by `transmission_grab_mip_count` below.)
 */
inline std::uint32_t full_mip_chain(
    std::uint32_t width,
    std::uint32_t height) {
    return 1u + static_cast<std::uint32_t>(
        std::floor(
            std::log2(
                static_cast<double>(std::max(width, height)))));
}

/**
 * The mip levels a sprite atlas's texture is uploaded with.
 *
 * The chain is the pinned loader's own `mipMaps` decision, carried on the
 * record: `loadSpriteAtlas` turns it off, and the atlas a node-particle
 * graph's texture block builds through `loadTexture2D` leaves it on. Both
 * backends ask this rather than each inferring the option back out of the
 * sampler.
 */
inline std::uint32_t atlas_mip_levels(const SpriteAtlasRecord& atlas) {
    return atlas.mip_maps ? full_mip_chain(atlas.width, atlas.height) : 1u;
}

// ---------------------------------------------------------------------------
// The pin's transmission scene-colour grab, stated once for both backends
// (frame-graph/transmission.ts): a fixed 1024x1024 rgba16float texture
// whatever the surface size, its full mip chain shortened by the fixed
// 4-mip LOD bias, sampled through getTrilinearAnisotropicSampler (repeat
// addressing, trilinear filtering, anisotropy 4). Pass mechanics — how the
// grab is blitted and when the chain regenerates — stay per backend.

/** The grab's fixed extent; both its width and its height. */
inline constexpr std::uint32_t transmission_grab_size = 1024;

/**
 * The shortened chain: the full chain over the fixed extent minus the
 * pin's 4-mip bias, never below one level. (Dawn used to hardcode 11-4
 * while SDL_GPU derived the same 7 from the extent — one derivation now.)
 */
inline std::uint32_t transmission_grab_mip_count() {
    const std::uint32_t full = full_mip_chain(
        transmission_grab_size,
        transmission_grab_size);
    return std::max(1u, full > 4u ? full - 4u : 1u);
}

/** getTrilinearAnisotropicSampler's anisotropy; the filters are trilinear
 *  and the addressing repeat, translated to each API where the sampler is
 *  created. */
inline constexpr std::uint32_t transmission_sampler_max_anisotropy = 4;

/**
 * Whether one draw's material is transmissive — the predicate behind the
 * pinned mid-pass break: `executePassWithTransmission` grabs the scene
 * colour before the FIRST draw this returns true for. The once-per-frame
 * latch and the pass surgery around it stay per backend.
 */
inline bool transmissive_draw_material(const MaterialRecord* material) {
    return material != nullptr &&
        (material->transmission_factor > 0.0f ||
         !material->transmission_texture.bytes.empty());
}


/**
 * The pixels a target scaled from another occupies, by the pin's own rule:
 * `max(1, floor(extent * ratio))`, evaluated against whatever the source
 * resolved to this build.
 */
inline std::uint32_t scaled_target_extent(
    std::uint32_t source,
    double ratio) {
    return static_cast<std::uint32_t>(std::max(
        1.0,
        std::floor(static_cast<double>(source) * ratio)));
}

inline TextureFormatClass geometry_format_class(
    const GeometryTextureDescription& description) {
    if (description.format == GeometryTextureFormat::r16_float) {
        return TextureFormatClass::r16_float;
    }
    switch (description.type) {
        case GeometryTextureType::reflectivity:
        case GeometryTextureType::albedo:
            return TextureFormatClass::rgba8_unorm;
        case GeometryTextureType::view_depth:
            return TextureFormatClass::r32_float;
        case GeometryTextureType::normalized_view_depth:
        case GeometryTextureType::screenspace_depth:
            return TextureFormatClass::r16_float;
        case GeometryTextureType::irradiance:
        case GeometryTextureType::world_position:
        case GeometryTextureType::local_position:
        case GeometryTextureType::view_normal:
        case GeometryTextureType::world_normal:
        case GeometryTextureType::linear_velocity:
            return TextureFormatClass::rgba16_float;
    }
    return TextureFormatClass::rgba16_float;
}

/**
 * All four channels of a geometry attachment clear to this value: the
 * pinned NORMALIZED_VIEW_DEPTH lane clears to one (its far plane), every
 * other lane to zero.
 */
inline float geometry_clear_component(GeometryTextureType type) {
    return type == GeometryTextureType::normalized_view_depth
        ? 1.0f
        : 0.0f;
}

/**
 * The two blend-factor tuples the corpus reaches, stated once. A
 * transparent draw blends colour src-alpha over one-minus-src-alpha and
 * accumulates alpha at one; the pinned background ground rides one over
 * one-minus-src-alpha on both lanes. The operation is always add. Every
 * blending pipeline in either backend translates one of these instances
 * to its API's enums; `BlendFactors` itself lives in the runtime records,
 * because generated code names it too.
 */
inline constexpr BlendFactors transparent_blend{
    BlendFactor::src_alpha,
    BlendFactor::one_minus_src_alpha,
    BlendFactor::one,
    BlendFactor::one_minus_src_alpha,
};

inline constexpr BlendFactors ground_blend{
    BlendFactor::one,
    BlendFactor::one_minus_src_alpha,
    BlendFactor::one,
    BlendFactor::one_minus_src_alpha,
};

/**
 * The one alpha-to-coverage rule: coverage needs samples to spread
 * across, and WebGPU rejects a 1-sample a2c pipeline outright where
 * D3D12 quantizes coverage to a ~0.5 cutoff instead. Every pipeline in
 * either backend that wants a2c enables it through this, so a
 * single-sample run draws the same pixels on both.
 */
inline bool alpha_to_coverage_enabled(
    bool wants_a2c,
    std::uint32_t samples) {
    return wants_a2c && samples > 1;
}

#if defined(BBLITE_HAS_PBR_RENDERER) && BBLITE_HAS_PBR_RENDERER
/**
 * The fixed-function facts one `RenderPipelineKind` carries, decoded once
 * for both backends: the material family, whether the draw blends, the
 * cull mode and the front face. The plan's own enums carry the answers,
 * so a backend keeps only its API-enum translation — the same split the
 * depth compare already uses. A new enumerator must be given an arm here
 * rather than inheriting one.
 */
struct RenderPipelineKindTraits {
    upstream::RenderMaterialKind family;
    bool transparent;
    upstream::RenderCullMode cull;
    bool clockwise_front_face;
    // The primitive the pipeline is built at. Only the glTF PBR kinds carry
    // anything but triangles, and each of those already fixes its cull mode
    // to none, exactly as `buildPrimitiveState` does -- so every other arm
    // takes this default rather than restating it.
    MeshTopology topology = MeshTopology::triangles;
};

/** Whether the kind asks for alpha-to-coverage (the `shader_a2c` arm). */
inline bool pipeline_kind_wants_a2c(upstream::RenderPipelineKind kind) {
    return kind == upstream::RenderPipelineKind::shader_a2c;
}

inline RenderPipelineKindTraits pipeline_kind_traits(
    upstream::RenderPipelineKind kind) {
    using Kind = upstream::RenderPipelineKind;
    using Family = upstream::RenderMaterialKind;
    using Cull = upstream::RenderCullMode;
    using Topology = MeshTopology;
    switch (kind) {
        case Kind::pbr_opaque_back:
            return {Family::pbr, false, Cull::back, false};
        case Kind::pbr_opaque_back_clockwise:
            return {Family::pbr, false, Cull::back, true};
        case Kind::pbr_opaque_none:
            return {Family::pbr, false, Cull::none, false};
        case Kind::pbr_opaque_none_clockwise:
            return {Family::pbr, false, Cull::none, true};
        case Kind::pbr_transparent_back:
            return {Family::pbr, true, Cull::back, false};
        case Kind::pbr_transparent_back_clockwise:
            return {Family::pbr, true, Cull::back, true};
        case Kind::pbr_transparent_none:
            return {Family::pbr, true, Cull::none, false};
        case Kind::pbr_transparent_none_clockwise:
            return {Family::pbr, true, Cull::none, true};
        // Points and lines cull nothing and have no winding, so each is one
        // arm per blend state.
        case Kind::pbr_opaque_points:
            return {Family::pbr, false, Cull::none, false, Topology::points};
        case Kind::pbr_opaque_lines:
            return {Family::pbr, false, Cull::none, false, Topology::lines};
        case Kind::pbr_opaque_line_strip:
            return {
                Family::pbr, false, Cull::none, false, Topology::line_strip};
        case Kind::pbr_transparent_points:
            return {Family::pbr, true, Cull::none, false, Topology::points};
        case Kind::pbr_transparent_lines:
            return {Family::pbr, true, Cull::none, false, Topology::lines};
        case Kind::pbr_transparent_line_strip:
            return {
                Family::pbr, true, Cull::none, false, Topology::line_strip};
        case Kind::standard_opaque_back:
            return {Family::standard, false, Cull::back, false};
        case Kind::standard_opaque_none:
            return {Family::standard, false, Cull::none, false};
        case Kind::standard_transparent_back:
            return {Family::standard, true, Cull::back, false};
        case Kind::standard_transparent_none:
            return {Family::standard, true, Cull::none, false};
        // The mirrored-mesh opt-in's own arms: same family, same blend and
        // cull, clockwise front face.
        case Kind::standard_opaque_back_clockwise:
            return {Family::standard, false, Cull::back, true};
        case Kind::standard_opaque_none_clockwise:
            return {Family::standard, false, Cull::none, true};
        case Kind::standard_transparent_back_clockwise:
            return {Family::standard, true, Cull::back, true};
        case Kind::standard_transparent_none_clockwise:
            return {Family::standard, true, Cull::none, true};
        case Kind::grid_opaque_back:
            return {Family::grid, false, Cull::back, false};
        case Kind::grid_opaque_none:
            return {Family::grid, false, Cull::none, false};
        case Kind::grid_transparent_back:
            return {Family::grid, true, Cull::back, false};
        case Kind::grid_transparent_none:
            return {Family::grid, true, Cull::none, false};
        // A shader kind's concrete fixed-function state comes from the
        // emitted variant table (cull, blend, depth write, topology); the
        // kind itself carries only the family and the a2c request.
        case Kind::shader:
        case Kind::shader_a2c:
            return {Family::shader, false, Cull::back, false};
        case Kind::node_opaque_back:
            return {Family::node, false, Cull::back, false};
        case Kind::node_opaque_none:
            return {Family::node, false, Cull::none, false};
        case Kind::node_transparent_back:
            return {Family::node, true, Cull::back, false};
        case Kind::node_transparent_none:
            return {Family::node, true, Cull::none, false};
    }
    throw std::runtime_error(
        "render pipeline kind " +
        std::to_string(static_cast<int>(kind)) +
        " is not implemented yet.");
}

/**
 * Every plan item's kind and variant, checked against the generated
 * tables before anything is uploaded or drawn from it. Both backends run
 * this at every plan (re)build, so a plan the build cannot draw fails at
 * rebuild time on both rather than at (or past) one backend's draw.
 */
inline void validate_render_plan_items(const upstream::RenderPlan& plan) {
    for (const upstream::RenderItem& item : plan.items) {
        if (item.material_kind == upstream::RenderMaterialKind::shader) {
            if (item.shader_variant >= upstream::shader_variant_count()) {
                throw std::runtime_error(
                    "this shader material variant is not implemented "
                    "yet.");
            }
        } else if (
            item.material_kind == upstream::RenderMaterialKind::node) {
#if BBLITE_NODE_VARIANTS > 0
            if (item.shader_variant >= upstream::node_variants.size()) {
                throw std::runtime_error(
                    "this node material graph was not composed.");
            }
#else
            throw std::runtime_error(
                "a node material in a build with no composed graphs.");
#endif
        } else if (
            item.material_kind !=
                upstream::RenderMaterialKind::standard &&
            item.material_kind != upstream::RenderMaterialKind::pbr &&
            item.material_kind != upstream::RenderMaterialKind::grid) {
            throw std::runtime_error(
                "only Standard, PBR, Grid, node and shader-variant "
                "materials are implemented yet.");
        }
    }
}

/**
 * Reconcile one backend's uploaded mesh rows with a rebuilt render plan.
 *
 * Plans preserve scene order, so a forward scan moves surviving rows,
 * releases removed rows, and uploads only new rows. The GPU resource type and
 * its release/upload operations remain backend-owned.
 */
template <typename GpuMesh, typename ReleaseMesh, typename UploadItem>
inline std::vector<GpuMesh> rematch_render_meshes(
    const std::vector<upstream::RenderItem>& previous_items,
    const std::vector<upstream::RenderItem>& updated_items,
    std::vector<GpuMesh>& uploaded_meshes,
    ReleaseMesh&& release_mesh,
    UploadItem&& upload_item) {
    if (previous_items.size() != uploaded_meshes.size()) {
        throw std::runtime_error(
            "Render plan and uploaded mesh rows are out of sync.");
    }
    const auto same_source = [](
                                 const upstream::RenderItem& left,
                                 const upstream::RenderItem& right) {
        return left.mesh.value == right.mesh.value &&
            left.geometry == right.geometry &&
            left.material.value == right.material.value;
    };
    std::vector<GpuMesh> result;
    result.reserve(updated_items.size());
    std::size_t previous_index = 0;
    for (const upstream::RenderItem& item : updated_items) {
        std::size_t scan = previous_index;
        while (
            scan < previous_items.size() &&
            !same_source(previous_items[scan], item)) {
            ++scan;
        }
        if (scan < previous_items.size()) {
            for (std::size_t dropped = previous_index;
                 dropped < scan;
                 ++dropped) {
                release_mesh(uploaded_meshes[dropped]);
            }
            result.push_back(std::move(uploaded_meshes[scan]));
            previous_index = scan + 1;
            continue;
        }
        result.push_back(upload_item(item));
    }
    for (std::size_t dropped = previous_index;
         dropped < uploaded_meshes.size();
         ++dropped) {
        release_mesh(uploaded_meshes[dropped]);
    }
    return result;
}

/**
 * A material family appearing after registration must have composed
 * artifacts to draw with: generation composes variants from the whole
 * scene, so a family the tables never saw is a compiler contract broken,
 * not a scene mistake. This is the table half of the guard, shared by
 * both backends; a backend whose modules are built eagerly at startup
 * (SDL_GPU) keeps its own built-pipeline residue beside it.
 */
inline void reject_uncomposed_family_growth(std::uint32_t added_families) {
#if BBLITE_STANDARD_VARIANTS > 0
    if (
        (added_families & material_family_standard) != 0 &&
        upstream::standard_variants.empty()) {
        throw std::runtime_error(
            "Post-registration Standard material family has no composed "
            "variants.");
    }
#else
    if ((added_families & material_family_standard) != 0) {
        throw std::runtime_error(
            "Post-registration Standard material family in a build with "
            "no composed variants.");
    }
#endif
    if (
        (added_families & material_family_shader) != 0 &&
        upstream::shader_variant_count() == 0) {
        throw std::runtime_error(
            "Post-registration shader material family has no composed "
            "variants.");
    }
}
#endif

/**
 * The format classes of a geometry-output task's colour targets, in the
 * task's own attachment order, plus whether a trailing target in the
 * frame's colour format follows. Both backends assemble their MRT
 * pipeline targets from this one list; only the API structs stay per
 * backend.
 */
struct GeometryTargetClasses {
    std::vector<TextureFormatClass> attachments;
    bool trailing_output = false;
};

inline GeometryTargetClasses geometry_target_classes(
    const FrameTaskRecord& task) {
    GeometryTargetClasses classes;
    classes.attachments.reserve(task.geometry.attachments.size());
    for (
        const GeometryTextureDescription& description :
        task.geometry.attachments) {
        classes.attachments.push_back(geometry_format_class(description));
    }
    classes.trailing_output =
        task.geometry.target.value != invalid_handle;
    return classes;
}

/**
 * The count assertion beside the list: a variant composed for N targets
 * over a task carrying M is the same generation bug on either backend,
 * so the refusal is stated once. `family` names the variant family the
 * caller resolves ("pinned" or "standard").
 */
inline void require_geometry_target_count(
    const GeometryTargetClasses& classes,
    std::size_t entry_color_target_count,
    const char* family) {
    const std::size_t total = classes.attachments.size() +
        (classes.trailing_output ? 1u : 0u);
    if (total == entry_color_target_count) return;
    throw std::runtime_error(
        std::string(family) + " geometry variant writes " +
        std::to_string(entry_color_target_count) +
        " targets where its task carries " + std::to_string(total) + ".");
}

/**
 * The skybox stage in sub-draw order: load-env.ts pushes the solid cube
 * before the DDS and .env arms, every background renderable carries
 * order 0, and the image-skybox cube draws after the environment arm.
 * Both backends walk this one array, so the stage cannot reorder on one
 * of them.
 */
enum class SkyboxLayer {
    solid,
    environment,
    image,
};

inline constexpr std::array<SkyboxLayer, 3> skybox_stage_order{
    SkyboxLayer::solid,
    SkyboxLayer::environment,
    SkyboxLayer::image,
};

/**
 * The pinned background skyboxes (DDS, HDR and solid) build their
 * pipeline through createDefaultPipelineDescriptor without a `_cullMode`,
 * so they take its "back" default; only the image skybox asks for "none"
 * explicitly. Drawing the cube unculled leaves both the entry and the
 * exit face rasterized once the camera is outside it, and depth writes
 * are off, so the later face in index order wins instead of the nearer
 * one.
 */
inline constexpr bool skybox_layer_culls_back(SkyboxLayer layer) {
    return layer != SkyboxLayer::image;
}

/**
 * Cluster ids advance in fixed 128-triangle groups, and the id and
 * cluster buffers are compared against the browser's, so both backends
 * have to number them identically.
 */
struct ClusterRange {
    std::uint32_t triangle_count;
    std::uint32_t id_start;
};

inline ClusterRange advance_cluster_range(
    std::uint32_t index_count,
    std::uint32_t& cluster_id_base) {
    const std::uint32_t triangle_count = index_count / 3;
    const std::uint32_t id_start = cluster_id_base;
    cluster_id_base += (triangle_count + 127u) / 128u;
    return ClusterRange{triangle_count, id_start};
}

#if defined(BBLITE_HAS_PBR_RENDERER) && BBLITE_HAS_PBR_RENDERER
/**
 * The alpha state the diagnostic shaders read: the bucket as a mode, the
 * cutoff, and the material alpha. A material-less item renders opaque at
 * full alpha.
 */
inline std::array<float, 4> diagnostic_alpha_options(
    const upstream::RenderItem& item,
    const MaterialRecord* material) {
    std::array<float, 4> options{};
    if (!material) {
        options[2] = 1.0f;
        return options;
    }
    options[0] =
        item.bucket == upstream::RenderBucket::alpha_blend
            ? 2.0f
            : item.bucket == upstream::RenderBucket::alpha_mask
                ? 1.0f
                : 0.0f;
    options[1] = material->alpha_cutoff;
    options[2] = material->alpha;
    return options;
}

/**
 * The id and cluster diagnostic uniform blocks. The draw-id RGB packing
 * (one little-endian byte per channel over 255) and the
 * {cluster base, 128 triangles per cluster} pair are diffed against the
 * browser's buffers, so both backends fill the blocks here.
 */
struct DiagnosticIdUniforms {
    float id_color[4];
    float alpha_options[4];
};

struct DiagnosticClusterUniforms {
    std::uint32_t cluster_options[4];
    float alpha_options[4];
};

inline DiagnosticIdUniforms diagnostic_id_uniforms(
    std::uint32_t draw_id,
    const std::array<float, 4>& alpha_options) {
    DiagnosticIdUniforms uniforms{};
    uniforms.id_color[0] =
        static_cast<float>(draw_id & 0xffu) / 255.0f;
    uniforms.id_color[1] =
        static_cast<float>((draw_id >> 8) & 0xffu) / 255.0f;
    uniforms.id_color[2] =
        static_cast<float>((draw_id >> 16) & 0xffu) / 255.0f;
    uniforms.id_color[3] = 1.0f;
    std::copy_n(alpha_options.begin(), 4, uniforms.alpha_options);
    return uniforms;
}

inline DiagnosticClusterUniforms diagnostic_cluster_uniforms(
    std::uint32_t cluster_base,
    const std::array<float, 4>& alpha_options) {
    DiagnosticClusterUniforms uniforms{};
    uniforms.cluster_options[0] = cluster_base;
    uniforms.cluster_options[1] = 128;
    std::copy_n(alpha_options.begin(), 4, uniforms.alpha_options);
    return uniforms;
}

/**
 * Whether a stage's whole block is the shared scene matrix, so a backend
 * may bind the frame's own buffer instead of the material's.
 *
 * Only `viewProjection` is constant across the pass. Shader-material
 * geometry stays in local space, so `world` and `worldViewProjection`
 * depend on the draw; the two individual factors are pass values but do not
 * have the same layout as the shared product buffer.
 */
inline bool block_is_shared_scene_matrix(
    const upstream::ShaderVariantStageBlock& block) {
    if (block.system_matrices.size() != 1 || !block.gather.empty()) {
        return false;
    }
    switch (block.system_matrices.front()) {
        case upstream::ShaderSystemMatrix::view_projection:
            return true;
        case upstream::ShaderSystemMatrix::world:
        case upstream::ShaderSystemMatrix::world_view:
        case upstream::ShaderSystemMatrix::world_view_projection:
        case upstream::ShaderSystemMatrix::view:
        case upstream::ShaderSystemMatrix::projection:
        case upstream::ShaderSystemMatrix::camera_position:
            return false;
    }
    return false;
}

/**
 * The matrices one pass renders with, carried together because a variant
 * may declare the product and either of its factors.
 *
 * They travel as one value so the three cannot come from two sources: a
 * pass that builds `view_projection` from a camera builds `view` and
 * `projection` from that same camera, which is what makes them the
 * factors of the product rather than a second answer to it. A shadow
 * caster pass is the one that cannot offer all three -- it renders
 * through the light's biased view-projection and the generator carries a
 * light-space view but no separate projection -- so it supplies what it
 * has and the packer names the factor it could not fill.
 *
 * Building them once per pass is also what keeps them off the per-draw
 * path: `view` costs the arc-rotate eye composition and `projection` a
 * tangent, and every draw in a pass would produce the same bytes.
 */
struct ShaderPassMatrices {
    const float* view_projection = nullptr;
    const std::array<float, 16>* view = nullptr;
    const std::array<float, 16>* projection = nullptr;
    const std::array<float, 16>* world = nullptr;
    const std::array<float, 16>* world_view = nullptr;
    const std::array<float, 16>* world_view_projection = nullptr;
    const std::array<float, 4>* camera_position = nullptr;
};

/** Camera position in the same absolute/eye-relative frame as shader world. */
inline std::array<float, 4> shader_camera_position(
    const Scene& scene,
    const Engine& engine,
    const CameraRecord& camera) {
    const Vec3d eye = upstream::arc_rotate_eye_position(camera);
#if BBLITE_FLOATING_ORIGIN
    const Vec3d origin = floating_origin_offset(scene, engine);
    return {
        static_cast<float>(eye.x - origin.x),
        static_cast<float>(eye.y - origin.y),
        static_cast<float>(eye.z - origin.z),
        0.0f};
#else
    (void)scene;
    (void)engine;
    return {
        static_cast<float>(eye.x),
        static_cast<float>(eye.y),
        static_cast<float>(eye.z),
        0.0f};
#endif
}

/**
 * One custom-shader stage block: declared system matrices followed by the
 * reflected gathers from the material's flat value storage. These exact
 * floats feed SDL pushes, Dawn buffer writes and render capture.
 */
inline std::vector<float> shader_stage_block_floats(
    const upstream::ShaderVariantStageBlock& block,
    const ShaderPassMatrices& pass,
    const MaterialRecord& material) {
    // Declared here rather than reusing `pinned_identity_world`, which
    // lives under BBLITE_PINNED_MATERIALS -- a shader-only scene compiles
    // this function without it.
    static constexpr std::array<float, 16> identity{
        1.0f, 0.0f, 0.0f, 0.0f,
        0.0f, 1.0f, 0.0f, 0.0f,
        0.0f, 0.0f, 1.0f, 0.0f,
        0.0f, 0.0f, 0.0f, 1.0f,
    };
    std::vector<float> floats(block.float_size, 0.0f);
    std::size_t head = 0;
    const auto copy_from =
        [&](const float* source, std::size_t count, const char* name) {
        if (!source) {
            throw std::runtime_error(
                std::string("A shader material declares the '") + name +
                "' system uniform in a pass that renders with no such "
                "matrix.");
        }
        std::copy_n(source, count, floats.begin() + head);
    };
    for (const upstream::ShaderSystemMatrix matrix : block.system_matrices) {
        // No default arm: a new enumerator has to be given a source here
        // rather than silently inheriting one.
        switch (matrix) {
            case upstream::ShaderSystemMatrix::world:
                copy_from(
                    pass.world ? pass.world->data() : identity.data(),
                    16,
                    "world");
                head += 16;
                break;
            case upstream::ShaderSystemMatrix::world_view:
                copy_from(
                    pass.world_view
                        ? pass.world_view->data()
                        : nullptr,
                    16,
                    "worldView");
                head += 16;
                break;
            case upstream::ShaderSystemMatrix::view:
                copy_from(
                    pass.view ? pass.view->data() : nullptr, 16, "view");
                head += 16;
                break;
            case upstream::ShaderSystemMatrix::projection:
                copy_from(
                    pass.projection ? pass.projection->data() : nullptr, 16,
                    "projection");
                head += 16;
                break;
            case upstream::ShaderSystemMatrix::view_projection:
                copy_from(pass.view_projection, 16, "viewProjection");
                head += 16;
                break;
            case upstream::ShaderSystemMatrix::world_view_projection:
                copy_from(
                    pass.world_view_projection
                        ? pass.world_view_projection->data()
                        : pass.view_projection,
                    16,
                    "worldViewProjection");
                head += 16;
                break;
            case upstream::ShaderSystemMatrix::camera_position:
                copy_from(
                    pass.camera_position
                        ? pass.camera_position->data()
                        : nullptr,
                    3,
                    "cameraPosition");
                // vec3 uniform members consume one 16-byte slot.
                head += 4;
                break;
        }
    }
    for (const std::array<std::uint32_t, 3>& gather : block.gather) {
        for (std::uint32_t index = 0; index < gather[2]; ++index) {
            floats[gather[0] + index] =
                material.shader_uniform_values[gather[1] + index];
        }
    }
    return floats;
}
#endif

/** Give every pre-render application RAF callback this turn's one timestamp. */
inline void run_animation_frame_callbacks(Engine& engine) {
    engine.animation_frame_timestamp_ms = performance_milliseconds();
    auto once_callbacks =
        std::move(engine.animation_frame_once_callbacks);
    engine.animation_frame_once_callbacks.clear();
    for (const auto& callback : engine.animation_frame_callbacks) {
        callback(engine.animation_frame_timestamp_ms);
    }
    for (const auto& callback : once_callbacks) {
        callback(engine.animation_frame_timestamp_ms);
    }
}

/**
 * Everything a frame does before anything is drawn, for every loop that
 * has a scene: resolve the delta, run application RAF callbacks registered
 * before `startEngine`, then run the scene's own callbacks.
 *
 * A stopped engine advances none of it -- the pin's `stopEngine` clears
 * `_renderFn`, so no further frame runs at all and the canvas keeps what
 * it last drew. Here the loop keeps presenting that unchanged frame while
 * `CaptureGate` still has something pending, so a screenshot lands on the
 * frozen frame exactly as the browser harness takes one off the frozen
 * canvas.
 *
 * Returns the frame's delta, because the frame body needs the same value
 * the before-render callbacks were given -- an animated billboard pass
 * advances by it. A stopped engine returns zero rather than the measured
 * wall-clock gap: the loop keeps presenting the frame it last drew, and a
 * frozen frame advances nothing.
 */
[[nodiscard]] inline float advance_frame(
    Engine& engine,
    Scene& scene,
    FrameClock& frame_clock,
    float frame_delta_ms) {
    if (engine.stopped) {
        return 0.0f;
    }
    const float delta_ms = frame_clock.advance(
        frame_delta_ms > 0.0f
            ? frame_delta_ms
            : scene.fixed_delta_ms);
    run_animation_frame_callbacks(engine);
    for (const auto& callback : scene.before_render) {
        callback(delta_ms);
    }
    return delta_ms;
}

/**
 * The same boundary for a loop with no scene. A `SpriteRenderer` or an
 * `EffectRenderer` is its own rendering context on the engine, but an
 * application can still own a requestAnimationFrame loop and queue a
 * timeout. Both run from the same frame clock as custom-shader time.
 */
[[nodiscard]] inline float advance_frame(
    Engine& engine,
    FrameClock& frame_clock,
    float frame_delta_ms) {
    if (engine.stopped) {
        return 0.0f;
    }
    const float delta_ms = frame_clock.advance(frame_delta_ms);
    run_animation_frame_callbacks(engine);
    return delta_ms;
}

/** The measured update boundary for a standalone FrameGraphContext. */
[[nodiscard]] inline float advance_frame(
    Engine& engine,
    FrameGraphContext& context,
    FrameClock& frame_clock,
    float frame_delta_ms) {
    if (engine.stopped) return 0.0f;
    const float delta_ms = frame_clock.advance(frame_delta_ms);
    run_animation_frame_callbacks(engine);
    for (const auto& callback : context.updates) {
        callback(delta_ms);
    }
    return delta_ms;
}

/**
 * Completes the browser frame turn after rendering has consumed its state.
 * RAF callbacks registered after the awaited `startEngine` follow the
 * engine-owned RAF callback, exactly as they do in the browser. A zero-delay
 * timeout queued anywhere in the turn is then drained at the turn boundary.
 */
inline void finish_frame(Engine& engine) {
    if (engine.stopped) return;
    if (engine.post_render_animation_frame_callbacks_armed) {
        for (const auto& callback :
             engine.post_render_animation_frame_callbacks) {
            callback(engine.animation_frame_timestamp_ms);
        }
    } else {
        // `startEngine` resolves after this initial render; source following
        // its await cannot have registered a callback for this RAF turn.
        engine.post_render_animation_frame_callbacks_armed = true;
    }
    run_deferred_callbacks(engine);
    run_timeout_callbacks(engine);
    run_interval_callbacks(engine);
}

/**
 * Which requested captures have landed, and whether the loop may stop.
 *
 * A measured run ends when the frame budget is spent, except that a
 * capture can still be outstanding: a topology update defers it by a
 * frame, and a null swapchain acquisition advances scene callbacks
 * without consuming one. Both backends therefore extend the loop by a
 * bounded grace period, and both used to carry their own copy of the
 * rule -- including the comment saying it matched the other one.
 */
class CaptureGate {
public:
    CaptureGate(
        const FrameOptions& options,
        long limit,
        const Engine* engine = nullptr)
        : options_(&options), limit_(limit), engine_(engine) {}

    bool screenshot_saved = false;
    bool id_buffer_saved = false;
    bool cluster_buffer_saved = false;
    bool render_capture_saved = false;

    /** Whether this run was asked for any capture at all. */
    [[nodiscard]] bool requested() const {
        return !options_->screenshot_path.empty() ||
            !options_->id_buffer_path.empty() ||
            !options_->cluster_buffer_path.empty() ||
            !options_->render_capture_path.empty();
    }

    [[nodiscard]] bool pending() const {
        return (!options_->screenshot_path.empty() &&
                !screenshot_saved) ||
            (!options_->id_buffer_path.empty() &&
             !id_buffer_saved) ||
            (!options_->cluster_buffer_path.empty() &&
             !cluster_buffer_saved) ||
            (!options_->render_capture_path.empty() &&
             !render_capture_saved);
    }

    /**
     * Whether the engine's own `stopEngine` has ended the run.
     *
     * The pin cancels its animation frame and clears `_renderFn`, so no
     * further frame submits and the canvas keeps what it last drew. Here
     * the loop keeps presenting that unchanged frame only while a capture
     * is still pending, so a screenshot lands on the frozen frame exactly
     * as the browser harness takes one off the frozen canvas -- and stops
     * the moment nothing is waiting for it.
     *
     * It lives here rather than at each call site for the reason this
     * class exists at all: there are six frame loops, and a rule spelled
     * six times is a rule that diverges. A loop with no engine to consult
     * (none today) is simply never stopped.
     */
    [[nodiscard]] bool engine_stopped() const {
        return engine_ != nullptr && engine_->stopped;
    }

    /**
     * Whether every bounded multi-frame drain the scene declared has
     * resolved. A scene that declares none is ready from frame zero.
     *
     * It lives here for the reason `engine_stopped` does: the condition
     * belongs to the run rather than to one renderer, and every loop that
     * hands this gate an engine gets the same answer.
     */
    [[nodiscard]] bool drains_resolved() const {
        if (engine_ == nullptr) return true;
        // `startEngine` resolves after its first render. The compiler queues
        // source following that await at the matching native frame boundary;
        // capturing while it is still pending would freeze the initial scene
        // instead of the state whose browser-ready marker follows it.
        if (engine_->pending_start_continuations != 0) return false;
        for (const std::function<bool()>& ready :
             engine_->capture_ready) {
            if (!ready || !ready()) return false;
        }
        return true;
    }

    /** Whether the loop should run another frame. */
    [[nodiscard]] bool keep_running(bool running, long frame) const {
        // A measured run ends the moment a stopped engine has nothing
        // left to capture. An INTERACTIVE one does not: the browser's
        // `stopEngine` freezes the canvas and leaves the page up, so the
        // window stays, input keeps working and the frozen scene can
        // still be orbited -- which is the manual check every integration
        // owes before it is called done.
        if (engine_stopped() && requested() && !pending()) {
            return false;
        }
        return running &&
            (limit_ <= 0 || frame < limit_ ||
             (pending() && frame < limit_ + grace_frames));
    }

    static constexpr long grace_frames = 8;

private:
    const FrameOptions* options_;
    long limit_;
    const Engine* engine_;
};

/**
 * The benchmark summary every renderer prints -- both GPU frame loops
 * and their sprite variants. The numbers are compared across backends,
 * so both the shape of the line and the statistics behind it are
 * produced in exactly one place. The contract:
 * one line opening with the "Babylon Lite <backend> benchmark |
 * driver=<driver>" identity prefix that names the renderer, then
 * `frames=` and the average / median / p95 / min / max frame CPU times
 * in milliseconds, fixed three-decimal precision. Samples are the
 * post-warmup frames (`benchmark_warmup_frames` above holds the shared
 * warmup policy); an empty run prints nothing.
 */
inline void report_benchmark(
    std::vector<double> samples,
    const char* backend,
    const std::string& driver) {
    if (samples.empty()) return;
    std::sort(samples.begin(), samples.end());
    double sum = 0.0;
    for (const double sample : samples) sum += sample;
    const std::size_t p95_index = std::min(
        samples.size() - 1,
        static_cast<std::size_t>(
            std::ceil(samples.size() * 0.95)) - 1);
    const std::ios_base::fmtflags flags = std::cout.flags();
    const std::streamsize precision = std::cout.precision();
    std::cout
        << std::fixed
        << std::setprecision(3)
        << "Babylon Lite " << backend << " benchmark | driver="
        << driver
        << " | frames=" << samples.size()
        << " | average=" << (sum / samples.size())
        << " ms | median=" << samples[samples.size() / 2]
        << " ms | p95=" << samples[p95_index]
        << " ms | min=" << samples.front()
        << " ms | max=" << samples.back()
        << " ms\n";
    std::cout.flags(flags);
    std::cout.precision(precision);
}

/**
 * Refuse a flag this backend does not implement rather than rendering
 * something else: a silent no-op would be measured as a backend delta.
 * `supported_backend` names the backend the refusal redirects to, so the
 * error text cannot claim SDL_GPU support from a backend that has none.
 */
inline void reject_unsupported_frame_options(
    const FrameOptions& options,
    const char* backend,
    bool supports_single_sample,
    bool supports_copy_task,
    const char* supported_backend = "SDL_GPU") {
    if (options.single_sample && !supports_single_sample) {
        throw std::runtime_error(
            std::string("BBLITE_MSAA is not supported by the ") +
            backend +
            " backend; run the single-sample diagnostic through " +
            supported_backend + ".");
    }
    if (!options.copy_task_filter.empty() && !supports_copy_task) {
        throw std::runtime_error(
            std::string("BBLITE_COPY_TASK is not supported by the ") +
            backend +
            " backend; the geometry copy-task diagnostic runs through " +
            supported_backend + ".");
    }
}

// The readback inverse of float_to_half above, shared by both backends'
// screenshot and diagnostic-buffer paths: a half-float channel decoded
// and quantized to the byte a PNG stores.
inline std::uint8_t half_to_byte(std::uint16_t value) {
    const bool negative = (value & 0x8000u) != 0;
    const std::uint16_t exponent = (value >> 10) & 0x1fu;
    const std::uint16_t mantissa = value & 0x03ffu;
    float decoded = 0.0f;
    if (exponent == 0) {
        decoded = std::ldexp(static_cast<float>(mantissa), -24);
    } else if (exponent == 31) {
        decoded = mantissa == 0
            ? std::numeric_limits<float>::infinity()
            : std::numeric_limits<float>::quiet_NaN();
    } else {
        decoded = std::ldexp(
            1.0f + static_cast<float>(mantissa) / 1024.0f,
            static_cast<int>(exponent) - 15);
    }
    if (negative) decoded = -decoded;
    return static_cast<std::uint8_t>(
        std::lround(std::clamp(decoded, 0.0f, 1.0f) * 255.0f));
}

// ---------------------------------------------------------------------------
// Readback row conversion, shared by both backends' screenshot and
// diagnostic-buffer paths. The copy/map mechanics stay per backend; what a
// row of readback bytes MEANS as PNG pixels is decided once: rgba16float
// decodes through the manual half conversion (clamped to bytes), r16float
// lands in the red channel, 8-bit rows copy through with an optional
// BGRA swap. Rows arrive 256-byte aligned, the way both APIs return them.

enum class ReadbackFormatClass {
    rgba16_float,
    r16_float,
    rgba8,
    bgra8,
};

inline std::vector<std::uint8_t> convert_readback_rows(
    const std::uint8_t* mapped,
    std::uint32_t width,
    std::uint32_t height,
    std::uint32_t aligned_row_bytes,
    ReadbackFormatClass format) {
    const std::uint32_t output_row_bytes = width * 4;
    std::vector<std::uint8_t> rgba(
        static_cast<std::size_t>(output_row_bytes) * height);
    for (std::uint32_t y = 0; y < height; ++y) {
        const std::uint8_t* source_row =
            mapped + static_cast<std::size_t>(y) * aligned_row_bytes;
        std::uint8_t* destination_row =
            rgba.data() + static_cast<std::size_t>(y) * output_row_bytes;
        if (format == ReadbackFormatClass::rgba16_float) {
            const auto* source_pixels =
                reinterpret_cast<const std::uint16_t*>(source_row);
            for (std::uint32_t x = 0; x < width; ++x) {
                for (std::uint32_t channel = 0; channel < 4; ++channel) {
                    destination_row[x * 4 + channel] =
                        half_to_byte(source_pixels[x * 4 + channel]);
                }
            }
        } else if (format == ReadbackFormatClass::r16_float) {
            const auto* source_pixels =
                reinterpret_cast<const std::uint16_t*>(source_row);
            for (std::uint32_t x = 0; x < width; ++x) {
                destination_row[x * 4] = half_to_byte(source_pixels[x]);
                destination_row[x * 4 + 1] = 0;
                destination_row[x * 4 + 2] = 0;
                destination_row[x * 4 + 3] = 255;
            }
        } else {
            std::memcpy(destination_row, source_row, output_row_bytes);
            if (format == ReadbackFormatClass::bgra8) {
                for (std::uint32_t x = 0; x < width; ++x) {
                    std::swap(
                        destination_row[x * 4],
                        destination_row[x * 4 + 2]);
                }
            }
        }
    }
    return rgba;
}

/**
 * The HDR diagnostic sidecar: the unpadded rgba16float rows, written to a
 * stream the caller opened (opening — and cleaning up its own GPU
 * resources when the open fails — stays per backend).
 */
inline void write_readback_raw_rows(
    std::ostream& raw,
    const std::uint8_t* mapped,
    std::uint32_t height,
    std::uint32_t aligned_row_bytes,
    std::uint32_t source_row_bytes) {
    for (std::uint32_t y = 0; y < height; ++y) {
        raw.write(
            reinterpret_cast<const char*>(
                mapped + static_cast<std::size_t>(y) * aligned_row_bytes),
            source_row_bytes);
    }
}

} // namespace bbl::pal
