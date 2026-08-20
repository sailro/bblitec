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

// The scene renderer needs a scene: its camera math and render plan are
// generated only for a scene that registers one. A sprite-only scene
// registers a SpriteRenderer instead and draws through
// `pal_dawn_sprite.cpp`, so this translation unit compiles to nothing.
#if defined(BBLITE_HAS_DAWN) && BBLITE_HAS_DAWN && \
    defined(BBLITE_HAS_PBR_RENDERER) && BBLITE_HAS_PBR_RENDERER

#include <bblite/upstream/camera_math.hpp>
#if defined(BBLITE_HAS_GEOMETRY_OUTPUT) && BBLITE_HAS_GEOMETRY_OUTPUT
#include <bblite/upstream/frame_graph_geometry.hpp>
#endif
#if defined(BBLITE_HAS_POST_PROCESS) && BBLITE_HAS_POST_PROCESS
#include <bblite/upstream/frame_graph_post_process.hpp>
#include <bblite/upstream/post_process_shaders.hpp>
#endif
#include <bblite/upstream/render_capabilities.hpp>
#include <bblite/upstream/renderer_plan.hpp>

#include "pal_camera_controls.hpp"
#include "pal_dawn_shared.hpp"
#if BBLITE_HAS_BILLBOARDS
#include "pal_dawn_billboard.hpp"
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
#include <stdexcept>
#include <string>
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

WGPUBlendFactor dawn_blend_factor(BlendFactor factor) {
    switch (factor) {
        case BlendFactor::one:
            return WGPUBlendFactor_One;
        case BlendFactor::src_alpha:
            return WGPUBlendFactor_SrcAlpha;
        case BlendFactor::one_minus_src_alpha:
            return WGPUBlendFactor_OneMinusSrcAlpha;
    }
    return WGPUBlendFactor_One;
}

// A shared blend tuple in this API's state; the operation is always add
// (`transparent_blend` / `ground_blend`, pal_gpu_shared.hpp).
WGPUBlendState blend_state_from(const BlendFactors& factors) {
    WGPUBlendState blend{};
    blend.color.operation = WGPUBlendOperation_Add;
    blend.color.srcFactor = dawn_blend_factor(factors.src_color);
    blend.color.dstFactor = dawn_blend_factor(factors.dst_color);
    blend.alpha.operation = WGPUBlendOperation_Add;
    blend.alpha.srcFactor = dawn_blend_factor(factors.src_alpha);
    blend.alpha.dstFactor = dawn_blend_factor(factors.dst_alpha);
    return blend;
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
    (BBLITE_MATERIAL_SPEC_GLOSS ? 1 : 0) +
    (BBLITE_MATERIAL_OCCLUSION_UV2 ? 1 : 0);
constexpr std::size_t material_extension_slot_base =
    5 + transmission_texture_slots;
// The Standard bump pair appends after everything the PBR path owns, so a
// scene that compiles it shifts no existing slot or binding index.
constexpr std::size_t standard_bump_slots =
    BBLITE_MATERIAL_STANDARD_BUMP ? 1 : 0;
constexpr std::size_t standard_bump_slot =
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

struct DawnMesh {
    WGPUBuffer vertices = nullptr;
    WGPUBuffer indices = nullptr;
    std::uint32_t index_count = 0;
    WGPUBuffer material_uniforms = nullptr;
    std::uint64_t material_uniform_size = 0;
#if BBLITE_PBR_VARIANTS > 0
    // The pin's own per-draw blocks and the group-1 bind group for the variant
    // this mesh composes. The material buffer is sized by that variant, which is
    // what makes it carry only the fields its own extensions contribute.
    WGPUBuffer pinned_mesh_uniforms = nullptr;
    WGPUBuffer pinned_material_uniforms = nullptr;
    WGPUBindGroup pinned_group = nullptr;
    std::size_t pinned_variant = std::numeric_limits<std::size_t>::max();
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
    // The Standard family's per-draw blocks and group-1 bind group, keyed
    // by (variant, unfilterable-emissive) exactly like the layout.
    WGPUBuffer standard_mesh_uniforms = nullptr;
    WGPUBuffer standard_material_uniforms = nullptr;
    WGPUBuffer standard_uv_uniforms = nullptr;
    WGPUBindGroup standard_group = nullptr;
    std::size_t standard_group_key =
        std::numeric_limits<std::size_t>::max();
    struct StandardGeometryDrawState {
        WGPUBuffer mesh_uniforms = nullptr;
        WGPUBuffer material_uniforms = nullptr;
        WGPUBuffer uv_uniforms = nullptr;
        WGPUBindGroup group = nullptr;
    };
    std::map<std::size_t, StandardGeometryDrawState>
        standard_geometry_states;
#endif
#if BBLITE_NODE_VARIANTS > 0
    // A node graph's per-draw blocks: the pin's own mesh block, and the
    // graph's uniform block when it declares one. Both are written once —
    // the mesh block follows the mesh's transform, and the uniform block is
    // the graph's own constants.
    WGPUBuffer node_mesh_uniforms = nullptr;
    WGPUBuffer node_uniforms = nullptr;
    WGPUBindGroup node_group = nullptr;
    std::size_t node_group_variant =
        std::numeric_limits<std::size_t>::max();
#endif
    std::array<WGPUTexture, mesh_texture_slots> owned_textures{};
    std::array<WGPUTextureView, mesh_texture_slots> owned_views{};
    std::array<WGPUTextureView, mesh_texture_slots> views{};
    std::array<WGPUSampler, mesh_texture_slots> samplers{};
    // Standard-material `.babylon` reflection cube view, non-owning
    // (points into DawnState::reflection_cube_views).
    WGPUTextureView reflection = nullptr;
    // Alpha-card shader vertex uniforms (center/angle/depth).
    WGPUBuffer shader_vertex_uniforms = nullptr;
    // Frame-graph source texture bound in the standard-emissive slot
    // (non-owning; resolved once frame-graph textures exist).
    WGPUTextureView emissive_render_view = nullptr;
    std::uint64_t transform_version = 0;
#if BBLITE_GPU_DEFORMATION
    WGPUBuffer deformation_uniforms = nullptr;
#endif
#if BBLITE_GPU_INSTANCING
    WGPUBuffer instances = nullptr;
    WGPUBuffer instance_uniform = nullptr;
    std::uint32_t instance_count = 1;
    std::uint64_t instance_version = 0;
#endif
#if BBLITE_PBR_VARIANTS > 0
    // The geometry-output MRT arms' per-variant draw state: a mesh drawn in
    // the main pass and in two geometry tasks holds three live bind groups
    // at encode time, so these are keyed by variant beside `pinned_group`.
    struct PinnedGeometryDrawState {
        WGPUBindGroup group = nullptr;
        WGPUBuffer mesh_uniforms = nullptr;
        WGPUBuffer material_uniforms = nullptr;
    };
    std::map<std::size_t, PinnedGeometryDrawState> pinned_geometry_states;
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
    /** Borrowed from `DawnState::post_process_programs`, which owns it. */
    const DawnPostProcessProgram* program = nullptr;
    WGPUBindGroup group = nullptr;
    WGPUBuffer uniforms = nullptr;
};
#endif

struct DawnState : DawnDevice {
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
#if BBLITE_HAS_BILLBOARDS
    std::vector<DawnBillboardPass> billboard_passes;
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
        frame_graph_width = 0;
        frame_graph_height = 0;
    }

    // Runtime scene mutation rebuilds the mesh set; the GPU must be
    // idle before release (the frame loop waits on submitted work).
    void release_meshes() {
        for (DawnMesh& mesh : meshes) {
            for (std::size_t slot = 0;
                 slot < mesh_texture_slots;
                 ++slot) {
                if (mesh.owned_views[slot]) {
                    wgpuTextureViewRelease(mesh.owned_views[slot]);
                }
                if (mesh.owned_textures[slot]) {
                    wgpuTextureRelease(mesh.owned_textures[slot]);
                }
                if (mesh.samplers[slot]) {
                    wgpuSamplerRelease(mesh.samplers[slot]);
                }
            }
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
            if (mesh.pinned_group) wgpuBindGroupRelease(mesh.pinned_group);
            if (mesh.pinned_mesh_uniforms) {
                wgpuBufferRelease(mesh.pinned_mesh_uniforms);
            }
            if (mesh.pinned_material_uniforms) {
                wgpuBufferRelease(mesh.pinned_material_uniforms);
            }
            mesh.pinned_group = nullptr;
            mesh.pinned_mesh_uniforms = nullptr;
            mesh.pinned_material_uniforms = nullptr;
            for (auto& [variant, draw_state] :
                 mesh.pinned_geometry_states) {
                if (draw_state.group) {
                    wgpuBindGroupRelease(draw_state.group);
                }
                if (draw_state.mesh_uniforms) {
                    wgpuBufferRelease(draw_state.mesh_uniforms);
                }
                if (draw_state.material_uniforms) {
                    wgpuBufferRelease(draw_state.material_uniforms);
                }
            }
            mesh.pinned_geometry_states.clear();
#endif
#if BBLITE_STANDARD_VARIANTS > 0
            for (auto& [variant, draw_state] :
                 mesh.standard_geometry_states) {
                if (draw_state.group) {
                    wgpuBindGroupRelease(draw_state.group);
                }
                if (draw_state.mesh_uniforms) {
                    wgpuBufferRelease(draw_state.mesh_uniforms);
                }
            }
            mesh.standard_geometry_states.clear();
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
            if (mesh.vertices) wgpuBufferRelease(mesh.vertices);
            if (mesh.indices) wgpuBufferRelease(mesh.indices);
        }
        meshes.clear();
    }

    ~DawnState() {
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
        if (mesh_pipeline_layout) {
            wgpuPipelineLayoutRelease(mesh_pipeline_layout);
        }
        for (WGPUBindGroupLayout layout : mesh_group_layouts) {
            if (layout) wgpuBindGroupLayoutRelease(layout);
        }
        release_meshes();
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

WGPUTexture upload_material_texture(
    DawnState& state,
    const TextureData& texture_data,
    bool srgb,
    const std::array<std::uint8_t, 4>& fallback,
    std::uint32_t& out_mip_count) {
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
                // pinned uploadCubemapRGBD (BJS invertY cubemaps).
                int face_width = 0;
                int face_height = 0;
                const std::vector<float> pixels =
                    decode_rgbd(face_data, face_width, face_height);
                half_pixels.resize(pixels.size());
                const std::size_t row_floats =
                    static_cast<std::size_t>(face_width) * 4;
                for (int row = 0; row < face_height; ++row) {
                    const std::size_t source_row =
                        static_cast<std::size_t>(
                            face_height - row - 1);
                    for (std::size_t column = 0;
                         column < row_floats;
                         ++column) {
                        half_pixels[
                            static_cast<std::size_t>(row) * row_floats +
                            column] = float_to_half(
                            pixels[source_row * row_floats + column]);
                    }
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
        const std::vector<float> pixels =
            decode_rgbd(environment.brdf_lut, lut_width, lut_height);
        width = static_cast<std::uint32_t>(lut_width);
        height = static_cast<std::uint32_t>(lut_height);
        half_pixels.reserve(pixels.size());
        for (const float value : pixels) {
            half_pixels.push_back(float_to_half(value));
        }
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
            target.depth = create_frame_texture(
                state,
                WGPUTextureFormat_Depth24PlusStencil8,
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
    bool grid = false;
    // Generated shader-variant kinds: the concrete modules and
    // fixed-function state come from the emitted variant table.
    bool shader = false;
    bool shader_a2c = false;
};

PipelineKindTraits pipeline_traits(upstream::RenderPipelineKind kind) {
    using Kind = upstream::RenderPipelineKind;
    switch (kind) {
        case Kind::standard_opaque_back:
            return {true, false, WGPUCullMode_Back, WGPUFrontFace_CCW};
        case Kind::standard_opaque_none:
            return {true, false, WGPUCullMode_None, WGPUFrontFace_CCW};
        case Kind::pbr_opaque_back:
            return {false, false, WGPUCullMode_Back, WGPUFrontFace_CCW};
        case Kind::pbr_opaque_none:
            return {false, false, WGPUCullMode_None, WGPUFrontFace_CCW};
        case Kind::pbr_opaque_none_clockwise:
            return {false, false, WGPUCullMode_None, WGPUFrontFace_CW};
        case Kind::standard_transparent_back:
            return {true, true, WGPUCullMode_Back, WGPUFrontFace_CCW};
        case Kind::standard_transparent_none:
            return {true, true, WGPUCullMode_None, WGPUFrontFace_CCW};
        case Kind::pbr_transparent_back:
            return {false, true, WGPUCullMode_Back, WGPUFrontFace_CCW};
        case Kind::pbr_transparent_none:
            return {false, true, WGPUCullMode_None, WGPUFrontFace_CCW};
        case Kind::pbr_transparent_none_clockwise:
            return {false, true, WGPUCullMode_None, WGPUFrontFace_CW};
        case Kind::grid_opaque_back:
            return {
                false, false, WGPUCullMode_Back, WGPUFrontFace_CCW,
                true};
        case Kind::grid_opaque_none:
            return {
                false, false, WGPUCullMode_None, WGPUFrontFace_CCW,
                true};
        case Kind::grid_transparent_back:
            return {
                false, true, WGPUCullMode_Back, WGPUFrontFace_CCW,
                true};
        case Kind::grid_transparent_none:
            return {
                false, true, WGPUCullMode_None, WGPUFrontFace_CCW,
                true};
        case Kind::shader: {
            PipelineKindTraits traits;
            traits.shader = true;
            return traits;
        }
        case Kind::shader_a2c: {
            PipelineKindTraits traits;
            traits.shader = true;
            traits.shader_a2c = true;
            return traits;
        }
        default:
            dawn_error(
                "render pipeline kind " +
                std::to_string(static_cast<int>(kind)) +
                " is not implemented yet.");
    }
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
        const upstream::PbrVariantBinding& binding =
            upstream::pbr_variant_bindings[entry.first_binding + index];
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
        if (binding.kind == upstream::PbrBindingKind::sampler) {
            layout_entry.sampler.type = WGPUSamplerBindingType_Filtering;
        } else if (
            binding.kind == upstream::PbrBindingKind::storageBuffer) {
            // The morph arms' deltas and weights.
            layout_entry.buffer.type =
                WGPUBufferBindingType_ReadOnlyStorage;
        } else if (
            binding.kind == upstream::PbrBindingKind::uniformBuffer) {
            // A group-1 uniform block past mesh and material: the geometry
            // arms' gpUniforms.
            layout_entry.buffer.type = WGPUBufferBindingType_Uniform;
        } else {
            // An rgba32float texture read with textureLoad cannot be bound as
            // filterable; the pin's bone palette is exactly that.
            layout_entry.texture.sampleType =
                binding.kind == upstream::PbrBindingKind::texture2dLoad
                    ? WGPUTextureSampleType_UnfilterableFloat
                    : WGPUTextureSampleType_Float;
            layout_entry.texture.viewDimension =
                binding.kind == upstream::PbrBindingKind::textureCube
                    ? WGPUTextureViewDimension_Cube
                    : WGPUTextureViewDimension_2D;
        }
        entries.push_back(layout_entry);
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

WGPUPipelineLayout pinned_pipeline_layout_for(
    DawnState& state,
    std::size_t variant) {
    if (state.pinned_pipeline_layouts.size() < upstream::pbr_variants.size()) {
        state.pinned_pipeline_layouts.resize(
            upstream::pbr_variants.size(),
            nullptr);
    }
    if (state.pinned_pipeline_layouts[variant]) {
        return state.pinned_pipeline_layouts[variant];
    }
    std::array<WGPUBindGroupLayout, 2> groups{
        pinned_frame_layout_for(state),
        pinned_draw_layout_for(state, variant),
    };
    WGPUPipelineLayoutDescriptor descriptor =
        WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
    descriptor.bindGroupLayoutCount = groups.size();
    descriptor.bindGroupLayouts = groups.data();
    state.pinned_pipeline_layouts[variant] =
        wgpuDeviceCreatePipelineLayout(state.device, &descriptor);
    if (!state.pinned_pipeline_layouts[variant]) {
        dawn_error("pinned variant pipeline layout creation failed.");
    }
    return state.pinned_pipeline_layouts[variant];
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
void write_pinned_geometry_prologue(
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
PinnedResource state_resource_for(
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
    WGPUBuffer geometry_params) {
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
        const upstream::PbrVariantBinding& binding =
            upstream::pbr_variant_bindings[entry.first_binding + index];
        WGPUBindGroupEntry group_entry = WGPU_BIND_GROUP_ENTRY_INIT;
        group_entry.binding = binding.binding;
        if (binding.kind == upstream::PbrBindingKind::uniformBuffer) {
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
        if (binding.kind == upstream::PbrBindingKind::storageBuffer) {
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
        if (binding.kind == upstream::PbrBindingKind::sampler) {
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

/** The per-draw buffers and group-1 bind group for a mesh's own variant. */
void ensure_pinned_draw_bindings(
    DawnState& state,
    DawnMesh& mesh,
    std::size_t variant) {
    if (mesh.pinned_group && mesh.pinned_variant == variant) return;
    if (mesh.pinned_group) wgpuBindGroupRelease(mesh.pinned_group);
    mesh.pinned_group = nullptr;
    const upstream::PbrVariantEntry& entry = upstream::pbr_variants[variant];
    const auto uniform_buffer = [&](std::size_t size) {
        WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
        descriptor.size = static_cast<std::uint64_t>(size);
        descriptor.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
        WGPUBuffer buffer = wgpuDeviceCreateBuffer(state.device, &descriptor);
        if (!buffer) dawn_error("pinned draw buffer creation failed.");
        return buffer;
    };
    if (!mesh.pinned_mesh_uniforms) {
        mesh.pinned_mesh_uniforms =
            uniform_buffer(sizeof(upstream::MeshUniforms));
    }
    // Sized by the variant, so a swap to one with more fields reallocates.
    if (mesh.pinned_material_uniforms) {
        wgpuBufferRelease(mesh.pinned_material_uniforms);
    }
    mesh.pinned_material_uniforms =
        uniform_buffer(entry.material_ubo_bytes);
    mesh.pinned_group = build_pinned_draw_group(
        state,
        mesh,
        variant,
        mesh.pinned_mesh_uniforms,
        mesh.pinned_material_uniforms,
        nullptr);
    mesh.pinned_variant = variant;
}

/**
 * The per-draw buffers and group-1 bind group for one geometry-output MRT
 * variant of a mesh, keyed by variant beside the main `pinned_group`: the
 * encoder references the main group and every geometry group of a mesh in
 * the same frame, so none can replace another.
 */
DawnMesh::PinnedGeometryDrawState& ensure_pinned_geometry_bindings(
    DawnState& state,
    DawnMesh& mesh,
    std::size_t variant,
    WGPUBuffer geometry_params) {
    auto existing = mesh.pinned_geometry_states.find(variant);
    if (existing != mesh.pinned_geometry_states.end()) {
        return existing->second;
    }
    DawnMesh::PinnedGeometryDrawState draw_state{};
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
                record),
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
            const std::size_t variant = pinned_variant_for_draw(
                scene,
                engine,
                draw,
                static_cast<std::size_t>(task.geometry.shader_index));
            if (variant == std::numeric_limits<std::size_t>::max()) {
                dawn_error(
                    ("PBR draw for mesh " +
                     std::to_string(draw.item.mesh.value) +
                     ", material " +
                     std::to_string(draw.item.material.value) +
                     " resolves no pinned variant in a geometry task.")
                        .c_str());
            }
            DawnMesh& mesh = state.meshes[draw.item_index];
            DawnMesh::PinnedGeometryDrawState& draw_state =
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
 * One composed-variant draw, encoded the same way at all four sites (PBR
 * and Standard, main pass and geometry task): bind the pipeline unless
 * already bound, the frame group at 0 and the draw group at 1, the
 * vertex stream (plus the optional thin-instance stream at slot 1), then
 * the indexed draw. Which pipeline, groups, buffers and counts go in
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
    WGPUBuffer instance_buffer,
    std::uint32_t instance_count,
    WGPUBuffer index_buffer,
    std::uint32_t index_count) {
    if (pipeline != bound_pipeline) {
        wgpuRenderPassEncoderSetPipeline(pass, pipeline);
        bound_pipeline = pipeline;
    }
    wgpuRenderPassEncoderSetBindGroup(pass, 0, frame_group, 0, nullptr);
    wgpuRenderPassEncoderSetBindGroup(pass, 1, draw_group, 0, nullptr);
    wgpuRenderPassEncoderSetVertexBuffer(
        pass,
        0,
        vertex_buffer,
        0,
        WGPU_WHOLE_SIZE);
    if (instance_buffer) {
        wgpuRenderPassEncoderSetVertexBuffer(
            pass,
            1,
            instance_buffer,
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
        instance_count,
        0,
        0,
        0);
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
        const upstream::StandardVariantBinding& binding =
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
        const upstream::StandardVariantBinding& binding =
            upstream::standard_variant_bindings[
                entry.first_binding + index];
        WGPUBindGroupLayoutEntry layout_entry =
            WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
        layout_entry.binding = binding.binding;
        layout_entry.visibility = 0;
        if (binding.vertex) layout_entry.visibility |= WGPUShaderStage_Vertex;
        if (binding.fragment) {
            layout_entry.visibility |= WGPUShaderStage_Fragment;
        }
        const bool depth_emissive = unfilterable_emissive &&
            (binding.name == "eT" || binding.name == "eS");
        if (binding.kind == upstream::StandardBindingKind::sampler) {
            layout_entry.sampler.type = depth_emissive
                ? WGPUSamplerBindingType_NonFiltering
                : WGPUSamplerBindingType_Filtering;
        } else if (
            binding.kind ==
            upstream::StandardBindingKind::storageBuffer) {
            layout_entry.buffer.type =
                WGPUBufferBindingType_ReadOnlyStorage;
        } else if (
            binding.kind ==
            upstream::StandardBindingKind::uniformBuffer) {
            // The vertex `up` block, the geometry arms' gpUniforms, and a
            // displaced `mat`/`mesh` block riding a reflected row.
            layout_entry.buffer.type = WGPUBufferBindingType_Uniform;
        } else {
            layout_entry.texture.sampleType =
                binding.kind ==
                        upstream::StandardBindingKind::texture2dLoad ||
                    depth_emissive
                    ? WGPUTextureSampleType_UnfilterableFloat
                    : WGPUTextureSampleType_Float;
            layout_entry.texture.viewDimension =
                binding.kind ==
                        upstream::StandardBindingKind::textureCube
                    ? WGPUTextureViewDimension_Cube
                    : WGPUTextureViewDimension_2D;
        }
        entries.push_back(layout_entry);
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
    const std::size_t key = variant * 2 + (unfilterable_emissive ? 1 : 0);
    if (
        state.standard_pipeline_layouts.size() <
        upstream::standard_variants.size() * 2) {
        state.standard_pipeline_layouts.resize(
            upstream::standard_variants.size() * 2,
            nullptr);
    }
    if (state.standard_pipeline_layouts[key]) {
        return state.standard_pipeline_layouts[key];
    }
    std::array<WGPUBindGroupLayout, 2> groups{
        pinned_frame_layout_for(state),
        standard_draw_layout_for(state, variant, unfilterable_emissive),
    };
    WGPUPipelineLayoutDescriptor descriptor =
        WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
    descriptor.bindGroupLayoutCount = groups.size();
    descriptor.bindGroupLayouts = groups.data();
    state.standard_pipeline_layouts[key] =
        wgpuDeviceCreatePipelineLayout(state.device, &descriptor);
    if (!state.standard_pipeline_layouts[key]) {
        dawn_error("standard variant pipeline layout creation failed.");
    }
    return state.standard_pipeline_layouts[key];
}

/** The group-1 bind group for one Standard variant of a mesh. */
WGPUBindGroup build_standard_draw_group(
    DawnState& state,
    DawnMesh& mesh,
    const MaterialRecord* material,
    std::size_t variant,
    WGPUBuffer mesh_uniforms,
    WGPUBuffer material_uniforms,
    WGPUBuffer uv_uniforms,
    WGPUBuffer geometry_params,
    WGPUTextureView emissive_render_view) {
    const bool unfilterable_emissive = emissive_render_view != nullptr;
    const upstream::StandardVariantEntry& entry =
        upstream::standard_variants[variant];
    // The fixed mesh@0/material@1 entries yield to reflected rows exactly
    // as the layout's do — a morph variant's storage pair occupies
    // binding 1 and its `mat` block rides a reflected row instead.
    bool rows_occupy_binding_0 = false;
    bool rows_occupy_binding_1 = false;
    for (std::size_t index = 0; index < entry.binding_count; ++index) {
        const upstream::StandardVariantBinding& binding =
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
        const upstream::StandardVariantBinding& binding =
            upstream::standard_variant_bindings[
                entry.first_binding + index];
        WGPUBindGroupEntry group_entry = WGPU_BIND_GROUP_ENTRY_INIT;
        group_entry.binding = binding.binding;
        if (binding.kind == upstream::StandardBindingKind::uniformBuffer) {
            if (binding.name == "up") {
                group_entry.buffer = uv_uniforms;
                group_entry.size =
                    sizeof(upstream::StandardUvTransformUniforms);
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
            } else {
                dawn_error(
                    ("standard variant declares an unmapped uniform "
                     "block '" + std::string(binding.name) + "'.")
                        .c_str());
            }
            entries.push_back(group_entry);
            continue;
        }
        if (binding.kind == upstream::StandardBindingKind::storageBuffer) {
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
        if (binding.kind == upstream::StandardBindingKind::sampler) {
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
void ensure_standard_draw_buffers(DawnState& state, DawnMesh& mesh) {
    const auto uniform_buffer = [&](std::size_t size) {
        WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
        descriptor.size = static_cast<std::uint64_t>(size);
        descriptor.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
        WGPUBuffer buffer = wgpuDeviceCreateBuffer(state.device, &descriptor);
        if (!buffer) dawn_error("standard draw buffer creation failed.");
        return buffer;
    };
    if (!mesh.standard_mesh_uniforms) {
        mesh.standard_mesh_uniforms =
            uniform_buffer(sizeof(upstream::MeshUniforms));
    }
    if (!mesh.standard_material_uniforms) {
        mesh.standard_material_uniforms =
            uniform_buffer(upstream::standard_material_ubo_bytes);
    }
    if (!mesh.standard_uv_uniforms) {
        mesh.standard_uv_uniforms =
            uniform_buffer(sizeof(upstream::StandardUvTransformUniforms));
    }
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
    WGPUBuffer uv_uniforms) {
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
            standard_draw_world(record, entry.uses_local_position),
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
            ensure_standard_draw_buffers(state, mesh);
            DawnMesh::StandardGeometryDrawState& draw_state =
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
                mesh.standard_material_uniforms,
                mesh.standard_uv_uniforms);
            if (!draw_state.group) {
                draw_state.group = build_standard_draw_group(
                    state,
                    mesh,
                    material,
                    variant,
                    draw_state.mesh_uniforms,
                    mesh.standard_material_uniforms,
                    mesh.standard_uv_uniforms,
                    geometry.pinned_geometry_params,
                    nullptr);
            }
        }
    }
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
    std::array<WGPUVertexBufferLayout, 2> vertex_layouts{};
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

    descriptor.primitive.topology =
        WGPUPrimitiveTopology_TriangleList;
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
    // Alpha-to-coverage needs samples to spread coverage across; at one
    // sample WebGPU rejects the pipeline outright.
    descriptor.multisample.alphaToCoverageEnabled =
        traits.shader_a2c && samples > 1;

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
/**
 * One declared vertex input, resolved onto our vertex and into Dawn's format
 * enum. The three composed families ask the same question of the same table
 * (`pinned_vertex_input`); what stays here is the enum residue and the split
 * between the vertex stream and the thin-instance one.
 */
bool append_variant_attribute(
    std::string_view name,
    std::uint32_t location,
    bool uses_local_position,
    std::vector<WGPUVertexAttribute>& attributes,
    std::vector<WGPUVertexAttribute>& instance_attributes) {
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
    (input.instance_stream ? instance_attributes : attributes)
        .push_back(attribute);
    return true;
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
    const FrameTaskRecord* geometry_task = nullptr) {
    // The same traits the transcribed pipeline reads, from the same kind. The
    // winding matters: a mesh whose node matrix mirrors draws through
    // `pbr_*_none_clockwise`, and hardcoding counter-clockwise here inverted
    // Scene 168's double-sided faces and Scene 266's negative-scale spheres.
    const PipelineKindTraits traits = pipeline_traits(kind);
    const std::size_t key = variant * 64 +
        static_cast<std::size_t>(kind) * 2 + (has_depth ? 1 : 0);
    auto& map = state.pinned_variant_pipelines[samples];
    const auto existing = map.find(key);
    if (existing != map.end()) return existing->second;
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
    std::vector<WGPUVertexAttribute> attributes;
    // The pin's thin-instance arm reads the per-instance matrix as four vec4
    // columns from a second, instance-stepped stream.
    std::vector<WGPUVertexAttribute> instance_attributes;
    attributes.reserve(entry.attribute_count);
    for (std::size_t index = 0; index < entry.attribute_count; ++index) {
        const upstream::PbrVariantAttribute& input =
            upstream::pbr_variant_attributes[entry.first_attribute + index];
        if (
            !append_variant_attribute(
                input.name,
                input.location,
                entry.uses_local_position,
                attributes,
                instance_attributes)) {
            dawn_error(
                (std::string("pinned variant declares an unmapped vertex ") +
                 "input '" + std::string(input.name) + "'.")
                    .c_str());
        }
    }
    std::array<WGPUVertexBufferLayout, 2> vertex_layouts{};
    vertex_layouts[0].stepMode = WGPUVertexStepMode_Vertex;
    vertex_layouts[0].arrayStride = sizeof(GpuVertex);
    vertex_layouts[0].attributeCount = attributes.size();
    vertex_layouts[0].attributes = attributes.data();
    vertex_layouts[1].stepMode = WGPUVertexStepMode_Instance;
    vertex_layouts[1].arrayStride = sizeof(std::array<float, 16>);
    vertex_layouts[1].attributeCount = instance_attributes.size();
    vertex_layouts[1].attributes = instance_attributes.data();

    WGPURenderPipelineDescriptor descriptor =
        WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    descriptor.layout = pinned_pipeline_layout_for(state, variant);
    descriptor.vertex.module = state.pinned_vertex_modules[variant];
    descriptor.vertex.entryPoint = string_view("main");
    descriptor.vertex.bufferCount = instance_attributes.empty() ? 1 : 2;
    descriptor.vertex.buffers = vertex_layouts.data();
    descriptor.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    descriptor.primitive.frontFace = traits.front;
    descriptor.primitive.cullMode = traits.cull;
    WGPUDepthStencilState depth_stencil = WGPU_DEPTH_STENCIL_STATE_INIT;
    depth_stencil.format = WGPUTextureFormat_Depth24PlusStencil8;
    // A no-color view draws in the depth-only tasks, which write depth
    // whatever the material's own alpha would have said.
    depth_stencil.depthWriteEnabled =
        !entry.no_color_output && traits.transparent
            ? WGPUOptionalBool_False
            : WGPUOptionalBool_True;
    depth_stencil.depthCompare =
        dawn_depth_compare(upstream::pinned_depth_compare);
    descriptor.depthStencil = has_depth ? &depth_stencil : nullptr;
    descriptor.multisample.count = samples;
    descriptor.multisample.mask = ~0u;
    WGPUColorTargetState color_target = WGPU_COLOR_TARGET_STATE_INIT;
    color_target.format = state.frame_color_format;
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
    // one target per attachment in the task's formats plus the optional
    // trailing colour, with depth writes forced on.
    std::vector<WGPUColorTargetState> geometry_targets;
    if (geometry_task) {
        geometry_targets.reserve(
            geometry_task->geometry.attachments.size() + 1u);
        for (const GeometryTextureDescription& description :
             geometry_task->geometry.attachments) {
            WGPUColorTargetState target = WGPU_COLOR_TARGET_STATE_INIT;
            target.format = geometry_texture_format(description);
            if (traits.transparent) target.blend = &blend;
            geometry_targets.push_back(target);
        }
        if (geometry_task->geometry.target.value != invalid_handle) {
            WGPUColorTargetState target = WGPU_COLOR_TARGET_STATE_INIT;
            target.format = state.frame_color_format;
            if (traits.transparent) target.blend = &blend;
            geometry_targets.push_back(target);
        }
        if (geometry_targets.size() != entry.color_target_count) {
            dawn_error(
                ("pinned geometry variant writes " +
                 std::to_string(entry.color_target_count) +
                 " targets where its task carries " +
                 std::to_string(geometry_targets.size()) + ".")
                    .c_str());
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
    const FrameTaskRecord* geometry_task = nullptr) {
    const PipelineKindTraits traits = pipeline_traits(kind);
    const std::size_t key = variant * 256 +
        static_cast<std::size_t>(kind) * 4 +
        (has_depth ? 2 : 0) + (unfilterable_emissive ? 1 : 0);
    auto& map = state.standard_variant_pipelines[samples];
    const auto existing = map.find(key);
    if (existing != map.end()) return existing->second;
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
    std::vector<WGPUVertexAttribute> attributes;
    std::vector<WGPUVertexAttribute> instance_attributes;
    attributes.reserve(entry.attribute_count);
    for (std::size_t index = 0; index < entry.attribute_count; ++index) {
        const upstream::StandardVariantAttribute& input =
            upstream::standard_variant_attributes[entry.first_attribute + index];
        if (
            !append_variant_attribute(
                input.name,
                input.location,
                entry.uses_local_position,
                attributes,
                instance_attributes)) {
            dawn_error(
                (std::string("standard variant declares an unmapped vertex ") +
                 "input '" + std::string(input.name) + "'.")
                    .c_str());
        }
    }
    std::array<WGPUVertexBufferLayout, 2> vertex_layouts{};
    vertex_layouts[0].stepMode = WGPUVertexStepMode_Vertex;
    vertex_layouts[0].arrayStride = sizeof(GpuVertex);
    vertex_layouts[0].attributeCount = attributes.size();
    vertex_layouts[0].attributes = attributes.data();
    vertex_layouts[1].stepMode = WGPUVertexStepMode_Instance;
    vertex_layouts[1].arrayStride = sizeof(std::array<float, 16>);
    vertex_layouts[1].attributeCount = instance_attributes.size();
    vertex_layouts[1].attributes = instance_attributes.data();
    WGPURenderPipelineDescriptor descriptor =
        WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    descriptor.layout = standard_pipeline_layout_for(
        state,
        variant,
        unfilterable_emissive);
    descriptor.vertex.module = state.standard_vertex_modules[variant];
    descriptor.vertex.entryPoint = string_view("main");
    descriptor.vertex.bufferCount = instance_attributes.empty() ? 1 : 2;
    descriptor.vertex.buffers = vertex_layouts.data();
    descriptor.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    descriptor.primitive.frontFace = WGPUFrontFace_CCW;
    descriptor.primitive.cullMode = traits.cull;
    WGPUDepthStencilState depth_stencil = WGPU_DEPTH_STENCIL_STATE_INIT;
    depth_stencil.format = WGPUTextureFormat_Depth24PlusStencil8;
    depth_stencil.depthWriteEnabled =
        !entry.no_color_output && traits.transparent
            ? WGPUOptionalBool_False
            : WGPUOptionalBool_True;
    depth_stencil.depthCompare =
        dawn_depth_compare(upstream::pinned_depth_compare);
    descriptor.depthStencil = has_depth ? &depth_stencil : nullptr;
    descriptor.multisample.count = samples;
    descriptor.multisample.mask = ~0u;
    WGPUColorTargetState color_target = WGPU_COLOR_TARGET_STATE_INIT;
    color_target.format = state.frame_color_format;
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
    std::vector<WGPUColorTargetState> geometry_targets;
    if (geometry_task) {
        geometry_targets.reserve(
            geometry_task->geometry.attachments.size() + 1u);
        for (const GeometryTextureDescription& description :
             geometry_task->geometry.attachments) {
            WGPUColorTargetState target = WGPU_COLOR_TARGET_STATE_INIT;
            target.format = geometry_texture_format(description);
            if (traits.transparent) target.blend = &blend;
            geometry_targets.push_back(target);
        }
        if (geometry_task->geometry.target.value != invalid_handle) {
            WGPUColorTargetState target = WGPU_COLOR_TARGET_STATE_INIT;
            target.format = state.frame_color_format;
            if (traits.transparent) target.blend = &blend;
            geometry_targets.push_back(target);
        }
        if (geometry_targets.size() != entry.color_target_count) {
            dawn_error(
                ("standard geometry variant writes " +
                 std::to_string(entry.color_target_count) +
                 " targets where its task carries " +
                 std::to_string(geometry_targets.size()) + ".")
                    .c_str());
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
    std::size_t variant) {
    if (state.node_draw_layouts.size() < upstream::node_variants.size()) {
        state.node_draw_layouts.resize(
            upstream::node_variants.size(),
            nullptr);
    }
    if (state.node_draw_layouts[variant]) {
        return state.node_draw_layouts[variant];
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
    WGPUBindGroupLayoutDescriptor descriptor =
        WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
    descriptor.label = string_view("node-mesh");
    descriptor.entryCount = entries.size();
    descriptor.entries = entries.data();
    state.node_draw_layouts[variant] =
        wgpuDeviceCreateBindGroupLayout(state.device, &descriptor);
    if (!state.node_draw_layouts[variant]) {
        dawn_error("node variant bind group layout creation failed.");
    }
    return state.node_draw_layouts[variant];
}

WGPUPipelineLayout node_pipeline_layout_for(
    DawnState& state,
    std::size_t variant) {
    if (state.node_pipeline_layouts.size() < upstream::node_variants.size()) {
        state.node_pipeline_layouts.resize(
            upstream::node_variants.size(),
            nullptr);
    }
    if (state.node_pipeline_layouts[variant]) {
        return state.node_pipeline_layouts[variant];
    }
    std::array<WGPUBindGroupLayout, 2> groups{
        pinned_frame_layout_for(state),
        node_draw_layout_for(state, variant),
    };
    WGPUPipelineLayoutDescriptor descriptor =
        WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
    descriptor.bindGroupLayoutCount = groups.size();
    descriptor.bindGroupLayouts = groups.data();
    state.node_pipeline_layouts[variant] =
        wgpuDeviceCreatePipelineLayout(state.device, &descriptor);
    if (!state.node_pipeline_layouts[variant]) {
        dawn_error("node variant pipeline layout creation failed.");
    }
    return state.node_pipeline_layouts[variant];
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
    bool has_depth) {
    const std::size_t key =
        variant * 256 + static_cast<std::size_t>(kind) * 2 +
        (has_depth ? 1 : 0);
    auto& map = state.node_variant_pipelines[samples];
    const auto existing = map.find(key);
    if (existing != map.end()) return existing->second;
    if (state.node_vertex_modules.size() < upstream::node_variants.size()) {
        state.node_vertex_modules.resize(
            upstream::node_variants.size(),
            nullptr);
        state.node_fragment_modules.resize(
            upstream::node_variants.size(),
            nullptr);
    }
    const upstream::NodeVariantEntry& entry =
        upstream::node_variants[variant];
    if (!state.node_vertex_modules[variant]) {
        state.node_vertex_modules[variant] =
            load_wgsl_module(state, std::string(entry.vertex_stem).c_str());
        state.node_fragment_modules[variant] = load_wgsl_module(
            state,
            std::string(entry.fragment_stem).c_str());
    }
    std::vector<WGPUVertexAttribute> attributes;
    // A node graph declaring the thin-instance columns would need a second
    // stream this pipeline does not bind, so the shared table's own marking
    // is what refuses it.
    std::vector<WGPUVertexAttribute> instance_attributes;
    attributes.reserve(entry.attribute_count);
    for (std::size_t index = 0; index < entry.attribute_count; ++index) {
        const upstream::NodeVariantAttribute& input =
            upstream::node_variant_attributes[entry.first_attribute + index];
        if (
            !append_variant_attribute(
                input.name,
                input.location,
                false,
                attributes,
                instance_attributes)) {
            dawn_error(
                (std::string("node variant declares an unmapped vertex ") +
                 "input '" + std::string(input.name) + "'.")
                    .c_str());
        }
        if (!instance_attributes.empty()) {
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
    vertex_layout.attributeCount = attributes.size();
    vertex_layout.attributes = attributes.data();
    WGPURenderPipelineDescriptor descriptor =
        WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    descriptor.layout = node_pipeline_layout_for(state, variant);
    descriptor.vertex.module = state.node_vertex_modules[variant];
    descriptor.vertex.entryPoint = string_view("vs_main");
    descriptor.vertex.bufferCount = 1;
    descriptor.vertex.buffers = &vertex_layout;
    descriptor.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    descriptor.primitive.frontFace = WGPUFrontFace_CCW;
    // The backFaceCulling the graph declared, which is the whole of its
    // fixed-function state: the reached slice composes no blend, so the
    // kind carries nothing else.
    descriptor.primitive.cullMode =
        kind == upstream::RenderPipelineKind::node_opaque_none
            ? WGPUCullMode_None
            : WGPUCullMode_Back;
    WGPUDepthStencilState depth_stencil = WGPU_DEPTH_STENCIL_STATE_INIT;
    depth_stencil.format = WGPUTextureFormat_Depth24PlusStencil8;
    depth_stencil.depthWriteEnabled = WGPUOptionalBool_True;
    depth_stencil.depthCompare =
        dawn_depth_compare(upstream::pinned_depth_compare);
    descriptor.depthStencil = has_depth ? &depth_stencil : nullptr;
    descriptor.multisample.count = samples;
    descriptor.multisample.mask = ~0u;
    WGPUColorTargetState color_target = WGPU_COLOR_TARGET_STATE_INIT;
    color_target.format = state.frame_color_format;
    WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
    fragment.module = state.node_fragment_modules[variant];
    fragment.entryPoint = string_view("fs_main");
    fragment.targetCount = 1;
    fragment.targets = &color_target;
    descriptor.fragment = &fragment;
    WGPURenderPipeline pipeline =
        wgpuDeviceCreateRenderPipeline(state.device, &descriptor);
    if (!pipeline) dawn_error("node variant pipeline creation failed.");
    return map.emplace(key, pipeline).first->second;
}

/** The per-draw buffers a node graph needs, created once per mesh. */
void ensure_node_draw_buffers(
    DawnState& state,
    DawnMesh& mesh,
    const upstream::NodeVariantEntry& entry) {
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
    if (!mesh.node_mesh_uniforms) {
        mesh.node_mesh_uniforms =
            uniform_buffer(sizeof(upstream::NodeMeshUniforms));
    }
    if (!mesh.node_uniforms && upstream::has_node_ubo(entry)) {
        mesh.node_uniforms =
            uniform_buffer(static_cast<std::uint64_t>(entry.ubo_bytes));
        // The constants the graph declared, written with the buffer that
        // holds them: nothing a reached scene does changes them.
        wgpuQueueWriteBuffer(
            state.queue,
            mesh.node_uniforms,
            0,
            &upstream::node_variant_uniform_floats[
                entry.first_uniform_float],
            entry.ubo_bytes);
    }
}

WGPUBindGroup build_node_draw_group(
    DawnState& state,
    DawnMesh& mesh,
    std::size_t variant) {
    const upstream::NodeVariantEntry& entry =
        upstream::node_variants[variant];
    std::vector<WGPUBindGroupEntry> entries;
    WGPUBindGroupEntry mesh_entry = WGPU_BIND_GROUP_ENTRY_INIT;
    mesh_entry.binding = 0;
    mesh_entry.buffer = mesh.node_mesh_uniforms;
    mesh_entry.size = sizeof(upstream::NodeMeshUniforms);
    entries.push_back(mesh_entry);
    if (upstream::has_node_ubo(entry)) {
        WGPUBindGroupEntry node_entry = WGPU_BIND_GROUP_ENTRY_INIT;
        node_entry.binding =
            static_cast<std::uint32_t>(entry.ubo_binding);
        node_entry.buffer = mesh.node_uniforms;
        node_entry.size = static_cast<std::uint64_t>(entry.ubo_bytes);
        entries.push_back(node_entry);
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
    WGPUBindGroupDescriptor descriptor = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    descriptor.layout = node_draw_layout_for(state, variant);
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
    DawnMesh& mesh) {
    const upstream::NodeMeshUniforms block =
        node_mesh_block(scene, engine, draw.item.mesh.value);
    wgpuQueueWriteBuffer(
        state.queue,
        mesh.node_mesh_uniforms,
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
        !binding_shader_info->vertex.gather.empty()) {
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
        binding_traits.standard
            ? (mesh.emissive_render_view
                   ? mesh.emissive_render_view
                   : mesh.views[4])
            : state.brdf_view,
    };
    std::array<WGPUSampler, max_texture_pairs> samplers{
        mesh.samplers[0],
        mesh.samplers[1],
        mesh.samplers[2],
        mesh.samplers[3],
        state.default_sampler,
        binding_traits.standard
            ? (mesh.emissive_render_view
                   ? state.nearest_sampler
                   : mesh.samplers[4])
            : state.clamp_sampler,
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
const DawnPostProcessProgram& post_process_program(
    DawnState& state,
    const upstream::PostProcessShaderInfo& info,
    WGPUTextureFormat format,
    std::uint32_t samples,
    std::uint32_t alpha_mode,
    std::size_t extra_textures) {
    const std::uint32_t uniform_size =
        (info.uniform_byte_length + 15u) & ~15u;
    for (const DawnPostProcessProgram& program :
         state.post_process_programs) {
        if (
            program.module_index == info.module_index &&
            program.format == format &&
            program.samples == samples &&
            program.alpha_mode == alpha_mode &&
            program.extra_textures == extra_textures &&
            program.uniform_binding == info.uniform_binding &&
            program.uniform_size == uniform_size) {
            return program;
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
    return state.post_process_programs.back();
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
    if (!gpu.program) {
        gpu.program = &post_process_program(
            state,
            info,
            state.render_targets[pass.output_target.value].color_format,
            output_record.swapchain
                ? 1u
                : task_sample_count(state, output_record.samples),
            pass.alpha_mode,
            pass.extra_textures.size());
        if (gpu.program->uniform_size > 0) {
            WGPUBufferDescriptor uniform_descriptor =
                WGPU_BUFFER_DESCRIPTOR_INIT;
            uniform_descriptor.size = gpu.program->uniform_size;
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
            uniform_binding.size = gpu.program->uniform_size;
            group_entries.push_back(uniform_binding);
        }
        WGPUBindGroupDescriptor group_descriptor =
            WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        group_descriptor.layout = gpu.program->group_layout;
        group_descriptor.entryCount = group_entries.size();
        group_descriptor.entries = group_entries.data();
        gpu.group = wgpuDeviceCreateBindGroup(
            state.device,
            &group_descriptor);
        pass.uniforms_dirty = true;
    }
    if (gpu.uniforms && pass.uniforms_dirty) {
        std::vector<float> data(gpu.program->uniform_size / 4u, 0.0f);
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
            gpu.program->uniform_size);
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
    wgpuRenderPassEncoderSetPipeline(post_pass, gpu.program->pipeline);
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

bool run_dawn_engine(Engine& engine) {
    if (engine.registered_scenes.empty() || !engine.registered_scenes.front()) {
        throw std::runtime_error("Dawn renderer requires a registered scene.");
    }
    reject_uncomposed_sprites(engine);
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
    // any of them is created.
    state.sample_count = frame_options.single_sample ? 1u : 4u;
    const bool hidden_test_pass = frame_options.test_pass;

    DawnDeviceOptions device_options;
    device_options.hidden_test_pass = hidden_test_pass;
    device_options.immediate_present =
        frame_options.benchmark_requested;
#if BBLITE_GPU_INSTANCING
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

    const std::uint32_t width =
        static_cast<std::uint32_t>(engine.options.width);
    const std::uint32_t height =
        static_cast<std::uint32_t>(engine.options.height);

    // Shared frame targets: 4x MSAA color (surface format, or linear
    // rgba16float for transmission frames whose multisampled texture
    // feeds the grab and the per-sample image processing) and the
    // browser's depth24plus-stencil8 depth buffer.
    state.frame_color_format = scene.transmission_enabled
        ? WGPUTextureFormat_RGBA16Float
        : state.surface_format;
    {
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
    }

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
    std::vector<std::uint8_t> fallback_rgba16f(8);
    for (std::size_t channel = 0; channel < 4; ++channel) {
        const std::uint16_t half =
            float_to_half(environment_fallback_face[channel]);
        fallback_rgba16f[channel * 2] =
            static_cast<std::uint8_t>(half & 0xff);
        fallback_rgba16f[channel * 2 + 1] =
            static_cast<std::uint8_t>(half >> 8);
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
    std::uint64_t synced_mesh_membership_version =
        scene.mesh_membership_version;
    const auto rebuild_meshes = [&] {
    render_plan = upstream::build_render_plan(scene, engine);
    for (const upstream::RenderItem& item : render_plan.items) {
        if (
            item.material_kind ==
            upstream::RenderMaterialKind::shader) {
            if (
                item.shader_variant >=
                upstream::shader_variant_count()) {
                dawn_error(
                    "this shader material variant is not implemented "
                    "yet.");
            }
        } else if (
            item.material_kind == upstream::RenderMaterialKind::node) {
#if BBLITE_NODE_VARIANTS > 0
            if (item.shader_variant >= upstream::node_variants.size()) {
                dawn_error("this node material graph was not composed.");
            }
#else
            dawn_error(
                "a node material in a build with no composed graphs.");
#endif
        } else if (
            item.material_kind !=
                upstream::RenderMaterialKind::standard &&
            item.material_kind != upstream::RenderMaterialKind::pbr &&
            item.material_kind != upstream::RenderMaterialKind::grid) {
            dawn_error(
                "only Standard, PBR, Grid, node and shader-variant "
                "materials are implemented yet.");
        }
        const ModelGeometry& geometry = engine.geometries[item.geometry];
        const MeshRecord& mesh_record = engine.meshes[item.mesh.value];
        const std::vector<GpuVertex> vertices =
            transformed_vertices(geometry, mesh_record);
        DawnMesh mesh;
        mesh.vertices = create_buffer(
            state,
            WGPUBufferUsage_Vertex,
            vertices.data(),
            vertices.size() * sizeof(GpuVertex));
#if BBLITE_PBR_VARIANTS > 0
        {
            const std::vector<GpuVertex> pinned =
                pinned_convention_vertices(vertices, mesh_record.mirrored_x);
            mesh.pinned_vertices = create_buffer(
                state,
                WGPUBufferUsage_Vertex,
                pinned.data(),
                pinned.size() * sizeof(GpuVertex));
        }
#endif
        mesh.indices = create_buffer(
            state,
            WGPUBufferUsage_Index,
            geometry.indices.data(),
            geometry.indices.size() * sizeof(std::uint32_t));
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
#if BBLITE_PBR_VARIANTS > 0
            if (mesh_record.instance_source != nullptr) {
                // Scene-code thin instances already carry Babylon's own
                // values, so the pinned draw shares the buffer -- and
                // with it the version-gated dynamic re-upload.
                mesh.pinned_instances = mesh.instances;
            } else if (!mesh_record.instance_matrices.empty()) {
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

        // Per-slot texture selection reads the generated
        // `material_texture_slots` table -- the same rows the SDL_GPU
        // backend executes -- so which record field a slot takes, its
        // sRGB view and its fallback texel are decided once, at
        // generation; this backend keeps only the upload mechanics.
        const bool standard_material =
            item.material_kind == upstream::RenderMaterialKind::standard;
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
        for (
            const upstream::MaterialTextureSlot& slot_row :
            upstream::material_texture_slots) {
            if (slot_row.slot == upstream::material_texture_no_slot) {
                continue;
            }
            const TextureData* slot_data = material
                ? material_slot_texture(
                      *material,
                      slot_row.source,
                      standard_material)
                : nullptr;
            const TextureData empty{};
            const TextureData& data = slot_data ? *slot_data : empty;
            std::uint32_t mip_count = 1;
            mesh.owned_textures[slot_row.slot] = upload_material_texture(
                state,
                data,
                material_slot_srgb(
                    slot_row.srgb,
                    slot_data,
                    material,
                    standard_material),
                material_slot_fallback(
                    slot_row.fallback,
                    material,
                    standard_material),
                mip_count);
            mesh.owned_views[slot_row.slot] = wgpuTextureCreateView(
                mesh.owned_textures[slot_row.slot],
                nullptr);
            mesh.views[slot_row.slot] = mesh.owned_views[slot_row.slot];
            mesh.samplers[slot_row.slot] = create_texture_sampler(
                state.device,
                slot_data
                    ? slot_data->sampler
                    : TextureSamplerState{});
        }
        state.meshes.push_back(std::move(mesh));
    }
    state.release_render_tasks();
    state.render_tasks.resize(engine.frame_tasks.size());
    for (const TaskHandle handle : scene.tasks) {
        const FrameTaskRecord& task = engine.frame_tasks[handle.value];
        if (
            task.kind != FrameTaskKind::render &&
            task.kind != FrameTaskKind::geometry) {
            continue;
        }
        DawnRenderTask& render_task = state.render_tasks[handle.value];
        render_task.draw_lists = upstream::build_render_task_draw_lists(
            render_plan.items,
            engine,
            task);
        if (task.kind == FrameTaskKind::render) {
            render_task.view_projection = create_buffer(
                state,
                WGPUBufferUsage_Uniform,
                nullptr,
                64);
        }
    }
    };
    rebuild_meshes();

    if (use_skybox) {
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
        WGPURenderPipelineDescriptor descriptor =
            WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
        descriptor.vertex.module = state.vertex_module;
        descriptor.vertex.entryPoint = string_view("mainVertex");
        descriptor.vertex.bufferCount = skybox_vertex_buffer_count;
        descriptor.vertex.buffers = vertex_layouts.data();
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
            64);
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
        state.skybox_scene_group =
            wgpuDeviceCreateBindGroup(state.device, &scene_descriptor);
        wgpuBindGroupLayoutRelease(scene_layout);
#if BBLITE_GPU_MORPH_STORAGE
        {
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

    CaptureGate captures(frame_options, limit);
    FrameClock frame_clock;
    bool running = true;
    long frame = 0;
    CameraPointerState pointer_state;
    while (captures.keep_running(running, frame)) {
        SDL_Event event;
        while (SDL_PollEvent(&event)) {
            if (event.type == SDL_EVENT_QUIT) running = false;
            if (!hidden_test_pass) {
                handle_camera_pointer_event(
                    event,
                    camera,
                    pointer_state);
            }
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
        const float delta_ms =
            frame_clock.advance(scene.fixed_delta_ms);
        for (const auto& callback : scene.before_render) {
            callback(delta_ms);
        }
        bool topology_updated = false;
        if (
            scene.mesh_membership_version !=
            synced_mesh_membership_version) {
            // Runtime mesh append: wait for the submitted work, then
            // rebuild the mesh set from a fresh render plan. Capture
            // defers past this frame exactly like the SDL backend.
            WGPUQueueWorkDoneCallbackInfo done_callback =
                WGPU_QUEUE_WORK_DONE_CALLBACK_INFO_INIT;
            done_callback.mode = WGPUCallbackMode_WaitAnyOnly;
            done_callback.callback = [](
                                         WGPUQueueWorkDoneStatus,
                                         WGPUStringView,
                                         void*,
                                         void*) {};
            wait_for(
                state.instance,
                wgpuQueueOnSubmittedWorkDone(
                    state.queue,
                    done_callback));
            state.release_meshes();
            rebuild_meshes();
            synced_mesh_membership_version =
                scene.mesh_membership_version;
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
            const bool mesh_uniform_item =
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
                }
                dawn_mesh.instance_count =
                    static_cast<std::uint32_t>(active_count);
                dawn_mesh.instance_version =
                    mesh.instance_version;
            }
            if (mesh_uniform_item) {
                const std::array<float, 16> parent_world =
                    upstream::build_instance_parent_world(mesh);
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
                mesh.transform_version) {
                continue;
            }
            const std::vector<GpuVertex> vertices =
                transformed_vertices(
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
        }
        update_camera(camera);
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
#if BBLITE_HAS_BILLBOARDS
        {
            // Lazily built, because the systems are known only once the
            // scene has run; the sort then follows the camera every frame.
            const std::array<float, 16> billboard_view =
                upstream::build_view_matrix(
                    upstream::camera_world_matrix(camera));
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
                }
            }
            for (DawnBillboardPass& billboard : state.billboard_passes) {
                upload_dawn_billboard_pass(
                    state.queue,
                    engine,
                    billboard,
                    matrix,
                    billboard_view,
                    delta_ms);
            }
        }
#endif
        // Written from the same plan, camera and matrix the uploads
        // below read, so the two backends' captures are comparable to
        // each other as well as to the browser's.
        if (
            frame >= screenshot_frame &&
            !topology_updated &&
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
#endif
        const auto write_material_uniforms =
            [&](const upstream::RenderDrawList& list) {
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
                        ensure_standard_draw_buffers(state, draw_mesh);
                        // The bind group builds at encode: a depth-sampled
                        // emissive render texture's view resolves only
                        // after the frame-graph textures exist.
                        draw_mesh.standard_group_key = variant * 2 +
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
                            draw_mesh.standard_mesh_uniforms,
                            draw_mesh.standard_material_uniforms,
                            draw_mesh.standard_uv_uniforms);
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
                        ensure_node_draw_buffers(
                            state,
                            draw_mesh,
                            upstream::node_variants.at(variant));
                        write_node_mesh_block(
                            state,
                            scene,
                            engine,
                            draw,
                            draw_mesh);
                        // Keyed like the two sibling families: a mesh moved
                        // to another graph rebuilds rather than keeping a
                        // group over the first graph's buffers.
                        if (draw_mesh.node_group_variant != variant) {
                            draw_mesh.node_group = build_node_draw_group(
                                state,
                                draw_mesh,
                                variant);
                            draw_mesh.node_group_variant = variant;
                        }
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
                            // Custom stage blocks gather from the
                            // material's flat value storage; a pure
                            // system-matrix vertex block binds the
                            // shared scene matrix instead. Combined
                            // matrix-plus-custom blocks are not
                            // reached on this backend.
                            const auto write_stage_block =
                                [&](
                                    const upstream::
                                        ShaderVariantStageBlock&
                                            block,
                                    WGPUBuffer buffer) {
                                if (
                                    !block.present ||
                                    block.gather.empty()) {
                                    return;
                                }
                                if (block.system_matrix) {
                                    dawn_error(
                                        "combined system and custom "
                                        "shader uniform blocks are "
                                        "not implemented yet.");
                                }
                                const std::vector<float>
                                    block_floats =
                                        shader_stage_block_floats(
                                            block,
                                            nullptr,
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
                        }
                    } else {
#if BBLITE_PBR_VARIANTS > 0
                        // The pin's own per-draw blocks. The transcribed
                        // block is retired: a PBR draw that resolves no
                        // variant is an error naming the mesh, matching the
                        // SDL_GPU backend.
                        const std::size_t variant =
                            pinned_variant_for_draw(
                                scene,
                                engine,
                                draw);
                        if (
                            variant ==
                            std::numeric_limits<std::size_t>::max()) {
                            dawn_error(
                                ("PBR draw for mesh " +
                                 std::to_string(draw.item.mesh.value) +
                                 ", material " +
                                 std::to_string(draw.item.material.value) +
                                 " resolves no pinned variant.")
                                    .c_str());
                        }
                        {
                            DawnMesh& variant_mesh =
                                state.meshes[draw.item_index];
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
                                    variant_mesh,
                                    variant_record);
                            }
                            ensure_pinned_draw_bindings(
                                state,
                                variant_mesh,
                                variant);
                            variant_mesh.pinned_mirrored_vertices =
                                conventions.mirrored_vertices;
                            write_pinned_draw_blocks(
                                state,
                                scene,
                                engine,
                                draw,
                                variant,
                                conventions.skeleton_draw,
                                conventions.world_from_palette,
                                variant_mesh.pinned_mesh_uniforms,
                                variant_mesh.pinned_material_uniforms);
                        }
#else
                        dawn_error(
                            "PBR draw in a build with no composed variant "
                            "table; the transcribed fragment is retired.");
#endif
                    }
                }
            };
        write_material_uniforms(render_plan.draw_lists.opaque);
        write_material_uniforms(render_plan.draw_lists.transparent);
        if (state.skybox_enabled) {
            const std::array<float, 16> skybox_view_projection =
                upstream::build_skybox_view_projection(
                    camera,
                    static_cast<float>(width) / height);
            wgpuQueueWriteBuffer(
                state.queue,
                state.skybox_matrix,
                0,
                scene.environment.skybox_uses_environment
                    ? skybox_view_projection.data()
                    : matrix.data(),
                64);
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
            // Resolve frame-graph source textures bound in standard
            // emissive slots (the depth-copy views exist only now).
            for (
                std::size_t item_index = 0;
                item_index < render_plan.items.size() &&
                item_index < state.meshes.size();
                ++item_index) {
                const upstream::RenderItem& item =
                    render_plan.items[item_index];
                if (
                    item.material_kind !=
                        upstream::RenderMaterialKind::standard ||
                    item.material.value >= engine.materials.size()) {
                    continue;
                }
                const MaterialRecord& material =
                    engine.materials[item.material.value];
                if (!material.has_emissive_render_texture) continue;
                const RenderTextureRef& reference =
                    material.emissive_render_texture;
                if (
                    reference.source !=
                        RenderTextureSource::render_target ||
                    reference.target.value >=
                        state.render_targets.size()) {
                    dawn_error(
                        "emissive render texture source is not "
                        "implemented yet.");
                }
                const DawnRenderTarget& source_target =
                    state.render_targets[reference.target.value];
                state.meshes[item_index].emissive_render_view =
                    source_target.depth_copy_view
                        ? source_target.depth_copy_view
                        : source_target.sampled_color_view;
            }
            for (const TaskHandle handle : scene.tasks) {
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
                const std::array<float, 16> task_matrix =
                    upstream::build_view_projection(
                        task_camera,
                        task_aspect);
                wgpuQueueWriteBuffer(
                    state.queue,
                    render_task.view_projection,
                    0,
                    task_matrix.data(),
                    64);
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
                if (target_record.has_color) {
                    // Depth-only tasks never read fragment uniforms;
                    // skipping them keeps the no-color override
                    // materials from rewriting the shared buffers.
                    upstream::sort_transparent_draws(
                        render_task.draw_lists.transparent,
                        engine,
                        task_camera);
                    write_material_uniforms(
                        render_task.draw_lists.opaque);
                    write_material_uniforms(
                        render_task.draw_lists.transparent);
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
                                        WGPUBindGroup frame_group = nullptr) {
            (void)frame_group;
            for (const upstream::RenderDrawCommand& draw :
                 list.commands) {
                if (draw.item_index >= state.meshes.size()) continue;
                DawnMesh& mesh = state.meshes[draw.item_index];
#if BBLITE_PBR_VARIANTS > 0
                // Babylon's own composed stages for this draw, when the scene
                // resolves a variant for it. Everything else — the Standard
                // path, the shader materials, a scene whose material handles do
                // not correspond to the composed asset — takes the transcribed
                // pipeline below.
                if (mesh.pinned_group) {
                    const std::size_t variant = mesh.pinned_variant;
                    // The thin-instance arm's second stream and the instance
                    // count; a non-instanced variant binds neither and draws
                    // once.
                    WGPUBuffer pinned_instance_buffer = nullptr;
                    std::uint32_t pinned_instances = 1;
#if BBLITE_GPU_INSTANCING
                    if (pinned_record_instanced(
                            engine.meshes[draw.item.mesh.value]) &&
                        mesh.pinned_instances) {
                        pinned_instance_buffer = mesh.pinned_instances;
                        pinned_instances = mesh.instance_count;
                    }
#endif
                    encode_variant_draw(
                        list_pass,
                        pinned_variant_pipeline(
                            state,
                            variant,
                            draw.pipeline,
                            samples,
                            pass_has_depth),
                        bound_pipeline,
                        frame_group ? frame_group
                                    : pinned_frame_group(state),
                        mesh.pinned_group,
                        // Skinned and palette-world draws read the mirrored
                        // buffer; the palette carries the mirror on both
                        // sides, so unmirrored vertices would apply it three
                        // times.
                        mesh.pinned_mirrored_vertices
                            ? mesh.vertices
                            : mesh.pinned_vertices,
                        pinned_instance_buffer,
                        pinned_instances,
                        mesh.indices,
                        mesh.index_count);
                    continue;
                }
#endif
#if BBLITE_STANDARD_VARIANTS > 0
                if (
                    draw.item.material_kind ==
                    upstream::RenderMaterialKind::standard &&
                    mesh.standard_group_key !=
                        std::numeric_limits<std::size_t>::max()) {
                    const std::size_t variant = mesh.standard_group_key / 2;
                    if (!mesh.standard_group) {
                        const MaterialRecord* standard_material =
                            draw.item.material.value <
                                    engine.materials.size()
                                ? &engine.materials[
                                      draw.item.material.value]
                                : nullptr;
                        mesh.standard_group = build_standard_draw_group(
                            state,
                            mesh,
                            standard_material,
                            variant,
                            mesh.standard_mesh_uniforms,
                            mesh.standard_material_uniforms,
                            mesh.standard_uv_uniforms,
                            nullptr,
                            (mesh.standard_group_key & 1) != 0
                                ? mesh.emissive_render_view
                                : nullptr);
                    }
                    WGPUBuffer standard_instance_buffer = nullptr;
                    std::uint32_t standard_instances = 1;
#if BBLITE_GPU_INSTANCING
                    if (pinned_record_instanced(
                            engine.meshes[draw.item.mesh.value]) &&
                        mesh.instances) {
                        standard_instance_buffer = mesh.instances;
                        standard_instances = mesh.instance_count;
                    }
#endif
                    encode_variant_draw(
                        list_pass,
                        standard_variant_pipeline(
                            state,
                            variant,
                            draw.pipeline,
                            samples,
                            pass_has_depth,
                            (mesh.standard_group_key & 1) != 0),
                        bound_pipeline,
                        frame_group ? frame_group
                                    : pinned_frame_group(state),
                        mesh.standard_group,
                        // The Standard families carry no glTF X-mirror: the
                        // baked buffer is the pin's own convention already.
                        mesh.vertices,
                        standard_instance_buffer,
                        standard_instances,
                        mesh.indices,
                        mesh.index_count);
                    continue;
                }
                if (
                    draw.item.material_kind ==
                    upstream::RenderMaterialKind::standard) {
                    dawn_error(
                        ("Standard draw for mesh " +
                         std::to_string(draw.item.mesh.value) +
                         " reached the encode with no resolved variant.")
                            .c_str());
                }
#endif
#if BBLITE_NODE_VARIANTS > 0
                if (
                    draw.item.material_kind ==
                    upstream::RenderMaterialKind::node) {
                    if (!mesh.node_group) {
                        dawn_error(
                            ("node draw for mesh " +
                             std::to_string(draw.item.mesh.value) +
                             " reached the encode with no bind group.")
                                .c_str());
                    }
                    encode_variant_draw(
                        list_pass,
                        node_variant_pipeline(
                            state,
                            draw.item.shader_variant,
                            draw.pipeline,
                            samples,
                            pass_has_depth),
                        bound_pipeline,
                        frame_group ? frame_group
                                    : pinned_frame_group(state),
                        mesh.node_group,
                        // A node graph reads the baked vertices under the
                        // identity world, like the Standard family.
                        mesh.vertices,
                        nullptr,
                        1,
                        mesh.indices,
                        mesh.index_count);
                    continue;
                }
#endif
#if BBLITE_PBR_VARIANTS > 0
                // The write phase resolves and binds every PBR draw or
                // errors; reaching here with one means its pinned bindings
                // were never built for this frame.
                if (
                    draw.item.material_kind ==
                    upstream::RenderMaterialKind::pbr) {
                    dawn_error(
                        ("PBR draw for mesh " +
                         std::to_string(draw.item.mesh.value) +
                         ", material " +
                         std::to_string(draw.item.material.value) +
                         ", pipeline kind " +
                         std::to_string(
                             static_cast<int>(draw.pipeline)) +
                         " reached the transcribed dispatch with no "
                         "pinned bindings.")
                            .c_str());
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
            // SDL backend and the pinned engine.
            color_attachment.storeOp = WGPUStoreOp_Store;
            color_attachment.clearValue = WGPUColor{
                inverse_image_processed_channel(
                    scene.clear_color.r,
                    scene.environment.exposure,
                    scene.environment.contrast,
                    scene.environment.tone_mapping_enabled),
                inverse_image_processed_channel(
                    scene.clear_color.g,
                    scene.environment.exposure,
                    scene.environment.contrast,
                    scene.environment.tone_mapping_enabled),
                inverse_image_processed_channel(
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
            wgpuRenderPassEncoderSetBindGroup(
                pass, 0, state.skybox_morph_group, 0, nullptr);
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
            wgpuRenderPassEncoderSetVertexBuffer(
                pass,
                1,
                state.background_instances,
                0,
                WGPU_WHOLE_SIZE);
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
#if BBLITE_HAS_BILLBOARDS
                    draw_billboards(BillboardDepthMode::cutout);
#endif
                    break;
                case upstream::RenderStage::transparent:
                    draw_render_list(
                        render_plan.draw_lists.transparent);
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
            [&](RenderTargetHandle target_handle)
            -> std::pair<WGPUTexture, WGPUTextureView> {
            if (target_handle.value >= state.render_targets.size()) {
                throw std::runtime_error(
                    "Frame graph render target handle is invalid.");
            }
            const RenderTargetRecord& record =
                engine.render_targets[target_handle.value];
            DawnRenderTarget& target =
                state.render_targets[target_handle.value];
            if (!record.has_color) {
                if (record.has_depth && target.depth_copy) {
                    return {target.depth_copy, target.depth_copy_view};
                }
                throw std::runtime_error(
                    "Depth-only render target has no color texture.");
            }
            return {target.sampled_color, target.sampled_color_view};
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
            const FrameTaskRecord& task =
                engine.frame_tasks[handle.value];
            if (task.kind == FrameTaskKind::render) {
                const RenderTargetRecord& target_record =
                    engine.render_targets[task.render.target.value];
                DawnRenderTarget& target =
                    state.render_targets[task.render.target.value];
                DawnRenderTask& render_task =
                    state.render_tasks[handle.value];
                const std::uint32_t samples = target_record.swapchain
                    ? 1u
                    : task_sample_count(state, target_record.samples);
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
                const bool pass_has_depth = borrowed_depth_view ||
                    (target_record.has_depth && target.depth);
                draw_list_into(
                    task_pass,
                    render_task.draw_lists.opaque,
                    samples,
                    bound_pipeline,
                    pass_has_depth,
                    render_task.pinned_frame_group);
                draw_list_into(
                    task_pass,
                    render_task.draw_lists.transparent,
                    samples,
                    bound_pipeline,
                    pass_has_depth,
                    render_task.pinned_frame_group);
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
                                const std::size_t variant =
                                    pinned_variant_for_draw(
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
                                        ("PBR draw for mesh " +
                                         std::to_string(
                                             draw.item.mesh.value) +
                                         " resolves no pinned variant in "
                                         "a geometry task.")
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
                                    nullptr,
                                    1,
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
                                WGPUBuffer standard_instance_buffer =
                                    nullptr;
                                std::uint32_t standard_instances = 1;
#if BBLITE_GPU_INSTANCING
                                if (pinned_record_instanced(
                                        engine.meshes[
                                            draw.item.mesh.value]) &&
                                    mesh.instances) {
                                    standard_instance_buffer =
                                        mesh.instances;
                                    standard_instances =
                                        mesh.instance_count;
                                }
#endif
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
                                    standard_instance_buffer,
                                    standard_instances,
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

        const bool capture_frame =
            frame >= screenshot_frame &&
            !captures.screenshot_saved &&
            !screenshot_path.empty() &&
            !topology_updated;
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

        const bool capture_ready =
            frame >= screenshot_frame && !topology_updated;
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
        ++frame;
    }
    report_benchmark(benchmark_samples, "Dawn", "D3D12");
    SDL_DestroyWindow(state.window);
    state.window = nullptr;
    return true;
}

} // namespace bbl::pal

#endif
