// Dawn (WebGPU) render backend. Renders through the same pinned Dawn
// commit as the Tint shader compiler so native output shares the
// browser reference's compiler and rasterization stack. Generated
// native WGSL is fed to Dawn directly; there is no offline shader
// compilation in this backend.
//
// Current slice: Standard-material opaque scenes without environment
// features. Unreached paths fail explicitly instead of approximating.

#include <bblite/pal.hpp>
#include <bblite/pal_gpu.hpp>
#include <bblite/pal_image.hpp>
#include <bblite/runtime.hpp>
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
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
#include "pal_render_capture.hpp"

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
    WGPUBindGroup scene = nullptr;
    WGPUBindGroup textures = nullptr;
    WGPUBindGroup material = nullptr;
#if BBLITE_GPU_MORPH_STORAGE
    WGPUBindGroup morph = nullptr;
#endif
};

// dawn_blend_factor / blend_state_from moved to pal_dawn_shared.hpp so
// the family headers can translate the shared blend tuples too.

/** The shared cull enum in this API's; the pipeline-kind facts come from
 *  `pipeline_kind_traits` (pal_gpu_shared.hpp). */
WGPUCullMode dawn_cull_mode(upstream::RenderCullMode cull) {
    return cull == upstream::RenderCullMode::none
        ? WGPUCullMode_None
        : WGPUCullMode_Back;
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
    (BBLITE_MATERIAL_SPEC_GLOSS ? 1 : 0) +
    (BBLITE_MATERIAL_OCCLUSION_UV2 ? 1 : 0);
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
struct DawnDrawState {
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
    std::size_t group_key = std::numeric_limits<std::size_t>::max();
    /** The pinned arm's vertex choice; `pinned_draw_conventions` states it. */
    bool mirrored_vertices = false;
};

/** Releases what one map of draw states owns, and empties it. */
template <typename Key>
inline void release_dawn_draw_states(
    std::map<Key, DawnDrawState>& states) {
    for (auto& [key, draw_state] : states) {
        if (draw_state.group) wgpuBindGroupRelease(draw_state.group);
        if (draw_state.uv_transform_uniforms) {
            wgpuBufferRelease(draw_state.uv_transform_uniforms);
        }
        if (draw_state.uv_uniforms) {
            wgpuBufferRelease(draw_state.uv_uniforms);
        }
        if (draw_state.material_uniforms) {
            wgpuBufferRelease(draw_state.material_uniforms);
        }
        if (draw_state.mesh_uniforms) {
            wgpuBufferRelease(draw_state.mesh_uniforms);
        }
    }
    states.clear();
}

struct DawnSharedShaderGeometry;
struct DawnSharedShaderMaterialTextures;
struct DawnSharedComposedMaterialTextures;

struct DawnMesh {
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
    WGPUTexture pinned_bone_texture = nullptr;
    // Whether this frame's pinned draw reads the mirrored buffer: skinned
    // draws and palette-world animated meshes both do.
    bool pinned_mirrored_vertices = false;
    WGPUTextureView pinned_bone_view = nullptr;
    std::uint32_t pinned_bone_count = 0;
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
    WGPUBuffer instance_uniform = nullptr;
    std::uint32_t instance_count = 1;
    std::uint64_t instance_version = 0;
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
};

/** One exact local-space shader geometry retained across topology rebuilds. */
struct DawnSharedShaderGeometry {
    std::vector<GpuVertex> vertices;
    std::vector<std::uint32_t> indices;
    WGPUBuffer vertex_buffer = nullptr;
    WGPUBuffer index_buffer = nullptr;
    std::size_t users = 0;
};

/** Texture/sampler triples shared by every mesh using one shader material. */
struct DawnSharedShaderMaterialTextures {
    MaterialHandle material{};
    std::vector<DawnSampledTexture> textures;
    std::size_t users = 0;
};

/** Generated PBR/Standard texture slots uploaded once per material. */
struct DawnSharedComposedMaterialTextures {
    MaterialHandle material{};
    bool standard_material = false;
    std::array<WGPUTexture, mesh_texture_slots> textures{};
    std::array<WGPUTextureView, mesh_texture_slots> views{};
    std::array<WGPUSampler, mesh_texture_slots> samplers{};
    std::size_t users = 0;
};

void release_dawn_composed_material_textures(
    DawnSharedComposedMaterialTextures& textures) {
    for (std::size_t slot = 0; slot < mesh_texture_slots; ++slot) {
        if (textures.views[slot]) {
            wgpuTextureViewRelease(textures.views[slot]);
        }
        if (textures.textures[slot]) {
            wgpuTextureRelease(textures.textures[slot]);
        }
        if (textures.samplers[slot]) {
            wgpuSamplerRelease(textures.samplers[slot]);
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
    WGPUTexture color = nullptr;
    WGPUTextureView color_view = nullptr;
    WGPUTexture sampled_color = nullptr;
    WGPUTextureView sampled_color_view = nullptr;
    WGPUTexture depth = nullptr;
    WGPUTextureView depth_view = nullptr;
    // Sampled-depth targets copy the depth aspect into an r32float
    // color texture after their task so material slots can filter it
    // like the SDL backend's direct depth SRV reads.
    WGPUTextureView depth_sampled_view = nullptr;
    WGPUTexture depth_copy = nullptr;
    WGPUTextureView depth_copy_view = nullptr;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    /** What its colour attachment resolved to, for a target that follows it. */
    WGPUTextureFormat color_format = WGPUTextureFormat_Undefined;
};

struct DawnRenderTask {
    upstream::RenderDrawLists draw_lists;
    WGPUBuffer view_projection = nullptr;
    // Lazily created group-1 bind group for depth-only passes.
    WGPUBindGroup scene_group = nullptr;
    // A task the scene gave its own camera composes its own view-projection
    // and eye position, so it needs its own copy of the pin's per-pass scene
    // block; the lights beside it are the scene's and stay shared. Null for
    // a task that draws through the scene camera, which binds the frame's.
    WGPUBuffer pinned_scene_uniforms = nullptr;
    WGPUBindGroup pinned_frame_group = nullptr;
};

struct DawnGeometryTask {
    std::vector<WGPUTexture> colors;
    std::vector<WGPUTextureView> color_views;
    std::vector<WGPUTexture> sampled_colors;
    std::vector<WGPUTextureView> sampled_views;
    WGPUTexture depth = nullptr;
    WGPUTextureView depth_view = nullptr;
    // The pin's gpUniforms for the task's MRT arms: previous-frame
    // view-projection and the camera near/far.
    WGPUBuffer pinned_geometry_params = nullptr;
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
    WGPUShaderModule module = nullptr;
    WGPUBindGroupLayout group_layout = nullptr;
    WGPUPipelineLayout pipeline_layout = nullptr;
    WGPURenderPipeline pipeline = nullptr;
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
    std::size_t program = std::numeric_limits<std::size_t>::max();
    WGPUBindGroup group = nullptr;
    WGPUBuffer uniforms = nullptr;
};
#endif

#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
struct DawnUiTexture {
    WGPUTexture texture = nullptr;
    WGPUTextureView view = nullptr;
    WGPUBindGroup group = nullptr;
    WGPUBindGroup nearest_group = nullptr;

    void release() {
        if (nearest_group) wgpuBindGroupRelease(nearest_group);
        if (group) wgpuBindGroupRelease(group);
        if (view) wgpuTextureViewRelease(view);
        if (texture) wgpuTextureRelease(texture);
        *this = {};
    }
};

/** Dawn-owned realization of the backend-neutral RmlUi frame. */
struct DawnUiResources {
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

struct DawnState : DawnDevice {
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
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
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
    std::vector<DawnRenderTask> render_tasks;
    std::vector<DawnGeometryTask> geometry_tasks;
#if defined(BBLITE_HAS_POST_PROCESS) && BBLITE_HAS_POST_PROCESS
    // Per frame task, one entry per pass it records.
    std::vector<std::vector<DawnPostProcessTask>> post_process_tasks;
    /** The distinct programs those passes draw with. */
    std::vector<DawnPostProcessProgram> post_process_programs;
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
    return state.shadow_params[material->esm_shadow_generator.value];
}
#endif

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
    WGPUShaderModule mip_vertex_module = nullptr;
    WGPUShaderModule mip_fragment_module = nullptr;
    WGPUSampler mip_sampler = nullptr;
#if BBLITE_GPU_MORPH_STORAGE
    WGPUBuffer empty_morph_deltas = nullptr;
    WGPUBuffer empty_morph_weights = nullptr;
#endif
    std::map<WGPUTextureFormat, WGPURenderPipeline> mip_pipelines;
    // Mesh pipelines keyed by (kind, shader variant id); the variant is
    // zero for every non-shader kind.
    std::map<
        std::pair<upstream::RenderPipelineKind, std::uint32_t>,
        DawnPipeline>
        pipelines;
    // Attribution capture resources (scene-1 diagnostics tooling),
    // created lazily on the first requested capture. Pipelines are
    // keyed by [double_sided]; the PBR diagnostic set adds the MRT
    // pass index.
    WGPUShaderModule diagnostic_id_module = nullptr;
    WGPUShaderModule diagnostic_cluster_module = nullptr;
    std::array<WGPURenderPipeline, 2> id_pipelines{};
    std::array<WGPURenderPipeline, 2> cluster_pipelines{};
    std::vector<DawnMesh> meshes;
    std::vector<std::unique_ptr<DawnSharedShaderGeometry>>
        shared_shader_geometries;
    std::vector<std::unique_ptr<DawnSharedShaderMaterialTextures>>
        shared_shader_material_textures;
    std::vector<std::unique_ptr<DawnSharedComposedMaterialTextures>>
        shared_composed_material_textures;

    // Frame-task draw resources are tied to the current render plan
    // and rebuild together with the meshes.
    void release_render_tasks() {
        for (DawnRenderTask& task : render_tasks) {
            if (task.scene_group) {
                wgpuBindGroupRelease(task.scene_group);
            }
            if (task.pinned_frame_group) {
                wgpuBindGroupRelease(task.pinned_frame_group);
            }
            if (task.pinned_scene_uniforms) {
                wgpuBufferRelease(task.pinned_scene_uniforms);
            }
            if (task.view_projection) {
                wgpuBufferRelease(task.view_projection);
            }
        }
        render_tasks.clear();
    }

    void release_frame_graph_textures() {
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
        for (DawnRenderTarget& target : render_targets) {
            if (
                target.sampled_color_view &&
                target.sampled_color_view != target.color_view) {
                wgpuTextureViewRelease(target.sampled_color_view);
            }
            if (
                target.sampled_color &&
                target.sampled_color != target.color) {
                wgpuTextureRelease(target.sampled_color);
            }
            if (target.color_view) {
                wgpuTextureViewRelease(target.color_view);
            }
            if (target.color) wgpuTextureRelease(target.color);
            if (target.depth_copy_view) {
                wgpuTextureViewRelease(target.depth_copy_view);
            }
            if (target.depth_copy) {
                wgpuTextureRelease(target.depth_copy);
            }
            if (target.depth_sampled_view) {
                wgpuTextureViewRelease(target.depth_sampled_view);
            }
            if (target.depth_view) {
                wgpuTextureViewRelease(target.depth_view);
            }
            if (target.depth) wgpuTextureRelease(target.depth);
            target = {};
        }
        for (DawnGeometryTask& task : geometry_tasks) {
            for (std::size_t index = 0;
                 index < task.colors.size();
                 ++index) {
                if (
                    index < task.sampled_views.size() &&
                    task.sampled_views[index] &&
                    task.sampled_views[index] !=
                        task.color_views[index]) {
                    wgpuTextureViewRelease(task.sampled_views[index]);
                }
                if (
                    index < task.sampled_colors.size() &&
                    task.sampled_colors[index] &&
                    task.sampled_colors[index] != task.colors[index]) {
                    wgpuTextureRelease(task.sampled_colors[index]);
                }
                if (task.color_views[index]) {
                    wgpuTextureViewRelease(task.color_views[index]);
                }
                if (task.colors[index]) {
                    wgpuTextureRelease(task.colors[index]);
                }
            }
            task.colors.clear();
            task.color_views.clear();
            task.sampled_colors.clear();
            task.sampled_views.clear();
            if (task.depth_view) {
                wgpuTextureViewRelease(task.depth_view);
            }
            if (task.depth) wgpuTextureRelease(task.depth);
            task.depth = nullptr;
            task.depth_view = nullptr;
            if (task.pinned_geometry_params) {
                wgpuBufferRelease(task.pinned_geometry_params);
                task.pinned_geometry_params = nullptr;
            }
            task.has_previous_view_projection = false;
        }
#if defined(BBLITE_HAS_POST_PROCESS) && BBLITE_HAS_POST_PROCESS
        // The pass's pipeline and bind group name the attachments the graph
        // just released, so they are rebuilt with them; the pin discards the
        // same state when its own internal target is re-created.
        for (std::vector<DawnPostProcessTask>& passes :
             post_process_tasks) {
            for (DawnPostProcessTask& task : passes) {
                if (task.group) wgpuBindGroupRelease(task.group);
                if (task.uniforms) wgpuBufferRelease(task.uniforms);
                task = {};
            }
        }
        post_process_tasks.clear();
        // The programs outlive no build: a rebuilt graph may target different
        // formats, and every pass that borrowed one was just reset.
        for (DawnPostProcessProgram& program : post_process_programs) {
            if (program.pipeline) {
                wgpuRenderPipelineRelease(program.pipeline);
            }
            if (program.pipeline_layout) {
                wgpuPipelineLayoutRelease(program.pipeline_layout);
            }
            if (program.group_layout) {
                wgpuBindGroupLayoutRelease(program.group_layout);
            }
            if (program.module) wgpuShaderModuleRelease(program.module);
            program = {};
        }
        post_process_programs.clear();
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

    // Release one mesh in dependency order. Submitted command buffers keep
    // their own references; this drops only the application's references.
    void release_mesh(DawnMesh& mesh) {
            // Bind groups are the dependents: release every group before
            // any buffer, texture view, sampler, or texture referenced by
            // one. Dawn's D3D12 implementation reads that binding state
            // while destroying a group, so the inverse order is not merely
            // a leak/lifetime nicety -- it can dereference freed metadata.
            for (auto& [kind, binding] : mesh.bindings) {
                if (binding.scene) wgpuBindGroupRelease(binding.scene);
                if (binding.textures) {
                    wgpuBindGroupRelease(binding.textures);
                }
                if (binding.material) {
                    wgpuBindGroupRelease(binding.material);
                }
#if BBLITE_GPU_MORPH_STORAGE
                if (binding.morph) wgpuBindGroupRelease(binding.morph);
#endif
            }
#if BBLITE_PBR_VARIANTS > 0
            release_dawn_draw_states(mesh.pinned_geometry_states);
            release_dawn_draw_states(mesh.pinned_states);
#endif
#if BBLITE_STANDARD_VARIANTS > 0
            release_dawn_draw_states(mesh.standard_geometry_states);
            release_dawn_draw_states(mesh.standard_states);
#endif
#if BBLITE_NODE_VARIANTS > 0
            release_dawn_draw_states(mesh.node_states);
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
#if BBLITE_PBR_VARIANTS > 0
            if (mesh.pinned_vertices) {
                wgpuBufferRelease(mesh.pinned_vertices);
                mesh.pinned_vertices = nullptr;
            }
            if (mesh.pinned_bone_view) {
                wgpuTextureViewRelease(mesh.pinned_bone_view);
            }
            if (mesh.pinned_bone_texture) {
                wgpuTextureRelease(mesh.pinned_bone_texture);
            }
            mesh.pinned_bone_view = nullptr;
            mesh.pinned_bone_texture = nullptr;
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
                    wgpuBufferRelease(geometry.vertex_buffer);
                }
                if (geometry.index_buffer) {
                    wgpuBufferRelease(geometry.index_buffer);
                }
            });
    }

    void prune_shared_shader_material_textures() {
        prune_unused_shared(
            shared_shader_material_textures,
            [](DawnSharedShaderMaterialTextures& textures) {
                release_dawn_extra_textures(textures.textures);
            });
    }

    void prune_shared_composed_material_textures() {
        prune_unused_shared(
            shared_composed_material_textures,
            [](DawnSharedComposedMaterialTextures& textures) {
                release_dawn_composed_material_textures(textures);
            });
    }

    void release_meshes() {
        for (DawnMesh& mesh : meshes) {
            release_mesh(mesh);
        }
        meshes.clear();
    }

    ~DawnState() {
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
        ui.release();
#endif
#if BBLITE_HAS_PICKING
        release_dawn_pick_targets(pick_targets);
        if (pick_mesh_pipeline) wgpuRenderPipelineRelease(pick_mesh_pipeline);
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
        for (auto& [format, pipeline] : mip_pipelines) {
            if (pipeline) wgpuRenderPipelineRelease(pipeline);
        }
        if (mip_sampler) wgpuSamplerRelease(mip_sampler);
        if (mip_fragment_module) {
            wgpuShaderModuleRelease(mip_fragment_module);
        }
        if (mip_vertex_module) wgpuShaderModuleRelease(mip_vertex_module);
        release_render_tasks();
        release_frame_graph_textures();
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
        release_all_shared(
            shared_shader_geometries,
            [](DawnSharedShaderGeometry& geometry) {
                if (geometry.vertex_buffer) {
                    wgpuBufferRelease(geometry.vertex_buffer);
                }
                if (geometry.index_buffer) {
                    wgpuBufferRelease(geometry.index_buffer);
                }
            });
        release_all_shared(
            shared_shader_material_textures,
            [](DawnSharedShaderMaterialTextures& textures) {
                release_dawn_extra_textures(textures.textures);
            });
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
        if (surface) wgpuSurfaceRelease(surface);
        if (queue) wgpuQueueRelease(queue);
        if (device) wgpuDeviceRelease(device);
        if (adapter) wgpuAdapterRelease(adapter);
        if (instance) wgpuInstanceRelease(instance);
        if (window) SDL_DestroyWindow(window);
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
    return state.shadow_params[material->esm_shadow_generator.value];
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
    WGPUBuffer buffer =
        wgpuDeviceCreateBuffer(state.device, &descriptor);
    if (!buffer) dawn_error("wgpuDeviceCreateBuffer");
    if (data) {
        wgpuQueueWriteBuffer(state.queue, buffer, 0, data, size);
    }
    return buffer;
}

#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
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
    WGPUShaderModule module =
        wgpuDeviceCreateShaderModule(state.device, &descriptor);
    if (!module) dawn_error("wgpuDeviceCreateShaderModule UI");
    return module;
}

WGPURenderPipeline create_ui_dawn_pipeline(
    DawnState& state,
    WGPUShaderModule module,
    const char* fragment_entry,
    WGPUTextureFormat format,
    std::uint32_t samples,
    WGPUPipelineLayout layout) {
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
    blend.color.dstFactor = WGPUBlendFactor_OneMinusSrcAlpha;
    blend.alpha.operation = WGPUBlendOperation_Add;
    blend.alpha.srcFactor = WGPUBlendFactor_One;
    blend.alpha.dstFactor = WGPUBlendFactor_OneMinusSrcAlpha;
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
    WGPURenderPipeline pipeline =
        wgpuDeviceCreateRenderPipeline(state.device, &descriptor);
    if (!pipeline) dawn_error("wgpuDeviceCreateRenderPipeline UI");
    return pipeline;
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
    WGPUBindGroup group =
        wgpuDeviceCreateBindGroup(state.device, &descriptor);
    if (!group) dawn_error("wgpuDeviceCreateBindGroup UI texture");
    return group;
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
    WGPUPipelineLayout color_layout =
        wgpuDeviceCreatePipelineLayout(state.device, &color_layout_descriptor);
    if (!color_layout) dawn_error("UI color pipeline layout");
    ui.color_pipeline = create_ui_dawn_pipeline(
        state,
        module,
        "fs_color",
        WGPUTextureFormat_RGBA8Unorm,
        state.sample_count,
        color_layout);
    wgpuPipelineLayoutRelease(color_layout);
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
    ui.layer_view = wgpuTextureCreateView(ui.layer, nullptr);
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
            wgpuTextureCreateView(ui.multisample_layer, nullptr);
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
    WGPUTextureView target,
    const UiRenderFrame& frame) {
    if (frame.draws.empty() || frame.width == 0 || frame.height == 0) return;
    create_ui_dawn_resources(state);
    ensure_ui_dawn_layers(state, frame.width, frame.height);
    DawnUiResources& ui = state.ui;

    std::vector<UiRenderVertex> vertices = frame.vertices;
    std::vector<std::uint32_t> indices = frame.indices;
    const std::uint32_t composite_first_index =
        static_cast<std::uint32_t>(indices.size());
    const std::uint32_t composite_first_vertex =
        static_cast<std::uint32_t>(vertices.size());
    vertices.insert(
        vertices.end(),
        {
            UiRenderVertex{0, 0, 255, 255, 255, 255, 0, 0},
            UiRenderVertex{static_cast<float>(frame.width), 0, 255, 255, 255, 255, 1, 0},
            UiRenderVertex{static_cast<float>(frame.width), static_cast<float>(frame.height), 255, 255, 255, 255, 1, 1},
            UiRenderVertex{0, static_cast<float>(frame.height), 255, 255, 255, 255, 0, 1},
        });
    indices.insert(
        indices.end(),
        {
            composite_first_vertex,
            composite_first_vertex + 1,
            composite_first_vertex + 2,
            composite_first_vertex,
            composite_first_vertex + 2,
            composite_first_vertex + 3,
        });

    const std::uint64_t vertex_bytes =
        vertices.size() * sizeof(UiRenderVertex);
    const std::uint64_t index_bytes =
        indices.size() * sizeof(std::uint32_t);
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
        state.queue, ui.vertices, 0, vertices.data(), vertex_bytes);
    wgpuQueueWriteBuffer(
        state.queue, ui.indices, 0, indices.data(), index_bytes);
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
        texture.view = wgpuTextureCreateView(texture.texture, nullptr);
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
    WGPURenderPassEncoder layer_pass =
        wgpuCommandEncoderBeginRenderPass(encoder, &layer_descriptor);
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
    for (const UiRenderDraw& draw : frame.draws) {
        const int left = std::clamp(draw.scissor_x, 0, static_cast<int>(frame.width));
        const int top = std::clamp(draw.scissor_y, 0, static_cast<int>(frame.height));
        const int right = std::clamp(
            draw.scissor_x + static_cast<int>(draw.scissor_width),
            0,
            static_cast<int>(frame.width));
        const int bottom = std::clamp(
            draw.scissor_y + static_cast<int>(draw.scissor_height),
            0,
            static_cast<int>(frame.height));
        if (right <= left || bottom <= top || draw.index_count == 0) continue;
        wgpuRenderPassEncoderSetScissorRect(
            layer_pass,
            static_cast<std::uint32_t>(left),
            static_cast<std::uint32_t>(top),
            static_cast<std::uint32_t>(right - left),
            static_cast<std::uint32_t>(bottom - top));
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
        wgpuRenderPassEncoderDrawIndexed(
            layer_pass,
            draw.index_count,
            1,
            draw.first_index,
            0,
            0);
    }
    wgpuRenderPassEncoderEnd(layer_pass);
    wgpuRenderPassEncoderRelease(layer_pass);

    WGPURenderPassColorAttachment composite_attachment =
        WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
    composite_attachment.view = target;
    composite_attachment.loadOp = WGPULoadOp_Load;
    composite_attachment.storeOp = WGPUStoreOp_Store;
    WGPURenderPassDescriptor composite_descriptor =
        WGPU_RENDER_PASS_DESCRIPTOR_INIT;
    composite_descriptor.colorAttachmentCount = 1;
    composite_descriptor.colorAttachments = &composite_attachment;
    WGPURenderPassEncoder composite_pass =
        wgpuCommandEncoderBeginRenderPass(encoder, &composite_descriptor);
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
    wgpuRenderPassEncoderDrawIndexed(
        composite_pass,
        6,
        1,
        composite_first_index,
        0,
        0);
    wgpuRenderPassEncoderEnd(composite_pass);
    wgpuRenderPassEncoderRelease(composite_pass);
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
    WGPUTexture texture =
        wgpuDeviceCreateTexture(state.device, &descriptor);
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
    return texture;
}

// The pinned mip generator's fullscreen-triangle bilinear blit
// (src/texture/generate-mipmaps.ts BLIT_SHADER) is deployed from
// generation like every other pinned shader — mip-blit.vert/.frag —
// instead of living here as a C++ string invisible to shader provenance.
WGPURenderPipeline mip_pipeline_for(
    DawnState& state,
    WGPUTextureFormat format) {
    const auto existing = state.mip_pipelines.find(format);
    if (existing != state.mip_pipelines.end()) return existing->second;
    if (!state.mip_vertex_module) {
        state.mip_vertex_module =
            load_wgsl_module(state, "mip-blit.vert");
        state.mip_fragment_module =
            load_wgsl_module(state, "mip-blit.frag");
        // The pinned generator samples with the bilinear sampler:
        // linear filters and WebGPU-default clamp addressing.
        WGPUSamplerDescriptor sampler_descriptor =
            WGPU_SAMPLER_DESCRIPTOR_INIT;
        sampler_descriptor.magFilter = WGPUFilterMode_Linear;
        sampler_descriptor.minFilter = WGPUFilterMode_Linear;
        state.mip_sampler =
            wgpuDeviceCreateSampler(state.device, &sampler_descriptor);
    }
    WGPURenderPipelineDescriptor descriptor =
        WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    descriptor.vertex.module = state.mip_vertex_module;
    descriptor.vertex.entryPoint = string_view("mainVertex");
    descriptor.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    WGPUColorTargetState color_target = WGPU_COLOR_TARGET_STATE_INIT;
    color_target.format = format;
    WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
    fragment.module = state.mip_fragment_module;
    fragment.entryPoint = string_view("mainFragment");
    fragment.targetCount = 1;
    fragment.targets = &color_target;
    descriptor.fragment = &fragment;
    WGPURenderPipeline pipeline =
        wgpuDeviceCreateRenderPipeline(state.device, &descriptor);
    if (!pipeline) dawn_error("mip blit pipeline creation failed.");
    state.mip_pipelines[format] = pipeline;
    return pipeline;
}

// The pinned generator blits one face at a time for cube textures
// (recordMipmaps' optional layer): views become single-layer 2D. The
// record variant encodes into a caller-owned encoder (the pinned
// recordMipmaps) so mid-frame chains stay ordered with the frame.
void record_mipmaps(
    DawnState& state,
    WGPUCommandEncoder encoder,
    WGPUTexture texture,
    WGPUTextureFormat format,
    std::uint32_t mip_count,
    std::int32_t face = -1) {
    if (mip_count <= 1) return;
    WGPURenderPipeline pipeline = mip_pipeline_for(state, format);
    WGPUBindGroupLayout layout =
        wgpuRenderPipelineGetBindGroupLayout(pipeline, 0);
    for (std::uint32_t level = 1; level < mip_count; ++level) {
        WGPUTextureViewDescriptor source_descriptor =
            WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
        source_descriptor.baseMipLevel = level - 1;
        source_descriptor.mipLevelCount = 1;
        WGPUTextureViewDescriptor target_descriptor =
            WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
        target_descriptor.baseMipLevel = level;
        target_descriptor.mipLevelCount = 1;
        if (face >= 0) {
            source_descriptor.dimension = WGPUTextureViewDimension_2D;
            source_descriptor.baseArrayLayer =
                static_cast<std::uint32_t>(face);
            source_descriptor.arrayLayerCount = 1;
            target_descriptor.dimension = WGPUTextureViewDimension_2D;
            target_descriptor.baseArrayLayer =
                static_cast<std::uint32_t>(face);
            target_descriptor.arrayLayerCount = 1;
        }
        WGPUTextureView source =
            wgpuTextureCreateView(texture, &source_descriptor);
        WGPUTextureView target =
            wgpuTextureCreateView(texture, &target_descriptor);

        std::array<WGPUBindGroupEntry, 2> entries{};
        entries[0] = WGPU_BIND_GROUP_ENTRY_INIT;
        entries[0].binding = 0;
        entries[0].textureView = source;
        entries[1] = WGPU_BIND_GROUP_ENTRY_INIT;
        entries[1].binding = 1;
        entries[1].sampler = state.mip_sampler;
        WGPUBindGroupDescriptor bind_descriptor =
            WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        bind_descriptor.layout = layout;
        bind_descriptor.entryCount = entries.size();
        bind_descriptor.entries = entries.data();
        WGPUBindGroup bind_group =
            wgpuDeviceCreateBindGroup(state.device, &bind_descriptor);

        WGPURenderPassColorAttachment color_attachment =
            WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
        color_attachment.view = target;
        color_attachment.loadOp = WGPULoadOp_Clear;
        color_attachment.storeOp = WGPUStoreOp_Store;
        WGPURenderPassDescriptor pass_descriptor =
            WGPU_RENDER_PASS_DESCRIPTOR_INIT;
        pass_descriptor.colorAttachmentCount = 1;
        pass_descriptor.colorAttachments = &color_attachment;
        WGPURenderPassEncoder pass =
            wgpuCommandEncoderBeginRenderPass(encoder, &pass_descriptor);
        wgpuRenderPassEncoderSetPipeline(pass, pipeline);
        wgpuRenderPassEncoderSetBindGroup(pass, 0, bind_group, 0, nullptr);
        wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0);
        wgpuRenderPassEncoderEnd(pass);
        wgpuRenderPassEncoderRelease(pass);
        wgpuBindGroupRelease(bind_group);
        wgpuTextureViewRelease(target);
        wgpuTextureViewRelease(source);
    }
    wgpuBindGroupLayoutRelease(layout);
}

void generate_mipmaps(
    DawnState& state,
    WGPUTexture texture,
    WGPUTextureFormat format,
    std::uint32_t mip_count,
    std::int32_t face = -1) {
    if (mip_count <= 1) return;
    WGPUCommandEncoder encoder =
        wgpuDeviceCreateCommandEncoder(state.device, nullptr);
    record_mipmaps(state, encoder, texture, format, mip_count, face);
    WGPUCommandBuffer command = wgpuCommandEncoderFinish(encoder, nullptr);
    wgpuQueueSubmit(state.queue, 1, &command);
    wgpuCommandBufferRelease(command);
    wgpuCommandEncoderRelease(encoder);
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
    WGPUTexture texture =
        wgpuDeviceCreateTexture(state.device, &descriptor);
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
    return texture;
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
    WGPUTexture texture =
        wgpuDeviceCreateTexture(state.device, &descriptor);
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
    return texture;
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
                ts::ArrayBuffer(texture_data[index].bytes));
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
    WGPUTexture texture =
        wgpuDeviceCreateTexture(state.device, &descriptor);
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
    return texture;
}

// create_texture_sampler moved to pal_dawn_shared.hpp so the sprite pass
// derives its atlas sampler from the record the same way (it used to
// hardcode a descriptor beside this translation).

// Upload the environment cubemap exactly as the browser does: rgba16f
// faces with pre-baked mips, uploaded unflipped (the SDL_GPU vertical
// reversal is an SDL-only adaptation).
void upload_environment(DawnState& state, const EnvironmentState& environment) {
    const bool has_environment =
        environment.specular_width != 0 &&
        environment.specular_mip_count != 0 &&
        environment.specular_faces.size() >=
            static_cast<std::size_t>(environment.specular_mip_count) * 6;
    if (!has_environment) return;
    const std::uint32_t width = environment.specular_width;
    const std::uint32_t mip_count = environment.specular_mip_count;
    WGPUTextureDescriptor descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
    descriptor.usage =
        WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
    descriptor.size = {width, width, 6};
    descriptor.format = WGPUTextureFormat_RGBA16Float;
    descriptor.mipLevelCount = mip_count;
    WGPUTexture texture =
        wgpuDeviceCreateTexture(state.device, &descriptor);
    if (!texture) dawn_error("wgpuDeviceCreateTexture environment");
    for (std::uint32_t mip = 0; mip < mip_count; ++mip) {
        const std::uint32_t mip_width = std::max(width >> mip, 1u);
        for (std::uint32_t face = 0; face < 6; ++face) {
            const TextureData& face_data =
                environment.specular_faces[
                    static_cast<std::size_t>(mip) * 6 + face];
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
        wgpuTextureCreateView(texture, &view_descriptor);
}

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
        if (environment.brdf_lut.bytes.empty()) return;
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
    state.brdf_view = wgpuTextureCreateView(texture, nullptr);
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
        case TextureFormatClass::r16_float:
            return WGPUTextureFormat_R16Float;
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
    WGPUTextureUsage usage) {
    WGPUTextureDescriptor descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
    descriptor.usage = usage;
    descriptor.size = {width, height, 1};
    descriptor.format = format;
    descriptor.sampleCount = samples;
    WGPUTexture texture =
        wgpuDeviceCreateTexture(state.device, &descriptor);
    if (!texture) dawn_error("wgpuDeviceCreateTexture frame graph");
    return texture;
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
        state.frame_graph_height == height) {
        return;
    }
    state.release_frame_graph_textures();
    state.frame_graph_width = width;
    state.frame_graph_height = height;
    state.render_targets.resize(engine.render_targets.size());
    for (
        std::size_t index = 0;
        index < engine.render_targets.size();
        ++index) {
        const RenderTargetRecord& record = engine.render_targets[index];
        DawnRenderTarget& target = state.render_targets[index];
        target.width = record.width > 0 ? record.width : width;
        target.height = record.height > 0 ? record.height : height;
        // A composite's intermediate takes a fraction of whatever its
        // source resolved to. Creation order guarantees that source is
        // already sized: `create_render_target` refuses a forward reference.
        if (record.scale_source.value != invalid_handle) {
            const DawnRenderTarget& scale_source =
                state.render_targets[record.scale_source.value];
            target.width = scaled_target_extent(
                scale_source.width,
                record.width_ratio);
            target.height = scaled_target_extent(
                scale_source.height,
                record.height_ratio);
        }
        // The swapchain owns no texture here -- its view is acquired per
        // frame -- but a target that follows it still needs its format.
        if (record.swapchain) {
            target.color_format = state.surface_format;
            continue;
        }
        const std::uint32_t samples = task_sample_count(state, record.samples);
        // "The source's format" is what a composite's intermediate asks for
        // when it names none, so it resolves through the target it scales
        // from rather than falling back to the surface.
        const WGPUTextureFormat color_format =
            record.has_format
                ? texture_format(record.format)
                : record.scale_source.value != invalid_handle
                      ? state.render_targets[record.scale_source.value]
                            .color_format
                      : state.surface_format;
        target.color_format = color_format;
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
            target.color_view =
                wgpuTextureCreateView(target.color, nullptr);
            if (samples == 1) {
                target.sampled_color = target.color;
                target.sampled_color_view = target.color_view;
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
                target.sampled_color_view = wgpuTextureCreateView(
                    target.sampled_color,
                    nullptr);
            }
        }
        if (record.has_depth) {
            // A shadow map states its own format: the pinned generator
            // creates `depth32float` where the frame's own attachments take
            // the browser's depth24plus-stencil8.
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
                    : WGPUTextureUsage_RenderAttachment);
            target.depth_view =
                wgpuTextureCreateView(target.depth, nullptr);
            if (record.sampled_depth) {
                WGPUTextureViewDescriptor depth_view_descriptor =
                    WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
                depth_view_descriptor.aspect =
                    WGPUTextureAspect_DepthOnly;
                target.depth_sampled_view = wgpuTextureCreateView(
                    target.depth,
                    &depth_view_descriptor);
                // A shadow map is read through a comparison sampler on the
                // depth texture itself. Every other sampled depth is read
                // as a Standard emissive slot, which needs the r32float
                // copy so it decodes like SDL's D3D12 depth SRV.
                if (!record.shadow_map) {
                    target.depth_copy = create_frame_texture(
                        state,
                        WGPUTextureFormat_R32Float,
                        1,
                        target.width,
                        target.height,
                        WGPUTextureUsage_RenderAttachment |
                            WGPUTextureUsage_TextureBinding);
                    target.depth_copy_view =
                        wgpuTextureCreateView(target.depth_copy, nullptr);
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
        if (task.kind != FrameTaskKind::post_process) continue;
        if (
            state.post_process_tasks[index].size() <
            task.post_process.passes.size()) {
            state.post_process_tasks[index].resize(
                task.post_process.passes.size());
        }
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
            WGPUTexture color = create_frame_texture(
                state,
                format,
                samples,
                width,
                height,
                samples == 1
                    ? WGPUTextureUsage_RenderAttachment |
                        WGPUTextureUsage_TextureBinding
                    : WGPUTextureUsage_RenderAttachment);
            task.colors.push_back(color);
            task.color_views.push_back(
                wgpuTextureCreateView(color, nullptr));
            if (samples == 1) {
                task.sampled_colors.push_back(color);
                task.sampled_views.push_back(task.color_views.back());
            } else {
                WGPUTexture sampled = create_frame_texture(
                    state,
                    format,
                    1,
                    width,
                    height,
                    WGPUTextureUsage_RenderAttachment |
                        WGPUTextureUsage_TextureBinding);
                task.sampled_colors.push_back(sampled);
                task.sampled_views.push_back(
                    wgpuTextureCreateView(sampled, nullptr));
            }
        }
        task.depth = create_frame_texture(
            state,
            WGPUTextureFormat_Depth24PlusStencil8,
            samples,
            width,
            height,
            WGPUTextureUsage_RenderAttachment);
        task.depth_view = wgpuTextureCreateView(task.depth, nullptr);
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
        WGPUBuffer buffer = wgpuDeviceCreateBuffer(state.device, &descriptor);
        if (!buffer) dawn_error("pinned uniform buffer creation failed.");
        return buffer;
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
WGPUBindGroup pinned_frame_group_over(
    DawnState& state,
    WGPUBuffer& scene_uniforms,
    WGPUBindGroup& group,
    const char* what) {
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
    entries[1].buffer = state.pinned_lights_uniforms;
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
    DawnRenderTask& task) {
    return pinned_frame_group_over(
        state,
        task.pinned_scene_uniforms,
        task.pinned_frame_group,
        "render task frame");
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
    std::string_view name) {
    const upstream::MaterialTextureSlot* slot =
        material_slot_for_binding(name);
    if (slot != nullptr) {
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
    const std::uint32_t bones =
        static_cast<std::uint32_t>(record.bone_matrices.size());
    if (bones == 0) return;
    const BonePaletteLayout palette = bone_palette_layout(bones);
    if (mesh.pinned_bone_count != bones) {
        if (mesh.pinned_bone_view) {
            wgpuTextureViewRelease(mesh.pinned_bone_view);
        }
        if (mesh.pinned_bone_texture) {
            wgpuTextureRelease(mesh.pinned_bone_texture);
        }
        WGPUTextureDescriptor descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
        descriptor.dimension = WGPUTextureDimension_2D;
        descriptor.size = {palette.width, palette.height, 1};
        descriptor.format = WGPUTextureFormat_RGBA32Float;
        descriptor.usage =
            WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
        descriptor.mipLevelCount = 1;
        descriptor.sampleCount = 1;
        mesh.pinned_bone_texture =
            wgpuDeviceCreateTexture(state.device, &descriptor);
        if (!mesh.pinned_bone_texture) {
            dawn_error("pinned bone texture creation failed.");
        }
        mesh.pinned_bone_view =
            wgpuTextureCreateView(mesh.pinned_bone_texture, nullptr);
        mesh.pinned_bone_count = bones;
    }
    WGPUTexelCopyTextureInfo destination = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
    destination.texture = mesh.pinned_bone_texture;
    WGPUTexelCopyBufferLayout layout = WGPU_TEXEL_COPY_BUFFER_LAYOUT_INIT;
    layout.bytesPerRow = palette.bytes;
    layout.rowsPerImage = palette.height;
    WGPUExtent3D extent{palette.width, palette.height, 1};
    wgpuQueueWriteTexture(
        state.queue,
        &destination,
        record.bone_matrices.data(),
        palette.bytes,
        &layout,
        &extent);
}

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
            pinned_resource_for(state, mesh, binding.name);
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
    WGPUBindGroup group =
        wgpuDeviceCreateBindGroup(state.device, &descriptor);
    if (!group) {
        dawn_error("pinned variant draw bind group creation failed.");
    }
    return group;
}

/** The per-draw buffers and group-1 bind group for one material's variant. */
DawnDrawState& ensure_pinned_draw_bindings(
    DawnState& state,
    DawnMesh& mesh,
    std::uint32_t material,
    std::size_t variant,
    const MaterialRecord* record) {
    DawnDrawState& draw_state = mesh.pinned_states[material];
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
        WGPUBuffer buffer = wgpuDeviceCreateBuffer(state.device, &descriptor);
        if (!buffer) dawn_error("pinned draw buffer creation failed.");
        return buffer;
    };
    if (!draw_state.mesh_uniforms) {
        draw_state.mesh_uniforms =
            uniform_buffer(sizeof(upstream::MeshUniforms));
    }
    // Sized by the variant, so a swap to one with more fields reallocates.
    if (draw_state.material_uniforms) {
        wgpuBufferRelease(draw_state.material_uniforms);
    }
    draw_state.material_uniforms =
        uniform_buffer(entry.material_ubo_bytes);
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
    DawnDrawState draw_state{};
    const upstream::PbrVariantEntry& entry = upstream::pbr_variants[variant];
    const auto uniform_buffer = [&](std::size_t size) {
        WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
        descriptor.size = static_cast<std::uint64_t>(size);
        descriptor.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
        WGPUBuffer buffer = wgpuDeviceCreateBuffer(state.device, &descriptor);
        if (!buffer) dawn_error("pinned geometry buffer creation failed.");
        return buffer;
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
        .emplace(variant, draw_state)
        .first->second;
}

/**
 * The pin's two per-draw blocks for one resolved variant — the mesh block
 * (draw world + light selection) and the variant's own material UBO —
 * written to the caller's buffers. Shared by the main pass and the
 * geometry task, which differ only in the receiving buffers and in which
 * convention booleans the draw rides; both used to carry this sequence
 * verbatim.
 */
void write_pinned_draw_blocks(
    DawnState& state,
    const Scene& scene,
    const Engine& engine,
    const upstream::RenderDrawCommand& draw,
    std::size_t variant,
    bool skeleton_draw,
    bool world_from_palette,
    WGPUBuffer mesh_uniforms,
    WGPUBuffer material_uniforms) {
    const MeshRecord& record = engine.meshes[draw.item.mesh.value];
    const upstream::PbrVariantEntry& entry =
        upstream::pbr_variants[variant];
    const upstream::MeshUniforms mesh_block =
        pinned_mesh_block(
            scene,
            engine,
            pinned_draw_world(
                skeleton_draw,
                world_from_palette,
                entry.uses_local_position,
                record,
                scene,
                engine),
            draw.item.mesh.value);
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
        engine.materials[draw.item.material.value],
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
    const CameraRecord& camera,
    const std::array<float, 16>& geometry_matrix,
    const FrameTaskRecord& task,
    DawnGeometryTask& geometry,
    const upstream::RenderDrawLists& draw_lists) {
    if (!pinned_lists_have_pinned_draws(draw_lists)) return;
    write_pinned_geometry_prologue(
        state,
        scene,
        engine,
        camera,
        geometry,
        geometry_matrix);
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
            if (variant == std::numeric_limits<std::size_t>::max()) {
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
            // Geometry draws are never skinned or palette-driven in the
            // corpus; the chain still decides local-lane and instanced
            // worlds the same way the main pass does.
            write_pinned_draw_blocks(
                state,
                scene,
                engine,
                draw,
                variant,
                /*skeleton_draw=*/false,
                /*world_from_palette=*/false,
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
    wgpuRenderPassEncoderDrawIndexed(
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
        engine.render_targets[target_handle.value];
    DawnRenderTarget& target = state.render_targets[target_handle.value];
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
        view = wgpuTextureCreateView(texture, nullptr);
    };
    create_half(blur.blur_h, blur.blur_h_view);
    create_half(blur.blur_v, blur.blur_v_view);

    const std::string stem = "shadow-blur-" + std::to_string(esm_index);
    WGPUShaderModule vertex_module = load_wgsl_module(state, stem + ".vert");
    WGPUShaderModule fragment_module = load_wgsl_module(state, stem + ".frag");
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
    wgpuShaderModuleRelease(vertex_module);
    wgpuShaderModuleRelease(fragment_module);

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
        WGPURenderPassEncoder render =
            wgpuCommandEncoderBeginRenderPass(encoder, &descriptor);
        wgpuRenderPassEncoderSetPipeline(render, blur.pipeline);
        wgpuRenderPassEncoderSetBindGroup(render, 0, group, 0, nullptr);
        wgpuRenderPassEncoderDraw(render, 3, 1, 0, 0);
        wgpuRenderPassEncoderEnd(render);
        wgpuRenderPassEncoderRelease(render);
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
        engine.shadow_generators[handle.value];
    if (
        generator.task.value >= engine.frame_tasks.size() ||
        engine.frame_tasks[generator.task.value].render.target.value >=
            state.render_targets.size()) {
        dawn_error("a shadow generator has no rendered map.");
    }
    const DawnRenderTarget& map = state.render_targets[
        engine.frame_tasks[generator.task.value].render.target.value];
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
            entry.buffer = state.shadow_uniforms[handle.value];
            entry.size = sizeof(upstream::ShadowInfoUniforms);
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
 * `renderPcfShadowMap` recomputes the light matrix when the light moved and
 * re-uploads the receiver UBO with it; the caster pass then renders through
 * the biased copy. Nothing here decides when — the record's own values are
 * rebuilt each frame, which is the same result for a static light and the
 * right one for a moving one.
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
            const upstream::ShadowInfoUniforms& block,
            bool moved) {
#if BBLITE_SHADOWS_ESM
            // `shadow_params_block` reads what the factory fixed -- bias,
            // depth scale, texel size -- so it is built once and outlives
            // every refresh.
            if (generator.filter == ShadowFilter::esm_directional &&
                !state.shadow_params[handle.value]) {
                const std::array<float, 8> params =
                    upstream::shadow_params_block(generator);
                state.shadow_params[handle.value] = create_buffer(
                    state,
                    WGPUBufferUsage_Uniform,
                    params.data(),
                    params.size() * sizeof(float));
            }
#endif
            if (!state.shadow_uniforms[handle.value]) {
                state.shadow_uniforms[handle.value] = create_buffer(
                    state,
                    WGPUBufferUsage_Uniform,
                    &block,
                    sizeof(block));
            } else if (moved) {
                wgpuQueueWriteBuffer(
                    state.queue,
                    state.shadow_uniforms[handle.value],
                    0,
                    &block,
                    sizeof(block));
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
            dawn_error(
                ("standard variant declares an unmapped resource '" +
                 std::string(binding.name) + "'.")
                    .c_str());
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
    WGPUBindGroup group =
        wgpuDeviceCreateBindGroup(state.device, &descriptor);
    if (!group) {
        dawn_error("standard variant draw bind group creation failed.");
    }
    return group;
}

/** The per-draw uniform buffers for a mesh's Standard draws. */
DawnDrawState& ensure_standard_draw_buffers(
    DawnState& state,
    DawnMesh& mesh,
    std::uint32_t material) {
    DawnDrawState& draw_state =
        mesh.standard_states[material];
    const auto uniform_buffer = [&](std::size_t size) {
        WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
        descriptor.size = static_cast<std::uint64_t>(size);
        descriptor.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
        WGPUBuffer buffer = wgpuDeviceCreateBuffer(state.device, &descriptor);
        if (!buffer) dawn_error("standard draw buffer creation failed.");
        return buffer;
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
    const MeshRecord& record = engine.meshes[draw.item.mesh.value];
    const MaterialRecord* material =
        draw.item.material.value < engine.materials.size()
            ? &engine.materials[draw.item.material.value]
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
void write_standard_geometry_task(
    DawnState& state,
    const Scene& scene,
    const Engine& engine,
    const CameraRecord& camera,
    const std::array<float, 16>& geometry_matrix,
    const FrameTaskRecord& task,
    DawnGeometryTask& geometry,
    const upstream::RenderDrawLists& draw_lists) {
    if (!pinned_lists_have_pinned_draws(draw_lists)) return;
#if BBLITE_PBR_VARIANTS == 0
    // With no PBR family compiled, `write_pinned_geometry_task` does not
    // exist, so this side owns the frame prologue it would have run.
    write_pinned_geometry_prologue(
        state,
        scene,
        engine,
        camera,
        geometry,
        geometry_matrix);
#else
    // The PBR write ran first at the shared call site and owns the
    // prologue; only the Standard draws are resolved here.
    (void)camera;
    (void)geometry_matrix;
#endif
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
            if (variant == std::numeric_limits<std::size_t>::max()) {
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
            const MaterialRecord* material =
                draw.item.material.value < engine.materials.size()
                    ? &engine.materials[draw.item.material.value]
                    : nullptr;
            DawnDrawState& colour_state =
                ensure_standard_draw_buffers(
                    state,
                    mesh,
                    draw.item.material.value);
            DawnDrawState& draw_state =
                mesh.standard_geometry_states[variant];
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

DawnPipeline& pipeline_for(
    DawnState& state,
    upstream::RenderPipelineKind kind,
    std::uint32_t shader_variant = 0,
    /** Zero asks for the frame's own sample count. */
    std::uint32_t requested_samples = 0,
    bool has_depth = true) {
    // The main set is whatever matches the frame; a render-task target
    // that differs gets its own. Written as "matches the frame" rather
    // than "is 4x" so a single-sample run keeps one main set instead of
    // filing every pipeline under the task buckets.
    const std::uint32_t samples = requested_samples == 0
        ? state.sample_count
        : requested_samples;
    const bool frame_samples = samples == state.sample_count;
    auto& pipeline_map = frame_samples && has_depth
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
            state.shader_fragment_modules[shader_variant] =
                load_wgsl_module(
                    state,
                    (base_name + ".frag").c_str());
        }
    }
    WGPURenderPipelineDescriptor descriptor =
        WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    descriptor.layout = mesh_pipeline_layout_for(state);
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
    depth_stencil.format = WGPUTextureFormat_Depth24PlusStencil8;
    depth_stencil.depthWriteEnabled = depth_write_off
        ? WGPUOptionalBool_False
        : WGPUOptionalBool_True;
    depth_stencil.depthCompare =
        dawn_depth_compare(upstream::pinned_depth_compare);
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
        blend = blend_state_from(transparent_blend);
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
    descriptor.fragment = &fragment;

    WGPURenderPipeline pipeline =
        wgpuDeviceCreateRenderPipeline(state.device, &descriptor);
    if (!pipeline) dawn_error("wgpuDeviceCreateRenderPipeline");
    DawnPipeline& slot = pipeline_map[pipeline_key];
    slot.pipeline = pipeline;
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
    VariantVertexAttributes& inputs) {
    const PinnedVertexInput input =
        pinned_vertex_input(name, uses_local_position);
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
    // A geometry-output MRT variant draws into its task's own attachments:
    // one target per attachment in the shared class list plus the
    // optional trailing colour, with depth writes forced on. The list and
    // its count assertion come from `geometry_target_classes`; only the
    // API structs are built here.
    std::vector<WGPUColorTargetState> geometry_targets;
    if (geometry_task) {
        const GeometryTargetClasses classes =
            geometry_target_classes(*geometry_task);
        require_geometry_target_count(
            classes,
            entry.color_target_count,
            "pinned");
        geometry_targets.reserve(classes.attachments.size() + 1u);
        for (const TextureFormatClass format_class : classes.attachments) {
            WGPUColorTargetState target = WGPU_COLOR_TARGET_STATE_INIT;
            target.format = texture_format(format_class);
            if (traits.transparent) target.blend = &blend;
            geometry_targets.push_back(target);
        }
        if (classes.trailing_output) {
            WGPUColorTargetState target = WGPU_COLOR_TARGET_STATE_INIT;
            target.format = state.frame_color_format;
            if (traits.transparent) target.blend = &blend;
            geometry_targets.push_back(target);
        }
        fragment.targetCount = geometry_targets.size();
        fragment.targets = geometry_targets.data();
        depth_stencil.depthWriteEnabled = WGPUOptionalBool_True;
    }
    descriptor.fragment = &fragment;
    WGPURenderPipeline pipeline =
        wgpuDeviceCreateRenderPipeline(state.device, &descriptor);
    if (!pipeline) dawn_error("pinned variant pipeline creation failed.");
    return map.emplace(key, pipeline).first->second;
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
    // The Standard sibling of the pinned MRT assembly above, over the
    // same shared class list and count assertion.
    std::vector<WGPUColorTargetState> geometry_targets;
    if (geometry_task) {
        const GeometryTargetClasses classes =
            geometry_target_classes(*geometry_task);
        require_geometry_target_count(
            classes,
            entry.color_target_count,
            "standard");
        geometry_targets.reserve(classes.attachments.size() + 1u);
        for (const TextureFormatClass format_class : classes.attachments) {
            WGPUColorTargetState target = WGPU_COLOR_TARGET_STATE_INIT;
            target.format = texture_format(format_class);
            if (traits.transparent) target.blend = &blend;
            geometry_targets.push_back(target);
        }
        if (classes.trailing_output) {
            WGPUColorTargetState target = WGPU_COLOR_TARGET_STATE_INIT;
            target.format = state.frame_color_format;
            if (traits.transparent) target.blend = &blend;
            geometry_targets.push_back(target);
        }
        fragment.targetCount = geometry_targets.size();
        fragment.targets = geometry_targets.data();
        depth_stencil.depthWriteEnabled = WGPUOptionalBool_True;
    }
    descriptor.fragment = &fragment;
    WGPURenderPipeline pipeline =
        wgpuDeviceCreateRenderPipeline(state.device, &descriptor);
    if (!pipeline) dawn_error("standard variant pipeline creation failed.");
    return map.emplace(key, pipeline).first->second;
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
    bool caster) {
    const std::size_t slot = pal::node_variant_slot(variant, caster);
    if (state.node_draw_layouts.size() < pal::node_variant_slots()) {
        state.node_draw_layouts.resize(pal::node_variant_slots(), nullptr);
    }
    if (state.node_draw_layouts[slot]) {
        return state.node_draw_layouts[slot];
    }
    const upstream::NodeVariantEntry& entry =
        upstream::node_variants[variant];
    std::vector<WGPUBindGroupLayoutEntry> entries;
    WGPUBindGroupLayoutEntry mesh_entry = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
    mesh_entry.binding = 0;
    mesh_entry.visibility =
        WGPUShaderStage_Vertex | WGPUShaderStage_Fragment;
    mesh_entry.buffer.type = WGPUBufferBindingType_Uniform;
    entries.push_back(mesh_entry);
    if (upstream::has_node_ubo(entry)) {
        WGPUBindGroupLayoutEntry node_entry =
            WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
        node_entry.binding =
            static_cast<std::uint32_t>(entry.ubo_binding);
        node_entry.visibility =
            WGPUShaderStage_Vertex | WGPUShaderStage_Fragment;
        node_entry.buffer.type = WGPUBufferBindingType_Uniform;
        entries.push_back(node_entry);
    }
    // The graph's own `TextureBlock`/`ImageSourceBlock` pairs, at the
    // bindings the pin's pipeline builder allocated and with the visibility
    // its own BGL entry carries -- a UV chain can put the sample in either
    // stage, so the pin declares both and so does this.
    for (std::size_t index = 0; index < entry.texture_count; ++index) {
        const upstream::NodeVariantTexture& binding =
            upstream::node_variant_textures[entry.first_texture + index];
        WGPUBindGroupLayoutEntry view = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
        view.binding = binding.texture;
        view.visibility =
            WGPUShaderStage_Vertex | WGPUShaderStage_Fragment;
        view.texture.sampleType = WGPUTextureSampleType_Float;
        view.texture.viewDimension = WGPUTextureViewDimension_2D;
        entries.push_back(view);
        WGPUBindGroupLayoutEntry sampler = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
        sampler.binding = binding.sampler;
        sampler.visibility =
            WGPUShaderStage_Vertex | WGPUShaderStage_Fragment;
        sampler.sampler.type = WGPUSamplerBindingType_Filtering;
        entries.push_back(sampler);
    }
    if (entry.morph.present) {
        const auto storage = [&](std::uint32_t binding) {
            WGPUBindGroupLayoutEntry item =
                WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
            item.binding = binding;
            item.visibility = WGPUShaderStage_Vertex;
            item.buffer.type = WGPUBufferBindingType_ReadOnlyStorage;
            entries.push_back(item);
        };
        storage(entry.morph.deltas_binding);
        storage(entry.morph.weights_binding);
    }
    if (entry.env.present) {
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
        texture(entry.env.ibl_texture, WGPUTextureViewDimension_Cube);
        sampler(entry.env.ibl_sampler);
        texture(entry.env.brdf_lut, WGPUTextureViewDimension_2D);
        sampler(entry.env.brdf_sampler);
    }
#if BBLITE_NODE_SHADOWS
    if (caster) {
#if BBLITE_SHADOWS_ESM
        if (entry.caster.esm) {
            // The ESM caster adds one row; the PCF no-colour compile adds
            // none and keeps only the graph's shared bindings above.
            WGPUBindGroupLayoutEntry params = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
            params.binding = entry.caster.params_binding;
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
             pal::node_shadow_rows(entry)) {
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
    bool caster) {
    const std::size_t slot = pal::node_variant_slot(variant, caster);
    if (state.node_pipeline_layouts.size() < pal::node_variant_slots()) {
        state.node_pipeline_layouts.resize(pal::node_variant_slots(), nullptr);
    }
    if (state.node_pipeline_layouts[slot]) {
        return state.node_pipeline_layouts[slot];
    }
    std::array<WGPUBindGroupLayout, 2> groups{
        pinned_frame_layout_for(state),
        node_draw_layout_for(state, variant, caster),
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
    std::uint32_t esm_shadow_index = invalid_handle) {
    const std::size_t slot = pal::node_variant_slot(variant, caster);
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
    const upstream::NodeVariantEntry& entry =
        upstream::node_variants[variant];
    if (!state.node_vertex_modules[slot]) {
        const upstream::NodeVariantStems stems =
            pal::node_variant_stems(slot);
        state.node_vertex_modules[slot] =
            load_wgsl_module(state, std::string(stems.vertex).c_str());
        state.node_fragment_modules[slot] = load_wgsl_module(
            state,
            std::string(stems.fragment).c_str());
    }
    VariantVertexAttributes inputs;
    // A node graph declaring the thin-instance columns would need a second
    // stream this pipeline does not bind, so the shared table's own marking
    // is what refuses it.
    inputs.vertex.reserve(entry.attribute_count);
    for (std::size_t index = 0; index < entry.attribute_count; ++index) {
        const upstream::NodeVariantAttribute& input =
            upstream::node_variant_attributes[entry.first_attribute + index];
        if (
            !append_variant_attribute(
                input.name,
                input.location,
                false,
                inputs)) {
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
    descriptor.layout = node_pipeline_layout_for(state, variant, caster);
    descriptor.vertex.module = state.node_vertex_modules[slot];
    descriptor.vertex.entryPoint = string_view("vs_main");
    descriptor.vertex.bufferCount = 1;
    descriptor.vertex.buffers = &vertex_layout;
    descriptor.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    descriptor.primitive.frontFace = WGPUFrontFace_CCW;
    const RenderPipelineKindTraits traits = pipeline_kind_traits(kind);
    const bool transparent = traits.transparent && !shadow_pass && !caster;
    // The graph's culling and alpha-combine state, decoded through the same
    // shared kind table as the other families. Shadow views force the pin's
    // alpha mode 0 and therefore keep depth writes and no colour blending.
    descriptor.primitive.cullMode =
        dawn_cull_mode(traits.cull);
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
    const bool pcf_caster = caster && !entry.caster.esm;
    fragment.targetCount = pcf_caster ? 0 : 1;
    fragment.targets = pcf_caster ? nullptr : &color_target;
    descriptor.fragment = &fragment;
    WGPURenderPipeline pipeline =
        wgpuDeviceCreateRenderPipeline(state.device, &descriptor);
    if (!pipeline) dawn_error("node variant pipeline creation failed.");
    return map.emplace(key, pipeline).first->second;
}

/** The per-draw buffers a node graph needs, created once per mesh. */
DawnDrawState& ensure_node_draw_buffers(
    DawnState& state,
    DawnMesh& mesh,
    std::uint32_t material,
    const upstream::NodeVariantEntry& entry) {
    DawnDrawState& draw_state = mesh.node_states[material];
    const auto uniform_buffer = [&](std::uint64_t size) {
        WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
        descriptor.size = size;
        descriptor.usage =
            WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
        WGPUBuffer buffer =
            wgpuDeviceCreateBuffer(state.device, &descriptor);
        if (!buffer) dawn_error("node uniform buffer creation failed.");
        return buffer;
    };
    if (!draw_state.mesh_uniforms) {
        draw_state.mesh_uniforms =
            uniform_buffer(sizeof(upstream::NodeMeshUniforms));
    }
    if (!draw_state.material_uniforms && upstream::has_node_ubo(entry)) {
        draw_state.material_uniforms =
            uniform_buffer(static_cast<std::uint64_t>(entry.ubo_bytes));
        // The constants the graph declared, written with the buffer that
        // holds them: nothing a reached scene does changes them.
        wgpuQueueWriteBuffer(
            state.queue,
            draw_state.material_uniforms,
            0,
            &upstream::node_variant_uniform_floats[
                entry.first_uniform_float],
            entry.ubo_bytes);
    }
    return draw_state;
}

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
    [[maybe_unused]] const MaterialRecord* material = nullptr) {
    const upstream::NodeVariantEntry& entry =
        upstream::node_variants[variant];
    std::vector<WGPUBindGroupEntry> entries;
    WGPUBindGroupEntry mesh_entry = WGPU_BIND_GROUP_ENTRY_INIT;
    mesh_entry.binding = 0;
    mesh_entry.buffer = draw_state.mesh_uniforms;
    mesh_entry.size = sizeof(upstream::NodeMeshUniforms);
    entries.push_back(mesh_entry);
    if (upstream::has_node_ubo(entry)) {
        WGPUBindGroupEntry node_entry = WGPU_BIND_GROUP_ENTRY_INIT;
        node_entry.binding =
            static_cast<std::uint32_t>(entry.ubo_binding);
        node_entry.buffer = draw_state.material_uniforms;
        node_entry.size = static_cast<std::uint64_t>(entry.ubo_bytes);
        entries.push_back(node_entry);
    }
    // The images the scene supplied, uploaded with the mesh: the variant
    // table's order is the pin's allocation order, and the material's slots
    // were filled in that same order by `create_node_material`.
    const auto& shader_textures = mesh_shader_textures(mesh);
    for (std::size_t index = 0; index < entry.texture_count; ++index) {
        const upstream::NodeVariantTexture& binding =
            upstream::node_variant_textures[entry.first_texture + index];
        if (index >= shader_textures.size()) {
            dawn_error(
                "a node graph declares more textures than its material "
                "carries.");
        }
        const DawnSampledTexture& supplied = shader_textures[index];
        WGPUBindGroupEntry view = WGPU_BIND_GROUP_ENTRY_INIT;
        view.binding = binding.texture;
        view.textureView = supplied.view;
        entries.push_back(view);
        WGPUBindGroupEntry sampler = WGPU_BIND_GROUP_ENTRY_INIT;
        sampler.binding = binding.sampler;
        sampler.sampler = supplied.sampler;
        entries.push_back(sampler);
    }
    if (entry.morph.present) {
#if BBLITE_GPU_MORPH_STORAGE
        WGPUBindGroupEntry deltas = WGPU_BIND_GROUP_ENTRY_INIT;
        deltas.binding = entry.morph.deltas_binding;
        deltas.buffer = mesh.morph_deltas;
        deltas.size = WGPU_WHOLE_SIZE;
        entries.push_back(deltas);
        WGPUBindGroupEntry weights = WGPU_BIND_GROUP_ENTRY_INIT;
        weights.binding = entry.morph.weights_binding;
        weights.buffer = mesh.morph_weights;
        weights.size = WGPU_WHOLE_SIZE;
        entries.push_back(weights);
#else
        dawn_error(
            "a node graph declares morph storage in a build without "
            "mesh morph buffers.");
#endif
    }
    if (entry.env.present) {
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
            WGPUBindGroupEntry view = WGPU_BIND_GROUP_ENTRY_INIT;
            view.binding = texture_binding;
            view.textureView = resource.view;
            entries.push_back(view);
            WGPUBindGroupEntry item = WGPU_BIND_GROUP_ENTRY_INIT;
            item.binding = sampler_binding;
            item.sampler = resource.sampler;
            entries.push_back(item);
        };
        pair(
            entry.env.ibl_texture,
            entry.env.ibl_sampler,
            upstream::MaterialTextureSource::environment_cube);
        pair(
            entry.env.brdf_lut,
            entry.env.brdf_sampler,
            upstream::MaterialTextureSource::brdf_lut);
    }
#if BBLITE_NODE_SHADOWS
    if (caster) {
#if BBLITE_SHADOWS_ESM
        if (entry.caster.esm) {
            // PCF's NODE_NO_COLOR_OUTPUT module adds no caster-only row.
            WGPUBindGroupEntry params = WGPU_BIND_GROUP_ENTRY_INIT;
            params.binding = entry.caster.params_binding;
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
    } else if (entry.shadow_binding_count > 0) {
        // The receiver's rows, in the GRAPH's own group 1 -- whether a
        // given mesh receives is the `meshU.receivesShadow` lane, not a
        // selection, so every draw of this graph binds them.
        ensure_shadow_samplers(state);
        const std::vector<ShadowGeneratorHandle> generators =
            shadow_generators_in_light_order(scene, engine);
        for (const upstream::PinnedShadowBinding& row :
             pal::node_shadow_rows(entry)) {
            entries.push_back(
                shadow_group_entry(state, engine, generators, row));
        }
    }
#endif
    WGPUBindGroupDescriptor descriptor = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    descriptor.layout = node_draw_layout_for(state, variant, caster);
    descriptor.entryCount = entries.size();
    descriptor.entries = entries.data();
    WGPUBindGroup group =
        wgpuDeviceCreateBindGroup(state.device, &descriptor);
    if (!group) dawn_error("node variant bind group creation failed.");
    return group;
}

/**
 * The one block a node draw rebuilds: the pin's own `MeshU`, carrying the
 * world matrix the vertex stage multiplies by and the shadow and light lanes
 * a graph reaching neither leaves at zero. The uniform block the graph
 * declared is a constant, so `ensure_node_draw_buffers` writes it once.
 */
void write_node_mesh_block(
    DawnState& state,
    const Scene& scene,
    const Engine& engine,
    const upstream::RenderDrawCommand& draw,
    const DawnDrawState& draw_state) {
    const upstream::NodeMeshUniforms block =
        node_mesh_block(scene, engine, draw.item.mesh.value);
    wgpuQueueWriteBuffer(
        state.queue,
        draw_state.mesh_uniforms,
        0,
        &block,
        sizeof(block));
}
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
    WGPUBindGroupLayout layout = wgpuRenderPipelineGetBindGroupLayout(
        state.transmission_grab_pipeline,
        0);
    WGPUBindGroupEntry entry = WGPU_BIND_GROUP_ENTRY_INIT;
    entry.binding = 0;
    entry.textureView = state.msaa_color_view;
    WGPUBindGroupDescriptor bind_descriptor =
        WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    bind_descriptor.layout = layout;
    bind_descriptor.entryCount = 1;
    bind_descriptor.entries = &entry;
    WGPUBindGroup bind_group =
        wgpuDeviceCreateBindGroup(state.device, &bind_descriptor);
    wgpuBindGroupLayoutRelease(layout);
    WGPUTextureViewDescriptor level_descriptor =
        WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
    level_descriptor.baseMipLevel = 0;
    level_descriptor.mipLevelCount = 1;
    WGPUTextureView level_view = wgpuTextureCreateView(
        state.transmission_color,
        &level_descriptor);
    WGPURenderPassColorAttachment color_attachment =
        WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
    color_attachment.view = level_view;
    color_attachment.loadOp = WGPULoadOp_Clear;
    color_attachment.storeOp = WGPUStoreOp_Store;
    WGPURenderPassDescriptor pass_descriptor =
        WGPU_RENDER_PASS_DESCRIPTOR_INIT;
    pass_descriptor.colorAttachmentCount = 1;
    pass_descriptor.colorAttachments = &color_attachment;
    WGPURenderPassEncoder pass =
        wgpuCommandEncoderBeginRenderPass(encoder, &pass_descriptor);
    wgpuRenderPassEncoderSetPipeline(
        pass,
        state.transmission_grab_pipeline);
    wgpuRenderPassEncoderSetBindGroup(pass, 0, bind_group, 0, nullptr);
    wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0);
    wgpuRenderPassEncoderEnd(pass);
    wgpuRenderPassEncoderRelease(pass);
    wgpuBindGroupRelease(bind_group);
    wgpuTextureViewRelease(level_view);
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
        WGPUBindGroupLayout layout =
            wgpuRenderPipelineGetBindGroupLayout(
                state.image_processing_pipeline,
                0);
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
        wgpuBindGroupLayoutRelease(layout);
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
    WGPURenderPassEncoder pass =
        wgpuCommandEncoderBeginRenderPass(encoder, &pass_descriptor);
    wgpuRenderPassEncoderSetPipeline(
        pass,
        state.image_processing_pipeline);
    wgpuRenderPassEncoderSetBindGroup(
        pass,
        0,
        state.image_processing_group,
        0,
        nullptr);
    wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0);
    wgpuRenderPassEncoderEnd(pass);
    wgpuRenderPassEncoderRelease(pass);
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
    WGPUBindGroupLayout layout = wgpuRenderPipelineGetBindGroupLayout(
        state.depth_copy_pipeline,
        0);
    WGPUBindGroupEntry entry = WGPU_BIND_GROUP_ENTRY_INIT;
    entry.binding = 0;
    entry.textureView = target.depth_sampled_view;
    WGPUBindGroupDescriptor bind_descriptor =
        WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    bind_descriptor.layout = layout;
    bind_descriptor.entryCount = 1;
    bind_descriptor.entries = &entry;
    WGPUBindGroup bind_group =
        wgpuDeviceCreateBindGroup(state.device, &bind_descriptor);
    wgpuBindGroupLayoutRelease(layout);
    WGPURenderPassColorAttachment color_attachment =
        WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
    color_attachment.view = target.depth_copy_view;
    color_attachment.loadOp = WGPULoadOp_Clear;
    color_attachment.storeOp = WGPUStoreOp_Store;
    WGPURenderPassDescriptor pass_descriptor =
        WGPU_RENDER_PASS_DESCRIPTOR_INIT;
    pass_descriptor.colorAttachmentCount = 1;
    pass_descriptor.colorAttachments = &color_attachment;
    WGPURenderPassEncoder pass =
        wgpuCommandEncoderBeginRenderPass(encoder, &pass_descriptor);
    wgpuRenderPassEncoderSetPipeline(pass, state.depth_copy_pipeline);
    wgpuRenderPassEncoderSetBindGroup(pass, 0, bind_group, 0, nullptr);
    wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0);
    wgpuRenderPassEncoderEnd(pass);
    wgpuRenderPassEncoderRelease(pass);
    wgpuBindGroupRelease(bind_group);
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
    WGPURenderPipeline pipeline =
        wgpuDeviceCreateRenderPipeline(state.device, &descriptor);
    if (!pipeline) dawn_error("blit pipeline creation failed.");
    state.blit_pipelines[key] = pipeline;
    return pipeline;
}

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
        wgpuDeviceCreateBindGroup(state.device, &scene_descriptor);

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
            wgpuDeviceCreateBindGroup(state.device, &morph_descriptor);
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
        wgpuDeviceCreateBindGroup(state.device, &texture_descriptor);

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
        wgpuDeviceCreateBindGroup(state.device, &material_descriptor);

    return mesh.bindings.emplace(kind, bindings).first->second;
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
    WGPURenderPipeline pipeline =
        wgpuDeviceCreateRenderPipeline(state.device, &descriptor);
    if (!pipeline) {
        dawn_error("diagnostic render pipeline creation failed.");
    }
    return pipeline;
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
    WGPUBuffer readback =
        wgpuDeviceCreateBuffer(state.device, &readback_descriptor);
    WGPUCommandEncoder encoder =
        wgpuDeviceCreateCommandEncoder(state.device, nullptr);
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
    WGPUCommandBuffer command =
        wgpuCommandEncoderFinish(encoder, nullptr);
    wgpuQueueSubmit(state.queue, 1, &command);
    wgpuCommandBufferRelease(command);
    wgpuCommandEncoderRelease(encoder);
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
        wgpuBufferRelease(readback);
        dawn_error("diagnostic readback map returned no data.");
    }
    if (
        !raw_path.empty() &&
        format == WGPUTextureFormat_RGBA16Float) {
        std::ofstream raw(raw_path, std::ios::binary);
        if (!raw) {
            wgpuBufferUnmap(readback);
            wgpuBufferRelease(readback);
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
    wgpuBufferRelease(readback);
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
    WGPUTexture color =
        wgpuDeviceCreateTexture(state.device, &color_info);
    if (!color) dawn_error("wgpuDeviceCreateTexture ID buffer");
    WGPUTextureView color_view = wgpuTextureCreateView(color, nullptr);
    WGPUTextureDescriptor depth_info = WGPU_TEXTURE_DESCRIPTOR_INIT;
    depth_info.usage = WGPUTextureUsage_RenderAttachment;
    depth_info.size = {width, height, 1};
    depth_info.format = WGPUTextureFormat_Depth24PlusStencil8;
    WGPUTexture depth =
        wgpuDeviceCreateTexture(state.device, &depth_info);
    if (!depth) dawn_error("wgpuDeviceCreateTexture ID depth");
    WGPUTextureView depth_view = wgpuTextureCreateView(depth, nullptr);

    std::vector<WGPUBuffer> transient_buffers;
    std::vector<WGPUBindGroup> transient_groups;
    WGPUCommandEncoder encoder =
        wgpuDeviceCreateCommandEncoder(state.device, nullptr);
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
    WGPURenderPassEncoder pass =
        wgpuCommandEncoderBeginRenderPass(encoder, &pass_descriptor);
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
                    ? &engine.materials[item.material.value]
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
            WGPUBuffer uniform_buffer = wgpuDeviceCreateBuffer(
                state.device,
                &uniform_descriptor);
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
            WGPUBindGroup uniform_group = wgpuDeviceCreateBindGroup(
                state.device,
                &group_descriptor);
            transient_buffers.push_back(uniform_buffer);
            transient_groups.push_back(uniform_group);

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
            wgpuRenderPassEncoderDrawIndexed(
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
    wgpuRenderPassEncoderRelease(pass);
    WGPUCommandBuffer command =
        wgpuCommandEncoderFinish(encoder, nullptr);
    wgpuQueueSubmit(state.queue, 1, &command);
    wgpuCommandBufferRelease(command);
    wgpuCommandEncoderRelease(encoder);
    save_dawn_texture_file(
        state,
        color,
        color_format,
        width,
        height,
        path);
    for (WGPUBindGroup group : transient_groups) {
        wgpuBindGroupRelease(group);
    }
    for (WGPUBuffer buffer : transient_buffers) {
        wgpuBufferRelease(buffer);
    }
    wgpuTextureViewRelease(depth_view);
    wgpuTextureRelease(depth);
    wgpuTextureViewRelease(color_view);
    wgpuTextureRelease(color);
}

#if defined(BBLITE_HAS_POST_PROCESS) && BBLITE_HAS_POST_PROCESS
/**
 * The program a post-process pass draws with, built once per distinct one.
 *
 * A pass is identified as a drawing by its deployed module, the pipeline state
 * its output implies, and the shape of its bind group; which textures fill
 * that shape and what its uniform block holds stay per pass. A composite's
 * chain repeats the first and varies the second, so depth of field's six
 * blurs share one entry here.
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
    for (std::size_t index = 0;
         index < state.post_process_programs.size();
         ++index) {
        const DawnPostProcessProgram& program =
            state.post_process_programs[index];
        if (
            program.module_index == info.module_index &&
            program.format == format &&
            program.samples == samples &&
            program.alpha_mode == alpha_mode &&
            program.extra_textures == extra_textures &&
            program.uniform_binding == info.uniform_binding &&
            program.uniform_size == uniform_size) {
            return index;
        }
    }
    DawnPostProcessProgram program;
    program.module_index = info.module_index;
    program.format = format;
    program.samples = samples;
    program.alpha_mode = alpha_mode;
    program.extra_textures = extra_textures;
    program.uniform_binding = info.uniform_binding;
    program.uniform_size = uniform_size;
    // Both stages live in one composed module; the two deployed files carry
    // the same text, so either loads it.
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
        wgpuDeviceCreateBindGroupLayout(state.device, &layout_descriptor);
    WGPUPipelineLayoutDescriptor pipeline_layout =
        WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
    pipeline_layout.bindGroupLayoutCount = 1;
    pipeline_layout.bindGroupLayouts = &program.group_layout;
    program.pipeline_layout =
        wgpuDeviceCreatePipelineLayout(state.device, &pipeline_layout);
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
    state.post_process_programs.push_back(program);
    return state.post_process_programs.size() - 1;
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
template <typename SourceTextureView>
void record_post_process_pass(
    DawnState& state,
    Engine& engine,
    TaskHandle handle,
    WGPUCommandEncoder encoder,
    WGPUTextureView surface_view,
    std::uint32_t width,
    std::uint32_t height,
    std::size_t index,
    SourceTextureView source_texture_view) {
    PostProcessPassOptions& pass =
        engine.frame_tasks[handle.value].post_process.passes[index];
    const upstream::PostProcessShaderInfo& info =
        upstream::post_process_shader_infos[
            pass.shader_index];
    DawnPostProcessTask& gpu =
        state.post_process_tasks[handle.value][index];
    const RenderTargetRecord& output_record =
        engine.render_targets[pass.output_target.value];
    DawnRenderTarget& output =
        state.render_targets[pass.output_target.value];
    const std::uint32_t output_width = output_record.swapchain
        ? width
        : output.width;
    const std::uint32_t output_height = output_record.swapchain
        ? height
        : output.height;
    std::uint32_t source_width = output_width;
    std::uint32_t source_height = output_height;
    if (
        pass.source.source ==
            RenderTextureSource::render_target &&
        pass.source.target.value <
            state.render_targets.size()) {
        source_width =
            state.render_targets[pass.source.target.value]
                .width;
        source_height =
            state.render_targets[pass.source.target.value]
                .height;
    }
    if (gpu.program == std::numeric_limits<std::size_t>::max()) {
        gpu.program = post_process_program(
            state,
            info,
            state.render_targets[pass.output_target.value].color_format,
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
    if (gpu.uniforms && pass.uniforms_dirty) {
        std::vector<float> data(program.uniform_size / 4u, 0.0f);
        upstream::write_post_process_uniforms(
            engine,
            pass,
            output_width,
            output_height,
            source_width,
            source_height,
            data.data());
        wgpuQueueWriteBuffer(
            state.queue,
            gpu.uniforms,
            0,
            data.data(),
            program.uniform_size);
        pass.uniforms_dirty = false;
    }
    WGPURenderPassColorAttachment attachment =
        WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
    attachment.view = output_record.swapchain
        ? surface_view
        : output.color_view;
    attachment.loadOp = pass.clear
        ? WGPULoadOp_Clear
        : WGPULoadOp_Load;
    attachment.storeOp = WGPUStoreOp_Store;
    WGPURenderPassDescriptor pass_descriptor =
        WGPU_RENDER_PASS_DESCRIPTOR_INIT;
    pass_descriptor.colorAttachmentCount = 1;
    pass_descriptor.colorAttachments = &attachment;
    WGPURenderPassEncoder post_pass =
        wgpuCommandEncoderBeginRenderPass(
            encoder,
            &pass_descriptor);
    if (pass.has_viewport) {
        const PixelViewport rectangle =
            upstream::resolve_post_process_viewport(
                pass.viewport,
                output_width,
                output_height);
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
    wgpuRenderPassEncoderSetPipeline(post_pass, program.pipeline);
    wgpuRenderPassEncoderSetBindGroup(
        post_pass,
        0,
        gpu.group,
        0,
        nullptr);
    wgpuRenderPassEncoderDraw(post_pass, 3, 1, 0, 0);
    wgpuRenderPassEncoderEnd(post_pass);
    wgpuRenderPassEncoderRelease(post_pass);
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
    WGPUBindGroupLayout mesh_layout) {
    WGPUShaderModule vertex = load_wgsl_module(device, "picking.vert");
    WGPUShaderModule fragment = load_wgsl_module(device, "picking.frag");

    const std::array<WGPUBindGroupLayout, 2> groups{
        scene_layout, mesh_layout};
    WGPUPipelineLayoutDescriptor layout_descriptor =
        WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
    layout_descriptor.bindGroupLayoutCount = groups.size();
    layout_descriptor.bindGroupLayouts = groups.data();
    WGPUPipelineLayout pipeline_layout =
        wgpuDeviceCreatePipelineLayout(device, &layout_descriptor);
    if (!pipeline_layout) dawn_error("pick pipeline layout");

    // The renderer's interleaved stream read at its own pitch: the pin
    // binds a position-only buffer, and these are the same numbers.
    WGPUVertexAttribute position{};
    position.shaderLocation = 0;
    position.offset = 0;
    position.format = WGPUVertexFormat_Float32x3;
    WGPUVertexBufferLayout vertex_layout{};
    vertex_layout.arrayStride = sizeof(GpuVertex);
    vertex_layout.stepMode = WGPUVertexStepMode_Vertex;
    vertex_layout.attributeCount = 1;
    vertex_layout.attributes = &position;

    std::array<WGPUColorTargetState, 2> targets{};
    fill_dawn_pick_targets(targets);

    WGPUFragmentState fragment_state = WGPU_FRAGMENT_STATE_INIT;
    fragment_state.module = fragment;
    fragment_state.entryPoint = string_view("fs");
    fragment_state.targetCount = targets.size();
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

    WGPURenderPipeline pipeline =
        wgpuDeviceCreateRenderPipeline(device, &descriptor);
    wgpuPipelineLayoutRelease(pipeline_layout);
    wgpuShaderModuleRelease(vertex);
    wgpuShaderModuleRelease(fragment);
    if (!pipeline) dawn_error("pick mesh render pipeline");
    return pipeline;
}

#if BBLITE_HAS_SPLATS
inline WGPURenderPipeline create_dawn_pick_cloud_pipeline(
    WGPUDevice device,
    WGPUBindGroupLayout scene_layout,
    WGPUBindGroupLayout cloud_layout,
    WGPUBindGroupLayout color_layout) {
    WGPUShaderModule vertex =
        load_wgsl_module(device, "picking-splat.vert");
    WGPUShaderModule fragment =
        load_wgsl_module(device, "picking-splat.frag");

    const std::array<WGPUBindGroupLayout, 3> groups{
        scene_layout, cloud_layout, color_layout};
    WGPUPipelineLayoutDescriptor layout_descriptor =
        WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
    layout_descriptor.bindGroupLayoutCount = groups.size();
    layout_descriptor.bindGroupLayouts = groups.data();
    WGPUPipelineLayout pipeline_layout =
        wgpuDeviceCreatePipelineLayout(device, &layout_descriptor);
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

    std::array<WGPUColorTargetState, 2> targets{};
    fill_dawn_pick_targets(targets);

    WGPUFragmentState fragment_state = WGPU_FRAGMENT_STATE_INIT;
    fragment_state.module = fragment;
    fragment_state.entryPoint = string_view("fs");
    fragment_state.targetCount = targets.size();
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

    WGPURenderPipeline pipeline =
        wgpuDeviceCreateRenderPipeline(device, &descriptor);
    wgpuPipelineLayoutRelease(pipeline_layout);
    wgpuShaderModuleRelease(vertex);
    wgpuShaderModuleRelease(fragment);
    if (!pipeline) dawn_error("cloud pick render pipeline");
    return pipeline;
}
#endif
#endif

bool run_dawn_engine(Engine& engine) {
    if (engine.registered_scenes.empty() || !engine.registered_scenes.front()) {
        throw std::runtime_error("Dawn renderer requires a registered scene.");
    }
    const FrameOptions frame_options = read_frame_options();
    reject_unsupported_frame_options(
        frame_options,
        "Dawn",
        /*supports_single_sample=*/true,
        /*supports_copy_task=*/false);
    Scene& scene = *engine.registered_scenes.front();
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
    DawnState state;
    // Every attachment and pipeline reads this, so it is settled before
    // any of them is created. The count is the generated read of the
    // pin's own surface declaration, not a re-typed 4; there is no
    // capability probe here because WebGPU guarantees 4x support on the
    // surface formats this backend renders to, where SDL_GPU must ask.
    state.sample_count = frame_options.single_sample
        ? 1u
        : upstream::preferred_sample_count();
    const bool hidden_test_pass = frame_options.test_pass;

    DawnDeviceOptions device_options;
    device_options.hidden_test_pass = hidden_test_pass;
    device_options.immediate_present =
        frame_options.benchmark_requested;
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

    std::uint32_t width = state.surface_width;
    std::uint32_t height = state.surface_height;
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
    std::unique_ptr<UiRmlRuntime, decltype(&destroy_ui_rml_runtime)>
        ui_runtime(
            create_ui_rml_runtime(engine, state.window, width, height),
            &destroy_ui_rml_runtime);
#endif

#if defined(BBLITE_HAS_SPRITE_RENDERER) && BBLITE_HAS_SPRITE_RENDERER
    // Sprite rendering contexts and their render targets may be created by a
    // before-render callback. Mirror all newly appended CPU records in handle
    // order both here and immediately after each callback run.
    const auto sync_sprite_gpu_contexts = [&]() {
        state.sprite_render_textures.resize(
            engine.sprite_render_textures.size(), nullptr);
        state.sprite_render_texture_views.resize(
            engine.sprite_render_textures.size(), nullptr);
        for (std::size_t index = 0;
             index < engine.sprite_render_textures.size();
             ++index) {
            const SpriteRenderTextureRecord& texture =
                engine.sprite_render_textures[index];
            WGPUTexture& gpu_texture =
                state.sprite_render_textures[index];
            WGPUTextureView& gpu_view =
                state.sprite_render_texture_views[index];
            if (texture.disposed) {
                if (gpu_view) wgpuTextureViewRelease(gpu_view);
                if (gpu_texture) wgpuTextureRelease(gpu_texture);
                gpu_view = nullptr;
                gpu_texture = nullptr;
                continue;
            }
            if (gpu_texture) continue;
            WGPUTextureDescriptor descriptor =
                WGPU_TEXTURE_DESCRIPTOR_INIT;
            descriptor.usage = WGPUTextureUsage_RenderAttachment |
                WGPUTextureUsage_TextureBinding |
                WGPUTextureUsage_CopySrc;
            descriptor.dimension = WGPUTextureDimension_2D;
            descriptor.size = WGPUExtent3D{
                texture.width, texture.height, 1u};
            descriptor.format = state.surface_format;
            descriptor.mipLevelCount = 1;
            descriptor.sampleCount = 1;
            gpu_texture = wgpuDeviceCreateTexture(
                state.device, &descriptor);
            if (!gpu_texture) dawn_error("sprite render texture");
            gpu_view = wgpuTextureCreateView(gpu_texture, nullptr);
            if (!gpu_view) dawn_error("sprite render texture view");
        }
        while (
            state.sprite_passes.size() <
            engine.sprite_renderers.size()) {
            state.sprite_passes.push_back(create_dawn_sprite_pass(
                state.device,
                state.queue,
                engine,
                SpriteRendererHandle{static_cast<std::uint32_t>(
                    state.sprite_passes.size())},
                state.sprite_render_textures,
                state.sprite_render_texture_views,
                state.surface_format));
        }
    };
    sync_sprite_gpu_contexts();
#endif

    // Shared frame targets: 4x MSAA color (surface format, or linear
    // rgba16float for transmission frames whose multisampled texture
    // feeds the grab and the per-sample image processing) and the
    // browser's depth24plus-stencil8 depth buffer.
    state.frame_color_format = scene.transmission_enabled
        ? WGPUTextureFormat_RGBA16Float
        : state.surface_format;
    const auto recreate_frame_targets = [&]() {
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
            wgpuTextureCreateView(state.msaa_color, nullptr);
        WGPUTextureDescriptor depth_descriptor =
            WGPU_TEXTURE_DESCRIPTOR_INIT;
        depth_descriptor.usage = WGPUTextureUsage_RenderAttachment;
        depth_descriptor.size = {width, height, 1};
        depth_descriptor.format =
            WGPUTextureFormat_Depth24PlusStencil8;
        depth_descriptor.sampleCount = state.sample_count;
        state.depth =
            wgpuDeviceCreateTexture(state.device, &depth_descriptor);
        state.depth_view = wgpuTextureCreateView(state.depth, nullptr);
        if (
            !state.msaa_color ||
            !state.msaa_color_view ||
            !state.depth ||
            !state.depth_view) {
            dawn_error("resizable frame target creation failed.");
        }
    };
    recreate_frame_targets();
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
        state.transmission_color_view = wgpuTextureCreateView(
            state.transmission_color,
            nullptr);
    }
#if defined(BBLITE_HAS_SPRITE_RENDERER) && BBLITE_HAS_SPRITE_RENDERER
    if (!scene.depth_hosted_sprite_layers.empty()) {
        state.scene_sprite_pass = create_dawn_scene_sprite_pass(
            state.device,
            state.queue,
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
        wgpuTextureCreateView(state.white_texture, nullptr);
    state.black_texture = create_solid_texture(
        state,
        {0, 0, 0, 255},
        WGPUTextureFormat_RGBA8Unorm,
        1);
    state.black_view =
        wgpuTextureCreateView(state.black_texture, nullptr);
    state.normal_flat_texture = create_solid_texture(
        state,
        {128, 128, 255, 255},
        WGPUTextureFormat_RGBA8Unorm,
        1);
    state.normal_flat_view =
        wgpuTextureCreateView(state.normal_flat_texture, nullptr);
    const auto cube_view = [&](WGPUTexture texture) {
        WGPUTextureViewDescriptor cube_descriptor =
            WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
        cube_descriptor.dimension = WGPUTextureViewDimension_Cube;
        cube_descriptor.arrayLayerCount = 6;
        return wgpuTextureCreateView(texture, &cube_descriptor);
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
        wgpuTextureCreateView(state.brdf_texture, nullptr);
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

    upstream::RenderPlan render_plan;
    std::uint64_t synced_render_topology_version =
        scene.render_topology_version;
    // For the post-registration family guard the topology update runs,
    // exactly as the SDL backend tracks it.
    std::uint32_t synced_material_family_mask =
        scene.material_family_mask;
    const auto upload_render_item =
        [&](const upstream::RenderItem& item) {
        const ModelGeometry& geometry = engine.geometries[item.geometry];
        const MeshRecord& mesh_record = engine.meshes[item.mesh.value];
        const bool shader_material =
            item.material_kind ==
            upstream::RenderMaterialKind::shader;
        const std::vector<GpuVertex> vertices =
            shader_material
                ? local_vertices(engine, geometry)
                : transformed_vertices(engine, geometry, mesh_record);
        DawnMesh mesh;
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
                geometry.indices.data(),
                geometry.indices.size() * sizeof(std::uint32_t));
#else
            mesh.shared_geometry = find_shared_shader_geometry(
                state.shared_shader_geometries,
                vertices,
                geometry.indices);
            if (!mesh.shared_geometry) {
                auto created = std::make_unique<DawnSharedShaderGeometry>(
                    DawnSharedShaderGeometry{
                        .vertices = vertices,
                        .indices = geometry.indices,
                    });
                created->vertex_buffer = create_buffer(
                    state,
                    WGPUBufferUsage_Vertex,
                    vertices.data(),
                    vertices.size() * sizeof(GpuVertex));
                created->index_buffer = create_buffer(
                    state,
                    WGPUBufferUsage_Index,
                    geometry.indices.data(),
                    geometry.indices.size() * sizeof(std::uint32_t));
                mesh.shared_geometry = created.get();
                state.shared_shader_geometries.push_back(
                    std::move(created));
            }
            ++mesh.shared_geometry->users;
            mesh.vertices = mesh.shared_geometry->vertex_buffer;
            mesh.indices = mesh.shared_geometry->index_buffer;
            mesh.owns_geometry_buffers = false;
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
                geometry.indices.data(),
                geometry.indices.size() * sizeof(std::uint32_t));
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
            mesh.owns_morph_buffers = true;
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
                WGPUBufferUsage_Vertex,
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
                    mesh_record.instance_colors;
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
            material = &engine.materials[item.material.value];
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
                    created->textures[slot_row.slot] =
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
                    created->views[slot_row.slot] =
                        wgpuTextureCreateView(
                            created->textures[slot_row.slot],
                            nullptr);
                    created->samplers[slot_row.slot] =
                        create_texture_sampler(
                            state.device,
                            slot_data
                                ? slot_data->sampler
                                : TextureSamplerState{});
                }
                mesh.shared_composed_textures = created.get();
                state.shared_composed_material_textures.push_back(
                    std::move(created));
            } else {
                mesh.shared_composed_textures = shared_it->get();
            }
            ++mesh.shared_composed_textures->users;
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
        const auto upload_shader_textures = [&] {
            std::vector<DawnSampledTexture> textures;
            for (const FileTexture& texture : material->shader_textures) {
                std::uint32_t shader_mip_count = 1;
                DawnSampledTexture sampled;
                sampled.texture = upload_material_texture(
                    state,
                    texture.data,
                    texture.srgb,
                    {255, 255, 255, 255},
                    shader_mip_count);
                sampled.view =
                    wgpuTextureCreateView(sampled.texture, nullptr);
                sampled.sampler = create_texture_sampler(
                    state.device,
                    texture.data.sampler);
                textures.push_back(sampled);
            }
            return textures;
        };
        if (material && material->shader_material) {
            mesh.shared_shader_textures =
                find_shared_shader_material_textures(
                    state.shared_shader_material_textures,
                    item.material);
            if (!mesh.shared_shader_textures) {
                auto created =
                    std::make_unique<DawnSharedShaderMaterialTextures>(
                        DawnSharedShaderMaterialTextures{
                            .material = item.material,
                            .textures = upload_shader_textures(),
                        });
                mesh.shared_shader_textures = created.get();
                state.shared_shader_material_textures.push_back(
                    std::move(created));
            }
            ++mesh.shared_shader_textures->users;
        } else if (material) {
            mesh.shader_textures = upload_shader_textures();
        }
        return mesh;
    };
    const auto rebuild_task_draw_lists = [&] {
        if (state.render_tasks.size() < engine.frame_tasks.size()) {
            state.render_tasks.resize(engine.frame_tasks.size());
        }
        for (const TaskHandle handle : scene.tasks) {
            if (handle.value >= engine.frame_tasks.size()) {
                throw std::runtime_error(
                    "Scene frame task handle is invalid.");
            }
            const FrameTaskRecord& task = engine.frame_tasks[handle.value];
            if (
                task.kind != FrameTaskKind::render &&
                task.kind != FrameTaskKind::geometry) {
                continue;
            }
            DawnRenderTask& render_task =
                state.render_tasks[handle.value];
            if (!render_task.view_projection) {
                render_task.view_projection = create_buffer(
                    state,
                    WGPUBufferUsage_Uniform,
                    nullptr,
                    64);
            }
            render_task.draw_lists =
                upstream::build_render_task_draw_lists(
                    render_plan.items,
                    engine,
                    task);
        }
    };
    const auto initialize_render_tasks = [&] {
        state.release_render_tasks();
        state.render_tasks.resize(engine.frame_tasks.size());
        for (const TaskHandle handle : scene.tasks) {
            const FrameTaskRecord& task = engine.frame_tasks[handle.value];
            if (task.kind == FrameTaskKind::render) {
                DawnRenderTask& render_task =
                    state.render_tasks[handle.value];
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
        state.meshes.reserve(render_plan.items.size());
        for (const upstream::RenderItem& item : render_plan.items) {
            state.meshes.push_back(upload_render_item(item));
        }
        initialize_render_tasks();
    };
    upstream::initialize_composition_feature_rows(engine);
    rebuild_meshes();

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
            scene.environment.skybox_uses_environment
                ? "background-skybox.frag"
                : "background-skybox-dither.frag");
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
            std::size_t offset = environment.skybox_data_offset;
            for (std::uint32_t face = 0; face < 6; ++face) {
                for (std::uint32_t mip = 0;
                     mip < environment.skybox_mip_count;
                     ++mip) {
                    const std::uint32_t mip_size =
                        std::max(environment.skybox_width >> mip, 1u);
                    const std::size_t byte_size =
                        static_cast<std::size_t>(mip_size) *
                        mip_size * 8;
                    if (offset + byte_size > data.bytes.size()) {
                        throw std::runtime_error(
                            "DDS skybox payload is truncated.");
                    }
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
                    offset += byte_size;
                }
            }
            WGPUTextureViewDescriptor view_descriptor =
                WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
            view_descriptor.dimension = WGPUTextureViewDimension_Cube;
            view_descriptor.arrayLayerCount = 6;
            state.skybox_texture_view = wgpuTextureCreateView(
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
        WGPUBindGroupLayout scene_layout =
            wgpuRenderPipelineGetBindGroupLayout(
                state.skybox_pipeline, 1);
        std::array<WGPUBindGroupEntry, 3> scene_entries{};
        scene_entries[0] = WGPU_BIND_GROUP_ENTRY_INIT;
        scene_entries[0].binding = 0;
        scene_entries[0].buffer = state.skybox_matrix;
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
        state.skybox_scene_group =
            wgpuDeviceCreateBindGroup(state.device, &scene_descriptor);
        wgpuBindGroupLayoutRelease(scene_layout);
#if BBLITE_GPU_MORPH_STORAGE
        if (!pinned_dds_skybox) {
            WGPUBindGroupLayout morph_layout =
                wgpuRenderPipelineGetBindGroupLayout(
                    state.skybox_pipeline, 0);
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
            wgpuBindGroupLayoutRelease(morph_layout);
        }
#endif
        WGPUBindGroupLayout texture_layout =
            wgpuRenderPipelineGetBindGroupLayout(
                state.skybox_pipeline, 2);
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
        wgpuBindGroupLayoutRelease(texture_layout);
        WGPUBindGroupLayout material_layout =
            wgpuRenderPipelineGetBindGroupLayout(
                state.skybox_pipeline, 3);
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
        wgpuBindGroupLayoutRelease(material_layout);
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

        WGPUBindGroupLayout scene_layout =
            wgpuRenderPipelineGetBindGroupLayout(
                state.solid_skybox_pipeline, 1);
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
        wgpuBindGroupLayoutRelease(scene_layout);

        WGPUBindGroupLayout material_layout =
            wgpuRenderPipelineGetBindGroupLayout(
                state.solid_skybox_pipeline, 3);
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
        wgpuBindGroupLayoutRelease(material_layout);
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
        state.image_skybox_texture_view = wgpuTextureCreateView(
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

        WGPUBindGroupLayout scene_layout =
            wgpuRenderPipelineGetBindGroupLayout(
                state.image_skybox_pipeline, 1);
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
        wgpuBindGroupLayoutRelease(scene_layout);

        WGPUBindGroupLayout texture_layout =
            wgpuRenderPipelineGetBindGroupLayout(
                state.image_skybox_pipeline, 2);
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
        wgpuBindGroupLayoutRelease(texture_layout);

        WGPUBindGroupLayout material_layout =
            wgpuRenderPipelineGetBindGroupLayout(
                state.image_skybox_pipeline, 3);
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
        wgpuBindGroupLayoutRelease(material_layout);
        state.image_skybox_enabled = true;
    }
#endif

    if (use_ground) {
        // The pinned dither, on the same terms as the skybox above.
        state.ground_module =
            load_wgsl_module(state, "background-ground-dither.frag");
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
            wgpuTextureCreateView(state.ground_texture, nullptr);

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
        WGPUBindGroupLayout scene_layout =
            wgpuRenderPipelineGetBindGroupLayout(
                state.ground_pipeline, 1);
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
        wgpuBindGroupLayoutRelease(scene_layout);
#if BBLITE_GPU_MORPH_STORAGE
        {
            WGPUBindGroupLayout morph_layout =
                wgpuRenderPipelineGetBindGroupLayout(
                    state.ground_pipeline, 0);
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
            wgpuBindGroupLayoutRelease(morph_layout);
        }
#endif
        WGPUBindGroupLayout texture_layout =
            wgpuRenderPipelineGetBindGroupLayout(
                state.ground_pipeline, 2);
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
        wgpuBindGroupLayoutRelease(texture_layout);
        WGPUBindGroupLayout material_layout =
            wgpuRenderPipelineGetBindGroupLayout(
                state.ground_pipeline, 3);
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
        wgpuBindGroupLayoutRelease(material_layout);
        state.ground_enabled = true;
    }

    CameraRecord fallback_camera;
    CameraRecord& camera =
        scene.camera.value < engine.cameras.size()
            ? engine.cameras[scene.camera.value]
            : fallback_camera;

    const std::string screenshot_path =
        frame_options.screenshot_path;
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
    const bool capture_ui = frame_options.capture_ui;
#endif
    const std::string id_buffer_path =
        frame_options.id_buffer_path;
    const std::string cluster_buffer_path =
        frame_options.cluster_buffer_path;
    const long screenshot_frame = frame_options.screenshot_frame;
    const long benchmark_frames = frame_options.benchmark_frames;
    const bool benchmark = frame_options.benchmarking();
    const long benchmark_warmup = frame_options.benchmark_warmup();
    const long limit = frame_options.frame_budget();
    std::vector<double> benchmark_samples;
    if (benchmark) {
        benchmark_samples.reserve(
            static_cast<std::size_t>(benchmark_frames));
    }


#if BBLITE_HAS_PICKING
    // The pick pass. Installed before the loop, because the continuation
    // that calls it arrives on the deferred queue at the first frame
    // boundary; a pick taken before this point reports a miss, exactly as
    // the pin's `pickAsync` does for a scene with no camera.
    engine.pick_hook =
        [&state, &engine, &scene, &render_plan](
            GpuPickerHandle, double x, double y) -> PickingInfo {
        if (scene.camera.value >= engine.cameras.size()) {
            return PickingInfo{};
        }
        const CameraRecord& camera = engine.cameras[scene.camera.value];
        // Native has no CSS box, so the pin's backing/client scale is 1.
        const double width = static_cast<double>(engine.options.width);
        const double height = static_cast<double>(engine.options.height);
        if (x < 0.0 || y < 0.0 || x >= width || y >= height) {
            return PickingInfo{};
        }
        const double aspect = width / height;
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
                state.pick_mesh_layout);
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
        // Which plan item each block belongs to. Indices rather than
        // pointers: the same function pushes into `state.splat_passes`
        // below, and a raw pointer into a growing vector is the shape of
        // the bloom-composite crash.
        std::vector<std::size_t> drawn_items;
        std::uint32_t next_id = 1;
        // The RENDER PLAN, not `scene.meshes`: `state.meshes` is indexed
        // by plan item and the plan skips a mesh with no geometry, so the
        // two agree only while nothing has been skipped or removed.
        for (std::size_t item_index = 0;
             item_index < render_plan.items.size() &&
             item_index < state.meshes.size();
             ++item_index) {
            const MeshHandle handle = render_plan.items[item_index].mesh;
            const DawnMesh& mesh = state.meshes[item_index];
            if (!mesh.vertices || !mesh.indices) continue;
            // A mesh the pin's picker would not take never enters the
            // pass, so it can neither answer a pick nor occlude one
            // behind it. The predicate is generated, and it reads the
            // live record rather than the plan's snapshot of it.
            if (!upstream::pick_candidate(engine.meshes[handle.value])) {
                continue;
            }
            DawnPickMeshUniforms block{};
            const MeshRecord& pick_mesh =
                engine.meshes[handle.value];
            block.world = pick_mesh.gpu_world_transform
                ? shader_draw_world(engine, pick_mesh)
                : std::array<float, 16>{
                      1.0f, 0.0f, 0.0f, 0.0f,
                      0.0f, 1.0f, 0.0f, 0.0f,
                      0.0f, 0.0f, 1.0f, 0.0f,
                      0.0f, 0.0f, 0.0f, 1.0f};
            block.pick_id = next_id;
            blocks.push_back(block);
            drawn_items.push_back(item_index);
            ranges.push_back(
                {next_id, PickedNodeKind::mesh, handle.value});
            ++next_id;
        }
        if (blocks.size() > state.pick_mesh_capacity) {
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

#if BBLITE_HAS_SPLATS
        // The clouds are built lazily inside the frame loop, so a pick at
        // the first frame boundary may arrive before any exist -- and the
        // sort's GPU-side order buffer is written by the frame's upload,
        // which runs after the deferred queue. `await splat.firstSortReady`
        // is what the pin's own scene waits for, so the pick brings both
        // current itself; the upload is idempotent.
        if (state.splat_passes.empty()) {
            for (const SplatMeshHandle handle : scene.splat_meshes) {
                state.splat_passes.push_back(create_dawn_splat_pass(
                    state.device,
                    state.queue,
                    state.frame_color_format,
                    WGPUTextureFormat_Depth24PlusStencil8,
                    state.sample_count,
                    engine,
                    handle));
            }
        }
        // The cloud pass wants the two matrices unmultiplied, where every
        // other pick draw wants the product. Declared here, with their only
        // consumer, so a picking scene that reaches no splat still compiles.
        const std::array<float, 16> pick_view =
            upstream::build_view_matrix(
                upstream::camera_world_matrix(camera));
        const std::array<float, 16> pick_projection =
            upstream::build_scene_projection(camera, aspect);
        for (DawnSplatPass& splat : state.splat_passes) {
            upload_dawn_splat_pass(
                state.queue,
                engine,
                splat,
                pick_view,
                pick_projection,
                static_cast<float>(width),
                static_cast<float>(height));
        }
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
        if (state.splat_passes.size() > 1) {
            throw std::runtime_error(
                "Picking more than one Gaussian cloud needs a per-cloud "
                "id buffer; the reached slice loads one.");
        }
        for (const DawnSplatPass& splat : state.splat_passes) {
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

        WGPUCommandEncoderDescriptor encoder_descriptor =
            WGPU_COMMAND_ENCODER_DESCRIPTOR_INIT;
        WGPUCommandEncoder encoder =
            wgpuDeviceCreateCommandEncoder(state.device, &encoder_descriptor);

        std::array<WGPURenderPassColorAttachment, 2> attachments{};
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

        WGPURenderPassDepthStencilAttachment depth_attachment =
            WGPU_RENDER_PASS_DEPTH_STENCIL_ATTACHMENT_INIT;
        depth_attachment.view = state.pick_targets.depth_view;
        depth_attachment.depthLoadOp = WGPULoadOp_Clear;
        depth_attachment.depthStoreOp = WGPUStoreOp_Discard;
        depth_attachment.depthClearValue = 0.0f;

        WGPURenderPassDescriptor pass_descriptor =
            WGPU_RENDER_PASS_DESCRIPTOR_INIT;
        pass_descriptor.colorAttachmentCount = attachments.size();
        pass_descriptor.colorAttachments = attachments.data();
        pass_descriptor.depthStencilAttachment = &depth_attachment;
        WGPURenderPassEncoder pass =
            wgpuCommandEncoderBeginRenderPass(encoder, &pass_descriptor);

        wgpuRenderPassEncoderSetPipeline(pass, state.pick_mesh_pipeline);
        wgpuRenderPassEncoderSetBindGroup(
            pass, 0, state.pick_scene_group, 0, nullptr);
        for (std::size_t index = 0; index < blocks.size(); ++index) {
            const DawnMesh& mesh = state.meshes[drawn_items[index]];
            const std::uint32_t offset = static_cast<std::uint32_t>(
                index * sizeof(DawnPickMeshUniforms));
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
            wgpuRenderPassEncoderDrawIndexed(
                pass, mesh.index_count, 1, 0, 0, 0);
        }
#if BBLITE_HAS_SPLATS
        for (const DawnSplatPass& splat : state.splat_passes) {
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
            wgpuRenderPassEncoderDrawIndexed(
                pass,
                static_cast<std::uint32_t>(
                    upstream::splat_quad_indices.size()),
                splat.vertex_count,
                0,
                0,
                0);
        }
#endif
        wgpuRenderPassEncoderEnd(pass);
        wgpuRenderPassEncoderRelease(pass);

        WGPUTexelCopyTextureInfo source = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
        source.texture = state.pick_targets.color;
        WGPUTexelCopyBufferInfo destination =
            WGPU_TEXEL_COPY_BUFFER_INFO_INIT;
        destination.buffer = state.pick_targets.staging;
        destination.layout.bytesPerRow = 256;
        destination.layout.rowsPerImage = 1;
        const WGPUExtent3D one{1, 1, 1};
        wgpuCommandEncoderCopyTextureToBuffer(
            encoder, &source, &destination, &one);
        source.texture = state.pick_targets.depth_color;
        destination.layout.offset = 256;
        wgpuCommandEncoderCopyTextureToBuffer(
            encoder, &source, &destination, &one);

        WGPUCommandBufferDescriptor finish =
            WGPU_COMMAND_BUFFER_DESCRIPTOR_INIT;
        WGPUCommandBuffer commands =
            wgpuCommandEncoderFinish(encoder, &finish);
        wgpuQueueSubmit(state.queue, 1, &commands);
        wgpuCommandBufferRelease(commands);
        wgpuCommandEncoderRelease(encoder);

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
                512,
                map_callback));
        if (!state.uncaptured_error.empty()) {
            dawn_error("pick buffer map failed: " + state.uncaptured_error);
        }
        const void* mapped = wgpuBufferGetConstMappedRange(
            state.pick_targets.staging, 0, 512);
        if (!mapped) dawn_error("pick map returned no data.");
        const auto* bytes = static_cast<const std::uint8_t*>(mapped);
        const std::uint32_t pick_id =
            decode_pick_id(bytes);
        float pick_depth = 1.0f;
        std::memcpy(&pick_depth, bytes + 256, sizeof(pick_depth));
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
        return info;
    };
#endif

    CaptureGate captures(frame_options, limit, &engine);
    FrameClock frame_clock;
    bool running = true;
    long frame = 0;
    CameraPointerState pointer_state;
    CameraTraceState camera_trace_state;
    PlatformInputReplay input_replay;
    while (captures.keep_running(running, frame)) {
        SDL_Event event;
        while (SDL_PollEvent(&event)) {
            if (event.type == SDL_EVENT_QUIT) running = false;
            if (hidden_test_pass && is_platform_input_event(event)) {
                continue;
            }
            bool propagate_to_scene = true;
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
            propagate_to_scene =
                handle_ui_rml_event(*ui_runtime, event);
#endif
            if (propagate_to_scene) {
                handle_platform_event(event, engine);
                apply_canvas_cursor(engine);
            }
            if (!hidden_test_pass && propagate_to_scene) {
                handle_camera_pointer_event(
                    event,
                    camera,
                    pointer_state);
            }
        }
        input_replay.dispatch(frame, state.window, engine);
        sync_engine_canvas_size(state.window, engine);
        if (resize_dawn_surface(state, engine.options)) {
            width = state.surface_width;
            height = state.surface_height;
            recreate_frame_targets();
        }
        // The benchmark bracket mirrors the SDL backend: frame CPU time
        // across the whole loop body -- scene callbacks and uploads, surface
        // acquire, submit and present -- under the immediate present mode
        // both backends configure. It starts here rather than at the
        // acquisition because SDL_GPU has to acquire before it may advance
        // the scene at all (a null swapchain must skip the frame entirely),
        // and a bracket that began at each backend's acquisition would then
        // cover a different span on each.
        const double benchmark_start = monotonic_milliseconds();
        // Only an animated billboard pass reads it, so the frame's own
        // delta is unused in a build that reaches no billboards.
        [[maybe_unused]] const float delta_ms =
            advance_frame(
                engine,
                scene,
                frame_clock,
                frame_options.frame_delta_ms);
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
        // Browser layout observes DOM changes made by this turn's RAF
        // callbacks before painting the frame.
        update_ui_rml_runtime(*ui_runtime, width, height);
#endif
        trace_dynamic_frame(engine, delta_ms, frame);
#if defined(BBLITE_HAS_SPRITE_RENDERER) && BBLITE_HAS_SPRITE_RENDERER
        // Upstream updates every rendering context before recording any of
        // them. Scene callbacks above may have changed layer membership or
        // instance data, so synchronize and upload every sprite context now.
        sync_sprite_gpu_contexts();
        for (DawnSpritePass& sprite_pass : state.sprite_passes) {
            sync_dawn_sprite_pass_layers(
                state.device,
                state.queue,
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
        bool topology_updated = false;
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
                    [&](DawnMesh& mesh) {
                        state.release_mesh(mesh);
                    },
                    [&](const upstream::RenderItem& item) {
                        return upload_render_item(item);
                    });
            state.prune_shared_shader_geometries();
            state.prune_shared_shader_material_textures();
            state.prune_shared_composed_material_textures();
            state.meshes = std::move(updated_meshes);
            render_plan = std::move(updated_plan);
            rebuild_task_draw_lists();
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
        }
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
        for (
            std::size_t index = 0;
            index < render_plan.items.size() &&
            index < state.meshes.size();
            ++index) {
            const upstream::RenderItem& item =
                render_plan.items[index];
            const MeshRecord& mesh =
                engine.meshes[item.mesh.value];
            DawnMesh& dawn_mesh = state.meshes[index];
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
            // Sound because visibility can only reach the draw lists
            // through a render_topology_version bump, and the rebuild that
            // bump triggers runs earlier in this same frame -- so the
            // frame a mesh starts drawing is a frame this loop writes it.
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
                // Re-upload the pinned dirty range [0, count) from
                // the record pool; slots past the active count keep
                // their previous contents and are never drawn.
                const std::size_t active_count = std::min(
                    static_cast<std::size_t>(
                        mesh.instance_count),
                    mesh.instance_matrices.size());
                if (active_count > 0) {
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
                        const std::vector<std::array<float, 16>>
                            pinned_matrices =
                                pinned_instance_matrices(mesh);
                        wgpuQueueWriteBuffer(
                            state.queue,
                            dawn_mesh.pinned_instances,
                            0,
                            pinned_matrices.data(),
                            active_count *
                                sizeof(pinned_matrices.front()));
                    }
#endif
#if BBLITE_GPU_INSTANCE_COLORS
                    if (
                        dawn_mesh.instance_colors &&
                        mesh.instance_colors.size() >=
                            active_count * 4) {
                        wgpuQueueWriteBuffer(
                            state.queue,
                            dawn_mesh.instance_colors,
                            0,
                            mesh.instance_colors.data(),
                            active_count * 4 * sizeof(float));
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
                wgpuQueueWriteBuffer(
                    state.queue,
                    dawn_mesh.vertices,
                    0,
                    vertices.data(),
                    vertices.size() * sizeof(GpuVertex));
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
                if (
                    dawn_mesh.owns_morph_buffers &&
                    dawn_mesh.morph_weights_version !=
                        mesh.morph_weights_version) {
                    // The shared value packer behind the blob's
                    // constant header; this backend rewrites just
                    // the weight span.
                    const std::vector<float> weights =
                        morph_weight_values(
                            engine.geometries[item.geometry],
                            mesh);
                    wgpuQueueWriteBuffer(
                        state.queue,
                        dawn_mesh.morph_weights,
                        16,
                        weights.data(),
                        weights.size() * sizeof(float));
                    dawn_mesh.morph_weights_version =
                        mesh.morph_weights_version;
                }
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
        update_camera(camera);
        trace_camera_state(camera, camera_trace_state, frame);
        upstream::sort_transparent_draws(
            render_plan.draw_lists.transparent,
            engine,
            camera);

        // getEffectiveAspectRatio divides two JavaScript numbers, so
        // the ratio reaches the projection writer in double.
        const double aspect =
            static_cast<double>(width) /
            static_cast<double>(height);
        const std::array<float, 16> matrix =
            upstream::build_view_projection(camera, aspect);
        // The frame's own two factors, built once. A shader material may
        // declare either beside the product, the pin's splat UBO stores
        // them separately, and the billboard sort reads the view. The
        // projection is the pin's `getProjectionMatrix` -- the arm that
        // branches on the camera -- rather than the perspective writer.
        const std::array<float, 16> frame_view =
            upstream::build_view_matrix(
                upstream::camera_world_matrix(camera));
        const std::array<float, 16> frame_projection =
            upstream::build_scene_projection(camera, aspect);
        const std::array<float, 4> frame_camera_position =
            shader_camera_position(scene, engine, camera);
        ShaderPassMatrices frame_pass_matrices{
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
        const bool capture_ready =
            frame >= screenshot_frame && !topology_updated &&
            captures.drains_resolved();
        // Written from the same plan, camera and matrix the uploads
        // below read, so the two backends' captures are comparable to
        // each other as well as to the browser's.
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
                frame);
            captures.render_capture_saved = true;
        }
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
#if BBLITE_SHADOW_RECEIVERS
        // The shadow generators' matrices and their receiver blocks, before
        // the caster pass reads the first and the receiving draws read the
        // second.
        write_shadow_generators(state, scene, engine);
#endif
#endif
        // The pass's own matrices travel with the list: a render task
        // renders through its own camera and target aspect, and a shadow
        // caster pass through the generator's light-space matrix, so a
        // shader material's system block reads what its pass renders with
        // rather than the frame's.
        const auto write_material_uniforms =
            [&](
                const upstream::RenderDrawList& list,
                const ShaderPassMatrices& pass_matrices) {
                for (const upstream::RenderDrawCommand& draw :
                     list.commands) {
                    DawnMesh& draw_mesh = state.meshes[draw.item_index];
                    const bool grid_draw =
                        draw.item.material_kind ==
                        upstream::RenderMaterialKind::grid;
                    const bool shader_draw =
                        draw.item.material_kind ==
                        upstream::RenderMaterialKind::shader;
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
                            standard_variant_for_draw(scene, engine, draw);
                        if (
                            variant ==
                            std::numeric_limits<std::size_t>::max()) {
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
                            scene,
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
                            scene,
                            engine,
                            draw,
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
                            state.meshes[draw.item_index]
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
                            const std::array<float, 16> shader_world =
                                shader_draw_world(
                                    engine,
                                    engine.meshes[
                                        draw.item.mesh.value]);
                            const std::array<float, 16> shader_wvp =
                                shader_world_view_projection(
                                    pass_matrices.view_projection,
                                    shader_world);
                            const auto shader_wv =
                                shader_world_view(
                                    pass_matrices.view,
                                    shader_world);
                            ShaderPassMatrices shader_pass_matrices =
                                pass_matrices;
                            shader_pass_matrices.world = &shader_world;
                            shader_pass_matrices.world_view =
                                shader_wv ? &*shader_wv : nullptr;
                            shader_pass_matrices
                                .world_view_projection = &shader_wvp;
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
                                const std::vector<float>
                                    block_floats =
                                        shader_stage_block_floats(
                                            block,
                                            shader_pass_matrices,
                                            material);
                                wgpuQueueWriteBuffer(
                                    state.queue,
                                    buffer,
                                    0,
                                    block_floats.data(),
                                    block_floats.size() *
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
                                scene,
                                engine,
                                draw,
                                std::numeric_limits<std::size_t>::max(),
                                &pinned_key);
                        if (
                            variant ==
                            std::numeric_limits<std::size_t>::max()) {
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
                                engine.meshes[draw.item.mesh.value];
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
                                scene,
                                engine,
                                draw,
                                variant,
                                conventions.skeleton_draw,
                                conventions.world_from_palette,
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
            };
        write_material_uniforms(
            render_plan.draw_lists.opaque, frame_pass_matrices);
        write_material_uniforms(
            render_plan.draw_lists.transparent, frame_pass_matrices);
        if (state.skybox_enabled) {
            const std::array<float, 16> skybox_view_projection =
                upstream::build_skybox_view_projection(
                    camera,
                    static_cast<float>(width) / height);
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
                    camera);
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
            create_frame_graph_textures(state, engine, width, height);
            for (const TaskHandle handle : scene.tasks) {
                if (handle.value >= engine.frame_tasks.size()) {
                    throw std::runtime_error(
                        "Scene frame task handle is invalid.");
                }
                const FrameTaskRecord& task =
                    engine.frame_tasks[handle.value];
                if (task.kind == FrameTaskKind::geometry) {
                    upstream::sort_transparent_draws(
                        state.render_tasks[handle.value]
                            .draw_lists.transparent,
                        engine,
                        camera);
#if BBLITE_PBR_VARIANTS > 0
                    // A task whose draws are PBR writes its blocks here:
                    // the shared scene block, the task's gpUniforms, and
                    // each draw's mesh and material blocks against the MRT
                    // variant the selector table keys on this task.
                    write_pinned_geometry_task(
                        state,
                        scene,
                        engine,
                        camera,
                        matrix,
                        task,
                        state.geometry_tasks[handle.value],
                        state.render_tasks[handle.value].draw_lists);
#endif
#if BBLITE_STANDARD_VARIANTS > 0
                    write_standard_geometry_task(
                        state,
                        scene,
                        engine,
                        camera,
                        matrix,
                        task,
                        state.geometry_tasks[handle.value],
                        state.render_tasks[handle.value].draw_lists);
#endif
                    continue;
                }
                if (task.kind != FrameTaskKind::render) continue;
                DawnRenderTask& render_task =
                    state.render_tasks[handle.value];
                if (
                    task.render.target.value >=
                    engine.render_targets.size()) {
                    throw std::runtime_error(
                        "Render task target is invalid.");
                }
                const RenderTargetRecord& target_record =
                    engine.render_targets[task.render.target.value];
                const DawnRenderTarget& target =
                    state.render_targets[task.render.target.value];
                const CameraRecord& task_camera =
                    task.render.has_camera &&
                            task.render.camera.value <
                                engine.cameras.size()
                        ? engine.cameras[task.render.camera.value]
                        : camera;
                const double task_aspect = task.render.canvas_size
                    ? static_cast<double>(width) /
                        static_cast<double>(height)
                    : static_cast<double>(target.width) /
                        static_cast<double>(target.height);
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
                    shader_camera_position(scene, engine, task_camera);
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
                    engine.shadow_generators.size()) {
                    const ShadowGeneratorRecord& generator =
                        engine.shadow_generators[
                            task.render.shadow_generator.value];
                    upstream::SceneUniforms shadow_block =
                        pinned_scene_block(
                            scene,
                            engine,
                            camera,
                            generator.caster_view_projection);
                    shadow_block.view = generator.caster_view;
                    task_pinned_frame_group(state, render_task);
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
                        generator.caster_view_projection.data(),
                        64);
                    ShaderPassMatrices caster_pass_matrices{
                        generator.caster_view_projection.data(),
                        &generator.caster_view,
                        nullptr};
                    caster_pass_matrices.camera_position =
                        &task_camera_position;
                    write_material_uniforms(
                        render_task.draw_lists.opaque,
                        caster_pass_matrices);
                    write_material_uniforms(
                        render_task.draw_lists.transparent,
                        caster_pass_matrices);
                }
#endif
#if BBLITE_PINNED_MATERIALS
                // A task the scene gave its own camera reads its own eye
                // position and view-projection, which is the whole of what
                // the pass block holds; the record says so directly.
                if (target_record.has_color && task.render.has_camera) {
                    // The task's own pass block, in the pin's own shape: the
                    // frame's writer over the task's camera and matrix.
                    const upstream::SceneUniforms task_scene_block =
                        pinned_scene_block(
                            scene,
                            engine,
                            task_camera,
                            task_matrix);
                    task_pinned_frame_group(state, render_task);
                    wgpuQueueWriteBuffer(
                        state.queue,
                        render_task.pinned_scene_uniforms,
                        0,
                        &task_scene_block,
                        sizeof(task_scene_block));
                }
#endif
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

        WGPUSurfaceTexture surface_texture = WGPU_SURFACE_TEXTURE_INIT;
        wgpuSurfaceGetCurrentTexture(state.surface, &surface_texture);
        if (
            surface_texture.status !=
                WGPUSurfaceGetCurrentTextureStatus_SuccessOptimal &&
            surface_texture.status !=
                WGPUSurfaceGetCurrentTextureStatus_SuccessSuboptimal) {
            dawn_error("wgpuSurfaceGetCurrentTexture failed.");
        }
        WGPUTextureView surface_view =
            wgpuTextureCreateView(surface_texture.texture, nullptr);

        WGPUCommandEncoder encoder =
            wgpuDeviceCreateCommandEncoder(state.device, nullptr);
        WGPUTexture capture_source = surface_texture.texture;
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
                                            invalid_handle) {
            (void)frame_group;
            (void)shadow_pass;
            (void)esm_shadow_index;
            for (const upstream::RenderDrawCommand& draw :
                 list.commands) {
                if (draw.item_index >= state.meshes.size()) continue;
                DawnMesh& mesh = state.meshes[draw.item_index];
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
                            engine.meshes[draw.item.mesh.value],
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
                                  scene,
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
                        standard_entry->second.group_key ==
                            std::numeric_limits<std::size_t>::max()) {
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
                            engine.meshes[draw.item.mesh.value],
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
                            ? standard_shadow_group_for(state, scene, engine, variant)
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
                            ? &engine.materials[draw.item.material.value]
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
                            scene,
                            engine,
                            mesh,
                            node_state,
                            draw.item.shader_variant,
                            node_caster,
                            node_material);
                        node_state.group_key = node_slot;
                    }
                    encode_variant_draw(
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
                    pass_has_depth);
                DawnMeshBindings& bindings = bindings_for(
                    state,
                    mesh,
                    draw.pipeline,
                    draw.item.shader_variant);
                if (pipeline.pipeline != bound_pipeline) {
                    wgpuRenderPassEncoderSetPipeline(
                        list_pass, pipeline.pipeline);
                    bound_pipeline = pipeline.pipeline;
                }
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
                wgpuRenderPassEncoderDrawIndexed(
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
            color_attachment.storeOp = WGPUStoreOp_Discard;
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
        WGPURenderPassEncoder pass =
            wgpuCommandEncoderBeginRenderPass(encoder, &pass_descriptor);
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
                        wgpuRenderPassEncoderRelease(pass);
                        encode_transmission_grab(state, encoder);
                        color_attachment.loadOp = WGPULoadOp_Load;
                        depth_attachment.depthLoadOp =
                            WGPULoadOp_Load;
                        pass = wgpuCommandEncoderBeginRenderPass(
                            encoder,
                            &pass_descriptor);
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
            wgpuRenderPassEncoderDrawIndexed(pass, 6, 1, 0, 0, 0);
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
            wgpuRenderPassEncoderDrawIndexed(pass, 36, 1, 0, 0, 0);
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
            wgpuRenderPassEncoderDrawIndexed(pass, 36, 1, 0, 0, 0);
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
            wgpuRenderPassEncoderDrawIndexed(pass, 36, 1, 0, 0, 0);
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
                if (engine.billboard_systems[billboard.system.value].depth_mode != mode) {
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
        wgpuRenderPassEncoderRelease(pass);
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
                state.geometry_tasks[reference.task.value].depth_view;
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
                engine.frame_tasks[reference.task.value];
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
                state.geometry_tasks[reference.task.value];
            return {
                geometry.sampled_colors[attachment_index],
                geometry.sampled_views[attachment_index],
            };
        };
        for (const TaskHandle handle : scene.tasks) {
            if (handle.value >= engine.frame_tasks.size()) {
                throw std::runtime_error(
                    "Scene frame task handle is invalid.");
            }
            const FrameTaskRecord& task =
                engine.frame_tasks[handle.value];
            if (task.kind == FrameTaskKind::render) {
                if (
                    task.render.target.value >=
                    engine.render_targets.size()) {
                    throw std::runtime_error(
                        "Render task target is invalid.");
                }
                const RenderTargetRecord& target_record =
                    engine.render_targets[task.render.target.value];
                DawnRenderTarget& target =
                    state.render_targets[task.render.target.value];
                DawnRenderTask& render_task =
                    state.render_tasks[handle.value];
                const std::uint32_t samples = target_record.swapchain
                    ? 1u
                    : task_sample_count(state, target_record.samples);
#if BBLITE_SHADOW_RECEIVERS
                if (
                    task.render.shadow_generator.value <
                        engine.shadow_generators.size()) {
                    if (!target_record.has_depth || !target.depth) {
                        throw std::runtime_error(
                            "Shadow render task has no depth attachment.");
                    }
                    WGPURenderPassDepthStencilAttachment
                        shadow_attachment{};
                    shadow_attachment.view = target.depth_view;
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
                    WGPURenderPassEncoder shadow_pass_encoder =
                        wgpuCommandEncoderBeginRenderPass(
                            encoder,
                            &shadow_descriptor);
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
                        esm_shadow_index);
                    draw_list_into(
                        shadow_pass_encoder,
                        render_task.draw_lists.transparent,
                        1u,
                        shadow_bound,
                        true,
                        render_task.pinned_frame_group,
                        true,
                        esm_shadow_index);
                    wgpuRenderPassEncoderEnd(shadow_pass_encoder);
                    wgpuRenderPassEncoderRelease(shadow_pass_encoder);
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
                    depth_attachment.view = target.depth_view;
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
                    WGPURenderPassEncoder task_pass =
                        wgpuCommandEncoderBeginRenderPass(
                            encoder,
                            &pass_descriptor);
                    if (!render_task.scene_group) {
                        WGPUBindGroupLayout scene_layout =
                            wgpuRenderPipelineGetBindGroupLayout(
                                depth_only_pipeline_for(
                                    state,
                                    false,
                                    samples),
                                1);
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
                        wgpuBindGroupLayoutRelease(scene_layout);
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
                                engine.materials[entry.material.value];
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
                                    engine.meshes[entry.mesh.value])) {
                                continue;
                            }
                            std::size_t mesh_index =
                                state.meshes.size();
                            for (std::size_t index = 0;
                                 index < render_plan.items.size();
                                 ++index) {
                                if (
                                    render_plan.items[index]
                                        .mesh.value ==
                                    entry.mesh.value) {
                                    mesh_index = index;
                                    break;
                                }
                            }
                            if (mesh_index >= state.meshes.size()) {
                                throw std::runtime_error(
                                    "Depth task mesh is not in the "
                                    "scene.");
                            }
                            DawnMesh& mesh = state.meshes[mesh_index];
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
                            wgpuRenderPassEncoderDrawIndexed(
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
                    wgpuRenderPassEncoderRelease(task_pass);
                    if (target_record.sampled_depth) {
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
                    depth_attachment.view = target.depth_view;
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
                WGPURenderPassEncoder task_pass =
                    wgpuCommandEncoderBeginRenderPass(
                        encoder,
                        &pass_descriptor);
                WGPURenderPipeline bound_pipeline = nullptr;
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
                            if (scene.environment.skybox_uses_environment) {
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
                                state.skybox_scene_group,
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
                            if (scene.environment.skybox_uses_environment) {
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
                            wgpuRenderPassEncoderDrawIndexed(
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
                            wgpuRenderPassEncoderDrawIndexed(
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
                            wgpuRenderPassEncoderDrawIndexed(
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
                    render_task.pinned_frame_group);
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
                    render_task.pinned_frame_group);
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
                    wgpuRenderPassEncoderDrawIndexed(
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
                wgpuRenderPassEncoderRelease(task_pass);
                continue;
            }
            if (task.kind == FrameTaskKind::geometry) {
                DawnGeometryTask& geometry =
                    state.geometry_tasks[handle.value];
                DawnRenderTask& render_task =
                    state.render_tasks[handle.value];
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
                WGPURenderPassEncoder task_pass =
                    wgpuCommandEncoderBeginRenderPass(
                        encoder,
                        &pass_descriptor);
                // Both are read only by the composed families' arms below,
                // so a scene reaching neither leaves them untouched.
                [[maybe_unused]] WGPURenderPipeline bound_pipeline = nullptr;
                const auto draw_geometry_list =
                    [&](const upstream::RenderDrawList& list) {
                        for (const upstream::RenderDrawCommand& draw :
                             list.commands) {
                            if (
                                draw.item_index >=
                                state.meshes.size()) {
                                continue;
                            }
                            [[maybe_unused]] DawnMesh& mesh =
                                state.meshes[draw.item_index];
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
                                        scene,
                                        engine,
                                        draw,
                                        static_cast<std::size_t>(
                                            task.geometry.shader_index),
                                        &geometry_key);
                                if (
                                    variant ==
                                    std::numeric_limits<
                                        std::size_t>::max()) {
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
                                    InstanceStreams{},
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
                                        scene,
                                        engine,
                                        draw,
                                        static_cast<std::size_t>(
                                            task.geometry.shader_index));
                                if (
                                    variant ==
                                    std::numeric_limits<
                                        std::size_t>::max()) {
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
                wgpuRenderPassEncoderRelease(task_pass);
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
                DawnEffectPass& pass = state.effect_tasks[handle.value];
                const RenderTargetRecord& target_record =
                    engine.render_targets[task.effect.target.value];
                DawnRenderTarget& target =
                    state.render_targets[task.effect.target.value];
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
                WGPURenderPassEncoder effect_pass =
                    wgpuCommandEncoderBeginRenderPass(encoder, &descriptor);
                record_dawn_effect_pass(effect_pass, pass);
                wgpuRenderPassEncoderEnd(effect_pass);
                wgpuRenderPassEncoderRelease(effect_pass);
                continue;
            }
#endif
#if defined(BBLITE_HAS_POST_PROCESS) && BBLITE_HAS_POST_PROCESS
            if (task.kind == FrameTaskKind::post_process) {
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
                }
                continue;
            }
#endif
            const CopyTaskOptions& copy = task.copy;
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
                    state.render_targets[copy.source.target.value];
                DawnRenderTarget& resolve_target =
                    state.render_targets[copy.resolve_target.value];
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
                WGPURenderPassEncoder resolve_pass =
                    wgpuCommandEncoderBeginRenderPass(
                        encoder,
                        &pass_descriptor);
                wgpuRenderPassEncoderEnd(resolve_pass);
                wgpuRenderPassEncoderRelease(resolve_pass);
                continue;
            }
            const RenderTargetRecord& target_record =
                engine.render_targets[copy.target.value];
            DawnRenderTarget& target =
                state.render_targets[copy.target.value];
            const auto [source_texture, source_view] =
                source_texture_view(copy.source);
            WGPURenderPassColorAttachment blit_attachment =
                WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
            blit_attachment.view = target_record.swapchain
                ? surface_view
                : target.color_view;
            blit_attachment.loadOp = copy.has_viewport
                ? WGPULoadOp_Load
                : WGPULoadOp_Clear;
            blit_attachment.storeOp = WGPUStoreOp_Store;
            WGPURenderPassDescriptor pass_descriptor =
                WGPU_RENDER_PASS_DESCRIPTOR_INIT;
            pass_descriptor.colorAttachmentCount = 1;
            pass_descriptor.colorAttachments = &blit_attachment;
            WGPURenderPassEncoder blit_pass =
                wgpuCommandEncoderBeginRenderPass(
                    encoder,
                    &pass_descriptor);
            const std::uint32_t blit_samples = target_record.swapchain
                ? 1u
                : task_sample_count(state, target_record.samples);
            WGPURenderPipeline blit_pipeline = blit_pipeline_for(
                state,
                state.surface_format,
                blit_samples);
            wgpuRenderPassEncoderSetPipeline(blit_pass, blit_pipeline);
            if (copy.has_viewport) {
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
                WGPUBindGroupLayout blit_layout =
                    wgpuRenderPipelineGetBindGroupLayout(
                        blit_pipeline,
                        2);
                std::array<WGPUBindGroupEntry, 2> blit_entries{};
                blit_entries[0] = WGPU_BIND_GROUP_ENTRY_INIT;
                blit_entries[0].binding = 0;
                blit_entries[0].textureView = source_view;
                blit_entries[1] = WGPU_BIND_GROUP_ENTRY_INIT;
                blit_entries[1].binding = 1;
                blit_entries[1].sampler = state.clamp_sampler;
                WGPUBindGroupDescriptor blit_descriptor =
                    WGPU_BIND_GROUP_DESCRIPTOR_INIT;
                blit_descriptor.layout = blit_layout;
                blit_descriptor.entryCount = blit_entries.size();
                blit_descriptor.entries = blit_entries.data();
                WGPUBindGroup blit_group = wgpuDeviceCreateBindGroup(
                    state.device,
                    &blit_descriptor);
                wgpuBindGroupLayoutRelease(blit_layout);
                wgpuRenderPassEncoderSetBindGroup(
                    blit_pass,
                    2,
                    blit_group,
                    0,
                    nullptr);
                wgpuRenderPassEncoderDraw(blit_pass, 3, 1, 0, 0);
                wgpuRenderPassEncoderEnd(blit_pass);
                wgpuRenderPassEncoderRelease(blit_pass);
                wgpuBindGroupRelease(blit_group);
            }
            if (target_record.swapchain) {
                capture_source = source_texture;
            }
        }
        }

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
                    engine.sprite_renderers[handle.value];
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
                WGPURenderPassEncoder sprite_encoder =
                    wgpuCommandEncoderBeginRenderPass(
                        encoder,
                        &sprite_descriptor);
                record_dawn_sprite_pass(
                    sprite_encoder,
                    engine,
                    state.sprite_passes[handle.value]);
                wgpuRenderPassEncoderEnd(sprite_encoder);
                wgpuRenderPassEncoderRelease(sprite_encoder);
            }
            capture_source = surface_texture.texture;
        }
#endif

        const bool capture_frame =
            capture_ready &&
            !captures.screenshot_saved &&
            !screenshot_path.empty();
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
        const UiRenderFrame& ui_frame =
            record_ui_rml_frame(*ui_runtime, width, height);
        const bool ui_after_capture_copy = capture_frame && !capture_ui;
        if (!ui_after_capture_copy) {
            render_ui_dawn_frame(
                state,
                encoder,
                surface_view,
                ui_frame);
            if (capture_frame && capture_ui) {
                capture_source = surface_texture.texture;
            }
        }
#endif
        WGPUBuffer readback = nullptr;
        const std::uint32_t bytes_per_row = (width * 4 + 255) & ~255u;
        if (capture_frame) {
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
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
        if (ui_after_capture_copy) {
            // Canvas-only attribution reads the surface before the native UI
            // is composited, then presents the UI normally.
            render_ui_dawn_frame(
                state,
                encoder,
                surface_view,
                ui_frame);
        }
#endif

        WGPUCommandBuffer command =
            wgpuCommandEncoderFinish(encoder, nullptr);
        wgpuQueueSubmit(state.queue, 1, &command);
        wgpuCommandBufferRelease(command);
        wgpuCommandEncoderRelease(encoder);

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
        if (readback) wgpuBufferRelease(readback);

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

        wgpuSurfacePresent(state.surface);
        if (benchmark && frame >= benchmark_warmup) {
            benchmark_samples.push_back(
                monotonic_milliseconds() - benchmark_start);
        }
        wgpuTextureViewRelease(surface_view);
        wgpuTextureRelease(surface_texture.texture);
        wgpuInstanceProcessEvents(state.instance);
        if (!state.uncaptured_error.empty()) {
            dawn_error("uncaptured error: " + state.uncaptured_error);
        }
        finish_frame(engine);
        ++frame;
    }
    report_benchmark(benchmark_samples, "Dawn", "D3D12");
#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
    ui_runtime.reset();
#endif
    SDL_DestroyWindow(state.window);
    state.window = nullptr;
    return true;
}

} // namespace bbl::pal

#endif
