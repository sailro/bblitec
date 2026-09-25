// The Dawn scene renderer's state and the declarations its sources share:
// the scene driver (pal_dawn.cpp) and one file per feature family, each
// paired with its SDL_GPU twin (pal_sdl_gpu_scene_<family>.cpp), compiled as
// one translation unit (pal_dawn_scene_all.cpp). Dawn renders generated WGSL
// directly through the Tint-pinned WebGPU runtime.
#pragma once

#include <bblite/features/device_recovery.hpp>
#include <bblite/features/gpu_task_timing.hpp>
#include <bblite/features/has_billboards.hpp>
#include <bblite/features/has_clustered_lights.hpp>
#include <bblite/features/has_detailed_picking.hpp>
#include <bblite/features/has_effect_task.hpp>
#include <bblite/features/has_geometry_output.hpp>
#include <bblite/features/has_material_plugin_textures.hpp>
#include <bblite/features/has_pbr_renderer.hpp>
#include <bblite/features/has_picking.hpp>
#include <bblite/features/has_post_process.hpp>
#include <bblite/features/has_screen_space.hpp>
#include <bblite/features/has_splats.hpp>
#include <bblite/features/has_sprite_renderer.hpp>
#include <bblite/features/has_text.hpp>
#include <bblite/features/has_ui.hpp>
#include <bblite/features/offscreen_surfaces.hpp>
#include <bblite/features/workers.hpp>

#include <bblite/pal.hpp>
#include <bblite/pal_gpu.hpp>
#include <bblite/pal_image.hpp>
#include <bblite/runtime.hpp>
#if BBLITE_HAS_UI && !BBLITE_WORKERS
#include <bblite/pal_ui.hpp>
#endif

// The scene renderer needs a scene: its camera math and render plan are
// generated only for a scene that registers one. A sprite-only scene
// registers a SpriteRenderer instead and draws through
// `pal_dawn_sprite.cpp`, so this translation unit compiles to nothing.
#if BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER

#include <bblite/upstream/camera_math.hpp>
// The pin's own inverse image processing, for the linear-frame clear color.
#include <bblite/upstream/pinned_inverse_image_processing.hpp>
#if BBLITE_HAS_GEOMETRY_OUTPUT
#include <bblite/upstream/frame_graph_geometry.hpp>
#endif
#if BBLITE_HAS_POST_PROCESS
#include <bblite/upstream/frame_graph_post_process.hpp>
#include <bblite/upstream/post_process_shaders.hpp>
#endif
#include <bblite/upstream/render_capabilities.hpp>
#include <bblite/upstream/renderer_plan.hpp>
#if BBLITE_HAS_CLUSTERED_LIGHTS
#include <bblite/upstream/clustered_light.hpp>
#include "pal_dawn_clustered.hpp"
#endif

#include "pal_camera_controls.hpp"
#include "pal_dawn_shared.hpp"
#if BBLITE_GPU_TASK_TIMING
#include <bblite/pal_gpu_task_timing.hpp>
#endif
#include "pal_dawn_compute_texture.hpp"
#if BBLITE_OFFSCREEN_SURFACES
#include "pal_dawn_offscreen.hpp"
#endif
#if BBLITE_HAS_UI && !BBLITE_WORKERS
#include "pal_dawn_sprite_ui.hpp"
#endif
#if BBLITE_HAS_BILLBOARDS
#include "pal_dawn_billboard.hpp"
#endif
#if BBLITE_HAS_SPRITE_RENDERER
#include "pal_dawn_sprite.hpp"
#endif
#if BBLITE_HAS_SPLATS
#include "pal_dawn_splat.hpp"
#endif
#if BBLITE_HAS_PICKING
#include "pal_dawn_picking.hpp"
#endif
#if BBLITE_HAS_EFFECT_TASK
#include "pal_dawn_effect.hpp"
#endif
#include "pal_gpu_shared.hpp"
#include "pal_dawn_post_process.hpp"
#include "pal_pass_camera.hpp"
#include "pal_scene_synchronize.hpp"
#include "pal_texture_upload_cache.hpp"
#include "pal_frame_session.hpp"
#if BBLITE_HAS_TEXT
#include "pal_dawn_text.hpp"
#endif
#if BBLITE_HAS_TAA
#include "pal_temporal_shared.hpp"
#endif
#include "pal_owned_gpu_record.hpp"
#include "pal_render_capture.hpp"
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
#include "pal_node_capture_state.hpp"
#endif

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <limits>
#include <map>
#include <memory>
#include <stdexcept>
#include <tuple>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace bbl::pal {

inline namespace dawn_scene {

/** A mesh's groups for the ID-diagnostic program; group 3 is the pass's own. */
struct DawnMeshBindings {
    DawnBindGroup scene{};
    DawnBindGroup textures{};
#if BBLITE_GPU_MORPH_STORAGE
    DawnBindGroup morph{};
#endif
};

/** Bind groups whose shapes come from one generated ShaderMaterial variant. */
struct DawnShaderBindings {
    DawnBindGroup storage{};
    DawnBindGroup scene{};
    DawnBindGroup resources{};
    DawnBindGroup material{};
};

struct DawnShaderBindingKey {
    std::uint32_t variant = 0;
    std::uint32_t material = invalid_handle;
    WGPUBuffer pass_uniforms = nullptr;

    bool operator<(const DawnShaderBindingKey& other) const {
        if (variant != other.variant)
            return variant < other.variant;
        if (material != other.material)
            return material < other.material;
        return std::less<WGPUBuffer>{}(pass_uniforms, other.pass_uniforms);
    }
};

void release_dawn_shader_bindings(DawnShaderBindings& bindings);

/** The shared cull enum in this API's; the pipeline-kind facts come from
 *  `pipeline_kind_traits` (pal_gpu_shared.hpp). */
inline WGPUCullMode dawn_cull_mode(upstream::RenderCullMode cull) {
    return cull == upstream::RenderCullMode::none ? WGPUCullMode_None : WGPUCullMode_Back;
}

/**
 * The pin's `executePassBody` and geometry `executeTask` opening
 * (`_applyCameraViewport`), mirrored from the SDL backend: a camera
 * carrying a viewport narrows the pass to it, and one without leaves the
 * pass at the whole target the way `if (!v) return` leaves it.
 *
 * Set AFTER the pass begins, exactly where upstream sets it, so the load
 * operation has already cleared or loaded the whole attachment.
 */
void set_pass_viewport(WGPURenderPassEncoder pass, const std::optional<PixelViewport>& resolved);

/** A scene's own pass: its camera's viewport composed into its surface pane. */
inline void set_pass_camera_viewport(WGPURenderPassEncoder pass, const Scene& scene,
                                     const Engine& engine, const CameraRecord* camera,
                                     std::uint32_t target_width, std::uint32_t target_height) {
    set_pass_viewport(pass,
                      scene_camera_viewport(engine, scene, camera, target_width, target_height));
}

/** A render or geometry task's pass, over its own target's extent. */
void set_task_camera_viewport(WGPURenderPassEncoder pass, const CameraRecord* camera,
                              std::uint32_t target_width, std::uint32_t target_height);

// Vertex uniform bindings in group 1 mirror the SDL vertex uniform
// slots: 0 = viewProjection, 1 = deformation, then the mesh world.
#if BBLITE_GPU_DEFORMATION
constexpr std::uint32_t mesh_world_uniform_binding = 2;
#else
constexpr std::uint32_t mesh_world_uniform_binding = 1;
#endif

// The mesh-owned slot order, the per-slot sRGB rules and fallback texels,
// and the pinned binding names all live in the generated
// `material_texture_slots` table (material_texture_slots.hpp) both
// backends execute; the constants below only size this backend's arrays,
// and the static_assert under them keeps the two in step.
constexpr std::size_t transmission_texture_slots =
    (BBLITE_MATERIAL_TRANSMISSION_MAP ? 1 : 0) + (BBLITE_MATERIAL_THICKNESS_MAP ? 1 : 0);
constexpr std::size_t material_extension_slots =
    (BBLITE_MATERIAL_CLEARCOAT ? 3 : 0) + (BBLITE_MATERIAL_SHEEN ? 2 : 0) +
    (BBLITE_MATERIAL_IRIDESCENCE ? 2 : 0) + (BBLITE_MATERIAL_METALLIC_REFLECTANCE_MAP ? 1 : 0) +
    (BBLITE_MATERIAL_REFLECTANCE_MAP ? 1 : 0) + (BBLITE_MATERIAL_ANISOTROPY_MAP ? 1 : 0) +
    (BBLITE_MATERIAL_TRANSLUCENCY_COLOR_MAP ? 1 : 0) +
    (BBLITE_MATERIAL_TRANSLUCENCY_INTENSITY_MAP ? 1 : 0) + (BBLITE_MATERIAL_SPEC_GLOSS ? 1 : 0) +
    (BBLITE_MATERIAL_OCCLUSION_UV2 ? 1 : 0) + (BBLITE_MATERIAL_LIGHTMAP ? 1 : 0);
// The Standard bump slot appends after everything the PBR path owns, so a
// scene that compiles it shifts no existing slot.
constexpr std::size_t standard_bump_slots = BBLITE_MATERIAL_STANDARD_BUMP ? 1 : 0;
// The Standard 2D reflection slot appends after bump the same way (the
// generated slot table's own order); only the composed variant bind path
// consults it, through its generated slot index.
constexpr std::size_t standard_reflection_slots = BBLITE_MATERIAL_STANDARD_REFLECTION ? 1 : 0;
constexpr std::size_t mesh_texture_slots = 5 + transmission_texture_slots +
                                           material_extension_slots + standard_bump_slots +
                                           standard_reflection_slots;
static_assert(mesh_texture_slots == upstream::material_texture_mesh_slots,
              "This backend's slot constants must match the generated material "
              "texture-slot table.");

/**
 * One draw's own group-1 blocks and bind group.
 *
 * Every family's per-draw state is this shape, so all of it is created,
 * held and released alike. A main-pass map is keyed by MATERIAL and a
 * geometry-arm map by variant; `group_key` records what the held group was
 * built for, so a draw arriving with another answer rebuilds.
 */
struct DawnState;

struct DawnDrawResources {
    WGPUBuffer mesh_uniforms = nullptr;
    WGPUBuffer material_uniforms = nullptr;
    WGPUBuffer uv_uniforms = nullptr;
    // stdUvTransformExt's own block, beside the base `up` one: the pin binds
    // both on a marked material and the extension's assignment is what the
    // varying ends up carrying. Unguarded, and null for a scene that reached
    // no marked material -- the same shape the geometry task's `gp` buffer
    // takes, where the reflected binding name decides whether it is bound.
    WGPUBuffer uv_transform_uniforms = nullptr;
    WGPUBindGroup group = nullptr;
    /** The variant, times two plus the Standard unfilterable-emissive bit. */
    std::size_t group_key = npos;
    std::vector<std::uint32_t> plugin_texture_allocations;
    std::optional<std::tuple<std::uint64_t, std::uint64_t, std::size_t, std::uint32_t>>
        material_upload;
};

using DawnDrawState = OwnedGpuRecord<DawnDrawResources, DawnState>;

struct DawnSharedShaderGeometry;
struct DawnSharedMaterialTextures;
using DawnSharedShaderMaterialTextures = DawnSharedMaterialTextures;
struct DawnSharedComposedMaterialTextures;
#if BBLITE_HAS_MATERIAL_PLUGIN_TEXTURES
using DawnSharedPluginMaterialTextures = DawnSharedMaterialTextures;
#endif

struct DawnMeshResources {
    WGPUBuffer vertices = nullptr;
    WGPUBuffer indices = nullptr;
    // Shader-material entries borrow exact local-space geometry from the
    // state cache; every other family owns its buffers.
    bool owns_geometry_buffers = true;
    DawnSharedShaderGeometry* shared_geometry = nullptr;
    std::uint32_t index_count = 0;
    WGPUBuffer material_uniforms = nullptr;
    std::uint64_t material_uniform_size = 0;
#if BBLITE_PBR_VARIANTS > 0
    // The pin's own per-draw blocks and group-1 bind group, keyed by
    // MATERIAL for the reason `standard_states` is: a render task drawing
    // this mesh through a material of its own arrives as the same
    // `DawnMesh`, and one buffer set per mesh would let the last queue
    // write poison the other pass. The material buffer is sized by the
    // draw's variant, which is what makes it carry only the fields that
    // variant's own extensions contribute.
    std::map<std::uint32_t, DawnDrawState> pinned_states;
    // `create-skeleton.ts`: rgba32float, four texels per bone, one mat4 column
    // each. The pin reads the palette with textureLoad rather than from a UBO,
    // so a skinned variant needs the texture and not the DeformationUniforms
    // array the transcribed stage takes.
#if BBLITE_VAT
    // The baked vertex-animation texture and the 32-byte settings block
    // beside it. The bake is settled before the first frame so the texture
    // uploads once; the settings ride the record's own version, because
    // `update` writes them every frame the scene advances the clock.
    WGPUTexture pinned_vat_texture = nullptr;
    WGPUTextureView pinned_vat_view = nullptr;
    std::uint32_t pinned_vat_bones = 0;
    std::uint32_t pinned_vat_frames = 0;
    WGPUBuffer pinned_vat_settings = nullptr;
    std::uint64_t pinned_vat_settings_version = 0;
#if BBLITE_VAT_INSTANCES
    WGPUTexture pinned_vat_instance_texture = nullptr;
    WGPUTextureView pinned_vat_instance_view = nullptr;
    std::uint32_t pinned_vat_instance_texels = 0;
    std::uint64_t pinned_vat_instance_version = 0;
#endif
#endif
#endif

#if BBLITE_PBR_VARIANTS > 0 || BBLITE_STANDARD_SKELETON
    WGPUTexture pinned_bone_texture = nullptr;
    WGPUTextureView pinned_bone_view = nullptr;
    std::uint32_t pinned_bone_count = 0;
    std::uint64_t pinned_bone_version = unsynced_bone_palette;
#endif

#if BBLITE_STANDARD_VARIANTS > 0
    // The Standard family's per-draw blocks and group-1 bind group.
    //
    // Keyed by MATERIAL, not by this mesh alone: a render task may draw the
    // mesh through a material of its own (`addMesh(mesh, { material })`),
    // and the pin's plan gives that draw the mesh's own item index, so both
    // draws arrive here as the same `DawnMesh`. One buffer set per mesh
    // would let whichever block is written last poison the other pass --
    // every queue write lands before the frame submits. The SDL backend is
    // immune because it pushes the material block per draw.
    std::map<std::uint32_t, DawnDrawState> standard_states;
    // The geometry arms keyed by variant beside it: a LOCAL_POSITION
    // variant's mesh block carries the node world where the colour pass's
    // carries the identity, so each owns its mesh block. Its material and
    // uv blocks stay the colour state's -- a geometry task carries no
    // material override, `build_render_task_draw_lists` ignoring
    // `render_meshes` for one.
    std::map<std::size_t, DawnDrawState> standard_geometry_states;
#endif
#if BBLITE_NODE_VARIANTS > 0
    // A node graph's per-draw blocks: the pin's own mesh block, and the
    // graph's uniform block when it declares one. The uniform block is
    // written once -- it is the graph's own constants -- and the mesh block
    // follows the mesh's transform. Keyed by material beside the two
    // sibling families, for the same override reason.
    std::map<std::uint32_t, DawnDrawState> node_states;
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
    // The geometry arms keyed by composed view beside it, the same way the
    // two material families' are: a geometry view walked the graph again
    // and owns its own uniform block, so it cannot share the colour state's
    // buffers or its bind group.
    std::map<std::size_t, DawnDrawState> node_geometry_states;
#endif
#endif
    std::array<WGPUTexture, mesh_texture_slots> owned_textures{};
    std::array<WGPUTextureView, mesh_texture_slots> owned_views{};
    std::array<WGPUTextureView, mesh_texture_slots> views{};
    std::array<WGPUSampler, mesh_texture_slots> samplers{};
    // A shader material's own sampler slots, in the order its `samplers`
    // option declared them. They take the leading pairs of the superset
    // texture group for a shader-kind draw, because the caller's WGSL
    // declares its textures from binding 0 up.
    std::vector<DawnSampledTexture> shader_textures;
    DawnSharedShaderMaterialTextures* shared_shader_textures = nullptr;
    DawnSharedComposedMaterialTextures* shared_composed_textures = nullptr;
#if BBLITE_HAS_MATERIAL_PLUGIN_TEXTURES
    // The textures this mesh's material plugins bound, in the order the
    // pin's own `bindPluginTextures` pushes them -- which is the order the
    // composed fragment declared their `getSamplers` pairs. Shared per
    // material, because the textures are the material's.
    DawnSharedPluginMaterialTextures* shared_plugin_textures = nullptr;
#endif
    // Standard-material `.babylon` reflection cube view, non-owning
    // (points into DawnState::reflection_cube_views).
    WGPUTextureView reflection = nullptr;
    // Alpha-card shader vertex uniforms (center/angle/depth).
    WGPUBuffer shader_vertex_uniforms = nullptr;
    std::uint64_t position_version = 0;
#if BBLITE_GPU_DEFORMATION
    WGPUBuffer deformation_uniforms = nullptr;
#endif
    // The shared material stage's `mesh` block: the world its
    // diagnostic and depth-only draws read.
    WGPUBuffer mesh_world_uniform = nullptr;
#if BBLITE_GPU_INSTANCING
    WGPUBuffer instances = nullptr;
#if BBLITE_HAS_PICKING
    WGPUBindGroup thin_pick_group = nullptr;
    WGPUBuffer thin_pick_uniform_buffer = nullptr;
    WGPUBuffer thin_pick_instances = nullptr;
    std::uint64_t thin_pick_bound_size = 0;

    void release_thin_pick_group() {
        if (thin_pick_group)
            wgpuBindGroupRelease(thin_pick_group);
        thin_pick_group = nullptr;
        thin_pick_uniform_buffer = nullptr;
        thin_pick_instances = nullptr;
        thin_pick_bound_size = 0;
    }
#endif
    std::uint32_t instance_count = 1;
    std::uint64_t instance_version = 0;
    // How many instance rows the buffers were allocated for. A live pool
    // can double past it (`addThinInstance`), and the matrices and the
    // colour lane are both sized from this one count, so
    // `thin_instance_pool_grew` recreates them together.
    std::uint32_t instance_capacity = 0;
#endif
#if BBLITE_GPU_INSTANCE_COLORS
    WGPUBuffer instance_colors = nullptr;
#endif
#if BBLITE_PBR_VARIANTS > 0
    // The geometry-output MRT arms' per-variant draw state: a mesh drawn in
    // the main pass and in two geometry tasks holds three live bind groups
    // at encode time, so these are keyed by variant beside `pinned_states`.
    std::map<std::size_t, DawnDrawState> pinned_geometry_states;
#endif
#if BBLITE_GPU_MORPH_STORAGE
    // Owned when the mesh has storage morphs; otherwise these alias
    // the shared empty fallbacks.
    WGPUBuffer morph_deltas = nullptr;
    WGPUBuffer morph_weights = nullptr;
    bool owns_morph_buffers = false;
    std::uint64_t morph_weights_version = 0;
#endif
    DawnMeshBindings diagnostic_bindings;
    // A render task may replace a mesh's material with another shader
    // variant (shadow caster views do exactly that), so the reflected
    // groups are keyed by both the active variant and active material.
    std::map<DawnShaderBindingKey, DawnShaderBindings> shader_bindings;
};

using DawnMesh = OwnedGpuRecord<DawnMeshResources, DawnState>;

/** One exact local-space shader geometry retained across topology rebuilds. */
struct DawnSharedShaderGeometry {
    SharedGeometryIdentity identity;
    // Kept only below `shared_geometry_bytes_kept_below` vertices.
    std::vector<GpuVertex> vertices;
    std::vector<std::uint32_t> indices;
    DawnBuffer vertex_buffer{};
    DawnBuffer index_buffer{};
    std::size_t users = 0;
};

/** Texture/sampler triples shared by every mesh using one material. */
struct DawnSharedMaterialTextures {
    MaterialHandle material{};
    std::vector<DawnSampledTexture> textures;
    std::vector<std::shared_ptr<DawnTexture>> image_leases;
    std::size_t users = 0;
    void clear() noexcept {
        textures.clear();
        image_leases.clear();
    }
};

/** Generated PBR/Standard texture slots uploaded once per material. */
struct DawnSharedComposedMaterialTextures {
    MaterialHandle material{};
    bool standard_material = false;
    std::array<DawnTexture, mesh_texture_slots> textures{};
    std::array<DawnTextureView, mesh_texture_slots> views{};
    std::array<DawnSampler, mesh_texture_slots> samplers{};
    std::size_t users = 0;
};

void release_dawn_composed_material_textures(DawnSharedComposedMaterialTextures& textures);

[[nodiscard]] inline const std::vector<DawnSampledTexture>&
mesh_shader_textures(const DawnMesh& mesh) {
    return mesh.shared_shader_textures ? mesh.shared_shader_textures->textures
                                       : mesh.shader_textures;
}

struct DawnTaskTarget {
    WGPUTextureFormat color;
    WGPUTextureFormat depth;
};
using DawnVariantPipelineKey = std::tuple<std::size_t, WGPUTextureFormat, WGPUTextureFormat>;
using DawnMeshPipelineKey = std::tuple<upstream::RenderPipelineKind, std::uint32_t, std::uint32_t,
                                       WGPUTextureFormat, WGPUTextureFormat, bool>;

struct DawnPipeline {
    WGPURenderPipeline pipeline = nullptr;
};

// Frame-graph render target: the task-sample-count attachment plus a
// single-sample sampled alias (the same texture when not
// multisampled), mirroring the SDL backend's GpuRenderTarget.
struct DawnRenderTarget {
    DawnTexture color;
    DawnTextureView color_view;
    DawnTexture sampled_color;
    DawnTextureView sampled_color_view;
    DawnTexture depth;
    // A layered depth attachment (the cascaded shadow map) is written one
    // layer per pass, so each pass needs its own single-layer view; the
    // receiver reads the whole array through `depth_sampled_view`, which is
    // then a `2d-array` view rather than a `2d` one.
    std::vector<DawnTextureView> depth_layer_views;
    // Sampled-depth targets copy the depth aspect into an r32float
    // color texture after their task so material slots can filter it
    // like the SDL backend's direct depth SRV reads.
    DawnTextureView depth_sampled_view;
    DawnTexture depth_copy;
    DawnTextureView depth_copy_view;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    /** What its colour attachment resolved to, for a target that follows it. */
    WGPUTextureFormat color_format = WGPUTextureFormat_Undefined;
    WGPUTextureFormat depth_format = WGPUTextureFormat_Undefined;
    /**
     * Which build of the frame graph created these textures, numbered per
     * target: the identity a screen-space effect compares its bound
     * textures by (`ScreenSpaceFrameInputs`). Zero until first created.
     */
    std::uint32_t allocation = 0;
};

/**
 * A depth-only task's group 1 for one mesh: the task's view-projection beside
 * the mesh's own stage blocks (`serve_mesh_stage_binding`), and the world
 * buffer it was built over -- a mesh uploaded again carries new blocks.
 */
struct DawnDepthOnlyGroup {
    WGPUBuffer mesh_world = nullptr;
    DawnBindGroup group{};
#if BBLITE_GPU_MORPH_STORAGE
    DawnBindGroup morph{};
#endif
};

struct DawnRenderTask {
    upstream::RenderDrawLists draw_lists;
    DawnBuffer view_projection{};
    // Depth-only passes bind group 1 per mesh, keyed by the mesh's slot.
    std::unordered_map<std::uint32_t, DawnDepthOnlyGroup> depth_only_groups;
    // A task the scene gave its own camera composes its own view-projection
    // and eye position, so it needs its own copy of the pin's per-pass scene
    // block; the lights beside it are the scene's and stay shared. Null for
    // a task that draws through the scene camera, which binds the frame's.
    DawnBuffer pinned_scene_uniforms{};
    DawnBindGroup pinned_frame_group{};
};

struct DawnGeometryTask {
    std::vector<DawnTexture> colors;
    std::vector<DawnTextureView> color_views;
    std::vector<DawnTexture> sampled_colors;
    std::vector<DawnTextureView> sampled_views;
    DawnTexture depth;
    DawnTextureView depth_view;
    // The pin's gpUniforms for the task's MRT arms: previous-frame
    // view-projection and the camera near/far.
    DawnBuffer pinned_geometry_params;
    std::array<float, 16> previous_view_projection{};
    bool has_previous_view_projection = false;
    /** The task's Standard renderables' previous worlds. */
    PinnedVelocityHistory velocity;
    /** Set with the textures: another task binds this task's depth. */
    bool depth_borrowed = false;
};

#if BBLITE_HAS_POST_PROCESS
/**
 * One post-process pass's GPU state.
 *
 * The pin builds all of this in `createPostProcessGpuState` and keeps it on
 * the task; here it lives beside the frame task it belongs to, created the
 * first time the pass records and rebuilt whenever the frame graph's textures
 * are.
 */
/**
 * The module, layout and pipeline a post-process pass draws with, shared by
 * every pass that draws the same way.
 *
 * A composite chains passes that differ only in which textures they bind and
 * what their uniform block holds -- depth of field's six blurs are one
 * deployed module and one pipeline state -- so building per pass would parse
 * the same WGSL and compile the same pipeline once each. The key is
 * everything the layout and the pipeline are made of.
 */

struct DawnPostProcessTask {
    /**
     * Its program's index in `DawnState::post_process_programs`, resolved
     * once and kept across frames.
     *
     * An index rather than a pointer because that vector grows: a pass
     * whose program is created first has its entry reallocated out from
     * under it the moment a later pass in the same task creates a second
     * one, and the next frame then binds through a dangling pointer. Bloom
     * is where that first became reachable -- four passes over three
     * distinct programs.
     */
    std::size_t program = npos;
    DawnBindGroup group{};
    DawnBuffer uniforms{};
#if BBLITE_HAS_TAA
    bool temporal_recorded = false;
#endif
};

struct PreparedDawnPostProcessPass {
    WGPUTextureView output = nullptr;
    WGPURenderPipeline pipeline = nullptr;
    WGPUBindGroup group = nullptr;
    bool presents = false, clear = false;
    std::optional<PixelViewport> viewport{};
};
#endif

#if BBLITE_HAS_SCREEN_SPACE
/**
 * A screen-space producer or temporal resolve: the pin's own dedicated
 * pipeline (`ensureProducerPipeline`, `ensurePipeline`) over the layout the
 * generated table declares, shared by every task drawing the same stage.
 */
struct DawnScreenSpaceProgram {
    std::uint32_t stage = 0;
    DawnShaderModule module{};
    DawnBindGroupLayout group_layout{};
    DawnPipelineLayout pipeline_layout{};
    DawnRenderPipeline pipeline{};
};

/**
 * One stage of one task: its program, its uniform buffer and the bind group
 * over the frame-graph textures it reads. The pin rebuilds that group when
 * any bound `GPUTexture` identity changed; here a texture changes identity
 * only through the frame-graph rebuild that resets this stage, so an empty
 * group is the whole test.
 */
struct DawnScreenSpaceStage {
    std::size_t program = npos;
    DawnBuffer uniforms{};
    DawnBindGroup group{};
};

struct DawnScreenSpaceTask {
    DawnScreenSpaceStage producer;
    DawnScreenSpaceStage resolve;
};
#endif

#if BBLITE_PBR_VARIANTS > 0 || BBLITE_STANDARD_VARIANTS > 0 || BBLITE_NODE_VARIANTS > 0
/**
 * One composed family's pipelines and modules, pipelines first. The PBR,
 * Standard and node families keep the same containers, so the order lives
 * once; their layouts live in the shared `DawnLayoutCache`.
 */
void release_variant_family(
    std::map<std::uint32_t, std::map<DawnVariantPipelineKey, WGPURenderPipeline>>& pipelines,
    std::vector<WGPUShaderModule>& fragment_modules, std::vector<WGPUShaderModule>& vertex_modules);
#endif

/**
 * Which layout a family built: the family, the variant row it reflects, and
 * the flags that split one row into several layouts -- the Standard
 * depth-emissive arm, a node draw slot, or the group index of a family laid
 * out over several groups.
 */
enum class DawnLayoutFamily : std::uint8_t {
    frame,
    diagnostic,
    shader,
    pbr,
    standard,
    node,
    pbr_shadow,
    standard_shadow,
    background,
};

struct DawnLayoutKey {
    DawnLayoutFamily family = DawnLayoutFamily::frame;
    std::size_t variant = 0;
    std::size_t flags = 0;
    friend auto operator<=>(const DawnLayoutKey&, const DawnLayoutKey&) = default;
};

/**
 * Every bind-group and pipeline layout the material families build, created
 * on first use under one key and released together. Pipeline layouts are
 * declared after the group layouts they name, so they are destroyed first.
 */
class DawnLayoutCache {
public:
    /** The group layout for `key`, created from `entries()` on first use. */
    template <typename Entries>
    WGPUBindGroupLayout group(WGPUDevice device, const DawnLayoutKey& key, Entries&& entries,
                              const char* label = nullptr) {
        if (const auto found = groups_.find(key); found != groups_.end())
            return found->second;
        const std::vector<WGPUBindGroupLayoutEntry> built = entries();
        WGPUBindGroupLayoutDescriptor descriptor = WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
        if (label)
            descriptor.label = string_view(label);
        descriptor.entryCount = built.size();
        descriptor.entries = built.data();
        DawnBindGroupLayout layout{wgpuDeviceCreateBindGroupLayout(device, &descriptor)};
        if (!layout)
            dawn_error(failure("bind group layout", key));
        return groups_.emplace(key, std::move(layout)).first->second;
    }

    /** The pipeline layout for `key` over the group layouts `groups()` names. */
    template <typename Groups>
    WGPUPipelineLayout pipeline(WGPUDevice device, const DawnLayoutKey& key, Groups&& groups) {
        if (const auto found = pipelines_.find(key); found != pipelines_.end())
            return found->second;
        const std::vector<WGPUBindGroupLayout> built = groups();
        WGPUPipelineLayoutDescriptor descriptor = WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
        descriptor.bindGroupLayoutCount = built.size();
        descriptor.bindGroupLayouts = built.data();
        DawnPipelineLayout layout{wgpuDeviceCreatePipelineLayout(device, &descriptor)};
        if (!layout)
            dawn_error(failure("pipeline layout", key));
        return pipelines_.emplace(key, std::move(layout)).first->second;
    }

private:
    static std::string failure(const char* what, const DawnLayoutKey& key) {
        return std::string(what) + " creation failed (family " +
               std::to_string(static_cast<int>(key.family)) + ", variant " +
               std::to_string(key.variant) + ", flags " + std::to_string(key.flags) + ").";
    }

    std::map<DawnLayoutKey, DawnBindGroupLayout> groups_;
    std::map<DawnLayoutKey, DawnPipelineLayout> pipelines_;
};

#if BBLITE_PINNED_BACKGROUNDS
/**
 * One of the pin's background arms on Dawn: a pipeline over the pin's two
 * modules, laid out as the factory laid it out (the frame group, then the
 * arm's own group 1 from its recorded entries), the buffers the lowered
 * builders filled, and the group-1 bind group over its mesh block and
 * texture.
 */
struct DawnBackgroundArm {
    const upstream::PinnedBackgroundArm* arm = nullptr;
    DawnRenderPipeline pipeline;
    std::vector<DawnBuffer> vertex_buffers;
    DawnBuffer indices;
    std::uint32_t index_count = 0;
    DawnBuffer mesh_uniforms;
    DawnTexture texture;
    DawnTextureView texture_view;
    DawnBindGroup group;
};
#endif

struct DawnState : DawnDevice {
    std::uint64_t material_upload_frame = 0;
    // Declared first so it is destroyed last: every pipeline and bind group
    // built over these layouts is released before them.
    DawnLayoutCache layouts;
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
    NodeCaptureState node_capture;
#endif
#if BBLITE_HAS_TEXT
    std::unique_ptr<DawnTextRenderer> text;
#endif
#if BBLITE_HAS_CLUSTERED_LIGHTS
    /** The clustered light field's params buffer and three data textures. */
    DawnClusteredLights clustered;
#endif
    // Transmission scenes render the frame in linear rgba16float and
    // apply image processing at the end; everything else targets the
    // surface format directly.
    WGPUTextureFormat frame_color_format = WGPUTextureFormat_BGRA8Unorm;
    /**
     * Samples every frame attachment and every pipeline agrees on: 4
     * normally, 1 under `BBLITE_MSAA=1`. The single-sample run is a
     * diagnostic -- it isolates whether a difference comes from
     * multisampling -- so it has to reach every pipeline, or the device
     * rejects the pass for an attachment/pipeline sample mismatch.
     *
     * At one sample there is nothing to resolve: the pass renders
     * straight to its target, and the two fullscreen passes that read
     * the frame back (the transmission grab and the pinned per-sample
     * image processing) bind an ordinary texture instead of a
     * multisampled one.
     */
    std::uint32_t sample_count = 4;
#if BBLITE_HAS_UI && !BBLITE_WORKERS
    SpriteUiDawnResources ui;
#endif
#if BBLITE_HAS_BILLBOARDS
    std::vector<DawnBillboardPass> billboard_passes;
#endif
#if BBLITE_HAS_SPRITE_RENDERER
    std::vector<DawnSpritePass> sprite_passes;
    std::vector<WGPUTexture> sprite_render_textures;
    std::vector<WGPUTextureView> sprite_render_texture_views;
    DawnSceneSpritePass scene_sprite_pass;
    bool has_scene_sprite_pass = false;
#endif
#if BBLITE_HAS_SPLATS
    std::vector<DawnSplatPass> splat_passes;
#endif
#if BBLITE_HAS_PICKING
    // A scene that picks without loading a cloud reaches every one of
    // these and none of the cloud set below, so the two guards are
    // siblings rather than nested.
    DawnPickTargets pick_targets;
    WGPURenderPipeline pick_mesh_pipeline = nullptr;
#if BBLITE_GPU_INSTANCING
    WGPURenderPipeline pick_thin_pipeline = nullptr;
    WGPUBindGroupLayout pick_thin_layout = nullptr;
#endif
#if BBLITE_HAS_DETAILED_PICKING
    /** The pin's second picking module: three targets, and a fragment
     *  that reads `@builtin(primitive_index)`. */
    WGPURenderPipeline pick_detailed_pipeline = nullptr;
#endif
#if BBLITE_DEFORM_PICKING
    /** The same module with the pin's deform vertex projection spliced
     *  into `vs`, and the two groups that projection declares. */
    struct PickDeformProgram {
        std::array<WGPURenderPipeline, 2> pipelines{};
        WGPUBindGroupLayout layout = nullptr;
    };
    std::array<PickDeformProgram, upstream::pick_deform_variants.size()> pick_deform_programs{};
    WGPUBindGroupLayout pick_deform_empty_layout = nullptr;
    WGPUBindGroup pick_deform_empty_group = nullptr;
#endif
    WGPUBindGroupLayout pick_scene_layout = nullptr;
    WGPUBindGroupLayout pick_mesh_layout = nullptr;
    WGPUBuffer pick_scene_buffer = nullptr;
    WGPUBindGroup pick_scene_group = nullptr;
    /** One slice per candidate, bound at a dynamic offset. */
    WGPUBuffer pick_mesh_buffer = nullptr;
    WGPUBindGroup pick_mesh_group = nullptr;
    std::size_t pick_mesh_capacity = 0;
#if BBLITE_HAS_SPLATS
    WGPURenderPipeline pick_cloud_pipeline = nullptr;
    WGPUBindGroupLayout pick_cloud_color_layout = nullptr;
    WGPUBuffer pick_cloud_shear = nullptr;
    WGPUBindGroup pick_cloud_shear_group = nullptr;
    WGPUBuffer pick_cloud_color = nullptr;
    WGPUBindGroup pick_cloud_color_group = nullptr;
#endif
#endif

    [[nodiscard]] bool multisampled() const { return sample_count > 1; }
    WGPUTexture msaa_color = nullptr;
    WGPUTextureView msaa_color_view = nullptr;
    WGPUSampler transmission_sampler = nullptr;
    WGPUTexture transmission_color = nullptr;
    WGPUTextureView transmission_color_view = nullptr;
    std::uint32_t transmission_mip_count = 1;
    WGPUShaderModule transmission_grab_module = nullptr;
    // The single-sample grab arm's bilinear sampler; the multisampled arm
    // loads its texels and binds none.
    WGPUSampler transmission_grab_sampler = nullptr;
    WGPURenderPipeline transmission_grab_pipeline = nullptr;
    WGPUShaderModule image_processing_module = nullptr;
    WGPURenderPipeline image_processing_pipeline = nullptr;
    WGPUBuffer image_processing_params = nullptr;
    WGPUBindGroup image_processing_group = nullptr;
    WGPUTexture depth = nullptr;
    WGPUTextureView depth_view = nullptr;
    WGPUShaderModule vertex_module = nullptr;
    WGPUShaderModule pbr_module = nullptr;
    // Lazily loaded per generated shader variant, indexed by variant id.
    std::vector<WGPUShaderModule> shader_vertex_modules;
    std::vector<WGPUShaderModule> shader_fragment_modules;
    using ShaderStorageBuffer = VersionedGpuBuffer<WGPUBuffer>;
    std::vector<ShaderStorageBuffer> shader_storage_buffers;
    WGPUBuffer view_projection = nullptr;
    WGPUTexture white_texture = nullptr;
    WGPUTextureView white_view = nullptr;
    WGPUTexture black_texture = nullptr;
    WGPUTextureView black_view = nullptr;
    WGPUTexture black_cube = nullptr;
    WGPUTextureView black_cube_view = nullptr;
    WGPUTexture normal_flat_texture = nullptr;
    WGPUTextureView normal_flat_view = nullptr;
    std::vector<WGPUTexture> reflection_cubes;
    std::vector<WGPUTextureView> reflection_cube_views;
    WGPUTexture environment_cube = nullptr;
#if BBLITE_LOCAL_CUBEMAP
    struct LocalCubemap {
        std::shared_ptr<const LocalCubemapRecord> source;
        WGPUTexture texture = nullptr;
        WGPUTextureView array_view = nullptr;
        WGPUTextureView cube_view = nullptr;
        WGPUBuffer uniform = nullptr;
        WGPUBuffer grid = nullptr;
        ~LocalCubemap() {
            if (array_view)
                wgpuTextureViewRelease(array_view);
            if (cube_view)
                wgpuTextureViewRelease(cube_view);
            if (texture)
                wgpuTextureRelease(texture);
            if (uniform)
                wgpuBufferRelease(uniform);
            if (grid)
                wgpuBufferRelease(grid);
        }
    };
    std::unordered_map<const LocalCubemapRecord*, std::unique_ptr<LocalCubemap>> local_cubemaps;
#endif
    WGPUTextureView environment_cube_view = nullptr;
    WGPUTexture brdf_texture = nullptr;
    WGPUTextureView brdf_view = nullptr;
    WGPUSampler default_sampler = nullptr;
    WGPUSampler clamp_sampler = nullptr;
    WGPUSampler ground_sampler = nullptr;
    WGPUSampler nearest_sampler = nullptr;
#if BBLITE_HAS_EFFECT_TASK
    // One built pass per effect render task, keyed by task index and built
    // lazily against the target's own format and sample count -- the pin
    // keys its own pipeline cache by exactly that pair.
    std::vector<DawnEffectPass> effect_tasks;
#endif
    // Frame graph state.
    std::vector<DawnRenderTarget> render_targets;
    /** The last `DawnRenderTarget::allocation` handed out. */
    std::uint32_t render_target_allocations = 0;
#if BBLITE_DEVICE_RECOVERY
    /**
     * The textures whose identities the device-recovery observers last
     * received, so a new identity is published only when the texture
     * behind it changed; the handles stay this backend's.
     */
    WGPUTexture published_environment_cube = nullptr;
    WGPUTexture published_white_texture = nullptr;
#endif
    std::vector<DawnRenderTask> render_tasks;
    std::vector<DawnGeometryTask> geometry_tasks;
#if BBLITE_HAS_POST_PROCESS
    // Per frame task, one entry per pass it records.
    std::vector<std::vector<DawnPostProcessTask>> post_process_tasks;
    /** The distinct programs those passes draw with. */
    std::vector<DawnPostProcessProgram> post_process_programs;
#if BBLITE_HAS_TAA
    WGPUTexture temporal_presented = nullptr;
    WGPUTextureView temporal_presented_view = nullptr;
    WGPUBindGroup temporal_presented_group = nullptr;
#endif
#endif
#if BBLITE_HAS_SCREEN_SPACE
    /** The distinct producer/resolve stages the screen-space tasks draw. */
    std::vector<DawnScreenSpaceProgram> screen_space_programs;
    // Per frame task, a screen-space task's two stages.
    std::vector<DawnScreenSpaceTask> screen_space_tasks;
#endif
#if BBLITE_HAS_POST_PROCESS
    // The pin's own `getBilinearSampler`: linear magnification and
    // minification over WebGPU's defaults, which is clamp addressing and a
    // nearest mip filter. `nearest_sampler` is already its `getNearestSampler`
    // sibling, so the pass's two sampling modes are both the pin's.
    WGPUSampler post_process_bilinear_sampler = nullptr;
#endif
    WGPUShaderModule depth_only_module = nullptr;
    WGPUShaderModule blit_vertex_module = nullptr;
    WGPUShaderModule blit_fragment_module = nullptr;
    WGPUShaderModule depth_copy_module = nullptr;
    WGPURenderPipeline depth_copy_pipeline = nullptr;
    // Depth-only pipelines by [sided][samples==4].
    std::map<std::tuple<bool, std::uint32_t, WGPUTextureFormat>, WGPURenderPipeline>
        depth_only_pipelines;
    // Blit pipelines keyed by target (format, samples).
    std::map<std::pair<WGPUTextureFormat, std::uint32_t>, WGPURenderPipeline> blit_pipelines;
    std::uint32_t frame_graph_width = 0;
    std::uint64_t render_targets_version = 0;
    std::uint32_t frame_graph_height = 0;

#if BBLITE_PINNED_MATERIALS
#if BBLITE_SHADOW_RECEIVERS
    /**
     * The receiver side of the shadow family.
     *
     * The pinned generator owns a `depth32float` map and one comparison
     * sampler per generator, and `rebuildSingle` builds ONE group-2 bind
     * group for every receiving mesh in a build — keyed by the layout
     * alone, because every receiver in a scene shares the same generators.
     * That is what these hold: the sampler the pin creates
     * (`compare: "less"`, linear min/mag), the receiver UBO per generator,
     * and the shared group.
     */
    WGPUSampler shadow_comparison_sampler = nullptr;
    WGPUSampler shadow_filtering_sampler = nullptr;
    std::vector<WGPUBuffer> shadow_uniforms;
#if BBLITE_SHADOWS_ESM
    /**
     * `sg._shadowParamsUBO`, one per generator: the bias and depth scale the
     * ESM caster's own material view reads while writing its exponential
     * depth. Written once, because neither value has a setter.
     */
    std::vector<WGPUBuffer> shadow_params;
#endif
    /** Per receiving variant, keyed like its layout: two variants can
     *  declare different rows. */
    std::map<DawnLayoutKey, DawnBindGroup> shadow_groups;
#if BBLITE_SHADOWS_ESM
    /**
     * One ESM generator's separable blur, built from what its own factory
     * recorded. The pin blurs the ESM map horizontally into `blur_h` and
     * then vertically into `blur_v`, and `blur_v` IS `sg._depthTexture` --
     * the texture the receiver samples.
     */
    struct EsmBlur {
        WGPUTextureView source = nullptr;
        WGPUTexture blur_h = nullptr;
        WGPUTextureView blur_h_view = nullptr;
        WGPUTexture blur_v = nullptr;
        WGPUTextureView blur_v_view = nullptr;
        WGPURenderPipeline pipeline = nullptr;
        WGPUBindGroupLayout layout = nullptr;
        WGPUBuffer horizontal_uniforms = nullptr;
        WGPUBuffer vertical_uniforms = nullptr;
        WGPUBindGroup horizontal = nullptr;
        WGPUBindGroup vertical = nullptr;
        void clear() {

            if (horizontal)
                wgpuBindGroupRelease(horizontal);
            if (vertical)
                wgpuBindGroupRelease(vertical);
            if (pipeline)
                wgpuRenderPipelineRelease(pipeline);
            if (layout)
                wgpuBindGroupLayoutRelease(layout);
            if (horizontal_uniforms) {
                wgpuBufferRelease(horizontal_uniforms);
            }
            if (vertical_uniforms) {
                wgpuBufferRelease(vertical_uniforms);
            }
            if (blur_h_view)
                wgpuTextureViewRelease(blur_h_view);
            if (blur_h)
                wgpuTextureRelease(blur_h);
            if (blur_v_view)
                wgpuTextureViewRelease(blur_v_view);
            if (blur_v)
                wgpuTextureRelease(blur_v);

            *this = {};
        }
    };
    std::vector<EsmBlur> esm_blurs;
#endif
    /**
     * Refilled per generator by the caster fold, never reallocated.
     *
     * It belongs to the shadow walk rather than to the ESM half: the walk
     * runs whenever this build has receivers at all, and a carrier that
     * existed only under the ESM define would make the shared walk's own
     * signature depend on which filters the scene reached.
     */
    /** The shared walk's carriers, whose layout it owns. */
    pal::ShadowRefreshState shadow_refresh;
#endif
    WGPUBindGroup pinned_frame_group = nullptr;
#endif

#if BBLITE_NODE_VARIANTS > 0
    // The node family's modules and pipelines.
    std::vector<WGPUShaderModule> node_vertex_modules;
    std::vector<WGPUShaderModule> node_fragment_modules;
    std::map<std::uint32_t, std::map<DawnVariantPipelineKey, WGPURenderPipeline>>
        node_variant_pipelines;
#endif
#if BBLITE_STANDARD_VARIANTS > 0
    // The Standard family's composed modules and pipelines.
    std::vector<WGPUShaderModule> standard_vertex_modules;
    std::vector<WGPUShaderModule> standard_fragment_modules;
    std::map<std::uint32_t, std::map<DawnVariantPipelineKey, WGPURenderPipeline>>
        standard_variant_pipelines;
#endif
#if BBLITE_PBR_VARIANTS > 0
    std::vector<WGPUShaderModule> pinned_vertex_modules;
    std::vector<WGPUShaderModule> pinned_fragment_modules;
    std::map<std::uint32_t, std::map<DawnVariantPipelineKey, WGPURenderPipeline>>
        pinned_variant_pipelines;
#endif
#if BBLITE_PINNED_MATERIALS
    // The frame's scene and lights blocks, shared by the PBR and the
    // Standard composed families through the same group-0 layout.
    WGPUBuffer pinned_scene_uniforms = nullptr;
    WGPUBuffer pinned_lights_uniforms = nullptr;
    // The geometry tasks' scene block: the same struct written for a
    // task's own camera and aspect, sharing the lights buffer through its
    // own group 0.
    WGPUBuffer pinned_geometry_scene_uniforms = nullptr;
    WGPUBindGroup pinned_geometry_frame_group = nullptr;
    // One swapchain overlay layer's own group 0. A layer is a second
    // scene: its lights are not the base scene's, so unlike a render
    // task it needs its own lights buffer beside its own scene block --
    // a queue write cannot be re-issued between two passes of one
    // command buffer, which is why the buffers are per layer rather
    // than rewritten.
    struct OverlayFrame {
        WGPUBuffer scene_uniforms = nullptr;
        WGPUBuffer lights_uniforms = nullptr;
        WGPUBindGroup frame_group = nullptr;
    };
    std::vector<OverlayFrame> overlay_frames;
#endif
#if BBLITE_PINNED_BACKGROUNDS
    // The arms this run draws (`select_pinned_backgrounds`), one each.
    pal::PinnedBackgroundDraws background_draws;
    std::vector<DawnBackgroundArm> background_arms;

    [[nodiscard]] const DawnBackgroundArm&
    background_arm(upstream::PinnedBackgroundArmKind kind) const {
        for (const DawnBackgroundArm& candidate : background_arms) {
            if (candidate.arm->kind == kind)
                return candidate;
        }
        throw std::runtime_error("A selected background arm was not built.");
    }
#endif
    // The pinned mip generator, shared with the pure-2D sprite driver
    // through `pal_dawn_shared.hpp`.
    DawnMipGenerator mips;
#if BBLITE_GPU_MORPH_STORAGE
    WGPUBuffer empty_morph_deltas = nullptr;
    WGPUBuffer empty_morph_weights = nullptr;
#endif
    std::map<DawnMeshPipelineKey, DawnPipeline> pipelines;
    // Attribution capture resources (scene-1 diagnostics tooling),
    // created lazily on the first requested capture. Pipelines are
    // keyed by [double_sided]; the PBR diagnostic set adds the MRT
    // pass index.
    WGPUShaderModule diagnostic_id_module = nullptr;
    WGPUShaderModule diagnostic_cluster_module = nullptr;
    std::array<WGPURenderPipeline, 2> id_pipelines{};
    std::array<WGPURenderPipeline, 2> cluster_pipelines{};
    std::vector<DawnMesh> meshes;
    /**
     * The uploaded meshes of every swapchain overlay layer.
     *
     * A draw command indexes its own PLAN, so a layer cannot share the
     * base scene's array; each keeps its own beside its own plan.
     */
    std::vector<std::vector<DawnMesh>> overlay_meshes;
    std::vector<std::unique_ptr<DawnSharedShaderGeometry>> shared_shader_geometries;
    TextureUploadCache<DawnTexture> shared_material_images;
    std::vector<std::unique_ptr<DawnSharedShaderMaterialTextures>> shared_shader_material_textures;
    std::vector<std::unique_ptr<DawnSharedComposedMaterialTextures>>
        shared_composed_material_textures;
#if BBLITE_HAS_MATERIAL_PLUGIN_TEXTURES
    std::vector<std::unique_ptr<DawnSharedPluginMaterialTextures>> shared_plugin_material_textures;
#endif

    // Frame-task draw resources are tied to the current render plan
    // and rebuild together with the meshes.
    void release_render_tasks() {
        for (DawnRenderTask& task : render_tasks) {
            task.depth_only_groups.clear();
            if (task.pinned_frame_group) {
                task.pinned_frame_group.reset();
            }
            if (task.pinned_scene_uniforms) {
                task.pinned_scene_uniforms.reset();
            }
            if (task.view_projection) {
                task.view_projection.reset();
            }
        }
        render_tasks.clear();
    }

    /** Drop groups that can name a recreated storage or shadow-map view. */
    void release_shader_bindings() {
        const auto release = [](std::vector<DawnMesh>& mesh_list) {
            for (DawnMesh& mesh : mesh_list) {
                for (auto& [key, bindings] : mesh.shader_bindings) {
                    (void)key;
                    release_dawn_shader_bindings(bindings);
                }
                mesh.shader_bindings.clear();
            }
        };
        release(meshes);
        for (std::vector<DawnMesh>& layer : overlay_meshes)
            release(layer);
    }

#if BBLITE_HAS_SCREEN_SPACE
    /**
     * The screen-space programs key only the generated stage table's
     * formats, so they outlive every frame-graph rebuild and go with the
     * device.
     */
    void release_screen_space_programs() {
        for (DawnScreenSpaceProgram& program : screen_space_programs) {
            if (program.pipeline)
                program.pipeline.reset();
            if (program.pipeline_layout) {
                program.pipeline_layout.reset();
            }
            if (program.group_layout) {
                program.group_layout.reset();
            }
            if (program.module)
                program.module.reset();
            program = {};
        }
        screen_space_programs.clear();
    }
#endif

    void release_frame_graph_textures(const Engine* preserve = nullptr) {
#if BBLITE_SHADOW_RECEIVERS
        // Custom shader resource groups may bind a CSM map directly. They
        // must release that view before the frame graph destroys it and
        // will be rebuilt lazily against the replacement map.
        release_shader_bindings();
#endif
#if BBLITE_SHADOW_RECEIVERS
        // The receiver group holds a view of a shadow map's depth texture,
        // which the loop below is about to release; a resize rebuilds both.
        // The layout beside it is shape-only and survives.
        shadow_groups.clear();
#endif
        for (std::size_t index = 0; index < render_targets.size(); ++index) {
            if (preserve && index < preserve->render_targets.size() &&
                preserve->render_targets[index].lifecycle)
                continue;
            render_targets[index] = {};
        }
        for (DawnGeometryTask& task : geometry_tasks)
            task = {};
#if BBLITE_HAS_POST_PROCESS
        // The pass's pipeline and bind group name the attachments the graph
        // just released, so they are rebuilt with them; the pin discards the
        // same state when its own internal target is re-created.
        for (std::vector<DawnPostProcessTask>& passes : post_process_tasks) {
            for (DawnPostProcessTask& task : passes) {
                if (task.group)
                    task.group.reset();
                if (task.uniforms)
                    task.uniforms.reset();
                task = {};
            }
        }
        post_process_tasks.clear();
        // The programs outlive no build: a rebuilt graph may target different
        // formats, and every pass that borrowed one was just reset.
        for (DawnPostProcessProgram& program : post_process_programs) {
            if (program.pipeline) {
                program.pipeline.reset();
            }
            if (program.pipeline_layout) {
                program.pipeline_layout.reset();
            }
            if (program.group_layout) {
                program.group_layout.reset();
            }
            if (program.module)
                program.module.reset();
            program = {};
        }
        post_process_programs.clear();
#if BBLITE_HAS_TAA
        if (temporal_presented_group)
            wgpuBindGroupRelease(temporal_presented_group);
        if (temporal_presented_view)
            wgpuTextureViewRelease(temporal_presented_view);
        if (temporal_presented)
            wgpuTextureRelease(temporal_presented);
        temporal_presented_group = nullptr;
        temporal_presented_view = nullptr;
        temporal_presented = nullptr;
#endif
#endif
#if BBLITE_HAS_SCREEN_SPACE
        // A stage's bind group names the attachments the graph just
        // released, so it goes with them; its program keys only the
        // generated stage table's formats and outlives every rebuild.
        for (DawnScreenSpaceTask& task : screen_space_tasks) {
            for (DawnScreenSpaceStage* stage : {&task.producer, &task.resolve}) {
                if (stage->group)
                    stage->group.reset();
                if (stage->uniforms)
                    stage->uniforms.reset();
                *stage = {};
            }
        }
        screen_space_tasks.clear();
#endif
#if BBLITE_HAS_EFFECT_TASK
        for (DawnEffectPass& pass : effect_tasks) {
            release_dawn_effect_pass(pass);
        }
        effect_tasks.clear();
#endif
        frame_graph_width = 0;
        frame_graph_height = 0;
    }

    void release_gpu_resources(DawnDrawResources& draw) noexcept {
        if (draw.group)
            wgpuBindGroupRelease(draw.group);
        if (draw.uv_transform_uniforms)
            wgpuBufferRelease(draw.uv_transform_uniforms);
        if (draw.uv_uniforms)
            wgpuBufferRelease(draw.uv_uniforms);
        if (draw.material_uniforms)
            wgpuBufferRelease(draw.material_uniforms);
        if (draw.mesh_uniforms)
            wgpuBufferRelease(draw.mesh_uniforms);
    }

    // Release one mesh in dependency order. Submitted command buffers keep
    // their own references; this drops only the application's references.
    void release_gpu_resources(DawnMeshResources& mesh) {
#if BBLITE_HAS_PICKING && BBLITE_GPU_INSTANCING
        mesh.release_thin_pick_group();
#endif
        // Bind groups are the dependents: release every group before
        // any buffer, texture view, sampler, or texture referenced by
        // one. Dawn's D3D12 implementation reads that binding state
        // while destroying a group, so the inverse order is not merely
        // a leak/lifetime nicety -- it can dereference freed metadata.
        mesh.diagnostic_bindings.scene.reset();
        mesh.diagnostic_bindings.textures.reset();
#if BBLITE_GPU_MORPH_STORAGE
        mesh.diagnostic_bindings.morph.reset();
#endif
        for (auto& [key, binding] : mesh.shader_bindings) {
            (void)key;
            release_dawn_shader_bindings(binding);
        }
        mesh.shader_bindings.clear();
#if BBLITE_PBR_VARIANTS > 0
        mesh.pinned_geometry_states.clear();
        mesh.pinned_states.clear();
#endif
#if BBLITE_STANDARD_VARIANTS > 0
        mesh.standard_geometry_states.clear();
        mesh.standard_states.clear();
#endif
#if BBLITE_NODE_VARIANTS > 0
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
        mesh.node_geometry_states.clear();
#endif
        mesh.node_states.clear();
#endif
        if (mesh.shared_composed_textures) {
            release_shared_user(mesh.shared_composed_textures,
                                "Composed material texture reference count underflow.");
        } else {
            for (std::size_t slot = 0; slot < mesh_texture_slots; ++slot) {
                if (mesh.owned_views[slot]) {
                    wgpuTextureViewRelease(mesh.owned_views[slot]);
                }
                if (mesh.owned_textures[slot]) {
                    wgpuTextureRelease(mesh.owned_textures[slot]);
                }
                // Unmaterialized slots borrow the state's default sampler;
                // only a slot with its own uploaded texture created the
                // sampler stored beside it.
                if (mesh.owned_textures[slot] && mesh.samplers[slot]) {
                    wgpuSamplerRelease(mesh.samplers[slot]);
                }
            }
        }
        if (mesh.shared_shader_textures) {
            release_shared_user(mesh.shared_shader_textures,
                                "Shader material texture reference count underflow.");
        } else {
            release_dawn_extra_textures(mesh.shader_textures);
        }
#if BBLITE_HAS_MATERIAL_PLUGIN_TEXTURES
        if (mesh.shared_plugin_textures) {
            release_shared_user(mesh.shared_plugin_textures,
                                "Plugin material texture reference count underflow.");
        }
#endif
#if BBLITE_PBR_VARIANTS > 0 || BBLITE_STANDARD_SKELETON
        if (mesh.pinned_bone_view) {
            wgpuTextureViewRelease(mesh.pinned_bone_view);
        }
        if (mesh.pinned_bone_texture) {
            wgpuTextureRelease(mesh.pinned_bone_texture);
        }
        mesh.pinned_bone_view = nullptr;
        mesh.pinned_bone_texture = nullptr;
        mesh.pinned_bone_count = 0;
#endif
#if BBLITE_PBR_VARIANTS > 0
#if BBLITE_VAT
        if (mesh.pinned_vat_view) {
            wgpuTextureViewRelease(mesh.pinned_vat_view);
        }
        if (mesh.pinned_vat_texture) {
            wgpuTextureRelease(mesh.pinned_vat_texture);
        }
        if (mesh.pinned_vat_settings) {
            wgpuBufferRelease(mesh.pinned_vat_settings);
        }
        mesh.pinned_vat_view = nullptr;
        mesh.pinned_vat_texture = nullptr;
        mesh.pinned_vat_settings = nullptr;
        mesh.pinned_vat_bones = 0;
        mesh.pinned_vat_frames = 0;
#if BBLITE_VAT_INSTANCES
        if (mesh.pinned_vat_instance_view) {
            wgpuTextureViewRelease(mesh.pinned_vat_instance_view);
        }
        if (mesh.pinned_vat_instance_texture) {
            wgpuTextureRelease(mesh.pinned_vat_instance_texture);
        }
        mesh.pinned_vat_instance_view = nullptr;
        mesh.pinned_vat_instance_texture = nullptr;
        mesh.pinned_vat_instance_texels = 0;
        mesh.pinned_vat_instance_version = 0;
#endif
#endif
#endif
        if (mesh.material_uniforms) {
            wgpuBufferRelease(mesh.material_uniforms);
        }
        if (mesh.shader_vertex_uniforms) {
            wgpuBufferRelease(mesh.shader_vertex_uniforms);
        }
#if BBLITE_GPU_DEFORMATION
        if (mesh.deformation_uniforms) {
            wgpuBufferRelease(mesh.deformation_uniforms);
        }
#endif
        if (mesh.mesh_world_uniform) {
            wgpuBufferRelease(mesh.mesh_world_uniform);
        }
#if BBLITE_GPU_INSTANCING
        if (mesh.instances)
            wgpuBufferRelease(mesh.instances);
#if BBLITE_GPU_INSTANCE_COLORS
        if (mesh.instance_colors) {
            wgpuBufferRelease(mesh.instance_colors);
        }
#endif
#endif
#if BBLITE_GPU_MORPH_STORAGE
        if (mesh.owns_morph_buffers) {
            if (mesh.morph_deltas) {
                wgpuBufferRelease(mesh.morph_deltas);
            }
            if (mesh.morph_weights) {
                wgpuBufferRelease(mesh.morph_weights);
            }
        }
#endif
        if (mesh.owns_geometry_buffers) {
            if (mesh.vertices)
                wgpuBufferRelease(mesh.vertices);
            if (mesh.indices)
                wgpuBufferRelease(mesh.indices);
        } else if (mesh.shared_geometry) {
            release_shared_user(mesh.shared_geometry, "Shader geometry reference count underflow.");
        }
    }

    void prune_shared_shader_geometries() {
        prune_unused_shared(shared_shader_geometries, [](DawnSharedShaderGeometry& geometry) {
            if (geometry.vertex_buffer) {
                geometry.vertex_buffer.reset();
            }
            if (geometry.index_buffer) {
                geometry.index_buffer.reset();
            }
        });
    }

    void prune_shared_shader_material_textures() {
        prune_unused_shared(shared_shader_material_textures,
                            [](DawnSharedShaderMaterialTextures& textures) { textures.clear(); });
#if BBLITE_HAS_MATERIAL_PLUGIN_TEXTURES
        prune_unused_shared(shared_plugin_material_textures,
                            [](DawnSharedPluginMaterialTextures& textures) { textures.clear(); });
#endif
        shared_material_images.prune();
    }

    void prune_shared_composed_material_textures() {
        prune_unused_shared(shared_composed_material_textures,
                            [](DawnSharedComposedMaterialTextures& textures) {
                                release_dawn_composed_material_textures(textures);
                            });
    }

    void release_meshes() {
        overlay_meshes.clear();
        meshes.clear();
    }

#if BBLITE_HAS_PICKING && BBLITE_GPU_INSTANCING
    void release_thin_pick_groups() {
        for (DawnMesh& mesh : meshes)
            mesh.release_thin_pick_group();
        for (auto& layer : overlay_meshes) {
            for (DawnMesh& mesh : layer)
                mesh.release_thin_pick_group();
        }
    }
#endif

    ~DawnState() {
#if BBLITE_HAS_TEXT
        text.reset();
#endif
#if BBLITE_HAS_PICKING && BBLITE_GPU_INSTANCING
        release_thin_pick_groups();
#endif
#if BBLITE_HAS_UI && !BBLITE_WORKERS
        release_sprite_ui_dawn_resources(ui);
#endif
#if BBLITE_HAS_PICKING
        release_dawn_pick_targets(pick_targets);
        if (pick_mesh_pipeline)
            wgpuRenderPipelineRelease(pick_mesh_pipeline);
#if BBLITE_GPU_INSTANCING
        if (pick_thin_pipeline) {
            wgpuRenderPipelineRelease(pick_thin_pipeline);
        }
        if (pick_thin_layout) {
            wgpuBindGroupLayoutRelease(pick_thin_layout);
        }
#endif
#if BBLITE_HAS_DETAILED_PICKING
        if (pick_detailed_pipeline) {
            wgpuRenderPipelineRelease(pick_detailed_pipeline);
        }
#endif
#if BBLITE_DEFORM_PICKING
        for (auto& program : pick_deform_programs) {
            for (auto pipeline : program.pipelines) {
                if (pipeline)
                    wgpuRenderPipelineRelease(pipeline);
            }
            if (program.layout)
                wgpuBindGroupLayoutRelease(program.layout);
        }
        if (pick_deform_empty_group) {
            wgpuBindGroupRelease(pick_deform_empty_group);
        }
        if (pick_deform_empty_layout) {
            wgpuBindGroupLayoutRelease(pick_deform_empty_layout);
        }
#endif
        if (pick_scene_layout)
            wgpuBindGroupLayoutRelease(pick_scene_layout);
        if (pick_mesh_layout)
            wgpuBindGroupLayoutRelease(pick_mesh_layout);
        if (pick_scene_group)
            wgpuBindGroupRelease(pick_scene_group);
        if (pick_scene_buffer)
            wgpuBufferRelease(pick_scene_buffer);
        if (pick_mesh_group)
            wgpuBindGroupRelease(pick_mesh_group);
        if (pick_mesh_buffer)
            wgpuBufferRelease(pick_mesh_buffer);
#if BBLITE_HAS_SPLATS
        if (pick_cloud_pipeline) {
            wgpuRenderPipelineRelease(pick_cloud_pipeline);
        }
        if (pick_cloud_color_layout) {
            wgpuBindGroupLayoutRelease(pick_cloud_color_layout);
        }
        if (pick_cloud_shear_group) {
            wgpuBindGroupRelease(pick_cloud_shear_group);
        }
        if (pick_cloud_shear)
            wgpuBufferRelease(pick_cloud_shear);
        if (pick_cloud_color_group) {
            wgpuBindGroupRelease(pick_cloud_color_group);
        }
        if (pick_cloud_color)
            wgpuBufferRelease(pick_cloud_color);
#endif
#endif
#if BBLITE_HAS_SPRITE_RENDERER
        if (has_scene_sprite_pass) {
            release_dawn_scene_sprite_pass(scene_sprite_pass);
            has_scene_sprite_pass = false;
        }
        for (DawnSpritePass& pass : sprite_passes) {
            release_dawn_sprite_pass(pass);
        }
        sprite_passes.clear();
        for (WGPUTextureView view : sprite_render_texture_views) {
            if (view)
                wgpuTextureViewRelease(view);
        }
        sprite_render_texture_views.clear();
        for (WGPUTexture texture : sprite_render_textures) {
            if (texture)
                wgpuTextureRelease(texture);
        }
        sprite_render_textures.clear();
#endif
        release_dawn_mip_generator(mips);
        release_render_tasks();
        release_frame_graph_textures();
#if BBLITE_HAS_SCREEN_SPACE
        release_screen_space_programs();
#endif
#if BBLITE_SHADOW_RECEIVERS
        // The receiver group already went with the frame-graph textures it
        // views; what remains is the generator-owned state, which outlives
        // a resize.
        for (WGPUBuffer buffer : shadow_uniforms) {
            if (buffer)
                wgpuBufferRelease(buffer);
        }
        if (shadow_comparison_sampler) {
            wgpuSamplerRelease(shadow_comparison_sampler);
        }
        if (shadow_filtering_sampler) {
            wgpuSamplerRelease(shadow_filtering_sampler);
        }
#endif
        for (auto& [key, pipeline] : depth_only_pipelines) {
            if (pipeline)
                wgpuRenderPipelineRelease(pipeline);
        }
        for (auto& [key, pipeline] : blit_pipelines) {
            if (pipeline)
                wgpuRenderPipelineRelease(pipeline);
        }
        if (depth_copy_pipeline) {
            wgpuRenderPipelineRelease(depth_copy_pipeline);
        }
        if (depth_copy_module) {
            wgpuShaderModuleRelease(depth_copy_module);
        }
        if (depth_only_module) {
            wgpuShaderModuleRelease(depth_only_module);
        }
        if (blit_fragment_module) {
            wgpuShaderModuleRelease(blit_fragment_module);
        }
        if (blit_vertex_module) {
            wgpuShaderModuleRelease(blit_vertex_module);
        }
        if (image_processing_group) {
            wgpuBindGroupRelease(image_processing_group);
        }
        if (image_processing_params) {
            wgpuBufferRelease(image_processing_params);
        }
        if (image_processing_pipeline) {
            wgpuRenderPipelineRelease(image_processing_pipeline);
        }
        if (image_processing_module) {
            wgpuShaderModuleRelease(image_processing_module);
        }
        if (transmission_grab_pipeline) {
            wgpuRenderPipelineRelease(transmission_grab_pipeline);
        }
        if (transmission_grab_sampler) {
            wgpuSamplerRelease(transmission_grab_sampler);
        }
        if (transmission_grab_module) {
            wgpuShaderModuleRelease(transmission_grab_module);
        }
        if (transmission_color_view) {
            wgpuTextureViewRelease(transmission_color_view);
        }
        if (transmission_color) {
            wgpuTextureRelease(transmission_color);
        }
        if (transmission_sampler) {
            wgpuSamplerRelease(transmission_sampler);
        }
        if (nearest_sampler)
            wgpuSamplerRelease(nearest_sampler);
#if BBLITE_HAS_POST_PROCESS
        if (post_process_bilinear_sampler) {
            wgpuSamplerRelease(post_process_bilinear_sampler);
        }
#endif
        release_meshes();
        for (ShaderStorageBuffer& storage : shader_storage_buffers) {
            if (storage.buffer && !storage.borrowed_owner)
                wgpuBufferRelease(storage.buffer);
        }
        shader_storage_buffers.clear();
        release_all_shared(shared_shader_geometries, [](DawnSharedShaderGeometry& geometry) {
            if (geometry.vertex_buffer) {
                geometry.vertex_buffer.reset();
            }
            if (geometry.index_buffer) {
                geometry.index_buffer.reset();
            }
        });
        release_all_shared(shared_shader_material_textures,
                           [](DawnSharedShaderMaterialTextures& textures) { textures.clear(); });
#if BBLITE_HAS_MATERIAL_PLUGIN_TEXTURES
        release_all_shared(shared_plugin_material_textures,
                           [](DawnSharedPluginMaterialTextures& textures) { textures.clear(); });
#endif
        release_all_shared(shared_composed_material_textures,
                           [](DawnSharedComposedMaterialTextures& textures) {
                               release_dawn_composed_material_textures(textures);
                           });
#if BBLITE_GPU_MORPH_STORAGE
        if (empty_morph_weights) {
            wgpuBufferRelease(empty_morph_weights);
        }
        if (empty_morph_deltas) {
            wgpuBufferRelease(empty_morph_deltas);
        }
#endif
        for (auto& [kind, pipeline] : pipelines) {
            if (pipeline.pipeline) {
                wgpuRenderPipelineRelease(pipeline.pipeline);
            }
        }
        // The shadow generators' own state, here rather than beside the
        // receiver releases above because every caster draw group binds a
        // `shadow_params` row -- the groups went with the meshes.
#if BBLITE_SHADOW_RECEIVERS
#if BBLITE_SHADOWS_ESM
        for (WGPUBuffer buffer : shadow_params) {
            if (buffer)
                wgpuBufferRelease(buffer);
        }
        for (EsmBlur& blur : esm_blurs)
            blur.clear();
        esm_blurs.clear();
#endif
#endif
        // The composed families' pipelines and modules. Their layouts stay
        // with `layouts`, which outlives every dependent: Dawn's D3D12
        // backend tears down layout-owned binding metadata eagerly, so a
        // bind group dropped after its layout can dereference freed state.
#if BBLITE_PINNED_MATERIALS
        if (pinned_geometry_frame_group) {
            wgpuBindGroupRelease(pinned_geometry_frame_group);
        }
        if (pinned_frame_group)
            wgpuBindGroupRelease(pinned_frame_group);
        for (OverlayFrame& overlay : overlay_frames) {
            if (overlay.frame_group) {
                wgpuBindGroupRelease(overlay.frame_group);
            }
            if (overlay.lights_uniforms) {
                wgpuBufferRelease(overlay.lights_uniforms);
            }
            if (overlay.scene_uniforms) {
                wgpuBufferRelease(overlay.scene_uniforms);
            }
        }
        overlay_frames.clear();
        if (pinned_geometry_scene_uniforms) {
            wgpuBufferRelease(pinned_geometry_scene_uniforms);
        }
        if (pinned_lights_uniforms) {
            wgpuBufferRelease(pinned_lights_uniforms);
        }
        if (pinned_scene_uniforms) {
            wgpuBufferRelease(pinned_scene_uniforms);
        }
#endif
#if BBLITE_PBR_VARIANTS > 0
        release_variant_family(pinned_variant_pipelines, pinned_fragment_modules,
                               pinned_vertex_modules);
#endif
#if BBLITE_STANDARD_VARIANTS > 0
        release_variant_family(standard_variant_pipelines, standard_fragment_modules,
                               standard_vertex_modules);
#endif
#if BBLITE_NODE_VARIANTS > 0
        release_variant_family(node_variant_pipelines, node_fragment_modules, node_vertex_modules);
#endif
#if BBLITE_PINNED_BACKGROUNDS
        // Before the layouts they were built over.
        background_arms.clear();
#endif
        if (ground_sampler)
            wgpuSamplerRelease(ground_sampler);
        if (clamp_sampler)
            wgpuSamplerRelease(clamp_sampler);
        if (default_sampler)
            wgpuSamplerRelease(default_sampler);
        if (brdf_view)
            wgpuTextureViewRelease(brdf_view);
        if (brdf_texture)
            wgpuTextureRelease(brdf_texture);
        if (environment_cube_view) {
            wgpuTextureViewRelease(environment_cube_view);
        }
        if (environment_cube)
            wgpuTextureRelease(environment_cube);
        for (WGPUTextureView view : reflection_cube_views) {
            if (view)
                wgpuTextureViewRelease(view);
        }
        for (WGPUTexture texture : reflection_cubes) {
            if (texture)
                wgpuTextureRelease(texture);
        }
        if (normal_flat_view)
            wgpuTextureViewRelease(normal_flat_view);
        if (normal_flat_texture)
            wgpuTextureRelease(normal_flat_texture);
        if (black_cube_view)
            wgpuTextureViewRelease(black_cube_view);
        if (black_cube)
            wgpuTextureRelease(black_cube);
        if (black_view)
            wgpuTextureViewRelease(black_view);
        if (black_texture)
            wgpuTextureRelease(black_texture);
        if (white_view)
            wgpuTextureViewRelease(white_view);
        if (white_texture)
            wgpuTextureRelease(white_texture);
        if (view_projection)
            wgpuBufferRelease(view_projection);
        for (WGPUShaderModule module : shader_fragment_modules) {
            if (module)
                wgpuShaderModuleRelease(module);
        }
        for (WGPUShaderModule module : shader_vertex_modules) {
            if (module)
                wgpuShaderModuleRelease(module);
        }
#if BBLITE_HAS_SPLATS
        for (DawnSplatPass& splat : splat_passes) {
            release_dawn_splat_pass(splat);
        }
        splat_passes.clear();
#endif
#if BBLITE_HAS_BILLBOARDS
        for (DawnBillboardPass& billboard : billboard_passes) {
            release_dawn_billboard_pass(billboard);
        }
        billboard_passes.clear();
#endif
        if (pbr_module)
            wgpuShaderModuleRelease(pbr_module);
        if (vertex_module)
            wgpuShaderModuleRelease(vertex_module);
        if (depth_view)
            wgpuTextureViewRelease(depth_view);
        if (depth)
            wgpuTextureRelease(depth);
        if (msaa_color_view)
            wgpuTextureViewRelease(msaa_color_view);
        if (msaa_color)
            wgpuTextureRelease(msaa_color);
#if BBLITE_LOCAL_CUBEMAP
        local_cubemaps.clear();
#endif
    }
};

#if BBLITE_SHADOWS_ESM
/**
 * The ESM caster's own params block, from the generator its material view
 * was built for.
 *
 * `getEsmShadowView` closes over that generator's `_shadowParamsUBO`, and
 * every family's caster reads the same one, so the lookup is stated once.
 */
WGPUBuffer esm_caster_params_buffer(const DawnState& state, const MaterialRecord* material);
#endif

/** Forwards to the shared loader; the call sites name the state. */
inline WGPUShaderModule load_wgsl_module(DawnState& state, const std::string& base_name) {
    return bbl::pal::load_wgsl_module(state.device, base_name);
}

WGPUBuffer create_buffer(DawnState& state, WGPUBufferUsage usage, const void* data,
                         std::uint64_t size);

/** Mirror Engine storage records into Dawn read-only storage buffers. */
void sync_shader_storage_buffers(DawnState& state, const Engine& engine);

WGPUTexture create_solid_texture(DawnState& state, const std::vector<std::uint8_t>& texel,
                                 WGPUTextureFormat format, std::uint32_t layers);

// The pinned mip generator's fullscreen-triangle bilinear blit
// (src/texture/generate-mipmaps.ts BLIT_SHADER) is deployed from
// generation like every other pinned shader -- the whole `mip-blit` module
// -- instead of living here as a C++ string invisible to shader provenance.
// The generator itself lives in pal_dawn_shared.hpp (`DawnMipGenerator`),
// shared with the pure-2D sprite driver; these are the scene driver's
// spellings over its own state.
inline void record_mipmaps(DawnState& state, WGPUCommandEncoder encoder, WGPUTexture texture,
                           WGPUTextureFormat format, std::uint32_t mip_count,
                           std::int32_t face = -1) {
    record_mipmaps(state.device, state.mips, encoder, texture, format, mip_count, face);
}

inline void generate_mipmaps(DawnState& state, WGPUTexture texture, WGPUTextureFormat format,
                             std::uint32_t mip_count, std::int32_t face = -1) {
    generate_mipmaps(state.device, state.queue, state.mips, texture, format, mip_count, face);
}

/**
 * The WebGPU enumerator for one shared block format. The pin writes
 * `GPUTextureFormat` strings, so this is the C API's own spelling of the
 * name the container states.
 */
WGPUTextureFormat compressed_texture_format(std::string_view name);

#if BBLITE_PINNED_MATERIAL_VARIANTS || BBLITE_PINNED_BACKGROUNDS
/**
 * One reflected group-1 row as a layout entry.
 *
 * The rows are one shape for both composed material families, so their
 * mapping onto WebGPU's entry is one function: a new `PinnedBindingKind` arm
 * is added once rather than in each family's loop. `depth_emissive` is the
 * Standard family's own trap -- a record whose emissive is the depth render
 * texture binds that pair unfilterable, with a non-filtering sampler.
 */
WGPUBindGroupLayoutEntry variant_layout_entry(const upstream::PinnedVariantBinding& binding,
                                              bool depth_emissive);

#if BBLITE_PBR_VARIANTS > 0
/** One PBR variant's reflected group-1 rows. */
inline std::span<const upstream::PinnedVariantBinding> pbr_variant_rows(std::size_t variant) {
    const upstream::PbrVariantEntry& entry = upstream::pbr_variants[variant];
    return upstream::pbr_variant_bindings.subspan(entry.first_binding, entry.binding_count);
}
#endif

#if BBLITE_STANDARD_VARIANTS > 0
/** One Standard variant's reflected group-1 rows. */
inline std::span<const upstream::PinnedVariantBinding> standard_variant_rows(std::size_t variant) {
    const upstream::StandardVariantEntry& entry = upstream::standard_variants[variant];
    return upstream::standard_variant_bindings.subspan(entry.first_binding, entry.binding_count);
}
#endif

/**
 * Whether a reflected row claims `binding`.
 *
 * Bindings 0 and 1 are the hand-managed mesh and material blocks, except
 * when the rows occupy them: a morph variant's storage pair claims bindings
 * 1-2, which pushes `mat` out to a reflected uniform row of its own (scene
 * 252's is at 3). A fixed entry under an occupied binding would duplicate
 * it, which Dawn refuses at layout creation, so each fixed entry yields to
 * the rows -- in the layout and in every group bound against it.
 */
inline bool rows_claim_binding(std::span<const upstream::PinnedVariantBinding> rows,
                               std::uint32_t binding) {
    return std::any_of(rows.begin(), rows.end(),
                       [binding](const auto& row) { return row.binding == binding; });
}

/** Appends each fixed layout or group entry whose binding no row claims. */
template <typename Entry>
void append_unclaimed_entries(std::vector<Entry>& entries,
                              std::span<const upstream::PinnedVariantBinding> rows,
                              std::initializer_list<Entry> fixed) {
    for (const Entry& entry : fixed) {
        if (!rows_claim_binding(rows, entry.binding))
            entries.push_back(entry);
    }
}

/**
 * A composed variant's group-1 layout: the fixed blocks no row claims, then
 * every reflected row. `unfilterable` names the rows a depth-sampled emissive
 * binds unfilterable, which only the Standard family reaches.
 */
template <typename Unfilterable>
std::vector<WGPUBindGroupLayoutEntry>
reflected_group_layout_entries(std::initializer_list<WGPUBindGroupLayoutEntry> fixed,
                               std::span<const upstream::PinnedVariantBinding> rows,
                               Unfilterable&& unfilterable) {
    std::vector<WGPUBindGroupLayoutEntry> entries;
    entries.reserve(fixed.size() + rows.size());
    append_unclaimed_entries(entries, rows, fixed);
    for (const upstream::PinnedVariantBinding& row : rows)
        entries.push_back(variant_layout_entry(row, unfilterable(row)));
    return entries;
}
#endif

/** A uniform block's layout entry. */
WGPUBindGroupLayoutEntry uniform_layout_entry(std::uint32_t binding, WGPUShaderStage visibility);

/** A read-only storage buffer's layout entry. */
WGPUBindGroupLayoutEntry storage_layout_entry(std::uint32_t binding, WGPUShaderStage visibility);

/**
 * A texture whose bytes are already blocks: the container's own mip chain,
 * uploaded level by level with nothing decoded and nothing generated.
 */
WGPUTexture upload_compressed_texture(DawnState& state, const CompressedTexture& compressed);

WGPUTexture upload_material_texture(DawnState& state, const TextureData& texture_data, bool srgb,
                                    const std::array<std::uint8_t, 4>& fallback,
                                    std::uint32_t& out_mip_count);

// `.babylon` reflection cube, matching the pinned loadCubeTexture:
// rgba8unorm faces with a full GPU-blit mip chain generated per face.
WGPUTexture upload_reflection_cube(DawnState& state,
                                   const std::array<TextureData, 6>& texture_data);

// create_texture_sampler moved to pal_dawn_shared.hpp so the sprite pass
// derives its atlas sampler from the record the same way (it used to
// hardcode a descriptor beside this translation).

// Upload the environment cubemap exactly as the browser does: rgba16f
// faces with pre-baked mips, uploaded unflipped (the SDL_GPU vertical
// reversal is an SDL-only adaptation).
WGPUTexture create_environment_texture(DawnState& state, const EnvironmentState& environment,
                                       std::uint32_t layers = 6);

void upload_environment(DawnState& state, const EnvironmentState& environment);

#if BBLITE_LOCAL_CUBEMAP
DawnState::LocalCubemap* ensure_local_cubemap(DawnState& state, const MaterialRecord* material);
#endif

void upload_brdf(DawnState& state, const EnvironmentState& environment);

inline std::uint32_t task_sample_count(const DawnState& state, std::uint32_t requested) {
    return requested == 4 ? state.sample_count : 1u;
}

inline WGPUTextureFormat geometry_texture_format(const GeometryTextureDescription& description) {
    return texture_format(geometry_format_class(description));
}

inline WGPUColor geometry_clear_color(GeometryTextureType type) {
    const double value = geometry_clear_component(type);
    return WGPUColor{value, value, value, value};
}

WGPUTexture create_frame_texture(DawnState& state, WGPUTextureFormat format, std::uint32_t samples,
                                 std::uint32_t width, std::uint32_t height, WGPUTextureUsage usage,
                                 std::uint32_t layers = 1);

// Mirrors the SDL backend's create_frame_graph_textures: render
// targets sized per record (or canvas), sampled aliases for
// single-sample attachments, and per-geometry-task MRT chains.
void create_frame_graph_textures(DawnState& state, const Engine& engine, std::uint32_t width,
                                 std::uint32_t height);

#if BBLITE_GPU_DEFORMATION
constexpr std::uint32_t base_vertex_attribute_count = 14;
#else
constexpr std::uint32_t base_vertex_attribute_count = 6;
#endif

// The GpuVertex attribute table the shared material stage's `VertexInput`
// declares, at its locations; deformation appends joints/weights/morph
// deltas at locations 8-15 exactly like the SDL backend.
void fill_base_vertex_attributes(WGPUVertexAttribute* attributes);

struct PipelineKindTraits {
    bool standard = false;
    bool transparent = false;
    WGPUCullMode cull = WGPUCullMode_Back;
    WGPUFrontFace front = WGPUFrontFace_CCW;
    // The kind's primitive, and the strip index format WebGPU requires
    // beside a strip topology on an indexed draw. Undef for every
    // non-strip primitive, which is what the descriptor's own default is.
    WGPUPrimitiveTopology topology = WGPUPrimitiveTopology_TriangleList;
    WGPUIndexFormat strip_index_format = WGPUIndexFormat_Undefined;
    // Generated shader-variant kinds: the concrete modules and
    // fixed-function state come from the emitted variant table.
    bool shader = false;
    bool shader_a2c = false;
};

// The API-enum residue of the shared `pipeline_kind_traits` decode
// (pal_gpu_shared.hpp): the facts exist once for both backends; what
// stays here is the WGPU translation and this mesh path's node refusal
// -- node draws bind their own compiled graphs and never take the mesh
// pipeline paths that ask for these traits.
PipelineKindTraits pipeline_traits(upstream::RenderPipelineKind kind);

#if BBLITE_PINNED_MATERIALS
// Babylon Lite's own bind groups, as its composed fragments declare them.
//
// The generated `pbr_variants.hpp` mirrors the four blocks -- SceneUniforms,
// LightEntry, MeshUniforms and one MaterialUniforms per variant -- from the pin
// itself, so the sizes here are those structs rather than numbers chosen at this
// layer. Texture pairs start at binding 3 because the mesh and material blocks
// take 0 and 1, which is the pin's numbering and not a convention of ours.
// Group 0: the per-pass scene group, laid out as the pin's own
// `getSceneBindGroupLayout` creates it -- the scene block, then the lights --
// from the rows generation recorded off that call. One layout for every
// variant, because the pin binds the same group under all of them.
WGPUBindGroupLayout pinned_frame_layout_for(DawnState& state);

/**
 * A composed family's pipeline layout: the shared frame group, the variant's
 * own draw group, and the receiver's group 2 where the variant composed one.
 *
 * One builder because the shape is the pin's rather than either family's --
 * both compose the same shadow core into the same third group, and a
 * non-receiver simply declares two.
 */
[[maybe_unused]] WGPUPipelineLayout composed_pipeline_layout(DawnState& state,
                                                             const DawnLayoutKey& key,
                                                             WGPUBindGroupLayout draw_layout,
                                                             WGPUBindGroupLayout shadow_layout);

#if BBLITE_PBR_VARIANTS > 0
std::pair<WGPUTexture, WGPUTextureView> dawn_render_target_texture(DawnState& state,
                                                                   const Engine& engine,
                                                                   RenderTargetHandle target_handle,
                                                                   bool depth_only);
/**
 * Group 1 for one variant: the mesh block, the material block, then exactly the
 * resources that variant's fragment declares.
 *
 * The bindings come from the generated table, which reads them off the composed
 * fragment itself. Declaring a superset instead would force every variant to
 * bind textures it never samples, and — because the indices are dense and
 * per-variant — would bind them at the wrong slots.
 */
WGPUBindGroupLayout pinned_draw_layout_for(DawnState& state, std::size_t variant);

#endif

// The per-pass scene and lights buffers, sized by the pin's own structs.
void ensure_pinned_frame_buffers(DawnState& state);

/**
 * Group 0 over one scene block and the frame's shared lights.
 *
 * Three callers want exactly this and differ only in which scene block they
 * read: the frame's own, a geometry task's, and a render task
 * drawing through its own camera. The lights are the scene's in all three.
 */
template <typename Buffer, typename Group>
WGPUBindGroup
pinned_frame_group_over(DawnState& state, Buffer& scene_uniforms, Group& group, const char* what,
                        // A swapchain overlay layer is the one caller whose LIGHTS are not
                        // the frame's: it is a second scene with its own light list, and a
                        // queue write cannot be re-issued between two passes of one command
                        // buffer. Every other caller leaves this null and shares the frame's.
                        WGPUBuffer lights_override = nullptr) {
    if (group)
        return group;
    ensure_pinned_frame_buffers(state);
    if (!scene_uniforms) {
        WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
        descriptor.size = sizeof(upstream::SceneUniforms);
        descriptor.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
        scene_uniforms = wgpuDeviceCreateBuffer(state.device, &descriptor);
        if (!scene_uniforms) {
            dawn_error((std::string(what) + " buffer creation failed.").c_str());
        }
    }
    std::array<WGPUBindGroupEntry, 2> entries{};
    entries[0] = WGPU_BIND_GROUP_ENTRY_INIT;
    entries[0].binding = 0;
    entries[0].buffer = scene_uniforms;
    entries[0].size = sizeof(upstream::SceneUniforms);
    entries[1] = WGPU_BIND_GROUP_ENTRY_INIT;
    entries[1].binding = 1;
    entries[1].buffer = lights_override ? lights_override : state.pinned_lights_uniforms;
    entries[1].size = 16 + upstream::pinned_max_lights * sizeof(upstream::LightEntry);
    WGPUBindGroupDescriptor descriptor = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    descriptor.layout = pinned_frame_layout_for(state);
    descriptor.entryCount = entries.size();
    descriptor.entries = entries.data();
    group = wgpuDeviceCreateBindGroup(state.device, &descriptor);
    if (!group) {
        dawn_error((std::string(what) + " bind group creation failed.").c_str());
    }
    return group;
}

// Group 0, built once from the buffers the frame writer fills.
inline WGPUBindGroup pinned_frame_group(DawnState& state) {
    return pinned_frame_group_over(state, state.pinned_scene_uniforms, state.pinned_frame_group,
                                   "pinned frame");
}

/**
 * Group 0 for a render task drawing through its own camera: its own scene
 * block, because a second camera moves the view-projection and the eye
 * position and no other value in it.
 */
inline WGPUBindGroup task_pinned_frame_group(DawnState& state, DawnRenderTask& task,
                                             WGPUBuffer lights = nullptr) {
    return pinned_frame_group_over(state, task.pinned_scene_uniforms, task.pinned_frame_group,
                                   "render task frame", lights);
}

#if BBLITE_HAS_TAA
void restore_temporal_source_buffer(DawnState& state, FrameTaskRecord& source, DawnRenderTask& gpu);
#endif

/**
 * Group 0 for one swapchain overlay layer: its own scene block AND its own
 * lights, because a layer is a second scene rather than a second camera on
 * this one.
 */
WGPUBindGroup overlay_frame_group(DawnState& state, DawnState::OverlayFrame& overlay);

/** Group 0 for the geometry tasks: their scene block beside the shared
 *  lights buffer, in the same layout as the main frame group. */
inline WGPUBindGroup pinned_geometry_frame_group(DawnState& state) {
    return pinned_frame_group_over(state, state.pinned_geometry_scene_uniforms,
                                   state.pinned_geometry_frame_group, "pinned geometry frame");
}

/**
 * A geometry task's frame prologue, run once by whichever family writer
 * owns it (the PBR writer when that family is compiled, the Standard
 * writer otherwise): the task's scene block, its gpUniforms
 * buffer — previous-frame view-projection beside the camera near/far —
 * and the previous view-projection tracking. Both writers used to carry
 * this sequence verbatim.
 */
[[maybe_unused]] void write_pinned_geometry_prologue(DawnState& state, const Scene& scene,
                                                     const Engine& engine,
                                                     const CameraRecord& camera,
                                                     DawnGeometryTask& geometry,
                                                     const std::array<float, 16>& geometry_matrix);

#if BBLITE_PINNED_MATERIALS
struct PinnedResource {
    WGPUTextureView view = nullptr;
    WGPUSampler sampler = nullptr;
};

/**
 * The scene-owned pair one slot source names, or an empty pair.
 *
 * A source outside the mesh's own slots is served by something this backend
 * holds for the whole scene, and every composed family wants the same answer
 * -- so the pairing is stated once here rather than per family.
 */
[[maybe_unused]] PinnedResource state_resource_for(const DawnState& state,
                                                   upstream::MaterialTextureSource source);
#endif

#if BBLITE_PBR_VARIANTS > 0
/**
 * Which of our resources the pin's own name for a binding refers to.
 *
 * The names are Babylon's, the slots are the PAL's, and this is where the two
 * meet. A variant that declares a resource this does not know fails by name
 * rather than drawing with whatever sat at that index.
 */
PinnedResource pinned_resource_for(DawnState& state, const DawnMesh& mesh, std::string_view name,
                                   [[maybe_unused]] const MaterialRecord* material = nullptr);

#endif

#if BBLITE_GPU_MORPH_STORAGE
/** Publish the same dirty pose before a visible draw or a same-turn pick. */
void sync_morph_weights(DawnState& state, DawnMesh& mesh, const ModelGeometry& geometry,
                        const MeshRecord& record);
#endif

#if BBLITE_PBR_VARIANTS > 0 || BBLITE_STANDARD_SKELETON
WGPUTexture create_pinned_float_texture(DawnState& state, std::uint32_t width, std::uint32_t height,
                                        const char* failure);

/**
 * The bone palette as the pin's own texture.
 *
 * `skeleton-updater.ts` writes `invMeshWorld * jointWorld * IBM` per bone into
 * an rgba32float row, four texels each. Our MeshRecord::bone_matrices already
 * holds that product -- the mesh world is conjugated into the palette, which is
 * why the transcribed skin path needs no separate world matrix either -- so this
 * uploads it unchanged.
 */
void write_pinned_bone_texture(DawnState& state, DawnMesh& mesh, const MeshRecord& record);

#endif

#if BBLITE_PBR_VARIANTS > 0
#if BBLITE_VAT
/** One rgba32float upload of `height` rows through the queue. */
void write_pinned_float_texture(DawnState& state, WGPUTexture texture, const float* data,
                                const VatTextureLayout& layout);

/**
 * The baked VAT as the pin's own texture, plus the settings block the
 * vertex stage reads its row range and clock from.
 *
 * The texture is `bakeVat`'s output byte for byte -- one live palette row
 * per animation frame -- so this uploads it once and then only follows the
 * settings and per-instance versions the handle's writers bump.
 */
void write_pinned_vat_texture(DawnState& state, DawnMesh& mesh, const MeshRecord& record,
                              const Engine& engine);
#endif

/**
 * The group-1 bind group for one variant of a mesh: the given mesh and
 * material blocks, then exactly the resources that variant declares --
 * shared by the main draw's slot and the geometry tasks' per-variant
 * states, which differ only in where their buffers live.
 */
WGPUBindGroup
build_pinned_draw_group(DawnState& state, DawnMesh& mesh, std::size_t variant,
                        WGPUBuffer mesh_uniforms, WGPUBuffer material_uniforms,
                        WGPUBuffer geometry_params,
                        // The material this group is built for, whose ESM caster view names the
                        // generator its `shadowParams` block belongs to.
                        [[maybe_unused]] const MaterialRecord* material = nullptr);

/** The per-draw buffers and group-1 bind group for one material's variant. */
DawnDrawState& ensure_pinned_draw_bindings(DawnState& state, DawnMesh& mesh, std::uint32_t material,
                                           std::size_t variant, const MaterialRecord* record);

/**
 * The per-draw buffers and group-1 bind group for one geometry-output MRT
 * variant of a mesh, keyed by variant beside `pinned_states`: the
 * encoder references the main group and every geometry group of a mesh in
 * the same frame, so none can replace another.
 */
DawnDrawState& ensure_pinned_geometry_bindings(DawnState& state, DawnMesh& mesh,
                                               std::size_t variant, WGPUBuffer geometry_params);

/**
 * The pin's two per-draw blocks for one resolved variant — the mesh block
 * (draw world + light selection) and the variant's own material UBO —
 * written to the caller's buffers. Shared by the main pass and the
 * geometry task.
 */
void write_pinned_draw_blocks(DawnState& state, const Scene& scene, const Engine& engine,
                              const upstream::RenderDrawCommand& draw, std::size_t variant,
                              DawnDrawState& draw_state);

/**
 * Writes one geometry task's pinned blocks for the frame.
 *
 * The shared geometry scene block carries the task's view-projection; the
 * task's gpUniforms holds last frame's matrix (seeded with the current one)
 * and the camera's near/far; and every PBR draw's mesh and material blocks
 * are written against the MRT variant the selector table keys on this task.
 */
void write_pinned_geometry_task(DawnState& state, const Scene& scene, const Engine& engine,
                                const FrameTaskRecord& task, DawnGeometryTask& geometry,
                                const upstream::RenderDrawLists& draw_lists);

#endif

// Fill and upload the pin's per-pass blocks.
//
// Every value is placed by generated code: `write_<kind>_light` is each light's
// own `_writeLightUbo`, and the scene block's members are the ones the pin's
// declaration names. Only the plumbing is here.
// Upload the pin's per-pass blocks. Both are built by the shared builders, so
// this backend decides only where they land: the scene block the pass
// retains (`pal::write_pass_scene_block`, which a camera-less pass leaves as
// it was) and the lights.
void write_pinned_frame_blocks(DawnState& state, const Scene& scene, const Engine& engine,
                               const upstream::SceneUniforms& scene_block);

/**
 * The instance-stepped streams one composed-variant draw reads.
 *
 * The pin's own thin-instance fragment names both: `ti-matrix` for the four
 * world columns and `ti-color` for the RGBA lane a coloured pool adds. A
 * draw with no pool leaves them null and instances once.
 */
struct InstanceStreams {
    WGPUBuffer matrices = nullptr;
    WGPUBuffer colors = nullptr;
    std::uint32_t count = 1;
};

/**
 * The streams one draw of `record` reads, from the buffers `mesh` holds.
 *
 * The pool tests and the `#if`s live here rather than at each of the encode
 * sites. A build with no instancing compiled in has no such buffers on
 * `DawnMesh` at all, which is why the whole body sits inside the guard
 * rather than the tests alone.
 */
[[maybe_unused]] InstanceStreams instance_streams_for([[maybe_unused]] const MeshRecord& record,
                                                      [[maybe_unused]] const DawnMesh& mesh);

/**
 * One composed-variant draw, encoded the same way at all four sites (PBR
 * and Standard, main pass and geometry task): bind the pipeline unless
 * already bound, the frame group at 0 and the draw group at 1, the
 * vertex stream (plus whichever thin-instance streams the pool carries),
 * then the indexed draw. Which pipeline, groups, buffers and counts go in
 * stays with each site; WebGPU forces the write/encode split, but the
 * duplication between the four encode arms did not.
 */
void encode_variant_draw(WGPURenderPassEncoder pass, WGPURenderPipeline pipeline,
                         WGPURenderPipeline& bound_pipeline, WGPUBindGroup frame_group,
                         WGPUBindGroup draw_group, WGPUBuffer vertex_buffer,
                         InstanceStreams instances, WGPUBuffer index_buffer,
                         std::uint32_t index_count,
                         // Group 2, bound only by a draw whose composed fragment declares it:
                         // the pin binds it under exactly the same test (`receiveShadows &&
                         // shadowBindGroup`).
                         WGPUBindGroup shadow_group = nullptr);
#endif

/**
 * The texture and view a render target hands a sampler.
 *
 * `rtt.ts` returns the colour attachment when the target has one and the
 * depth attachment otherwise, so the fork belongs to `has_color` -- the
 * record's own field, which the SDL backend reads for the same question.
 * Deriving it from whether a depth copy happens to exist would part from
 * that for a target carrying both.
 */
std::pair<WGPUTexture, WGPUTextureView> dawn_render_target_texture(DawnState& state,
                                                                   const Engine& engine,
                                                                   RenderTargetHandle target_handle,
                                                                   bool depth_only = false);

// The receiver's shared machinery: the samplers, the map view, and the two
// builders that read a composed group-2 row span. Both material families wrap
// one pinned shadow core, so their rows are one shape and this is one
// implementation; each family adds only its own cache vectors beside it.
#if BBLITE_SHADOW_RECEIVERS
/** The two samplers a receiver row may name, built once. */
void ensure_shadow_samplers(DawnState& state);

#if BBLITE_SHADOWS_ESM
inline WGPUTextureFormat esm_texture_format(upstream::EsmTextureFormat format) {
    return format == upstream::EsmTextureFormat::depth32_float ? WGPUTextureFormat_Depth32Float
                                                               : WGPUTextureFormat_RGBA16Float;
}

/**
 * One generator's blur halves and the pipeline that fills them.
 *
 * Every descriptor here is what the pinned factory asked its device for when
 * generation ran it: the two extents and their format, the bind-group
 * layout's three entries, and the two texel steps. Built once, on the frame
 * the generator's own map first exists.
 */
DawnState::EsmBlur& ensure_esm_blur(DawnState& state, WGPUTextureView source,
                                    std::uint32_t esm_index);

/** The pin's two blur passes, run straight after the caster pass. */
void run_esm_blur(DawnState& state, WGPUCommandEncoder encoder, WGPUTextureView source,
                  std::uint32_t esm_index);
#endif

/** The view a generator's map is sampled through. */
WGPUTextureView shadow_map_view(DawnState& state, const Engine& engine,
                                ShadowGeneratorHandle handle);

/**
 * The generators in `scene.lights` order, as a list a row's own light index
 * can be looked up in.
 *
 * That walk IS the ordinal every shadow row names, and it is the shared one:
 * the refresh that rebuilds these generators' matrices visits them in the
 * same order, and a second spelling could disagree.
 */
std::vector<ShadowGeneratorHandle> shadow_generators_in_light_order(const Scene& scene,
                                                                    const Engine& engine);

/**
 * One receiver row's layout entry.
 *
 * `createShadowFragment` and the node emitter alike pick each binding's TYPE
 * from its own light's filter, so a scene mixing an ESM directional with a
 * PCF spot declares a float texture and a plain sampler beside a depth
 * texture and a comparison one. The generated rows are the reflection of
 * that text, so neither the shape nor the stage visibility is decided here
 * -- and every family reads them through this one builder.
 */
WGPUBindGroupLayoutEntry shadow_layout_entry(const upstream::PinnedShadowBinding& row);

/** The resource one receiver row wants, from its role and its light. */
WGPUBindGroupEntry shadow_group_entry(DawnState& state, const Engine& engine,
                                      std::span<const ShadowGeneratorHandle> generators,
                                      const upstream::PinnedShadowBinding& row);

// From here to the end of this block: the two COMPOSED-VARIANT families'
// own group 2. A node receiver has none -- its rows continue the graph's
// own group 1 -- so a node-only scene compiles the two builders above and
// none of this.
#if BBLITE_STANDARD_SHADOWS || BBLITE_PBR_SHADOWS
/**
 * Group 2 for a shadow-receiving composed draw, from the composed rows.
 *
 * `createShadowFragment` numbers three bindings per shadow-casting light and
 * picks each one's TYPE from that light's own filter, so a scene mixing an
 * ESM directional with a PCF spot declares a float texture and a plain
 * sampler beside a depth texture and a comparison one -- in one group. The
 * generated shadow-binding rows are the reflection of that text, exactly as
 * group 1's are, so neither the shape nor the stage visibility is decided
 * here. `family` is `standard_shadow` or `pbr_shadow`.
 */
std::span<const upstream::PinnedShadowBinding> receiver_shadow_rows(DawnLayoutFamily family,
                                                                    std::size_t variant);

WGPUBindGroupLayout shadow_layout_for(DawnState& state, DawnLayoutFamily family,
                                      std::size_t variant);

/**
 * Group 2 itself, one per receiving variant and shared by every mesh drawn
 * through it -- which is the cache `rebuildSingle` keys by the layout for the
 * same reason. Each row names its role and its light, so the resource it
 * wants is a lookup rather than a name parse.
 */
WGPUBindGroup shadow_group_for(DawnState& state, const Scene& scene, const Engine& engine,
                               DawnLayoutFamily family, std::size_t variant);
#endif

#endif

#if !(BBLITE_STANDARD_SHADOWS || BBLITE_PBR_SHADOWS)
// A composed scene that reaches no generator: every call site still
// compiles, and each answers "no shadows" rather than being conditioned out.
[[maybe_unused]] inline WGPUBindGroupLayout shadow_layout_for(DawnState&, DawnLayoutFamily,
                                                              std::size_t) {
    return nullptr;
}
[[maybe_unused]] inline WGPUBindGroup shadow_group_for(DawnState&, const Scene&, const Engine&,
                                                       DawnLayoutFamily, std::size_t) {
    return nullptr;
}
#endif

#if BBLITE_SHADOW_RECEIVERS
/**
 * The per-frame half: the generators' matrices and their receiver blocks.
 *
 * When something decides here: the shared walk runs the pin's render gate
 * ahead of each fit, so a static generator's matrices — and this visitor's
 * block — keep their last-render values, the visitor is skipped outright,
 * and the task loop below skips the caster pass against the gate's `due`
 * verdict. On a due frame
 * `renderPcfShadowMap`'s rule applies: the light matrix is refit, the
 * receiver UBO re-uploads when its bytes moved, and the caster pass
 * renders through the biased copy.
 */
void write_shadow_generators(DawnState& state, const Scene& scene, Engine& engine);
#endif

#if BBLITE_STANDARD_VARIANTS > 0
/**
 * Group 1 for one Standard variant: the mesh block, the `mat` block, then
 * exactly the resources the composed stages declare — textures with their
 * samplers, the vertex `up` block, the geometry arms' `gp`, the morph
 * storage pair. `unfilterable_emissive` keys the depth-emissive trap: a
 * record whose emissive is the depth render texture binds eT as
 * unfilterable-float with a non-filtering sampler, and the two arms cannot
 * share a layout.
 */
WGPUBindGroupLayout standard_draw_layout_for(DawnState& state, std::size_t variant,
                                             bool unfilterable_emissive);

WGPUPipelineLayout standard_pipeline_layout_for(DawnState& state, std::size_t variant,
                                                bool unfilterable_emissive);

/**
 * The frame-graph attachments a Standard draw's own material samples.
 *
 * Both are resolved from the DRAW's material, at the encode, for the two
 * reasons that decide everything else about Standard draw state: an
 * override draw carries a material the mesh's own render item never names,
 * and the depth-copy views a target may hand back exist only once the
 * frame graph has built. Neither is read off the mesh, so a pass that
 * binds one states that it does.
 */
struct StandardRenderViews {
    WGPUTextureView emissive = nullptr;
    WGPUTextureView diffuse = nullptr;
};

/** The group-1 bind group for one Standard variant of a mesh. */
WGPUBindGroup
build_standard_draw_group(DawnState& state, DawnMesh& mesh, const MaterialRecord* material,
                          std::size_t variant, WGPUBuffer mesh_uniforms,
                          WGPUBuffer material_uniforms, WGPUBuffer uv_uniforms,
                          // Bound only when the composed variant declares the extension's block,
                          // which is a reflected binding name rather than a compile-time fact --
                          // the same shape `geometry_params` takes below.
                          [[maybe_unused]] WGPUBuffer uv_transform_uniforms,
                          WGPUBuffer geometry_params, StandardRenderViews render_views);

/** The per-draw uniform buffers for a mesh's Standard draws. */
DawnDrawState& ensure_standard_draw_buffers(DawnState& state, DawnMesh& mesh,
                                            std::uint32_t material);

/**
 * The attachments one material hands its Standard render-texture slots.
 *
 * Both reached writes -- `setStandardEmissiveTexture` and
 * `material.diffuseTexture` -- name a `createRenderTargetTexture` output,
 * and generation refuses any other source by name, so a reference reaching
 * here that is not a render target is a compiler contract broken rather
 * than a scene mistake.
 */
StandardRenderViews standard_render_views(DawnState& state, const Engine& engine,
                                          const MaterialRecord* material);

/**
 * Writes one Standard draw's pinned blocks for the frame; a geometry task's
 * draw passes its velocity history, updated for the frame.
 */
void write_standard_draw_blocks(DawnState& state, const Scene& scene, const Engine& engine,
                                const upstream::RenderDrawCommand& draw, WGPUBuffer mesh_uniforms,
                                DawnDrawState& material_state,
                                const PinnedVelocityHistory* velocity_history = nullptr);

/**
 * The Standard sibling of `write_pinned_geometry_task`: every Standard
 * draw in a geometry task's lists resolves its MRT variant, writes the
 * shared per-draw blocks, and builds a per-variant group carrying the
 * task's own `gp` buffer. Variants are per task by construction — the
 * selector keys on the task index — so the per-variant map cannot mix
 * two tasks' groups.
 */
[[maybe_unused]] void write_standard_geometry_task(DawnState& state, const Scene& scene,
                                                   const Engine& engine,
                                                   const FrameTaskRecord& task,
                                                   DawnGeometryTask& geometry,
                                                   const upstream::RenderDrawLists& draw_lists);
#endif

#if BBLITE_PBR_VARIANTS > 0
/**
 * The PBR family's pipeline layout, with the receiver's group 2 where the
 * variant composed one.
 *
 * Written beside the Standard one and after the shadow builders for the same
 * reason: a receiving variant's third group is the shadow family's, and both
 * families read the same rows.
 */
WGPUPipelineLayout pinned_pipeline_layout_for(DawnState& state, std::size_t variant);
#endif

/**
 * The ID-diagnostic program's stages: the scene vertex module and the two
 * diagnostic fragments, which declare the same groups.
 */
constexpr std::array<DawnLayoutStage, 3> diagnostic_stages{{
    {"pbr.vert", WGPUShaderStage_Vertex},
    {"diagnostic-id.frag", WGPUShaderStage_Fragment},
    {"diagnostic-cluster.frag", WGPUShaderStage_Fragment},
}};

/** One group of the diagnostic program's layout, as its stages declare it. */
WGPUBindGroupLayout diagnostic_group_layout(DawnState& state, std::uint32_t group);

WGPUPipelineLayout diagnostic_pipeline_layout(DawnState& state);

WGPUTextureSampleType shader_sample_type(upstream::ShaderSamplerSampleType type);

WGPUTextureViewDimension shader_view_dimension(upstream::ShaderSamplerViewDimension dimension);

/**
 * One ShaderMaterial group layout, following the generated reflection
 * exactly. The ordinary mesh layout cannot be a superset: custom storage
 * bindings occupy group 0 and fragment resources may be depth arrays or
 * storage buffers in group 2.
 */
WGPUBindGroupLayout shader_group_layout(DawnState& state, std::uint32_t variant, std::size_t group);

/** Pipeline layout for one generated ShaderMaterial reflection row. */
WGPUPipelineLayout shader_pipeline_layout_for(DawnState& state, std::uint32_t variant);

DawnPipeline& pipeline_for(DawnState& state, upstream::RenderPipelineKind kind,
                           std::uint32_t shader_variant = 0,
                           /** Zero asks for the frame's own sample count. */
                           std::uint32_t requested_samples = 0, bool has_depth = true,
                           bool shadow_pass = false, std::optional<DawnTaskTarget> target = {});

#if BBLITE_PINNED_MATERIALS
/** The attributes one composed variant declares, split by their stream. */
struct VariantVertexAttributes {
    std::vector<WGPUVertexAttribute> vertex;
    std::vector<WGPUVertexAttribute> instance_matrix;
    std::vector<WGPUVertexAttribute> instance_color;

    std::vector<WGPUVertexAttribute>& of(VertexInputStream stream) {
        switch (stream) {
        case VertexInputStream::instance_matrix:
            return instance_matrix;
        case VertexInputStream::instance_color:
            return instance_color;
        case VertexInputStream::vertex:
            break;
        }
        return vertex;
    }
};

/**
 * One declared vertex input, resolved onto our vertex and into Dawn's format
 * enum. The three composed families ask the same question of the same table
 * (`pinned_vertex_input`); what stays here is the enum residue and the split
 * across the vertex stream and the two instance-stepped ones.
 */
bool append_variant_attribute(std::string_view name, std::uint32_t location,
                              VariantVertexAttributes& inputs);

/**
 * The vertex buffer layouts one composed variant declares, and how many of
 * them it reaches.
 *
 * Which streams exist, at which slot, stride and step rate, is the shared
 * table's answer (`vertex_streams` and friends); what stays here is Dawn's
 * own layout shape. WebGPU takes a contiguous buffer list, so a variant
 * that reads the colour stream must declare the matrix one before it --
 * which the pin's own fragment guarantees, since `ti-color` exists only
 * beside `ti-matrix`.
 */
[[maybe_unused]] std::uint32_t
fill_variant_vertex_layouts(VariantVertexAttributes& inputs,
                            std::array<WGPUVertexBufferLayout, vertex_streams.size()>& layouts);
#endif

/**
 * The pass-dependent depth state, applied the same way by all three family
 * builders.
 *
 * `createShadowRenderTarget` is the pin's ONE exception to this port's
 * depth convention, and it moves the compare and the attachment format
 * together (the sample count arrives as `samples`, which the caster pass
 * already passes as the pin's own). A caster is drawn through whichever
 * family its own material belongs to, so a builder that answered this for
 * itself would be right only for the casters that family happens to own.
 */
[[maybe_unused]] void apply_pass_depth_state(WGPUDepthStencilState& depth_stencil, bool shadow_pass,
                                             std::optional<DawnTaskTarget> target);

#if BBLITE_PBR_VARIANTS > 0 || BBLITE_STANDARD_VARIANTS > 0 || BBLITE_NODE_GEOMETRY_VARIANTS > 0
/**
 * The MRT colour targets one geometry-output pipeline draws into, for
 * whichever family composed it.
 *
 * All three answer this the same way: one target per attachment class the
 * shared `geometry_target_classes` list carries, then the optional
 * trailing colour output in the frame's own format, with the geometry
 * pass's depth write forced on whatever the material's own alpha would
 * have said. `blend` is the family's transparent blend state, or null for
 * a draw that does not blend. The sample count is not touched: it reaches
 * the descriptor as this backend's `samples` argument, which the caller
 * already resolved from the task.
 *
 * The node family reaches the same body through a strict subset: a
 * geometry view is compiled at the pin's alpha mode 0 (so `blend` is null
 * and the depth write was already on) and `createNodeGeometryMaterialView`
 * refuses `emitColor`, so its task carries no trailing output -- and if one
 * ever did, the shared count assertion below refuses before a target is
 * built.
 *
 * `targets` is the caller's storage because `fragment` holds a pointer into
 * it until the pipeline is created.
 */
void apply_geometry_color_targets(WGPUFragmentState& fragment, WGPUDepthStencilState& depth_stencil,
                                  std::vector<WGPUColorTargetState>& targets,
                                  const DawnState& state, const FrameTaskRecord& task,
                                  std::size_t entry_color_target_count, const char* family,
                                  const WGPUBlendState* blend);
#endif

#if BBLITE_PBR_VARIANTS > 0
/**
 * The render pipeline for one composed variant.
 *
 * The stages are the pin's own text, deployed under `upstream/shaders/` like
 * every other module and entered at `main` — the name the pin gives both. Only
 * the fixed-function state is the PAL's, and it is the same state the
 * transcribed path uses for the same draw, so a difference between the two is a
 * difference in the shader rather than in how it is run.
 */
WGPURenderPipeline
pinned_variant_pipeline(DawnState& state, std::size_t variant, upstream::RenderPipelineKind kind,
                        std::uint32_t samples, bool has_depth,
                        // The geometry-output task an MRT variant draws in. A geometry variant
                        // is composed for exactly one task, so the variant-keyed cache stays
                        // valid with the task's targets baked into its pipeline.
                        const FrameTaskRecord* geometry_task = nullptr,
                        // The pin's one exception to this port's depth convention: a shadow
                        // caster pass renders standard-Z into the generator's own
                        // `depth32float` map. The Standard sibling takes the same flag -- a
                        // caster is drawn through whichever family its own material belongs
                        // to, so a depth state either family answered alone would be right
                        // only for the casters that family happens to own.
                        bool shadow_pass = false,
                        // Which ESM generator's map this pass writes, when it writes one. The
                        // colour format is that generator's own recorded row, so two generators
                        // whose factories returned different formats build different pipelines.
                        std::uint32_t esm_shadow_index = invalid_handle,
                        std::optional<DawnTaskTarget> target = {});
#endif

#if BBLITE_STANDARD_VARIANTS > 0
/**
 * The render pipeline for one composed Standard variant — the Standard
 * sibling of `pinned_variant_pipeline`. The kind carries the blend and
 * cull state the render plan bucketed (standard-pipeline.ts
 * getOrCreateStandardPipeline).
 */
WGPURenderPipeline standard_variant_pipeline(
    DawnState& state, std::size_t variant, upstream::RenderPipelineKind kind, std::uint32_t samples,
    bool has_depth, bool unfilterable_emissive, const FrameTaskRecord* geometry_task = nullptr,
    // The pin's one exception to this port's depth convention: a shadow
    // caster pass renders standard-Z into the generator's own
    // `depth32float` map.
    bool shadow_pass = false,
    // Which ESM generator's map this pass writes, when it writes one. The
    // colour format is that generator's own recorded row, so two generators
    // whose factories returned different formats build different pipelines.
    std::uint32_t esm_shadow_index = invalid_handle, std::optional<DawnTaskTarget> target = {});
#endif

#if BBLITE_NODE_VARIANTS > 0
/**
 * Group 1 for one node graph: the pin's mesh block, the graph's own uniform
 * block at whichever binding `compileNodePipeline` gave it, and the
 * environment pair a graph reaching `ReflectionBlock` declares.
 */
std::vector<WGPUBindGroupLayoutEntry>
node_draw_layout_entries(std::size_t slot, [[maybe_unused]] bool caster,
                         [[maybe_unused]] std::size_t geometry_variant);

WGPUBindGroupLayout
node_draw_layout_for(DawnState& state, std::size_t variant, bool caster,
                     std::size_t geometry_variant = pal::no_node_geometry_variant);

WGPUPipelineLayout
node_pipeline_layout_for(DawnState& state, std::size_t variant, bool caster,
                         std::size_t geometry_variant = pal::no_node_geometry_variant);

/**
 * The render pipeline for one compiled node graph.
 *
 * The module is the pin's, entered at its own `vs_main`/`fs_main`. Its
 * vertex inputs are named rather than positional — the pipeline builder
 * numbers them by emission order, so a graph reading uv first puts uv at
 * location 0 — which is why each is resolved onto our vertex by name here
 * and an unmapped one fails naming itself.
 */
WGPURenderPipeline
node_variant_pipeline(DawnState& state, std::size_t variant, upstream::RenderPipelineKind kind,
                      std::uint32_t samples, bool has_depth,
                      // The shadow target's own depth state, taken by every family: a node
                      // material casts through its own ESM view exactly as the Standard
                      // family does.
                      bool shadow_pass = false,
                      // Which of the graph's two compiled views this draws, and -- when it is
                      // the caster -- which ESM generator's map it writes, whose recorded row
                      // is the colour format.
                      bool caster = false, std::uint32_t esm_shadow_index = invalid_handle,
                      // The geometry-output task an MRT view draws in, with the composed view
                      // it resolved. A geometry module is composed for exactly ONE task, so
                      // the slot-keyed cache stays valid with that task's targets baked in.
                      [[maybe_unused]] const FrameTaskRecord* geometry_task = nullptr,
                      std::size_t geometry_variant = pal::no_node_geometry_variant,
                      std::optional<DawnTaskTarget> target = {});

/** The per-draw buffers one compiled node view needs, created once. */
void fill_node_draw_buffers(DawnState& state, DawnDrawState& draw_state,
                            const upstream::NodeVariantEntry& view);

/** The per-draw buffers a node graph's colour or caster view needs. */
DawnDrawState& ensure_node_draw_buffers(DawnState& state, DawnMesh& mesh, std::uint32_t material,
                                        const upstream::NodeVariantEntry& entry);

#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
/**
 * The same, for one geometry view.
 *
 * Keyed by the composed view rather than by the material: the view walked
 * the graph again and its uniform block is its own, so it can share neither
 * the colour state's buffers nor its bind group.
 */
DawnDrawState& ensure_node_geometry_draw_buffers(DawnState& state, DawnMesh& mesh,
                                                 std::size_t geometry_variant);
#endif

WGPUBindGroup build_node_draw_group(
    DawnState& state, [[maybe_unused]] const Scene& scene, [[maybe_unused]] const Engine& engine,
    DawnMesh& mesh, const DawnDrawState& draw_state, std::size_t variant,
    // Which of the graph's two compiled views, and the material that says
    // so -- an ESM caster view carries both the bit and its generator.
    bool caster = false, [[maybe_unused]] const MaterialRecord* material = nullptr,
    // The composed geometry view this draw is, when it is one; the task's
    // gpUniforms comes with it because only the encode knows which task.
    std::size_t geometry_variant = pal::no_node_geometry_variant,
    [[maybe_unused]] WGPUBuffer geometry_params = nullptr);

// The draw wrapper observes the same arguments passed to the shared encoder.
// It never reselects the variant, attributes, buffers, or per-view group.
void encode_node_variant_draw([[maybe_unused]] DawnState& state,
                              [[maybe_unused]] const upstream::RenderDrawCommand& draw,
                              WGPURenderPassEncoder pass, WGPURenderPipeline pipeline,
                              WGPURenderPipeline& bound_pipeline, WGPUBindGroup frame_group,
                              WGPUBindGroup draw_group, WGPUBuffer vertex_buffer,
                              InstanceStreams instances, WGPUBuffer index_buffer,
                              std::uint32_t index_count);

/**
 * One frame's composed node mesh blocks, memoised per mesh.
 *
 * A node mesh drawn in a geometry task is composed once for the colour pass
 * and once more per task, and every compose walks `scene.lights` again
 * (`pinned_mesh_light_selection`) for bytes the first walk already
 * produced. The queue WRITES are not redundant -- each compiled view owns
 * its own `mesh_uniforms` buffer -- so only the CPU compose is memoised
 * here.
 *
 * Keyed by the scene as well as the mesh because an overlay layer's draws
 * read their own scene's light selection and floating-origin frame, and the
 * frame's writer walks the base scene, its overlays and its graph layers in
 * turn. Held by that writer as a local: a mesh moves between frames, so a
 * memo outliving one would answer with the previous frame's world.
 */
struct NodeMeshBlockCache {
    const Scene* scene = nullptr;
    std::vector<upstream::NodeMeshUniforms> blocks;
    std::vector<std::uint8_t> composed;
};

const upstream::NodeMeshUniforms& node_mesh_block_for(NodeMeshBlockCache& cache, const Scene& scene,
                                                      const Engine& engine, MeshHandle mesh);

/**
 * The one block a node draw rebuilds: the pin's own `MeshU`, carrying the
 * world matrix the vertex stage multiplies by and the shadow and light lanes
 * a graph reaching neither leaves at zero. The uniform block the graph
 * declared is a constant, so `ensure_node_draw_buffers` writes it once.
 */
void write_node_mesh_block(DawnState& state, const upstream::NodeMeshUniforms& block,
                           const DawnDrawState& draw_state);

#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
/**
 * The node family's sibling of `write_pinned_geometry_task`.
 *
 * Every node draw in a geometry task's lists resolves the view composed for
 * THIS task, writes its own mesh block, and builds a per-view group carrying
 * the task's gpUniforms. Keyed per view by construction, so the per-view map
 * cannot mix two tasks' groups.
 */
void write_node_geometry_task(DawnState& state, NodeMeshBlockCache& mesh_blocks, const Scene& scene,
                              const Engine& engine, const FrameTaskRecord& task,
                              DawnGeometryTask& geometry,
                              const upstream::RenderDrawLists& draw_lists);
#endif
#endif

// Depth-only pipelines mirror SDL: the scene vertex module with the
// empty depth-only fragment, depth writes on, no color targets.
WGPURenderPipeline depth_only_pipeline_for(DawnState& state, bool double_sided,
                                           std::uint32_t samples, WGPUTextureFormat format);

// Geometry MRT pipelines mirror SDL: the per-task generated fragment
// modules over the shared vertex module, one color target per
// attachment plus the optional output target, LESS depth (writes off
// for the transparent variants, which also blend on every target).

// The pinned transmission scene-color grab and the pinned trailing image
// processing are deployed from generation like every other pinned shader,
// each in both of the pin's arms and each module whole: the grab is
// frame-graph/transmission.ts BLIT_MSAA_SHADER (per-texel sample average
// with manual bilinear filtering, read straight from the multisampled
// attachment) or, for a single-sample source, that module's own BLIT_SHADER
// over the bilinear sampler; the image processing is the module
// frame-graph/image-processing-task.ts composes for the source's sample
// count (exposure, optional tonemap, gamma, contrast applied per sample,
// then averaged).

// Encodes the pinned mid-pass scene-color grab: the fullscreen blit into
// transmission mip 0 followed by the standard blit mip chain.
void encode_transmission_grab(DawnState& state, WGPUCommandEncoder encoder);

// The pinned final pass: per-sample image processing of the linear
// multisampled frame straight into the surface (the payoff SDL_GPU
// could not express — it had to process the resolved pixel once).
void encode_image_processing(DawnState& state, WGPUCommandEncoder encoder,
                             WGPUTextureView surface_view, const Scene& scene);

// Copies a sampled depth attachment into an r32float color texture so
// material texture slots can read it exactly like the SDL backend's
// direct D3D12 depth SRV (r = depth, g/b = 0, a = 1). Pure PAL
// mechanics: WebGPU cannot bind a depth view where the generated
// shader expects a filterable float texture.
constexpr const char* depth_copy_wgsl =
    "@group(0)@binding(0)var t:texture_depth_2d;\n"
    "struct V{@builtin(position)p:vec4f};\n"
    "@vertex fn vs(@builtin(vertex_index)i:u32)->V{let "
    "p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i];return "
    "V(vec4f(p,0,1));}\n"
    "@fragment fn fs(v:V)->@location(0)vec4f{return "
    "vec4f(textureLoad(t,vec2u(v.p.xy),0),0,0,1);}";

void encode_depth_copy(DawnState& state, WGPUCommandEncoder encoder,
                       const DawnRenderTarget& target);

// Fullscreen-triangle copy used by frame-graph copy tasks.
WGPURenderPipeline blit_pipeline_for(DawnState& state, WGPUTextureFormat format,
                                     std::uint32_t samples);

WGPUBindGroup blit_group_for(DawnState& state, WGPURenderPipeline pipeline, WGPUTextureView source);

#if BBLITE_HAS_TAA
void retain_temporal_presentation(DawnState& state, WGPUCommandEncoder encoder, WGPUTexture surface,
                                  std::uint32_t width, std::uint32_t height);

void present_stopped_temporal_frame(DawnState& state, WGPUCommandEncoder encoder,
                                    WGPUTextureView surface);
#endif

/**
 * A mesh's groups for the ID-diagnostic program, built once over its
 * layout: each binding the program's stages declare (their `.slots`
 * layout lines) takes the resource that serves it. Group 1 carries the
 * vertex blocks, group 2 the texture/sampler pairs in the mesh's own slot
 * order -- pair n at bindings 2n and 2n + 1 -- and group 3 is the pass's
 * own per-draw block.
 */
DawnMeshBindings& diagnostic_bindings_for(DawnState& state, DawnMesh& mesh);

/**
 * The shared material stage's world and deformation blocks for one mesh, as
 * queue writes: what the diagnostic and depth-only draws read through
 * `serve_mesh_stage_binding`.
 */
void write_mesh_stage_blocks(DawnState& state, const Scene& scene, const Engine& engine,
                             const MeshRecord& mesh, const DawnMeshResources& gpu);

/**
 * One binding of the shared material stage's group 1 for a mesh drawn outside
 * its material pipeline -- the diagnostic and depth-only draws: the pass's
 * view-projection, the mesh's deformation block when deformation is compiled
 * in, and its world block at `mesh_world_uniform_binding`, both of which
 * `write_mesh_blocks` keeps current. False for a binding the stage does not
 * declare.
 */
bool serve_mesh_stage_binding(WGPUBindGroupEntry& entry, WGPUBuffer view_projection,
                              const DawnMeshResources& mesh);

/** Build the four reflected groups for an active ShaderMaterial draw. */
DawnShaderBindings& shader_bindings_for(DawnState& state, [[maybe_unused]] const Scene& scene,
                                        const Engine& engine, DawnMesh& mesh,
                                        MaterialHandle material_handle, std::uint32_t variant,
                                        WGPUBuffer pass_uniforms);

// ---------------------------------------------------------------------------
// Attribution captures (scene-1 diagnostics tooling): draw-id and
// triangle-cluster id buffers plus the PBR diagnostic MRT set, matching
// the SDL backend's save_geometry_id_buffer_png / save_pbr_diagnostic_
// buffers outputs byte-for-byte in layout and conversion semantics.

// The diagnostic pipelines reuse the scene vertex module and the
// superset mesh pipeline layout so the per-mesh bind groups from the
// main pass stay valid; only the fragment module, cull mode, sample
// count, and color target formats vary.
WGPURenderPipeline create_diagnostic_pipeline(DawnState& state, WGPUShaderModule fragment_module,
                                              bool double_sided, std::uint32_t samples,
                                              const WGPUTextureFormat* color_formats,
                                              std::uint32_t color_count);

// Downloads a diagnostic render target and stores it with the SDL
// backend's exact conversion semantics: rgba16float decodes through
// the manual half conversion (clamped to bytes), r16float lands in the
// red channel, rgba8unorm copies through, and the optional raw path
// dumps the unpadded rgba16float rows.
void save_dawn_texture_file(DawnState& state, WGPUTexture texture, WGPUTextureFormat format,
                            std::uint32_t width, std::uint32_t height, const std::string& path,
                            const std::string& raw_path = {});

void save_dawn_geometry_id_buffer(DawnState& state, std::uint32_t width, std::uint32_t height,
                                  const std::vector<upstream::RenderItem>& render_plan,
                                  const Engine& engine, const std::string& path, bool cluster_ids);

#if BBLITE_HAS_POST_PROCESS

/**
 * The program a post-process pass draws with, built once per distinct one.
 *
 * A pass is identified as a drawing by its deployed module, the pipeline state
 * its output implies, and the shape of its bind group; which textures fill
 * that shape and what its uniform block holds stay per pass. A composite's
 * chain repeats the first and varies the second, so depth of field's six
 * blurs share one entry here. The find-or-create walk is the shared
 * `find_or_create_program`; the key stays this backend's own -- its layout
 * bakes in the bind-group shape SDL_GPU's key never needs.
 */
std::size_t post_process_program(DawnState& state, const upstream::PostProcessShaderInfo& info,
                                 WGPUTextureFormat format, std::uint32_t samples,
                                 std::uint32_t alpha_mode, std::size_t extra_textures);

/**
 * One post-process pass, recorded into the frame's encoder.
 *
 * The pin runs every effect through the same pass -- a three-vertex draw over
 * the composed module its factory handed over -- so what this reads off the
 * record is the module, the textures it samples, the uniform block it writes,
 * and where it draws. `source_texture_view` resolves a frame-graph reference
 * the way every other task in this backend resolves one, so a pass sampling a
 * geometry attachment reaches it by the same path a render task would.
 *
 * A pass whose output is the swapchain draws straight into `surface_view`:
 * WebGPU lets a surface texture be a colour attachment, so no readable copy
 * stands between the pass and the present.
 */
void write_dawn_post_process_uniforms(DawnState& state, Engine& engine, TaskHandle handle,
                                      std::size_t index, std::uint32_t width, std::uint32_t height,
                                      bool force = false);

template <typename SourceTextureView>
PreparedDawnPostProcessPass
prepare_dawn_post_process_pass(DawnState& state, Engine& engine, TaskHandle handle,
                               std::uint32_t width, std::uint32_t height, std::size_t index,
                               SourceTextureView source_texture_view, bool write_uniforms = true) {
    PostProcessPassOptions& pass = handle_at(engine.frame_tasks, handle).post_process.passes[index];
    const upstream::PostProcessShaderInfo& info =
        upstream::post_process_shader_infos[pass.shader_index];
    DawnPostProcessTask& gpu = handle_at(state.post_process_tasks, handle)[index];
    const RenderTargetRecord& output_record = handle_at(engine.render_targets, pass.output_target);
    DawnRenderTarget& output = handle_at(state.render_targets, pass.output_target);
    const PostProcessExtent extent =
        resolve_post_process_extent(output_record, state.render_targets, pass, width, height);
    const std::uint32_t output_width = extent.output_width;
    const std::uint32_t output_height = extent.output_height;
    if (gpu.program == npos) {
        gpu.program = post_process_program(
            state, info, handle_at(state.render_targets, pass.output_target).color_format,
            output_record.swapchain ? 1u : task_sample_count(state, output_record.samples),
            pass.alpha_mode, pass.extra_textures.size());
        const DawnPostProcessProgram& created = state.post_process_programs[gpu.program];
        if (created.uniform_size > 0) {
            WGPUBufferDescriptor uniform_descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
            uniform_descriptor.size = created.uniform_size;
            uniform_descriptor.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
            gpu.uniforms = wgpuDeviceCreateBuffer(state.device, &uniform_descriptor);
        }
        std::vector<WGPUBindGroupEntry> group_entries;
        WGPUBindGroupEntry sampler_binding = WGPU_BIND_GROUP_ENTRY_INIT;
        sampler_binding.binding = 0;
        sampler_binding.sampler = pass.sampling == PostProcessSampling::nearest
                                      ? state.nearest_sampler
                                      : state.post_process_bilinear_sampler;
        group_entries.push_back(sampler_binding);
        WGPUBindGroupEntry texture_binding = WGPU_BIND_GROUP_ENTRY_INIT;
        texture_binding.binding = 1;
        texture_binding.textureView = source_texture_view(pass.source).second;
        group_entries.push_back(texture_binding);
        for (std::size_t extra = 0; extra < pass.extra_textures.size(); ++extra) {
            WGPUBindGroupEntry extra_binding = WGPU_BIND_GROUP_ENTRY_INIT;
            extra_binding.binding = 2u + static_cast<std::uint32_t>(extra);
            extra_binding.textureView = source_texture_view(pass.extra_textures[extra]).second;
            group_entries.push_back(extra_binding);
        }
        if (gpu.uniforms) {
            WGPUBindGroupEntry uniform_binding = WGPU_BIND_GROUP_ENTRY_INIT;
            uniform_binding.binding = info.uniform_binding;
            uniform_binding.buffer = gpu.uniforms;
            uniform_binding.size = created.uniform_size;
            group_entries.push_back(uniform_binding);
        }
        WGPUBindGroupDescriptor group_descriptor = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        group_descriptor.layout = created.group_layout;
        group_descriptor.entryCount = group_entries.size();
        group_descriptor.entries = group_entries.data();
        gpu.group = wgpuDeviceCreateBindGroup(state.device, &group_descriptor);
        pass.uniforms_dirty = true;
    }
    const DawnPostProcessProgram& program = state.post_process_programs[gpu.program];
    if (write_uniforms)
        write_dawn_post_process_uniforms(state, engine, handle, index, width, height);
    PreparedDawnPostProcessPass prepared;
    prepared.output = output.color_view;
    prepared.pipeline = program.pipeline;
    prepared.group = gpu.group;
    prepared.presents = output_record.swapchain;
    prepared.clear = pass.clear;
    if (pass.has_viewport)
        prepared.viewport =
            upstream::resolve_post_process_viewport(pass.viewport, output_width, output_height);
    return prepared;
}

void encode_dawn_post_process_pass(WGPUCommandEncoder encoder, WGPUTextureView surface_view,
                                   const PreparedDawnPostProcessPass& prepared);

template <typename SourceTextureView>
void record_post_process_pass(DawnState& state, Engine& engine, TaskHandle handle,
                              WGPUCommandEncoder encoder, WGPUTextureView surface_view,
                              std::uint32_t width, std::uint32_t height, std::size_t index,
                              SourceTextureView source_texture_view) {
    const auto prepared = prepare_dawn_post_process_pass(state, engine, handle, width, height,
                                                         index, source_texture_view);
    encode_dawn_post_process_pass(encoder, surface_view, prepared);
}
#endif

#if BBLITE_HAS_SCREEN_SPACE
/** Builds the entry `screen_space_program` below found missing. */
DawnScreenSpaceProgram build_screen_space_program(DawnState& state, std::uint32_t stage);

std::size_t screen_space_program(DawnState& state, std::uint32_t stage);

/**
 * The view a stage binding reads, by the role the pin bound there: the
 * depth attachment's depth-only view, the lit source colour, or one of the
 * task's owned targets.
 */
WGPUTextureView screen_space_binding_view(DawnState& state, const ScreenSpaceTaskOptions& task,
                                          upstream::ScreenSpaceTextureRole role);

/**
 * A pass over one temporal target, cleared to zero: what every dedicated
 * stage draws into and what the identity clear leaves empty.
 */
WGPURenderPassEncoder begin_screen_space_pass(WGPUCommandEncoder encoder, WGPUTextureView target);

/**
 * One dedicated stage: the block written to its buffer, the bind group
 * built over the frame-graph textures it names (the pin's
 * `rebuildProducerBindGroup`/`rebuildBindGroup` identity test, which here
 * the frame-graph rebuild answers by resetting the stage), then the pin's
 * clear-and-draw over a fullscreen triangle.
 */
void record_screen_space_stage(DawnState& state, const ScreenSpaceTaskOptions& task,
                               DawnScreenSpaceStage& stage, std::uint32_t stage_index,
                               WGPUCommandEncoder encoder, WGPUTextureView target,
                               const float* uniforms);

/** The pin's `clearIdentity`: one clear-only pass over a temporal target. */
void clear_screen_space_target(WGPUCommandEncoder encoder, WGPUTextureView view);

/**
 * One screen-space task, in the pin's own `execute` order: the generated
 * frame function samples the task's live settings and advances its temporal
 * state, and what it decided is encoded here -- the identity clear on the
 * enabled-to-disabled transition or a singular view-projection inverse,
 * then producer, resolve and history copy when the effect runs, then the
 * composite whenever the task has one.
 */
template <typename SourceTextureView>
void record_screen_space_task(DawnState& state, Engine& engine, TaskHandle handle,
                              WGPUCommandEncoder encoder, WGPUTextureView surface_view,
                              std::uint32_t width, std::uint32_t height,
                              SourceTextureView source_texture_view, bool& frame_graph_presented) {
    FrameTaskRecord& record = handle_at(engine.frame_tasks, handle);
    const ScreenSpaceTaskOptions& task = record.screen_space;
    DawnScreenSpaceTask& gpu = handle_at(state.screen_space_tasks, handle);
    const DawnRenderTarget& raw = handle_at(state.render_targets, task.raw);
    const DawnRenderTarget& stable = handle_at(state.render_targets, task.stable);
    const DawnRenderTarget& history = handle_at(state.render_targets, task.history);
    const ScreenSpaceFrameDecision decision = upstream::screen_space_frame(
        engine, handle, screen_space_frame_inputs(state.render_targets, task));
    record_screen_space_decision(
        decision, record.post_process.passes.size() > 1,
        [&](bool previous) {
            clear_screen_space_target(encoder, previous ? history.color_view : stable.color_view);
        },
        [&](bool producer, const float* uniforms) {
            record_screen_space_stage(state, task, producer ? gpu.producer : gpu.resolve,
                                      producer ? task.producer_shader : task.resolve_shader,
                                      encoder, producer ? raw.color_view : stable.color_view,
                                      uniforms);
        },
        [&](std::size_t child) {
            record_post_process_pass(state, engine, handle, encoder, surface_view, width, height,
                                     child, source_texture_view);
            if (child == 1u &&
                engine.render_targets.at(record.post_process.passes[1].output_target.value)
                    .swapchain) {
                frame_graph_presented = true;
            }
        });
}
#endif

} // namespace dawn_scene

#if BBLITE_HAS_PICKING
/**
 * The two pick pipelines. Both draw the pin's own attachment pair at one
 * sample with no blending; the mesh pass compares GREATER because this
 * renderer is reverse-Z, and the cloud pass compares LESS, which is what
 * its own pinned pipeline declares.
 */
WGPURenderPipeline create_dawn_pick_mesh_pipeline(
    WGPUDevice device, WGPUBindGroupLayout scene_layout, WGPUBindGroupLayout mesh_layout,
    const char* stem_vertex, const char* stem_fragment, std::uint32_t target_count,
    WGPUBindGroupLayout empty_layout = nullptr, WGPUBindGroupLayout deform_layout = nullptr,
    [[maybe_unused]] bool skeleton = false);

#if BBLITE_DEFORM_PICKING
/**
 * The two extra groups the pin's deform projection declares, and the
 * pipeline that binds them.
 *
 * `deform-picking-projection.ts` puts the projection at group 3 and says
 * why the empty group 2 exists beside it: bind group layouts must be
 * contiguous from 0, so a pick pipeline with no discard rule to fill
 * group 2 still has to declare one. Both are built here for the same
 * reason the pin builds them once per device -- they carry no per-mesh
 * state, only the shapes -- each laid out from what the variant's
 * modules declare in it (their `.slots` layout lines).
 */
std::vector<DawnLayoutStage> dawn_pick_deform_stages(const upstream::PickDeformVariant& variant);

/** Group 2, which no deform module declares: laid out empty. */
inline WGPUBindGroupLayout
create_dawn_pick_empty_layout(WGPUDevice device, const upstream::PickDeformVariant& variant) {
    return create_dawn_reflected_layout(device, dawn_pick_deform_stages(variant), 2);
}

/**
 * The projection's own group 3, as the variant's vertex modules declare it:
 * the bone palette, then the morph pair. Both modes of a variant share it.
 */
inline WGPUBindGroupLayout
create_dawn_pick_deform_layout(WGPUDevice device, const upstream::PickDeformVariant& variant) {
    return create_dawn_reflected_layout(device, dawn_pick_deform_stages(variant), 3);
}
#endif

#if BBLITE_HAS_SPLATS
WGPURenderPipeline create_dawn_pick_cloud_pipeline(WGPUDevice device,
                                                   WGPUBindGroupLayout scene_layout,
                                                   WGPUBindGroupLayout cloud_layout,
                                                   WGPUBindGroupLayout color_layout);
#endif
#endif

#if BBLITE_HAS_SPRITE_RENDERER
void sync_dawn_scene_sprites(DawnState& state, Engine& engine);
#endif

void recreate_dawn_scene_targets(DawnState& state, const Scene& scene, std::uint32_t width,
                                 std::uint32_t height);

#if BBLITE_PINNED_BACKGROUNDS
/** A DDS skybox's cube, every level the container carries. */
WGPUTexture upload_dawn_dds_skybox(DawnState& state, const EnvironmentState& environment);

WGPUTextureView dawn_cube_view(WGPUTexture texture);

/** A buffer over `bytes`, padded to the four-byte multiple a queue write takes. */
inline WGPUBuffer create_padded_buffer(DawnState& state, WGPUBufferUsage usage,
                                       std::vector<std::uint8_t> bytes) {
    bytes.resize((bytes.size() + 3u) & ~std::size_t{3});
    return create_buffer(state, usage, bytes.data(), bytes.size());
}

WGPUVertexFormat dawn_vertex_format(upstream::PinnedVertexFormat format);

/**
 * Build every background arm the run draws.
 *
 * The pipeline is the pin's own over the pass state: the arm's recorded
 * vertex layouts, cull, front face, depth write and blend, the pass's depth
 * compare and sample count, and a layout of the frame group (the pin's
 * `getSceneBindGroupLayout`) beside the arm's group 1, built from the entries
 * its factory passed to `createBindGroupLayout`. Each module enters at the
 * one entry point it declares for its stage. The texture an arm samples is
 * the one its factory binds: the ground's own image, the DDS skybox's cube,
 * the environment's specular cube for the .env arm, the image skybox's six
 * faces.
 */
void initialize_dawn_backgrounds(DawnState& state, const Scene& scene);

/** Draw one arm the way the pin's renderable does, over `frame_group`. */
void draw_dawn_background_arm(WGPURenderPassEncoder pass, const DawnBackgroundArm& arm,
                              WGPUBindGroup frame_group);
#endif
#if BBLITE_HAS_PBR_RENDERER
DawnMesh upload_dawn_scene_mesh(DawnState& state, Engine& engine, const upstream::RenderItem& item);
#endif

#if BBLITE_HAS_PBR_RENDERER && BBLITE_HAS_PICKING
PickingInfo pick_dawn_scene(DawnState& state, Engine& engine, const upstream::RenderPlan& root_plan,
                            const std::vector<upstream::RenderPlan>& overlay_plans,
                            const std::vector<std::shared_ptr<Scene>>& active_registered_scenes,
                            [[maybe_unused]] GpuPickerHandle picker, double x, double y,
                            const Engine::PickFilter* filter
#if BBLITE_HAS_BILLBOARDS
                            ,
                            DawnBillboardPickContributor& billboard_pick
#endif
);
#endif

} // namespace bbl::pal

#endif
