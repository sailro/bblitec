// Dawn renders generated WGSL directly through the Tint-pinned WebGPU runtime.

#include <bblite/pal.hpp>
#include <bblite/pal_gpu.hpp>
#include <bblite/pal_image.hpp>
#include <bblite/runtime.hpp>
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI && !(defined(BBLITE_WORKERS) && BBLITE_WORKERS)
#include <bblite/pal_ui.hpp>
#endif

// The scene renderer needs a scene: its camera math and render plan are
// generated only for a scene that registers one. A sprite-only scene
// registers a SpriteRenderer instead and draws through
// `pal_dawn_sprite.cpp`, so this translation unit compiles to nothing.
#if defined(BBLITE_HAS_DAWN) && BBLITE_HAS_DAWN && \
    defined(BBLITE_HAS_PBR_RENDERER) && BBLITE_HAS_PBR_RENDERER

#include <bblite/upstream/camera_math.hpp>
// The pin's own inverse image processing, for the linear-frame clear color.
#include <bblite/upstream/pinned_inverse_image_processing.hpp>
#if defined(BBLITE_HAS_GEOMETRY_OUTPUT) && BBLITE_HAS_GEOMETRY_OUTPUT
#include <bblite/upstream/frame_graph_geometry.hpp>
#endif
#if defined(BBLITE_HAS_POST_PROCESS) && BBLITE_HAS_POST_PROCESS
#include <bblite/upstream/frame_graph_post_process.hpp>
#include <bblite/upstream/post_process_shaders.hpp>
#endif
#include <bblite/upstream/render_capabilities.hpp>
#include <bblite/upstream/renderer_plan.hpp>
#if defined(BBLITE_HAS_CLUSTERED_LIGHTS) && BBLITE_HAS_CLUSTERED_LIGHTS
#include <bblite/upstream/clustered_light.hpp>
#include "pal_dawn_clustered.hpp"
#endif

#include "pal_camera_controls.hpp"
#include "pal_dawn_shared.hpp"
#if BBLITE_OFFSCREEN_SURFACES
#include "pal_dawn_offscreen.hpp"
#endif
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI && !(defined(BBLITE_WORKERS) && BBLITE_WORKERS)
#include "pal_ui_backdrop_dawn.hpp"
#include "pal_ui_filter_dawn.hpp"
#endif
#if BBLITE_HAS_BILLBOARDS
#include "pal_dawn_billboard.hpp"
#endif
#if defined(BBLITE_HAS_SPRITE_RENDERER) && BBLITE_HAS_SPRITE_RENDERER
#include "pal_dawn_sprite.hpp"
#endif
#if BBLITE_HAS_SPLATS
#include "pal_dawn_splat.hpp"
#endif
#if BBLITE_HAS_PICKING
#include "pal_dawn_picking.hpp"
#endif
#if defined(BBLITE_HAS_EFFECT_TASK) && BBLITE_HAS_EFFECT_TASK
#include "pal_dawn_effect.hpp"
#endif
#include "pal_gpu_shared.hpp"
#include "pal_frame_session.hpp"
#if defined(BBLITE_HAS_TEXT) && BBLITE_HAS_TEXT
#include "pal_dawn_text.hpp"
#endif
#if defined(BBLITE_HAS_TAA) && BBLITE_HAS_TAA
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
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace bbl::pal {

namespace {

struct DawnMeshBindings {
    DawnBindGroup scene{};
    DawnBindGroup textures{};
    DawnBindGroup material{};
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
        if (variant != other.variant) return variant < other.variant;
        if (material != other.material) return material < other.material;
        return std::less<WGPUBuffer>{}(pass_uniforms, other.pass_uniforms);
    }
};

void release_dawn_shader_bindings(DawnShaderBindings& bindings) {
    if (bindings.material) bindings.material.reset();
    if (bindings.resources) bindings.resources.reset();
    if (bindings.scene) bindings.scene.reset();
    if (bindings.storage) bindings.storage.reset();
    bindings = {};
}

// dawn_blend_factor / blend_state_from moved to pal_dawn_shared.hpp so
// the family headers can translate the shared blend tuples too.

/** The shared cull enum in this API's; the pipeline-kind facts come from
 *  `pipeline_kind_traits` (pal_gpu_shared.hpp). */
WGPUCullMode dawn_cull_mode(upstream::RenderCullMode cull) {
    return cull == upstream::RenderCullMode::none
        ? WGPUCullMode_None
        : WGPUCullMode_Back;
}

/**
 * The pin's `executePassBody` opening, mirrored from the SDL backend: a
 * camera carrying a viewport narrows the pass to it, and one without
 * leaves the pass at the whole target the way `if (v)` leaves it.
 *
 * Set AFTER the pass begins, exactly where upstream sets it, so the load
 * operation has already cleared or loaded the whole attachment.
 */
void set_pass_camera_viewport(
    WGPURenderPassEncoder pass,
    const Scene& scene,
    const Engine& engine,
    const CameraRecord& camera,
    std::uint32_t target_width,
    std::uint32_t target_height) {
    const std::optional<PixelViewport> resolved = scene_camera_viewport(
        engine, scene, camera, target_width, target_height);
    if (!resolved.has_value()) return;
    const PixelViewport& rect = *resolved;
    wgpuRenderPassEncoderSetViewport(
        pass,
        static_cast<float>(rect.x),
        static_cast<float>(rect.y),
        static_cast<float>(rect.width),
        static_cast<float>(rect.height),
        0.0f,
        1.0f);
    wgpuRenderPassEncoderSetScissorRect(
        pass,
        static_cast<std::uint32_t>(rect.x),
        static_cast<std::uint32_t>(rect.y),
        static_cast<std::uint32_t>(rect.width),
        static_cast<std::uint32_t>(rect.height));
}

// Vertex uniform bindings in group 1 mirror the SDL vertex uniform
// slots: 0 = viewProjection, 1 = deformation, then the instance
// parent world matrix.
#if BBLITE_GPU_INSTANCING
#if BBLITE_GPU_DEFORMATION
constexpr std::uint32_t instance_uniform_binding = 2;
#else
constexpr std::uint32_t instance_uniform_binding = 1;
#endif
#endif

// The mesh-owned slot order, the per-slot sRGB rules and fallback texels,
// and the pinned binding names all live in the generated
// `material_texture_slots` table (material_texture_slots.hpp) both
// backends execute; the constants below only size this backend's arrays
// and place the transcribed bind path's pairs, and the static_assert under
// them keeps the two in step.
#if BBLITE_RENDERER_TRANSMISSION
constexpr std::size_t transmission_texture_slots = 2;
// The bound trio is one pair wider than the mesh-owned slots: the
// scene-color pair rebinds the base color when no grab exists.
constexpr std::size_t transmission_texture_pairs = 3;
#else
constexpr std::size_t transmission_texture_slots = 0;
constexpr std::size_t transmission_texture_pairs = 0;
#endif
constexpr std::size_t material_extension_slots =
    (BBLITE_MATERIAL_CLEARCOAT ? 3 : 0) +
    (BBLITE_MATERIAL_SHEEN ? 2 : 0) +
    (BBLITE_MATERIAL_IRIDESCENCE ? 2 : 0) +
    (BBLITE_MATERIAL_METALLIC_REFLECTANCE_MAP ? 1 : 0) +
    (BBLITE_MATERIAL_REFLECTANCE_MAP ? 1 : 0) +
    (BBLITE_MATERIAL_ANISOTROPY_MAP ? 1 : 0) +
    (BBLITE_MATERIAL_TRANSLUCENCY_COLOR_MAP ? 1 : 0) +
    (BBLITE_MATERIAL_TRANSLUCENCY_INTENSITY_MAP ? 1 : 0) +
    (BBLITE_MATERIAL_SPEC_GLOSS ? 1 : 0) +
    (BBLITE_MATERIAL_OCCLUSION_UV2 ? 1 : 0) +
    (BBLITE_MATERIAL_LIGHTMAP ? 1 : 0);
constexpr std::size_t material_extension_slot_base =
    5 + transmission_texture_slots;
// The Standard bump pair appends after everything the PBR path owns, so a
// scene that compiles it shifts no existing slot or binding index.
constexpr std::size_t standard_bump_slots =
    BBLITE_MATERIAL_STANDARD_BUMP ? 1 : 0;
[[maybe_unused]] constexpr std::size_t standard_bump_slot =
    5 + transmission_texture_slots + material_extension_slots;
// The Standard 2D reflection slot appends after bump the same way (the
// generated slot table's own order); only the composed variant bind path
// consults it, through its generated slot index.
constexpr std::size_t standard_reflection_slots =
    BBLITE_MATERIAL_STANDARD_REFLECTION ? 1 : 0;
constexpr std::size_t mesh_texture_slots =
    5 + transmission_texture_slots + material_extension_slots +
    standard_bump_slots + standard_reflection_slots;
static_assert(
    mesh_texture_slots == upstream::material_texture_mesh_slots,
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
    /** The pinned arm's vertex choice; `pinned_draw_conventions` states it. */
    bool mirrored_vertices = false;
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
    // state cache; every other family owns its baked buffers as before.
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
    // The same vertices unmirrored, paired with the mirroring world matrix in
    // the mesh block. `load-gltf.ts` states the convention it expects: "Keep
    // vertex data as-is from glTF — RH→LH conversion handled by root world
    // matrix". Our loader instead mirrors X into the vertices and reconciles
    // `tangent.w` against that, so a bitangent built with `cross()` inside the
    // pin's own vertex stage comes out negated unless the conversion is undone.
    WGPUBuffer pinned_vertices = nullptr;
    // The instance matrices in Babylon's own convention, for the pin's
    // thin-instance arm. `pinned_instance_matrices` states the conversion;
    // aliased to `instances` for thin-instanced meshes, owned otherwise.
    WGPUBuffer pinned_instances = nullptr;
    // Whether this frame's pinned draw reads the mirrored buffer: skinned
    // draws and palette-world animated meshes both do.
    bool pinned_mirrored_vertices = false;
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

#if BBLITE_PBR_VARIANTS > 0 || defined(BBLITE_STANDARD_SKELETON)
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
    std::uint64_t transform_version = 0;
    bool gpu_world_transform = false;
#if BBLITE_GPU_DEFORMATION
    WGPUBuffer deformation_uniforms = nullptr;
#endif
#if BBLITE_GPU_INSTANCING
    WGPUBuffer instances = nullptr;
    #if BBLITE_HAS_PICKING
    WGPUBindGroup thin_pick_group = nullptr;
    WGPUBuffer thin_pick_uniform_buffer = nullptr;
    WGPUBuffer thin_pick_instances = nullptr;
    std::uint64_t thin_pick_bound_size = 0;

    void release_thin_pick_group() {
        if (thin_pick_group) wgpuBindGroupRelease(thin_pick_group);
        thin_pick_group = nullptr;
        thin_pick_uniform_buffer = nullptr;
        thin_pick_instances = nullptr;
        thin_pick_bound_size = 0;
    }
    #endif
    WGPUBuffer instance_uniform = nullptr;
    std::uint32_t instance_count = 1;
    std::uint64_t instance_version = 0;
    // How many instance rows the buffers were allocated for. A live pool
    // can double past it (`addThinInstance`), and matrices, the pinned
    // mirror-conjugated copy and the colour lane are all sized from this
    // one count, so `thin_instance_pool_grew` recreates them together.
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
    std::map<upstream::RenderPipelineKind, DawnMeshBindings> bindings;
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
    std::size_t users = 0;
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

void release_dawn_composed_material_textures(
    DawnSharedComposedMaterialTextures& textures) {
    for (std::size_t slot = 0; slot < mesh_texture_slots; ++slot) {
        if (textures.views[slot]) {
            textures.views[slot].reset();
        }
        if (textures.textures[slot]) {
            textures.textures[slot].reset();
        }
        if (textures.samplers[slot]) {
            textures.samplers[slot].reset();
        }
    }
}

[[nodiscard]] const std::vector<DawnSampledTexture>&
mesh_shader_textures(const DawnMesh& mesh) {
    return mesh.shared_shader_textures
        ? mesh.shared_shader_textures->textures
        : mesh.shader_textures;
}

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
    /**
     * Which build of the frame graph created these textures, numbered per
     * target: the identity a screen-space effect compares its bound
     * textures by (`ScreenSpaceFrameInputs`). Zero until first created.
     */
    std::uint32_t allocation = 0;
};

struct DawnRenderTask {
    DawnBuffer skybox_matrix{};
    DawnBindGroup skybox_scene_group{};
    upstream::RenderDrawLists draw_lists;
    DawnBuffer view_projection{};
    // Lazily created group-1 bind group for depth-only passes.
    DawnBindGroup scene_group{};
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
    /** Set with the textures: another task binds this task's depth. */
    bool depth_borrowed = false;
};

#if defined(BBLITE_HAS_POST_PROCESS) && BBLITE_HAS_POST_PROCESS
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
struct DawnPostProcessProgram {
    std::uint32_t module_index = 0;
    WGPUTextureFormat format = WGPUTextureFormat_Undefined;
    std::uint32_t samples = 1;
    std::uint32_t alpha_mode = 0;
    std::size_t extra_textures = 0;
    std::uint32_t uniform_binding = 0;
    std::uint32_t uniform_size = 0;
    DawnShaderModule module{};
    DawnBindGroupLayout group_layout{};
    DawnPipelineLayout pipeline_layout{};
    DawnRenderPipeline pipeline{};
};

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
#if defined(BBLITE_HAS_TAA) && BBLITE_HAS_TAA
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

#if defined(BBLITE_HAS_SCREEN_SPACE) && BBLITE_HAS_SCREEN_SPACE
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

#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI && !(defined(BBLITE_WORKERS) && BBLITE_WORKERS)
using DawnUiTexture = UiDawnTexture;

/** Dawn-owned realization of the backend-neutral RmlUi frame. */
struct DawnUiResources {
    UiBackdropDawnResources backdrop;
    UiFilterDawnResources filters;
    WGPUBindGroupLayout screen_layout = nullptr;
    WGPUBindGroupLayout texture_layout = nullptr;
    WGPUPipelineLayout pipeline_layout = nullptr;
    WGPURenderPipeline color_pipeline = nullptr;
    WGPURenderPipeline texture_pipeline = nullptr;
    WGPURenderPipeline composite_pipeline = nullptr;
    WGPUSampler sampler = nullptr;
    WGPUSampler nearest_sampler = nullptr;
    WGPUBuffer screen = nullptr;
    WGPUBindGroup screen_group = nullptr;
    WGPUTexture layer = nullptr;
    WGPUTextureView layer_view = nullptr;
    WGPUTexture multisample_layer = nullptr;
    WGPUTextureView multisample_layer_view = nullptr;
    WGPUBindGroup layer_group = nullptr;
    WGPUBuffer vertices = nullptr;
    WGPUBuffer indices = nullptr;
    std::unordered_map<std::uint64_t, DawnUiTexture> textures;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    std::uint64_t vertex_capacity = 0;
    std::uint64_t index_capacity = 0;

    void release() {
        backdrop.release();
        filters.release();
        for (auto& [id, source] : textures) {
            static_cast<void>(id);
            source.release();
        }
        textures.clear();
        if (indices) wgpuBufferRelease(indices);
        if (vertices) wgpuBufferRelease(vertices);
        if (layer_group) wgpuBindGroupRelease(layer_group);
        if (multisample_layer_view) {
            wgpuTextureViewRelease(multisample_layer_view);
        }
        if (multisample_layer) wgpuTextureRelease(multisample_layer);
        if (layer_view) wgpuTextureViewRelease(layer_view);
        if (layer) wgpuTextureRelease(layer);
        if (screen_group) wgpuBindGroupRelease(screen_group);
        if (screen) wgpuBufferRelease(screen);
        if (sampler) wgpuSamplerRelease(sampler);
        if (nearest_sampler) wgpuSamplerRelease(nearest_sampler);
        if (composite_pipeline) {
            wgpuRenderPipelineRelease(composite_pipeline);
        }
        if (texture_pipeline) wgpuRenderPipelineRelease(texture_pipeline);
        if (color_pipeline) wgpuRenderPipelineRelease(color_pipeline);
        if (pipeline_layout) wgpuPipelineLayoutRelease(pipeline_layout);
        if (texture_layout) wgpuBindGroupLayoutRelease(texture_layout);
        if (screen_layout) wgpuBindGroupLayoutRelease(screen_layout);
        *this = {};
    }
};
#endif

#if BBLITE_PBR_VARIANTS > 0 || BBLITE_STANDARD_VARIANTS > 0 || \
    BBLITE_NODE_VARIANTS > 0
/**
 * One composed family's cache released in dependents-first order:
 * pipelines, then the pipeline layouts built over the bind-group
 * layouts, then those layouts and the modules. The PBR, Standard and
 * node families each keep the same five containers, so the order lives
 * once instead of three times.
 */
void release_variant_family(
    std::map<std::uint32_t, std::map<std::size_t, WGPURenderPipeline>>&
        pipelines,
    std::vector<WGPUPipelineLayout>& pipeline_layouts,
    std::vector<WGPUBindGroupLayout>& draw_layouts,
    std::vector<WGPUShaderModule>& fragment_modules,
    std::vector<WGPUShaderModule>& vertex_modules) {
    for (auto& [key, by_variant] : pipelines) {
        static_cast<void>(key);
        for (auto& [variant, pipeline] : by_variant) {
            static_cast<void>(variant);
            if (pipeline) wgpuRenderPipelineRelease(pipeline);
        }
    }
    for (WGPUPipelineLayout layout : pipeline_layouts) {
        if (layout) wgpuPipelineLayoutRelease(layout);
    }
    for (WGPUBindGroupLayout layout : draw_layouts) {
        if (layout) wgpuBindGroupLayoutRelease(layout);
    }
    for (WGPUShaderModule module : fragment_modules) {
        if (module) wgpuShaderModuleRelease(module);
    }
    for (WGPUShaderModule module : vertex_modules) {
        if (module) wgpuShaderModuleRelease(module);
    }
}
#endif

struct DawnState : DawnDevice {
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
    NodeCaptureState node_capture;
#endif
#if defined(BBLITE_HAS_TEXT) && BBLITE_HAS_TEXT
    std::unique_ptr<DawnTextRenderer> text;
#endif
#if defined(BBLITE_HAS_CLUSTERED_LIGHTS) && BBLITE_HAS_CLUSTERED_LIGHTS
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
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI && !(defined(BBLITE_WORKERS) && BBLITE_WORKERS)
    DawnUiResources ui;
#endif
#if BBLITE_HAS_BILLBOARDS
    std::vector<DawnBillboardPass> billboard_passes;
#endif
#if defined(BBLITE_HAS_SPRITE_RENDERER) && BBLITE_HAS_SPRITE_RENDERER
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

    [[nodiscard]] bool multisampled() const {
        return sample_count > 1;
    }
    WGPUTexture msaa_color = nullptr;
    WGPUTextureView msaa_color_view = nullptr;
    WGPUSampler transmission_sampler = nullptr;
    WGPUTexture transmission_color = nullptr;
    WGPUTextureView transmission_color_view = nullptr;
    std::uint32_t transmission_mip_count = 1;
    WGPUShaderModule transmission_grab_vertex_module = nullptr;
    WGPUShaderModule transmission_grab_fragment_module = nullptr;
    WGPURenderPipeline transmission_grab_pipeline = nullptr;
    WGPUShaderModule image_processing_vertex_module = nullptr;
    WGPUShaderModule image_processing_fragment_module = nullptr;
    WGPURenderPipeline image_processing_pipeline = nullptr;
    WGPUBuffer image_processing_params = nullptr;
    WGPUBindGroup image_processing_group = nullptr;
    WGPUTexture depth = nullptr;
    WGPUTextureView depth_view = nullptr;
    WGPUShaderModule vertex_module = nullptr;
    WGPUShaderModule pbr_module = nullptr;
    WGPUShaderModule grid_vertex_module = nullptr;
    WGPUShaderModule grid_fragment_module = nullptr;
    // Lazily loaded per generated shader variant, indexed by variant id.
    std::vector<WGPUShaderModule> shader_vertex_modules;
    std::vector<WGPUShaderModule> shader_fragment_modules;
    // ShaderMaterial layouts follow the generated reflection exactly. The
    // ordinary mesh layout cannot be a superset: custom storage bindings
    // occupy group 0 and fragment resources may be depth arrays or storage
    // buffers in group 2.
    std::vector<std::array<WGPUBindGroupLayout, 4>> shader_group_layouts;
    std::vector<WGPUPipelineLayout> shader_pipeline_layouts;
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
            if (array_view) wgpuTextureViewRelease(array_view);
            if (cube_view) wgpuTextureViewRelease(cube_view);
            if (texture) wgpuTextureRelease(texture);
            if (uniform) wgpuBufferRelease(uniform);
            if (grid) wgpuBufferRelease(grid);
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
#if defined(BBLITE_HAS_EFFECT_TASK) && BBLITE_HAS_EFFECT_TASK
    // One built pass per effect render task, keyed by task index and built
    // lazily against the target's own format and sample count -- the pin
    // keys its own pipeline cache by exactly that pair.
    std::vector<DawnEffectPass> effect_tasks;
#endif
    // Frame graph state.
    std::vector<DawnRenderTarget> render_targets;
    /** The last `DawnRenderTarget::allocation` handed out. */
    std::uint32_t render_target_allocations = 0;
#if defined(BBLITE_DEVICE_RECOVERY) && BBLITE_DEVICE_RECOVERY
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
#if defined(BBLITE_HAS_POST_PROCESS) && BBLITE_HAS_POST_PROCESS
    // Per frame task, one entry per pass it records.
    std::vector<std::vector<DawnPostProcessTask>> post_process_tasks;
    /** The distinct programs those passes draw with. */
    std::vector<DawnPostProcessProgram> post_process_programs;
#if defined(BBLITE_HAS_TAA) && BBLITE_HAS_TAA
    WGPUTexture temporal_presented = nullptr;
    WGPUTextureView temporal_presented_view = nullptr;
    WGPUBindGroup temporal_presented_group = nullptr;
#endif
#endif
#if defined(BBLITE_HAS_SCREEN_SPACE) && BBLITE_HAS_SCREEN_SPACE
    /** The distinct producer/resolve stages the screen-space tasks draw. */
    std::vector<DawnScreenSpaceProgram> screen_space_programs;
    // Per frame task, a screen-space task's two stages.
    std::vector<DawnScreenSpaceTask> screen_space_tasks;
#endif
#if defined(BBLITE_HAS_POST_PROCESS) && BBLITE_HAS_POST_PROCESS
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
    std::array<std::array<WGPURenderPipeline, 2>, 2>
        depth_only_pipelines{};
    // Blit pipelines keyed by target (format, samples).
    std::map<std::pair<WGPUTextureFormat, std::uint32_t>,
        WGPURenderPipeline>
        blit_pipelines;
    // Mesh pipelines for render-task targets that differ from the
    // main pass, keyed by [multisampled][has depth]; the main 4x set
    // stays in `pipelines`.
    std::array<
        std::array<
            std::map<
                std::pair<
                    upstream::RenderPipelineKind,
                    std::uint32_t>,
                DawnPipeline>,
            2>,
        2>
        task_pipelines{};
    std::uint32_t frame_graph_width = 0;
    std::uint32_t frame_graph_height = 0;
    // Explicit bind group layouts shared by every mesh pipeline
    // (main, task, and geometry): WebGPU allows layout bindings the
    // shader does not use, so one superset layout keeps all mesh bind
    // groups interchangeable across shader variants.
    std::array<WGPUBindGroupLayout, 4> mesh_group_layouts{};
    WGPUPipelineLayout mesh_pipeline_layout = nullptr;

#if BBLITE_PINNED_MATERIALS
    // Babylon Lite's own grouping, which its composed fragments declare:
    // group 0 carries the per-pass scene block and the lights array, group 1
    // the per-draw mesh and material blocks followed by the material's texture
    // pairs from binding 3. Kept beside the layouts above while the variant
    // path is brought up, so both can be measured against the same goldens.
    // Group 0 is shared by every variant of both composed families; group 1
    // is not — the pin assigns its texture bindings densely per variant, so
    // the same index names a different texture in two of them and each needs
    // its own layout.
    WGPUBindGroupLayout pinned_frame_layout = nullptr;
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
    /** Per receiving variant: two variants can declare different rows. */
    std::vector<WGPUBindGroupLayout> shadow_layouts;
    std::vector<WGPUBindGroup> shadow_groups;
    /** The same, over the PBR family's own variant table. */
    std::vector<WGPUBindGroupLayout> pbr_shadow_layouts;
    std::vector<WGPUBindGroup> pbr_shadow_groups;
#if BBLITE_SHADOWS_ESM
    /**
     * One ESM generator's separable blur, built from what its own factory
     * recorded. The pin blurs the ESM map horizontally into `blur_h` and
     * then vertically into `blur_v`, and `blur_v` IS `sg._depthTexture` --
     * the texture the receiver samples.
     */
    struct EsmBlur {
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

#if BBLITE_PBR_VARIANTS > 0
    std::vector<WGPUBindGroupLayout> pinned_draw_layouts;
    std::vector<WGPUPipelineLayout> pinned_pipeline_layouts;
#endif
#if BBLITE_NODE_VARIANTS > 0
    // The node family's layouts, modules and pipelines. A graph's group-1
    // bindings are its own, so each carries its own layout.
    std::vector<WGPUBindGroupLayout> node_draw_layouts;
    std::vector<WGPUPipelineLayout> node_pipeline_layouts;
    std::vector<WGPUShaderModule> node_vertex_modules;
    std::vector<WGPUShaderModule> node_fragment_modules;
    std::map<std::uint32_t, std::map<std::size_t, WGPURenderPipeline>>
        node_variant_pipelines;
#endif
#if BBLITE_STANDARD_VARIANTS > 0
    // The Standard family's composed layouts, modules and pipelines. The
    // draw layout is keyed (variant * 2 + unfilterable-emissive): a
    // depth-sampled emissive render texture binds eT as unfilterable-float
    // with a non-filtering sampler, and the two arms cannot share a layout.
    std::vector<WGPUBindGroupLayout> standard_draw_layouts;
    std::vector<WGPUPipelineLayout> standard_pipeline_layouts;
    std::vector<WGPUShaderModule> standard_vertex_modules;
    std::vector<WGPUShaderModule> standard_fragment_modules;
    std::map<std::uint32_t, std::map<std::size_t, WGPURenderPipeline>>
        standard_variant_pipelines;
#endif
#if BBLITE_PBR_VARIANTS > 0
    std::vector<WGPUShaderModule> pinned_vertex_modules;
    std::vector<WGPUShaderModule> pinned_fragment_modules;
    std::map<std::uint32_t, std::map<std::size_t, WGPURenderPipeline>>
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
    WGPUShaderModule ground_module = nullptr;
    WGPURenderPipeline ground_pipeline = nullptr;
    WGPUBuffer ground_vertices = nullptr;
    WGPUBuffer ground_indices = nullptr;
    WGPUTexture ground_texture = nullptr;
    WGPUTextureView ground_texture_view = nullptr;
    WGPUBuffer ground_uniforms = nullptr;
    WGPUBindGroup ground_scene_group = nullptr;
    WGPUBindGroup ground_texture_group = nullptr;
    WGPUBindGroup ground_material_group = nullptr;
    bool ground_enabled = false;
    WGPUShaderModule skybox_vertex_module = nullptr;
    WGPUShaderModule skybox_module = nullptr;
    WGPURenderPipeline skybox_pipeline = nullptr;
    WGPUBuffer skybox_vertices = nullptr;
    WGPUBuffer skybox_indices = nullptr;
    WGPUTexture skybox_texture = nullptr;
    WGPUTextureView skybox_texture_view = nullptr;
    WGPUBuffer skybox_matrix = nullptr;
    WGPUBuffer skybox_uniforms = nullptr;
    WGPUBindGroup skybox_scene_group = nullptr;
#if BBLITE_GPU_DEFORMATION
    // Identity deformation block shared by the background ground and
    // skybox pipelines: their quads carry zeroed joint weights, and the
    // shared material vertex stage statically binds the deformation
    // uniforms, so the derived group layout requires an entry even for
    // undeformed geometry.
    WGPUBuffer background_deformation_uniforms = nullptr;
#endif
#if BBLITE_GPU_INSTANCING
    // One identity per-instance matrix plus an identity parent-world
    // uniform for the background pipelines: the shared material vertex
    // stage consumes the instance attribute stream and instance
    // uniforms whenever instancing is compiled in.
    WGPUBuffer background_instances = nullptr;
    WGPUBuffer background_instance_uniform = nullptr;
#endif
#if BBLITE_GPU_MORPH_STORAGE
    // Group-0 morph storage groups for the background pipelines; the
    // shared vertex module statically binds the storage buffers, so
    // the derived layouts require them even for undeformed quads.
    WGPUBindGroup ground_morph_group = nullptr;
    WGPUBindGroup skybox_morph_group = nullptr;
#endif
#if BBLITE_SOLID_SKYBOX
    // The clear-colour cube samples nothing: no texture, no texture group.
    WGPUShaderModule solid_skybox_vertex_module = nullptr;
    WGPUShaderModule solid_skybox_fragment_module = nullptr;
    WGPURenderPipeline solid_skybox_pipeline = nullptr;
    WGPUBuffer solid_skybox_vertices = nullptr;
    WGPUBuffer solid_skybox_indices = nullptr;
    WGPUBuffer solid_skybox_scene_uniforms = nullptr;
    WGPUBuffer solid_skybox_mesh_uniforms = nullptr;
    WGPUBindGroup solid_skybox_scene_group = nullptr;
    WGPUBindGroup solid_skybox_material_group = nullptr;
    bool solid_skybox_enabled = false;
#endif
#if BBLITE_IMAGE_SKYBOX
    WGPUShaderModule image_skybox_vertex_module = nullptr;
    WGPUShaderModule image_skybox_fragment_module = nullptr;
    WGPURenderPipeline image_skybox_pipeline = nullptr;
    WGPUBuffer image_skybox_vertices = nullptr;
    WGPUBuffer image_skybox_indices = nullptr;
    WGPUBuffer image_skybox_uniforms = nullptr;
    WGPUTexture image_skybox_texture = nullptr;
    WGPUTextureView image_skybox_texture_view = nullptr;
    WGPUBindGroup image_skybox_scene_group = nullptr;
    WGPUBindGroup image_skybox_texture_group = nullptr;
    WGPUBindGroup image_skybox_material_group = nullptr;
    bool image_skybox_enabled = false;
#endif
    WGPUBindGroup skybox_texture_group = nullptr;
    WGPUBindGroup skybox_material_group = nullptr;
    bool skybox_enabled = false;
    // The pinned mip generator, shared with the pure-2D sprite driver
    // through `pal_dawn_shared.hpp`.
    DawnMipGenerator mips;
#if BBLITE_GPU_MORPH_STORAGE
    WGPUBuffer empty_morph_deltas = nullptr;
    WGPUBuffer empty_morph_weights = nullptr;
#endif
    // Mesh pipelines keyed by (kind, shader variant id); the variant is
    // zero for every non-shader kind.
    std::map<
        std::pair<upstream::RenderPipelineKind, std::uint32_t>,
        DawnPipeline>
        pipelines;
    /** Vertex-only custom-material pipelines for depth shadow targets. */
    std::map<
        std::pair<upstream::RenderPipelineKind, std::uint32_t>,
        DawnPipeline>
        shader_shadow_pipelines;
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
    std::vector<std::unique_ptr<DawnSharedShaderGeometry>>
        shared_shader_geometries;
    std::vector<std::unique_ptr<DawnSharedShaderMaterialTextures>>
        shared_shader_material_textures;
    std::vector<std::unique_ptr<DawnSharedComposedMaterialTextures>>
        shared_composed_material_textures;
#if BBLITE_HAS_MATERIAL_PLUGIN_TEXTURES
    std::vector<std::unique_ptr<DawnSharedPluginMaterialTextures>>
        shared_plugin_material_textures;
#endif

    // Frame-task draw resources are tied to the current render plan
    // and rebuild together with the meshes.
    void release_render_tasks() {
        for (DawnRenderTask& task : render_tasks) {
            if (task.skybox_scene_group) task.skybox_scene_group.reset();
            if (task.skybox_matrix) task.skybox_matrix.reset();
            if (task.scene_group) {
                task.scene_group.reset();
            }
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
        for (std::vector<DawnMesh>& layer : overlay_meshes) release(layer);
    }

#if defined(BBLITE_HAS_SCREEN_SPACE) && BBLITE_HAS_SCREEN_SPACE
    /**
     * The screen-space programs key only the generated stage table's
     * formats, so they outlive every frame-graph rebuild and go with the
     * device.
     */
    void release_screen_space_programs() {
        for (DawnScreenSpaceProgram& program : screen_space_programs) {
            if (program.pipeline) program.pipeline.reset();
            if (program.pipeline_layout) {
                program.pipeline_layout.reset();
            }
            if (program.group_layout) {
                program.group_layout.reset();
            }
            if (program.module) program.module.reset();
            program = {};
        }
        screen_space_programs.clear();
    }
#endif

    void release_frame_graph_textures() {
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
        for (WGPUBindGroup group : shadow_groups) {
            if (group) wgpuBindGroupRelease(group);
        }
        shadow_groups.clear();
        for (WGPUBindGroup group : pbr_shadow_groups) {
            if (group) wgpuBindGroupRelease(group);
        }
        pbr_shadow_groups.clear();
#endif
        for (DawnRenderTarget& target : render_targets) target = {};
        for (DawnGeometryTask& task : geometry_tasks) task = {};
#if defined(BBLITE_HAS_POST_PROCESS) && BBLITE_HAS_POST_PROCESS
        // The pass's pipeline and bind group name the attachments the graph
        // just released, so they are rebuilt with them; the pin discards the
        // same state when its own internal target is re-created.
        for (std::vector<DawnPostProcessTask>& passes :
             post_process_tasks) {
            for (DawnPostProcessTask& task : passes) {
                if (task.group) task.group.reset();
                if (task.uniforms) task.uniforms.reset();
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
            if (program.module) program.module.reset();
            program = {};
        }
        post_process_programs.clear();
#if defined(BBLITE_HAS_TAA) && BBLITE_HAS_TAA
        if (temporal_presented_group) wgpuBindGroupRelease(temporal_presented_group);
        if (temporal_presented_view) wgpuTextureViewRelease(temporal_presented_view);
        if (temporal_presented) wgpuTextureRelease(temporal_presented);
        temporal_presented_group = nullptr;
        temporal_presented_view = nullptr;
        temporal_presented = nullptr;
#endif
#endif
#if defined(BBLITE_HAS_SCREEN_SPACE) && BBLITE_HAS_SCREEN_SPACE
        // A stage's bind group names the attachments the graph just
        // released, so it goes with them; its program keys only the
        // generated stage table's formats and outlives every rebuild.
        for (DawnScreenSpaceTask& task : screen_space_tasks) {
            for (DawnScreenSpaceStage* stage : {&task.producer, &task.resolve}) {
                if (stage->group) stage->group.reset();
                if (stage->uniforms) stage->uniforms.reset();
                *stage = {};
            }
        }
        screen_space_tasks.clear();
#endif
#if defined(BBLITE_HAS_EFFECT_TASK) && BBLITE_HAS_EFFECT_TASK
        for (DawnEffectPass& pass : effect_tasks) {
            release_dawn_effect_pass(pass);
        }
        effect_tasks.clear();
#endif
        frame_graph_width = 0;
        frame_graph_height = 0;
    }

    void release_gpu_resources(DawnDrawResources& draw) noexcept {
        if (draw.group) wgpuBindGroupRelease(draw.group);
        if (draw.uv_transform_uniforms) wgpuBufferRelease(draw.uv_transform_uniforms);
        if (draw.uv_uniforms) wgpuBufferRelease(draw.uv_uniforms);
        if (draw.material_uniforms) wgpuBufferRelease(draw.material_uniforms);
        if (draw.mesh_uniforms) wgpuBufferRelease(draw.mesh_uniforms);
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
            for (auto& [kind, binding] : mesh.bindings) {
                if (binding.scene) binding.scene.reset();
                if (binding.textures) {
                    binding.textures.reset();
                }
                if (binding.material) {
                    binding.material.reset();
                }
#if BBLITE_GPU_MORPH_STORAGE
                if (binding.morph) binding.morph.reset();
#endif
            }
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
                release_shared_user(
                    mesh.shared_composed_textures,
                    "Composed material texture reference count underflow.");
            } else {
                for (std::size_t slot = 0;
                     slot < mesh_texture_slots;
                     ++slot) {
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
                release_shared_user(
                    mesh.shared_shader_textures,
                    "Shader material texture reference count underflow.");
            } else {
                release_dawn_extra_textures(mesh.shader_textures);
            }
#if BBLITE_HAS_MATERIAL_PLUGIN_TEXTURES
            if (mesh.shared_plugin_textures) {
                release_shared_user(
                    mesh.shared_plugin_textures,
                    "Plugin material texture reference count underflow.");
            }
#endif
#if BBLITE_PBR_VARIANTS > 0
            if (mesh.pinned_vertices) {
                wgpuBufferRelease(mesh.pinned_vertices);
                mesh.pinned_vertices = nullptr;
            }
#endif
#if BBLITE_PBR_VARIANTS > 0 || defined(BBLITE_STANDARD_SKELETON)
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
#if BBLITE_GPU_INSTANCING
            if (mesh.instance_uniform) {
                wgpuBufferRelease(mesh.instance_uniform);
            }
#if BBLITE_PBR_VARIANTS > 0
            if (mesh.pinned_instances &&
                mesh.pinned_instances != mesh.instances) {
                wgpuBufferRelease(mesh.pinned_instances);
            }
            mesh.pinned_instances = nullptr;
#endif
            if (mesh.instances) wgpuBufferRelease(mesh.instances);
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
                if (mesh.vertices) wgpuBufferRelease(mesh.vertices);
                if (mesh.indices) wgpuBufferRelease(mesh.indices);
            } else if (mesh.shared_geometry) {
                release_shared_user(
                    mesh.shared_geometry,
                    "Shader geometry reference count underflow.");
            }
    }

    void prune_shared_shader_geometries() {
        prune_unused_shared(
            shared_shader_geometries,
            [](DawnSharedShaderGeometry& geometry) {
                if (geometry.vertex_buffer) {
                    geometry.vertex_buffer.reset();
                }
                if (geometry.index_buffer) {
                    geometry.index_buffer.reset();
                }
            });
    }

    void prune_shared_shader_material_textures() {
        prune_unused_shared(
            shared_shader_material_textures,
            [](DawnSharedShaderMaterialTextures& textures) {
                release_dawn_extra_textures(textures.textures);
            });
#if BBLITE_HAS_MATERIAL_PLUGIN_TEXTURES
        prune_unused_shared(
            shared_plugin_material_textures,
            [](DawnSharedPluginMaterialTextures& textures) {
                release_dawn_extra_textures(textures.textures);
            });
#endif
    }

    void prune_shared_composed_material_textures() {
        prune_unused_shared(
            shared_composed_material_textures,
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
        for (DawnMesh& mesh : meshes) mesh.release_thin_pick_group();
        for (auto& layer : overlay_meshes) {
            for (DawnMesh& mesh : layer) mesh.release_thin_pick_group();
        }
    }
#endif

    ~DawnState() {
#if defined(BBLITE_HAS_TEXT) && BBLITE_HAS_TEXT
        text.reset();
#endif
#if BBLITE_HAS_PICKING && BBLITE_GPU_INSTANCING
        release_thin_pick_groups();
#endif
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI && !(defined(BBLITE_WORKERS) && BBLITE_WORKERS)
        ui.release();
#endif
#if BBLITE_HAS_PICKING
        release_dawn_pick_targets(pick_targets);
        if (pick_mesh_pipeline) wgpuRenderPipelineRelease(pick_mesh_pipeline);
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
                if (pipeline) wgpuRenderPipelineRelease(pipeline);
            }
            if (program.layout) wgpuBindGroupLayoutRelease(program.layout);
        }
        if (pick_deform_empty_group) {
            wgpuBindGroupRelease(pick_deform_empty_group);
        }
        if (pick_deform_empty_layout) {
            wgpuBindGroupLayoutRelease(pick_deform_empty_layout);
        }
#endif
        if (pick_scene_layout) wgpuBindGroupLayoutRelease(pick_scene_layout);
        if (pick_mesh_layout) wgpuBindGroupLayoutRelease(pick_mesh_layout);
        if (pick_scene_group) wgpuBindGroupRelease(pick_scene_group);
        if (pick_scene_buffer) wgpuBufferRelease(pick_scene_buffer);
        if (pick_mesh_group) wgpuBindGroupRelease(pick_mesh_group);
        if (pick_mesh_buffer) wgpuBufferRelease(pick_mesh_buffer);
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
        if (pick_cloud_shear) wgpuBufferRelease(pick_cloud_shear);
        if (pick_cloud_color_group) {
            wgpuBindGroupRelease(pick_cloud_color_group);
        }
        if (pick_cloud_color) wgpuBufferRelease(pick_cloud_color);
#endif
#endif
#if defined(BBLITE_HAS_SPRITE_RENDERER) && BBLITE_HAS_SPRITE_RENDERER
        if (has_scene_sprite_pass) {
            release_dawn_scene_sprite_pass(scene_sprite_pass);
            has_scene_sprite_pass = false;
        }
        for (DawnSpritePass& pass : sprite_passes) {
            release_dawn_sprite_pass(pass);
        }
        sprite_passes.clear();
        for (WGPUTextureView view : sprite_render_texture_views) {
            if (view) wgpuTextureViewRelease(view);
        }
        sprite_render_texture_views.clear();
        for (WGPUTexture texture : sprite_render_textures) {
            if (texture) wgpuTextureRelease(texture);
        }
        sprite_render_textures.clear();
#endif
        release_dawn_mip_generator(mips);
        release_render_tasks();
        release_frame_graph_textures();
#if defined(BBLITE_HAS_SCREEN_SPACE) && BBLITE_HAS_SCREEN_SPACE
        release_screen_space_programs();
#endif
#if BBLITE_SHADOW_RECEIVERS
        // The receiver group already went with the frame-graph textures it
        // views; what remains is the generator-owned state, which outlives
        // a resize.
        for (WGPUBuffer buffer : shadow_uniforms) {
            if (buffer) wgpuBufferRelease(buffer);
        }
        for (WGPUBindGroupLayout layout : shadow_layouts) {
            if (layout) wgpuBindGroupLayoutRelease(layout);
        }
        for (WGPUBindGroupLayout layout : pbr_shadow_layouts) {
            if (layout) wgpuBindGroupLayoutRelease(layout);
        }
        if (shadow_comparison_sampler) {
            wgpuSamplerRelease(shadow_comparison_sampler);
        }
        if (shadow_filtering_sampler) {
            wgpuSamplerRelease(shadow_filtering_sampler);
        }
#endif
        for (auto& sided : depth_only_pipelines) {
            for (WGPURenderPipeline pipeline : sided) {
                if (pipeline) wgpuRenderPipelineRelease(pipeline);
            }
        }
        for (auto& [key, pipeline] : blit_pipelines) {
            if (pipeline) wgpuRenderPipelineRelease(pipeline);
        }
        for (auto& by_depth : task_pipelines) {
            for (auto& pipeline_map : by_depth) {
                for (auto& [kind, pipeline] : pipeline_map) {
                    if (pipeline.pipeline) {
                        wgpuRenderPipelineRelease(pipeline.pipeline);
                    }
                }
            }
        }
        for (auto& [key, pipeline] : shader_shadow_pipelines) {
            (void)key;
            if (pipeline.pipeline) {
                wgpuRenderPipelineRelease(pipeline.pipeline);
            }
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
        if (image_processing_fragment_module) {
            wgpuShaderModuleRelease(image_processing_fragment_module);
        }
        if (image_processing_vertex_module) {
            wgpuShaderModuleRelease(image_processing_vertex_module);
        }
        if (transmission_grab_pipeline) {
            wgpuRenderPipelineRelease(transmission_grab_pipeline);
        }
        if (transmission_grab_fragment_module) {
            wgpuShaderModuleRelease(transmission_grab_fragment_module);
        }
        if (transmission_grab_vertex_module) {
            wgpuShaderModuleRelease(transmission_grab_vertex_module);
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
        if (nearest_sampler) wgpuSamplerRelease(nearest_sampler);
#if defined(BBLITE_HAS_POST_PROCESS) && BBLITE_HAS_POST_PROCESS
        if (post_process_bilinear_sampler) {
            wgpuSamplerRelease(post_process_bilinear_sampler);
        }
#endif
        release_meshes();
        for (ShaderStorageBuffer& storage : shader_storage_buffers) {
            if (storage.buffer) wgpuBufferRelease(storage.buffer);
        }
        shader_storage_buffers.clear();
        release_all_shared(
            shared_shader_geometries,
            [](DawnSharedShaderGeometry& geometry) {
                if (geometry.vertex_buffer) {
                    geometry.vertex_buffer.reset();
                }
                if (geometry.index_buffer) {
                    geometry.index_buffer.reset();
                }
            });
        release_all_shared(
            shared_shader_material_textures,
            [](DawnSharedShaderMaterialTextures& textures) {
                release_dawn_extra_textures(textures.textures);
            });
#if BBLITE_HAS_MATERIAL_PLUGIN_TEXTURES
        release_all_shared(
            shared_plugin_material_textures,
            [](DawnSharedPluginMaterialTextures& textures) {
                release_dawn_extra_textures(textures.textures);
            });
#endif
        release_all_shared(
            shared_composed_material_textures,
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
            if (buffer) wgpuBufferRelease(buffer);
        }
        for (EsmBlur& blur : esm_blurs) {
            if (blur.horizontal) wgpuBindGroupRelease(blur.horizontal);
            if (blur.vertical) wgpuBindGroupRelease(blur.vertical);
            if (blur.pipeline) wgpuRenderPipelineRelease(blur.pipeline);
            if (blur.layout) wgpuBindGroupLayoutRelease(blur.layout);
            if (blur.horizontal_uniforms) {
                wgpuBufferRelease(blur.horizontal_uniforms);
            }
            if (blur.vertical_uniforms) {
                wgpuBufferRelease(blur.vertical_uniforms);
            }
            if (blur.blur_h_view) wgpuTextureViewRelease(blur.blur_h_view);
            if (blur.blur_h) wgpuTextureRelease(blur.blur_h);
            if (blur.blur_v_view) wgpuTextureViewRelease(blur.blur_v_view);
            if (blur.blur_v) wgpuTextureRelease(blur.blur_v);
        }
        esm_blurs.clear();
#endif
#endif
        // The composed families' caches, each in the dependents-first
        // order `release_variant_family` owns; the frame layout goes
        // last because every family's pipeline layouts name it.
#if BBLITE_PINNED_MATERIALS
        if (pinned_geometry_frame_group) {
            wgpuBindGroupRelease(pinned_geometry_frame_group);
        }
        if (pinned_frame_group) wgpuBindGroupRelease(pinned_frame_group);
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
        release_variant_family(
            pinned_variant_pipelines,
            pinned_pipeline_layouts,
            pinned_draw_layouts,
            pinned_fragment_modules,
            pinned_vertex_modules);
#endif
#if BBLITE_STANDARD_VARIANTS > 0
        release_variant_family(
            standard_variant_pipelines,
            standard_pipeline_layouts,
            standard_draw_layouts,
            standard_fragment_modules,
            standard_vertex_modules);
#endif
#if BBLITE_NODE_VARIANTS > 0
        release_variant_family(
            node_variant_pipelines,
            node_pipeline_layouts,
            node_draw_layouts,
            node_fragment_modules,
            node_vertex_modules);
#endif
#if BBLITE_PINNED_MATERIALS
        if (pinned_frame_layout) {
            wgpuBindGroupLayoutRelease(pinned_frame_layout);
        }
#endif
        // Pipelines and bind groups depend on the shared pipeline/group
        // layouts. Release every dependent first: Dawn's D3D12 backend
        // tears down layout-owned binding metadata eagerly, so dropping a
        // texture bind group after its layout can dereference freed state.
        if (mesh_pipeline_layout) {
            wgpuPipelineLayoutRelease(mesh_pipeline_layout);
        }
        for (WGPUBindGroupLayout layout : mesh_group_layouts) {
            if (layout) wgpuBindGroupLayoutRelease(layout);
        }
        for (WGPUPipelineLayout layout : shader_pipeline_layouts) {
            if (layout) wgpuPipelineLayoutRelease(layout);
        }
        for (auto& layouts : shader_group_layouts) {
            for (WGPUBindGroupLayout layout : layouts) {
                if (layout) wgpuBindGroupLayoutRelease(layout);
            }
        }
#if BBLITE_SOLID_SKYBOX
        if (solid_skybox_material_group) {
            wgpuBindGroupRelease(solid_skybox_material_group);
        }
        if (solid_skybox_scene_group) {
            wgpuBindGroupRelease(solid_skybox_scene_group);
        }
        if (solid_skybox_mesh_uniforms) {
            wgpuBufferRelease(solid_skybox_mesh_uniforms);
        }
        if (solid_skybox_scene_uniforms) {
            wgpuBufferRelease(solid_skybox_scene_uniforms);
        }
        if (solid_skybox_indices) {
            wgpuBufferRelease(solid_skybox_indices);
        }
        if (solid_skybox_vertices) {
            wgpuBufferRelease(solid_skybox_vertices);
        }
        if (solid_skybox_pipeline) {
            wgpuRenderPipelineRelease(solid_skybox_pipeline);
        }
        if (solid_skybox_fragment_module) {
            wgpuShaderModuleRelease(solid_skybox_fragment_module);
        }
        if (solid_skybox_vertex_module) {
            wgpuShaderModuleRelease(solid_skybox_vertex_module);
        }
#endif
#if BBLITE_IMAGE_SKYBOX
        if (image_skybox_material_group) {
            wgpuBindGroupRelease(image_skybox_material_group);
        }
        if (image_skybox_texture_group) {
            wgpuBindGroupRelease(image_skybox_texture_group);
        }
        if (image_skybox_scene_group) {
            wgpuBindGroupRelease(image_skybox_scene_group);
        }
        if (image_skybox_texture_view) {
            wgpuTextureViewRelease(image_skybox_texture_view);
        }
        if (image_skybox_texture) {
            wgpuTextureRelease(image_skybox_texture);
        }
        if (image_skybox_uniforms) {
            wgpuBufferRelease(image_skybox_uniforms);
        }
        if (image_skybox_indices) {
            wgpuBufferRelease(image_skybox_indices);
        }
        if (image_skybox_vertices) {
            wgpuBufferRelease(image_skybox_vertices);
        }
        if (image_skybox_pipeline) {
            wgpuRenderPipelineRelease(image_skybox_pipeline);
        }
        if (image_skybox_fragment_module) {
            wgpuShaderModuleRelease(image_skybox_fragment_module);
        }
        if (image_skybox_vertex_module) {
            wgpuShaderModuleRelease(image_skybox_vertex_module);
        }
#endif
        if (skybox_material_group) wgpuBindGroupRelease(skybox_material_group);
        if (skybox_texture_group) wgpuBindGroupRelease(skybox_texture_group);
        if (skybox_scene_group) wgpuBindGroupRelease(skybox_scene_group);
#if BBLITE_GPU_DEFORMATION
        if (background_deformation_uniforms) {
            wgpuBufferRelease(background_deformation_uniforms);
        }
#endif
#if BBLITE_GPU_INSTANCING
        if (background_instance_uniform) {
            wgpuBufferRelease(background_instance_uniform);
        }
        if (background_instances) {
            wgpuBufferRelease(background_instances);
        }
#endif
#if BBLITE_GPU_MORPH_STORAGE
        if (skybox_morph_group) {
            wgpuBindGroupRelease(skybox_morph_group);
        }
        if (ground_morph_group) {
            wgpuBindGroupRelease(ground_morph_group);
        }
#endif
        if (skybox_uniforms) wgpuBufferRelease(skybox_uniforms);
        if (skybox_matrix) wgpuBufferRelease(skybox_matrix);
        if (skybox_texture_view) wgpuTextureViewRelease(skybox_texture_view);
        if (skybox_texture) wgpuTextureRelease(skybox_texture);
        if (skybox_indices) wgpuBufferRelease(skybox_indices);
        if (skybox_vertices) wgpuBufferRelease(skybox_vertices);
        if (skybox_pipeline) wgpuRenderPipelineRelease(skybox_pipeline);
        if (skybox_module) wgpuShaderModuleRelease(skybox_module);
        if (skybox_vertex_module) {
            wgpuShaderModuleRelease(skybox_vertex_module);
        }
        if (ground_material_group) wgpuBindGroupRelease(ground_material_group);
        if (ground_texture_group) wgpuBindGroupRelease(ground_texture_group);
        if (ground_scene_group) wgpuBindGroupRelease(ground_scene_group);
        if (ground_uniforms) wgpuBufferRelease(ground_uniforms);
        if (ground_texture_view) wgpuTextureViewRelease(ground_texture_view);
        if (ground_texture) wgpuTextureRelease(ground_texture);
        if (ground_indices) wgpuBufferRelease(ground_indices);
        if (ground_vertices) wgpuBufferRelease(ground_vertices);
        if (ground_pipeline) wgpuRenderPipelineRelease(ground_pipeline);
        if (ground_module) wgpuShaderModuleRelease(ground_module);
        if (ground_sampler) wgpuSamplerRelease(ground_sampler);
        if (clamp_sampler) wgpuSamplerRelease(clamp_sampler);
        if (default_sampler) wgpuSamplerRelease(default_sampler);
        if (brdf_view) wgpuTextureViewRelease(brdf_view);
        if (brdf_texture) wgpuTextureRelease(brdf_texture);
        if (environment_cube_view) {
            wgpuTextureViewRelease(environment_cube_view);
        }
        if (environment_cube) wgpuTextureRelease(environment_cube);
        for (WGPUTextureView view : reflection_cube_views) {
            if (view) wgpuTextureViewRelease(view);
        }
        for (WGPUTexture texture : reflection_cubes) {
            if (texture) wgpuTextureRelease(texture);
        }
        if (normal_flat_view) wgpuTextureViewRelease(normal_flat_view);
        if (normal_flat_texture) wgpuTextureRelease(normal_flat_texture);
        if (black_cube_view) wgpuTextureViewRelease(black_cube_view);
        if (black_cube) wgpuTextureRelease(black_cube);
        if (black_view) wgpuTextureViewRelease(black_view);
        if (black_texture) wgpuTextureRelease(black_texture);
        if (white_view) wgpuTextureViewRelease(white_view);
        if (white_texture) wgpuTextureRelease(white_texture);
        if (view_projection) wgpuBufferRelease(view_projection);
        for (WGPUShaderModule module : shader_fragment_modules) {
            if (module) wgpuShaderModuleRelease(module);
        }
        for (WGPUShaderModule module : shader_vertex_modules) {
            if (module) wgpuShaderModuleRelease(module);
        }
        if (grid_fragment_module) {
            wgpuShaderModuleRelease(grid_fragment_module);
        }
        if (grid_vertex_module) {
            wgpuShaderModuleRelease(grid_vertex_module);
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
        if (pbr_module) wgpuShaderModuleRelease(pbr_module);
        if (vertex_module) wgpuShaderModuleRelease(vertex_module);
        if (depth_view) wgpuTextureViewRelease(depth_view);
        if (depth) wgpuTextureRelease(depth);
        if (msaa_color_view) wgpuTextureViewRelease(msaa_color_view);
        if (msaa_color) wgpuTextureRelease(msaa_color);
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
WGPUBuffer esm_caster_params_buffer(
    const DawnState& state,
    const MaterialRecord* material) {
    if (
        !material ||
        !material->esm_shadow ||
        material->esm_shadow_generator.value >= state.shadow_params.size()) {
        return nullptr;
    }
    return handle_at(state.shadow_params, material->esm_shadow_generator);
}
#endif

/** Forwards to the shared loader; the call sites name the state. */
WGPUShaderModule load_wgsl_module(
    DawnState& state,
    const std::string& base_name) {
    return bbl::pal::load_wgsl_module(state.device, base_name);
}

WGPUBuffer create_buffer(
    DawnState& state,
    WGPUBufferUsage usage,
    const void* data,
    std::uint64_t size) {
    WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
    descriptor.usage = usage | WGPUBufferUsage_CopyDst;
    descriptor.size = (size + 3) & ~3ull;
    DawnBuffer buffer{wgpuDeviceCreateBuffer(state.device, &descriptor)};
    if (!buffer) dawn_error("wgpuDeviceCreateBuffer");
    if (data) {
        wgpuQueueWriteBuffer(state.queue, buffer, 0, data, size);
    }
    return buffer.release();
}

/** Mirror Engine storage records into Dawn read-only storage buffers. */
void sync_shader_storage_buffers(DawnState& state, const Engine& engine) {
    sync_storage_records(engine.storage_buffers, state.shader_storage_buffers,
        [&] { state.release_shader_bindings(); },
        [](WGPUBuffer buffer) { wgpuBufferRelease(buffer); },
        [&](const void* bytes, std::size_t size) { return create_buffer(state, WGPUBufferUsage_Storage, bytes, size); },
        [&](WGPUBuffer buffer, const void* bytes, std::size_t size) { wgpuQueueWriteBuffer(state.queue, buffer, 0, bytes, size); });
}

#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI && !(defined(BBLITE_WORKERS) && BBLITE_WORKERS)
WGPUShaderModule create_ui_dawn_module(DawnState& state) {
    static constexpr char source[] = R"wgsl(
struct Screen {
    size: vec2<f32>,
    padding: vec2<f32>,
};

@group(0) @binding(0) var<uniform> screen: Screen;
@group(1) @binding(0) var ui_texture: texture_2d<f32>;
@group(1) @binding(1) var ui_sampler: sampler;

struct VertexInput {
    @location(0) position: vec2<f32>,
    @location(1) color: vec4<f32>,
    @location(2) uv: vec2<f32>,
};

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) color: vec4<f32>,
    @location(1) uv: vec2<f32>,
};

@vertex
fn vs(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.position = vec4<f32>(
        input.position.x * 2.0 / screen.size.x - 1.0,
        1.0 - input.position.y * 2.0 / screen.size.y,
        0.0,
        1.0);
    output.color = input.color;
    output.uv = input.uv;
    return output;
}

@fragment
fn fs_color(input: VertexOutput) -> @location(0) vec4<f32> {
    return input.color;
}

@fragment
fn fs_texture(input: VertexOutput) -> @location(0) vec4<f32> {
    return input.color * textureSample(ui_texture, ui_sampler, input.uv);
}
)wgsl";
    WGPUShaderSourceWGSL wgsl = WGPU_SHADER_SOURCE_WGSL_INIT;
    wgsl.code = WGPUStringView{source, sizeof(source) - 1};
    WGPUShaderModuleDescriptor descriptor{};
    descriptor.nextInChain = &wgsl.chain;
    descriptor.label = string_view("bblite-ui");
    DawnShaderModule module{wgpuDeviceCreateShaderModule(state.device, &descriptor)};
    if (!module) dawn_error("wgpuDeviceCreateShaderModule UI");
    return module.release();
}

WGPURenderPipeline create_ui_dawn_pipeline(
    DawnState& state,
    WGPUShaderModule module,
    const char* fragment_entry,
    WGPUTextureFormat format,
    std::uint32_t samples,
    WGPUPipelineLayout layout,
    bool additive = false) {
    std::array<WGPUVertexAttribute, 3> attributes{};
    attributes[0] = WGPU_VERTEX_ATTRIBUTE_INIT;
    attributes[0].format = WGPUVertexFormat_Float32x2;
    attributes[0].offset = offsetof(UiRenderVertex, x);
    attributes[0].shaderLocation = 0;
    attributes[1] = WGPU_VERTEX_ATTRIBUTE_INIT;
    attributes[1].format = WGPUVertexFormat_Unorm8x4;
    attributes[1].offset = offsetof(UiRenderVertex, red);
    attributes[1].shaderLocation = 1;
    attributes[2] = WGPU_VERTEX_ATTRIBUTE_INIT;
    attributes[2].format = WGPUVertexFormat_Float32x2;
    attributes[2].offset = offsetof(UiRenderVertex, u);
    attributes[2].shaderLocation = 2;
    WGPUVertexBufferLayout vertex_layout{};
    vertex_layout.arrayStride = sizeof(UiRenderVertex);
    vertex_layout.stepMode = WGPUVertexStepMode_Vertex;
    vertex_layout.attributeCount = attributes.size();
    vertex_layout.attributes = attributes.data();

    WGPUBlendState blend{};
    blend.color.operation = WGPUBlendOperation_Add;
    blend.color.srcFactor = WGPUBlendFactor_One;
    blend.color.dstFactor = additive ? WGPUBlendFactor_One : WGPUBlendFactor_OneMinusSrcAlpha;
    blend.alpha.operation = WGPUBlendOperation_Add;
    blend.alpha.srcFactor = WGPUBlendFactor_One;
    blend.alpha.dstFactor = additive ? WGPUBlendFactor_One : WGPUBlendFactor_OneMinusSrcAlpha;
    WGPUColorTargetState target = WGPU_COLOR_TARGET_STATE_INIT;
    target.format = format;
    target.blend = &blend;
    WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
    fragment.module = module;
    fragment.entryPoint = string_view(fragment_entry);
    fragment.targetCount = 1;
    fragment.targets = &target;
    WGPURenderPipelineDescriptor descriptor =
        WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    descriptor.layout = layout;
    descriptor.vertex.module = module;
    descriptor.vertex.entryPoint = string_view("vs");
    descriptor.vertex.bufferCount = 1;
    descriptor.vertex.buffers = &vertex_layout;
    descriptor.fragment = &fragment;
    descriptor.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    descriptor.primitive.cullMode = WGPUCullMode_None;
    descriptor.multisample.count = samples;
    descriptor.multisample.mask = ~0u;
    DawnRenderPipeline pipeline{wgpuDeviceCreateRenderPipeline(state.device, &descriptor)};
    if (!pipeline) dawn_error("wgpuDeviceCreateRenderPipeline UI");
    return pipeline.release();
}

WGPUBindGroup create_ui_dawn_texture_group(
    DawnState& state,
    WGPUTextureView view,
    WGPUSampler sampler) {
    std::array<WGPUBindGroupEntry, 2> entries{};
    entries[0] = WGPU_BIND_GROUP_ENTRY_INIT;
    entries[0].binding = 0;
    entries[0].textureView = view;
    entries[1] = WGPU_BIND_GROUP_ENTRY_INIT;
    entries[1].binding = 1;
    entries[1].sampler = sampler;
    WGPUBindGroupDescriptor descriptor = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    descriptor.layout = state.ui.texture_layout;
    descriptor.entryCount = entries.size();
    descriptor.entries = entries.data();
    DawnBindGroup group{wgpuDeviceCreateBindGroup(state.device, &descriptor)};
    if (!group) dawn_error("wgpuDeviceCreateBindGroup UI texture");
    return group.release();
}

void create_ui_dawn_resources(DawnState& state) {
    DawnUiResources& ui = state.ui;
    if (ui.color_pipeline) return;

    WGPUBindGroupLayoutEntry screen_entry =
        WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
    screen_entry.binding = 0;
    screen_entry.visibility = WGPUShaderStage_Vertex;
    screen_entry.buffer.type = WGPUBufferBindingType_Uniform;
    screen_entry.buffer.minBindingSize = 16;
    WGPUBindGroupLayoutDescriptor screen_descriptor =
        WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
    screen_descriptor.entryCount = 1;
    screen_descriptor.entries = &screen_entry;
    ui.screen_layout =
        wgpuDeviceCreateBindGroupLayout(state.device, &screen_descriptor);
    if (!ui.screen_layout) dawn_error("UI screen bind group layout");

    std::array<WGPUBindGroupLayoutEntry, 2> texture_entries{};
    texture_entries[0] = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
    texture_entries[0].binding = 0;
    texture_entries[0].visibility = WGPUShaderStage_Fragment;
    texture_entries[0].texture.sampleType = WGPUTextureSampleType_Float;
    texture_entries[0].texture.viewDimension = WGPUTextureViewDimension_2D;
    texture_entries[1] = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
    texture_entries[1].binding = 1;
    texture_entries[1].visibility = WGPUShaderStage_Fragment;
    texture_entries[1].sampler.type = WGPUSamplerBindingType_Filtering;
    WGPUBindGroupLayoutDescriptor texture_descriptor =
        WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
    texture_descriptor.entryCount = texture_entries.size();
    texture_descriptor.entries = texture_entries.data();
    ui.texture_layout =
        wgpuDeviceCreateBindGroupLayout(state.device, &texture_descriptor);
    if (!ui.texture_layout) dawn_error("UI texture bind group layout");

    const std::array<WGPUBindGroupLayout, 2> layouts{
        ui.screen_layout,
        ui.texture_layout};
    WGPUPipelineLayoutDescriptor pipeline_layout =
        WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
    pipeline_layout.bindGroupLayoutCount = layouts.size();
    pipeline_layout.bindGroupLayouts = layouts.data();
    ui.pipeline_layout =
        wgpuDeviceCreatePipelineLayout(state.device, &pipeline_layout);
    if (!ui.pipeline_layout) dawn_error("UI pipeline layout");

    WGPUShaderModule module = create_ui_dawn_module(state);
    WGPUPipelineLayoutDescriptor color_layout_descriptor =
        WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
    color_layout_descriptor.bindGroupLayoutCount = 1;
    color_layout_descriptor.bindGroupLayouts = &ui.screen_layout;
    DawnPipelineLayout color_layout{wgpuDeviceCreatePipelineLayout(state.device, &color_layout_descriptor)};
    if (!color_layout) dawn_error("UI color pipeline layout");
    ui.color_pipeline = create_ui_dawn_pipeline(
        state,
        module,
        "fs_color",
        WGPUTextureFormat_RGBA8Unorm,
        state.sample_count,
        color_layout);
    color_layout.reset();
    ui.texture_pipeline = create_ui_dawn_pipeline(
        state,
        module,
        "fs_texture",
        WGPUTextureFormat_RGBA8Unorm,
        state.sample_count,
        ui.pipeline_layout);
    ui.composite_pipeline = create_ui_dawn_pipeline(
        state,
        module,
        "fs_texture",
        state.surface_format,
        1,
        ui.pipeline_layout);
    wgpuShaderModuleRelease(module);

    WGPUSamplerDescriptor sampler = WGPU_SAMPLER_DESCRIPTOR_INIT;
    sampler.minFilter = WGPUFilterMode_Linear;
    sampler.magFilter = WGPUFilterMode_Linear;
    sampler.mipmapFilter = WGPUMipmapFilterMode_Nearest;
    sampler.addressModeU = WGPUAddressMode_ClampToEdge;
    sampler.addressModeV = WGPUAddressMode_ClampToEdge;
    sampler.addressModeW = WGPUAddressMode_ClampToEdge;
    ui.sampler = wgpuDeviceCreateSampler(state.device, &sampler);
    if (!ui.sampler) dawn_error("wgpuDeviceCreateSampler UI");
    sampler.minFilter = WGPUFilterMode_Nearest;
    sampler.magFilter = WGPUFilterMode_Nearest;
    ui.nearest_sampler = wgpuDeviceCreateSampler(state.device, &sampler);
    if (!ui.nearest_sampler) {
        dawn_error("wgpuDeviceCreateSampler UI nearest");
    }

    ui.screen = create_buffer(state, WGPUBufferUsage_Uniform, nullptr, 16);
    WGPUBindGroupEntry screen_binding = WGPU_BIND_GROUP_ENTRY_INIT;
    screen_binding.binding = 0;
    screen_binding.buffer = ui.screen;
    screen_binding.size = 16;
    WGPUBindGroupDescriptor screen_group = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    screen_group.layout = ui.screen_layout;
    screen_group.entryCount = 1;
    screen_group.entries = &screen_binding;
    ui.screen_group =
        wgpuDeviceCreateBindGroup(state.device, &screen_group);
    if (!ui.screen_group) dawn_error("wgpuDeviceCreateBindGroup UI screen");
}

void ensure_ui_dawn_backdrop_pipeline(DawnState& state) {
    DawnUiResources& ui = state.ui;
    if (ui.backdrop.pipeline) return;
    WGPUShaderModule module = create_ui_dawn_module(state);
    ui.backdrop.pipeline = create_ui_dawn_pipeline(
        state,
        module,
        "fs_texture",
        WGPUTextureFormat_RGBA16Float,
        1,
        ui.pipeline_layout,
        true);
    wgpuShaderModuleRelease(module);
}

void ensure_ui_dawn_layers(
    DawnState& state,
    std::uint32_t width,
    std::uint32_t height) {
    DawnUiResources& ui = state.ui;
    if (ui.width == width && ui.height == height && ui.layer) return;
    if (ui.layer_group) wgpuBindGroupRelease(ui.layer_group);
    if (ui.multisample_layer_view) {
        wgpuTextureViewRelease(ui.multisample_layer_view);
    }
    if (ui.multisample_layer) wgpuTextureRelease(ui.multisample_layer);
    if (ui.layer_view) wgpuTextureViewRelease(ui.layer_view);
    if (ui.layer) wgpuTextureRelease(ui.layer);
    ui.layer_group = nullptr;
    ui.multisample_layer_view = nullptr;
    ui.multisample_layer = nullptr;
    ui.layer_view = nullptr;
    ui.layer = nullptr;

    WGPUTextureDescriptor layer = WGPU_TEXTURE_DESCRIPTOR_INIT;
    layer.dimension = WGPUTextureDimension_2D;
    layer.format = WGPUTextureFormat_RGBA8Unorm;
    layer.usage = WGPUTextureUsage_RenderAttachment |
        WGPUTextureUsage_TextureBinding;
    layer.size = WGPUExtent3D{width, height, 1};
    layer.sampleCount = 1;
    ui.layer = wgpuDeviceCreateTexture(state.device, &layer);
    if (!ui.layer) dawn_error("wgpuDeviceCreateTexture UI layer");
    ui.layer_view = create_dawn_texture_view(ui.layer, nullptr);
    if (!ui.layer_view) dawn_error("wgpuTextureCreateView UI layer");
    if (state.multisampled()) {
        layer.usage = WGPUTextureUsage_RenderAttachment;
        layer.sampleCount = state.sample_count;
        ui.multisample_layer =
            wgpuDeviceCreateTexture(state.device, &layer);
        if (!ui.multisample_layer) {
            dawn_error("wgpuDeviceCreateTexture UI multisample layer");
        }
        ui.multisample_layer_view =
            create_dawn_texture_view(ui.multisample_layer, nullptr);
        if (!ui.multisample_layer_view) {
            dawn_error("wgpuTextureCreateView UI multisample layer");
        }
    }
    ui.layer_group = create_ui_dawn_texture_group(
        state,
        ui.layer_view,
        ui.sampler);
    ui.width = width;
    ui.height = height;
}

void ensure_ui_dawn_buffer(
    DawnState& state,
    WGPUBuffer& buffer,
    std::uint64_t& capacity,
    std::uint64_t required,
    WGPUBufferUsage usage) {
    if (buffer && capacity >= required) return;
    if (buffer) wgpuBufferRelease(buffer);
    capacity = std::max<std::uint64_t>(4096, capacity);
    while (capacity < required) capacity *= 2;
    WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
    descriptor.usage = usage | WGPUBufferUsage_CopyDst;
    descriptor.size = capacity;
    buffer = wgpuDeviceCreateBuffer(state.device, &descriptor);
    if (!buffer) dawn_error("wgpuDeviceCreateBuffer UI");
}

void render_ui_dawn_frame(
    DawnState& state,
    WGPUCommandEncoder encoder,
    WGPUTexture target_texture,
    WGPUTextureView target,
    const UiRenderFrame& frame) {
    if ((frame.draws.empty() && frame.operations.empty()) || frame.width == 0 || frame.height == 0) return;
    create_ui_dawn_resources(state);
    if (!frame.backdrops.empty()) ensure_ui_dawn_backdrop_pipeline(state);
    ensure_ui_dawn_layers(state, frame.width, frame.height);
    DawnUiResources& ui = state.ui;

    // The recorder appended the full-frame composite quad after the RmlUi
    // draws (`frame.composite_first_index` names it), so the aggregate
    // geometry uploads verbatim -- no per-frame copy on this side.
    const std::uint64_t vertex_bytes =
        frame.vertices.size() * sizeof(UiRenderVertex);
    const std::uint64_t index_bytes =
        frame.indices.size() * sizeof(std::uint32_t);
    ensure_ui_dawn_buffer(
        state,
        ui.vertices,
        ui.vertex_capacity,
        vertex_bytes,
        WGPUBufferUsage_Vertex);
    ensure_ui_dawn_buffer(
        state,
        ui.indices,
        ui.index_capacity,
        index_bytes,
        WGPUBufferUsage_Index);
    wgpuQueueWriteBuffer(
        state.queue, ui.vertices, 0, frame.vertices.data(), vertex_bytes);
    wgpuQueueWriteBuffer(
        state.queue, ui.indices, 0, frame.indices.data(), index_bytes);
    const std::array<float, 4> screen{
        static_cast<float>(frame.width),
        static_cast<float>(frame.height),
        0,
        0};
    wgpuQueueWriteBuffer(
        state.queue, ui.screen, 0, screen.data(), sizeof(screen));

    for (auto texture = ui.textures.begin(); texture != ui.textures.end();) {
        if (ui_frame_uses_texture(frame, texture->first)) {
            ++texture;
            continue;
        }
        texture->second.release();
        texture = ui.textures.erase(texture);
    }
    for (const UiRenderTexture& source : frame.textures) {
        if (ui.textures.contains(source.id) || !source.rgba) continue;
        DawnUiTexture texture;
        texture.texture = upload_dawn_rgba_texture(
            state.device,
            state.queue,
            source.rgba->data(),
            source.rgba->size(),
            source.width,
            source.height);
        texture.view = create_dawn_texture_view(texture.texture, nullptr);
        if (!texture.view) dawn_error("wgpuTextureCreateView UI source");
        texture.group = create_ui_dawn_texture_group(
            state,
            texture.view,
            ui.sampler);
        texture.nearest_group = create_ui_dawn_texture_group(
            state,
            texture.view,
            ui.nearest_sampler);
        ui.textures.emplace(source.id, texture);
    }

    const UiDawnTexture root_target{target_texture, target, nullptr, nullptr};
    ui.filters.begin_frame();
    for_each_ui_segment(frame, [&](std::size_t draw_begin, std::size_t draw_end, std::uint32_t layer) {
        const auto draw_target = ui.filters.target(state.device, encoder, root_target, state.surface_format,
            ui.texture_layout, ui.sampler, frame, layer);
        WGPURenderPassColorAttachment layer_attachment =
            WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
        layer_attachment.view = ui.multisample_layer_view
            ? ui.multisample_layer_view
            : ui.layer_view;
        layer_attachment.resolveTarget = ui.multisample_layer_view
            ? ui.layer_view
            : nullptr;
        layer_attachment.loadOp = WGPULoadOp_Clear;
        layer_attachment.storeOp = ui.multisample_layer_view
            ? WGPUStoreOp_Discard
            : WGPUStoreOp_Store;
        layer_attachment.clearValue = WGPUColor{0, 0, 0, 0};
        WGPURenderPassDescriptor layer_descriptor =
            WGPU_RENDER_PASS_DESCRIPTOR_INIT;
        layer_descriptor.colorAttachmentCount = 1;
        layer_descriptor.colorAttachments = &layer_attachment;
        DawnRenderPass layer_pass{wgpuCommandEncoderBeginRenderPass(encoder, &layer_descriptor)};
        wgpuRenderPassEncoderSetBindGroup(
            layer_pass, 0, ui.screen_group, 0, nullptr);
        wgpuRenderPassEncoderSetVertexBuffer(
            layer_pass, 0, ui.vertices, 0, WGPU_WHOLE_SIZE);
        wgpuRenderPassEncoderSetIndexBuffer(
            layer_pass,
            ui.indices,
            WGPUIndexFormat_Uint32,
            0,
            WGPU_WHOLE_SIZE);
        for (std::size_t draw_index = draw_begin; draw_index < draw_end; ++draw_index) {
            const UiRenderDraw& draw = frame.draws[draw_index];
            const std::optional<UiScissorRect> scissor =
                clamped_ui_scissor(draw, frame.width, frame.height);
            if (!scissor) continue;
            wgpuRenderPassEncoderSetScissorRect(
                layer_pass,
                static_cast<std::uint32_t>(scissor->left),
                static_cast<std::uint32_t>(scissor->top),
                static_cast<std::uint32_t>(scissor->width),
                static_cast<std::uint32_t>(scissor->height));
            if (draw.texture_id) {
                const auto texture = ui.textures.find(draw.texture_id);
                if (texture == ui.textures.end()) continue;
                wgpuRenderPassEncoderSetPipeline(
                    layer_pass, ui.texture_pipeline);
                wgpuRenderPassEncoderSetBindGroup(
                    layer_pass,
                    1,
                    draw.nearest_sampling
                        ? texture->second.nearest_group
                        : texture->second.group,
                    0,
                    nullptr);
            } else {
                wgpuRenderPassEncoderSetPipeline(layer_pass, ui.color_pipeline);
            }
            count_gpu_draw(wgpuRenderPassEncoderDrawIndexed,
                layer_pass,
                draw.index_count,
                1,
                draw.first_index,
                0,
                0);
        }
        wgpuRenderPassEncoderEnd(layer_pass);
        layer_pass.reset();

        WGPURenderPassColorAttachment composite_attachment =
            WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
        composite_attachment.view = draw_target.view;
        composite_attachment.loadOp = WGPULoadOp_Load;
        composite_attachment.storeOp = WGPUStoreOp_Store;
        WGPURenderPassDescriptor composite_descriptor =
            WGPU_RENDER_PASS_DESCRIPTOR_INIT;
        composite_descriptor.colorAttachmentCount = 1;
        composite_descriptor.colorAttachments = &composite_attachment;
        DawnRenderPass composite_pass{wgpuCommandEncoderBeginRenderPass(encoder, &composite_descriptor)};
        wgpuRenderPassEncoderSetPipeline(
            composite_pass, ui.composite_pipeline);
        wgpuRenderPassEncoderSetBindGroup(
            composite_pass, 0, ui.screen_group, 0, nullptr);
        wgpuRenderPassEncoderSetBindGroup(
            composite_pass, 1, ui.layer_group, 0, nullptr);
        wgpuRenderPassEncoderSetVertexBuffer(
            composite_pass, 0, ui.vertices, 0, WGPU_WHOLE_SIZE);
        wgpuRenderPassEncoderSetIndexBuffer(
            composite_pass,
            ui.indices,
            WGPUIndexFormat_Uint32,
            0,
            WGPU_WHOLE_SIZE);
        wgpuRenderPassEncoderSetScissorRect(
            composite_pass, 0, 0, frame.width, frame.height);
        count_gpu_draw(wgpuRenderPassEncoderDrawIndexed,
            composite_pass,
            6,
            1,
            frame.composite_first_index,
            0,
            0);
        wgpuRenderPassEncoderEnd(composite_pass);
        composite_pass.reset();
    }, [&](const UiRenderOperation& operation) {
        if (operation.kind == UiRenderOperation::Kind::ResetLayer) {
            ui.filters.reset_layer(operation.index);
        } else if (operation.kind == UiRenderOperation::Kind::Backdrop) {
            render_ui_backdrop_dawn(state.device, encoder, target_texture, target,
                state.surface_format, ui.vertices, ui.indices, ui.sampler, ui.screen_group, ui.texture_layout,
                ui.composite_pipeline, ui.backdrop, frame, operation.index);
        } else {
            render_ui_composite_dawn(state.device, state.queue, encoder, root_target, state.surface_format,
                ui.vertices, ui.indices, ui.sampler, ui.screen_group, ui.texture_layout,
                ui.composite_pipeline, ui.filters, frame, operation.index);
        }
    });
    ui.filters.finish_frame(frame.composites.size());
}
#endif

#if BBLITE_GPU_DEFORMATION
void ensure_background_deformation_uniforms(DawnState& state) {
    if (state.background_deformation_uniforms) return;
    const DeformationUniforms background_deformation =
        build_deformation_uniforms(MeshRecord{}, false);
    state.background_deformation_uniforms = create_buffer(
        state,
        WGPUBufferUsage_Uniform,
        &background_deformation,
        sizeof(background_deformation));
}
#endif

#if BBLITE_GPU_INSTANCING
void ensure_background_instance_resources(DawnState& state) {
    if (state.background_instances) return;
    std::array<float, 16> identity{};
    identity[0] = 1.0f;
    identity[5] = 1.0f;
    identity[10] = 1.0f;
    identity[15] = 1.0f;
    state.background_instances = create_buffer(
        state,
        WGPUBufferUsage_Vertex,
        identity.data(),
        sizeof(identity));
    state.background_instance_uniform = create_buffer(
        state,
        WGPUBufferUsage_Uniform,
        identity.data(),
        sizeof(identity));
}
#endif

WGPUTexture create_solid_texture(
    DawnState& state,
    const std::vector<std::uint8_t>& texel,
    WGPUTextureFormat format,
    std::uint32_t layers) {
    WGPUTextureDescriptor descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
    descriptor.usage =
        WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
    descriptor.size = {1, 1, layers};
    descriptor.format = format;
    DawnTexture texture{wgpuDeviceCreateTexture(state.device, &descriptor)};
    if (!texture) dawn_error("wgpuDeviceCreateTexture solid");
    for (std::uint32_t layer = 0; layer < layers; ++layer) {
        WGPUTexelCopyTextureInfo destination =
            WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
        destination.texture = texture;
        destination.origin = {0, 0, layer};
        WGPUTexelCopyBufferLayout layout{};
        layout.offset = 0;
        layout.bytesPerRow = 256;
        layout.rowsPerImage = 1;
        const WGPUExtent3D size{1, 1, 1};
        std::array<std::uint8_t, 256> row{};
        std::memcpy(row.data(), texel.data(), texel.size());
        wgpuQueueWriteTexture(
            state.queue,
            &destination,
            row.data(),
            row.size(),
            &layout,
            &size);
    }
    return texture.release();
}

// The pinned mip generator's fullscreen-triangle bilinear blit
// (src/texture/generate-mipmaps.ts BLIT_SHADER) is deployed from
// generation like every other pinned shader — mip-blit.vert/.frag —
// instead of living here as a C++ string invisible to shader provenance.
// The generator itself lives in pal_dawn_shared.hpp (`DawnMipGenerator`),
// shared with the pure-2D sprite driver; these are the scene driver's
// spellings over its own state.
void record_mipmaps(
    DawnState& state,
    WGPUCommandEncoder encoder,
    WGPUTexture texture,
    WGPUTextureFormat format,
    std::uint32_t mip_count,
    std::int32_t face = -1) {
    record_mipmaps(
        state.device, state.mips, encoder, texture, format, mip_count, face);
}

void generate_mipmaps(
    DawnState& state,
    WGPUTexture texture,
    WGPUTextureFormat format,
    std::uint32_t mip_count,
    std::int32_t face = -1) {
    generate_mipmaps(
        state.device,
        state.queue,
        state.mips,
        texture,
        format,
        mip_count,
        face);
}

/**
 * The WebGPU enumerator for one shared block format. The pin writes
 * `GPUTextureFormat` strings, so this is the C API's own spelling of the
 * name the container states.
 */
WGPUTextureFormat compressed_texture_format(std::string_view name) {
    switch (compressed_block_format(name)) {
        case CompressedBlockFormat::bc1_rgba_unorm:
            return WGPUTextureFormat_BC1RGBAUnorm;
        case CompressedBlockFormat::bc2_rgba_unorm:
            return WGPUTextureFormat_BC2RGBAUnorm;
        case CompressedBlockFormat::bc3_rgba_unorm:
            return WGPUTextureFormat_BC3RGBAUnorm;
        case CompressedBlockFormat::bc7_rgba_unorm:
            return WGPUTextureFormat_BC7RGBAUnorm;
        case CompressedBlockFormat::bc7_rgba_unorm_srgb:
            return WGPUTextureFormat_BC7RGBAUnormSrgb;
    }
    throw std::runtime_error(
        "Dawn has no compressed texture format for '" +
        std::string(name) + "'.");
}

/**
 * One family's cache slot for a variant, grown to that family's table.
 *
 * The two receiver caches are indexed by variant and sized by whichever
 * variant table the family composes, so which vector and which count is the
 * caller's to say and the resize is not written twice.
 */
template <typename T>
T& shadow_cache_slot(
    std::vector<T>& cache,
    std::size_t variants,
    std::size_t variant) {
    if (cache.size() < variants) cache.resize(variants, nullptr);
    return cache[variant];
}

#if BBLITE_PINNED_MATERIAL_VARIANTS
/**
 * One reflected group-1 row as a layout entry.
 *
 * The rows are one shape for both composed material families, so their
 * mapping onto WebGPU's entry is one function: a new `PinnedBindingKind` arm
 * is added once rather than in each family's loop. `depth_emissive` is the
 * Standard family's own trap -- a record whose emissive is the depth render
 * texture binds that pair unfilterable, with a non-filtering sampler.
 */
WGPUBindGroupLayoutEntry variant_layout_entry(
    const upstream::PinnedVariantBinding& binding,
    bool depth_emissive) {
    WGPUBindGroupLayoutEntry layout_entry =
        WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
    layout_entry.binding = binding.binding;
    // Group 1 is shared, so a binding declared only in the vertex stage --
    // the bone palette is the one -- must not be visible to the fragment.
    layout_entry.visibility = 0;
    if (binding.vertex) layout_entry.visibility |= WGPUShaderStage_Vertex;
    if (binding.fragment) {
        layout_entry.visibility |= WGPUShaderStage_Fragment;
    }
    switch (binding.kind) {
        case upstream::PinnedBindingKind::sampler:
            layout_entry.sampler.type = depth_emissive
                ? WGPUSamplerBindingType_NonFiltering
                : WGPUSamplerBindingType_Filtering;
            break;
        case upstream::PinnedBindingKind::storageBuffer:
            // The morph arms' deltas and weights.
            layout_entry.buffer.type = WGPUBufferBindingType_ReadOnlyStorage;
            break;
        case upstream::PinnedBindingKind::uniformBuffer:
            // A group-1 uniform block past mesh and material: the vertex
            // `up` block, the geometry arms' gpUniforms, and a displaced
            // `mat`/`mesh` block riding a reflected row.
            layout_entry.buffer.type = WGPUBufferBindingType_Uniform;
            break;
        default:
            // An rgba32float texture read with textureLoad cannot be bound
            // as filterable; the pin's bone palette is exactly that. An
            // INTEGER texture is a third case -- WebGPU has no sampler for
            // one at all -- and the clustered slice and tile-mask pair are
            // the reached ones.
            layout_entry.texture.sampleType =
                binding.kind ==
                        upstream::PinnedBindingKind::texture2dUint
                    ? WGPUTextureSampleType_Uint
                : binding.kind ==
                        upstream::PinnedBindingKind::texture2dLoad ||
                    depth_emissive
                    ? WGPUTextureSampleType_UnfilterableFloat
                    : WGPUTextureSampleType_Float;
            layout_entry.texture.viewDimension =
                binding.kind == upstream::PinnedBindingKind::textureCube
                    ? WGPUTextureViewDimension_Cube
                    : binding.kind == upstream::PinnedBindingKind::textureCubeArray
                    ? WGPUTextureViewDimension_CubeArray
                    : WGPUTextureViewDimension_2D;
            break;
    }
    return layout_entry;
}
#endif

/**
 * A texture whose bytes are already blocks: the container's own mip chain,
 * uploaded level by level with nothing decoded and nothing generated.
 */
WGPUTexture upload_compressed_texture(
    DawnState& state,
    const CompressedTexture& compressed) {
    // The device request is opportunistic (the pinned engine asks for every
    // optional feature the adapter offers), so an adapter without block
    // compression reaches here rather than failing at creation. Refuse by
    // name, as the SDL_GPU sibling does through
    // `SDL_GPUTextureSupportsFormat`.
    if (!wgpuAdapterHasFeature(
            state.adapter,
            WGPUFeatureName_TextureCompressionBC)) {
        throw std::runtime_error(
            "This adapter cannot sample '" +
            std::string(compressed.format) +
            "' textures: it reports no block-compression feature.");
    }
    WGPUTextureDescriptor descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
    descriptor.usage =
        WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
    descriptor.size = {compressed.width, compressed.height, 1};
    descriptor.format = compressed_texture_format(compressed.format);
    descriptor.mipLevelCount =
        static_cast<std::uint32_t>(compressed.mips.size());
    DawnTexture texture{wgpuDeviceCreateTexture(state.device, &descriptor)};
    if (!texture) dawn_error("wgpuDeviceCreateTexture compressed");
    for (std::size_t level = 0; level < compressed.mips.size(); ++level) {
        const CompressedMipLevel& mip = compressed.mips[level];
        const CompressedMipCopy geometry =
            compressed_mip_copy(compressed, mip);
        WGPUTexelCopyTextureInfo destination =
            WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
        destination.texture = texture;
        destination.mipLevel = static_cast<std::uint32_t>(level);
        WGPUTexelCopyBufferLayout layout{};
        layout.offset = 0;
        layout.bytesPerRow = geometry.row_bytes;
        layout.rowsPerImage = geometry.block_rows;
        const WGPUExtent3D size{geometry.width, geometry.height, 1};
        wgpuQueueWriteTexture(
            state.queue,
            &destination,
            mip.bytes.data(),
            mip.bytes.size(),
            &layout,
            &size);
    }
    return texture.release();
}

WGPUTexture upload_material_texture(
    DawnState& state,
    const TextureData& texture_data,
    bool srgb,
    const std::array<std::uint8_t, 4>& fallback,
    std::uint32_t& out_mip_count) {
    // A compressed slot carries its own format and its own chain, so the
    // table's sRGB rule has nothing to select: the container states which
    // of the two views its blocks decode through.
    if (!texture_data.compressed.mips.empty()) {
        out_mip_count =
            static_cast<std::uint32_t>(texture_data.compressed.mips.size());
        return upload_compressed_texture(state, texture_data.compressed);
    }
    const DecodedImage image =
        decode_uploadable_image(texture_data, fallback);
    const std::uint32_t mip_count = full_mip_chain(
        static_cast<std::uint32_t>(image.width),
        static_cast<std::uint32_t>(image.height));
    out_mip_count = mip_count;
    const WGPUTextureFormat format = srgb
        ? WGPUTextureFormat_RGBA8UnormSrgb
        : WGPUTextureFormat_RGBA8Unorm;
    WGPUTextureDescriptor descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
    descriptor.usage =
        WGPUTextureUsage_TextureBinding |
        WGPUTextureUsage_RenderAttachment |
        WGPUTextureUsage_CopyDst;
    descriptor.size = {
        static_cast<std::uint32_t>(image.width),
        static_cast<std::uint32_t>(image.height),
        1,
    };
    descriptor.format = format;
    descriptor.mipLevelCount = mip_count;
    DawnTexture texture{wgpuDeviceCreateTexture(state.device, &descriptor)};
    if (!texture) dawn_error("wgpuDeviceCreateTexture material");
    WGPUTexelCopyTextureInfo destination =
        WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
    destination.texture = texture;
    WGPUTexelCopyBufferLayout layout{};
    layout.offset = 0;
    layout.bytesPerRow = static_cast<std::uint32_t>(image.width) * 4;
    layout.rowsPerImage = static_cast<std::uint32_t>(image.height);
    const WGPUExtent3D size{
        static_cast<std::uint32_t>(image.width),
        static_cast<std::uint32_t>(image.height),
        1,
    };
    wgpuQueueWriteTexture(
        state.queue,
        &destination,
        image.rgba.data(),
        image.rgba.size(),
        &layout,
        &size);
    generate_mipmaps(state, texture, format, mip_count);
    return texture.release();
}

// `.babylon` reflection cube, matching the pinned loadCubeTexture:
// rgba8unorm faces with a full GPU-blit mip chain generated per face.
WGPUTexture upload_reflection_cube(
    DawnState& state,
    const std::array<TextureData, 6>& texture_data) {
    std::array<DecodedImage, 6> images;
    int width = 1;
    int height = 1;
    for (std::size_t index = 0; index < images.size(); ++index) {
        if (!texture_data[index].bytes.empty()) {
            images[index] = decode_image(
                js::ArrayBuffer(texture_data[index].bytes));
        } else {
            images[index].width = 1;
            images[index].height = 1;
            images[index].rgba = {0, 0, 0, 255};
        }
        if (index == 0) {
            width = images[index].width;
            height = images[index].height;
        } else if (
            images[index].width != width ||
            images[index].height != height) {
            throw std::runtime_error(
                "Cube texture faces must have matching dimensions.");
        }
    }
    const std::uint32_t mip_count = full_mip_chain(
        static_cast<std::uint32_t>(width),
        static_cast<std::uint32_t>(height));
    WGPUTextureDescriptor descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
    descriptor.usage =
        WGPUTextureUsage_TextureBinding |
        WGPUTextureUsage_RenderAttachment |
        WGPUTextureUsage_CopyDst;
    descriptor.size = {
        static_cast<std::uint32_t>(width),
        static_cast<std::uint32_t>(height),
        6,
    };
    descriptor.format = WGPUTextureFormat_RGBA8Unorm;
    descriptor.mipLevelCount = mip_count;
    DawnTexture texture{wgpuDeviceCreateTexture(state.device, &descriptor)};
    if (!texture) dawn_error("wgpuDeviceCreateTexture reflection cube");
    for (std::uint32_t face = 0; face < 6; ++face) {
        const DecodedImage& image = images[face];
        WGPUTexelCopyTextureInfo destination =
            WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
        destination.texture = texture;
        destination.origin = {0, 0, face};
        WGPUTexelCopyBufferLayout layout{};
        layout.bytesPerRow = static_cast<std::uint32_t>(width) * 4;
        layout.rowsPerImage = static_cast<std::uint32_t>(height);
        const WGPUExtent3D size{
            static_cast<std::uint32_t>(width),
            static_cast<std::uint32_t>(height),
            1,
        };
        wgpuQueueWriteTexture(
            state.queue,
            &destination,
            image.rgba.data(),
            image.rgba.size(),
            &layout,
            &size);
        generate_mipmaps(
            state,
            texture,
            WGPUTextureFormat_RGBA8Unorm,
            mip_count,
            static_cast<std::int32_t>(face));
    }
    return texture.release();
}

// create_texture_sampler moved to pal_dawn_shared.hpp so the sprite pass
// derives its atlas sampler from the record the same way (it used to
// hardcode a descriptor beside this translation).

// Upload the environment cubemap exactly as the browser does: rgba16f
// faces with pre-baked mips, uploaded unflipped (the SDL_GPU vertical
// reversal is an SDL-only adaptation).
WGPUTexture create_environment_texture(DawnState& state, const EnvironmentState& environment, std::uint32_t layers = 6) {
    const bool has_environment = environment_cube_present(environment);
    if (!has_environment) return nullptr;
    const std::uint32_t width = environment.specular_width;
    const std::uint32_t mip_count = environment.specular_mip_count;
    WGPUTextureDescriptor descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
    descriptor.usage =
        WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
    descriptor.size = {width, width, layers};
    descriptor.format = WGPUTextureFormat_RGBA16Float;
    descriptor.mipLevelCount = mip_count;
    DawnTexture texture{wgpuDeviceCreateTexture(state.device, &descriptor)};
    if (!texture) dawn_error("wgpuDeviceCreateTexture environment");
    for (std::uint32_t mip = 0; mip < mip_count; ++mip) {
        const std::uint32_t mip_width = std::max(width >> mip, 1u);
        for (std::uint32_t face = 0; face < layers; ++face) {
            const TextureData& face_data =
                environment.specular_faces[
                    static_cast<std::size_t>(mip) * layers + face];
            std::vector<std::uint16_t> half_pixels;
            const std::uint8_t* source_bytes = nullptr;
            std::size_t byte_size = 0;
            if (environment.specular_rgba16f) {
                byte_size = static_cast<std::size_t>(mip_width) *
                    mip_width * 8;
                if (face_data.bytes.size() != byte_size) {
                    throw std::runtime_error(
                        "Compiled HDR cubemap face has an invalid size.");
                }
                source_bytes = face_data.bytes.data();
            } else {
                // RGBD faces are Y-flipped on upload, matching the
                // pinned uploadCubemapRGBD (BJS invertY cubemaps). The
                // decode already hands back the upload's own type, so the
                // flip is a row swap in place rather than a second buffer.
                int face_width = 0;
                int face_height = 0;
                half_pixels = decode_rgbd(face_data, face_width, face_height);
                const std::size_t row_channels =
                    static_cast<std::size_t>(face_width) * 4;
                for (int row = 0; row < face_height / 2; ++row) {
                    const auto top = half_pixels.begin() +
                        static_cast<std::ptrdiff_t>(
                            static_cast<std::size_t>(row) * row_channels);
                    const auto bottom = half_pixels.begin() +
                        static_cast<std::ptrdiff_t>(
                            static_cast<std::size_t>(
                                face_height - row - 1) * row_channels);
                    std::swap_ranges(
                        top,
                        top + static_cast<std::ptrdiff_t>(row_channels),
                        bottom);
                }
                source_bytes = reinterpret_cast<const std::uint8_t*>(
                    half_pixels.data());
                byte_size =
                    half_pixels.size() * sizeof(std::uint16_t);
            }
            WGPUTexelCopyTextureInfo destination =
                WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
            destination.texture = texture;
            destination.mipLevel = mip;
            destination.origin = {0, 0, face};
            WGPUTexelCopyBufferLayout layout{};
            layout.bytesPerRow = mip_width * 8;
            layout.rowsPerImage = mip_width;
            const WGPUExtent3D size{mip_width, mip_width, 1};
            wgpuQueueWriteTexture(
                state.queue,
                &destination,
                source_bytes,
                byte_size,
                &layout,
                &size);
        }
    }
    return texture.release();
}

void upload_environment(DawnState& state, const EnvironmentState& environment) {
    const auto texture = create_environment_texture(state, environment);
    if (!texture) return;
    if (state.environment_cube_view) {
        wgpuTextureViewRelease(state.environment_cube_view);
    }
    if (state.environment_cube) {
        wgpuTextureRelease(state.environment_cube);
    }
    state.environment_cube = texture;
    WGPUTextureViewDescriptor view_descriptor =
        WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
    view_descriptor.dimension = WGPUTextureViewDimension_Cube;
    view_descriptor.arrayLayerCount = 6;
    state.environment_cube_view =
        create_dawn_texture_view(texture, &view_descriptor);
}

#if BBLITE_LOCAL_CUBEMAP
DawnState::LocalCubemap* ensure_local_cubemap(DawnState& state, const MaterialRecord* material) {
    if (!material || !material->local_environment) return nullptr;
    const auto& source = material->local_environment;
    if (const auto found = state.local_cubemaps.find(source.get()); found != state.local_cubemaps.end()) return found->second.get();
    auto gpu = std::make_unique<DawnState::LocalCubemap>();
    gpu->source = source;
    gpu->texture = create_environment_texture(state, local_cubemap_texture(*source), source->layers);
    if (!gpu->texture) dawn_error("Local cubemap texture upload failed.");
    WGPUTextureViewDescriptor view = WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
    view.dimension = WGPUTextureViewDimension_CubeArray;
    view.arrayLayerCount = source->layers;
    gpu->array_view = create_dawn_texture_view(gpu->texture, &view);
    if (source->overrides_environment) {
        view.dimension = WGPUTextureViewDimension_Cube;
        view.arrayLayerCount = 6;
        gpu->cube_view = create_dawn_texture_view(gpu->texture, &view);
    }
    gpu->uniform = create_buffer(state, WGPUBufferUsage_Uniform, source->uniform_data.data(), source->uniform_data.size() * sizeof(std::uint32_t));
    gpu->grid = create_buffer(state, WGPUBufferUsage_Storage, source->grid_data.data(), source->grid_data.size() * sizeof(std::uint32_t));
    auto* result = gpu.get();
    state.local_cubemaps.emplace(source.get(), std::move(gpu));
    return result;
}
#endif

void upload_brdf(DawnState& state, const EnvironmentState& environment) {
    std::vector<std::uint16_t> half_pixels;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    if (environment.brdf_lut_rgba16f) {
        const std::size_t expected_size =
            static_cast<std::size_t>(environment.brdf_lut_width) *
            environment.brdf_lut_width * 8;
        if (
            environment.brdf_lut_width == 0 ||
            environment.brdf_lut.bytes.size() != expected_size) {
            throw std::runtime_error(
                "Compiled BRDF LUT has invalid RGBA16F dimensions.");
        }
        width = height = environment.brdf_lut_width;
        half_pixels.resize(expected_size / 2);
        std::memcpy(
            half_pixels.data(),
            environment.brdf_lut.bytes.data(),
            expected_size);
    } else {
        // No empty-bytes guard: the shared decode's own empty arm yields
        // the 1x1 {0,0,0,1} half texel, so a build with no LUT samples
        // the same fallback SDL_GPU uploads. An early return kept this
        // backend's startup zeros instead -- a silent backend delta.
        int lut_width = 0;
        int lut_height = 0;
        half_pixels =
            decode_rgbd(environment.brdf_lut, lut_width, lut_height);
        width = static_cast<std::uint32_t>(lut_width);
        height = static_cast<std::uint32_t>(lut_height);
    }
    WGPUTextureDescriptor descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
    descriptor.usage =
        WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
    descriptor.size = {width, height, 1};
    descriptor.format = WGPUTextureFormat_RGBA16Float;
    WGPUTexture texture =
        wgpuDeviceCreateTexture(state.device, &descriptor);
    if (!texture) dawn_error("wgpuDeviceCreateTexture brdf");
    WGPUTexelCopyTextureInfo destination =
        WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
    destination.texture = texture;
    WGPUTexelCopyBufferLayout layout{};
    layout.bytesPerRow = width * 8;
    layout.rowsPerImage = height;
    const WGPUExtent3D size{width, height, 1};
    wgpuQueueWriteTexture(
        state.queue,
        &destination,
        half_pixels.data(),
        half_pixels.size() * sizeof(std::uint16_t),
        &layout,
        &size);
    if (state.brdf_view) wgpuTextureViewRelease(state.brdf_view);
    if (state.brdf_texture) wgpuTextureRelease(state.brdf_texture);
    state.brdf_texture = texture;
    state.brdf_view = create_dawn_texture_view(texture, nullptr);
}

[[noreturn]] void fragment_module_for(
    DawnState& state,
    bool standard) {
    (void)state;
    // Both mesh families draw through their composed variants; the
    // legacy mesh pipeline serves only the grid and custom-shader
    // kinds, which never reach this fork.
    dawn_error(
        standard
            ? "transcribed Standard fragment requested; the composed "
              "variants own every Standard draw."
            : "transcribed PBR fragment requested; the pinned path owns "
              "every PBR draw.");
}

std::uint32_t task_sample_count(
    const DawnState& state,
    std::uint32_t requested) {
    return requested == 4 ? state.sample_count : 1u;
}

WGPUTextureFormat texture_format(TextureFormatClass format) {
    switch (format) {
        case TextureFormatClass::rgba8_unorm:
            return WGPUTextureFormat_RGBA8Unorm;
        case TextureFormatClass::r8_unorm:
            return WGPUTextureFormat_R8Unorm;
        case TextureFormatClass::r16_float:
            return WGPUTextureFormat_R16Float;
        case TextureFormatClass::rg16_float:
            return WGPUTextureFormat_RG16Float;
        case TextureFormatClass::r32_float:
            return WGPUTextureFormat_R32Float;
        case TextureFormatClass::rgba16_float:
            return WGPUTextureFormat_RGBA16Float;
    }
    return WGPUTextureFormat_RGBA16Float;
}

WGPUTextureFormat geometry_texture_format(
    const GeometryTextureDescription& description) {
    return texture_format(geometry_format_class(description));
}

WGPUColor geometry_clear_color(GeometryTextureType type) {
    const double value = geometry_clear_component(type);
    return WGPUColor{value, value, value, value};
}

WGPUTexture create_frame_texture(
    DawnState& state,
    WGPUTextureFormat format,
    std::uint32_t samples,
    std::uint32_t width,
    std::uint32_t height,
    WGPUTextureUsage usage,
    std::uint32_t layers = 1) {
    WGPUTextureDescriptor descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
    descriptor.usage = usage;
    descriptor.size = {width, height, layers};
    descriptor.format = format;
    descriptor.sampleCount = samples;
    DawnTexture texture{wgpuDeviceCreateTexture(state.device, &descriptor)};
    if (!texture) dawn_error("wgpuDeviceCreateTexture frame graph");
    return texture.release();
}

// Mirrors the SDL backend's create_frame_graph_textures: render
// targets sized per record (or canvas), sampled aliases for
// single-sample attachments, and per-geometry-task MRT chains.
void create_frame_graph_textures(
    DawnState& state,
    const Engine& engine,
    std::uint32_t width,
    std::uint32_t height) {
    if (
        state.render_targets.size() == engine.render_targets.size() &&
        state.frame_graph_width == width &&
        state.frame_graph_height == height &&
        !surface_targets_changed(engine, state.render_targets, width, height)) {
        return;
    }
    const auto target_plans = plan_render_targets(engine, width, height, state.surface_format,
        [](TextureFormatClass format) { return texture_format(format); });
    state.release_frame_graph_textures();
#if BBLITE_SHADOW_RECEIVERS
    // Every shadow map was just released with the other targets, so the
    // render gate's "already rendered" sentinels no longer describe a
    // texture that exists: each generator's next frame must render.
    state.shadow_refresh.invalidate_rendered_maps();
#endif
    state.frame_graph_width = width;
    state.frame_graph_height = height;
    state.render_targets.resize(engine.render_targets.size());
    for (
        std::size_t index = 0;
        index < engine.render_targets.size();
        ++index) {
        const RenderTargetRecord& record = engine.render_targets[index];
        DawnRenderTarget& target = state.render_targets[index];
        const auto& planned = target_plans[index];
        target.width = planned.width;
        target.height = planned.height;
        target.color_format = planned.color_format;
        if (record.swapchain) continue;
        target.allocation = ++state.render_target_allocations;
        const auto samples = task_sample_count(state, record.samples);
        const auto color_format = planned.color_format;
        if (record.has_color) {
            target.color = create_frame_texture(
                state,
                color_format,
                samples,
                target.width,
                target.height,
                samples == 1
                    // A single-sample frame turns the graph's resolve
                    // step into a copy, and the target of one is a
                    // colour target of another, so both ends of that
                    // copy are the same kind of texture.
                    ? WGPUTextureUsage_RenderAttachment |
                        WGPUTextureUsage_TextureBinding |
                        WGPUTextureUsage_CopySrc |
                        WGPUTextureUsage_CopyDst
                    : WGPUTextureUsage_RenderAttachment);
            target.color_view = create_dawn_texture_view(
                target.color, nullptr, "wgpuTextureCreateView frame graph color");
            if (samples == 1) {
                target.sampled_color = target.color.retain();
                target.sampled_color_view = target.color_view.retain();
            } else {
                target.sampled_color = create_frame_texture(
                    state,
                    color_format,
                    1,
                    target.width,
                    target.height,
                    WGPUTextureUsage_RenderAttachment |
                        WGPUTextureUsage_TextureBinding |
                        WGPUTextureUsage_CopySrc);
                target.sampled_color_view = create_dawn_texture_view(
                    target.sampled_color,
                    nullptr,
                    "wgpuTextureCreateView frame graph sampled color");
            }
        }
        if (record.has_depth) {
            // A shadow map states its own format: the pinned generator
            // creates `depth32float` where the frame's own attachments take
            // the browser's depth24plus-stencil8.
            // `create_render_target` normalises this, so the record's own
            // invariant is that it is at least one.
            const std::uint32_t depth_layers = record.depth_layers;
            target.depth = create_frame_texture(
                state,
                record.shadow_map
                    ? WGPUTextureFormat_Depth32Float
                    : WGPUTextureFormat_Depth24PlusStencil8,
                samples,
                target.width,
                target.height,
                record.sampled_depth
                    ? WGPUTextureUsage_RenderAttachment |
                        WGPUTextureUsage_TextureBinding
                    : WGPUTextureUsage_RenderAttachment,
                depth_layers);
            // One attachment view per layer:
            // `ensureCsmShadowTaskState` builds each cascade's render
            // target over `createView({dimension:"2d", baseArrayLayer:i,
            // arrayLayerCount:1})`, and a pass writes exactly one of them.
            target.depth_layer_views.resize(depth_layers);
            for (std::uint32_t layer = 0; layer < depth_layers; ++layer) {
                WGPUTextureViewDescriptor layer_descriptor =
                    WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
                layer_descriptor.dimension = WGPUTextureViewDimension_2D;
                layer_descriptor.baseArrayLayer = layer;
                layer_descriptor.arrayLayerCount = 1;
                target.depth_layer_views[layer] = create_dawn_texture_view(
                    target.depth, &layer_descriptor, "wgpuTextureCreateView frame graph depth layer");
            }
            if (record.sampled_depth) {
                WGPUTextureViewDescriptor depth_view_descriptor =
                    WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
                depth_view_descriptor.aspect =
                    WGPUTextureAspect_DepthOnly;
                // The cascaded receiver declares `texture_depth_2d_array`,
                // so its sampled view is the pin's own
                // `dimension: "2d-array"` one over every layer.
                if (depth_layers > 1) {
                    depth_view_descriptor.dimension =
                        WGPUTextureViewDimension_2DArray;
                    depth_view_descriptor.arrayLayerCount = depth_layers;
                }
                target.depth_sampled_view = create_dawn_texture_view(
                    target.depth,
                    &depth_view_descriptor,
                    "wgpuTextureCreateView frame graph sampled depth");
                // A shadow map is read through a comparison sampler on the
                // depth texture itself, and a screen-space effect reads a
                // colour-carrying target's depth through the depth-only view
                // above. The remaining sampled depth -- a colour-less target
                // -- is read as a Standard emissive slot, which needs the
                // r32float copy so it decodes like SDL's D3D12 depth SRV;
                // `dawn_render_target_texture` hands out nothing else.
                if (!record.shadow_map && !record.has_color) {
                    target.depth_copy = create_frame_texture(
                        state,
                        WGPUTextureFormat_R32Float,
                        1,
                        target.width,
                        target.height,
                        WGPUTextureUsage_RenderAttachment |
                            WGPUTextureUsage_TextureBinding);
                    target.depth_copy_view = create_dawn_texture_view(
                        target.depth_copy, nullptr, "wgpuTextureCreateView frame graph depth copy");
                }
            }
        }
    }

    if (state.geometry_tasks.size() < engine.frame_tasks.size()) {
        state.geometry_tasks.resize(engine.frame_tasks.size());
    }
#if defined(BBLITE_HAS_POST_PROCESS) && BBLITE_HAS_POST_PROCESS
    if (state.post_process_tasks.size() < engine.frame_tasks.size()) {
        state.post_process_tasks.resize(engine.frame_tasks.size());
    }
    // Each post-process task keeps one entry per pass it records, sized here
    // rather than grown from the record path: a composite's chain is known
    // before a frame starts and its entries own vectors worth not moving.
    for (std::size_t index = 0; index < engine.frame_tasks.size(); ++index) {
        const FrameTaskRecord& task = engine.frame_tasks[index];
        // A screen-space task's history copy and composite are ordinary
        // passes in the same list, recorded by the same pass path.
        if (
            task.kind != FrameTaskKind::post_process &&
            task.kind != FrameTaskKind::screen_space) {
            continue;
        }
        if (
            state.post_process_tasks[index].size() <
            task.post_process.passes.size()) {
            state.post_process_tasks[index].resize(
                task.post_process.passes.size());
        }
    }
#endif
#if defined(BBLITE_HAS_SCREEN_SPACE) && BBLITE_HAS_SCREEN_SPACE
    if (state.screen_space_tasks.size() < engine.frame_tasks.size()) {
        state.screen_space_tasks.resize(engine.frame_tasks.size());
    }
#endif
    for (
        std::size_t index = 0;
        index < engine.frame_tasks.size();
        ++index) {
        const FrameTaskRecord& record = engine.frame_tasks[index];
        if (record.kind != FrameTaskKind::geometry) continue;
        DawnGeometryTask& task = state.geometry_tasks[index];
        task.depth_borrowed = geometry_depth_is_borrowed(engine, index);
        const std::uint32_t samples =
            task_sample_count(state, record.geometry.samples);
        task.colors.reserve(record.geometry.attachments.size());
        for (const GeometryTextureDescription& description :
             record.geometry.attachments) {
            const WGPUTextureFormat format =
                geometry_texture_format(description);
            DawnTexture color{create_frame_texture(
                state,
                format,
                samples,
                width,
                height,
                samples == 1
                    ? WGPUTextureUsage_RenderAttachment |
                        WGPUTextureUsage_TextureBinding
                    : WGPUTextureUsage_RenderAttachment)};
            task.colors.push_back(std::move(color));
            task.color_views.push_back(DawnTextureView{create_dawn_texture_view(
                task.colors.back(), nullptr, "wgpuTextureCreateView geometry task color")});
            if (samples == 1) {
                task.sampled_colors.push_back(task.colors.back().retain());
                task.sampled_views.push_back(task.color_views.back().retain());
            } else {
                DawnTexture sampled{create_frame_texture(
                    state,
                    format,
                    1,
                    width,
                    height,
                    WGPUTextureUsage_RenderAttachment |
                        WGPUTextureUsage_TextureBinding)};
                task.sampled_colors.push_back(std::move(sampled));
                task.sampled_views.push_back(DawnTextureView{create_dawn_texture_view(
                    task.sampled_colors.back(), nullptr, "wgpuTextureCreateView geometry task sampled color")});
            }
        }
        task.depth = create_frame_texture(
            state,
            WGPUTextureFormat_Depth24PlusStencil8,
            samples,
            width,
            height,
            WGPUTextureUsage_RenderAttachment);
        task.depth_view = create_dawn_texture_view(
            task.depth, nullptr, "wgpuTextureCreateView geometry task depth");
    }
}

#if BBLITE_GPU_DEFORMATION
constexpr std::uint32_t base_vertex_attribute_count = 16;
#else
constexpr std::uint32_t base_vertex_attribute_count = 8;
#endif

// The GpuVertex attribute table shared by mesh, skybox, and ground
// pipelines; deformation appends joints/weights/morph deltas at
// locations 8-15 exactly like the SDL backend.
void fill_base_vertex_attributes(WGPUVertexAttribute* attributes) {
    const auto attribute = [&](
                               std::uint32_t location,
                               WGPUVertexFormat format,
                               std::uint64_t offset) {
        attributes[location] = WGPUVertexAttribute{};
        attributes[location].format = format;
        attributes[location].offset = offset;
        attributes[location].shaderLocation = location;
    };
    attribute(0, WGPUVertexFormat_Float32x3, 0);
    attribute(1, WGPUVertexFormat_Float32x3, 12);
    attribute(2, WGPUVertexFormat_Float32x4, 24);
    attribute(3, WGPUVertexFormat_Float32x2, 40);
    attribute(4, WGPUVertexFormat_Float32x3, 48);
    attribute(5, WGPUVertexFormat_Float32x2, 60);
    attribute(6, WGPUVertexFormat_Float32x4, 68);
    attribute(7, WGPUVertexFormat_Float32x3, 84);
#if BBLITE_GPU_DEFORMATION
    attribute(8, WGPUVertexFormat_Float32x4, 96);
    attribute(9, WGPUVertexFormat_Float32x4, 112);
    attribute(10, WGPUVertexFormat_Float32x3, 128);
    attribute(11, WGPUVertexFormat_Float32x3, 140);
    attribute(12, WGPUVertexFormat_Float32x3, 152);
    attribute(13, WGPUVertexFormat_Float32x3, 164);
    attribute(14, WGPUVertexFormat_Float32x3, 176);
    attribute(15, WGPUVertexFormat_Float32x3, 188);
#endif
}

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
    bool grid = false;
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
PipelineKindTraits pipeline_traits(upstream::RenderPipelineKind kind) {
    const RenderPipelineKindTraits traits = pipeline_kind_traits(kind);
    if (traits.family == upstream::RenderMaterialKind::node) {
        dawn_error(
            "render pipeline kind " +
            std::to_string(static_cast<int>(kind)) +
            " is not implemented yet.");
    }
    PipelineKindTraits result;
    result.standard =
        traits.family == upstream::RenderMaterialKind::standard;
    result.transparent = traits.transparent;
    result.cull = dawn_cull_mode(traits.cull);
    result.front = traits.clockwise_front_face
        ? WGPUFrontFace_CW
        : WGPUFrontFace_CCW;
    result.grid = traits.family == upstream::RenderMaterialKind::grid;
    result.shader =
        traits.family == upstream::RenderMaterialKind::shader;
    result.shader_a2c = pipeline_kind_wants_a2c(kind);
    // buildPrimitiveState's own table, in WebGPU's names. Every index draws
    // through the loader's uint32 buffer, so a strip's index format is that.
    switch (traits.topology) {
        case MeshTopology::triangles:
            result.topology = WGPUPrimitiveTopology_TriangleList;
            break;
        case MeshTopology::points:
            result.topology = WGPUPrimitiveTopology_PointList;
            break;
        case MeshTopology::lines:
            result.topology = WGPUPrimitiveTopology_LineList;
            break;
        case MeshTopology::line_strip:
            result.topology = WGPUPrimitiveTopology_LineStrip;
            result.strip_index_format = WGPUIndexFormat_Uint32;
            break;
    }
    return result;
}

#if BBLITE_PINNED_MATERIALS
// Babylon Lite's own bind groups, as its composed fragments declare them.
//
// The generated `pbr_variants.hpp` mirrors the four blocks -- SceneUniforms,
// LightEntry, MeshUniforms and one MaterialUniforms per variant -- from the pin
// itself, so the sizes here are those structs rather than numbers chosen at this
// layer. Texture pairs start at binding 3 because the mesh and material blocks
// take 0 and 1, which is the pin's numbering and not a convention of ours.
// Group 0: the per-pass scene block, then the lights array. One layout for
// every variant, because the pin declares the same two bindings in all of them.
WGPUBindGroupLayout pinned_frame_layout_for(DawnState& state) {
    if (state.pinned_frame_layout) return state.pinned_frame_layout;
    std::array<WGPUBindGroupLayoutEntry, 2> entries{};
    for (std::uint32_t binding = 0; binding < entries.size(); ++binding) {
        entries[binding] = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
        entries[binding].binding = binding;
        // The scene block is read by both stages; the pin's vertex template
        // takes its viewProjection from the same struct the fragment reads.
        entries[binding].visibility = binding == 0
            ? WGPUShaderStage_Vertex | WGPUShaderStage_Fragment
            : WGPUShaderStage_Fragment;
        entries[binding].buffer.type = WGPUBufferBindingType_Uniform;
    }
    WGPUBindGroupLayoutDescriptor descriptor =
        WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
    descriptor.entryCount = entries.size();
    descriptor.entries = entries.data();
    state.pinned_frame_layout =
        wgpuDeviceCreateBindGroupLayout(state.device, &descriptor);
    if (!state.pinned_frame_layout) {
        dawn_error("pinned frame bind group layout creation failed.");
    }
    return state.pinned_frame_layout;
}

/**
 * A composed family's pipeline layout: the shared frame group, the variant's
 * own draw group, and the receiver's group 2 where the variant composed one.
 *
 * One builder because the shape is the pin's rather than either family's --
 * both compose the same shadow core into the same third group, and a
 * non-receiver simply declares two.
 */
[[maybe_unused]] WGPUPipelineLayout composed_pipeline_layout(
    DawnState& state,
    WGPUBindGroupLayout draw_layout,
    WGPUBindGroupLayout shadow_layout,
    WGPUPipelineLayout& slot,
    const char* failure) {
    if (slot) return slot;
    std::array<WGPUBindGroupLayout, 3> groups{
        pinned_frame_layout_for(state),
        draw_layout,
        shadow_layout,
    };
    WGPUPipelineLayoutDescriptor descriptor =
        WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
    descriptor.bindGroupLayoutCount = shadow_layout ? 3u : 2u;
    descriptor.bindGroupLayouts = groups.data();
    slot = wgpuDeviceCreatePipelineLayout(state.device, &descriptor);
    if (!slot) dawn_error(failure);
    return slot;
}

#if BBLITE_PBR_VARIANTS > 0
/**
 * Group 1 for one variant: the mesh block, the material block, then exactly the
 * resources that variant's fragment declares.
 *
 * The bindings come from the generated table, which reads them off the composed
 * fragment itself. Declaring a superset instead would force every variant to
 * bind textures it never samples, and — because the indices are dense and
 * per-variant — would bind them at the wrong slots.
 */
WGPUBindGroupLayout pinned_draw_layout_for(
    DawnState& state,
    std::size_t variant) {
    if (state.pinned_draw_layouts.size() < upstream::pbr_variants.size()) {
        state.pinned_draw_layouts.resize(
            upstream::pbr_variants.size(),
            nullptr);
    }
    if (state.pinned_draw_layouts[variant]) {
        return state.pinned_draw_layouts[variant];
    }
    const upstream::PbrVariantEntry& entry = upstream::pbr_variants[variant];
    std::vector<WGPUBindGroupLayoutEntry> entries;
    entries.reserve(2 + entry.binding_count);
    const auto uniform = [&](std::uint32_t binding,
                             WGPUShaderStage visibility) {
        WGPUBindGroupLayoutEntry layout_entry =
            WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
        layout_entry.binding = binding;
        layout_entry.visibility = visibility;
        layout_entry.buffer.type = WGPUBufferBindingType_Uniform;
        entries.push_back(layout_entry);
    };
    // `mesh.world` is read in the vertex stage and `mesh.li` in the fragment,
    // so the mesh block is visible to both.
    uniform(0, WGPUShaderStage_Vertex | WGPUShaderStage_Fragment);
    uniform(1, WGPUShaderStage_Fragment);
    for (std::size_t index = 0; index < entry.binding_count; ++index) {
        entries.push_back(variant_layout_entry(
            upstream::pbr_variant_bindings[entry.first_binding + index],
            false));
    }
    WGPUBindGroupLayoutDescriptor descriptor =
        WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
    descriptor.entryCount = entries.size();
    descriptor.entries = entries.data();
    state.pinned_draw_layouts[variant] =
        wgpuDeviceCreateBindGroupLayout(state.device, &descriptor);
    if (!state.pinned_draw_layouts[variant]) {
        dawn_error("pinned variant draw bind group layout creation failed.");
    }
    return state.pinned_draw_layouts[variant];
}

#endif

// The per-pass scene and lights buffers, sized by the pin's own structs.
void ensure_pinned_frame_buffers(DawnState& state) {
    if (state.pinned_scene_uniforms) return;
    const auto uniform_buffer = [&](std::size_t size) {
        WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
        descriptor.size = static_cast<std::uint64_t>(size);
        descriptor.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
        DawnBuffer buffer{wgpuDeviceCreateBuffer(state.device, &descriptor)};
        if (!buffer) dawn_error("pinned uniform buffer creation failed.");
        return buffer.release();
    };
    state.pinned_scene_uniforms =
        uniform_buffer(sizeof(upstream::SceneUniforms));
    // The pin's own header: 16 bytes of count and padding, then MAX_LIGHTS
    // entries. `getLightsUboSize()` states it and the mirrored LightEntry is
    // what makes the entry stride the pin's rather than a guess.
    state.pinned_lights_uniforms = uniform_buffer(
        16 + upstream::pinned_max_lights * sizeof(upstream::LightEntry));
}

/**
 * Group 0 over one scene block and the frame's shared lights.
 *
 * Three callers want exactly this and differ only in which scene block they
 * read: the frame's own, a geometry task's, and a render task
 * drawing through its own camera. The lights are the scene's in all three.
 */
template <typename Buffer, typename Group>
WGPUBindGroup pinned_frame_group_over(
    DawnState& state,
    Buffer& scene_uniforms,
    Group& group,
    const char* what,
    // A swapchain overlay layer is the one caller whose LIGHTS are not
    // the frame's: it is a second scene with its own light list, and a
    // queue write cannot be re-issued between two passes of one command
    // buffer. Every other caller leaves this null and shares the frame's.
    WGPUBuffer lights_override = nullptr) {
    if (group) return group;
    ensure_pinned_frame_buffers(state);
    if (!scene_uniforms) {
        WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
        descriptor.size = sizeof(upstream::SceneUniforms);
        descriptor.usage =
            WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
        scene_uniforms =
            wgpuDeviceCreateBuffer(state.device, &descriptor);
        if (!scene_uniforms) {
            dawn_error((std::string(what) + " buffer creation failed.")
                           .c_str());
        }
    }
    std::array<WGPUBindGroupEntry, 2> entries{};
    entries[0] = WGPU_BIND_GROUP_ENTRY_INIT;
    entries[0].binding = 0;
    entries[0].buffer = scene_uniforms;
    entries[0].size = sizeof(upstream::SceneUniforms);
    entries[1] = WGPU_BIND_GROUP_ENTRY_INIT;
    entries[1].binding = 1;
    entries[1].buffer =
        lights_override ? lights_override : state.pinned_lights_uniforms;
    entries[1].size =
        16 + upstream::pinned_max_lights * sizeof(upstream::LightEntry);
    WGPUBindGroupDescriptor descriptor = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    descriptor.layout = pinned_frame_layout_for(state);
    descriptor.entryCount = entries.size();
    descriptor.entries = entries.data();
    group = wgpuDeviceCreateBindGroup(state.device, &descriptor);
    if (!group) {
        dawn_error(
            (std::string(what) + " bind group creation failed.").c_str());
    }
    return group;
}

// Group 0, built once from the buffers the frame writer fills.
WGPUBindGroup pinned_frame_group(DawnState& state) {
    return pinned_frame_group_over(
        state,
        state.pinned_scene_uniforms,
        state.pinned_frame_group,
        "pinned frame");
}

/**
 * Group 0 for a render task drawing through its own camera: its own scene
 * block, because a second camera moves the view-projection and the eye
 * position and no other value in it.
 */
WGPUBindGroup task_pinned_frame_group(
    DawnState& state,
    DawnRenderTask& task,
    WGPUBuffer lights = nullptr) {
    return pinned_frame_group_over(
        state,
        task.pinned_scene_uniforms,
        task.pinned_frame_group,
        "render task frame", lights);
}

#if defined(BBLITE_HAS_TAA) && BBLITE_HAS_TAA
void restore_temporal_source_buffer(DawnState& state, FrameTaskRecord& source, DawnRenderTask& gpu) {
    if (!source.scene_uniforms) source.scene_uniforms = upstream::create_persistent_scene_uniforms();
    if (!gpu.pinned_scene_uniforms) {
        const auto& bytes = source.scene_uniforms->drawn;
        gpu.pinned_scene_uniforms = create_buffer(state, WGPUBufferUsage_Uniform,
            bytes.data(), bytes.size() * sizeof(float));
    }
}
#endif

/**
 * Group 0 for one swapchain overlay layer: its own scene block AND its own
 * lights, because a layer is a second scene rather than a second camera on
 * this one.
 */
WGPUBindGroup overlay_frame_group(
    DawnState& state,
    DawnState::OverlayFrame& overlay) {
    if (!overlay.lights_uniforms) {
        WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
        descriptor.size = static_cast<std::uint64_t>(
            16 + upstream::pinned_max_lights *
                     sizeof(upstream::LightEntry));
        descriptor.usage =
            WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
        overlay.lights_uniforms =
            wgpuDeviceCreateBuffer(state.device, &descriptor);
        if (!overlay.lights_uniforms) {
            dawn_error("overlay lights buffer creation failed.");
        }
    }
    return pinned_frame_group_over(
        state,
        overlay.scene_uniforms,
        overlay.frame_group,
        "swapchain overlay frame",
        overlay.lights_uniforms);
}

/** Group 0 for the geometry tasks: their scene block beside the shared
 *  lights buffer, in the same layout as the main frame group. */
WGPUBindGroup pinned_geometry_frame_group(DawnState& state) {
    return pinned_frame_group_over(
        state,
        state.pinned_geometry_scene_uniforms,
        state.pinned_geometry_frame_group,
        "pinned geometry frame");
}

/**
 * A geometry task's frame prologue, run once by whichever family writer
 * owns it (the PBR writer when that family is compiled, the Standard
 * writer otherwise): the task's scene block, its gpUniforms
 * buffer — previous-frame view-projection beside the camera near/far —
 * and the previous view-projection tracking. Both writers used to carry
 * this sequence verbatim.
 */
[[maybe_unused]] void write_pinned_geometry_prologue(
    DawnState& state,
    const Scene& scene,
    const Engine& engine,
    const CameraRecord& camera,
    DawnGeometryTask& geometry,
    const std::array<float, 16>& geometry_matrix) {
    pinned_geometry_frame_group(state);
    const upstream::SceneUniforms scene_block =
        pinned_scene_block(scene, engine, camera, geometry_matrix);
    wgpuQueueWriteBuffer(
        state.queue,
        state.pinned_geometry_scene_uniforms,
        0,
        &scene_block,
        sizeof(scene_block));
    if (!geometry.pinned_geometry_params) {
        WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
        descriptor.size = sizeof(PinnedGeometryParams);
        descriptor.usage =
            WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
        geometry.pinned_geometry_params =
            wgpuDeviceCreateBuffer(state.device, &descriptor);
        if (!geometry.pinned_geometry_params) {
            dawn_error("pinned geometry params buffer creation failed.");
        }
    }
    if (!geometry.has_previous_view_projection) {
        geometry.previous_view_projection = geometry_matrix;
        geometry.has_previous_view_projection = true;
    }
    const PinnedGeometryParams params{
        geometry.previous_view_projection,
        {
            static_cast<float>(camera.near_plane),
            static_cast<float>(camera.far_plane),
            0.0f,
            0.0f,
        },
    };
    wgpuQueueWriteBuffer(
        state.queue,
        geometry.pinned_geometry_params,
        0,
        &params,
        sizeof(params));
    geometry.previous_view_projection = geometry_matrix;
}

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
[[maybe_unused]] PinnedResource state_resource_for(
    const DawnState& state,
    upstream::MaterialTextureSource source) {
    switch (source) {
        case upstream::MaterialTextureSource::environment_cube:
            return PinnedResource{
                state.environment_cube_view,
                state.default_sampler};
        case upstream::MaterialTextureSource::brdf_lut:
            return PinnedResource{state.brdf_view, state.clamp_sampler};
        case upstream::MaterialTextureSource::scene_color:
            return PinnedResource{
                state.transmission_color_view,
                state.transmission_sampler};
        default:
            return {};
    }
}
#endif

#if BBLITE_PBR_VARIANTS > 0
/**
 * Which of our resources the pin's own name for a binding refers to.
 *
 * The names are Babylon's, the slots are the PAL's, and this is where the two
 * meet. A variant that declares a resource this does not know fails by name
 * rather than drawing with whatever sat at that index.
 */
PinnedResource pinned_resource_for(
    DawnState& state,
    const DawnMesh& mesh,
    std::string_view name,
    [[maybe_unused]] const MaterialRecord* material = nullptr) {
    const upstream::MaterialTextureSlot* slot =
        material_slot_for_binding(name);
    if (slot != nullptr) {
#if BBLITE_LOCAL_CUBEMAP
        if (material && material->local_environment) {
            const auto& local = *state.local_cubemaps.at(material->local_environment.get());
            if (slot->source == upstream::MaterialTextureSource::local_probe_cube) return {local.array_view, state.default_sampler};
            if (slot->source == upstream::MaterialTextureSource::environment_cube && local.source->overrides_environment)
                return {local.cube_view, state.default_sampler};
        }
#endif
        if (slot->slot != upstream::material_texture_no_slot) {
            // The material's own textures, in the generated slot order the
            // upload loop fills.
            return PinnedResource{
                mesh.views[slot->slot],
                mesh.samplers[slot->slot]};
        }
        const PinnedResource resource = state_resource_for(state, slot->source);
        if (resource.view != nullptr) return resource;
        switch (slot->source) {
            case upstream::MaterialTextureSource::scene_color:
                // The scene-colour grab the pin refracts through. The
                // persistent bind group needs a complete entry before the
                // grab exists, so the base-colour pair stands in until the
                // group is rebuilt with the real texture -- which is the
                // mesh's, so this one arm cannot move to the scene-owned
                // resolver above.
                return PinnedResource{mesh.views[0], mesh.samplers[0]};
            case upstream::MaterialTextureSource::bone_palette:
                return PinnedResource{mesh.pinned_bone_view, nullptr};
#if BBLITE_VAT
            // The baked palette and its per-instance params: the mesh's
            // own textures, textureLoaded like the live palette, so no
            // sampler on this backend either.
            case upstream::MaterialTextureSource::vat_palette:
                return PinnedResource{mesh.pinned_vat_view, nullptr};
#if BBLITE_VAT_INSTANCES
            case upstream::MaterialTextureSource::vat_instance_params:
                return PinnedResource{
                    mesh.pinned_vat_instance_view,
                    nullptr};
#endif
#endif
#if defined(BBLITE_HAS_CLUSTERED_LIGHTS) && BBLITE_HAS_CLUSTERED_LIGHTS
            // The clustered field's three, from the container the scene
            // holds. Each is `textureLoad`ed, so none carries a sampler at
            // all on this backend.
            case upstream::MaterialTextureSource::clustered_lights:
                return PinnedResource{state.clustered.lights, nullptr};
            case upstream::MaterialTextureSource::clustered_cells:
                return PinnedResource{state.clustered.cells, nullptr};
            case upstream::MaterialTextureSource::clustered_indices:
                return PinnedResource{state.clustered.indices, nullptr};
#endif
            default:
                break;
        }
    }
    dawn_error(
        (std::string("pinned variant declares an unmapped resource '") +
         std::string(name) + "'.")
            .c_str());
    return PinnedResource{};
}

#endif

#if BBLITE_GPU_MORPH_STORAGE
/** Publish the same dirty pose before a visible draw or a same-turn pick. */
void sync_morph_weights(
    DawnState& state, DawnMesh& mesh,
    const ModelGeometry& geometry,
    const MeshRecord& record) {
    if (!mesh.owns_morph_buffers || mesh.morph_weights_version == record.morph_weights_version) return;
    const std::vector<float> weights = morph_weight_values(geometry, record);
    wgpuQueueWriteBuffer(state.queue, mesh.morph_weights, 16,
        weights.data(), weights.size() * sizeof(float));
    mesh.morph_weights_version = record.morph_weights_version;
}
#endif

#if BBLITE_PBR_VARIANTS > 0 || defined(BBLITE_STANDARD_SKELETON)
WGPUTexture create_pinned_float_texture(
    DawnState& state,
    std::uint32_t width,
    std::uint32_t height,
    const char* failure) {
    WGPUTextureDescriptor descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
    descriptor.dimension = WGPUTextureDimension_2D;
    descriptor.size = {width, height, 1};
    descriptor.format = WGPUTextureFormat_RGBA32Float;
    descriptor.usage =
        WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
    descriptor.mipLevelCount = 1;
    descriptor.sampleCount = 1;
    DawnTexture texture{wgpuDeviceCreateTexture(state.device, &descriptor)};
    if (!texture) dawn_error(failure);
    return texture.release();
}

/**
 * The bone palette as the pin's own texture.
 *
 * `skeleton-updater.ts` writes `invMeshWorld * jointWorld * IBM` per bone into
 * an rgba32float row, four texels each. Our MeshRecord::bone_matrices already
 * holds that product -- the mesh world is conjugated into the palette, which is
 * why the transcribed skin path needs no separate world matrix either -- so this
 * uploads it unchanged.
 */
void write_pinned_bone_texture(
    DawnState& state,
    DawnMesh& mesh,
    const MeshRecord& record) {
    sync_pinned_bone_palette(
        mesh,
        record,
        [&](const BonePaletteLayout& palette) {
            if (mesh.pinned_bone_view) {
                wgpuTextureViewRelease(mesh.pinned_bone_view);
            }
            if (mesh.pinned_bone_texture) {
                wgpuTextureRelease(mesh.pinned_bone_texture);
            }
            mesh.pinned_bone_texture = create_pinned_float_texture(
                state,
                palette.width,
                palette.height,
                "pinned bone texture creation failed.");
            mesh.pinned_bone_view =
                create_dawn_texture_view(mesh.pinned_bone_texture, nullptr);
        },
        [&](const float* floats, const BonePaletteLayout& palette) {
            WGPUTexelCopyTextureInfo destination = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
            destination.texture = mesh.pinned_bone_texture;
            WGPUTexelCopyBufferLayout layout = WGPU_TEXEL_COPY_BUFFER_LAYOUT_INIT;
            layout.bytesPerRow = palette.bytes;
            layout.rowsPerImage = palette.height;
            WGPUExtent3D extent{palette.width, palette.height, 1};
            wgpuQueueWriteTexture(
                state.queue, &destination, floats, palette.bytes, &layout, &extent);
        });
}

#endif

#if BBLITE_PBR_VARIANTS > 0
#if BBLITE_VAT
/** One rgba32float upload of `height` rows through the queue. */
void write_pinned_float_texture(
    DawnState& state,
    WGPUTexture texture,
    const float* data,
    const VatTextureLayout& layout) {
    WGPUTexelCopyTextureInfo destination = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
    destination.texture = texture;
    WGPUTexelCopyBufferLayout copy = WGPU_TEXEL_COPY_BUFFER_LAYOUT_INIT;
    copy.bytesPerRow = layout.row_bytes;
    copy.rowsPerImage = layout.height;
    WGPUExtent3D extent{layout.width, layout.height, 1};
    wgpuQueueWriteTexture(
        state.queue,
        &destination,
        data,
        layout.bytes,
        &copy,
        &extent);
}

/**
 * The baked VAT as the pin's own texture, plus the settings block the
 * vertex stage reads its row range and clock from.
 *
 * The texture is `bakeVat`'s output byte for byte -- one live palette row
 * per animation frame -- so this uploads it once and then only follows the
 * settings and per-instance versions the handle's writers bump.
 */
void write_pinned_vat_texture(
    DawnState& state, DawnMesh& mesh, const MeshRecord& record, const Engine& engine) {
    sync_pinned_vat(mesh, record, engine,
        [&](const VatBakeRecord& bake, const VatTextureLayout& layout) {
            if (mesh.pinned_vat_view) wgpuTextureViewRelease(mesh.pinned_vat_view);
            if (mesh.pinned_vat_texture) wgpuTextureRelease(mesh.pinned_vat_texture);
            mesh.pinned_vat_texture = create_pinned_float_texture(state, layout.width, layout.height,
                "pinned VAT texture creation failed.");
            mesh.pinned_vat_view = create_dawn_texture_view(mesh.pinned_vat_texture, nullptr);
            if (!mesh.pinned_vat_view) dawn_error("pinned VAT texture view creation failed.");
            write_pinned_float_texture(state, mesh.pinned_vat_texture, bake.data.data(), layout);
        },
        [&](const VatData& vat) {
            if (!mesh.pinned_vat_settings) {
                WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
                descriptor.size = sizeof(float) * 8;
                descriptor.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
                mesh.pinned_vat_settings = wgpuDeviceCreateBuffer(state.device, &descriptor);
                if (!mesh.pinned_vat_settings) dawn_error("pinned VAT settings buffer creation failed.");
                mesh.pinned_vat_settings_version = 0;
            }
            if (mesh.pinned_vat_settings_version != vat.settings_version) {
                wgpuQueueWriteBuffer(state.queue, mesh.pinned_vat_settings, 0, vat.settings.data(), sizeof(float) * 8);
                mesh.pinned_vat_settings_version = vat.settings_version;
            }
        },
#if BBLITE_VAT_INSTANCES
        [&](const VatData& vat) {
            if (mesh.pinned_vat_instance_view) wgpuTextureViewRelease(mesh.pinned_vat_instance_view);
            if (mesh.pinned_vat_instance_texture) wgpuTextureRelease(mesh.pinned_vat_instance_texture);
            mesh.pinned_vat_instance_texture = create_pinned_float_texture(state, vat.instance_texels, 1u,
                "pinned VAT instance texture creation failed.");
            mesh.pinned_vat_instance_view = create_dawn_texture_view(mesh.pinned_vat_instance_texture, nullptr);
            if (!mesh.pinned_vat_instance_view) dawn_error("pinned VAT instance view creation failed.");
        },
        [&](const VatData& vat, const VatTextureLayout& layout) {
            write_pinned_float_texture(state, mesh.pinned_vat_instance_texture, vat.instance_params.data(), layout);
        }
#else
        [](const VatData&) {}, [](const VatData&, const VatTextureLayout&) {}
#endif
    );
}
#endif

/**
 * The group-1 bind group for one variant of a mesh: the given mesh and
 * material blocks, then exactly the resources that variant declares --
 * shared by the main draw's slot and the geometry tasks' per-variant
 * states, which differ only in where their buffers live.
 */
WGPUBindGroup build_pinned_draw_group(
    DawnState& state,
    DawnMesh& mesh,
    std::size_t variant,
    WGPUBuffer mesh_uniforms,
    WGPUBuffer material_uniforms,
    WGPUBuffer geometry_params,
    // The material this group is built for, whose ESM caster view names the
    // generator its `shadowParams` block belongs to.
    [[maybe_unused]] const MaterialRecord* material = nullptr) {
#if BBLITE_LOCAL_CUBEMAP
    const auto* local_cubemap = ensure_local_cubemap(state, material);
#endif
    const upstream::PbrVariantEntry& entry = upstream::pbr_variants[variant];
    std::vector<WGPUBindGroupEntry> entries;
    entries.reserve(2 + entry.binding_count);
    WGPUBindGroupEntry mesh_entry = WGPU_BIND_GROUP_ENTRY_INIT;
    mesh_entry.binding = 0;
    mesh_entry.buffer = mesh_uniforms;
    mesh_entry.size = sizeof(upstream::MeshUniforms);
    entries.push_back(mesh_entry);
    WGPUBindGroupEntry material_entry = WGPU_BIND_GROUP_ENTRY_INIT;
    material_entry.binding = 1;
    material_entry.buffer = material_uniforms;
    material_entry.size = entry.material_ubo_bytes;
    entries.push_back(material_entry);
    for (std::size_t index = 0; index < entry.binding_count; ++index) {
        const upstream::PinnedVariantBinding& binding =
            upstream::pbr_variant_bindings[entry.first_binding + index];
        WGPUBindGroupEntry group_entry = WGPU_BIND_GROUP_ENTRY_INIT;
        group_entry.binding = binding.binding;
#if BBLITE_LOCAL_CUBEMAP
        if (local_cubemap && (binding.name == "localProbeData" || binding.name == "localProbeGrid")) {
            const bool uniform = binding.name == "localProbeData";
            group_entry.buffer = uniform ? local_cubemap->uniform : local_cubemap->grid;
            group_entry.size = (uniform ? local_cubemap->source->uniform_data.size() : local_cubemap->source->grid_data.size()) * sizeof(std::uint32_t);
            entries.push_back(group_entry);
            continue;
        }
#endif
        if (binding.kind == upstream::PinnedBindingKind::uniformBuffer) {
#if BBLITE_SHADOWS_ESM
            // The ESM caster's own block, from the generator its view was
            // built for -- the Standard family's arm, for the family that
            // shares the view's factory.
            if (binding.name == "shadowParams") {
                group_entry.buffer =
                    esm_caster_params_buffer(state, material);
                if (!group_entry.buffer) {
                    dawn_error(
                        "an ESM caster draw reached the encode before its "
                        "generator's shadow params.");
                }
                group_entry.size = upstream::shadow_params_block_bytes;
                entries.push_back(group_entry);
                continue;
            }
#endif
#if defined(BBLITE_HAS_CLUSTERED_LIGHTS) && BBLITE_HAS_CLUSTERED_LIGHTS
            // The clustered field's params block, from the container the
            // scene holds rather than from this material.
            if (binding.name == "clusteredLightParams") {
                group_entry.buffer = state.clustered.params;
                if (!group_entry.buffer) {
                    dawn_error(
                        "a clustered draw reached the encode before its "
                        "container's params buffer.");
                }
                group_entry.size = sizeof(std::uint32_t) * 8;
                entries.push_back(group_entry);
                continue;
            }
#endif
#if BBLITE_VAT
            // The pin's 32-byte VAT settings: params then clock, written
            // on the mesh's own buffer by play/update.
            if (binding.name == "vat") {
                group_entry.buffer = mesh.pinned_vat_settings;
                if (!group_entry.buffer) {
                    dawn_error(
                        "a baked draw reached the encode before its VAT "
                        "settings block.");
                }
                group_entry.size = sizeof(float) * 8;
                entries.push_back(group_entry);
                continue;
            }
#endif
            // The geometry arms' gpUniforms, per task.
            if (binding.name != "gp" || !geometry_params) {
                dawn_error(
                    ("pinned variant declares an unmapped uniform "
                     "block '" + std::string(binding.name) + "'.")
                        .c_str());
            }
            group_entry.buffer = geometry_params;
            group_entry.size = sizeof(PinnedGeometryParams);
            entries.push_back(group_entry);
            continue;
        }
        if (binding.kind == upstream::PinnedBindingKind::storageBuffer) {
            // The morph arms' storage, by the pin's own names. These are the
            // same buffers the transcribed stage read: the upload loop
            // maintains the deltas and the {count, vertexCount}-headed
            // weights in the pin's own layout.
#if BBLITE_GPU_MORPH_STORAGE
            if (binding.name == "morphDeltas") {
                group_entry.buffer = mesh.morph_deltas;
            } else if (binding.name == "morph") {
                group_entry.buffer = mesh.morph_weights;
            }
#endif
            if (!group_entry.buffer) {
                dawn_error(
                    ("pinned variant declares an unmapped storage buffer '" +
                     std::string(binding.name) + "'.")
                        .c_str());
            }
            group_entry.size = WGPU_WHOLE_SIZE;
            entries.push_back(group_entry);
            continue;
        }
        const PinnedResource resource =
            pinned_resource_for(state, mesh, binding.name, material);
        if (binding.kind == upstream::PinnedBindingKind::sampler) {
            group_entry.sampler = resource.sampler;
        } else {
            group_entry.textureView = resource.view;
        }
        entries.push_back(group_entry);
    }
    WGPUBindGroupDescriptor descriptor = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    descriptor.layout = pinned_draw_layout_for(state, variant);
    descriptor.entryCount = entries.size();
    descriptor.entries = entries.data();
    DawnBindGroup group{wgpuDeviceCreateBindGroup(state.device, &descriptor)};
    if (!group) {
        dawn_error("pinned variant draw bind group creation failed.");
    }
    return group.release();
}

/** The per-draw buffers and group-1 bind group for one material's variant. */
DawnDrawState& ensure_pinned_draw_bindings(
    DawnState& state,
    DawnMesh& mesh,
    std::uint32_t material,
    std::size_t variant,
    const MaterialRecord* record) {
    DawnDrawState& draw_state = mesh.pinned_states.try_emplace(material, state).first->second;
    if (draw_state.group && draw_state.group_key == variant) {
        return draw_state;
    }
    if (draw_state.group) wgpuBindGroupRelease(draw_state.group);
    draw_state.group = nullptr;
    const upstream::PbrVariantEntry& entry = upstream::pbr_variants[variant];
    const auto uniform_buffer = [&](std::size_t size) {
        WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
        descriptor.size = static_cast<std::uint64_t>(size);
        descriptor.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
        DawnBuffer buffer{wgpuDeviceCreateBuffer(state.device, &descriptor)};
        if (!buffer) dawn_error("pinned draw buffer creation failed.");
        return buffer.release();
    };
    if (!draw_state.mesh_uniforms) {
        draw_state.mesh_uniforms =
            uniform_buffer(sizeof(upstream::MeshUniforms));
    }
    // Sized by the variant, so a swap to one with more fields reallocates.
    if (WGPUBuffer old = std::exchange(
            draw_state.material_uniforms, uniform_buffer(entry.material_ubo_bytes))) {
        wgpuBufferRelease(old);
    }
    draw_state.group = build_pinned_draw_group(
        state,
        mesh,
        variant,
        draw_state.mesh_uniforms,
        draw_state.material_uniforms,
        nullptr,
        record);
    draw_state.group_key = variant;
    return draw_state;
}

/**
 * The per-draw buffers and group-1 bind group for one geometry-output MRT
 * variant of a mesh, keyed by variant beside `pinned_states`: the
 * encoder references the main group and every geometry group of a mesh in
 * the same frame, so none can replace another.
 */
DawnDrawState& ensure_pinned_geometry_bindings(
    DawnState& state,
    DawnMesh& mesh,
    std::size_t variant,
    WGPUBuffer geometry_params) {
    auto existing = mesh.pinned_geometry_states.find(variant);
    if (existing != mesh.pinned_geometry_states.end()) {
        return existing->second;
    }
    DawnDrawState draw_state{state};
    const upstream::PbrVariantEntry& entry = upstream::pbr_variants[variant];
    const auto uniform_buffer = [&](std::size_t size) {
        WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
        descriptor.size = static_cast<std::uint64_t>(size);
        descriptor.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
        DawnBuffer buffer{wgpuDeviceCreateBuffer(state.device, &descriptor)};
        if (!buffer) dawn_error("pinned geometry buffer creation failed.");
        return buffer.release();
    };
    draw_state.mesh_uniforms =
        uniform_buffer(sizeof(upstream::MeshUniforms));
    draw_state.material_uniforms =
        uniform_buffer(entry.material_ubo_bytes);
    draw_state.group = build_pinned_draw_group(
        state,
        mesh,
        variant,
        draw_state.mesh_uniforms,
        draw_state.material_uniforms,
        geometry_params);
    return mesh.pinned_geometry_states
        .emplace(variant, std::move(draw_state))
        .first->second;
}

/**
 * The pin's two per-draw blocks for one resolved variant — the mesh block
 * (draw world + light selection) and the variant's own material UBO —
 * written to the caller's buffers. Shared by the main pass and the
 * geometry task. Variant and mesh state determine the world conventions.
 */
void write_pinned_draw_blocks(
    DawnState& state,
    const Scene& scene,
    const Engine& engine,
    const upstream::RenderDrawCommand& draw,
    std::size_t variant,
    const PinnedDrawConventions& conventions,
    WGPUBuffer mesh_uniforms,
    WGPUBuffer material_uniforms) {
    const MeshRecord& record = handle_at(engine.meshes, draw.item.mesh);
    const upstream::PbrVariantEntry& entry =
        upstream::pbr_variants[variant];
    const upstream::MeshUniforms mesh_block =
        pinned_draw_mesh_block(scene, engine, draw, variant, conventions);
    wgpuQueueWriteBuffer(
        state.queue,
        mesh_uniforms,
        0,
        &mesh_block,
        sizeof(mesh_block));
    std::vector<std::uint8_t> material_block(
        entry.material_ubo_bytes,
        0);
    upstream::write_pbr_variant_material(
        variant,
        handle_at(engine.materials, draw.item.material),
        material_block.data(),
        entry.material_ubo_bytes,
        // The refraction thickness scale the pin's fragment reads off its
        // mesh world, whose scale this backend bakes into vertices.
        record.baked_world_scale);
    wgpuQueueWriteBuffer(
        state.queue,
        material_uniforms,
        0,
        material_block.data(),
        entry.material_ubo_bytes);
}

/**
 * Writes one geometry task's pinned blocks for the frame.
 *
 * The shared geometry scene block carries the task's view-projection; the
 * task's gpUniforms holds last frame's matrix (seeded with the current one)
 * and the camera's near/far; and every PBR draw's mesh and material blocks
 * are written against the MRT variant the selector table keys on this task.
 */
void write_pinned_geometry_task(
    DawnState& state,
    const Scene& scene,
    const Engine& engine,
    const FrameTaskRecord& task,
    DawnGeometryTask& geometry,
    const upstream::RenderDrawLists& draw_lists) {
    for (const auto* list : {&draw_lists.opaque, &draw_lists.transparent}) {
        for (const upstream::RenderDrawCommand& draw : list->commands) {
            if (
                draw.item.material_kind !=
                upstream::RenderMaterialKind::pbr) {
                continue;
            }
            if (draw.item_index >= state.meshes.size()) continue;
            pal::PinnedVariantKey geometry_key;
            const std::size_t variant = pinned_variant_for_draw(
                scene,
                engine,
                draw,
                static_cast<std::size_t>(task.geometry.shader_index),
                &geometry_key);
            if (variant == npos) {
                dawn_error(
                    ("PBR draw for mesh " +
                     std::to_string(draw.item.mesh.value) +
                     ", material " +
                     std::to_string(draw.item.material.value) +
                     " resolves no pinned variant in a geometry task: " +
                     pal::pinned_variant_request(
                         geometry_key,
                         static_cast<std::size_t>(
                             task.geometry.shader_index)))
                        .c_str());
            }
            DawnMesh& mesh = state.meshes[draw.item_index];
            DawnDrawState& draw_state =
                ensure_pinned_geometry_bindings(
                    state,
                    mesh,
                    variant,
                    geometry.pinned_geometry_params);
            write_pinned_draw_blocks(
                state,
                scene,
                engine,
                draw,
                variant,
                pinned_draw_conventions(variant, handle_at(engine.meshes, draw.item.mesh)),
                draw_state.mesh_uniforms,
                draw_state.material_uniforms);
        }
    }
}

#endif

// Fill and upload the pin's per-pass blocks.
//
// Every value is placed by generated code: `write_<kind>_light` is each light's
// own `_writeLightUbo`, and the scene block's members are the ones the pin's
// declaration names. Only the plumbing is here.
// Upload the pin's per-pass blocks. Both are built by the shared builders, so
// this backend decides only where they land.
void write_pinned_frame_blocks(
    DawnState& state,
    const Scene& scene,
    const Engine& engine,
    const CameraRecord& camera,
    const std::array<float, 16>& view_projection) {
    ensure_pinned_frame_buffers(state);
    const upstream::SceneUniforms scene_block =
        pinned_scene_block(scene, engine, camera, view_projection);
    wgpuQueueWriteBuffer(
        state.queue,
        state.pinned_scene_uniforms,
        0,
        &scene_block,
        sizeof(scene_block));
    const std::vector<std::uint8_t> lights =
        pinned_lights_block(scene, engine);
    wgpuQueueWriteBuffer(
        state.queue,
        state.pinned_lights_uniforms,
        0,
        lights.data(),
        lights.size());
}

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

/** Which matrix buffer a family's draw reads its pool from. */
enum class InstanceMatrixSource { standard, pinned };

/**
 * The streams one draw of `record` reads, from the buffers `mesh` holds.
 *
 * The two composed families differ only in that source — the PBR one is
 * paired with the pinned vertex convention — so the pool tests and both
 * `#if`s live here rather than at each of the three encode sites, the way
 * `frame_floating_origin_offset` already keeps its own. A build with no
 * instancing compiled in has no such buffers on `DawnMesh` at all, which is
 * why the whole body sits inside the guard rather than the tests alone.
 */
[[maybe_unused]] InstanceStreams instance_streams_for(
    [[maybe_unused]] const MeshRecord& record,
    [[maybe_unused]] const DawnMesh& mesh,
    [[maybe_unused]] InstanceMatrixSource source) {
#if BBLITE_GPU_INSTANCING
    // The pinned source lives on `DawnMesh` only where the PBR family is
    // composed at all, so the selector resolves under that guard too.
    WGPUBuffer matrices = mesh.instances;
#if BBLITE_PBR_VARIANTS > 0
    if (source == InstanceMatrixSource::pinned) {
        matrices = mesh.pinned_instances;
    }
#endif
    if (!pinned_record_instanced(record) || !matrices) {
        return InstanceStreams{};
    }
    InstanceStreams streams{matrices, nullptr, mesh.instance_count};
#if BBLITE_GPU_INSTANCE_COLORS
    // The colour lane rides the pool: the composed variant declares it only
    // for a record whose pool carries colours, so the same record test
    // answers the key and the binding.
    if (pinned_record_instance_colored(record)) {
        streams.colors = mesh.instance_colors;
    }
#endif
    return streams;
#else
    return InstanceStreams{};
#endif
}

/**
 * One composed-variant draw, encoded the same way at all four sites (PBR
 * and Standard, main pass and geometry task): bind the pipeline unless
 * already bound, the frame group at 0 and the draw group at 1, the
 * vertex stream (plus whichever thin-instance streams the pool carries),
 * then the indexed draw. Which pipeline, groups, buffers and counts go in
 * stays with each site; WebGPU forces the write/encode split, but the
 * duplication between the four encode arms did not.
 */
void encode_variant_draw(
    WGPURenderPassEncoder pass,
    WGPURenderPipeline pipeline,
    WGPURenderPipeline& bound_pipeline,
    WGPUBindGroup frame_group,
    WGPUBindGroup draw_group,
    WGPUBuffer vertex_buffer,
    InstanceStreams instances,
    WGPUBuffer index_buffer,
    std::uint32_t index_count,
    // Group 2, bound only by a draw whose composed fragment declares it:
    // the pin binds it under exactly the same test (`receiveShadows &&
    // shadowBindGroup`).
    WGPUBindGroup shadow_group = nullptr) {
    if (pipeline != bound_pipeline) {
        wgpuRenderPassEncoderSetPipeline(pass, pipeline);
        bound_pipeline = pipeline;
    }
    wgpuRenderPassEncoderSetBindGroup(pass, 0, frame_group, 0, nullptr);
    wgpuRenderPassEncoderSetBindGroup(pass, 1, draw_group, 0, nullptr);
    if (shadow_group) {
        wgpuRenderPassEncoderSetBindGroup(
            pass,
            2,
            shadow_group,
            0,
            nullptr);
    }
    wgpuRenderPassEncoderSetVertexBuffer(
        pass,
        vertex_stream_slot(VertexInputStream::vertex),
        vertex_buffer,
        0,
        WGPU_WHOLE_SIZE);
    if (instances.matrices) {
        wgpuRenderPassEncoderSetVertexBuffer(
            pass,
            vertex_stream_slot(VertexInputStream::instance_matrix),
            instances.matrices,
            0,
            WGPU_WHOLE_SIZE);
    }
    if (instances.colors) {
        wgpuRenderPassEncoderSetVertexBuffer(
            pass,
            vertex_stream_slot(VertexInputStream::instance_color),
            instances.colors,
            0,
            WGPU_WHOLE_SIZE);
    }
    wgpuRenderPassEncoderSetIndexBuffer(
        pass,
        index_buffer,
        WGPUIndexFormat_Uint32,
        0,
        WGPU_WHOLE_SIZE);
    count_gpu_draw(wgpuRenderPassEncoderDrawIndexed,
        pass,
        index_count,
        instances.count,
        0,
        0,
        0);
}
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
std::pair<WGPUTexture, WGPUTextureView> dawn_render_target_texture(
    DawnState& state,
    const Engine& engine,
    RenderTargetHandle target_handle) {
    if (target_handle.value >= state.render_targets.size()) {
        dawn_error("Frame graph render target handle is invalid.");
    }
    const RenderTargetRecord& record =
        handle_at(engine.render_targets, target_handle);
    DawnRenderTarget& target = handle_at(state.render_targets, target_handle);
    if (pal::render_target_samples_depth(record)) {
        if (record.has_depth && target.depth_copy) {
            return {target.depth_copy, target.depth_copy_view};
        }
        pal::fail_render_target_has_no_texture();
    }
    return {target.sampled_color, target.sampled_color_view};
}

// The receiver's shared machinery: the samplers, the map view, and the two
// builders that read a composed group-2 row span. Both material families wrap
// one pinned shadow core, so their rows are one shape and this is one
// implementation; each family adds only its own cache vectors beside it.
#if BBLITE_SHADOW_RECEIVERS
/** The two samplers a receiver row may name, built once. */
void ensure_shadow_samplers(DawnState& state) {
    if (!state.shadow_comparison_sampler) {
        WGPUSamplerDescriptor descriptor = WGPU_SAMPLER_DESCRIPTOR_INIT;
        // The pinned PCF generator's own sampler: a comparison sampler under
        // `less`, with linear filtering so the hardware averages the four
        // comparisons each of the nine taps takes.
        descriptor.compare = WGPUCompareFunction_Less;
        descriptor.magFilter = WGPUFilterMode_Linear;
        descriptor.minFilter = WGPUFilterMode_Linear;
        state.shadow_comparison_sampler =
            wgpuDeviceCreateSampler(state.device, &descriptor);
        if (!state.shadow_comparison_sampler) {
            dawn_error("shadow comparison sampler creation failed.");
        }
    }
    if (!state.shadow_filtering_sampler) {
        // The pinned ESM generator reads its blurred map through
        // `getBilinearSampler`. Its two filters are what the factory asked
        // its device for; everything else it left at WebGPU's defaults,
        // which are Dawn's defaults too.
        WGPUSamplerDescriptor descriptor = WGPU_SAMPLER_DESCRIPTOR_INIT;
#if BBLITE_SHADOWS_ESM
        const auto& blur_sampler =
            upstream::esm_shadow_resources[0].blur_sampler;
        descriptor.magFilter =
            blur_sampler.magnify == upstream::EsmFilter::linear
                ? WGPUFilterMode_Linear
                : WGPUFilterMode_Nearest;
        descriptor.minFilter =
            blur_sampler.minify == upstream::EsmFilter::linear
                ? WGPUFilterMode_Linear
                : WGPUFilterMode_Nearest;
#endif
        state.shadow_filtering_sampler =
            wgpuDeviceCreateSampler(state.device, &descriptor);
        if (!state.shadow_filtering_sampler) {
            dawn_error("shadow filtering sampler creation failed.");
        }
    }
}

#if BBLITE_SHADOWS_ESM
WGPUTextureFormat esm_texture_format(upstream::EsmTextureFormat format) {
    return format == upstream::EsmTextureFormat::depth32_float
        ? WGPUTextureFormat_Depth32Float
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
DawnState::EsmBlur& ensure_esm_blur(
    DawnState& state,
    WGPUTextureView source,
    std::uint32_t esm_index) {
    if (state.esm_blurs.size() <= esm_index) {
        state.esm_blurs.resize(esm_index + 1);
    }
    DawnState::EsmBlur& blur = state.esm_blurs[esm_index];
    if (blur.pipeline) return blur;
    const upstream::EsmShadowResources& resources =
        upstream::esm_shadow_resources[esm_index];
    const upstream::EsmTextureDescriptor& half = resources.textures[2];
    const auto create_half = [&](WGPUTexture& texture, WGPUTextureView& view) {
        texture = create_frame_texture(
            state,
            esm_texture_format(half.format),
            1,
            half.width,
            half.height,
            WGPUTextureUsage_RenderAttachment |
                WGPUTextureUsage_TextureBinding);
        view = create_dawn_texture_view(texture, nullptr);
    };
    create_half(blur.blur_h, blur.blur_h_view);
    create_half(blur.blur_v, blur.blur_v_view);

    const std::string stem = "shadow-blur-" + std::to_string(esm_index);
    DawnShaderModule vertex_module{load_wgsl_module(state, stem + ".vert")};
    DawnShaderModule fragment_module{load_wgsl_module(state, stem + ".frag")};
    WGPUColorTargetState target = WGPU_COLOR_TARGET_STATE_INIT;
    // The one target `blurPipeline` declares, as the factory declared it.
    target.format = esm_texture_format(resources.blur_target_format);
    target.writeMask = WGPUColorWriteMask_All;
    WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
    fragment.module = fragment_module;
    fragment.entryPoint = {"main", WGPU_STRLEN};
    fragment.targetCount = 1;
    fragment.targets = &target;
    WGPURenderPipelineDescriptor descriptor =
        WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    // No explicit layout: the composed WGSL already declares the group, and
    // taking the pipeline's own is what every other pass here does.
    descriptor.vertex.module = vertex_module;
    descriptor.vertex.entryPoint = {"main", WGPU_STRLEN};
    descriptor.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    descriptor.primitive.cullMode = WGPUCullMode_None;
    descriptor.fragment = &fragment;
    blur.pipeline = wgpuDeviceCreateRenderPipeline(state.device, &descriptor);
    if (!blur.pipeline) dawn_error("ESM blur pipeline creation failed.");
    blur.layout = wgpuRenderPipelineGetBindGroupLayout(blur.pipeline, 0);
    vertex_module.reset();
    fragment_module.reset();

    ensure_shadow_samplers(state);
    const auto bind = [&](
                          WGPUBuffer& uniforms,
                          WGPUBindGroup& group,
                          const std::array<float, 4>& direction,
                          WGPUTextureView read) {
        uniforms = create_buffer(
            state,
            WGPUBufferUsage_Uniform,
            direction.data(),
            direction.size() * sizeof(float));
        std::array<WGPUBindGroupEntry, 3> group_entries{};
        for (WGPUBindGroupEntry& entry : group_entries) {
            entry = WGPU_BIND_GROUP_ENTRY_INIT;
        }
        group_entries[0].binding = 0;
        group_entries[0].buffer = uniforms;
        group_entries[0].size = direction.size() * sizeof(float);
        group_entries[1].binding = 1;
        group_entries[1].textureView = read;
        group_entries[2].binding = 2;
        group_entries[2].sampler = state.shadow_filtering_sampler;
        WGPUBindGroupDescriptor group_descriptor =
            WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        group_descriptor.layout = blur.layout;
        group_descriptor.entryCount = group_entries.size();
        group_descriptor.entries = group_entries.data();
        group = wgpuDeviceCreateBindGroup(state.device, &group_descriptor);
    };
    bind(
        blur.horizontal_uniforms,
        blur.horizontal,
        resources.blur_directions[0],
        source);
    bind(
        blur.vertical_uniforms,
        blur.vertical,
        resources.blur_directions[1],
        blur.blur_h_view);
    return blur;
}

/** The pin's two blur passes, run straight after the caster pass. */
void run_esm_blur(
    DawnState& state,
    WGPUCommandEncoder encoder,
    WGPUTextureView source,
    std::uint32_t esm_index) {
    const DawnState::EsmBlur& blur = ensure_esm_blur(state, source, esm_index);
    const auto pass = [&](WGPUTextureView view, WGPUBindGroup group) {
        WGPURenderPassColorAttachment attachment =
            WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
        attachment.view = view;
        attachment.loadOp = WGPULoadOp_Clear;
        attachment.storeOp = WGPUStoreOp_Store;
        attachment.clearValue = {0.0, 0.0, 0.0, 0.0};
        WGPURenderPassDescriptor descriptor = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
        descriptor.colorAttachmentCount = 1;
        descriptor.colorAttachments = &attachment;
        DawnRenderPass render{wgpuCommandEncoderBeginRenderPass(encoder, &descriptor)};
        wgpuRenderPassEncoderSetPipeline(render, blur.pipeline);
        wgpuRenderPassEncoderSetBindGroup(render, 0, group, 0, nullptr);
        count_gpu_draw(wgpuRenderPassEncoderDraw, render, 3, 1, 0, 0);
        wgpuRenderPassEncoderEnd(render);
        render.reset();
    };
    pass(blur.blur_h_view, blur.horizontal);
    pass(blur.blur_v_view, blur.vertical);
}
#endif

/** The view a generator's map is sampled through. */
WGPUTextureView shadow_map_view(
    DawnState& state,
    const Engine& engine,
    ShadowGeneratorHandle handle) {
    const ShadowGeneratorRecord& generator =
        handle_at(engine.shadow_generators, handle);
    if (generator.map_target.value >= state.render_targets.size()) {
        dawn_error("a shadow generator has no rendered map.");
    }
    const DawnRenderTarget& map =
        handle_at(state.render_targets, generator.map_target);
#if BBLITE_SHADOWS_ESM
    // The ESM receiver samples `sg._depthTexture`, which the pinned factory
    // set to the SECOND blur half -- not the depth buffer the caster pass
    // wrote.
    if (generator.filter == ShadowFilter::esm_directional) {
        const DawnState::EsmBlur& blur = ensure_esm_blur(
            state,
            map.sampled_color_view,
            generator.esm_index);
        return blur.blur_v_view;
    }
#endif
    return map.depth_sampled_view;
}

/**
 * The generators in `scene.lights` order, as a list a row's own light index
 * can be looked up in.
 *
 * That walk IS the ordinal every shadow row names, and it is the shared one:
 * the refresh that rebuilds these generators' matrices visits them in the
 * same order, and a second spelling could disagree.
 */
std::vector<ShadowGeneratorHandle> shadow_generators_in_light_order(
    const Scene& scene,
    const Engine& engine) {
    // One entry per scene light, so a row's light slot indexes it directly.
    // A light with no generator keeps the default invalid handle, which is
    // what the caller's bounds test reads.
    std::vector<ShadowGeneratorHandle> generators(scene.lights.size());
    pal::for_each_shadow_generator(
        scene,
        engine,
        [&](ShadowGeneratorHandle handle, LightHandle, std::size_t slot) {
            generators[slot] = handle;
        });
    return generators;
}

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
WGPUBindGroupLayoutEntry shadow_layout_entry(
    const upstream::PinnedShadowBinding& row) {
    WGPUBindGroupLayoutEntry entry = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
    entry.binding = row.binding;
    entry.visibility = 0;
    if (row.vertex) entry.visibility |= WGPUShaderStage_Vertex;
    if (row.fragment) entry.visibility |= WGPUShaderStage_Fragment;
    switch (row.kind) {
        case upstream::PinnedBindingKind::textureDepth2d:
            entry.texture.sampleType = WGPUTextureSampleType_Depth;
            entry.texture.viewDimension = WGPUTextureViewDimension_2D;
            break;
        case upstream::PinnedBindingKind::textureDepth2dArray:
            // `bglEntry` maps a `_textureType` containing "array" onto
            // `viewDimension: "2d-array"`; the sample type is still depth.
            entry.texture.sampleType = WGPUTextureSampleType_Depth;
            entry.texture.viewDimension =
                WGPUTextureViewDimension_2DArray;
            break;
        case upstream::PinnedBindingKind::texture2d:
            entry.texture.sampleType = WGPUTextureSampleType_Float;
            entry.texture.viewDimension = WGPUTextureViewDimension_2D;
            break;
        case upstream::PinnedBindingKind::samplerComparison:
            entry.sampler.type = WGPUSamplerBindingType_Comparison;
            break;
        case upstream::PinnedBindingKind::sampler:
            entry.sampler.type = WGPUSamplerBindingType_Filtering;
            break;
        case upstream::PinnedBindingKind::uniformBuffer:
            entry.buffer.type = WGPUBufferBindingType_Uniform;
            break;
        default:
            dawn_error(
                ("a composed shadow binding '" + std::string(row.name) +
                 "' has a kind no receiver can bind.")
                    .c_str());
    }
    return entry;
}

/** The resource one receiver row wants, from its role and its light. */
WGPUBindGroupEntry shadow_group_entry(
    DawnState& state,
    const Engine& engine,
    std::span<const ShadowGeneratorHandle> generators,
    const upstream::PinnedShadowBinding& row) {
    if (
        row.light >= generators.size() ||
        generators[row.light].value >= engine.shadow_generators.size()) {
        dawn_error(
            ("a composed shadow binding names light " +
             std::to_string(row.light) +
             ", which carries no generator.")
                .c_str());
    }
    const ShadowGeneratorHandle handle = generators[row.light];
    WGPUBindGroupEntry entry = WGPU_BIND_GROUP_ENTRY_INIT;
    entry.binding = row.binding;
    switch (row.role) {
        case upstream::PinnedShadowRole::map:
            entry.textureView = shadow_map_view(state, engine, handle);
            break;
        case upstream::PinnedShadowRole::map_sampler:
            // Which sampler is the ROW's to say: a PCF map is compared,
            // an ESM one is filtered.
            entry.sampler = row.kind ==
                    upstream::PinnedBindingKind::samplerComparison
                ? state.shadow_comparison_sampler
                : state.shadow_filtering_sampler;
            break;
        case upstream::PinnedShadowRole::info:
            // How many bytes is the GENERATOR's answer: a single-map
            // receiver binds 96 and a cascaded one 320. The refresh already
            // holds the block this buffer was created from, so its size is
            // read there rather than mirrored into a second vector.
            entry.buffer = handle_at(state.shadow_uniforms, handle);
            entry.size = handle_at(state.shadow_refresh.blocks, handle).size;
            break;
    }
    return entry;
}

// From here to the end of this block: the two COMPOSED-VARIANT families'
// own group 2. A node receiver has none -- its rows continue the graph's
// own group 1 -- so a node-only scene compiles the two builders above and
// none of this.
#if BBLITE_STANDARD_SHADOWS || BBLITE_PBR_SHADOWS
/**
 * Group 2 for a shadow-receiving Standard draw, from the composed rows.
 *
 * `createShadowFragment` numbers three bindings per shadow-casting light and
 * picks each one's TYPE from that light's own filter, so a scene mixing an
 * ESM directional with a PCF spot declares a float texture and a plain
 * sampler beside a depth texture and a comparison one -- in one group. The
 * generated `standard_shadow_bindings` rows are the reflection of that text,
 * exactly as group 1's are, so neither the shape nor the stage visibility is
 * decided here.
 */
WGPUBindGroupLayout shadow_layout_for(
    DawnState& state,
    std::span<const upstream::PinnedShadowBinding> rows,
    // The cache slot, so both material families share one builder: the rows
    // are the shadow family's whichever wrapper composed them.
    WGPUBindGroupLayout& slot) {
    if (slot) return slot;
    std::vector<WGPUBindGroupLayoutEntry> entries;
    entries.reserve(rows.size());
    for (const upstream::PinnedShadowBinding& row : rows) {
        entries.push_back(shadow_layout_entry(row));
    }
    WGPUBindGroupLayoutDescriptor descriptor =
        WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
    descriptor.entryCount = entries.size();
    descriptor.entries = entries.data();
    slot = wgpuDeviceCreateBindGroupLayout(state.device, &descriptor);
    if (!slot) {
        dawn_error("shadow receiver bind group layout creation failed.");
    }
    return slot;
}

/**
 * Group 2 itself, one per receiving variant and shared by every mesh drawn
 * through it -- which is the cache `rebuildSingle` keys by the layout for the
 * same reason. Each row names its role and its light, so the resource it
 * wants is a lookup rather than a name parse.
 */
WGPUBindGroup shadow_group_for(
    DawnState& state,
    const Scene& scene,
    const Engine& engine,
    std::span<const upstream::PinnedShadowBinding> rows,
    WGPUBindGroupLayout& layout_slot,
    WGPUBindGroup& slot) {
    if (slot) return slot;
    ensure_shadow_samplers(state);
    const std::vector<ShadowGeneratorHandle> generators =
        shadow_generators_in_light_order(scene, engine);
    std::vector<WGPUBindGroupEntry> entries;
    entries.reserve(rows.size());
    for (const upstream::PinnedShadowBinding& row : rows) {
        entries.push_back(
            shadow_group_entry(state, engine, generators, row));
    }
    WGPUBindGroupDescriptor descriptor = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    descriptor.layout = shadow_layout_for(state, rows, layout_slot);
    descriptor.entryCount = entries.size();
    descriptor.entries = entries.data();
    slot = wgpuDeviceCreateBindGroup(state.device, &descriptor);
    if (!slot) {
        dawn_error("shadow receiver bind group creation failed.");
    }
    return slot;
}
#endif

#endif

#if BBLITE_STANDARD_SHADOWS

WGPUBindGroupLayout standard_shadow_layout_for(
    DawnState& state,
    std::size_t variant) {
    return shadow_layout_for(
        state,
        pal::standard_shadow_rows(variant),
        shadow_cache_slot(
            state.shadow_layouts,
            upstream::standard_variants.size(),
            variant));
}

WGPUBindGroup standard_shadow_group_for(
    DawnState& state,
    const Scene& scene,
    const Engine& engine,
    std::size_t variant) {
    return shadow_group_for(
        state,
        scene,
        engine,
        pal::standard_shadow_rows(variant),
        shadow_cache_slot(
            state.shadow_layouts,
            upstream::standard_variants.size(),
            variant),
        shadow_cache_slot(
            state.shadow_groups,
            upstream::standard_variants.size(),
            variant));
}
#endif

#if BBLITE_PBR_SHADOWS
WGPUBindGroupLayout pbr_shadow_layout_for(
    DawnState& state,
    std::size_t variant) {
    return shadow_layout_for(
        state,
        pal::pbr_shadow_rows(variant),
        shadow_cache_slot(
            state.pbr_shadow_layouts,
            upstream::pbr_variants.size(),
            variant));
}

WGPUBindGroup pbr_shadow_group_for(
    DawnState& state,
    const Scene& scene,
    const Engine& engine,
    std::size_t variant) {
    return shadow_group_for(
        state,
        scene,
        engine,
        pal::pbr_shadow_rows(variant),
        shadow_cache_slot(
            state.pbr_shadow_layouts,
            upstream::pbr_variants.size(),
            variant),
        shadow_cache_slot(
            state.pbr_shadow_groups,
            upstream::pbr_variants.size(),
            variant));
}
#else
[[maybe_unused]] inline WGPUBindGroupLayout pbr_shadow_layout_for(
    DawnState&,
    std::size_t) {
    return nullptr;
}
[[maybe_unused]] inline WGPUBindGroup pbr_shadow_group_for(
    DawnState&,
    const Scene&,
    const Engine&,
    std::size_t) {
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
void write_shadow_generators(
    DawnState& state,
    const Scene& scene,
    Engine& engine) {
    if (engine.shadow_generators.empty()) return;
    if (state.shadow_uniforms.size() < engine.shadow_generators.size()) {
        state.shadow_uniforms.resize(
            engine.shadow_generators.size(),
            nullptr);
#if BBLITE_SHADOWS_ESM
        state.shadow_params.resize(engine.shadow_generators.size(), nullptr);
#endif
    }
    pal::refresh_shadow_generators(
        scene,
        engine,
        state.shadow_refresh,
        [&](
            [[maybe_unused]] const ShadowGeneratorRecord& generator,
            ShadowGeneratorHandle handle,
            std::size_t,
            const upstream::ShadowReceiverBlock& block,
            bool moved) {
#if BBLITE_SHADOWS_ESM
            // `shadow_params_block` reads what the factory fixed -- bias,
            // depth scale, texel size -- so it is built once and outlives
            // every refresh.
            if (generator.filter == ShadowFilter::esm_directional &&
                !handle_at(state.shadow_params, handle)) {
                const std::array<float, 8> params =
                    upstream::shadow_params_block(generator);
                handle_at(state.shadow_params, handle) = create_buffer(
                    state,
                    WGPUBufferUsage_Uniform,
                    params.data(),
                    params.size() * sizeof(float));
            }
#endif
            if (!handle_at(state.shadow_uniforms, handle)) {
                handle_at(state.shadow_uniforms, handle) = create_buffer(
                    state,
                    WGPUBufferUsage_Uniform,
                    block.bytes.data(),
                    block.size);
            } else if (moved) {
                wgpuQueueWriteBuffer(
                    state.queue,
                    handle_at(state.shadow_uniforms, handle),
                    0,
                    block.bytes.data(),
                    block.size);
            }
        });
}
#endif

#if !BBLITE_STANDARD_SHADOWS
// A Standard scene that reaches no generator: every call site below still
// compiles, and each answers "no shadows" rather than being conditioned out.
[[maybe_unused]] inline WGPUBindGroupLayout standard_shadow_layout_for(
    DawnState&,
    std::size_t) {
    return nullptr;
}
[[maybe_unused]] inline WGPUBindGroup standard_shadow_group_for(
    DawnState&,
    const Scene&,
    const Engine&,
    std::size_t) {
    return nullptr;
}
#endif

#if BBLITE_STANDARD_VARIANTS > 0
/**
 * Group 1 for one Standard variant: the mesh block, the `mat` block, then
 * exactly the resources the composed stages declare — textures with their
 * samplers, the vertex `up` block, the geometry arms' `gp`, the morph
 * storage pair. `unfilterable_emissive` keys the depth-emissive trap: a
 * record whose emissive is the depth render texture binds eT as
 * unfilterable-float with a non-filtering sampler.
 */
WGPUBindGroupLayout standard_draw_layout_for(
    DawnState& state,
    std::size_t variant,
    bool unfilterable_emissive) {
    const std::size_t key = variant * 2 + (unfilterable_emissive ? 1 : 0);
    if (
        state.standard_draw_layouts.size() <
        upstream::standard_variants.size() * 2) {
        state.standard_draw_layouts.resize(
            upstream::standard_variants.size() * 2,
            nullptr);
    }
    if (state.standard_draw_layouts[key]) {
        return state.standard_draw_layouts[key];
    }
    const upstream::StandardVariantEntry& entry =
        upstream::standard_variants[variant];
    // The composed stages own the group-1 binding map. Bindings 0 and 1
    // are the hand-managed mesh and material blocks — except when the
    // reflected rows occupy them: a morph variant's storage pair claims
    // bindings 1-2, which pushes `mat` out to a reflected uniform row of
    // its own (scene 252's is at 3). A fixed entry under an occupied
    // binding would duplicate it, which Dawn refuses at layout creation,
    // so each fixed entry yields to the rows.
    bool rows_occupy_binding_0 = false;
    bool rows_occupy_binding_1 = false;
    for (std::size_t index = 0; index < entry.binding_count; ++index) {
        const upstream::PinnedVariantBinding& binding =
            upstream::standard_variant_bindings[
                entry.first_binding + index];
        if (binding.binding == 0) rows_occupy_binding_0 = true;
        if (binding.binding == 1) rows_occupy_binding_1 = true;
    }
    std::vector<WGPUBindGroupLayoutEntry> entries;
    entries.reserve(2 + entry.binding_count);
    if (!rows_occupy_binding_0) {
        WGPUBindGroupLayoutEntry mesh_entry =
            WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
        mesh_entry.binding = 0;
        mesh_entry.visibility =
            WGPUShaderStage_Vertex | WGPUShaderStage_Fragment;
        mesh_entry.buffer.type = WGPUBufferBindingType_Uniform;
        entries.push_back(mesh_entry);
    }
    if (!rows_occupy_binding_1) {
        WGPUBindGroupLayoutEntry material_entry =
            WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
        material_entry.binding = 1;
        material_entry.visibility = WGPUShaderStage_Fragment;
        material_entry.buffer.type = WGPUBufferBindingType_Uniform;
        entries.push_back(material_entry);
    }
    for (std::size_t index = 0; index < entry.binding_count; ++index) {
        const upstream::PinnedVariantBinding& binding =
            upstream::standard_variant_bindings[
                entry.first_binding + index];
        entries.push_back(variant_layout_entry(
            binding,
            unfilterable_emissive &&
                (binding.name == "eT" || binding.name == "eS")));
    }
    WGPUBindGroupLayoutDescriptor descriptor =
        WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
    descriptor.entryCount = entries.size();
    descriptor.entries = entries.data();
    state.standard_draw_layouts[key] =
        wgpuDeviceCreateBindGroupLayout(state.device, &descriptor);
    if (!state.standard_draw_layouts[key]) {
        dawn_error("standard variant draw bind group layout creation failed.");
    }
    return state.standard_draw_layouts[key];
}


WGPUPipelineLayout standard_pipeline_layout_for(
    DawnState& state,
    std::size_t variant,
    bool unfilterable_emissive) {
    // The depth-emissive trap keys its own layout, so this family's cache is
    // twice its variant table.
    const std::size_t key = variant * 2 + (unfilterable_emissive ? 1 : 0);
    return composed_pipeline_layout(
        state,
        standard_draw_layout_for(state, variant, unfilterable_emissive),
        pal::standard_variant_receives_shadows(variant)
            ? standard_shadow_layout_for(state, variant)
            : nullptr,
        shadow_cache_slot(
            state.standard_pipeline_layouts,
            upstream::standard_variants.size() * 2,
            key),
        "standard variant pipeline layout creation failed.");
}

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
WGPUBindGroup build_standard_draw_group(
    DawnState& state,
    DawnMesh& mesh,
    const MaterialRecord* material,
    std::size_t variant,
    WGPUBuffer mesh_uniforms,
    WGPUBuffer material_uniforms,
    WGPUBuffer uv_uniforms,
    // Bound only when the composed variant declares the extension's block,
    // which is a reflected binding name rather than a compile-time fact --
    // the same shape `geometry_params` takes below.
    [[maybe_unused]] WGPUBuffer uv_transform_uniforms,
    WGPUBuffer geometry_params,
    StandardRenderViews render_views) {
    const WGPUTextureView emissive_render_view = render_views.emissive;
    const WGPUTextureView diffuse_render_view = render_views.diffuse;
    const bool unfilterable_emissive = emissive_render_view != nullptr;
    const upstream::StandardVariantEntry& entry =
        upstream::standard_variants[variant];
    // The fixed mesh@0/material@1 entries yield to reflected rows exactly
    // as the layout's do — a morph variant's storage pair occupies
    // binding 1 and its `mat` block rides a reflected row instead.
    bool rows_occupy_binding_0 = false;
    bool rows_occupy_binding_1 = false;
    for (std::size_t index = 0; index < entry.binding_count; ++index) {
        const upstream::PinnedVariantBinding& binding =
            upstream::standard_variant_bindings[
                entry.first_binding + index];
        if (binding.binding == 0) rows_occupy_binding_0 = true;
        if (binding.binding == 1) rows_occupy_binding_1 = true;
    }
    std::vector<WGPUBindGroupEntry> entries;
    entries.reserve(2 + entry.binding_count);
    if (!rows_occupy_binding_0) {
        WGPUBindGroupEntry mesh_entry = WGPU_BIND_GROUP_ENTRY_INIT;
        mesh_entry.binding = 0;
        mesh_entry.buffer = mesh_uniforms;
        mesh_entry.size = sizeof(upstream::MeshUniforms);
        entries.push_back(mesh_entry);
    }
    if (!rows_occupy_binding_1) {
        WGPUBindGroupEntry material_entry = WGPU_BIND_GROUP_ENTRY_INIT;
        material_entry.binding = 1;
        material_entry.buffer = material_uniforms;
        material_entry.size = upstream::standard_material_ubo_bytes;
        entries.push_back(material_entry);
    }
    for (std::size_t index = 0; index < entry.binding_count; ++index) {
        const upstream::PinnedVariantBinding& binding =
            upstream::standard_variant_bindings[
                entry.first_binding + index];
        WGPUBindGroupEntry group_entry = WGPU_BIND_GROUP_ENTRY_INIT;
        group_entry.binding = binding.binding;
        if (binding.kind == upstream::PinnedBindingKind::uniformBuffer) {
            if (binding.name == "up") {
                group_entry.buffer = uv_uniforms;
                group_entry.size =
                    sizeof(upstream::StandardUvTransformUniforms);
#if defined(BBLITE_HAS_STANDARD_UV_TRANSFORM) && BBLITE_HAS_STANDARD_UV_TRANSFORM
            } else if (binding.name == "stdUvTx") {
                group_entry.buffer = uv_transform_uniforms;
                group_entry.size = sizeof(upstream::StandardUvTxUniforms);
#endif
            } else if (binding.name == "gp" && geometry_params) {
                group_entry.buffer = geometry_params;
                group_entry.size = sizeof(PinnedGeometryParams);
            } else if (binding.name == "mat") {
                // The material block, displaced past hand-managed
                // binding 1 by the morph storage pair.
                group_entry.buffer = material_uniforms;
                group_entry.size = upstream::standard_material_ubo_bytes;
            } else if (binding.name == "mesh") {
                // The mesh block's mirror arm, should a variant ever
                // displace binding 0 the same way.
                group_entry.buffer = mesh_uniforms;
                group_entry.size = sizeof(upstream::MeshUniforms);
#if BBLITE_SHADOWS_ESM
            } else if (
                binding.name == "shadowParams" &&
                esm_caster_params_buffer(state, material)) {
                group_entry.buffer =
                    esm_caster_params_buffer(state, material);
                group_entry.size = upstream::shadow_params_block_bytes;
#endif
            } else {
                dawn_error(
                    ("standard variant declares an unmapped uniform "
                     "block '" + std::string(binding.name) + "'.")
                        .c_str());
            }
            entries.push_back(group_entry);
            continue;
        }
        if (binding.kind == upstream::PinnedBindingKind::storageBuffer) {
#if BBLITE_GPU_MORPH_STORAGE
            if (binding.name == "morphDeltas") {
                group_entry.buffer = mesh.morph_deltas;
            } else if (binding.name == "morph") {
                group_entry.buffer = mesh.morph_weights;
            }
#endif
            if (!group_entry.buffer) {
                dawn_error(
                    ("standard variant declares an unmapped storage "
                     "buffer '" + std::string(binding.name) + "'.")
                        .c_str());
            }
            group_entry.size = WGPU_WHOLE_SIZE;
            entries.push_back(group_entry);
            continue;
        }
        // The generated name->slot rows; the cube pair and the
        // depth-sampled emissive are the resources outside the table.
        WGPUTextureView view = nullptr;
        WGPUSampler sampler = nullptr;
        bool matched = false;
        for (
            const upstream::StandardBindingResource& row :
            upstream::standard_binding_resources) {
            if (
                binding.name != row.texture_name &&
                binding.name != row.sampler_name) {
                continue;
            }
            matched = true;
            if (row.reflection_cube) {
                view = mesh.reflection;
                sampler = state.default_sampler;
#if defined(BBLITE_STANDARD_SKELETON)
            } else if (row.source == upstream::MaterialTextureSource::bone_palette) {
                view = mesh.pinned_bone_view;
#endif
            } else if (
                row.source ==
                    upstream::MaterialTextureSource::standard_emissive &&
                material != nullptr &&
                material->has_emissive_render_texture) {
                view = emissive_render_view;
                sampler = state.nearest_sampler;
            } else if (
                row.source ==
                    upstream::MaterialTextureSource::base_color &&
                material != nullptr &&
                material->has_diffuse_render_texture) {
                // `material.diffuseTexture = <render target>`: a colour
                // attachment, which rtt.ts hands the pin's bilinear
                // sampler (`getBilinearSampler`: linear mag/min over
                // WebGPU's clamp default). This backend's clamp sampler
                // differs only in its mip filter, and buildRenderTarget
                // allocates one level, so nothing samples past mip 0.
                view = diffuse_render_view;
                sampler = state.clamp_sampler;
            } else {
                // By source, not by name: the row names are the pin's own
                // std bindings (dT/oT/rT...), the slot table's names are
                // the PBR pinned bindings, and the row's declared source
                // is the join key -- the same resolution the SDL sibling's
                // mesh_slot_members makes.
                const upstream::MaterialTextureSlot* slot =
                    material_slot_for_source(row.source);
                if (
                    slot == nullptr ||
                    slot->slot == upstream::material_texture_no_slot) {
                    dawn_error(
                        ("standard variant resource '" +
                         std::string(binding.name) +
                         "' has no material slot.")
                            .c_str());
                }
                view = mesh.views[slot->slot];
                sampler = mesh.samplers[slot->slot];
            }
            break;
        }
        (void)unfilterable_emissive;
        if (!matched) {
#if BBLITE_HAS_MATERIAL_PLUGIN_TEXTURES
            // A material plugin's own declaration. The name alone does not
            // resolve it -- two plugin lists may declare the same WGSL
            // name -- so the row is found by the material's own signature
            // index, and the texture is that material's, at the position
            // the pin's `bindPluginTextures` fills.
            const upstream::StandardPluginBinding* plugin_row = material
                ? upstream::standard_plugin_binding_for(
                      binding.name,
                      material->plugin_signature_index)
                : nullptr;
            if (plugin_row && mesh.shared_plugin_textures) {
                if (
                    plugin_row->ordinal >=
                    mesh.shared_plugin_textures->textures.size()) {
                    dawn_error(
                        ("standard variant plugin resource '" +
                         std::string(binding.name) +
                         "' has no bound texture.")
                            .c_str());
                }
                const DawnSampledTexture& plugin_texture =
                    mesh.shared_plugin_textures
                        ->textures[plugin_row->ordinal];
                view = plugin_texture.view;
                sampler = plugin_texture.sampler;
                matched = true;
            }
#endif
            if (!matched) {
                dawn_error(
                    ("standard variant declares an unmapped resource '" +
                     std::string(binding.name) + "'.")
                        .c_str());
            }
        }
        if (binding.kind == upstream::PinnedBindingKind::sampler) {
            group_entry.sampler = sampler;
        } else {
            group_entry.textureView = view;
        }
        entries.push_back(group_entry);
    }
    WGPUBindGroupDescriptor descriptor = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    descriptor.layout = standard_draw_layout_for(
        state,
        variant,
        unfilterable_emissive);
    descriptor.entryCount = entries.size();
    descriptor.entries = entries.data();
    DawnBindGroup group{wgpuDeviceCreateBindGroup(state.device, &descriptor)};
    if (!group) {
        dawn_error("standard variant draw bind group creation failed.");
    }
    return group.release();
}

/** The per-draw uniform buffers for a mesh's Standard draws. */
DawnDrawState& ensure_standard_draw_buffers(
    DawnState& state,
    DawnMesh& mesh,
    std::uint32_t material) {
    DawnDrawState& draw_state =
        mesh.standard_states.try_emplace(material, state).first->second;
    const auto uniform_buffer = [&](std::size_t size) {
        WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
        descriptor.size = static_cast<std::uint64_t>(size);
        descriptor.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
        DawnBuffer buffer{wgpuDeviceCreateBuffer(state.device, &descriptor)};
        if (!buffer) dawn_error("standard draw buffer creation failed.");
        return buffer.release();
    };
    if (!draw_state.mesh_uniforms) {
        draw_state.mesh_uniforms =
            uniform_buffer(sizeof(upstream::MeshUniforms));
    }
    if (!draw_state.material_uniforms) {
        draw_state.material_uniforms =
            uniform_buffer(upstream::standard_material_ubo_bytes);
    }
    if (!draw_state.uv_uniforms) {
        draw_state.uv_uniforms =
            uniform_buffer(sizeof(upstream::StandardUvTransformUniforms));
    }
#if defined(BBLITE_HAS_STANDARD_UV_TRANSFORM) && BBLITE_HAS_STANDARD_UV_TRANSFORM
    if (!draw_state.uv_transform_uniforms) {
        draw_state.uv_transform_uniforms =
            uniform_buffer(sizeof(upstream::StandardUvTxUniforms));
    }
#endif
    return draw_state;
}

/**
 * The attachments one material hands its Standard render-texture slots.
 *
 * Both reached writes -- `setStandardEmissiveTexture` and
 * `material.diffuseTexture` -- name a `createRenderTargetTexture` output,
 * and generation refuses any other source by name, so a reference reaching
 * here that is not a render target is a compiler contract broken rather
 * than a scene mistake.
 */
StandardRenderViews standard_render_views(
    DawnState& state,
    const Engine& engine,
    const MaterialRecord* material) {
    if (!material) return {};
    const auto view = [&](const RenderTextureRef& reference) {
        if (reference.source != RenderTextureSource::render_target) {
            dawn_error(
                "a material render texture must name a render target "
                "built by createRenderTargetTexture.");
        }
        return dawn_render_target_texture(state, engine, reference.target)
            .second;
    };
    return StandardRenderViews{
        material->has_emissive_render_texture
            ? view(material->emissive_render_texture)
            : nullptr,
        material->has_diffuse_render_texture
            ? view(material->diffuse_render_texture)
            : nullptr,
    };
}

/** Writes one Standard draw's pinned blocks for the frame. */
void write_standard_draw_blocks(
    DawnState& state,
    const Scene& scene,
    const Engine& engine,
    const upstream::RenderDrawCommand& draw,
    std::size_t variant,
    WGPUBuffer mesh_uniforms,
    WGPUBuffer material_uniforms,
    WGPUBuffer uv_uniforms,
    [[maybe_unused]] WGPUBuffer uv_transform_uniforms) {
    const MeshRecord& record = handle_at(engine.meshes, draw.item.mesh);
    const MaterialRecord* material =
        draw.item.material.value < engine.materials.size()
            ? &handle_at(engine.materials, draw.item.material)
            : nullptr;
    const upstream::StandardVariantEntry& entry =
        upstream::standard_variants[variant];
    const upstream::MeshUniforms mesh_block =
        pinned_mesh_block(
            scene,
            engine,
            standard_draw_world(
                record,
                entry.uses_local_position,
                scene,
                engine),
            draw.item.mesh.value);
    wgpuQueueWriteBuffer(
        state.queue,
        mesh_uniforms,
        0,
        &mesh_block,
        sizeof(mesh_block));
    std::uint32_t features = material
        ? upstream::standard_material_features(*material)
        : 0u;
    if (material && material->no_color) {
        features |= upstream::standard_no_color_output_flag;
    }
    const upstream::StandardMaterialUniforms material_block =
        standard_material_block(material, features);
    wgpuQueueWriteBuffer(
        state.queue,
        material_uniforms,
        0,
        &material_block,
        sizeof(material_block));
    const upstream::StandardUvTransformUniforms uv_block =
        standard_uv_block(material, features);
    wgpuQueueWriteBuffer(
        state.queue,
        uv_uniforms,
        0,
        &uv_block,
        sizeof(uv_block));
#if defined(BBLITE_HAS_STANDARD_UV_TRANSFORM) && BBLITE_HAS_STANDARD_UV_TRANSFORM
    const upstream::StandardUvTxUniforms uv_transform =
        standard_uv_transform_block(material);
    wgpuQueueWriteBuffer(
        state.queue,
        uv_transform_uniforms,
        0,
        &uv_transform,
        sizeof(uv_transform));
#endif
}

/**
 * The Standard sibling of `write_pinned_geometry_task`: every Standard
 * draw in a geometry task's lists resolves its MRT variant, writes the
 * shared per-draw blocks, and builds a per-variant group carrying the
 * task's own `gp` buffer. Variants are per task by construction — the
 * selector keys on the task index — so the per-variant map cannot mix
 * two tasks' groups.
 */
[[maybe_unused]] void write_standard_geometry_task(
    DawnState& state,
    const Scene& scene,
    const Engine& engine,
    const FrameTaskRecord& task,
    DawnGeometryTask& geometry,
    const upstream::RenderDrawLists& draw_lists) {
    for (const auto* list : {&draw_lists.opaque, &draw_lists.transparent}) {
        for (const upstream::RenderDrawCommand& draw : list->commands) {
            if (
                draw.item.material_kind !=
                upstream::RenderMaterialKind::standard) {
                continue;
            }
            if (draw.item_index >= state.meshes.size()) continue;
            const std::size_t variant = standard_variant_for_draw(
                scene,
                engine,
                draw,
                static_cast<std::size_t>(task.geometry.shader_index));
            if (variant == npos) {
                dawn_error(
                    ("Standard draw for mesh " +
                     std::to_string(draw.item.mesh.value) +
                     ", material " +
                     std::to_string(draw.item.material.value) +
                     " resolves no composed variant in a geometry task: " +
                     standard_variant_request(engine, draw))
                        .c_str());
            }
            DawnMesh& mesh = state.meshes[draw.item_index];
#if defined(BBLITE_STANDARD_SKELETON)
            if (upstream::standard_variant_skeleton(upstream::standard_variants[variant])) {
                write_pinned_bone_texture(state, mesh, handle_at(engine.meshes, draw.item.mesh));
            }
#endif
            const MaterialRecord* material =
                draw.item.material.value < engine.materials.size()
                    ? &handle_at(engine.materials, draw.item.material)
                    : nullptr;
            DawnDrawState& colour_state =
                ensure_standard_draw_buffers(
                    state,
                    mesh,
                    draw.item.material.value);
            DawnDrawState& draw_state =
                mesh.standard_geometry_states.try_emplace(variant, state).first->second;
            // A LOCAL_POSITION variant's mesh block carries the node world
            // where the colour pass's carries the identity over baked
            // vertices, and every queue write lands before the frame's
            // submission — so a geometry variant cannot share the colour
            // pass's mesh buffer without the last writer poisoning the
            // other pass. Each geometry draw state owns its mesh block;
            // the material and uv blocks are the same bytes in every pass
            // and stay shared.
            if (!draw_state.mesh_uniforms) {
                WGPUBufferDescriptor descriptor =
                    WGPU_BUFFER_DESCRIPTOR_INIT;
                descriptor.size = sizeof(upstream::MeshUniforms);
                descriptor.usage =
                    WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
                draw_state.mesh_uniforms =
                    wgpuDeviceCreateBuffer(state.device, &descriptor);
                if (!draw_state.mesh_uniforms) {
                    dawn_error(
                        "standard geometry mesh buffer creation failed.");
                }
            }
            write_standard_draw_blocks(
                state,
                scene,
                engine,
                draw,
                variant,
                draw_state.mesh_uniforms,
                colour_state.material_uniforms,
                colour_state.uv_uniforms,
                colour_state.uv_transform_uniforms);
            if (!draw_state.group) {
                draw_state.group = build_standard_draw_group(
                    state,
                    mesh,
                    material,
                    variant,
                    draw_state.mesh_uniforms,
                    colour_state.material_uniforms,
                    colour_state.uv_uniforms,
                    colour_state.uv_transform_uniforms,
                    geometry.pinned_geometry_params,
                    // A geometry task writes the MRT attachments and
                    // samples neither slot, and its layout arm is the
                    // filterable one, so it binds neither view.
                    StandardRenderViews{});
            }
        }
    }
}
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

WGPUPipelineLayout pinned_pipeline_layout_for(
    DawnState& state,
    std::size_t variant) {
    return composed_pipeline_layout(
        state,
        pinned_draw_layout_for(state, variant),
        pal::pbr_variant_receives_shadows(variant)
            ? pbr_shadow_layout_for(state, variant)
            : nullptr,
        shadow_cache_slot(
            state.pinned_pipeline_layouts,
            upstream::pbr_variants.size(),
            variant),
        "pinned variant pipeline layout creation failed.");
}
#endif

WGPUPipelineLayout mesh_pipeline_layout_for(DawnState& state) {
    if (state.mesh_pipeline_layout) return state.mesh_pipeline_layout;
    // Group 0: vertex storage morphing (always declared so the layout
    // stays one superset; storage entries only when compiled).
    {
        std::array<WGPUBindGroupLayoutEntry, 2> entries{};
        std::uint32_t count = 0;
#if BBLITE_GPU_MORPH_STORAGE
        for (std::uint32_t binding = 0; binding < 2; ++binding) {
            entries[count] = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
            entries[count].binding = binding;
            entries[count].visibility = WGPUShaderStage_Vertex;
            entries[count].buffer.type =
                WGPUBufferBindingType_ReadOnlyStorage;
            ++count;
        }
#endif
        WGPUBindGroupLayoutDescriptor descriptor =
            WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
        descriptor.entryCount = count;
        descriptor.entries = entries.data();
        state.mesh_group_layouts[0] = wgpuDeviceCreateBindGroupLayout(
            state.device,
            &descriptor);
    }
    // Group 1: vertex uniforms (scene matrix, deformation, instance).
    {
        std::array<WGPUBindGroupLayoutEntry, 3> entries{};
        std::uint32_t count = 0;
        const auto uniform = [&](std::uint32_t binding) {
            entries[count] = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
            entries[count].binding = binding;
            entries[count].visibility = WGPUShaderStage_Vertex;
            entries[count].buffer.type = WGPUBufferBindingType_Uniform;
            ++count;
        };
        uniform(0);
#if BBLITE_GPU_DEFORMATION
        uniform(1);
#endif
#if BBLITE_GPU_INSTANCING
        uniform(instance_uniform_binding);
#endif
        WGPUBindGroupLayoutDescriptor descriptor =
            WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
        descriptor.entryCount = count;
        descriptor.entries = entries.data();
        state.mesh_group_layouts[1] = wgpuDeviceCreateBindGroupLayout(
            state.device,
            &descriptor);
    }
    // Group 2: fragment texture/sampler pairs in the SDL slot order;
    // binding 8 is the cube slot.
    {
        constexpr std::size_t pair_count =
            6 + transmission_texture_pairs + material_extension_slots +
            standard_bump_slots;
        std::array<WGPUBindGroupLayoutEntry, pair_count * 2> entries{};
        for (std::uint32_t pair = 0; pair < pair_count; ++pair) {
            entries[pair * 2] = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
            entries[pair * 2].binding = pair * 2;
            entries[pair * 2].visibility = WGPUShaderStage_Fragment;
            entries[pair * 2].texture.sampleType =
                WGPUTextureSampleType_Float;
            entries[pair * 2].texture.viewDimension = pair == 4
                ? WGPUTextureViewDimension_Cube
                : WGPUTextureViewDimension_2D;
            entries[pair * 2 + 1] = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
            entries[pair * 2 + 1].binding = pair * 2 + 1;
            entries[pair * 2 + 1].visibility =
                WGPUShaderStage_Fragment;
            entries[pair * 2 + 1].sampler.type =
                WGPUSamplerBindingType_Filtering;
        }
        WGPUBindGroupLayoutDescriptor descriptor =
            WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
        descriptor.entryCount = entries.size();
        descriptor.entries = entries.data();
        state.mesh_group_layouts[2] = wgpuDeviceCreateBindGroupLayout(
            state.device,
            &descriptor);
    }
    // Group 3: the fragment uniform block.
    {
        WGPUBindGroupLayoutEntry entry =
            WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
        entry.binding = 0;
        entry.visibility = WGPUShaderStage_Fragment;
        entry.buffer.type = WGPUBufferBindingType_Uniform;
        WGPUBindGroupLayoutDescriptor descriptor =
            WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
        descriptor.entryCount = 1;
        descriptor.entries = &entry;
        state.mesh_group_layouts[3] = wgpuDeviceCreateBindGroupLayout(
            state.device,
            &descriptor);
    }
    WGPUPipelineLayoutDescriptor descriptor =
        WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
    descriptor.bindGroupLayoutCount = state.mesh_group_layouts.size();
    descriptor.bindGroupLayouts = state.mesh_group_layouts.data();
    state.mesh_pipeline_layout = wgpuDeviceCreatePipelineLayout(
        state.device,
        &descriptor);
    if (!state.mesh_pipeline_layout) {
        dawn_error("mesh pipeline layout creation failed.");
    }
    return state.mesh_pipeline_layout;
}

WGPUTextureSampleType shader_sample_type(
    upstream::ShaderSamplerSampleType type) {
    switch (type) {
        case upstream::ShaderSamplerSampleType::unfilterable_float:
            return WGPUTextureSampleType_UnfilterableFloat;
        case upstream::ShaderSamplerSampleType::depth:
            return WGPUTextureSampleType_Depth;
        case upstream::ShaderSamplerSampleType::float_sample:
            return WGPUTextureSampleType_Float;
    }
    dawn_error("Unknown shader sampler sample type.");
}

WGPUTextureViewDimension shader_view_dimension(
    upstream::ShaderSamplerViewDimension dimension) {
    switch (dimension) {
        case upstream::ShaderSamplerViewDimension::texture_2d_array:
            return WGPUTextureViewDimension_2DArray;
        case upstream::ShaderSamplerViewDimension::texture_2d:
            return WGPUTextureViewDimension_2D;
    }
    dawn_error("Unknown shader sampler view dimension.");
}

/** Pipeline layout for one generated ShaderMaterial reflection row. */
WGPUPipelineLayout shader_pipeline_layout_for(
    DawnState& state,
    std::uint32_t variant) {
    const std::size_t variant_count = upstream::shader_variant_count();
    if (variant >= variant_count) {
        dawn_error("Unknown shader variant id.");
    }
    if (state.shader_pipeline_layouts.size() < variant_count) {
        state.shader_pipeline_layouts.resize(variant_count, nullptr);
        state.shader_group_layouts.resize(variant_count);
    }
    if (state.shader_pipeline_layouts[variant]) {
        return state.shader_pipeline_layouts[variant];
    }

    const upstream::ShaderVariantInfo& info =
        upstream::shader_variant_info(variant);
    std::array<std::vector<WGPUBindGroupLayoutEntry>, 4> entries;
    std::uint32_t vertex_storage_binding = 0;
    std::uint32_t fragment_storage_binding =
        static_cast<std::uint32_t>(info.samplers.size() * 2);
    for (const upstream::ShaderStorageBufferInfo& storage :
         info.storage_buffers) {
        if (storage.vertex) {
            WGPUBindGroupLayoutEntry entry =
                WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
            entry.binding = vertex_storage_binding++;
            entry.visibility = WGPUShaderStage_Vertex;
            entry.buffer.type = WGPUBufferBindingType_ReadOnlyStorage;
            entries[0].push_back(entry);
        }
        if (storage.fragment) {
            WGPUBindGroupLayoutEntry entry =
                WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
            entry.binding = fragment_storage_binding++;
            entry.visibility = WGPUShaderStage_Fragment;
            entry.buffer.type = WGPUBufferBindingType_ReadOnlyStorage;
            entries[2].push_back(entry);
        }
    }
    if (info.vertex.present) {
        WGPUBindGroupLayoutEntry entry =
            WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
        entry.binding = 0;
        entry.visibility = WGPUShaderStage_Vertex;
        entry.buffer.type = WGPUBufferBindingType_Uniform;
        entries[1].push_back(entry);
    }
    for (std::size_t slot = 0; slot < info.samplers.size(); ++slot) {
        const upstream::ShaderSamplerShape shape =
            slot < info.sampler_shapes.size()
                ? info.sampler_shapes[slot]
                : upstream::ShaderSamplerShape{};
        WGPUBindGroupLayoutEntry texture =
            WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
        texture.binding = static_cast<std::uint32_t>(slot * 2);
        texture.visibility = WGPUShaderStage_Fragment;
        texture.texture.sampleType = shader_sample_type(shape.sample_type);
        texture.texture.viewDimension =
            shader_view_dimension(shape.view_dimension);
        entries[2].push_back(texture);
        WGPUBindGroupLayoutEntry sampler =
            WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
        sampler.binding = static_cast<std::uint32_t>(slot * 2 + 1);
        sampler.visibility = WGPUShaderStage_Fragment;
        sampler.sampler.type = shape.comparison
            ? WGPUSamplerBindingType_Comparison
            : shape.sample_type ==
                    upstream::ShaderSamplerSampleType::unfilterable_float
                ? WGPUSamplerBindingType_NonFiltering
                : WGPUSamplerBindingType_Filtering;
        entries[2].push_back(sampler);
    }
    if (info.fragment.present) {
        WGPUBindGroupLayoutEntry entry =
            WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
        entry.binding = 0;
        entry.visibility = WGPUShaderStage_Fragment;
        entry.buffer.type = WGPUBufferBindingType_Uniform;
        entries[3].push_back(entry);
    }

    auto& layouts = state.shader_group_layouts[variant];
    for (std::size_t group = 0; group < layouts.size(); ++group) {
        WGPUBindGroupLayoutDescriptor descriptor =
            WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
        descriptor.entryCount = entries[group].size();
        descriptor.entries = entries[group].data();
        layouts[group] = wgpuDeviceCreateBindGroupLayout(
            state.device,
            &descriptor);
        if (!layouts[group]) {
            dawn_error("Shader bind group layout creation failed.");
        }
    }
    WGPUPipelineLayoutDescriptor descriptor =
        WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
    descriptor.bindGroupLayoutCount = layouts.size();
    descriptor.bindGroupLayouts = layouts.data();
    state.shader_pipeline_layouts[variant] =
        wgpuDeviceCreatePipelineLayout(state.device, &descriptor);
    if (!state.shader_pipeline_layouts[variant]) {
        dawn_error("Shader pipeline layout creation failed.");
    }
    return state.shader_pipeline_layouts[variant];
}

DawnPipeline& pipeline_for(
    DawnState& state,
    upstream::RenderPipelineKind kind,
    std::uint32_t shader_variant = 0,
    /** Zero asks for the frame's own sample count. */
    std::uint32_t requested_samples = 0,
    bool has_depth = true,
    bool shadow_pass = false) {
    // The main set is whatever matches the frame; a render-task target
    // that differs gets its own. Written as "matches the frame" rather
    // than "is 4x" so a single-sample run keeps one main set instead of
    // filing every pipeline under the task buckets.
    const std::uint32_t samples = requested_samples == 0
        ? state.sample_count
        : requested_samples;
    const bool frame_samples = samples == state.sample_count;
    auto& pipeline_map = shadow_pass
        ? state.shader_shadow_pipelines
        : frame_samples && has_depth
            ? state.pipelines
            : state.task_pipelines[frame_samples ? 1 : 0]
                                  [has_depth ? 1 : 0];
    const auto pipeline_key = std::make_pair(kind, shader_variant);
    const auto existing = pipeline_map.find(pipeline_key);
    if (existing != pipeline_map.end()) return existing->second;
    const PipelineKindTraits traits = pipeline_traits(kind);
    const upstream::ShaderVariantInfo* shader_info = traits.shader
        ? &upstream::shader_variant_info(shader_variant)
        : nullptr;

    std::array<WGPUVertexAttribute, base_vertex_attribute_count>
        attributes{};
    fill_base_vertex_attributes(attributes.data());
    std::array<WGPUVertexBufferLayout, vertex_streams.size()>
        vertex_layouts{};
    vertex_layouts[0].stepMode = WGPUVertexStepMode_Vertex;
    vertex_layouts[0].arrayStride = sizeof(GpuVertex);
    vertex_layouts[0].attributeCount = attributes.size();
    vertex_layouts[0].attributes = attributes.data();
#if BBLITE_GPU_INSTANCING
    // Per-instance world-matrix columns at locations 16-19, exactly
    // like the SDL backend's second vertex buffer.
    std::array<WGPUVertexAttribute, 4> instance_attributes{};
    for (std::uint32_t column = 0; column < 4; ++column) {
        instance_attributes[column].format = WGPUVertexFormat_Float32x4;
        instance_attributes[column].offset = column * 16;
        instance_attributes[column].shaderLocation =
            instance_matrix_first_location + column;
    }
    vertex_layouts[1].stepMode = WGPUVertexStepMode_Instance;
    vertex_layouts[1].arrayStride = sizeof(std::array<float, 16>);
    vertex_layouts[1].attributeCount = instance_attributes.size();
    vertex_layouts[1].attributes = instance_attributes.data();
    constexpr std::uint32_t matrix_vertex_buffer_count = 2;
#else
    constexpr std::uint32_t matrix_vertex_buffer_count = 1;
#endif
#if BBLITE_GPU_INSTANCE_COLORS
    // The per-instance RGBA stream the pin's own thin-instance module
    // appends after the matrix lanes, in its own tightly-packed buffer.
    // Only a material that declares the lane widens its layout, exactly as
    // the SDL backend widens that one pipeline: every other pipeline keeps
    // the layout it had, so no draw of theirs owes the slot a buffer.
    WGPUVertexAttribute instance_color_attribute{};
    instance_color_attribute.format = WGPUVertexFormat_Float32x4;
    instance_color_attribute.offset = 0;
    instance_color_attribute.shaderLocation = instance_color_location;
    vertex_layouts[2].stepMode = WGPUVertexStepMode_Instance;
    vertex_layouts[2].arrayStride = sizeof(std::array<float, 4>);
    vertex_layouts[2].attributeCount = 1;
    vertex_layouts[2].attributes = &instance_color_attribute;
    const std::uint32_t vertex_buffer_count =
        shader_info && shader_info->instance_colors
            ? matrix_vertex_buffer_count + 1
            : matrix_vertex_buffer_count;
#else
    constexpr std::uint32_t vertex_buffer_count =
        matrix_vertex_buffer_count;
#endif

    if (traits.grid && !state.grid_vertex_module) {
        state.grid_vertex_module = load_wgsl_module(state, "grid.vert");
        state.grid_fragment_module =
            load_wgsl_module(state, "grid.frag");
    }
    if (shader_info) {
        if (state.shader_vertex_modules.size() <
            upstream::shader_variant_count()) {
            state.shader_vertex_modules.resize(
                upstream::shader_variant_count(),
                nullptr);
            state.shader_fragment_modules.resize(
                upstream::shader_variant_count(),
                nullptr);
        }
        if (!state.shader_vertex_modules[shader_variant]) {
            const std::string base_name = shader_info->name;
            state.shader_vertex_modules[shader_variant] =
                load_wgsl_module(
                    state,
                    (base_name + ".vert").c_str());
        }
        if (!shadow_pass && !state.shader_fragment_modules[shader_variant]) {
            const std::string base_name = shader_info->name;
            state.shader_fragment_modules[shader_variant] =
                load_wgsl_module(
                    state,
                    (base_name + ".frag").c_str());
        }
    }
    WGPURenderPipelineDescriptor descriptor =
        WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    descriptor.layout = shader_info
        ? shader_pipeline_layout_for(state, shader_variant)
        : mesh_pipeline_layout_for(state);
    descriptor.vertex.module = traits.grid
        ? state.grid_vertex_module
        : shader_info
            ? state.shader_vertex_modules[shader_variant]
            : state.vertex_module;
    descriptor.vertex.entryPoint = string_view("mainVertex");
    descriptor.vertex.bufferCount = vertex_buffer_count;
    descriptor.vertex.buffers = vertex_layouts.data();

    // The material's own primitive: the pin builds a shader pipeline at
    // `material._topology ?? "triangle-list"`, and a line material is the
    // one reached material that names the second one.
    descriptor.primitive.topology =
        shader_info &&
                shader_info->topology ==
                    upstream::ShaderTopology::line_list
            ? WGPUPrimitiveTopology_LineList
            : WGPUPrimitiveTopology_TriangleList;
    descriptor.primitive.frontFace = traits.front;
    // The pinned shader-pipeline mapping drives variant state:
    // backFaceCulling selects the cull mode, and depthWrite=false turns
    // depth writes off (as a transparent draw does).
    descriptor.primitive.cullMode = shader_info
        ? (shader_info->back_face_culling
               ? WGPUCullMode_Back
               : WGPUCullMode_None)
        : traits.cull;

    const bool depth_write_off =
        traits.transparent ||
        (shader_info && !shader_info->depth_write);
    WGPUDepthStencilState depth_stencil =
        WGPU_DEPTH_STENCIL_STATE_INIT;
    depth_stencil.format = shadow_pass
        ? WGPUTextureFormat_Depth32Float
        : WGPUTextureFormat_Depth24PlusStencil8;
    depth_stencil.depthWriteEnabled = depth_write_off
        ? WGPUOptionalBool_False
        : WGPUOptionalBool_True;
    depth_stencil.depthCompare =
        dawn_depth_compare(shader_info && shader_info->depth_compare
            ? *shader_info->depth_compare : pass_depth_compare(shadow_pass));
    // Depth-less render-task targets need attachment-compatible
    // pipelines; WebGPU validates what SDL_GPU tolerated.
    descriptor.depthStencil = has_depth ? &depth_stencil : nullptr;

    descriptor.multisample.count = samples;
    descriptor.multisample.mask = ~0u;
    // The one a2c rule (pal_gpu_shared.hpp): coverage needs samples to
    // spread across; at one sample WebGPU rejects the pipeline outright.
    descriptor.multisample.alphaToCoverageEnabled =
        alpha_to_coverage_enabled(traits.shader_a2c, samples);

    WGPUColorTargetState color_target = WGPU_COLOR_TARGET_STATE_INIT;
    color_target.format = state.frame_color_format;
    WGPUBlendState blend{};
    if (
        traits.transparent ||
        (shader_info && shader_info->alpha_blending)) {
        blend = blend_state_from(
            shader_info && shader_info->additive_blending
                ? shader_additive_blend
                : transparent_blend);
        color_target.blend = &blend;
    }
    WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
    if (traits.grid) {
        fragment.module = state.grid_fragment_module;
    } else if (shader_info) {
        fragment.module = state.shader_fragment_modules[shader_variant];
    } else {
        fragment_module_for(state, traits.standard);
    }
    fragment.entryPoint = string_view("mainFragment");
    fragment.targetCount = 1;
    fragment.targets = &color_target;
    descriptor.fragment = shadow_pass && shader_info
        ? nullptr
        : &fragment;

    DawnRenderPipeline pipeline{wgpuDeviceCreateRenderPipeline(state.device, &descriptor)};
    if (!pipeline) dawn_error("wgpuDeviceCreateRenderPipeline");
    DawnPipeline& slot = pipeline_map[pipeline_key];
    slot.pipeline = pipeline.release();
    return slot;
}


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
bool append_variant_attribute(
    std::string_view name,
    std::uint32_t location,
    bool uses_local_position,
    VariantVertexAttributes& inputs,
    bool uses_local_normal = false) {
    const PinnedVertexInput input =
        pinned_vertex_input(name, uses_local_position, uses_local_normal);
    if (!input.mapped) return false;
    WGPUVertexAttribute attribute{};
    attribute.shaderLocation = location;
    attribute.offset = input.offset;
    switch (input.lane) {
        case VertexInputLane::float2:
            attribute.format = WGPUVertexFormat_Float32x2;
            break;
        case VertexInputLane::float3:
            attribute.format = WGPUVertexFormat_Float32x3;
            break;
        case VertexInputLane::float4:
            attribute.format = WGPUVertexFormat_Float32x4;
            break;
        case VertexInputLane::uint4:
            attribute.format = WGPUVertexFormat_Uint32x4;
            break;
    }
    inputs.of(input.stream).push_back(attribute);
    return true;
}

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
[[maybe_unused]] std::uint32_t fill_variant_vertex_layouts(
    VariantVertexAttributes& inputs,
    std::array<WGPUVertexBufferLayout, vertex_streams.size()>& layouts) {
    std::uint32_t used = 1;
    for (std::size_t index = 0; index < vertex_streams.size(); ++index) {
        const VertexInputStream stream = vertex_streams[index];
        const std::vector<WGPUVertexAttribute>& attributes =
            inputs.of(stream);
        layouts[index].stepMode = vertex_stream_is_instanced(stream)
            ? WGPUVertexStepMode_Instance
            : WGPUVertexStepMode_Vertex;
        layouts[index].arrayStride = vertex_stream_stride(stream);
        layouts[index].attributeCount = attributes.size();
        layouts[index].attributes = attributes.data();
        if (!attributes.empty()) {
            used = std::max(used, vertex_stream_slot(stream) + 1u);
        }
    }
    return used;
}
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
[[maybe_unused]] void apply_pass_depth_state(
    WGPUDepthStencilState& depth_stencil,
    bool shadow_pass) {
    depth_stencil.format = shadow_pass
        ? WGPUTextureFormat_Depth32Float
        : WGPUTextureFormat_Depth24PlusStencil8;
    depth_stencil.depthCompare =
        dawn_depth_compare(pal::pass_depth_compare(shadow_pass));
}

#if BBLITE_PBR_VARIANTS > 0 || BBLITE_STANDARD_VARIANTS > 0 || \
    BBLITE_NODE_GEOMETRY_VARIANTS > 0
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
void apply_geometry_color_targets(
    WGPUFragmentState& fragment,
    WGPUDepthStencilState& depth_stencil,
    std::vector<WGPUColorTargetState>& targets,
    const DawnState& state,
    const FrameTaskRecord& task,
    std::size_t entry_color_target_count,
    const char* family,
    const WGPUBlendState* blend) {
    const std::vector<WGPUTextureFormat> formats =
        geometry_color_target_formats<WGPUTextureFormat>(
            task,
            entry_color_target_count,
            family,
            [](TextureFormatClass format_class) {
                return texture_format(format_class);
            },
            state.frame_color_format);
    targets.reserve(formats.size());
    for (const WGPUTextureFormat format : formats) {
        WGPUColorTargetState target = WGPU_COLOR_TARGET_STATE_INIT;
        target.format = format;
        target.blend = blend;
        targets.push_back(target);
    }
    fragment.targetCount = targets.size();
    fragment.targets = targets.data();
    depth_stencil.depthWriteEnabled = WGPUOptionalBool_True;
}
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
WGPURenderPipeline pinned_variant_pipeline(
    DawnState& state,
    std::size_t variant,
    upstream::RenderPipelineKind kind,
    std::uint32_t samples,
    bool has_depth,
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
    std::uint32_t esm_shadow_index = invalid_handle) {
    const std::size_t key = pal::variant_pipeline_key(
        pal::esm_keyed_variant(
            variant,
            upstream::pbr_variants.size(),
            esm_shadow_index),
        kind,
        {shadow_pass, has_depth});
    auto& map = state.pinned_variant_pipelines[samples];
    const auto existing = map.find(key);
    if (existing != map.end()) return existing->second;
    // The same traits the transcribed pipeline reads, from the same kind. The
    // winding matters: a mesh whose node matrix mirrors draws through
    // `pbr_*_none_clockwise`, and hardcoding counter-clockwise here inverted
    // Scene 168's double-sided faces and Scene 266's negative-scale spheres.
    // Decoded after the cache lookup, as every sibling builder does: a hit is
    // every draw past the first, and it needs none of this.
    const PipelineKindTraits traits = pipeline_traits(kind);
    if (state.pinned_vertex_modules.size() < upstream::pbr_variants.size()) {
        state.pinned_vertex_modules.resize(
            upstream::pbr_variants.size(),
            nullptr);
        state.pinned_fragment_modules.resize(
            upstream::pbr_variants.size(),
            nullptr);
    }
    const upstream::PbrVariantEntry& entry = upstream::pbr_variants[variant];
    if (!state.pinned_vertex_modules[variant]) {
        // The deployed module name: generation prefixes the variant stages so
        // they cannot collide with the scene's own modules.
        const auto stem = [](std::string_view file) {
            return "variant-" + std::string(file.substr(0, file.find(".wgsl")));
        };
        state.pinned_vertex_modules[variant] =
            load_wgsl_module(state, stem(entry.vertex_shader).c_str());
        state.pinned_fragment_modules[variant] =
            load_wgsl_module(state, stem(entry.fragment_shader).c_str());
    }
    // The variant's own inputs, at the locations it declares them. The names
    // are the pin's; where each sits in our vertex is the PAL's, so a variant
    // asking for something we do not carry fails by name here.
    VariantVertexAttributes inputs;
    inputs.vertex.reserve(entry.attribute_count);
    for (std::size_t index = 0; index < entry.attribute_count; ++index) {
        const upstream::PbrVariantAttribute& input =
            upstream::pbr_variant_attributes[entry.first_attribute + index];
        if (
            !append_variant_attribute(
                input.name,
                input.location,
                entry.uses_local_position,
                inputs)) {
            dawn_error(
                (std::string("pinned variant declares an unmapped vertex ") +
                 "input '" + std::string(input.name) + "'.")
                    .c_str());
        }
    }
    std::array<WGPUVertexBufferLayout, vertex_streams.size()>
        vertex_layouts{};
    const std::uint32_t vertex_buffer_count =
        fill_variant_vertex_layouts(inputs, vertex_layouts);

    WGPURenderPipelineDescriptor descriptor =
        WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    descriptor.layout = pinned_pipeline_layout_for(state, variant);
    descriptor.vertex.module = state.pinned_vertex_modules[variant];
    descriptor.vertex.entryPoint = string_view("main");
    descriptor.vertex.bufferCount = vertex_buffer_count;
    descriptor.vertex.buffers = vertex_layouts.data();
    descriptor.primitive.topology = traits.topology;
    descriptor.primitive.stripIndexFormat = traits.strip_index_format;
    descriptor.primitive.frontFace = traits.front;
    descriptor.primitive.cullMode = traits.cull;
    WGPUDepthStencilState depth_stencil = WGPU_DEPTH_STENCIL_STATE_INIT;
    apply_pass_depth_state(depth_stencil, shadow_pass);
    // A no-color view draws in the depth-only tasks, which write depth
    // whatever the material's own alpha would have said.
    depth_stencil.depthWriteEnabled =
        !entry.no_color_output && traits.transparent
            ? WGPUOptionalBool_False
            : WGPUOptionalBool_True;
    descriptor.depthStencil = has_depth ? &depth_stencil : nullptr;
    descriptor.multisample.count = samples;
    descriptor.multisample.mask = ~0u;
    WGPUColorTargetState color_target = WGPU_COLOR_TARGET_STATE_INIT;
    color_target.format = state.frame_color_format;
#if BBLITE_SHADOWS_ESM
    // An ESM caster variant draws into ONE generator's map -- the task that
    // owns this pass names it -- so the format is that generator's own row
    // rather than an assumption that every ESM map agrees.
    if (esm_shadow_index != invalid_handle && entry.esm_shadow_output) {
        color_target.format = esm_texture_format(
            upstream::esm_shadow_resources[esm_shadow_index].textures[0]
                .format);
    }
#endif
    WGPUBlendState blend{};
    if (traits.transparent) {
        blend = blend_state_from(transparent_blend);
        color_target.blend = &blend;
    }
    WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
    fragment.module = state.pinned_fragment_modules[variant];
    fragment.entryPoint = string_view("main");
    // A depth-only view's fragment writes no colour target, and the pass it
    // draws in carries none either.
    fragment.targetCount = entry.no_color_output ? 0 : 1;
    fragment.targets = entry.no_color_output ? nullptr : &color_target;
    // A geometry-output MRT variant draws into its task's own attachments,
    // through the builder all three families share.
    std::vector<WGPUColorTargetState> geometry_targets;
    if (geometry_task) {
        apply_geometry_color_targets(
            fragment,
            depth_stencil,
            geometry_targets,
            state,
            *geometry_task,
            entry.color_target_count,
            "pinned",
            traits.transparent ? &blend : nullptr);
    }
    descriptor.fragment = &fragment;
    DawnRenderPipeline pipeline{wgpuDeviceCreateRenderPipeline(state.device, &descriptor)};
    if (!pipeline) dawn_error("pinned variant pipeline creation failed.");
    const auto result = map.emplace(key, pipeline.get());
    if (result.second) (void)pipeline.release();
    return result.first->second;
}
#endif

#if BBLITE_STANDARD_VARIANTS > 0
/**
 * The render pipeline for one composed Standard variant — the Standard
 * sibling of `pinned_variant_pipeline`. The kind carries the blend and
 * cull state the render plan bucketed (standard-pipeline.ts
 * getOrCreateStandardPipeline).
 */
WGPURenderPipeline standard_variant_pipeline(
    DawnState& state,
    std::size_t variant,
    upstream::RenderPipelineKind kind,
    std::uint32_t samples,
    bool has_depth,
    bool unfilterable_emissive,
    const FrameTaskRecord* geometry_task = nullptr,
    // The pin's one exception to this port's depth convention: a shadow
    // caster pass renders standard-Z into the generator's own
    // `depth32float` map.
    bool shadow_pass = false,
    // Which ESM generator's map this pass writes, when it writes one. The
    // colour format is that generator's own recorded row, so two generators
    // whose factories returned different formats build different pipelines.
    std::uint32_t esm_shadow_index = invalid_handle) {
    const std::size_t key = pal::variant_pipeline_key(
        pal::esm_keyed_variant(
            variant,
            upstream::standard_variants.size(),
            esm_shadow_index),
        kind,
        {shadow_pass, has_depth, unfilterable_emissive});
    auto& map = state.standard_variant_pipelines[samples];
    const auto existing = map.find(key);
    if (existing != map.end()) return existing->second;
    // After the lookup, as every sibling builder does: a cache hit is every
    // draw past the first and needs none of the decode.
    const PipelineKindTraits traits = pipeline_traits(kind);
    if (
        state.standard_vertex_modules.size() <
        upstream::standard_variants.size()) {
        state.standard_vertex_modules.resize(
            upstream::standard_variants.size(),
            nullptr);
        state.standard_fragment_modules.resize(
            upstream::standard_variants.size(),
            nullptr);
    }
    const upstream::StandardVariantEntry& entry =
        upstream::standard_variants[variant];
    if (!state.standard_vertex_modules[variant]) {
        const auto stem = [](std::string_view file) {
            return "variant-std-" +
                std::string(file.substr(0, file.find(".wgsl")));
        };
        state.standard_vertex_modules[variant] =
            load_wgsl_module(state, stem(entry.vertex_shader).c_str());
        state.standard_fragment_modules[variant] =
            load_wgsl_module(state, stem(entry.fragment_shader).c_str());
    }
    VariantVertexAttributes inputs;
    inputs.vertex.reserve(entry.attribute_count);
    for (std::size_t index = 0; index < entry.attribute_count; ++index) {
        const upstream::StandardVariantAttribute& input =
            upstream::standard_variant_attributes[entry.first_attribute + index];
        if (
            !append_variant_attribute(
                input.name,
                input.location,
                entry.uses_local_position,
                inputs)) {
            dawn_error(
                (std::string("standard variant declares an unmapped vertex ") +
                 "input '" + std::string(input.name) + "'.")
                    .c_str());
        }
    }
    std::array<WGPUVertexBufferLayout, vertex_streams.size()>
        vertex_layouts{};
    const std::uint32_t vertex_buffer_count =
        fill_variant_vertex_layouts(inputs, vertex_layouts);
    WGPURenderPipelineDescriptor descriptor =
        WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    descriptor.layout = standard_pipeline_layout_for(
        state,
        variant,
        unfilterable_emissive);
    descriptor.vertex.module = state.standard_vertex_modules[variant];
    descriptor.vertex.entryPoint = string_view("main");
    descriptor.vertex.bufferCount = vertex_buffer_count;
    descriptor.vertex.buffers = vertex_layouts.data();
    descriptor.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    // The winding is the kind's under the mirrored-mesh opt-in: the pin
    // installs a Standard primitive resolver precisely because this family
    // has none of its own, and a mirrored mesh drawn counter-clockwise
    // renders inside-out.
    descriptor.primitive.frontFace = traits.front;
    descriptor.primitive.cullMode = traits.cull;
    WGPUDepthStencilState depth_stencil = WGPU_DEPTH_STENCIL_STATE_INIT;
    apply_pass_depth_state(depth_stencil, shadow_pass);
    depth_stencil.depthWriteEnabled =
        !entry.no_color_output && traits.transparent
            ? WGPUOptionalBool_False
            : WGPUOptionalBool_True;
    descriptor.depthStencil = has_depth ? &depth_stencil : nullptr;
    descriptor.multisample.count = samples;
    descriptor.multisample.mask = ~0u;
    WGPUColorTargetState color_target = WGPU_COLOR_TARGET_STATE_INIT;
    color_target.format = state.frame_color_format;
#if BBLITE_SHADOWS_ESM
    // An ESM caster variant draws into ONE generator's map -- the task that
    // owns this pass names it -- so the format is that generator's own row
    // rather than an assumption that every ESM map agrees.
    if (
        (entry.features & upstream::standard_esm_shadow_output_flag) &&
        esm_shadow_index != invalid_handle) {
        color_target.format = esm_texture_format(
            upstream::esm_shadow_resources[esm_shadow_index].textures[0]
                .format);
    }
#endif
    WGPUBlendState blend{};
    if (traits.transparent) {
        blend = blend_state_from(transparent_blend);
        color_target.blend = &blend;
    }
    WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
    fragment.module = state.standard_fragment_modules[variant];
    fragment.entryPoint = string_view("main");
    fragment.targetCount = entry.no_color_output ? 0 : 1;
    fragment.targets = entry.no_color_output ? nullptr : &color_target;
    // The Standard sibling of the pinned MRT assembly above, through the
    // same shared builder.
    std::vector<WGPUColorTargetState> geometry_targets;
    if (geometry_task) {
        apply_geometry_color_targets(
            fragment,
            depth_stencil,
            geometry_targets,
            state,
            *geometry_task,
            entry.color_target_count,
            "standard",
            traits.transparent ? &blend : nullptr);
    }
    descriptor.fragment = &fragment;
    DawnRenderPipeline pipeline{wgpuDeviceCreateRenderPipeline(state.device, &descriptor)};
    if (!pipeline) dawn_error("standard variant pipeline creation failed.");
    const auto result = map.emplace(key, pipeline.get());
    if (result.second) (void)pipeline.release();
    return result.first->second;
}
#endif

#if BBLITE_NODE_VARIANTS > 0
/**
 * Group 1 for one node graph: the pin's mesh block, the graph's own uniform
 * block at whichever binding `compileNodePipeline` gave it, and the
 * environment pair a graph reaching `ReflectionBlock` declares.
 */
WGPUBindGroupLayout node_draw_layout_for(
    DawnState& state,
    std::size_t variant,
    bool caster,
    std::size_t geometry_variant = pal::no_node_geometry_variant) {
    const std::size_t slot =
        pal::node_draw_slot(variant, caster, geometry_variant);
    if (state.node_draw_layouts.size() < pal::node_variant_slots()) {
        state.node_draw_layouts.resize(pal::node_variant_slots(), nullptr);
    }
    if (state.node_draw_layouts[slot]) {
        return state.node_draw_layouts[slot];
    }
    // The compiled view this slot draws: the graph's own row for a colour
    // or caster slot, the geometry emit's row for a geometry one.
    const upstream::NodeVariantEntry& view = pal::node_slot_view(slot);
    [[maybe_unused]] const bool geometry_view =
        geometry_variant != pal::no_node_geometry_variant;
    std::vector<WGPUBindGroupLayoutEntry> entries;
    WGPUBindGroupLayoutEntry mesh_entry = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
    mesh_entry.binding = 0;
    mesh_entry.visibility =
        WGPUShaderStage_Vertex | WGPUShaderStage_Fragment;
    mesh_entry.buffer.type = WGPUBufferBindingType_Uniform;
    entries.push_back(mesh_entry);
    if (upstream::has_node_ubo(view)) {
        WGPUBindGroupLayoutEntry node_entry =
            WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
        node_entry.binding =
            static_cast<std::uint32_t>(view.ubo_binding);
        node_entry.visibility =
            WGPUShaderStage_Vertex | WGPUShaderStage_Fragment;
        node_entry.buffer.type = WGPUBufferBindingType_Uniform;
        entries.push_back(node_entry);
    }
    // The graph's own `TextureBlock`/`ImageSourceBlock` pairs, at the
    // bindings the pin's pipeline builder allocated and with the visibility
    // its own BGL entry carries -- a UV chain can put the sample in either
    // stage, so the pin declares both and so does this.
    for (std::size_t index = 0; index < view.texture_count; ++index) {
        const upstream::NodeVariantTexture& binding =
            upstream::node_variant_textures[view.first_texture + index];
        WGPUBindGroupLayoutEntry texture = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
        texture.binding = binding.texture;
        texture.visibility =
            WGPUShaderStage_Vertex | WGPUShaderStage_Fragment;
        texture.texture.sampleType = WGPUTextureSampleType_Float;
        texture.texture.viewDimension = WGPUTextureViewDimension_2D;
        entries.push_back(texture);
        WGPUBindGroupLayoutEntry sampler = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
        sampler.binding = binding.sampler;
        sampler.visibility =
            WGPUShaderStage_Vertex | WGPUShaderStage_Fragment;
        sampler.sampler.type = WGPUSamplerBindingType_Filtering;
        entries.push_back(sampler);
    }
    // Everything past the graph's own bindings is per view, and the row
    // this slot names is that view's: `ensureGeometryResources` refuses a
    // graph whose geometry emit reaches morph targets, the environment or a
    // shadow light, so a geometry view's row declares all three absent and
    // the three arms below fall out on their own.
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
    if (geometry_view) {
        // The task's gpUniforms, at the binding `_buildGeomUbo` took --
        // present only for a view whose emit raised `_needsGpUbo`.
        const upstream::NodeGeometryVariantEntry& geometry =
            upstream::node_geometry_variants[geometry_variant];
        if (geometry.geometry_params_binding != upstream::node_no_ubo) {
            WGPUBindGroupLayoutEntry params =
                WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
            params.binding = static_cast<std::uint32_t>(
                geometry.geometry_params_binding);
            params.visibility = WGPUShaderStage_Fragment;
            params.buffer.type = WGPUBufferBindingType_Uniform;
            params.buffer.minBindingSize = sizeof(PinnedGeometryParams);
            entries.push_back(params);
        }
    }
#endif
    if (view.morph.present) {
        const auto storage = [&](std::uint32_t binding) {
            WGPUBindGroupLayoutEntry item =
                WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
            item.binding = binding;
            item.visibility = WGPUShaderStage_Vertex;
            item.buffer.type = WGPUBufferBindingType_ReadOnlyStorage;
            entries.push_back(item);
        };
        storage(view.morph.deltas_binding);
        storage(view.morph.weights_binding);
    }
    if (view.env.present) {
        // The pin's own four, in the order `emitEnv` allocates them: the
        // specular cube and its sampler, then the BRDF LUT and its own.
        const auto texture = [&](
                                 std::uint32_t binding,
                                 WGPUTextureViewDimension dimension) {
            WGPUBindGroupLayoutEntry item =
                WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
            item.binding = binding;
            item.visibility = WGPUShaderStage_Fragment;
            item.texture.sampleType = WGPUTextureSampleType_Float;
            item.texture.viewDimension = dimension;
            entries.push_back(item);
        };
        const auto sampler = [&](std::uint32_t binding) {
            WGPUBindGroupLayoutEntry item =
                WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
            item.binding = binding;
            item.visibility = WGPUShaderStage_Fragment;
            item.sampler.type = WGPUSamplerBindingType_Filtering;
            entries.push_back(item);
        };
        texture(view.env.ibl_texture, WGPUTextureViewDimension_Cube);
        sampler(view.env.ibl_sampler);
        texture(view.env.brdf_lut, WGPUTextureViewDimension_2D);
        sampler(view.env.brdf_sampler);
    }
#if BBLITE_NODE_SHADOWS
    if (caster) {
#if BBLITE_SHADOWS_ESM
        if (view.caster.esm) {
            // The ESM caster adds one row; the PCF no-colour compile adds
            // none and keeps only the graph's shared bindings above.
            WGPUBindGroupLayoutEntry params = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
            params.binding = view.caster.params_binding;
            params.visibility = WGPUShaderStage_Fragment;
            params.buffer.type = WGPUBufferBindingType_Uniform;
            params.buffer.minBindingSize = upstream::shadow_params_block_bytes;
            entries.push_back(params);
        }
#endif
    } else {
        // The receiver's rows, continuing the graph's own binding run
        // rather than opening a group of their own -- but each is the same
        // reflected row the composed families' are, so the same builder
        // answers what type it carries and which stages read it.
        for (const upstream::PinnedShadowBinding& row :
             pal::node_shadow_rows(view)) {
            entries.push_back(shadow_layout_entry(row));
        }
    }
#endif
    WGPUBindGroupLayoutDescriptor descriptor =
        WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
    descriptor.label = string_view("node-mesh");
    descriptor.entryCount = entries.size();
    descriptor.entries = entries.data();
    state.node_draw_layouts[slot] =
        wgpuDeviceCreateBindGroupLayout(state.device, &descriptor);
    if (!state.node_draw_layouts[slot]) {
        dawn_error("node variant bind group layout creation failed.");
    }
    return state.node_draw_layouts[slot];
}

WGPUPipelineLayout node_pipeline_layout_for(
    DawnState& state,
    std::size_t variant,
    bool caster,
    std::size_t geometry_variant = pal::no_node_geometry_variant) {
    const std::size_t slot =
        pal::node_draw_slot(variant, caster, geometry_variant);
    if (state.node_pipeline_layouts.size() < pal::node_variant_slots()) {
        state.node_pipeline_layouts.resize(pal::node_variant_slots(), nullptr);
    }
    if (state.node_pipeline_layouts[slot]) {
        return state.node_pipeline_layouts[slot];
    }
    std::array<WGPUBindGroupLayout, 2> groups{
        pinned_frame_layout_for(state),
        node_draw_layout_for(state, variant, caster, geometry_variant),
    };
    WGPUPipelineLayoutDescriptor descriptor =
        WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
    descriptor.bindGroupLayoutCount = groups.size();
    descriptor.bindGroupLayouts = groups.data();
    state.node_pipeline_layouts[slot] =
        wgpuDeviceCreatePipelineLayout(state.device, &descriptor);
    if (!state.node_pipeline_layouts[slot]) {
        dawn_error("node variant pipeline layout creation failed.");
    }
    return state.node_pipeline_layouts[slot];
}

/**
 * The render pipeline for one compiled node graph.
 *
 * The module is the pin's, entered at its own `vs_main`/`fs_main`. Its
 * vertex inputs are named rather than positional — the pipeline builder
 * numbers them by emission order, so a graph reading uv first puts uv at
 * location 0 — which is why each is resolved onto our vertex by name here
 * and an unmapped one fails naming itself.
 */
WGPURenderPipeline node_variant_pipeline(
    DawnState& state,
    std::size_t variant,
    upstream::RenderPipelineKind kind,
    std::uint32_t samples,
    bool has_depth,
    // The shadow target's own depth state, taken by every family: a node
    // material casts through its own ESM view exactly as the Standard
    // family does.
    bool shadow_pass = false,
    // Which of the graph's two compiled views this draws, and -- when it is
    // the caster -- which ESM generator's map it writes, whose recorded row
    // is the colour format.
    bool caster = false,
    std::uint32_t esm_shadow_index = invalid_handle,
    // The geometry-output task an MRT view draws in, with the composed view
    // it resolved. A geometry module is composed for exactly ONE task, so
    // the slot-keyed cache stays valid with that task's targets baked in.
    [[maybe_unused]] const FrameTaskRecord* geometry_task = nullptr,
    std::size_t geometry_variant = pal::no_node_geometry_variant) {
    const bool geometry_view =
        geometry_variant != pal::no_node_geometry_variant;
    const std::size_t slot =
        pal::node_draw_slot(variant, caster, geometry_variant);
    const std::size_t key = pal::variant_pipeline_key(
        pal::esm_keyed_variant(
            slot,
            pal::node_variant_slots(),
            esm_shadow_index),
        kind,
        {shadow_pass, has_depth});
    auto& map = state.node_variant_pipelines[samples];
    const auto existing = map.find(key);
    if (existing != map.end()) return existing->second;
    if (state.node_vertex_modules.size() < pal::node_variant_slots()) {
        state.node_vertex_modules.resize(pal::node_variant_slots(), nullptr);
        state.node_fragment_modules.resize(
            pal::node_variant_slots(),
            nullptr);
    }
    // The compiled view this slot draws: the graph's own row for a colour
    // or caster slot, the geometry emit's row for a geometry one.
    const upstream::NodeVariantEntry& view = pal::node_slot_view(slot);
    if (!state.node_vertex_modules[slot]) {
        const upstream::NodeVariantStems stems =
            pal::node_variant_stems(slot);
        // Both entry points live in one composed module, deployed once
        // under the fragment stem -- the vertex stem is an `alsoStages`
        // declaration carrying only compiled artifacts -- so the vertex
        // handle loads the fragment stem's file too. Two handles stay:
        // the teardown's `release_variant_family` releases one per table.
        const std::string module_file(stems.fragment);
        state.node_vertex_modules[slot] =
            load_wgsl_module(state, module_file);
        state.node_fragment_modules[slot] =
            load_wgsl_module(state, module_file);
    }
    VariantVertexAttributes inputs;
    // A node graph declaring the thin-instance columns would need a second
    // stream this pipeline does not bind, so the shared table's own marking
    // is what refuses it.
    inputs.vertex.reserve(view.attribute_count);
    for (std::size_t index = 0; index < view.attribute_count; ++index) {
        const upstream::NodeVariantAttribute& input =
            upstream::node_variant_attributes[view.first_attribute + index];
        if (
            !append_variant_attribute(
                input.name,
                input.location,
                node_uses_local_attributes(geometry_variant),
                inputs,
                node_uses_local_attributes(geometry_variant))) {
            dawn_error(
                (std::string("node variant declares an unmapped vertex ") +
                 "input '" + std::string(input.name) + "'.")
                    .c_str());
        }
        if (
            !inputs.instance_matrix.empty() ||
            !inputs.instance_color.empty()) {
            dawn_error(
                (std::string("node variant declares the per-instance ") +
                 "vertex input '" + std::string(input.name) +
                 "', which its pipeline binds no stream for.")
                    .c_str());
        }
    }
    WGPUVertexBufferLayout vertex_layout{};
    vertex_layout.stepMode = WGPUVertexStepMode_Vertex;
    vertex_layout.arrayStride = sizeof(GpuVertex);
    vertex_layout.attributeCount = inputs.vertex.size();
    vertex_layout.attributes = inputs.vertex.data();
    WGPURenderPipelineDescriptor descriptor =
        WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    descriptor.layout =
        node_pipeline_layout_for(state, variant, caster, geometry_variant);
    descriptor.vertex.module = state.node_vertex_modules[slot];
    descriptor.vertex.entryPoint = string_view("vs_main");
    descriptor.vertex.bufferCount = 1;
    descriptor.vertex.buffers = &vertex_layout;
    descriptor.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    descriptor.primitive.frontFace = WGPUFrontFace_CCW;
    const RenderPipelineKindTraits traits = pipeline_kind_traits(kind);
    // A geometry view is compiled at the pin's alpha mode 0 whatever the
    // graph's own blending says (`ensureGeometryCompile` passes it), so its
    // pipeline neither blends nor drops depth writes.
    const bool transparent =
        traits.transparent && !shadow_pass && !caster && !geometry_view;
    // The graph's culling and alpha-combine state, decoded through the same
    // shared kind table as the other families. Shadow views force the pin's
    // alpha mode 0 and therefore keep depth writes and no colour blending,
    // and so does the geometry view -- but its culling is still the graph's
    // own `backFaceCulling`, which is the fact the plan's node kinds are
    // bucketed by, so all three views read the one table.
    descriptor.primitive.cullMode = dawn_cull_mode(traits.cull);
    WGPUDepthStencilState depth_stencil = WGPU_DEPTH_STENCIL_STATE_INIT;
    apply_pass_depth_state(depth_stencil, shadow_pass);
    depth_stencil.depthWriteEnabled = transparent
        ? WGPUOptionalBool_False
        : WGPUOptionalBool_True;
    descriptor.depthStencil = has_depth ? &depth_stencil : nullptr;
    descriptor.multisample.count = samples;
    descriptor.multisample.mask = ~0u;
    WGPUColorTargetState color_target = WGPU_COLOR_TARGET_STATE_INIT;
    color_target.format = state.frame_color_format;
#if BBLITE_SHADOWS_ESM
    // The caster writes ONE generator's map, so the format is that
    // generator's own recorded row rather than the frame's.
    if (caster && esm_shadow_index != invalid_handle) {
        color_target.format = esm_texture_format(
            upstream::esm_shadow_resources[esm_shadow_index].textures[0]
                .format);
    }
#endif
    WGPUBlendState blend{};
    if (transparent) {
        blend = blend_state_from(transparent_blend);
        color_target.blend = &blend;
    }
    WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
    fragment.module = state.node_fragment_modules[slot];
    fragment.entryPoint = string_view("fs_main");
    const bool pcf_caster = caster && !view.caster.esm;
    fragment.targetCount = pcf_caster ? 0 : 1;
    fragment.targets = pcf_caster ? nullptr : &color_target;
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
    // The task's own attachments, through the builder the two material
    // families' MRT arms take. No blend and no trailing output: a geometry
    // view is compiled at the pin's alpha mode 0 and
    // `createNodeGeometryMaterialView` refuses `emitColor`.
    std::vector<WGPUColorTargetState> geometry_targets;
    if (geometry_view) {
        apply_geometry_color_targets(
            fragment,
            depth_stencil,
            geometry_targets,
            state,
            *geometry_task,
            upstream::node_geometry_variants[geometry_variant]
                .color_target_count,
            "node",
            nullptr);
    }
#endif
    descriptor.fragment = &fragment;
    WGPURenderPipeline pipeline =
        wgpuDeviceCreateRenderPipeline(state.device, &descriptor);
    if (!pipeline) dawn_error("node variant pipeline creation failed.");
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
    if (state.node_capture.capture.enabled()) {
        NodeGpuPipelineCapture receipt;
        receipt.id = state.node_capture.allocate(pipeline, "node-pipeline");
        receipt.variant = static_cast<std::uint32_t>(variant);
        receipt.geometry_variant = geometry_view ? static_cast<int>(geometry_variant) : -1;
        receipt.uses_local_attributes = node_uses_local_attributes(geometry_variant);
        receipt.color_target_count = static_cast<std::uint32_t>(fragment.targetCount);
        receipt.samples = descriptor.multisample.count;
        receipt.topology = descriptor.primitive.topology == WGPUPrimitiveTopology_TriangleList ? "triangle-list" : "unknown";
        receipt.cull_mode = descriptor.primitive.cullMode == WGPUCullMode_None ? "none"
            : descriptor.primitive.cullMode == WGPUCullMode_Back ? "back" : "front";
        receipt.front_face = descriptor.primitive.frontFace == WGPUFrontFace_CCW ? "ccw" : "cw";
        for (std::size_t i = 0; i < vertex_layout.attributeCount; ++i) {
            const auto& attribute = vertex_layout.attributes[i];
            const char* format = attribute.format == WGPUVertexFormat_Float32x2 ? "float32x2"
                : attribute.format == WGPUVertexFormat_Float32x3 ? "float32x3"
                : attribute.format == WGPUVertexFormat_Float32x4 ? "float32x4" : "unknown";
            receipt.attributes.push_back({std::string(upstream::node_variant_attributes[view.first_attribute + i].name),
                format, attribute.shaderLocation, 0, static_cast<std::size_t>(attribute.offset),
                static_cast<std::size_t>(vertex_layout.arrayStride)});
        }
        state.node_capture.capture.pipeline(std::move(receipt));
    }
#endif
    return map.emplace(key, pipeline).first->second;
}

/** The per-draw buffers one compiled node view needs, created once. */
void fill_node_draw_buffers(
    DawnState& state,
    DawnDrawState& draw_state,
    const upstream::NodeVariantEntry& view) {
    const auto uniform_buffer = [&](std::uint64_t size) {
        WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
        descriptor.size = size;
        descriptor.usage =
            WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
        DawnBuffer buffer{wgpuDeviceCreateBuffer(state.device, &descriptor)};
        if (!buffer) dawn_error("node uniform buffer creation failed.");
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
        state.node_capture.allocate(buffer, "node-uniform", static_cast<std::size_t>(descriptor.size));
#endif
        return buffer.release();
    };
    if (!draw_state.mesh_uniforms) {
        draw_state.mesh_uniforms =
            uniform_buffer(sizeof(upstream::NodeMeshUniforms));
    }
    if (!draw_state.material_uniforms && upstream::has_node_ubo(view)) {
        draw_state.material_uniforms =
            uniform_buffer(static_cast<std::uint64_t>(view.ubo_bytes));
        // The constants the graph declared, written with the buffer that
        // holds them: nothing a reached scene does changes them.
        wgpuQueueWriteBuffer(
            state.queue,
            draw_state.material_uniforms,
            0,
            &upstream::node_variant_uniform_floats[
                view.first_uniform_float],
            view.ubo_bytes);
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
        state.node_capture.write(draw_state.material_uniforms,
            &upstream::node_variant_uniform_floats[view.first_uniform_float], view.ubo_bytes);
#endif
    }
}

/** The per-draw buffers a node graph's colour or caster view needs. */
DawnDrawState& ensure_node_draw_buffers(
    DawnState& state,
    DawnMesh& mesh,
    std::uint32_t material,
    const upstream::NodeVariantEntry& entry) {
    DawnDrawState& draw_state = mesh.node_states.try_emplace(material, state).first->second;
    fill_node_draw_buffers(state, draw_state, entry);
    return draw_state;
}

#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
/**
 * The same, for one geometry view.
 *
 * Keyed by the composed view rather than by the material: the view walked
 * the graph again and its uniform block is its own, so it can share neither
 * the colour state's buffers nor its bind group.
 */
DawnDrawState& ensure_node_geometry_draw_buffers(
    DawnState& state,
    DawnMesh& mesh,
    std::size_t geometry_variant) {
    DawnDrawState& draw_state = mesh.node_geometry_states
        .try_emplace(geometry_variant, state).first->second;
    fill_node_draw_buffers(
        state,
        draw_state,
        upstream::node_variants[
            upstream::node_geometry_entry(geometry_variant)]);
    return draw_state;
}
#endif

WGPUBindGroup build_node_draw_group(
    DawnState& state,
    [[maybe_unused]] const Scene& scene,
    [[maybe_unused]] const Engine& engine,
    DawnMesh& mesh,
    const DawnDrawState& draw_state,
    std::size_t variant,
    // Which of the graph's two compiled views, and the material that says
    // so -- an ESM caster view carries both the bit and its generator.
    bool caster = false,
    [[maybe_unused]] const MaterialRecord* material = nullptr,
    // The composed geometry view this draw is, when it is one; the task's
    // gpUniforms comes with it because only the encode knows which task.
    std::size_t geometry_variant = pal::no_node_geometry_variant,
    [[maybe_unused]] WGPUBuffer geometry_params = nullptr) {
    [[maybe_unused]] const bool geometry_view =
        geometry_variant != pal::no_node_geometry_variant;
    const std::size_t slot =
        pal::node_draw_slot(variant, caster, geometry_variant);
    // The compiled view this slot draws: the graph's own row for a colour
    // or caster slot, the geometry emit's row for a geometry one.
    const upstream::NodeVariantEntry& view = pal::node_slot_view(slot);
    std::vector<WGPUBindGroupEntry> entries;
    WGPUBindGroupEntry mesh_entry = WGPU_BIND_GROUP_ENTRY_INIT;
    mesh_entry.binding = 0;
    mesh_entry.buffer = draw_state.mesh_uniforms;
    mesh_entry.size = sizeof(upstream::NodeMeshUniforms);
    entries.push_back(mesh_entry);
    if (upstream::has_node_ubo(view)) {
        WGPUBindGroupEntry node_entry = WGPU_BIND_GROUP_ENTRY_INIT;
        node_entry.binding =
            static_cast<std::uint32_t>(view.ubo_binding);
        node_entry.buffer = draw_state.material_uniforms;
        node_entry.size = static_cast<std::uint64_t>(view.ubo_bytes);
        entries.push_back(node_entry);
    }
    // The images the scene supplied, uploaded with the mesh: the variant
    // table's order is the pin's allocation order, and the material's slots
    // were filled in that same order by `create_node_material`.
    const auto& shader_textures = mesh_shader_textures(mesh);
    for (std::size_t index = 0; index < view.texture_count; ++index) {
        const upstream::NodeVariantTexture& binding =
            upstream::node_variant_textures[view.first_texture + index];
        if (index >= shader_textures.size()) {
            dawn_error(
                "a node graph declares more textures than its material "
                "carries.");
        }
        const DawnSampledTexture& supplied = shader_textures[index];
        WGPUBindGroupEntry texture = WGPU_BIND_GROUP_ENTRY_INIT;
        texture.binding = binding.texture;
        texture.textureView = supplied.view;
        entries.push_back(texture);
        WGPUBindGroupEntry sampler = WGPU_BIND_GROUP_ENTRY_INIT;
        sampler.binding = binding.sampler;
        sampler.sampler = supplied.sampler;
        entries.push_back(sampler);
    }
    if (view.morph.present) {
#if BBLITE_GPU_MORPH_STORAGE
        WGPUBindGroupEntry deltas = WGPU_BIND_GROUP_ENTRY_INIT;
        deltas.binding = view.morph.deltas_binding;
        deltas.buffer = mesh.morph_deltas;
        deltas.size = WGPU_WHOLE_SIZE;
        entries.push_back(deltas);
        WGPUBindGroupEntry weights = WGPU_BIND_GROUP_ENTRY_INIT;
        weights.binding = view.morph.weights_binding;
        weights.buffer = mesh.morph_weights;
        weights.size = WGPU_WHOLE_SIZE;
        entries.push_back(weights);
#else
        dawn_error(
            "a node graph declares morph storage in a build without "
            "mesh morph buffers.");
#endif
    }
    if (view.env.present) {
        // `pushEnvBindGroupEntries` binds the scene's own EnvironmentTextures,
        // which is what the material families already sample here.
        if (!state.environment_cube_view || !state.brdf_view) {
            dawn_error(
                "a node graph reaches the environment in a scene that "
                "loaded none.");
        }
        // Which of our resources each role names is the slot table's
        // answer, the same one `pinned_resource_for` gives the other
        // families -- the graph's names join it by source.
        const auto pair = [&](
                              std::uint32_t texture_binding,
                              std::uint32_t sampler_binding,
                              upstream::MaterialTextureSource source) {
            const PinnedResource resource =
                state_resource_for(state, source);
            WGPUBindGroupEntry texture = WGPU_BIND_GROUP_ENTRY_INIT;
            texture.binding = texture_binding;
            texture.textureView = resource.view;
            entries.push_back(texture);
            WGPUBindGroupEntry item = WGPU_BIND_GROUP_ENTRY_INIT;
            item.binding = sampler_binding;
            item.sampler = resource.sampler;
            entries.push_back(item);
        };
        pair(
            view.env.ibl_texture,
            view.env.ibl_sampler,
            upstream::MaterialTextureSource::environment_cube);
        pair(
            view.env.brdf_lut,
            view.env.brdf_sampler,
            upstream::MaterialTextureSource::brdf_lut);
    }
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
    // The task's gpUniforms, the one binding no colour view declares. The
    // arms above fall out on their own: a geometry view's row states its
    // morph, environment, caster and receiver arms absent, because the pin
    // refuses a geometry emit reaching any of them.
    if (geometry_view) {
        const upstream::NodeGeometryVariantEntry& geometry =
            upstream::node_geometry_variants[geometry_variant];
        if (geometry.geometry_params_binding != upstream::node_no_ubo) {
            if (!geometry_params) {
                dawn_error(
                    "a node geometry view declares NmeGeomParams but its "
                    "task built no gpUniforms buffer.");
            }
            WGPUBindGroupEntry params = WGPU_BIND_GROUP_ENTRY_INIT;
            params.binding = static_cast<std::uint32_t>(
                geometry.geometry_params_binding);
            params.buffer = geometry_params;
            params.size = sizeof(PinnedGeometryParams);
            entries.push_back(params);
        }
    }
#endif
#if BBLITE_NODE_SHADOWS
    if (caster) {
#if BBLITE_SHADOWS_ESM
        if (view.caster.esm) {
            // PCF's NODE_NO_COLOR_OUTPUT module adds no caster-only row.
            WGPUBindGroupEntry params = WGPU_BIND_GROUP_ENTRY_INIT;
            params.binding = view.caster.params_binding;
            params.buffer = esm_caster_params_buffer(state, material);
            if (!params.buffer) {
                dawn_error(
                    "a node caster draw reached the encode before its "
                    "generator's shadow params.");
            }
            params.size = upstream::shadow_params_block_bytes;
            entries.push_back(params);
        }
#endif
    } else if (view.shadow_binding_count > 0) {
        // The receiver's rows, in the GRAPH's own group 1 -- whether a
        // given mesh receives is the `meshU.receivesShadow` lane, not a
        // selection, so every draw of this graph binds them.
        ensure_shadow_samplers(state);
        const std::vector<ShadowGeneratorHandle> generators =
            shadow_generators_in_light_order(scene, engine);
        for (const upstream::PinnedShadowBinding& row :
             pal::node_shadow_rows(view)) {
            entries.push_back(
                shadow_group_entry(state, engine, generators, row));
        }
    }
#endif
    WGPUBindGroupDescriptor descriptor = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    descriptor.layout =
        node_draw_layout_for(state, variant, caster, geometry_variant);
    descriptor.entryCount = entries.size();
    descriptor.entries = entries.data();
    DawnBindGroup group{wgpuDeviceCreateBindGroup(state.device, &descriptor)};
    if (!group) dawn_error("node variant bind group creation failed.");
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
    if (state.node_capture.capture.enabled()) {
        state.node_capture.allocate(group, "node-bind-group");
        auto& captured = state.node_capture.groups[group];
        captured.clear();
        for (const auto& binding : entries) {
            NodeGpuBindingCapture receipt;
            receipt.binding = binding.binding;
            if (binding.buffer) {
                receipt.role = binding.binding == 0 ? "meshU" : "buffer";
                receipt.resource = state.node_capture.identity(binding.buffer, "bound-buffer");
            } else if (binding.sampler) {
                receipt.role = "sampler";
                receipt.resource = state.node_capture.identity(binding.sampler, "bound-sampler");
            } else if (binding.textureView) {
                receipt.role = "texture";
                receipt.view = state.node_capture.identity(binding.textureView, "bound-texture-view");
                for (const auto& supplied : shader_textures) {
                    if (supplied.view == binding.textureView) {
                        receipt.resource = state.node_capture.identity(supplied.texture, "bound-texture");
                        break;
                    }
                }
            }
            captured.push_back(std::move(receipt));
        }
    }
#endif
    return group.release();
}

// The draw wrapper observes the same arguments passed to the shared encoder.
// It never reselects the variant, attributes, buffers, or per-view group.
void encode_node_variant_draw(
    [[maybe_unused]] DawnState& state,
    [[maybe_unused]] const upstream::RenderDrawCommand& draw,
    WGPURenderPassEncoder pass, WGPURenderPipeline pipeline,
    WGPURenderPipeline& bound_pipeline, WGPUBindGroup frame_group,
    WGPUBindGroup draw_group, WGPUBuffer vertex_buffer,
    InstanceStreams instances, WGPUBuffer index_buffer, std::uint32_t index_count) {
    encode_variant_draw(pass, pipeline, bound_pipeline, frame_group, draw_group,
        vertex_buffer, instances, index_buffer, index_count);
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
    if (state.node_capture.capture.enabled()) {
        NodeGpuDrawCapture receipt;
        receipt.pipeline = state.node_capture.identity(pipeline, "node-pipeline");
        receipt.group = state.node_capture.identity(draw_group, "node-bind-group");
        receipt.mesh = draw.item.mesh.value;
        receipt.material = draw.item.material.value;
        receipt.vertices = state.node_capture.identity(vertex_buffer, "node-vertices");
        receipt.indices = state.node_capture.identity(index_buffer, "node-indices");
        receipt.index_count = index_count;
        receipt.instance_count = instances.count;
        receipt.bindings = state.node_capture.groups.at(draw_group);
        for (const auto& binding : receipt.bindings) {
            if (binding.role == "meshU") receipt.mesh_uniform = binding.resource;
        }
        state.node_capture.capture.draw(std::move(receipt));
    }
#endif
}

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
    struct Mode {
        std::vector<upstream::NodeMeshUniforms> blocks;
        std::vector<std::uint8_t> composed;
    };
    std::array<Mode, 2> modes;
};

const upstream::NodeMeshUniforms& node_mesh_block_for(
    NodeMeshBlockCache& cache,
    const Scene& scene,
    const Engine& engine,
    std::uint32_t mesh_index,
    bool uses_local_attributes = false) {
    if (cache.scene != &scene) {
        cache.scene = &scene;
        for (auto& mode : cache.modes) {
            std::fill(mode.composed.begin(), mode.composed.end(), std::uint8_t{0});
        }
    }
    auto& mode = cache.modes[uses_local_attributes ? 1u : 0u];
    if (mode.composed.size() <= mesh_index) {
        mode.blocks.resize(mesh_index + 1u);
        mode.composed.resize(mesh_index + 1u, 0u);
    }
    if (!mode.composed[mesh_index]) {
        mode.blocks[mesh_index] =
            node_mesh_block(scene, engine, mesh_index, uses_local_attributes);
        mode.composed[mesh_index] = 1u;
    }
    return mode.blocks[mesh_index];
}

/**
 * The one block a node draw rebuilds: the pin's own `MeshU`, carrying the
 * world matrix the vertex stage multiplies by and the shadow and light lanes
 * a graph reaching neither leaves at zero. The uniform block the graph
 * declared is a constant, so `ensure_node_draw_buffers` writes it once.
 */
void write_node_mesh_block(
    DawnState& state,
    const upstream::NodeMeshUniforms& block,
    const DawnDrawState& draw_state) {
    wgpuQueueWriteBuffer(
        state.queue,
        draw_state.mesh_uniforms,
        0,
        &block,
        sizeof(block));
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
    state.node_capture.write(draw_state.mesh_uniforms, &block, sizeof(block));
#endif
}

#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
/**
 * The node family's sibling of `write_pinned_geometry_task`.
 *
 * Every node draw in a geometry task's lists resolves the view composed for
 * THIS task, writes its own mesh block, and builds a per-view group carrying
 * the task's gpUniforms. Keyed per view by construction, so the per-view map
 * cannot mix two tasks' groups.
 */
void write_node_geometry_task(
    DawnState& state,
    NodeMeshBlockCache& mesh_blocks,
    const Scene& scene,
    const Engine& engine,
    const FrameTaskRecord& task,
    DawnGeometryTask& geometry,
    const upstream::RenderDrawLists& draw_lists) {
    for (const auto* list : {&draw_lists.opaque, &draw_lists.transparent}) {
        for (const upstream::RenderDrawCommand& draw : list->commands) {
            if (
                draw.item.material_kind !=
                upstream::RenderMaterialKind::node) {
                continue;
            }
            if (draw.item_index >= state.meshes.size()) continue;
            const std::size_t geometry_variant =
                pal::require_node_geometry_variant(
                    draw.item.shader_variant,
                    static_cast<std::size_t>(task.geometry.shader_index));
            DawnMesh& mesh = state.meshes[draw.item_index];
            DawnDrawState& draw_state = ensure_node_geometry_draw_buffers(
                state,
                mesh,
                geometry_variant);
            write_node_mesh_block(
                state,
                node_mesh_block_for(
                    mesh_blocks,
                    scene,
                    engine,
                    draw.item.mesh.value,
                    node_uses_local_attributes(geometry_variant)),
                draw_state);
            if (!draw_state.group) {
                draw_state.group = build_node_draw_group(
                    state,
                    scene,
                    engine,
                    mesh,
                    draw_state,
                    draw.item.shader_variant,
                    false,
                    nullptr,
                    geometry_variant,
                    geometry.pinned_geometry_params);
            }
        }
    }
}
#endif
#endif


// Depth-only pipelines mirror SDL: the scene vertex module with the
// empty depth-only fragment, depth writes on, no color targets.
WGPURenderPipeline depth_only_pipeline_for(
    DawnState& state,
    bool double_sided,
    std::uint32_t samples) {
    WGPURenderPipeline& slot =
        state.depth_only_pipelines[double_sided ? 1 : 0]
                                  [samples == state.sample_count ? 1
                                                                 : 0];
    if (slot) return slot;
    if (!state.depth_only_module) {
        state.depth_only_module =
            load_wgsl_module(state, "depth-only.frag");
    }
    std::array<WGPUVertexAttribute, base_vertex_attribute_count>
        attributes{};
    fill_base_vertex_attributes(attributes.data());
    WGPUVertexBufferLayout vertex_layout{};
    vertex_layout.stepMode = WGPUVertexStepMode_Vertex;
    vertex_layout.arrayStride = sizeof(GpuVertex);
    vertex_layout.attributeCount = attributes.size();
    vertex_layout.attributes = attributes.data();
    WGPURenderPipelineDescriptor descriptor =
        WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    descriptor.vertex.module = state.vertex_module;
    descriptor.vertex.entryPoint = string_view("mainVertex");
    descriptor.vertex.bufferCount = 1;
    descriptor.vertex.buffers = &vertex_layout;
    descriptor.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    descriptor.primitive.frontFace = WGPUFrontFace_CCW;
    descriptor.primitive.cullMode =
        double_sided ? WGPUCullMode_None : WGPUCullMode_Back;
    WGPUDepthStencilState depth_stencil = WGPU_DEPTH_STENCIL_STATE_INIT;
    depth_stencil.format = WGPUTextureFormat_Depth24PlusStencil8;
    depth_stencil.depthWriteEnabled = WGPUOptionalBool_True;
    depth_stencil.depthCompare =
        dawn_depth_compare(upstream::pinned_depth_compare);
    descriptor.depthStencil = &depth_stencil;
    descriptor.multisample.count = samples;
    descriptor.multisample.mask = ~0u;
    WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
    fragment.module = state.depth_only_module;
    fragment.entryPoint = string_view("mainFragment");
    fragment.targetCount = 0;
    descriptor.fragment = &fragment;
    slot = wgpuDeviceCreateRenderPipeline(state.device, &descriptor);
    if (!slot) dawn_error("depth-only pipeline creation failed.");
    return slot;
}

// Geometry MRT pipelines mirror SDL: the per-task generated fragment
// modules over the shared vertex module, one color target per
// attachment plus the optional output target, LESS depth (writes off
// for the transparent variants, which also blend on every target).

// The pinned transmission scene-color grab
// (frame-graph/transmission.ts BLIT_MSAA_SHADER: per-texel sample
// average with manual bilinear filtering, read straight from the
// multisampled attachment) and the pinned per-sample image processing
// (frame-graph/image-processing-task.ts: exposure, optional tonemap,
// gamma, contrast applied per MSAA sample, then averaged) are deployed
// from generation like every other pinned shader instead of living here
// as C++ strings invisible to shader provenance. Under `BBLITE_MSAA=1`
// there is one sample and nothing to average, so each pass loads its
// `-single` sibling: an ordinary texture binding and a plain load around
// the same pinned text.

// Encodes the pinned mid-pass scene-color grab: the fullscreen
// sample-averaging blit into transmission mip 0 followed by the
// standard blit mip chain.
void encode_transmission_grab(
    DawnState& state,
    WGPUCommandEncoder encoder) {
    if (!state.transmission_grab_pipeline) {
        state.transmission_grab_vertex_module =
            load_wgsl_module(state, "transmission-grab.vert");
        state.transmission_grab_fragment_module = load_wgsl_module(
            state,
            state.multisampled()
                ? "transmission-grab.frag"
                : "transmission-grab-single.frag");
        WGPURenderPipelineDescriptor descriptor =
            WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
        descriptor.vertex.module =
            state.transmission_grab_vertex_module;
        descriptor.vertex.entryPoint = string_view("mainVertex");
        descriptor.primitive.topology =
            WGPUPrimitiveTopology_TriangleList;
        WGPUColorTargetState color_target =
            WGPU_COLOR_TARGET_STATE_INIT;
        color_target.format = WGPUTextureFormat_RGBA16Float;
        WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
        fragment.module = state.transmission_grab_fragment_module;
        fragment.entryPoint = string_view("mainFragment");
        fragment.targetCount = 1;
        fragment.targets = &color_target;
        descriptor.fragment = &fragment;
        state.transmission_grab_pipeline =
            wgpuDeviceCreateRenderPipeline(state.device, &descriptor);
        if (!state.transmission_grab_pipeline) {
            dawn_error("transmission grab pipeline creation failed.");
        }
    }
    DawnBindGroupLayout layout{wgpuRenderPipelineGetBindGroupLayout(
        state.transmission_grab_pipeline,
        0)};
    WGPUBindGroupEntry entry = WGPU_BIND_GROUP_ENTRY_INIT;
    entry.binding = 0;
    entry.textureView = state.msaa_color_view;
    WGPUBindGroupDescriptor bind_descriptor =
        WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    bind_descriptor.layout = layout;
    bind_descriptor.entryCount = 1;
    bind_descriptor.entries = &entry;
    DawnBindGroup bind_group{wgpuDeviceCreateBindGroup(state.device, &bind_descriptor)};
    layout.reset();
    WGPUTextureViewDescriptor level_descriptor =
        WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
    level_descriptor.baseMipLevel = 0;
    level_descriptor.mipLevelCount = 1;
    DawnTextureView level_view{create_dawn_texture_view(
        state.transmission_color,
        &level_descriptor)};
    WGPURenderPassColorAttachment color_attachment =
        WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
    color_attachment.view = level_view;
    color_attachment.loadOp = WGPULoadOp_Clear;
    color_attachment.storeOp = WGPUStoreOp_Store;
    WGPURenderPassDescriptor pass_descriptor =
        WGPU_RENDER_PASS_DESCRIPTOR_INIT;
    pass_descriptor.colorAttachmentCount = 1;
    pass_descriptor.colorAttachments = &color_attachment;
    DawnRenderPass pass{wgpuCommandEncoderBeginRenderPass(encoder, &pass_descriptor)};
    wgpuRenderPassEncoderSetPipeline(
        pass,
        state.transmission_grab_pipeline);
    wgpuRenderPassEncoderSetBindGroup(pass, 0, bind_group, 0, nullptr);
    count_gpu_draw(wgpuRenderPassEncoderDraw, pass, 3, 1, 0, 0);
    wgpuRenderPassEncoderEnd(pass);
    pass.reset();
    bind_group.reset();
    level_view.reset();
    record_mipmaps(
        state,
        encoder,
        state.transmission_color,
        WGPUTextureFormat_RGBA16Float,
        state.transmission_mip_count);
}

// The pinned final pass: per-sample image processing of the linear
// multisampled frame straight into the surface (the payoff SDL_GPU
// could not express — it had to process the resolved pixel once).
void encode_image_processing(
    DawnState& state,
    WGPUCommandEncoder encoder,
    WGPUTextureView surface_view,
    const Scene& scene) {
    if (!state.image_processing_pipeline) {
        state.image_processing_vertex_module =
            load_wgsl_module(state, "image-processing-samples.vert");
        state.image_processing_fragment_module = load_wgsl_module(
            state,
            state.multisampled()
                ? "image-processing-samples.frag"
                : "image-processing-samples-single.frag");
        WGPURenderPipelineDescriptor descriptor =
            WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
        descriptor.vertex.module = state.image_processing_vertex_module;
        descriptor.vertex.entryPoint = string_view("mainVertex");
        descriptor.primitive.topology =
            WGPUPrimitiveTopology_TriangleList;
        WGPUColorTargetState color_target =
            WGPU_COLOR_TARGET_STATE_INIT;
        color_target.format = state.surface_format;
        WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
        fragment.module = state.image_processing_fragment_module;
        fragment.entryPoint = string_view("mainFragment");
        fragment.targetCount = 1;
        fragment.targets = &color_target;
        descriptor.fragment = &fragment;
        state.image_processing_pipeline =
            wgpuDeviceCreateRenderPipeline(state.device, &descriptor);
        if (!state.image_processing_pipeline) {
            dawn_error("image processing pipeline creation failed.");
        }
        state.image_processing_params = create_buffer(
            state,
            WGPUBufferUsage_Uniform,
            nullptr,
            16);
    }
    if (!state.image_processing_group) {
        DawnBindGroupLayout layout{wgpuRenderPipelineGetBindGroupLayout(
                state.image_processing_pipeline,
                0)};
        std::array<WGPUBindGroupEntry, 2> entries{};
        entries[0] = WGPU_BIND_GROUP_ENTRY_INIT;
        entries[0].binding = 0;
        entries[0].buffer = state.image_processing_params;
        entries[0].size = 16;
        entries[1] = WGPU_BIND_GROUP_ENTRY_INIT;
        entries[1].binding = 1;
        entries[1].textureView = state.msaa_color_view;
        WGPUBindGroupDescriptor bind_descriptor =
            WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        bind_descriptor.layout = layout;
        bind_descriptor.entryCount = entries.size();
        bind_descriptor.entries = entries.data();
        state.image_processing_group =
            wgpuDeviceCreateBindGroup(state.device, &bind_descriptor);
        layout.reset();
    }
    const std::array<float, 4> params{
        scene.environment.exposure,
        scene.environment.contrast,
        scene.environment.tone_mapping_enabled ? 1.0f : 0.0f,
        0.0f,
    };
    wgpuQueueWriteBuffer(
        state.queue,
        state.image_processing_params,
        0,
        params.data(),
        sizeof(params));
    WGPURenderPassColorAttachment color_attachment =
        WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
    color_attachment.view = surface_view;
    color_attachment.loadOp = WGPULoadOp_Clear;
    color_attachment.storeOp = WGPUStoreOp_Store;
    color_attachment.clearValue = WGPUColor{
        scene.clear_color.r,
        scene.clear_color.g,
        scene.clear_color.b,
        scene.clear_color.a,
    };
    WGPURenderPassDescriptor pass_descriptor =
        WGPU_RENDER_PASS_DESCRIPTOR_INIT;
    pass_descriptor.colorAttachmentCount = 1;
    pass_descriptor.colorAttachments = &color_attachment;
    DawnRenderPass pass{wgpuCommandEncoderBeginRenderPass(encoder, &pass_descriptor)};
    wgpuRenderPassEncoderSetPipeline(
        pass,
        state.image_processing_pipeline);
    wgpuRenderPassEncoderSetBindGroup(
        pass,
        0,
        state.image_processing_group,
        0,
        nullptr);
    count_gpu_draw(wgpuRenderPassEncoderDraw, pass, 3, 1, 0, 0);
    wgpuRenderPassEncoderEnd(pass);
    pass.reset();
}

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

void encode_depth_copy(
    DawnState& state,
    WGPUCommandEncoder encoder,
    const DawnRenderTarget& target) {
    if (!state.depth_copy_pipeline) {
        WGPUShaderSourceWGSL wgsl = WGPU_SHADER_SOURCE_WGSL_INIT;
        wgsl.code = string_view(depth_copy_wgsl);
        WGPUShaderModuleDescriptor module_descriptor{};
        module_descriptor.nextInChain = &wgsl.chain;
        module_descriptor.label = string_view("depth-copy");
        state.depth_copy_module = wgpuDeviceCreateShaderModule(
            state.device,
            &module_descriptor);
        WGPURenderPipelineDescriptor descriptor =
            WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
        descriptor.vertex.module = state.depth_copy_module;
        descriptor.vertex.entryPoint = string_view("vs");
        descriptor.primitive.topology =
            WGPUPrimitiveTopology_TriangleList;
        WGPUColorTargetState color_target =
            WGPU_COLOR_TARGET_STATE_INIT;
        color_target.format = WGPUTextureFormat_R32Float;
        WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
        fragment.module = state.depth_copy_module;
        fragment.entryPoint = string_view("fs");
        fragment.targetCount = 1;
        fragment.targets = &color_target;
        descriptor.fragment = &fragment;
        state.depth_copy_pipeline = wgpuDeviceCreateRenderPipeline(
            state.device,
            &descriptor);
        if (!state.depth_copy_pipeline) {
            dawn_error("depth copy pipeline creation failed.");
        }
    }
    DawnBindGroupLayout layout{wgpuRenderPipelineGetBindGroupLayout(
        state.depth_copy_pipeline,
        0)};
    WGPUBindGroupEntry entry = WGPU_BIND_GROUP_ENTRY_INIT;
    entry.binding = 0;
    entry.textureView = target.depth_sampled_view;
    WGPUBindGroupDescriptor bind_descriptor =
        WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    bind_descriptor.layout = layout;
    bind_descriptor.entryCount = 1;
    bind_descriptor.entries = &entry;
    DawnBindGroup bind_group{wgpuDeviceCreateBindGroup(state.device, &bind_descriptor)};
    layout.reset();
    WGPURenderPassColorAttachment color_attachment =
        WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
    color_attachment.view = target.depth_copy_view;
    color_attachment.loadOp = WGPULoadOp_Clear;
    color_attachment.storeOp = WGPUStoreOp_Store;
    WGPURenderPassDescriptor pass_descriptor =
        WGPU_RENDER_PASS_DESCRIPTOR_INIT;
    pass_descriptor.colorAttachmentCount = 1;
    pass_descriptor.colorAttachments = &color_attachment;
    DawnRenderPass pass{wgpuCommandEncoderBeginRenderPass(encoder, &pass_descriptor)};
    wgpuRenderPassEncoderSetPipeline(pass, state.depth_copy_pipeline);
    wgpuRenderPassEncoderSetBindGroup(pass, 0, bind_group, 0, nullptr);
    count_gpu_draw(wgpuRenderPassEncoderDraw, pass, 3, 1, 0, 0);
    wgpuRenderPassEncoderEnd(pass);
    pass.reset();
    bind_group.reset();
}

// Fullscreen-triangle copy used by frame-graph copy tasks.
WGPURenderPipeline blit_pipeline_for(
    DawnState& state,
    WGPUTextureFormat format,
    std::uint32_t samples) {
    const auto key = std::make_pair(format, samples);
    const auto existing = state.blit_pipelines.find(key);
    if (existing != state.blit_pipelines.end()) {
        return existing->second;
    }
    if (!state.blit_vertex_module) {
        state.blit_vertex_module = load_wgsl_module(state, "blit.vert");
        state.blit_fragment_module =
            load_wgsl_module(state, "blit.frag");
    }
    WGPURenderPipelineDescriptor descriptor =
        WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    descriptor.vertex.module = state.blit_vertex_module;
    descriptor.vertex.entryPoint = string_view("mainVertex");
    descriptor.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    descriptor.primitive.cullMode = WGPUCullMode_None;
    descriptor.multisample.count = samples;
    descriptor.multisample.mask = ~0u;
    WGPUColorTargetState color_target = WGPU_COLOR_TARGET_STATE_INIT;
    color_target.format = format;
    WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
    fragment.module = state.blit_fragment_module;
    fragment.entryPoint = string_view("mainFragment");
    fragment.targetCount = 1;
    fragment.targets = &color_target;
    descriptor.fragment = &fragment;
    DawnRenderPipeline pipeline{wgpuDeviceCreateRenderPipeline(state.device, &descriptor)};
    if (!pipeline) dawn_error("blit pipeline creation failed.");
    auto& slot = state.blit_pipelines[key];
    slot = pipeline.release();
    return slot;
}

WGPUBindGroup blit_group_for(DawnState& state, WGPURenderPipeline pipeline, WGPUTextureView source) {
    const auto layout = wgpuRenderPipelineGetBindGroupLayout(pipeline, 2);
    std::array<WGPUBindGroupEntry, 2> entries{};
    entries[0] = WGPU_BIND_GROUP_ENTRY_INIT;
    entries[0].binding = 0;
    entries[0].textureView = source;
    entries[1] = WGPU_BIND_GROUP_ENTRY_INIT;
    entries[1].binding = 1;
    entries[1].sampler = state.clamp_sampler;
    WGPUBindGroupDescriptor descriptor = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    descriptor.layout = layout;
    descriptor.entryCount = entries.size();
    descriptor.entries = entries.data();
    const auto group = wgpuDeviceCreateBindGroup(state.device, &descriptor);
    wgpuBindGroupLayoutRelease(layout);
    return group;
}

#if defined(BBLITE_HAS_TAA) && BBLITE_HAS_TAA
void retain_temporal_presentation(DawnState& state, WGPUCommandEncoder encoder,
    WGPUTexture surface, std::uint32_t width, std::uint32_t height) {
    if (!state.temporal_presented) {
        state.temporal_presented = create_frame_texture(state, state.surface_format, 1u, width, height,
            WGPUTextureUsage_CopyDst | WGPUTextureUsage_TextureBinding);
        state.temporal_presented_view = create_dawn_texture_view(state.temporal_presented, nullptr);
        state.temporal_presented_group = blit_group_for(state,
            blit_pipeline_for(state, state.surface_format, 1u), state.temporal_presented_view);
    }
    WGPUTexelCopyTextureInfo source{};
    source.texture = surface;
    WGPUTexelCopyTextureInfo target{};
    target.texture = state.temporal_presented;
    const WGPUExtent3D extent{width, height, 1u};
    wgpuCommandEncoderCopyTextureToTexture(encoder, &source, &target, &extent);
}

void present_stopped_temporal_frame(DawnState& state, WGPUCommandEncoder encoder, WGPUTextureView surface) {
    WGPURenderPassColorAttachment attachment = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
    attachment.view = surface;
    attachment.loadOp = WGPULoadOp_Clear;
    attachment.storeOp = WGPUStoreOp_Store;
    WGPURenderPassDescriptor descriptor = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
    descriptor.colorAttachmentCount = 1;
    descriptor.colorAttachments = &attachment;
    DawnRenderPass pass{wgpuCommandEncoderBeginRenderPass(encoder, &descriptor)};
    wgpuRenderPassEncoderSetPipeline(pass, blit_pipeline_for(state, state.surface_format, 1u));
    wgpuRenderPassEncoderSetBindGroup(pass, 2u, state.temporal_presented_group, 0u, nullptr);
    count_gpu_draw(wgpuRenderPassEncoderDraw, pass, 3u, 1u, 0u, 0u);
    wgpuRenderPassEncoderEnd(pass);
    pass.reset();
}
#endif

DawnMeshBindings& bindings_for(
    DawnState& state,
    DawnMesh& mesh,
    upstream::RenderPipelineKind kind,
    std::uint32_t shader_variant = 0) {
    const auto existing = mesh.bindings.find(kind);
    if (existing != mesh.bindings.end()) return existing->second;
    // The groups build from the explicit superset layout and the state's own
    // resources; the pipeline is the draw's business. The diagnostic passes
    // request PBR-kind groups for their own fragments, and creating the
    // retired transcribed PBR pipeline here was the only thing that still
    // asked for its fragment module.
    DawnMeshBindings bindings;

    const PipelineKindTraits binding_traits = pipeline_traits(kind);
    mesh_pipeline_layout_for(state);
    // The explicit superset layout requires every binding; kinds whose
    // shader ignores a slot still supply the mesh's resource (custom
    // vertex uniform blocks swap the scene matrix for the mesh's own
    // buffer, sized by the variant's reflected block).
    std::array<WGPUBindGroupEntry, 3> scene_entries{};
    std::uint32_t scene_entry_count = 0;
    scene_entries[scene_entry_count] = WGPU_BIND_GROUP_ENTRY_INIT;
    scene_entries[scene_entry_count].binding = 0;
    const upstream::ShaderVariantInfo* binding_shader_info =
        binding_traits.shader
            ? &upstream::shader_variant_info(shader_variant)
            : nullptr;
    if (
        binding_shader_info &&
        binding_shader_info->vertex.present &&
        !block_is_shared_scene_matrix(binding_shader_info->vertex)) {
        scene_entries[scene_entry_count].buffer =
            mesh.shader_vertex_uniforms;
        scene_entries[scene_entry_count].size =
            binding_shader_info->vertex.float_size * 4;
    } else {
        scene_entries[scene_entry_count].buffer = state.view_projection;
        scene_entries[scene_entry_count].size = 64;
    }
    ++scene_entry_count;
#if BBLITE_GPU_DEFORMATION
    scene_entries[scene_entry_count] = WGPU_BIND_GROUP_ENTRY_INIT;
    scene_entries[scene_entry_count].binding = 1;
    scene_entries[scene_entry_count].buffer =
        mesh.deformation_uniforms;
    scene_entries[scene_entry_count].size =
        sizeof(DeformationUniforms);
    ++scene_entry_count;
#endif
#if BBLITE_GPU_INSTANCING
    scene_entries[scene_entry_count] = WGPU_BIND_GROUP_ENTRY_INIT;
    scene_entries[scene_entry_count].binding =
        instance_uniform_binding;
    scene_entries[scene_entry_count].buffer = mesh.instance_uniform;
    scene_entries[scene_entry_count].size = 64;
    ++scene_entry_count;
#endif
    WGPUBindGroupDescriptor scene_descriptor =
        WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    scene_descriptor.layout = state.mesh_group_layouts[1];
    scene_descriptor.entryCount = scene_entry_count;
    scene_descriptor.entries = scene_entries.data();
    bindings.scene =
        require_dawn_resource(wgpuDeviceCreateBindGroup(state.device, &scene_descriptor), "mesh bind group");

#if BBLITE_GPU_MORPH_STORAGE
    {
        std::array<WGPUBindGroupEntry, 2> morph_entries{};
        morph_entries[0] = WGPU_BIND_GROUP_ENTRY_INIT;
        morph_entries[0].binding = 0;
        morph_entries[0].buffer = mesh.morph_deltas;
        morph_entries[0].size = WGPU_WHOLE_SIZE;
        morph_entries[1] = WGPU_BIND_GROUP_ENTRY_INIT;
        morph_entries[1].binding = 1;
        morph_entries[1].buffer = mesh.morph_weights;
        morph_entries[1].size = WGPU_WHOLE_SIZE;
        WGPUBindGroupDescriptor morph_descriptor =
            WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        morph_descriptor.layout = state.mesh_group_layouts[0];
        morph_descriptor.entryCount = morph_entries.size();
        morph_descriptor.entries = morph_entries.data();
        bindings.morph =
            require_dawn_resource(wgpuDeviceCreateBindGroup(state.device, &morph_descriptor), "mesh bind group");
    }
#endif

    // Fragment texture pairs mirror the SDL_GPU slot order. Standard:
    // base color, specular, opacity, ambient, reflection cube,
    // standard emissive. PBR: base color, metallic-roughness, normal,
    // emissive, environment cube, BRDF LUT.
    constexpr std::size_t max_texture_pairs =
        6 + transmission_texture_pairs + material_extension_slots +
        standard_bump_slots;
    std::array<WGPUTextureView, max_texture_pairs> views{
        mesh.views[0],
        mesh.views[1],
        mesh.views[2],
        mesh.views[3],
        binding_traits.standard
            ? (mesh.reflection ? mesh.reflection : state.black_cube_view)
            : state.environment_cube_view,
        // No render-texture arm here: a Standard draw in a build with a
        // composed variant table never reaches this superset layout (the
        // encode's own arm handles it, and the write phase errors when it
        // resolves none), and a build without one cannot reach the
        // features that write these slots.
        binding_traits.standard ? mesh.views[4] : state.brdf_view,
    };
    std::array<WGPUSampler, max_texture_pairs> samplers{
        mesh.samplers[0],
        mesh.samplers[1],
        mesh.samplers[2],
        mesh.samplers[3],
        state.default_sampler,
        binding_traits.standard ? mesh.samplers[4] : state.clamp_sampler,
    };
    // The transmission trio and material-extension pairs append after
    // the base six. The superset layout requires every pair for every
    // kind; shaders that ignore a slot never sample it. The
    // scene-color slot binds the grab texture through the pinned
    // repeat trilinear anisotropic sampler when transmission runs,
    // and the base color as an inert stand-in otherwise (exactly like
    // the SDL backend with transmission disabled at runtime).
    std::size_t pair = 6;
#if BBLITE_RENDERER_TRANSMISSION
    if (state.transmission_color_view) {
        views[pair] = state.transmission_color_view;
        samplers[pair] = state.transmission_sampler;
    } else {
        views[pair] = mesh.views[0];
        samplers[pair] = mesh.samplers[0];
    }
    ++pair;
    views[pair] = mesh.views[5];
    samplers[pair] = mesh.samplers[5];
    ++pair;
    views[pair] = mesh.views[6];
    samplers[pair] = mesh.samplers[6];
    ++pair;
#endif
    for (std::size_t slot = 0;
         slot < material_extension_slots;
         ++slot) {
        views[pair] = mesh.views[material_extension_slot_base + slot];
        samplers[pair] =
            mesh.samplers[material_extension_slot_base + slot];
        ++pair;
    }
#if BBLITE_MATERIAL_STANDARD_BUMP
    // Last pair, so the indexes above are exactly what they were before
    // this slot existed. A PBR material binds its flat-normal fallback
    // here and never samples it.
    views[pair] = mesh.views[standard_bump_slot];
    samplers[pair] = mesh.samplers[standard_bump_slot];
    ++pair;
#endif
    // A shader material's own textures replace the leading pairs: the
    // caller's fragment declares them from binding 0 up, and the superset
    // layout's own first pairs are the material-slot ones no custom WGSL
    // names.
    //
    // Declared order is binding order here, unlike the SDL backend: Dawn
    // compiles the `.native.wgsl` this port emitted, whose `@binding(2n)`
    // pairs ARE the declared indexes, so no compaction stands between the
    // record and the group.
    if (binding_traits.shader && binding_shader_info) {
        const auto& shader_textures =
            mesh_shader_textures(mesh);
        if (
            shader_textures.size() <
            binding_shader_info->samplers.size()) {
            dawn_error(shader_sampler_shortfall(
                *binding_shader_info,
                shader_textures.size()));
        }
        for (
            std::size_t slot = 0;
            slot < binding_shader_info->samplers.size();
            ++slot) {
            views[slot] = shader_textures[slot].view;
            samplers[slot] = shader_textures[slot].sampler;
        }
    }
    const std::uint32_t pair_count =
        static_cast<std::uint32_t>(pair);
    std::array<WGPUBindGroupEntry, max_texture_pairs * 2>
        texture_entries{};
    for (std::uint32_t slot = 0; slot < pair_count; ++slot) {
        texture_entries[slot * 2] = WGPU_BIND_GROUP_ENTRY_INIT;
        texture_entries[slot * 2].binding = slot * 2;
        texture_entries[slot * 2].textureView = views[slot];
        texture_entries[slot * 2 + 1] = WGPU_BIND_GROUP_ENTRY_INIT;
        texture_entries[slot * 2 + 1].binding = slot * 2 + 1;
        texture_entries[slot * 2 + 1].sampler = samplers[slot];
    }
    WGPUBindGroupDescriptor texture_descriptor =
        WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    texture_descriptor.layout = state.mesh_group_layouts[2];
    texture_descriptor.entryCount = pair_count * 2;
    texture_descriptor.entries = texture_entries.data();
    bindings.textures =
        require_dawn_resource(wgpuDeviceCreateBindGroup(state.device, &texture_descriptor), "mesh bind group");

    WGPUBindGroupEntry material_entry = WGPU_BIND_GROUP_ENTRY_INIT;
    material_entry.binding = 0;
    material_entry.buffer = mesh.material_uniforms;
    material_entry.size = mesh.material_uniform_size;
    WGPUBindGroupDescriptor material_descriptor =
        WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    material_descriptor.layout = state.mesh_group_layouts[3];
    material_descriptor.entryCount = 1;
    material_descriptor.entries = &material_entry;
    bindings.material =
        require_dawn_resource(wgpuDeviceCreateBindGroup(state.device, &material_descriptor), "mesh bind group");

    return mesh.bindings.emplace(kind, std::move(bindings)).first->second;
}

/** Build the four reflected groups for an active ShaderMaterial draw. */
DawnShaderBindings& shader_bindings_for(
    DawnState& state,
    [[maybe_unused]] const Scene& scene,
    const Engine& engine,
    DawnMesh& mesh,
    MaterialHandle material_handle,
    std::uint32_t variant,
    WGPUBuffer pass_uniforms) {
    if (material_handle.value >= engine.materials.size()) {
        dawn_error("Shader draw has an invalid material.");
    }
    const MaterialRecord& material = handle_at(engine.materials, material_handle);
    const upstream::ShaderVariantInfo& info =
        upstream::shader_variant_info(variant);
    const WGPUBuffer vertex_uniforms =
        info.vertex.present && block_is_shared_scene_matrix(info.vertex)
        ? pass_uniforms
        : mesh.shader_vertex_uniforms;
    const DawnShaderBindingKey key{
        variant,
        material_handle.value,
        vertex_uniforms,
    };
    const auto existing = mesh.shader_bindings.find(key);
    if (existing != mesh.shader_bindings.end()) return existing->second;

    shader_pipeline_layout_for(state, variant);
    const auto& layouts = state.shader_group_layouts[variant];
    DawnShaderBindings bindings;
    const auto storage_buffer = [&](std::size_t declared_slot) {
        if (declared_slot >= material.shader_storage_buffers.size()) {
            dawn_error(
                (std::string("Shader material storage binding count is "
                             "stale for '") +
                 info.name + "'.")
                    .c_str());
        }
        const StorageBufferHandle handle =
            material.shader_storage_buffers[declared_slot];
        if (
            handle.value >= state.shader_storage_buffers.size() ||
            !handle_at(state.shader_storage_buffers, handle).buffer) {
            dawn_error(
                (std::string("Shader material storage buffer '") +
                 info.storage_buffers[declared_slot].name +
                 "' is not ready.")
                    .c_str());
        }
        return handle_at(state.shader_storage_buffers, handle).buffer;
    };

    std::vector<WGPUBindGroupEntry> storage_entries;
    for (std::size_t slot = 0; slot < info.storage_buffers.size(); ++slot) {
        if (!info.storage_buffers[slot].vertex) continue;
        WGPUBindGroupEntry entry = WGPU_BIND_GROUP_ENTRY_INIT;
        entry.binding = static_cast<std::uint32_t>(storage_entries.size());
        entry.buffer = storage_buffer(slot);
        entry.size = WGPU_WHOLE_SIZE;
        storage_entries.push_back(entry);
    }
    if (!storage_entries.empty()) {
        WGPUBindGroupDescriptor descriptor =
            WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        descriptor.layout = layouts[0];
        descriptor.entryCount = storage_entries.size();
        descriptor.entries = storage_entries.data();
        bindings.storage =
            require_dawn_resource(wgpuDeviceCreateBindGroup(state.device, &descriptor), "mesh bind group");
        if (!bindings.storage) {
            dawn_error("Shader storage bind group creation failed.");
        }
    }

    if (info.vertex.present) {
        if (!vertex_uniforms) {
            dawn_error("Shader vertex uniform buffer is not ready.");
        }
        WGPUBindGroupEntry entry = WGPU_BIND_GROUP_ENTRY_INIT;
        entry.binding = 0;
        entry.buffer = vertex_uniforms;
        entry.size = info.vertex.float_size * 4ull;
        WGPUBindGroupDescriptor descriptor =
            WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        descriptor.layout = layouts[1];
        descriptor.entryCount = 1;
        descriptor.entries = &entry;
        bindings.scene =
            require_dawn_resource(wgpuDeviceCreateBindGroup(state.device, &descriptor), "mesh bind group");
        if (!bindings.scene) {
            dawn_error("Shader vertex bind group creation failed.");
        }
    }

    std::vector<WGPUBindGroupEntry> resource_entries;
    const auto& textures = mesh_shader_textures(mesh);
    for (std::size_t slot = 0; slot < info.samplers.size(); ++slot) {
        WGPUTextureView view = nullptr;
        WGPUSampler sampler = nullptr;
#if BBLITE_SHADOWS_CSM
        const bool csm =
            slot < material.shader_csm_textures.size() &&
            material.shader_csm_textures[slot].value != invalid_handle;
        if (csm) {
#if BBLITE_SHADOW_RECEIVERS
            const ShadowGeneratorHandle generator =
                material.shader_csm_textures[slot];
            if (generator.value >= engine.shadow_generators.size()) {
                dawn_error("Shader CSM receiver has an invalid generator.");
            }
            ensure_shadow_samplers(state);
            view = shadow_map_view(state, engine, generator);
            sampler = state.shadow_comparison_sampler;
#else
            dawn_error("Shader CSM texture in a build with no receiver.");
#endif
        } else
#endif
        {
            if (slot >= textures.size()) {
                dawn_error(shader_sampler_shortfall(info, textures.size()));
            }
            view = textures[slot].view;
            sampler = textures[slot].sampler;
        }
        if (!view || !sampler) {
            dawn_error(
                (std::string("Shader material texture '") +
                 info.samplers[slot] + "' is not ready.")
                    .c_str());
        }
        WGPUBindGroupEntry texture = WGPU_BIND_GROUP_ENTRY_INIT;
        texture.binding = static_cast<std::uint32_t>(slot * 2);
        texture.textureView = view;
        resource_entries.push_back(texture);
        WGPUBindGroupEntry sampler_entry = WGPU_BIND_GROUP_ENTRY_INIT;
        sampler_entry.binding = static_cast<std::uint32_t>(slot * 2 + 1);
        sampler_entry.sampler = sampler;
        resource_entries.push_back(sampler_entry);
    }
    std::uint32_t fragment_storage_binding =
        static_cast<std::uint32_t>(info.samplers.size() * 2);
    for (std::size_t slot = 0; slot < info.storage_buffers.size(); ++slot) {
        if (!info.storage_buffers[slot].fragment) continue;
        WGPUBindGroupEntry entry = WGPU_BIND_GROUP_ENTRY_INIT;
        entry.binding = fragment_storage_binding++;
        entry.buffer = storage_buffer(slot);
        entry.size = WGPU_WHOLE_SIZE;
        resource_entries.push_back(entry);
    }
    if (!resource_entries.empty()) {
        WGPUBindGroupDescriptor descriptor =
            WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        descriptor.layout = layouts[2];
        descriptor.entryCount = resource_entries.size();
        descriptor.entries = resource_entries.data();
        bindings.resources =
            require_dawn_resource(wgpuDeviceCreateBindGroup(state.device, &descriptor), "mesh bind group");
        if (!bindings.resources) {
            dawn_error("Shader resource bind group creation failed.");
        }
    }

    if (info.fragment.present) {
        WGPUBindGroupEntry entry = WGPU_BIND_GROUP_ENTRY_INIT;
        entry.binding = 0;
        entry.buffer = mesh.material_uniforms;
        entry.size = info.fragment.float_size * 4ull;
        WGPUBindGroupDescriptor descriptor =
            WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        descriptor.layout = layouts[3];
        descriptor.entryCount = 1;
        descriptor.entries = &entry;
        bindings.material =
            require_dawn_resource(wgpuDeviceCreateBindGroup(state.device, &descriptor), "mesh bind group");
        if (!bindings.material) {
            dawn_error("Shader fragment bind group creation failed.");
        }
    }
    return mesh.shader_bindings.emplace(key, std::move(bindings)).first->second;
}

// ---------------------------------------------------------------------------
// Attribution captures (scene-1 diagnostics tooling): draw-id and
// triangle-cluster id buffers plus the PBR diagnostic MRT set, matching
// the SDL backend's save_geometry_id_buffer_png / save_pbr_diagnostic_
// buffers outputs byte-for-byte in layout and conversion semantics.

// The diagnostic pipelines reuse the scene vertex module and the
// superset mesh pipeline layout so the per-mesh bind groups from the
// main pass stay valid; only the fragment module, cull mode, sample
// count, and color target formats vary.
WGPURenderPipeline create_diagnostic_pipeline(
    DawnState& state,
    WGPUShaderModule fragment_module,
    bool double_sided,
    std::uint32_t samples,
    const WGPUTextureFormat* color_formats,
    std::uint32_t color_count) {
    std::array<WGPUVertexAttribute, base_vertex_attribute_count>
        attributes{};
    fill_base_vertex_attributes(attributes.data());
    std::array<WGPUVertexBufferLayout, 2> vertex_layouts{};
    vertex_layouts[0].stepMode = WGPUVertexStepMode_Vertex;
    vertex_layouts[0].arrayStride = sizeof(GpuVertex);
    vertex_layouts[0].attributeCount = attributes.size();
    vertex_layouts[0].attributes = attributes.data();
#if BBLITE_GPU_INSTANCING
    std::array<WGPUVertexAttribute, 4> instance_attributes{};
    for (std::uint32_t column = 0; column < 4; ++column) {
        instance_attributes[column].format = WGPUVertexFormat_Float32x4;
        instance_attributes[column].offset = column * 16;
        instance_attributes[column].shaderLocation = 16 + column;
    }
    vertex_layouts[1].stepMode = WGPUVertexStepMode_Instance;
    vertex_layouts[1].arrayStride = sizeof(std::array<float, 16>);
    vertex_layouts[1].attributeCount = instance_attributes.size();
    vertex_layouts[1].attributes = instance_attributes.data();
    constexpr std::uint32_t vertex_buffer_count = 2;
#else
    constexpr std::uint32_t vertex_buffer_count = 1;
#endif
    WGPURenderPipelineDescriptor descriptor =
        WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    descriptor.layout = mesh_pipeline_layout_for(state);
    descriptor.vertex.module = state.vertex_module;
    descriptor.vertex.entryPoint = string_view("mainVertex");
    descriptor.vertex.bufferCount = vertex_buffer_count;
    descriptor.vertex.buffers = vertex_layouts.data();
    descriptor.primitive.topology =
        WGPUPrimitiveTopology_TriangleList;
    descriptor.primitive.frontFace = WGPUFrontFace_CCW;
    descriptor.primitive.cullMode =
        double_sided ? WGPUCullMode_None : WGPUCullMode_Back;
    WGPUDepthStencilState depth_stencil =
        WGPU_DEPTH_STENCIL_STATE_INIT;
    depth_stencil.format = WGPUTextureFormat_Depth24PlusStencil8;
    depth_stencil.depthWriteEnabled = WGPUOptionalBool_True;
    depth_stencil.depthCompare =
        dawn_depth_compare(upstream::pinned_depth_compare);
    descriptor.depthStencil = &depth_stencil;
    descriptor.multisample.count = samples;
    descriptor.multisample.mask = ~0u;
    std::array<WGPUColorTargetState, 4> color_targets{};
    for (std::uint32_t index = 0; index < color_count; ++index) {
        color_targets[index] = WGPU_COLOR_TARGET_STATE_INIT;
        color_targets[index].format = color_formats[index];
    }
    WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
    fragment.module = fragment_module;
    fragment.entryPoint = string_view("mainFragment");
    fragment.targetCount = color_count;
    fragment.targets = color_targets.data();
    descriptor.fragment = &fragment;
    DawnRenderPipeline pipeline{wgpuDeviceCreateRenderPipeline(state.device, &descriptor)};
    if (!pipeline) {
        dawn_error("diagnostic render pipeline creation failed.");
    }
    return pipeline.release();
}

// Downloads a diagnostic render target and stores it with the SDL
// backend's exact conversion semantics: rgba16float decodes through
// the manual half conversion (clamped to bytes), r16float lands in the
// red channel, rgba8unorm copies through, and the optional raw path
// dumps the unpadded rgba16float rows.
void save_dawn_texture_file(
    DawnState& state,
    WGPUTexture texture,
    WGPUTextureFormat format,
    std::uint32_t width,
    std::uint32_t height,
    const std::string& path,
    const std::string& raw_path = {}) {
    const std::uint32_t bytes_per_pixel =
        format == WGPUTextureFormat_RGBA16Float
            ? 8u
            : format == WGPUTextureFormat_R16Float ? 2u : 4u;
    const std::uint32_t source_row_bytes = width * bytes_per_pixel;
    const std::uint32_t aligned_row_bytes =
        (source_row_bytes + 255u) & ~255u;
    WGPUBufferDescriptor readback_descriptor =
        WGPU_BUFFER_DESCRIPTOR_INIT;
    readback_descriptor.usage =
        WGPUBufferUsage_CopyDst | WGPUBufferUsage_MapRead;
    readback_descriptor.size =
        static_cast<std::uint64_t>(aligned_row_bytes) * height;
    DawnBuffer readback{wgpuDeviceCreateBuffer(state.device, &readback_descriptor)};
    DawnCommandEncoder encoder{wgpuDeviceCreateCommandEncoder(state.device, nullptr)};
    WGPUTexelCopyTextureInfo copy_source =
        WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
    copy_source.texture = texture;
    WGPUTexelCopyBufferInfo copy_destination =
        WGPU_TEXEL_COPY_BUFFER_INFO_INIT;
    copy_destination.layout.bytesPerRow = aligned_row_bytes;
    copy_destination.layout.rowsPerImage = height;
    copy_destination.buffer = readback;
    const WGPUExtent3D copy_size{width, height, 1};
    wgpuCommandEncoderCopyTextureToBuffer(
        encoder,
        &copy_source,
        &copy_destination,
        &copy_size);
    DawnCommandBuffer command{wgpuCommandEncoderFinish(encoder, nullptr)};
    submit_dawn_command(state.queue, command);
    command.reset();
    encoder.reset();
    WGPUBufferMapCallbackInfo map_callback =
        WGPU_BUFFER_MAP_CALLBACK_INFO_INIT;
    map_callback.mode = WGPUCallbackMode_WaitAnyOnly;
    map_callback.callback = [](
                                WGPUMapAsyncStatus status,
                                WGPUStringView message,
                                void* userdata1,
                                void*) {
        if (status != WGPUMapAsyncStatus_Success) {
            auto* error = static_cast<std::string*>(userdata1);
            if (error->empty()) *error = view_text(message);
        }
    };
    map_callback.userdata1 = &state.uncaptured_error;
    wait_for(
        state.instance,
        wgpuBufferMapAsync(
            readback,
            WGPUMapMode_Read,
            0,
            static_cast<std::size_t>(aligned_row_bytes) * height,
            map_callback));
    const auto* mapped =
        static_cast<const std::uint8_t*>(wgpuBufferGetConstMappedRange(
            readback,
            0,
            static_cast<std::size_t>(aligned_row_bytes) * height));
    if (!mapped) {
        readback.reset();
        dawn_error("diagnostic readback map returned no data.");
    }
    if (
        !raw_path.empty() &&
        format == WGPUTextureFormat_RGBA16Float) {
        std::ofstream raw(raw_path, std::ios::binary);
        if (!raw) {
            wgpuBufferUnmap(readback);
            readback.reset();
            throw std::runtime_error(
                "Unable to open HDR diagnostic output '" + raw_path +
                "'.");
        }
        write_readback_raw_rows(
            raw,
            mapped,
            height,
            aligned_row_bytes,
            source_row_bytes);
    }
    const std::uint32_t output_row_bytes = width * 4;
    // The shared row conversion (pal_gpu_shared.hpp); only the WebGPU
    // format enum is translated here.
    const ReadbackFormatClass format_class =
        format == WGPUTextureFormat_RGBA16Float
            ? ReadbackFormatClass::rgba16_float
            : format == WGPUTextureFormat_R16Float
                ? ReadbackFormatClass::r16_float
                : ReadbackFormatClass::rgba8;
    std::vector<std::uint8_t> rgba = convert_readback_rows(
        mapped,
        width,
        height,
        aligned_row_bytes,
        format_class);
    wgpuBufferUnmap(readback);
    readback.reset();
    save_capture_png(rgba, width, height, output_row_bytes, false, path);
}

void save_dawn_geometry_id_buffer(
    DawnState& state,
    std::uint32_t width,
    std::uint32_t height,
    const std::vector<upstream::RenderItem>& render_plan,
    const Engine& engine,
    const std::string& path,
    bool cluster_ids) {
    if (cluster_ids && !state.diagnostic_cluster_module) {
        state.diagnostic_cluster_module =
            load_wgsl_module(state, "diagnostic-cluster.frag");
    }
    if (!cluster_ids && !state.diagnostic_id_module) {
        state.diagnostic_id_module =
            load_wgsl_module(state, "diagnostic-id.frag");
    }
    const WGPUTextureFormat color_format = WGPUTextureFormat_RGBA8Unorm;
    auto& pipelines =
        cluster_ids ? state.cluster_pipelines : state.id_pipelines;
    for (int sided = 0; sided < 2; ++sided) {
        if (!pipelines[sided]) {
            pipelines[sided] = create_diagnostic_pipeline(
                state,
                cluster_ids
                    ? state.diagnostic_cluster_module
                    : state.diagnostic_id_module,
                sided == 1,
                1,
                &color_format,
                1);
        }
    }

    WGPUTextureDescriptor color_info = WGPU_TEXTURE_DESCRIPTOR_INIT;
    color_info.usage =
        WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_CopySrc;
    color_info.size = {width, height, 1};
    color_info.format = color_format;
    DawnTexture color{wgpuDeviceCreateTexture(state.device, &color_info)};
    if (!color) dawn_error("wgpuDeviceCreateTexture ID buffer");
    DawnTextureView color_view{create_dawn_texture_view(color, nullptr)};
    WGPUTextureDescriptor depth_info = WGPU_TEXTURE_DESCRIPTOR_INIT;
    depth_info.usage = WGPUTextureUsage_RenderAttachment;
    depth_info.size = {width, height, 1};
    depth_info.format = WGPUTextureFormat_Depth24PlusStencil8;
    DawnTexture depth{wgpuDeviceCreateTexture(state.device, &depth_info)};
    if (!depth) dawn_error("wgpuDeviceCreateTexture ID depth");
    DawnTextureView depth_view{create_dawn_texture_view(depth, nullptr)};

    std::vector<DawnBuffer> transient_buffers;
    std::vector<DawnBindGroup> transient_groups;
    DawnCommandEncoder encoder{wgpuDeviceCreateCommandEncoder(state.device, nullptr)};
    WGPURenderPassColorAttachment color_attachment =
        WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
    color_attachment.view = color_view;
    color_attachment.loadOp = WGPULoadOp_Clear;
    color_attachment.storeOp = WGPUStoreOp_Store;
    color_attachment.clearValue = WGPUColor{0.0, 0.0, 0.0, 0.0};
    WGPURenderPassDepthStencilAttachment depth_attachment{};
    depth_attachment.view = depth_view;
    depth_attachment.depthLoadOp = WGPULoadOp_Clear;
    depth_attachment.depthClearValue = upstream::pinned_depth_clear;
    depth_attachment.depthStoreOp = WGPUStoreOp_Discard;
    depth_attachment.stencilLoadOp = WGPULoadOp_Clear;
    depth_attachment.stencilStoreOp = WGPUStoreOp_Discard;
    WGPURenderPassDescriptor pass_descriptor =
        WGPU_RENDER_PASS_DESCRIPTOR_INIT;
    pass_descriptor.colorAttachmentCount = 1;
    pass_descriptor.colorAttachments = &color_attachment;
    pass_descriptor.depthStencilAttachment = &depth_attachment;
    DawnRenderPass pass{wgpuCommandEncoderBeginRenderPass(encoder, &pass_descriptor)};
    for (int sided_mode = 0; sided_mode < 2; ++sided_mode) {
        wgpuRenderPassEncoderSetPipeline(pass, pipelines[sided_mode]);
        std::uint32_t cluster_id_base = 1;
        for (
            std::size_t mesh_index = 0;
            mesh_index < state.meshes.size() &&
            mesh_index < render_plan.size();
            ++mesh_index) {
            DawnMesh& mesh = state.meshes[mesh_index];
            const ClusterRange cluster =
                advance_cluster_range(mesh.index_count, cluster_id_base);

            const std::uint32_t current_cluster_base = cluster.id_start;
            const upstream::RenderItem& item = render_plan[mesh_index];
            const MaterialRecord* material =
                item.material.value < engine.materials.size()
                    ? &handle_at(engine.materials, item.material)
                    : nullptr;
            const bool double_sided =
                item.cull_mode == upstream::RenderCullMode::none;
            if (double_sided != (sided_mode == 1)) continue;

            const std::array<float, 4> alpha_options =
                diagnostic_alpha_options(item, material);
            WGPUBufferDescriptor uniform_descriptor =
                WGPU_BUFFER_DESCRIPTOR_INIT;
            uniform_descriptor.usage =
                WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
            uniform_descriptor.size = 32;
            DawnBuffer uniform_buffer{wgpuDeviceCreateBuffer(
                state.device,
                &uniform_descriptor)};
            if (cluster_ids) {
                const DiagnosticClusterUniforms uniforms =
                    diagnostic_cluster_uniforms(
                        current_cluster_base,
                        alpha_options);
                wgpuQueueWriteBuffer(
                    state.queue,
                    uniform_buffer,
                    0,
                    &uniforms,
                    sizeof(uniforms));
            } else {
                const DiagnosticIdUniforms uniforms =
                    diagnostic_id_uniforms(
                        static_cast<std::uint32_t>(mesh_index + 1),
                        alpha_options);
                wgpuQueueWriteBuffer(
                    state.queue,
                    uniform_buffer,
                    0,
                    &uniforms,
                    sizeof(uniforms));
            }
            WGPUBindGroupEntry uniform_entry = WGPU_BIND_GROUP_ENTRY_INIT;
            uniform_entry.binding = 0;
            uniform_entry.buffer = uniform_buffer;
            uniform_entry.size = 32;
            WGPUBindGroupDescriptor group_descriptor =
                WGPU_BIND_GROUP_DESCRIPTOR_INIT;
            group_descriptor.layout = state.mesh_group_layouts[3];
            group_descriptor.entryCount = 1;
            group_descriptor.entries = &uniform_entry;
            DawnBindGroup uniform_group{wgpuDeviceCreateBindGroup(
                state.device,
                &group_descriptor)};

            DawnMeshBindings& bindings = bindings_for(
                state,
                mesh,
                upstream::RenderPipelineKind::pbr_opaque_back);
            wgpuRenderPassEncoderSetBindGroup(
                pass, 1, bindings.scene, 0, nullptr);
            wgpuRenderPassEncoderSetBindGroup(
                pass, 2, bindings.textures, 0, nullptr);
            wgpuRenderPassEncoderSetBindGroup(
                pass, 3, uniform_group, 0, nullptr);
            transient_buffers.push_back(std::move(uniform_buffer));
            transient_groups.push_back(std::move(uniform_group));
#if BBLITE_GPU_MORPH_STORAGE
            wgpuRenderPassEncoderSetBindGroup(
                pass, 0, bindings.morph, 0, nullptr);
#endif
            wgpuRenderPassEncoderSetVertexBuffer(
                pass, 0, mesh.vertices, 0, WGPU_WHOLE_SIZE);
#if BBLITE_GPU_INSTANCING
            wgpuRenderPassEncoderSetVertexBuffer(
                pass, 1, mesh.instances, 0, WGPU_WHOLE_SIZE);
#endif
#if BBLITE_GPU_INSTANCE_COLORS
            wgpuRenderPassEncoderSetVertexBuffer(
                pass, 2, mesh.instance_colors, 0, WGPU_WHOLE_SIZE);
#endif
            wgpuRenderPassEncoderSetIndexBuffer(
                pass,
                mesh.indices,
                WGPUIndexFormat_Uint32,
                0,
                WGPU_WHOLE_SIZE);
            count_gpu_draw(wgpuRenderPassEncoderDrawIndexed,
                pass,
                mesh.index_count,
#if BBLITE_GPU_INSTANCING
                mesh.instance_count,
#else
                1,
#endif
                0,
                0,
                0);
        }
    }
    wgpuRenderPassEncoderEnd(pass);
    pass.reset();
    DawnCommandBuffer command{wgpuCommandEncoderFinish(encoder, nullptr)};
    submit_dawn_command(state.queue, command);
    command.reset();
    encoder.reset();
    save_dawn_texture_file(
        state,
        color,
        color_format,
        width,
        height,
        path);
    transient_groups.clear();
    transient_buffers.clear();
    depth_view.reset();
    depth.reset();
    color_view.reset();
    color.reset();
}

#if defined(BBLITE_HAS_POST_PROCESS) && BBLITE_HAS_POST_PROCESS
/** Builds the entry `post_process_program` below found missing. */
DawnPostProcessProgram build_post_process_program(
    DawnState& state,
    const upstream::PostProcessShaderInfo& info,
    WGPUTextureFormat format,
    std::uint32_t samples,
    std::uint32_t alpha_mode,
    std::size_t extra_textures,
    std::uint32_t uniform_size) {
    DawnPostProcessProgram program;
    program.module_index = info.module_index;
    program.format = format;
    program.samples = samples;
    program.alpha_mode = alpha_mode;
    program.extra_textures = extra_textures;
    program.uniform_binding = info.uniform_binding;
    program.uniform_size = uniform_size;
    // Both stages live in one composed module, deployed once under the
    // fragment stem (the vertex stem is an alsoStages declaration carrying
    // only compiled artifacts), so the fragment file is the module.
    program.module = load_wgsl_module(
        state,
        "postprocess-" + std::to_string(info.module_index) + ".frag");
    std::vector<WGPUBindGroupLayoutEntry> layout_entries;
    WGPUBindGroupLayoutEntry sampler_entry =
        WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
    sampler_entry.binding = 0;
    sampler_entry.visibility = WGPUShaderStage_Fragment;
    sampler_entry.sampler.type = WGPUSamplerBindingType_Filtering;
    layout_entries.push_back(sampler_entry);
    WGPUBindGroupLayoutEntry texture_entry =
        WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
    texture_entry.binding = 1;
    texture_entry.visibility = WGPUShaderStage_Fragment;
    texture_entry.texture.sampleType = WGPUTextureSampleType_Float;
    layout_entries.push_back(texture_entry);
    for (std::size_t extra = 0; extra < extra_textures; ++extra) {
        WGPUBindGroupLayoutEntry extra_entry = texture_entry;
        extra_entry.binding = 2u + static_cast<std::uint32_t>(extra);
        layout_entries.push_back(extra_entry);
    }
    if (uniform_size > 0) {
        WGPUBindGroupLayoutEntry uniform_entry =
            WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
        uniform_entry.binding = info.uniform_binding;
        uniform_entry.visibility =
            WGPUShaderStage_Vertex | WGPUShaderStage_Fragment;
        uniform_entry.buffer.type = WGPUBufferBindingType_Uniform;
        layout_entries.push_back(uniform_entry);
    }
    WGPUBindGroupLayoutDescriptor layout_descriptor =
        WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
    layout_descriptor.entryCount = layout_entries.size();
    layout_descriptor.entries = layout_entries.data();
    program.group_layout =
        require_dawn_resource(wgpuDeviceCreateBindGroupLayout(state.device, &layout_descriptor), "pass pipeline layout");
    WGPUPipelineLayoutDescriptor pipeline_layout =
        WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
    pipeline_layout.bindGroupLayoutCount = 1;
    const auto group_layout = program.group_layout.get();
    pipeline_layout.bindGroupLayouts = &group_layout;
    program.pipeline_layout =
        require_dawn_resource(wgpuDeviceCreatePipelineLayout(state.device, &pipeline_layout), "pass pipeline layout");
    // The generated table names the pin's factors; turning them into this
    // API's enums is the backend's own `blend_state_from`.
    const upstream::PostProcessBlend blend =
        upstream::post_process_blend(alpha_mode);
    const WGPUBlendState blend_state = blend_state_from(blend.factors);
    WGPUColorTargetState color_target = WGPU_COLOR_TARGET_STATE_INIT;
    color_target.format = format;
    if (blend.enabled) color_target.blend = &blend_state;
    WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
    fragment.module = program.module;
    fragment.entryPoint = string_view("postProcessFragment");
    fragment.targetCount = 1;
    fragment.targets = &color_target;
    WGPURenderPipelineDescriptor descriptor =
        WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    descriptor.layout = program.pipeline_layout;
    descriptor.vertex.module = program.module;
    descriptor.vertex.entryPoint = string_view("postProcessVertex");
    descriptor.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    descriptor.primitive.cullMode = WGPUCullMode_None;
    // The pin builds the pipeline against its output target's own sample
    // count and resolves nothing; what it refuses is a multisampled *source*.
    descriptor.multisample.count = samples;
    descriptor.multisample.mask = ~0u;
    descriptor.fragment = &fragment;
    program.pipeline =
        wgpuDeviceCreateRenderPipeline(state.device, &descriptor);
    if (!program.pipeline) {
        dawn_error("post-process pipeline creation failed.");
    }
    return program;
}

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
std::size_t post_process_program(
    DawnState& state,
    const upstream::PostProcessShaderInfo& info,
    WGPUTextureFormat format,
    std::uint32_t samples,
    std::uint32_t alpha_mode,
    std::size_t extra_textures) {
    const std::uint32_t uniform_size =
        (info.uniform_byte_length + 15u) & ~15u;
    return find_or_create_program(
        state.post_process_programs,
        [&](const DawnPostProcessProgram& program) {
            return program.module_index == info.module_index &&
                program.format == format &&
                program.samples == samples &&
                program.alpha_mode == alpha_mode &&
                program.extra_textures == extra_textures &&
                program.uniform_binding == info.uniform_binding &&
                program.uniform_size == uniform_size;
        },
        [&] {
            return build_post_process_program(
                state,
                info,
                format,
                samples,
                alpha_mode,
                extra_textures,
                uniform_size);
        });
}

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
    std::size_t index, std::uint32_t width, std::uint32_t height, bool force = false) {
    auto& pass = handle_at(engine.frame_tasks, handle).post_process.passes[index];
    auto& gpu = handle_at(state.post_process_tasks, handle)[index];
    if (!gpu.uniforms || (!force && !pass.uniforms_dirty)) return;
    const auto& program = state.post_process_programs[gpu.program];
    const auto extent = resolve_post_process_extent(handle_at(engine.render_targets, pass.output_target),
        state.render_targets, pass, width, height);
    std::vector<float> data(program.uniform_size / sizeof(float), 0.0f);
    upstream::write_post_process_uniforms(engine, pass, extent.output_width, extent.output_height,
        extent.source_width, extent.source_height, data.data());
    wgpuQueueWriteBuffer(state.queue, gpu.uniforms, 0, data.data(), program.uniform_size);
    pass.uniforms_dirty = false;
}

template <typename SourceTextureView>
PreparedDawnPostProcessPass prepare_dawn_post_process_pass(
    DawnState& state,
    Engine& engine,
    TaskHandle handle,
    std::uint32_t width,
    std::uint32_t height,
    std::size_t index,
    SourceTextureView source_texture_view,
    bool write_uniforms = true) {
    PostProcessPassOptions& pass =
        handle_at(engine.frame_tasks, handle).post_process.passes[index];
    const upstream::PostProcessShaderInfo& info =
        upstream::post_process_shader_infos[
            pass.shader_index];
    DawnPostProcessTask& gpu =
        handle_at(state.post_process_tasks, handle)[index];
    const RenderTargetRecord& output_record =
        handle_at(engine.render_targets, pass.output_target);
    DawnRenderTarget& output =
        handle_at(state.render_targets, pass.output_target);
    const PostProcessExtent extent = resolve_post_process_extent(
        output_record,
        state.render_targets,
        pass,
        width,
        height);
    const std::uint32_t output_width = extent.output_width;
    const std::uint32_t output_height = extent.output_height;
    if (gpu.program == npos) {
        gpu.program = post_process_program(
            state,
            info,
            handle_at(state.render_targets, pass.output_target).color_format,
            output_record.swapchain
                ? 1u
                : task_sample_count(state, output_record.samples),
            pass.alpha_mode,
            pass.extra_textures.size());
        const DawnPostProcessProgram& created =
            state.post_process_programs[gpu.program];
        if (created.uniform_size > 0) {
            WGPUBufferDescriptor uniform_descriptor =
                WGPU_BUFFER_DESCRIPTOR_INIT;
            uniform_descriptor.size = created.uniform_size;
            uniform_descriptor.usage =
                WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
            gpu.uniforms = wgpuDeviceCreateBuffer(
                state.device,
                &uniform_descriptor);
        }
        std::vector<WGPUBindGroupEntry> group_entries;
        WGPUBindGroupEntry sampler_binding =
            WGPU_BIND_GROUP_ENTRY_INIT;
        sampler_binding.binding = 0;
        sampler_binding.sampler =
            pass.sampling == PostProcessSampling::nearest
                ? state.nearest_sampler
                : state.post_process_bilinear_sampler;
        group_entries.push_back(sampler_binding);
        WGPUBindGroupEntry texture_binding =
            WGPU_BIND_GROUP_ENTRY_INIT;
        texture_binding.binding = 1;
        texture_binding.textureView =
            source_texture_view(pass.source).second;
        group_entries.push_back(texture_binding);
        for (
            std::size_t extra = 0;
            extra < pass.extra_textures.size();
            ++extra) {
            WGPUBindGroupEntry extra_binding =
                WGPU_BIND_GROUP_ENTRY_INIT;
            extra_binding.binding =
                2u + static_cast<std::uint32_t>(extra);
            extra_binding.textureView =
                source_texture_view(
                    pass.extra_textures[extra])
                    .second;
            group_entries.push_back(extra_binding);
        }
        if (gpu.uniforms) {
            WGPUBindGroupEntry uniform_binding =
                WGPU_BIND_GROUP_ENTRY_INIT;
            uniform_binding.binding = info.uniform_binding;
            uniform_binding.buffer = gpu.uniforms;
            uniform_binding.size = created.uniform_size;
            group_entries.push_back(uniform_binding);
        }
        WGPUBindGroupDescriptor group_descriptor =
            WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        group_descriptor.layout = created.group_layout;
        group_descriptor.entryCount = group_entries.size();
        group_descriptor.entries = group_entries.data();
        gpu.group = wgpuDeviceCreateBindGroup(
            state.device,
            &group_descriptor);
        pass.uniforms_dirty = true;
    }
    const DawnPostProcessProgram& program =
        state.post_process_programs[gpu.program];
    if (write_uniforms) write_dawn_post_process_uniforms(state, engine, handle, index, width, height);
    PreparedDawnPostProcessPass prepared;
    prepared.output = output.color_view;
    prepared.pipeline = program.pipeline;
    prepared.group = gpu.group;
    prepared.presents = output_record.swapchain;
    prepared.clear = pass.clear;
    if (pass.has_viewport) prepared.viewport = upstream::resolve_post_process_viewport(pass.viewport, output_width, output_height);
    return prepared;
}

void encode_dawn_post_process_pass(WGPUCommandEncoder encoder, WGPUTextureView surface_view,
    const PreparedDawnPostProcessPass& prepared) {
    WGPURenderPassColorAttachment attachment =
        WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
    attachment.view = prepared.presents
        ? surface_view
        : prepared.output;
    attachment.loadOp = prepared.clear
        ? WGPULoadOp_Clear
        : WGPULoadOp_Load;
    attachment.storeOp = WGPUStoreOp_Store;
    WGPURenderPassDescriptor pass_descriptor =
        WGPU_RENDER_PASS_DESCRIPTOR_INIT;
    pass_descriptor.colorAttachmentCount = 1;
    pass_descriptor.colorAttachments = &attachment;
    DawnRenderPass post_pass{wgpuCommandEncoderBeginRenderPass(
            encoder,
            &pass_descriptor)};
    if (prepared.viewport) {
        const PixelViewport& rectangle = *prepared.viewport;
        wgpuRenderPassEncoderSetViewport(
            post_pass,
            static_cast<float>(rectangle.x),
            static_cast<float>(rectangle.y),
            static_cast<float>(rectangle.width),
            static_cast<float>(rectangle.height),
            0.0f,
            1.0f);
        wgpuRenderPassEncoderSetScissorRect(
            post_pass,
            static_cast<std::uint32_t>(rectangle.x),
            static_cast<std::uint32_t>(rectangle.y),
            static_cast<std::uint32_t>(rectangle.width),
            static_cast<std::uint32_t>(rectangle.height));
    }
    wgpuRenderPassEncoderSetPipeline(post_pass, prepared.pipeline);
    wgpuRenderPassEncoderSetBindGroup(
        post_pass,
        0,
        prepared.group,
        0,
        nullptr);
    count_gpu_draw(wgpuRenderPassEncoderDraw, post_pass, 3, 1, 0, 0);
    wgpuRenderPassEncoderEnd(post_pass);
    post_pass.reset();
}

template <typename SourceTextureView>
void record_post_process_pass(DawnState& state, Engine& engine, TaskHandle handle,
    WGPUCommandEncoder encoder, WGPUTextureView surface_view, std::uint32_t width,
    std::uint32_t height, std::size_t index, SourceTextureView source_texture_view) {
    const auto prepared = prepare_dawn_post_process_pass(state, engine, handle, width, height,
        index, source_texture_view);
    encode_dawn_post_process_pass(encoder, surface_view, prepared);
}
#endif

#if defined(BBLITE_HAS_SCREEN_SPACE) && BBLITE_HAS_SCREEN_SPACE
/** Builds the entry `screen_space_program` below found missing. */
DawnScreenSpaceProgram build_screen_space_program(
    DawnState& state,
    std::uint32_t stage) {
    const upstream::ScreenSpaceShaderInfo& info =
        upstream::screen_space_shader_infos.at(stage);
    DawnScreenSpaceProgram program;
    program.stage = stage;
    // Both stages live in one deployed module under the fragment stem.
    program.module =
        load_wgsl_module(state, std::string(info.stem) + ".frag");
    // The pin's own bind group layout, entry for entry: every binding is
    // fragment-visible, and the kinds are the ones its descriptors name.
    std::vector<WGPUBindGroupLayoutEntry> layout_entries;
    for (std::size_t index = 0; index < info.binding_count; ++index) {
        const upstream::ScreenSpaceStageBinding& binding =
            info.bindings[index];
        WGPUBindGroupLayoutEntry entry = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
        entry.binding = binding.binding;
        entry.visibility = WGPUShaderStage_Fragment;
        switch (binding.kind) {
            case upstream::ScreenSpaceBindingKind::depth_texture:
                entry.texture.sampleType = WGPUTextureSampleType_Depth;
                break;
            case upstream::ScreenSpaceBindingKind::texture:
                entry.texture.sampleType = WGPUTextureSampleType_Float;
                break;
            case upstream::ScreenSpaceBindingKind::sampler:
                entry.sampler.type = WGPUSamplerBindingType_Filtering;
                break;
            case upstream::ScreenSpaceBindingKind::uniform:
                entry.buffer.type = WGPUBufferBindingType_Uniform;
                break;
        }
        layout_entries.push_back(entry);
    }
    WGPUBindGroupLayoutDescriptor layout_descriptor =
        WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
    layout_descriptor.entryCount = layout_entries.size();
    layout_descriptor.entries = layout_entries.data();
    program.group_layout =
        require_dawn_resource(wgpuDeviceCreateBindGroupLayout(state.device, &layout_descriptor), "pass pipeline layout");
    WGPUPipelineLayoutDescriptor pipeline_layout =
        WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
    pipeline_layout.bindGroupLayoutCount = 1;
    const auto group_layout = program.group_layout.get();
    pipeline_layout.bindGroupLayouts = &group_layout;
    program.pipeline_layout =
        require_dawn_resource(wgpuDeviceCreatePipelineLayout(state.device, &pipeline_layout), "pass pipeline layout");
    // Single-sample, unblended, a triangle list: `ensureProducerPipeline`.
    WGPUColorTargetState color_target = WGPU_COLOR_TARGET_STATE_INIT;
    color_target.format = texture_format(info.target_format);
    WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
    fragment.module = program.module;
    fragment.entryPoint = string_view(info.fragment_entry);
    fragment.targetCount = 1;
    fragment.targets = &color_target;
    WGPURenderPipelineDescriptor descriptor =
        WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    descriptor.layout = program.pipeline_layout;
    descriptor.vertex.module = program.module;
    descriptor.vertex.entryPoint = string_view(info.vertex_entry);
    descriptor.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    descriptor.primitive.cullMode = WGPUCullMode_None;
    descriptor.multisample.count = 1;
    descriptor.multisample.mask = ~0u;
    descriptor.fragment = &fragment;
    program.pipeline =
        wgpuDeviceCreateRenderPipeline(state.device, &descriptor);
    if (!program.pipeline) {
        dawn_error("screen-space pipeline creation failed.");
    }
    return program;
}

std::size_t screen_space_program(DawnState& state, std::uint32_t stage) {
    return find_or_create_program(
        state.screen_space_programs,
        [&](const DawnScreenSpaceProgram& program) {
            return program.stage == stage;
        },
        [&] { return build_screen_space_program(state, stage); });
}

/**
 * The view a stage binding reads, by the role the pin bound there: the
 * depth attachment's depth-only view, the lit source colour, or one of the
 * task's owned targets.
 */
WGPUTextureView screen_space_binding_view(
    DawnState& state,
    const ScreenSpaceTaskOptions& task,
    upstream::ScreenSpaceTextureRole role) {
    switch (role) {
        case upstream::ScreenSpaceTextureRole::depth:
            return state.render_targets.at(task.depth.value).depth_sampled_view;
        case upstream::ScreenSpaceTextureRole::source_color:
            return state.render_targets.at(task.source.value).sampled_color_view;
        case upstream::ScreenSpaceTextureRole::raw:
            return state.render_targets.at(task.raw.value).sampled_color_view;
        case upstream::ScreenSpaceTextureRole::history:
            return state.render_targets.at(task.history.value)
                .sampled_color_view;
        default:
            dawn_error(
                "A screen-space stage binds a texture role this backend "
                "does not serve.");
    }
}

/**
 * A pass over one temporal target, cleared to zero: what every dedicated
 * stage draws into and what the identity clear leaves empty.
 */
WGPURenderPassEncoder begin_screen_space_pass(
    WGPUCommandEncoder encoder,
    WGPUTextureView target) {
    WGPURenderPassColorAttachment attachment =
        WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
    attachment.view = target;
    attachment.loadOp = WGPULoadOp_Clear;
    attachment.storeOp = WGPUStoreOp_Store;
    WGPURenderPassDescriptor pass_descriptor =
        WGPU_RENDER_PASS_DESCRIPTOR_INIT;
    pass_descriptor.colorAttachmentCount = 1;
    pass_descriptor.colorAttachments = &attachment;
    return wgpuCommandEncoderBeginRenderPass(encoder, &pass_descriptor);
}

/**
 * One dedicated stage: the block written to its buffer, the bind group
 * built over the frame-graph textures it names (the pin's
 * `rebuildProducerBindGroup`/`rebuildBindGroup` identity test, which here
 * the frame-graph rebuild answers by resetting the stage), then the pin's
 * clear-and-draw over a fullscreen triangle.
 */
void record_screen_space_stage(
    DawnState& state,
    const ScreenSpaceTaskOptions& task,
    DawnScreenSpaceStage& stage,
    std::uint32_t stage_index,
    WGPUCommandEncoder encoder,
    WGPUTextureView target,
    const float* uniforms) {
    if (stage.program == npos) {
        stage.program = screen_space_program(state, stage_index);
    }
    const DawnScreenSpaceProgram& program =
        state.screen_space_programs[stage.program];
    const upstream::ScreenSpaceShaderInfo& info =
        upstream::screen_space_shader_infos[program.stage];
    if (!stage.uniforms) {
        WGPUBufferDescriptor uniform_descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
        uniform_descriptor.size = info.uniform_bytes;
        uniform_descriptor.usage =
            WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
        stage.uniforms =
            wgpuDeviceCreateBuffer(state.device, &uniform_descriptor);
    }
    wgpuQueueWriteBuffer(
        state.queue,
        stage.uniforms,
        0,
        uniforms,
        info.uniform_bytes);
    if (!stage.group) {
        std::vector<WGPUBindGroupEntry> entries;
        for (std::size_t index = 0; index < info.binding_count; ++index) {
            const upstream::ScreenSpaceStageBinding& binding =
                info.bindings[index];
            WGPUBindGroupEntry entry = WGPU_BIND_GROUP_ENTRY_INIT;
            entry.binding = binding.binding;
            switch (binding.kind) {
                case upstream::ScreenSpaceBindingKind::depth_texture:
                case upstream::ScreenSpaceBindingKind::texture:
                    entry.textureView =
                        screen_space_binding_view(state, task, binding.role);
                    break;
                case upstream::ScreenSpaceBindingKind::sampler:
                    // The pin's one bilinear sampler wherever it samples.
                    entry.sampler = state.post_process_bilinear_sampler;
                    break;
                case upstream::ScreenSpaceBindingKind::uniform:
                    entry.buffer = stage.uniforms;
                    entry.size = info.uniform_bytes;
                    break;
            }
            entries.push_back(entry);
        }
        WGPUBindGroupDescriptor group_descriptor =
            WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        group_descriptor.layout = program.group_layout;
        group_descriptor.entryCount = entries.size();
        group_descriptor.entries = entries.data();
        stage.group =
            wgpuDeviceCreateBindGroup(state.device, &group_descriptor);
    }
    DawnRenderPass pass{begin_screen_space_pass(encoder, target)};
    wgpuRenderPassEncoderSetPipeline(pass, program.pipeline);
    wgpuRenderPassEncoderSetBindGroup(pass, 0, stage.group, 0, nullptr);
    count_gpu_draw(wgpuRenderPassEncoderDraw, pass, 3, 1, 0, 0);
    wgpuRenderPassEncoderEnd(pass);
    pass.reset();
}

/** The pin's `clearIdentity`: one clear-only pass over a temporal target. */
void clear_screen_space_target(
    WGPUCommandEncoder encoder,
    WGPUTextureView view) {
    DawnRenderPass pass{begin_screen_space_pass(encoder, view)};
    wgpuRenderPassEncoderEnd(pass);
    pass.reset();
}

/**
 * One screen-space task, in the pin's own `execute` order: the generated
 * frame function samples the task's live settings and advances its temporal
 * state, and what it decided is encoded here -- the identity clear on the
 * enabled-to-disabled transition or a singular view-projection inverse,
 * then producer, resolve and history copy when the effect runs, then the
 * composite whenever the task has one.
 */
template <typename SourceTextureView>
void record_screen_space_task(
    DawnState& state,
    Engine& engine,
    TaskHandle handle,
    WGPUCommandEncoder encoder,
    WGPUTextureView surface_view,
    std::uint32_t width,
    std::uint32_t height,
    SourceTextureView source_texture_view,
    bool& frame_graph_presented) {
    FrameTaskRecord& record = handle_at(engine.frame_tasks, handle);
    const ScreenSpaceTaskOptions& task = record.screen_space;
    DawnScreenSpaceTask& gpu = handle_at(state.screen_space_tasks, handle);
    const DawnRenderTarget& raw = state.render_targets.at(task.raw.value);
    const DawnRenderTarget& stable =
        state.render_targets.at(task.stable.value);
    const DawnRenderTarget& history =
        state.render_targets.at(task.history.value);
    const ScreenSpaceFrameDecision decision = upstream::screen_space_frame(
        engine,
        handle,
        screen_space_frame_inputs(state.render_targets, task));
    record_screen_space_decision(decision, record.post_process.passes.size() > 1,
        [&](bool previous) { clear_screen_space_target(encoder, previous ? history.color_view : stable.color_view); },
        [&](bool producer, const float* uniforms) {
            record_screen_space_stage(state, task, producer ? gpu.producer : gpu.resolve,
                producer ? task.producer_shader : task.resolve_shader, encoder,
                producer ? raw.color_view : stable.color_view, uniforms);
        },
        [&](std::size_t child) {
            record_post_process_pass(state, engine, handle, encoder, surface_view, width, height, child, source_texture_view);
            if (child == 1u && engine.render_targets.at(record.post_process.passes[1].output_target.value).swapchain) {
                frame_graph_presented = true;
            }
        });
}
#endif

} // namespace


#if BBLITE_HAS_PICKING
/**
 * The two pick pipelines. Both draw the pin's own attachment pair at one
 * sample with no blending; the mesh pass compares GREATER because this
 * renderer is reverse-Z, and the cloud pass compares LESS, which is what
 * its own pinned pipeline declares.
 */
inline WGPURenderPipeline create_dawn_pick_mesh_pipeline(
    WGPUDevice device,
    WGPUBindGroupLayout scene_layout,
    WGPUBindGroupLayout mesh_layout,
    const char* stem_vertex,
    const char* stem_fragment,
    std::uint32_t target_count,
    WGPUBindGroupLayout empty_layout = nullptr,
    WGPUBindGroupLayout deform_layout = nullptr,
    [[maybe_unused]] bool skeleton = false) {
    DawnShaderModule vertex{load_wgsl_module(device, stem_vertex)};
    DawnShaderModule fragment{load_wgsl_module(device, stem_fragment)};

    const std::array<WGPUBindGroupLayout, 4> groups{
        scene_layout, mesh_layout, empty_layout, deform_layout};
    WGPUPipelineLayoutDescriptor layout_descriptor =
        WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
    layout_descriptor.bindGroupLayoutCount = deform_layout ? 4u : 2u;
    layout_descriptor.bindGroupLayouts = groups.data();
    DawnPipelineLayout pipeline_layout{wgpuDeviceCreatePipelineLayout(device, &layout_descriptor)};
    if (!pipeline_layout) dawn_error("pick pipeline layout");

    // The renderer's interleaved stream read at its own pitch: the pin
    // binds a position-only buffer, and these are the same numbers.
    std::array<WGPUVertexAttribute, 3> attributes{};
    attributes[0].shaderLocation = 0;
    attributes[0].offset = 0;
    attributes[0].format = WGPUVertexFormat_Float32x3;
#if BBLITE_GPU_DEFORMATION && (BBLITE_PBR_VARIANTS > 0 || defined(BBLITE_STANDARD_SKELETON))
    attributes[1].shaderLocation = 1;
    attributes[1].offset = offsetof(GpuVertex, joint_indices);
    attributes[1].format = WGPUVertexFormat_Uint32x4;
    attributes[2].shaderLocation = 2;
    attributes[2].offset = offsetof(GpuVertex, weights);
    attributes[2].format = WGPUVertexFormat_Float32x4;
#endif
    WGPUVertexBufferLayout vertex_layout{};
    vertex_layout.arrayStride = sizeof(GpuVertex);
    vertex_layout.stepMode = WGPUVertexStepMode_Vertex;
    vertex_layout.attributeCount = skeleton ? 3u : 1u;
    vertex_layout.attributes = attributes.data();

    std::array<WGPUColorTargetState, pick_color_targets> targets{};
    fill_dawn_pick_targets(targets);

    WGPUFragmentState fragment_state = WGPU_FRAGMENT_STATE_INIT;
    fragment_state.module = fragment;
    fragment_state.entryPoint = string_view("fs");
    fragment_state.targetCount = target_count;
    fragment_state.targets = targets.data();

    WGPUDepthStencilState depth = WGPU_DEPTH_STENCIL_STATE_INIT;
    depth.format = WGPUTextureFormat_Depth24Plus;
    depth.depthCompare = WGPUCompareFunction_Greater;
    depth.depthWriteEnabled = WGPUOptionalBool_True;

    WGPURenderPipelineDescriptor descriptor =
        WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    descriptor.layout = pipeline_layout;
    descriptor.vertex.module = vertex;
    descriptor.vertex.entryPoint = string_view("vs");
    descriptor.vertex.bufferCount = 1;
    descriptor.vertex.buffers = &vertex_layout;
    descriptor.fragment = &fragment_state;
    descriptor.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    descriptor.primitive.cullMode = WGPUCullMode_None;
    descriptor.depthStencil = &depth;
    descriptor.multisample.count = 1;

    DawnRenderPipeline pipeline{wgpuDeviceCreateRenderPipeline(device, &descriptor)};
    pipeline_layout.reset();
    vertex.reset();
    fragment.reset();
    if (!pipeline) dawn_error("pick mesh render pipeline");
    return pipeline.release();
}

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
 * state, only the shapes.
 */
inline WGPUBindGroupLayout create_dawn_pick_empty_layout(
    WGPUDevice device) {
    WGPUBindGroupLayoutDescriptor descriptor =
        WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
    descriptor.entryCount = 0;
    DawnBindGroupLayout layout{wgpuDeviceCreateBindGroupLayout(device, &descriptor)};
    if (!layout) dawn_error("pick deform empty bind group layout");
    return layout.release();
}

/** The projection's own group: the bone palette, then the morph pair. */
inline WGPUBindGroupLayout create_dawn_pick_deform_layout(
    WGPUDevice device, const upstream::PickDeformVariant& variant) {
    std::array<WGPUBindGroupLayoutEntry, 3> entries{};
    std::size_t entry_count = 0;
    const auto append = [&]() -> WGPUBindGroupLayoutEntry& {
        auto& entry = entries[entry_count];
        entry = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
        entry.binding = static_cast<std::uint32_t>(entry_count++);
        entry.visibility = WGPUShaderStage_Vertex;
        return entry;
    };
    if (variant.skeleton) {
        auto& entry = append();
        entry.texture.sampleType = WGPUTextureSampleType_UnfilterableFloat;
        entry.texture.viewDimension = WGPUTextureViewDimension_2D;
    }
    if (variant.morph) {
        append().buffer.type = WGPUBufferBindingType_ReadOnlyStorage;
        append().buffer.type = WGPUBufferBindingType_ReadOnlyStorage;
    }

    WGPUBindGroupLayoutDescriptor descriptor =
        WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
    descriptor.entryCount = static_cast<std::uint32_t>(entry_count);
    descriptor.entries = entries.data();
    DawnBindGroupLayout layout{wgpuDeviceCreateBindGroupLayout(device, &descriptor)};
    if (!layout) dawn_error("pick deform bind group layout");
    return layout.release();
}


#endif

#if BBLITE_HAS_SPLATS
inline WGPURenderPipeline create_dawn_pick_cloud_pipeline(
    WGPUDevice device,
    WGPUBindGroupLayout scene_layout,
    WGPUBindGroupLayout cloud_layout,
    WGPUBindGroupLayout color_layout) {
    DawnShaderModule vertex{load_wgsl_module(device, "picking-splat.vert")};
    DawnShaderModule fragment{load_wgsl_module(device, "picking-splat.frag")};

    const std::array<WGPUBindGroupLayout, 3> groups{
        scene_layout, cloud_layout, color_layout};
    WGPUPipelineLayoutDescriptor layout_descriptor =
        WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
    layout_descriptor.bindGroupLayoutCount = groups.size();
    layout_descriptor.bindGroupLayouts = groups.data();
    DawnPipelineLayout pipeline_layout{wgpuDeviceCreatePipelineLayout(device, &layout_descriptor)};
    if (!pipeline_layout) dawn_error("cloud pick pipeline layout");

    WGPUVertexAttribute corner{};
    corner.shaderLocation = 0;
    corner.offset = 0;
    corner.format = WGPUVertexFormat_Float32x2;
    WGPUVertexBufferLayout quad_layout{};
    quad_layout.arrayStride = 8;
    quad_layout.stepMode = WGPUVertexStepMode_Vertex;
    quad_layout.attributeCount = 1;
    quad_layout.attributes = &corner;

    WGPUVertexAttribute index{};
    index.shaderLocation = 1;
    index.offset = 0;
    index.format = WGPUVertexFormat_Float32;
    WGPUVertexBufferLayout order_layout{};
    order_layout.arrayStride = 4;
    order_layout.stepMode = WGPUVertexStepMode_Instance;
    order_layout.attributeCount = 1;
    order_layout.attributes = &index;
    const std::array<WGPUVertexBufferLayout, 2> buffers{
        quad_layout, order_layout};

    std::array<WGPUColorTargetState, pick_color_targets> targets{};
    fill_dawn_pick_targets(targets);

    WGPUFragmentState fragment_state = WGPU_FRAGMENT_STATE_INIT;
    fragment_state.module = fragment;
    fragment_state.entryPoint = string_view("fs");
    // The cloud contributor draws the pin's own pair; a detailed pick
    // composes no contributor, so it never binds the third.
    fragment_state.targetCount = 2;
    fragment_state.targets = targets.data();

    WGPUDepthStencilState depth = WGPU_DEPTH_STENCIL_STATE_INIT;
    depth.format = WGPUTextureFormat_Depth24Plus;
    depth.depthCompare = WGPUCompareFunction_Less;
    depth.depthWriteEnabled = WGPUOptionalBool_True;

    WGPURenderPipelineDescriptor descriptor =
        WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    descriptor.layout = pipeline_layout;
    descriptor.vertex.module = vertex;
    descriptor.vertex.entryPoint = string_view("vs");
    descriptor.vertex.bufferCount = buffers.size();
    descriptor.vertex.buffers = buffers.data();
    descriptor.fragment = &fragment_state;
    descriptor.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    descriptor.primitive.cullMode = WGPUCullMode_None;
    descriptor.depthStencil = &depth;
    descriptor.multisample.count = 1;

    DawnRenderPipeline pipeline{wgpuDeviceCreateRenderPipeline(device, &descriptor)};
    pipeline_layout.reset();
    vertex.reset();
    fragment.reset();
    if (!pipeline) dawn_error("cloud pick render pipeline");
    return pipeline.release();
}
#endif
#endif

WGPUBindGroup skybox_scene_group_over(
    DawnState& state, WGPUBuffer matrix, bool pinned_dds_skybox) {
        DawnBindGroupLayout scene_layout{wgpuRenderPipelineGetBindGroupLayout(
                state.skybox_pipeline, 1)};
        std::array<WGPUBindGroupEntry, 3> scene_entries{};
        scene_entries[0] = WGPU_BIND_GROUP_ENTRY_INIT;
        scene_entries[0].binding = 0;
        scene_entries[0].buffer = matrix;
        scene_entries[0].size = pinned_dds_skybox
            ? sizeof(upstream::SkyboxVertexUniforms)
            : 64;
        std::uint32_t scene_entry_count = 1;
#if BBLITE_GPU_DEFORMATION
        if (!pinned_dds_skybox) {
            ensure_background_deformation_uniforms(state);
            scene_entries[scene_entry_count] =
                WGPU_BIND_GROUP_ENTRY_INIT;
            scene_entries[scene_entry_count].binding = 1;
            scene_entries[scene_entry_count].buffer =
                state.background_deformation_uniforms;
            scene_entries[scene_entry_count].size =
                sizeof(DeformationUniforms);
            ++scene_entry_count;
        }
#endif
#if BBLITE_GPU_INSTANCING
        if (!pinned_dds_skybox) {
            ensure_background_instance_resources(state);
            scene_entries[scene_entry_count] =
                WGPU_BIND_GROUP_ENTRY_INIT;
            scene_entries[scene_entry_count].binding =
                instance_uniform_binding;
            scene_entries[scene_entry_count].buffer =
                state.background_instance_uniform;
            scene_entries[scene_entry_count].size = 64;
            ++scene_entry_count;
        }
#endif
        WGPUBindGroupDescriptor scene_descriptor =
            WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        scene_descriptor.layout = scene_layout;
        scene_descriptor.entryCount = scene_entry_count;
        scene_descriptor.entries = scene_entries.data();
        DawnBindGroup group{wgpuDeviceCreateBindGroup(state.device, &scene_descriptor)};
        scene_layout.reset();
    return group.release();
}

#if defined(BBLITE_HAS_SPRITE_RENDERER) && BBLITE_HAS_SPRITE_RENDERER
void sync_dawn_scene_sprites(DawnState& state, Engine& engine) {
    state.sprite_render_textures.resize(engine.sprite_render_textures.size(), nullptr);
    state.sprite_render_texture_views.resize(engine.sprite_render_textures.size(), nullptr);
    sync_retained_textures(engine.sprite_render_textures,
        [&](std::size_t index) { return state.sprite_render_textures[index] != nullptr; },
        [&] { refuse_disposed_sprite_render_texture_in_use(engine); },
        [&](std::size_t index) {
            auto& view = state.sprite_render_texture_views[index];
            auto& texture = state.sprite_render_textures[index];
            if (view) wgpuTextureViewRelease(view);
            if (texture) wgpuTextureRelease(texture);
            view = nullptr; texture = nullptr;
        },
        [&](std::size_t index, const SpriteRenderTextureRecord& texture) {
            WGPUTextureDescriptor descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
            descriptor.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopySrc;
            descriptor.dimension = WGPUTextureDimension_2D;
            descriptor.size = WGPUExtent3D{texture.width, texture.height, 1u};
            descriptor.format = state.surface_format;
            descriptor.mipLevelCount = 1;
            descriptor.sampleCount = 1;
            auto& gpu_texture = state.sprite_render_textures[index];
            auto& gpu_view = state.sprite_render_texture_views[index];
            gpu_texture = wgpuDeviceCreateTexture(state.device, &descriptor);
            if (!gpu_texture) dawn_error("sprite render texture");
            gpu_view = create_dawn_texture_view(gpu_texture, nullptr);
            if (!gpu_view) dawn_error("sprite render texture view");
        });
    while (state.sprite_passes.size() < engine.sprite_renderers.size()) {
        state.sprite_passes.push_back(create_dawn_sprite_pass(state.device, state.queue, state.mips, engine,
            SpriteRendererHandle{static_cast<std::uint32_t>(state.sprite_passes.size())},
            state.sprite_render_textures, state.sprite_render_texture_views, state.surface_format));
    }
}
#endif

void recreate_dawn_scene_targets(DawnState& state, const Scene& scene, std::uint32_t width, std::uint32_t height) {
    if (state.image_processing_group) {
        wgpuBindGroupRelease(state.image_processing_group);
        state.image_processing_group = nullptr;
    }
    if (state.depth_view) wgpuTextureViewRelease(state.depth_view);
    if (state.depth) wgpuTextureRelease(state.depth);
    if (state.msaa_color_view) {
        wgpuTextureViewRelease(state.msaa_color_view);
    }
    if (state.msaa_color) wgpuTextureRelease(state.msaa_color);
    state.depth_view = nullptr;
    state.depth = nullptr;
    state.msaa_color_view = nullptr;
    state.msaa_color = nullptr;

    WGPUTextureDescriptor color_descriptor =
        WGPU_TEXTURE_DESCRIPTOR_INIT;
    color_descriptor.usage = scene.transmission_enabled
        ? WGPUTextureUsage_RenderAttachment |
            WGPUTextureUsage_TextureBinding
        : WGPUTextureUsage_RenderAttachment;
    color_descriptor.size = {width, height, 1};
    color_descriptor.format = state.frame_color_format;
    color_descriptor.sampleCount = state.sample_count;
    state.msaa_color =
        wgpuDeviceCreateTexture(state.device, &color_descriptor);
    state.msaa_color_view =
        create_dawn_texture_view(state.msaa_color, nullptr);
    WGPUTextureDescriptor depth_descriptor =
        WGPU_TEXTURE_DESCRIPTOR_INIT;
    depth_descriptor.usage = WGPUTextureUsage_RenderAttachment;
    depth_descriptor.size = {width, height, 1};
    depth_descriptor.format =
        WGPUTextureFormat_Depth24PlusStencil8;
    depth_descriptor.sampleCount = state.sample_count;
    state.depth =
        wgpuDeviceCreateTexture(state.device, &depth_descriptor);
    state.depth_view = create_dawn_texture_view(state.depth, nullptr);
    if (
        !state.msaa_color ||
        !state.msaa_color_view ||
        !state.depth ||
        !state.depth_view) {
        dawn_error("resizable frame target creation failed.");
    }
}

void initialize_dawn_environment(
    DawnState& state, const Scene& scene, bool use_skybox, bool use_ground,
    [[maybe_unused]] bool background_enabled) {
    if (use_skybox) {
        const bool pinned_dds_skybox =
            !scene.environment.skybox_uses_environment;
        // Which arm of the pinned skybox this is decides whether it
        // dithers at all: background-dds-skybox.ts prefixes WGSL_DITHER,
        // while background-hdr-skybox.ts -- the arm an environment
        // cubemap skybox takes -- composes none. One generated fragment
        // serves both, so the variant is selected here.
        //
        // The dither seeds on interpolated world positions whose low
        // bits follow the barycentrics, so it reproduces only where the
        // composed view-projection agrees with the pinned engine bit for
        // bit. Both backends select the same variant from this same
        // environment-arm rule.
        if (pinned_dds_skybox) {
            state.skybox_vertex_module = load_wgsl_module(
                state,
                "background-skybox-dds.vert");
        }
        state.skybox_module = load_wgsl_module(
            state,
            pal::background_skybox_fragment(scene.environment));
        const upstream::SkyboxPlan skybox_plan =
            upstream::build_skybox_plan(scene.environment);
        std::array<GpuVertex, 8> skybox_quad{};
        for (std::size_t index = 0; index < skybox_quad.size(); ++index) {
            skybox_quad[index] =
                gpu_vertex_from(skybox_plan.vertices[index]);
        }
        state.skybox_vertices = create_buffer(
            state,
            WGPUBufferUsage_Vertex,
            skybox_quad.data(),
            sizeof(skybox_quad));
        state.skybox_indices = create_buffer(
            state,
            WGPUBufferUsage_Index,
            skybox_plan.indices.data(),
            sizeof(skybox_plan.indices));
        WGPUTextureView skybox_view = nullptr;
        if (scene.environment.skybox_uses_environment) {
            skybox_view = state.environment_cube_view;
        } else {
            const EnvironmentState& environment = scene.environment;
            const TextureData& data = environment.skybox_texture;
            if (
                environment.skybox_width == 0 ||
                environment.skybox_mip_count == 0 ||
                environment.skybox_data_offset >= data.bytes.size()) {
                throw std::runtime_error(
                    "DDS skybox metadata is incomplete.");
            }
            WGPUTextureDescriptor descriptor =
                WGPU_TEXTURE_DESCRIPTOR_INIT;
            descriptor.usage =
                WGPUTextureUsage_TextureBinding |
                WGPUTextureUsage_CopyDst;
            descriptor.size = {
                environment.skybox_width,
                environment.skybox_width,
                6,
            };
            descriptor.format = WGPUTextureFormat_RGBA16Float;
            descriptor.mipLevelCount = environment.skybox_mip_count;
            state.skybox_texture =
                wgpuDeviceCreateTexture(state.device, &descriptor);
            if (!state.skybox_texture) {
                dawn_error("wgpuDeviceCreateTexture DDS skybox");
            }
            // The face/mip/offset walk and its truncation guard are the
            // shared half; only the queue write below is this backend's.
            for_each_dds_skybox_level(
                environment,
                [&](
                    std::uint32_t face,
                    std::uint32_t mip,
                    std::uint32_t mip_size,
                    std::size_t offset,
                    std::size_t byte_size) {
                    WGPUTexelCopyTextureInfo destination =
                        WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
                    destination.texture = state.skybox_texture;
                    destination.mipLevel = mip;
                    destination.origin = {0, 0, face};
                    WGPUTexelCopyBufferLayout layout{};
                    layout.bytesPerRow = mip_size * 8;
                    layout.rowsPerImage = mip_size;
                    const WGPUExtent3D size{mip_size, mip_size, 1};
                    wgpuQueueWriteTexture(
                        state.queue,
                        &destination,
                        data.bytes.data() + offset,
                        byte_size,
                        &layout,
                        &size);
                });
            WGPUTextureViewDescriptor view_descriptor =
                WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
            view_descriptor.dimension = WGPUTextureViewDimension_Cube;
            view_descriptor.arrayLayerCount = 6;
            state.skybox_texture_view = create_dawn_texture_view(
                state.skybox_texture,
                &view_descriptor);
            skybox_view = state.skybox_texture_view;
        }

        std::array<WGPUVertexAttribute, base_vertex_attribute_count>
            attributes{};
        fill_base_vertex_attributes(attributes.data());
        std::array<WGPUVertexBufferLayout, 2> vertex_layouts{};
        vertex_layouts[0].stepMode = WGPUVertexStepMode_Vertex;
        vertex_layouts[0].arrayStride = sizeof(GpuVertex);
        vertex_layouts[0].attributeCount = attributes.size();
        vertex_layouts[0].attributes = attributes.data();
#if BBLITE_GPU_INSTANCING
        std::array<WGPUVertexAttribute, 4> instance_attributes{};
        for (std::uint32_t column = 0; column < 4; ++column) {
            instance_attributes[column].format =
                WGPUVertexFormat_Float32x4;
            instance_attributes[column].offset = column * 16;
            instance_attributes[column].shaderLocation = 16 + column;
        }
        vertex_layouts[1].stepMode = WGPUVertexStepMode_Instance;
        vertex_layouts[1].arrayStride = sizeof(std::array<float, 16>);
        vertex_layouts[1].attributeCount = instance_attributes.size();
        vertex_layouts[1].attributes = instance_attributes.data();
        constexpr std::uint32_t skybox_vertex_buffer_count = 2;
#else
        constexpr std::uint32_t skybox_vertex_buffer_count = 1;
#endif
        WGPUVertexAttribute dds_position_attribute{};
        dds_position_attribute.format = WGPUVertexFormat_Float32x3;
        dds_position_attribute.offset = 0;
        dds_position_attribute.shaderLocation = 0;
        WGPUVertexBufferLayout dds_vertex_layout{};
        dds_vertex_layout.stepMode = WGPUVertexStepMode_Vertex;
        dds_vertex_layout.arrayStride = sizeof(GpuVertex);
        dds_vertex_layout.attributeCount = 1;
        dds_vertex_layout.attributes = &dds_position_attribute;
        WGPURenderPipelineDescriptor descriptor =
            WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
        descriptor.vertex.module = pinned_dds_skybox
            ? state.skybox_vertex_module
            : state.vertex_module;
        descriptor.vertex.entryPoint = string_view("mainVertex");
        descriptor.vertex.bufferCount = pinned_dds_skybox
            ? 1
            : skybox_vertex_buffer_count;
        descriptor.vertex.buffers = pinned_dds_skybox
            ? &dds_vertex_layout
            : vertex_layouts.data();
        descriptor.primitive.topology =
            WGPUPrimitiveTopology_TriangleList;
        descriptor.primitive.frontFace = WGPUFrontFace_CCW;
        // `skybox_layer_culls_back` states why the cube must cull.
        descriptor.primitive.cullMode =
            skybox_layer_culls_back(SkyboxLayer::environment)
                ? WGPUCullMode_Back
                : WGPUCullMode_None;
        WGPUDepthStencilState depth_stencil =
            WGPU_DEPTH_STENCIL_STATE_INIT;
        depth_stencil.format = WGPUTextureFormat_Depth24PlusStencil8;
        depth_stencil.depthWriteEnabled = WGPUOptionalBool_False;
        depth_stencil.depthCompare =
        dawn_depth_compare(upstream::pinned_depth_compare);
        descriptor.depthStencil = &depth_stencil;
        descriptor.multisample.count = state.sample_count;
        descriptor.multisample.mask = ~0u;
        WGPUColorTargetState color_target =
            WGPU_COLOR_TARGET_STATE_INIT;
        color_target.format = state.frame_color_format;
        WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
        fragment.module = state.skybox_module;
        fragment.entryPoint = string_view("mainFragment");
        fragment.targetCount = 1;
        fragment.targets = &color_target;
        descriptor.fragment = &fragment;
        state.skybox_pipeline =
            wgpuDeviceCreateRenderPipeline(state.device, &descriptor);
        if (!state.skybox_pipeline) {
            dawn_error("skybox pipeline creation failed.");
        }

        state.skybox_matrix = create_buffer(
            state,
            WGPUBufferUsage_Uniform,
            nullptr,
            pinned_dds_skybox
                ? sizeof(upstream::SkyboxVertexUniforms)
                : 64);
        state.skybox_uniforms = create_buffer(
            state,
            WGPUBufferUsage_Uniform,
            nullptr,
            (sizeof(upstream::SkyboxUniforms) + 15) & ~15ull);
        state.skybox_scene_group = skybox_scene_group_over(state, state.skybox_matrix, pinned_dds_skybox);
#if BBLITE_GPU_MORPH_STORAGE
        if (!pinned_dds_skybox) {
            DawnBindGroupLayout morph_layout{wgpuRenderPipelineGetBindGroupLayout(
                    state.skybox_pipeline, 0)};
            std::array<WGPUBindGroupEntry, 2> morph_entries{};
            morph_entries[0] = WGPU_BIND_GROUP_ENTRY_INIT;
            morph_entries[0].binding = 0;
            morph_entries[0].buffer = state.empty_morph_deltas;
            morph_entries[0].size = WGPU_WHOLE_SIZE;
            morph_entries[1] = WGPU_BIND_GROUP_ENTRY_INIT;
            morph_entries[1].binding = 1;
            morph_entries[1].buffer = state.empty_morph_weights;
            morph_entries[1].size = WGPU_WHOLE_SIZE;
            WGPUBindGroupDescriptor morph_descriptor =
                WGPU_BIND_GROUP_DESCRIPTOR_INIT;
            morph_descriptor.layout = morph_layout;
            morph_descriptor.entryCount = morph_entries.size();
            morph_descriptor.entries = morph_entries.data();
            state.skybox_morph_group = wgpuDeviceCreateBindGroup(
                state.device,
                &morph_descriptor);
            morph_layout.reset();
        }
#endif
        DawnBindGroupLayout texture_layout{wgpuRenderPipelineGetBindGroupLayout(
                state.skybox_pipeline, 2)};
        std::array<WGPUBindGroupEntry, 2> texture_entries{};
        texture_entries[0] = WGPU_BIND_GROUP_ENTRY_INIT;
        texture_entries[0].binding = 0;
        texture_entries[0].textureView = skybox_view;
        texture_entries[1] = WGPU_BIND_GROUP_ENTRY_INIT;
        texture_entries[1].binding = 1;
        texture_entries[1].sampler = state.clamp_sampler;
        WGPUBindGroupDescriptor texture_descriptor =
            WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        texture_descriptor.layout = texture_layout;
        texture_descriptor.entryCount = texture_entries.size();
        texture_descriptor.entries = texture_entries.data();
        state.skybox_texture_group =
            wgpuDeviceCreateBindGroup(state.device, &texture_descriptor);
        texture_layout.reset();
        DawnBindGroupLayout material_layout{wgpuRenderPipelineGetBindGroupLayout(
                state.skybox_pipeline, 3)};
        WGPUBindGroupEntry material_entry = WGPU_BIND_GROUP_ENTRY_INIT;
        material_entry.binding = 0;
        material_entry.buffer = state.skybox_uniforms;
        material_entry.size =
            (sizeof(upstream::SkyboxUniforms) + 15) & ~15ull;
        WGPUBindGroupDescriptor material_descriptor =
            WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        material_descriptor.layout = material_layout;
        material_descriptor.entryCount = 1;
        material_descriptor.entries = &material_entry;
        state.skybox_material_group =
            wgpuDeviceCreateBindGroup(state.device, &material_descriptor);
        material_layout.reset();
        state.skybox_enabled = true;
    }

#if BBLITE_SOLID_SKYBOX
    if (
        scene.environment.has_solid_skybox &&
        background_enabled) {
        state.solid_skybox_vertex_module =
            load_wgsl_module(state, "solid-skybox.vert");
        state.solid_skybox_fragment_module =
            load_wgsl_module(state, "solid-skybox.frag");
        const upstream::SolidSkyboxPlan solid_skybox_plan =
            upstream::build_solid_skybox_plan(scene.environment);
        state.solid_skybox_vertices = create_buffer(
            state,
            WGPUBufferUsage_Vertex,
            solid_skybox_plan.positions.data(),
            sizeof(solid_skybox_plan.positions));
        state.solid_skybox_indices = create_buffer(
            state,
            WGPUBufferUsage_Index,
            solid_skybox_plan.indices.data(),
            sizeof(solid_skybox_plan.indices));
        state.solid_skybox_scene_uniforms = create_buffer(
            state,
            WGPUBufferUsage_Uniform,
            nullptr,
            (sizeof(upstream::SolidSkyboxSceneUniforms) + 15) & ~15ull);
        state.solid_skybox_mesh_uniforms = create_buffer(
            state,
            WGPUBufferUsage_Uniform,
            nullptr,
            (sizeof(upstream::SolidSkyboxUniforms) + 15) & ~15ull);

        WGPUVertexAttribute position_attribute{};
        position_attribute.format = WGPUVertexFormat_Float32x3;
        position_attribute.offset = 0;
        position_attribute.shaderLocation = 0;
        WGPUVertexBufferLayout vertex_layout{};
        vertex_layout.stepMode = WGPUVertexStepMode_Vertex;
        vertex_layout.arrayStride = sizeof(float) * 3;
        vertex_layout.attributeCount = 1;
        vertex_layout.attributes = &position_attribute;
        WGPURenderPipelineDescriptor descriptor =
            WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
        descriptor.vertex.module = state.solid_skybox_vertex_module;
        descriptor.vertex.entryPoint = string_view("mainVertex");
        descriptor.vertex.bufferCount = 1;
        descriptor.vertex.buffers = &vertex_layout;
        descriptor.primitive.topology =
            WGPUPrimitiveTopology_TriangleList;
        descriptor.primitive.frontFace = WGPUFrontFace_CCW;
        // The shared back-cull rule (`skybox_layer_culls_back`), which
        // background-solid-skybox.ts does not override.
        descriptor.primitive.cullMode =
            skybox_layer_culls_back(SkyboxLayer::solid)
                ? WGPUCullMode_Back
                : WGPUCullMode_None;
        WGPUDepthStencilState depth_stencil =
            WGPU_DEPTH_STENCIL_STATE_INIT;
        depth_stencil.format =
            WGPUTextureFormat_Depth24PlusStencil8;
        depth_stencil.depthWriteEnabled = WGPUOptionalBool_False;
        depth_stencil.depthCompare =
        dawn_depth_compare(upstream::pinned_depth_compare);
        descriptor.depthStencil = &depth_stencil;
        descriptor.multisample.count = state.sample_count;
        descriptor.multisample.mask = ~0u;
        WGPUColorTargetState color_target =
            WGPU_COLOR_TARGET_STATE_INIT;
        color_target.format = state.frame_color_format;
        WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
        fragment.module = state.solid_skybox_fragment_module;
        fragment.entryPoint = string_view("mainFragment");
        fragment.targetCount = 1;
        fragment.targets = &color_target;
        descriptor.fragment = &fragment;
        state.solid_skybox_pipeline =
            wgpuDeviceCreateRenderPipeline(state.device, &descriptor);
        if (!state.solid_skybox_pipeline) {
            dawn_error("solid skybox pipeline creation failed.");
        }

        DawnBindGroupLayout scene_layout{wgpuRenderPipelineGetBindGroupLayout(
                state.solid_skybox_pipeline, 1)};
        std::array<WGPUBindGroupEntry, 2> scene_entries{};
        scene_entries[0] = WGPU_BIND_GROUP_ENTRY_INIT;
        scene_entries[0].binding = 0;
        scene_entries[0].buffer = state.solid_skybox_scene_uniforms;
        scene_entries[0].size =
            sizeof(upstream::SolidSkyboxSceneUniforms);
        scene_entries[1] = WGPU_BIND_GROUP_ENTRY_INIT;
        scene_entries[1].binding = 1;
        scene_entries[1].buffer = state.solid_skybox_mesh_uniforms;
        scene_entries[1].size = sizeof(upstream::SolidSkyboxUniforms);
        WGPUBindGroupDescriptor scene_descriptor =
            WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        scene_descriptor.layout = scene_layout;
        scene_descriptor.entryCount = scene_entries.size();
        scene_descriptor.entries = scene_entries.data();
        state.solid_skybox_scene_group =
            wgpuDeviceCreateBindGroup(state.device, &scene_descriptor);
        scene_layout.reset();

        DawnBindGroupLayout material_layout{wgpuRenderPipelineGetBindGroupLayout(
                state.solid_skybox_pipeline, 3)};
        WGPUBindGroupEntry material_entry =
            WGPU_BIND_GROUP_ENTRY_INIT;
        material_entry.binding = 0;
        material_entry.buffer = state.solid_skybox_mesh_uniforms;
        material_entry.size = sizeof(upstream::SolidSkyboxUniforms);
        WGPUBindGroupDescriptor material_descriptor =
            WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        material_descriptor.layout = material_layout;
        material_descriptor.entryCount = 1;
        material_descriptor.entries = &material_entry;
        state.solid_skybox_material_group =
            wgpuDeviceCreateBindGroup(
                state.device,
                &material_descriptor);
        material_layout.reset();
        state.solid_skybox_enabled = true;
    }
#endif
#if BBLITE_IMAGE_SKYBOX
    if (
        scene.environment.has_image_skybox &&
        background_enabled) {
        state.image_skybox_vertex_module =
            load_wgsl_module(state, "skybox-cubemap.vert");
        state.image_skybox_fragment_module =
            load_wgsl_module(state, "skybox-cubemap.frag");
        const upstream::ImageSkyboxPlan image_skybox_plan =
            upstream::build_image_skybox_plan(scene.environment);
        state.image_skybox_vertices = create_buffer(
            state,
            WGPUBufferUsage_Vertex,
            image_skybox_plan.positions.data(),
            sizeof(image_skybox_plan.positions));
        state.image_skybox_indices = create_buffer(
            state,
            WGPUBufferUsage_Index,
            image_skybox_plan.indices.data(),
            sizeof(image_skybox_plan.indices));
        state.image_skybox_uniforms = create_buffer(
            state,
            WGPUBufferUsage_Uniform,
            nullptr,
            (sizeof(upstream::ImageSkyboxUniforms) + 15) & ~15ull);
        state.image_skybox_texture = upload_reflection_cube(
            state,
            scene.environment.image_skybox_faces);
        WGPUTextureViewDescriptor view_descriptor =
            WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
        view_descriptor.dimension = WGPUTextureViewDimension_Cube;
        view_descriptor.arrayLayerCount = 6;
        state.image_skybox_texture_view = create_dawn_texture_view(
            state.image_skybox_texture,
            &view_descriptor);

        WGPUVertexAttribute position_attribute{};
        position_attribute.format = WGPUVertexFormat_Float32x3;
        position_attribute.offset = 0;
        position_attribute.shaderLocation = 0;
        WGPUVertexBufferLayout vertex_layout{};
        vertex_layout.stepMode = WGPUVertexStepMode_Vertex;
        vertex_layout.arrayStride = sizeof(float) * 3;
        vertex_layout.attributeCount = 1;
        vertex_layout.attributes = &position_attribute;
        WGPURenderPipelineDescriptor descriptor =
            WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
        descriptor.vertex.module =
            state.image_skybox_vertex_module;
        descriptor.vertex.entryPoint = string_view("mainVertex");
        descriptor.vertex.bufferCount = 1;
        descriptor.vertex.buffers = &vertex_layout;
        descriptor.primitive.topology =
            WGPUPrimitiveTopology_TriangleList;
        descriptor.primitive.frontFace = WGPUFrontFace_CCW;
        descriptor.primitive.cullMode =
            skybox_layer_culls_back(SkyboxLayer::image)
                ? WGPUCullMode_Back
                : WGPUCullMode_None;
        WGPUDepthStencilState depth_stencil =
            WGPU_DEPTH_STENCIL_STATE_INIT;
        depth_stencil.format =
            WGPUTextureFormat_Depth24PlusStencil8;
        depth_stencil.depthWriteEnabled = WGPUOptionalBool_True;
        depth_stencil.depthCompare =
        dawn_depth_compare(upstream::pinned_depth_compare);
        descriptor.depthStencil = &depth_stencil;
        descriptor.multisample.count = state.sample_count;
        descriptor.multisample.mask = ~0u;
        WGPUColorTargetState color_target =
            WGPU_COLOR_TARGET_STATE_INIT;
        color_target.format = state.frame_color_format;
        WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
        fragment.module = state.image_skybox_fragment_module;
        fragment.entryPoint = string_view("mainFragment");
        fragment.targetCount = 1;
        fragment.targets = &color_target;
        descriptor.fragment = &fragment;
        state.image_skybox_pipeline =
            wgpuDeviceCreateRenderPipeline(state.device, &descriptor);
        if (!state.image_skybox_pipeline) {
            dawn_error("image skybox pipeline creation failed.");
        }

        DawnBindGroupLayout scene_layout{wgpuRenderPipelineGetBindGroupLayout(
                state.image_skybox_pipeline, 1)};
        WGPUBindGroupEntry scene_entry = WGPU_BIND_GROUP_ENTRY_INIT;
        scene_entry.binding = 0;
        scene_entry.buffer = state.view_projection;
        scene_entry.size = 64;
        WGPUBindGroupDescriptor scene_descriptor =
            WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        scene_descriptor.layout = scene_layout;
        scene_descriptor.entryCount = 1;
        scene_descriptor.entries = &scene_entry;
        state.image_skybox_scene_group =
            wgpuDeviceCreateBindGroup(state.device, &scene_descriptor);
        scene_layout.reset();

        DawnBindGroupLayout texture_layout{wgpuRenderPipelineGetBindGroupLayout(
                state.image_skybox_pipeline, 2)};
        std::array<WGPUBindGroupEntry, 2> texture_entries{};
        texture_entries[0] = WGPU_BIND_GROUP_ENTRY_INIT;
        texture_entries[0].binding = 0;
        texture_entries[0].textureView =
            state.image_skybox_texture_view;
        texture_entries[1] = WGPU_BIND_GROUP_ENTRY_INIT;
        texture_entries[1].binding = 1;
        texture_entries[1].sampler = state.default_sampler;
        WGPUBindGroupDescriptor texture_descriptor =
            WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        texture_descriptor.layout = texture_layout;
        texture_descriptor.entryCount = texture_entries.size();
        texture_descriptor.entries = texture_entries.data();
        state.image_skybox_texture_group =
            wgpuDeviceCreateBindGroup(
                state.device,
                &texture_descriptor);
        texture_layout.reset();

        DawnBindGroupLayout material_layout{wgpuRenderPipelineGetBindGroupLayout(
                state.image_skybox_pipeline, 3)};
        WGPUBindGroupEntry material_entry =
            WGPU_BIND_GROUP_ENTRY_INIT;
        material_entry.binding = 0;
        material_entry.buffer = state.image_skybox_uniforms;
        material_entry.size =
            sizeof(upstream::ImageSkyboxUniforms);
        WGPUBindGroupDescriptor material_descriptor =
            WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        material_descriptor.layout = material_layout;
        material_descriptor.entryCount = 1;
        material_descriptor.entries = &material_entry;
        state.image_skybox_material_group =
            wgpuDeviceCreateBindGroup(
                state.device,
                &material_descriptor);
        material_layout.reset();
        state.image_skybox_enabled = true;
    }
#endif

    if (use_ground) {
        state.ground_module = load_wgsl_module(
            state,
            pal::background_ground_fragment(scene.environment));
        const upstream::BackgroundPlan background =
            upstream::build_background_plan(scene.environment);
        std::array<GpuVertex, 4> ground_quad{};
        for (std::size_t index = 0; index < ground_quad.size(); ++index) {
            ground_quad[index] =
                gpu_vertex_from(background.vertices[index]);
        }
        state.ground_vertices = create_buffer(
            state,
            WGPUBufferUsage_Vertex,
            ground_quad.data(),
            sizeof(ground_quad));
        state.ground_indices = create_buffer(
            state,
            WGPUBufferUsage_Index,
            background.indices.data(),
            sizeof(background.indices));
        std::uint32_t ground_mips = 1;
        state.ground_texture = upload_material_texture(
            state,
            scene.environment.ground_texture,
            false,
            {255, 255, 255, 255},
            ground_mips);
        state.ground_texture_view =
            create_dawn_texture_view(state.ground_texture, nullptr);

        std::array<WGPUVertexAttribute, base_vertex_attribute_count>
            attributes{};
        fill_base_vertex_attributes(attributes.data());
        std::array<WGPUVertexBufferLayout, 2> vertex_layouts{};
        vertex_layouts[0].stepMode = WGPUVertexStepMode_Vertex;
        vertex_layouts[0].arrayStride = sizeof(GpuVertex);
        vertex_layouts[0].attributeCount = attributes.size();
        vertex_layouts[0].attributes = attributes.data();
#if BBLITE_GPU_INSTANCING
        std::array<WGPUVertexAttribute, 4> instance_attributes{};
        for (std::uint32_t column = 0; column < 4; ++column) {
            instance_attributes[column].format =
                WGPUVertexFormat_Float32x4;
            instance_attributes[column].offset = column * 16;
            instance_attributes[column].shaderLocation = 16 + column;
        }
        vertex_layouts[1].stepMode = WGPUVertexStepMode_Instance;
        vertex_layouts[1].arrayStride = sizeof(std::array<float, 16>);
        vertex_layouts[1].attributeCount = instance_attributes.size();
        vertex_layouts[1].attributes = instance_attributes.data();
        constexpr std::uint32_t ground_vertex_buffer_count = 2;
#else
        constexpr std::uint32_t ground_vertex_buffer_count = 1;
#endif
        WGPURenderPipelineDescriptor descriptor =
            WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
        descriptor.vertex.module = state.vertex_module;
        descriptor.vertex.entryPoint = string_view("mainVertex");
        descriptor.vertex.bufferCount = ground_vertex_buffer_count;
        descriptor.vertex.buffers = vertex_layouts.data();
        descriptor.primitive.topology =
            WGPUPrimitiveTopology_TriangleList;
        descriptor.primitive.frontFace = WGPUFrontFace_CCW;
        descriptor.primitive.cullMode = WGPUCullMode_Back;
        WGPUDepthStencilState depth_stencil =
            WGPU_DEPTH_STENCIL_STATE_INIT;
        depth_stencil.format = WGPUTextureFormat_Depth24PlusStencil8;
        depth_stencil.depthWriteEnabled = WGPUOptionalBool_False;
        depth_stencil.depthCompare =
        dawn_depth_compare(upstream::pinned_depth_compare);
        descriptor.depthStencil = &depth_stencil;
        descriptor.multisample.count = state.sample_count;
        descriptor.multisample.mask = ~0u;
        WGPUColorTargetState color_target =
            WGPU_COLOR_TARGET_STATE_INIT;
        color_target.format = state.frame_color_format;
        const WGPUBlendState blend = blend_state_from(ground_blend);
        color_target.blend = &blend;
        WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
        fragment.module = state.ground_module;
        fragment.entryPoint = string_view("mainFragment");
        fragment.targetCount = 1;
        fragment.targets = &color_target;
        descriptor.fragment = &fragment;
        state.ground_pipeline =
            wgpuDeviceCreateRenderPipeline(state.device, &descriptor);
        if (!state.ground_pipeline) {
            dawn_error("ground pipeline creation failed.");
        }

        state.ground_uniforms = create_buffer(
            state,
            WGPUBufferUsage_Uniform,
            nullptr,
            (sizeof(upstream::BackgroundUniforms) + 15) & ~15ull);
        DawnBindGroupLayout scene_layout{wgpuRenderPipelineGetBindGroupLayout(
                state.ground_pipeline, 1)};
        std::array<WGPUBindGroupEntry, 3> scene_entries{};
        scene_entries[0] = WGPU_BIND_GROUP_ENTRY_INIT;
        scene_entries[0].binding = 0;
        scene_entries[0].buffer = state.view_projection;
        scene_entries[0].size = 64;
        std::uint32_t scene_entry_count = 1;
#if BBLITE_GPU_DEFORMATION
        ensure_background_deformation_uniforms(state);
        scene_entries[scene_entry_count] =
            WGPU_BIND_GROUP_ENTRY_INIT;
        scene_entries[scene_entry_count].binding = 1;
        scene_entries[scene_entry_count].buffer =
            state.background_deformation_uniforms;
        scene_entries[scene_entry_count].size =
            sizeof(DeformationUniforms);
        ++scene_entry_count;
#endif
#if BBLITE_GPU_INSTANCING
        ensure_background_instance_resources(state);
        scene_entries[scene_entry_count] =
            WGPU_BIND_GROUP_ENTRY_INIT;
        scene_entries[scene_entry_count].binding =
            instance_uniform_binding;
        scene_entries[scene_entry_count].buffer =
            state.background_instance_uniform;
        scene_entries[scene_entry_count].size = 64;
        ++scene_entry_count;
#endif
        WGPUBindGroupDescriptor scene_descriptor =
            WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        scene_descriptor.layout = scene_layout;
        scene_descriptor.entryCount = scene_entry_count;
        scene_descriptor.entries = scene_entries.data();
        state.ground_scene_group =
            wgpuDeviceCreateBindGroup(state.device, &scene_descriptor);
        scene_layout.reset();
#if BBLITE_GPU_MORPH_STORAGE
        {
            DawnBindGroupLayout morph_layout{wgpuRenderPipelineGetBindGroupLayout(
                    state.ground_pipeline, 0)};
            std::array<WGPUBindGroupEntry, 2> morph_entries{};
            morph_entries[0] = WGPU_BIND_GROUP_ENTRY_INIT;
            morph_entries[0].binding = 0;
            morph_entries[0].buffer = state.empty_morph_deltas;
            morph_entries[0].size = WGPU_WHOLE_SIZE;
            morph_entries[1] = WGPU_BIND_GROUP_ENTRY_INIT;
            morph_entries[1].binding = 1;
            morph_entries[1].buffer = state.empty_morph_weights;
            morph_entries[1].size = WGPU_WHOLE_SIZE;
            WGPUBindGroupDescriptor morph_descriptor =
                WGPU_BIND_GROUP_DESCRIPTOR_INIT;
            morph_descriptor.layout = morph_layout;
            morph_descriptor.entryCount = morph_entries.size();
            morph_descriptor.entries = morph_entries.data();
            state.ground_morph_group = wgpuDeviceCreateBindGroup(
                state.device,
                &morph_descriptor);
            morph_layout.reset();
        }
#endif
        DawnBindGroupLayout texture_layout{wgpuRenderPipelineGetBindGroupLayout(
                state.ground_pipeline, 2)};
        std::array<WGPUBindGroupEntry, 2> texture_entries{};
        texture_entries[0] = WGPU_BIND_GROUP_ENTRY_INIT;
        texture_entries[0].binding = 0;
        texture_entries[0].textureView = state.ground_texture_view;
        texture_entries[1] = WGPU_BIND_GROUP_ENTRY_INIT;
        texture_entries[1].binding = 1;
        texture_entries[1].sampler = state.ground_sampler;
        WGPUBindGroupDescriptor texture_descriptor =
            WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        texture_descriptor.layout = texture_layout;
        texture_descriptor.entryCount = texture_entries.size();
        texture_descriptor.entries = texture_entries.data();
        state.ground_texture_group =
            wgpuDeviceCreateBindGroup(state.device, &texture_descriptor);
        texture_layout.reset();
        DawnBindGroupLayout material_layout{wgpuRenderPipelineGetBindGroupLayout(
                state.ground_pipeline, 3)};
        WGPUBindGroupEntry material_entry = WGPU_BIND_GROUP_ENTRY_INIT;
        material_entry.binding = 0;
        material_entry.buffer = state.ground_uniforms;
        material_entry.size =
            (sizeof(upstream::BackgroundUniforms) + 15) & ~15ull;
        WGPUBindGroupDescriptor material_descriptor =
            WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        material_descriptor.layout = material_layout;
        material_descriptor.entryCount = 1;
        material_descriptor.entries = &material_entry;
        state.ground_material_group =
            wgpuDeviceCreateBindGroup(state.device, &material_descriptor);
        material_layout.reset();
        state.ground_enabled = true;
    }
}

#if defined(BBLITE_HAS_PBR_RENDERER) && BBLITE_HAS_PBR_RENDERER
DawnMesh upload_dawn_scene_mesh(
    DawnState& state, Engine& engine, const upstream::RenderItem& item) {
    const ModelGeometry& geometry = engine.geometries[item.geometry];
    const MeshRecord& mesh_record = handle_at(engine.meshes, item.mesh);
    const bool use_source_indices = mesh_record.detached_imported_mesh
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
        || item.material_kind == upstream::RenderMaterialKind::node
#endif
        ;
    std::vector<std::uint32_t> source_indices;
    if (use_source_indices && geometry.source_indices_reversed) {
        node_source_indices(geometry, source_indices);
    }
    const auto& upload_indices = source_indices.empty() ? geometry.indices : source_indices;
    const bool shader_material =
        item.material_kind ==
        upstream::RenderMaterialKind::shader;
    const std::vector<GpuVertex> vertices =
        shader_material
            ? local_vertices(engine, geometry, &mesh_record)
            : transformed_vertices(engine, geometry, mesh_record);
    DawnMesh mesh(state);
    if (shader_material) {
#if BBLITE_MESH_POSITION_UPDATE
        // Mutable procedural geometry must own its upload instead of
        // borrowing the immutable shader-geometry cache.
        mesh.vertices = create_buffer(
            state,
            WGPUBufferUsage_Vertex,
            vertices.data(),
            vertices.size() * sizeof(GpuVertex));
        mesh.indices = create_buffer(
            state,
            WGPUBufferUsage_Index,
            upload_indices.data(),
            upload_indices.size() * sizeof(std::uint32_t));
#else
        const SharedGeometryIdentity identity =
            shared_geometry_identity(vertices, upload_indices);
        mesh.shared_geometry = find_shared_shader_geometry(
            state.shared_shader_geometries,
            identity,
            vertices,
            upload_indices);
        if (!mesh.shared_geometry) {
            const bool keep_bytes = shared_geometry_keeps_bytes(vertices);
            auto created = std::make_unique<DawnSharedShaderGeometry>(
                DawnSharedShaderGeometry{
                    .identity = identity,
                    .vertices = keep_bytes
                        ? vertices
                        : std::vector<GpuVertex>{},
                    .indices = keep_bytes
                        ? upload_indices
                        : std::vector<std::uint32_t>{},
                });
            state.shared_shader_geometries.push_back(std::move(created));
            mesh.shared_geometry = state.shared_shader_geometries.back().get();
        }
        ++mesh.shared_geometry->users;
        mesh.owns_geometry_buffers = false;
        if (!mesh.shared_geometry->vertex_buffer) {
            mesh.shared_geometry->vertex_buffer = create_buffer(
                state,
                WGPUBufferUsage_Vertex,
                vertices.data(),
                vertices.size() * sizeof(GpuVertex));
            mesh.shared_geometry->index_buffer = create_buffer(
                state,
                WGPUBufferUsage_Index,
                upload_indices.data(),
                upload_indices.size() * sizeof(std::uint32_t));
        }
        mesh.vertices = mesh.shared_geometry->vertex_buffer;
        mesh.indices = mesh.shared_geometry->index_buffer;
#endif
    } else {
        mesh.vertices = create_buffer(
            state,
            WGPUBufferUsage_Vertex,
            vertices.data(),
            vertices.size() * sizeof(GpuVertex));
        mesh.indices = create_buffer(
            state,
            WGPUBufferUsage_Index,
            upload_indices.data(), upload_indices.size() * sizeof(std::uint32_t));
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
        if (item.material_kind == upstream::RenderMaterialKind::node) {
            state.node_capture.upload(mesh.vertices, "node-vertices", vertices.data(), vertices.size() * sizeof(GpuVertex));
            state.node_capture.upload(mesh.indices, "node-indices", upload_indices.data(), upload_indices.size() * sizeof(std::uint32_t));
        }
#endif
    }
#if BBLITE_PBR_VARIANTS > 0
    if (
        item.material_kind ==
        upstream::RenderMaterialKind::pbr) {
        const std::vector<GpuVertex> pinned =
            pinned_convention_vertices(vertices, mesh_record.mirrored_x);
        mesh.pinned_vertices = create_buffer(
            state,
            WGPUBufferUsage_Vertex,
            pinned.data(),
            pinned.size() * sizeof(GpuVertex));
    }
#endif
    mesh.index_count =
        static_cast<std::uint32_t>(geometry.indices.size());
#if BBLITE_GPU_DEFORMATION
    mesh.deformation_uniforms = create_buffer(
        state,
        WGPUBufferUsage_Uniform,
        nullptr,
        sizeof(DeformationUniforms));
#endif
#if BBLITE_GPU_MORPH_STORAGE
    mesh.morph_deltas = state.empty_morph_deltas;
    mesh.morph_weights = state.empty_morph_weights;
    if (
        mesh_record.gpu_deformation &&
        !geometry.morph_positions.empty()) {
        mesh.morph_deltas = nullptr;
        mesh.morph_weights = nullptr;
        mesh.owns_morph_buffers = true;
        const std::vector<float> deltas =
            pack_morph_deltas(geometry);
        mesh.morph_deltas = create_buffer(
            state,
            WGPUBufferUsage_Storage,
            deltas.data(),
            deltas.size() * sizeof(float));
        const std::vector<std::uint8_t> weights_blob =
            pack_morph_weights(geometry, mesh_record);
        mesh.morph_weights = create_buffer(
            state,
            WGPUBufferUsage_Storage,
            weights_blob.data(),
            weights_blob.size());
        mesh.morph_weights_version =
            mesh_record.morph_weights_version;
    }
#endif
#if BBLITE_GPU_INSTANCING
    {
        std::vector<std::array<float, 16>> instance_matrices =
            mesh_record.instance_matrices;
        if (instance_matrices.empty()) {
            std::array<float, 16> identity{};
            identity[0] = 1.0f;
            identity[5] = 1.0f;
            identity[10] = 1.0f;
            identity[15] = 1.0f;
            instance_matrices.push_back(identity);
        }
        // The buffer holds the full capacity pool; dynamic pools
        // draw the record count and re-upload through the frame
        // loop's version-gated mesh-sync pass.
        mesh.instances = create_buffer(
            state,
            WGPUBufferUsage_Vertex | WGPUBufferUsage_Storage,
            instance_matrices.data(),
            instance_matrices.size() *
                sizeof(instance_matrices.front()));
        mesh.instance_count =
            mesh_record.thin_instanced
                ? mesh_record.instance_count
                : static_cast<std::uint32_t>(
                      instance_matrices.size());
        mesh.instance_version =
            mesh_record.instance_version;
        mesh.instance_capacity =
            static_cast<std::uint32_t>(instance_matrices.size());
        mesh.instance_uniform = create_buffer(
            state,
            WGPUBufferUsage_Uniform,
            nullptr,
            64);
#if BBLITE_GPU_INSTANCE_COLORS
        {
            // One tightly-packed RGBA row per matrix-pool slot. A
            // colour setter may first run after registration, so the
            // fallback must reserve the established capacity, not one
            // row, before the versioned upload fills it.
            std::vector<float> instance_colors =
                instance_colors_for_upload(mesh_record);
            instance_colors.resize(
                std::max(
                    instance_colors.size(),
                    instance_matrices.size() * 4),
                1.0f);
            mesh.instance_colors = create_buffer(
                state,
                WGPUBufferUsage_Vertex,
                instance_colors.data(),
                instance_colors.size() * sizeof(float));
        }
#endif
#if BBLITE_PBR_VARIANTS > 0
        if (!mesh_record.instance_matrices.empty()) {
            // PBR's pinned vertex stream needs the mirror-conjugated
            // matrix stream for both glTF and scene-code pools. The
            // ordinary/Standard stream above keeps the record bytes.
            const std::vector<std::array<float, 16>>
                pinned_matrices =
                    pinned_instance_matrices(mesh_record);
            mesh.pinned_instances = create_buffer(
                state,
                WGPUBufferUsage_Vertex,
                pinned_matrices.data(),
                pinned_matrices.size() *
                    sizeof(pinned_matrices.front()));
        }
#endif
    }
#endif
    const upstream::ShaderVariantInfo* mesh_shader_info =
        item.material_kind ==
            upstream::RenderMaterialKind::shader
            ? &upstream::shader_variant_info(
                  item.shader_variant)
            : nullptr;
    // A Standard item's blocks live in the pinned standard buffers,
    // so the transcribed material buffer is a 16-byte stub for it.
    mesh.material_uniform_size =
        ((item.material_kind ==
                  upstream::RenderMaterialKind::standard
              ? 16ull
              : item.material_kind ==
                      upstream::RenderMaterialKind::grid
                  ? sizeof(upstream::GridUniforms)
                  : mesh_shader_info
                      ? std::max<std::uint64_t>(
                            mesh_shader_info->fragment
                                    .float_size *
                                4ull,
                            16ull)
                      // The pinned material blocks own every PBR
                      // draw; like the Standard arm this buffer is
                      // never written for them, so it stays a stub.
                      : 16ull) +
         15) &
        ~15ull;
    mesh.material_uniforms = create_buffer(
        state,
        WGPUBufferUsage_Uniform,
        nullptr,
        mesh.material_uniform_size);
    if (mesh_shader_info) {
        mesh.shader_vertex_uniforms = create_buffer(
            state,
            WGPUBufferUsage_Uniform,
            nullptr,
            std::max<std::uint64_t>(
                mesh_shader_info->vertex.float_size * 4ull,
                16ull));
    }
    mesh.transform_version =
        mesh_record.transform_version;
    mesh.position_version = geometry.position_version;
    mesh.gpu_world_transform =
        mesh_record.gpu_world_transform;

    // Per-slot texture selection reads the generated
    // `material_texture_slots` table -- the same rows the SDL_GPU
    // backend executes -- so which record field a slot takes, its
    // sRGB view and its fallback texel are decided once, at
    // generation; this backend keeps only the upload mechanics.
    const bool standard_material =
        item.material_kind == upstream::RenderMaterialKind::standard;
    const bool composed_material =
        item.material_kind == upstream::RenderMaterialKind::pbr ||
        standard_material;
    const MaterialRecord* material = nullptr;
    if (item.material.value < engine.materials.size()) {
        material = &handle_at(engine.materials, item.material);
        if (
            standard_material &&
            material->reflection_cube <
                state.reflection_cube_views.size()) {
            mesh.reflection =
                state.reflection_cube_views[
                    material->reflection_cube];
        }
    }
    // The explicit superset bind-group layout still needs inert values
    // for families that do not read generated PBR/Standard slots.
    mesh.views.fill(state.white_view);
    mesh.samplers.fill(state.default_sampler);
    if (composed_material) {
        const auto shared_it = std::find_if(
            state.shared_composed_material_textures.begin(),
            state.shared_composed_material_textures.end(),
            [&](const auto& candidate) {
                return candidate->material.value == item.material.value &&
                    candidate->standard_material == standard_material;
            });
        if (
            shared_it ==
            state.shared_composed_material_textures.end()) {
            auto created =
                std::make_unique<DawnSharedComposedMaterialTextures>();
            created->material = item.material;
            created->standard_material = standard_material;
            state.shared_composed_material_textures.push_back(std::move(created));
            mesh.shared_composed_textures = state.shared_composed_material_textures.back().get();
            ++mesh.shared_composed_textures->users;
            for (
                const upstream::MaterialTextureSlot& slot_row :
                upstream::material_texture_slots) {
                if (
                    slot_row.slot ==
                    upstream::material_texture_no_slot) {
                    continue;
                }
                const TextureData* slot_data = material
                    ? material_slot_texture(
                          *material,
                          slot_row.source,
                          standard_material)
                    : nullptr;
                const TextureData empty{};
                const TextureData& data =
                    slot_data ? *slot_data : empty;
                std::uint32_t mip_count = 1;
                mesh.shared_composed_textures->textures[slot_row.slot] =
                    upload_material_texture(
                        state,
                        data,
                        material_slot_srgb(
                            slot_row.srgb,
                            material,
                            standard_material),
                        material_slot_fallback(
                            slot_row.fallback,
                            material,
                            standard_material),
                        mip_count);
                mesh.shared_composed_textures->views[slot_row.slot] =
                    create_dawn_texture_view(
                        mesh.shared_composed_textures->textures[slot_row.slot],
                        nullptr);
                mesh.shared_composed_textures->samplers[slot_row.slot] =
                    create_texture_sampler(
                        state.device,
                        slot_data
                            ? slot_data->sampler
                            : TextureSamplerState{});
            }
        } else {
            mesh.shared_composed_textures = shared_it->get();
            ++mesh.shared_composed_textures->users;
        }
        for (std::size_t slot = 0; slot < mesh_texture_slots; ++slot) {
            if (mesh.shared_composed_textures->views[slot]) {
                mesh.views[slot] =
                    mesh.shared_composed_textures->views[slot];
            }
            if (mesh.shared_composed_textures->samplers[slot]) {
                mesh.samplers[slot] =
                    mesh.shared_composed_textures->samplers[slot];
            }
        }
    }
    const auto upload_shader_textures = [&](std::vector<DawnSampledTexture>& textures) {
        for (const FileTexture& texture : material->shader_textures) {
            std::uint32_t shader_mip_count = 1;
            DawnSampledTexture& sampled = textures.emplace_back();
            sampled.texture = upload_material_texture(
                state,
                texture.data,
                texture.srgb,
                {255, 255, 255, 255},
                shader_mip_count);
            sampled.view =
                create_dawn_texture_view(sampled.texture, nullptr);
            sampled.sampler = create_texture_sampler(
                state.device,
                texture.data.sampler);
        }
    };
    // A node graph's declared images take the same per-MATERIAL cache
    // the shader family uses -- keyed by handle, and a material is
    // exactly one family -- so two meshes sharing one graph decode and
    // upload its images once, as the SDL backend does. Every other
    // family's `shader_textures` list is empty, so its per-mesh upload
    // stays the no-op it always was.
    if (
        material &&
        (material->shader_material || material->node_material)) {
        mesh.shared_shader_textures =
            find_shared_shader_material_textures(
                state.shared_shader_material_textures,
                item.material);
        if (!mesh.shared_shader_textures) {
            auto created = std::make_unique<DawnSharedShaderMaterialTextures>();
            created->material = item.material;
            state.shared_shader_material_textures.push_back(std::move(created));
            mesh.shared_shader_textures = state.shared_shader_material_textures.back().get();
            ++mesh.shared_shader_textures->users;
            upload_shader_textures(mesh.shared_shader_textures->textures);
        } else {
            ++mesh.shared_shader_textures->users;
        }
    } else if (material) {
        upload_shader_textures(mesh.shader_textures);
    }
#if BBLITE_HAS_MATERIAL_PLUGIN_TEXTURES
    // The textures this material's plugins bound, uploaded once per
    // material like every other caller-owned family: the payload, its
    // own encoding and its own sampler, with the white fallback an
    // empty slot takes. The generated `standard_plugin_bindings` table
    // resolves a composed binding name to a position in this list.
    if (material && !material->plugin_textures.empty()) {
        mesh.shared_plugin_textures =
            find_shared_shader_material_textures(
                state.shared_plugin_material_textures,
                item.material);
        if (!mesh.shared_plugin_textures) {
            auto created =
                std::make_unique<DawnSharedPluginMaterialTextures>();
            created->material = item.material;
            state.shared_plugin_material_textures.push_back(std::move(created));
            mesh.shared_plugin_textures = state.shared_plugin_material_textures.back().get();
            ++mesh.shared_plugin_textures->users;
            for (
                const MaterialPluginTexture& texture :
                material->plugin_textures) {
                std::uint32_t plugin_mip_count = 1;
                DawnSampledTexture& sampled = mesh.shared_plugin_textures->textures.emplace_back();
                sampled.texture = upload_material_texture(
                    state,
                    texture.data,
                    texture.srgb,
                    {255, 255, 255, 255},
                    plugin_mip_count);
                sampled.view =
                    create_dawn_texture_view(sampled.texture, nullptr);
                sampled.sampler = create_texture_sampler(
                    state.device,
                    texture.data.sampler);
            }
        } else {
            ++mesh.shared_plugin_textures->users;
        }
    }
#endif
    return mesh;
}
#endif

#if defined(BBLITE_HAS_PBR_RENDERER) && BBLITE_HAS_PBR_RENDERER && BBLITE_HAS_PICKING
PickingInfo pick_dawn_scene(
    DawnState& state, Engine& engine, const upstream::RenderPlan& root_plan,
    const std::vector<upstream::RenderPlan>& overlay_plans,
    const std::vector<std::shared_ptr<Scene>>& active_registered_scenes,
    [[maybe_unused]] GpuPickerHandle picker, double x, double y, const Engine::PickFilter* filter
#if BBLITE_HAS_BILLBOARDS
    , DawnBillboardPickContributor& billboard_pick
#endif
) {
        const auto layer = picker_scene_index(engine, picker, active_registered_scenes);
        if (!layer) return PickingInfo{};
        const Scene& scene = *active_registered_scenes[*layer];
        const auto& render_plan = *layer == 0 ? root_plan : overlay_plans[*layer - 1];
        auto& pick_meshes = *layer == 0 ? state.meshes : state.overlay_meshes[*layer - 1];
#if BBLITE_HAS_DETAILED_PICKING
    // `picker._detailedPicking`, armed by `enableDetailedPicking`.
    const bool detailed = detailed_pick_armed(engine, picker);
#else
    constexpr bool detailed = false;
#endif
    if (scene.camera.value >= engine.cameras.size()) {
        return PickingInfo{};
    }
    const CameraRecord& camera = handle_at(engine.cameras, scene.camera);
    // Native has no CSS box, so the pin's backing/client scale is 1.
    const double width = static_cast<double>(engine.options.width);
    const double height = static_cast<double>(engine.options.height);
    if (x < 0.0 || y < 0.0 || x >= width || y >= height) {
        return PickingInfo{};
    }
    if (camera.viewport.has_value()) {
        // `pickAsync` maps the pointer through
        // `resolveCameraViewport` before it renders the candidates
        // (src/picking/gpu-picker.ts), which this port has not
        // ported: no scene reaches both. Refusing by name beats
        // picking against a frustum the pass never drew.
        dawn_error(
            "A GPU pick through a camera viewport needs the pin's "
            "resolveCameraViewport pointer mapping, which is not "
            "ported: no reached scene both picks and splits.");
    }
    const double aspect = upstream::effective_aspect_ratio(
        camera,
        width,
        height);
    const std::array<float, 16> view_projection =
        upstream::build_view_projection(camera, aspect);
    ensure_dawn_pick_targets(state.device, state.pick_targets);
    if (!state.pick_mesh_pipeline) {
        state.pick_scene_layout =
            create_dawn_pick_scene_layout(state.device);
        state.pick_mesh_layout =
            create_dawn_pick_mesh_layout(state.device);
        state.pick_mesh_pipeline = create_dawn_pick_mesh_pipeline(
            state.device,
            state.pick_scene_layout,
            state.pick_mesh_layout,
            "picking.vert",
            "picking.frag",
            2);
#if BBLITE_GPU_INSTANCING
        state.pick_thin_layout =
            create_dawn_pick_thin_layout(state.device);
        state.pick_thin_pipeline = create_dawn_pick_mesh_pipeline(
            state.device,
            state.pick_scene_layout,
            state.pick_thin_layout,
            "picking-thin.vert",
            "picking-thin.frag",
            2);
#endif
#if BBLITE_HAS_DETAILED_PICKING
        // The pin's second module, built beside the first: the picker
        // dynamic-imports whichever `_detailedPicking` selected, and
        // a picker can be armed after another has already picked.
        state.pick_detailed_pipeline = create_dawn_pick_mesh_pipeline(
            state.device,
            state.pick_scene_layout,
            state.pick_mesh_layout,
            "picking-detailed.vert",
            "picking-detailed.frag",
            pick_color_targets);
#endif
#if BBLITE_DEFORM_PICKING
        state.pick_deform_empty_layout =
            create_dawn_pick_empty_layout(state.device);
        WGPUBindGroupDescriptor empty_group =
            WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        empty_group.layout = state.pick_deform_empty_layout;
        empty_group.entryCount = 0;
        state.pick_deform_empty_group =
            wgpuDeviceCreateBindGroup(state.device, &empty_group);
        if (!state.pick_deform_empty_group) {
            dawn_error("pick deform empty bind group");
        }
        for (std::size_t index = 0; index < upstream::pick_deform_variants.size(); ++index) {
            const auto& variant = upstream::pick_deform_variants[index];
            auto& program = state.pick_deform_programs[index];
            program.layout = create_dawn_pick_deform_layout(state.device, variant);
            for (std::size_t mode = 0; mode < 2; ++mode) {
                const char* stem = mode == 0 ? variant.vertex : variant.detailed_vertex;
                if (!stem) continue;
                program.pipelines[mode] = create_dawn_pick_mesh_pipeline(
                    state.device, state.pick_scene_layout, state.pick_mesh_layout,
                    stem, mode == 0 ? "picking.frag" : "picking-detailed.frag",
                    mode == 0 ? 2u : 3u, state.pick_deform_empty_layout,
                    program.layout, variant.skeleton);
            }
        }
#endif
        WGPUBufferDescriptor scene_buffer =
            WGPU_BUFFER_DESCRIPTOR_INIT;
        scene_buffer.usage =
            WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
        scene_buffer.size = sizeof(PickSceneUniforms);
        state.pick_scene_buffer =
            wgpuDeviceCreateBuffer(state.device, &scene_buffer);
        WGPUBindGroupEntry scene_entry = WGPU_BIND_GROUP_ENTRY_INIT;
        scene_entry.binding = 0;
        scene_entry.buffer = state.pick_scene_buffer;
        scene_entry.size = sizeof(PickSceneUniforms);
        WGPUBindGroupDescriptor scene_group =
            WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        scene_group.layout = state.pick_scene_layout;
        scene_group.entryCount = 1;
        scene_group.entries = &scene_entry;
        state.pick_scene_group =
            wgpuDeviceCreateBindGroup(state.device, &scene_group);
    }

    const PickSceneUniforms scene_uniforms =
        build_pick_scene_uniforms(
            view_projection, x, y, width, height);
    wgpuQueueWriteBuffer(
        state.queue,
        state.pick_scene_buffer,
        0,
        &scene_uniforms,
        sizeof(scene_uniforms));

    // Every candidate's block is written before the pass opens,
    // because WebGPU forbids a queue write between draws inside one.
    std::vector<PickRange> ranges;
    std::vector<DawnPickMeshUniforms> blocks;
    std::uint32_t next_id = 1;
    // The shared collector owns the plan walk, the generated pick
    // predicate and the id/range assignment; only "does this row have
    // GPU buffers" is answered here. Candidate rows carry plan-item
    // indices rather than pointers: the same function pushes into
    // `state.splat_passes` below, and a raw pointer into a growing
    // vector is the shape of the bloom-composite crash.
    const std::vector<PickMeshCandidate> candidates =
        collect_pick_mesh_candidates(
            engine,
            scene,
            render_plan,
            pick_meshes.size(),
            [&](std::size_t item_index) {
                const DawnMesh& mesh = pick_meshes[item_index];
                return mesh.vertices && mesh.indices;
            },
            ranges,
            next_id,
            filter, detailed);
    // `pickAsyncImpl` takes no pick source under a supplied filter.
    [[maybe_unused]] const bool pick_sources = filter == nullptr;
    validate_pick_contributors(engine, scene, detailed, pick_sources);
#if BBLITE_DEFORM_PICKING
    for (const auto& candidate : candidates) {
        if (candidate.deform < 0) continue;
        const auto& item = render_plan.items[candidate.item_index];
        const auto& record = handle_at(engine.meshes, item.mesh);
        auto& gpu = pick_meshes[candidate.item_index];
#if BBLITE_GPU_MORPH_STORAGE
        sync_morph_weights(state, gpu, engine.geometries[item.geometry], record);
#endif
#if BBLITE_PBR_VARIANTS > 0 || defined(BBLITE_STANDARD_SKELETON)
        if (record.skinned) write_pinned_bone_texture(state, gpu, record);
#endif
    }
#endif
    blocks.reserve(candidates.size());
    for (const PickMeshCandidate& candidate : candidates) {
        // The shared block at this backend's 256-byte dynamic-offset
        // stride.
        DawnPickMeshUniforms block{};
        block.world = candidate.uniforms.world;
        block.pick_id = candidate.uniforms.pick_id;
        block.excluded_thin_instance_start =
            candidate.uniforms.excluded_thin_instance_start;
        block.excluded_thin_instance_count =
            candidate.uniforms.excluded_thin_instance_count;
        blocks.push_back(block);
    }
    if (blocks.size() > state.pick_mesh_capacity) {
#if BBLITE_GPU_INSTANCING
        state.release_thin_pick_groups();
#endif
        if (state.pick_mesh_group) {
            wgpuBindGroupRelease(state.pick_mesh_group);
            state.pick_mesh_group = nullptr;
        }
        if (state.pick_mesh_buffer) {
            wgpuBufferRelease(state.pick_mesh_buffer);
            state.pick_mesh_buffer = nullptr;
        }
        state.pick_mesh_capacity = blocks.size();
        WGPUBufferDescriptor mesh_buffer = WGPU_BUFFER_DESCRIPTOR_INIT;
        mesh_buffer.usage =
            WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
        mesh_buffer.size = static_cast<std::uint64_t>(
            state.pick_mesh_capacity * sizeof(DawnPickMeshUniforms));
        state.pick_mesh_buffer =
            wgpuDeviceCreateBuffer(state.device, &mesh_buffer);
        WGPUBindGroupEntry entry = WGPU_BIND_GROUP_ENTRY_INIT;
        entry.binding = 0;
        entry.buffer = state.pick_mesh_buffer;
        entry.size = sizeof(DawnPickMeshUniforms);
        WGPUBindGroupDescriptor group = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        group.layout = state.pick_mesh_layout;
        group.entryCount = 1;
        group.entries = &entry;
        state.pick_mesh_group =
            wgpuDeviceCreateBindGroup(state.device, &group);
    }
    if (!blocks.empty()) {
        wgpuQueueWriteBuffer(
            state.queue,
            state.pick_mesh_buffer,
            0,
            blocks.data(),
            blocks.size() * sizeof(DawnPickMeshUniforms));
    }
#if BBLITE_GPU_INSTANCING
    // Membership is stable across picks. Uniform contents are dynamic,
    // but only replacing a bound resource or its range needs a new group.
    for (std::size_t index = 0; index < candidates.size(); ++index) {
        if (!candidates[index].thin) continue;
#if BBLITE_HAS_DETAILED_PICKING
        if (detailed) {
            dawn_error("detailed thin-instance picking was not composed");
        }
#endif
        DawnMesh& mesh =
            pick_meshes[candidates[index].item_index];
        if (!mesh.instances) {
            dawn_error(
                "a thin-instance pick candidate has no instance buffer");
        }
        const std::uint64_t bound_size = static_cast<std::uint64_t>(
            candidates[index].instance_count) * sizeof(std::array<float, 16>);
        if (mesh.thin_pick_group &&
            mesh.thin_pick_uniform_buffer == state.pick_mesh_buffer &&
            mesh.thin_pick_instances == mesh.instances &&
            mesh.thin_pick_bound_size == bound_size) continue;
        mesh.release_thin_pick_group();
        std::array<WGPUBindGroupEntry, 2> entries{};
        for (WGPUBindGroupEntry& entry : entries) {
            entry = WGPU_BIND_GROUP_ENTRY_INIT;
        }
        entries[0].binding = 0;
        entries[0].buffer = state.pick_mesh_buffer;
        entries[0].size = sizeof(DawnPickMeshUniforms);
        entries[1].binding = 1;
        entries[1].buffer = mesh.instances;
        entries[1].size = bound_size;
        WGPUBindGroupDescriptor group =
            WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        group.layout = state.pick_thin_layout;
        group.entryCount = entries.size();
        group.entries = entries.data();
        mesh.thin_pick_group =
            wgpuDeviceCreateBindGroup(state.device, &group);
        if (!mesh.thin_pick_group) {
            dawn_error("pick thin bind group");
        }
        mesh.thin_pick_uniform_buffer = state.pick_mesh_buffer;
        mesh.thin_pick_instances = mesh.instances;
        mesh.thin_pick_bound_size = bound_size;
    }
#endif

#if BBLITE_HAS_SPLATS
    // The clouds and their sorted order buffers are the frame loop's:
    // its upload phase creates each pass and brings the sort current
    // before the drain a pick can arrive on, and a scene that picks
    // sooner than one elapsed frame yields sooner than the pin's own
    // `firstSortReady` scene does. The pick only reads.
    if (!state.splat_passes.empty() && !state.pick_cloud_pipeline) {
        state.pick_cloud_color_layout =
            create_dawn_pick_scene_layout(state.device);
        state.pick_cloud_pipeline = create_dawn_pick_cloud_pipeline(
            state.device,
            state.pick_scene_layout,
            state.splat_passes[0].layout,
            state.pick_cloud_color_layout);
        const auto uniform_pair =
            [&](std::uint64_t size,
                WGPUBindGroupLayout layout,
                WGPUBuffer& buffer,
                WGPUBindGroup& group) {
                WGPUBufferDescriptor descriptor =
                    WGPU_BUFFER_DESCRIPTOR_INIT;
                descriptor.usage = WGPUBufferUsage_Uniform |
                                   WGPUBufferUsage_CopyDst;
                descriptor.size = size;
                buffer =
                    wgpuDeviceCreateBuffer(state.device, &descriptor);
                WGPUBindGroupEntry entry = WGPU_BIND_GROUP_ENTRY_INIT;
                entry.binding = 0;
                entry.buffer = buffer;
                entry.size = size;
                WGPUBindGroupDescriptor descriptor_group =
                    WGPU_BIND_GROUP_DESCRIPTOR_INIT;
                descriptor_group.layout = layout;
                descriptor_group.entryCount = 1;
                descriptor_group.entries = &entry;
                group = wgpuDeviceCreateBindGroup(
                    state.device, &descriptor_group);
            };
        uniform_pair(
            64,
            state.pick_scene_layout,
            state.pick_cloud_shear,
            state.pick_cloud_shear_group);
        uniform_pair(
            16,
            state.pick_cloud_color_layout,
            state.pick_cloud_color,
            state.pick_cloud_color_group);
    }
    // One cloud per pick: the shear and the id colour are single
    // buffers, so a second cloud would need the same dynamic-offset
    // treatment the mesh blocks get. No reached scene loads two.
    if (pick_sources && state.splat_passes.size() > 1) {
        throw std::runtime_error(
            "Picking more than one Gaussian cloud needs a per-cloud "
            "id buffer; the reached slice loads one.");
    }
    for (DawnSplatPass& splat : state.splat_passes) {
        if (!pick_sources) break;
        // Refresh data before encoding, retaining the last frame's order.
        sync_dawn_splat_data(state.queue,
            handle_at(engine.splat_meshes, splat.mesh), splat);
        std::array<float, 16> shear{};
        compute_cloud_pick_matrix(shear, x, y, width, height);
        wgpuQueueWriteBuffer(
            state.queue,
            state.pick_cloud_shear,
            0,
            shear.data(),
            shear.size() * sizeof(float));
        const std::array<float, 3> color =
            encode_pick_id_to_color(next_id);
        const std::array<float, 4> picking_block{
            color[0], color[1], color[2], 0.0f};
        wgpuQueueWriteBuffer(
            state.queue,
            state.pick_cloud_color,
            0,
            picking_block.data(),
            picking_block.size() * sizeof(float));
        ranges.push_back(
            {next_id,
             PickedNodeKind::splat_mesh,
             splat.mesh.value});
        ++next_id;
    }
#endif
#if BBLITE_HAS_BILLBOARDS
    // The last contributor in the pin's own order: meshes own 1..M,
    // then each registered pick source's contiguous range. Its blocks
    // are written here for the same reason the mesh blocks above are
    // -- WebGPU forbids a queue write between draws inside a pass.
    if (pick_sources) {
        billboard_pick.prepare(
            state.device,
            state.queue,
            state.pick_scene_layout,
            engine,
            scene,
            upstream::build_view_matrix(
                upstream::camera_world_matrix(camera)),
            ranges,
            next_id);
    }
#endif

    WGPUCommandEncoderDescriptor encoder_descriptor =
        WGPU_COMMAND_ENCODER_DESCRIPTOR_INIT;
    DawnCommandEncoder encoder{wgpuDeviceCreateCommandEncoder(state.device, &encoder_descriptor)};

    std::array<WGPURenderPassColorAttachment, pick_color_targets>
        attachments{};
    for (WGPURenderPassColorAttachment& attachment : attachments) {
        attachment = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
        attachment.loadOp = WGPULoadOp_Clear;
        attachment.storeOp = WGPUStoreOp_Store;
    }
    attachments[0].view = state.pick_targets.color_view;
    attachments[0].clearValue = WGPUColor{0.0, 0.0, 0.0, 0.0};
    attachments[1].view = state.pick_targets.depth_color_view;
    // 1 is "nothing here" under reverse-Z, which is the pin's clear.
    attachments[1].clearValue = WGPUColor{1.0, 0.0, 0.0, 0.0};
    std::size_t attachment_count = 2;
#if BBLITE_HAS_DETAILED_PICKING
    if (detailed) {
        attachments[2].view = state.pick_targets.detail_view;
        // The pin's own 0xffffffff, which `readDetailTarget` reads
        // back as "no primitive".
        attachments[2].clearValue =
            WGPUColor{pick_detail_clear_red, 0.0, 0.0, 0.0};
        attachment_count = 3;
    }
#endif

    WGPURenderPassDepthStencilAttachment depth_attachment =
        WGPU_RENDER_PASS_DEPTH_STENCIL_ATTACHMENT_INIT;
    depth_attachment.view = state.pick_targets.depth_view;
    depth_attachment.depthLoadOp = WGPULoadOp_Clear;
    depth_attachment.depthStoreOp = WGPUStoreOp_Discard;
    depth_attachment.depthClearValue = 0.0f;

    WGPURenderPassDescriptor pass_descriptor =
        WGPU_RENDER_PASS_DESCRIPTOR_INIT;
    pass_descriptor.colorAttachmentCount = attachment_count;
    pass_descriptor.colorAttachments = attachments.data();
    pass_descriptor.depthStencilAttachment = &depth_attachment;
    DawnRenderPass pass{wgpuCommandEncoderBeginRenderPass(encoder, &pass_descriptor)};

    wgpuRenderPassEncoderSetPipeline(
        pass,
#if BBLITE_HAS_DETAILED_PICKING
        detailed ? state.pick_detailed_pipeline :
#endif
                 state.pick_mesh_pipeline);
    wgpuRenderPassEncoderSetBindGroup(
        pass, 0, state.pick_scene_group, 0, nullptr);
#if BBLITE_GPU_INSTANCING
    bool regular_pick_pipeline_bound = true;
#endif
#if BBLITE_DEFORM_PICKING
    // The projection's per-mesh group. Built here rather than inside
    // the loop only so every one of them is released together; the
    // pin builds its own the same way, from the pose the frame has
    // already uploaded.
    std::vector<WGPUBindGroup> deform_groups(blocks.size(), nullptr);
    int deform_bound = -1;
    const std::size_t deform_mode =
#if BBLITE_HAS_DETAILED_PICKING
        detailed ? 1u :
#endif
        0u;
#endif
    for (std::size_t index = 0; index < blocks.size(); ++index) {
        const DawnMesh& mesh =
            pick_meshes[candidates[index].item_index];
        const std::uint32_t offset = static_cast<std::uint32_t>(
            index * sizeof(DawnPickMeshUniforms));
#if BBLITE_GPU_INSTANCING
        if (candidates[index].thin) {
            wgpuRenderPassEncoderSetPipeline(
                pass, state.pick_thin_pipeline);
            wgpuRenderPassEncoderSetBindGroup(
                pass, 0, state.pick_scene_group, 0, nullptr);
            wgpuRenderPassEncoderSetBindGroup(
                pass,
                1,
                mesh.thin_pick_group,
                1,
                &offset);
            wgpuRenderPassEncoderSetVertexBuffer(
                pass, 0, mesh.vertices, 0, WGPU_WHOLE_SIZE);
            wgpuRenderPassEncoderSetIndexBuffer(
                pass,
                mesh.indices,
                WGPUIndexFormat_Uint32,
                0,
                WGPU_WHOLE_SIZE);
            count_gpu_draw(wgpuRenderPassEncoderDrawIndexed,
                pass,
                mesh.index_count,
                candidates[index].instance_count,
                0,
                0,
                0);
            regular_pick_pipeline_bound = false;
            continue;
        }
        if (!regular_pick_pipeline_bound) {
            wgpuRenderPassEncoderSetPipeline(
                pass,
#if BBLITE_HAS_DETAILED_PICKING
                detailed ? state.pick_detailed_pipeline :
#endif
                           state.pick_mesh_pipeline);
            wgpuRenderPassEncoderSetBindGroup(
                pass, 0, state.pick_scene_group, 0, nullptr);
            regular_pick_pipeline_bound = true;
#if BBLITE_DEFORM_PICKING
            deform_bound = -1;
#endif
        }
#endif
#if BBLITE_DEFORM_PICKING
        const int deform_draw = candidates[index].deform;
        const auto* deform_program = deform_draw >= 0
            ? &state.pick_deform_programs[static_cast<std::size_t>(deform_draw)] : nullptr;
        if (deform_draw != deform_bound) {
            deform_bound = deform_draw;
            wgpuRenderPassEncoderSetPipeline(pass,
                deform_program ? deform_program->pipelines[deform_mode] :
#if BBLITE_HAS_DETAILED_PICKING
                detailed ? state.pick_detailed_pipeline :
#endif
                state.pick_mesh_pipeline);
            wgpuRenderPassEncoderSetBindGroup(pass, 0, state.pick_scene_group, 0, nullptr);
        }
        if (deform_program) {
            const auto& variant = upstream::pick_deform_variants[static_cast<std::size_t>(deform_draw)];
            std::array<WGPUBindGroupEntry, 3> entries{};
            std::size_t entry_count = 0;
            bool pose_bound = true;
            const auto append = [&]() -> WGPUBindGroupEntry& {
                auto& entry = entries[entry_count];
                entry = WGPU_BIND_GROUP_ENTRY_INIT;
                entry.binding = static_cast<std::uint32_t>(entry_count++);
                return entry;
            };
            if (variant.skeleton) {
#if BBLITE_PBR_VARIANTS > 0 || defined(BBLITE_STANDARD_SKELETON)
                auto& entry = append();
                entry.textureView = mesh.pinned_bone_view;
                pose_bound = entry.textureView != nullptr;
#else
                dawn_error("deformation pick has no bone palette transport");
#endif
            }
#if BBLITE_DEFORM_PICKING_MORPH
            if (variant.morph) {
                auto& deltas = append();
                deltas.buffer = mesh.morph_deltas;
                deltas.size = WGPU_WHOLE_SIZE;
                auto& weights = append();
                weights.buffer = mesh.morph_weights;
                weights.size = WGPU_WHOLE_SIZE;
                pose_bound = pose_bound && deltas.buffer != nullptr && weights.buffer != nullptr;
            }
#endif
            if (!pose_bound) {
                dawn_error(
                    "a deforming pick candidate reached the pass "
                    "without the pose the projection samples");
            }
            WGPUBindGroupDescriptor group =
                WGPU_BIND_GROUP_DESCRIPTOR_INIT;
            group.layout = deform_program->layout;
            group.entryCount =
                static_cast<std::uint32_t>(entry_count);
            group.entries = entries.data();
            deform_groups[index] =
                wgpuDeviceCreateBindGroup(state.device, &group);
            if (!deform_groups[index]) {
                dawn_error("pick deform bind group");
            }
            wgpuRenderPassEncoderSetBindGroup(
                pass, 2, state.pick_deform_empty_group, 0, nullptr);
            wgpuRenderPassEncoderSetBindGroup(
                pass, 3, deform_groups[index], 0, nullptr);
        }
#endif
        wgpuRenderPassEncoderSetBindGroup(
            pass, 1, state.pick_mesh_group, 1, &offset);
        wgpuRenderPassEncoderSetVertexBuffer(
            pass, 0, mesh.vertices, 0, WGPU_WHOLE_SIZE);
        wgpuRenderPassEncoderSetIndexBuffer(
            pass,
            mesh.indices,
            WGPUIndexFormat_Uint32,
            0,
            WGPU_WHOLE_SIZE);
        count_gpu_draw(wgpuRenderPassEncoderDrawIndexed,
            pass, mesh.index_count, 1, 0, 0, 0);
    }
#if BBLITE_HAS_SPLATS
    for (const DawnSplatPass& splat : state.splat_passes) {
        if (!pick_sources) break;
        if (splat.vertex_count == 0) continue;
        wgpuRenderPassEncoderSetPipeline(
            pass, state.pick_cloud_pipeline);
        wgpuRenderPassEncoderSetBindGroup(
            pass, 0, state.pick_cloud_shear_group, 0, nullptr);
        wgpuRenderPassEncoderSetBindGroup(
            pass, 1, splat.group, 0, nullptr);
        wgpuRenderPassEncoderSetBindGroup(
            pass, 2, state.pick_cloud_color_group, 0, nullptr);
        wgpuRenderPassEncoderSetVertexBuffer(
            pass, 0, splat.quad, 0, WGPU_WHOLE_SIZE);
        wgpuRenderPassEncoderSetVertexBuffer(
            pass, 1, splat.order, 0, WGPU_WHOLE_SIZE);
        wgpuRenderPassEncoderSetIndexBuffer(
            pass,
            splat.indices,
            WGPUIndexFormat_Uint16,
            0,
            WGPU_WHOLE_SIZE);
        count_gpu_draw(wgpuRenderPassEncoderDrawIndexed,
            pass,
            static_cast<std::uint32_t>(
                upstream::splat_quad_indices.size()),
            splat.vertex_count,
            0,
            0,
            0);
    }
#endif
#if BBLITE_HAS_BILLBOARDS
    if (pick_sources) {
        billboard_pick.record(pass, state.pick_scene_group);
    }
#endif
    wgpuRenderPassEncoderEnd(pass);
    pass.reset();
#if BBLITE_DEFORM_PICKING
    for (WGPUBindGroup group : deform_groups) {
        if (group) wgpuBindGroupRelease(group);
    }
#endif

    WGPUTexelCopyTextureInfo source = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
    source.texture = state.pick_targets.color;
    WGPUTexelCopyBufferInfo destination =
        WGPU_TEXEL_COPY_BUFFER_INFO_INIT;
    destination.buffer = state.pick_targets.staging;
    destination.layout.bytesPerRow = pick_readback_row;
    destination.layout.rowsPerImage = 1;
    const WGPUExtent3D one{1, 1, 1};
    wgpuCommandEncoderCopyTextureToBuffer(
        encoder, &source, &destination, &one);
    source.texture = state.pick_targets.depth_color;
    destination.layout.offset = pick_depth_offset;
    wgpuCommandEncoderCopyTextureToBuffer(
        encoder, &source, &destination, &one);
#if BBLITE_HAS_DETAILED_PICKING
    if (detailed) {
        source.texture = state.pick_targets.detail;
        destination.layout.offset = pick_detail_offset;
        wgpuCommandEncoderCopyTextureToBuffer(
            encoder, &source, &destination, &one);
    }
#endif

    WGPUCommandBufferDescriptor finish =
        WGPU_COMMAND_BUFFER_DESCRIPTOR_INIT;
    DawnCommandBuffer commands{wgpuCommandEncoderFinish(encoder, &finish)};
    submit_dawn_command(state.queue, commands);
    commands.reset();
    encoder.reset();

    WGPUBufferMapCallbackInfo map_callback =
        WGPU_BUFFER_MAP_CALLBACK_INFO_INIT;
    map_callback.mode = WGPUCallbackMode_WaitAnyOnly;
    // Recorded rather than thrown: the callback runs inside
    // `wgpuInstanceWaitAny`, so an exception would unwind through
    // Dawn's own C frame. Every other wait in this backend reports a
    // map failure the same way.
    map_callback.callback =
        [](WGPUMapAsyncStatus status,
           WGPUStringView message,
           void* userdata1,
           void*) {
            if (status != WGPUMapAsyncStatus_Success) {
                auto* error = static_cast<std::string*>(userdata1);
                if (error->empty()) *error = view_text(message);
            }
        };
    map_callback.userdata1 = &state.uncaptured_error;
    wait_for(
        state.instance,
        wgpuBufferMapAsync(
            state.pick_targets.staging,
            WGPUMapMode_Read,
            0,
            pick_staging_bytes,
            map_callback));
    if (!state.uncaptured_error.empty()) {
        dawn_error("pick buffer map failed: " + state.uncaptured_error);
    }
    const void* mapped = wgpuBufferGetConstMappedRange(
        state.pick_targets.staging, 0, pick_staging_bytes);
    if (!mapped) dawn_error("pick map returned no data.");
    const auto* bytes = static_cast<const std::uint8_t*>(mapped);
    const std::uint32_t pick_id =
        decode_pick_id(bytes);
    float pick_depth = 1.0f;
    std::memcpy(
        &pick_depth, bytes + pick_depth_offset, sizeof(pick_depth));
#if BBLITE_HAS_DETAILED_PICKING
    const PickDetailReadback pick_detail =
        detailed ? decode_pick_detail(bytes + pick_detail_offset)
                 : PickDetailReadback{};
#endif
    wgpuBufferUnmap(state.pick_targets.staging);

    PickingInfo info = resolve_pick_result(ranges, pick_id);
    populate_picked_point(
        info,
        view_projection,
        x,
        y,
        width,
        height,
        pick_depth);
#if BBLITE_HAS_DETAILED_PICKING
    if (detailed) {
        finish_detailed_pick(
            engine,
            info,
            pick_detail,
            view_projection,
            x,
            y,
            width,
            height);
    }
#endif
    return info;
}
#endif

class DawnSceneRun {

    struct State : FrameSession {
        const bool cpu_profile = environment_variable("BBLITE_CPU_PROFILE") == "1";
        const bool mem_profile = environment_variable("BBLITE_MEM_PROFILE") == "1";
        CpuStartupMark cpu_startup_mark{cpu_profile, "dawn"};
        const std::vector<std::shared_ptr<Scene>> active_registered_scenes = engine.registered_scenes;
        const std::shared_ptr<Scene> active_scene = active_registered_scenes.front();
        Scene& scene = *active_scene;
        DawnState state;
        std::uint32_t width = 0, height = 0;
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI && !(defined(BBLITE_WORKERS) && BBLITE_WORKERS)
        std::unique_ptr<UiRmlRuntime, decltype(&destroy_ui_rml_runtime)> ui_runtime{nullptr, &destroy_ui_rml_runtime};
#endif
        upstream::RenderPlan render_plan;
        std::vector<upstream::RenderPlan> overlay_plans;
        std::vector<std::uint64_t> overlay_topology_versions;
        std::uint64_t synced_render_topology_version = 0, synced_draw_list_epoch = 0;
        std::uint32_t synced_material_family_mask = 0;
#if defined(BBLITE_HAS_TEXT) && BBLITE_HAS_TEXT
        std::optional<DawnTextResourceOps> text_ops;
#endif
        CameraRecord fallback_camera;
        CameraRecord* camera = nullptr;
        CameraPointerState pointer_state;
        SurfaceCameraPointerState surface_pointer_state;
        CameraTraceState camera_trace_state;
        std::vector<float> shader_block_scratch;
#if BBLITE_GPU_INSTANCING && BBLITE_PBR_VARIANTS > 0
        std::vector<std::array<float, 16>> pinned_instance_scratch;
#endif
#if BBLITE_OFFSCREEN_SURFACES
        OffscreenRun* offscreen = nullptr;
        OffscreenImagePool<DawnOffscreenImage> offscreen_images;
#endif
#if BBLITE_HAS_PICKING
#if BBLITE_HAS_BILLBOARDS
        DawnBillboardPickContributor billboard_pick;
#endif
        std::optional<PickHookGuard> pick_hook_guard;
#endif
#if defined(BBLITE_DEVICE_RECOVERY) && BBLITE_DEVICE_RECOVERY
        std::optional<DrawCountScope> draw_count_scope;
#endif
        explicit State(Engine& target) : FrameSession(target) {}
    } data_;

    struct Frame {
        bool yield_when_skipped = false;
#if BBLITE_OFFSCREEN_SURFACES
        DawnOffscreenImage* offscreen_image = nullptr;
#endif
        double benchmark_start = 0, delta_ms = 0, updated = 0, uploaded = 0, written = 0, acquired = 0;
        std::size_t profile_transformed_meshes = 0, profile_transformed_vertices = 0;
        bool topology_updated = false, capture_ready = false, frame_graph_presented = false;
        PixelViewport surface_extent{};
        double aspect = 0;
        std::array<float, 16> matrix{}, frame_view{}, frame_projection{};
        std::array<float, 4> frame_camera_position{};
        ShaderPassMatrices frame_pass_matrices{};
        const Scene* pass_scene = nullptr;
        std::vector<DawnMesh>* pass_meshes = nullptr;
#if BBLITE_NODE_VARIANTS > 0
        NodeMeshBlockCache node_mesh_blocks;
#endif
        WGPUSurfaceTexture surface_texture = WGPU_SURFACE_TEXTURE_INIT;
        DawnTexture surface;
        DawnTextureView surface_view;
        DawnCommandEncoder encoder;
        WGPUTexture capture_source = nullptr;
    };
    std::optional<Frame> frame_;

    void rebuild_task_draw_lists() {
        [[maybe_unused]] auto& engine = data_.engine;
        [[maybe_unused]] auto& state = data_.state;
        [[maybe_unused]] auto& render_plan = data_.render_plan;
        [[maybe_unused]] auto& overlay_plans = data_.overlay_plans;

        if (state.render_tasks.size() < engine.frame_tasks.size()) {
            state.render_tasks.resize(engine.frame_tasks.size());
        }
        for (std::size_t layer = 0; layer < engine.registered_scenes.size(); ++layer) {
            const Scene& task_scene = *engine.registered_scenes[layer];
            const auto& task_plan = layer == 0 ? render_plan : overlay_plans[layer - 1];
        for (const TaskHandle handle : task_scene.tasks) {
            if (handle.value >= engine.frame_tasks.size()) {
                throw std::runtime_error(
                    "Scene frame task handle is invalid.");
            }
            const FrameTaskRecord& task = handle_at(engine.frame_tasks, handle);
            if (
                task.kind != FrameTaskKind::render &&
                task.kind != FrameTaskKind::geometry) {
                continue;
            }
            DawnRenderTask& render_task =
                handle_at(state.render_tasks, handle);
            if (!render_task.view_projection) {
                render_task.view_projection = create_buffer(
                    state,
                    WGPUBufferUsage_Uniform,
                    nullptr,
                    64);
            }
            render_task.draw_lists =
                upstream::build_render_task_draw_lists(
                    task_plan.items,
                    engine,
                    task);
        }
        }
    }

    void capture_render_state() {
        [[maybe_unused]] auto& engine = data_.engine;
        [[maybe_unused]] auto& frame_options = data_.frame_options;
        [[maybe_unused]] auto& captures = data_.captures;
        [[maybe_unused]] auto& frame = data_.frame;
        [[maybe_unused]] auto& scene = data_.scene;
        [[maybe_unused]] auto& state = data_.state;
        [[maybe_unused]] auto& width = data_.width;
        [[maybe_unused]] auto& height = data_.height;
        [[maybe_unused]] auto& render_plan = data_.render_plan;
        [[maybe_unused]] auto& camera = *data_.camera;
        [[maybe_unused]] const auto& matrix = frame_->matrix;
        [[maybe_unused]] const auto& capture_ready = frame_->capture_ready;

        if (
            capture_ready &&
            !captures.render_capture_saved &&
            !frame_options.render_capture_path.empty()) {
            write_render_capture(
                frame_options.render_capture_path,
                "dawn",
                scene,
                engine,
                camera,
                render_plan,
                matrix,
                static_cast<int>(width),
                static_cast<int>(height),
                frame
#if defined(BBLITE_HAS_TEXT) && BBLITE_HAS_TEXT
                , &state.text->owner->capture
#elif BBLITE_NODE_GEOMETRY_VARIANTS > 0
                , nullptr
#endif
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
                , &state.node_capture.capture
#endif
                );
            captures.render_capture_saved = true;
        }
    }

    void write_material_uniforms(
        const upstream::RenderDrawList& list, const ShaderPassMatrices& pass_matrices,
        bool pass_dependent_only = false) {
        [[maybe_unused]] auto& engine = data_.engine;
        [[maybe_unused]] auto& state = data_.state;
        [[maybe_unused]] auto& shader_block_scratch = data_.shader_block_scratch;
        [[maybe_unused]] auto& pass_scene = frame_->pass_scene;
        [[maybe_unused]] auto& pass_meshes = frame_->pass_meshes;
#if BBLITE_NODE_VARIANTS > 0
        [[maybe_unused]] auto& node_mesh_blocks = frame_->node_mesh_blocks;
#endif

        for (const upstream::RenderDrawCommand& draw :
             list.commands) {
            DawnMesh& draw_mesh = (*pass_meshes)[draw.item_index];
            const bool grid_draw =
                draw.item.material_kind ==
                upstream::RenderMaterialKind::grid;
            const bool shader_draw =
                draw.item.material_kind ==
                upstream::RenderMaterialKind::shader;
            if (pass_dependent_only && !grid_draw && !shader_draw) {
                continue;
            }
            // The per-mesh vertex, deformation, instancing and
            // morph state is synced once per frame by the item
            // pass above; a draw writes only the blocks its
            // material kind owns.
            if (
                draw.item.material_kind ==
                upstream::RenderMaterialKind::standard) {
#if BBLITE_STANDARD_VARIANTS > 0
                // The pin's own per-draw blocks; the transcribed
                // block is retired, so an unresolved draw errors
                // naming the mesh, matching the SDL_GPU backend.
                const std::size_t variant =
                    standard_variant_for_draw(*pass_scene, engine, draw);
                if (variant == npos) {
                    dawn_error(
                        ("Standard draw for mesh " +
                         std::to_string(draw.item.mesh.value) +
                         ", material " +
                         std::to_string(draw.item.material.value) +
                         " resolves no composed variant: " +
                         standard_variant_request(engine, draw))
                            .c_str());
                }
                const MaterialRecord* standard_material =
                    draw.item.material.value <
                            engine.materials.size()
                        ? &engine.materials[
                              draw.item.material.value]
                        : nullptr;
#if defined(BBLITE_STANDARD_SKELETON)
                if (upstream::standard_variant_skeleton(
                        upstream::standard_variants[variant])) {
                    write_pinned_bone_texture(
                        state, draw_mesh, handle_at(engine.meshes, draw.item.mesh));
                }
#endif
                DawnDrawState& standard_state =
                    ensure_standard_draw_buffers(
                        state,
                        draw_mesh,
                        draw.item.material.value);
                // The bind group builds at encode: a depth-sampled
                // emissive render texture's view resolves only
                // after the frame-graph textures exist.
                standard_state.group_key = variant * 2 +
                    ((standard_material &&
                      standard_material
                          ->has_emissive_render_texture)
                         ? 1
                         : 0);
                write_standard_draw_blocks(
                    state,
                    *pass_scene,
                    engine,
                    draw,
                    variant,
                    standard_state.mesh_uniforms,
                    standard_state.material_uniforms,
                    standard_state.uv_uniforms,
                    standard_state.uv_transform_uniforms);
#else
                dawn_error(
                    "Standard draw in a build with no composed "
                    "variant table; the transcribed fragment is "
                    "retired.");
#endif
#if BBLITE_NODE_VARIANTS > 0
            } else if (
                draw.item.material_kind ==
                upstream::RenderMaterialKind::node) {
                const std::size_t variant =
                    draw.item.shader_variant;
                DawnDrawState& node_state =
                    ensure_node_draw_buffers(
                        state,
                        draw_mesh,
                        draw.item.material.value,
                        upstream::node_variants.at(variant));
                write_node_mesh_block(
                    state,
                    node_mesh_block_for(
                        node_mesh_blocks,
                        *pass_scene,
                        engine,
                        draw.item.mesh.value),
                    node_state);
                // The group itself is built at encode: a receiving
                // graph binds the generators' maps, which the frame
                // graph has not created yet at this point.
#endif
            } else if (grid_draw) {
                const upstream::GridUniforms fragment =
                    upstream::build_grid_uniforms(
                        engine,
                        draw.item);
                wgpuQueueWriteBuffer(
                    state.queue,
                    (*pass_meshes)[draw.item_index]
                        .material_uniforms,
                    0,
                    &fragment,
                    sizeof(fragment));
            } else if (shader_draw) {
                if (
                    draw.item.material.value <
                    engine.materials.size()) {
                    const MaterialRecord& material =
                        engine.materials[
                            draw.item.material.value];
                    const upstream::ShaderVariantInfo&
                        shader_info =
                            upstream::shader_variant_info(
                                draw.item.shader_variant);
                    const ShaderDrawMatrices shader_matrices(
                        engine,
                        engine.meshes[
                            draw.item.mesh.value],
                        pass_matrices);
                    const ShaderPassMatrices
                        shader_pass_matrices =
                            shader_matrices.apply(
                                pass_matrices);
                    // A block that is exactly the shared scene
                    // matrix binds the frame's own buffer and
                    // needs no write; everything else -- custom
                    // gathers, or several system matrices --
                    // owns the material's buffer and is filled
                    // here.
                    const auto write_stage_block =
                        [&](
                            const upstream::
                                ShaderVariantStageBlock&
                                    block,
                            WGPUBuffer buffer) {
                        if (
                            !block.present ||
                            block_is_shared_scene_matrix(block)) {
                            return;
                        }
                        shader_stage_block_floats(
                            block,
                            shader_pass_matrices,
                            material,
                            shader_block_scratch);
                        wgpuQueueWriteBuffer(
                            state.queue,
                            buffer,
                            0,
                            shader_block_scratch.data(),
                            shader_block_scratch.size() *
                                sizeof(float));
                    };
                    write_stage_block(
                        shader_info.vertex,
                        draw_mesh.shader_vertex_uniforms);
                    write_stage_block(
                        shader_info.fragment,
                        draw_mesh.material_uniforms);
                } else {
                    // The SDL backend's named refusal: encoding
                    // the draw with stale or zero uniforms is
                    // the silent alternative.
                    dawn_error(
                        "Shader draw has an invalid material.");
                }
            } else {
#if BBLITE_PBR_VARIANTS > 0
                // The pin's own per-draw blocks. The transcribed
                // block is retired: a PBR draw that resolves no
                // variant is an error naming the mesh, matching the
                // SDL_GPU backend.
                pal::PinnedVariantKey pinned_key;
                const std::size_t variant =
                    pinned_variant_for_draw(
                        *pass_scene,
                        engine,
                        draw,
                        npos,
                        &pinned_key);
                if (variant == npos) {
                    dawn_error(
                        ("PBR draw for mesh " +
                         std::to_string(draw.item.mesh.value) +
                         ", material " +
                         std::to_string(draw.item.material.value) +
                         " resolves no pinned variant: " +
                         pal::pinned_variant_request(pinned_key))
                            .c_str());
                }
                {
                    const MeshRecord& variant_record =
                        handle_at(engine.meshes, draw.item.mesh);
                    // `pinned_draw_conventions` states the
                    // skinned and palette-world contract these
                    // three booleans carry.
                    const PinnedDrawConventions conventions =
                        pinned_draw_conventions(
                            variant,
                            variant_record);
                    if (conventions.skeleton_draw) {
                        write_pinned_bone_texture(
                            state,
                            draw_mesh,
                            variant_record);
                    }
#if BBLITE_VAT
                    // Before the bind group is built: the settings
                    // buffer it names has to exist by then, and a
                    // cached group keeps the same buffer while the
                    // clock is rewritten in place.
                    if (conventions.vat_draw) {
                        write_pinned_vat_texture(
                            state,
                            draw_mesh,
                            variant_record,
                            engine);
                    }
#endif
                    DawnDrawState& pinned_state =
                        ensure_pinned_draw_bindings(
                            state,
                            draw_mesh,
                            draw.item.material.value,
                            variant,
                            draw.item.material.value <
                                    engine.materials.size()
                                ? &engine.materials[
                                    draw.item.material.value]
                                : nullptr);
                    pinned_state.mirrored_vertices =
                        conventions.mirrored_vertices;
                    write_pinned_draw_blocks(
                        state,
                        *pass_scene,
                        engine,
                        draw,
                        variant,
                        conventions,
                        pinned_state.mesh_uniforms,
                        pinned_state.material_uniforms);
                }
#else
                dawn_error(
                    "PBR draw in a build with no composed variant "
                    "table; the transcribed fragment is retired.");
#endif
            }
        }
    }

public:
    static constexpr FrameAcquirePhase acquire_phase = FrameAcquirePhase::before_encoding;
    explicit DawnSceneRun(Engine& engine) : data_(engine) {}
    bool keep_running() const { return data_.keep_running(); }
    void discard_frame() { frame_.reset(); }
    bool yield_when_skipped() const { return frame_ && frame_->yield_when_skipped; }

    void setup() {
        [[maybe_unused]] auto& engine = data_.engine;
        [[maybe_unused]] auto& frame_options = data_.frame_options;
        [[maybe_unused]] auto& cpu_startup_mark = data_.cpu_startup_mark;
        [[maybe_unused]] auto& active_registered_scenes = data_.active_registered_scenes;
        [[maybe_unused]] auto& scene = data_.scene;
        [[maybe_unused]] auto& state = data_.state;
        [[maybe_unused]] auto& width = data_.width;
        [[maybe_unused]] auto& height = data_.height;
        [[maybe_unused]] auto& render_plan = data_.render_plan;
        [[maybe_unused]] auto& overlay_plans = data_.overlay_plans;
        [[maybe_unused]] auto& overlay_topology_versions = data_.overlay_topology_versions;
        [[maybe_unused]] auto& synced_render_topology_version = data_.synced_render_topology_version;
        [[maybe_unused]] auto& synced_draw_list_epoch = data_.synced_draw_list_epoch;
        [[maybe_unused]] auto& synced_material_family_mask = data_.synced_material_family_mask;
        [[maybe_unused]] auto& fallback_camera = data_.fallback_camera;
        [[maybe_unused]] auto& benchmark_samples = data_.samples_ms;
        [[maybe_unused]] auto& screenshot_path = data_.frame_options.screenshot_path;
        [[maybe_unused]] const auto benchmark = data_.frame_options.benchmarking();
        [[maybe_unused]] auto& benchmark_frames = data_.frame_options.benchmark_frames;
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI && !(defined(BBLITE_WORKERS) && BBLITE_WORKERS)
        [[maybe_unused]] auto& ui_runtime = data_.ui_runtime;
#endif
#if BBLITE_HAS_PICKING && BBLITE_HAS_BILLBOARDS
        [[maybe_unused]] auto& billboard_pick = data_.billboard_pick;
#endif
#if BBLITE_OFFSCREEN_SURFACES
        [[maybe_unused]] auto& offscreen = data_.offscreen;
#endif




        reject_unsupported_frame_options(
            frame_options,
            "Dawn",
            /*supports_single_sample=*/true,
            /*supports_copy_task=*/true);
        // Keep every planned wrapper alive through event dispatch. A UI callback
        // may replace the root or finish registering an awaited auxiliary scene;
        // either change rebuilds the backend before stale plans are used again.



        if (scene.transmission_enabled && !scene.tasks.empty()) {
            dawn_error(
                "transmission combined with frame-graph tasks is not "
                "implemented yet.");
        }
        apply_animation_seek(frame_options, scene);
        // Read by the image-skybox and ground arms, which not every feature set
        // compiles.
        [[maybe_unused]] const bool background_enabled =
            frame_options.background_enabled(scene.environment);
        const bool use_skybox =
            frame_options.skybox_enabled(scene.environment);
        const bool use_ground =
            frame_options.ground_enabled(scene.environment);

        // Every attachment and pipeline reads this, so it is settled before
        // any of them is created. The count is the generated read of the
        // pin's own surface declaration, not a re-typed 4; there is no
        // capability probe here because WebGPU guarantees 4x support on the
        // surface formats this backend renders to, where SDL_GPU must ask.
        state.sample_count = frame_options.single_sample
            ? 1u
            : upstream::preferred_sample_count();


        DeviceOptions device_options = frame_device_options(frame_options);
#if BBLITE_GPU_INSTANCE_COLORS
        // With the per-instance RGBA lane the pin's own thin-instance module
        // appends, the specialized WGSL reaches the lane after the matrix
        // columns, and the limit has to cover that location.
        device_options.max_vertex_attributes = instance_color_location + 1;
#elif BBLITE_GPU_INSTANCING
        // The SDL-specialized WGSL feeds per-instance matrix columns at
        // locations 16-19; the WebGPU default caps attribute locations
        // below 16, so raise the device limit to cover location 19.
        device_options.max_vertex_attributes = 20;
#endif
        // Geometry MRT chains can exceed the default 32-byte color budget;
        // the entry's erased requiredLimits option is derived here from
        // the task records with the WebGPU render-target byte costs
        // (rgba8/bgra8/rgba16f cost 8, r32f 4, r16f 2).
        {
            std::uint32_t color_bytes_per_sample = 0;
            for (const FrameTaskRecord& task : engine.frame_tasks) {
                if (task.kind != FrameTaskKind::geometry) continue;
                std::uint32_t total = 0;
                for (const GeometryTextureDescription& description :
                     task.geometry.attachments) {
                    switch (geometry_texture_format(description)) {
                        case WGPUTextureFormat_R16Float:
                            total += 2;
                            break;
                        case WGPUTextureFormat_R32Float:
                            total += 4;
                            break;
                        default:
                            total += 8;
                            break;
                    }
                }
                if (task.geometry.target.value != invalid_handle) {
                    total += 8;
                }
                color_bytes_per_sample =
                    std::max(color_bytes_per_sample, total);
            }
            if (color_bytes_per_sample > 32) {
                device_options.max_color_attachment_bytes_per_sample =
                    color_bytes_per_sample;
            }
        }
        create_dawn_device(engine.options, device_options, state);
        sync_engine_canvas_size(state.window, engine);
        resize_dawn_surface(state, engine.options);
        cpu_startup_mark("window-device");

        width = state.surface_width;
        height = state.surface_height;
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI && !(defined(BBLITE_WORKERS) && BBLITE_WORKERS)
        ui_runtime.reset(create_ui_rml_runtime(engine, state.window, width, height));
#endif

#if defined(BBLITE_HAS_SPRITE_RENDERER) && BBLITE_HAS_SPRITE_RENDERER
        // Sprite rendering contexts and their render targets may be created by a
        // before-render callback. Mirror all newly appended CPU records in handle
        // order both here and immediately after each callback run.
        sync_dawn_scene_sprites(state, engine);
#endif

        // Shared frame targets: 4x MSAA color (surface format, or linear
        // rgba16float for transmission frames whose multisampled texture
        // feeds the grab and the per-sample image processing) and the
        // browser's depth24plus-stencil8 depth buffer.
        state.frame_color_format = scene.transmission_enabled
            ? WGPUTextureFormat_RGBA16Float
            : state.surface_format;
        recreate_dawn_scene_targets(state, scene, width, height);
        if (scene.transmission_enabled) {
            // The pinned refraction target: the shared fixed-extent,
            // shortened-chain contract (pal_gpu_shared.hpp), rgba16float.
            state.transmission_mip_count = transmission_grab_mip_count();
            WGPUTextureDescriptor transmission_descriptor =
                WGPU_TEXTURE_DESCRIPTOR_INIT;
            transmission_descriptor.usage =
                WGPUTextureUsage_RenderAttachment |
                WGPUTextureUsage_TextureBinding;
            transmission_descriptor.size = {
                transmission_grab_size,
                transmission_grab_size,
                1,
            };
            transmission_descriptor.format =
                WGPUTextureFormat_RGBA16Float;
            transmission_descriptor.mipLevelCount =
                state.transmission_mip_count;
            state.transmission_color = wgpuDeviceCreateTexture(
                state.device,
                &transmission_descriptor);
            if (!state.transmission_color) {
                dawn_error(
                    "wgpuDeviceCreateTexture transmission color");
            }
            state.transmission_color_view = create_dawn_texture_view(
                state.transmission_color,
                nullptr);
        }
#if defined(BBLITE_HAS_SPRITE_RENDERER) && BBLITE_HAS_SPRITE_RENDERER
        if (!scene.depth_hosted_sprite_layers.empty()) {
            state.scene_sprite_pass = create_dawn_scene_sprite_pass(
                state.device,
                state.queue,
                state.mips,
                engine,
                scene.depth_hosted_sprite_layers,
                state.sprite_render_textures,
                state.sprite_render_texture_views,
                state.frame_color_format,
                WGPUTextureFormat_Depth24PlusStencil8,
                state.sample_count);
            state.has_scene_sprite_pass = true;
        }
#endif

        state.vertex_module = load_wgsl_module(state, "pbr.vert");

        state.view_projection = create_buffer(
            state,
            WGPUBufferUsage_Uniform,
            nullptr,
            64);
        state.white_texture = create_solid_texture(
            state,
            {255, 255, 255, 255},
            WGPUTextureFormat_RGBA8Unorm,
            1);
        state.white_view =
            create_dawn_texture_view(state.white_texture, nullptr);
        state.black_texture = create_solid_texture(
            state,
            {0, 0, 0, 255},
            WGPUTextureFormat_RGBA8Unorm,
            1);
        state.black_view =
            create_dawn_texture_view(state.black_texture, nullptr);
        state.normal_flat_texture = create_solid_texture(
            state,
            {128, 128, 255, 255},
            WGPUTextureFormat_RGBA8Unorm,
            1);
        state.normal_flat_view =
            create_dawn_texture_view(state.normal_flat_texture, nullptr);
        const auto cube_view = [&](WGPUTexture texture) {
            WGPUTextureViewDescriptor cube_descriptor =
                WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
            cube_descriptor.dimension = WGPUTextureViewDimension_Cube;
            cube_descriptor.arrayLayerCount = 6;
            return create_dawn_texture_view(texture, &cube_descriptor);
        };
        state.black_cube = create_solid_texture(
            state,
            {0, 0, 0, 255},
            WGPUTextureFormat_RGBA8Unorm,
            6);
        state.black_cube_view = cube_view(state.black_cube);
        const std::vector<std::uint8_t> zero_rgba16f(8, 0);
        // The startup value IS the no-environment value: `upload_environment`
        // replaces this cube only when the scene carries one, so an
        // environment-less PBR scene shades ambient reflections from this face.
        // SDL_GPU uploads the same `environment_fallback_face`; zeros here were
        // a silent backend delta.
        const std::vector<std::uint16_t> fallback_halves = fallback_face_halves();
        std::vector<std::uint8_t> fallback_rgba16f(8);
        for (std::size_t channel = 0; channel < fallback_halves.size(); ++channel) {
            fallback_rgba16f[channel * 2] =
                static_cast<std::uint8_t>(fallback_halves[channel] & 0xff);
            fallback_rgba16f[channel * 2 + 1] =
                static_cast<std::uint8_t>(fallback_halves[channel] >> 8);
        }
        state.environment_cube = create_solid_texture(
            state,
            fallback_rgba16f,
            WGPUTextureFormat_RGBA16Float,
            6);
        state.environment_cube_view = cube_view(state.environment_cube);
        state.brdf_texture = create_solid_texture(
            state,
            zero_rgba16f,
            WGPUTextureFormat_RGBA16Float,
            1);
        state.brdf_view =
            create_dawn_texture_view(state.brdf_texture, nullptr);
        {
            WGPUSamplerDescriptor sampler_descriptor =
                WGPU_SAMPLER_DESCRIPTOR_INIT;
            sampler_descriptor.addressModeU = WGPUAddressMode_Repeat;
            sampler_descriptor.addressModeV = WGPUAddressMode_Repeat;
            sampler_descriptor.addressModeW = WGPUAddressMode_Repeat;
            sampler_descriptor.magFilter = WGPUFilterMode_Linear;
            sampler_descriptor.minFilter = WGPUFilterMode_Linear;
            sampler_descriptor.mipmapFilter = WGPUMipmapFilterMode_Linear;
            state.default_sampler =
                wgpuDeviceCreateSampler(state.device, &sampler_descriptor);
            sampler_descriptor.addressModeU = WGPUAddressMode_ClampToEdge;
            sampler_descriptor.addressModeV = WGPUAddressMode_ClampToEdge;
            sampler_descriptor.addressModeW = WGPUAddressMode_ClampToEdge;
            state.clamp_sampler =
                wgpuDeviceCreateSampler(state.device, &sampler_descriptor);
            sampler_descriptor.lodMaxClamp = 0.0f;
            state.ground_sampler =
                wgpuDeviceCreateSampler(state.device, &sampler_descriptor);
            WGPUSamplerDescriptor nearest_descriptor =
                WGPU_SAMPLER_DESCRIPTOR_INIT;
            state.nearest_sampler =
                wgpuDeviceCreateSampler(state.device, &nearest_descriptor);
#if defined(BBLITE_HAS_POST_PROCESS) && BBLITE_HAS_POST_PROCESS
            WGPUSamplerDescriptor post_process_descriptor =
                WGPU_SAMPLER_DESCRIPTOR_INIT;
            post_process_descriptor.magFilter = WGPUFilterMode_Linear;
            post_process_descriptor.minFilter = WGPUFilterMode_Linear;
            state.post_process_bilinear_sampler =
                wgpuDeviceCreateSampler(state.device, &post_process_descriptor);
#endif
            // The pinned scene-color sampler: repeat trilinear with the
            // shared anisotropy (getTrilinearAnisotropicSampler).
            WGPUSamplerDescriptor transmission_descriptor =
                WGPU_SAMPLER_DESCRIPTOR_INIT;
            transmission_descriptor.addressModeU = WGPUAddressMode_Repeat;
            transmission_descriptor.addressModeV = WGPUAddressMode_Repeat;
            transmission_descriptor.addressModeW = WGPUAddressMode_Repeat;
            transmission_descriptor.magFilter = WGPUFilterMode_Linear;
            transmission_descriptor.minFilter = WGPUFilterMode_Linear;
            transmission_descriptor.mipmapFilter =
                WGPUMipmapFilterMode_Linear;
            transmission_descriptor.maxAnisotropy =
                static_cast<std::uint16_t>(
                    transmission_sampler_max_anisotropy);
            state.transmission_sampler =
                wgpuDeviceCreateSampler(state.device, &transmission_descriptor);
        }
#if BBLITE_GPU_MORPH_STORAGE
        {
            const std::array<float, 1> zero_delta{0.0f};
            state.empty_morph_deltas = create_buffer(
                state,
                WGPUBufferUsage_Storage,
                zero_delta.data(),
                sizeof(zero_delta));
            // Sixteen-byte {count, vertexCount} header plus one zero
            // weight: derived background pipeline layouts require the
            // shader's 20-byte minimum binding size for the runtime
            // weights array.
            const std::array<std::uint32_t, 5> zero_header{};
            state.empty_morph_weights = create_buffer(
                state,
                WGPUBufferUsage_Storage,
                zero_header.data(),
                sizeof(zero_header));
        }
#endif
        upload_environment(state, scene.environment);
        upload_brdf(state, scene.environment);
        state.reflection_cubes.reserve(engine.reflection_cubes.size());
        state.reflection_cube_views.reserve(engine.reflection_cubes.size());
        for (const auto& cube : engine.reflection_cubes) {
            WGPUTexture texture = upload_reflection_cube(state, cube);
            state.reflection_cubes.push_back(texture);
            state.reflection_cube_views.push_back(cube_view(texture));
        }
        cpu_startup_mark("environment-background");


        // Every scene registered after the first is a swapchain overlay layer,
        // which is the pin's own trigger (scene/swapchain-overlay.ts): a later
        // scene on the same surface keeps the base scene's colour and clears
        // only its own depth. Each layer owns a plan because a draw command
        // indexes one.

        // What each layer's plan was built against; a layer that changes its
        // renderables afterwards is refused rather than drawn stale.

        synced_render_topology_version =
            scene.render_topology_version;
        synced_draw_list_epoch =
            engine.draw_list_epoch;
        // For the post-registration family guard the topology update runs,
        // exactly as the SDL backend tracks it.
        synced_material_family_mask =
            scene.material_family_mask;

        const auto initialize_render_tasks = [&] {
            state.release_render_tasks();
            state.render_tasks.resize(engine.frame_tasks.size());
            for (const TaskHandle handle : scene.tasks) {
                const FrameTaskRecord& task = handle_at(engine.frame_tasks, handle);
                if (task.kind == FrameTaskKind::render) {
                    DawnRenderTask& render_task =
                        handle_at(state.render_tasks, handle);
                    render_task.view_projection = create_buffer(
                        state,
                        WGPUBufferUsage_Uniform,
                        nullptr,
                        64);
                }
            }
            rebuild_task_draw_lists();
        };
        const auto rebuild_meshes = [&] {
            render_plan = upstream::build_render_plan(scene, engine);
            // Validate every item's kind and variant before uploading anything.
            validate_render_plan_items(render_plan);
            cpu_startup_mark("render-plan");
            state.meshes.reserve(render_plan.items.size());
            for (const upstream::RenderItem& item : render_plan.items) {
                state.meshes.push_back(upload_dawn_scene_mesh(state, engine, item));
            }
            for (
                std::size_t layer = 1;
                layer < engine.registered_scenes.size();
                ++layer) {
                Scene* overlay_scene = engine.registered_scenes[layer].get();
                if (!overlay_scene) continue;
                upstream::RenderPlan overlay_plan =
                    upstream::build_render_plan(*overlay_scene, engine);
                validate_render_plan_items(overlay_plan);
                std::vector<DawnMesh> overlay_layer_meshes;
                overlay_layer_meshes.reserve(overlay_plan.items.size());
                for (const upstream::RenderItem& item : overlay_plan.items) {
                    overlay_layer_meshes.push_back(upload_dawn_scene_mesh(state, engine, item));
                }
                overlay_plans.push_back(std::move(overlay_plan));
                state.overlay_meshes.push_back(
                    std::move(overlay_layer_meshes));
                overlay_topology_versions.push_back(
                    overlay_scene->render_topology_version);
            }
#if BBLITE_PINNED_MATERIALS
            state.overlay_frames.resize(overlay_plans.size());
#endif
            cpu_startup_mark("mesh-uploads");
            initialize_render_tasks();
            cpu_startup_mark("draw-lists-ready");
        };
        upstream::initialize_composition_feature_rows(engine);
        rebuild_meshes();

        initialize_dawn_environment(state, scene, use_skybox, use_ground, background_enabled);
        // The composed variant modules load lazily in the loop, so this phase
        // covers only the background/skybox/ground half SDL_GPU builds here too.
        cpu_startup_mark("shaders-pipelines");
#if defined(BBLITE_HAS_TEXT) && BBLITE_HAS_TEXT
        state.text = std::make_unique<DawnTextRenderer>(state.device, state.queue,
            !environment_variable("BBLITE_RENDER_CAPTURE").empty());
        auto& text_ops = data_.text_ops.emplace(state.text->owner);
        const std::string text_color_format = state.frame_color_format == WGPUTextureFormat_BGRA8Unorm
            ? "bgra8unorm" : state.frame_color_format == WGPUTextureFormat_RGBA8Unorm ? "rgba8unorm"
            : throw std::runtime_error("Unrepresented default text color target.");
        state.text->scene.bind(scene, state.text->owner.get(),
            TextTargetSignature{text_color_format, state.sample_count, "depth24plus-stencil8"},
            [&](const upstream::TextPipelineInfo& info) {
                return state.text->pipeline(info, state.frame_color_format, WGPUTextureFormat_Depth24PlusStencil8);
            }, text_ops);
#endif


        data_.camera = &(scene.camera.value < engine.cameras.size()
                ? handle_at(engine.cameras, scene.camera)
                : fallback_camera);


#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI && !(defined(BBLITE_WORKERS) && BBLITE_WORKERS)

#endif








        if (benchmark) {
            benchmark_samples.reserve(
                static_cast<std::size_t>(benchmark_frames));
        }


#if BBLITE_HAS_PICKING
        // The pick pass. Installed before the loop, because the continuation
        // that calls it arrives on the deferred queue at the first frame
        // boundary; a pick taken before this point reports a miss, exactly as
        // the pin's `pickAsync` does for a scene with no camera. The guard
        // clears the hook when this scope ends, however it ends: the hook
        // holds `state`, the scene and the render plan by reference, all of
        // which die with the scope.
        data_.pick_hook_guard.emplace(engine);
#if BBLITE_HAS_BILLBOARDS
        // The contributor's own GPU state, scoped to the hook it serves:
        // upstream it lives in the closure the picker cached and frees in
        // `disposePicker`, which is this scope.

#endif
        engine.pick_hook =
            [&state, &engine, &root_plan = render_plan, &overlay_plans, &active_registered_scenes
#if BBLITE_HAS_BILLBOARDS
             ,
             &billboard_pick
#endif
        ]([[maybe_unused]] GpuPickerHandle picker, double x, double y, const Engine::PickFilter* filter) -> PickingInfo {
            return pick_dawn_scene(state, engine, root_plan, overlay_plans, active_registered_scenes, picker, x, y, filter
#if BBLITE_HAS_BILLBOARDS
                , billboard_pick
#endif
            );
        };
#endif









        // Caller-owned scratch for the custom-shader stage blocks: the packer
        // fills it in place, so the per-draw buffer writes reuse one
        // allocation across draws and frames.

#if BBLITE_GPU_INSTANCING && BBLITE_PBR_VARIANTS > 0

#endif
        // The shared drain owns the per-event contract; the scene loop only
        // adds its camera-controls dispatch, which rides the hook so every
        // event the scene receives also reaches the camera -- and none does
        // in a deterministic test pass.

#if BBLITE_OFFSCREEN_SURFACES
        offscreen = OffscreenRun::current();

        if (offscreen && !screenshot_path.empty()) {
            throw std::runtime_error("Capture offscreen output from its presentation host.");
        }
#endif
#if defined(BBLITE_DEVICE_RECOVERY) && BBLITE_DEVICE_RECOVERY
        data_.draw_count_scope.emplace(engine);
#endif
    }

    FramePreparation prepare() {
        frame_.emplace();
        [[maybe_unused]] auto& engine = data_.engine;
        [[maybe_unused]] auto& input_replay = data_.input_replay;
        [[maybe_unused]] auto& running = data_.running;
        [[maybe_unused]] auto& frame = data_.frame;
        [[maybe_unused]] auto& active_registered_scenes = data_.active_registered_scenes;
        [[maybe_unused]] auto& scene = data_.scene;
        [[maybe_unused]] auto& state = data_.state;
        [[maybe_unused]] auto& width = data_.width;
        [[maybe_unused]] auto& height = data_.height;
        [[maybe_unused]] auto& pointer_state = data_.pointer_state;
        [[maybe_unused]] auto& surface_pointer_state = data_.surface_pointer_state;
        [[maybe_unused]] auto& camera = *data_.camera;
        [[maybe_unused]] auto& hidden_test_pass = data_.frame_options.test_pass;
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI && !(defined(BBLITE_WORKERS) && BBLITE_WORKERS)
        [[maybe_unused]] auto& ui_runtime = data_.ui_runtime;
#endif
#if BBLITE_OFFSCREEN_SURFACES
        [[maybe_unused]] auto& offscreen = data_.offscreen;
#endif
#if BBLITE_OFFSCREEN_SURFACES
        [[maybe_unused]] auto& offscreen_images = data_.offscreen_images;
#endif
#if BBLITE_OFFSCREEN_SURFACES
        [[maybe_unused]] auto& offscreen_image = frame_->offscreen_image;
#endif
        const auto camera_pointer_hook = [&](const SDL_Event& event) {
            if (hidden_test_pass && !is_replayed_ui_event(event)) return;
            dispatch_surface_camera_pointer(engine, event, camera, pointer_state, surface_pointer_state);
        };

#if defined(BBLITE_DEVICE_RECOVERY) && BBLITE_DEVICE_RECOVERY
        if (state.device_lost) {
            force_device_loss(engine);
            return FramePreparation::stop;
        }
        engine.draw_call_count = 0;
#endif
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
            state.node_capture.capture.begin_frame(static_cast<std::uint64_t>(frame));
#endif
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI && !(defined(BBLITE_WORKERS) && BBLITE_WORKERS)
        poll_platform_events(
            engine,
            running,
            hidden_test_pass,
            [&](SDL_Event& event) {
                return handle_ui_rml_event(*ui_runtime, event);
            },
            camera_pointer_hook);
#else
        poll_platform_events(
            engine,
            running,
            hidden_test_pass,
            [](const SDL_Event&) { return true; },
            camera_pointer_hook);
#endif
#if BBLITE_OFFSCREEN_SURFACES
        if (offscreen && !running) return FramePreparation::stop;
#endif
        input_replay.dispatch(frame, state.window, engine);
        if (request_renderer_restart_if_scene_set_changed(
                engine, active_registered_scenes)) {
            return FramePreparation::restart;
        }
        sync_engine_canvas_size(state.window, engine);
        if (resize_dawn_surface(state, engine.options)) {
            width = state.surface_width;
            height = state.surface_height;
            recreate_dawn_scene_targets(state, scene, width, height);
        }
#if BBLITE_OFFSCREEN_SURFACES
        offscreen_image = nullptr;
        if (offscreen) {
            offscreen_image = offscreen_images.acquire(width, height, *offscreen, [&](auto w, auto h) {
                return std::make_shared<DawnOffscreenImage>(state.device, w, h);
            });
            if (!offscreen_image) { frame_->yield_when_skipped = true; return FramePreparation::skip; }
        }
#endif
        // The benchmark bracket mirrors the SDL backend: frame CPU time
        // across the whole loop body -- scene callbacks and uploads, surface
        // acquire, submit and present -- under the immediate present mode
        // both backends configure. It starts here rather than at the
        // acquisition because SDL_GPU has to acquire before it may advance
        // the scene at all (a null swapchain must skip the frame entirely),
        // and a bracket that began at each backend's acquisition would then
        // cover a different span on each.

        return FramePreparation::ready;
    }

    FramePreparation update() {
        [[maybe_unused]] auto& engine = data_.engine;
        [[maybe_unused]] auto& frame_options = data_.frame_options;
        [[maybe_unused]] auto& frame_clock = data_.frame_clock;
        [[maybe_unused]] auto& cpu_profile = data_.cpu_profile;
        [[maybe_unused]] auto& active_registered_scenes = data_.active_registered_scenes;
        [[maybe_unused]] auto& scene = data_.scene;
        [[maybe_unused]] auto& width = data_.width;
        [[maybe_unused]] auto& height = data_.height;
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI && !(defined(BBLITE_WORKERS) && BBLITE_WORKERS)
        [[maybe_unused]] auto& ui_runtime = data_.ui_runtime;
#endif
        [[maybe_unused]] auto& benchmark_start = frame_->benchmark_start;
        [[maybe_unused]] auto& delta_ms = frame_->delta_ms;
        [[maybe_unused]] auto& updated = frame_->updated;
        benchmark_start = monotonic_milliseconds();
        // The frame trace, sprite passes and animated billboard passes
        // read the frame's own delta.
        delta_ms =
            advance_frame(
                engine,
                scene,
                frame_clock,
                frame_options.frame_delta_ms);
        // Scene callbacks may tear down this plan and register a replacement.
        // No surface or command encoder has been acquired yet, so restart
        // before syncing GPU resources or drawing from the disposed scene.
        if (request_renderer_restart_if_scene_set_changed(
                engine, active_registered_scenes)) {
            return FramePreparation::restart;
        }
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI && !(defined(BBLITE_WORKERS) && BBLITE_WORKERS)
        // Browser layout observes DOM changes made by this turn's RAF
        // callbacks before painting the frame.
        update_ui_rml_runtime(*ui_runtime, width, height);
#endif
        // The phase stamps below feed only the CPU profile, so with
        // profiling off they cost nothing; `benchmark_start` above stays
        // unconditional because the benchmark bracket reads it.
        updated =
            cpu_profile ? monotonic_milliseconds() : 0.0;

        return FramePreparation::ready;
    }

    void synchronize() {
        [[maybe_unused]] auto& engine = data_.engine;
        [[maybe_unused]] auto& captures = data_.captures;
        [[maybe_unused]] auto& frame = data_.frame;
        [[maybe_unused]] auto& cpu_profile = data_.cpu_profile;
        [[maybe_unused]] auto& scene = data_.scene;
        [[maybe_unused]] auto& state = data_.state;
        [[maybe_unused]] auto& width = data_.width;
        [[maybe_unused]] auto& height = data_.height;
        [[maybe_unused]] auto& render_plan = data_.render_plan;
        [[maybe_unused]] auto& overlay_plans = data_.overlay_plans;
        [[maybe_unused]] auto& overlay_topology_versions = data_.overlay_topology_versions;
        [[maybe_unused]] auto& synced_render_topology_version = data_.synced_render_topology_version;
        [[maybe_unused]] auto& synced_draw_list_epoch = data_.synced_draw_list_epoch;
        [[maybe_unused]] auto& synced_material_family_mask = data_.synced_material_family_mask;
        [[maybe_unused]] auto& camera_trace_state = data_.camera_trace_state;
        [[maybe_unused]] auto& camera = *data_.camera;
        [[maybe_unused]] auto& screenshot_frame = data_.frame_options.screenshot_frame;
#if defined(BBLITE_HAS_TEXT) && BBLITE_HAS_TEXT
        [[maybe_unused]] auto& text_ops = *data_.text_ops;
#endif
#if BBLITE_GPU_INSTANCING && BBLITE_PBR_VARIANTS > 0
        [[maybe_unused]] auto& pinned_instance_scratch = data_.pinned_instance_scratch;
#endif
        [[maybe_unused]] const auto& delta_ms = frame_->delta_ms;
        [[maybe_unused]] auto& uploaded = frame_->uploaded;
        [[maybe_unused]] auto& written = frame_->written;
        [[maybe_unused]] auto& profile_transformed_meshes = frame_->profile_transformed_meshes;
        [[maybe_unused]] auto& profile_transformed_vertices = frame_->profile_transformed_vertices;
        [[maybe_unused]] auto& topology_updated = frame_->topology_updated;
        [[maybe_unused]] auto& surface_extent = frame_->surface_extent;
        [[maybe_unused]] auto& aspect = frame_->aspect;
        [[maybe_unused]] auto& matrix = frame_->matrix;
        [[maybe_unused]] auto& frame_view = frame_->frame_view;
        [[maybe_unused]] auto& frame_projection = frame_->frame_projection;
        [[maybe_unused]] auto& frame_camera_position = frame_->frame_camera_position;
        [[maybe_unused]] auto& frame_pass_matrices = frame_->frame_pass_matrices;
        [[maybe_unused]] auto& capture_ready = frame_->capture_ready;
        [[maybe_unused]] auto& pass_scene = frame_->pass_scene;
        [[maybe_unused]] auto& pass_meshes = frame_->pass_meshes;
#if BBLITE_NODE_VARIANTS > 0
        [[maybe_unused]] auto& node_mesh_blocks = frame_->node_mesh_blocks;
#endif
        profile_transformed_meshes = 0;
        profile_transformed_vertices = 0;
        trace_dynamic_frame(engine, delta_ms, frame);
#if defined(BBLITE_HAS_SPRITE_RENDERER) && BBLITE_HAS_SPRITE_RENDERER
        // Upstream updates every rendering context before recording any of
        // them. Scene callbacks above may have changed layer membership or
        // instance data, so synchronize and upload every sprite context now.
        sync_dawn_scene_sprites(state, engine);
        for (DawnSpritePass& sprite_pass : state.sprite_passes) {
            // `spriteRendererUpdate` runs the renderer's own hooks before
            // it reads its layers, so an overlay HUD's hook is seen by this
            // frame rather than the next.
            run_sprite_renderer_before_update(
                engine, sprite_pass.renderer, delta_ms);
            sync_dawn_sprite_pass_layers(
                state.device,
                state.queue,
                state.mips,
                engine,
                sprite_pass,
                state.sprite_render_textures,
                state.sprite_render_texture_views);
            upload_dawn_sprite_pass(
                state.device,
                state.queue,
                engine,
                sprite_pass,
                width,
                height,
                delta_ms);
        }
        if (state.has_scene_sprite_pass) {
            upload_dawn_scene_sprite_pass(
                state.device,
                state.queue,
                engine,
                state.scene_sprite_pass,
                width,
                height,
                delta_ms);
        }
#endif
        topology_updated = refresh_overlay_render_plans(
            engine, overlay_plans, state.overlay_meshes, overlay_topology_versions,
            engine.draw_list_epoch != synced_draw_list_epoch,
            [](DawnMesh& mesh) { mesh.reset(); },
            [&](const upstream::RenderItem& item) { return upload_dawn_scene_mesh(state, engine, item); });
        if (topology_updated) {
            state.prune_shared_shader_geometries();
            state.prune_shared_shader_material_textures();
            state.prune_shared_composed_material_textures();
        }
        if (
            scene.render_topology_version !=
            synced_render_topology_version) {
            const std::size_t previous_item_count =
                render_plan.items.size();
            // The table half of the SDL backend's post-registration
            // family guard; this backend loads its modules lazily, so
            // the tables are its whole answer.
            reject_uncomposed_family_growth(
                scene.material_family_mask &
                ~synced_material_family_mask);
            upstream::RenderPlan updated_plan =
                upstream::build_render_plan(scene, engine);
            validate_render_plan_items(updated_plan);
            // Dawn command buffers retain submitted resources, so releasing
            // a removed row drops only this state's reference.
            std::vector<DawnMesh> updated_meshes =
                rematch_render_meshes(
                    render_plan.items,
                    updated_plan.items,
                    state.meshes,
                    [](DawnMesh& mesh) {
                        mesh.reset();
                    },
                    [&](const upstream::RenderItem& item) {
                        return upload_dawn_scene_mesh(state, engine, item);
                    });
            state.prune_shared_shader_geometries();
            state.prune_shared_shader_material_textures();
            state.prune_shared_composed_material_textures();
            state.meshes = std::move(updated_meshes);
            render_plan = std::move(updated_plan);
            synced_render_topology_version =
                scene.render_topology_version;
            synced_material_family_mask = scene.material_family_mask;
            const std::size_t shader_item_count =
                static_cast<std::size_t>(std::count_if(
                    render_plan.items.begin(),
                    render_plan.items.end(),
                    [](const upstream::RenderItem& item) {
                        return item.material_kind ==
                            upstream::RenderMaterialKind::shader;
                    }));
            trace_scene_topology(
                scene,
                engine,
                previous_item_count,
                render_plan.items.size(),
                shader_item_count,
                state.shared_shader_geometries.size(),
                state.shared_shader_material_textures.size(),
                frame);
            topology_updated = true;
        } else if (
            engine.draw_list_epoch != synced_draw_list_epoch) {
            // The pin's visibility epoch re-records the cached opaque
            // render bundles; the draw lists are this port's bundles, so
            // only they and the task lists rebuild -- mesh GPU state is
            // untouched. A culling-enabled thin-instance pool moves the
            // second epoch only when its live count crosses zero, matching
            // the pin's direct-bucket membership.
            render_plan.draw_lists = upstream::build_render_draw_lists(
                render_plan.items,
                engine);
        }
        if (topology_updated || engine.draw_list_epoch != synced_draw_list_epoch) {
            rebuild_task_draw_lists();
        }
        synced_draw_list_epoch = engine.draw_list_epoch;
        // One mesh-sync pass per frame over the plan's items, the same
        // walk and skip logic as the SDL_GPU backend's loop: the
        // thin-instance pool re-upload, the GPU-deformation skip (the
        // palette carries those meshes' world, so a CPU rebake would
        // re-upload the same bytes), the version-gated morph-weight
        // span, and the CPU vertex rebake for everything else. The two
        // per-mesh vertex-stage blocks SDL_GPU pushes per draw --
        // WebGPU has no push constants -- are rewritten here once per
        // frame instead: bone palettes and parent worlds carry no
        // version, so both writes are unconditional, exactly as the
        // per-draw pushes are. The per-draw material blocks stay with
        // their draws in `write_material_uniforms` below.
        // One scene's plan synced against the meshes uploaded for it. A
        // swapchain overlay layer is a second (plan, mesh array) pair, so
        // this takes them rather than closing over the base scene's.
        const auto sync_plan_meshes =
            [&](
                const upstream::RenderPlan& sync_plan,
                std::vector<DawnMesh>& sync_meshes) {
        for (
            std::size_t index = 0;
            index < sync_plan.items.size() &&
            index < sync_meshes.size();
            ++index) {
            const upstream::RenderItem& item =
                sync_plan.items[index];
            const MeshRecord& mesh =
                handle_at(engine.meshes, item.mesh);
            DawnMesh& dawn_mesh = sync_meshes[index];
            // Grid and shader-variant vertex stages own no
            // deformation or instancing uniforms.
            // Both writes below are unconditional -- bone palettes and
            // parent worlds carry no version -- so they would run every
            // frame for a mesh that never draws. SDL pushes the same two
            // per DRAW and so pays nothing for one; this loop was hoisted
            // to once per plan item, which widened it. The plan keeps a
            // hidden mesh so the pick pass can see it, so the sync asks
            // the same predicate the draw lists ask.
            //
            // Sound because visibility reaches the draw lists only through
            // a version bump -- render_topology_version or the visibility
            // epoch -- and the rebuild either triggers runs earlier in
            // this same frame, so the frame a mesh starts drawing is a
            // frame this loop writes it.
            const bool mesh_uniform_item =
                upstream::mesh_draws(mesh) &&
                item.material_kind !=
                    upstream::RenderMaterialKind::grid &&
                item.material_kind !=
                    upstream::RenderMaterialKind::shader;
            (void)mesh_uniform_item;
#if BBLITE_GPU_INSTANCING
            if (
                mesh.thin_instanced &&
                dawn_mesh.instance_version !=
                    mesh.instance_version) {
                // A pool that grew past what registration allocated cannot
                // be filled by a write: the three instance buffers are
                // recreated at the new capacity, which is also a full
                // upload, so the dirty-range write below is skipped that
                // frame. Releasing the old handles here is safe because a
                // submitted command buffer holds its own reference, and
                // this port records no bundles -- every pass reads DawnMesh
                // live at the draw, so a shadow or depth task later this
                // frame binds the new buffers.
                const bool recreated = thin_instance_pool_grew(
                    mesh,
                    dawn_mesh.instance_capacity);
                if (recreated) {
                    const std::size_t rows =
                        mesh.instance_matrices.size();
                    WGPUBuffer const previous_instances =
                        dawn_mesh.instances;
#if BBLITE_HAS_PICKING
                    dawn_mesh.release_thin_pick_group();
#endif
                    wgpuBufferRelease(previous_instances);
                    dawn_mesh.instances = create_buffer(
                        state,
                        WGPUBufferUsage_Vertex | WGPUBufferUsage_Storage,
                        mesh.instance_matrices.data(),
                        rows *
                            sizeof(mesh.instance_matrices.front()));
#if BBLITE_PBR_VARIANTS > 0
                    // The PBR family's mirror-conjugated stream is
                    // allocated for every pool registration saw, and its
                    // draw predicate is the LIVE record -- so a mesh
                    // registered with no pool at all, whose first
                    // addThinInstance lands here, has none yet and would
                    // bind a null buffer. Allocate it whenever the record
                    // now instances, null included, rather than only
                    // refreshing an existing one. A build with no PBR
                    // variant compiles this out, so Standard pays nothing.
                    if (
                        dawn_mesh.pinned_instances &&
                        dawn_mesh.pinned_instances !=
                            previous_instances) {
                        // Aliased to `instances` for some pools and owned
                        // otherwise, exactly as the release path reads it.
                        wgpuBufferRelease(dawn_mesh.pinned_instances);
                    }
                    {
                        pinned_instance_matrices(
                            mesh,
                            rows,
                            pinned_instance_scratch);
                        dawn_mesh.pinned_instances = create_buffer(
                            state,
                            WGPUBufferUsage_Vertex,
                            pinned_instance_scratch.data(),
                            rows *
                                sizeof(pinned_instance_scratch.front()));
                    }
#endif
#if BBLITE_GPU_INSTANCE_COLORS
                    if (dawn_mesh.instance_colors) {
                        // The colour mirror is the scene's own array and
                        // may still be the shorter one; pad to the pool
                        // the way registration does.
                        std::vector<float> instance_colors =
                            instance_colors_for_upload(mesh);
                        instance_colors.resize(rows * 4, 1.0f);
                        wgpuBufferRelease(dawn_mesh.instance_colors);
                        dawn_mesh.instance_colors = create_buffer(
                            state,
                            WGPUBufferUsage_Vertex,
                            instance_colors.data(),
                            instance_colors.size() * sizeof(float));
                    }
#endif
                    dawn_mesh.instance_capacity =
                        static_cast<std::uint32_t>(rows);
                }
                // Re-upload the pinned dirty range [0, count) from
                // the record pool; slots past the active count keep
                // their previous contents and are never drawn.
                const std::size_t active_count =
                    thin_instance_active_count(mesh);
                if (!recreated && active_count > 0) {
                    wgpuQueueWriteBuffer(
                        state.queue,
                        dawn_mesh.instances,
                        0,
                        mesh.instance_matrices.data(),
                        active_count *
                            sizeof(mesh.instance_matrices
                                       .front()));
#if BBLITE_PBR_VARIANTS > 0
                    if (dawn_mesh.pinned_instances) {
                        pinned_instance_matrices(
                            mesh,
                            active_count,
                            pinned_instance_scratch);
                        wgpuQueueWriteBuffer(
                            state.queue,
                            dawn_mesh.pinned_instances,
                            0,
                            pinned_instance_scratch.data(),
                            active_count *
                                sizeof(pinned_instance_scratch.front()));
                    }
#endif
#if BBLITE_GPU_INSTANCE_COLORS
                    if (dawn_mesh.instance_colors) {
                        const auto colors = instance_colors_for_upload(mesh);
                        if (colors.size() >= active_count * 4) {
                            wgpuQueueWriteBuffer(
                                state.queue,
                                dawn_mesh.instance_colors,
                                0,
                                colors.data(),
                                active_count * 4 * sizeof(float));
                        }
                    }
#endif
                }
                dawn_mesh.instance_count =
                    static_cast<std::uint32_t>(active_count);
                dawn_mesh.instance_version =
                    mesh.instance_version;
            }
            if (mesh_uniform_item) {
                const std::array<float, 16> parent_world =
                    instance_parent_draw_world(mesh, scene, engine);
                wgpuQueueWriteBuffer(
                    state.queue,
                    dawn_mesh.instance_uniform,
                    0,
                    parent_world.data(),
                    64);
            }
#endif
#if BBLITE_GPU_DEFORMATION
            if (mesh_uniform_item) {
                const DeformationUniforms deformation =
                    build_deformation_uniforms(
                        mesh,
                        engine.geometries[item.geometry]
                            .flat_normals);
                wgpuQueueWriteBuffer(
                    state.queue,
                    dawn_mesh.deformation_uniforms,
                    0,
                    &deformation,
                    sizeof(deformation));
            }
#endif
#if BBLITE_MESH_POSITION_UPDATE
            const ModelGeometry& geometry =
                engine.geometries[item.geometry];
            if (
                dawn_mesh.position_version !=
                geometry.position_version) {
                const std::vector<GpuVertex> vertices =
                    item.material_kind ==
                            upstream::RenderMaterialKind::shader
                        ? local_vertices(engine, geometry)
                        : transformed_vertices(engine, geometry, mesh);
                ++profile_transformed_meshes;
                profile_transformed_vertices += vertices.size();
                wgpuQueueWriteBuffer(
                    state.queue,
                    dawn_mesh.vertices,
                    0,
                    vertices.data(),
                    vertices.size() * sizeof(GpuVertex));
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
                state.node_capture.update(dawn_mesh.vertices, vertices.data(), vertices.size() * sizeof(GpuVertex));
#endif
#if BBLITE_PBR_VARIANTS > 0
                if (dawn_mesh.pinned_vertices) {
                    const std::vector<GpuVertex> pinned =
                        pinned_convention_vertices(
                            vertices,
                            mesh.mirrored_x);
                    wgpuQueueWriteBuffer(
                        state.queue,
                        dawn_mesh.pinned_vertices,
                        0,
                        pinned.data(),
                        pinned.size() * sizeof(GpuVertex));
                }
#endif
                dawn_mesh.position_version =
                    geometry.position_version;
                dawn_mesh.transform_version = mesh.transform_version;
                dawn_mesh.gpu_world_transform =
                    mesh.gpu_world_transform;
            }
#endif
            if (
                mesh.gpu_deformation &&
                !engine.geometries[item.geometry].flat_normals) {
#if BBLITE_GPU_MORPH_STORAGE
                sync_morph_weights(state, dawn_mesh, engine.geometries[item.geometry], mesh);
#endif
                dawn_mesh.transform_version =
                    mesh.transform_version;
                continue;
            }
            if (
                dawn_mesh.transform_version ==
                    mesh.transform_version &&
                dawn_mesh.gpu_world_transform ==
                    mesh.gpu_world_transform) {
                continue;
            }
            if (
                item.material_kind ==
                upstream::RenderMaterialKind::shader) {
                dawn_mesh.gpu_world_transform =
                    mesh.gpu_world_transform;
                dawn_mesh.transform_version = mesh.transform_version;
                continue;
            }
            if (
                mesh.gpu_world_transform &&
                dawn_mesh.gpu_world_transform) {
                dawn_mesh.transform_version = mesh.transform_version;
                continue;
            }
            const std::vector<GpuVertex> vertices =
                transformed_vertices(
                    engine,
                    engine.geometries[item.geometry],
                    mesh);
            wgpuQueueWriteBuffer(
                state.queue,
                dawn_mesh.vertices,
                0,
                vertices.data(),
                vertices.size() * sizeof(GpuVertex));
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
                state.node_capture.update(dawn_mesh.vertices, vertices.data(), vertices.size() * sizeof(GpuVertex));
#endif
#if BBLITE_PBR_VARIANTS > 0
            if (dawn_mesh.pinned_vertices) {
                const std::vector<GpuVertex> pinned =
                    pinned_convention_vertices(
                        vertices,
                        mesh.mirrored_x);
                wgpuQueueWriteBuffer(
                    state.queue,
                    dawn_mesh.pinned_vertices,
                    0,
                    pinned.data(),
                    pinned.size() * sizeof(GpuVertex));
            }
#endif
            dawn_mesh.transform_version =
                mesh.transform_version;
            dawn_mesh.gpu_world_transform =
                mesh.gpu_world_transform;
        }
        };
        sync_plan_meshes(render_plan, state.meshes);
        for (
            std::size_t layer = 0;
            layer < overlay_plans.size() &&
            layer < state.overlay_meshes.size();
            ++layer) {
            sync_plan_meshes(
                overlay_plans[layer],
                state.overlay_meshes[layer]);
        }
        uploaded =
            cpu_profile ? monotonic_milliseconds() : 0.0;
        update_surface_cameras(engine, camera);
        trace_camera_state(camera, camera_trace_state, frame);
        upstream::sort_transparent_draws(
            render_plan.draw_lists.transparent,
            engine,
            camera);

        // getEffectiveAspectRatio divides two JavaScript numbers, so
        // the ratio reaches the projection writer in double. It is the
        // pinned function itself: a camera carrying a viewport scales
        // the target ratio by the viewport's own, and one without takes
        // the pin's literal 1.
        surface_extent = scene_surface_extent(
            engine, scene, width, height);
        aspect =
            upstream::effective_aspect_ratio(
                camera,
                static_cast<double>(surface_extent.width),
                static_cast<double>(surface_extent.height));
        matrix =
            upstream::build_view_projection(camera, aspect);
#if defined(BBLITE_HAS_TEXT) && BBLITE_HAS_TEXT
        validate_text_scene(scene);
        state.text->owner->capture.begin_frame(static_cast<std::uint64_t>(frame));
        const TextCameraInput text_camera{matrix, upstream::scene_camera_change_key(camera), aspect};
        state.text->scene.update(scene.camera.value < engine.cameras.size() ? &text_camera : nullptr,
            static_cast<double>(surface_extent.width), static_cast<double>(surface_extent.height), text_ops);
#endif
        // The frame's own two factors, built once. A shader material may
        // declare either beside the product, the pin's splat UBO stores
        // them separately, and the billboard sort reads the view. The
        // projection is the pin's `getProjectionMatrix` -- the arm that
        // branches on the camera -- rather than the perspective writer.
        frame_view =
            upstream::build_view_matrix(
                upstream::camera_world_matrix(camera));
        frame_projection =
            upstream::build_scene_projection(camera, aspect);
        frame_camera_position =
            shader_camera_position(scene, engine, camera);
        frame_pass_matrices = {
            matrix.data(), &frame_view, &frame_projection};
        frame_pass_matrices.camera_position = &frame_camera_position;
#if BBLITE_HAS_SPLATS
        {
            // Lazily built for the same reason the billboard passes are:
            // the clouds are known only once the scene has run. The sort
            // then follows the camera, which `upload_dawn_splat_pass`
            // decides with the pin's own epsilon.
            if (state.splat_passes.empty()) {
                for (const SplatMeshHandle splat : scene.splat_meshes) {
                    state.splat_passes.push_back(create_dawn_splat_pass(
                        state.device,
                        state.queue,
                        state.frame_color_format,
                        WGPUTextureFormat_Depth24PlusStencil8,
                        state.sample_count,
                        engine,
                        splat));
                }
            }
            for (DawnSplatPass& splat : state.splat_passes) {
                upload_dawn_splat_pass(
                    state.queue,
                    engine,
                    splat,
                    frame_view,
                    frame_projection,
                    frame_camera_position,
                    static_cast<float>(width),
                    static_cast<float>(height));
            }
        }
#endif
#if defined(BBLITE_HAS_CLUSTERED_LIGHTS) && BBLITE_HAS_CLUSTERED_LIGHTS
        // The cluster binning, in the place the splat sort runs and for the
        // same reason: it reads this frame's camera and the draws below read
        // what it wrote.
        if (ClusteredLightContainer* clustered =
                upstream::clustered_container(
                    engine, scene.clustered_lights)) {
            upload_dawn_clustered(
                state.device,
                state.queue,
                *clustered,
                frame_view,
                frame_projection,
                camera.near_plane,
                camera.far_plane,
                state.clustered);
        }
#endif
#if BBLITE_HAS_BILLBOARDS
        {
            // Lazily built, because the systems are known only once the
            // scene has run; the sort then follows the camera every frame.
            if (state.billboard_passes.empty()) {
                for (const BillboardSystemHandle system :
                     scene.billboard_systems) {
                    state.billboard_passes.push_back(
                        create_dawn_billboard_pass(
                            state.device,
                            state.queue,
                            engine,
                            system,
                            state.frame_color_format,
                            WGPUTextureFormat_Depth24PlusStencil8,
                            state.sample_count));
                    // The atlas reports the chain it allocated; the blit
                    // that fills it is this state's.
                    const DawnBillboardPass& built =
                        state.billboard_passes.back();
                    generate_mipmaps(
                        state,
                        built.atlas,
                        WGPUTextureFormat_RGBA8Unorm,
                        built.atlas_mip_levels);
                }
            }
            for (DawnBillboardPass& billboard : state.billboard_passes) {
                upload_dawn_billboard_pass(
                    state.queue,
                    scene,
                    engine,
                    billboard,
                    matrix,
                    frame_view,
                    delta_ms);
            }
        }
#endif
        capture_ready =
            frame >= screenshot_frame && !topology_updated &&
            captures.drains_resolved();

#if (!defined(BBLITE_HAS_TAA) || !BBLITE_HAS_TAA) && (!defined(BBLITE_HAS_TEXT) || !BBLITE_HAS_TEXT)
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
            if (!state.node_capture.capture.enabled())
#endif
        capture_render_state();
#endif
        wgpuQueueWriteBuffer(
            state.queue,
            state.view_projection,
            0,
            matrix.data(),
            sizeof(matrix));
#if BBLITE_PINNED_MATERIALS
        // The pin's per-pass blocks, before anything reads them: the scene block
        // the variants' vertex and fragment stages share, and the lights array
        // their multi-light arm indexes.
        write_pinned_frame_blocks(
            state,
            scene,
            engine,
            camera,
            matrix);
#if BBLITE_PINNED_MATERIALS
        // Each overlay layer's own scene and lights blocks, written into
        // its own buffers. A queue write lands before the whole command
        // buffer runs, so the base scene's blocks cannot simply be
        // rewritten between the two passes.
        for (
            std::size_t layer = 0;
            layer < overlay_plans.size() &&
            layer < state.overlay_frames.size();
            ++layer) {
            Scene* overlay_scene = engine.registered_scenes[layer + 1u].get();
            if (!overlay_scene) continue;
            DawnState::OverlayFrame& overlay =
                state.overlay_frames[layer];
            overlay_frame_group(state, overlay);
            const CameraRecord& overlay_camera =
                overlay_scene->camera.value < engine.cameras.size()
                    ? handle_at(engine.cameras, overlay_scene->camera)
                    : camera;
            // A layer's own camera answers `getEffectiveAspectRatio` for
            // itself: upstream each scene's render task writes its OWN
            // scene UBO from `cfg.cam ?? scene.camera`, so two scenes
            // splitting one target by viewport project at two ratios.
            const PixelViewport overlay_surface_extent =
                scene_surface_extent(
                    engine, *overlay_scene, width, height);
            const double overlay_aspect =
                upstream::effective_aspect_ratio(
                    overlay_camera,
                    static_cast<double>(overlay_surface_extent.width),
                    static_cast<double>(overlay_surface_extent.height));
            const upstream::SceneUniforms overlay_scene_block =
                pinned_scene_block(
                    *overlay_scene,
                    engine,
                    overlay_camera,
                    upstream::build_view_projection(
                        overlay_camera,
                        overlay_aspect));
            wgpuQueueWriteBuffer(
                state.queue,
                overlay.scene_uniforms,
                0,
                &overlay_scene_block,
                sizeof(overlay_scene_block));
            const std::vector<std::uint8_t> overlay_lights =
                pinned_lights_block(*overlay_scene, engine);
            wgpuQueueWriteBuffer(
                state.queue,
                overlay.lights_uniforms,
                0,
                overlay_lights.data(),
                overlay_lights.size());
        }
#endif
#if BBLITE_SHADOW_RECEIVERS
        // The shadow generators' matrices and their receiver blocks, before
        // the caster pass reads the first and the receiving draws read the
        // second.
        for (const auto& registered_scene : engine.registered_scenes) {
            write_shadow_generators(state, *registered_scene, engine);
        }
#endif
#endif
        // RAF callbacks and CSM receiver subscriptions can both update
        // ShaderMaterial storage. Publish their latest bytes before any
        // caster or colour pass builds and binds the reflected groups.
        sync_shader_storage_buffers(state, engine);
        // The pass's own matrices travel with the list: a render task
        // renders through its own camera and target aspect, and a shadow
        // caster pass through the generator's light-space matrix, so a
        // shader material's system block reads what its pass renders with
        // rather than the frame's.
        //
        // `pass_dependent_only` is how a cascade after the first renders:
        // only the shader and grid arms below read `pass_matrices`, so the
        // rest would rewrite the same buffers with the same bytes once per
        // cascade -- 2,412 redundant queue writes per frame on scene 214,
        // whose 201 casters draw four times. SDL_GPU's palette sweep
        // already dedupes its own half this way.
        // Which scene the pass being written and recorded belongs to, and
        // the meshes uploaded for it. The base scene goes first; a
        // swapchain overlay layer repoints these before its own write and
        // its own pass, because the walk is the same one and only the
        // scene it reads its light selection and its uploaded meshes from
        // changes.
        // Every reader is a material-variant draw, so a build that
        // composes no variants at all -- a splat-only scene, say -- sets
        // this and never reads it.
        pass_scene = &scene;
        pass_meshes = &state.meshes;
#if BBLITE_NODE_VARIANTS > 0
        // This frame's node mesh blocks, composed once per mesh per scene
        // and written into every view's own buffer below. A local, so the
        // next frame composes them again against the meshes it moved.

#endif

#if !defined(BBLITE_HAS_TAA) || !BBLITE_HAS_TAA
        write_material_uniforms(
            render_plan.draw_lists.opaque, frame_pass_matrices);
        write_material_uniforms(
            render_plan.draw_lists.transparent, frame_pass_matrices);
        // The same write phase for each swapchain overlay layer, over the
        // layer's own draw lists and its own uploaded meshes.
        for (
            std::size_t layer = 0;
            layer < overlay_plans.size() &&
            layer < state.overlay_meshes.size();
            ++layer) {
            Scene* overlay_scene = engine.registered_scenes[layer + 1u].get();
            if (!overlay_scene) continue;
            const CameraRecord& overlay_camera =
                overlay_scene->camera.value < engine.cameras.size()
                    ? handle_at(engine.cameras, overlay_scene->camera)
                    : camera;
            // The layer's own effective aspect, as above: a viewport is
            // the camera's, not the target's.
            const PixelViewport overlay_surface_extent =
                scene_surface_extent(
                    engine, *overlay_scene, width, height);
            const double overlay_aspect =
                upstream::effective_aspect_ratio(
                    overlay_camera,
                    static_cast<double>(overlay_surface_extent.width),
                    static_cast<double>(overlay_surface_extent.height));
            const std::array<float, 16> overlay_matrix =
                upstream::build_view_projection(
                    overlay_camera,
                    overlay_aspect);
            const std::array<float, 16> overlay_view =
                upstream::build_view_matrix(
                    upstream::camera_world_matrix(overlay_camera));
            const std::array<float, 16> overlay_projection =
                upstream::build_scene_projection(
                    overlay_camera,
                    overlay_aspect);
            const std::array<float, 4> overlay_camera_position =
                shader_camera_position(
                    *overlay_scene,
                    engine,
                    overlay_camera);
            ShaderPassMatrices overlay_pass_matrices{
                overlay_matrix.data(),
                &overlay_view,
                &overlay_projection};
            overlay_pass_matrices.camera_position =
                &overlay_camera_position;
            pass_scene = overlay_scene;
            pass_meshes = &state.overlay_meshes[layer];
            write_material_uniforms(
                overlay_plans[layer].draw_lists.opaque,
                overlay_pass_matrices);
            write_material_uniforms(
                overlay_plans[layer].draw_lists.transparent,
                overlay_pass_matrices);
            pass_scene = &scene;
            pass_meshes = &state.meshes;
        }
#endif
        if (state.skybox_enabled) {
            const std::array<float, 16> skybox_view_projection =
                upstream::build_skybox_view_projection(
                    camera,
                    aspect);
            if (scene.environment.skybox_uses_environment) {
                wgpuQueueWriteBuffer(
                    state.queue,
                    state.skybox_matrix,
                    0,
                    skybox_view_projection.data(),
                    sizeof(skybox_view_projection));
            } else {
                const upstream::SkyboxVertexUniforms vertex_uniforms =
                    upstream::build_skybox_vertex_uniforms(
                        scene.environment,
                        matrix);
                wgpuQueueWriteBuffer(
                    state.queue,
                    state.skybox_matrix,
                    0,
                    &vertex_uniforms,
                    sizeof(vertex_uniforms));
            }
            const upstream::SkyboxUniforms skybox =
                upstream::build_skybox_uniforms(
                    scene.environment,
                    scene.transmission_enabled);
            wgpuQueueWriteBuffer(
                state.queue,
                state.skybox_uniforms,
                0,
                &skybox,
                sizeof(skybox));
        }
        if (state.ground_enabled) {
            const upstream::BackgroundUniforms background =
                upstream::build_background_uniforms(
                    scene.environment,
                    camera,
                    scene.transmission_enabled);
            wgpuQueueWriteBuffer(
                state.queue,
                state.ground_uniforms,
                0,
                &background,
                sizeof(background));
        }
#if BBLITE_SOLID_SKYBOX
        if (state.solid_skybox_enabled) {
            // The pinned vertex stage reads its own scene block -- the
            // matrix beside the view and the eye position it offsets the
            // cube by -- so the draw binds that layout over the frame's
            // matrix.
            const upstream::SolidSkyboxSceneUniforms
                solid_skybox_scene =
                    upstream::build_solid_skybox_scene_uniforms(
                        camera,
                        matrix);
            wgpuQueueWriteBuffer(
                state.queue,
                state.solid_skybox_scene_uniforms,
                0,
                &solid_skybox_scene,
                sizeof(solid_skybox_scene));
            const upstream::SolidSkyboxUniforms solid_skybox_mesh =
                upstream::build_solid_skybox_uniforms(scene);
            wgpuQueueWriteBuffer(
                state.queue,
                state.solid_skybox_mesh_uniforms,
                0,
                &solid_skybox_mesh,
                sizeof(solid_skybox_mesh));
        }
#endif
#if BBLITE_IMAGE_SKYBOX
        if (state.image_skybox_enabled) {
            const upstream::ImageSkyboxUniforms
                image_skybox_uniforms =
                    upstream::build_image_skybox_uniforms(
                        scene,
                        camera);
            wgpuQueueWriteBuffer(
                state.queue,
                state.image_skybox_uniforms,
                0,
                &image_skybox_uniforms,
                sizeof(image_skybox_uniforms));
        }
#endif
        if (!scene.tasks.empty()) {
#if defined(BBLITE_HAS_TAA) && BBLITE_HAS_TAA
            if (!engine.stopped) create_frame_graph_textures(state, engine, width, height);
#else
            create_frame_graph_textures(state, engine, width, height);
#if BBLITE_SHADOW_RECEIVERS
            // Which generators have had their casters' pass-independent
            // blocks written this frame. A cascaded generator renders one
            // task per cascade and every one of them carries the SAME
            // casters -- `refresh_shadow_task_meshes` adds each caster to
            // every task through the same view -- so the first cascade
            // writes the blocks and the rest name only their own matrices.
            std::vector<bool> wrote_caster_blocks(
                engine.shadow_generators.size(),
                false);
#endif
            for (std::size_t graph_layer = 0;
                 graph_layer < engine.registered_scenes.size(); ++graph_layer) {
            const Scene& graph_scene = *engine.registered_scenes[graph_layer];
            const CameraRecord& graph_camera = graph_scene.camera.value < engine.cameras.size()
                ? handle_at(engine.cameras, graph_scene.camera) : camera;
            const auto graph_extent = scene_surface_extent(
                engine, graph_scene, width, height);
#if BBLITE_GEOMETRY_TASK_FAMILIES
            std::optional<std::array<float, 16>> graph_matrix;
#endif
            pass_scene = &graph_scene;
            pass_meshes = graph_layer == 0 ? &state.meshes : &state.overlay_meshes[graph_layer - 1];
            [[maybe_unused]] WGPUBuffer graph_lights = nullptr;
#if BBLITE_PINNED_MATERIALS
            if (graph_layer > 0) graph_lights = state.overlay_frames[graph_layer - 1].lights_uniforms;
#endif
            for (const TaskHandle handle : graph_scene.tasks) {
                if (handle.value >= engine.frame_tasks.size()) {
                    throw std::runtime_error(
                        "Scene frame task handle is invalid.");
                }
                const FrameTaskRecord& task =
                    handle_at(engine.frame_tasks, handle);
                if (task.kind == FrameTaskKind::geometry) {
#if BBLITE_GEOMETRY_TASK_FAMILIES
                    if (!graph_matrix) {
                        const double graph_aspect = upstream::effective_aspect_ratio(
                            graph_camera, graph_extent.width, graph_extent.height);
                        graph_matrix = upstream::build_view_projection(graph_camera, graph_aspect);
                    }
#endif
                    upstream::sort_transparent_draws(
                        handle_at(state.render_tasks, handle)
                            .draw_lists.transparent,
                        engine,
                        graph_camera);
#if BBLITE_GEOMETRY_TASK_FAMILIES
                    // The task's own frame state, written once and before
                    // any family: its scene block, its gpUniforms buffer and
                    // the previous-view-projection it tracks are properties
                    // of the TASK, so which families the scene composed
                    // decides only whether it is written at all.
                    if (
                        pinned_lists_have_pinned_draws(
                            handle_at(state.render_tasks, handle).draw_lists)) {
                        write_pinned_geometry_prologue(
                            state,
                            graph_scene,
                            engine,
                            graph_camera,
                            handle_at(state.geometry_tasks, handle),
                            *graph_matrix);
                    }
#endif
#if BBLITE_PBR_VARIANTS > 0
                    // A task whose draws are PBR writes its blocks here:
                    // each draw's mesh and material blocks against the MRT
                    // variant the selector table keys on this task.
                    write_pinned_geometry_task(
                        state,
                        graph_scene,
                        engine,
                        task,
                        handle_at(state.geometry_tasks, handle),
                        handle_at(state.render_tasks, handle).draw_lists);
#endif
#if BBLITE_STANDARD_VARIANTS > 0
                    write_standard_geometry_task(
                        state,
                        graph_scene,
                        engine,
                        task,
                        handle_at(state.geometry_tasks, handle),
                        handle_at(state.render_tasks, handle).draw_lists);
#endif
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
                    // The node family's own MRT arm, third and last: the
                    // view composed for this task, its mesh block and the
                    // group carrying the task's gpUniforms.
                    write_node_geometry_task(
                        state,
                        node_mesh_blocks,
                        graph_scene,
                        engine,
                        task,
                        handle_at(state.geometry_tasks, handle),
                        handle_at(state.render_tasks, handle).draw_lists);
#endif
                    continue;
                }
                if (task.kind != FrameTaskKind::render) continue;
                DawnRenderTask& render_task =
                    handle_at(state.render_tasks, handle);
                if (
                    task.render.target.value >=
                    engine.render_targets.size()) {
                    throw std::runtime_error(
                        "Render task target is invalid.");
                }
                const RenderTargetRecord& target_record =
                    handle_at(engine.render_targets, task.render.target);
                const DawnRenderTarget& target =
                    handle_at(state.render_targets, task.render.target);
                const CameraRecord& task_camera =
                    task.render.has_camera &&
                            task.render.camera.value <
                                engine.cameras.size()
                        ? handle_at(engine.cameras, task.render.camera)
                        : graph_camera;
                // `_writePassSceneUBO` folds the camera's own viewport
                // into whichever extent the task was configured for --
                // the canvas or the target.
                const double task_aspect = task.render.canvas_size
                    ? upstream::effective_aspect_ratio(
                          task_camera,
                          static_cast<double>(graph_extent.width),
                          static_cast<double>(graph_extent.height))
                    : upstream::effective_aspect_ratio(
                          task_camera,
                          static_cast<double>(target.width),
                          static_cast<double>(target.height));
                // A shadow task renders from the light, not from a
                // camera: the generator's own matrices replace both of
                // these below, so building and uploading a camera
                // view-projection first would be a dead pass over the
                // camera basis and a dead 64-byte write.
                const bool shadow_task =
                    task.render.shadow_generator.value !=
                    invalid_handle;
                const std::array<float, 16> task_matrix = shadow_task
                    ? std::array<float, 16>{}
                    : upstream::build_view_projection(
                        task_camera,
                        task_aspect);
                // The task's own two factors, beside its product, for a
                // shader material that declares one.
                const std::array<float, 16> task_view =
                    upstream::build_view_matrix(
                        upstream::camera_world_matrix(task_camera));
                const std::array<float, 16> task_projection =
                    upstream::build_scene_projection(
                        task_camera, task_aspect);
                const std::array<float, 4> task_camera_position =
                    shader_camera_position(graph_scene, engine, task_camera);
                ShaderPassMatrices task_pass_matrices{
                    task_matrix.data(), &task_view, &task_projection};
                task_pass_matrices.camera_position =
                    &task_camera_position;
                if (!shadow_task) {
                    wgpuQueueWriteBuffer(
                        state.queue,
                        render_task.view_projection,
                        0,
                        task_matrix.data(),
                        64);
                }
#if BBLITE_SHADOW_RECEIVERS
                // A shadow caster pass renders from the light. The pin gives
                // it a camera facade whose view and view-projection caches it
                // pins to the light-space matrices; there is no facade here,
                // so the pass block is written from the generator directly --
                // the BIASED view-projection, which is the one
                // `updateShadowCameraBase` receives.
                if (
                    task.render.shadow_generator.value <
                        engine.shadow_generators.size() &&
                    // A gated frame runs no caster pass, so nothing reads
                    // these blocks — and the generator's matrices they are
                    // written from are unchanged anyway. The pin's skipped
                    // `render*ShadowMap` writes nothing either.
                    state.shadow_refresh.gates[
                        task.render.shadow_generator.value].due) {
                    const pal::ShadowCasterMatrices caster =
                        pal::shadow_caster_matrices(engine, task);
                    const std::array<float, 16>& caster_view_projection =
                        caster.view_projection;
                    const std::array<float, 16>& caster_view = caster.view;
                    upstream::SceneUniforms shadow_block =
                        pinned_scene_block(
                            graph_scene,
                            engine,
                            graph_camera,
                            caster_view_projection);
                    shadow_block.view = caster_view;
                    task_pinned_frame_group(state, render_task, graph_lights);
                    wgpuQueueWriteBuffer(
                        state.queue,
                        render_task.pinned_scene_uniforms,
                        0,
                        &shadow_block,
                        sizeof(shadow_block));
                    wgpuQueueWriteBuffer(
                        state.queue,
                        render_task.view_projection,
                        0,
                        caster_view_projection.data(),
                        64);
                    ShaderPassMatrices caster_pass_matrices{
                        caster_view_projection.data(),
                        &caster_view,
                        nullptr};
                    caster_pass_matrices.camera_position =
                        &task_camera_position;
                    const std::size_t generator_index =
                        task.render.shadow_generator.value;
                    const bool later_cascade =
                        generator_index < wrote_caster_blocks.size() &&
                        wrote_caster_blocks[generator_index];
                    if (generator_index < wrote_caster_blocks.size()) {
                        wrote_caster_blocks[generator_index] = true;
                    }
                    write_material_uniforms(
                        render_task.draw_lists.opaque,
                        caster_pass_matrices,
                        later_cascade);
                    write_material_uniforms(
                        render_task.draw_lists.transparent,
                        caster_pass_matrices,
                        later_cascade);
                }
#endif
#if BBLITE_PINNED_MATERIALS
                // A colour task that is not a caster pass reads its OWN
                // pass block, which is the rule the SDL_GPU backend states
                // as `if (!shadow_task)` around its own push.
                //
                // It used to be written only for a task the scene gave its
                // own camera, on the reading that a second camera is the
                // only thing that moves the view-projection. It is not: the
                // matrix is built from `task_aspect`, and that comes from
                // the task's TARGET. A task rendering the scene camera into
                // a target the canvas's shape does not share -- scene 187
                // renders into half the canvas width -- then drew through
                // the frame's matrix and came out squeezed by exactly the
                // ratio of the two extents.
                //
                // `!shadow_task` is the other half, and dropping it was a
                // regression: `task_matrix` is deliberately the ZERO matrix
                // for a caster pass, which has no camera view-projection to
                // build, so writing the block there hands every receiver a
                // zeroed one. Six shadow scenes and a demo moved on Dawn
                // alone while SDL_GPU stayed byte-identical -- which is the
                // differential naming the side before anything was read.
                if (target_record.has_color && !shadow_task) {
                    // The task's own pass block, in the pin's own shape: the
                    // frame's writer over the task's camera and matrix.
                    const upstream::SceneUniforms task_scene_block =
                        pinned_scene_block(
                            graph_scene,
                            engine,
                            task_camera,
                            task_matrix);
                    task_pinned_frame_group(state, render_task, graph_lights);
                    wgpuQueueWriteBuffer(
                        state.queue,
                        render_task.pinned_scene_uniforms,
                        0,
                        &task_scene_block,
                        sizeof(task_scene_block));
                }
#endif
                if (task.render.scene_stages && state.skybox_enabled) {
                    const bool dds = !graph_scene.environment.skybox_uses_environment;
                    if (!render_task.skybox_matrix) {
                        render_task.skybox_matrix = create_buffer(state, WGPUBufferUsage_Uniform,
                            nullptr, dds ? sizeof(upstream::SkyboxVertexUniforms) : 64);
                        render_task.skybox_scene_group = skybox_scene_group_over(
                            state, render_task.skybox_matrix, dds);
                    }
                    if (dds) {
                        const auto skybox = upstream::build_skybox_vertex_uniforms(graph_scene.environment, task_matrix);
                        wgpuQueueWriteBuffer(state.queue, render_task.skybox_matrix, 0, &skybox, sizeof(skybox));
                    } else {
                        const auto skybox = upstream::build_skybox_view_projection(task_camera, task_aspect);
                        wgpuQueueWriteBuffer(state.queue, render_task.skybox_matrix, 0, skybox.data(), sizeof(skybox));
                    }
                }
                // A colour task's own draws, prepared under its own
                // camera. Both halves are skipped for a depth-only task
                // and each for its own reason, so neither is riding the
                // other's test: it encodes through
                // `depth_only_pipeline_for`, which reads none of the
                // blocks or groups these writes build; and its draws write
                // depth without blending, so back-to-front order changes
                // nothing to sort for. The SDL backend sorts in exactly
                // its colour and geometry task arms for the same reasons.
                if (target_record.has_color) {
                    upstream::sort_transparent_draws(
                        render_task.draw_lists.transparent,
                        engine,
                        task_camera);
                    write_material_uniforms(
                        render_task.draw_lists.opaque, task_pass_matrices);
                    write_material_uniforms(
                        render_task.draw_lists.transparent,
                        task_pass_matrices);
                }
            }
            }
            pass_scene = &scene;
            pass_meshes = &state.meshes;
#endif
        }

        written =
            cpu_profile ? monotonic_milliseconds() : 0.0;
    }

    bool acquire() {
        [[maybe_unused]] auto& cpu_profile = data_.cpu_profile;
        [[maybe_unused]] auto& state = data_.state;
        [[maybe_unused]] auto& acquired = frame_->acquired;
        [[maybe_unused]] auto& surface_texture = frame_->surface_texture;
        [[maybe_unused]] auto& surface = frame_->surface;
        [[maybe_unused]] auto& surface_view = frame_->surface_view;
#if BBLITE_OFFSCREEN_SURFACES
        [[maybe_unused]] auto& offscreen_image = frame_->offscreen_image;
#endif
        surface_texture = WGPU_SURFACE_TEXTURE_INIT;

#if BBLITE_OFFSCREEN_SURFACES
        if (offscreen_image) {
            surface_texture.texture = offscreen_image->texture;
            wgpuTextureAddRef(surface_texture.texture);
            surface = surface_texture.texture;
        } else {
#endif
        wgpuSurfaceGetCurrentTexture(state.surface, &surface_texture);
        surface = surface_texture.texture;
        if (
            surface_texture.status !=
                WGPUSurfaceGetCurrentTextureStatus_SuccessOptimal &&
            surface_texture.status !=
                WGPUSurfaceGetCurrentTextureStatus_SuccessSuboptimal) {
            dawn_error("wgpuSurfaceGetCurrentTexture failed.");
        }
#if BBLITE_OFFSCREEN_SURFACES
        }
#endif
        surface_view = create_dawn_texture_view(surface_texture.texture, nullptr);
        acquired =
            cpu_profile ? monotonic_milliseconds() : 0.0;


        return true;
    }

    void encode() {
        [[maybe_unused]] auto& engine = data_.engine;
        [[maybe_unused]] auto& frame_options = data_.frame_options;
        [[maybe_unused]] auto& scene = data_.scene;
        [[maybe_unused]] auto& state = data_.state;
        [[maybe_unused]] auto& width = data_.width;
        [[maybe_unused]] auto& height = data_.height;
        [[maybe_unused]] auto& render_plan = data_.render_plan;
        [[maybe_unused]] auto& overlay_plans = data_.overlay_plans;
        [[maybe_unused]] auto& overlay_topology_versions = data_.overlay_topology_versions;
        [[maybe_unused]] auto& camera = *data_.camera;
#if defined(BBLITE_HAS_TEXT) && BBLITE_HAS_TEXT
        [[maybe_unused]] auto& text_ops = *data_.text_ops;
#endif
        [[maybe_unused]] auto& pass_scene = frame_->pass_scene;
        [[maybe_unused]] auto& pass_meshes = frame_->pass_meshes;
        [[maybe_unused]] auto& surface_texture = frame_->surface_texture;
        [[maybe_unused]] auto& surface_view = frame_->surface_view;
        [[maybe_unused]] auto& encoder = frame_->encoder;
        [[maybe_unused]] auto& capture_source = frame_->capture_source;
        [[maybe_unused]] auto& frame_graph_presented = frame_->frame_graph_presented;
        encoder = wgpuDeviceCreateCommandEncoder(state.device, nullptr);
        capture_source = surface_texture.texture;
        // Meaningful only under the frame-graph arm, where the default
        // above is a never-rendered surface: set by the same two arms
        // that name the SDL backend's capture source -- the
        // copy-to-swapchain blit and the post-process present -- so a
        // graph that presents through neither refuses capture below
        // instead of reading the raw surface back.
        frame_graph_presented = false;
        const auto draw_list_into = [&](
                                        WGPURenderPassEncoder list_pass,
                                        const upstream::RenderDrawList&
                                            list,
                                        std::uint32_t samples,
                                        WGPURenderPipeline&
                                            bound_pipeline,
                                        bool pass_has_depth = true,
                                        // Which per-pass block the composed
                                        // stages read: the frame's, or a
                                        // task's own when it draws through
                                        // its own camera.
                                        WGPUBindGroup frame_group = nullptr,
                                        // A shadow caster pass renders
                                        // standard-Z into the generator's
                                        // own depth32float map, which is
                                        // the pin's one exception to this
                                        // port's depth convention.
                                        bool shadow_pass = false,
                                        // Which ESM generator's map it
                                        // writes, when it writes one.
                                        std::uint32_t esm_shadow_index =
                                            invalid_handle,
                                        // ShaderMaterial's group-1 pass
                                        // block. Tasks own one so cascades
                                        // do not all read the frame camera.
                                        WGPUBuffer shader_pass_uniforms =
                                            nullptr) {
            (void)frame_group;
            (void)shadow_pass;
            (void)esm_shadow_index;
            for (const upstream::RenderDrawCommand& draw :
                 list.commands) {
                if (!upstream::render_item_draws_now(draw.item, engine)) continue;
                if (draw.item_index >= (*pass_meshes).size()) continue;
                DawnMesh& mesh = (*pass_meshes)[draw.item_index];
#if BBLITE_PBR_VARIANTS > 0
                // Babylon's own composed stages for this draw. Everything
                // else -- the Standard path, the shader materials, the node
                // graphs -- takes the transcribed pipeline below. Tested by
                // KIND, not by whether a group happens to exist: a mesh
                // drawn once through a PBR material would otherwise keep
                // taking this arm after moving to another family.
                if (
                    draw.item.material_kind ==
                    upstream::RenderMaterialKind::pbr) {
                    // The write phase resolves and binds every PBR draw or
                    // errors, so a missing state here means its pinned
                    // bindings were never built for this frame.
                    const auto pinned_entry =
                        mesh.pinned_states.find(draw.item.material.value);
                    if (
                        pinned_entry == mesh.pinned_states.end() ||
                        !pinned_entry->second.group) {
                        dawn_error(
                            ("PBR draw for mesh " +
                             std::to_string(draw.item.mesh.value) +
                             ", material " +
                             std::to_string(draw.item.material.value) +
                             ", pipeline kind " +
                             std::to_string(
                                 static_cast<int>(draw.pipeline)) +
                             " reached the encode with no pinned "
                             "bindings.")
                                .c_str());
                    }
                    const DawnDrawState& pinned_state =
                        pinned_entry->second;
                    const std::size_t variant = pinned_state.group_key;
                    // The thin-instance streams; a non-instanced variant
                    // binds none of them and draws once.
                    const InstanceStreams pinned_streams =
                        instance_streams_for(
                            handle_at(engine.meshes, draw.item.mesh),
                            mesh,
                            InstanceMatrixSource::pinned);
                    encode_variant_draw(
                        list_pass,
                        pinned_variant_pipeline(
                            state,
                            variant,
                            draw.pipeline,
                            samples,
                            pass_has_depth,
                            nullptr,
                            shadow_pass,
                            esm_shadow_index),
                        bound_pipeline,
                        frame_group ? frame_group
                                    : pinned_frame_group(state),
                        pinned_state.group,
                        // Skinned and palette-world draws read the mirrored
                        // buffer; the palette carries the mirror on both
                        // sides, so unmirrored vertices would apply it three
                        // times.
                        pinned_state.mirrored_vertices
                            ? mesh.vertices
                            : mesh.pinned_vertices,
                        pinned_streams,
                        mesh.indices,
                        mesh.index_count,
                        // The receiver's group 2, under the pin's own test:
                        // `meshShadowLights.length > 0 && bindings._shadowBGL`
                        // -- which is exactly "this variant composed the
                        // shadow fragment".
                        pal::pbr_variant_receives_shadows(variant)
                            ? pbr_shadow_group_for(
                                  state,
                                  *pass_scene,
                                  engine,
                                  variant)
                            : nullptr);
                    continue;
                }
#endif
#if BBLITE_STANDARD_VARIANTS > 0
                if (
                    draw.item.material_kind ==
                    upstream::RenderMaterialKind::standard) {
                    // Looked up inside the kind test: every other family's
                    // draws would otherwise pay this descent per frame for
                    // an answer their branch cannot use.
                    const auto standard_entry =
                        mesh.standard_states.find(
                            draw.item.material.value);
                    if (
                        standard_entry == mesh.standard_states.end() ||
                        standard_entry->second.group_key == npos) {
                        dawn_error(
                            ("Standard draw for mesh " +
                             std::to_string(draw.item.mesh.value) +
                             " reached the encode with no resolved "
                             "variant.")
                                .c_str());
                    }
                    DawnDrawState& standard_state =
                        standard_entry->second;
                    const std::size_t variant =
                        standard_state.group_key / 2;
                    if (!standard_state.group) {
                        const MaterialRecord* standard_material =
                            draw.item.material.value <
                                    engine.materials.size()
                                ? &engine.materials[
                                      draw.item.material.value]
                                : nullptr;
                        standard_state.group = build_standard_draw_group(
                            state,
                            mesh,
                            standard_material,
                            variant,
                            standard_state.mesh_uniforms,
                            standard_state.material_uniforms,
                            standard_state.uv_uniforms,
                            standard_state.uv_transform_uniforms,
                            nullptr,
                            standard_render_views(
                                state,
                                engine,
                                standard_material));
                    }
                    const InstanceStreams standard_streams =
                        instance_streams_for(
                            handle_at(engine.meshes, draw.item.mesh),
                            mesh,
                            InstanceMatrixSource::standard);
                    // Only a draw whose composed fragment declares the
                    // shadow group binds it, which is the pin's own test.
                    const bool receives =
                        pal::standard_variant_receives_shadows(variant);
                    encode_variant_draw(
                        list_pass,
                        standard_variant_pipeline(
                            state,
                            variant,
                            draw.pipeline,
                            samples,
                            pass_has_depth,
                            (standard_state.group_key & 1) != 0,
                            nullptr,
                            shadow_pass,
                            esm_shadow_index),
                        bound_pipeline,
                        frame_group ? frame_group
                                    : pinned_frame_group(state),
                        standard_state.group,
                        // The Standard families carry no glTF X-mirror: the
                        // baked buffer is the pin's own convention already.
                        mesh.vertices,
                        standard_streams,
                        mesh.indices,
                        mesh.index_count,
                        receives
                            ? standard_shadow_group_for(state, *pass_scene, engine, variant)
                            : nullptr);
                    continue;
                }
#endif
#if BBLITE_NODE_VARIANTS > 0
                if (
                    draw.item.material_kind ==
                    upstream::RenderMaterialKind::node) {
                    const auto node_entry =
                        mesh.node_states.find(draw.item.material.value);
                    if (node_entry == mesh.node_states.end()) {
                        dawn_error(
                            ("node draw for mesh " +
                             std::to_string(draw.item.mesh.value) +
                             " reached the encode with no draw state.")
                                .c_str());
                    }
                    const MaterialRecord* node_material =
                        draw.item.material.value < engine.materials.size()
                            ? &handle_at(engine.materials, draw.item.material)
                            : nullptr;
                    // Which of the graph's two compiled views: an ESM caster
                    // view carries the bit its own factory set.
                    const bool node_caster =
                        node_material &&
                        (node_material->esm_shadow || node_material->no_color);
                    DawnDrawState& node_state = node_entry->second;
                    const std::size_t node_slot = pal::node_variant_slot(
                        draw.item.shader_variant,
                        node_caster);
                    // Built here rather than beside the buffers: a receiving
                    // graph names the generators' maps, and those exist only
                    // once the frame graph has been created. A material that
                    // moved to another graph -- or to the other view of its
                    // own -- rebuilds rather than keeping the first one's.
                    if (node_state.group_key != node_slot) {
                        if (node_state.group) {
                            wgpuBindGroupRelease(node_state.group);
                        }
                        node_state.group = build_node_draw_group(
                            state,
                            *pass_scene,
                            engine,
                            mesh,
                            node_state,
                            draw.item.shader_variant,
                            node_caster,
                            node_material);
                        node_state.group_key = node_slot;
                    }
                    encode_node_variant_draw(
                        state, draw,
                        list_pass,
                        node_variant_pipeline(
                            state,
                            draw.item.shader_variant,
                            draw.pipeline,
                            samples,
                            pass_has_depth,
                            shadow_pass,
                            node_caster,
                            esm_shadow_index),
                        bound_pipeline,
                        frame_group ? frame_group
                                    : pinned_frame_group(state),
                        node_state.group,
                        // A node graph reads the baked vertices under the
                        // identity world, like the Standard family.
                        mesh.vertices,
                        InstanceStreams{},
                        mesh.indices,
                        mesh.index_count);
                    continue;
                }
#endif
                DawnPipeline& pipeline = pipeline_for(
                    state,
                    draw.pipeline,
                    draw.item.shader_variant,
                    samples,
                    pass_has_depth,
                    shadow_pass);
                if (pipeline.pipeline != bound_pipeline) {
                    wgpuRenderPassEncoderSetPipeline(
                        list_pass, pipeline.pipeline);
                    bound_pipeline = pipeline.pipeline;
                }
                if (
                    draw.item.material_kind ==
                    upstream::RenderMaterialKind::shader) {
                    DawnShaderBindings& bindings = shader_bindings_for(
                        state,
                        *pass_scene,
                        engine,
                        mesh,
                        draw.item.material,
                        draw.item.shader_variant,
                        shader_pass_uniforms
                            ? shader_pass_uniforms
                            : state.view_projection);
                    if (bindings.storage) {
                        wgpuRenderPassEncoderSetBindGroup(
                            list_pass, 0, bindings.storage, 0, nullptr);
                    }
                    if (bindings.scene) {
                        wgpuRenderPassEncoderSetBindGroup(
                            list_pass, 1, bindings.scene, 0, nullptr);
                    }
                    if (bindings.resources) {
                        wgpuRenderPassEncoderSetBindGroup(
                            list_pass, 2, bindings.resources, 0, nullptr);
                    }
                    if (bindings.material) {
                        wgpuRenderPassEncoderSetBindGroup(
                            list_pass, 3, bindings.material, 0, nullptr);
                    }
                } else {
                    DawnMeshBindings& bindings = bindings_for(
                        state,
                        mesh,
                        draw.pipeline,
                        draw.item.shader_variant);
                    wgpuRenderPassEncoderSetBindGroup(
                        list_pass, 1, bindings.scene, 0, nullptr);
                    wgpuRenderPassEncoderSetBindGroup(
                        list_pass, 2, bindings.textures, 0, nullptr);
                    wgpuRenderPassEncoderSetBindGroup(
                        list_pass, 3, bindings.material, 0, nullptr);
#if BBLITE_GPU_MORPH_STORAGE
                    wgpuRenderPassEncoderSetBindGroup(
                        list_pass, 0, bindings.morph, 0, nullptr);
#endif
                }
                wgpuRenderPassEncoderSetVertexBuffer(
                    list_pass, 0, mesh.vertices, 0, WGPU_WHOLE_SIZE);
#if BBLITE_GPU_INSTANCING
                wgpuRenderPassEncoderSetVertexBuffer(
                    list_pass, 1, mesh.instances, 0, WGPU_WHOLE_SIZE);
#endif
#if BBLITE_GPU_INSTANCE_COLORS
                wgpuRenderPassEncoderSetVertexBuffer(
                    list_pass, 2, mesh.instance_colors, 0, WGPU_WHOLE_SIZE);
#endif
                wgpuRenderPassEncoderSetIndexBuffer(
                    list_pass,
                    mesh.indices,
                    WGPUIndexFormat_Uint32,
                    0,
                    WGPU_WHOLE_SIZE);
                count_gpu_draw(wgpuRenderPassEncoderDrawIndexed,
                    list_pass,
                    mesh.index_count,
#if BBLITE_GPU_INSTANCING
                    mesh.instance_count,
#else
                    1,
#endif
                    0,
                    0,
                    0);
            }
        };
        if (scene.tasks.empty()) {
        const bool transmission = scene.transmission_enabled;
        WGPURenderPassColorAttachment color_attachment =
            WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
        color_attachment.view = state.msaa_color_view;
        if (transmission) {
            // The linear frame keeps its multisampled texture for the
            // grab and the per-sample image processing; the clear
            // color inverts the image processing exactly like the
            // SDL backend and the pinned engine. The pin's inverse runs
            // in f64 and WGPUColor carries doubles, so the value reaches
            // Dawn at the width the browser hands its own clear value.
            color_attachment.storeOp = WGPUStoreOp_Store;
            color_attachment.clearValue = WGPUColor{
                upstream::inverse_image_processed_channel(
                    scene.clear_color.r,
                    scene.environment.exposure,
                    scene.environment.contrast,
                    scene.environment.tone_mapping_enabled),
                upstream::inverse_image_processed_channel(
                    scene.clear_color.g,
                    scene.environment.exposure,
                    scene.environment.contrast,
                    scene.environment.tone_mapping_enabled),
                upstream::inverse_image_processed_channel(
                    scene.clear_color.b,
                    scene.environment.exposure,
                    scene.environment.contrast,
                    scene.environment.tone_mapping_enabled),
                scene.clear_color.a,
            };
        } else if (state.multisampled()) {
            color_attachment.resolveTarget = surface_view;
            // An overlay layer composites onto this pass's multisample
            // texture, so it has to survive the pass -- the pin's own
            // overlay rule: "both scenes must use the base task's MSAA
            // colour texture before the overlay can load its pixels and
            // resolve the composited result" (swapchain-overlay.ts).
            color_attachment.storeOp = overlay_plans.empty()
                ? WGPUStoreOp_Discard
                : WGPUStoreOp_Store;
            color_attachment.clearValue = WGPUColor{
                scene.clear_color.r,
                scene.clear_color.g,
                scene.clear_color.b,
                scene.clear_color.a,
            };
        } else {
            // One sample has nothing to average, so the pass draws
            // into the surface instead of resolving into it.
            color_attachment.view = surface_view;
            color_attachment.storeOp = WGPUStoreOp_Store;
            color_attachment.clearValue = WGPUColor{
                scene.clear_color.r,
                scene.clear_color.g,
                scene.clear_color.b,
                scene.clear_color.a,
            };
        }
        color_attachment.loadOp = WGPULoadOp_Clear;
        WGPURenderPassDepthStencilAttachment depth_attachment{};
        depth_attachment.view = state.depth_view;
        depth_attachment.depthLoadOp = WGPULoadOp_Clear;
        depth_attachment.depthStoreOp = transmission
            ? WGPUStoreOp_Store
            : WGPUStoreOp_Discard;
        depth_attachment.depthClearValue = upstream::pinned_depth_clear;
        depth_attachment.stencilLoadOp = WGPULoadOp_Clear;
        depth_attachment.stencilStoreOp = WGPUStoreOp_Discard;
        WGPURenderPassDescriptor pass_descriptor =
            WGPU_RENDER_PASS_DESCRIPTOR_INIT;
        pass_descriptor.colorAttachmentCount = 1;
        pass_descriptor.colorAttachments = &color_attachment;
        pass_descriptor.depthStencilAttachment = &depth_attachment;
        DawnRenderPass pass{wgpuCommandEncoderBeginRenderPass(encoder, &pass_descriptor)};
        set_pass_camera_viewport(
            pass, scene, engine, camera, width, height);
        WGPURenderPipeline bound_pipeline = nullptr;
        bool transmission_copied = false;
        const auto draw_render_list =
            [&](const upstream::RenderDrawList& list) {
                if (!transmission) {
                    draw_list_into(
                        pass,
                        list,
                        state.sample_count,
                        bound_pipeline);
                    return;
                }
                for (const upstream::RenderDrawCommand& draw :
                     list.commands) {
                    if (!upstream::render_item_draws_now(draw.item, engine)) continue;
                    if (draw.item_index >= state.meshes.size()) {
                        continue;
                    }
                    const MaterialRecord* material =
                        draw.item.material.value <
                                engine.materials.size()
                            ? &engine.materials[
                                  draw.item.material.value]
                            : nullptr;
                    if (
                        !transmission_copied &&
                        transmissive_draw_material(material)) {
                        // The pinned mid-pass break: grab the scene
                        // color from the preserved multisampled
                        // attachment, then resume loading color and
                        // depth for the transmissive draws.
                        wgpuRenderPassEncoderEnd(pass);
                        pass.reset();
                        encode_transmission_grab(state, encoder);
                        color_attachment.loadOp = WGPULoadOp_Load;
                        depth_attachment.depthLoadOp =
                            WGPULoadOp_Load;
                        pass = wgpuCommandEncoderBeginRenderPass(
                            encoder,
                            &pass_descriptor);
                        // A restarted pass starts at the whole target
                        // again, so the camera's rectangle is set once
                        // per PASS rather than once per frame.
                        set_pass_camera_viewport(
                            pass,
                            scene,
                            engine,
                            camera,
                            width,
                            height);
                        bound_pipeline = nullptr;
                        transmission_copied = true;
                    }
                    upstream::RenderDrawList single;
                    single.commands.push_back(draw);
                    draw_list_into(
                        pass,
                        single,
                        state.sample_count,
                        bound_pipeline);
                }
            };
        const auto draw_ground = [&] {
            if (!state.ground_enabled) return;
            wgpuRenderPassEncoderSetPipeline(pass, state.ground_pipeline);
            bound_pipeline = state.ground_pipeline;
#if BBLITE_GPU_MORPH_STORAGE
            wgpuRenderPassEncoderSetBindGroup(
                pass, 0, state.ground_morph_group, 0, nullptr);
#endif
            wgpuRenderPassEncoderSetBindGroup(
                pass, 1, state.ground_scene_group, 0, nullptr);
            wgpuRenderPassEncoderSetBindGroup(
                pass, 2, state.ground_texture_group, 0, nullptr);
            wgpuRenderPassEncoderSetBindGroup(
                pass, 3, state.ground_material_group, 0, nullptr);
            wgpuRenderPassEncoderSetVertexBuffer(
                pass, 0, state.ground_vertices, 0, WGPU_WHOLE_SIZE);
#if BBLITE_GPU_INSTANCING
            wgpuRenderPassEncoderSetVertexBuffer(
                pass,
                1,
                state.background_instances,
                0,
                WGPU_WHOLE_SIZE);
#endif
            wgpuRenderPassEncoderSetIndexBuffer(
                pass,
                state.ground_indices,
                WGPUIndexFormat_Uint32,
                0,
                WGPU_WHOLE_SIZE);
            count_gpu_draw(wgpuRenderPassEncoderDrawIndexed, pass, 6, 1, 0, 0, 0);
        };
        const auto draw_skybox = [&] {
            if (!state.skybox_enabled) return;
            wgpuRenderPassEncoderSetPipeline(pass, state.skybox_pipeline);
            bound_pipeline = state.skybox_pipeline;
#if BBLITE_GPU_MORPH_STORAGE
            if (scene.environment.skybox_uses_environment) {
                wgpuRenderPassEncoderSetBindGroup(
                    pass, 0, state.skybox_morph_group, 0, nullptr);
            }
#endif
            wgpuRenderPassEncoderSetBindGroup(
                pass, 1, state.skybox_scene_group, 0, nullptr);
            wgpuRenderPassEncoderSetBindGroup(
                pass, 2, state.skybox_texture_group, 0, nullptr);
            wgpuRenderPassEncoderSetBindGroup(
                pass, 3, state.skybox_material_group, 0, nullptr);
            wgpuRenderPassEncoderSetVertexBuffer(
                pass, 0, state.skybox_vertices, 0, WGPU_WHOLE_SIZE);
#if BBLITE_GPU_INSTANCING
            if (scene.environment.skybox_uses_environment) {
                wgpuRenderPassEncoderSetVertexBuffer(
                    pass,
                    1,
                    state.background_instances,
                    0,
                    WGPU_WHOLE_SIZE);
            }
#endif
            wgpuRenderPassEncoderSetIndexBuffer(
                pass,
                state.skybox_indices,
                WGPUIndexFormat_Uint32,
                0,
                WGPU_WHOLE_SIZE);
            count_gpu_draw(wgpuRenderPassEncoderDrawIndexed, pass, 36, 1, 0, 0, 0);
        };
#if BBLITE_SOLID_SKYBOX
        const auto draw_solid_skybox = [&] {
            if (!state.solid_skybox_enabled) return;
            wgpuRenderPassEncoderSetPipeline(
                pass,
                state.solid_skybox_pipeline);
            bound_pipeline = state.solid_skybox_pipeline;
            wgpuRenderPassEncoderSetBindGroup(
                pass, 1, state.solid_skybox_scene_group, 0, nullptr);
            wgpuRenderPassEncoderSetBindGroup(
                pass, 3, state.solid_skybox_material_group, 0, nullptr);
            wgpuRenderPassEncoderSetVertexBuffer(
                pass,
                0,
                state.solid_skybox_vertices,
                0,
                WGPU_WHOLE_SIZE);
            wgpuRenderPassEncoderSetIndexBuffer(
                pass,
                state.solid_skybox_indices,
                WGPUIndexFormat_Uint32,
                0,
                WGPU_WHOLE_SIZE);
            count_gpu_draw(wgpuRenderPassEncoderDrawIndexed, pass, 36, 1, 0, 0, 0);
        };
#endif
#if BBLITE_IMAGE_SKYBOX
        const auto draw_image_skybox = [&] {
            if (!state.image_skybox_enabled) return;
            wgpuRenderPassEncoderSetPipeline(
                pass,
                state.image_skybox_pipeline);
            bound_pipeline = state.image_skybox_pipeline;
            wgpuRenderPassEncoderSetBindGroup(
                pass, 1, state.image_skybox_scene_group, 0, nullptr);
            wgpuRenderPassEncoderSetBindGroup(
                pass, 2, state.image_skybox_texture_group, 0, nullptr);
            wgpuRenderPassEncoderSetBindGroup(
                pass, 3, state.image_skybox_material_group, 0, nullptr);
            wgpuRenderPassEncoderSetVertexBuffer(
                pass,
                0,
                state.image_skybox_vertices,
                0,
                WGPU_WHOLE_SIZE);
            wgpuRenderPassEncoderSetIndexBuffer(
                pass,
                state.image_skybox_indices,
                WGPUIndexFormat_Uint32,
                0,
                WGPU_WHOLE_SIZE);
            count_gpu_draw(wgpuRenderPassEncoderDrawIndexed, pass, 36, 1, 0, 0, 0);
        };
#endif
#if BBLITE_HAS_BILLBOARDS
        // A billboard system draws in the slot its depth mode gives it: 100
        // among the opaque meshes, because a cutout system writes depth and
        // everything after has to see it, and 200 after the scene stages for
        // the transparent modes.
        const auto draw_billboards = [&](BillboardDepthMode mode) {
            for (const DawnBillboardPass& billboard :
                 state.billboard_passes) {
                if (handle_at(engine.billboard_systems, billboard.system).depth_mode != mode) {
                    continue;
                }
                record_dawn_billboard_pass(pass, engine, billboard);
            }
        };
#endif
        for (const upstream::RenderStage stage : render_plan.stages) {
            switch (stage) {
                case upstream::RenderStage::skybox:
                    // The sub-order comes from the shared
                    // `skybox_stage_order`.
                    for (const SkyboxLayer layer :
                         skybox_stage_order) {
                        switch (layer) {
                            case SkyboxLayer::solid:
#if BBLITE_SOLID_SKYBOX
                                draw_solid_skybox();
#endif
                                break;
                            case SkyboxLayer::environment:
                                draw_skybox();
                                break;
                            case SkyboxLayer::image:
#if BBLITE_IMAGE_SKYBOX
                                draw_image_skybox();
#endif
                                break;
                        }
                    }
                    break;
                case upstream::RenderStage::opaque:
                    draw_render_list(render_plan.draw_lists.opaque);
#if defined(BBLITE_HAS_SPRITE_RENDERER) && BBLITE_HAS_SPRITE_RENDERER
                    if (state.has_scene_sprite_pass) {
                        record_dawn_scene_sprite_pass(
                            pass,
                            engine,
                            state.scene_sprite_pass,
                            Sprite2DDepthMode::test_write);
                    }
#endif
#if BBLITE_HAS_BILLBOARDS
                    draw_billboards(BillboardDepthMode::cutout);
#endif
                    break;
                case upstream::RenderStage::transparent:
                    draw_render_list(
                        render_plan.draw_lists.transparent);
#if defined(BBLITE_HAS_TEXT) && BBLITE_HAS_TEXT
                    text_ops.pass = pass;
                    state.text->scene.draw(text_ops);
#endif
#if defined(BBLITE_HAS_SPRITE_RENDERER) && BBLITE_HAS_SPRITE_RENDERER
                    if (state.has_scene_sprite_pass) {
                        record_dawn_scene_sprite_pass(
                            pass,
                            engine,
                            state.scene_sprite_pass,
                            Sprite2DDepthMode::test);
                    }
#endif
#if BBLITE_HAS_SPLATS
                    // `isTransparent: true` on the pinned renderable, so a
                    // cloud belongs to this bucket rather than after it.
                    // `27-render-pipeline.md` states the bucket's rule:
                    // "Transparent bindings must remain camera-space-depth
                    // sorted and are not pipeline-sorted." A cloud carries
                    // no single depth to sort by -- it sorts its own splats
                    // -- and no reached scene puts another transparent
                    // renderable beside one, so it draws at the end of the
                    // bucket and a scene that mixed the two would need the
                    // pin's own `_sortDistance` before this is right.
                    for (const DawnSplatPass& splat : state.splat_passes) {
                        record_dawn_splat_pass(pass, splat);
                    }
#endif
                    break;
                case upstream::RenderStage::ground:
                    draw_ground();
                    break;
            }
        }
#if BBLITE_HAS_BILLBOARDS
        // The transparent systems close the scene's pass: they blend over
        // every stage above and test against the depth they wrote.
        draw_billboards(BillboardDepthMode::transparent);
#endif
        wgpuRenderPassEncoderEnd(pass);
        pass.reset();
        // The swapchain overlay layers: one pass each on the same colour
        // attachment with a FRESH depth buffer. `createUtilityLayer`
        // states the contract -- the overlay keeps NORMAL depth testing
        // among its own meshes and never tests against the base scene's,
        // so a gizmo body still occludes its own back faces while sitting
        // in front of everything below it.
        for (
            std::size_t layer = 0;
            layer < overlay_plans.size() &&
            layer < state.overlay_meshes.size();
            ++layer) {
            Scene* overlay_scene = engine.registered_scenes[layer + 1u].get();
            if (!overlay_scene) continue;
            if (
                layer < overlay_topology_versions.size() &&
                overlay_scene->render_topology_version !=
                    overlay_topology_versions[layer]) {
                dawn_error(
                    "A swapchain overlay changed its renderables after resource synchronization.");
            }
            WGPURenderPassColorAttachment overlay_color =
                WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
            overlay_color.view = color_attachment.view;
            overlay_color.resolveTarget = color_attachment.resolveTarget;
            overlay_color.loadOp = WGPULoadOp_Load;
            overlay_color.storeOp = color_attachment.storeOp;
            WGPURenderPassDepthStencilAttachment overlay_depth{};
            overlay_depth.view = state.depth_view;
            overlay_depth.depthLoadOp = WGPULoadOp_Clear;
            overlay_depth.depthStoreOp = WGPUStoreOp_Discard;
            overlay_depth.depthClearValue = upstream::pinned_depth_clear;
            overlay_depth.stencilLoadOp = WGPULoadOp_Clear;
            overlay_depth.stencilStoreOp = WGPUStoreOp_Discard;
            WGPURenderPassDescriptor overlay_descriptor =
                WGPU_RENDER_PASS_DESCRIPTOR_INIT;
            overlay_descriptor.colorAttachmentCount = 1;
            overlay_descriptor.colorAttachments = &overlay_color;
            overlay_descriptor.depthStencilAttachment = &overlay_depth;
            DawnRenderPass overlay_pass{wgpuCommandEncoderBeginRenderPass(
                    encoder,
                    &overlay_descriptor)};
            {
                const CameraRecord& overlay_pass_camera =
                    overlay_scene->camera.value < engine.cameras.size()
                        ? handle_at(engine.cameras, overlay_scene->camera)
                        : camera;
                set_pass_camera_viewport(
                    overlay_pass,
                    *overlay_scene,
                    engine,
                    overlay_pass_camera,
                    width,
                    height);
            }
            WGPURenderPipeline overlay_bound_pipeline = nullptr;
            pass_scene = overlay_scene;
            pass_meshes = &state.overlay_meshes[layer];
            WGPUBindGroup overlay_group = nullptr;
            WGPUBuffer overlay_shader_uniforms = state.view_projection;
#if BBLITE_PINNED_MATERIALS
            if (layer < state.overlay_frames.size()) {
                overlay_group = overlay_frame_group(
                    state,
                    state.overlay_frames[layer]);
                overlay_shader_uniforms =
                    state.overlay_frames[layer].scene_uniforms;
            }
#endif
            for (
                const upstream::RenderStage stage :
                overlay_plans[layer].stages) {
                switch (stage) {
                    case upstream::RenderStage::opaque:
                        draw_list_into(
                            overlay_pass,
                            overlay_plans[layer].draw_lists.opaque,
                            state.sample_count,
                            overlay_bound_pipeline,
                            true,
                            overlay_group,
                            false,
                            invalid_handle,
                            overlay_shader_uniforms);
                        break;
                    case upstream::RenderStage::transparent:
                        draw_list_into(
                            overlay_pass,
                            overlay_plans[layer].draw_lists.transparent,
                            state.sample_count,
                            overlay_bound_pipeline,
                            true,
                            overlay_group,
                            false,
                            invalid_handle,
                            overlay_shader_uniforms);
                        break;
                    default:
                        // A utility layer carries no environment, so its
                        // plan reaches no background stage.
                        break;
                }
            }
            wgpuRenderPassEncoderEnd(overlay_pass);
            overlay_pass.reset();
            pass_scene = &scene;
            pass_meshes = &state.meshes;
        }
        if (transmission) {
            encode_image_processing(
                state,
                encoder,
                surface_view,
                scene);
        }
        } else {
        // Frame-graph execution replaces the main pass entirely,
        // mirroring the SDL task loop.
        const auto render_target_texture =
            [&](RenderTargetHandle target_handle) {
            return dawn_render_target_texture(state, engine, target_handle);
        };
        /** The depth view a reference names, or null when it names none. */
        const auto task_depth_view =
            [&](const RenderTextureRef& reference) -> WGPUTextureView {
            if (
                reference.source != RenderTextureSource::geometry_depth ||
                reference.task.value >= engine.frame_tasks.size() ||
                reference.task.value >= state.geometry_tasks.size()) {
                throw std::runtime_error(
                    "Render task depth must name a geometry task.");
            }
            WGPUTextureView view =
                handle_at(state.geometry_tasks, reference.task).depth_view;
            if (!view) {
                throw std::runtime_error(
                    "Geometry task has no depth attachment to share.");
            }
            return view;
        };
        const auto source_texture_view =
            [&](const RenderTextureRef& reference)
            -> std::pair<WGPUTexture, WGPUTextureView> {
            if (
                reference.source ==
                RenderTextureSource::render_target) {
                return render_target_texture(reference.target);
            }
            if (reference.task.value >= engine.frame_tasks.size()) {
                throw std::runtime_error(
                    "Frame graph source task handle is invalid.");
            }
            const FrameTaskRecord& source_task =
                handle_at(engine.frame_tasks, reference.task);
            if (source_task.kind != FrameTaskKind::geometry) {
                throw std::runtime_error(
                    "Frame graph source task is not geometry.");
            }
            if (
                reference.source ==
                RenderTextureSource::geometry_output) {
                return render_target_texture(
                    source_task.geometry.target);
            }
            const auto found = std::find_if(
                source_task.geometry.attachments.begin(),
                source_task.geometry.attachments.end(),
                [&](const GeometryTextureDescription& description) {
                    return description.type == reference.geometry_type;
                });
            if (found == source_task.geometry.attachments.end()) {
                throw std::runtime_error(
                    "Geometry source attachment was not requested.");
            }
            const std::size_t attachment_index =
                static_cast<std::size_t>(
                    std::distance(
                        source_task.geometry.attachments.begin(),
                        found));
            DawnGeometryTask& geometry =
                handle_at(state.geometry_tasks, reference.task);
            return {
                geometry.sampled_colors[attachment_index],
                geometry.sampled_views[attachment_index],
            };
        };
#if defined(BBLITE_HAS_TAA) && BBLITE_HAS_TAA
        if (!engine.stopped) {
            for (const auto& registered : engine.registered_scenes) {
                for (const TaskHandle handle : registered->tasks) {
                    auto& task = engine.frame_tasks.at(handle.value);
                    if (!task.post_process.taa) continue;
                    auto& first = state.post_process_tasks.at(handle.value).at(0);
                    if (first.temporal_recorded) continue;
                    upstream::record_taa_post_process(*task.post_process.taa, [&] {
                        for (std::size_t child = 0; child < task.post_process.passes.size(); ++child) {
                            (void)prepare_dawn_post_process_pass(state, engine, handle, width, height, child, source_texture_view);
                        }
                    });
                    first.temporal_recorded = true;
                }
            }
#endif
        for (std::size_t graph_layer = 0;
             graph_layer < engine.registered_scenes.size(); ++graph_layer) {
        const Scene& graph_scene = *engine.registered_scenes[graph_layer];
        const auto& graph_plan = graph_layer == 0 ? render_plan : overlay_plans[graph_layer - 1];
        auto& graph_meshes = graph_layer == 0 ? state.meshes : state.overlay_meshes[graph_layer - 1];
        pass_scene = &graph_scene;
        pass_meshes = &graph_meshes;
        for (const TaskHandle handle : graph_scene.tasks) {
            if (handle.value >= engine.frame_tasks.size()) {
                throw std::runtime_error(
                    "Scene frame task handle is invalid.");
            }
            FrameTaskRecord& task =
                handle_at(engine.frame_tasks, handle);
#if defined(BBLITE_HAS_TAA) && BBLITE_HAS_TAA
            if (task.kind != FrameTaskKind::render && task.kind != FrameTaskKind::post_process) {
                throw std::runtime_error("Temporal submission requires an admitted frame-task execution adapter.");
            }
#endif
            if (task.kind == FrameTaskKind::render) {
                if (
                    task.render.target.value >=
                    engine.render_targets.size()) {
                    throw std::runtime_error(
                        "Render task target is invalid.");
                }
                const RenderTargetRecord& target_record =
                    handle_at(engine.render_targets, task.render.target);
                DawnRenderTarget& target =
                    handle_at(state.render_targets, task.render.target);
                DawnRenderTask& render_task =
                    handle_at(state.render_tasks, handle);
                const std::uint32_t samples = target_record.swapchain
                    ? 1u
                    : task_sample_count(state, target_record.samples);
#if defined(BBLITE_HAS_TAA) && BBLITE_HAS_TAA
                if (task.source_scene != graph_scene.state || task.render.scene_stages ||
                    task.render.shadow_generator.value != invalid_handle || !target.color ||
                    target.color_format != state.surface_format) {
                    throw std::runtime_error("Temporal source requires an admitted Standard color pass in its owning scene.");
                }
                CameraRecord* source_camera = task.render.has_camera
                    ? &engine.cameras.at(task.render.camera.value)
                    : task.source_scene->camera.value < engine.cameras.size()
                        ? &handle_at(engine.cameras, task.source_scene->camera) : nullptr;
                validate_temporal_source(engine, task, source_camera, render_task.draw_lists);
                const auto& task_camera = source_camera ? *source_camera : camera;
                const auto graph_extent = scene_surface_extent(engine, graph_scene, width, height);
                restore_temporal_source_buffer(state, task, render_task);
                WGPUBuffer lights = graph_layer == 0 ? nullptr : state.overlay_frames[graph_layer - 1].lights_uniforms;
                task_pinned_frame_group(state, render_task, lights);
                prepare_temporal_scene_uniforms(task, source_camera, target.width, target.height,
                    graph_extent.width, graph_extent.height, [&](const float* data, std::size_t bytes) {
                        wgpuQueueWriteBuffer(state.queue, render_task.pinned_scene_uniforms, 0, data, bytes);
                    });
                const double task_aspect = task.render.canvas_size
                    ? upstream::effective_aspect_ratio(task_camera, graph_extent.width, graph_extent.height)
                    : upstream::effective_aspect_ratio(task_camera, target.width, target.height);
                const auto task_matrix = upstream::build_view_projection(task_camera, task_aspect);
                const auto task_view = upstream::build_view_matrix(upstream::camera_world_matrix(task_camera));
                const auto task_projection = upstream::build_scene_projection(task_camera, task_aspect);
                const auto task_eye = shader_camera_position(graph_scene, engine, task_camera);
                ShaderPassMatrices matrices{task_matrix.data(), &task_view, &task_projection};
                matrices.camera_position = &task_eye;
                wgpuQueueWriteBuffer(state.queue, render_task.view_projection, 0, task_matrix.data(), sizeof(task_matrix));
                write_material_uniforms(render_task.draw_lists.opaque, matrices);
                write_material_uniforms(render_task.draw_lists.transparent, matrices);
                if (source_camera) upstream::sort_transparent_draws(render_task.draw_lists.transparent, engine, task_camera);
#endif
#if BBLITE_SHADOW_RECEIVERS
                if (
                    task.render.shadow_generator.value <
                        engine.shadow_generators.size()) {
                    // The pin's render gate: `renderEsmShadowMap` /
                    // `renderPcfShadowMap` return before the caster pass
                    // and both blur passes when nothing moved since the
                    // last render, and the map textures persist — the
                    // receiver keeps sampling last render's bit-identical
                    // content. The verdict was written onto the gate by
                    // `refresh_shadow_generators` earlier this frame.
                    if (!state.shadow_refresh.gates[
                            task.render.shadow_generator.value].due) {
                        continue;
                    }
                    if (!target_record.has_depth || !target.depth) {
                        throw std::runtime_error(
                            "Shadow render task has no depth attachment.");
                    }
                    WGPURenderPassDepthStencilAttachment
                        shadow_attachment{};
                    // Its own cascade layer, which for every generator but
                    // a cascaded one is the single layer 0.
                    shadow_attachment.view =
                        target.depth_layer_views[task.render.depth_layer];
                    shadow_attachment.depthLoadOp = WGPULoadOp_Clear;
                    // The pin's own shadow target clears to ITS far value,
                    // which standard-Z puts at 1 where this port's reverse-Z
                    // puts it at 0.
                    shadow_attachment.depthClearValue =
                        pass_depth_clear(true);
                    shadow_attachment.depthStoreOp = WGPUStoreOp_Store;
                    shadow_attachment.stencilLoadOp = WGPULoadOp_Undefined;
                    shadow_attachment.stencilStoreOp =
                        WGPUStoreOp_Undefined;
                    // An ESM caster pass STORES a colour: the exponential
                    // depth its material view writes. A PCF one has no
                    // colour attachment at all, which is the difference
                    // between the two pinned targets.
                    WGPURenderPassColorAttachment shadow_color =
                        WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
                    if (target_record.has_color) {
                        if (!target.color_view) {
                            throw std::runtime_error(
                                "ESM shadow task has no colour "
                                "attachment.");
                        }
                        shadow_color.view = target.color_view;
                        shadow_color.loadOp = WGPULoadOp_Clear;
                        shadow_color.storeOp = WGPUStoreOp_Store;
                        // `createRenderTask({ clrColor: {0,0,0,0} })`.
                        shadow_color.clearValue = {0.0, 0.0, 0.0, 0.0};
                    }
                    WGPURenderPassDescriptor shadow_descriptor =
                        WGPU_RENDER_PASS_DESCRIPTOR_INIT;
                    shadow_descriptor.colorAttachmentCount =
                        target_record.has_color ? 1u : 0u;
                    shadow_descriptor.colorAttachments =
                        target_record.has_color ? &shadow_color : nullptr;
                    shadow_descriptor.depthStencilAttachment =
                        &shadow_attachment;
                    DawnRenderPass shadow_pass_encoder{wgpuCommandEncoderBeginRenderPass(
                            encoder,
                            &shadow_descriptor)};
                    const ShadowGeneratorRecord& shadow_generator =
                        engine.shadow_generators[
                            task.render.shadow_generator.value];
                    const std::uint32_t esm_shadow_index =
                        shadow_generator.filter ==
                            ShadowFilter::esm_directional
                            ? shadow_generator.esm_index
                            : invalid_handle;
                    WGPURenderPipeline shadow_bound = nullptr;
                    draw_list_into(
                        shadow_pass_encoder,
                        render_task.draw_lists.opaque,
                        1u,
                        shadow_bound,
                        true,
                        render_task.pinned_frame_group,
                        true,
                        esm_shadow_index,
                        render_task.view_projection);
                    draw_list_into(
                        shadow_pass_encoder,
                        render_task.draw_lists.transparent,
                        1u,
                        shadow_bound,
                        true,
                        render_task.pinned_frame_group,
                        true,
                        esm_shadow_index,
                        render_task.view_projection);
                    wgpuRenderPassEncoderEnd(shadow_pass_encoder);
                    shadow_pass_encoder.reset();
#if BBLITE_SHADOWS_ESM
                    // `renderEsmShadowMap` blurs the map it just drew, in
                    // two passes, before anything samples it.
                    if (esm_shadow_index != invalid_handle) {
                        run_esm_blur(
                            state,
                            encoder,
                            target.sampled_color_view,
                            esm_shadow_index);
                    }
#endif
                    continue;
                }
#endif
                if (!target_record.has_color) {
                    if (!target_record.has_depth || !target.depth) {
                        throw std::runtime_error(
                            "Depth-only render task has no depth "
                            "attachment.");
                    }
                    if (task.render_meshes.empty()) {
                        throw std::runtime_error(
                            "Depth-only render task requires explicit "
                            "meshes.");
                    }
                    WGPURenderPassDepthStencilAttachment
                        depth_attachment{};
                    depth_attachment.view =
                        target.depth_layer_views[task.render.depth_layer];
                    depth_attachment.depthLoadOp = WGPULoadOp_Clear;
                    depth_attachment.depthClearValue =
                        upstream::pinned_depth_clear;
                    depth_attachment.depthStoreOp =
                        target_record.sampled_depth
                            ? WGPUStoreOp_Store
                            : WGPUStoreOp_Discard;
                    depth_attachment.stencilLoadOp = WGPULoadOp_Clear;
                    depth_attachment.stencilStoreOp =
                        WGPUStoreOp_Discard;
                    WGPURenderPassDescriptor pass_descriptor =
                        WGPU_RENDER_PASS_DESCRIPTOR_INIT;
                    pass_descriptor.colorAttachmentCount = 0;
                    pass_descriptor.depthStencilAttachment =
                        &depth_attachment;
                    DawnRenderPass task_pass{wgpuCommandEncoderBeginRenderPass(
                            encoder,
                            &pass_descriptor)};
                    if (!render_task.scene_group) {
                        DawnBindGroupLayout scene_layout{wgpuRenderPipelineGetBindGroupLayout(
                                depth_only_pipeline_for(
                                    state,
                                    false,
                                    samples),
                                1)};
                        WGPUBindGroupEntry scene_entry =
                            WGPU_BIND_GROUP_ENTRY_INIT;
                        scene_entry.binding = 0;
                        scene_entry.buffer =
                            render_task.view_projection;
                        scene_entry.size = 64;
                        WGPUBindGroupDescriptor scene_descriptor =
                            WGPU_BIND_GROUP_DESCRIPTOR_INIT;
                        scene_descriptor.layout = scene_layout;
                        scene_descriptor.entryCount = 1;
                        scene_descriptor.entries = &scene_entry;
                        render_task.scene_group =
                            wgpuDeviceCreateBindGroup(
                                state.device,
                                &scene_descriptor);
                        scene_layout.reset();
                    }
                    for (int sided_mode = 0;
                         sided_mode < 2;
                         ++sided_mode) {
                        wgpuRenderPassEncoderSetPipeline(
                            task_pass,
                            depth_only_pipeline_for(
                                state,
                                sided_mode == 1,
                                samples));
                        wgpuRenderPassEncoderSetBindGroup(
                            task_pass,
                            1,
                            render_task.scene_group,
                            0,
                            nullptr);
                        for (const RenderTaskMesh& entry :
                             task.render_meshes) {
                            if (
                                entry.material.value >=
                                engine.materials.size()) {
                                throw std::runtime_error(
                                    "Depth task material override is "
                                    "invalid.");
                            }
                            const MaterialRecord& material =
                                handle_at(engine.materials, entry.material);
                            if (!material.no_color) {
                                throw std::runtime_error(
                                    "Depth-only render task requires "
                                    "a no-color material view.");
                            }
                            if (
                                material.double_sided !=
                                (sided_mode == 1)) {
                                continue;
                            }
                            // geometry-renderer-task.ts skips a hidden mesh at the draw
                            // itself. This path consumes no draw list -- it walks the task's
                            // own meshes and resolves each against the plan -- so it cannot
                            // inherit append_draw's answer and asks the same predicate.
                            if (!upstream::mesh_draws(
                                    handle_at(engine.meshes, entry.mesh))) {
                                continue;
                            }
                            std::size_t mesh_index =
                                graph_meshes.size();
                            for (std::size_t index = 0;
                                 index < graph_plan.items.size();
                                 ++index) {
                                if (
                                    graph_plan.items[index]
                                        .mesh.value ==
                                    entry.mesh.value) {
                                    mesh_index = index;
                                    break;
                                }
                            }
                            if (mesh_index >= graph_meshes.size()) {
                                throw std::runtime_error(
                                    "Depth task mesh is not in the "
                                    "scene.");
                            }
                            DawnMesh& mesh = graph_meshes[mesh_index];
                            wgpuRenderPassEncoderSetVertexBuffer(
                                task_pass,
                                0,
                                mesh.vertices,
                                0,
                                WGPU_WHOLE_SIZE);
#if BBLITE_GPU_INSTANCING
                            wgpuRenderPassEncoderSetVertexBuffer(
                                task_pass,
                                1,
                                mesh.instances,
                                0,
                                WGPU_WHOLE_SIZE);
#endif
                            wgpuRenderPassEncoderSetIndexBuffer(
                                task_pass,
                                mesh.indices,
                                WGPUIndexFormat_Uint32,
                                0,
                                WGPU_WHOLE_SIZE);
                            count_gpu_draw(wgpuRenderPassEncoderDrawIndexed,
                                task_pass,
                                mesh.index_count,
#if BBLITE_GPU_INSTANCING
                                mesh.instance_count,
#else
                                1,
#endif
                                0,
                                0,
                                0);
                        }
                    }
                    wgpuRenderPassEncoderEnd(task_pass);
                    task_pass.reset();
                    // Only a colour-less sampled-depth target has the copy
                    // to refresh; see `create_frame_graph_textures`.
                    if (target_record.sampled_depth && target.depth_copy) {
                        encode_depth_copy(state, encoder, target);
                    }
                    continue;
                }
                WGPURenderPassColorAttachment color_attachment =
                    WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
                color_attachment.view = target_record.swapchain
                    ? surface_view
                    : target.color_view;
                color_attachment.loadOp = task.render.clear
                    ? WGPULoadOp_Clear
                    : WGPULoadOp_Load;
                color_attachment.storeOp = WGPUStoreOp_Store;
                color_attachment.clearValue = WGPUColor{
                    task.render.clear_color.r,
                    task.render.clear_color.g,
                    task.render.clear_color.b,
                    task.render.clear_color.a,
                };
                // The pin resolves into `rst` at end-of-pass, and ignores it
                // outright when the task's own target is single-sample. That
                // is the count the target was *allocated* at, not the one it
                // asked for: a run forced to one sample resolves nothing.
                const std::uint32_t resolve =
                    task.render.resolve_target.value;
                if (
                    resolve < state.render_targets.size() &&
                    task_sample_count(state, target_record.samples) > 1) {
                    color_attachment.resolveTarget =
                        engine.render_targets[resolve].swapchain
                            ? surface_view
                            : state.render_targets[resolve].color_view;
                }
                WGPURenderPassDepthStencilAttachment depth_attachment{};
                WGPURenderPassDescriptor pass_descriptor =
                    WGPU_RENDER_PASS_DESCRIPTOR_INIT;
                pass_descriptor.colorAttachmentCount = 1;
                pass_descriptor.colorAttachments = &color_attachment;
                // The pin's external-depth arm: a task handed another task's
                // depth binds that view and LOADS it, because a geometry
                // output is eager and its owner already cleared and wrote it.
                WGPUTextureView borrowed_depth_view = nullptr;
                if (
                    task.render.depth.source ==
                    RenderTextureSource::geometry_depth) {
                    borrowed_depth_view =
                        task_depth_view(task.render.depth);
                }
                if (borrowed_depth_view) {
                    depth_attachment.view = borrowed_depth_view;
                    depth_attachment.depthLoadOp = WGPULoadOp_Load;
                    depth_attachment.depthStoreOp = WGPUStoreOp_Store;
                    depth_attachment.stencilLoadOp = WGPULoadOp_Load;
                    depth_attachment.stencilStoreOp = WGPUStoreOp_Store;
                    pass_descriptor.depthStencilAttachment =
                        &depth_attachment;
                } else if (target_record.has_depth && target.depth) {
                    // Its own layer, as the shadow and depth-only passes
                    // above take theirs; for every target but a cascaded
                    // shadow map that is the single layer 0.
                    depth_attachment.view =
                        target.depth_layer_views[task.render.depth_layer];
                    depth_attachment.depthLoadOp = WGPULoadOp_Clear;
                    depth_attachment.depthClearValue =
                        upstream::pinned_depth_clear;
                    depth_attachment.depthStoreOp =
                        target_record.sampled_depth
                            ? WGPUStoreOp_Store
                            : WGPUStoreOp_Discard;
                    depth_attachment.stencilLoadOp = WGPULoadOp_Clear;
                    depth_attachment.stencilStoreOp =
                        WGPUStoreOp_Discard;
                    pass_descriptor.depthStencilAttachment =
                        &depth_attachment;
                }
                DawnRenderPass task_pass{wgpuCommandEncoderBeginRenderPass(
                        encoder,
                        &pass_descriptor)};
                WGPURenderPipeline bound_pipeline = nullptr;
#if defined(BBLITE_HAS_TAA) && BBLITE_HAS_TAA
                if (source_camera && task_camera.viewport) {
                    const auto rectangle = upstream::resolve_camera_viewport(task_camera, target.width, target.height);
                    wgpuRenderPassEncoderSetViewport(task_pass, static_cast<float>(rectangle.x), static_cast<float>(rectangle.y),
                        static_cast<float>(rectangle.width), static_cast<float>(rectangle.height), 0.0f, 1.0f);
                    wgpuRenderPassEncoderSetScissorRect(task_pass, rectangle.x, rectangle.y, rectangle.width, rectangle.height);
                }
#endif
#if BBLITE_HAS_BILLBOARDS
                const auto draw_task_billboards =
                    [&](BillboardDepthMode mode) {
                    for (const DawnBillboardPass& billboard :
                         state.billboard_passes) {
                        if (
                            engine.billboard_systems[
                                billboard.system.value].depth_mode != mode) {
                            continue;
                        }
                        record_dawn_billboard_pass(
                            task_pass,
                            engine,
                            billboard);
                    }
                    // The billboard pass has its own pipeline; a following
                    // mesh list must not mistake the previously cached mesh
                    // pipeline for the one currently bound on the encoder.
                    bound_pipeline = nullptr;
                };
#endif
                const bool pass_has_depth = borrowed_depth_view ||
                    (target_record.has_depth && target.depth);
                if (task.render.scene_stages) {
                    if (
                        task.render.has_camera ||
                        samples != state.sample_count ||
                        !pass_has_depth) {
                        throw std::runtime_error(
                            "Compiler-owned scene stages require the "
                            "default camera, sample count, and depth target.");
                    }
                    // A materialized default task replaces the ordinary
                    // scene pass. Its draw lists contain meshes only, so
                    // replay the scene renderer's skybox sub-order before
                    // those lists rather than silently degrading to clear.
                    for (const SkyboxLayer layer : skybox_stage_order) {
                        if (layer == SkyboxLayer::environment) {
                            if (!state.skybox_enabled) continue;
                            wgpuRenderPassEncoderSetPipeline(
                                task_pass,
                                state.skybox_pipeline);
                            bound_pipeline = state.skybox_pipeline;
#if BBLITE_GPU_MORPH_STORAGE
                            if (graph_scene.environment.skybox_uses_environment) {
                                wgpuRenderPassEncoderSetBindGroup(
                                    task_pass,
                                    0,
                                    state.skybox_morph_group,
                                    0,
                                    nullptr);
                            }
#endif
                            wgpuRenderPassEncoderSetBindGroup(
                                task_pass,
                                1,
                                render_task.skybox_scene_group,
                                0,
                                nullptr);
                            wgpuRenderPassEncoderSetBindGroup(
                                task_pass,
                                2,
                                state.skybox_texture_group,
                                0,
                                nullptr);
                            wgpuRenderPassEncoderSetBindGroup(
                                task_pass,
                                3,
                                state.skybox_material_group,
                                0,
                                nullptr);
                            wgpuRenderPassEncoderSetVertexBuffer(
                                task_pass,
                                0,
                                state.skybox_vertices,
                                0,
                                WGPU_WHOLE_SIZE);
#if BBLITE_GPU_INSTANCING
                            if (graph_scene.environment.skybox_uses_environment) {
                                wgpuRenderPassEncoderSetVertexBuffer(
                                    task_pass,
                                    1,
                                    state.background_instances,
                                    0,
                                    WGPU_WHOLE_SIZE);
                            }
#endif
                            wgpuRenderPassEncoderSetIndexBuffer(
                                task_pass,
                                state.skybox_indices,
                                WGPUIndexFormat_Uint32,
                                0,
                                WGPU_WHOLE_SIZE);
                            count_gpu_draw(wgpuRenderPassEncoderDrawIndexed,
                                task_pass,
                                36,
                                1,
                                0,
                                0,
                                0);
                            continue;
                        }
#if BBLITE_SOLID_SKYBOX
                        if (layer == SkyboxLayer::solid) {
                            if (!state.solid_skybox_enabled) continue;
                            wgpuRenderPassEncoderSetPipeline(
                                task_pass,
                                state.solid_skybox_pipeline);
                            bound_pipeline =
                                state.solid_skybox_pipeline;
                            wgpuRenderPassEncoderSetBindGroup(
                                task_pass,
                                1,
                                state.solid_skybox_scene_group,
                                0,
                                nullptr);
                            wgpuRenderPassEncoderSetBindGroup(
                                task_pass,
                                3,
                                state.solid_skybox_material_group,
                                0,
                                nullptr);
                            wgpuRenderPassEncoderSetVertexBuffer(
                                task_pass,
                                0,
                                state.solid_skybox_vertices,
                                0,
                                WGPU_WHOLE_SIZE);
                            wgpuRenderPassEncoderSetIndexBuffer(
                                task_pass,
                                state.solid_skybox_indices,
                                WGPUIndexFormat_Uint32,
                                0,
                                WGPU_WHOLE_SIZE);
                            count_gpu_draw(wgpuRenderPassEncoderDrawIndexed,
                                task_pass,
                                36,
                                1,
                                0,
                                0,
                                0);
                            continue;
                        }
#endif
#if BBLITE_IMAGE_SKYBOX
                        if (layer == SkyboxLayer::image) {
                            if (!state.image_skybox_enabled) continue;
                            wgpuRenderPassEncoderSetPipeline(
                                task_pass,
                                state.image_skybox_pipeline);
                            bound_pipeline =
                                state.image_skybox_pipeline;
                            wgpuRenderPassEncoderSetBindGroup(
                                task_pass,
                                1,
                                state.image_skybox_scene_group,
                                0,
                                nullptr);
                            wgpuRenderPassEncoderSetBindGroup(
                                task_pass,
                                2,
                                state.image_skybox_texture_group,
                                0,
                                nullptr);
                            wgpuRenderPassEncoderSetBindGroup(
                                task_pass,
                                3,
                                state.image_skybox_material_group,
                                0,
                                nullptr);
                            wgpuRenderPassEncoderSetVertexBuffer(
                                task_pass,
                                0,
                                state.image_skybox_vertices,
                                0,
                                WGPU_WHOLE_SIZE);
                            wgpuRenderPassEncoderSetIndexBuffer(
                                task_pass,
                                state.image_skybox_indices,
                                WGPUIndexFormat_Uint32,
                                0,
                                WGPU_WHOLE_SIZE);
                            count_gpu_draw(wgpuRenderPassEncoderDrawIndexed,
                                task_pass,
                                36,
                                1,
                                0,
                                0,
                                0);
                        }
#endif
                    }
                }
                draw_list_into(
                    task_pass,
                    render_task.draw_lists.opaque,
                    samples,
                    bound_pipeline,
                    pass_has_depth,
                    render_task.pinned_frame_group,
                    false,
                    invalid_handle,
                    render_task.view_projection);
#if BBLITE_HAS_BILLBOARDS
                if (task.render.scene_stages) {
                    draw_task_billboards(BillboardDepthMode::cutout);
                }
#endif
                draw_list_into(
                    task_pass,
                    render_task.draw_lists.transparent,
                    samples,
                    bound_pipeline,
                    pass_has_depth,
                    render_task.pinned_frame_group,
                    false,
                    invalid_handle,
                    render_task.view_projection);
                if (task.render.scene_stages && state.ground_enabled) {
                    // Ground is the final scene stage, after transparent
                    // meshes, exactly as in the non-frame-graph pass.
                    wgpuRenderPassEncoderSetPipeline(
                        task_pass,
                        state.ground_pipeline);
#if BBLITE_GPU_MORPH_STORAGE
                    wgpuRenderPassEncoderSetBindGroup(
                        task_pass,
                        0,
                        state.ground_morph_group,
                        0,
                        nullptr);
#endif
                    wgpuRenderPassEncoderSetBindGroup(
                        task_pass,
                        1,
                        state.ground_scene_group,
                        0,
                        nullptr);
                    wgpuRenderPassEncoderSetBindGroup(
                        task_pass,
                        2,
                        state.ground_texture_group,
                        0,
                        nullptr);
                    wgpuRenderPassEncoderSetBindGroup(
                        task_pass,
                        3,
                        state.ground_material_group,
                        0,
                        nullptr);
                    wgpuRenderPassEncoderSetVertexBuffer(
                        task_pass,
                        0,
                        state.ground_vertices,
                        0,
                        WGPU_WHOLE_SIZE);
#if BBLITE_GPU_INSTANCING
                    wgpuRenderPassEncoderSetVertexBuffer(
                        task_pass,
                        1,
                        state.background_instances,
                        0,
                        WGPU_WHOLE_SIZE);
#endif
                    wgpuRenderPassEncoderSetIndexBuffer(
                        task_pass,
                        state.ground_indices,
                        WGPUIndexFormat_Uint32,
                        0,
                        WGPU_WHOLE_SIZE);
                    count_gpu_draw(wgpuRenderPassEncoderDrawIndexed,
                        task_pass,
                        6,
                        1,
                        0,
                        0,
                        0);
                }
#if BBLITE_HAS_BILLBOARDS
                if (task.render.scene_stages) {
                    // Transparent systems close the compiler-owned scene
                    // task just as they close the ordinary scene pass.
                    draw_task_billboards(BillboardDepthMode::transparent);
                }
#endif
                wgpuRenderPassEncoderEnd(task_pass);
                task_pass.reset();
                if (graph_layer == 0 && task.render.scene_stages) {
                    for (std::size_t layer = 0; layer < overlay_plans.size(); ++layer) {
                        const Scene& utility = *engine.registered_scenes[layer + 1];
                        if (utility.surface_canvas || !utility.tasks.empty()) continue;
                        color_attachment.loadOp = WGPULoadOp_Load;
                        depth_attachment.depthLoadOp = WGPULoadOp_Clear;
                        DawnRenderPass utility_pass{wgpuCommandEncoderBeginRenderPass(encoder, &pass_descriptor)};
                        const CameraRecord& utility_camera = utility.camera.value < engine.cameras.size()
                            ? handle_at(engine.cameras, utility.camera) : camera;
                        set_pass_camera_viewport(utility_pass, utility, engine, utility_camera, target.width, target.height);
                        pass_scene = &utility;
                        pass_meshes = &state.overlay_meshes[layer];
                        WGPUBindGroup utility_group = nullptr;
                        WGPUBuffer utility_uniforms = state.view_projection;
#if BBLITE_PINNED_MATERIALS
                        utility_group = overlay_frame_group(state, state.overlay_frames[layer]);
                        utility_uniforms = state.overlay_frames[layer].scene_uniforms;
#endif
                        WGPURenderPipeline utility_pipeline = nullptr;
                        upstream::sort_transparent_draws(overlay_plans[layer].draw_lists.transparent, engine, utility_camera);
                        draw_list_into(utility_pass, overlay_plans[layer].draw_lists.opaque,
                            samples, utility_pipeline, pass_has_depth, utility_group, false, invalid_handle, utility_uniforms);
                        draw_list_into(utility_pass, overlay_plans[layer].draw_lists.transparent,
                            samples, utility_pipeline, pass_has_depth, utility_group, false, invalid_handle, utility_uniforms);
                        wgpuRenderPassEncoderEnd(utility_pass);
                        utility_pass.reset();
                    }
                    pass_scene = &graph_scene;
                    pass_meshes = &graph_meshes;
                }
                continue;
            }
            if (task.kind == FrameTaskKind::geometry) {
                DawnGeometryTask& geometry =
                    handle_at(state.geometry_tasks, handle);
                DawnRenderTask& render_task =
                    handle_at(state.render_tasks, handle);
                const std::uint32_t samples =
                    task_sample_count(state, task.geometry.samples);
                std::vector<WGPURenderPassColorAttachment>
                    color_attachments;
                color_attachments.reserve(
                    task.geometry.attachments.size() + 1);
                for (
                    std::size_t index = 0;
                    index < task.geometry.attachments.size();
                    ++index) {
                    WGPURenderPassColorAttachment attachment =
                        WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
                    attachment.view = geometry.color_views[index];
                    attachment.loadOp = WGPULoadOp_Clear;
                    attachment.clearValue = geometry_clear_color(
                        task.geometry.attachments[index].type);
                    if (samples == 1) {
                        attachment.storeOp = WGPUStoreOp_Store;
                    } else {
                        attachment.storeOp = WGPUStoreOp_Discard;
                        attachment.resolveTarget =
                            geometry.sampled_views[index];
                    }
                    color_attachments.push_back(attachment);
                }
                if (task.geometry.target.value != invalid_handle) {
                    DawnRenderTarget& output_target =
                        state.render_targets[
                            task.geometry.target.value];
                    WGPURenderPassColorAttachment attachment =
                        WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
                    attachment.view = output_target.color_view;
                    attachment.loadOp = task.geometry.clear_target
                        ? WGPULoadOp_Clear
                        : WGPULoadOp_Load;
                    attachment.clearValue = WGPUColor{
                        task.geometry.target_clear_color.r,
                        task.geometry.target_clear_color.g,
                        task.geometry.target_clear_color.b,
                        task.geometry.target_clear_color.a,
                    };
                    if (samples == 1) {
                        attachment.storeOp = WGPUStoreOp_Store;
                    } else {
                        attachment.storeOp = WGPUStoreOp_Discard;
                        attachment.resolveTarget =
                            output_target.sampled_color_view;
                    }
                    color_attachments.push_back(attachment);
                }
                WGPURenderPassDepthStencilAttachment depth_attachment{};
                depth_attachment.view = geometry.depth_view;
                depth_attachment.depthLoadOp = WGPULoadOp_Clear;
                depth_attachment.depthClearValue =
                    upstream::pinned_depth_clear;
                depth_attachment.depthStoreOp = geometry.depth_borrowed
                    ? WGPUStoreOp_Store
                    : WGPUStoreOp_Discard;
                depth_attachment.stencilLoadOp = WGPULoadOp_Clear;
                depth_attachment.stencilStoreOp = WGPUStoreOp_Discard;
                WGPURenderPassDescriptor pass_descriptor =
                    WGPU_RENDER_PASS_DESCRIPTOR_INIT;
                pass_descriptor.colorAttachmentCount =
                    color_attachments.size();
                pass_descriptor.colorAttachments =
                    color_attachments.data();
                pass_descriptor.depthStencilAttachment =
                    &depth_attachment;
                DawnRenderPass task_pass{wgpuCommandEncoderBeginRenderPass(
                        encoder,
                        &pass_descriptor)};
                // Both are read only by the composed families' arms below,
                // so a scene reaching neither leaves them untouched.
                [[maybe_unused]] WGPURenderPipeline bound_pipeline = nullptr;
                const auto draw_geometry_list =
                    [&](const upstream::RenderDrawList& list) {
                        for (const upstream::RenderDrawCommand& draw :
                             list.commands) {
                            if (!upstream::render_item_draws_now(draw.item, engine)) continue;
                            if (
                                draw.item_index >=
                                graph_meshes.size()) {
                                continue;
                            }
                            [[maybe_unused]] DawnMesh& mesh =
                                graph_meshes[draw.item_index];
#if BBLITE_PBR_VARIANTS > 0
                            // The pin's own MRT arm for a PBR draw: the
                            // variant the selector table keys on this
                            // task, its bindings built in the write phase.
                            if (
                                draw.item.material_kind ==
                                upstream::RenderMaterialKind::pbr) {
                                pal::PinnedVariantKey geometry_key;
                                const std::size_t variant =
                                    pinned_variant_for_draw(
                                        graph_scene,
                                        engine,
                                        draw,
                                        static_cast<std::size_t>(
                                            task.geometry.shader_index),
                                        &geometry_key);
                                if (variant == npos) {
                                    dawn_error(
                                        ("PBR draw for mesh " +
                                         std::to_string(
                                             draw.item.mesh.value) +
                                         " resolves no pinned variant in "
                                         "a geometry task: " +
                                         pal::pinned_variant_request(
                                             geometry_key,
                                             static_cast<std::size_t>(
                                                 task.geometry
                                                     .shader_index)))
                                            .c_str());
                                }
                                const auto draw_state_it =
                                    mesh.pinned_geometry_states.find(
                                        variant);
                                if (
                                    draw_state_it ==
                                    mesh.pinned_geometry_states.end()) {
                                    dawn_error(
                                        "pinned geometry draw reached the "
                                        "encoder with no bindings.");
                                }
                                const InstanceStreams pinned_streams =
                                    instance_streams_for(
                                        engine.meshes[
                                            draw.item.mesh.value],
                                        mesh,
                                        InstanceMatrixSource::pinned);
                                encode_variant_draw(
                                    task_pass,
                                    pinned_variant_pipeline(
                                        state,
                                        variant,
                                        draw.pipeline,
                                        samples,
                                        true,
                                        &task),
                                    bound_pipeline,
                                    pinned_geometry_frame_group(state),
                                    draw_state_it->second.group,
                                    mesh.pinned_mirrored_vertices
                                        ? mesh.vertices
                                        : mesh.pinned_vertices,
                                    pinned_streams,
                                    mesh.indices,
                                    mesh.index_count);
                                continue;
                            }
#endif
#if BBLITE_STANDARD_VARIANTS > 0
                            // The composed Standard MRT arm: variant and
                            // bindings resolved in the write phase, the
                            // task's own gp buffer inside the group.
                            if (
                                draw.item.material_kind ==
                                upstream::RenderMaterialKind::standard) {
                                const std::size_t variant =
                                    standard_variant_for_draw(
                                        graph_scene,
                                        engine,
                                        draw,
                                        static_cast<std::size_t>(
                                            task.geometry.shader_index));
                                if (variant == npos) {
                                    dawn_error(
                                        ("Standard draw for mesh " +
                                         std::to_string(
                                             draw.item.mesh.value) +
                                         " resolves no composed variant "
                                         "in a geometry task: " +
                                         standard_variant_request(
                                             engine,
                                             draw))
                                            .c_str());
                                }
                                const auto draw_state_it =
                                    mesh.standard_geometry_states.find(
                                        variant);
                                if (
                                    draw_state_it ==
                                        mesh.standard_geometry_states
                                            .end() ||
                                    !draw_state_it->second.group) {
                                    dawn_error(
                                        "standard geometry draw reached "
                                        "the encoder with no bindings.");
                                }
                                const InstanceStreams standard_streams =
                                    instance_streams_for(
                                        engine.meshes[
                                            draw.item.mesh.value],
                                        mesh,
                                        InstanceMatrixSource::standard);
                                encode_variant_draw(
                                    task_pass,
                                    standard_variant_pipeline(
                                        state,
                                        variant,
                                        draw.pipeline,
                                        samples,
                                        true,
                                        false,
                                        &task),
                                    bound_pipeline,
                                    pinned_geometry_frame_group(state),
                                    draw_state_it->second.group,
                                    mesh.vertices,
                                    standard_streams,
                                    mesh.indices,
                                    mesh.index_count);
                                continue;
                            }
#endif
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
                            // The node family's own MRT arm: the view
                            // composed for this task, with the group the
                            // write phase built around the task's
                            // gpUniforms.
                            if (
                                draw.item.material_kind ==
                                upstream::RenderMaterialKind::node) {
                                const std::size_t geometry_variant =
                                    pal::require_node_geometry_variant(
                                        draw.item.shader_variant,
                                        static_cast<std::size_t>(
                                            task.geometry.shader_index));
                                const auto draw_state_it =
                                    mesh.node_geometry_states.find(
                                        geometry_variant);
                                if (
                                    draw_state_it ==
                                        mesh.node_geometry_states.end() ||
                                    !draw_state_it->second.group) {
                                    dawn_error(
                                        "node geometry draw reached the "
                                        "encoder with no bindings.");
                                }
                                encode_node_variant_draw(
                                    state, draw,
                                    task_pass,
                                    node_variant_pipeline(
                                        state,
                                        draw.item.shader_variant,
                                        draw.pipeline,
                                        samples,
                                        true,
                                        false,
                                        false,
                                        invalid_handle,
                                        &task,
                                        geometry_variant),
                                    bound_pipeline,
                                    pinned_geometry_frame_group(state),
                                    draw_state_it->second.group,
                                    // A node graph reads the baked
                                    // vertices under the identity world,
                                    // like the Standard family.
                                    mesh.vertices,
                                    InstanceStreams{},
                                    mesh.indices,
                                    mesh.index_count);
                                continue;
                            }
#endif
                            // Every mesh-family draw resolved a
                            // composed variant above; nothing else is
                            // eligible for a geometry task.
                            dawn_error(
                                "geometry task draw resolved no composed "
                                "variant.");
                        }
                    };
                draw_geometry_list(render_task.draw_lists.opaque);
                draw_geometry_list(render_task.draw_lists.transparent);
                wgpuRenderPassEncoderEnd(task_pass);
                task_pass.reset();
                continue;
            }
#if defined(BBLITE_HAS_EFFECT_TASK) && BBLITE_HAS_EFFECT_TASK
            if (task.kind == FrameTaskKind::effect) {
                // The same two halves the swapchain renderer draws through,
                // recorded into the frame graph's encoder instead: the pin
                // ships two entry points over one pass, not two passes.
                if (state.effect_tasks.size() < engine.frame_tasks.size()) {
                    state.effect_tasks.resize(engine.frame_tasks.size());
                }
                DawnEffectPass& pass = handle_at(state.effect_tasks, handle);
                const RenderTargetRecord& target_record =
                    handle_at(engine.render_targets, task.effect.target);
                DawnRenderTarget& target =
                    handle_at(state.render_targets, task.effect.target);
                if (!pass.pipeline) {
                    pass = create_dawn_effect_pass(
                        state,
                        engine,
                        task.effect.effect,
                        target.color_format,
                        target_record.swapchain
                            ? 1u
                            : task_sample_count(state, target_record.samples));
                }
                upload_dawn_effect_pass(
                    state.queue,
                    engine,
                    pass,
                    task.effect.effect);
                WGPURenderPassColorAttachment attachment =
                    WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
                attachment.view = target_record.swapchain
                    ? surface_view
                    : target.color_view;
                attachment.loadOp = task.effect.clear
                    ? WGPULoadOp_Clear
                    : WGPULoadOp_Load;
                attachment.storeOp = WGPUStoreOp_Store;
                attachment.clearValue = WGPUColor{
                    task.effect.clear_color.r,
                    task.effect.clear_color.g,
                    task.effect.clear_color.b,
                    task.effect.clear_color.a};
                WGPURenderPassDescriptor descriptor =
                    WGPU_RENDER_PASS_DESCRIPTOR_INIT;
                descriptor.colorAttachmentCount = 1;
                descriptor.colorAttachments = &attachment;
                DawnRenderPass effect_pass{wgpuCommandEncoderBeginRenderPass(encoder, &descriptor)};
                record_dawn_effect_pass(effect_pass, pass);
                wgpuRenderPassEncoderEnd(effect_pass);
                effect_pass.reset();
                continue;
            }
#endif
#if defined(BBLITE_HAS_POST_PROCESS) && BBLITE_HAS_POST_PROCESS
            if (task.kind == FrameTaskKind::post_process) {
#if defined(BBLITE_HAS_TAA) && BBLITE_HAS_TAA
                const auto execute_pass = [&](std::size_t child, bool write_uniforms) {
                    auto prepared = prepare_dawn_post_process_pass(state, engine, handle, width, height,
                        child, source_texture_view, write_uniforms);
                    encode_dawn_post_process_pass(encoder, surface_view, prepared);
                    if (prepared.presents) {
                        frame_graph_presented = true;
                    }
                    return upstream::post_process_leaf_draw_count();
                };
                if (task.post_process.taa) {
                    auto& taa = *task.post_process.taa;
                    const auto source_handle = task.post_process.source_tasks.at(0);
                    auto& source = engine.frame_tasks.at(source_handle.value);
                    auto& gpu_source = state.render_tasks.at(source_handle.value);
                    if (!source.source_scene) throw std::runtime_error("Temporal source has no retained scene.");
                    restore_temporal_source_buffer(state, source, gpu_source);
                    CameraRecord* source_camera = source.source_scene->camera.value < engine.cameras.size()
                        ? &handle_at(engine.cameras, source.source_scene->camera) : nullptr;
                    [[maybe_unused]] const double draws = upstream::execute_taa_post_process(taa,
                        task.post_process.passes.at(0).params[0], source_camera,
                        [](CameraRecord* value) { return upstream::scene_camera_change_key(*value); },
                        [&](std::size_t child) { write_dawn_post_process_uniforms(state, engine, handle, child, width, height, true); },
                        [&](std::size_t child) -> std::optional<double> { return execute_pass(child, false); },
                        [&](TaaPostProcessState& value) {
                            const auto& blend = task.post_process.passes.at(0);
                            const auto extent = resolve_post_process_extent(engine.render_targets.at(blend.output_target.value),
                                state.render_targets, blend, width, height);
                            advance_temporal_jitter(value, *source.scene_uniforms, extent.source_width, extent.source_height,
                                [&](std::size_t offset, const float* data, std::size_t bytes) {
                                    wgpuQueueWriteBuffer(state.queue, gpu_source.pinned_scene_uniforms, offset, data, bytes);
                                });
                        });
                    ++taa.execution_count;
                } else {
                    for (std::size_t child = 0; child < task.post_process.passes.size(); ++child) execute_pass(child, true);
                }
                continue;
#endif
                // A composite records the chain its own factory built; a
                // plain effect is the same loop over one.
                for (
                    std::size_t index = 0;
                    index < task.post_process.passes.size();
                    ++index) {
                    record_post_process_pass(
                        state,
                        engine,
                        handle,
                        encoder,
                        surface_view,
                        width,
                        height,
                        index,
                        source_texture_view);
                    const RenderTargetRecord& output_record =
                        engine.render_targets[
                            task.post_process.passes[index]
                                .output_target.value];
                    if (output_record.swapchain) {
                        frame_graph_presented = true;
                    }
                }
                continue;
            }
#endif
#if defined(BBLITE_HAS_SCREEN_SPACE) && BBLITE_HAS_SCREEN_SPACE
            if (task.kind == FrameTaskKind::screen_space) {
                record_screen_space_task(
                    state,
                    engine,
                    handle,
                    encoder,
                    surface_view,
                    width,
                    height,
                    source_texture_view,
                    frame_graph_presented);
                continue;
            }
#endif
            const CopyTaskOptions& copy = task.copy;
            if (frame_options.skip_copy_task(copy)) continue;
            const bool force_full_viewport = frame_options.full_copy_viewport(copy);
            if (
                copy.resolve_target.value != invalid_handle &&
                copy.target.value == invalid_handle) {
                if (
                    copy.source.source !=
                    RenderTextureSource::render_target) {
                    throw std::runtime_error(
                        "Resolve source must be a render target.");
                }
                DawnRenderTarget& resolve_source =
                    handle_at(state.render_targets, copy.source.target);
                DawnRenderTarget& resolve_target =
                    handle_at(state.render_targets, copy.resolve_target);
                if (!state.multisampled()) {
                    // Nothing to average: the pinned resolve of a
                    // single-sample source is the source, so the frame
                    // graph's resolve step is a texture copy.
                    WGPUTexelCopyTextureInfo copy_source{};
                    copy_source.texture = resolve_source.color;
                    WGPUTexelCopyTextureInfo copy_destination{};
                    copy_destination.texture = resolve_target.color;
                    const WGPUExtent3D extent{
                        resolve_source.width,
                        resolve_source.height,
                        1};
                    wgpuCommandEncoderCopyTextureToTexture(
                        encoder,
                        &copy_source,
                        &copy_destination,
                        &extent);
                    continue;
                }
                WGPURenderPassColorAttachment resolve_attachment =
                    WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
                resolve_attachment.view = resolve_source.color_view;
                resolve_attachment.resolveTarget =
                    resolve_target.color_view;
                resolve_attachment.loadOp = WGPULoadOp_Load;
                resolve_attachment.storeOp = WGPUStoreOp_Discard;
                WGPURenderPassDescriptor pass_descriptor =
                    WGPU_RENDER_PASS_DESCRIPTOR_INIT;
                pass_descriptor.colorAttachmentCount = 1;
                pass_descriptor.colorAttachments = &resolve_attachment;
                DawnRenderPass resolve_pass{wgpuCommandEncoderBeginRenderPass(
                        encoder,
                        &pass_descriptor)};
                wgpuRenderPassEncoderEnd(resolve_pass);
                resolve_pass.reset();
                continue;
            }
            const RenderTargetRecord& target_record =
                handle_at(engine.render_targets, copy.target);
            DawnRenderTarget& target =
                handle_at(state.render_targets, copy.target);
            const auto [source_texture, source_view] =
                source_texture_view(copy.source);
            const auto surface_pane = target_record.swapchain && !force_full_viewport
                ? scene_surface_pane(engine, graph_scene, width, height) : std::nullopt;
            WGPURenderPassColorAttachment blit_attachment =
                WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
            blit_attachment.view = target_record.swapchain
                ? surface_view
                : target.color_view;
            blit_attachment.loadOp = copy.has_viewport || (surface_pane && graph_layer > 0)
                ? WGPULoadOp_Load
                : WGPULoadOp_Clear;
            blit_attachment.storeOp = WGPUStoreOp_Store;
            WGPURenderPassDescriptor pass_descriptor =
                WGPU_RENDER_PASS_DESCRIPTOR_INIT;
            pass_descriptor.colorAttachmentCount = 1;
            pass_descriptor.colorAttachments = &blit_attachment;
            DawnRenderPass blit_pass{wgpuCommandEncoderBeginRenderPass(
                    encoder,
                    &pass_descriptor)};
            const std::uint32_t blit_samples = target_record.swapchain
                ? 1u
                : task_sample_count(state, target_record.samples);
            WGPURenderPipeline blit_pipeline = blit_pipeline_for(
                state,
                state.surface_format,
                blit_samples);
            wgpuRenderPassEncoderSetPipeline(blit_pass, blit_pipeline);
            if (surface_pane) {
                wgpuRenderPassEncoderSetViewport(blit_pass,
                    static_cast<float>(surface_pane->x), static_cast<float>(surface_pane->y),
                    static_cast<float>(surface_pane->width), static_cast<float>(surface_pane->height),
                    0.0f, 1.0f);
                wgpuRenderPassEncoderSetScissorRect(blit_pass,
                    surface_pane->x, surface_pane->y, surface_pane->width, surface_pane->height);
            } else if (copy.has_viewport && !force_full_viewport) {
#if defined(BBLITE_HAS_GEOMETRY_OUTPUT) && BBLITE_HAS_GEOMETRY_OUTPUT
                const PixelViewport pixel_viewport =
                    upstream::resolve_copy_viewport(
                        copy.viewport,
                        target.width,
                        target.height);
                wgpuRenderPassEncoderSetViewport(
                    blit_pass,
                    static_cast<float>(pixel_viewport.x),
                    static_cast<float>(pixel_viewport.y),
                    static_cast<float>(pixel_viewport.width),
                    static_cast<float>(pixel_viewport.height),
                    0.0f,
                    1.0f);
                wgpuRenderPassEncoderSetScissorRect(
                    blit_pass,
                    static_cast<std::uint32_t>(pixel_viewport.x),
                    static_cast<std::uint32_t>(pixel_viewport.y),
                    static_cast<std::uint32_t>(pixel_viewport.width),
                    static_cast<std::uint32_t>(pixel_viewport.height));
#else
                throw std::runtime_error(
                    "Viewport copy requires geometry-output support.");
#endif
            }
            {
                WGPUBindGroup blit_group = blit_group_for(state, blit_pipeline, source_view);
                wgpuRenderPassEncoderSetBindGroup(
                    blit_pass,
                    2,
                    blit_group,
                    0,
                    nullptr);
                count_gpu_draw(wgpuRenderPassEncoderDraw, blit_pass, 3, 1, 0, 0);
                wgpuRenderPassEncoderEnd(blit_pass);
                blit_pass.reset();
                wgpuBindGroupRelease(blit_group);
            }
            if (target_record.swapchain) {
                // A copy covering the whole swapchain IS its source, so
                // the capture reads that source and skips a surface
                // readback. One writing a VIEWPORT is only part of the
                // frame -- scene 187 presents SMAA beside the raw image,
                // each into half -- so the composed image is the surface,
                // and the source is both the wrong size and the wrong
                // content. The surface is configured CopySrc, which is
                // what the standalone frame-graph driver already captures.
                if (!copy.has_viewport && !surface_pane) {
                    capture_source = source_texture;
                }
                frame_graph_presented = true;
            }
        }
        }
#if defined(BBLITE_HAS_TAA) && BBLITE_HAS_TAA
            if (frame_graph_presented) retain_temporal_presentation(state, encoder, surface_texture.texture, width, height);
        } else if (state.temporal_presented) {
            present_stopped_temporal_frame(state, encoder, surface_view);
            frame_graph_presented = true;
        }
#endif
        pass_scene = &scene;
        pass_meshes = &state.meshes;
        }

#if (defined(BBLITE_HAS_TAA) && BBLITE_HAS_TAA) || (defined(BBLITE_HAS_TEXT) && BBLITE_HAS_TEXT) || BBLITE_NODE_GEOMETRY_VARIANTS > 0
        capture_render_state();
#endif
#if defined(BBLITE_HAS_SPRITE_RENDERER) && BBLITE_HAS_SPRITE_RENDERER
        // The scene context records first. Registered sprite contexts then
        // load and blend over the final surface in registration order, after
        // any transmission image processing or frame-graph copy. Capture and
        // presentation therefore observe the same composed frame.
        if (!engine.registered_sprite_renderers.empty()) {
            for (const SpriteRendererHandle handle :
                 engine.registered_sprite_renderers) {
                if (handle.value >= state.sprite_passes.size()) {
                    throw std::runtime_error(
                        "A SpriteRenderer created after the scene frame "
                        "started has no Dawn pass yet.");
                }
                const SpriteRendererRecord& renderer =
                    handle_at(engine.sprite_renderers, handle);
                WGPURenderPassColorAttachment sprite_attachment =
                    WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
                sprite_attachment.view = renderer.has_target
                    ? state.sprite_render_texture_views[
                          renderer.target.value]
                    : surface_view;
                sprite_attachment.loadOp = renderer.clear
                    ? WGPULoadOp_Clear
                    : WGPULoadOp_Load;
                sprite_attachment.storeOp = WGPUStoreOp_Store;
                sprite_attachment.clearValue = WGPUColor{
                    renderer.clear_value.r,
                    renderer.clear_value.g,
                    renderer.clear_value.b,
                    renderer.clear_value.a};
                WGPURenderPassDescriptor sprite_descriptor =
                    WGPU_RENDER_PASS_DESCRIPTOR_INIT;
                sprite_descriptor.colorAttachmentCount = 1;
                sprite_descriptor.colorAttachments = &sprite_attachment;
                DawnRenderPass sprite_encoder{wgpuCommandEncoderBeginRenderPass(
                        encoder,
                        &sprite_descriptor)};
                record_dawn_sprite_pass(
                    sprite_encoder,
                    engine,
                    handle_at(state.sprite_passes, handle));
                wgpuRenderPassEncoderEnd(sprite_encoder);
                sprite_encoder.reset();
            }
            capture_source = surface_texture.texture;
        }
#endif
    }

    FramePreparation present() {
        [[maybe_unused]] auto& engine = data_.engine;
        [[maybe_unused]] auto& captures = data_.captures;
        [[maybe_unused]] auto& frame = data_.frame;
        [[maybe_unused]] auto& scene = data_.scene;
        [[maybe_unused]] auto& state = data_.state;
        [[maybe_unused]] auto& width = data_.width;
        [[maybe_unused]] auto& height = data_.height;
        [[maybe_unused]] auto& render_plan = data_.render_plan;
        [[maybe_unused]] auto& benchmark_samples = data_.samples_ms;
        [[maybe_unused]] auto& screenshot_path = data_.frame_options.screenshot_path;
        [[maybe_unused]] auto& id_buffer_path = data_.frame_options.id_buffer_path;
        [[maybe_unused]] auto& cluster_buffer_path = data_.frame_options.cluster_buffer_path;
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI && !(defined(BBLITE_WORKERS) && BBLITE_WORKERS)
        [[maybe_unused]] auto& capture_ui = data_.frame_options.capture_ui;
#endif
        [[maybe_unused]] const auto benchmark = data_.frame_options.benchmarking();
        [[maybe_unused]] const auto benchmark_warmup = data_.frame_options.benchmark_warmup();
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI && !(defined(BBLITE_WORKERS) && BBLITE_WORKERS)
        [[maybe_unused]] auto& ui_runtime = data_.ui_runtime;
#endif
#if BBLITE_OFFSCREEN_SURFACES
        [[maybe_unused]] auto& offscreen = data_.offscreen;
#endif
#if BBLITE_OFFSCREEN_SURFACES
        [[maybe_unused]] auto& offscreen_images = data_.offscreen_images;
#endif
        [[maybe_unused]] const auto& benchmark_start = frame_->benchmark_start;
        [[maybe_unused]] const auto& capture_ready = frame_->capture_ready;
        [[maybe_unused]] auto& surface_texture = frame_->surface_texture;
        [[maybe_unused]] auto& surface = frame_->surface;
        [[maybe_unused]] auto& surface_view = frame_->surface_view;
        [[maybe_unused]] auto& encoder = frame_->encoder;
        [[maybe_unused]] auto& capture_source = frame_->capture_source;
        [[maybe_unused]] auto& frame_graph_presented = frame_->frame_graph_presented;
        const bool capture_frame =
            capture_ready &&
            !captures.screenshot_saved &&
            !screenshot_path.empty();
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI && !(defined(BBLITE_WORKERS) && BBLITE_WORKERS)
        const UiRenderFrame& ui_frame =
            record_ui_rml_frame(*ui_runtime, width, height);
        const bool ui_after_capture_copy = capture_frame && !capture_ui;
        if (!ui_after_capture_copy) {
            render_ui_dawn_frame(
                state,
                encoder,
                surface_texture.texture,
                surface_view,
                ui_frame);
            if (capture_frame && capture_ui) {
                capture_source = surface_texture.texture;
            }
        }
#endif
        DawnBuffer readback{nullptr};
        const std::uint32_t bytes_per_row = (width * 4 + 255) & ~255u;
        if (capture_frame) {
            if (!scene.tasks.empty() && !frame_graph_presented) {
                throw std::runtime_error(
                    "Frame graph did not present a capture source.");
            }
            WGPUBufferDescriptor readback_descriptor =
                WGPU_BUFFER_DESCRIPTOR_INIT;
            readback_descriptor.usage =
                WGPUBufferUsage_CopyDst | WGPUBufferUsage_MapRead;
            readback_descriptor.size =
                static_cast<std::uint64_t>(bytes_per_row) * height;
            readback =
                wgpuDeviceCreateBuffer(state.device, &readback_descriptor);
            WGPUTexelCopyTextureInfo copy_source =
                WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
            copy_source.texture = capture_source;
            WGPUTexelCopyBufferInfo copy_destination =
                WGPU_TEXEL_COPY_BUFFER_INFO_INIT;
            copy_destination.layout.bytesPerRow = bytes_per_row;
            copy_destination.layout.rowsPerImage = height;
            copy_destination.buffer = readback;
            const WGPUExtent3D copy_size{width, height, 1};
            wgpuCommandEncoderCopyTextureToBuffer(
                encoder,
                &copy_source,
                &copy_destination,
                &copy_size);
        }
        DawnCommandBuffer command{wgpuCommandEncoderFinish(encoder, nullptr)};
        submit_dawn_command(state.queue, command);
        command.reset();
        encoder.reset();

        if (capture_frame) {
            WGPUBufferMapCallbackInfo map_callback =
                WGPU_BUFFER_MAP_CALLBACK_INFO_INIT;
            map_callback.mode = WGPUCallbackMode_WaitAnyOnly;
            map_callback.callback = [](
                                        WGPUMapAsyncStatus status,
                                        WGPUStringView message,
                                        void* userdata1,
                                        void*) {
                if (status != WGPUMapAsyncStatus_Success) {
                    auto* error = static_cast<std::string*>(userdata1);
                    if (error->empty()) *error = view_text(message);
                }
            };
            map_callback.userdata1 = &state.uncaptured_error;
            wait_for(
                state.instance,
                wgpuBufferMapAsync(
                    readback,
                    WGPUMapMode_Read,
                    0,
                    static_cast<std::size_t>(bytes_per_row) * height,
                    map_callback));
            const void* mapped = wgpuBufferGetConstMappedRange(
                readback,
                0,
                static_cast<std::size_t>(bytes_per_row) * height);
            if (!mapped) dawn_error("buffer map returned no data.");
            std::vector<std::uint8_t> pixels(
                static_cast<const std::uint8_t*>(mapped),
                static_cast<const std::uint8_t*>(mapped) +
                    static_cast<std::size_t>(bytes_per_row) * height);
            wgpuBufferUnmap(readback);
            save_capture_png(
                pixels,
                width,
                height,
                bytes_per_row,
                state.surface_format == WGPUTextureFormat_BGRA8Unorm,
                screenshot_path);
            captures.screenshot_saved = true;
        }
        if (readback) readback.reset();
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI && !(defined(BBLITE_WORKERS) && BBLITE_WORKERS)
        if (ui_after_capture_copy) {
            // Complete the canvas-only readback before transitioning the
            // surface back to a render attachment for host UI. Encoding both
            // uses in one submission can leave Dawn's map future unresolved.
            DawnCommandEncoder ui_encoder{wgpuDeviceCreateCommandEncoder(state.device, nullptr)};
            render_ui_dawn_frame(
                state,
                ui_encoder,
                surface_texture.texture,
                surface_view,
                ui_frame);
            DawnCommandBuffer ui_command{wgpuCommandEncoderFinish(ui_encoder, nullptr)};
            submit_dawn_command(state.queue, ui_command);
            ui_command.reset();
            ui_encoder.reset();
        }
#endif

        if (
            capture_ready && !captures.id_buffer_saved &&
            !id_buffer_path.empty()) {
            save_dawn_geometry_id_buffer(
                state,
                width,
                height,
                render_plan.items,
                engine,
                id_buffer_path,
                false);
            captures.id_buffer_saved = true;
        }
        if (
            capture_ready && !captures.cluster_buffer_saved &&
            !cluster_buffer_path.empty()) {
            save_dawn_geometry_id_buffer(
                state,
                width,
                height,
                render_plan.items,
                engine,
                cluster_buffer_path,
                true);
            captures.cluster_buffer_saved = true;
        }

#if BBLITE_OFFSCREEN_SURFACES
        if (offscreen) offscreen_images.publish(*offscreen);
        else
#endif
        wgpuSurfacePresent(state.surface);
        if (benchmark && frame >= benchmark_warmup) {
            benchmark_samples.push_back(
                monotonic_milliseconds() - benchmark_start);
        }
        surface_view.reset();
        surface.reset();
        wgpuInstanceProcessEvents(state.instance);
#if defined(BBLITE_DEVICE_RECOVERY) && BBLITE_DEVICE_RECOVERY
        if (state.device_lost) {
            force_device_loss(engine);
            return FramePreparation::stop;
        }
#endif
        if (!state.uncaptured_error.empty()) {
            dawn_error("uncaptured error: " + state.uncaptured_error);
        }
#if defined(BBLITE_DEVICE_RECOVERY) && BBLITE_DEVICE_RECOVERY
        if (engine.device_recovery) {
            auto& recovery = *engine.device_recovery;
            GpuTextureIdentity& environment = recovery.environments[scene.state.get()];
            if (environment.object == 0 || environment.generation != engine.device_generation ||
                state.published_environment_cube != state.environment_cube) {
                state.published_environment_cube = state.environment_cube;
                environment = publish_gpu_texture_identity(engine);
            }
            if (recovery.fallback.object == 0 || recovery.fallback.generation != engine.device_generation ||
                state.published_white_texture != state.white_texture) {
                state.published_white_texture = state.white_texture;
                recovery.fallback = publish_gpu_texture_identity(engine);
            }
            auto& renderable_count = recovery.renderable_counts[scene.state.get()];
            renderable_count = state.meshes.size() + state.skybox_enabled + state.ground_enabled;
#if BBLITE_SOLID_SKYBOX
            renderable_count += state.solid_skybox_enabled;
#endif
#if BBLITE_IMAGE_SKYBOX
            renderable_count += state.image_skybox_enabled;
#endif
#if BBLITE_SHADOW_RECEIVERS
            recovery.shadows.resize(engine.shadow_generators.size());
            for (std::size_t i = 0; i < engine.shadow_generators.size(); ++i) {
                const auto& generator = engine.shadow_generators[i];
                if (generator.map_target.value >= state.render_targets.size()) continue;
                WGPUTexture texture = handle_at(state.render_targets, generator.map_target).depth.get();
#if BBLITE_SHADOWS_ESM
                if (generator.filter == ShadowFilter::esm_directional && generator.esm_index < state.esm_blurs.size()) texture = state.esm_blurs[generator.esm_index].blur_v;
#endif
                recovery.shadows[i] = {engine.device_generation, reinterpret_cast<std::uintptr_t>(texture)};
            }
#endif
            recovery.resources_ready = true;
        }
#endif

        return FramePreparation::ready;
    }

    void complete() {
        [[maybe_unused]] auto& engine = data_.engine;
        [[maybe_unused]] auto& frame = data_.frame;
        [[maybe_unused]] auto& cpu_profile = data_.cpu_profile;
        [[maybe_unused]] auto& mem_profile = data_.mem_profile;
        [[maybe_unused]] auto& scene = data_.scene;
        [[maybe_unused]] auto& state = data_.state;
        [[maybe_unused]] auto& render_plan = data_.render_plan;
        [[maybe_unused]] const auto& benchmark_start = frame_->benchmark_start;
        [[maybe_unused]] const auto& updated = frame_->updated;
        [[maybe_unused]] const auto& uploaded = frame_->uploaded;
        [[maybe_unused]] const auto& written = frame_->written;
        [[maybe_unused]] const auto& acquired = frame_->acquired;
        [[maybe_unused]] auto& profile_transformed_meshes = frame_->profile_transformed_meshes;
        [[maybe_unused]] auto& profile_transformed_vertices = frame_->profile_transformed_vertices;
        finish_frame(engine);
        ++frame;
        // Profile-only too: this backend's benchmark sample above reads its
        // own `monotonic_milliseconds()` inline.
        const double end =
            cpu_profile ? monotonic_milliseconds() : 0.0;
        const long completed_frame = frame - 1;
        if (mem_profile && completed_frame % memory_profile_frames == 0) {
            print_memory_frame_profile(
                completed_frame,
                engine,
                scene,
                state.meshes,
                state.shared_shader_geometries);
        }
        if (cpu_profile && completed_frame % 30 == 0) {
            std::size_t draw_commands =
                render_plan.draw_lists.opaque.commands.size() +
                render_plan.draw_lists.transparent.commands.size();
            for (const DawnRenderTask& profiled : state.render_tasks) {
                draw_commands += profiled.draw_lists.opaque.commands.size() +
                    profiled.draw_lists.transparent.commands.size();
            }
            // The SDL backend's labels where the phase is the same concept.
            // The acquire sits late here rather than at the loop head, and
            // `write_ms` is this backend's own phase: the per-draw block
            // writes WebGPU's no-push-constants model forces.
            print_cpu_frame_profile(
                completed_frame,
                end - benchmark_start,
                acquired - written,
                updated - benchmark_start,
                uploaded - updated,
                written - uploaded,
                end - acquired,
                render_plan.items.size(),
                draw_commands,
                profile_transformed_meshes,
                profile_transformed_vertices);
        }
    }

    void finish_run() {
        [[maybe_unused]] auto& engine = data_.engine;
        [[maybe_unused]] auto& state = data_.state;
        [[maybe_unused]] auto& benchmark_samples = data_.samples_ms;
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI && !(defined(BBLITE_WORKERS) && BBLITE_WORKERS)
        [[maybe_unused]] auto& ui_runtime = data_.ui_runtime;
#endif
        report_benchmark(benchmark_samples, "Dawn", "D3D12");
#if defined(BBLITE_DEVICE_RECOVERY) && BBLITE_DEVICE_RECOVERY
        if (engine.device_recovery && (engine.device_recovery->requested || engine.device_recovery->disposed)) wgpuDeviceDestroy(state.device);
#endif
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI && !(defined(BBLITE_WORKERS) && BBLITE_WORKERS)
        ui_runtime.reset();
#endif
        // No catch arm: everything `~DawnState` and the unique_ptr UI runtime
        // own unwinds on its own, and `pick_hook_guard` clears the hook on
        // either exit.
    }

};

SceneRun run_dawn_engine(Engine& engine) {
    if (engine.registered_scenes.empty() || !engine.registered_scenes.front())
        throw std::runtime_error("Dawn renderer requires a registered scene.");
    DawnSceneRun renderer(engine);
    renderer.setup();
    for (;;) {
        renderer.discard_frame();
        const FrameOutcome outcome = conduct_frame(renderer);
        if (outcome == FrameOutcome::stopped || outcome == FrameOutcome::restart) break;
        if (outcome == FrameOutcome::rendered || renderer.yield_when_skipped())
            BBLITE_FRAME_YIELD(outcome == FrameOutcome::rendered);
    }
    renderer.discard_frame();
    renderer.finish_run();
    BBLITE_RUN_RETURN(true);
}

} // namespace bbl::pal

#endif
