#include <bblite/pal.hpp>
#include <bblite/pal_image.hpp>
#if defined(BBLITE_HAS_GLTF) && BBLITE_HAS_GLTF
#include <bblite/pal_gltf.hpp>
#endif
#include <bblite/pal_gpu.hpp>
#include <bblite/runtime.hpp>
#include <bblite/upstream/camera_controls.hpp>
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
#if defined(BBLITE_HAS_PBR_RENDERER) && BBLITE_HAS_PBR_RENDERER
#include <bblite/upstream/render_capabilities.hpp>
#include <bblite/upstream/renderer_plan.hpp>
#endif

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

#include "pal_camera_controls.hpp"
#include "pal_gpu_shared.hpp"
#if BBLITE_HAS_BILLBOARDS
#include "pal_sdl_gpu_billboard.hpp"
#endif
#if BBLITE_HAS_SPLATS
#include "pal_sdl_gpu_splat.hpp"
#endif
#if defined(BBLITE_HAS_EFFECT_TASK) && BBLITE_HAS_EFFECT_TASK
#include "pal_sdl_gpu_effect.hpp"
#endif
#include "pal_render_capture.hpp"

#if defined(BBLITE_HAS_PBR_RENDERER) && BBLITE_HAS_PBR_RENDERER
#include <SDL3/SDL.h>
#include <SDL3/SDL_gpu.h>
#include <SDL3_image/SDL_image.h>
#include "pal_sdl_gpu_shared.hpp"
#endif

#ifndef BBLITE_GPU_SHADER_DIR
#define BBLITE_GPU_SHADER_DIR "shaders"
#endif

namespace bbl::pal {

#if defined(BBLITE_HAS_PBR_RENDERER) && BBLITE_HAS_PBR_RENDERER
namespace {

// gpu_blend_factor / blend_state_from moved to pal_sdl_gpu_shared.hpp so
// the family headers can translate the shared blend tuples too.

/** The shared cull enum in this API's; the pipeline-kind facts come from
 *  `pipeline_kind_traits` (pal_gpu_shared.hpp). */
/**
 * `buildPrimitiveState`'s own table, in SDL_GPU's names. A triangle strip
 * never reaches here: the loader expands one into the list it describes.
 */
SDL_GPUPrimitiveType gpu_primitive_type(MeshTopology topology) {
    switch (topology) {
        case MeshTopology::points:
            return SDL_GPU_PRIMITIVETYPE_POINTLIST;
        case MeshTopology::lines:
            return SDL_GPU_PRIMITIVETYPE_LINELIST;
        case MeshTopology::line_strip:
            return SDL_GPU_PRIMITIVETYPE_LINESTRIP;
        case MeshTopology::triangles:
            return SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
    }
    return SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
}

SDL_GPUCullMode gpu_cull_mode(upstream::RenderCullMode cull) {
    return cull == upstream::RenderCullMode::none
        ? SDL_GPU_CULLMODE_NONE
        : SDL_GPU_CULLMODE_BACK;
}

SDL_GPUFrontFace gpu_front_face(bool clockwise) {
    return clockwise
        ? SDL_GPU_FRONTFACE_CLOCKWISE
        : SDL_GPU_FRONTFACE_COUNTER_CLOCKWISE;
}

struct GpuMesh {
    SDL_GPUBuffer* vertices = nullptr;

#if BBLITE_PBR_VARIANTS > 0
    // The same vertices in Babylon's own convention: X unmirrored and
    // `tangent.w` back to its authored sign, paired with the mirroring world
    // matrix in the pin's mesh block. `pinned_convention_vertices` states why.
    SDL_GPUBuffer* pinned_vertices = nullptr;
    // The bone palette as the pin's own rgba32float texture, streamed each
    // frame before the passes open. `write_pinned_bone_texture` states the
    // layout.
    SDL_GPUTexture* pinned_bone_texture = nullptr;
    std::uint32_t pinned_bone_count = 0;
    // The instance matrices in Babylon's own convention, for the pin's
    // thin-instance arm. `pinned_instance_matrices` states the conversion.
    SDL_GPUBuffer* pinned_instances = nullptr;
#endif
    SDL_GPUBuffer* indices = nullptr;
    SDL_GPUBuffer* instances = nullptr;
#if BBLITE_GPU_INSTANCE_COLORS
    // The per-instance RGBA stream a material with useThinInstanceColors
    // reads, in its own tightly-packed instance buffer.
    SDL_GPUBuffer* instance_colors = nullptr;
#endif
    std::uint64_t instance_version = 0;
#if BBLITE_GPU_MORPH_STORAGE
    SDL_GPUBuffer* morph_deltas = nullptr;
    SDL_GPUBuffer* morph_weights = nullptr;
    std::uint64_t morph_weights_version = 0;
    bool owns_morph_buffers = false;
#endif
    SDL_GPUTexture* base_color = nullptr;
    SDL_GPUTexture* metallic_roughness = nullptr;
    SDL_GPUTexture* normal = nullptr;
    SDL_GPUTexture* emissive = nullptr;
    SDL_GPUTexture* transmission = nullptr;
    SDL_GPUTexture* thickness = nullptr;
#if BBLITE_MATERIAL_CLEARCOAT
    SDL_GPUTexture* clearcoat = nullptr;
    SDL_GPUTexture* clearcoat_roughness = nullptr;
    SDL_GPUTexture* clearcoat_normal = nullptr;
#endif
#if BBLITE_MATERIAL_SHEEN
    SDL_GPUTexture* sheen_color = nullptr;
    SDL_GPUTexture* sheen_roughness = nullptr;
#endif
#if BBLITE_MATERIAL_IRIDESCENCE
    SDL_GPUTexture* iridescence = nullptr;
    SDL_GPUTexture* iridescence_thickness = nullptr;
#endif
#if BBLITE_MATERIAL_METALLIC_REFLECTANCE_MAP
    SDL_GPUTexture* metallic_reflectance = nullptr;
#endif
#if BBLITE_MATERIAL_REFLECTANCE_MAP
    SDL_GPUTexture* reflectance = nullptr;
#endif
#if BBLITE_MATERIAL_SPEC_GLOSS
    SDL_GPUTexture* spec_gloss = nullptr;
#endif
#if BBLITE_MATERIAL_OCCLUSION_UV2
    SDL_GPUTexture* occlusion = nullptr;
#endif
    SDL_GPUTexture* standard_emissive = nullptr;
#if BBLITE_MATERIAL_STANDARD_BUMP
    SDL_GPUTexture* standard_bump = nullptr;
#endif
#if BBLITE_MATERIAL_STANDARD_REFLECTION
    // The Standard 2D reflection slot (std-reflection-fragment.ts rT/rS);
    // `reflection` below stays the cube.
    SDL_GPUTexture* standard_reflection = nullptr;
#endif
    SDL_GPUTexture* reflection = nullptr;
    SDL_GPUSampler* base_color_sampler = nullptr;
    SDL_GPUSampler* metallic_roughness_sampler = nullptr;
    SDL_GPUSampler* normal_sampler = nullptr;
    SDL_GPUSampler* emissive_sampler = nullptr;
    SDL_GPUSampler* transmission_sampler = nullptr;
    SDL_GPUSampler* thickness_sampler = nullptr;
#if BBLITE_MATERIAL_CLEARCOAT
    SDL_GPUSampler* clearcoat_sampler = nullptr;
    SDL_GPUSampler* clearcoat_roughness_sampler = nullptr;
    SDL_GPUSampler* clearcoat_normal_sampler = nullptr;
#endif
#if BBLITE_MATERIAL_SHEEN
    SDL_GPUSampler* sheen_color_sampler = nullptr;
    SDL_GPUSampler* sheen_roughness_sampler = nullptr;
#endif
#if BBLITE_MATERIAL_IRIDESCENCE
    SDL_GPUSampler* iridescence_sampler = nullptr;
    SDL_GPUSampler* iridescence_thickness_sampler = nullptr;
#endif
#if BBLITE_MATERIAL_METALLIC_REFLECTANCE_MAP
    SDL_GPUSampler* metallic_reflectance_sampler = nullptr;
#endif
#if BBLITE_MATERIAL_REFLECTANCE_MAP
    SDL_GPUSampler* reflectance_sampler = nullptr;
#endif
#if BBLITE_MATERIAL_SPEC_GLOSS
    SDL_GPUSampler* spec_gloss_sampler = nullptr;
#endif
#if BBLITE_MATERIAL_OCCLUSION_UV2
    SDL_GPUSampler* occlusion_sampler = nullptr;
#endif
    SDL_GPUSampler* standard_emissive_sampler = nullptr;
#if BBLITE_MATERIAL_STANDARD_BUMP
    SDL_GPUSampler* standard_bump_sampler = nullptr;
#endif
#if BBLITE_MATERIAL_STANDARD_REFLECTION
    SDL_GPUSampler* standard_reflection_sampler = nullptr;
#endif
    // A shader material's own sampler slots, bound as fragment samplers
    // 0..n in the order its `samplers` option declared them. Empty for
    // every other material family.
    std::vector<SDL_GPUTextureSamplerBinding> shader_textures;
    std::uint32_t index_count = 0;
    std::uint32_t instance_count = 1;
    std::uint64_t transform_version = 0;
};

/**
 * This backend's member pair for one generated texture-slot row.
 *
 * The enum→member residue the generated `material_texture_slots` table
 * leaves per backend: what a slot means (field, sRGB, fallback, pinned
 * names) is table data, and this only says where this backend stores it.
 * Null members mean the row has no storage here, which the callers treat
 * as the generation bug it would be.
 */
struct GpuMeshSlotMembers {
    SDL_GPUTexture* GpuMesh::* texture = nullptr;
    SDL_GPUSampler* GpuMesh::* sampler = nullptr;
};

/**
 * The frame-graph attachments a Standard draw samples in place of decoded
 * image bytes.
 *
 * Two slots reach this: the depth-sampled emissive texture
 * `setStandardEmissiveTexture` names, and the colour attachment a
 * `material.diffuseTexture` write names. They are resolved once per draw
 * rather than inside the binding walk, which carries no frame graph.
 */
struct StandardRenderTextures {
    SDL_GPUTexture* base_color = nullptr;
    SDL_GPUTexture* standard_emissive = nullptr;
};

/**
 * Both slots resolved through the caller's own `source_texture`, which is
 * the one place this backend turns a `RenderTextureRef` into a texture.
 */
template <typename SourceTexture>
StandardRenderTextures material_render_textures(
    const MaterialRecord* material,
    SourceTexture source_texture) {
    if (!material) return {};
    return {
        material->has_diffuse_render_texture
            ? source_texture(material->diffuse_render_texture)
            : nullptr,
        material->has_emissive_render_texture
            ? source_texture(material->emissive_render_texture)
            : nullptr,
    };
}

/**
 * The grid and shader pipelines one secondary dispatch selects from. The
 * main pass reads them off the state and a render task off its own
 * parameters, so the sources travel as one bundle and the dispatch below
 * exists once.
 */
struct SecondaryPipelines {
    SDL_GPUGraphicsPipeline* grid_opaque = nullptr;
    SDL_GPUGraphicsPipeline* grid_double_sided = nullptr;
    SDL_GPUGraphicsPipeline* grid_transparent = nullptr;
    SDL_GPUGraphicsPipeline* grid_transparent_double_sided = nullptr;
    const std::vector<SDL_GPUGraphicsPipeline*>* shader = nullptr;
    const std::vector<SDL_GPUGraphicsPipeline*>* shader_a2c = nullptr;
};

/**
 * The pipeline a non-composed draw binds: the grid family by the shared
 * kind decode, a shader material by its variant index. The composed
 * families never reach here — the pinned dispatch above owns every PBR,
 * Standard and node draw — so those families refuse by dispatch name.
 * `dispatch` names the calling pass ("main dispatch" / "task dispatch").
 */
SDL_GPUGraphicsPipeline* secondary_pipeline_for(
    const SecondaryPipelines& pipelines,
    upstream::RenderPipelineKind kind,
    std::uint32_t shader_variant,
    const char* dispatch) {
    const RenderPipelineKindTraits traits = pipeline_kind_traits(kind);
    switch (traits.family) {
        case upstream::RenderMaterialKind::pbr:
            gpu_error(
                (std::string(dispatch) +
                 " reached a PBR pipeline kind; the pinned branch owns "
                 "every PBR draw.")
                    .c_str());
        case upstream::RenderMaterialKind::standard:
            gpu_error(
                (std::string(dispatch) +
                 " reached a Standard pipeline kind; the pinned branch "
                 "owns every Standard draw.")
                    .c_str());
        case upstream::RenderMaterialKind::grid:
            if (traits.transparent) {
                return traits.cull == upstream::RenderCullMode::none
                    ? pipelines.grid_transparent_double_sided
                    : pipelines.grid_transparent;
            }
            return traits.cull == upstream::RenderCullMode::none
                ? pipelines.grid_double_sided
                : pipelines.grid_opaque;
        case upstream::RenderMaterialKind::shader: {
            const std::vector<SDL_GPUGraphicsPipeline*>* variants =
                pipeline_kind_wants_a2c(kind)
                    ? pipelines.shader_a2c
                    : pipelines.shader;
            return variants && shader_variant < variants->size()
                ? (*variants)[shader_variant]
                : nullptr;
        }
        case upstream::RenderMaterialKind::node:
            // Node draws bind their own compiled graphs; a node kind here
            // returns nothing and the caller refuses by name.
            return nullptr;
    }
    return nullptr;
}

GpuMeshSlotMembers mesh_slot_members(
    upstream::MaterialTextureSource source) {
    using Source = upstream::MaterialTextureSource;
    switch (source) {
        case Source::base_color:
            return {&GpuMesh::base_color, &GpuMesh::base_color_sampler};
        case Source::specular_or_metallic_roughness:
            return {
                &GpuMesh::metallic_roughness,
                &GpuMesh::metallic_roughness_sampler};
        case Source::opacity_or_normal:
            return {&GpuMesh::normal, &GpuMesh::normal_sampler};
        case Source::ambient_or_emissive:
            return {&GpuMesh::emissive, &GpuMesh::emissive_sampler};
        case Source::standard_emissive:
            return {
                &GpuMesh::standard_emissive,
                &GpuMesh::standard_emissive_sampler};
        case Source::transmission:
            return {&GpuMesh::transmission, &GpuMesh::transmission_sampler};
        case Source::thickness:
            return {&GpuMesh::thickness, &GpuMesh::thickness_sampler};
#if BBLITE_MATERIAL_CLEARCOAT
        case Source::clearcoat:
            return {&GpuMesh::clearcoat, &GpuMesh::clearcoat_sampler};
        case Source::clearcoat_roughness:
            return {
                &GpuMesh::clearcoat_roughness,
                &GpuMesh::clearcoat_roughness_sampler};
        case Source::clearcoat_normal:
            return {
                &GpuMesh::clearcoat_normal,
                &GpuMesh::clearcoat_normal_sampler};
#endif
#if BBLITE_MATERIAL_SHEEN
        case Source::sheen_color:
            return {&GpuMesh::sheen_color, &GpuMesh::sheen_color_sampler};
        case Source::sheen_roughness:
            return {
                &GpuMesh::sheen_roughness,
                &GpuMesh::sheen_roughness_sampler};
#endif
#if BBLITE_MATERIAL_IRIDESCENCE
        case Source::iridescence:
            return {&GpuMesh::iridescence, &GpuMesh::iridescence_sampler};
        case Source::iridescence_thickness:
            return {
                &GpuMesh::iridescence_thickness,
                &GpuMesh::iridescence_thickness_sampler};
#endif
#if BBLITE_MATERIAL_METALLIC_REFLECTANCE_MAP
        case Source::metallic_reflectance:
            return {
                &GpuMesh::metallic_reflectance,
                &GpuMesh::metallic_reflectance_sampler};
#endif
#if BBLITE_MATERIAL_REFLECTANCE_MAP
        case Source::reflectance:
            return {
                &GpuMesh::reflectance,
                &GpuMesh::reflectance_sampler};
#endif
#if BBLITE_MATERIAL_SPEC_GLOSS
        case Source::spec_gloss:
            return {&GpuMesh::spec_gloss, &GpuMesh::spec_gloss_sampler};
#endif
#if BBLITE_MATERIAL_OCCLUSION_UV2
        case Source::occlusion_uv2:
            return {&GpuMesh::occlusion, &GpuMesh::occlusion_sampler};
#endif
#if BBLITE_MATERIAL_STANDARD_BUMP
        case Source::standard_bump:
            return {
                &GpuMesh::standard_bump,
                &GpuMesh::standard_bump_sampler};
#endif
#if BBLITE_MATERIAL_STANDARD_REFLECTION
        case Source::standard_reflection:
            return {
                &GpuMesh::standard_reflection,
                &GpuMesh::standard_reflection_sampler};
#endif
        default:
            return {};
    }
}

/**
 * A shader material's own texture/sampler pairs, at the registers the
 * compaction pass gave them.
 *
 * The pairs were uploaded in the order the material declared them and
 * reordered at upload against this stage's `.slots` sidecar, so this only
 * binds what that produced. Empty for every other family, and for a stage
 * whose pairs the shader compiler dropped.
 */
void bind_shader_material_textures(
    SDL_GPURenderPass* pass,
    const GpuMesh& mesh) {
    if (mesh.shader_textures.empty()) return;
    SDL_BindGPUFragmentSamplers(
        pass,
        0,
        mesh.shader_textures.data(),
        static_cast<Uint32>(mesh.shader_textures.size()));
}

void bind_mesh_vertex_buffers(
    SDL_GPURenderPass* pass,
    const GpuMesh& mesh) {
#if BBLITE_GPU_INSTANCE_COLORS
    // The matrix pool at slot 1 and the per-instance RGBA rows at slot 2,
    // which the line family's vertex stage reads as `instanceColor`.
    const std::array<SDL_GPUBufferBinding, 3> bindings{
        SDL_GPUBufferBinding{mesh.vertices, 0},
        SDL_GPUBufferBinding{mesh.instances, 0},
        SDL_GPUBufferBinding{mesh.instance_colors, 0},
    };
    SDL_BindGPUVertexBuffers(
        pass,
        0,
        bindings.data(),
        static_cast<Uint32>(bindings.size()));
#elif BBLITE_GPU_INSTANCING
    const std::array<SDL_GPUBufferBinding, 2> bindings{
        SDL_GPUBufferBinding{mesh.vertices, 0},
        SDL_GPUBufferBinding{mesh.instances, 0},
    };
    SDL_BindGPUVertexBuffers(
        pass,
        0,
        bindings.data(),
        static_cast<Uint32>(bindings.size()));
#else
    const SDL_GPUBufferBinding binding{
        mesh.vertices,
        0,
    };
    SDL_BindGPUVertexBuffers(
        pass,
        0,
        &binding,
        1);
#endif
#if BBLITE_GPU_MORPH_STORAGE
    const std::array<SDL_GPUBuffer*, 2> storage{
        mesh.morph_deltas,
        mesh.morph_weights,
    };
    SDL_BindGPUVertexStorageBuffers(
        pass,
        0,
        storage.data(),
        static_cast<Uint32>(storage.size()));
#endif
}

struct GpuBackground {
    SDL_GPUBuffer* vertices = nullptr;
    SDL_GPUBuffer* indices = nullptr;
    SDL_GPUTexture* texture = nullptr;
    bool enabled = false;
};

struct GpuSkybox {
    SDL_GPUBuffer* vertices = nullptr;
    SDL_GPUBuffer* indices = nullptr;
    SDL_GPUTexture* texture = nullptr;
    bool owns_texture = false;
    bool enabled = false;
};

#if BBLITE_IMAGE_SKYBOX
struct GpuImageSkybox {
    SDL_GPUBuffer* vertices = nullptr;
    SDL_GPUBuffer* indices = nullptr;
    SDL_GPUTexture* texture = nullptr;
    SDL_GPUGraphicsPipeline* pipeline = nullptr;
    bool enabled = false;
};
#endif

#if BBLITE_SOLID_SKYBOX
// The clear-colour cube samples nothing, so it carries no texture: its
// fragment writes scene.clearColor plus the pinned dither.
struct GpuSolidSkybox {
    SDL_GPUBuffer* vertices = nullptr;
    SDL_GPUBuffer* indices = nullptr;
    SDL_GPUGraphicsPipeline* pipeline = nullptr;
    bool enabled = false;
};
#endif

struct GpuRenderTarget {
    SDL_GPUTexture* color = nullptr;
    SDL_GPUTexture* sampled_color = nullptr;
    SDL_GPUTexture* depth = nullptr;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    /** What its colour attachment resolved to, for a target that follows it. */
    SDL_GPUTextureFormat color_format = SDL_GPU_TEXTUREFORMAT_INVALID;
};

#if defined(BBLITE_HAS_POST_PROCESS) && BBLITE_HAS_POST_PROCESS
/**
 * One post-process pass's SDL_GPU state.
 *
 * The pin keeps its pipeline, bind group and uniform buffer on the task; this
 * backend pushes uniforms per pass instead of binding a buffer, so what
 * survives is the pipeline and the slots the compaction assigned each stage.
 */
/** SDL_GPU's per-stage sampler cap; a pass binds a source plus its extras. */
inline constexpr std::size_t max_post_process_textures = 8;

/**
 * The stage pair and pipeline a pass draws with, shared by every pass that
 * draws the same way.
 *
 * A composite chains passes that differ only in their bindings and uniforms --
 * depth of field's six blurs are one deployed module and one pipeline state --
 * so building per pass would read the same files and compile the same shaders
 * once each. The key is everything a pipeline is made of.
 */
struct GpuPostProcessProgram {
    std::uint32_t module_index = 0;
    SDL_GPUTextureFormat format = SDL_GPU_TEXTUREFORMAT_INVALID;
    SDL_GPUSampleCount samples = SDL_GPU_SAMPLECOUNT_1;
    std::uint32_t alpha_mode = 0;
    SDL_GPUGraphicsPipeline* pipeline = nullptr;
    PinnedStageSlots vertex_slots;
    PinnedStageSlots fragment_slots;
};

struct GpuPostProcessTask {
    /** Borrowed from `GpuState::post_process_programs`, which owns it. */
    const GpuPostProcessProgram* program = nullptr;
    /**
     * What each fragment texture slot names, resolved from the `.slots`
     * sidecar once: -1 is the pass's source, and 0.. indexes its extra
     * textures in the effect's own order.
     */
    std::vector<int> texture_sources;
    /** The effect's uniform block, sized once and refilled per frame. */
    std::vector<float> uniform_data;
};
#endif

struct GpuGeometryTask {
    std::vector<SDL_GPUTexture*> colors;
    std::vector<SDL_GPUTexture*> sampled_colors;
    SDL_GPUTexture* depth = nullptr;
    // The pin's gpUniforms.previousViewProjection: last frame's task
    // matrix, seeded with the current one on the first frame.
    std::array<float, 16> previous_view_projection{};
    bool has_previous_view_projection = false;
    // The task's gpUniforms as a real buffer. SDL_GPU caps uniform
    // buffers at four per stage and the composed Standard geometry
    // fragments spend all four on scene, lights, mesh and mat, so the
    // shader compile demotes their gp block to a read-only storage
    // buffer and the encode uploads its contents here each frame.
    SDL_GPUBuffer* params = nullptr;
    /** Set with the textures: another task binds this task's depth. */
    bool depth_borrowed = false;
};

#if BBLITE_PINNED_MATERIALS
/** A texture and its sampler, resolved from the pin's own name for a binding. */
struct PinnedResource {
    SDL_GPUTexture* texture = nullptr;
    SDL_GPUSampler* sampler = nullptr;
};
#endif

struct GpuState {
    SDL_Window* window = nullptr;
    SDL_GPUDevice* device = nullptr;
    SDL_GPUGraphicsPipeline* grid_pipeline = nullptr;
    SDL_GPUGraphicsPipeline* grid_double_sided_pipeline = nullptr;
    SDL_GPUGraphicsPipeline* grid_transparent_pipeline = nullptr;
    SDL_GPUGraphicsPipeline*
        grid_transparent_double_sided_pipeline = nullptr;
    // One pipeline (plus an alpha-to-coverage twin) per generated
    // shader variant, indexed by the variant id from the emitted table.
    std::vector<SDL_GPUGraphicsPipeline*> shader_pipelines;
    std::vector<SDL_GPUGraphicsPipeline*>
        shader_a2c_pipelines;
    // What the compaction pass assigned each shader-material stage, by the
    // caller's own block and sampler names. The stage's contents depend on
    // scene code, so this sidecar -- not the WGSL, and not the reflection
    // generation derived from it -- is the authority on its registers.
    std::vector<PinnedStageSlots> shader_vertex_slots;
    std::vector<PinnedStageSlots> shader_fragment_slots;
#if defined(BBLITE_HAS_EFFECT_TASK) && BBLITE_HAS_EFFECT_TASK
    // One built pass per effect render task, keyed by task index and built
    // lazily against the target's own format and sample count -- the pin
    // keys its own pipeline cache by exactly that pair.
    std::vector<EffectPass> effect_tasks;
#endif
    SDL_GPUGraphicsPipeline* background_pipeline = nullptr;
    SDL_GPUGraphicsPipeline* skybox_pipeline = nullptr;
    SDL_GPUGraphicsPipeline* id_pipeline = nullptr;
    SDL_GPUGraphicsPipeline* id_double_sided_pipeline = nullptr;
    SDL_GPUGraphicsPipeline* cluster_pipeline = nullptr;
    SDL_GPUGraphicsPipeline* cluster_double_sided_pipeline = nullptr;
    SDL_GPUGraphicsPipeline* blit_pipeline = nullptr;
    SDL_GPUGraphicsPipeline* blit_msaa_pipeline = nullptr;
    SDL_GPUGraphicsPipeline* image_processing_pipeline = nullptr;
    bool per_sample_image_processing = false;
    std::array<SDL_GPUGraphicsPipeline*, 2> depth_only_pipelines{};
    std::array<SDL_GPUGraphicsPipeline*, 2>
        depth_only_double_sided_pipelines{};
    SDL_GPUSampler* sampler = nullptr;
    SDL_GPUSampler* background_sampler = nullptr;
    SDL_GPUSampler* transmission_sampler = nullptr;
    SDL_GPUSampler* ground_sampler = nullptr;
#if BBLITE_GPU_MORPH_STORAGE
    // Shared zero-count pair bound for draws whose mesh has no morph
    // targets; the shader's storage loop then runs zero iterations.
    SDL_GPUBuffer* empty_morph_deltas = nullptr;
    SDL_GPUBuffer* empty_morph_weights = nullptr;
#endif
    SDL_GPUSampler* depth_sampler = nullptr;
    SDL_GPUTexture* environment = nullptr;
    SDL_GPUTexture* brdf_lut = nullptr;
    SDL_GPUTexture* reflection_fallback = nullptr;
    std::vector<SDL_GPUTexture*> reflection_cubes;
    SDL_GPUTexture* color = nullptr;
    SDL_GPUTexture* processed_color = nullptr;
    SDL_GPUTexture* transmission_color = nullptr;
    SDL_GPUTexture* msaa_color = nullptr;
    SDL_GPUTexture* depth = nullptr;
#if BBLITE_PBR_VARIANTS > 0
    // One pipeline per (variant, pipeline kind): the kind carries the cull mode,
    // the winding a mirrored node needs and the blend and depth state, exactly
    // as it does for the transcribed pipelines.
    std::map<std::size_t, SDL_GPUGraphicsPipeline*> pinned_pipelines;
    // Each variant's stage slot maps, read once from the `.slots` sidecars.
    std::vector<PinnedStageSlots> pinned_vertex_slots;
    std::vector<PinnedStageSlots> pinned_fragment_slots;
    // Paired with every bone palette binding. The pin reads the palette with
    // textureLoad, so the sampler is never consulted; SDL_GPU still binds the
    // pair together.
    SDL_GPUSampler* pinned_bone_sampler = nullptr;
#endif
#if BBLITE_SHADOW_RECEIVERS
    /**
     * The receiver side of the shadow family, one entry per generator.
     *
     * The map is the generator's depth target; the block is the pin's
     * `shadowInfo_N` receiver UBO, kept both as bytes (the vertex stage
     * reads it as a uniform) and as a real buffer (the fragment reads it
     * as a storage buffer, because the shader compile demotes it out of
     * SDL_GPU's four uniform slots -- the same treatment the geometry
     * tasks' `gp` block takes).
     */
    struct ShadowGenerator {
        SDL_GPUTexture* map = nullptr;
        SDL_GPUBuffer* info = nullptr;
        upstream::ShadowInfoUniforms block{};
    };
    std::vector<ShadowGenerator> shadow_generators;
    SDL_GPUSampler* shadow_comparison_sampler = nullptr;
    SDL_GPUSampler* shadow_filtering_sampler = nullptr;
#if BBLITE_SHADOWS_ESM
    /**
     * One ESM generator's blur, by its own ESM ordinal -- the row
     * generation emitted its recorded resources under.
     *
     * The pin blurs the ESM colour map horizontally into the first half and
     * vertically into the second, and that second one IS `sg._depthTexture`,
     * what the receiver samples. The PIPELINE is per generator too: the blur
     * fragment's tap table is folded from that generator's own `blurKernel`,
     * so two kernels are two shaders.
     */
    struct EsmBlur {
        SDL_GPUTexture* source = nullptr;
        SDL_GPUTexture* blur_h = nullptr;
        SDL_GPUTexture* blur_v = nullptr;
        SDL_GPUGraphicsPipeline* pipeline = nullptr;
        /** `sg._shadowParamsUBO`, as bytes the caster stage is pushed. */
        std::array<float, 8> params{};
    };
    std::vector<EsmBlur> esm_blurs;
#endif
    /** The shared walk's carriers, whose layout it owns. */
    pal::ShadowRefreshState shadow_refresh;
#endif

#if BBLITE_STANDARD_VARIANTS > 0
    // The Standard family's composed pipelines and slot maps, keyed and
    // cached exactly like the PBR ones.
    std::map<std::size_t, SDL_GPUGraphicsPipeline*> standard_variant_pipelines;
    std::vector<PinnedStageSlots> standard_vertex_slots;
    std::vector<PinnedStageSlots> standard_fragment_slots;
#endif
#if BBLITE_NODE_VARIANTS > 0
    // The node family's pipelines and slot maps, cached the same way.
    std::map<std::size_t, SDL_GPUGraphicsPipeline*> node_variant_pipelines;
    std::vector<PinnedStageSlots> node_vertex_slots;
    std::vector<PinnedStageSlots> node_fragment_slots;
#endif
#if BBLITE_PINNED_MATERIALS
    SDL_GPUTextureFormat pinned_color_format =
        SDL_GPU_TEXTUREFORMAT_INVALID;
#endif
    SDL_GPUTextureFormat depth_format =
        SDL_GPU_TEXTUREFORMAT_D16_UNORM;
    SDL_GPUSampleCount sample_count = SDL_GPU_SAMPLECOUNT_1;
#if BBLITE_HAS_BILLBOARDS
    std::vector<BillboardPass> billboard_passes;
#endif
#if BBLITE_HAS_SPLATS
    std::vector<SplatPass> splat_passes;
#endif
    std::uint32_t color_width = 0;
    std::uint32_t color_height = 0;
    std::uint32_t processed_color_width = 0;
    std::uint32_t processed_color_height = 0;
    std::uint32_t transmission_width = 0;
    std::uint32_t transmission_height = 0;
    std::uint32_t msaa_color_width = 0;
    std::uint32_t msaa_color_height = 0;
    std::uint32_t depth_width = 0;
    std::uint32_t depth_height = 0;
    std::uint32_t frame_graph_width = 0;
    std::uint32_t frame_graph_height = 0;
    std::vector<GpuMesh> meshes;
    std::vector<GpuRenderTarget> render_targets;
    std::vector<GpuGeometryTask> geometry_tasks;
#if defined(BBLITE_HAS_POST_PROCESS) && BBLITE_HAS_POST_PROCESS
    // Per frame task, one entry per pass it records.
    std::vector<std::vector<GpuPostProcessTask>> post_process_tasks;
    /** The distinct stage pairs and pipelines those passes draw with. */
    std::vector<GpuPostProcessProgram> post_process_programs;
    // A pass that presents renders here first: SDL_GPU swapchain textures
    // are not readable, and the capture has to read what the pass produced.
    SDL_GPUTexture* post_process_present = nullptr;
    // The pin's own `getBilinearSampler` and `getNearestSampler`: linear or
    // nearest filtering over WebGPU's defaults, which is clamp addressing
    // and no mip filtering.
    SDL_GPUSampler* post_process_bilinear_sampler = nullptr;
    SDL_GPUSampler* post_process_nearest_sampler = nullptr;
#endif
    GpuBackground background;
    GpuSkybox skybox;
#if BBLITE_IMAGE_SKYBOX
    GpuImageSkybox image_skybox;
#endif
#if BBLITE_SOLID_SKYBOX
    GpuSolidSkybox solid_skybox;
#endif
#if BBLITE_GPU_INSTANCING
    // Identity per-instance matrix shared by the background ground and
    // skybox draws: the shared material vertex stage consumes the
    // per-instance attribute slots whenever instancing is compiled in,
    // so background quads must bind a valid one-element instance
    // stream.
    SDL_GPUBuffer* background_instances = nullptr;
#endif
};

// Geometry-task helpers shared by the PBR and Standard variant
// pipelines; the definitions sit with the transmission helpers below.
SDL_GPUSampleCount task_sample_count(
    const GpuState& state,
    std::uint32_t requested);
SDL_GPUTextureFormat texture_format(TextureFormatClass format);
SDL_GPUTextureFormat geometry_texture_format(
    const GeometryTextureDescription& description);

#if BBLITE_PINNED_MATERIALS
/**
 * One declared vertex input, resolved onto our vertex and into SDL's format
 * enum. The Dawn sibling reads the same `pinned_vertex_input` table; only the
 * enum residue and the buffer slot differ.
 */
bool append_variant_attribute(
    std::string_view name,
    Uint32 location,
    bool uses_local_position,
    std::vector<SDL_GPUVertexAttribute>& attributes) {
    const PinnedVertexInput input =
        pinned_vertex_input(name, uses_local_position);
    if (!input.mapped) return false;
    SDL_GPUVertexAttribute attribute{};
    attribute.location = location;
    attribute.buffer_slot = input.instance_stream ? 1u : 0u;
    attribute.offset = static_cast<Uint32>(input.offset);
    switch (input.lane) {
        case VertexInputLane::float2:
            attribute.format = SDL_GPU_VERTEXELEMENTFORMAT_FLOAT2;
            break;
        case VertexInputLane::float3:
            attribute.format = SDL_GPU_VERTEXELEMENTFORMAT_FLOAT3;
            break;
        case VertexInputLane::float4:
            attribute.format = SDL_GPU_VERTEXELEMENTFORMAT_FLOAT4;
            break;
        case VertexInputLane::uint4:
            attribute.format = SDL_GPU_VERTEXELEMENTFORMAT_UINT4;
            break;
    }
    attributes.push_back(attribute);
    return true;
}
#endif

#if BBLITE_PINNED_MATERIALS
#if BBLITE_SHADOW_RECEIVERS
/**
 * The composed group-2 row one binding name belongs to, or null.
 *
 * `createShadowFragment` names every binding after its light's slot in
 * `scene.lights` AND picks its type from that light's filter, so both facts
 * are reflected into the generated rows. Reading the row is what keeps this
 * backend from parsing a name to answer either -- the same discipline
 * `standard_binding_resources` already holds for the group-1 slots. Taken as
 * a span so both material families' receivers resolve through one lookup:
 * they wrap one pinned core, so their rows are one shape.
 */
const upstream::PinnedShadowBinding* shadow_row_for(
    std::span<const upstream::PinnedShadowBinding> rows,
    const std::string& name) {
    for (const upstream::PinnedShadowBinding& row : rows) {
        if (name == row.name) return &row;
    }
    return nullptr;
}

/** The sampler row declared beside one light's map. */
const upstream::PinnedShadowBinding* shadow_sampler_row_for(
    std::span<const upstream::PinnedShadowBinding> rows,
    std::uint32_t light) {
    for (const upstream::PinnedShadowBinding& row : rows) {
        if (
            row.light == light &&
            row.role == upstream::PinnedShadowRole::map_sampler) {
            return &row;
        }
    }
    return nullptr;
}

/**
 * The map-and-sampler pair one group-2 texture name resolves to, or an empty
 * pair when the name is not a receiver binding.
 */
/**
 * The receiver block one group-2 name resolves to, or null.
 *
 * The buffer half of `shadow_resource_for`'s question: the vertex stage reads
 * the block as a uniform and the fragment as a storage buffer, because the
 * shader compile demotes it out of SDL_GPU's four uniform slots -- so both
 * stages ask by name, for both material families, through one lookup.
 */
inline SDL_GPUBuffer* shadow_info_buffer_for(
    const GpuState& state,
    std::span<const upstream::PinnedShadowBinding> rows,
    const std::string& name) {
    const upstream::PinnedShadowBinding* row = shadow_row_for(rows, name);
    if (row == nullptr) return nullptr;
    if (row->light >= state.shadow_generators.size()) {
        gpu_error("a composed shadow binding names a missing light.");
    }
    return state.shadow_generators[row->light].info;
}

/** The same block as uniform bytes, for the stage that kept it a uniform. */
inline PinnedStageBlock shadow_info_uniform_for(
    const GpuState& state,
    std::span<const upstream::PinnedShadowBinding> rows,
    const std::string& block) {
    const upstream::PinnedShadowBinding* row = shadow_row_for(rows, block);
    if (row == nullptr) return {};
    if (row->light >= state.shadow_generators.size()) {
        gpu_error("a composed shadow block names a missing light.");
    }
    return {
        &state.shadow_generators[row->light].block,
        sizeof(upstream::ShadowInfoUniforms),
    };
}

PinnedResource shadow_resource_for(
    const GpuState& state,
    std::span<const upstream::PinnedShadowBinding> rows,
    const std::string& name) {
    const upstream::PinnedShadowBinding* row = shadow_row_for(rows, name);
    if (row == nullptr) return {};
    if (row->light >= state.shadow_generators.size()) {
        gpu_error("a composed shadow binding names a missing light.");
    }
    // SDL_GPU binds a texture and its sampler as one pair, resolved from
    // the TEXTURE's name -- so which sampler this map takes is the
    // paired row's to say, not this one's: a PCF map's companion is
    // declared `sampler_comparison`, an ESM map's a plain `sampler`.
    const upstream::PinnedShadowBinding* companion =
        shadow_sampler_row_for(rows, row->light);
    if (!companion) {
        gpu_error(
            ("a composed shadow map '" + std::string(row->name) +
             "' declares no sampler beside it.")
                .c_str());
    }
    return {
        state.shadow_generators[row->light].map,
        companion->kind ==
                upstream::PinnedBindingKind::samplerComparison
            ? state.shadow_comparison_sampler
            : state.shadow_filtering_sampler,
    };
}
#endif

/**
 * The scene-owned pair one slot source names, or an empty pair.
 *
 * A source outside the mesh's own slots is served by something this backend
 * holds for the whole scene, and every composed family -- PBR, Standard and
 * node alike -- wants the same answer, so the pairing is stated once here
 * rather than per family.
 */
PinnedResource state_resource_for(
    const GpuState& state,
    upstream::MaterialTextureSource source) {
    switch (source) {
        case upstream::MaterialTextureSource::environment_cube:
            return {state.environment, state.sampler};
        case upstream::MaterialTextureSource::brdf_lut:
            return {state.brdf_lut, state.background_sampler};
        case upstream::MaterialTextureSource::scene_color:
            // The pin's transmission grab: the 1024x1024 mip-chained scene
            // colour copied out mid-pass, sampled trilinear-anisotropic.
            return {state.transmission_color, state.transmission_sampler};
        default:
            return {};
    }
}
#endif

/**
 * The pass-dependent depth state, applied the same way by all three family
 * builders.
 *
 * `createShadowRenderTarget` is the pin's ONE exception to this port's
 * depth convention, and it moves three things at once: the compare, the
 * sample count and the attachment format. A caster is drawn through
 * whichever family its own material belongs to, so a builder that answered
 * this for itself would be right only for the casters that family happens
 * to own -- which is how the PBR family came to draw its casters under the
 * main pass's reverse-Z state.
 */
void apply_pass_depth_state(
    SDL_GPUGraphicsPipelineCreateInfo& info,
    const GpuState& state,
    bool shadow_pass) {
    info.depth_stencil_state.compare_op =
        gpu_depth_compare(pal::pass_depth_compare(shadow_pass));
    info.depth_stencil_state.enable_depth_test = true;
    info.multisample_state.sample_count = shadow_pass
        ? task_sample_count(state, pal::pass_depth_samples(true, 1))
        : state.sample_count;
    info.target_info.depth_stencil_format = shadow_pass
        ? SDL_GPU_TEXTUREFORMAT_D32_FLOAT
        : state.depth_format;
    info.target_info.has_depth_stencil_target = true;
}

#if BBLITE_PBR_VARIANTS > 0
/**
 * Which of our resources the pin's own name for a binding refers to.
 *
 * The name→slot association is the generated `material_texture_slots`
 * table — the same rows the Dawn backend resolves — so this keeps only the
 * translation onto this backend's own storage: named mesh members for the
 * slot rows, named state for the scene-owned rows. A variant that declares
 * a resource the table does not know fails by name instead of sampling
 * whatever sat at that index.
 */
PinnedResource pinned_resource_for(
    const GpuState& state,
    const GpuMesh& mesh,
    const std::string& name,
    [[maybe_unused]] std::size_t variant) {
    const upstream::MaterialTextureSlot* slot =
        material_slot_for_binding(name);
    if (slot != nullptr) {
        if (slot->slot != upstream::material_texture_no_slot) {
            const GpuMeshSlotMembers members =
                mesh_slot_members(slot->source);
            if (members.texture != nullptr) {
                return {mesh.*members.texture, mesh.*members.sampler};
            }
        } else {
            const PinnedResource resource =
                state_resource_for(state, slot->source);
            if (resource.texture != nullptr) return resource;
            if (
                slot->source ==
                upstream::MaterialTextureSource::bone_palette) {
                // The texture is the mesh's; only the sampler is the
                // scene's, so this one row cannot join the resolver above.
                return {
                    mesh.pinned_bone_texture,
                    state.pinned_bone_sampler};
            }
        }
    }
#if BBLITE_PBR_SHADOWS
    // The receiver's group 2, resolved from its own composed rows exactly as
    // the Standard family's is: this backend binds by name, so group 2 joins
    // the same lookup rather than being a separate bind call. Asked AFTER the
    // slot table because the two name sets are disjoint and a material
    // texture is the common case -- walking the shadow rows first would make
    // every base-colour and ORM binding pay for it.
    if (const PinnedResource shadow = shadow_resource_for(
            state,
            pal::pbr_shadow_rows(variant),
            name);
        shadow.texture != nullptr) {
        return shadow;
    }
#endif
    gpu_error(
        ("pinned variant declares an unmapped resource '" + name + "'.")
            .c_str());
    return {};
}

/**
 * Load a variant's slot maps if they are not loaded.
 *
 * Separate from the pipeline because the draw path reads them before it decides
 * whether to take the pinned branch: how many uniform blocks a stage ended up
 * with is one of the properties it gates on.
 */
void ensure_pinned_slots(GpuState& state, std::size_t variant);

/** The stem the shader compiler deployed a variant's stage under. */
std::string pinned_stage_name(std::string_view file) {
    return "variant-" + std::string(file.substr(0, file.find(".wgsl")));
}

void ensure_pinned_slots(GpuState& state, std::size_t variant) {
    if (state.pinned_vertex_slots.size() < upstream::pbr_variants.size()) {
        state.pinned_vertex_slots.resize(upstream::pbr_variants.size());
        state.pinned_fragment_slots.resize(upstream::pbr_variants.size());
    }
    if (!state.pinned_vertex_slots[variant].uniforms.empty()) return;
    const upstream::PbrVariantEntry& entry = upstream::pbr_variants[variant];
    state.pinned_vertex_slots[variant] =
        read_pinned_stage_slots(pinned_stage_name(entry.vertex_shader));
    state.pinned_fragment_slots[variant] =
        read_pinned_stage_slots(pinned_stage_name(entry.fragment_shader));
}



/**
 * The graphics pipeline for one composed variant under one pipeline kind.
 *
 * The stages are Babylon's own text, entered at `main` -- the name the pin gives
 * both -- with only their register addressing moved into this backend's spaces.
 * The resource counts come from the variant table and its slot map rather than
 * from a constant here, because they differ per variant: an unlit fragment binds
 * two uniform slots where a lit one binds three.
 */
SDL_GPUGraphicsPipeline* pinned_variant_pipeline(
    GpuState& state,
    std::size_t variant,
    upstream::RenderPipelineKind kind,
    // The geometry-output task an MRT variant draws in. A geometry variant
    // is composed for exactly one task, so the variant-keyed cache stays
    // valid with the task's targets baked into its pipeline.
    const FrameTaskRecord* geometry_task = nullptr,
    // The pin's one exception to this port's depth convention: a shadow
    // caster pass renders standard-Z into the generator's own
    // `depth32float` map, at one sample. The Standard sibling takes the
    // same flag -- a caster is drawn through whichever family its own
    // material belongs to, so a depth state either family answered alone
    // would be right only for the casters that family happens to own.
    bool shadow_pass = false) {
    const std::size_t key =
        pal::variant_pipeline_key(variant, kind, {shadow_pass});
    const auto existing = state.pinned_pipelines.find(key);
    if (existing != state.pinned_pipelines.end()) return existing->second;
    ensure_pinned_slots(state, variant);
    const upstream::PbrVariantEntry& entry = upstream::pbr_variants[variant];
    const std::string vertex_name = pinned_stage_name(entry.vertex_shader);
    const std::string fragment_name = pinned_stage_name(entry.fragment_shader);
    const PinnedStageSlots& vertex_slots = state.pinned_vertex_slots[variant];
    const PinnedStageSlots& fragment_slots =
        state.pinned_fragment_slots[variant];
    SDL_GPUShader* vertex_shader = load_shader(
        state.device,
        vertex_name.c_str(),
        SDL_GPU_SHADERSTAGE_VERTEX,
        static_cast<Uint32>(vertex_slots.textures.size()),
        static_cast<Uint32>(vertex_slots.uniforms.size()),
        "main",
        static_cast<Uint32>(vertex_slots.storage.size()));
    SDL_GPUShader* fragment_shader = load_shader(
        state.device,
        fragment_name.c_str(),
        SDL_GPU_SHADERSTAGE_FRAGMENT,
        static_cast<Uint32>(fragment_slots.textures.size()),
        static_cast<Uint32>(fragment_slots.uniforms.size()),
        "main",
        static_cast<Uint32>(fragment_slots.storage.size()));

    // The variant's own inputs, at the locations it declares them. The names are
    // the pin's; where each sits in our vertex is this backend's.
    std::vector<SDL_GPUVertexAttribute> attributes;
    attributes.reserve(entry.attribute_count);
    for (std::size_t index = 0; index < entry.attribute_count; ++index) {
        const upstream::PbrVariantAttribute& input =
            upstream::pbr_variant_attributes[entry.first_attribute + index];
        if (
            !append_variant_attribute(
                input.name,
                input.location,
                entry.uses_local_position,
                attributes)) {
            gpu_error(
                ("pinned variant declares an unmapped vertex input '" +
                 std::string(input.name) + "'.")
                    .c_str());
        }
    }

    // The kind carries the fixed-function state, decoded once for both
    // backends (`pipeline_kind_traits`). Reading it here rather than
    // restating per-draw booleans is what keeps a mirrored node's
    // clockwise winding from being lost.
    const RenderPipelineKindTraits traits = pipeline_kind_traits(kind);
    const bool transparent = traits.transparent;
    SDL_GPUColorTargetDescription color_target{};
    color_target.format = state.pinned_color_format;
    if (transparent) {
        color_target.blend_state = blend_state_from(transparent_blend);
    }
    SDL_GPUGraphicsPipelineCreateInfo info{};
    info.vertex_shader = vertex_shader;
    info.fragment_shader = fragment_shader;
    const bool instanced = std::any_of(
        attributes.begin(),
        attributes.end(),
        [](const SDL_GPUVertexAttribute& attribute) {
            return attribute.buffer_slot == 1;
        });
    std::array<SDL_GPUVertexBufferDescription, 2> vertex_buffers{};
    vertex_buffers[0].slot = 0;
    vertex_buffers[0].pitch = sizeof(GpuVertex);
    vertex_buffers[0].input_rate = SDL_GPU_VERTEXINPUTRATE_VERTEX;
    // The thin-instance arm's second stream: one 64-byte matrix per instance.
    vertex_buffers[1].slot = 1;
    vertex_buffers[1].pitch = sizeof(std::array<float, 16>);
    vertex_buffers[1].input_rate = SDL_GPU_VERTEXINPUTRATE_INSTANCE;
    info.vertex_input_state = SDL_GPUVertexInputState{
        vertex_buffers.data(),
        instanced ? 2u : 1u,
        attributes.data(),
        static_cast<Uint32>(attributes.size()),
    };
    info.primitive_type = gpu_primitive_type(traits.topology);
    info.rasterizer_state.fill_mode = SDL_GPU_FILLMODE_FILL;
    info.rasterizer_state.cull_mode = gpu_cull_mode(traits.cull);
    info.rasterizer_state.front_face =
        gpu_front_face(traits.clockwise_front_face);
    info.rasterizer_state.enable_depth_clip = true;
    apply_pass_depth_state(info, state, shadow_pass);
    info.depth_stencil_state.enable_depth_write =
        entry.no_color_output || !transparent;
    // A depth-only view's fragment writes no colour target, and the pass it
    // draws in carries none either.
    info.target_info.color_target_descriptions =
        entry.no_color_output ? nullptr : &color_target;
    info.target_info.num_color_targets = entry.no_color_output ? 0 : 1;
    // A geometry-output MRT variant draws into its task's own attachments:
    // one target per attachment in the shared class list, plus the
    // optional trailing colour output, at the task's sample count -- the
    // same fixed-function state the transcribed geometry pipelines
    // carried. The list and its count assertion come from
    // `geometry_target_classes`; only the API structs are built here.
    std::vector<SDL_GPUColorTargetDescription> geometry_targets;
    if (geometry_task) {
        const GeometryTargetClasses classes =
            geometry_target_classes(*geometry_task);
        require_geometry_target_count(
            classes,
            entry.color_target_count,
            "pinned");
        geometry_targets.reserve(classes.attachments.size() + 1u);
        for (const TextureFormatClass format_class : classes.attachments) {
            SDL_GPUColorTargetDescription target{};
            target.format = texture_format(format_class);
            if (transparent) {
                target.blend_state = blend_state_from(transparent_blend);
            }
            geometry_targets.push_back(target);
        }
        if (classes.trailing_output) {
            SDL_GPUColorTargetDescription target{};
            target.format = state.pinned_color_format;
            if (transparent) {
                target.blend_state = blend_state_from(transparent_blend);
            }
            geometry_targets.push_back(target);
        }
        info.target_info.color_target_descriptions =
            geometry_targets.data();
        info.target_info.num_color_targets =
            static_cast<Uint32>(geometry_targets.size());
        info.multisample_state.sample_count =
            task_sample_count(state, geometry_task->geometry.samples);
        // A geometry task always writes depth, whatever the material's own
        // alpha would have said.
        info.depth_stencil_state.enable_depth_write = true;
    }
    SDL_GPUGraphicsPipeline* pipeline =
        SDL_CreateGPUGraphicsPipeline(state.device, &info);
    if (!pipeline) gpu_error("SDL_CreateGPUGraphicsPipeline pinned variant");
    SDL_ReleaseGPUShader(state.device, vertex_shader);
    SDL_ReleaseGPUShader(state.device, fragment_shader);
    return state.pinned_pipelines.emplace(key, pipeline).first->second;
}

/**
 * The bone palette as the pin's own texture.
 *
 * `skeleton-updater.ts` writes `invMeshWorld * jointWorld * IBM` per bone into
 * an rgba32float row, four texels each. Our MeshRecord::bone_matrices already
 * holds that product -- the mesh world is conjugated into the palette, which is
 * why the transcribed skin path needs no separate world matrix either -- so this
 * uploads it unchanged. Where the Dawn backend writes the texture through its
 * queue at resolve time, a copy pass cannot open inside a render pass, so this
 * backend streams every resolved palette before the frame's passes begin, on
 * its own submission the way the per-frame vertex re-uploads already do.
 */
void write_pinned_bone_texture(
    GpuState& state,
    GpuMesh& mesh,
    const MeshRecord& record) {
    const std::uint32_t bones =
        static_cast<std::uint32_t>(record.bone_matrices.size());
    if (bones == 0) return;
    const BonePaletteLayout palette = bone_palette_layout(bones);
    if (!state.pinned_bone_sampler) {
        SDL_GPUSamplerCreateInfo sampler_info{};
        sampler_info.min_filter = SDL_GPU_FILTER_NEAREST;
        sampler_info.mag_filter = SDL_GPU_FILTER_NEAREST;
        sampler_info.mipmap_mode = SDL_GPU_SAMPLERMIPMAPMODE_NEAREST;
        sampler_info.address_mode_u =
            SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
        sampler_info.address_mode_v =
            SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
        sampler_info.address_mode_w =
            SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
        state.pinned_bone_sampler =
            SDL_CreateGPUSampler(state.device, &sampler_info);
        if (!state.pinned_bone_sampler) {
            gpu_error("SDL_CreateGPUSampler pinned bone palette");
        }
    }
    if (mesh.pinned_bone_count != bones) {
        if (mesh.pinned_bone_texture) {
            SDL_ReleaseGPUTexture(state.device, mesh.pinned_bone_texture);
        }
        SDL_GPUTextureCreateInfo texture_info{};
        texture_info.type = SDL_GPU_TEXTURETYPE_2D;
        texture_info.format = SDL_GPU_TEXTUREFORMAT_R32G32B32A32_FLOAT;
        texture_info.usage = SDL_GPU_TEXTUREUSAGE_SAMPLER;
        texture_info.width = palette.width;
        texture_info.height = palette.height;
        texture_info.layer_count_or_depth = 1;
        texture_info.num_levels = 1;
        texture_info.sample_count = SDL_GPU_SAMPLECOUNT_1;
        mesh.pinned_bone_texture =
            SDL_CreateGPUTexture(state.device, &texture_info);
        if (!mesh.pinned_bone_texture) {
            gpu_error("SDL_CreateGPUTexture pinned bone palette");
        }
        mesh.pinned_bone_count = bones;
    }
    SDL_GPUTransferBufferCreateInfo transfer_info{};
    transfer_info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD;
    transfer_info.size = palette.bytes;
    SDL_GPUTransferBuffer* transfer =
        SDL_CreateGPUTransferBuffer(state.device, &transfer_info);
    if (!transfer) gpu_error("SDL_CreateGPUTransferBuffer");
    void* mapped = SDL_MapGPUTransferBuffer(state.device, transfer, false);
    if (!mapped) gpu_error("SDL_MapGPUTransferBuffer");
    std::memcpy(mapped, record.bone_matrices.data(), palette.bytes);
    SDL_UnmapGPUTransferBuffer(state.device, transfer);
    SDL_GPUCommandBuffer* command =
        SDL_AcquireGPUCommandBuffer(state.device);
    if (!command) gpu_error("SDL_AcquireGPUCommandBuffer");
    SDL_GPUCopyPass* copy = SDL_BeginGPUCopyPass(command);
    SDL_GPUTextureTransferInfo source{
        transfer, 0, palette.width, palette.height};
    SDL_GPUTextureRegion destination{
        mesh.pinned_bone_texture, 0, 0, 0, 0, 0,
        palette.width, palette.height, 1};
    SDL_UploadToGPUTexture(copy, &source, &destination, true);
    SDL_EndGPUCopyPass(copy);
    if (!SDL_SubmitGPUCommandBuffer(command)) {
        gpu_error("SDL_SubmitGPUCommandBuffer");
    }
    SDL_ReleaseGPUTransferBuffer(state.device, transfer);
}

/**
 * Draws one PBR command through the pin's own composed stages.
 *
 * Shared by the main pass and the render-task passes: the blocks build from
 * the pass's own camera and matrix, and everything else -- slots, textures,
 * the skinned and palette-world conventions -- is per draw.
 */
void draw_pinned_variant(
    GpuState& state,
    SDL_GPUCommandBuffer* command,
    SDL_GPURenderPass* pass,
    const Scene& scene,
    const Engine& engine,
    // The pass's scene and lights blocks, built once per pass by the
    // caller (Dawn builds both per frame): their builders run camera and
    // view math that must not repeat per draw.
    const upstream::SceneUniforms& pinned_scene,
    const std::vector<std::uint8_t>& pinned_lights,
    const upstream::RenderDrawCommand& draw,
    const GpuMesh& mesh,
    const MaterialRecord* material,
    std::size_t pinned_variant,
    SDL_GPUGraphicsPipeline*& bound_pipeline,
    // Set for a draw inside a geometry-output task: the task whose targets
    // the MRT pipeline binds, and the pin's gpUniforms block when the
    // variant declares one.
    const FrameTaskRecord* geometry_task = nullptr,
    const PinnedGeometryParams* geometry_params = nullptr,
    // The same block as a buffer, for a fragment whose `gp` the shader
    // compile demoted out of the four uniform slots.
    SDL_GPUBuffer* geometry_params_buffer = nullptr,
    bool shadow_pass = false) {
    const upstream::RenderItem& item = draw.item;
    SDL_GPUGraphicsPipeline* variant_pipeline =
        pinned_variant_pipeline(
            state,
            pinned_variant,
            draw.pipeline,
            geometry_task,
            shadow_pass);
    if (variant_pipeline != bound_pipeline) {
        SDL_BindGPUGraphicsPipeline(pass, variant_pipeline);
        bound_pipeline = variant_pipeline;
    }
    const upstream::PbrVariantEntry& variant_entry =
        upstream::pbr_variants[pinned_variant];
    const MeshRecord& pinned_record =
        engine.meshes[item.mesh.value];
    // `pinned_draw_conventions` states the skinned and
    // palette-world contract these three booleans carry.
    const PinnedDrawConventions conventions =
        pinned_draw_conventions(
            pinned_variant,
            pinned_record);
    const upstream::MeshUniforms pinned_mesh =
        pinned_mesh_block(
            scene,
            engine,
            pinned_draw_world(
                conventions.skeleton_draw,
                conventions.world_from_palette,
                variant_entry.uses_local_position,
                pinned_record),
            item.mesh.value);
    std::vector<std::uint8_t> pinned_material(
        variant_entry.material_ubo_bytes,
        0);
    if (material) {
        upstream::write_pbr_variant_material(
            pinned_variant,
            *material,
            pinned_material.data(),
            pinned_material.size(),
            // The refraction thickness scale the pin's fragment reads off
            // its mesh world, whose scale this backend bakes into vertices.
            pinned_record.baked_world_scale);
    }
    // Each block at the slot the remap assigned it. The
    // order is the `.slots` map's, because a stage can
    // declare a block it never reads and Tint strips it.
    const auto resolve = [&](
                             const std::string& block) -> PinnedStageBlock {
        if (block == "scene") {
            return {&pinned_scene, sizeof(pinned_scene)};
        }
        if (block == "lights") {
            return {pinned_lights.data(), pinned_lights.size()};
        }
        if (block == "mesh") return {&pinned_mesh, sizeof(pinned_mesh)};
        if (block == "material") {
            return {pinned_material.data(), pinned_material.size()};
        }
        if (block == "gp") {
            // The geometry-params block: previous view-projection and
            // camera near/far, built by the geometry task's caller.
            if (!geometry_params) {
                gpu_error(
                    "pinned variant declares gpUniforms outside a "
                    "geometry task.");
            }
            return {geometry_params, sizeof(*geometry_params)};
        }
#if BBLITE_PBR_SHADOWS
        // The receiver block, one per shadow-casting light, named after that
        // light's slot -- read off the composed row rather than parsed.
        if (const PinnedStageBlock info = shadow_info_uniform_for(
                state,
                pal::pbr_shadow_rows(pinned_variant),
                block);
            info.data != nullptr) {
            return info;
        }
#endif
        return {};
    };
    push_stage_uniforms(
        command,
        state.pinned_vertex_slots[pinned_variant],
        false,
        "pinned variant",
        resolve);
    push_stage_uniforms(
        command,
        state.pinned_fragment_slots[pinned_variant],
        true,
        "pinned variant",
        resolve);
    const PinnedStageSlots& pinned_fragment =
        state.pinned_fragment_slots[pinned_variant];
    bind_stage_textures(
        pass,
        pinned_fragment,
        true,
        "pinned variant fragment",
        [&](const std::string& name) {
            const PinnedResource resource =
                pinned_resource_for(state, mesh, name, pinned_variant);
            return SDL_GPUTextureSamplerBinding{
                resource.texture,
                resource.sampler,
            };
        });
    bind_stage_storage(
        pass,
        pinned_fragment,
        true,
        "pinned variant fragment",
        [&](const std::string& name) -> SDL_GPUBuffer* {
            if (name == "gp") return geometry_params_buffer;
#if BBLITE_PBR_SHADOWS
            // The receiver blocks the shader compile demoted out of the
            // uniform slots, the same way the geometry arms' gp block is:
            // SDL_GPU caps those at four per stage and a receiving PBR
            // fragment spends all four on scene, lights, mesh and material.
            if (SDL_GPUBuffer* info = shadow_info_buffer_for(
                    state,
                    pal::pbr_shadow_rows(pinned_variant),
                    name)) {
                return info;
            }
#endif
            return nullptr;
        });
    // The vertex stage's own textures -- the skeleton
    // arm's bone palette -- in the same `.slots` order as
    // the fragment's, and its storage buffers -- the
    // morph arms' deltas and weights, the same buffers
    // the transcribed stage read.
    const PinnedStageSlots& pinned_vertex =
        state.pinned_vertex_slots[pinned_variant];
    bind_stage_storage(
        pass,
        pinned_vertex,
        false,
        "pinned variant vertex",
        [&](const std::string& name) -> SDL_GPUBuffer* {
            // Cast unconditionally: which arms below compile is a capability
            // question, and a compound negative would have to be re-derived
            // every time one is added.
            (void)name;
#if BBLITE_GPU_MORPH_STORAGE
            if (name == "morphDeltas") return mesh.morph_deltas;
            if (name == "morph") return mesh.morph_weights;
#endif
#if BBLITE_PBR_SHADOWS
            // A receiver whose vertex stage also overflows the four uniform
            // slots has its own receiver blocks demoted there too.
            if (SDL_GPUBuffer* info = shadow_info_buffer_for(
                    state,
                    pal::pbr_shadow_rows(pinned_variant),
                    name)) {
                return info;
            }
#endif
            return nullptr;
        });
    bind_stage_textures(
        pass,
        pinned_vertex,
        false,
        "pinned variant vertex",
        [&](const std::string& name) {
            const PinnedResource resource =
                pinned_resource_for(state, mesh, name, pinned_variant);
            return SDL_GPUTextureSamplerBinding{
                resource.texture,
                resource.sampler,
            };
        });
    const SDL_GPUBufferBinding pinned_vertex_binding{
        // Skinned and palette-world draws read the
        // mirrored buffer; the palette carries the mirror
        // on both sides, so unmirrored vertices would
        // apply it three times.
        conventions.mirrored_vertices
            ? mesh.vertices
            : mesh.pinned_vertices,
        0,
    };
    SDL_BindGPUVertexBuffers(
        pass,
        0,
        &pinned_vertex_binding,
        1);
    // The thin-instance arm's second stream and the instance count; a
    // non-instanced variant binds neither and draws once.
    const bool instanced_draw =
        pinned_record_instanced(engine.meshes[item.mesh.value]);
    if (instanced_draw && mesh.pinned_instances) {
        const SDL_GPUBufferBinding pinned_instance_binding{
            mesh.pinned_instances,
            0,
        };
        SDL_BindGPUVertexBuffers(
            pass,
            1,
            &pinned_instance_binding,
            1);
    }
    const SDL_GPUBufferBinding pinned_index_binding{
        mesh.indices,
        0,
    };
    SDL_BindGPUIndexBuffer(
        pass,
        &pinned_index_binding,
        SDL_GPU_INDEXELEMENTSIZE_32BIT);
    SDL_DrawGPUIndexedPrimitives(
        pass,
        mesh.index_count,
        instanced_draw ? mesh.instance_count : 1,
        0,
        0,
        0);
}
#endif

#if BBLITE_NODE_VARIANTS > 0
void ensure_node_slots(GpuState& state, std::size_t variant) {
    if (state.node_vertex_slots.size() < upstream::node_variants.size()) {
        state.node_vertex_slots.resize(upstream::node_variants.size());
        state.node_fragment_slots.resize(upstream::node_variants.size());
    }
    if (!state.node_vertex_slots[variant].uniforms.empty()) return;
    const upstream::NodeVariantEntry& entry =
        upstream::node_variants[variant];
    state.node_vertex_slots[variant] =
        read_pinned_stage_slots(std::string(entry.vertex_stem));
    state.node_fragment_slots[variant] =
        read_pinned_stage_slots(std::string(entry.fragment_stem));
}

/**
 * The pipeline for one compiled node graph.
 *
 * Its two stages are one module entered twice, so both load under the
 * graph's own file names; the vertex inputs are named rather than
 * positional, because the pin's pipeline builder numbers them by emission
 * order rather than by a fixed convention.
 */
SDL_GPUGraphicsPipeline* node_variant_pipeline(
    GpuState& state,
    std::size_t variant,
    upstream::RenderPipelineKind kind,
    // The shadow target's own depth state, taken by every family: a node
    // material casts through its own no-colour view exactly as the other
    // two do.
    bool shadow_pass = false) {
    const std::size_t key =
        pal::variant_pipeline_key(variant, kind, {shadow_pass});
    const auto existing = state.node_variant_pipelines.find(key);
    if (existing != state.node_variant_pipelines.end()) {
        return existing->second;
    }
    ensure_node_slots(state, variant);
    const upstream::NodeVariantEntry& entry =
        upstream::node_variants[variant];
    const PinnedStageSlots& vertex_slots = state.node_vertex_slots[variant];
    const PinnedStageSlots& fragment_slots =
        state.node_fragment_slots[variant];
    SDL_GPUShader* vertex_shader = load_shader(
        state.device,
        std::string(entry.vertex_stem).c_str(),
        SDL_GPU_SHADERSTAGE_VERTEX,
        static_cast<Uint32>(vertex_slots.textures.size()),
        static_cast<Uint32>(vertex_slots.uniforms.size()),
        "vs_main",
        static_cast<Uint32>(vertex_slots.storage.size()));
    SDL_GPUShader* fragment_shader = load_shader(
        state.device,
        std::string(entry.fragment_stem).c_str(),
        SDL_GPU_SHADERSTAGE_FRAGMENT,
        static_cast<Uint32>(fragment_slots.textures.size()),
        static_cast<Uint32>(fragment_slots.uniforms.size()),
        "fs_main",
        static_cast<Uint32>(fragment_slots.storage.size()));
    std::vector<SDL_GPUVertexAttribute> attributes;
    attributes.reserve(entry.attribute_count);
    for (std::size_t index = 0; index < entry.attribute_count; ++index) {
        const upstream::NodeVariantAttribute& input =
            upstream::node_variant_attributes[entry.first_attribute + index];
        if (
            !append_variant_attribute(
                input.name,
                input.location,
                false,
                attributes)) {
            gpu_error(
                ("node variant declares an unmapped vertex input '" +
                 std::string(input.name) + "'.")
                    .c_str());
        }
        if (attributes.back().buffer_slot != 0) {
            gpu_error(
                ("node variant declares the per-instance vertex input '" +
                 std::string(input.name) + "', which its pipeline binds no "
                 "stream for.")
                    .c_str());
        }
    }
    SDL_GPUColorTargetDescription color_target{};
    color_target.format = state.pinned_color_format;
    SDL_GPUGraphicsPipelineCreateInfo info{};
    info.vertex_shader = vertex_shader;
    info.fragment_shader = fragment_shader;
    SDL_GPUVertexBufferDescription vertex_buffer{};
    vertex_buffer.slot = 0;
    vertex_buffer.pitch = sizeof(GpuVertex);
    vertex_buffer.input_rate = SDL_GPU_VERTEXINPUTRATE_VERTEX;
    info.vertex_input_state = SDL_GPUVertexInputState{
        &vertex_buffer,
        1u,
        attributes.data(),
        static_cast<Uint32>(attributes.size()),
    };
    info.primitive_type = SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
    info.rasterizer_state.fill_mode = SDL_GPU_FILLMODE_FILL;
    // The backFaceCulling the graph declared, through the same shared
    // decode as the other families: the reached slice composes no blend,
    // so the kind carries nothing else.
    info.rasterizer_state.cull_mode =
        gpu_cull_mode(pipeline_kind_traits(kind).cull);
    info.rasterizer_state.front_face =
        SDL_GPU_FRONTFACE_COUNTER_CLOCKWISE;
    info.rasterizer_state.enable_depth_clip = true;
    apply_pass_depth_state(info, state, shadow_pass);
    info.depth_stencil_state.enable_depth_write = true;
    info.target_info.color_target_descriptions = &color_target;
    info.target_info.num_color_targets = 1;
    SDL_GPUGraphicsPipeline* pipeline =
        SDL_CreateGPUGraphicsPipeline(state.device, &info);
    if (!pipeline) {
        gpu_error("SDL_CreateGPUGraphicsPipeline node variant");
    }
    SDL_ReleaseGPUShader(state.device, vertex_shader);
    SDL_ReleaseGPUShader(state.device, fragment_shader);
    return state.node_variant_pipelines.emplace(key, pipeline)
        .first->second;
}

/**
 * Draws one node command through the graph's own compiled stages.
 *
 * The blocks are pushed by the names the register remap published beside
 * each stage: the pin's `scene` and `nmeLights` in group 0, its `meshU` and
 * the graph's `nodeU` in group 1. A name the resolver cannot map pushes
 * nothing and fails loudly rather than pushing a neighbour's bytes.
 */
void draw_node_variant(
    GpuState& state,
    SDL_GPUCommandBuffer* command,
    SDL_GPURenderPass* pass,
    const Scene& scene,
    const Engine& engine,
    // The pass's scene and lights blocks, built once per pass by the
    // caller alongside the other composed families'.
    const upstream::SceneUniforms& pinned_scene,
    const std::vector<std::uint8_t>& pinned_lights,
    const upstream::RenderDrawCommand& draw,
    const GpuMesh& mesh,
    std::size_t variant,
    SDL_GPUGraphicsPipeline*& bound_pipeline,
    bool shadow_pass = false) {
    SDL_GPUGraphicsPipeline* variant_pipeline =
        node_variant_pipeline(state, variant, draw.pipeline, shadow_pass);
    if (variant_pipeline != bound_pipeline) {
        SDL_BindGPUGraphicsPipeline(pass, variant_pipeline);
        bound_pipeline = variant_pipeline;
    }
    const upstream::NodeVariantEntry& entry =
        upstream::node_variants[variant];
    const upstream::NodeMeshUniforms node_mesh =
        node_mesh_block(scene, engine, draw.item.mesh.value);
    const auto resolve = [&](
                             const std::string& block) -> PinnedStageBlock {
        if (block == "scene") {
            return {&pinned_scene, sizeof(pinned_scene)};
        }
        if (block == "nmeLights") {
            return {pinned_lights.data(), pinned_lights.size()};
        }
        if (block == "meshU") return {&node_mesh, sizeof(node_mesh)};
        if (block == "nodeU") {
            return {
                &upstream::node_variant_uniform_floats[
                    entry.first_uniform_float],
                entry.ubo_bytes,
            };
        }
        return {};
    };
    push_stage_uniforms(
        command,
        state.node_vertex_slots[variant],
        false,
        "node variant",
        resolve);
    push_stage_uniforms(
        command,
        state.node_fragment_slots[variant],
        true,
        "node variant",
        resolve);
    // Two kinds of name reach a node stage's sampler slots. The graph's own
    // `TextureBlock` bindings are declared `nodeTex_<name>` / `nodeSamp_<name>`
    // around the sanitized block name, so they resolve against the images the
    // scene supplied -- in the variant table's order, which is the order
    // `create_node_material` filled the material's slots in. Every other name
    // is one of the pin's environment resources and carries no slot this
    // table knows, so it joins through the source `node_binding_resources`
    // declares, the pair every other family already resolves.
    const auto resolve_texture =
        [&](const std::string& name) -> SDL_GPUTextureSamplerBinding {
        // The prefix is stripped once rather than re-concatenated onto every
        // candidate: this runs per declared name, per stage, per draw, per
        // frame, and building the comparison strings there allocated three
        // times a binding.
        std::string_view declared(name);
        const bool prefixed = declared.starts_with("nodeTex_")
            ? (declared.remove_prefix(8), true)
            : declared.starts_with("nodeSamp_")
                ? (declared.remove_prefix(9), true)
                : false;
        if (prefixed) {
            for (std::size_t index = 0; index < entry.texture_count; ++index) {
                const upstream::NodeVariantTexture& binding =
                    upstream::node_variant_textures[
                        entry.first_texture + index];
                if (binding.name != declared) continue;
                if (index >= mesh.shader_textures.size()) {
                    gpu_error(
                        "a node graph declares more textures than its "
                        "material carries.");
                }
                return mesh.shader_textures[index];
            }
        }
        const PinnedResource resource = state_resource_for(
            state,
            upstream::node_binding_source(name));
        if (resource.texture == nullptr) {
            gpu_error(
                ("node variant declares an unmapped resource '" + name +
                 "'.")
                    .c_str());
        }
        return SDL_GPUTextureSamplerBinding{
            resource.texture,
            resource.sampler,
        };
    };
    bind_stage_textures(
        pass,
        state.node_vertex_slots[variant],
        false,
        "node variant vertex",
        resolve_texture);
    bind_stage_textures(
        pass,
        state.node_fragment_slots[variant],
        true,
        "node variant fragment",
        resolve_texture);
    const SDL_GPUBufferBinding vertex_binding{mesh.vertices, 0};
    SDL_BindGPUVertexBuffers(pass, 0, &vertex_binding, 1);
    const SDL_GPUBufferBinding index_binding{mesh.indices, 0};
    SDL_BindGPUIndexBuffer(
        pass,
        &index_binding,
        SDL_GPU_INDEXELEMENTSIZE_32BIT);
    SDL_DrawGPUIndexedPrimitives(pass, mesh.index_count, 1, 0, 0, 0);
}
#endif

#if BBLITE_SHADOW_RECEIVERS
/**
 * The generators' matrices, their maps and their receiver blocks.
 *
 * `renderPcfShadowMap` recomputes the light matrix when the light moved and
 * re-uploads the receiver UBO with it; the caster pass then renders through
 * the biased copy. The record's values are rebuilt each frame, which is the
 * same result for a static light and the right one for a moving one. The
 * receiver block is uploaded as a storage buffer as well as kept as bytes,
 * because the composed fragment reads it through the demoted binding while
 * the vertex stage reads it as a uniform.
 */
#if BBLITE_SHADOWS_ESM
// Defined with the frame's own targets, below.
SDL_GPUTexture* create_frame_texture(
    SDL_GPUDevice* device,
    SDL_GPUTextureFormat format,
    SDL_GPUSampleCount samples,
    std::uint32_t width,
    std::uint32_t height,
    SDL_GPUTextureUsageFlags usage);

SDL_GPUTextureFormat esm_texture_format(upstream::EsmTextureFormat format) {
    return format == upstream::EsmTextureFormat::depth32_float
        ? SDL_GPU_TEXTUREFORMAT_D32_FLOAT
        : SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT;
}

/**
 * One ESM generator's blur halves and the pipeline that fills them.
 *
 * Every descriptor is what the pinned factory asked its device for when
 * generation ran it -- the two extents, their format, and the two texel
 * steps -- so nothing about the blur is decided here. Built once, on the
 * frame the generator's own colour map first exists.
 */
GpuState::EsmBlur& ensure_esm_blur(
    GpuState& state,
    const ShadowGeneratorRecord& generator,
    SDL_GPUTexture* source) {
    const std::uint32_t esm_index = generator.esm_index;
    if (state.esm_blurs.size() <= esm_index) {
        state.esm_blurs.resize(esm_index + 1);
    }
    GpuState::EsmBlur& blur = state.esm_blurs[esm_index];
    blur.source = source;
    if (blur.pipeline) return blur;
    // Written once: neither `bias` nor `depthScale` has a setter, which is
    // the same reason Dawn creates its own buffer once.
    blur.params = upstream::shadow_params_block(generator);
    const upstream::EsmShadowResources& resources =
        upstream::esm_shadow_resources[esm_index];
    const upstream::EsmTextureDescriptor& half = resources.textures[2];
    const auto create_half = [&]() {
        return create_frame_texture(
            state.device,
            esm_texture_format(half.format),
            SDL_GPU_SAMPLECOUNT_1,
            half.width,
            half.height,
            SDL_GPU_TEXTUREUSAGE_COLOR_TARGET |
                SDL_GPU_TEXTUREUSAGE_SAMPLER);
    };
    blur.blur_h = create_half();
    blur.blur_v = create_half();
    const std::string stem = "shadow-blur-" + std::to_string(esm_index);
    // The `.slots` sidecars are the only authority on which register each
    // block kept after HLSL compaction, exactly as for a composed variant.
    const PinnedStageSlots vertex_slots =
        read_pinned_stage_slots(stem + ".vert");
    const PinnedStageSlots fragment_slots =
        read_pinned_stage_slots(stem + ".frag");
    SDL_GPUShader* vertex_shader = load_shader(
        state.device,
        (stem + ".vert").c_str(),
        SDL_GPU_SHADERSTAGE_VERTEX,
        static_cast<Uint32>(vertex_slots.textures.size()),
        static_cast<Uint32>(vertex_slots.uniforms.size()),
        "main",
        static_cast<Uint32>(vertex_slots.storage.size()));
    SDL_GPUShader* fragment_shader = load_shader(
        state.device,
        (stem + ".frag").c_str(),
        SDL_GPU_SHADERSTAGE_FRAGMENT,
        static_cast<Uint32>(fragment_slots.textures.size()),
        static_cast<Uint32>(fragment_slots.uniforms.size()),
        "main",
        static_cast<Uint32>(fragment_slots.storage.size()));
    SDL_GPUColorTargetDescription color_target{};
    // The one target `blurPipeline` declares, as the factory declared it.
    color_target.format =
        esm_texture_format(resources.blur_target_format);
    SDL_GPUGraphicsPipelineCreateInfo info{};
    info.vertex_shader = vertex_shader;
    info.fragment_shader = fragment_shader;
    info.primitive_type = SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
    info.rasterizer_state.fill_mode = SDL_GPU_FILLMODE_FILL;
    info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_NONE;
    info.multisample_state.sample_count = SDL_GPU_SAMPLECOUNT_1;
    info.target_info.color_target_descriptions = &color_target;
    info.target_info.num_color_targets = 1;
    blur.pipeline = SDL_CreateGPUGraphicsPipeline(state.device, &info);
    SDL_ReleaseGPUShader(state.device, vertex_shader);
    SDL_ReleaseGPUShader(state.device, fragment_shader);
    if (!blur.pipeline) {
        gpu_error("SDL_CreateGPUGraphicsPipeline ESM blur");
    }
    return blur;
}

/** The pin's two blur passes, run straight after the caster pass. */
void run_esm_blur(
    GpuState& state,
    SDL_GPUCommandBuffer* command,
    std::uint32_t esm_index) {
    const GpuState::EsmBlur& blur = state.esm_blurs[esm_index];
    const upstream::EsmShadowResources& resources =
        upstream::esm_shadow_resources[esm_index];
    const auto blur_pass = [&](
                               SDL_GPUTexture* into,
                               SDL_GPUTexture* read,
                               const std::array<float, 4>& direction) {
        SDL_GPUColorTargetInfo target{};
        target.texture = into;
        target.load_op = SDL_GPU_LOADOP_CLEAR;
        target.store_op = SDL_GPU_STOREOP_STORE;
        target.clear_color = SDL_FColor{0.0f, 0.0f, 0.0f, 0.0f};
        SDL_GPURenderPass* pass =
            SDL_BeginGPURenderPass(command, &target, 1, nullptr);
        SDL_BindGPUGraphicsPipeline(pass, blur.pipeline);
        SDL_GPUTextureSamplerBinding binding{};
        binding.texture = read;
        binding.sampler = state.shadow_filtering_sampler;
        SDL_BindGPUFragmentSamplers(pass, 0, &binding, 1);
        // `BlurParams` is declared in both stages, so both are pushed.
        SDL_PushGPUVertexUniformData(
            command,
            0,
            direction.data(),
            static_cast<Uint32>(direction.size() * sizeof(float)));
        SDL_PushGPUFragmentUniformData(
            command,
            0,
            direction.data(),
            static_cast<Uint32>(direction.size() * sizeof(float)));
        SDL_DrawGPUPrimitives(pass, 3, 1, 0, 0);
        SDL_EndGPURenderPass(pass);
    };
    blur_pass(blur.blur_h, blur.source, resources.blur_directions[0]);
    blur_pass(blur.blur_v, blur.blur_h, resources.blur_directions[1]);
}
#endif

void update_shadow_generators(
    GpuState& state,
    const Scene& scene,
    Engine& engine) {
    if (engine.shadow_generators.empty()) return;
    if (state.shadow_generators.size() < engine.shadow_generators.size()) {
        state.shadow_generators.resize(engine.shadow_generators.size());
    }
    if (!state.shadow_comparison_sampler) {
        SDL_GPUSamplerCreateInfo info{};
        // The pinned PCF generator's own sampler: a comparison sampler under
        // `less`, with linear filtering so the hardware averages the four
        // comparisons each of the nine taps takes.
        info.enable_compare = true;
        info.compare_op = SDL_GPU_COMPAREOP_LESS;
        info.min_filter = SDL_GPU_FILTER_LINEAR;
        info.mag_filter = SDL_GPU_FILTER_LINEAR;
        info.mipmap_mode = SDL_GPU_SAMPLERMIPMAPMODE_NEAREST;
        info.address_mode_u = SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
        info.address_mode_v = SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
        info.address_mode_w = SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
        state.shadow_comparison_sampler =
            SDL_CreateGPUSampler(state.device, &info);
        if (!state.shadow_comparison_sampler) {
            gpu_error("SDL_CreateGPUSampler shadow comparison");
        }
    }
    if (!state.shadow_filtering_sampler) {
        // The pinned ESM generator reads its blurred map through
        // `getBilinearSampler`. Its two filters are what the factory asked
        // its device for; everything else it left at WebGPU's defaults,
        // which clamp and sample the base level.
        SDL_GPUSamplerCreateInfo info{};
#if BBLITE_SHADOWS_ESM
        const auto& blur_sampler =
            upstream::esm_shadow_resources[0].blur_sampler;
        info.min_filter =
            blur_sampler.minify == upstream::EsmFilter::linear
                ? SDL_GPU_FILTER_LINEAR
                : SDL_GPU_FILTER_NEAREST;
        info.mag_filter =
            blur_sampler.magnify == upstream::EsmFilter::linear
                ? SDL_GPU_FILTER_LINEAR
                : SDL_GPU_FILTER_NEAREST;
#else
        info.min_filter = SDL_GPU_FILTER_LINEAR;
        info.mag_filter = SDL_GPU_FILTER_LINEAR;
#endif
        info.mipmap_mode = SDL_GPU_SAMPLERMIPMAPMODE_NEAREST;
        info.address_mode_u = SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
        info.address_mode_v = SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
        info.address_mode_w = SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
        state.shadow_filtering_sampler =
            SDL_CreateGPUSampler(state.device, &info);
        if (!state.shadow_filtering_sampler) {
            gpu_error("SDL_CreateGPUSampler shadow filtering");
        }
    }
    pal::refresh_shadow_generators(
        scene,
        engine,
        state.shadow_refresh,
        [&](
            const ShadowGeneratorRecord& generator,
            ShadowGeneratorHandle,
            std::size_t slot,
            const upstream::ShadowInfoUniforms& block,
            bool moved) {
            GpuState::ShadowGenerator& gpu = state.shadow_generators[slot];
            // Kept densely beside the map and the buffer because
            // `shadow_info_uniform_for` binds it by a composed row's LIGHT
            // ordinal, which is this slot and not the generator's handle.
            gpu.block = block;
            if (
                generator.task.value < engine.frame_tasks.size() &&
                engine.frame_tasks[generator.task.value]
                        .render.target.value < state.render_targets.size()) {
                const GpuRenderTarget& target = state.render_targets[
                    engine.frame_tasks[generator.task.value]
                        .render.target.value];
#if BBLITE_SHADOWS_ESM
                if (generator.filter == ShadowFilter::esm_directional) {
                    // `sg._depthTexture` is the SECOND blur half, never the
                    // depth buffer the caster pass wrote.
                    gpu.map =
                        ensure_esm_blur(state, generator, target.color)
                            .blur_v;
                } else
#endif
                gpu.map = target.depth;
            }
            if (!gpu.map) {
                gpu_error("a shadow generator has no rendered map.");
            }
            if (!gpu.info) {
                gpu.info = upload_buffer(
                    state.device,
                    SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ,
                    &block,
                    sizeof(block));
            } else if (moved) {
                // `update_buffer` costs a transfer buffer and a second
                // command submit, so it runs only when the block moved.
                update_buffer(state.device, gpu.info, &block, sizeof(block));
            }
        });
}
#endif

#if BBLITE_STANDARD_VARIANTS > 0
/** The stem the shader compiler deployed a Standard variant's stage under. */
std::string standard_stage_name(std::string_view file) {
    return "variant-std-" +
        std::string(file.substr(0, file.find(".wgsl")));
}

void ensure_standard_slots(GpuState& state, std::size_t variant) {
    if (
        state.standard_vertex_slots.size() <
        upstream::standard_variants.size()) {
        state.standard_vertex_slots.resize(
            upstream::standard_variants.size());
        state.standard_fragment_slots.resize(
            upstream::standard_variants.size());
    }
    if (!state.standard_vertex_slots[variant].uniforms.empty()) return;
    const upstream::StandardVariantEntry& entry =
        upstream::standard_variants[variant];
    state.standard_vertex_slots[variant] = read_pinned_stage_slots(
        standard_stage_name(entry.vertex_shader));
    state.standard_fragment_slots[variant] = read_pinned_stage_slots(
        standard_stage_name(entry.fragment_shader));
}


/**
 * Which of our resources the pin's own name for a Standard binding refers
 * to. The name->slot rows are the generated `standard_binding_resources`;
 * the cube reflection pair and the two render-texture slots are the
 * resources outside the material slot table.
 */

PinnedResource standard_resource_for(
    GpuState& state,
    const GpuMesh& mesh,
    const MaterialRecord* material,
    const StandardRenderTextures& render_textures,
    const std::string& name,
    [[maybe_unused]] std::size_t variant) {
    for (
        const upstream::StandardBindingResource& row :
        upstream::standard_binding_resources) {
        if (name != row.texture_name && name != row.sampler_name) continue;
        if (row.reflection_cube) {
            return {mesh.reflection, state.sampler};
        }
        if (
            row.source ==
                upstream::MaterialTextureSource::standard_emissive &&
            material != nullptr &&
            material->has_emissive_render_texture) {
            // The compiled `material.emissiveTexture = <render texture>`
            // setter: the pin's depth-sampled texture, bound with the
            // non-filtering depth sampler.
            return {render_textures.standard_emissive, state.depth_sampler};
        }
        if (
            row.source == upstream::MaterialTextureSource::base_color &&
            material != nullptr &&
            material->has_diffuse_render_texture) {
            // `material.diffuseTexture = <render texture>`: a colour
            // attachment, which rtt.ts hands the pin's bilinear sampler.
            // `getBilinearSampler`: linear mag/min over clamp
            // addressing, which is the descriptor `ground_sampler` was
            // already built with (its `max_lod` 0 and the pin's nearest
            // mip filter agree, because buildRenderTarget allocates one
            // level).
            return {render_textures.base_color, state.ground_sampler};
        }
        const GpuMeshSlotMembers members = mesh_slot_members(row.source);
        if (members.texture != nullptr) {
            return {mesh.*members.texture, mesh.*members.sampler};
        }
        break;
    }
#if BBLITE_STANDARD_SHADOWS
    // Group 2, after the slot table for the reason the PBR resolver asks in
    // that order: the two name sets are disjoint, and a material texture is
    // the common case.
    if (const PinnedResource shadow = shadow_resource_for(
            state,
            pal::standard_shadow_rows(variant),
            name);
        shadow.texture != nullptr) {
        return shadow;
    }
#endif
    gpu_error(
        ("standard variant declares an unmapped resource '" + name + "'.")
            .c_str());
    return {};
}

/**
 * The graphics pipeline for one composed Standard variant under one
 * pipeline kind — the Standard sibling of `pinned_variant_pipeline`. The
 * kind carries the blend and cull state the render plan bucketed
 * (standard-pipeline.ts getOrCreateStandardPipeline: needsBlend =
 * HAS_OPACITY_TEXTURE || MATERIAL_ALPHA_BLEND, cull = DOUBLE_SIDED), and
 * depth writes turn off only when blending.
 */
SDL_GPUGraphicsPipeline* standard_variant_pipeline(
    GpuState& state,
    std::size_t variant,
    upstream::RenderPipelineKind kind,
    const FrameTaskRecord* geometry_task = nullptr,
    // The pin's one exception to this port's depth convention: a shadow
    // caster pass renders standard-Z into the generator's own
    // `depth32float` map, at one sample.
    bool shadow_pass = false) {
    const std::size_t key =
        pal::variant_pipeline_key(variant, kind, {shadow_pass});
    const auto existing = state.standard_variant_pipelines.find(key);
    if (existing != state.standard_variant_pipelines.end()) {
        return existing->second;
    }
    ensure_standard_slots(state, variant);
    const upstream::StandardVariantEntry& entry =
        upstream::standard_variants[variant];
    const std::string vertex_name =
        standard_stage_name(entry.vertex_shader);
    const std::string fragment_name =
        standard_stage_name(entry.fragment_shader);
    const PinnedStageSlots& vertex_slots =
        state.standard_vertex_slots[variant];
    const PinnedStageSlots& fragment_slots =
        state.standard_fragment_slots[variant];
    SDL_GPUShader* vertex_shader = load_shader(
        state.device,
        vertex_name.c_str(),
        SDL_GPU_SHADERSTAGE_VERTEX,
        static_cast<Uint32>(vertex_slots.textures.size()),
        static_cast<Uint32>(vertex_slots.uniforms.size()),
        "main",
        static_cast<Uint32>(vertex_slots.storage.size()));
    SDL_GPUShader* fragment_shader = load_shader(
        state.device,
        fragment_name.c_str(),
        SDL_GPU_SHADERSTAGE_FRAGMENT,
        static_cast<Uint32>(fragment_slots.textures.size()),
        static_cast<Uint32>(fragment_slots.uniforms.size()),
        "main",
        static_cast<Uint32>(fragment_slots.storage.size()));
    std::vector<SDL_GPUVertexAttribute> attributes;
    attributes.reserve(entry.attribute_count);
    for (std::size_t index = 0; index < entry.attribute_count; ++index) {
        const upstream::StandardVariantAttribute& input =
            upstream::standard_variant_attributes[entry.first_attribute + index];
        if (
            !append_variant_attribute(
                input.name,
                input.location,
                entry.uses_local_position,
                attributes)) {
            gpu_error(
                ("standard variant declares an unmapped vertex input '" +
                 std::string(input.name) + "'.")
                    .c_str());
        }
    }
    // The same shared decode the PBR sibling reads; standard kinds carry
    // no clockwise arm, so only the blend and cull facts are consumed.
    const RenderPipelineKindTraits traits = pipeline_kind_traits(kind);
    const bool transparent = traits.transparent;
    SDL_GPUColorTargetDescription color_target{};
    color_target.format = state.pinned_color_format;
    if (transparent) {
        color_target.blend_state = blend_state_from(transparent_blend);
    }
    SDL_GPUGraphicsPipelineCreateInfo info{};
    info.vertex_shader = vertex_shader;
    info.fragment_shader = fragment_shader;
    const bool instanced = std::any_of(
        attributes.begin(),
        attributes.end(),
        [](const SDL_GPUVertexAttribute& attribute) {
            return attribute.buffer_slot == 1;
        });
    std::array<SDL_GPUVertexBufferDescription, 2> vertex_buffers{};
    vertex_buffers[0].slot = 0;
    vertex_buffers[0].pitch = sizeof(GpuVertex);
    vertex_buffers[0].input_rate = SDL_GPU_VERTEXINPUTRATE_VERTEX;
    vertex_buffers[1].slot = 1;
    vertex_buffers[1].pitch = sizeof(std::array<float, 16>);
    vertex_buffers[1].input_rate = SDL_GPU_VERTEXINPUTRATE_INSTANCE;
    info.vertex_input_state = SDL_GPUVertexInputState{
        vertex_buffers.data(),
        instanced ? 2u : 1u,
        attributes.data(),
        static_cast<Uint32>(attributes.size()),
    };
    info.primitive_type = SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
    info.rasterizer_state.fill_mode = SDL_GPU_FILLMODE_FILL;
    info.rasterizer_state.cull_mode = gpu_cull_mode(traits.cull);
    info.rasterizer_state.front_face =
        SDL_GPU_FRONTFACE_COUNTER_CLOCKWISE;
    info.rasterizer_state.enable_depth_clip = true;
    apply_pass_depth_state(info, state, shadow_pass);
    info.depth_stencil_state.enable_depth_write =
        entry.no_color_output || !transparent;
    info.target_info.color_target_descriptions =
        entry.no_color_output ? nullptr : &color_target;
    info.target_info.num_color_targets = entry.no_color_output ? 0 : 1;
    // A geometry-output MRT variant draws into its task's own
    // attachments, exactly as the PBR sibling does; the class list and
    // its count assertion are the shared `geometry_target_classes`.
    std::vector<SDL_GPUColorTargetDescription> geometry_targets;
    if (geometry_task) {
        const GeometryTargetClasses classes =
            geometry_target_classes(*geometry_task);
        require_geometry_target_count(
            classes,
            entry.color_target_count,
            "standard");
        geometry_targets.reserve(classes.attachments.size() + 1u);
        for (const TextureFormatClass format_class : classes.attachments) {
            SDL_GPUColorTargetDescription target{};
            target.format = texture_format(format_class);
            if (transparent) {
                target.blend_state = blend_state_from(transparent_blend);
            }
            geometry_targets.push_back(target);
        }
        if (classes.trailing_output) {
            SDL_GPUColorTargetDescription target{};
            target.format = state.pinned_color_format;
            if (transparent) {
                target.blend_state = blend_state_from(transparent_blend);
            }
            geometry_targets.push_back(target);
        }
        info.target_info.color_target_descriptions =
            geometry_targets.data();
        info.target_info.num_color_targets =
            static_cast<Uint32>(geometry_targets.size());
        info.multisample_state.sample_count =
            task_sample_count(state, geometry_task->geometry.samples);
        // A geometry task always writes depth, whatever the material's own
        // alpha would have said.
        info.depth_stencil_state.enable_depth_write = true;
    }
    SDL_GPUGraphicsPipeline* pipeline =
        SDL_CreateGPUGraphicsPipeline(state.device, &info);
    if (!pipeline) {
        gpu_error("SDL_CreateGPUGraphicsPipeline standard variant");
    }
    SDL_ReleaseGPUShader(state.device, vertex_shader);
    SDL_ReleaseGPUShader(state.device, fragment_shader);
    return state.standard_variant_pipelines.emplace(key, pipeline)
        .first->second;
}

/**
 * Draws one Standard command through the pin's own composed stages — the
 * Standard sibling of `draw_pinned_variant`, sharing the scene and lights
 * blocks with the PBR family and binding the slot-name blocks the remap
 * assigned: `scene`, `lights`, `mesh`, `mat`, `up` and the geometry arms'
 * `gp`.
 */
void draw_standard_variant(
    GpuState& state,
    SDL_GPUCommandBuffer* command,
    SDL_GPURenderPass* pass,
    const Scene& scene,
    const Engine& engine,
    // The pass's scene and lights blocks, built once per pass by the
    // caller (Dawn builds both per frame): their builders run camera and
    // view math that must not repeat per draw.
    const upstream::SceneUniforms& pinned_scene,
    const std::vector<std::uint8_t>& pinned_lights,
    const upstream::RenderDrawCommand& draw,
    const GpuMesh& mesh,
    const MaterialRecord* material,
    std::size_t variant,
    // The feature word the selector already derived for this draw
    // (`standard_variant_key`), passed through rather than re-derived.
    std::uint32_t features,
    SDL_GPUGraphicsPipeline*& bound_pipeline,
    const FrameTaskRecord* geometry_task = nullptr,
    const PinnedGeometryParams* geometry_params = nullptr,
    StandardRenderTextures render_textures = {},
    SDL_GPUBuffer* geometry_params_buffer = nullptr,
    // Drawing the shadow map, so the pipeline renders standard-Z into the
    // generator's own single-sample depth32float target.
    bool shadow_pass = false) {
    const upstream::RenderItem& item = draw.item;
    SDL_GPUGraphicsPipeline* variant_pipeline =
        standard_variant_pipeline(
            state,
            variant,
            draw.pipeline,
            geometry_task,
            shadow_pass);
    if (variant_pipeline != bound_pipeline) {
        SDL_BindGPUGraphicsPipeline(pass, variant_pipeline);
        bound_pipeline = variant_pipeline;
    }
    const upstream::StandardVariantEntry& entry =
        upstream::standard_variants[variant];
    const MeshRecord& record = engine.meshes[item.mesh.value];
    const upstream::MeshUniforms pinned_mesh =
        pinned_mesh_block(
            scene,
            engine,
            standard_draw_world(record, entry.uses_local_position),
            item.mesh.value);
    const upstream::StandardMaterialUniforms material_block =
        standard_material_block(material, features);
    const upstream::StandardUvTransformUniforms uv_block =
        standard_uv_block(material, features);
#if defined(BBLITE_HAS_STANDARD_UV_TRANSFORM) && BBLITE_HAS_STANDARD_UV_TRANSFORM
    const upstream::StandardUvTxUniforms uv_transform_block =
        standard_uv_transform_block(material);
#endif
    const auto resolve = [&](
                             const std::string& block) -> PinnedStageBlock {
        if (block == "scene") {
            return {&pinned_scene, sizeof(pinned_scene)};
        }
        if (block == "lights") {
            return {pinned_lights.data(), pinned_lights.size()};
        }
        if (block == "mesh") return {&pinned_mesh, sizeof(pinned_mesh)};
        if (block == "mat") return {&material_block, sizeof(material_block)};
        if (block == "up") return {&uv_block, sizeof(uv_block)};
#if defined(BBLITE_HAS_STANDARD_UV_TRANSFORM) && BBLITE_HAS_STANDARD_UV_TRANSFORM
        if (block == "stdUvTx") {
            return {&uv_transform_block, sizeof(uv_transform_block)};
        }
#endif
        if (block == "gp") {
            if (!geometry_params) {
                gpu_error(
                    "standard variant declares gpUniforms outside a "
                    "geometry task.");
            }
            return {geometry_params, sizeof(*geometry_params)};
        }
#if BBLITE_STANDARD_SHADOWS
        if (const PinnedStageBlock info = shadow_info_uniform_for(
                state,
                pal::standard_shadow_rows(variant),
                block);
            info.data != nullptr) {
            return info;
        }
#endif
#if BBLITE_SHADOWS_ESM
        // The ESM caster's own block, from the generator its material view
        // was built for -- `getEsmShadowView` closes over that generator's
        // `_shadowParamsUBO`.
        if (
            block == "shadowParams" &&
            material &&
            material->esm_shadow_generator.value <
                engine.shadow_generators.size()) {
            const std::uint32_t esm_index =
                engine.shadow_generators[
                    material->esm_shadow_generator.value].esm_index;
            if (esm_index < state.esm_blurs.size()) {
                const std::array<float, 8>& params =
                    state.esm_blurs[esm_index].params;
                return {params.data(), params.size() * sizeof(float)};
            }
        }
#endif
        return {};
    };
    push_stage_uniforms(
        command,
        state.standard_vertex_slots[variant],
        false,
        "standard variant",
        resolve);
    push_stage_uniforms(
        command,
        state.standard_fragment_slots[variant],
        true,
        "standard variant",
        resolve);
    const PinnedStageSlots& fragment_slots =
        state.standard_fragment_slots[variant];
    bind_stage_textures(
        pass,
        fragment_slots,
        true,
        "standard variant fragment",
        [&](const std::string& name) {
            const PinnedResource resource = standard_resource_for(
                state,
                mesh,
                material,
                render_textures,
                name,
                variant);
            return SDL_GPUTextureSamplerBinding{
                resource.texture,
                resource.sampler,
            };
        });
    // The gp block the shader compile demoted out of the uniform slots:
    // SDL_GPU caps those at four per stage and a geometry fragment spends all
    // four on scene, lights, mesh and mat.
    bind_stage_storage(
        pass,
        fragment_slots,
        true,
        "standard variant fragment",
        [&](const std::string& name) -> SDL_GPUBuffer* {
            if (name == "gp") return geometry_params_buffer;
#if BBLITE_STANDARD_SHADOWS
            if (SDL_GPUBuffer* info = shadow_info_buffer_for(
                    state,
                    pal::standard_shadow_rows(variant),
                    name)) {
                return info;
            }
#endif
            return nullptr;
        });
    const PinnedStageSlots& vertex_slots =
        state.standard_vertex_slots[variant];
    // The morph arms' deltas and weights, by the pin's own names.
    bind_stage_storage(
        pass,
        vertex_slots,
        false,
        "standard variant vertex",
        [&](const std::string& name) -> SDL_GPUBuffer* {
            (void)name;
#if BBLITE_GPU_MORPH_STORAGE
            if (name == "morphDeltas") return mesh.morph_deltas;
            if (name == "morph") return mesh.morph_weights;
#endif
#if BBLITE_STANDARD_SHADOWS
            // A receiver whose vertex stage also overflows SDL_GPU's four
            // uniform slots has its own receiver blocks demoted there too.
            if (SDL_GPUBuffer* info = shadow_info_buffer_for(
                    state,
                    pal::standard_shadow_rows(variant),
                    name)) {
                return info;
            }
#endif
            return nullptr;
        });
    // The Standard families carry no glTF X-mirror: the pin's world is the
    // identity (or the record's parent TRS for a pool), so the baked vertex
    // buffer is the pin's own convention already.
    const SDL_GPUBufferBinding vertex_binding{mesh.vertices, 0};
    SDL_BindGPUVertexBuffers(pass, 0, &vertex_binding, 1);
    const bool instanced_draw = pinned_record_instanced(record);
    if (instanced_draw && mesh.instances) {
        const SDL_GPUBufferBinding instance_binding{mesh.instances, 0};
        SDL_BindGPUVertexBuffers(pass, 1, &instance_binding, 1);
    }
    const SDL_GPUBufferBinding index_binding{mesh.indices, 0};
    SDL_BindGPUIndexBuffer(
        pass,
        &index_binding,
        SDL_GPU_INDEXELEMENTSIZE_32BIT);
    SDL_DrawGPUIndexedPrimitives(
        pass,
        mesh.index_count,
        instanced_draw ? mesh.instance_count : 1,
        0,
        0,
        0);
}
#endif


struct ImageProcessingUniforms {
    float parameters[4];
};

#if BBLITE_GPU_INSTANCING
#if BBLITE_GPU_DEFORMATION
constexpr Uint32 instance_uniform_slot = 2;
#else
constexpr Uint32 instance_uniform_slot = 1;
#endif
#endif

#if BBLITE_GPU_DEFORMATION
// BBLITE_DEFORMATION_DUMP=<path> appends each mesh's first-frame bone
// palette and morph weights as hexfloats for bit-level comparison
// against instrumented browser captures.
void dump_deformation_uniforms(
    std::uint32_t mesh,
    const DeformationUniforms& deformation) {
    // Read here rather than from the frame options: this dump helper is
    // called from the upload path, which is not handed them.
    static const std::string dump_path =
        environment_variable("BBLITE_DEFORMATION_DUMP");
    if (dump_path.empty()) return;
    static std::vector<std::uint32_t> dumped;
    for (const std::uint32_t existing : dumped) {
        if (existing == mesh) return;
    }
    dumped.push_back(mesh);
    std::ofstream out(dump_path, std::ios::app);
    out << "mesh " << mesh << "\n";
    out << std::hexfloat;
    for (
        std::size_t bone = 0;
        bone < deformation.bone_matrices.size();
        ++bone) {
        out << "bone " << bone;
        for (const float value :
             deformation.bone_matrices[bone]) {
            out << " " << value;
        }
        out << "\n";
    }
    out << "morph";
    for (const float value : deformation.morph_weights) {
        out << " " << value;
    }
    out << "\n";
}
#endif




/** The SDL enumerator for one shared block format. */
SDL_GPUTextureFormat compressed_texture_format(std::string_view name) {
    switch (compressed_block_format(name)) {
        case CompressedBlockFormat::bc1_rgba_unorm:
            return SDL_GPU_TEXTUREFORMAT_BC1_RGBA_UNORM;
        case CompressedBlockFormat::bc2_rgba_unorm:
            return SDL_GPU_TEXTUREFORMAT_BC2_RGBA_UNORM;
        case CompressedBlockFormat::bc3_rgba_unorm:
            return SDL_GPU_TEXTUREFORMAT_BC3_RGBA_UNORM;
        case CompressedBlockFormat::bc7_rgba_unorm:
            return SDL_GPU_TEXTUREFORMAT_BC7_RGBA_UNORM;
        case CompressedBlockFormat::bc7_rgba_unorm_srgb:
            return SDL_GPU_TEXTUREFORMAT_BC7_RGBA_UNORM_SRGB;
    }
    throw std::runtime_error(
        "SDL_GPU has no compressed texture format for '" +
        std::string(name) + "'.");
}

/**
 * A texture whose bytes are already blocks: the container's own mip chain,
 * uploaded level by level with nothing decoded and nothing generated.
 */
SDL_GPUTexture* upload_compressed_texture(
    SDL_GPUDevice* device,
    const CompressedTexture& compressed) {
    SDL_GPUTextureCreateInfo texture_info{};
    texture_info.type = SDL_GPU_TEXTURETYPE_2D;
    texture_info.format = compressed_texture_format(compressed.format);
    texture_info.usage = SDL_GPU_TEXTUREUSAGE_SAMPLER;
    texture_info.width = compressed.width;
    texture_info.height = compressed.height;
    texture_info.layer_count_or_depth = 1;
    texture_info.num_levels =
        static_cast<Uint32>(compressed.mips.size());
    texture_info.sample_count = SDL_GPU_SAMPLECOUNT_1;
    if (!SDL_GPUTextureSupportsFormat(
            device,
            texture_info.format,
            SDL_GPU_TEXTURETYPE_2D,
            SDL_GPU_TEXTUREUSAGE_SAMPLER)) {
        throw std::runtime_error(
            "This device cannot sample '" +
            std::string(compressed.format) + "' textures.");
    }
    SDL_GPUTexture* texture = SDL_CreateGPUTexture(device, &texture_info);
    if (!texture) gpu_error("SDL_CreateGPUTexture compressed");

    SDL_GPUCommandBuffer* command = SDL_AcquireGPUCommandBuffer(device);
    if (!command) gpu_error("SDL_AcquireGPUCommandBuffer");
    SDL_GPUCopyPass* copy = SDL_BeginGPUCopyPass(command);
    std::vector<SDL_GPUTransferBuffer*> transfers;
    transfers.reserve(compressed.mips.size());
    for (std::size_t level = 0; level < compressed.mips.size(); ++level) {
        const CompressedMipLevel& mip = compressed.mips[level];
        const CompressedMipCopy geometry =
            compressed_mip_copy(compressed, mip);
        SDL_GPUTransferBufferCreateInfo transfer_info{};
        transfer_info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD;
        transfer_info.size = static_cast<Uint32>(mip.bytes.size());
        SDL_GPUTransferBuffer* transfer =
            SDL_CreateGPUTransferBuffer(device, &transfer_info);
        if (!transfer) gpu_error("SDL_CreateGPUTransferBuffer");
        transfers.push_back(transfer);
        void* mapped = SDL_MapGPUTransferBuffer(device, transfer, false);
        if (!mapped) gpu_error("SDL_MapGPUTransferBuffer");
        std::memcpy(mapped, mip.bytes.data(), mip.bytes.size());
        SDL_UnmapGPUTransferBuffer(device, transfer);
        // SDL takes both in pixels and divides by the format's block size
        // itself, so the padded extent is what it needs here too.
        SDL_GPUTextureTransferInfo source{
            transfer, 0, geometry.width, geometry.height};
        SDL_GPUTextureRegion destination{
            texture,
            static_cast<Uint32>(level),
            0, 0, 0, 0,
            geometry.width,
            geometry.height,
            1};
        SDL_UploadToGPUTexture(copy, &source, &destination, false);
    }
    SDL_EndGPUCopyPass(copy);
    if (!SDL_SubmitGPUCommandBuffer(command)) {
        gpu_error("SDL_SubmitGPUCommandBuffer");
    }
    for (SDL_GPUTransferBuffer* transfer : transfers) {
        SDL_ReleaseGPUTransferBuffer(device, transfer);
    }
    return texture;
}

SDL_GPUTexture* upload_texture(
    SDL_GPUDevice* device,
    const TextureData& texture_data,
    bool srgb,
    std::array<std::uint8_t, 4> fallback) {
    // A compressed slot carries its own format and its own chain, so the
    // table's sRGB rule has nothing to select: the container states which
    // of the two views its blocks decode through.
    if (!texture_data.compressed.mips.empty()) {
        return upload_compressed_texture(device, texture_data.compressed);
    }
    const DecodedImage image =
        decode_uploadable_image(texture_data, fallback);
    SDL_GPUTextureCreateInfo texture_info{};
    texture_info.type = SDL_GPU_TEXTURETYPE_2D;
    texture_info.format = srgb
        ? SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM_SRGB
        : SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM;
    texture_info.usage =
        SDL_GPU_TEXTUREUSAGE_SAMPLER | SDL_GPU_TEXTUREUSAGE_COLOR_TARGET;
    texture_info.width = image.width;
    texture_info.height = image.height;
    texture_info.layer_count_or_depth = 1;
    texture_info.num_levels = full_mip_chain(
        static_cast<std::uint32_t>(image.width),
        static_cast<std::uint32_t>(image.height));
    texture_info.sample_count = SDL_GPU_SAMPLECOUNT_1;
    SDL_GPUTexture* texture = SDL_CreateGPUTexture(device, &texture_info);
    if (!texture) gpu_error("SDL_CreateGPUTexture");

    SDL_GPUTransferBufferCreateInfo transfer_info{};
    transfer_info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD;
    transfer_info.size = static_cast<Uint32>(image.rgba.size());
    SDL_GPUTransferBuffer* transfer = SDL_CreateGPUTransferBuffer(device, &transfer_info);
    if (!transfer) gpu_error("SDL_CreateGPUTransferBuffer");
    void* mapped = SDL_MapGPUTransferBuffer(device, transfer, false);
    if (!mapped) gpu_error("SDL_MapGPUTransferBuffer");
    std::memcpy(mapped, image.rgba.data(), image.rgba.size());
    SDL_UnmapGPUTransferBuffer(device, transfer);

    SDL_GPUCommandBuffer* command = SDL_AcquireGPUCommandBuffer(device);
    if (!command) gpu_error("SDL_AcquireGPUCommandBuffer");
    SDL_GPUCopyPass* copy = SDL_BeginGPUCopyPass(command);
    SDL_GPUTextureTransferInfo source{transfer, 0, static_cast<Uint32>(image.width), static_cast<Uint32>(image.height)};
    SDL_GPUTextureRegion destination{
        texture, 0, 0, 0, 0, 0,
        static_cast<Uint32>(image.width), static_cast<Uint32>(image.height), 1};
    SDL_UploadToGPUTexture(copy, &source, &destination, false);
    SDL_EndGPUCopyPass(copy);
    if (texture_info.num_levels > 1) {
        SDL_GenerateMipmapsForGPUTexture(command, texture);
    }
    if (!SDL_SubmitGPUCommandBuffer(command)) gpu_error("SDL_SubmitGPUCommandBuffer");
    SDL_ReleaseGPUTransferBuffer(device, transfer);
    return texture;
}

SDL_GPUTexture* upload_cube_texture(
    SDL_GPUDevice* device,
    const std::array<TextureData, 6>* texture_data) {
    std::array<DecodedImage, 6> images;
    int width = 1;
    int height = 1;
    for (std::size_t index = 0; index < images.size(); ++index) {
        if (texture_data && !(*texture_data)[index].bytes.empty()) {
            images[index] = decode_image(
                ts::ArrayBuffer((*texture_data)[index].bytes));
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
    SDL_GPUTextureCreateInfo texture_info{};
    texture_info.type = SDL_GPU_TEXTURETYPE_CUBE;
    texture_info.format = SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM;
    texture_info.usage =
        SDL_GPU_TEXTUREUSAGE_SAMPLER | SDL_GPU_TEXTUREUSAGE_COLOR_TARGET;
    texture_info.width = static_cast<Uint32>(width);
    texture_info.height = static_cast<Uint32>(height);
    texture_info.layer_count_or_depth = 6;
    texture_info.num_levels = full_mip_chain(
        static_cast<std::uint32_t>(width),
        static_cast<std::uint32_t>(height));
    texture_info.sample_count = SDL_GPU_SAMPLECOUNT_1;
    SDL_GPUTexture* texture =
        SDL_CreateGPUTexture(device, &texture_info);
    if (!texture) gpu_error("SDL_CreateGPUTexture reflection cube");

    SDL_GPUCommandBuffer* command =
        SDL_AcquireGPUCommandBuffer(device);
    if (!command) {
        gpu_error("SDL_AcquireGPUCommandBuffer reflection cube");
    }
    SDL_GPUCopyPass* copy = SDL_BeginGPUCopyPass(command);
    std::array<SDL_GPUTransferBuffer*, 6> transfers{};
    for (std::size_t index = 0; index < images.size(); ++index) {
        const DecodedImage& image = images[index];
        SDL_GPUTransferBufferCreateInfo transfer_info{};
        transfer_info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD;
        transfer_info.size =
            static_cast<Uint32>(image.rgba.size());
        transfers[index] =
            SDL_CreateGPUTransferBuffer(device, &transfer_info);
        if (!transfers[index]) {
            gpu_error(
                "SDL_CreateGPUTransferBuffer reflection cube");
        }
        void* mapped = SDL_MapGPUTransferBuffer(
            device,
            transfers[index],
            false);
        if (!mapped) {
            gpu_error("SDL_MapGPUTransferBuffer reflection cube");
        }
        std::memcpy(
            mapped,
            image.rgba.data(),
            image.rgba.size());
        SDL_UnmapGPUTransferBuffer(device, transfers[index]);
        const SDL_GPUTextureTransferInfo source{
            transfers[index],
            0,
            static_cast<Uint32>(width),
            static_cast<Uint32>(height),
        };
        const SDL_GPUTextureRegion destination{
            texture,
            0,
            static_cast<Uint32>(index),
            0,
            0,
            0,
            static_cast<Uint32>(width),
            static_cast<Uint32>(height),
            1,
        };
        SDL_UploadToGPUTexture(
            copy,
            &source,
            &destination,
            false);
    }
    SDL_EndGPUCopyPass(copy);
    if (texture_info.num_levels > 1) {
        SDL_GenerateMipmapsForGPUTexture(command, texture);
    }
    if (!SDL_SubmitGPUCommandBuffer(command)) {
        gpu_error("SDL_SubmitGPUCommandBuffer reflection cube");
    }
    for (SDL_GPUTransferBuffer* transfer : transfers) {
        SDL_ReleaseGPUTransferBuffer(device, transfer);
    }
    return texture;
}




SDL_GPUTexture* upload_rgbd_texture(SDL_GPUDevice* device, const TextureData& texture_data) {
    int width = 0;
    int height = 0;
    const std::vector<std::uint16_t> pixels =
        decode_rgbd(texture_data, width, height);
    return upload_2d_texture(
        device,
        pixels.data(),
        pixels.size() * sizeof(std::uint16_t),
        static_cast<std::uint32_t>(width),
        static_cast<std::uint32_t>(height),
        SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT,
        "upload RGBD texture");
}

SDL_GPUTexture* upload_brdf_lut(
    SDL_GPUDevice* device,
    const EnvironmentState& environment) {
    if (!environment.brdf_lut_rgba16f) {
        return upload_rgbd_texture(device, environment.brdf_lut);
    }
    const std::size_t expected_size =
        static_cast<std::size_t>(environment.brdf_lut_width) *
        environment.brdf_lut_width *
        8;
    if (
        environment.brdf_lut_width == 0 ||
        environment.brdf_lut.bytes.size() != expected_size) {
        throw std::runtime_error(
            "Compiled BRDF LUT has invalid RGBA16F dimensions.");
    }
    return upload_2d_texture(
        device,
        environment.brdf_lut.bytes.data(),
        environment.brdf_lut.bytes.size(),
        environment.brdf_lut_width,
        environment.brdf_lut_width,
        SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT,
        "upload BRDF LUT");
}

SDL_GPUTexture* upload_environment(SDL_GPUDevice* device, const EnvironmentState& environment) {
    const bool has_environment =
        environment.specular_width != 0 &&
        environment.specular_mip_count != 0 &&
        environment.specular_faces.size() >=
            static_cast<std::size_t>(environment.specular_mip_count) * 6;
    const std::uint32_t width = has_environment ? environment.specular_width : 1;
    const std::uint32_t mip_count = has_environment ? environment.specular_mip_count : 1;
    SDL_GPUTextureCreateInfo texture_info{};
    texture_info.type = SDL_GPU_TEXTURETYPE_CUBE;
    texture_info.format =
        SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT;
    texture_info.usage = SDL_GPU_TEXTUREUSAGE_SAMPLER;
    texture_info.width = width;
    texture_info.height = width;
    texture_info.layer_count_or_depth = 6;
    texture_info.num_levels = mip_count;
    texture_info.sample_count = SDL_GPU_SAMPLECOUNT_1;
    SDL_GPUTexture* texture = SDL_CreateGPUTexture(device, &texture_info);
    if (!texture) gpu_error("SDL_CreateGPUTexture environment");

    SDL_GPUCommandBuffer* command = SDL_AcquireGPUCommandBuffer(device);
    if (!command) gpu_error("SDL_AcquireGPUCommandBuffer environment");
    SDL_GPUCopyPass* copy = SDL_BeginGPUCopyPass(command);
    std::vector<SDL_GPUTransferBuffer*> transfers;
    transfers.reserve(static_cast<std::size_t>(mip_count) * 6);
    for (std::uint32_t mip = 0; mip < mip_count; ++mip) {
        for (std::uint32_t face = 0; face < 6; ++face) {
            int image_width =
                static_cast<int>(std::max(width >> mip, 1u));
            int image_height = image_width;
            const TextureData* face_data =
                has_environment
                    ? &environment.specular_faces[
                          static_cast<std::size_t>(mip) * 6 + face]
                    : nullptr;
            std::vector<std::uint16_t> decoded_half_pixels;
            const std::uint8_t* source_bytes = nullptr;
            std::size_t byte_size = 0;
            std::size_t row_size = 0;
            if (environment.specular_rgba16f && face_data) {
                byte_size =
                    static_cast<std::size_t>(image_width) *
                    image_height *
                    8;
                if (face_data->bytes.size() != byte_size) {
                    throw std::runtime_error(
                        "Compiled HDR cubemap face has an invalid size.");
                }
                source_bytes = face_data->bytes.data();
                row_size =
                    static_cast<std::size_t>(image_width) * 8;
            } else {
                decoded_half_pixels = face_data
                    ? decode_rgbd(
                          *face_data,
                          image_width,
                          image_height)
                    : fallback_face_halves();
                source_bytes =
                    reinterpret_cast<const std::uint8_t*>(
                        decoded_half_pixels.data());
                byte_size =
                    decoded_half_pixels.size() *
                    sizeof(std::uint16_t);
                row_size =
                    static_cast<std::size_t>(image_width) *
                    4 *
                    sizeof(std::uint16_t);
            }
            SDL_GPUTransferBufferCreateInfo transfer_info{};
            transfer_info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD;
            transfer_info.size = static_cast<Uint32>(byte_size);
            SDL_GPUTransferBuffer* transfer = SDL_CreateGPUTransferBuffer(device, &transfer_info);
            if (!transfer) gpu_error("SDL_CreateGPUTransferBuffer environment");
            void* mapped = SDL_MapGPUTransferBuffer(device, transfer, false);
            if (!mapped) gpu_error("SDL_MapGPUTransferBuffer environment");
            for (int row = 0; row < image_height; ++row) {
                const int source_row =
                    environment.specular_rgba16f
                        ? row
                        : image_height - row - 1;
                std::memcpy(
                    static_cast<std::uint8_t*>(mapped) +
                        static_cast<std::size_t>(row) * row_size,
                    source_bytes +
                        static_cast<std::size_t>(source_row) * row_size,
                    row_size);
            }
            SDL_UnmapGPUTransferBuffer(device, transfer);
            transfers.push_back(transfer);
            const SDL_GPUTextureTransferInfo source{
                transfer, 0, static_cast<Uint32>(image_width), static_cast<Uint32>(image_height)};
            const SDL_GPUTextureRegion destination{
                texture, mip, face, 0, 0, 0,
                static_cast<Uint32>(image_width), static_cast<Uint32>(image_height), 1};
            SDL_UploadToGPUTexture(copy, &source, &destination, false);
        }
    }
    SDL_EndGPUCopyPass(copy);
    if (!SDL_SubmitGPUCommandBuffer(command)) gpu_error("SDL_SubmitGPUCommandBuffer environment");
    for (SDL_GPUTransferBuffer* transfer : transfers) {
        SDL_ReleaseGPUTransferBuffer(device, transfer);
    }
    return texture;
}

SDL_GPUTexture* upload_dds_skybox(SDL_GPUDevice* device, const EnvironmentState& environment) {
    const TextureData& data = environment.skybox_texture;
    if (
        !environment.has_skybox ||
        environment.skybox_width == 0 ||
        environment.skybox_mip_count == 0 ||
        environment.skybox_data_offset >= data.bytes.size()) {
        throw std::runtime_error("DDS skybox metadata is incomplete.");
    }
    SDL_GPUTextureCreateInfo texture_info{};
    texture_info.type = SDL_GPU_TEXTURETYPE_CUBE;
    texture_info.format = SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT;
    texture_info.usage = SDL_GPU_TEXTUREUSAGE_SAMPLER;
    texture_info.width = environment.skybox_width;
    texture_info.height = environment.skybox_width;
    texture_info.layer_count_or_depth = 6;
    texture_info.num_levels = environment.skybox_mip_count;
    texture_info.sample_count = SDL_GPU_SAMPLECOUNT_1;
    SDL_GPUTexture* texture = SDL_CreateGPUTexture(device, &texture_info);
    if (!texture) gpu_error("SDL_CreateGPUTexture DDS skybox");

    SDL_GPUCommandBuffer* command = SDL_AcquireGPUCommandBuffer(device);
    if (!command) gpu_error("SDL_AcquireGPUCommandBuffer DDS skybox");
    SDL_GPUCopyPass* copy = SDL_BeginGPUCopyPass(command);
    std::vector<SDL_GPUTransferBuffer*> transfers;
    transfers.reserve(static_cast<std::size_t>(environment.skybox_mip_count) * 6);
    std::size_t offset = environment.skybox_data_offset;
    for (std::uint32_t face = 0; face < 6; ++face) {
        for (std::uint32_t mip = 0; mip < environment.skybox_mip_count; ++mip) {
            const std::uint32_t size = std::max(environment.skybox_width >> mip, 1u);
            const std::size_t byte_size = static_cast<std::size_t>(size) * size * 8;
            if (offset + byte_size > data.bytes.size()) {
                throw std::runtime_error("DDS skybox pixel data is truncated.");
            }
            SDL_GPUTransferBufferCreateInfo transfer_info{};
            transfer_info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD;
            transfer_info.size = static_cast<Uint32>(byte_size);
            SDL_GPUTransferBuffer* transfer = SDL_CreateGPUTransferBuffer(device, &transfer_info);
            if (!transfer) gpu_error("SDL_CreateGPUTransferBuffer DDS skybox");
            void* mapped = SDL_MapGPUTransferBuffer(device, transfer, false);
            if (!mapped) gpu_error("SDL_MapGPUTransferBuffer DDS skybox");
            std::memcpy(mapped, data.bytes.data() + offset, byte_size);
            SDL_UnmapGPUTransferBuffer(device, transfer);
            transfers.push_back(transfer);
            const SDL_GPUTextureTransferInfo source{transfer, 0, size, size};
            const SDL_GPUTextureRegion destination{
                texture, mip, face, 0, 0, 0, size, size, 1};
            SDL_UploadToGPUTexture(copy, &source, &destination, false);
            offset += byte_size;
        }
    }
    SDL_EndGPUCopyPass(copy);
    if (!SDL_SubmitGPUCommandBuffer(command)) gpu_error("SDL_SubmitGPUCommandBuffer DDS skybox");
    for (SDL_GPUTransferBuffer* transfer : transfers) {
        SDL_ReleaseGPUTransferBuffer(device, transfer);
    }
    return texture;
}

void release_sized_texture(
    GpuState& state,
    SDL_GPUTexture*& texture,
    std::uint32_t& width,
    std::uint32_t& height) {
    if (texture) {
        SDL_ReleaseGPUTexture(state.device, texture);
        texture = nullptr;
    }
    width = 0;
    height = 0;
}

void create_depth(GpuState& state, std::uint32_t width, std::uint32_t height) {
    if (state.depth && state.depth_width == width && state.depth_height == height) return;
    release_sized_texture(
        state,
        state.depth,
        state.depth_width,
        state.depth_height);
    SDL_GPUTextureCreateInfo info{};
    info.type = SDL_GPU_TEXTURETYPE_2D;
    info.format = state.depth_format;
    info.usage = SDL_GPU_TEXTUREUSAGE_DEPTH_STENCIL_TARGET;
    info.width = width;
    info.height = height;
    info.layer_count_or_depth = 1;
    info.num_levels = 1;
    info.sample_count = state.sample_count;
    state.depth = SDL_CreateGPUTexture(state.device, &info);
    if (!state.depth) gpu_error("SDL_CreateGPUTexture depth");
    state.depth_width = width;
    state.depth_height = height;
}

void create_msaa_color(
    GpuState& state,
    SDL_GPUTextureFormat format,
    std::uint32_t width,
    std::uint32_t height) {
    if (state.sample_count == SDL_GPU_SAMPLECOUNT_1) return;
    if (
        state.msaa_color &&
        state.msaa_color_width == width &&
        state.msaa_color_height == height) {
        return;
    }
    release_sized_texture(
        state,
        state.msaa_color,
        state.msaa_color_width,
        state.msaa_color_height);
    SDL_GPUTextureCreateInfo info{};
    info.type = SDL_GPU_TEXTURETYPE_2D;
    info.format = format;
    // GRAPHICS_STORAGE_READ is what lets the final pass process each
    // sample instead of the resolved pixel. Stock SDL rejects a
    // multisample texture carrying any read usage; libsdl-org/SDL#15838
    // relaxes that to COMPUTE_STORAGE_WRITE only and gives D3D12 a
    // TEXTURE2DMS shader-resource view.
    info.usage = SDL_GPU_TEXTUREUSAGE_COLOR_TARGET |
        SDL_GPU_TEXTUREUSAGE_GRAPHICS_STORAGE_READ;
    info.width = width;
    info.height = height;
    info.layer_count_or_depth = 1;
    info.num_levels = 1;
    info.sample_count = state.sample_count;
    state.msaa_color = SDL_CreateGPUTexture(state.device, &info);
    if (!state.msaa_color) gpu_error("SDL_CreateGPUTexture MSAA color");
    state.msaa_color_width = width;
    state.msaa_color_height = height;
}

void create_color(
    GpuState& state,
    SDL_GPUTextureFormat format,
    std::uint32_t width,
    std::uint32_t height) {
    if (state.color && state.color_width == width && state.color_height == height) return;
    release_sized_texture(
        state,
        state.color,
        state.color_width,
        state.color_height);
    SDL_GPUTextureCreateInfo info{};
    info.type = SDL_GPU_TEXTURETYPE_2D;
    info.format = format;
    info.usage = SDL_GPU_TEXTUREUSAGE_COLOR_TARGET | SDL_GPU_TEXTUREUSAGE_SAMPLER;
    info.width = width;
    info.height = height;
    info.layer_count_or_depth = 1;
    info.num_levels = 1;
    info.sample_count = SDL_GPU_SAMPLECOUNT_1;
    state.color = SDL_CreateGPUTexture(state.device, &info);
    if (!state.color) gpu_error("SDL_CreateGPUTexture color");
    state.color_width = width;
    state.color_height = height;
}

void create_processed_color(
    GpuState& state,
    SDL_GPUTextureFormat format,
    std::uint32_t width,
    std::uint32_t height) {
    if (
        state.processed_color &&
        state.processed_color_width == width &&
        state.processed_color_height == height) {
        return;
    }
    release_sized_texture(
        state,
        state.processed_color,
        state.processed_color_width,
        state.processed_color_height);
    SDL_GPUTextureCreateInfo info{};
    info.type = SDL_GPU_TEXTURETYPE_2D;
    info.format = format;
    info.usage =
        SDL_GPU_TEXTUREUSAGE_COLOR_TARGET |
        SDL_GPU_TEXTUREUSAGE_SAMPLER;
    info.width = width;
    info.height = height;
    info.layer_count_or_depth = 1;
    info.num_levels = 1;
    info.sample_count = SDL_GPU_SAMPLECOUNT_1;
    state.processed_color =
        SDL_CreateGPUTexture(state.device, &info);
    if (!state.processed_color) {
        gpu_error("SDL_CreateGPUTexture processed color");
    }
    state.processed_color_width = width;
    state.processed_color_height = height;
}

void create_transmission_color(GpuState& state) {
    // The pin's refraction grab: the shared fixed-extent, shortened-chain
    // contract (pal_gpu_shared.hpp), whatever the surface size
    // (frame-graph/transmission.ts).
    const std::uint32_t width = transmission_grab_size;
    const std::uint32_t height = transmission_grab_size;
    if (
        state.transmission_color &&
        state.transmission_width == width &&
        state.transmission_height == height) {
        return;
    }
    release_sized_texture(
        state,
        state.transmission_color,
        state.transmission_width,
        state.transmission_height);
    SDL_GPUTextureCreateInfo info{};
    info.type = SDL_GPU_TEXTURETYPE_2D;
    info.format = SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT;
    info.usage =
        SDL_GPU_TEXTUREUSAGE_COLOR_TARGET |
        SDL_GPU_TEXTUREUSAGE_SAMPLER;
    info.width = width;
    info.height = height;
    info.layer_count_or_depth = 1;
    info.num_levels = transmission_grab_mip_count();
    info.sample_count = SDL_GPU_SAMPLECOUNT_1;
    state.transmission_color =
        SDL_CreateGPUTexture(state.device, &info);
    if (!state.transmission_color) {
        gpu_error("SDL_CreateGPUTexture transmission color");
    }
    state.transmission_width = width;
    state.transmission_height = height;
}

SDL_GPUSampleCount task_sample_count(
    const GpuState& state,
    std::uint32_t requested) {
    return requested == 4 ? state.sample_count : SDL_GPU_SAMPLECOUNT_1;
}

SDL_GPUTextureFormat texture_format(TextureFormatClass format) {
    switch (format) {
        case TextureFormatClass::rgba8_unorm:
            return SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM;
        case TextureFormatClass::r16_float:
            return SDL_GPU_TEXTUREFORMAT_R16_FLOAT;
        case TextureFormatClass::r32_float:
            return SDL_GPU_TEXTUREFORMAT_R32_FLOAT;
        case TextureFormatClass::rgba16_float:
            return SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT;
    }
    return SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT;
}

SDL_GPUTextureFormat geometry_texture_format(
    const GeometryTextureDescription& description) {
    return texture_format(geometry_format_class(description));
}

SDL_FColor geometry_clear_color(GeometryTextureType type) {
    const float value = geometry_clear_component(type);
    return SDL_FColor{value, value, value, value};
}

SDL_GPUTexture* create_frame_texture(
    SDL_GPUDevice* device,
    SDL_GPUTextureFormat format,
    SDL_GPUSampleCount samples,
    std::uint32_t width,
    std::uint32_t height,
    SDL_GPUTextureUsageFlags usage) {
    SDL_GPUTextureCreateInfo info{};
    info.type = SDL_GPU_TEXTURETYPE_2D;
    info.format = format;
    info.usage = usage;
    info.width = width;
    info.height = height;
    info.layer_count_or_depth = 1;
    info.num_levels = 1;
    info.sample_count = samples;
    SDL_GPUTexture* texture = SDL_CreateGPUTexture(device, &info);
    if (!texture) gpu_error("SDL_CreateGPUTexture frame graph");
    return texture;
}

void release_frame_graph_textures(GpuState& state) {
    for (GpuRenderTarget& target : state.render_targets) {
        if (target.sampled_color && target.sampled_color != target.color) {
            SDL_ReleaseGPUTexture(state.device, target.sampled_color);
        }
        if (target.color) SDL_ReleaseGPUTexture(state.device, target.color);
        if (target.depth) SDL_ReleaseGPUTexture(state.device, target.depth);
        target = {};
    }
    for (GpuGeometryTask& task : state.geometry_tasks) {
        for (std::size_t index = 0; index < task.colors.size(); ++index) {
            if (
                index < task.sampled_colors.size() &&
                task.sampled_colors[index] &&
                task.sampled_colors[index] != task.colors[index]) {
                SDL_ReleaseGPUTexture(
                    state.device,
                    task.sampled_colors[index]);
            }
            if (task.colors[index]) {
                SDL_ReleaseGPUTexture(state.device, task.colors[index]);
            }
        }
        if (task.depth) SDL_ReleaseGPUTexture(state.device, task.depth);
        if (task.params) SDL_ReleaseGPUBuffer(state.device, task.params);
        task.colors.clear();
        task.sampled_colors.clear();
        task.depth = nullptr;
        task.params = nullptr;
    }
#if defined(BBLITE_HAS_POST_PROCESS) && BBLITE_HAS_POST_PROCESS
    for (std::vector<GpuPostProcessTask>& passes :
         state.post_process_tasks) {
        for (GpuPostProcessTask& task : passes) {
            task = {};
        }
    }
    state.post_process_tasks.clear();
    // The programs outlive no build: a rebuilt graph may target different
    // formats, and every pass that borrowed one is being reset above.
    for (GpuPostProcessProgram& program : state.post_process_programs) {
        if (program.pipeline) {
            SDL_ReleaseGPUGraphicsPipeline(state.device, program.pipeline);
        }
    }
    state.post_process_programs.clear();
    if (state.post_process_present) {
        SDL_ReleaseGPUTexture(state.device, state.post_process_present);
        state.post_process_present = nullptr;
    }
#endif
#if defined(BBLITE_HAS_EFFECT_TASK) && BBLITE_HAS_EFFECT_TASK
    // An effect pass outlives no build either: its pipeline was built
    // against the target's format and sample count, and a rebuilt graph may
    // change both.
    for (EffectPass& pass : state.effect_tasks) {
        release_effect_pass(state.device, pass);
    }
    state.effect_tasks.clear();
#endif
    state.frame_graph_width = 0;
    state.frame_graph_height = 0;
}

void create_frame_graph_textures(
    GpuState& state,
    const Engine& engine,
    SDL_GPUTextureFormat surface_format,
    std::uint32_t width,
    std::uint32_t height) {
    if (
        state.render_targets.size() == engine.render_targets.size() &&
        state.frame_graph_width == width &&
        state.frame_graph_height == height) {
        return;
    }
    release_frame_graph_textures(state);
    state.frame_graph_width = width;
    state.frame_graph_height = height;
    state.render_targets.resize(engine.render_targets.size());
    for (std::size_t index = 0; index < engine.render_targets.size(); ++index) {
        const RenderTargetRecord& record = engine.render_targets[index];
        GpuRenderTarget& target = state.render_targets[index];
        target.width = record.width > 0 ? record.width : width;
        target.height = record.height > 0 ? record.height : height;
        // A composite's intermediate takes a fraction of whatever its
        // source resolved to. Creation order guarantees that source is
        // already sized: `create_render_target` refuses a forward reference.
        if (record.scale_source.value != invalid_handle) {
            const GpuRenderTarget& scale_source =
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
            target.color_format = surface_format;
            continue;
        }
        const SDL_GPUSampleCount samples =
            task_sample_count(state, record.samples);
        // "The source's format" is what a composite's intermediate asks for
        // when it names none, so it resolves through the target it scales
        // from rather than falling back to the surface.
        const SDL_GPUTextureFormat color_format =
            record.has_format
                ? texture_format(record.format)
                : record.scale_source.value != invalid_handle
                      ? state.render_targets[record.scale_source.value]
                            .color_format
                      : surface_format;
        target.color_format = color_format;
        if (record.has_color) {
            target.color = create_frame_texture(
                state.device,
                color_format,
                samples,
                target.width,
                target.height,
                SDL_GPU_TEXTUREUSAGE_COLOR_TARGET |
                    (samples == SDL_GPU_SAMPLECOUNT_1
                         ? SDL_GPU_TEXTUREUSAGE_SAMPLER
                         : 0));
            target.sampled_color =
                samples == SDL_GPU_SAMPLECOUNT_1
                    ? target.color
                    : create_frame_texture(
                          state.device,
                          color_format,
                          SDL_GPU_SAMPLECOUNT_1,
                          target.width,
                          target.height,
                          SDL_GPU_TEXTUREUSAGE_COLOR_TARGET |
                              SDL_GPU_TEXTUREUSAGE_SAMPLER);
        }
        if (record.has_depth) {
            // A shadow map states its own format: the pinned generator
            // creates `depth32float` where every other attachment takes the
            // device's own preferred sampled-depth format.
            target.depth = create_frame_texture(
                state.device,
                record.shadow_map
                    ? SDL_GPU_TEXTUREFORMAT_D32_FLOAT
                    : state.depth_format,
                samples,
                target.width,
                target.height,
                SDL_GPU_TEXTUREUSAGE_DEPTH_STENCIL_TARGET |
                    (record.sampled_depth
                         ? SDL_GPU_TEXTUREUSAGE_SAMPLER
                         : 0));
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
    for (std::size_t index = 0; index < engine.frame_tasks.size(); ++index) {
        const FrameTaskRecord& record = engine.frame_tasks[index];
        if (record.kind != FrameTaskKind::geometry) continue;
        GpuGeometryTask& task = state.geometry_tasks[index];
        task.depth_borrowed = geometry_depth_is_borrowed(engine, index);
        const SDL_GPUSampleCount samples =
            task_sample_count(state, record.geometry.samples);
        task.colors.reserve(record.geometry.attachments.size());
        task.sampled_colors.reserve(record.geometry.attachments.size());
        for (const GeometryTextureDescription& description :
             record.geometry.attachments) {
            const SDL_GPUTextureFormat format =
                geometry_texture_format(description);
            SDL_GPUTexture* color = create_frame_texture(
                state.device,
                format,
                samples,
                width,
                height,
                SDL_GPU_TEXTUREUSAGE_COLOR_TARGET |
                    (samples == SDL_GPU_SAMPLECOUNT_1
                         ? SDL_GPU_TEXTUREUSAGE_SAMPLER
                         : 0));
            task.colors.push_back(color);
            task.sampled_colors.push_back(
                samples == SDL_GPU_SAMPLECOUNT_1
                    ? color
                    : create_frame_texture(
                          state.device,
                          format,
                          SDL_GPU_SAMPLECOUNT_1,
                          width,
                          height,
                          SDL_GPU_TEXTUREUSAGE_COLOR_TARGET |
                              SDL_GPU_TEXTUREUSAGE_SAMPLER));
        }
        task.depth = create_frame_texture(
            state.device,
            state.depth_format,
            samples,
            width,
            height,
            SDL_GPU_TEXTUREUSAGE_DEPTH_STENCIL_TARGET);
    }
}

void save_geometry_id_buffer_png(
    GpuState& state,
    std::uint32_t width,
    std::uint32_t height,
    const std::array<float, 16>& view_projection,
    const std::vector<upstream::RenderItem>& render_plan,
    const Engine& engine,
    const std::string& path,
    bool cluster_ids) {
    SDL_GPUTextureCreateInfo color_info{};
    color_info.type = SDL_GPU_TEXTURETYPE_2D;
    color_info.format = SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM;
    color_info.usage = SDL_GPU_TEXTUREUSAGE_COLOR_TARGET;
    color_info.width = width;
    color_info.height = height;
    color_info.layer_count_or_depth = 1;
    color_info.num_levels = 1;
    color_info.sample_count = SDL_GPU_SAMPLECOUNT_1;
    SDL_GPUTexture* color = SDL_CreateGPUTexture(state.device, &color_info);
    if (!color) gpu_error("SDL_CreateGPUTexture ID buffer");

    SDL_GPUTextureCreateInfo depth_info{};
    depth_info.type = SDL_GPU_TEXTURETYPE_2D;
    depth_info.format = state.depth_format;
    depth_info.usage = SDL_GPU_TEXTUREUSAGE_DEPTH_STENCIL_TARGET;
    depth_info.width = width;
    depth_info.height = height;
    depth_info.layer_count_or_depth = 1;
    depth_info.num_levels = 1;
    depth_info.sample_count = SDL_GPU_SAMPLECOUNT_1;
    SDL_GPUTexture* depth = SDL_CreateGPUTexture(state.device, &depth_info);
    if (!depth) {
        SDL_ReleaseGPUTexture(state.device, color);
        gpu_error("SDL_CreateGPUTexture ID depth");
    }

    SDL_GPUCommandBuffer* command = SDL_AcquireGPUCommandBuffer(state.device);
    if (!command) {
        SDL_ReleaseGPUTexture(state.device, depth);
        SDL_ReleaseGPUTexture(state.device, color);
        gpu_error("SDL_AcquireGPUCommandBuffer ID buffer");
    }
    SDL_PushGPUVertexUniformData(
        command,
        0,
        view_projection.data(),
        sizeof(view_projection));

    SDL_GPUColorTargetInfo target{};
    target.texture = color;
    target.clear_color = SDL_FColor{0.0f, 0.0f, 0.0f, 0.0f};
    target.load_op = SDL_GPU_LOADOP_CLEAR;
    target.store_op = SDL_GPU_STOREOP_STORE;
    SDL_GPUDepthStencilTargetInfo depth_target{};
    depth_target.texture = depth;
    depth_target.clear_depth = upstream::pinned_depth_clear;
    depth_target.load_op = SDL_GPU_LOADOP_CLEAR;
    depth_target.store_op = SDL_GPU_STOREOP_DONT_CARE;
    depth_target.stencil_load_op = SDL_GPU_LOADOP_DONT_CARE;
    depth_target.stencil_store_op = SDL_GPU_STOREOP_DONT_CARE;
    SDL_GPURenderPass* pass =
        SDL_BeginGPURenderPass(command, &target, 1, &depth_target);
    for (int sided_mode = 0; sided_mode < 2; ++sided_mode) {
        SDL_BindGPUGraphicsPipeline(
            pass,
            cluster_ids
                ? (sided_mode == 0
                      ? state.cluster_pipeline
                      : state.cluster_double_sided_pipeline)
                : (sided_mode == 0
                      ? state.id_pipeline
                      : state.id_double_sided_pipeline));
        std::uint32_t cluster_id_base = 1;
        for (std::size_t mesh_index = 0; mesh_index < state.meshes.size(); ++mesh_index) {
            const GpuMesh& mesh = state.meshes[mesh_index];
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
            if (cluster_ids) {
                const DiagnosticClusterUniforms uniforms =
                    diagnostic_cluster_uniforms(
                        current_cluster_base,
                        alpha_options);
                SDL_PushGPUFragmentUniformData(
                    command,
                    0,
                    &uniforms,
                    sizeof(uniforms));
            } else {
                const DiagnosticIdUniforms uniforms =
                    diagnostic_id_uniforms(
                        static_cast<std::uint32_t>(mesh_index + 1),
                        alpha_options);
                SDL_PushGPUFragmentUniformData(
                    command,
                    0,
                    &uniforms,
                    sizeof(uniforms));
            }

            const SDL_GPUBufferBinding index_binding{mesh.indices, 0};
            const SDL_GPUTextureSamplerBinding texture_binding{
                mesh.base_color,
                state.sampler,
            };
            bind_mesh_vertex_buffers(pass, mesh);
            SDL_BindGPUIndexBuffer(
                pass,
                &index_binding,
                SDL_GPU_INDEXELEMENTSIZE_32BIT);
            SDL_BindGPUFragmentSamplers(pass, 0, &texture_binding, 1);
            SDL_DrawGPUIndexedPrimitives(
                pass,
                mesh.index_count,
                mesh.instance_count,
                0,
                0,
                0);
        }
    }
    SDL_EndGPURenderPass(pass);
    save_texture_png(
        state.device,
        command,
        color,
        SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM,
        width,
        height,
        path);
    SDL_ReleaseGPUTexture(state.device, depth);
    SDL_ReleaseGPUTexture(state.device, color);
}

// Release every GPU resource a mesh entry owns. Used by shutdown and
// by runtime scene removal, which drops entries mid-run (SDL defers the
// actual destruction until the GPU is done with them).
void release_gpu_mesh(GpuState& state, GpuMesh& mesh) {
    SDL_ReleaseGPUBuffer(state.device, mesh.vertices);
#if BBLITE_PBR_VARIANTS > 0
    if (mesh.pinned_vertices) {
        SDL_ReleaseGPUBuffer(state.device, mesh.pinned_vertices);
        mesh.pinned_vertices = nullptr;
    }
    if (mesh.pinned_bone_texture) {
        SDL_ReleaseGPUTexture(state.device, mesh.pinned_bone_texture);
        mesh.pinned_bone_texture = nullptr;
        mesh.pinned_bone_count = 0;
    }
    // Aliased to `instances` for thin-instanced meshes, owned otherwise.
    if (mesh.pinned_instances && mesh.pinned_instances != mesh.instances) {
        SDL_ReleaseGPUBuffer(state.device, mesh.pinned_instances);
    }
    mesh.pinned_instances = nullptr;
#endif
    SDL_ReleaseGPUBuffer(state.device, mesh.indices);
    SDL_ReleaseGPUBuffer(state.device, mesh.instances);
#if BBLITE_GPU_INSTANCE_COLORS
    SDL_ReleaseGPUBuffer(state.device, mesh.instance_colors);
#endif
#if BBLITE_GPU_MORPH_STORAGE
    if (mesh.owns_morph_buffers) {
        SDL_ReleaseGPUBuffer(state.device, mesh.morph_deltas);
        SDL_ReleaseGPUBuffer(state.device, mesh.morph_weights);
    }
#endif
    // One release per generated texture-slot row, which is exactly the set
    // the upload loop created.
    for (
        const upstream::MaterialTextureSlot& slot_row :
        upstream::material_texture_slots) {
        if (slot_row.slot == upstream::material_texture_no_slot) continue;
        const GpuMeshSlotMembers members =
            mesh_slot_members(slot_row.source);
        if (members.texture == nullptr) continue;
        SDL_ReleaseGPUTexture(state.device, mesh.*members.texture);
        SDL_ReleaseGPUSampler(state.device, mesh.*members.sampler);
    }
    // The shader material's own pairs, which the upload loop created
    // outside the slot table.
    release_sprite_fragment_textures(state.device, mesh.shader_textures);
}

void release(GpuState& state) {
    release_frame_graph_textures(state);
#if BBLITE_HAS_BILLBOARDS
    for (BillboardPass& billboard : state.billboard_passes) {
        release_billboard_pass(state.device, billboard);
    }
    state.billboard_passes.clear();
#endif
#if BBLITE_HAS_SPLATS
    for (SplatPass& splat : state.splat_passes) {
        release_splat_pass(state.device, splat);
    }
    state.splat_passes.clear();
#endif
    for (GpuMesh& mesh : state.meshes) {
        release_gpu_mesh(state, mesh);
    }
#if BBLITE_GPU_MORPH_STORAGE
    if (state.empty_morph_deltas) {
        SDL_ReleaseGPUBuffer(state.device, state.empty_morph_deltas);
    }
    if (state.empty_morph_weights) {
        SDL_ReleaseGPUBuffer(state.device, state.empty_morph_weights);
    }
#endif
#if BBLITE_IMAGE_SKYBOX
    if (state.image_skybox.pipeline) {
        SDL_ReleaseGPUGraphicsPipeline(
            state.device,
            state.image_skybox.pipeline);
    }
    if (state.image_skybox.texture) {
        SDL_ReleaseGPUTexture(
            state.device,
            state.image_skybox.texture);
    }
    if (state.image_skybox.indices) {
        SDL_ReleaseGPUBuffer(
            state.device,
            state.image_skybox.indices);
    }
    if (state.image_skybox.vertices) {
        SDL_ReleaseGPUBuffer(
            state.device,
            state.image_skybox.vertices);
    }
#endif
#if BBLITE_SOLID_SKYBOX
    if (state.solid_skybox.pipeline) {
        SDL_ReleaseGPUGraphicsPipeline(
            state.device,
            state.solid_skybox.pipeline);
    }
    if (state.solid_skybox.indices) {
        SDL_ReleaseGPUBuffer(
            state.device,
            state.solid_skybox.indices);
    }
    if (state.solid_skybox.vertices) {
        SDL_ReleaseGPUBuffer(
            state.device,
            state.solid_skybox.vertices);
    }
#endif
#if BBLITE_GPU_INSTANCING
    if (state.background_instances) {
        SDL_ReleaseGPUBuffer(
            state.device,
            state.background_instances);
    }
#endif
    if (state.background.vertices) SDL_ReleaseGPUBuffer(state.device, state.background.vertices);
    if (state.background.indices) SDL_ReleaseGPUBuffer(state.device, state.background.indices);
    if (state.background.texture) SDL_ReleaseGPUTexture(state.device, state.background.texture);
    if (state.skybox.vertices) SDL_ReleaseGPUBuffer(state.device, state.skybox.vertices);
    if (state.skybox.indices) SDL_ReleaseGPUBuffer(state.device, state.skybox.indices);
    if (state.skybox.texture && state.skybox.owns_texture) {
        SDL_ReleaseGPUTexture(state.device, state.skybox.texture);
    }
    if (state.environment) SDL_ReleaseGPUTexture(state.device, state.environment);
    if (state.brdf_lut) SDL_ReleaseGPUTexture(state.device, state.brdf_lut);
    if (state.reflection_fallback) {
        SDL_ReleaseGPUTexture(
            state.device,
            state.reflection_fallback);
    }
    for (SDL_GPUTexture* texture : state.reflection_cubes) {
        SDL_ReleaseGPUTexture(state.device, texture);
    }
    release_sized_texture(
        state,
        state.color,
        state.color_width,
        state.color_height);
    release_sized_texture(
        state,
        state.processed_color,
        state.processed_color_width,
        state.processed_color_height);
    release_sized_texture(
        state,
        state.transmission_color,
        state.transmission_width,
        state.transmission_height);
    release_sized_texture(
        state,
        state.msaa_color,
        state.msaa_color_width,
        state.msaa_color_height);
    release_sized_texture(
        state,
        state.depth,
        state.depth_width,
        state.depth_height);
    if (state.background_sampler) SDL_ReleaseGPUSampler(state.device, state.background_sampler);
    if (state.transmission_sampler) {
        SDL_ReleaseGPUSampler(
            state.device,
            state.transmission_sampler);
    }
    if (state.ground_sampler) {
        SDL_ReleaseGPUSampler(
            state.device,
            state.ground_sampler);
    }
#if defined(BBLITE_HAS_POST_PROCESS) && BBLITE_HAS_POST_PROCESS
    if (state.post_process_bilinear_sampler) {
        SDL_ReleaseGPUSampler(
            state.device,
            state.post_process_bilinear_sampler);
        state.post_process_bilinear_sampler = nullptr;
    }
    if (state.post_process_nearest_sampler) {
        SDL_ReleaseGPUSampler(
            state.device,
            state.post_process_nearest_sampler);
        state.post_process_nearest_sampler = nullptr;
    }
#endif
    if (state.depth_sampler) {
        SDL_ReleaseGPUSampler(state.device, state.depth_sampler);
    }
#if BBLITE_SHADOW_RECEIVERS
    for (const GpuState::ShadowGenerator& generator : state.shadow_generators) {
        if (generator.info) {
            SDL_ReleaseGPUBuffer(state.device, generator.info);
        }
    }
    state.shadow_generators.clear();
    if (state.shadow_comparison_sampler) {
        SDL_ReleaseGPUSampler(
            state.device,
            state.shadow_comparison_sampler);
        state.shadow_comparison_sampler = nullptr;
    }
    if (state.shadow_filtering_sampler) {
        SDL_ReleaseGPUSampler(
            state.device,
            state.shadow_filtering_sampler);
        state.shadow_filtering_sampler = nullptr;
    }
#endif
#if BBLITE_PBR_VARIANTS > 0
    if (state.pinned_bone_sampler) {
        SDL_ReleaseGPUSampler(state.device, state.pinned_bone_sampler);
    }
#endif
    if (state.sampler) SDL_ReleaseGPUSampler(state.device, state.sampler);
    if (state.background_pipeline) SDL_ReleaseGPUGraphicsPipeline(state.device, state.background_pipeline);
    if (state.skybox_pipeline) SDL_ReleaseGPUGraphicsPipeline(state.device, state.skybox_pipeline);
    if (state.id_pipeline) SDL_ReleaseGPUGraphicsPipeline(state.device, state.id_pipeline);
    if (state.id_double_sided_pipeline) SDL_ReleaseGPUGraphicsPipeline(state.device, state.id_double_sided_pipeline);
    if (state.cluster_pipeline) SDL_ReleaseGPUGraphicsPipeline(state.device, state.cluster_pipeline);
    if (state.cluster_double_sided_pipeline) {
        SDL_ReleaseGPUGraphicsPipeline(state.device, state.cluster_double_sided_pipeline);
    }
    if (state.blit_pipeline) {
        SDL_ReleaseGPUGraphicsPipeline(state.device, state.blit_pipeline);
    }
    if (state.blit_msaa_pipeline) {
        SDL_ReleaseGPUGraphicsPipeline(state.device, state.blit_msaa_pipeline);
    }
    if (state.image_processing_pipeline) {
        SDL_ReleaseGPUGraphicsPipeline(
            state.device,
            state.image_processing_pipeline);
    }
    for (SDL_GPUGraphicsPipeline* pipeline : state.depth_only_pipelines) {
        if (pipeline) {
            SDL_ReleaseGPUGraphicsPipeline(state.device, pipeline);
        }
    }
    for (
        SDL_GPUGraphicsPipeline* pipeline :
        state.depth_only_double_sided_pipelines) {
        if (pipeline) {
            SDL_ReleaseGPUGraphicsPipeline(state.device, pipeline);
        }
    }
#if BBLITE_STANDARD_VARIANTS > 0
    for (const auto& [key, pipeline] : state.standard_variant_pipelines) {
        (void)key;
        if (pipeline) {
            SDL_ReleaseGPUGraphicsPipeline(state.device, pipeline);
        }
    }
#endif
    if (state.grid_pipeline) {
        SDL_ReleaseGPUGraphicsPipeline(
            state.device,
            state.grid_pipeline);
    }
    if (state.grid_double_sided_pipeline) {
        SDL_ReleaseGPUGraphicsPipeline(
            state.device,
            state.grid_double_sided_pipeline);
    }
    if (state.grid_transparent_pipeline) {
        SDL_ReleaseGPUGraphicsPipeline(
            state.device,
            state.grid_transparent_pipeline);
    }
    if (state.grid_transparent_double_sided_pipeline) {
        SDL_ReleaseGPUGraphicsPipeline(
            state.device,
            state.grid_transparent_double_sided_pipeline);
    }
    for (SDL_GPUGraphicsPipeline* pipeline : state.shader_pipelines) {
        if (pipeline) {
            SDL_ReleaseGPUGraphicsPipeline(state.device, pipeline);
        }
    }
    for (SDL_GPUGraphicsPipeline* pipeline : state.shader_a2c_pipelines) {
        if (pipeline) {
            SDL_ReleaseGPUGraphicsPipeline(state.device, pipeline);
        }
    }
    if (state.window && state.device) SDL_ReleaseWindowFromGPUDevice(state.device, state.window);
    if (state.device) SDL_DestroyGPUDevice(state.device);
    if (state.window) SDL_DestroyWindow(state.window);
    SDL_Quit();
}

#if defined(BBLITE_HAS_POST_PROCESS) && BBLITE_HAS_POST_PROCESS
/**
 * The program a post-process pass draws with, built once per distinct one.
 *
 * A pass is identified as a drawing by its deployed module and the pipeline
 * state its output implies; everything else about it -- which textures it
 * binds, what its uniform block holds -- is per pass and stays there. A
 * composite's chain repeats the first and varies the second, so depth of
 * field's six blurs share one entry here.
 */
const GpuPostProcessProgram& post_process_program(
    GpuState& state,
    std::uint32_t module_index,
    SDL_GPUTextureFormat format,
    SDL_GPUSampleCount samples,
    std::uint32_t alpha_mode) {
    for (const GpuPostProcessProgram& program :
         state.post_process_programs) {
        if (
            program.module_index == module_index &&
            program.format == format &&
            program.samples == samples &&
            program.alpha_mode == alpha_mode) {
            return program;
        }
    }
    GpuPostProcessProgram program;
    program.module_index = module_index;
    program.format = format;
    program.samples = samples;
    program.alpha_mode = alpha_mode;
    const std::string stem =
        "postprocess-" + std::to_string(module_index);
    const std::string vertex_name = stem + ".vert";
    const std::string fragment_name = stem + ".frag";
    program.vertex_slots = read_pinned_stage_slots(vertex_name);
    program.fragment_slots = read_pinned_stage_slots(fragment_name);
    SDL_GPUShader* vertex_shader = load_shader(
        state.device,
        vertex_name.c_str(),
        SDL_GPU_SHADERSTAGE_VERTEX,
        static_cast<Uint32>(program.vertex_slots.textures.size()),
        static_cast<Uint32>(program.vertex_slots.uniforms.size()),
        "postProcessVertex");
    SDL_GPUShader* fragment_shader = load_shader(
        state.device,
        fragment_name.c_str(),
        SDL_GPU_SHADERSTAGE_FRAGMENT,
        static_cast<Uint32>(program.fragment_slots.textures.size()),
        static_cast<Uint32>(program.fragment_slots.uniforms.size()),
        "postProcessFragment");
    // The generated table names the pin's factors; turning them into this
    // API's enums is the backend's own `blend_state_from`.
    const upstream::PostProcessBlend blend =
        upstream::post_process_blend(alpha_mode);
    SDL_GPUColorTargetDescription target{};
    target.format = format;
    if (blend.enabled) {
        target.blend_state = blend_state_from(blend.factors);
    }
    SDL_GPUGraphicsPipelineCreateInfo info{};
    info.vertex_shader = vertex_shader;
    info.fragment_shader = fragment_shader;
    info.primitive_type = SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
    info.rasterizer_state.fill_mode = SDL_GPU_FILLMODE_FILL;
    info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_NONE;
    info.multisample_state.sample_count = samples;
    info.target_info.color_target_descriptions = &target;
    info.target_info.num_color_targets = 1;
    program.pipeline = SDL_CreateGPUGraphicsPipeline(state.device, &info);
    if (!program.pipeline) {
        gpu_error("SDL_CreateGPUGraphicsPipeline post-process");
    }
    SDL_ReleaseGPUShader(state.device, vertex_shader);
    SDL_ReleaseGPUShader(state.device, fragment_shader);
    state.post_process_programs.push_back(std::move(program));
    return state.post_process_programs.back();
}

/**
 * One post-process pass, recorded into the frame's command buffer.
 *
 * The pin runs every effect through the same pass -- a three-vertex draw over
 * the composed module its factory handed over -- so what this reads off the
 * record is the module, the textures it samples, the uniform block it writes,
 * and where it draws. `source_texture` resolves a frame-graph reference the
 * way every other task in this backend resolves one, so a pass sampling a
 * geometry attachment reaches it by the same path a render task would.
 *
 * A pass whose output is the swapchain draws into a readable copy and blits
 * that, because a swapchain texture cannot be read back and the capture reads
 * exactly what was presented; `capture_texture` is left naming the copy.
 */
template <typename SourceTexture, typename TargetTexture>
void record_post_process_pass(
    GpuState& state,
    Engine& engine,
    TaskHandle handle,
    SDL_GPUCommandBuffer* command,
    SDL_GPUTexture* swapchain,
    SDL_GPUTextureFormat swapchain_format,
    std::uint32_t width,
    std::uint32_t height,
    std::size_t index,
    SDL_GPUTexture*& capture_texture,
    SourceTexture source_texture,
    TargetTexture target_texture) {
    PostProcessPassOptions& pass =
        engine.frame_tasks[handle.value].post_process.passes[index];
    const upstream::PostProcessShaderInfo& shader_info =
        upstream::post_process_shader_infos[
            pass.shader_index];
    GpuPostProcessTask& gpu =
        state.post_process_tasks[handle.value][index];
    const RenderTargetRecord& output_record =
        engine.render_targets[pass.output_target.value];
    const std::uint32_t output_width =
        output_record.swapchain
            ? width
            : state
                  .render_targets[
                      pass.output_target.value]
                  .width;
    const std::uint32_t output_height =
        output_record.swapchain
            ? height
            : state
                  .render_targets[
                      pass.output_target.value]
                  .height;
    std::uint32_t source_width = output_width;
    std::uint32_t source_height = output_height;
    if (
        pass.source.source ==
            RenderTextureSource::render_target &&
        pass.source.target.value <
            state.render_targets.size()) {
        source_width =
            state
                .render_targets[pass.source.target.value]
                .width;
        source_height =
            state
                .render_targets[pass.source.target.value]
                .height;
    }
    // A swapchain texture cannot be read back, so a pass
    // that presents renders into this readable copy and
    // blits it, which is also what the capture reads.
    const bool presents = output_record.swapchain;
    if (presents && !state.post_process_present) {
        state.post_process_present =
            create_frame_texture(
                state.device,
                swapchain_format,
                SDL_GPU_SAMPLECOUNT_1,
                width,
                height,
                SDL_GPU_TEXTUREUSAGE_COLOR_TARGET |
                    SDL_GPU_TEXTUREUSAGE_SAMPLER);
    }
    if (!gpu.program) {
        // A pass writes into its own output, whose format the frame graph
        // already resolved -- a composite's intermediate may name its own
        // (the circle-of-confusion map is r16) or follow its source's. The
        // pin builds the pipeline against that target's own sample count and
        // resolves nothing; what it refuses is a multisampled *source*.
        gpu.program = &post_process_program(
            state,
            shader_info.module_index,
            state.render_targets[pass.output_target.value].color_format,
            presents
                ? SDL_GPU_SAMPLECOUNT_1
                : task_sample_count(state, output_record.samples),
            pass.alpha_mode);
        gpu.uniform_data.assign(
            ((shader_info.uniform_byte_length + 15u) &
             ~15u) /
                4u,
            0.0f);
        std::size_t extra_slot = 0;
        gpu.texture_sources.reserve(
            gpu.program->fragment_slots.textures.size());
        for (const std::string& name :
             gpu.program->fragment_slots.textures) {
            if (name == "sourceTextureSampler") {
                gpu.texture_sources.push_back(-1);
                continue;
            }
            if (
                extra_slot >=
                pass.extra_textures.size()) {
                throw std::runtime_error(
                    "Post-process stage declares a "
                    "texture the pass does not carry: " +
                    name);
            }
            gpu.texture_sources.push_back(
                static_cast<int>(extra_slot++));
        }
    }
    if (!gpu.uniform_data.empty()) {
        std::fill(
            gpu.uniform_data.begin(),
            gpu.uniform_data.end(),
            0.0f);
        upstream::write_post_process_uniforms(
            engine,
            pass,
            output_width,
            output_height,
            source_width,
            source_height,
            gpu.uniform_data.data());
        const std::size_t uniform_bytes =
            gpu.uniform_data.size() * sizeof(float);
        // At most one block per stage, so the slot the
        // compaction left it at is zero when it survived.
        if (!gpu.program->vertex_slots.uniforms.empty()) {
            SDL_PushGPUVertexUniformData(
                command,
                0,
                gpu.uniform_data.data(),
                static_cast<Uint32>(uniform_bytes));
        }
        if (!gpu.program->fragment_slots.uniforms.empty()) {
            SDL_PushGPUFragmentUniformData(
                command,
                0,
                gpu.uniform_data.data(),
                static_cast<Uint32>(uniform_bytes));
        }
    }
    // No dirty flag on this backend: SDL_GPU uniforms are
    // pushed per command buffer, so the block is written
    // every frame either way. The flag is Dawn's, whose
    // uniform buffer persists between frames.
    SDL_GPUColorTargetInfo pass_target{};
    pass_target.texture = presents
        ? state.post_process_present
        : target_texture(pass.output_target, false);
    // The pin leaves the attachment's clear value at
    // WebGPU's default, which is transparent black.
    pass_target.load_op = pass.clear
        ? SDL_GPU_LOADOP_CLEAR
        : SDL_GPU_LOADOP_LOAD;
    pass_target.clear_color =
        SDL_FColor{0.0f, 0.0f, 0.0f, 0.0f};
    pass_target.store_op = SDL_GPU_STOREOP_STORE;
    SDL_GPURenderPass* post_pass =
        SDL_BeginGPURenderPass(
            command,
            &pass_target,
            1,
            nullptr);
    SDL_BindGPUGraphicsPipeline(post_pass, gpu.program->pipeline);
    if (pass.has_viewport) {
        const PixelViewport rectangle =
            upstream::resolve_post_process_viewport(
                pass.viewport,
                output_width,
                output_height);
        const SDL_GPUViewport gpu_viewport{
            static_cast<float>(rectangle.x),
            static_cast<float>(rectangle.y),
            static_cast<float>(rectangle.width),
            static_cast<float>(rectangle.height),
            0.0f,
            1.0f,
        };
        SDL_SetGPUViewport(post_pass, &gpu_viewport);
        const SDL_Rect scissor{
            rectangle.x,
            rectangle.y,
            rectangle.width,
            rectangle.height,
        };
        SDL_SetGPUScissor(post_pass, &scissor);
    }
    // The pin binds one sampler for every texture the
    // stage reads; this backend pairs each with its own
    // texture, so the pair repeats the same sampler.
    SDL_GPUSampler* pass_sampler =
        pass.sampling == PostProcessSampling::nearest
            ? state.post_process_nearest_sampler
            : state.post_process_bilinear_sampler;
    std::array<
        SDL_GPUTextureSamplerBinding,
        max_post_process_textures>
        bindings{};
    for (std::size_t slot = 0;
         slot < gpu.texture_sources.size();
         ++slot) {
        const int source = gpu.texture_sources[slot];
        bindings[slot] = SDL_GPUTextureSamplerBinding{
            source_texture(
                source < 0
                    ? pass.source
                    : pass.extra_textures[
                          static_cast<std::size_t>(
                              source)]),
            pass_sampler};
    }
    if (!gpu.texture_sources.empty()) {
        SDL_BindGPUFragmentSamplers(
            post_pass,
            0,
            bindings.data(),
            static_cast<Uint32>(
                gpu.texture_sources.size()));
    }
    SDL_DrawGPUPrimitives(post_pass, 3, 1, 0, 0);
    SDL_EndGPURenderPass(post_pass);
    if (presents) {
        SDL_GPUColorTargetInfo present_target{};
        present_target.texture = swapchain;
        present_target.load_op =
            SDL_GPU_LOADOP_DONT_CARE;
        present_target.store_op = SDL_GPU_STOREOP_STORE;
        SDL_GPURenderPass* present_pass =
            SDL_BeginGPURenderPass(
                command,
                &present_target,
                1,
                nullptr);
        SDL_BindGPUGraphicsPipeline(
            present_pass,
            state.blit_pipeline);
        const SDL_GPUTextureSamplerBinding present_binding{
            state.post_process_present,
            state.background_sampler,
        };
        SDL_BindGPUFragmentSamplers(
            present_pass,
            0,
            &present_binding,
            1);
        SDL_DrawGPUPrimitives(present_pass, 3, 1, 0, 0);
        SDL_EndGPURenderPass(present_pass);
        capture_texture = state.post_process_present;
    }
}
#endif

} // namespace
#endif

bool run_gpu_engine(Engine& engine) {
    const FrameOptions frame_options = read_frame_options();
    reject_unsupported_frame_options(
        frame_options,
        "SDL_GPU",
        /*supports_single_sample=*/true,
        /*supports_copy_task=*/true);
#if defined(BBLITE_HAS_PBR_RENDERER) && BBLITE_HAS_PBR_RENDERER
    if (engine.registered_scenes.empty() || !engine.registered_scenes.front()) {
        throw std::runtime_error("GPU renderer requires a registered scene.");
    }
    reject_uncomposed_sprites(engine);
    Scene& scene = *engine.registered_scenes.front();
    apply_animation_seek(frame_options, scene);
    // Read by the image-skybox and ground arms, which not every feature set
    // compiles.
    [[maybe_unused]] const bool background_enabled =
        frame_options.background_enabled(scene.environment);
    const bool use_skybox =
        frame_options.skybox_enabled(scene.environment);
    const bool use_ground =
        frame_options.ground_enabled(scene.environment);
    const std::string id_buffer_path = frame_options.id_buffer_path;
    const std::string cluster_buffer_path =
        frame_options.cluster_buffer_path;
    const std::string& copy_task_filter =
        frame_options.copy_task_filter;
    if (!SDL_Init(SDL_INIT_VIDEO | SDL_INIT_EVENTS)) gpu_error("SDL_Init");

    GpuState state;
    try {
        const bool hidden_test_pass =
            frame_options.test_pass;
        state.window = SDL_CreateWindow(
            engine.options.title.c_str(),
            engine.options.width,
            engine.options.height,
            hidden_test_pass
                ? SDL_WINDOW_RESIZABLE |
                    SDL_WINDOW_NOT_FOCUSABLE
                : SDL_WINDOW_RESIZABLE);
        if (!state.window) gpu_error("SDL_CreateWindow");
        const bool gpu_debug =
            frame_options.gpu_debug;
        state.device = SDL_CreateGPUDevice(
            SDL_GPU_SHADERFORMAT_DXIL |
                SDL_GPU_SHADERFORMAT_SPIRV |
                SDL_GPU_SHADERFORMAT_MSL,
            gpu_debug,
            nullptr);
        if (!state.device) gpu_error("SDL_CreateGPUDevice");
        if (!SDL_ClaimWindowForGPUDevice(state.device, state.window)) gpu_error("SDL_ClaimWindowForGPUDevice");
        for (const SDL_GPUTextureFormat candidate : {
                 SDL_GPU_TEXTUREFORMAT_D32_FLOAT,
                 SDL_GPU_TEXTUREFORMAT_D24_UNORM,
             }) {
            if (SDL_GPUTextureSupportsFormat(
                    state.device,
                    candidate,
                    SDL_GPU_TEXTURETYPE_2D,
                    SDL_GPU_TEXTUREUSAGE_DEPTH_STENCIL_TARGET |
                        SDL_GPU_TEXTUREUSAGE_SAMPLER)) {
                state.depth_format = candidate;
                break;
            }
        }
        const SDL_GPUTextureFormat swapchain_format =
            SDL_GetGPUSwapchainTextureFormat(state.device, state.window);
        const bool transmission_enabled = scene.transmission_enabled;
        // The frame-graph path takes the main pass's else arm, where the
        // mid-pass scene-colour grab never runs — refuse, exactly as the
        // Dawn backend does, rather than render transmission-less.
        if (transmission_enabled && !scene.tasks.empty()) {
            throw std::runtime_error(
                "transmission combined with frame-graph tasks is not "
                "implemented yet.");
        }
        if (
            !frame_options.single_sample &&
            upstream::preferred_sample_count() >= 4 &&
            SDL_GPUTextureSupportsSampleCount(
                state.device,
                swapchain_format,
                SDL_GPU_SAMPLECOUNT_4) &&
            SDL_GPUTextureSupportsSampleCount(
                state.device,
                SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM,
                SDL_GPU_SAMPLECOUNT_4) &&
            SDL_GPUTextureSupportsSampleCount(
                state.device,
                SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT,
                SDL_GPU_SAMPLECOUNT_4) &&
            SDL_GPUTextureSupportsSampleCount(
                state.device,
                SDL_GPU_TEXTUREFORMAT_R16_FLOAT,
                SDL_GPU_SAMPLECOUNT_4) &&
            SDL_GPUTextureSupportsSampleCount(
                state.device,
                state.depth_format,
                SDL_GPU_SAMPLECOUNT_4)) {
            state.sample_count = SDL_GPU_SAMPLECOUNT_4;
        }
        const bool benchmark_mode = frame_options.benchmark_requested;
        if (benchmark_mode && SDL_WindowSupportsGPUPresentMode(
                state.device,
                state.window,
                SDL_GPU_PRESENTMODE_IMMEDIATE)) {
            if (!SDL_SetGPUSwapchainParameters(
                    state.device,
                    state.window,
                    SDL_GPU_SWAPCHAINCOMPOSITION_SDR,
                    SDL_GPU_PRESENTMODE_IMMEDIATE)) {
                gpu_error("SDL_SetGPUSwapchainParameters");
            }
        }
        if (!SDL_SetGPUAllowedFramesInFlight(state.device, 3)) {
            gpu_error("SDL_SetGPUAllowedFramesInFlight");
        }

        SDL_GPUShader* vertex_shader =
            load_shader(
                state.device,
                "pbr.vert",
                SDL_GPU_SHADERSTAGE_VERTEX,
                0,
#if BBLITE_GPU_DEFORMATION && BBLITE_GPU_INSTANCING
                3,
#elif BBLITE_GPU_DEFORMATION || BBLITE_GPU_INSTANCING
                2,
#else
                1,
#endif
                "mainVertex",
#if BBLITE_GPU_MORPH_STORAGE
                2);
#else
                0);
#endif
        SDL_GPUShader* image_processing_vertex_shader =
            transmission_enabled
                ? load_shader(
                      state.device,
                      "image-processing.vert",
                      SDL_GPU_SHADERSTAGE_VERTEX,
                      0,
                      0,
                      "mainVertex")
                : nullptr;
        // The pinned image-processing task samples the multisampled
        // attachment and averages after `ip()`. That needs a texture SDL
        // refuses to create with a read usage until libsdl-org/SDL#15838
        // lands, so the single-sample fragment stays as the fallback for
        // BBLITE_MSAA=1 and for a build against stock SDL.
        const bool per_sample_image_processing =
            transmission_enabled &&
            state.sample_count != SDL_GPU_SAMPLECOUNT_1;
        SDL_GPUShader* image_processing_fragment_shader =
            transmission_enabled
                ? (per_sample_image_processing
                       ? load_shader(
                             state.device,
                             "image-processing-ms.frag",
                             SDL_GPU_SHADERSTAGE_FRAGMENT,
                             0,
                             1,
                             "mainFragment",
                             0,
                             1)
                       : load_shader(
                             state.device,
                             "image-processing.frag",
                             SDL_GPU_SHADERSTAGE_FRAGMENT,
                             1,
                             1,
                             "mainFragment"))
                : nullptr;
        const upstream::RenderFeatures render_features =
            upstream::build_render_features(scene, engine);
        // The Standard family's reflection cubes still upload when the
        // family is present; its stages themselves are the composed
        // variant-std-* modules, loaded lazily per variant.
        const bool use_standard_material =
            render_features.standard_material;
        const bool use_grid_material =
            render_features.grid_material;
        SDL_GPUShader* grid_vertex_shader = use_grid_material
            ? load_shader(
                  state.device,
                  "grid.vert",
                  SDL_GPU_SHADERSTAGE_VERTEX,
                  0,
                  1,
                  "mainVertex")
            : nullptr;
        SDL_GPUShader* grid_fragment_shader = use_grid_material
            ? load_shader(
                  state.device,
                  "grid.frag",
                  SDL_GPU_SHADERSTAGE_FRAGMENT,
                  0,
                  1,
                  "mainFragment")
            : nullptr;
        const bool use_no_color_material =
            render_features.no_color_material;
        SDL_GPUShader* depth_only_fragment_shader =
            use_no_color_material
                ? load_shader(
                      state.device,
                      "depth-only.frag",
                      SDL_GPU_SHADERSTAGE_FRAGMENT,
                      0,
                      0,
                      "mainFragment")
                : nullptr;
        const bool use_shader_materials =
            render_features.shader_material;
        std::vector<SDL_GPUShader*> shader_vertex_shaders;
        std::vector<SDL_GPUShader*> shader_fragment_shaders;
        if (use_shader_materials) {
            const std::uint32_t shader_variant_total =
                upstream::shader_variant_count();
            shader_vertex_shaders.resize(
                shader_variant_total,
                nullptr);
            shader_fragment_shaders.resize(
                shader_variant_total,
                nullptr);
            state.shader_vertex_slots.resize(shader_variant_total);
            state.shader_fragment_slots.resize(shader_variant_total);
            for (
                std::uint32_t variant = 0;
                variant < shader_variant_total;
                ++variant) {
                const upstream::ShaderVariantInfo& info =
                    upstream::shader_variant_info(variant);
                const std::string vertex_name =
                    std::string(info.name) + ".vert";
                const std::string fragment_name =
                    std::string(info.name) + ".frag";
                // A shader material's stage is composed from the caller's
                // own WGSL, so which blocks and textures survive to the
                // compiled artifact is the caller's text to decide -- a
                // sampler read only inside a branch a define folds away is
                // stripped, and the registers behind it move up. The
                // compaction pass publishes what it assigned, so the PAL
                // binds by that sidecar rather than by the reflection
                // generation derived, exactly as the post-process and
                // billboard programs already do.
                state.shader_vertex_slots[variant] =
                    read_pinned_stage_slots(vertex_name);
                state.shader_fragment_slots[variant] =
                    read_pinned_stage_slots(fragment_name);
                const PinnedStageSlots& vertex_slots =
                    state.shader_vertex_slots[variant];
                const PinnedStageSlots& fragment_slots =
                    state.shader_fragment_slots[variant];
                shader_vertex_shaders[variant] = load_shader(
                    state.device,
                    vertex_name.c_str(),
                    SDL_GPU_SHADERSTAGE_VERTEX,
                    static_cast<Uint32>(vertex_slots.textures.size()),
                    static_cast<Uint32>(vertex_slots.uniforms.size()),
                    "mainVertex");
                shader_fragment_shaders[variant] = load_shader(
                    state.device,
                    fragment_name.c_str(),
                    SDL_GPU_SHADERSTAGE_FRAGMENT,
                    static_cast<Uint32>(fragment_slots.textures.size()),
                    static_cast<Uint32>(fragment_slots.uniforms.size()),
                    "mainFragment");
            }
        }
        // The pinned position-seeded dither. background-ground.ts and
        // background-dds-skybox.ts prefix WGSL_DITHER; the environment
        // cubemap arm (background-hdr-skybox.ts) composes none, and one
        // generated fragment serves both skyboxes, so the variant is
        // selected here.
        SDL_GPUShader* background_fragment_shader = use_ground
            ? load_shader(
                  state.device,
                  "background-ground-dither.frag",
                  SDL_GPU_SHADERSTAGE_FRAGMENT,
                  1,
                  1,
                  "mainFragment")
            : nullptr;
        SDL_GPUShader* skybox_fragment_shader = use_skybox
            ? load_shader(
                  state.device,
                  scene.environment.skybox_uses_environment
                      ? "background-skybox.frag"
                      : "background-skybox-dither.frag",
                  SDL_GPU_SHADERSTAGE_FRAGMENT,
                  1,
                  1,
                  "mainFragment")
            : nullptr;
        SDL_GPUShader* id_fragment_shader = !id_buffer_path.empty()
            ? load_shader(
                  state.device,
                  "diagnostic-id.frag",
                  SDL_GPU_SHADERSTAGE_FRAGMENT,
                  1,
                  1,
                  "mainFragment")
            : nullptr;
        SDL_GPUShader* cluster_fragment_shader = !cluster_buffer_path.empty()
            ? load_shader(
                  state.device,
                  "diagnostic-cluster.frag",
                  SDL_GPU_SHADERSTAGE_FRAGMENT,
                  1,
                  1,
                  "mainFragment")
            : nullptr;

        std::array<
            SDL_GPUVertexBufferDescription,
#if BBLITE_GPU_INSTANCING
            2
#else
            1
#endif
        > vertex_buffers{};
        vertex_buffers[0].slot = 0;
        vertex_buffers[0].pitch = sizeof(GpuVertex);
        vertex_buffers[0].input_rate =
            SDL_GPU_VERTEXINPUTRATE_VERTEX;
#if BBLITE_GPU_DEFORMATION
        constexpr Uint32 base_attribute_count = 16;
#else
        constexpr Uint32 base_attribute_count = 8;
#endif
        std::array<
            SDL_GPUVertexAttribute,
#if BBLITE_GPU_INSTANCING
            base_attribute_count + 4
#else
            base_attribute_count
#endif
        > attributes{};
        constexpr Uint32 attribute_count =
            static_cast<Uint32>(attributes.size());
        attributes[0] = SDL_GPUVertexAttribute{0, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT3, 0};
        attributes[1] = SDL_GPUVertexAttribute{1, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT3, 12};
        attributes[2] = SDL_GPUVertexAttribute{2, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT4, 24};
        attributes[3] = SDL_GPUVertexAttribute{3, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT2, 40};
        attributes[4] = SDL_GPUVertexAttribute{4, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT3, 48};
        attributes[5] = SDL_GPUVertexAttribute{5, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT2, 60};
        attributes[6] = SDL_GPUVertexAttribute{6, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT4, 68};
        attributes[7] = SDL_GPUVertexAttribute{7, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT3, 84};
#if BBLITE_GPU_DEFORMATION
        attributes[8] = SDL_GPUVertexAttribute{8, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT4, 96};
        attributes[9] = SDL_GPUVertexAttribute{9, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT4, 112};
        attributes[10] = SDL_GPUVertexAttribute{10, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT3, 128};
        attributes[11] = SDL_GPUVertexAttribute{11, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT3, 140};
        attributes[12] = SDL_GPUVertexAttribute{12, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT3, 152};
        attributes[13] = SDL_GPUVertexAttribute{13, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT3, 164};
        attributes[14] = SDL_GPUVertexAttribute{14, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT3, 176};
        attributes[15] = SDL_GPUVertexAttribute{15, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT3, 188};
#endif
#if BBLITE_GPU_INSTANCING
        vertex_buffers[1].slot = 1;
        vertex_buffers[1].pitch =
            sizeof(std::array<float, 16>);
        vertex_buffers[1].input_rate =
            SDL_GPU_VERTEXINPUTRATE_INSTANCE;
        attributes[base_attribute_count] =
            SDL_GPUVertexAttribute{
                16,
                1,
                SDL_GPU_VERTEXELEMENTFORMAT_FLOAT4,
                0};
        attributes[base_attribute_count + 1] =
            SDL_GPUVertexAttribute{
                17,
                1,
                SDL_GPU_VERTEXELEMENTFORMAT_FLOAT4,
                16};
        attributes[base_attribute_count + 2] =
            SDL_GPUVertexAttribute{
                18,
                1,
                SDL_GPU_VERTEXELEMENTFORMAT_FLOAT4,
                32};
        attributes[base_attribute_count + 3] =
            SDL_GPUVertexAttribute{
                19,
                1,
                SDL_GPU_VERTEXELEMENTFORMAT_FLOAT4,
                48};
#endif
        SDL_GPUColorTargetDescription color_target{};
        color_target.format = transmission_enabled
            ? SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT
            : swapchain_format;
#if BBLITE_PINNED_MATERIALS
        // The pinned pipelines are built lazily on first use, long after this
        // point, and they target the same attachment as the transcribed ones.
        state.pinned_color_format = color_target.format;
#endif
#if BBLITE_HAS_SPLATS
        // One pass per cloud the scene registered, against the same
        // attachment and depth the scene's own draws use.
        for (const SplatMeshHandle splat : scene.splat_meshes) {
            state.splat_passes.push_back(create_splat_pass(
                state.device,
                engine,
                splat,
                color_target.format,
                state.depth_format,
                state.sample_count));
        }
#endif
#if BBLITE_HAS_BILLBOARDS
        // One pass per system the scene registered, targeting the same
        // attachment and depth the scene's own draws do.
        for (const BillboardSystemHandle system : scene.billboard_systems) {
            state.billboard_passes.push_back(create_billboard_pass(
                state.device,
                engine,
                system,
                color_target.format,
                state.depth_format,
                state.sample_count));
        }
#endif
        // The shared material vertex with no fragment: the PBR fragment text
        // is retired -- PBR draws run the pin's own composed stages -- so this
        // info is only the base the standard, grid and diagnostic pipelines
        // copy before setting their own fragment.
        SDL_GPUGraphicsPipelineCreateInfo pipeline_info{};
        pipeline_info.vertex_shader = vertex_shader;
        pipeline_info.vertex_input_state =
            SDL_GPUVertexInputState{
                vertex_buffers.data(),
                static_cast<Uint32>(
                    vertex_buffers.size()),
                attributes.data(),
                attribute_count,
            };
        pipeline_info.primitive_type = SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
        pipeline_info.rasterizer_state.fill_mode = SDL_GPU_FILLMODE_FILL;
        pipeline_info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_BACK;
        pipeline_info.rasterizer_state.front_face = SDL_GPU_FRONTFACE_COUNTER_CLOCKWISE;
        pipeline_info.rasterizer_state.enable_depth_clip = true;
        pipeline_info.depth_stencil_state.compare_op = gpu_depth_compare(upstream::pinned_depth_compare);
        pipeline_info.depth_stencil_state.enable_depth_test = true;
        pipeline_info.depth_stencil_state.enable_depth_write = true;
        pipeline_info.multisample_state.sample_count = state.sample_count;
        pipeline_info.target_info.color_target_descriptions = &color_target;
        pipeline_info.target_info.num_color_targets = 1;
        pipeline_info.target_info.depth_stencil_format =
            state.depth_format;
        pipeline_info.target_info.has_depth_stencil_target = true;
        if (
            image_processing_vertex_shader &&
            image_processing_fragment_shader) {
            SDL_GPUColorTargetDescription image_processing_target{};
            image_processing_target.format = swapchain_format;
            SDL_GPUGraphicsPipelineCreateInfo image_processing_info{};
            image_processing_info.vertex_shader =
                image_processing_vertex_shader;
            image_processing_info.fragment_shader =
                image_processing_fragment_shader;
            image_processing_info.primitive_type =
                SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
            image_processing_info.rasterizer_state.fill_mode =
                SDL_GPU_FILLMODE_FILL;
            image_processing_info.rasterizer_state.cull_mode =
                SDL_GPU_CULLMODE_NONE;
            image_processing_info.multisample_state.sample_count =
                SDL_GPU_SAMPLECOUNT_1;
            image_processing_info.target_info.color_target_descriptions =
                &image_processing_target;
            image_processing_info.target_info.num_color_targets = 1;
            state.per_sample_image_processing =
                per_sample_image_processing;
            state.image_processing_pipeline =
                SDL_CreateGPUGraphicsPipeline(
                    state.device,
                    &image_processing_info);
            if (!state.image_processing_pipeline) {
                gpu_error(
                    "SDL_CreateGPUGraphicsPipeline image processing");
            }
        }
        if (grid_vertex_shader && grid_fragment_shader) {
            SDL_GPUGraphicsPipelineCreateInfo grid_pipeline_info =
                pipeline_info;
            grid_pipeline_info.vertex_shader = grid_vertex_shader;
            grid_pipeline_info.fragment_shader = grid_fragment_shader;
            grid_pipeline_info.rasterizer_state.cull_mode =
                SDL_GPU_CULLMODE_BACK;
            state.grid_pipeline =
                SDL_CreateGPUGraphicsPipeline(
                    state.device,
                    &grid_pipeline_info);
            if (!state.grid_pipeline) {
                gpu_error(
                    "SDL_CreateGPUGraphicsPipeline grid material");
            }
            grid_pipeline_info.rasterizer_state.cull_mode =
                SDL_GPU_CULLMODE_NONE;
            state.grid_double_sided_pipeline =
                SDL_CreateGPUGraphicsPipeline(
                    state.device,
                    &grid_pipeline_info);
            if (!state.grid_double_sided_pipeline) {
                gpu_error(
                    "SDL_CreateGPUGraphicsPipeline grid double-sided");
            }
        }
        for (std::size_t index = 0;
             depth_only_fragment_shader &&
             index < state.depth_only_pipelines.size();
             ++index) {
            SDL_GPUGraphicsPipelineCreateInfo depth_pipeline_info =
                pipeline_info;
            depth_pipeline_info.fragment_shader =
                depth_only_fragment_shader;
            depth_pipeline_info.rasterizer_state.cull_mode =
                SDL_GPU_CULLMODE_BACK;
            depth_pipeline_info.multisample_state.sample_count =
                index == 0
                    ? SDL_GPU_SAMPLECOUNT_1
                    : state.sample_count;
            depth_pipeline_info.target_info.color_target_descriptions =
                nullptr;
            depth_pipeline_info.target_info.num_color_targets = 0;
            depth_pipeline_info.target_info.depth_stencil_format =
                state.depth_format;
            depth_pipeline_info.target_info.has_depth_stencil_target = true;
            state.depth_only_pipelines[index] =
                SDL_CreateGPUGraphicsPipeline(
                    state.device,
                    &depth_pipeline_info);
            if (!state.depth_only_pipelines[index]) {
                gpu_error(
                    "SDL_CreateGPUGraphicsPipeline depth-only");
            }
            depth_pipeline_info.rasterizer_state.cull_mode =
                SDL_GPU_CULLMODE_NONE;
            state.depth_only_double_sided_pipelines[index] =
                SDL_CreateGPUGraphicsPipeline(
                    state.device,
                    &depth_pipeline_info);
            if (!state.depth_only_double_sided_pipelines[index]) {
                gpu_error(
                    "SDL_CreateGPUGraphicsPipeline depth-only double-sided");
            }
        }
        if (use_shader_materials) {
            const std::uint32_t shader_variant_total =
                upstream::shader_variant_count();
            state.shader_pipelines.resize(
                shader_variant_total,
                nullptr);
            state.shader_a2c_pipelines.resize(
                shader_variant_total,
                nullptr);
            for (
                std::uint32_t variant = 0;
                variant < shader_variant_total;
                ++variant) {
                SDL_GPUShader* variant_vertex_shader =
                    shader_vertex_shaders[variant];
                SDL_GPUShader* variant_fragment_shader =
                    shader_fragment_shaders[variant];
                if (!variant_vertex_shader ||
                    !variant_fragment_shader) {
                    continue;
                }
                const upstream::ShaderVariantInfo& info =
                    upstream::shader_variant_info(variant);
                // The pinned shader-pipeline mapping: needAlphaBlending
                // selects the src-alpha/one-minus-src-alpha blend,
                // backFaceCulling selects the cull mode, and
                // depthWrite=false turns depth writes off.
                SDL_GPUColorTargetDescription shader_target =
                    color_target;
                if (info.alpha_blending) {
                    shader_target.blend_state =
                        blend_state_from(transparent_blend);
                }
                SDL_GPUGraphicsPipelineCreateInfo shader_pipeline_info =
                    pipeline_info;
                shader_pipeline_info.vertex_shader =
                    variant_vertex_shader;
                shader_pipeline_info.fragment_shader =
                    variant_fragment_shader;
                shader_pipeline_info.rasterizer_state.cull_mode =
                    info.back_face_culling
                        ? SDL_GPU_CULLMODE_BACK
                        : SDL_GPU_CULLMODE_NONE;
                // The material's own primitive: the pin builds a shader
                // pipeline at `material._topology ?? "triangle-list"`, and
                // a line material is the one reached material that names
                // the second one.
                shader_pipeline_info.primitive_type =
                    info.topology == upstream::ShaderTopology::line_list
                        ? SDL_GPU_PRIMITIVETYPE_LINELIST
                        : SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
                if (!info.depth_write) {
                    shader_pipeline_info.depth_stencil_state
                        .enable_depth_write = false;
                }
                shader_pipeline_info.target_info
                    .color_target_descriptions = &shader_target;
#if BBLITE_GPU_INSTANCE_COLORS
                // A material reading the per-instance RGBA stream draws
                // through a widened vertex input: the shared layout plus
                // the lane the pin's own thin-instance module appends,
                // in its own tightly-packed instance buffer. Only this
                // family declares it, so every other pipeline keeps the
                // layout it had.
                std::array<SDL_GPUVertexBufferDescription, 3>
                    color_vertex_buffers{};
                std::array<
                    SDL_GPUVertexAttribute,
                    attributes.size() + 1> color_attributes{};
                if (info.instance_colors) {
                    std::copy(
                        vertex_buffers.begin(),
                        vertex_buffers.end(),
                        color_vertex_buffers.begin());
                    color_vertex_buffers[2].slot = 2;
                    color_vertex_buffers[2].pitch =
                        sizeof(std::array<float, 4>);
                    color_vertex_buffers[2].input_rate =
                        SDL_GPU_VERTEXINPUTRATE_INSTANCE;
                    std::copy(
                        attributes.begin(),
                        attributes.end(),
                        color_attributes.begin());
                    color_attributes[attributes.size()] =
                        SDL_GPUVertexAttribute{
                            instance_color_location,
                            2,
                            SDL_GPU_VERTEXELEMENTFORMAT_FLOAT4,
                            0};
                    shader_pipeline_info.vertex_input_state
                        .vertex_buffer_descriptions =
                        color_vertex_buffers.data();
                    shader_pipeline_info.vertex_input_state
                        .num_vertex_buffers = static_cast<Uint32>(
                        color_vertex_buffers.size());
                    shader_pipeline_info.vertex_input_state
                        .vertex_attributes = color_attributes.data();
                    shader_pipeline_info.vertex_input_state
                        .num_vertex_attributes = static_cast<Uint32>(
                        color_attributes.size());
                }
#endif
                state.shader_pipelines[variant] =
                    SDL_CreateGPUGraphicsPipeline(
                        state.device,
                        &shader_pipeline_info);
                if (!state.shader_pipelines[variant]) {
                    gpu_error(
                        "SDL_CreateGPUGraphicsPipeline shader material");
                }
                // The one a2c rule (pal_gpu_shared.hpp): coverage needs
                // samples to spread across, so a single-sample run draws
                // the same un-cut pixels Dawn does instead of a2c's
                // implicit 0.5 cutoff.
                shader_pipeline_info.multisample_state
                    .enable_alpha_to_coverage = alpha_to_coverage_enabled(
                    true,
                    gpu_sample_count_value(state.sample_count));
                state.shader_a2c_pipelines[variant] =
                    SDL_CreateGPUGraphicsPipeline(
                        state.device,
                        &shader_pipeline_info);
                if (!state.shader_a2c_pipelines[variant]) {
                    gpu_error(
                        "SDL_CreateGPUGraphicsPipeline alpha to coverage");
                }
            }
        }
        state.geometry_tasks.resize(engine.frame_tasks.size());
        if (!scene.tasks.empty()) {
            SDL_GPUShader* blit_vertex_shader = load_shader(
                state.device,
                "blit.vert",
                SDL_GPU_SHADERSTAGE_VERTEX,
                0,
                0,
                "mainVertex");
            SDL_GPUShader* blit_fragment_shader = load_shader(
                state.device,
                "blit.frag",
                SDL_GPU_SHADERSTAGE_FRAGMENT,
                1,
                0,
                "mainFragment");
            SDL_GPUColorTargetDescription blit_target{};
            blit_target.format = swapchain_format;
            SDL_GPUGraphicsPipelineCreateInfo blit_pipeline_info{};
            blit_pipeline_info.vertex_shader = blit_vertex_shader;
            blit_pipeline_info.fragment_shader = blit_fragment_shader;
            blit_pipeline_info.primitive_type =
                SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
            blit_pipeline_info.rasterizer_state.fill_mode =
                SDL_GPU_FILLMODE_FILL;
            blit_pipeline_info.rasterizer_state.cull_mode =
                SDL_GPU_CULLMODE_NONE;
            blit_pipeline_info.multisample_state.sample_count =
                SDL_GPU_SAMPLECOUNT_1;
            blit_pipeline_info.target_info.color_target_descriptions =
                &blit_target;
            blit_pipeline_info.target_info.num_color_targets = 1;
            state.blit_pipeline = SDL_CreateGPUGraphicsPipeline(
                state.device,
                &blit_pipeline_info);
            if (!state.blit_pipeline) {
                gpu_error("SDL_CreateGPUGraphicsPipeline blit");
            }
            blit_pipeline_info.multisample_state.sample_count =
                state.sample_count;
            state.blit_msaa_pipeline = SDL_CreateGPUGraphicsPipeline(
                state.device,
                &blit_pipeline_info);
            if (!state.blit_msaa_pipeline) {
                gpu_error("SDL_CreateGPUGraphicsPipeline blit MSAA");
            }
            SDL_ReleaseGPUShader(state.device, blit_vertex_shader);
            SDL_ReleaseGPUShader(state.device, blit_fragment_shader);
        }
        if (id_fragment_shader) {
            SDL_GPUColorTargetDescription id_target{};
            id_target.format = SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM;
            SDL_GPUGraphicsPipelineCreateInfo id_pipeline_info = pipeline_info;
            id_pipeline_info.fragment_shader = id_fragment_shader;
            id_pipeline_info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_BACK;
            id_pipeline_info.multisample_state.sample_count = SDL_GPU_SAMPLECOUNT_1;
            id_pipeline_info.target_info.color_target_descriptions = &id_target;
            state.id_pipeline =
                SDL_CreateGPUGraphicsPipeline(state.device, &id_pipeline_info);
            id_pipeline_info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_NONE;
            state.id_double_sided_pipeline =
                SDL_CreateGPUGraphicsPipeline(state.device, &id_pipeline_info);
        }
        if (cluster_fragment_shader) {
            SDL_GPUColorTargetDescription cluster_target{};
            cluster_target.format = SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM;
            SDL_GPUGraphicsPipelineCreateInfo cluster_pipeline_info = pipeline_info;
            cluster_pipeline_info.fragment_shader = cluster_fragment_shader;
            cluster_pipeline_info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_BACK;
            cluster_pipeline_info.multisample_state.sample_count = SDL_GPU_SAMPLECOUNT_1;
            cluster_pipeline_info.target_info.color_target_descriptions =
                &cluster_target;
            state.cluster_pipeline =
                SDL_CreateGPUGraphicsPipeline(state.device, &cluster_pipeline_info);
            cluster_pipeline_info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_NONE;
            state.cluster_double_sided_pipeline =
                SDL_CreateGPUGraphicsPipeline(state.device, &cluster_pipeline_info);
        }
        color_target.blend_state = blend_state_from(transparent_blend);
        pipeline_info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_BACK;
        pipeline_info.depth_stencil_state.enable_depth_write = false;
        if (grid_vertex_shader && grid_fragment_shader) {
            pipeline_info.vertex_shader = grid_vertex_shader;
            pipeline_info.fragment_shader = grid_fragment_shader;
            pipeline_info.rasterizer_state.cull_mode =
                SDL_GPU_CULLMODE_BACK;
            state.grid_transparent_pipeline =
                SDL_CreateGPUGraphicsPipeline(
                    state.device,
                    &pipeline_info);
            if (!state.grid_transparent_pipeline) {
                gpu_error(
                    "SDL_CreateGPUGraphicsPipeline grid transparent");
            }
            pipeline_info.rasterizer_state.cull_mode =
                SDL_GPU_CULLMODE_NONE;
            state.grid_transparent_double_sided_pipeline =
                SDL_CreateGPUGraphicsPipeline(
                    state.device,
                    &pipeline_info);
            if (!state.grid_transparent_double_sided_pipeline) {
                gpu_error(
                    "SDL_CreateGPUGraphicsPipeline grid transparent double-sided");
            }
        }
        if (skybox_fragment_shader) {
            pipeline_info.vertex_shader = vertex_shader;
            pipeline_info.fragment_shader = skybox_fragment_shader;
            color_target.blend_state.enable_blend = false;
            // `skybox_layer_culls_back` states why the cube must cull.
            pipeline_info.rasterizer_state.cull_mode =
                skybox_layer_culls_back(SkyboxLayer::environment)
                    ? SDL_GPU_CULLMODE_BACK
                    : SDL_GPU_CULLMODE_NONE;
            state.skybox_pipeline = SDL_CreateGPUGraphicsPipeline(state.device, &pipeline_info);
        }
        if (background_fragment_shader) {
            pipeline_info.vertex_shader = vertex_shader;
            pipeline_info.fragment_shader = background_fragment_shader;
            color_target.blend_state = blend_state_from(ground_blend);
            pipeline_info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_BACK;
            state.background_pipeline = SDL_CreateGPUGraphicsPipeline(state.device, &pipeline_info);
        }
#if BBLITE_IMAGE_SKYBOX
        if (
            scene.environment.has_image_skybox &&
            background_enabled) {
            SDL_GPUShader* image_skybox_vertex_shader =
                load_shader(
                    state.device,
                    "skybox-cubemap.vert",
                    SDL_GPU_SHADERSTAGE_VERTEX,
                    0,
                    1,
                    "mainVertex");
            SDL_GPUShader* image_skybox_fragment_shader =
                load_shader(
                    state.device,
                    "skybox-cubemap.frag",
                    SDL_GPU_SHADERSTAGE_FRAGMENT,
                    1,
                    1,
                    "mainFragment");
            const SDL_GPUVertexBufferDescription
                image_skybox_buffer{
                    0,
                    sizeof(float) * 3,
                    SDL_GPU_VERTEXINPUTRATE_VERTEX,
                    0,
                };
            const SDL_GPUVertexAttribute
                image_skybox_attribute{
                    0,
                    0,
                    SDL_GPU_VERTEXELEMENTFORMAT_FLOAT3,
                    0,
                };
            SDL_GPUGraphicsPipelineCreateInfo
                image_skybox_info = pipeline_info;
            image_skybox_info.vertex_shader =
                image_skybox_vertex_shader;
            image_skybox_info.fragment_shader =
                image_skybox_fragment_shader;
            image_skybox_info.vertex_input_state =
                SDL_GPUVertexInputState{
                    &image_skybox_buffer,
                    1,
                    &image_skybox_attribute,
                    1,
                };
            image_skybox_info.rasterizer_state.cull_mode =
                skybox_layer_culls_back(SkyboxLayer::image)
                    ? SDL_GPU_CULLMODE_BACK
                    : SDL_GPU_CULLMODE_NONE;
            state.image_skybox.pipeline =
                SDL_CreateGPUGraphicsPipeline(
                    state.device,
                    &image_skybox_info);
            if (!state.image_skybox.pipeline) {
                gpu_error(
                    "SDL_CreateGPUGraphicsPipeline image skybox");
            }
            SDL_ReleaseGPUShader(
                state.device,
                image_skybox_vertex_shader);
            SDL_ReleaseGPUShader(
                state.device,
                image_skybox_fragment_shader);
        }
#endif
#if BBLITE_SOLID_SKYBOX
        if (
            scene.environment.has_solid_skybox &&
            background_enabled) {
            SDL_GPUShader* solid_skybox_vertex_shader =
                load_shader(
                    state.device,
                    "solid-skybox.vert",
                    SDL_GPU_SHADERSTAGE_VERTEX,
                    0,
                    2,
                    "mainVertex");
            SDL_GPUShader* solid_skybox_fragment_shader =
                load_shader(
                    state.device,
                    "solid-skybox.frag",
                    SDL_GPU_SHADERSTAGE_FRAGMENT,
                    0,
                    1,
                    "mainFragment");
            const SDL_GPUVertexBufferDescription
                solid_skybox_buffer{
                    0,
                    sizeof(float) * 3,
                    SDL_GPU_VERTEXINPUTRATE_VERTEX,
                    0,
                };
            const SDL_GPUVertexAttribute
                solid_skybox_attribute{
                    0,
                    0,
                    SDL_GPU_VERTEXELEMENTFORMAT_FLOAT3,
                    0,
                };
            // The ground arm above leaves the shared color target blending;
            // the solid skybox composes none (createDefaultPipelineDescriptor
            // is given no _blend).
            color_target.blend_state.enable_blend = false;
            SDL_GPUGraphicsPipelineCreateInfo
                solid_skybox_info = pipeline_info;
            solid_skybox_info.vertex_shader =
                solid_skybox_vertex_shader;
            solid_skybox_info.fragment_shader =
                solid_skybox_fragment_shader;
            solid_skybox_info.vertex_input_state =
                SDL_GPUVertexInputState{
                    &solid_skybox_buffer,
                    1,
                    &solid_skybox_attribute,
                    1,
                };
            // createDefaultPipelineDescriptor's own defaults, which
            // background-solid-skybox.ts does not override:
            // counter-clockwise front, depth writes off, and the shared
            // back-cull rule (`skybox_layer_culls_back`).
            solid_skybox_info.rasterizer_state.cull_mode =
                skybox_layer_culls_back(SkyboxLayer::solid)
                    ? SDL_GPU_CULLMODE_BACK
                    : SDL_GPU_CULLMODE_NONE;
            state.solid_skybox.pipeline =
                SDL_CreateGPUGraphicsPipeline(
                    state.device,
                    &solid_skybox_info);
            if (!state.solid_skybox.pipeline) {
                gpu_error(
                    "SDL_CreateGPUGraphicsPipeline solid skybox");
            }
            SDL_ReleaseGPUShader(
                state.device,
                solid_skybox_vertex_shader);
            SDL_ReleaseGPUShader(
                state.device,
                solid_skybox_fragment_shader);
        }
#endif
        SDL_ReleaseGPUShader(state.device, vertex_shader);
        if (image_processing_vertex_shader) {
            SDL_ReleaseGPUShader(
                state.device,
                image_processing_vertex_shader);
        }
        if (image_processing_fragment_shader) {
            SDL_ReleaseGPUShader(
                state.device,
                image_processing_fragment_shader);
        }
        if (grid_vertex_shader) {
            SDL_ReleaseGPUShader(state.device, grid_vertex_shader);
        }
        if (grid_fragment_shader) {
            SDL_ReleaseGPUShader(state.device, grid_fragment_shader);
        }
        if (depth_only_fragment_shader) {
            SDL_ReleaseGPUShader(
                state.device,
                depth_only_fragment_shader);
        }
        for (SDL_GPUShader* shader : shader_vertex_shaders) {
            if (shader) SDL_ReleaseGPUShader(state.device, shader);
        }
        for (SDL_GPUShader* shader : shader_fragment_shaders) {
            if (shader) SDL_ReleaseGPUShader(state.device, shader);
        }
        if (background_fragment_shader) {
            SDL_ReleaseGPUShader(state.device, background_fragment_shader);
        }
        if (skybox_fragment_shader) {
            SDL_ReleaseGPUShader(state.device, skybox_fragment_shader);
        }
        if (id_fragment_shader) {
            SDL_ReleaseGPUShader(state.device, id_fragment_shader);
        }
        if (cluster_fragment_shader) {
            SDL_ReleaseGPUShader(state.device, cluster_fragment_shader);
        }
        if (background_fragment_shader && !state.background_pipeline) {
            gpu_error("SDL_CreateGPUGraphicsPipeline background");
        }
        if (skybox_fragment_shader && !state.skybox_pipeline) {
            gpu_error("SDL_CreateGPUGraphicsPipeline skybox");
        }
        if (id_fragment_shader && (!state.id_pipeline || !state.id_double_sided_pipeline)) {
            gpu_error("SDL_CreateGPUGraphicsPipeline ID buffer");
        }
        if (
            cluster_fragment_shader &&
            (!state.cluster_pipeline || !state.cluster_double_sided_pipeline)) {
            gpu_error("SDL_CreateGPUGraphicsPipeline triangle cluster");
        }

        SDL_GPUSamplerCreateInfo sampler_info{};
        sampler_info.min_filter = SDL_GPU_FILTER_LINEAR;
        sampler_info.mag_filter = SDL_GPU_FILTER_LINEAR;
        sampler_info.mipmap_mode = SDL_GPU_SAMPLERMIPMAPMODE_LINEAR;
        sampler_info.address_mode_u =
            SDL_GPU_SAMPLERADDRESSMODE_REPEAT;
        sampler_info.address_mode_v =
            SDL_GPU_SAMPLERADDRESSMODE_REPEAT;
        sampler_info.address_mode_w =
            SDL_GPU_SAMPLERADDRESSMODE_REPEAT;
        sampler_info.max_lod = 1000.0f;
        state.sampler = SDL_CreateGPUSampler(state.device, &sampler_info);
        if (!state.sampler) gpu_error("SDL_CreateGPUSampler");
        // Scene-color grab sampler mirrors Babylon Lite's
        // trilinear-anisotropic sampler: linear filters, repeat
        // addressing, and the shared anisotropy (inert under
        // explicit-LOD sampling but kept for descriptor parity).
        sampler_info.enable_anisotropy = true;
        sampler_info.max_anisotropy =
            static_cast<float>(transmission_sampler_max_anisotropy);
        state.transmission_sampler =
            SDL_CreateGPUSampler(state.device, &sampler_info);
        if (!state.transmission_sampler) {
            gpu_error("SDL_CreateGPUSampler transmission");
        }
        sampler_info.enable_anisotropy = false;
        sampler_info.max_anisotropy = 0.0f;
#if BBLITE_GPU_MORPH_STORAGE
        {
            const std::array<float, 1> zero_delta{0.0f};
            state.empty_morph_deltas = upload_buffer(
                state.device,
                SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ,
                zero_delta.data(),
                sizeof(zero_delta));
            const std::array<std::uint32_t, 4> zero_header{};
            state.empty_morph_weights = upload_buffer(
                state.device,
                SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ,
                zero_header.data(),
                sizeof(zero_header));
        }
#endif
        sampler_info.address_mode_u =
            SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
        sampler_info.address_mode_v =
            SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
        sampler_info.address_mode_w =
            SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
        state.background_sampler = SDL_CreateGPUSampler(state.device, &sampler_info);
        if (!state.background_sampler) gpu_error("SDL_CreateGPUSampler background");
        sampler_info.max_lod = 0.0f;
        state.ground_sampler =
            SDL_CreateGPUSampler(
                state.device,
                &sampler_info);
        if (!state.ground_sampler) {
            gpu_error("SDL_CreateGPUSampler ground");
        }
        sampler_info.max_lod = 1000.0f;
        sampler_info.min_filter = SDL_GPU_FILTER_NEAREST;
        sampler_info.mag_filter = SDL_GPU_FILTER_NEAREST;
        sampler_info.mipmap_mode = SDL_GPU_SAMPLERMIPMAPMODE_NEAREST;
        state.depth_sampler =
            SDL_CreateGPUSampler(state.device, &sampler_info);
        if (!state.depth_sampler) {
            gpu_error("SDL_CreateGPUSampler depth");
        }
#if defined(BBLITE_HAS_POST_PROCESS) && BBLITE_HAS_POST_PROCESS
        {
            SDL_GPUSamplerCreateInfo post_process_info{};
            post_process_info.address_mode_u =
                SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
            post_process_info.address_mode_v =
                SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
            post_process_info.address_mode_w =
                SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
            post_process_info.mipmap_mode =
                SDL_GPU_SAMPLERMIPMAPMODE_NEAREST;
            post_process_info.min_filter = SDL_GPU_FILTER_NEAREST;
            post_process_info.mag_filter = SDL_GPU_FILTER_NEAREST;
            state.post_process_nearest_sampler =
                SDL_CreateGPUSampler(state.device, &post_process_info);
            if (!state.post_process_nearest_sampler) {
                gpu_error("SDL_CreateGPUSampler post-process nearest");
            }
            post_process_info.min_filter = SDL_GPU_FILTER_LINEAR;
            post_process_info.mag_filter = SDL_GPU_FILTER_LINEAR;
            state.post_process_bilinear_sampler =
                SDL_CreateGPUSampler(state.device, &post_process_info);
            if (!state.post_process_bilinear_sampler) {
                gpu_error("SDL_CreateGPUSampler post-process bilinear");
            }
        }
#endif
        state.environment = upload_environment(state.device, scene.environment);
        state.brdf_lut = upload_brdf_lut(state.device, scene.environment);
        if (use_standard_material) {
            state.reflection_fallback =
                upload_cube_texture(state.device, nullptr);
            state.reflection_cubes.reserve(
                engine.reflection_cubes.size());
            for (const auto& cube : engine.reflection_cubes) {
                state.reflection_cubes.push_back(
                    upload_cube_texture(state.device, &cube));
            }
        }
        if (use_skybox) {
            const upstream::SkyboxPlan skybox =
                upstream::build_skybox_plan(scene.environment);
            std::array<GpuVertex, 8> vertices{};
            for (std::size_t index = 0; index < vertices.size(); ++index) {
                vertices[index] = gpu_vertex_from(skybox.vertices[index]);
            }
            state.skybox.vertices = upload_buffer(
                state.device,
                SDL_GPU_BUFFERUSAGE_VERTEX,
                vertices.data(),
                sizeof(vertices));
            state.skybox.indices = upload_buffer(
                state.device,
                SDL_GPU_BUFFERUSAGE_INDEX,
                skybox.indices.data(),
                sizeof(skybox.indices));
            if (scene.environment.skybox_uses_environment) {
                state.skybox.texture = state.environment;
                state.skybox.owns_texture = false;
            } else {
                state.skybox.texture =
                    upload_dds_skybox(
                        state.device,
                        scene.environment);
                state.skybox.owns_texture = true;
            }
            state.skybox.enabled = true;
        }
        if (scene.environment.has_ground && use_ground) {
            const upstream::BackgroundPlan background =
                upstream::build_background_plan(scene.environment);
            std::array<GpuVertex, 4> vertices{};
            for (std::size_t index = 0; index < vertices.size(); ++index) {
                vertices[index] =
                    gpu_vertex_from(background.vertices[index]);
            }
            state.background.vertices = upload_buffer(
                state.device,
                SDL_GPU_BUFFERUSAGE_VERTEX,
                vertices.data(),
                sizeof(vertices));
            state.background.indices = upload_buffer(
                state.device,
                SDL_GPU_BUFFERUSAGE_INDEX,
                background.indices.data(),
                sizeof(background.indices));
            state.background.texture = upload_texture(
                state.device,
                scene.environment.ground_texture,
                false,
                {255, 255, 255, 255});
            state.background.enabled = true;
        }
#if BBLITE_IMAGE_SKYBOX
        if (
            scene.environment.has_image_skybox &&
            background_enabled &&
            state.image_skybox.pipeline) {
            const upstream::ImageSkyboxPlan image_skybox_plan =
                upstream::build_image_skybox_plan(
                    scene.environment);
            state.image_skybox.vertices = upload_buffer(
                state.device,
                SDL_GPU_BUFFERUSAGE_VERTEX,
                image_skybox_plan.positions.data(),
                sizeof(image_skybox_plan.positions));
            state.image_skybox.indices = upload_buffer(
                state.device,
                SDL_GPU_BUFFERUSAGE_INDEX,
                image_skybox_plan.indices.data(),
                sizeof(image_skybox_plan.indices));
            state.image_skybox.texture = upload_cube_texture(
                state.device,
                &scene.environment.image_skybox_faces);
            state.image_skybox.enabled = true;
        }
#endif
#if BBLITE_SOLID_SKYBOX
        if (
            scene.environment.has_solid_skybox &&
            background_enabled &&
            state.solid_skybox.pipeline) {
            const upstream::SolidSkyboxPlan solid_skybox_plan =
                upstream::build_solid_skybox_plan(
                    scene.environment);
            state.solid_skybox.vertices = upload_buffer(
                state.device,
                SDL_GPU_BUFFERUSAGE_VERTEX,
                solid_skybox_plan.positions.data(),
                sizeof(solid_skybox_plan.positions));
            state.solid_skybox.indices = upload_buffer(
                state.device,
                SDL_GPU_BUFFERUSAGE_INDEX,
                solid_skybox_plan.indices.data(),
                sizeof(solid_skybox_plan.indices));
            state.solid_skybox.enabled = true;
        }
#endif
#if BBLITE_GPU_INSTANCING
        if (
            (state.background.enabled ||
             state.skybox.enabled) &&
            !state.background_instances) {
            std::array<float, 16> identity{};
            identity[0] = 1.0f;
            identity[5] = 1.0f;
            identity[10] = 1.0f;
            identity[15] = 1.0f;
            state.background_instances = upload_buffer(
                state.device,
                SDL_GPU_BUFFERUSAGE_VERTEX,
                identity.data(),
                sizeof(identity));
        }
#endif

        upstream::RenderPlan render_plan =
            upstream::build_render_plan(scene, engine);
        // Every item's kind and variant against the generated tables
        // before anything uploads — the same shared walk the Dawn
        // backend runs, so a plan the build cannot draw fails here
        // rather than at (or past) the draw.
        validate_render_plan_items(render_plan);
        const auto upload_render_item =
            [&](const upstream::RenderItem& item) -> GpuMesh {
            const ModelGeometry& geometry = engine.geometries[item.geometry];
            const MeshRecord& mesh_record =
                engine.meshes[item.mesh.value];
            const std::vector<GpuVertex> vertices =
                transformed_vertices(geometry, mesh_record);
            GpuMesh gpu_mesh;
            gpu_mesh.vertices = upload_buffer(
                state.device,
                SDL_GPU_BUFFERUSAGE_VERTEX,
                vertices.data(),
                vertices.size() * sizeof(GpuVertex));
#if BBLITE_PBR_VARIANTS > 0
            {
                const std::vector<GpuVertex> pinned =
                    pinned_convention_vertices(
                        vertices,
                        mesh_record.mirrored_x);
                gpu_mesh.pinned_vertices = upload_buffer(
                    state.device,
                    SDL_GPU_BUFFERUSAGE_VERTEX,
                    pinned.data(),
                    pinned.size() * sizeof(GpuVertex));
            }
#endif
            gpu_mesh.indices = upload_buffer(
                state.device,
                SDL_GPU_BUFFERUSAGE_INDEX,
                geometry.indices.data(),
                geometry.indices.size() * sizeof(std::uint32_t));
#if BBLITE_GPU_MORPH_STORAGE
            gpu_mesh.morph_deltas = state.empty_morph_deltas;
            gpu_mesh.morph_weights = state.empty_morph_weights;
            if (
                mesh_record.gpu_deformation &&
                !geometry.morph_positions.empty()) {
                const std::vector<float> deltas =
                    pack_morph_deltas(geometry);
                gpu_mesh.morph_deltas = upload_buffer(
                    state.device,
                    SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ,
                    deltas.data(),
                    deltas.size() * sizeof(float));
                const std::vector<std::uint8_t> weights_blob =
                    pack_morph_weights(geometry, mesh_record);
                gpu_mesh.morph_weights = upload_buffer(
                    state.device,
                    SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ,
                    weights_blob.data(),
                    weights_blob.size());
                gpu_mesh.morph_weights_version =
                    mesh_record.morph_weights_version;
                gpu_mesh.owns_morph_buffers = true;
            }
#endif
#if BBLITE_GPU_INSTANCING
            std::vector<std::array<float, 16>>
                instance_matrices =
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
            // draw record.instance_count of it and re-upload through the
            // version-gated per-frame sync below.
            gpu_mesh.instances = upload_buffer(
                state.device,
                SDL_GPU_BUFFERUSAGE_VERTEX,
                instance_matrices.data(),
                instance_matrices.size() *
                    sizeof(instance_matrices.front()));
#if BBLITE_PBR_VARIANTS > 0
            if (mesh_record.instance_source != nullptr) {
                // Scene-code thin instances already carry Babylon's own
                // values, so the pinned draw shares the buffer -- and with
                // it the version-gated dynamic re-upload below.
                gpu_mesh.pinned_instances = gpu_mesh.instances;
            } else {
                const std::vector<std::array<float, 16>>
                    pinned_matrices =
                        pinned_instance_matrices(mesh_record);
                if (!pinned_matrices.empty()) {
                    gpu_mesh.pinned_instances = upload_buffer(
                        state.device,
                        SDL_GPU_BUFFERUSAGE_VERTEX,
                        pinned_matrices.data(),
                        pinned_matrices.size() *
                            sizeof(pinned_matrices.front()));
                }
            }
#endif
            gpu_mesh.instance_count =
                mesh_record.thin_instanced
                    ? mesh_record.instance_count
                    : static_cast<std::uint32_t>(
                          instance_matrices.size());
            gpu_mesh.instance_version =
                mesh_record.instance_version;
#if BBLITE_GPU_INSTANCE_COLORS
            {
                // One tightly-packed RGBA row per instance. A mesh with
                // none still binds the slot, so it takes one white row.
                std::vector<float> instance_colors =
                    mesh_record.instance_colors;
                if (instance_colors.empty()) {
                    instance_colors.assign(4, 1.0f);
                }
                gpu_mesh.instance_colors = upload_buffer(
                    state.device,
                    SDL_GPU_BUFFERUSAGE_VERTEX,
                    instance_colors.data(),
                    instance_colors.size() * sizeof(float));
            }
#endif
#endif
            gpu_mesh.index_count =             static_cast<std::uint32_t>(geometry.indices.size());
            gpu_mesh.transform_version =
            mesh_record.transform_version;
            const bool standard_material =
                item.material_kind == upstream::RenderMaterialKind::standard;
            const MaterialRecord* material = nullptr;
            if (item.material.value < engine.materials.size()) {
                material = &engine.materials[item.material.value];
                if (
                    standard_material &&
                    material->reflection_cube <
                        state.reflection_cubes.size()) {
                    gpu_mesh.reflection =
                        state.reflection_cubes[
                            material->reflection_cube];
                }
            }
            if (standard_material && !gpu_mesh.reflection) {
                gpu_mesh.reflection =
                    state.reflection_fallback;
            }
            // One upload per generated texture-slot row: which record
            // field fills the slot, its sRGB view and its fallback texel
            // are the table's, resolved through the shared helpers; this
            // backend keeps the upload mechanics and the enum→member
            // residue in `mesh_slot_members`.
            for (
                const upstream::MaterialTextureSlot& slot_row :
                upstream::material_texture_slots) {
                if (
                    slot_row.slot ==
                    upstream::material_texture_no_slot) {
                    continue;
                }
                const GpuMeshSlotMembers members =
                    mesh_slot_members(slot_row.source);
                if (members.texture == nullptr) {
                    gpu_error(
                        "generated texture slot has no SDL_GPU member.");
                }
                const TextureData* data = material
                    ? material_slot_texture(
                          *material,
                          slot_row.source,
                          standard_material)
                    : nullptr;
                const TextureData empty{};
                gpu_mesh.*members.texture = upload_texture(
                    state.device,
                    data ? *data : empty,
                    material_slot_srgb(
                        slot_row.srgb,
                        material,
                        standard_material),
                    material_slot_fallback(
                        slot_row.fallback,
                        material,
                        standard_material));
                gpu_mesh.*members.sampler = create_texture_sampler(
                    state.device,
                    data ? data->sampler : TextureSamplerState{});
            }
            // A shader material's own samplers sit outside the generated
            // slot table: the caller named them, so they bind as fragment
            // samplers of their own.
            //
            // The record stores them in the order `samplers` declared, and
            // the compiled stage keeps whichever its WGSL reads, densely,
            // at registers the compaction pass assigned. So the upload
            // walks that stage's sidecar and pulls each surviving name's
            // texture out of the declared order -- the same name-to-
            // resource resolution the composed Standard variants use. A
            // register naming something the material never declared is a
            // generation bug, not a draw to skip.
            // The caller's own texture slots -- a shader material's declared
            // samplers and a node graph's `TextureBlock` bindings alike --
            // upload the same way: the image's own bytes, the material's own
            // sampler, and the white fallback every slot takes.
            const auto upload_material_slot_texture =
                [&](const FileTexture& texture) {
                    return SDL_GPUTextureSamplerBinding{
                        upload_texture(
                            state.device,
                            texture.data,
                            texture.srgb,
                            {255, 255, 255, 255}),
                        create_texture_sampler(
                            state.device,
                            texture.data.sampler)};
                };
            // A node graph's own textures upload in the order the variant
            // table declares them, because that is the order the draw
            // resolves a declared binding by -- the compaction that reorders
            // a shader material's slots does not reach them, since a node
            // stage names its bindings `nodeTex_<name>` and the draw matches
            // on the name rather than on a register.
            if (material && material->node_material) {
                for (const FileTexture& texture : material->shader_textures) {
                    gpu_mesh.shader_textures.push_back(
                        upload_material_slot_texture(texture));
                }
            }
            if (material && material->shader_material) {
                const upstream::ShaderVariantInfo& shader_info =
                    upstream::shader_variant_info(
                        material->shader_variant);
                const PinnedStageSlots& slots =
                    state.shader_fragment_slots[
                        material->shader_variant];
                for (const std::string& texture_name : slots.textures) {
                    const auto declared = std::find_if(
                        shader_info.samplers.begin(),
                        shader_info.samplers.end(),
                        [&](const char* candidate) {
                            return texture_name == candidate;
                        });
                    if (declared == shader_info.samplers.end()) {
                        gpu_error(
                            shader_sampler_unmapped(
                                shader_info,
                                texture_name)
                                .c_str());
                    }
                    const std::size_t slot = static_cast<std::size_t>(
                        declared - shader_info.samplers.begin());
                    if (slot >= material->shader_textures.size()) {
                        gpu_error(
                            shader_sampler_shortfall(
                                shader_info,
                                material->shader_textures.size())
                                .c_str());
                    }
                    gpu_mesh.shader_textures.push_back(
                        upload_material_slot_texture(
                            material->shader_textures[slot]));
                }
            }
            return gpu_mesh;
        };
        for (const upstream::RenderItem& item : render_plan.items) {
            state.meshes.push_back(upload_render_item(item));
        }
        std::vector<upstream::RenderDrawLists> task_draw_lists(
            engine.frame_tasks.size());
        const auto rebuild_task_draw_lists = [&] {
            for (
                std::size_t index = 0;
                index < engine.frame_tasks.size();
                ++index) {
                task_draw_lists[index] =
                    upstream::build_render_task_draw_lists(
                        render_plan.items,
                        engine,
                        engine.frame_tasks[index]);
            }
        };
        rebuild_task_draw_lists();
        std::uint64_t synced_mesh_membership_version =
            scene.mesh_membership_version;
        std::uint32_t synced_material_family_mask =
            scene.material_family_mask;

        CameraRecord fallback_camera;
        CameraRecord& camera =
            scene.camera.value < engine.cameras.size()
                ? engine.cameras[scene.camera.value]
                : fallback_camera;
        CameraPointerState pointer_state;
        const std::string screenshot_path = frame_options.screenshot_path;
        const long screenshot_frame = frame_options.screenshot_frame;
        const bool benchmark = frame_options.benchmarking();
        const long warmup = frame_options.benchmark_warmup();
        const long limit = frame_options.frame_budget();
        CaptureGate captures(frame_options, limit, &engine);
        std::vector<double> samples;
        bool running = true;
        long frame = 0;
        FrameClock frame_clock;
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
            // The swapchain is acquired before the scene advances, because
            // SDL only reports an unavailable texture *from*
            // `SDL_WaitAndAcquireGPUSwapchainTexture` -- it cannot be tested
            // for first. An iteration that gets none produces no frame, so it
            // must not advance the clock, run the before-render callbacks or
            // upload anything either; those all live below the check now, and
            // time stops behind a minimised window the way a throttled
            // `requestAnimationFrame` stops it. The cost of the early acquire
            // is holding the image across the scene half of the frame.
            //
            // The benchmark bracket therefore starts here, covering the whole
            // loop body; `pal_dawn.cpp` starts its own at the same point so
            // the published pair stays comparable.
            const double start = monotonic_milliseconds();
            SDL_GPUCommandBuffer* command = SDL_AcquireGPUCommandBuffer(state.device);
            if (!command) gpu_error("SDL_AcquireGPUCommandBuffer");
            SDL_GPUTexture* swapchain = nullptr;
            Uint32 width = 0;
            Uint32 height = 0;
            if (!SDL_WaitAndAcquireGPUSwapchainTexture(
                    command,
                    state.window,
                    &swapchain,
                    &width,
                    &height)) {
                gpu_error("SDL_WaitAndAcquireGPUSwapchainTexture");
            }
            if (!swapchain) {
                SDL_CancelGPUCommandBuffer(command);
                continue;
            }
            // Only an animated billboard pass reads it, so the frame's own
            // delta is unused in a build that reaches no billboards.
            [[maybe_unused]] const float delta_ms =
                advance_frame(engine, scene, frame_clock);
            for (
                std::size_t index = 0;
                index < render_plan.items.size() &&
                index < state.meshes.size();
                ++index) {
                const upstream::RenderItem& item =
                    render_plan.items[index];
                const MeshRecord& mesh =
                    engine.meshes[item.mesh.value];
                GpuMesh& gpu_mesh = state.meshes[index];
#if BBLITE_GPU_INSTANCING
                if (
                    mesh.thin_instanced &&
                    gpu_mesh.instance_version !=
                        mesh.instance_version) {
                    // Re-upload the pinned dirty range [0, count) from
                    // the record pool; slots past the active count keep
                    // their previous contents and are never drawn.
                    const std::size_t active_count = std::min(
                        static_cast<std::size_t>(
                            mesh.instance_count),
                        mesh.instance_matrices.size());
                    if (active_count > 0) {
                        update_buffer(
                            state.device,
                            gpu_mesh.instances,
                            mesh.instance_matrices.data(),
                            active_count *
                                sizeof(mesh.instance_matrices
                                           .front()));
                    }
                    gpu_mesh.instance_count =
                        static_cast<std::uint32_t>(
                            active_count);
                    gpu_mesh.instance_version =
                        mesh.instance_version;
                }
#endif
                if (
                    mesh.gpu_deformation &&
                    !engine.geometries[item.geometry].flat_normals) {
#if BBLITE_GPU_MORPH_STORAGE
                    if (
                        gpu_mesh.owns_morph_buffers &&
                        gpu_mesh.morph_weights_version !=
                            mesh.morph_weights_version) {
                        // The shared packer both upload paths use; this
                        // re-upload used to rebuild the same blob inline.
                        const std::vector<std::uint8_t> weights_blob =
                            pack_morph_weights(
                                engine.geometries[item.geometry],
                                mesh);
                        update_buffer(
                            state.device,
                            gpu_mesh.morph_weights,
                            weights_blob.data(),
                            weights_blob.size());
                        gpu_mesh.morph_weights_version =
                            mesh.morph_weights_version;
                    }
#endif
                    gpu_mesh.transform_version =
                        mesh.transform_version;
                    continue;
                }
                if (gpu_mesh.transform_version == mesh.transform_version) {
                    continue;
                }
                const std::vector<GpuVertex> vertices =
                    transformed_vertices(
                        engine.geometries[item.geometry],
                        mesh);
                update_buffer(
                    state.device,
                    gpu_mesh.vertices,
                    vertices.data(),
                    vertices.size() * sizeof(GpuVertex));
#if BBLITE_PBR_VARIANTS > 0
                if (gpu_mesh.pinned_vertices) {
                    const std::vector<GpuVertex> pinned =
                        pinned_convention_vertices(
                            vertices,
                            mesh.mirrored_x);
                    update_buffer(
                        state.device,
                        gpu_mesh.pinned_vertices,
                        pinned.data(),
                        pinned.size() * sizeof(GpuVertex));
                }
#endif
                gpu_mesh.transform_version =
                    mesh.transform_version;
            }
            bool topology_updated = false;
            if (
                scene.mesh_membership_version !=
                synced_mesh_membership_version) {
                if (!SDL_WaitForGPUIdle(state.device)) {
                    gpu_error(
                        "SDL_WaitForGPUIdle topology update");
                }
                const std::uint32_t added_families =
                    scene.material_family_mask &
                    ~synced_material_family_mask;
                // The table half of the guard is shared with Dawn; the
                // built-pipeline checks below are this backend's own
                // residue — its modules are built eagerly at startup, so
                // a family the initial plan never reached has none.
                reject_uncomposed_family_growth(added_families);
                if (
                    (added_families & material_family_shader) != 0 &&
                    state.shader_pipelines.empty()) {
                    throw std::runtime_error(
                        "Post-registration shader material family has no reached pipeline.");
                }
                if (
                    (added_families & material_family_grid) != 0 &&
                    !state.grid_pipeline) {
                    throw std::runtime_error(
                        "Post-registration Grid material family has no reached pipeline.");
                }
                upstream::RenderPlan updated_plan =
                    upstream::build_render_plan(scene, engine);
                validate_render_plan_items(updated_plan);
                // Re-match the uploaded mesh entries to the updated
                // plan: both plans walk the scene list in order, so a
                // forward two-pointer pass keeps every surviving
                // entry's GPU resources, releases the ones a removal
                // dropped, and uploads newly added items.
                std::vector<GpuMesh> updated_meshes;
                updated_meshes.reserve(updated_plan.items.size());
                const auto same_source = [](
                                             const upstream::RenderItem& left,
                                             const upstream::RenderItem& right) {
                    return left.mesh.value == right.mesh.value &&
                        left.geometry == right.geometry &&
                        left.material.value == right.material.value;
                };
                std::size_t previous_index = 0;
                for (
                    const upstream::RenderItem& item :
                    updated_plan.items) {
                    std::size_t scan = previous_index;
                    while (
                        scan < render_plan.items.size() &&
                        !same_source(
                            render_plan.items[scan],
                            item)) {
                        ++scan;
                    }
                    if (scan < render_plan.items.size()) {
                        for (
                            std::size_t dropped = previous_index;
                            dropped < scan;
                            ++dropped) {
                            release_gpu_mesh(
                                state,
                                state.meshes[dropped]);
                        }
                        updated_meshes.push_back(
                            state.meshes[scan]);
                        previous_index = scan + 1;
                        continue;
                    }
                    updated_meshes.push_back(
                        upload_render_item(item));
                }
                for (
                    std::size_t dropped = previous_index;
                    dropped < state.meshes.size();
                    ++dropped) {
                    release_gpu_mesh(state, state.meshes[dropped]);
                }
                state.meshes = std::move(updated_meshes);
                render_plan = std::move(updated_plan);
                rebuild_task_draw_lists();
                synced_mesh_membership_version =
                    scene.mesh_membership_version;
                synced_material_family_mask =
                    scene.material_family_mask;
                topology_updated = true;
            }
            update_camera(camera);
            upstream::sort_transparent_draws(
                render_plan.draw_lists.transparent,
                engine,
                camera);
#if BBLITE_PBR_VARIANTS > 0
            // The pin's bone palettes for every draw the gate resolves,
            // streamed here because a copy pass cannot open inside the render
            // pass. The draw branch below keys its skinned handling on the
            // texture this leaves behind.
            {
                const auto stream_palettes =
                    [&](const upstream::RenderDrawList& list) {
                    for (
                        const upstream::RenderDrawCommand& draw :
                        list.commands) {
                        if (draw.item_index >= state.meshes.size()) continue;
                        if (draw.item.mesh.value >= engine.meshes.size()) {
                            continue;
                        }
                        const std::size_t palette_variant =
                            pinned_variant_for_draw(scene, engine, draw);
                        if (
                            palette_variant ==
                                std::numeric_limits<std::size_t>::max() ||
                            !pinned_variant_skeleton(palette_variant)) {
                            continue;
                        }
                        write_pinned_bone_texture(
                            state,
                            state.meshes[draw.item_index],
                            engine.meshes[draw.item.mesh.value]);
                    }
                };
                stream_palettes(render_plan.draw_lists.opaque);
                stream_palettes(render_plan.draw_lists.transparent);
                for (const upstream::RenderDrawLists& task_lists :
                     task_draw_lists) {
                    stream_palettes(task_lists.opaque);
                    stream_palettes(task_lists.transparent);
                }
            }
#endif
            const bool capture_ready =
                frame >= screenshot_frame &&
                !topology_updated;
            const bool capture_frame =
                capture_ready &&
                !captures.screenshot_saved &&
                !screenshot_path.empty();
            const bool capture_ids =
                capture_ready &&
                !captures.id_buffer_saved &&
                !id_buffer_path.empty();
            const bool capture_clusters =
                capture_ready &&
                !captures.cluster_buffer_saved &&
                !cluster_buffer_path.empty();
            // getEffectiveAspectRatio divides two JavaScript numbers,
            // so the ratio reaches the projection writer in double.
            const double aspect =
                static_cast<double>(width) /
                static_cast<double>(height);
            const std::array<float, 16> matrix =
                upstream::build_view_projection(camera, aspect);
            const std::array<float, 16> skybox_matrix =
                upstream::build_skybox_view_projection(
                    camera,
                    aspect);
#if BBLITE_HAS_SPLATS
            // The splat stage reads the view and the projection separately,
            // because the pin's own UBO stores them separately.
            const std::array<float, 16> splat_view =
                upstream::build_view_matrix(
                    upstream::camera_world_matrix(camera));
            const std::array<float, 16> splat_projection =
                upstream::build_projection(camera, aspect);
#endif
#if BBLITE_HAS_BILLBOARDS
            // The sorted order depends on the camera alone, so it is built
            // once for the frame here -- before the frame's command buffer is
            // acquired, because the upload submits one of its own -- and the
            // draw below reads the same matrix.
            const std::array<float, 16> billboard_view =
                upstream::build_view_matrix(
                    upstream::camera_world_matrix(camera));
            for (BillboardPass& billboard : state.billboard_passes) {
                upload_billboard_pass(
                    state.device,
                    engine,
                    billboard,
                    billboard_view,
                    delta_ms);
            }
#endif
#if BBLITE_HAS_SPLATS
            // The sort runs on this thread before the draw that reads it,
            // which is the state `firstSortReady` waits for. The view and
            // projection are built once for the frame here and the draw
            // below reads the same matrices, as the billboard pass does.
            for (SplatPass& splat : state.splat_passes) {
                upload_splat_pass(
                    state.device, engine, splat, splat_view);
            }
#endif
            // The render capture describes CPU state alone, so it is
            // written as soon as the frame's plan, camera and matrix are
            // final rather than after the passes -- the values it reads
            // do not change between here and present, and writing it
            // early means a driver failure later still leaves the
            // description of the frame that failed.
            if (
                capture_ready &&
                !captures.render_capture_saved &&
                !frame_options.render_capture_path.empty()) {
                write_render_capture(
                    frame_options.render_capture_path,
                    "sdl_gpu",
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
            if (!scene.tasks.empty()) {
                create_frame_graph_textures(
                    state,
                    engine,
                    swapchain_format,
                    width,
                    height);
#if BBLITE_SHADOW_RECEIVERS
                update_shadow_generators(state, scene, engine);
#endif
                SDL_PushGPUVertexUniformData(
                    command,
                    0,
                    matrix.data(),
                    sizeof(matrix));

                const auto target_texture = [&](
                                                RenderTargetHandle handle,
                                                bool sampled) {
                    if (handle.value >= state.render_targets.size()) {
                        throw std::runtime_error(
                            "Frame graph render target handle is invalid.");
                    }
                    const RenderTargetRecord& record =
                        engine.render_targets[handle.value];
                    if (record.swapchain) return swapchain;
                    const GpuRenderTarget& target =
                        state.render_targets[handle.value];
                    if (pal::render_target_samples_depth(record)) {
                        if (sampled && record.has_depth && target.depth) {
                            return target.depth;
                        }
                        pal::fail_render_target_has_no_texture();
                    }
                    return sampled ? target.sampled_color : target.color;
                };
                /** The depth texture a reference names. */
                const auto task_depth_texture =
                    [&](const RenderTextureRef& reference)
                    -> SDL_GPUTexture* {
                    if (
                        reference.source !=
                            RenderTextureSource::geometry_depth ||
                        reference.task.value >=
                            state.geometry_tasks.size()) {
                        throw std::runtime_error(
                            "Render task depth must name a geometry task.");
                    }
                    SDL_GPUTexture* depth =
                        state.geometry_tasks[reference.task.value].depth;
                    if (!depth) {
                        throw std::runtime_error(
                            "Geometry task has no depth attachment to "
                            "share.");
                    }
                    return depth;
                };
                const auto source_texture =
                    [&](const RenderTextureRef& source) -> SDL_GPUTexture* {
                    if (source.source == RenderTextureSource::render_target) {
                        return target_texture(source.target, true);
                    }
                    if (source.task.value >= engine.frame_tasks.size()) {
                        throw std::runtime_error(
                            "Frame graph source task handle is invalid.");
                    }
                    const FrameTaskRecord& task =
                        engine.frame_tasks[source.task.value];
                    if (task.kind != FrameTaskKind::geometry) {
                        throw std::runtime_error(
                            "Frame graph source task is not geometry.");
                    }
                    if (
                        source.source ==
                        RenderTextureSource::geometry_output) {
                        return target_texture(task.geometry.target, true);
                    }
                    const auto found = std::find_if(
                        task.geometry.attachments.begin(),
                        task.geometry.attachments.end(),
                        [&](const GeometryTextureDescription& description) {
                            return description.type == source.geometry_type;
                        });
                    if (found == task.geometry.attachments.end()) {
                        throw std::runtime_error(
                            "Geometry source attachment was not requested.");
                    }
                    const std::size_t attachment_index =
                        static_cast<std::size_t>(
                            std::distance(
                                task.geometry.attachments.begin(),
                                found));
                    return state.geometry_tasks[source.task.value]
                        .sampled_colors[attachment_index];
                };
                const auto gpu_mesh_index = [&](MeshHandle handle) {
                    for (std::size_t index = 0;
                         index < render_plan.items.size();
                         ++index) {
                        if (
                            render_plan.items[index].mesh.value ==
                            handle.value) {
                            return index;
                        }
                    }
                    return state.meshes.size();
                };
                const auto draw_scene = [&](
                                          SDL_GPURenderPass* task_pass,
                                          SDL_GPUGraphicsPipeline* grid_opaque,
                                          SDL_GPUGraphicsPipeline* grid_double_sided,
                                          SDL_GPUGraphicsPipeline* grid_transparent,
                                          SDL_GPUGraphicsPipeline* grid_transparent_double_sided,
                                          const std::vector<SDL_GPUGraphicsPipeline*>& shader_variant_pipelines,
                                          const std::vector<SDL_GPUGraphicsPipeline*>& shader_variant_a2c_pipelines,
                                          const std::array<float, 16>& draw_matrix,
                                          [[maybe_unused]] const CameraRecord& draw_camera,
                                          const upstream::RenderDrawLists& draw_lists,
                                          [[maybe_unused]] const FrameTaskRecord* geometry_task,
                                          [[maybe_unused]] const PinnedGeometryParams* geometry_params,
                                          [[maybe_unused]] SDL_GPUBuffer* geometry_params_buffer,
                                          // Set when this pass renders one
                                          // generator's shadow map: the
                                          // pass block takes the light's
                                          // own matrices and every pipeline
                                          // renders standard-Z.
                                          [[maybe_unused]] const
                                              ShadowGeneratorRecord*
                                                  shadow_generator =
                                                      nullptr) {
                    bool scene_matrix_bound = true;
                    // One dispatch for both passes; only the sources
                    // differ (`secondary_pipeline_for`).
                    const SecondaryPipelines secondary{
                        grid_opaque,
                        grid_double_sided,
                        grid_transparent,
                        grid_transparent_double_sided,
                        &shader_variant_pipelines,
                        &shader_variant_a2c_pipelines,
                    };
                    const auto pipeline_for =
                        [&](
                            upstream::RenderPipelineKind kind,
                            std::uint32_t shader_variant) {
                        return secondary_pipeline_for(
                            secondary,
                            kind,
                            shader_variant,
                            "task dispatch");
                    };
#if BBLITE_PINNED_MATERIAL_VARIANTS
                    // The pass's scene and lights blocks, once per pass
                    // rather than per draw: their builders run camera and
                    // view math whose repetition was pure cost.
                    upstream::SceneUniforms pass_scene_block =
                        pinned_scene_block(
                            scene,
                            engine,
                            draw_camera,
                            draw_matrix);
#if BBLITE_SHADOW_RECEIVERS
                    // The pin installs the light-space matrices on a camera
                    // facade whose caches it pins, so its caster pass reads
                    // them straight back. There is no facade here: the pass
                    // block takes the generator's own biased view-projection
                    // and its light-space view directly.
                    if (shadow_generator) {
                        pass_scene_block.viewProjection =
                            shadow_generator->caster_view_projection;
                        pass_scene_block.view =
                            shadow_generator->caster_view;
                    }
#endif
                    // A caster pass declares no lights block in either
                    // stage -- its fragment is the no-colour view -- so
                    // building the pin's 16-entry array for it would be
                    // ~2 KB zeroed and copied per frame for nothing.
                    const std::vector<std::uint8_t> pass_lights_block =
#if BBLITE_SHADOW_RECEIVERS
                        shadow_generator
                            ? std::vector<std::uint8_t>{}
                            :
#endif
                        pinned_lights_block(scene, engine);
#endif
                    const auto draw_list =
                        [&](const upstream::RenderDrawList& list) {
                        SDL_GPUGraphicsPipeline* bound_pipeline =
                            nullptr;
                        for (
                            const upstream::RenderDrawCommand& draw :
                            list.commands) {
                            if (
                                draw.item_index >=
                                state.meshes.size()) {
                                continue;
                            }
                            const GpuMesh& mesh =
                                state.meshes[draw.item_index];
                            const upstream::RenderItem& draw_item =
                                draw.item;
                            const MaterialRecord* material =
                                draw_item.material.value <
                                        engine.materials.size()
                                    ? &engine.materials[
                                          draw_item.material.value]
                                    : nullptr;
#if BBLITE_PBR_VARIANTS > 0
                            // The task pass draws PBR through the pin's own
                            // stages exactly as the main pass does, from the
                            // task's own camera and matrix.
                            if (
                                draw_item.material_kind ==
                                upstream::RenderMaterialKind::pbr) {
                                const std::size_t task_shader =
                                    geometry_task
                                        ? static_cast<std::size_t>(
                                              geometry_task->geometry
                                                  .shader_index)
                                        : std::numeric_limits<
                                              std::size_t>::max();
                                pal::PinnedVariantKey pinned_key;
                                const std::size_t pinned_variant =
                                    pinned_variant_for_draw(
                                        scene,
                                        engine,
                                        draw,
                                        task_shader,
                                        &pinned_key);
                                if (
                                    pinned_variant ==
                                    std::numeric_limits<
                                        std::size_t>::max()) {
                                    gpu_error(
                                        ("PBR draw for mesh " +
                                         std::to_string(
                                             draw_item.mesh.value) +
                                         ", material " +
                                         std::to_string(
                                             draw_item.material.value) +
                                         " resolves no pinned variant in a "
                                         "render task: " +
                                         pal::pinned_variant_request(
                                             pinned_key,
                                             task_shader))
                                            .c_str());
                                }
                                ensure_pinned_slots(state, pinned_variant);
                                draw_pinned_variant(
                                    state,
                                    command,
                                    task_pass,
                                    scene,
                                    engine,
                                    pass_scene_block,
                                    pass_lights_block,
                                    draw,
                                    mesh,
                                    material,
                                    pinned_variant,
                                    bound_pipeline,
                                    geometry_task,
                                    geometry_params,
                                    geometry_params_buffer,
                                    shadow_generator != nullptr);
                                continue;
                            }
#endif
#if BBLITE_STANDARD_VARIANTS > 0
                            // The task pass draws Standard through the
                            // pin's own stages exactly as it draws PBR,
                            // from the task's own camera and matrix.
                            if (
                                draw_item.material_kind ==
                                upstream::RenderMaterialKind::standard) {
                                StandardVariantKey standard_key;
                                const std::size_t standard_variant =
                                    standard_variant_for_draw(
                                        scene,
                                        engine,
                                        draw,
                                        geometry_task
                                            ? static_cast<std::size_t>(
                                                  geometry_task->geometry
                                                      .shader_index)
                                            : std::numeric_limits<
                                                  std::size_t>::max(),
                                        &standard_key);
                                if (
                                    standard_variant ==
                                    std::numeric_limits<
                                        std::size_t>::max()) {
                                    gpu_error(
                                        ("Standard draw for mesh " +
                                         std::to_string(
                                             draw_item.mesh.value) +
                                         ", material " +
                                         std::to_string(
                                             draw_item.material.value) +
                                         " resolves no composed variant in "
                                         "a render task: " +
                                         standard_variant_request(
                                             engine,
                                             draw))
                                            .c_str());
                                }
                                draw_standard_variant(
                                    state,
                                    command,
                                    task_pass,
                                    scene,
                                    engine,
                                    pass_scene_block,
                                    pass_lights_block,
                                    draw,
                                    mesh,
                                    material,
                                    standard_variant,
                                    standard_key.features,
                                    bound_pipeline,
                                    geometry_task,
                                    geometry_params,
                                    material_render_textures(
                                        material,
                                        source_texture),
                                    geometry_params_buffer,
                                    shadow_generator != nullptr);
                                continue;
                            }
#else
                            if (
                                draw_item.material_kind ==
                                upstream::RenderMaterialKind::standard) {
                                gpu_error(
                                    "Standard draw in a build with no "
                                    "composed variant table; the "
                                    "transcribed fragment is retired.");
                            }
#endif
                            // A node material in a task pass has no arm
                            // here, and the secondary path below would
                            // read its graph index as a shader-variant
                            // index -- an answer, from the wrong table.
                            // The main-pass dispatcher draws the family;
                            // composing its caster view is what a node
                            // caster still needs.
                            if (
                                draw_item.material_kind ==
                                upstream::RenderMaterialKind::node) {
                                gpu_error(
                                    "Node draw in a task pass; the node "
                                    "family composes no task-pass view "
                                    "yet.");
                            }
                            SDL_GPUGraphicsPipeline* pipeline =
                                pipeline_for(draw.pipeline, draw.item.shader_variant);
                            if (!pipeline) {
                                throw std::runtime_error(
                                    "Reached secondary render pipeline was not created.");
                            }
                            if (pipeline != bound_pipeline) {
                                SDL_BindGPUGraphicsPipeline(
                                    task_pass,
                                    pipeline);
                                bound_pipeline = pipeline;
                            }
                            const bool grid_bucket =
                                draw_item.material_kind ==
                                upstream::RenderMaterialKind::grid;
                            const bool shader_bucket =
                                draw_item.material_kind ==
                                upstream::RenderMaterialKind::shader;
                            if (shader_bucket) {
                                if (!material) {
                                    throw std::runtime_error(
                                        "Shader draw has an invalid material.");
                                }
                                // Per-stage blocks from the generated
                                // variant table: [the declared system
                                // matrices][custom floats gathered from
                                // the material's flat value storage].
                                const upstream::ShaderVariantInfo&
                                    shader_info =
                                        upstream::shader_variant_info(
                                            draw_item.shader_variant);
                                const auto push_stage_block =
                                    [&](
                                        const upstream::
                                            ShaderVariantStageBlock&
                                                block,
                                        bool fragment_stage) {
                                    if (!block.present) return;
                                    const std::vector<float>
                                        block_floats =
                                            shader_stage_block_floats(
                                                block,
                                                draw_matrix.data(),
                                                *material);
                                    if (fragment_stage) {
                                        SDL_PushGPUFragmentUniformData(
                                            command,
                                            0,
                                            block_floats.data(),
                                            static_cast<Uint32>(
                                                block_floats.size() *
                                                sizeof(float)));
                                    } else {
                                        SDL_PushGPUVertexUniformData(
                                            command,
                                            0,
                                            block_floats.data(),
                                            static_cast<Uint32>(
                                                block_floats.size() *
                                                sizeof(float)));
                                    }
                                };
                                push_stage_block(
                                    shader_info.vertex,
                                    false);
                                push_stage_block(
                                    shader_info.fragment,
                                    true);
                                bind_shader_material_textures(
                                    task_pass,
                                    mesh);
                                if (shader_info.vertex.present) {
                                    // A pure scene-matrix vertex block
                                    // leaves the shared binding valid;
                                    // custom vertex floats invalidate
                                    // it for the next draw.
                                    scene_matrix_bound =
                                        block_is_shared_scene_matrix(
                                            shader_info.vertex);
                                }
                            } else {
                                if (!scene_matrix_bound) {
                                    SDL_PushGPUVertexUniformData(
                                        command,
                                        0,
                                        draw_matrix.data(),
                                        sizeof(draw_matrix));
                                    scene_matrix_bound = true;
                                }
#if BBLITE_GPU_DEFORMATION
                            if (!grid_bucket) {
                                const DeformationUniforms deformation =
                                    build_deformation_uniforms(
                                        engine.meshes[
                                            draw_item.mesh.value],
                                        engine.geometries[
                                            draw_item.geometry].flat_normals);
                                SDL_PushGPUVertexUniformData(
                                    command,
                                    1,
                                    &deformation,
                                    sizeof(deformation));
                            }
#endif
#if BBLITE_GPU_INSTANCING
                            if (!grid_bucket) {
                                const std::array<float, 16> parent_world =
                                    upstream::build_instance_parent_world(
                                        engine.meshes[
                                            draw_item.mesh.value]);
                                SDL_PushGPUVertexUniformData(
                                    command,
                                    instance_uniform_slot,
                                    parent_world.data(),
                                    sizeof(parent_world));
                            }
#endif
                            if (grid_bucket) {
                                const upstream::GridUniforms fragment =
                                    upstream::build_grid_uniforms(
                                        engine,
                                        draw_item);
                                SDL_PushGPUFragmentUniformData(
                                    command,
                                    0,
                                    &fragment,
                                    sizeof(fragment));
                            }
                            }
                            const SDL_GPUBufferBinding index_binding{
                                mesh.indices,
                                0,
                            };
                            bind_mesh_vertex_buffers(
                                task_pass,
                                mesh);
                            SDL_BindGPUIndexBuffer(
                                task_pass,
                                &index_binding,
                                SDL_GPU_INDEXELEMENTSIZE_32BIT);
                            SDL_DrawGPUIndexedPrimitives(
                                task_pass,
                                mesh.index_count,
                                mesh.instance_count,
                                0,
                                0,
                                0);
                        }
                    };
                    draw_list(draw_lists.opaque);
                    draw_list(draw_lists.transparent);
                };

                SDL_GPUTexture* capture_texture = nullptr;
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
                        GpuRenderTarget& target =
                            state.render_targets[task.render.target.value];
                        const CameraRecord& task_camera =
                            task.render.has_camera &&
                                    task.render.camera.value <
                                        engine.cameras.size()
                                ? engine.cameras[task.render.camera.value]
                                : camera;
                        const double task_aspect =
                            task.render.canvas_size
                                ? static_cast<double>(width) /
                                    static_cast<double>(height)
                                : static_cast<double>(target.width) /
                                    static_cast<double>(target.height);
                        // A shadow task renders from the light, not from
                        // a camera: the generator's own matrices replace
                        // both of these below, so building and pushing a
                        // camera view-projection first would be a dead pass
                        // over the camera basis and a dead push.
                        const bool shadow_task =
                            task.render.shadow_generator.value !=
                            invalid_handle;
                        const std::array<float, 16> task_matrix = shadow_task
                            ? std::array<float, 16>{}
                            : upstream::build_view_projection(
                                task_camera,
                                task_aspect);
                        if (!shadow_task) {
                            SDL_PushGPUVertexUniformData(
                                command,
                                0,
                                task_matrix.data(),
                                sizeof(task_matrix));
                        }
#if BBLITE_SHADOW_RECEIVERS
                        if (
                            task.render.shadow_generator.value <
                                engine.shadow_generators.size()) {
                            if (!target_record.has_depth || !target.depth) {
                                throw std::runtime_error(
                                    "Shadow render task has no depth attachment.");
                            }
                            const ShadowGeneratorRecord& generator =
                                engine.shadow_generators[
                                    task.render.shadow_generator.value];
                            SDL_GPUDepthStencilTargetInfo shadow_depth{};
                            shadow_depth.texture = target.depth;
                            // The pin's own shadow target clears to ITS
                            // far value, which standard-Z puts at 1 where
                            // this port's reverse-Z puts it at 0.
                            shadow_depth.clear_depth =
                                pass_depth_clear(true);
                            shadow_depth.load_op = SDL_GPU_LOADOP_CLEAR;
                            shadow_depth.store_op = SDL_GPU_STOREOP_STORE;
                            shadow_depth.stencil_load_op =
                                SDL_GPU_LOADOP_DONT_CARE;
                            shadow_depth.stencil_store_op =
                                SDL_GPU_STOREOP_DONT_CARE;
                            // An ESM caster pass STORES a colour: the
                            // exponential depth its material view writes.
                            // A PCF one has no colour attachment at all,
                            // which is the difference between the two
                            // pinned targets.
                            SDL_GPUColorTargetInfo shadow_color{};
                            if (target_record.has_color) {
                                if (!target.color) {
                                    throw std::runtime_error(
                                        "ESM shadow task has no colour "
                                        "attachment.");
                                }
                                shadow_color.texture = target.color;
                                shadow_color.load_op = SDL_GPU_LOADOP_CLEAR;
                                shadow_color.store_op =
                                    SDL_GPU_STOREOP_STORE;
                                // `createRenderTask({clrColor:{0,0,0,0}})`.
                                shadow_color.clear_color =
                                    SDL_FColor{0.0f, 0.0f, 0.0f, 0.0f};
                            }
                            SDL_GPURenderPass* shadow_pass =
                                SDL_BeginGPURenderPass(
                                    command,
                                    target_record.has_color
                                        ? &shadow_color
                                        : nullptr,
                                    target_record.has_color ? 1u : 0u,
                                    &shadow_depth);
                            SDL_PushGPUVertexUniformData(
                                command,
                                0,
                                generator.caster_view_projection.data(),
                                sizeof(generator.caster_view_projection));
                            draw_scene(
                                shadow_pass,
                                nullptr,
                                nullptr,
                                nullptr,
                                nullptr,
                                {},
                                {},
                                generator.caster_view_projection,
                                task_camera,
                                task_draw_lists[handle.value],
                                nullptr,
                                nullptr,
                                nullptr,
                                &generator);
                            SDL_EndGPURenderPass(shadow_pass);
#if BBLITE_SHADOWS_ESM
                            // `renderEsmShadowMap` blurs the map it just
                            // drew, in two passes, before anything samples
                            // it.
                            if (
                                generator.filter ==
                                ShadowFilter::esm_directional) {
                                run_esm_blur(
                                    state,
                                    command,
                                    generator.esm_index);
                            }
#endif
                            continue;
                        }
#endif
                        if (!target_record.has_color) {
                            if (!target_record.has_depth || !target.depth) {
                                throw std::runtime_error(
                                    "Depth-only render task has no depth attachment.");
                            }
                            if (task.render_meshes.empty()) {
                                throw std::runtime_error(
                                    "Depth-only render task requires explicit meshes.");
                            }
                            SDL_GPUDepthStencilTargetInfo task_depth{};
                            task_depth.texture = target.depth;
                            task_depth.clear_depth =
                                upstream::pinned_depth_clear;
                            task_depth.load_op = SDL_GPU_LOADOP_CLEAR;
                            task_depth.store_op =
                                target_record.sampled_depth
                                    ? SDL_GPU_STOREOP_STORE
                                    : SDL_GPU_STOREOP_DONT_CARE;
                            task_depth.stencil_load_op =
                                SDL_GPU_LOADOP_DONT_CARE;
                            task_depth.stencil_store_op =
                                SDL_GPU_STOREOP_DONT_CARE;
                            SDL_GPURenderPass* task_pass =
                                SDL_BeginGPURenderPass(
                                    command,
                                    nullptr,
                                    0,
                                    &task_depth);
                            const std::size_t pipeline_index =
                                target_record.samples == 4 ? 1u : 0u;
                            for (int sided_mode = 0;
                                 sided_mode < 2;
                                 ++sided_mode) {
                                SDL_BindGPUGraphicsPipeline(
                                    task_pass,
                                    sided_mode == 0
                                        ? state.depth_only_pipelines[
                                              pipeline_index]
                                        : state
                                              .depth_only_double_sided_pipelines[
                                                  pipeline_index]);
                                for (
                                    const RenderTaskMesh& entry :
                                    task.render_meshes) {
                                    if (
                                        entry.material.value >=
                                        engine.materials.size()) {
                                        throw std::runtime_error(
                                            "Depth task material override is invalid.");
                                    }
                                    const MaterialRecord& material =
                                        engine.materials[
                                            entry.material.value];
                                    if (!material.no_color) {
                                        throw std::runtime_error(
                                            "Depth-only render task requires a no-color material view.");
                                    }
                                    if (
                                        material.double_sided !=
                                        (sided_mode == 1)) {
                                        continue;
                                    }
                                    const std::size_t mesh_index =
                                        gpu_mesh_index(entry.mesh);
                                    if (
                                        mesh_index >=
                                        state.meshes.size()) {
                                        throw std::runtime_error(
                                            "Depth task mesh is not in the scene.");
                                    }
                                    const GpuMesh& mesh =
                                        state.meshes[mesh_index];
                                    const SDL_GPUBufferBinding index_binding{
                                        mesh.indices,
                                        0,
                                    };
                                    bind_mesh_vertex_buffers(
                                        task_pass,
                                        mesh);
                                    SDL_BindGPUIndexBuffer(
                                        task_pass,
                                        &index_binding,
                                        SDL_GPU_INDEXELEMENTSIZE_32BIT);
                                    SDL_DrawGPUIndexedPrimitives(
                                        task_pass,
                                        mesh.index_count,
                                        mesh.instance_count,
                                        0,
                                        0,
                                        0);
                                }
                            }
                            SDL_EndGPURenderPass(task_pass);
                            continue;
                        }
                        SDL_GPUColorTargetInfo target_info{};
                        target_info.texture =
                            target_record.swapchain
                                ? swapchain
                                : target.color;
                        target_info.clear_color = SDL_FColor{
                            task.render.clear_color.r,
                            task.render.clear_color.g,
                            task.render.clear_color.b,
                            task.render.clear_color.a,
                        };
                        target_info.load_op =
                            task.render.clear
                                ? SDL_GPU_LOADOP_CLEAR
                                : SDL_GPU_LOADOP_LOAD;
                        target_info.store_op = SDL_GPU_STOREOP_STORE;
                        // The pin resolves into `rst` at end-of-pass, and
                        // ignores it outright when the task's own target is
                        // single-sample. That is the count the target was
                        // *allocated* at, not the one it asked for: a run
                        // forced to one sample resolves nothing.
                        if (
                            task.render.resolve_target.value !=
                                invalid_handle &&
                            task_sample_count(state, target_record.samples) !=
                                SDL_GPU_SAMPLECOUNT_1) {
                            target_info.store_op =
                                SDL_GPU_STOREOP_RESOLVE_AND_STORE;
                            target_info.resolve_texture = target_texture(
                                task.render.resolve_target,
                                false);
                        }
                        SDL_GPUDepthStencilTargetInfo task_depth{};
                        SDL_GPUDepthStencilTargetInfo* task_depth_pointer =
                            nullptr;
                        // The pin's external-depth arm: a task handed another
                        // task's depth binds that texture and LOADS it,
                        // because a geometry output is eager and its owner
                        // already cleared and wrote it.
                        if (
                            task.render.depth.source ==
                            RenderTextureSource::geometry_depth) {
                            task_depth.texture =
                                task_depth_texture(task.render.depth);
                            task_depth.load_op = SDL_GPU_LOADOP_LOAD;
                            task_depth.store_op = SDL_GPU_STOREOP_STORE;
                            task_depth.stencil_load_op =
                                SDL_GPU_LOADOP_LOAD;
                            task_depth.stencil_store_op =
                                SDL_GPU_STOREOP_STORE;
                            task_depth_pointer = &task_depth;
                        } else if (target_record.has_depth && target.depth) {
                            task_depth.texture = target.depth;
                            task_depth.clear_depth =
                                upstream::pinned_depth_clear;
                            task_depth.load_op = SDL_GPU_LOADOP_CLEAR;
                            task_depth.store_op =
                                target_record.sampled_depth
                                    ? SDL_GPU_STOREOP_STORE
                                    : SDL_GPU_STOREOP_DONT_CARE;
                            task_depth.stencil_load_op =
                                SDL_GPU_LOADOP_DONT_CARE;
                            task_depth.stencil_store_op =
                                SDL_GPU_STOREOP_DONT_CARE;
                            task_depth_pointer = &task_depth;
                        }
                        SDL_GPURenderPass* task_pass =
                            SDL_BeginGPURenderPass(
                                command,
                                &target_info,
                                1,
                                task_depth_pointer);
                        upstream::sort_transparent_draws(
                            task_draw_lists[handle.value].transparent,
                            engine,
                            task_camera);
                        draw_scene(
                            task_pass,
                            state.grid_pipeline,
                            state.grid_double_sided_pipeline,
                            state.grid_transparent_pipeline,
                            state
                                .grid_transparent_double_sided_pipeline,
                            state.shader_pipelines,
                            state.shader_a2c_pipelines,
                            task_matrix,
                            task_camera,
                            task_draw_lists[handle.value],
                            nullptr,
                            nullptr,
                            nullptr);
                        SDL_EndGPURenderPass(task_pass);
                        continue;
                    }
                    if (task.kind == FrameTaskKind::geometry) {
                        GpuGeometryTask& geometry =
                            state.geometry_tasks[handle.value];
                        const SDL_GPUSampleCount task_samples =
                            task_sample_count(
                                state,
                                task.geometry.samples);
                        std::vector<SDL_GPUColorTargetInfo> target_infos;
                        target_infos.reserve(
                            task.geometry.attachments.size() +
                            (task.geometry.target.value != invalid_handle
                                 ? 1u
                                 : 0u));
                        for (
                            std::size_t index = 0;
                            index < task.geometry.attachments.size();
                            ++index) {
                            SDL_GPUColorTargetInfo target_info{};
                            target_info.texture = geometry.colors[index];
                            target_info.clear_color =
                                geometry_clear_color(
                                    task.geometry.attachments[index].type);
                            target_info.load_op = SDL_GPU_LOADOP_CLEAR;
                            target_info.store_op =
                                task_samples == SDL_GPU_SAMPLECOUNT_1
                                    ? SDL_GPU_STOREOP_STORE
                                    : SDL_GPU_STOREOP_RESOLVE;
                            target_info.resolve_texture =
                                task_samples == SDL_GPU_SAMPLECOUNT_1
                                    ? nullptr
                                    : geometry.sampled_colors[index];
                            target_infos.push_back(target_info);
                        }
                        if (
                            task.geometry.target.value != invalid_handle) {
                            GpuRenderTarget& output_target =
                                state.render_targets[
                                    task.geometry.target.value];
                            SDL_GPUColorTargetInfo target_info{};
                            target_info.texture = output_target.color;
                            target_info.clear_color = SDL_FColor{
                                task.geometry.target_clear_color.r,
                                task.geometry.target_clear_color.g,
                                task.geometry.target_clear_color.b,
                                task.geometry.target_clear_color.a,
                            };
                            target_info.load_op =
                                task.geometry.clear_target
                                    ? SDL_GPU_LOADOP_CLEAR
                                    : SDL_GPU_LOADOP_LOAD;
                            target_info.store_op =
                                task_samples == SDL_GPU_SAMPLECOUNT_1
                                    ? SDL_GPU_STOREOP_STORE
                                    : SDL_GPU_STOREOP_RESOLVE;
                            target_info.resolve_texture =
                                task_samples == SDL_GPU_SAMPLECOUNT_1
                                    ? nullptr
                                    : output_target.sampled_color;
                            target_infos.push_back(target_info);
                        }
                        SDL_GPUDepthStencilTargetInfo task_depth{};
                        // The pin's gpUniforms for the task's MRT variants:
                        // last frame's view-projection (seeded with the
                        // current one on the first frame) and the camera's
                        // near/far planes.
                        if (!geometry.has_previous_view_projection) {
                            geometry.previous_view_projection =
                                matrix;
                            geometry.has_previous_view_projection = true;
                        }
                        const PinnedGeometryParams geometry_params{
                            geometry.previous_view_projection,
                            {
                                static_cast<float>(camera.near_plane),
                                static_cast<float>(camera.far_plane),
                                0.0f,
                                0.0f,
                            },
                        };
#if BBLITE_PINNED_MATERIALS
                        // The same block as a real buffer, for a composed
                        // geometry fragment whose gp the shader compile
                        // demoted out of SDL_GPU's four uniform slots --
                        // which happens to either family once scene, lights,
                        // mesh and material fill them. The upload runs on its
                        // own command buffer, submitted (and so executed)
                        // ahead of this frame's, and cycles the buffer so a
                        // frame still in flight keeps last frame's contents.
                        {
                            if (!geometry.params) {
                                geometry.params = upload_buffer(
                                    state.device,
                                    SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ,
                                    &geometry_params,
                                    sizeof(geometry_params));
                            } else {
                                update_buffer(
                                    state.device,
                                    geometry.params,
                                    &geometry_params,
                                    sizeof(geometry_params));
                            }
                        }
#endif
                        task_depth.texture = geometry.depth;
                        task_depth.clear_depth = upstream::pinned_depth_clear;
                        task_depth.load_op = SDL_GPU_LOADOP_CLEAR;
                        task_depth.store_op = geometry.depth_borrowed
                            ? SDL_GPU_STOREOP_STORE
                            : SDL_GPU_STOREOP_DONT_CARE;
                        task_depth.stencil_load_op =
                            SDL_GPU_LOADOP_DONT_CARE;
                        task_depth.stencil_store_op =
                            SDL_GPU_STOREOP_DONT_CARE;
                        SDL_GPURenderPass* task_pass =
                            SDL_BeginGPURenderPass(
                                command,
                                target_infos.data(),
                                static_cast<Uint32>(target_infos.size()),
                                &task_depth);
                        SDL_PushGPUVertexUniformData(
                            command,
                            0,
                            matrix.data(),
                            sizeof(matrix));
                        upstream::sort_transparent_draws(
                            task_draw_lists[handle.value].transparent,
                            engine,
                            camera);
                        draw_scene(
                            task_pass,
                            nullptr,
                            nullptr,
                            nullptr,
                            nullptr,
                            {},
                            {},
                            matrix,
                            camera,
                            task_draw_lists[handle.value],
                            &task,
                            &geometry_params,
                            geometry.params);
                        geometry.previous_view_projection =
                            matrix;
                        SDL_EndGPURenderPass(task_pass);
                        continue;
                    }

#if defined(BBLITE_HAS_EFFECT_TASK) && BBLITE_HAS_EFFECT_TASK
                    if (task.kind == FrameTaskKind::effect) {
                        // The same two halves the swapchain renderer draws
                        // through, recorded into the frame graph's command
                        // buffer instead: the pin ships two entry points
                        // over one pass, not two passes.
                        if (
                            state.effect_tasks.size() <
                            engine.frame_tasks.size()) {
                            state.effect_tasks.resize(
                                engine.frame_tasks.size());
                        }
                        EffectPass& pass = state.effect_tasks[handle.value];
                        const RenderTargetRecord& target_record =
                            engine.render_targets[task.effect.target.value];
                        if (!pass.pipeline) {
                            pass = create_effect_pass(
                                state.device,
                                engine,
                                task.effect.effect,
                                target_record.swapchain
                                    ? swapchain_format
                                    : state
                                          .render_targets[
                                              task.effect.target.value]
                                          .color_format,
                                // Through the MSAA gate like every other
                                // task pipeline, so a single-sample run
                                // matches the 1-sample texture the gate
                                // allocated (Dawn's site reads the same
                                // gate).
                                target_record.swapchain
                                    ? 1u
                                    : gpu_sample_count_value(
                                          task_sample_count(
                                              state,
                                              target_record.samples)));
                        }
                        SDL_GPUColorTargetInfo effect_target{};
                        effect_target.texture =
                            target_texture(task.effect.target, false);
                        effect_target.load_op = task.effect.clear
                            ? SDL_GPU_LOADOP_CLEAR
                            : SDL_GPU_LOADOP_LOAD;
                        effect_target.clear_color = SDL_FColor{
                            task.effect.clear_color.r,
                            task.effect.clear_color.g,
                            task.effect.clear_color.b,
                            task.effect.clear_color.a};
                        effect_target.store_op = SDL_GPU_STOREOP_STORE;
                        SDL_GPURenderPass* effect_pass =
                            SDL_BeginGPURenderPass(
                                command,
                                &effect_target,
                                1,
                                nullptr);
                        record_effect_pass(
                            command,
                            effect_pass,
                            engine,
                            pass,
                            task.effect.effect);
                        SDL_EndGPURenderPass(effect_pass);
                        continue;
                    }
#endif
#if defined(BBLITE_HAS_POST_PROCESS) && BBLITE_HAS_POST_PROCESS
                    if (task.kind == FrameTaskKind::post_process) {
                        // A composite records the chain its own factory
                        // built; a plain effect is the same loop over one.
                        for (
                            std::size_t index = 0;
                            index < task.post_process.passes.size();
                            ++index) {
                            record_post_process_pass(
                                state,
                                engine,
                                handle,
                                command,
                                swapchain,
                                swapchain_format,
                                width,
                                height,
                                index,
                                capture_texture,
                                source_texture,
                                target_texture);
                        }
                        continue;
                    }
#endif
                    const CopyTaskOptions& copy = task.copy;
                    const bool filtered_copy =
                        copy.has_viewport &&
                        copy.name.find("-impostor-") !=
                            std::string::npos;
                    if (
                        !copy_task_filter.empty() &&
                        filtered_copy &&
                        copy.name != copy_task_filter) {
                        continue;
                    }
                    const bool force_full_viewport =
                        !copy_task_filter.empty() &&
                        copy.name == copy_task_filter;
                    if (
                        copy.resolve_target.value != invalid_handle &&
                        copy.target.value == invalid_handle) {
                        if (
                            copy.source.source !=
                            RenderTextureSource::render_target) {
                            throw std::runtime_error(
                                "Resolve source must be a render target.");
                        }
                        if (state.sample_count ==
                            SDL_GPU_SAMPLECOUNT_1) {
                            // Nothing to average: the pinned resolve of a
                            // single-sample source is the source, so the
                            // frame graph's resolve step is a texture copy
                            // — the same degradation `pal_dawn.cpp` makes.
                            // Asking for STOREOP_RESOLVE here instead
                            // builds a command list D3D12 refuses to
                            // close, which is why every geometry-output
                            // scene failed under BBLITE_MSAA=1.
                            const GpuRenderTarget& resolve_source =
                                state.render_targets[
                                    copy.source.target.value];
                            SDL_GPUTextureLocation copy_source{};
                            copy_source.texture = target_texture(
                                copy.source.target,
                                false);
                            SDL_GPUTextureLocation copy_destination{};
                            copy_destination.texture = target_texture(
                                copy.resolve_target,
                                false);
                            SDL_GPUCopyPass* resolve_copy =
                                SDL_BeginGPUCopyPass(command);
                            SDL_CopyGPUTextureToTexture(
                                resolve_copy,
                                &copy_source,
                                &copy_destination,
                                resolve_source.width,
                                resolve_source.height,
                                1,
                                false);
                            SDL_EndGPUCopyPass(resolve_copy);
                            continue;
                        }
                        SDL_GPUColorTargetInfo resolve_info{};
                        resolve_info.texture =
                            target_texture(copy.source.target, false);
                        resolve_info.load_op = SDL_GPU_LOADOP_LOAD;
                        resolve_info.store_op = SDL_GPU_STOREOP_RESOLVE;
                        resolve_info.resolve_texture =
                            target_texture(copy.resolve_target, false);
                        SDL_GPURenderPass* resolve_pass =
                            SDL_BeginGPURenderPass(
                                command,
                                &resolve_info,
                                1,
                                nullptr);
                        SDL_EndGPURenderPass(resolve_pass);
                        continue;
                    }

                    const RenderTargetRecord& target_record =
                        engine.render_targets[copy.target.value];
                    SDL_GPUColorTargetInfo blit_target{};
                    blit_target.texture =
                        target_texture(copy.target, false);
                    blit_target.load_op =
                        copy.has_viewport && !force_full_viewport
                            ? SDL_GPU_LOADOP_LOAD
                            : SDL_GPU_LOADOP_DONT_CARE;
                    blit_target.store_op = SDL_GPU_STOREOP_STORE;
                    SDL_GPURenderPass* blit_pass =
                        SDL_BeginGPURenderPass(
                            command,
                            &blit_target,
                            1,
                            nullptr);
                    SDL_BindGPUGraphicsPipeline(
                        blit_pass,
                        target_record.samples == 4
                            ? state.blit_msaa_pipeline
                            : state.blit_pipeline);
                    if (force_full_viewport || copy.has_viewport) {
#if defined(BBLITE_HAS_GEOMETRY_OUTPUT) && BBLITE_HAS_GEOMETRY_OUTPUT
                        const GpuRenderTarget& target =
                            state.render_targets[copy.target.value];
                        const NormalizedViewport normalized_viewport =
                            force_full_viewport
                                ? NormalizedViewport{}
                                : copy.viewport;
                        const PixelViewport pixel_viewport =
                            upstream::resolve_copy_viewport(
                                normalized_viewport,
                                target.width,
                                target.height);
                        const SDL_GPUViewport gpu_viewport{
                            static_cast<float>(pixel_viewport.x),
                            static_cast<float>(pixel_viewport.y),
                            static_cast<float>(pixel_viewport.width),
                            static_cast<float>(pixel_viewport.height),
                            0.0f,
                            1.0f,
                        };
                        SDL_SetGPUViewport(
                            blit_pass,
                            &gpu_viewport);
                        const SDL_Rect scissor{
                            pixel_viewport.x,
                            pixel_viewport.y,
                            pixel_viewport.width,
                            pixel_viewport.height,
                        };
                        SDL_SetGPUScissor(blit_pass, &scissor);
#else
                        throw std::runtime_error(
                            "Viewport copy requires geometry-output support.");
#endif
                    }
                    const SDL_GPUTextureSamplerBinding texture_binding{
                        source_texture(copy.source),
                        state.background_sampler,
                    };
                    SDL_BindGPUFragmentSamplers(
                        blit_pass,
                        0,
                        &texture_binding,
                        1);
                    SDL_DrawGPUPrimitives(blit_pass, 3, 1, 0, 0);
                    SDL_EndGPURenderPass(blit_pass);
                    if (target_record.swapchain) {
                        capture_texture = source_texture(copy.source);
                    }
                }
                if (capture_frame) {
                    if (!capture_texture) {
                        throw std::runtime_error(
                            "Frame graph did not present a capture source.");
                    }
                    save_texture_png(
                        state.device,
                        command,
                        capture_texture,
                        swapchain_format,
                        width,
                        height,
                        screenshot_path);
                    captures.screenshot_saved = true;
                } else if (!SDL_SubmitGPUCommandBuffer(command)) {
                    gpu_error("SDL_SubmitGPUCommandBuffer frame graph");
                }
            } else {
            if (capture_frame || transmission_enabled) {
                create_color(
                    state,
                    transmission_enabled
                        ? SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT
                        : swapchain_format,
                    width,
                    height);
            }
            if (transmission_enabled) {
                create_transmission_color(state);
                create_processed_color(
                    state,
                    swapchain_format,
                    width,
                    height);
            }
            create_msaa_color(
                state,
                transmission_enabled
                    ? SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT
                    : swapchain_format,
                width,
                height);
            create_depth(state, width, height);
            SDL_PushGPUVertexUniformData(command, 0, matrix.data(), sizeof(matrix));

            SDL_GPUColorTargetInfo color_info{};
            const bool multisampled =
                state.sample_count != SDL_GPU_SAMPLECOUNT_1;
            color_info.texture =
                multisampled
                    ? state.msaa_color
                    : capture_frame || transmission_enabled
                        ? state.color
                        : swapchain;
            // The pin's inverse runs in f64 and WebGPU's clear value stays
            // double; SDL_FColor is the one store that narrows, so the cast
            // sits at the store exactly like the pin's own f32 boundaries.
            color_info.clear_color = transmission_enabled
                ? SDL_FColor{
                      static_cast<float>(
                          upstream::inverse_image_processed_channel(
                              scene.clear_color.r,
                              scene.environment.exposure,
                              scene.environment.contrast,
                              scene.environment.tone_mapping_enabled)),
                      static_cast<float>(
                          upstream::inverse_image_processed_channel(
                              scene.clear_color.g,
                              scene.environment.exposure,
                              scene.environment.contrast,
                              scene.environment.tone_mapping_enabled)),
                      static_cast<float>(
                          upstream::inverse_image_processed_channel(
                              scene.clear_color.b,
                              scene.environment.exposure,
                              scene.environment.contrast,
                              scene.environment.tone_mapping_enabled)),
                      scene.clear_color.a}
                : SDL_FColor{
                      scene.clear_color.r,
                      scene.clear_color.g,
                      scene.clear_color.b,
                      scene.clear_color.a};
            color_info.load_op = SDL_GPU_LOADOP_CLEAR;
            // Resolve opaque color for transmission sampling while preserving
            // the multisample attachment so transmissive draws can resume it.
            color_info.store_op =
                multisampled
                    ? transmission_enabled
                        ? SDL_GPU_STOREOP_RESOLVE_AND_STORE
                        : SDL_GPU_STOREOP_RESOLVE
                    : SDL_GPU_STOREOP_STORE;
            color_info.resolve_texture =
                multisampled
                    ? capture_frame || transmission_enabled
                        ? state.color
                        : swapchain
                    : nullptr;
            SDL_GPUDepthStencilTargetInfo depth_info{};
            depth_info.texture = state.depth;
            depth_info.clear_depth = upstream::pinned_depth_clear;
            depth_info.load_op = SDL_GPU_LOADOP_CLEAR;
            depth_info.store_op = SDL_GPU_STOREOP_DONT_CARE;
            if (transmission_enabled) {
                depth_info.store_op = SDL_GPU_STOREOP_STORE;
            }
            depth_info.stencil_load_op = SDL_GPU_LOADOP_DONT_CARE;
            depth_info.stencil_store_op = SDL_GPU_STOREOP_DONT_CARE;
            SDL_GPURenderPass* pass =
                SDL_BeginGPURenderPass(command, &color_info, 1, &depth_info);
            bool scene_matrix_bound = true;
            // The pin's transmission grab fires once, before the first
            // transmissive draw: the opaque scene colour resolved so far is
            // blitted into the 1024x1024 mip-chained refraction texture the
            // composed fragments sample.
            bool transmission_copied = false;
#if BBLITE_GPU_INSTANCING
            const std::array<float, 16> identity_parent_world{
                1.0f, 0.0f, 0.0f, 0.0f,
                0.0f, 1.0f, 0.0f, 0.0f,
                0.0f, 0.0f, 1.0f, 0.0f,
                0.0f, 0.0f, 0.0f, 1.0f,
            };
#endif
            const auto draw_skybox = [&] {
                if (!state.skybox.enabled) return;
                const upstream::SkyboxUniforms skybox =
                    upstream::build_skybox_uniforms(
                        scene.environment,
                        transmission_enabled);
                SDL_PushGPUVertexUniformData(
                    command,
                    0,
                    scene.environment.skybox_uses_environment
                        ? skybox_matrix.data()
                        : matrix.data(),
                    sizeof(matrix));
#if BBLITE_GPU_DEFORMATION
                // Background geometry carries zeroed joint weights; without
                // a fresh identity deformation block the previous mesh
                // draw's skinning uniforms would collapse the quad.
                const DeformationUniforms skybox_deformation =
                    build_deformation_uniforms(MeshRecord{}, false);
                SDL_PushGPUVertexUniformData(
                    command,
                    1,
                    &skybox_deformation,
                    sizeof(skybox_deformation));
#endif
                SDL_BindGPUGraphicsPipeline(pass, state.skybox_pipeline);
                SDL_PushGPUFragmentUniformData(command, 0, &skybox, sizeof(skybox));
                const SDL_GPUBufferBinding index_binding{state.skybox.indices, 0};
                const SDL_GPUTextureSamplerBinding texture_binding{
                    state.skybox.texture,
                    state.background_sampler,
                };
#if BBLITE_GPU_INSTANCING
                const std::array<SDL_GPUBufferBinding, 2>
                    skybox_vertex_bindings{
                        SDL_GPUBufferBinding{
                            state.skybox.vertices,
                            0,
                        },
                        SDL_GPUBufferBinding{
                            state.background_instances,
                            0,
                        },
                    };
                SDL_BindGPUVertexBuffers(
                    pass,
                    0,
                    skybox_vertex_bindings.data(),
                    static_cast<Uint32>(
                        skybox_vertex_bindings.size()));
                SDL_PushGPUVertexUniformData(
                    command,
                    instance_uniform_slot,
                    identity_parent_world.data(),
                    sizeof(identity_parent_world));
#else
                const SDL_GPUBufferBinding vertex_binding{state.skybox.vertices, 0};
                SDL_BindGPUVertexBuffers(pass, 0, &vertex_binding, 1);
#endif
#if BBLITE_GPU_MORPH_STORAGE
                const std::array<SDL_GPUBuffer*, 2> morph_storage{
                    state.empty_morph_deltas,
                    state.empty_morph_weights,
                };
                SDL_BindGPUVertexStorageBuffers(
                    pass,
                    0,
                    morph_storage.data(),
                    static_cast<Uint32>(morph_storage.size()));
#endif
                SDL_BindGPUIndexBuffer(
                    pass,
                    &index_binding,
                    SDL_GPU_INDEXELEMENTSIZE_32BIT);
                SDL_BindGPUFragmentSamplers(pass, 0, &texture_binding, 1);
                SDL_DrawGPUIndexedPrimitives(pass, 36, 1, 0, 0, 0);
                scene_matrix_bound = false;
            };
#if BBLITE_SOLID_SKYBOX
            const auto draw_solid_skybox = [&] {
                if (!state.solid_skybox.enabled) return;
                // The pinned vertex stage reads its own scene block --
                // scene.viewProjection, scene.view and scene.vEyePosition,
                // the last of which it offsets the cube by -- so the draw
                // binds that layout over the frame's matrix.
                const upstream::SolidSkyboxSceneUniforms
                    solid_skybox_scene =
                        upstream::build_solid_skybox_scene_uniforms(
                            camera,
                            matrix);
                const upstream::SolidSkyboxUniforms solid_skybox_mesh =
                    upstream::build_solid_skybox_uniforms(scene);
                SDL_PushGPUVertexUniformData(
                    command,
                    0,
                    &solid_skybox_scene,
                    sizeof(solid_skybox_scene));
                SDL_PushGPUVertexUniformData(
                    command,
                    1,
                    &solid_skybox_mesh,
                    sizeof(solid_skybox_mesh));
                SDL_PushGPUFragmentUniformData(
                    command,
                    0,
                    &solid_skybox_mesh,
                    sizeof(solid_skybox_mesh));
                SDL_BindGPUGraphicsPipeline(
                    pass,
                    state.solid_skybox.pipeline);
                const SDL_GPUBufferBinding vertex_binding{
                    state.solid_skybox.vertices,
                    0,
                };
                const SDL_GPUBufferBinding index_binding{
                    state.solid_skybox.indices,
                    0,
                };
                SDL_BindGPUVertexBuffers(
                    pass,
                    0,
                    &vertex_binding,
                    1);
                SDL_BindGPUIndexBuffer(
                    pass,
                    &index_binding,
                    SDL_GPU_INDEXELEMENTSIZE_32BIT);
                SDL_DrawGPUIndexedPrimitives(pass, 36, 1, 0, 0, 0);
                scene_matrix_bound = false;
            };
#endif
#if BBLITE_IMAGE_SKYBOX
            const auto draw_image_skybox = [&] {
                if (!state.image_skybox.enabled) return;
                SDL_PushGPUVertexUniformData(
                    command,
                    0,
                    matrix.data(),
                    sizeof(matrix));
                const upstream::ImageSkyboxUniforms
                    image_skybox_uniforms =
                        upstream::build_image_skybox_uniforms(
                            scene,
                            camera);
                SDL_BindGPUGraphicsPipeline(
                    pass,
                    state.image_skybox.pipeline);
                SDL_PushGPUFragmentUniformData(
                    command,
                    0,
                    &image_skybox_uniforms,
                    sizeof(image_skybox_uniforms));
                const SDL_GPUBufferBinding vertex_binding{
                    state.image_skybox.vertices,
                    0,
                };
                const SDL_GPUBufferBinding index_binding{
                    state.image_skybox.indices,
                    0,
                };
                const SDL_GPUTextureSamplerBinding
                    texture_binding{
                        state.image_skybox.texture,
                        state.background_sampler,
                    };
                SDL_BindGPUVertexBuffers(
                    pass,
                    0,
                    &vertex_binding,
                    1);
                SDL_BindGPUIndexBuffer(
                    pass,
                    &index_binding,
                    SDL_GPU_INDEXELEMENTSIZE_32BIT);
                SDL_BindGPUFragmentSamplers(
                    pass,
                    0,
                    &texture_binding,
                    1);
                SDL_DrawGPUIndexedPrimitives(
                    pass,
                    36,
                    1,
                    0,
                    0,
                    0);
                scene_matrix_bound = true;
            };
#endif
            const auto pipeline_for =
                [&](
                    upstream::RenderPipelineKind kind,
                    std::uint32_t shader_variant) {
                return secondary_pipeline_for(
                    SecondaryPipelines{
                        state.grid_pipeline,
                        state.grid_double_sided_pipeline,
                        state.grid_transparent_pipeline,
                        state.grid_transparent_double_sided_pipeline,
                        &state.shader_pipelines,
                        &state.shader_a2c_pipelines,
                    },
                    kind,
                    shader_variant,
                    "main dispatch");
            };
#if BBLITE_PINNED_MATERIALS
            // The frame's scene and lights blocks, once per frame rather
            // than per draw — the same hoist the Dawn backend's
            // write_pinned_frame_blocks already makes.
            const upstream::SceneUniforms pass_scene_block =
                pinned_scene_block(scene, engine, camera, matrix);
            const std::vector<std::uint8_t> pass_lights_block =
                pinned_lights_block(scene, engine);
#endif
            const auto draw_render_list =
                [&](const upstream::RenderDrawList& list) {
                SDL_GPUGraphicsPipeline* bound_pipeline = nullptr;
                for (
                    const upstream::RenderDrawCommand& draw :
                    list.commands) {
                    if (
                        draw.item_index >=
                        state.meshes.size()) {
                        continue;
                    }
                    const upstream::RenderItem& item = draw.item;
                    const GpuMesh& mesh =
                        state.meshes[draw.item_index];
                    const MaterialRecord* material =
                        item.material.value <
                                engine.materials.size()
                            ? &engine.materials[
                                  item.material.value]
                            : nullptr;
                    if (
                        transmission_enabled &&
                        !transmission_copied &&
                        transmissive_draw_material(material)) {
                        // executePassWithTransmission: end the pass (which
                        // resolves the multisampled colour), copy it into
                        // the refraction texture with its mip chain, and
                        // resume loading what was stored.
                        SDL_EndGPURenderPass(pass);
                        SDL_GPUBlitInfo transmission_blit{};
                        transmission_blit.source = SDL_GPUBlitRegion{
                            state.color,
                            0,
                            0,
                            0,
                            0,
                            width,
                            height,
                        };
                        transmission_blit.destination = SDL_GPUBlitRegion{
                            state.transmission_color,
                            0,
                            0,
                            0,
                            0,
                            state.transmission_width,
                            state.transmission_height,
                        };
                        transmission_blit.load_op =
                            SDL_GPU_LOADOP_DONT_CARE;
                        transmission_blit.flip_mode = SDL_FLIP_NONE;
                        transmission_blit.filter = SDL_GPU_FILTER_LINEAR;
                        SDL_BlitGPUTexture(command, &transmission_blit);
                        SDL_GenerateMipmapsForGPUTexture(
                            command,
                            state.transmission_color);
                        color_info.load_op = SDL_GPU_LOADOP_LOAD;
                        color_info.store_op =
                            multisampled
                                ? SDL_GPU_STOREOP_RESOLVE
                                : SDL_GPU_STOREOP_STORE;
                        depth_info.load_op = SDL_GPU_LOADOP_LOAD;
                        pass = SDL_BeginGPURenderPass(
                            command,
                            &color_info,
                            1,
                            &depth_info);
                        bound_pipeline = nullptr;
                        transmission_copied = true;
                    }
#if BBLITE_PBR_VARIANTS > 0
                    // Babylon Lite's own composed stages own every PBR draw:
                    // the transcribed fragment is retired, so a draw the
                    // shared gate refuses is an error naming the mesh rather
                    // than a silent fallback.
                    pal::PinnedVariantKey pinned_key;
                    const std::size_t pinned_variant =
                        item.material_kind ==
                            upstream::RenderMaterialKind::pbr
                            ? pinned_variant_for_draw(
                                  scene,
                                  engine,
                                  draw,
                                  std::numeric_limits<std::size_t>::max(),
                                  &pinned_key)
                            : std::numeric_limits<std::size_t>::max();
                    if (
                        item.material_kind ==
                            upstream::RenderMaterialKind::pbr &&
                        pinned_variant ==
                            std::numeric_limits<std::size_t>::max()) {
                        gpu_error(
                            ("PBR draw for mesh " +
                             std::to_string(item.mesh.value) +
                             ", material " +
                             std::to_string(item.material.value) +
                             " resolves no pinned variant: " +
                             pal::pinned_variant_request(pinned_key))
                                .c_str());
                    }
                    if (
                        pinned_variant !=
                        std::numeric_limits<std::size_t>::max()) {
                        ensure_pinned_slots(state, pinned_variant);
                    }
                    if (
                        pinned_variant !=
                        std::numeric_limits<std::size_t>::max()) {
                        draw_pinned_variant(
                            state,
                            command,
                            pass,
                            scene,
                            engine,
                            pass_scene_block,
                            pass_lights_block,
                            draw,
                            mesh,
                            material,
                            pinned_variant,
                            bound_pipeline);
                        continue;
                    }
#else
                    if (
                        item.material_kind ==
                        upstream::RenderMaterialKind::pbr) {
                        gpu_error(
                            "PBR draw in a build with no composed variant "
                            "table; the transcribed fragment is retired.");
                    }
#endif
#if BBLITE_STANDARD_VARIANTS > 0
                    // Babylon Lite's own composed stages own every Standard
                    // draw too; a draw the gate refuses is an error naming
                    // the mesh rather than a silent fallback.
                    if (
                        item.material_kind ==
                        upstream::RenderMaterialKind::standard) {
                        // The main pass carries no frame graph, so a
                        // render-target texture on a material has nothing
                        // to resolve against — refused by name rather
                        // than trusted to never happen.
                        if (
                            material &&
                            (material->has_emissive_render_texture ||
                             material->has_diffuse_render_texture)) {
                            gpu_error(
                                "a Standard material samples a "
                                "render-target texture in the main pass, "
                                "which carries no frame graph to resolve "
                                "it.");
                        }
                        StandardVariantKey standard_key;
                        const std::size_t standard_variant =
                            standard_variant_for_draw(
                                scene,
                                engine,
                                draw,
                                std::numeric_limits<std::size_t>::max(),
                                &standard_key);
                        if (
                            standard_variant ==
                            std::numeric_limits<std::size_t>::max()) {
                            gpu_error(
                                ("Standard draw for mesh " +
                                 std::to_string(item.mesh.value) +
                                 ", material " +
                                 std::to_string(item.material.value) +
                                 " resolves no composed variant: " +
                                 standard_variant_request(engine, draw))
                                    .c_str());
                        }
                        draw_standard_variant(
                            state,
                            command,
                            pass,
                            scene,
                            engine,
                            pass_scene_block,
                            pass_lights_block,
                            draw,
                            mesh,
                            material,
                            standard_variant,
                            standard_key.features,
                            bound_pipeline);
                        continue;
                    }
#else
                    if (
                        item.material_kind ==
                        upstream::RenderMaterialKind::standard) {
                        gpu_error(
                            "Standard draw in a build with no composed "
                            "variant table; the transcribed fragment is "
                            "retired.");
                    }
#endif
#if BBLITE_NODE_VARIANTS > 0
                    // A node graph's own compiled stages, the third
                    // composed family. Its variant is the graph's index,
                    // which the plan carries on the item.
                    if (
                        item.material_kind ==
                        upstream::RenderMaterialKind::node) {
                        draw_node_variant(
                            state,
                            command,
                            pass,
                            scene,
                            engine,
                            pass_scene_block,
                            pass_lights_block,
                            draw,
                            mesh,
                            item.shader_variant,
                            bound_pipeline);
                        continue;
                    }
#else
                    if (
                        item.material_kind ==
                        upstream::RenderMaterialKind::node) {
                        gpu_error(
                            "a node material in a build with no composed "
                            "graphs.");
                    }
#endif
                    SDL_GPUGraphicsPipeline* pipeline =
                        pipeline_for(draw.pipeline, draw.item.shader_variant);
                    if (!pipeline) {
                        throw std::runtime_error(
                            "Reached render pipeline was not created.");
                    }
                    if (pipeline != bound_pipeline) {
                        SDL_BindGPUGraphicsPipeline(
                            pass,
                            pipeline);
                        bound_pipeline = pipeline;
                    }
                    if (
                        item.material_kind ==
                        upstream::RenderMaterialKind::shader) {
                        if (!material) {
                            throw std::runtime_error(
                                "Shader draw has an invalid material.");
                        }
                        // Per-stage blocks from the generated variant
                        // table: [optional scene worldViewProjection]
                        // [custom floats gathered from the material's
                        // flat value storage].
                        const upstream::ShaderVariantInfo& shader_info =
                            upstream::shader_variant_info(
                                item.shader_variant);
                        const auto push_stage_block =
                            [&](
                                const upstream::ShaderVariantStageBlock&
                                    block,
                                bool fragment_stage) {
                            if (!block.present) return;
                            const std::vector<float> block_floats =
                                shader_stage_block_floats(
                                    block,
                                    matrix.data(),
                                    *material);
                            if (fragment_stage) {
                                SDL_PushGPUFragmentUniformData(
                                    command,
                                    0,
                                    block_floats.data(),
                                    static_cast<Uint32>(
                                        block_floats.size() *
                                        sizeof(float)));
                            } else {
                                SDL_PushGPUVertexUniformData(
                                    command,
                                    0,
                                    block_floats.data(),
                                    static_cast<Uint32>(
                                        block_floats.size() *
                                        sizeof(float)));
                            }
                        };
                        push_stage_block(shader_info.vertex, false);
                        push_stage_block(shader_info.fragment, true);
                        bind_shader_material_textures(pass, mesh);
                        if (shader_info.vertex.present) {
                            scene_matrix_bound =
                                block_is_shared_scene_matrix(
                                    shader_info.vertex);
                        }
                    } else {
                        if (!scene_matrix_bound) {
                            SDL_PushGPUVertexUniformData(
                                command,
                                0,
                                matrix.data(),
                                sizeof(matrix));
                            scene_matrix_bound = true;
                        }
#if BBLITE_GPU_DEFORMATION
                        if (
                            item.material_kind !=
                            upstream::RenderMaterialKind::grid) {
                            const DeformationUniforms deformation =
                                build_deformation_uniforms(
                                    engine.meshes[
                                        item.mesh.value],
                                    engine.geometries[
                                        item.geometry].flat_normals);
                            dump_deformation_uniforms(
                                item.mesh.value,
                                deformation);
                            SDL_PushGPUVertexUniformData(
                                command,
                                1,
                                &deformation,
                                sizeof(deformation));
                        }
#endif
#if BBLITE_GPU_INSTANCING
                        if (
                            item.material_kind !=
                            upstream::RenderMaterialKind::grid) {
                            const std::array<float, 16> parent_world =
                                upstream::build_instance_parent_world(
                                    engine.meshes[
                                        item.mesh.value]);
                            SDL_PushGPUVertexUniformData(
                                command,
                                instance_uniform_slot,
                                parent_world.data(),
                                sizeof(parent_world));
                        }
#endif
                        if (
                            item.material_kind ==
                            upstream::RenderMaterialKind::grid) {
                            const upstream::GridUniforms fragment =
                                upstream::build_grid_uniforms(
                                    engine,
                                    item);
                            SDL_PushGPUFragmentUniformData(
                                command,
                                0,
                                &fragment,
                                sizeof(fragment));
                        }
                    }
                    const SDL_GPUBufferBinding index_binding{
                        mesh.indices,
                        0,
                    };
                    bind_mesh_vertex_buffers(
                        pass,
                        mesh);
                    SDL_BindGPUIndexBuffer(
                        pass,
                        &index_binding,
                        SDL_GPU_INDEXELEMENTSIZE_32BIT);
                    SDL_DrawGPUIndexedPrimitives(
                        pass,
                        mesh.index_count,
                        mesh.instance_count,
                        0,
                        0,
                        0);
                }
            };
            const auto draw_ground = [&] {
                if (!state.background.enabled) return;
                if (!scene_matrix_bound) {
                    SDL_PushGPUVertexUniformData(
                        command,
                        0,
                        matrix.data(),
                        sizeof(matrix));
                }
#if BBLITE_GPU_DEFORMATION
                // Background geometry carries zeroed joint weights; without
                // a fresh identity deformation block the previous mesh
                // draw's skinning uniforms would collapse the quad.
                const DeformationUniforms ground_deformation =
                    build_deformation_uniforms(MeshRecord{}, false);
                SDL_PushGPUVertexUniformData(
                    command,
                    1,
                    &ground_deformation,
                    sizeof(ground_deformation));
#endif
                const upstream::BackgroundUniforms background =
                    upstream::build_background_uniforms(scene.environment, camera);
                SDL_BindGPUGraphicsPipeline(pass, state.background_pipeline);
                SDL_PushGPUFragmentUniformData(
                    command,
                    0,
                    &background,
                    sizeof(background));
                const SDL_GPUBufferBinding index_binding{state.background.indices, 0};
                const SDL_GPUTextureSamplerBinding texture_binding{
                    state.background.texture,
                    state.ground_sampler,
                };
#if BBLITE_GPU_INSTANCING
                const std::array<SDL_GPUBufferBinding, 2>
                    ground_vertex_bindings{
                        SDL_GPUBufferBinding{
                            state.background.vertices,
                            0,
                        },
                        SDL_GPUBufferBinding{
                            state.background_instances,
                            0,
                        },
                    };
                SDL_BindGPUVertexBuffers(
                    pass,
                    0,
                    ground_vertex_bindings.data(),
                    static_cast<Uint32>(
                        ground_vertex_bindings.size()));
                SDL_PushGPUVertexUniformData(
                    command,
                    instance_uniform_slot,
                    identity_parent_world.data(),
                    sizeof(identity_parent_world));
#else
                const SDL_GPUBufferBinding vertex_binding{state.background.vertices, 0};
                SDL_BindGPUVertexBuffers(pass, 0, &vertex_binding, 1);
#endif
#if BBLITE_GPU_MORPH_STORAGE
                const std::array<SDL_GPUBuffer*, 2> morph_storage{
                    state.empty_morph_deltas,
                    state.empty_morph_weights,
                };
                SDL_BindGPUVertexStorageBuffers(
                    pass,
                    0,
                    morph_storage.data(),
                    static_cast<Uint32>(morph_storage.size()));
#endif
                SDL_BindGPUIndexBuffer(
                    pass,
                    &index_binding,
                    SDL_GPU_INDEXELEMENTSIZE_32BIT);
                SDL_BindGPUFragmentSamplers(pass, 0, &texture_binding, 1);
                SDL_DrawGPUIndexedPrimitives(pass, 6, 1, 0, 0, 0);
                scene_matrix_bound = true;
            };
#if BBLITE_HAS_BILLBOARDS
            // A billboard system draws in the slot its depth mode gives it:
            // 100 among the opaque meshes, because a cutout system writes
            // depth and everything after has to see it, and 200 after the
            // scene's own stages for the transparent modes.
            const auto draw_billboards =
                [&](BillboardDepthMode mode) {
                for (const BillboardPass& billboard :
                     state.billboard_passes) {
                    if (engine.billboard_systems[billboard.system.value].depth_mode !=
                        mode) {
                        continue;
                    }
                    record_billboard_pass(
                        command,
                        pass,
                        engine,
                        billboard,
                        matrix,
                        billboard_view);
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
                        draw_render_list(render_plan.draw_lists.transparent);
#if BBLITE_HAS_SPLATS
                        // `isTransparent: true` on the pinned renderable, so
                        // a cloud belongs to this bucket. The Dawn sibling
                        // states the ordering caveat.
                        for (const SplatPass& splat : state.splat_passes) {
                            record_splat_pass(
                                command,
                                pass,
                                engine,
                                splat,
                                splat_view,
                                splat_projection,
                                static_cast<double>(width),
                                static_cast<double>(height));
                        }
#endif
                        break;
                    case upstream::RenderStage::ground:
                        draw_ground();
                        break;
                }
            }
#if BBLITE_HAS_BILLBOARDS
            // The transparent systems close the scene's pass: they blend
            // over every stage above and test against the depth they wrote.
            draw_billboards(BillboardDepthMode::transparent);
#endif
            SDL_EndGPURenderPass(pass);
            SDL_GPUTexture* visible_color = state.color;
            if (transmission_enabled) {
                SDL_GPUColorTargetInfo image_processing_target{};
                image_processing_target.texture =
                    state.processed_color;
                image_processing_target.load_op =
                    SDL_GPU_LOADOP_DONT_CARE;
                image_processing_target.store_op =
                    SDL_GPU_STOREOP_STORE;
                SDL_GPURenderPass* image_processing_pass =
                    SDL_BeginGPURenderPass(
                        command,
                        &image_processing_target,
                        1,
                        nullptr);
                SDL_BindGPUGraphicsPipeline(
                    image_processing_pass,
                    state.image_processing_pipeline);
                const ImageProcessingUniforms image_processing{{
                    scene.environment.exposure,
                    scene.environment.contrast,
                    scene.environment.tone_mapping_enabled
                        ? 1.0f
                        : 0.0f,
                    0.0f,
                }};
                SDL_PushGPUFragmentUniformData(
                    command,
                    0,
                    &image_processing,
                    sizeof(image_processing));
                if (state.per_sample_image_processing) {
                    // A Texture2DMS is Load()-ed and carries no sampler,
                    // so it binds as a storage texture rather than as a
                    // sampler pair.
                    SDL_BindGPUFragmentStorageTextures(
                        image_processing_pass,
                        0,
                        &state.msaa_color,
                        1);
                } else {
                    const SDL_GPUTextureSamplerBinding source_binding{
                        state.color,
                        state.background_sampler,
                    };
                    SDL_BindGPUFragmentSamplers(
                        image_processing_pass,
                        0,
                        &source_binding,
                        1);
                }
                SDL_DrawGPUPrimitives(
                    image_processing_pass,
                    3,
                    1,
                    0,
                    0);
                SDL_EndGPURenderPass(image_processing_pass);
                visible_color = state.processed_color;
            }
            if (capture_frame || transmission_enabled) {
                SDL_GPUBlitInfo blit{};
                blit.source = SDL_GPUBlitRegion{
                    visible_color,
                    0,
                    0,
                    0,
                    0,
                    width,
                    height};
                blit.destination = SDL_GPUBlitRegion{swapchain, 0, 0, 0, 0, width, height};
                blit.load_op = SDL_GPU_LOADOP_DONT_CARE;
                blit.flip_mode = SDL_FLIP_NONE;
                blit.filter = SDL_GPU_FILTER_NEAREST;
                SDL_BlitGPUTexture(command, &blit);
            }
            if (capture_frame) {
                save_texture_png(
                    state.device,
                    command,
                    visible_color,
                    swapchain_format,
                    width,
                    height,
                    screenshot_path);
                captures.screenshot_saved = true;
            } else if (!SDL_SubmitGPUCommandBuffer(command)) {
                gpu_error("SDL_SubmitGPUCommandBuffer");
            }
            }
            if (capture_ids) {
                save_geometry_id_buffer_png(
                    state,
                    width,
                    height,
                    matrix,
                    render_plan.items,
                    engine,
                    id_buffer_path,
                    false);
                captures.id_buffer_saved = true;
            }
            if (capture_clusters) {
                save_geometry_id_buffer_png(
                    state,
                    width,
                    height,
                    matrix,
                    render_plan.items,
                    engine,
                    cluster_buffer_path,
                    true);
                captures.cluster_buffer_saved = true;
            }
            const double end = monotonic_milliseconds();
            if (benchmark && frame >= warmup) {
                samples.push_back(end - start);
            }
            ++frame;
        }
        report_benchmark(
            samples,
            "SDL_GPU",
            SDL_GetGPUDeviceDriver(state.device));
        if (!SDL_WaitForGPUIdle(state.device)) {
            gpu_error("SDL_WaitForGPUIdle");
        }
        release(state);
        return true;
    } catch (...) {
        release(state);
        throw;
    }
#else
    (void)engine;
    return false;
#endif
}

} // namespace bbl::pal
