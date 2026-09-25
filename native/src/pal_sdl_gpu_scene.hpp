// The SDL_GPU scene renderer's state and the declarations its sources
// share: the scene driver (pal_sdl_gpu.cpp) and one file per feature family,
// each paired with its Dawn twin (pal_dawn_scene_<family>.cpp), compiled as
// one translation unit (pal_sdl_gpu_scene_all.cpp).
#pragma once
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
#include <bblite/pal_image.hpp>
#include <bblite/pal_gpu.hpp>
#include <bblite/runtime.hpp>
#if BBLITE_HAS_UI && !BBLITE_WORKERS
#include <bblite/pal_ui.hpp>
#endif
#include <bblite/upstream/camera_controls.hpp>
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
#if BBLITE_HAS_PBR_RENDERER
#include <bblite/upstream/render_capabilities.hpp>
#include <bblite/upstream/renderer_plan.hpp>
#endif
#if BBLITE_HAS_CLUSTERED_LIGHTS
#include <bblite/upstream/clustered_light.hpp>
#endif

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iostream>
#include <limits>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <tuple>
#include <unordered_map>
#include <vector>

#include "pal_camera_controls.hpp"
#include "pal_gpu_common.hpp"
#include "pal_gpu_surface.hpp"
#include "pal_gpu_vertex.hpp"
#include "pal_gpu_materials.hpp"
#include "pal_gpu_scene_blocks.hpp"
#include "pal_gpu_targets.hpp"
#include "pal_gpu_pipeline.hpp"
#include "pal_sdl_gpu_post_process.hpp"
#include "pal_pass_camera.hpp"
#include "pal_scene_synchronize.hpp"
#include "pal_texture_upload_cache.hpp"
#include "pal_sdl_gpu_compute_texture.hpp"
#include "pal_frame_session.hpp"
#if BBLITE_HAS_TEXT
#include "pal_sdl_gpu_text.hpp"
#endif
#if BBLITE_HAS_BILLBOARDS
#include "pal_sdl_gpu_billboard.hpp"
#endif
#if BBLITE_HAS_SPRITE_RENDERER
#include "pal_sdl_gpu_sprite.hpp"
#endif
#if BBLITE_HAS_SPLATS
#include "pal_sdl_gpu_splat.hpp"
#endif
#if BBLITE_HAS_PICKING
#include "pal_sdl_gpu_picking.hpp"
#endif
#if BBLITE_HAS_EFFECT_TASK
#include "pal_sdl_gpu_effect.hpp"
#endif
#include "pal_render_capture.hpp"
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
#include "pal_node_capture_state.hpp"
#endif

#if BBLITE_HAS_PBR_RENDERER
#include <SDL3/SDL.h>
#include <SDL3/SDL_gpu.h>
#include "pal_sdl_gpu_shared.hpp"
#if BBLITE_GPU_TASK_TIMING
#include <bblite/pal_gpu_task_timing.hpp>
#include "pal_sdl_gpu_timestamp.hpp"
#endif
#if BBLITE_HAS_TAA
#include "pal_sdl_gpu_temporal.hpp"
#include "pal_temporal_shared.hpp"
#include <variant>
#endif
#if BBLITE_OFFSCREEN_SURFACES
#include "pal_sdl_gpu_offscreen.hpp"
#endif
#if BBLITE_HAS_UI && !BBLITE_WORKERS
#include "pal_sdl_gpu_sprite_ui.hpp"
#endif
#if BBLITE_HAS_CLUSTERED_LIGHTS
#include "pal_sdl_gpu_clustered.hpp"
#endif
#endif

namespace bbl::pal {

#if BBLITE_HAS_PBR_RENDERER
inline namespace sdl_scene {

/** The shared cull enum in this API's; the pipeline-kind facts come from
 *  `pipeline_kind_traits` (shared GPU helpers). */
/**
 * `buildPrimitiveState`'s own table, in SDL_GPU's names. A triangle strip
 * never reaches here: the loader expands one into the list it describes.
 */
[[maybe_unused]] SDL_GPUPrimitiveType gpu_primitive_type(MeshTopology topology);

/**
 * The pin's `executePassBody` and geometry `executeTask` opening
 * (`_applyCameraViewport`): a camera carrying a viewport narrows the pass
 * to it, and one without leaves the pass at the whole target the way
 * `if (!v) return` leaves it.
 *
 * Set AFTER the pass begins, exactly where upstream sets it, so the load
 * operation has already cleared or loaded the whole attachment -- a
 * split-screen base scene clears the target and draws its half, and the
 * overlay loads that and draws the other.
 */
void set_pass_viewport(SDL_GPURenderPass* pass, const std::optional<PixelViewport>& resolved);

/** A scene's own pass: its camera's viewport composed into its surface pane. */
inline void set_pass_camera_viewport(SDL_GPURenderPass* pass, const Scene& scene,
                                     const Engine& engine, const CameraRecord* camera,
                                     std::uint32_t target_width, std::uint32_t target_height) {
    set_pass_viewport(pass,
                      scene_camera_viewport(engine, scene, camera, target_width, target_height));
}

/** A render or geometry task's pass, over its own target's extent. */
void set_task_camera_viewport(SDL_GPURenderPass* pass, const CameraRecord* camera,
                              std::uint32_t target_width, std::uint32_t target_height);

[[maybe_unused]] inline SDL_GPUCullMode gpu_cull_mode(upstream::RenderCullMode cull) {
    return cull == upstream::RenderCullMode::none ? SDL_GPU_CULLMODE_NONE : SDL_GPU_CULLMODE_BACK;
}

[[maybe_unused]] inline SDL_GPUFrontFace gpu_front_face(bool clockwise) {
    return clockwise ? SDL_GPU_FRONTFACE_CLOCKWISE : SDL_GPU_FRONTFACE_COUNTER_CLOCKWISE;
}

struct SharedShaderGeometry;
struct SharedMaterialTextures;
using SharedShaderMaterialTextures = SharedMaterialTextures;
struct SharedComposedMaterialTextures;
#if BBLITE_HAS_MATERIAL_PLUGIN_TEXTURES
using SharedPluginMaterialTextures = SharedMaterialTextures;
#endif

struct GpuMeshResources {
    SDL_GPUBuffer* vertices = nullptr;
    // Shader-material meshes keep immutable local-space geometry in the
    // state cache. Their entries borrow those buffers and bind the ordinary
    // mesh transform through the material's system-matrix block per draw.
    bool owns_geometry_buffers = true;
    SharedShaderGeometry* shared_geometry = nullptr;

#if BBLITE_PBR_VARIANTS > 0
#if BBLITE_VAT
    // The baked vertex-animation texture: the bone palette's own row,
    // frameCount rows tall. Uploaded once -- the bake is settled before the
    // first frame -- and the per-instance params beside it, re-uploaded on
    // the record's own version.
    SDL_GPUTexture* pinned_vat_texture = nullptr;
    std::uint32_t pinned_vat_bones = 0;
    std::uint32_t pinned_vat_frames = 0;
#if BBLITE_VAT_INSTANCES
    SDL_GPUTexture* pinned_vat_instance_texture = nullptr;
    std::uint32_t pinned_vat_instance_texels = 0;
    std::uint64_t pinned_vat_instance_version = 0;
#endif
#endif
#endif
#if BBLITE_PBR_VARIANTS > 0 || BBLITE_STANDARD_SKELETON
    // Both material families sample the pin's rgba32float bone palette.
    SDL_GPUTexture* pinned_bone_texture = nullptr;
    std::uint32_t pinned_bone_count = 0;
    std::uint64_t pinned_bone_version = unsynced_bone_palette;
#endif
    SDL_GPUBuffer* indices = nullptr;
    SDL_GPUBuffer* instances = nullptr;
#if BBLITE_GPU_INSTANCE_COLORS
    // The per-instance RGBA stream a material with useThinInstanceColors
    // reads, in its own tightly-packed instance buffer.
    SDL_GPUBuffer* instance_colors = nullptr;
#endif
    std::uint64_t instance_version = 0;
    // How many instance rows the buffers above were allocated for. A live
    // pool can double past it (`addThinInstance`), and every one of them is
    // sized from this same count, so the frame sync recreates all three
    // together when `thin_instance_pool_grew` says so.
    std::uint32_t instance_capacity = 0;
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
#if BBLITE_MATERIAL_TRANSMISSION_MAP
    SDL_GPUTexture* transmission = nullptr;
#endif
#if BBLITE_MATERIAL_THICKNESS_MAP
    SDL_GPUTexture* thickness = nullptr;
#endif
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
#if BBLITE_MATERIAL_LIGHTMAP
    SDL_GPUTexture* lightmap = nullptr;
#endif
#if BBLITE_MATERIAL_METALLIC_REFLECTANCE_MAP
    SDL_GPUTexture* metallic_reflectance = nullptr;
#endif
#if BBLITE_MATERIAL_REFLECTANCE_MAP
    SDL_GPUTexture* reflectance = nullptr;
#endif
#if BBLITE_MATERIAL_ANISOTROPY_MAP
    SDL_GPUTexture* anisotropy = nullptr;
#endif
#if BBLITE_MATERIAL_TRANSLUCENCY_COLOR_MAP
    SDL_GPUTexture* translucency_color = nullptr;
#endif
#if BBLITE_MATERIAL_TRANSLUCENCY_INTENSITY_MAP
    SDL_GPUTexture* translucency_intensity = nullptr;
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
#if BBLITE_MATERIAL_TRANSMISSION_MAP
    SDL_GPUSampler* transmission_sampler = nullptr;
#endif
#if BBLITE_MATERIAL_THICKNESS_MAP
    SDL_GPUSampler* thickness_sampler = nullptr;
#endif
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
#if BBLITE_MATERIAL_LIGHTMAP
    SDL_GPUSampler* lightmap_sampler = nullptr;
#endif
#if BBLITE_MATERIAL_METALLIC_REFLECTANCE_MAP
    SDL_GPUSampler* metallic_reflectance_sampler = nullptr;
#endif
#if BBLITE_MATERIAL_REFLECTANCE_MAP
    SDL_GPUSampler* reflectance_sampler = nullptr;
#endif
#if BBLITE_MATERIAL_ANISOTROPY_MAP
    SDL_GPUSampler* anisotropy_sampler = nullptr;
#endif
#if BBLITE_MATERIAL_TRANSLUCENCY_COLOR_MAP
    SDL_GPUSampler* translucency_color_sampler = nullptr;
#endif
#if BBLITE_MATERIAL_TRANSLUCENCY_INTENSITY_MAP
    SDL_GPUSampler* translucency_intensity_sampler = nullptr;
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
    SharedShaderMaterialTextures* shared_shader_textures = nullptr;
#if BBLITE_HAS_MATERIAL_PLUGIN_TEXTURES
    // The textures this mesh's material plugins bound, in the order the
    // pin's own `bindPluginTextures` pushes them. Shared per material,
    // because the textures are the material's.
    SharedPluginMaterialTextures* shared_plugin_textures = nullptr;
#endif
    // PBR and Standard texture slots belong to their material. Fractured
    // meshes can contribute hundreds of render items that all retain the
    // same material; each mesh borrows this one backend upload.
    SharedComposedMaterialTextures* shared_composed_textures = nullptr;
    std::uint32_t index_count = 0;
    std::uint32_t instance_count = 1;
    std::uint64_t position_version = 0;
};
struct GpuState;
void release_gpu_mesh_resources(GpuState*, GpuMeshResources&) noexcept;
using GpuMesh =
    OwnedGpuRecord<GpuMeshResources, std::remove_pointer_t<GpuState*>, release_gpu_mesh_resources>;

[[maybe_unused]] SDL_GPUBuffer* morph_storage_buffer_for(const GpuMesh& mesh,
                                                         const std::string& name);

/** Bind the contiguous vertex/matrix/colour stream prefix one composed arm uses. */
[[maybe_unused]] void bind_composed_mesh_vertex_buffers(SDL_GPURenderPass* pass,
                                                        SDL_GPUBuffer* vertices,
                                                        SDL_GPUBuffer* instances,
                                                        SDL_GPUBuffer* colors);

/** One exact local-space shader geometry shared by every matching draw. */
struct SharedShaderGeometry {
    SharedGeometryIdentity identity;
    // Kept only below `shared_geometry_bytes_kept_below` vertices.
    std::vector<GpuVertex> vertices;
    std::vector<std::uint32_t> indices;
    OwnedSdlBuffer vertex_buffer{};
    OwnedSdlBuffer index_buffer{};
    std::size_t users = 0;
};

/** Texture/sampler pairs belong to a material, not to each mesh. */
struct SharedMaterialTextures : SdlSampledTextures {
    using SdlSampledTextures::SdlSampledTextures;
    MaterialHandle material{};
    std::size_t users = 0;
};

/** Generated PBR/Standard texture-slot bindings owned once per material. */
struct SharedComposedMaterialTextures : SdlSampledTextures {
    using SdlSampledTextures::SdlSampledTextures;
    MaterialHandle material{};
    bool standard_material = false;
    std::size_t users = 0;
};

[[nodiscard]] inline const std::vector<SDL_GPUTextureSamplerBinding>&
mesh_shader_textures(const GpuMesh& mesh) {
    return mesh.shared_shader_textures ? mesh.shared_shader_textures->bindings
                                       : mesh.shader_textures;
}

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
    SDL_GPUTexture* GpuMeshResources::* texture = nullptr;
    SDL_GPUSampler* GpuMeshResources::* sampler = nullptr;
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
StandardRenderTextures material_render_textures(const MaterialRecord* material,
                                                SourceTexture source_texture) {
    if (!material)
        return {};
    return {
        material->has_diffuse_render_texture ? source_texture(material->diffuse_render_texture)
                                             : nullptr,
        material->has_emissive_render_texture ? source_texture(material->emissive_render_texture)
                                              : nullptr,
    };
}

/**
 * The shader pipelines one secondary dispatch selects from. The main pass
 * reads them off the state and a render task off its own parameters, so
 * the sources travel as one bundle and the dispatch below exists once.
 */
struct SecondaryPipelines {
    const std::vector<SDL_GPUGraphicsPipeline*>* shader = nullptr;
    const std::vector<SDL_GPUGraphicsPipeline*>* shader_a2c = nullptr;
};

/**
 * The pipeline a non-composed draw binds: a shader material by its variant
 * index. The composed
 * families never reach here — the pinned dispatch above owns every PBR,
 * Standard and node draw — so those families refuse by dispatch name.
 * `dispatch` names the calling pass ("main dispatch" / "task dispatch").
 */
SDL_GPUGraphicsPipeline* secondary_pipeline_for(const SecondaryPipelines& pipelines,
                                                upstream::RenderPipelineKind kind,
                                                std::uint32_t shader_variant, const char* dispatch);

GpuMeshSlotMembers mesh_slot_members(upstream::MaterialTextureSource source);

void bind_mesh_vertex_buffers(SDL_GPURenderPass* pass, const GpuMesh& mesh);

#if BBLITE_PINNED_BACKGROUNDS
/**
 * One of the pin's background arms on SDL_GPU: a pipeline over the pin's
 * two stages built from its row in `pinned_background_arms`, the buffers the
 * lowered builders filled, and the texture its group 1 samples.
 */
struct GpuBackgroundArm {
    const upstream::PinnedBackgroundArm* arm = nullptr;
    SDL_GPUGraphicsPipeline* pipeline = nullptr;
    PinnedStageSlots vertex_slots;
    PinnedStageSlots fragment_slots;
    std::vector<SDL_GPUBuffer*> vertex_buffers;
    SDL_GPUBuffer* indices = nullptr;
    std::uint32_t index_count = 0;
    std::vector<std::uint8_t> mesh_block;
    SDL_GPUTexture* texture = nullptr;
    bool owns_texture = false;
    SDL_GPUSampler* sampler = nullptr;
};
#endif

using SdlVariantPipelineKey =
    std::tuple<std::size_t, SDL_GPUSampleCount, SDL_GPUTextureFormat, SDL_GPUTextureFormat>;

struct ShaderTaskTarget {
    SDL_GPUTextureFormat color;
    SDL_GPUTextureFormat depth;
    SDL_GPUSampleCount samples;
};

/** Custom-material pipelines follow the render task's attachment layout. */
struct ShaderTaskPipeline {
    OwnedSdlShader vertex;
    OwnedSdlShader fragment;
    SDL_GPUGraphicsPipelineCreateInfo base{};
    SDL_GPUColorTargetDescription color{};
    std::vector<SDL_GPUVertexBufferDescription> buffers;
    std::vector<SDL_GPUVertexAttribute> attributes;
    std::map<std::tuple<SDL_GPUTextureFormat, SDL_GPUTextureFormat, SDL_GPUSampleCount, bool>,
             OwnedSdlPipeline>
        pipelines;

    ShaderTaskPipeline() = default;
    ShaderTaskPipeline(OwnedSdlShader vertex_shader, OwnedSdlShader fragment_shader,
                       const SDL_GPUGraphicsPipelineCreateInfo& info)
        : vertex(std::move(vertex_shader)), fragment(std::move(fragment_shader)), base(info),
          color(*info.target_info.color_target_descriptions) {
        const auto& input = info.vertex_input_state;
        if (input.num_vertex_buffers)
            buffers.assign(input.vertex_buffer_descriptions,
                           input.vertex_buffer_descriptions + input.num_vertex_buffers);
        if (input.num_vertex_attributes)
            attributes.assign(input.vertex_attributes,
                              input.vertex_attributes + input.num_vertex_attributes);
    }

    SDL_GPUGraphicsPipeline* get(SDL_GPUDevice* device, const ShaderTaskTarget& target, bool cutout,
                                 SDL_GPUGraphicsPipeline* ordinary,
                                 SDL_GPUGraphicsPipeline* alpha_to_coverage) {
        const bool coverage =
            alpha_to_coverage_enabled(cutout, gpu_sample_count_value(target.samples));
        const auto base_depth = base.target_info.has_depth_stencil_target
                                    ? base.target_info.depth_stencil_format
                                    : SDL_GPU_TEXTUREFORMAT_INVALID;
        if (target.color == color.format && target.depth == base_depth &&
            target.samples == base.multisample_state.sample_count) {
            return coverage ? alpha_to_coverage : ordinary;
        }
        const auto key = std::make_tuple(target.color, target.depth, target.samples, coverage);
        if (const auto found = pipelines.find(key); found != pipelines.end())
            return found->second.get();
        auto info = base;
        auto attachment = color;
        attachment.format = target.color;
        info.vertex_shader = vertex.get();
        info.fragment_shader = fragment.get();
        info.vertex_input_state.vertex_buffer_descriptions = buffers.data();
        info.vertex_input_state.vertex_attributes = attributes.data();
        info.target_info.color_target_descriptions = &attachment;
        info.target_info.depth_stencil_format = target.depth;
        info.target_info.has_depth_stencil_target = target.depth != SDL_GPU_TEXTUREFORMAT_INVALID;
        info.depth_stencil_state.enable_depth_test &= info.target_info.has_depth_stencil_target;
        info.depth_stencil_state.enable_depth_write &= info.target_info.has_depth_stencil_target;
        info.multisample_state.sample_count = target.samples;
        info.multisample_state.enable_alpha_to_coverage = coverage;
        OwnedSdlPipeline pipeline{create_sdl_gpu_graphics_pipeline(device, vertex, &info),
                                  {device}};
        if (!pipeline)
            gpu_error("SDL_CreateGPUGraphicsPipeline shader render task");
        return pipelines.emplace(key, std::move(pipeline)).first->second.get();
    }
};

struct GpuRenderTarget {
    SDL_GPUTexture* color = nullptr;
    SDL_GPUTexture* sampled_color = nullptr;
    SDL_GPUTexture* depth = nullptr;
    SDL_GPUTexture* depth_copy = nullptr;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    /** What its colour attachment resolved to, for a target that follows it. */
    SDL_GPUTextureFormat color_format = SDL_GPU_TEXTUREFORMAT_INVALID;
    SDL_GPUTextureFormat depth_format = SDL_GPU_TEXTUREFORMAT_INVALID;
    /**
     * Which build of the frame graph created these textures, numbered per
     * target: the identity a screen-space effect compares its bound
     * textures by (`ScreenSpaceFrameInputs`). Zero until first created.
     */
    std::uint32_t allocation = 0;
    std::shared_ptr<GpuRenderTarget> retained;
};
[[maybe_unused]] std::shared_ptr<GpuRenderTarget> retain_render_target(SDL_GPUDevice* device,
                                                                       GpuRenderTarget& target);

#if BBLITE_HAS_POST_PROCESS
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

struct GpuPostProcessTask {
    /**
     * Its program's index in `GpuState::post_process_programs`, resolved
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
    /**
     * What each fragment texture slot names, resolved from the `.slots`
     * sidecar once: -1 is the pass's source, and 0.. indexes its extra
     * textures in the effect's own order.
     */
    std::vector<int> texture_sources;
    /** The effect's uniform block, sized once and refilled per frame. */
    std::vector<float> uniform_data;
#if BBLITE_HAS_TAA
    bool temporal_recorded = false;
#endif
};
#endif

#if BBLITE_HAS_SCREEN_SPACE
/**
 * A screen-space producer or temporal resolve: the pin's own dedicated
 * pipeline (`ensureProducerPipeline`, `ensurePipeline`), built from the
 * deployed stage the generated table names and shared by every task that
 * draws the same stage.
 */
struct GpuScreenSpaceProgram {
    std::uint32_t stage = 0;
    OwnedSdlPipeline pipeline;
    PinnedStageSlots vertex_slots;
    PinnedStageSlots fragment_slots;
    /**
     * Which frame-graph texture each fragment sampler slot reads, resolved
     * once from the sidecar's names against the stage's binding table.
     */
    std::vector<upstream::ScreenSpaceTextureRole> fragment_roles;
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
    /** The task's Standard renderables' previous worlds. */
    PinnedVelocityHistory velocity;
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

#if BBLITE_SHADOW_RECEIVERS
/**
 * One stage's composed shadow rows, parallel to its `.slots` lists.
 *
 * This backend binds by NAME, so a receiving draw used to walk the
 * variant's reflected rows per binding name per stage -- ~100 string
 * compares a frame on scene 22, growing as bindings x shadow-lights x
 * receiving draws. The rows and the slot name list are both fixed per
 * variant, so each list here is resolved once beside the slot cache and
 * per-draw resolution becomes an index: entry i answers for slot i, null
 * where that slot is not a shadow binding. `texture_samplers` carries the
 * sampler row declared beside each map row's light, resolved with it so
 * the draw keeps only the comparison-versus-filtering choice.
 */
struct PinnedStageShadowRows {
    std::vector<const upstream::PinnedShadowBinding*> uniforms;
    std::vector<const upstream::PinnedShadowBinding*> textures;
    std::vector<const upstream::PinnedShadowBinding*> texture_samplers;
    std::vector<const upstream::PinnedShadowBinding*> storage;
};
#endif

struct GpuState : SdlGpuDevice {
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
    NodeCaptureState node_capture;
#endif
#if BBLITE_LOCAL_CUBEMAP
    struct LocalCubemap {
        SDL_GPUDevice* device = nullptr;
        std::shared_ptr<const LocalCubemapRecord> source;
        SDL_GPUTexture* texture = nullptr;
        SDL_GPUTexture* environment = nullptr;
        std::shared_ptr<ComputeTextureAllocation> environment_gpu;
        SDL_GPUBuffer* uniform = nullptr;
        SDL_GPUBuffer* grid = nullptr;
        ~LocalCubemap() {
            if (texture)
                SDL_ReleaseGPUTexture(device, texture);
            if (environment && !environment_gpu)
                SDL_ReleaseGPUTexture(device, environment);
            if (uniform)
                SDL_ReleaseGPUBuffer(device, uniform);
            if (grid)
                SDL_ReleaseGPUBuffer(device, grid);
        }
    };
    std::unordered_map<const LocalCubemapRecord*, std::unique_ptr<LocalCubemap>> local_cubemaps;
#endif
#if BBLITE_HAS_TEXT
    std::unique_ptr<SdlTextRenderer> text;
#endif
#if BBLITE_HAS_CLUSTERED_LIGHTS
    /** The clustered light field's three data textures and their sampler. */
    ClusteredLightGpu clustered;
#endif
#if BBLITE_HAS_UI && !BBLITE_WORKERS
    SpriteUiSdlResources ui;
    UiSdlReadableSurface ui_readable_surface;
#endif
    // One pipeline (plus an alpha-to-coverage twin) per generated
    // shader variant, indexed by the variant id from the emitted table.
    std::vector<SDL_GPUGraphicsPipeline*> shader_pipelines;
    std::vector<SDL_GPUGraphicsPipeline*> shader_a2c_pipelines;
    /** Vertex-only custom-material pipelines for depth shadow targets. */
    std::vector<SDL_GPUGraphicsPipeline*> shader_shadow_pipelines;
    std::vector<ShaderTaskPipeline> shader_task_pipelines;
    // What the compaction pass assigned each shader-material stage, by the
    // caller's own block and sampler names. The stage's contents depend on
    // scene code, so this sidecar -- not the WGSL, and not the reflection
    // generation derived from it -- is the authority on its registers.
    std::vector<PinnedStageSlots> shader_vertex_slots;
    std::vector<PinnedStageSlots> shader_fragment_slots;
    using StorageBuffer = VersionedGpuBuffer<SDL_GPUBuffer*>;
    std::vector<StorageBuffer> storage_buffers;
    std::vector<SDL_GPUTextureSamplerBinding> shader_texture_binding_scratch;
#if BBLITE_HAS_EFFECT_TASK
    // One built pass per effect render task, keyed by task index and built
    // lazily against the target's own format and sample count -- the pin
    // keys its own pipeline cache by exactly that pair.
    std::vector<EffectPass> effect_tasks;
#endif
    SDL_GPUGraphicsPipeline* id_pipeline = nullptr;
    SDL_GPUGraphicsPipeline* id_double_sided_pipeline = nullptr;
    SDL_GPUGraphicsPipeline* cluster_pipeline = nullptr;
    SDL_GPUGraphicsPipeline* cluster_double_sided_pipeline = nullptr;
    SDL_GPUGraphicsPipeline* blit_pipeline = nullptr;
    SDL_GPUGraphicsPipeline* blit_msaa_pipeline = nullptr;
#if BBLITE_RENDERER_TRANSMISSION
    // The pin's transmission grab and its image-processing resolve, the
    // same gate the Dawn backend compiles them behind.
    SDL_GPUGraphicsPipeline* image_processing_pipeline = nullptr;
    bool per_sample_image_processing = false;
    // Where the compaction left the pin's parameter block `p`.
    int image_processing_params_slot = -1;
    SDL_GPUSampler* transmission_sampler = nullptr;
    SDL_GPUTexture* transmission_color = nullptr;
    std::uint32_t transmission_width = 0;
    std::uint32_t transmission_height = 0;
#endif
    std::array<SDL_GPUGraphicsPipeline*, 2> depth_only_pipelines{};
    std::array<SDL_GPUGraphicsPipeline*, 2> depth_only_double_sided_pipelines{};
    SDL_GPUSampler* sampler = nullptr;
    SDL_GPUSampler* background_sampler = nullptr;
    SDL_GPUSampler* ground_sampler = nullptr;
#if BBLITE_GPU_MORPH_STORAGE
    // Shared zero-count pair bound for draws whose mesh has no morph
    // targets; the shader's storage loop then runs zero iterations.
    SDL_GPUBuffer* empty_morph_deltas = nullptr;
    SDL_GPUBuffer* empty_morph_weights = nullptr;
#endif
    SDL_GPUSampler* depth_sampler = nullptr;
    SDL_GPUTexture* environment = nullptr;
    std::shared_ptr<ComputeTextureAllocation> environment_gpu;
    SDL_GPUTexture* brdf_lut = nullptr;
    SDL_GPUTexture* reflection_fallback = nullptr;
    std::vector<SDL_GPUTexture*> reflection_cubes;
    SDL_GPUTexture* color = nullptr;
#if BBLITE_RENDERER_TRANSMISSION
    SDL_GPUTexture* processed_color = nullptr;
    std::uint32_t processed_color_width = 0;
    std::uint32_t processed_color_height = 0;
#endif
    SDL_GPUTexture* msaa_color = nullptr;
    SDL_GPUTexture* depth = nullptr;
#if BBLITE_PBR_VARIANTS > 0
    // One pipeline per (variant, pipeline kind, samples): the kind carries the cull mode,
    // the winding a mirrored node needs and the blend and depth state, exactly
    // as it does for the transcribed pipelines.
    std::map<SdlVariantPipelineKey, OwnedSdlPipeline> pinned_pipelines;
    // Each variant's stage slot maps, read once from the `.slots` sidecars.
    std::vector<PinnedStageSlots> pinned_vertex_slots;
    std::vector<PinnedStageSlots> pinned_fragment_slots;
#if BBLITE_PBR_SHADOWS
    // Each stage's composed shadow rows, parallel to the slot maps above
    // and filled beside them (`ensure_pinned_slots`), so a receiving draw
    // resolves a shadow name by index instead of walking the rows.
    std::vector<PinnedStageShadowRows> pinned_vertex_shadow_rows;
    std::vector<PinnedStageShadowRows> pinned_fragment_shadow_rows;
#endif
#endif
#if BBLITE_PBR_VARIANTS > 0 || BBLITE_STANDARD_SKELETON
    // Paired with every bone palette binding. The pin reads the palette with
    // textureLoad, so the sampler is never consulted; SDL_GPU still binds the
    // pair together.
    SDL_GPUSampler* pinned_bone_sampler = nullptr;
    /**
     * The staging buffer every pinned float texture (bone palettes, VAT
     * rows) streams through, grown to the largest upload and cycled by
     * SDL when a submitted upload still reads it.
     */
    SdlTextureTransferCache pinned_float_transfer;
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
        /**
         * Whichever of the two receiver blocks this generator publishes --
         * 96 bytes for a single-map one, 320 for a cascaded one -- with its
         * own size beside it, since the row that binds it cannot know.
         */
        upstream::ShadowReceiverBlock block{};
    };
    std::vector<ShadowGenerator> shadow_generators;
    std::vector<std::uint32_t> shadow_light_slots;
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
        /**
         * The same block as a real buffer, for a caster stage whose compile
         * demoted it: a node caster's fragment keeps the graph's own
         * lighting, so it spends all four uniform slots on scene,
         * nmeLights, meshU and nodeU before this one arrives.
         */
        SDL_GPUBuffer* params_buffer = nullptr;
        void clear(SDL_GPUDevice* device) {

            if (blur_h)
                SDL_ReleaseGPUTexture(device, blur_h);
            if (blur_v)
                SDL_ReleaseGPUTexture(device, blur_v);
            if (pipeline) {
                SDL_ReleaseGPUGraphicsPipeline(device, pipeline);
            }
            if (params_buffer) {
                SDL_ReleaseGPUBuffer(device, params_buffer);
            }

            *this = {};
        }
    };
    std::vector<EsmBlur> esm_blurs;
#endif
    /** The shared walk's carriers, whose layout it owns. */
    pal::ShadowRefreshState shadow_refresh;
#endif

#if BBLITE_STANDARD_VARIANTS > 0
    // The Standard family's composed pipelines and slot maps, keyed and
    // cached exactly like the PBR ones.
    std::map<SdlVariantPipelineKey, OwnedSdlPipeline> standard_variant_pipelines;
    std::vector<PinnedStageSlots> standard_vertex_slots;
    std::vector<PinnedStageSlots> standard_fragment_slots;
#if BBLITE_STANDARD_SHADOWS
    // The PBR pair's Standard siblings, filled by `ensure_standard_slots`.
    std::vector<PinnedStageShadowRows> standard_vertex_shadow_rows;
    std::vector<PinnedStageShadowRows> standard_fragment_shadow_rows;
#endif
#endif
#if BBLITE_NODE_VARIANTS > 0
    // The node family's pipelines and slot maps, cached the same way.
    std::map<SdlVariantPipelineKey, OwnedSdlPipeline> node_variant_pipelines;
    std::vector<PinnedStageSlots> node_vertex_slots;
    std::vector<PinnedStageSlots> node_fragment_slots;
#if BBLITE_NODE_SHADOWS
    // The same rows per node SLOT: a graph's receiver and caster views
    // compile separate stages, so each view's lists are its own.
    std::vector<PinnedStageShadowRows> node_vertex_shadow_rows;
    std::vector<PinnedStageShadowRows> node_fragment_shadow_rows;
#endif
#endif
    // Caller-owned scratch for composed and shader-material storage binds: the
    // pointer list a stage binds lives here so the per-draw walk reuses
    // one allocation, its capacity following whichever stage shape --
    // node-morph or shadow slot counts differ -- was the largest so far.
    std::vector<SDL_GPUBuffer*> storage_binding_scratch;
    SDL_GPUTextureFormat frame_color_format = SDL_GPU_TEXTUREFORMAT_INVALID;
    SDL_GPUTextureFormat depth_format = SDL_GPU_TEXTUREFORMAT_D16_UNORM;
    SDL_GPUSampleCount sample_count = SDL_GPU_SAMPLECOUNT_1;
#if BBLITE_HAS_BILLBOARDS
    std::vector<BillboardPass> billboard_passes;
#endif
#if BBLITE_HAS_SPLATS
    std::vector<SplatPass> splat_passes;
#endif
#if BBLITE_HAS_PICKING
    // Built on the first pick and released with the renderer, as the pin
    // builds them on first use and releases them in `disposePicker`. A
    // scene that picks without loading a cloud reaches every one of these
    // and none of the cloud pair below, which is why the two guards are
    // siblings rather than nested.
    PickTargets pick_targets;
    SDL_GPUGraphicsPipeline* pick_mesh_pipeline = nullptr;
    int pick_mesh_scene_slot = -1;
    int pick_mesh_uniform_slot = -1;
    /** The same two in the fragment stage, which keeps fewer. */
    int pick_frag_scene_slot = -1;
    int pick_frag_mesh_slot = -1;
#if BBLITE_GPU_INSTANCING
    /** The pin's advanced affine arm for a thin-instanced candidate. */
    SDL_GPUGraphicsPipeline* pick_thin_pipeline = nullptr;
    int pick_thin_scene_slot = -1;
    int pick_thin_uniform_slot = -1;
    int pick_thin_frag_scene_slot = -1;
    int pick_thin_frag_mesh_slot = -1;
#endif
#if BBLITE_HAS_DETAILED_PICKING
    /**
     * The DETAILED pipeline and its own four slots. A second pipeline
     * rather than a flag on the first, because the pin's own split is a
     * second module: `picking-detailed-pipeline.ts` composes a third
     * `rgba32uint` target and a `@builtin(primitive_index)` the basic
     * fragment does not read, and its stages therefore go through Tint's
     * register remap on their own.
     */
    SDL_GPUGraphicsPipeline* pick_detailed_pipeline = nullptr;
    int pick_detailed_scene_slot = -1;
    int pick_detailed_uniform_slot = -1;
    int pick_detailed_frag_scene_slot = -1;
    int pick_detailed_frag_mesh_slot = -1;
#endif
#if BBLITE_DEFORM_PICKING
    struct PickDeformProgram {
        SDL_GPUGraphicsPipeline* pipeline = nullptr;
        int scene_slot = -1;
        int mesh_slot = -1;
        PinnedStageSlots vertex_slots{};
    };
    std::array<std::array<PickDeformProgram, 2>, upstream::pick_deform_variants.size()>
        pick_deform_programs{};
#endif
#if BBLITE_HAS_SPLATS
    SDL_GPUGraphicsPipeline* pick_cloud_pipeline = nullptr;
    int pick_cloud_scene_slot = -1;
    int pick_cloud_mesh_slot = -1;
    int pick_cloud_color_slot = -1;
#endif
#endif
    std::uint32_t color_width = 0;
    std::uint32_t color_height = 0;
    std::uint32_t msaa_color_width = 0;
    std::uint32_t msaa_color_height = 0;
    std::uint32_t depth_width = 0;
    std::uint32_t depth_height = 0;
    std::uint32_t frame_graph_width = 0;
    std::uint64_t render_targets_version = 0;
    std::uint32_t frame_graph_height = 0;
    std::vector<GpuMesh> meshes;
    /**
     * The uploaded meshes of every swapchain overlay layer, one array per
     * scene registered after the first.
     *
     * `RenderDrawCommand::item_index` indexes a PLAN, so an overlay's
     * meshes cannot share the base scene's array: each layer keeps its own,
     * parallel to its own render plan.
     */
    std::vector<std::vector<GpuMesh>> overlay_meshes;
#if BBLITE_PBR_VARIANTS > 0 || BBLITE_STANDARD_SKELETON
    /**
     * Which meshes this frame's bone-palette sweep has already streamed.
     *
     * Kept on the state rather than built per frame so the sweep costs no
     * allocation; refilled at the top of each sweep.
     */
    std::vector<bool> streamed_palettes;
#endif
    // Dynamic shader meshes frequently repeat a small set of immutable
    // shapes. Keep exact local-space copies here so topology changes create
    // buffers once per distinct shape, not once per short-lived mesh.
    std::vector<std::unique_ptr<SharedShaderGeometry>> shared_shader_geometries;
    TextureUploadCache<OwnedSdlTexture> shared_material_images;
    std::vector<std::unique_ptr<SharedShaderMaterialTextures>> shared_shader_material_textures;
    std::vector<std::unique_ptr<SharedComposedMaterialTextures>> shared_composed_material_textures;
#if BBLITE_HAS_MATERIAL_PLUGIN_TEXTURES
    std::vector<std::unique_ptr<SharedPluginMaterialTextures>> shared_plugin_material_textures;
#endif
    std::vector<GpuRenderTarget> render_targets;
    OwnedSdlPipeline depth_copy_pipeline;
    /** The last `GpuRenderTarget::allocation` handed out. */
    std::uint32_t render_target_allocations = 0;
    std::vector<GpuGeometryTask> geometry_tasks;
#if BBLITE_HAS_POST_PROCESS
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
#if BBLITE_HAS_SCREEN_SPACE
    /**
     * The distinct producer/resolve stages the screen-space tasks draw,
     * kept for the device's lifetime.
     */
    std::vector<GpuScreenSpaceProgram> screen_space_programs;
#endif
#if BBLITE_PINNED_BACKGROUNDS
    // The arms this run draws (`select_pinned_backgrounds`), one each.
    pal::PinnedBackgroundDraws background_draws;
    std::vector<GpuBackgroundArm> background_arms;

    [[nodiscard]] const GpuBackgroundArm&
    background_arm(upstream::PinnedBackgroundArmKind kind) const {
        for (const GpuBackgroundArm& candidate : background_arms) {
            if (candidate.arm->kind == kind)
                return candidate;
        }
        throw std::runtime_error("A selected background arm was not built.");
    }
#endif
};

void sync_shader_storage_buffers(GpuState& state, const Engine& engine,
                                 GpuBufferUploadBatch& uploads);

SDL_GPUBuffer* shader_storage_buffer(GpuState& state, const MaterialRecord& material,
                                     const upstream::ShaderVariantInfo& info,
                                     const std::string& name);

/** Bind ordinary shader textures and resolve CSM pseudo-textures live. */
void bind_shader_material_textures(GpuState& state, SDL_GPURenderPass* pass,
                                   [[maybe_unused]] const Scene& scene,
                                   [[maybe_unused]] const Engine& engine,
                                   [[maybe_unused]] const MaterialRecord& material,
                                   std::uint32_t variant, const GpuMesh& mesh);

// Geometry-task helpers shared by the PBR and Standard variant
// pipelines; the definitions sit with the transmission helpers below.
SDL_GPUSampleCount task_sample_count(const GpuState& state, std::uint32_t requested);
SDL_GPUTextureFormat geometry_texture_format(const GeometryTextureDescription& description);

#if BBLITE_PINNED_MATERIALS
/**
 * One declared vertex input, resolved onto our vertex and into SDL's format
 * enum. The Dawn sibling reads the same `pinned_vertex_input` table; only the
 * enum residue and the buffer slot differ.
 */
bool append_variant_attribute(std::string_view name, Uint32 location,
                              std::vector<SDL_GPUVertexAttribute>& attributes);

/**
 * The vertex buffer descriptions one composed variant declares, and how
 * many of them it reaches.
 *
 * Which streams exist, at which slot, stride and step rate, is the shared
 * table's answer (`vertex_streams` and friends); what stays here is SDL's
 * own descriptor shape. `pinned_vertex_input` has already placed each
 * attribute in its stream, so the count is one past the highest slot any
 * of them landed in.
 */
[[maybe_unused]] Uint32 fill_variant_vertex_buffers(
    const std::vector<SDL_GPUVertexAttribute>& attributes,
    std::array<SDL_GPUVertexBufferDescription, vertex_streams.size()>& buffers);
#endif

#if BBLITE_SHADOWS_ESM
inline SDL_GPUTextureFormat esm_texture_format(upstream::EsmTextureFormat format) {
    return format == upstream::EsmTextureFormat::depth32_float
               ? SDL_GPU_TEXTUREFORMAT_D32_FLOAT
               : SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT;
}
#endif

#if BBLITE_PINNED_MATERIALS
#if BBLITE_SHADOWS_ESM

/**
 * The colour target an ESM caster pipeline declares.
 *
 * SDL_GPU's D3D12 backend bakes the declared format straight into the PSO's
 * RTV list, so a caster drawn into the generator's `rgba16float` map cannot
 * declare the frame's format: which map it writes is the pass's to say, and
 * the format is that generator's own recorded row -- the same answer the
 * Dawn backend takes.
 */
inline SDL_GPUTextureFormat esm_caster_color_format(std::uint32_t esm_shadow_index) {
    return esm_texture_format(upstream::esm_shadow_resources[esm_shadow_index].textures[0].format);
}
#endif

// Every family's receiver rows. A node receiver has no group 2 of its own
// -- its bindings continue the graph's own group 1 -- but the ROWS are the
// same reflected shape, so which resource each one wants is answered here
// for all three.
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
const upstream::PinnedShadowBinding*
shadow_row_for(std::span<const upstream::PinnedShadowBinding> rows, const std::string& name);

/**
 * The generator resources one composed row's LIGHT slot names.
 *
 * The active scene maps its light slots to engine-owned generator resources.
 * Separate scenes can use the same light slot without overwriting a buffer
 * already referenced by an earlier pass in this command buffer.
 */
const GpuState::ShadowGenerator& shadow_generator_for_row(const GpuState& state,
                                                          const upstream::PinnedShadowBinding& row);

/** The sampler row declared beside one light's map. */
const upstream::PinnedShadowBinding*
shadow_sampler_row_for(std::span<const upstream::PinnedShadowBinding> rows, std::uint32_t light);

/**
 * Resolve one stage's slot names against a family's composed rows, once.
 *
 * The per-name walk `shadow_row_for` makes runs here once per variant
 * stage, beside the slot cache each family's `ensure_*_slots` fills; the
 * draw path then indexes the result. A map row's companion sampler row is
 * resolved with it -- SDL_GPU binds a texture and its sampler as one pair,
 * and which sampler a map takes is the paired row's to say: a PCF map's
 * companion is declared `sampler_comparison`, an ESM map's a plain
 * `sampler`. A map row with no sampler row beside it fails here by name,
 * the same refusal the draw path used to make.
 */
PinnedStageShadowRows
resolve_stage_shadow_rows(const PinnedStageSlots& slots,
                          std::span<const upstream::PinnedShadowBinding> rows);

/**
 * The receiver block one cached row names, or null for a slot that is not
 * a shadow binding.
 *
 * The buffer half of `shadow_resource_at`'s question: the vertex stage reads
 * the block as a uniform and the fragment as a storage buffer, because the
 * shader compile demotes it out of SDL_GPU's four uniform slots -- so both
 * stages ask through one lookup, for both material families. The generator
 * itself stays a per-draw read: `state.shadow_generators` is runtime state.
 */
SDL_GPUBuffer* shadow_info_buffer_at(const GpuState& state,
                                     const upstream::PinnedShadowBinding* row);

/** The same block as uniform bytes, for the stage that kept it a uniform. */
PinnedStageBlock shadow_info_uniform_at(const GpuState& state,
                                        const upstream::PinnedShadowBinding* row);

/**
 * The map-and-sampler pair one stage texture slot resolves to, or an empty
 * pair when that slot is not a receiver binding.
 */
PinnedResource shadow_resource_at(const GpuState& state, const PinnedStageShadowRows& rows,
                                  std::size_t slot);

/**
 * Wrap a family's uniform resolver with the receiver-block fallback.
 *
 * Every receiving family's `push_stage_uniforms` walk answers the same
 * way: the family's own blocks first, then the receiver block the cached
 * row for this slot names -- or the walk's by-name refusal when that row
 * is null. The families differ only in which rows they cached, so the
 * fallback is stated once and each stage passes its own rows.
 */
template <typename Resolve>
auto with_shadow_uniform_rows(const GpuState& state, const PinnedStageShadowRows& rows,
                              Resolve resolve) {
    return
        [&state, &rows, resolve](const std::string& block, std::size_t slot) -> PinnedStageBlock {
            const PinnedStageBlock resolved = resolve(block);
            if (resolved.data != nullptr)
                return resolved;
            return shadow_info_uniform_at(state, rows.uniforms[slot]);
        };
}

#endif

#if BBLITE_SHADOWS_ESM
/**
 * The ESM caster's own params block, from the generator its material view
 * was built for.
 *
 * `getEsmShadowView` closes over that generator's `_shadowParamsUBO`; the
 * blur that owns it is found by the generator's ESM ordinal rather than by
 * its handle. Every family's caster reads the same block, so the lookup is
 * stated once.
 */
const GpuState::EsmBlur* esm_caster_params_for(const GpuState& state, const Engine& engine,
                                               const MaterialRecord* material);
#endif

/**
 * The scene-owned pair one slot source names, or an empty pair.
 *
 * A source outside the mesh's own slots is served by something this backend
 * holds for the whole scene, and every composed family -- PBR, Standard and
 * node alike -- wants the same answer, so the pairing is stated once here
 * rather than per family.
 */
[[maybe_unused]] PinnedResource state_resource_for(const GpuState& state,
                                                   upstream::MaterialTextureSource source);
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
[[maybe_unused]] void apply_pass_depth_state(SDL_GPUGraphicsPipelineCreateInfo& info,
                                             const GpuState& state, bool shadow_pass,
                                             std::optional<SDL_GPUSampleCount> task_samples = {},
                                             std::optional<ShaderTaskTarget> target = {});

#if BBLITE_PBR_VARIANTS > 0 || BBLITE_STANDARD_VARIANTS > 0 || BBLITE_NODE_GEOMETRY_VARIANTS > 0
/**
 * The MRT colour targets one geometry-output pipeline draws into, for
 * whichever family composed it.
 *
 * All three answer this the same way: one target per attachment class the
 * shared `geometry_target_classes` list carries, then the optional
 * trailing colour output in the frame's own format, at the task's sample
 * count and with the geometry pass's depth write forced on whatever the
 * material's own alpha would have said. `blend` is the family's transparent
 * blend state, or null for a draw that does not blend.
 *
 * The node family reaches the same body through a strict subset: a geometry
 * view is compiled at the pin's alpha mode 0 (so `blend` is null and the
 * depth write was already on) and `createNodeGeometryMaterialView` refuses
 * `emitColor`, so its task carries no trailing output -- and if one ever
 * did, the shared count assertion below refuses before a target is built.
 *
 * `targets` is the caller's storage because `info` holds a pointer into it
 * until the pipeline is created.
 */
void apply_geometry_color_targets(SDL_GPUGraphicsPipelineCreateInfo& info,
                                  std::vector<SDL_GPUColorTargetDescription>& targets,
                                  const GpuState& state, const FrameTaskRecord& task,
                                  std::size_t entry_color_target_count, const char* family,
                                  const SDL_GPUColorTargetBlendState* blend);
#endif

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
SDL_GPUTexture* upload_environment(SDL_GPUDevice* device, const EnvironmentState& environment,
                                   std::uint32_t layers = 6, bool cube_array = false,
                                   std::shared_ptr<ComputeTextureAllocation>* borrowed = nullptr);

#if BBLITE_LOCAL_CUBEMAP
GpuState::LocalCubemap* ensure_local_cubemap(GpuState& state, const MaterialRecord* material);
#endif

PinnedResource
pinned_resource_for(GpuState& state, const GpuMesh& mesh, const std::string& name,
                    [[maybe_unused]] std::size_t variant,
                    // Which stage's texture list the name came from, and its index there:
                    // the pair that makes the group-2 fallback below a cached-row index.
                    [[maybe_unused]] bool fragment, [[maybe_unused]] std::size_t stage_slot,
                    [[maybe_unused]] const MaterialRecord* material = nullptr);

/**
 * Load a variant's slot maps if they are not loaded.
 *
 * Separate from the pipeline because the draw path reads them before it decides
 * whether to take the pinned branch: how many uniform blocks a stage ended up
 * with is one of the properties it gates on.
 */
void ensure_pinned_slots(GpuState& state, std::size_t variant);

/** The stem the shader compiler deployed a variant's stage under. */
inline std::string pinned_stage_name(std::string_view file) {
    return "variant-" + std::string(file.substr(0, file.find(".wgsl")));
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
SDL_GPUGraphicsPipeline*
pinned_variant_pipeline(GpuState& state, std::size_t variant, upstream::RenderPipelineKind kind,
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
                        bool shadow_pass = false,
                        // Which ESM generator's map this pass writes, when it writes one: a
                        // caster's colour target is that generator's own recorded row.
                        std::uint32_t esm_shadow_index = invalid_handle,
                        std::optional<SDL_GPUSampleCount> task_samples = {},
                        std::optional<ShaderTaskTarget> target = {});

#endif

#if BBLITE_GPU_MORPH_STORAGE
/** Publish the same dirty pose before a visible draw or a same-turn pick. */
void sync_morph_weights(GpuBufferUploadBatch& uploads, GpuMesh& mesh, const ModelGeometry& geometry,
                        const MeshRecord& record);
#endif

/** The shared vertex stage's world and optional skin/morph uniforms. */
void push_mesh_stage_blocks(SDL_GPUCommandBuffer* command, const Scene& scene, const Engine& engine,
                            const MeshRecord& mesh);

#if BBLITE_PBR_VARIANTS > 0 || BBLITE_STANDARD_SKELETON
/**
 * One rgba32float upload through this backend's copy pass, staged through
 * the state's one transfer buffer: a pose streams every frame, so the
 * buffer is kept and grown rather than created and released per upload.
 * Mapping with `cycle` lets SDL hand out fresh backing when a submitted
 * upload still reads the previous contents.
 */
void upload_pinned_float_texture(GpuState& state, SDL_GPUTexture* texture, const float* data,
                                 std::uint32_t width, std::uint32_t height, std::uint32_t bytes);

SDL_GPUTexture* create_pinned_float_texture(GpuState& state, std::uint32_t width,
                                            std::uint32_t height, const char* label);

/**
 * The nearest-clamp sampler every palette row is read through.
 *
 * The palettes are `textureLoad`ed, but this backend still pairs a sampler
 * with each binding, so the live palette and the baked one share this one.
 */
void ensure_pinned_bone_sampler(GpuState& state);

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
void write_pinned_bone_texture(GpuState& state, GpuMesh& mesh, const MeshRecord& record);

#endif

#if BBLITE_PBR_VARIANTS > 0
#if BBLITE_VAT
/**
 * The baked VAT as the pin's own texture.
 *
 * `bakeVat` stacks one palette row per animation frame into an
 * rgba32float texture of `boneCount * 4` texels by `frameCount` rows --
 * byte for byte what the live path uploads as its one-row palette, which
 * is why VAT(frame N) reproduces the live pose. The bake is settled before
 * the first frame, so this uploads once; only the per-instance params can
 * change afterwards and they carry their own version.
 */
void write_pinned_vat_texture(GpuState& state, GpuMesh& mesh, const MeshRecord& record,
                              const Engine& engine);
#endif

/**
 * Draws one PBR command through the pin's own composed stages.
 *
 * Shared by the main pass and the render-task passes: the blocks build from
 * the pass's own camera and matrix, and everything else -- slots, textures,
 * the skinned and palette-world conventions -- is per draw.
 */
void draw_pinned_variant(GpuState& state, SDL_GPUCommandBuffer* command, SDL_GPURenderPass* pass,
                         const Scene& scene, const Engine& engine,
                         // The pass's scene and lights blocks, built once per pass by the
                         // caller (Dawn builds both per frame): their builders run camera and
                         // view math that must not repeat per draw.
                         const upstream::SceneUniforms& pinned_scene,
                         const std::vector<std::uint8_t>& pinned_lights,
                         const upstream::RenderDrawCommand& draw, const GpuMesh& mesh,
                         const MaterialRecord* material, std::size_t pinned_variant,
                         SDL_GPUGraphicsPipeline*& bound_pipeline,
                         // Set for a draw inside a geometry-output task: the task whose targets
                         // the MRT pipeline binds, and the pin's gpUniforms block when the
                         // variant declares one.
                         const FrameTaskRecord* geometry_task = nullptr,
                         const PinnedGeometryParams* geometry_params = nullptr,
                         // The same block as a buffer, for a fragment whose `gp` the shader
                         // compile demoted out of the four uniform slots.
                         SDL_GPUBuffer* geometry_params_buffer = nullptr,
                         // Set when this draw is a caster in a shadow pass, which takes the
                         // pin's standard-Z depth state rather than this port's reverse-Z.
                         bool shadow_pass = false,
                         // The generator whose map that pass writes, when it writes one.
                         std::uint32_t esm_shadow_index = invalid_handle,
                         std::optional<SDL_GPUSampleCount> task_samples = {},
                         std::optional<ShaderTaskTarget> target = {});
#endif

#if BBLITE_NODE_VARIANTS > 0
void ensure_node_slots(GpuState& state, std::size_t slot);

/**
 * The pipeline for one compiled node graph.
 *
 * Its two stages are one module entered twice, so both load under the
 * graph's own file names; the vertex inputs are named rather than
 * positional, because the pin's pipeline builder numbers them by emission
 * order rather than by a fixed convention.
 */
SDL_GPUGraphicsPipeline*
node_variant_pipeline(GpuState& state, std::size_t variant, upstream::RenderPipelineKind kind,
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
                      // the slot-keyed cache stays valid with that task's targets baked in --
                      // the same reason the two material families key theirs on the variant.
                      [[maybe_unused]] const FrameTaskRecord* geometry_task = nullptr,
                      std::size_t geometry_variant = pal::no_node_geometry_variant,
                      std::optional<ShaderTaskTarget> target = {});

/**
 * Draws one node command through the graph's own compiled stages.
 *
 * The blocks are pushed by the names the register remap published beside
 * each stage: the pin's `scene` and `nmeLights` in group 0, its `meshU` and
 * the graph's `nodeU` in group 1. A name the resolver cannot map pushes
 * nothing and fails loudly rather than pushing a neighbour's bytes.
 */
void draw_node_variant(GpuState& state, SDL_GPUCommandBuffer* command, SDL_GPURenderPass* pass,
                       const Scene& scene, const Engine& engine,
                       // The pass's scene and lights blocks, built once per pass by the
                       // caller alongside the other composed families'.
                       const upstream::SceneUniforms& pinned_scene,
                       const std::vector<std::uint8_t>& pinned_lights,
                       const upstream::RenderDrawCommand& draw, const GpuMesh& mesh,
                       std::size_t variant, SDL_GPUGraphicsPipeline*& bound_pipeline,
                       bool shadow_pass = false,
                       // The material this draw resolved to, whose ESM bit selects the graph's
                       // caster view over its receiver one.
                       [[maybe_unused]] const MaterialRecord* material = nullptr,
                       // The generator whose map this pass writes, when it writes one.
                       std::uint32_t esm_shadow_index = invalid_handle,
                       // The geometry-output task this draw is inside, with the task's own
                       // gpUniforms in both the shapes a stage can read it: the block the
                       // register remap keeps as a uniform, and the buffer it demotes to
                       // storage once four uniform slots are spent.
                       [[maybe_unused]] const FrameTaskRecord* geometry_task = nullptr,
                       [[maybe_unused]] const PinnedGeometryParams* geometry_params = nullptr,
                       [[maybe_unused]] SDL_GPUBuffer* geometry_params_buffer = nullptr,
                       std::optional<ShaderTaskTarget> target = {});
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
/**
 * One ESM generator's blur halves and the pipeline that fills them.
 *
 * Every descriptor is what the pinned factory asked its device for when
 * generation ran it -- the two extents, their format, and the two texel
 * steps -- so nothing about the blur is decided here. Built once, on the
 * frame the generator's own colour map first exists.
 */
GpuState::EsmBlur& ensure_esm_blur(GpuState& state, const ShadowGeneratorRecord& generator,
                                   SDL_GPUTexture* source);

/** The pin's two blur passes, run straight after the caster pass. */
void run_esm_blur(GpuState& state, SDL_GPUCommandBuffer* command, std::uint32_t esm_index);
#endif

void update_shadow_generators(GpuState& state, const Scene& scene, Engine& engine);
#endif

#if BBLITE_STANDARD_VARIANTS > 0
/** The stem the shader compiler deployed a Standard variant's stage under. */
inline std::string standard_stage_name(std::string_view file) {
    return "variant-std-" + std::string(file.substr(0, file.find(".wgsl")));
}

void ensure_standard_slots(GpuState& state, std::size_t variant);

/**
 * Which of our resources the pin's own name for a Standard binding refers
 * to. The name->slot rows are the generated `standard_binding_resources`;
 * the cube reflection pair and the two render-texture slots are the
 * resources outside the material slot table.
 */

PinnedResource standard_resource_for(GpuState& state, const GpuMesh& mesh,
                                     const MaterialRecord* material,
                                     const StandardRenderTextures& render_textures,
                                     const std::string& name, [[maybe_unused]] std::size_t variant,
                                     [[maybe_unused]] bool fragment,
                                     // The name's index in its stage's texture list.
                                     [[maybe_unused]] std::size_t stage_slot);

/**
 * The graphics pipeline for one composed Standard variant under one
 * pipeline kind — the Standard sibling of `pinned_variant_pipeline`. The
 * kind carries the blend and cull state the render plan bucketed
 * (standard-pipeline.ts getOrCreateStandardPipeline: needsBlend =
 * HAS_OPACITY_TEXTURE || MATERIAL_ALPHA_BLEND, cull = DOUBLE_SIDED), and
 * depth writes turn off only when blending.
 */
SDL_GPUGraphicsPipeline*
standard_variant_pipeline(GpuState& state, std::size_t variant, upstream::RenderPipelineKind kind,
                          const FrameTaskRecord* geometry_task = nullptr,
                          // The pin's one exception to this port's depth convention: a shadow
                          // caster pass renders standard-Z into the generator's own
                          // `depth32float` map, at one sample.
                          bool shadow_pass = false,
                          // Which ESM generator's map this pass writes, when it writes one.
                          std::uint32_t esm_shadow_index = invalid_handle,
                          std::optional<SDL_GPUSampleCount> task_samples = {},
                          std::optional<ShaderTaskTarget> target = {});

/**
 * Draws one Standard command through the pin's own composed stages — the
 * Standard sibling of `draw_pinned_variant`, sharing the scene and lights
 * blocks with the PBR family and binding the slot-name blocks the remap
 * assigned: `scene`, `lights`, `mesh`, `mat`, `up` and the geometry arms'
 * `gp`.
 */
void draw_standard_variant(GpuState& state, SDL_GPUCommandBuffer* command, SDL_GPURenderPass* pass,
                           const Scene& scene, const Engine& engine,
                           // The pass's scene and lights blocks, built once per pass by the
                           // caller (Dawn builds both per frame): their builders run camera and
                           // view math that must not repeat per draw.
                           const upstream::SceneUniforms& pinned_scene,
                           const std::vector<std::uint8_t>& pinned_lights,
                           const upstream::RenderDrawCommand& draw, const GpuMesh& mesh,
                           const MaterialRecord* material, std::size_t variant,
                           // The feature word the selector already derived for this draw
                           // (`standard_variant_key`), passed through rather than re-derived.
                           std::uint32_t features, SDL_GPUGraphicsPipeline*& bound_pipeline,
                           const FrameTaskRecord* geometry_task = nullptr,
                           const PinnedGeometryParams* geometry_params = nullptr,
                           StandardRenderTextures render_textures = {},
                           SDL_GPUBuffer* geometry_params_buffer = nullptr,
                           // The geometry task's velocity history, updated for this frame.
                           const PinnedVelocityHistory* velocity_history = nullptr,
                           // Drawing the shadow map, so the pipeline renders standard-Z into the
                           // generator's own single-sample depth32float target.
                           bool shadow_pass = false,
                           // The generator whose map that pass writes, when it writes one.
                           std::uint32_t esm_shadow_index = invalid_handle
#if BBLITE_HAS_TAA
                           ,
                           std::vector<PreparedSdlDraw>* deferred = nullptr,
                           const std::shared_ptr<PersistentSceneUniforms>& deferred_scene = {}
#endif
                           ,
                           std::optional<SDL_GPUSampleCount> task_samples = {},
                           std::optional<ShaderTaskTarget> target = {});
#endif

struct ImageProcessingUniforms {
    float parameters[4];
};

// The shared material stage's `mesh` block, after its scene matrix and its
// deformation block.
#if BBLITE_GPU_DEFORMATION
constexpr Uint32 mesh_world_uniform_slot = 2;
#else
constexpr Uint32 mesh_world_uniform_slot = 1;
#endif

/** The SDL enumerator for one shared block format. */
SDL_GPUTextureFormat compressed_texture_format(std::string_view name);

/**
 * A texture whose bytes are already blocks: the container's own mip chain,
 * uploaded level by level with nothing decoded and nothing generated.
 */
SDL_GPUTexture* upload_compressed_texture(SDL_GPUDevice* device,
                                          const CompressedTexture& compressed);

SDL_GPUTexture* upload_texture(SDL_GPUDevice* device, const TextureData& texture_data, bool srgb,
                               std::array<std::uint8_t, 4> fallback);

SDL_GPUTexture* upload_cube_texture(SDL_GPUDevice* device,
                                    const std::array<TextureData, 6>* texture_data);

SDL_GPUTexture* upload_rgbd_texture(SDL_GPUDevice* device, const TextureData& texture_data);

SDL_GPUTexture* upload_brdf_lut(SDL_GPUDevice* device, const EnvironmentState& environment);

SDL_GPUTexture* upload_environment(SDL_GPUDevice* device, const EnvironmentState& environment,
                                   std::uint32_t layers, bool cube_array,
                                   std::shared_ptr<ComputeTextureAllocation>* borrowed);

#if BBLITE_PINNED_BACKGROUNDS
SDL_GPUTexture* upload_dds_skybox(SDL_GPUDevice* device, const EnvironmentState& environment);

SDL_GPUVertexElementFormat pinned_vertex_format(upstream::PinnedVertexFormat format);

/**
 * Build every background arm the run draws: its pipeline over `base` (the
 * pass's formats, sample count and depth test) with the arm's own vertex
 * layouts, rasterizer, depth write and blend, and its buffers from the
 * lowered builders. The texture an arm samples is the one its factory binds:
 * the ground's own image, the DDS skybox's cube, the environment's specular
 * cube for the .env arm, and the image skybox's six faces.
 */
void create_background_arms(GpuState& state, const Scene& scene,
                            const SDL_GPUGraphicsPipelineCreateInfo& base,
                            const SDL_GPUColorTargetDescription& base_target);

/**
 * Draw one arm the way the pin's renderable does: its pipeline, the pass's
 * scene block and its own mesh block at the uniform slots each stage kept,
 * one buffer per vertex slot, the index buffer at the pin's width, and the
 * whole index range once.
 */
void draw_background_arm(SDL_GPUCommandBuffer* command, SDL_GPURenderPass* pass,
                         const GpuBackgroundArm& arm, const upstream::SceneUniforms& scene_block);
#endif

void release_sized_texture(GpuState& state, SDL_GPUTexture*& texture, std::uint32_t& width,
                           std::uint32_t& height);

void create_depth(GpuState& state, std::uint32_t width, std::uint32_t height);

void create_msaa_color(GpuState& state, SDL_GPUTextureFormat format, std::uint32_t width,
                       std::uint32_t height);

void create_color(GpuState& state, SDL_GPUTextureFormat format, std::uint32_t width,
                  std::uint32_t height);

#if BBLITE_RENDERER_TRANSMISSION
/** The image-processing resolve's target: the transmission frame's output. */
void create_processed_color(GpuState& state, SDL_GPUTextureFormat format, std::uint32_t width,
                            std::uint32_t height);

void create_transmission_color(GpuState& state);
#endif

inline SDL_GPUSampleCount task_sample_count(const GpuState& state, std::uint32_t requested) {
    return requested == 4 ? state.sample_count : SDL_GPU_SAMPLECOUNT_1;
}

inline SDL_GPUTextureFormat geometry_texture_format(const GeometryTextureDescription& description) {
    return texture_format(geometry_format_class(description));
}

inline SDL_FColor geometry_clear_color(GeometryTextureType type) {
    const float value = geometry_clear_component(type);
    return SDL_FColor{value, value, value, value};
}

// Metal's float view of depth expands to (d,d,d,1). Material slots need
// (d,0,0,1), matching the shared R32 depth-copy contract used by Dawn.
void encode_metal_depth_copy(GpuState& state, SDL_GPUCommandBuffer* command,
                             const GpuRenderTarget& target);

void release_render_target(SDL_GPUDevice* device, GpuRenderTarget& target);

std::shared_ptr<GpuRenderTarget> retain_render_target(SDL_GPUDevice* device,
                                                      GpuRenderTarget& target);

void release_frame_graph_textures(GpuState& state, const Engine* preserve = nullptr);

SDL_GPUTextureFormat depth_texture_format(const GpuState& state, const RenderTargetRecord& record);

void create_frame_graph_textures(GpuState& state, const Engine& engine,
                                 SDL_GPUTextureFormat surface_format, std::uint32_t width,
                                 std::uint32_t height);

void save_geometry_id_buffer_png(GpuState& state, std::uint32_t width, std::uint32_t height,
                                 const std::array<float, 16>& view_projection,
                                 const std::vector<upstream::RenderItem>& render_plan,
                                 const Scene& scene, const Engine& engine, const std::string& path,
                                 bool cluster_ids);

// Release every GPU resource a mesh entry owns. Used by shutdown and
// by runtime scene removal, which drops entries mid-run (SDL defers the
// actual destruction until the GPU is done with them).
void release_gpu_mesh_resources([[maybe_unused]] GpuState* state, GpuMeshResources& mesh) noexcept;

inline void release_gpu_mesh(GpuState&, GpuMesh& mesh) { mesh.reset(); }

void prune_shared_shader_geometries(GpuState& state);

void prune_shared_shader_material_textures(GpuState& state);

void prune_shared_composed_material_textures(GpuState& state);

void release(GpuState& state);

#if BBLITE_HAS_POST_PROCESS

/**
 * The program a post-process pass draws with, built once per distinct one.
 *
 * A pass is identified as a drawing by its deployed module and the pipeline
 * state its output implies; everything else about it -- which textures it
 * binds, what its uniform block holds -- is per pass and stays there. A
 * composite's chain repeats the first and varies the second, so depth of
 * field's six blurs share one entry here. The find-or-create walk is the
 * shared `find_or_create_program`; only the key equality is this backend's.
 */
std::size_t post_process_program(GpuState& state, std::uint32_t module_index,
                                 SDL_GPUTextureFormat format, SDL_GPUSampleCount samples,
                                 std::uint32_t alpha_mode);

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
struct PreparedSdlPostProcessPass {
    TaskHandle task{};
    std::size_t child = 0;
    SDL_GPUGraphicsPipeline* pipeline = nullptr;
    SDL_GPUColorTargetInfo target{}, present_target{};
    SDL_GPUViewport viewport{};
    SDL_Rect scissor{};
    bool has_viewport = false, presents = false;
    bool vertex_uniforms = false, fragment_uniforms = false;
    std::array<SDL_GPUTextureSamplerBinding, max_post_process_textures> textures{};
    Uint32 texture_count = 0;
};

void write_sdl_gpu_post_process_uniforms(GpuState& state, Engine& engine, TaskHandle handle,
                                         std::size_t index, std::uint32_t width,
                                         std::uint32_t height);

/** Resource and CPU work completes here; encoding only consumes this packet. */
template <typename SourceTexture, typename TargetTexture>
PreparedSdlPostProcessPass
prepare_post_process_pass(GpuState& state, Engine& engine, TaskHandle handle,
                          SDL_GPUTexture* swapchain, SDL_GPUTextureFormat swapchain_format,
                          std::uint32_t width, std::uint32_t height, std::size_t index,
                          SourceTexture source_texture, TargetTexture target_texture,
                          bool write_uniforms = true) {
    PreparedSdlPostProcessPass prepared;
    prepared.task = handle;
    prepared.child = index;
    PostProcessPassOptions& pass = handle_at(engine.frame_tasks, handle).post_process.passes[index];
    const upstream::PostProcessShaderInfo& shader_info =
        upstream::post_process_shader_infos[pass.shader_index];
    GpuPostProcessTask& gpu = handle_at(state.post_process_tasks, handle)[index];
    const RenderTargetRecord& output_record = handle_at(engine.render_targets, pass.output_target);
    const PostProcessExtent extent =
        resolve_post_process_extent(output_record, state.render_targets, pass, width, height);
    const std::uint32_t output_width = extent.output_width;
    const std::uint32_t output_height = extent.output_height;
    // A swapchain texture cannot be read back, so a pass
    // that presents renders into this readable copy and
    // blits it, which is also what the capture reads.
    const bool presents = output_record.swapchain;
    if (presents && !state.post_process_present) {
        state.post_process_present = create_frame_texture(
            state.device, swapchain_format, SDL_GPU_SAMPLECOUNT_1, width, height,
            SDL_GPU_TEXTUREUSAGE_COLOR_TARGET | SDL_GPU_TEXTUREUSAGE_SAMPLER);
    }
    if (gpu.program == npos) {
        // A pass writes into its own output, whose format the frame graph
        // already resolved -- a composite's intermediate may name its own
        // (the circle-of-confusion map is r16) or follow its source's. The
        // pin builds the pipeline against that target's own sample count and
        // resolves nothing; what it refuses is a multisampled *source*.
        gpu.program = post_process_program(
            state, shader_info.module_index,
            handle_at(state.render_targets, pass.output_target).color_format,
            presents ? SDL_GPU_SAMPLECOUNT_1 : task_sample_count(state, output_record.samples),
            pass.alpha_mode);
        gpu.uniform_data.assign(((shader_info.uniform_byte_length + 15u) & ~15u) / 4u, 0.0f);
        const GpuPostProcessProgram& created = state.post_process_programs[gpu.program];
        std::size_t extra_slot = 0;
        gpu.texture_sources.reserve(created.fragment_slots.textures.size());
        for (const std::string& name : created.fragment_slots.textures) {
            if (name == "sourceTextureSampler") {
                gpu.texture_sources.push_back(-1);
                continue;
            }
            if (extra_slot >= pass.extra_textures.size()) {
                throw std::runtime_error("Post-process stage declares a "
                                         "texture the pass does not carry: " +
                                         name);
            }
            gpu.texture_sources.push_back(static_cast<int>(extra_slot++));
        }
    }
    const GpuPostProcessProgram& program = state.post_process_programs[gpu.program];
    if (write_uniforms)
        write_sdl_gpu_post_process_uniforms(state, engine, handle, index, width, height);
    prepared.vertex_uniforms = !program.vertex_slots.uniforms.empty();
    prepared.fragment_uniforms = !program.fragment_slots.uniforms.empty();
    prepared.pipeline = program.pipeline.get();
    // No dirty flag on this backend: SDL_GPU uniforms are
    // pushed per command buffer, so the block is written
    // every frame either way. The flag is Dawn's, whose
    // uniform buffer persists between frames.
    SDL_GPUColorTargetInfo& pass_target = prepared.target;
    pass_target.texture =
        presents ? state.post_process_present : target_texture(pass.output_target, false);
    // The pin leaves the attachment's clear value at
    // WebGPU's default, which is transparent black.
    pass_target.load_op = pass.clear ? SDL_GPU_LOADOP_CLEAR : SDL_GPU_LOADOP_LOAD;
    pass_target.clear_color = SDL_FColor{0.0f, 0.0f, 0.0f, 0.0f};
    pass_target.store_op = SDL_GPU_STOREOP_STORE;
    prepared.has_viewport = pass.has_viewport;
    if (pass.has_viewport) {
        const PixelViewport rectangle =
            upstream::resolve_post_process_viewport(pass.viewport, output_width, output_height);
        prepared.viewport = SDL_GPUViewport{
            static_cast<float>(rectangle.x),
            static_cast<float>(rectangle.y),
            static_cast<float>(rectangle.width),
            static_cast<float>(rectangle.height),
            0.0f,
            1.0f,
        };
        prepared.scissor = SDL_Rect{
            rectangle.x,
            rectangle.y,
            rectangle.width,
            rectangle.height,
        };
    }
    // The pin binds one sampler for every texture the
    // stage reads; this backend pairs each with its own
    // texture, so the pair repeats the same sampler.
    SDL_GPUSampler* pass_sampler = pass.sampling == PostProcessSampling::nearest
                                       ? state.post_process_nearest_sampler
                                       : state.post_process_bilinear_sampler;
    if (gpu.texture_sources.size() > prepared.textures.size()) {
        throw std::runtime_error("Post-process stage exceeds SDL_GPU's texture slot capacity.");
    }
    prepared.texture_count = static_cast<Uint32>(gpu.texture_sources.size());
    for (std::size_t slot = 0; slot < gpu.texture_sources.size(); ++slot) {
        const int source = gpu.texture_sources[slot];
        prepared.textures[slot] = SDL_GPUTextureSamplerBinding{
            source_texture(source < 0 ? pass.source
                                      : pass.extra_textures[static_cast<std::size_t>(source)]),
            pass_sampler};
    }
    prepared.presents = presents;
    if (presents) {
        prepared.present_target.texture = swapchain;
        prepared.present_target.load_op = SDL_GPU_LOADOP_DONT_CARE;
        prepared.present_target.store_op = SDL_GPU_STOREOP_STORE;
    }
    return prepared;
}

void encode_post_process_pass(GpuState& state, SDL_GPUCommandBuffer* command,
                              const PreparedSdlPostProcessPass& prepared,
                              SDL_GPUTexture*& capture_texture);

template <typename SourceTexture, typename TargetTexture>
void record_post_process_pass(GpuState& state, Engine& engine, TaskHandle handle,
                              SDL_GPUCommandBuffer* command, SDL_GPUTexture* swapchain,
                              SDL_GPUTextureFormat swapchain_format, std::uint32_t width,
                              std::uint32_t height, std::size_t index,
                              SDL_GPUTexture*& capture_texture, SourceTexture source_texture,
                              TargetTexture target_texture) {
    const auto prepared =
        prepare_post_process_pass(state, engine, handle, swapchain, swapchain_format, width, height,
                                  index, source_texture, target_texture);
    encode_post_process_pass(state, command, prepared, capture_texture);
}
#endif

#if BBLITE_HAS_SCREEN_SPACE
/** Builds the entry `screen_space_program` below found missing. */
GpuScreenSpaceProgram build_screen_space_program(GpuState& state, std::uint32_t stage);

std::size_t screen_space_program(GpuState& state, std::uint32_t stage);

/**
 * The texture a stage binding reads, by the role the pin bound there: the
 * depth attachment itself (a depth-only view in the pin, the depth texture's
 * own SRV here), the lit source colour, or one of the task's owned targets.
 */
SDL_GPUTexture* screen_space_binding_texture(GpuState& state, const ScreenSpaceTaskOptions& task,
                                             upstream::ScreenSpaceTextureRole role);

/**
 * A pass over one temporal target, cleared to zero: what every dedicated
 * stage draws into and what the identity clear leaves empty.
 */
SDL_GPURenderPass* begin_screen_space_pass(SDL_GPUCommandBuffer* command, SDL_GPUTexture* target);

/**
 * One dedicated stage: the pin's clear-and-draw over a fullscreen triangle,
 * with the block pushed as the stage's one uniform and every texture the
 * compaction kept bound by the role its program resolved for the slot. The
 * pin binds one bilinear sampler wherever it samples; each SRV here pairs
 * with it.
 */
void record_screen_space_stage(GpuState& state, const ScreenSpaceTaskOptions& task,
                               std::size_t program_index, SDL_GPUCommandBuffer* command,
                               SDL_GPUTexture* target, const float* uniforms);

/** The pin's `clearIdentity`: one clear-only pass over a temporal target. */
inline void clear_screen_space_target(SDL_GPUCommandBuffer* command, SDL_GPUTexture* texture) {
    SDL_EndGPURenderPass(begin_screen_space_pass(command, texture));
}

/**
 * One screen-space task, in the pin's own `execute` order: the generated
 * frame function samples the task's live settings and advances its temporal
 * state, and what it decided is encoded here -- the identity clear on the
 * enabled-to-disabled transition or a singular view-projection inverse,
 * then producer, resolve and history copy when the effect runs, then the
 * composite whenever the task has one.
 */
template <typename SourceTexture, typename TargetTexture>
void record_screen_space_task(GpuState& state, Engine& engine, TaskHandle handle,
                              SDL_GPUCommandBuffer* command, SDL_GPUTexture* swapchain,
                              SDL_GPUTextureFormat swapchain_format, std::uint32_t width,
                              std::uint32_t height, SDL_GPUTexture*& capture_texture,
                              SourceTexture source_texture, TargetTexture target_texture) {
    FrameTaskRecord& record = handle_at(engine.frame_tasks, handle);
    const ScreenSpaceTaskOptions& task = record.screen_space;
    const GpuRenderTarget& raw = handle_at(state.render_targets, task.raw);
    const GpuRenderTarget& stable = handle_at(state.render_targets, task.stable);
    const GpuRenderTarget& history = handle_at(state.render_targets, task.history);
    const ScreenSpaceFrameDecision decision = upstream::screen_space_frame(
        engine, handle, screen_space_frame_inputs(state.render_targets, task));
    record_screen_space_decision(
        decision, record.post_process.passes.size() > 1,
        [&](bool previous) {
            clear_screen_space_target(command, previous ? history.color : stable.color);
        },
        [&](bool producer, const float* uniforms) {
            record_screen_space_stage(
                state, task,
                screen_space_program(state, producer ? task.producer_shader : task.resolve_shader),
                command, producer ? raw.color : stable.color, uniforms);
        },
        [&](std::size_t child) {
            record_post_process_pass(state, engine, handle, command, swapchain, swapchain_format,
                                     width, height, child, capture_texture, source_texture,
                                     target_texture);
        });
}
#endif

} // namespace sdl_scene
#endif

#if BBLITE_HAS_PICKING
/**
 * The two pick pipelines, built on first use.
 *
 * Both target the pin's own pair -- an `rgba8unorm` id and an `r32float`
 * depth -- over a `depth24plus` buffer cleared to 0. The mesh pipeline
 * compares GREATER because this port and the pin both render reverse-Z; the
 * cloud pipeline compares LESS, which is the pin's own choice and is kept
 * rather than reconciled: its vertex stage passes clip depth through a
 * shear that leaves z alone, and changing the comparison would change which
 * splat wins the pixel.
 */
void ensure_pick_pipelines(GpuState& state);

#if BBLITE_HAS_SPLATS
/**
 * One cloud's pick draw: the pin's own splat draw with the shear applied
 * after its clip position and the pick colour in place of the blended one.
 */
void record_cloud_pick_draw(SDL_GPUCommandBuffer* command, SDL_GPURenderPass* pass,
                            const GpuState& state, const Engine& engine, const SplatPass& splat,
                            const CameraRecord& camera, std::uint32_t pick_id, double sample_x,
                            double sample_y, double width, double height);
#endif
#endif

#if BBLITE_HAS_PBR_RENDERER
GpuMesh upload_sdl_gpu_scene_mesh(GpuState& state, Engine& engine, const upstream::RenderItem& item,
                                  GpuBufferUploadBatch* buffer_uploads = nullptr);

#if BBLITE_HAS_SPRITE_RENDERER
void sync_sdl_gpu_scene_sprites(GpuState& state, Engine& engine,
                                std::vector<SpritePass>& sprite_passes,
                                std::vector<SDL_GPUTexture*>& sprite_render_textures,
                                SDL_GPUTextureFormat swapchain_format);
#endif
#endif

#if BBLITE_HAS_PBR_RENDERER && BBLITE_HAS_PICKING
PickingInfo pick_sdl_gpu_scene(GpuState& state, Engine& engine,
                               const upstream::RenderPlan& root_plan,
                               const std::vector<upstream::RenderPlan>& overlay_plans,
                               const std::vector<std::shared_ptr<Scene>>& active_registered_scenes,
                               [[maybe_unused]] GpuPickerHandle picker, double x, double y,
                               const Engine::PickFilter* filter
#if BBLITE_HAS_BILLBOARDS
                               ,
                               BillboardPickContributor& billboard_pick
#endif
);
#endif

} // namespace bbl::pal
