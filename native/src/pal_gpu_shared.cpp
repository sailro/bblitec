// The bodies of the scene-shaped helpers both GPU backends share, one
// section per concern header in pal_gpu_shared.hpp's order. They read the
// scene's generated headers, so this unit compiles once per scene -- once,
// rather than in every backend unit that includes the headers.
#include <bblite/features/has_billboards.hpp>
#include <bblite/features/has_detailed_picking.hpp>
#include <bblite/features/has_pbr_renderer.hpp>
#include <bblite/features/has_picking.hpp>
#include <bblite/features/has_screen_space.hpp>
#include <bblite/features/has_splats.hpp>
#include <bblite/features/has_sprite_renderer.hpp>
#include <bblite/features/has_sprites.hpp>
#include <bblite/features/has_standard_uv_transform.hpp>
#include <bblite/features/has_ui.hpp>
#include <bblite/features/shadow_morph_bounds.hpp>
#include <bblite/features/shadows_csm.hpp>

#include "pal_gpu_shared.hpp"

namespace bbl::pal {

// ---------------------------------------------------------------------------
// Textures (pal_gpu_textures.hpp)

#if BBLITE_LOCAL_CUBEMAP
EnvironmentState local_cubemap_texture(const LocalCubemapRecord& local) {
    EnvironmentState result;
    result.has_irradiance = true;
    result.specular_width = local.width;
    result.specular_mip_count = local.mip_count;
    result.specular_faces.resize(static_cast<std::size_t>(local.layers) * local.mip_count);
    std::vector<bool> copied(result.specular_faces.size(), false);
    result.specular_rgba16f = local.environments.at(0)->specular_rgba16f;
    for (const auto& copy : local.copies) {
        const auto& source = *local.environments.at(copy.source);
        if (copy.source_layer >= 6 || copy.source_mip >= source.specular_mip_count ||
            copy.layer >= local.layers || copy.mip >= local.mip_count ||
            copy.size != std::max(1u, source.specular_width >> copy.source_mip) ||
            copy.size != std::max(1u, local.width >> copy.mip) ||
            source.specular_rgba16f != result.specular_rgba16f)
            throw std::runtime_error("Local cubemap copy does not match its source environment.");
        const auto destination = static_cast<std::size_t>(copy.mip) * local.layers + copy.layer;
        if (copied.at(destination))
            throw std::runtime_error("Local cubemap repeats a face copy.");
        copied[destination] = true;
        result.specular_faces[destination] = source.specular_faces.at(
            static_cast<std::size_t>(copy.source_mip) * 6 + copy.source_layer);
    }
    if (std::find(copied.begin(), copied.end(), false) != copied.end())
        throw std::runtime_error("Local cubemap copy plan leaves a face uninitialized.");
    return result;
}
#endif

#if BBLITE_HAS_PBR_RENDERER
std::vector<std::uint16_t> decode_rgbd(const TextureData& texture_data, int& width, int& height) {
    // src/loader-env/rgbd-decode.ts: the pin decodes into a
    // `texture_storage_2d<rgba16float, write>`, so a half is the decode's
    // result type, not a packing step a caller may skip. Returning halves
    // is what keeps every caller on the pin's precision: an RGBA32Float
    // upload on one path beside a half-packed one on another would be a
    // silent backend delta.
    if (texture_data.bytes.empty()) {
        width = height = 1;
        return {0, 0, 0, float_to_half(1.0f)};
    }
    const DecodedImage image = decode_image(js::ArrayBuffer(texture_data.bytes));
    width = image.width;
    height = image.height;
    std::vector<std::uint16_t> result(static_cast<std::size_t>(width) * height * 4);
    for (std::size_t index = 0; index < image.rgba.size(); index += 4) {
        const auto pixel = upstream::decode_rgbd_pixel(image.rgba.data() + index);
        for (std::size_t channel = 0; channel < pixel.size(); ++channel) {
            result[index + channel] = float_to_half(pixel[channel]);
        }
    }
    return result;
}
#endif

bool environment_cube_present(const EnvironmentState& environment) {
    return environment.specular_width != 0 && environment.specular_mip_count != 0 &&
           (environment.specular_gpu ||
            environment.specular_faces.size() >=
                static_cast<std::size_t>(environment.specular_mip_count) * 6);
}

// ---------------------------------------------------------------------------
// Surfaces and viewports (pal_gpu_surface.hpp)

#if BBLITE_HAS_UI
PixelViewport laid_out_canvas_pane(const Engine& engine, UiElementHandle canvas,
                                   std::uint32_t target_width, std::uint32_t target_height) {
    const auto& rect = handle_at(engine.ui_elements, canvas).client_rect;
    const double scale_x = static_cast<double>(target_width) / engine.options.width;
    const double scale_y = static_cast<double>(target_height) / engine.options.height;
    return PixelViewport{
        static_cast<std::int32_t>(rect.left * scale_x),
        static_cast<std::int32_t>(rect.top * scale_y),
        std::max<std::int32_t>(1, static_cast<std::int32_t>(rect.width * scale_x)),
        std::max<std::int32_t>(1, static_cast<std::int32_t>(rect.height * scale_y)),
    };
}
#endif

std::optional<PixelViewport> equal_surface_pane(const Engine& engine, const Scene& scene,
                                                std::uint32_t target_width,
                                                std::uint32_t target_height) {
#if BBLITE_HAS_UI
    if (engine.registered_scenes.empty())
        return std::nullopt;
    std::size_t pane_count = 1;
    std::size_t pane_index = npos;
    const std::shared_ptr<Scene>& primary = engine.registered_scenes.front();
    if (primary && primary->shares_identity(scene))
        pane_index = 0;
    for (std::size_t i = 1; i < engine.registered_scenes.size(); ++i) {
        const std::shared_ptr<Scene>& registered = engine.registered_scenes[i];
        if (!registered || !unplaced_surface_scene(engine, *registered))
            continue;
        if (registered->shares_identity(scene))
            pane_index = pane_count;
        ++pane_count;
    }
    if (pane_count == 1 || pane_index == npos)
        return std::nullopt;
    const std::uint64_t width = target_width;
    const auto x0 = static_cast<std::int32_t>(width * pane_index / pane_count);
    const auto x1 = static_cast<std::int32_t>(width * (pane_index + 1) / pane_count);
    return PixelViewport{
        x0,
        0,
        std::max<std::int32_t>(1, x1 - x0),
        std::max<std::int32_t>(1, static_cast<std::int32_t>(target_height)),
    };
#else
    (void)engine;
    (void)scene;
    (void)target_width;
    (void)target_height;
    return std::nullopt;
#endif
}

std::optional<PixelViewport> scene_surface_pane(const Engine& engine, const Scene& scene,
                                                std::uint32_t width, std::uint32_t height) {
#if BBLITE_HAS_UI
    if (scene.surface_canvas && surface_canvas_laid_out(engine, *scene.surface_canvas)) {
        return laid_out_canvas_pane(engine, *scene.surface_canvas, width, height);
    }
#endif
    return equal_surface_pane(engine, scene, width, height);
}

std::optional<PixelViewport> surface_canvas_pane(const Engine& engine,
                                                 std::optional<UiElementHandle> surface_canvas,
                                                 std::uint32_t target_width,
                                                 std::uint32_t target_height) {
#if BBLITE_HAS_UI
    if (!surface_canvas)
        return std::nullopt;
    if (surface_canvas_laid_out(engine, *surface_canvas)) {
        return laid_out_canvas_pane(engine, *surface_canvas, target_width, target_height);
    }
    for (std::size_t i = 0; i < engine.registered_scenes.size(); ++i) {
        const std::shared_ptr<Scene>& registered = engine.registered_scenes[i];
        if (!registered || !registered->surface_canvas)
            continue;
        if (registered->surface_canvas->value != surface_canvas->value)
            continue;
        return equal_surface_pane(engine, *registered, target_width, target_height);
    }
    return std::nullopt;
#else
    (void)engine;
    (void)surface_canvas;
    (void)target_width;
    (void)target_height;
    return std::nullopt;
#endif
}

std::pair<std::uint32_t, std::uint32_t> surface_target_extent(const Engine& engine,
                                                              const RenderTargetRecord& target,
                                                              std::uint32_t width,
                                                              std::uint32_t height) {
    const auto pane = surface_canvas_pane(engine, target.surface_canvas, width, height);
    return {target.width > 0 ? target.width
            : pane           ? static_cast<std::uint32_t>(pane->width)
                             : width,
            target.height > 0 ? target.height
            : pane            ? static_cast<std::uint32_t>(pane->height)
                              : height};
}

PixelViewport scene_surface_extent(const Engine& engine, const Scene& scene,
                                   std::uint32_t target_width, std::uint32_t target_height) {
    return scene_surface_pane(engine, scene, target_width, target_height)
        .value_or(PixelViewport{
            0,
            0,
            static_cast<std::int32_t>(target_width),
            static_cast<std::int32_t>(target_height),
        });
}

#if BBLITE_HAS_PBR_RENDERER
std::optional<PixelViewport> scene_camera_viewport(const Engine& engine, const Scene& scene,
                                                   const CameraRecord* camera,
                                                   std::uint32_t target_width,
                                                   std::uint32_t target_height) {
    const std::optional<PixelViewport> pane =
        scene_surface_pane(engine, scene, target_width, target_height);
    if (!pane.has_value()) {
        return upstream::pass_camera_viewport(camera, static_cast<double>(target_width),
                                              static_cast<double>(target_height));
    }
    std::optional<PixelViewport> viewport = upstream::pass_camera_viewport(
        camera, static_cast<double>(pane->width), static_cast<double>(pane->height));
    if (!viewport.has_value())
        return pane;
    viewport->x += pane->x;
    viewport->y += pane->y;
    return viewport;
}
#endif

#if BBLITE_FLOATING_ORIGIN
void apply_light_floating_origin(std::span<upstream::LightEntry> entries, std::uint32_t count,
                                 const Scene& scene, const Engine& engine) {
    const Vec3d offset = floating_origin_offset(scene, engine);
    std::uint32_t written = 0;
    for (const LightHandle handle : scene.lights) {
        if (written >= count)
            break;
        if (handle.value >= engine.lights.size())
            continue;
        const LightRecord& light = handle_at(engine.lights, handle);
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
            entries[written].vLightData[0] = static_cast<float>(light.position.x - offset.x);
            entries[written].vLightData[1] = static_cast<float>(light.position.y - offset.y);
            entries[written].vLightData[2] = static_cast<float>(light.position.z - offset.z);
        }
        ++written;
    }
}
#endif

#if BBLITE_HAS_PBR_RENDERER
Vec3d frame_floating_origin_offset([[maybe_unused]] const Scene& scene,
                                   [[maybe_unused]] const Engine& engine) {
#if BBLITE_FLOATING_ORIGIN
    return floating_origin_offset(scene, engine);
#else
    return Vec3d{};
#endif
}

std::array<float, 16> mesh_block_world([[maybe_unused]] const Scene& scene, const Engine& engine,
                                       const MeshRecord& record) {
#if BBLITE_FLOATING_ORIGIN
    return upstream::mesh_world_eye_relative(engine, record, floating_origin_offset(scene, engine));
#else
    return upstream::mesh_world_matrix(engine, record);
#endif
}
#endif

// ---------------------------------------------------------------------------
// Sprites and billboards (pal_gpu_sprites.hpp)

#if BBLITE_HAS_SPRITES
bool sprite_blend_equal(const SpriteBlendDescriptor& left, const SpriteBlendDescriptor& right) {
    return left.enabled == right.enabled && left.color.src == right.color.src &&
           left.color.dst == right.color.dst && left.alpha.src == right.alpha.src &&
           left.alpha.dst == right.alpha.dst;
}

SpriteLayerPipelinePlan sprite_layer_pipeline_plan(const Sprite2DLayerRecord& layer) {
    const bool has_depth = layer.depth_mode != Sprite2DDepthMode::none;
    return SpriteLayerPipelinePlan{
        layer.uv_scroll, has_depth, layer.depth_mode == Sprite2DDepthMode::test_write,
        layer.alpha_to_coverage,
        layer.instance_floats_per_sprite * static_cast<std::uint32_t>(sizeof(float))};
}

std::string sprite_program_stem(std::uint32_t program, const SpriteLayerPipelinePlan& plan) {
    std::string stem = program == 0u   ? std::string("sprite")
                       : program == 1u ? std::string("sprite_custom")
                                       : "sprite_custom_" + std::to_string(program);
    if (plan.has_depth)
        stem += "_depth";
    if (plan.scroll)
        stem += "_uvscroll";
    return stem;
}

bool sprite_scene_pipeline_compatible(const Sprite2DLayerRecord& left,
                                      const Sprite2DLayerRecord& right) {
    const SpriteLayerPipelinePlan left_plan = sprite_layer_pipeline_plan(left);
    const SpriteLayerPipelinePlan right_plan = sprite_layer_pipeline_plan(right);
    return sprite_blend_equal(left.blend, right.blend) && left_plan.scroll == right_plan.scroll &&
           left_plan.has_depth == right_plan.has_depth &&
           left_plan.depth_write == right_plan.depth_write &&
           left_plan.alpha_to_coverage == right_plan.alpha_to_coverage &&
           left.custom_shader == right.custom_shader &&
           left.custom_textures.size() == right.custom_textures.size() &&
           left_plan.instance_stride_bytes == right_plan.instance_stride_bytes;
}

void refuse_disposed_sprite_render_texture_in_use(const Engine& engine) {
    for (const SpriteRendererHandle& renderer_handle : engine.registered_sprite_renderers) {
        const SpriteRendererRecord& renderer = handle_at(engine.sprite_renderers, renderer_handle);
        for (const Sprite2DLayerHandle& layer_handle : renderer.layers) {
            const SpriteAtlasRecord& atlas = handle_at(
                engine.sprite_atlases, handle_at(engine.sprite_layers, layer_handle).atlas);
            if (atlas.has_render_texture &&
                handle_at(engine.sprite_render_textures, atlas.render_texture).disposed) {
                throw std::runtime_error("A disposed sprite render texture is "
                                         "still sampled by a registered "
                                         "SpriteRenderer layer's atlas.");
            }
        }
    }
}

SpriteDirtyRange resolve_sprite_dirty_range(const Sprite2DLayerRecord& layer, bool uploaded,
                                            std::uint64_t uploaded_version) {
    const bool needs_full_upload = !uploaded || uploaded_version < layer.dirty_sprite_reset_version;
    return {needs_full_upload ? 0u : std::min(layer.dirty_sprite_begin, layer.count),
            needs_full_upload ? layer.count : std::min(layer.dirty_sprite_end, layer.count)};
}

SpriteInstanceUpload resolve_sprite_instance_upload(Engine& engine, Sprite2DLayerRecord& layer,
                                                    bool uploaded, std::uint64_t uploaded_version) {
    // The pin's `uploadedVersion`: this buffer's stamp, or -1 where it holds
    // none of the current rows -- a fresh buffer, or one whose stamp
    // predates the last consumption of the shared range.
    const bool stale = !uploaded || uploaded_version < layer.dirty_sprite_reset_version;
    if (engine.sprite_y_sort_hook.upload) {
        if (auto ordered = engine.sprite_y_sort_hook.upload(
                layer, stale ? -1.0 : static_cast<double>(uploaded_version))) {
            return *ordered;
        }
    }
    const auto [dirty_begin, dirty_end] =
        resolve_sprite_dirty_range(layer, uploaded, uploaded_version);
    if (dirty_end <= dirty_begin)
        return {};
    const std::size_t stride_bytes = layer.instance_floats_per_sprite * sizeof(float);
    const std::size_t offset = static_cast<std::size_t>(dirty_begin) * stride_bytes;
    return {reinterpret_cast<const std::uint8_t*>(layer.instance_data.data()), offset, offset,
            static_cast<std::size_t>(dirty_end - dirty_begin) * stride_bytes};
}
#endif

#if BBLITE_HAS_SPRITES && BBLITE_HAS_SPRITE_RENDERER
void begin_sprite_renderer_update(Engine& engine, SpriteRendererHandle renderer, double delta_ms) {
    if (renderer.value >= engine.sprite_renderers.size())
        return;
    SpriteRendererRecord& record = handle_at(engine.sprite_renderers, renderer);
    if (record.disposed)
        return;
    if (!record.before_update.empty()) {
        // Copied into the record's own scratch rather than a fresh vector:
        // the copy is what makes this iterate the list it entered with, the
        // way upstream's `for (const hook of rr._beforeUpdate)` does, and
        // assigning into a retained buffer keeps that guarantee while paying
        // the allocation once instead of once per renderer per frame.
        record.before_update_running.assign(record.before_update.begin(),
                                            record.before_update.end());
        for (const auto& hook : record.before_update_running) {
            hook(delta_ms);
        }
    }
    sort_sprite_renderer_layers(engine, handle_at(engine.sprite_renderers, renderer));
}
#endif

#if BBLITE_HAS_SPRITES
BillboardDrawPlan billboard_draw_plan(const BillboardSystemRecord& system) {
    const bool axis_locked = system.orientation == BillboardOrientation::axis_locked;
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
        throw std::runtime_error("A node-particle Multiply blend draws the pin's own facing "
                                 "program; it has no axis-locked or custom-shader arm.");
    }
    const bool cutout = system.depth_mode == BillboardDepthMode::cutout;
    BillboardDrawPlan plan{};
    // Each program is the module the pin composes for the system, deployed
    // whole under these stems (`emitSpriteBillboard`, upstream-lower.ts).
    // The custom composer takes the orientation and has no depth arm; the
    // stock cutout arm discards below the cutoff, and with alpha-to-coverage
    // the pin drops the discard and lets sample coverage carry the edge, so
    // that permutation shares the transparent program.
    const bool discards = cutout && !system.alpha_to_coverage;
    plan.program_stem =
        particle_multiply      ? "billboard_particle_multiply"
        : system.custom_shader ? (axis_locked ? "billboard_custom_axis_locked" : "billboard_custom")
        : discards             ? (axis_locked ? "billboard_axis_locked_cutout" : "billboard_cutout")
        : axis_locked          ? "billboard_axis_locked"
                               : "billboard";
    plan.axis_locked = axis_locked;
    plan.cutout_writes_depth = cutout;
    plan.particle_passes = system.blend.particle_passes;
    return plan;
}

bool billboard_needs_upload(const BillboardSystemRecord& system, const BillboardUploadStamp& stamp,
                            const std::array<float, 16>& view, [[maybe_unused]] Vec3d fo_offset) {
    if (system.count == 0)
        return false;
    if (!stamp.uploaded || stamp.count != system.count ||
        stamp.instance_version != system.instance_version) {
        return true;
    }
#if BBLITE_FLOATING_ORIGIN
    // The anchors are uploaded eye-relative, so the offset is an input to
    // the bytes -- a cutout system, which otherwise uploads once per count
    // and never again, would hold the offset it first saw. The pin folds
    // the camera's own version into the same stamp for the same reason
    // (`lightFoVersion`, `wrapRenderableForFO`).
    if (stamp.fo_offset.x != fo_offset.x || stamp.fo_offset.y != fo_offset.y ||
        stamp.fo_offset.z != fo_offset.z) {
        return true;
    }
#endif
    const bool cutout = system.depth_mode == BillboardDepthMode::cutout;
    return !(cutout || stamp.view == view);
}

void stamp_billboard_upload(BillboardUploadStamp& stamp, const BillboardSystemRecord& system,
                            const std::array<float, 16>& view, [[maybe_unused]] Vec3d fo_offset) {
    stamp.view = view;
    stamp.count = system.count;
    stamp.instance_version = system.instance_version;
    stamp.uploaded = true;
#if BBLITE_FLOATING_ORIGIN
    stamp.fo_offset = fo_offset;
#endif
}
#endif

// ---------------------------------------------------------------------------
// Vertex streams and shared geometry (pal_gpu_vertex.hpp)

#if BBLITE_GPU_DEFORMATION
DeformationUniforms build_deformation_uniforms(const MeshRecord& mesh) {
    DeformationUniforms result;
    for (std::array<float, 16>& matrix : result.bone_matrices) {
        matrix[0] = 1.0f;
        matrix[5] = 1.0f;
        matrix[10] = 1.0f;
        matrix[15] = 1.0f;
    }
    if (!mesh.gpu_deformation)
        return result;
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
        std::copy(mesh.bone_matrices.begin(), mesh.bone_matrices.end(),
                  result.bone_matrices.begin());
    }
    std::copy(mesh.morph_weights.begin(), mesh.morph_weights.end(), result.morph_weights);
    result.options[0] = 1.0f;
    return result;
}
#endif

std::vector<GpuVertex> mesh_gpu_vertices(const ModelGeometry& geometry,
                                         [[maybe_unused]] const MeshRecord& mesh) {
    std::vector<GpuVertex> result;
    result.reserve(geometry.vertices.size());
#if BBLITE_GPU_DEFORMATION
    const auto morph_lane = [&](const std::vector<std::vector<Vec3>>& targets, std::size_t target,
                                std::size_t vertex_index) {
        if (targets.size() <= target)
            return std::array<float, 3>{};
        const Vec3& delta = targets[target][vertex_index];
        return std::array<float, 3>{delta.x, delta.y, delta.z};
    };
#endif
    for (std::size_t vertex_index = 0; vertex_index < geometry.vertices.size(); ++vertex_index) {
        const ModelVertex& vertex = geometry.vertices[vertex_index];
        GpuVertex packed{
            {vertex.position.x, vertex.position.y, vertex.position.z},
            {vertex.normal.x, vertex.normal.y, vertex.normal.z},
            {vertex.tangent.x, vertex.tangent.y, vertex.tangent.z, vertex.tangent.w},
            {vertex.uv.x, vertex.uv.y},
            {vertex.uv2.x, vertex.uv2.y},
            {vertex.color.x, vertex.color.y, vertex.color.z, vertex.color.w},
#if BBLITE_GPU_DEFORMATION
            {
                static_cast<float>(vertex.joints[0]),
                static_cast<float>(vertex.joints[1]),
                static_cast<float>(vertex.joints[2]),
                static_cast<float>(vertex.joints[3]),
            },
            {
                // A deformed mesh with no skin weights reads the identity
                // palette entry, so the influence sum is the identity.
                mesh.gpu_deformation &&
                        vertex.weights.x + vertex.weights.y + vertex.weights.z + vertex.weights.w <=
                            0.0f
                    ? 1.0f
                    : vertex.weights.x,
                vertex.weights.y,
                vertex.weights.z,
                vertex.weights.w,
            },
            {},
            {},
            {},
            {},
            {},
            {},
#if BBLITE_PBR_VARIANTS > 0 || BBLITE_STANDARD_SKELETON
            {
                static_cast<std::uint32_t>(vertex.joints[0]),
                static_cast<std::uint32_t>(vertex.joints[1]),
                static_cast<std::uint32_t>(vertex.joints[2]),
                static_cast<std::uint32_t>(vertex.joints[3]),
            },
#endif
#endif
        };
#if BBLITE_GPU_DEFORMATION
        const auto store = [](float (&lane)[3], const std::array<float, 3>& value) {
            std::copy(value.begin(), value.end(), lane);
        };
        store(packed.morph_position_0, morph_lane(geometry.morph_positions, 0, vertex_index));
        store(packed.morph_position_1, morph_lane(geometry.morph_positions, 1, vertex_index));
        store(packed.morph_normal_0, morph_lane(geometry.morph_normals, 0, vertex_index));
        store(packed.morph_normal_1, morph_lane(geometry.morph_normals, 1, vertex_index));
        store(packed.morph_tangent_0, morph_lane(geometry.morph_tangents, 0, vertex_index));
        store(packed.morph_tangent_1, morph_lane(geometry.morph_tangents, 1, vertex_index));
#endif
        result.push_back(packed);
    }
    return result;
}

std::uint64_t fnv1a_append(std::uint64_t hash, const void* data, std::size_t size) {
    const auto* bytes = static_cast<const std::uint8_t*>(data);
    for (std::size_t index = 0; index < size; ++index) {
        hash ^= bytes[index];
        hash *= 1099511628211ull;
    }
    return hash;
}

SharedGeometryIdentity shared_geometry_identity(const std::vector<GpuVertex>& vertices,
                                                const std::vector<std::uint32_t>& indices) {
    std::uint64_t hash = 14695981039346656037ull;
    hash = fnv1a_append(hash, vertices.data(), vertices.size() * sizeof(GpuVertex));
    hash = fnv1a_append(hash, indices.data(), indices.size() * sizeof(std::uint32_t));
    return {vertices.size(), indices.size(), hash};
}

#if BBLITE_PINNED_MATERIALS
PinnedVertexInput pinned_vertex_input(std::string_view name) {
    const auto at = [](VertexInputLane lane, std::size_t offset) {
        return PinnedVertexInput{
            lane,
            static_cast<std::uint64_t>(offset),
            VertexInputStream::vertex,
            true,
        };
    };
    if (name == "position") {
        return at(VertexInputLane::float3, offsetof(GpuVertex, position));
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
    if (const upstream::PinnedInstanceAttribute* declared =
            upstream::pinned_instance_attribute(name)) {
        return PinnedVertexInput{
            VertexInputLane::float4,
            declared->offset,
            declared->buffer_group == vertex_stream_group(VertexInputStream::instance_color)
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
#if BBLITE_PBR_VARIANTS > 0 || BBLITE_STANDARD_SKELETON
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

#if BBLITE_GPU_INSTANCE_COLORS
std::vector<float> instance_colors_for_upload(const MeshRecord& mesh) {
    if (!mesh.instance_color_source)
        return mesh.instance_colors;
    const auto& source = *mesh.instance_color_source;
    std::vector<float> colors(source.size());
    for (std::size_t lane = 0; lane < colors.size(); ++lane)
        colors[lane] = source.load(lane);
    return colors;
}
#endif

#if BBLITE_GPU_MORPH_STORAGE
std::vector<float> morph_weight_values(const ModelGeometry& geometry,
                                       const MeshRecord& mesh_record) {
    const std::size_t target_count = geometry.morph_positions.size();
    std::vector<float> weights(target_count, 0.0f);
    for (std::size_t target = 0; target < target_count; ++target) {
        weights[target] = target < mesh_record.morph_storage_weights.size()
                              ? mesh_record.morph_storage_weights[target]
                              : 0.0f;
    }
    return weights;
}

std::vector<std::uint8_t> pack_morph_weights(const ModelGeometry& geometry,
                                             const MeshRecord& mesh_record) {
    const std::size_t target_count = geometry.morph_positions.size();
    const std::size_t vertex_count = geometry.vertices.size();
    std::vector<std::uint8_t> weights_blob(16 + target_count * sizeof(float), 0);
    const std::uint32_t header[2] = {
        static_cast<std::uint32_t>(target_count),
        static_cast<std::uint32_t>(vertex_count),
    };
    std::memcpy(weights_blob.data(), header, sizeof(header));
    const std::vector<float> weights = morph_weight_values(geometry, mesh_record);
    if (target_count > 0) {
        std::memcpy(weights_blob.data() + 16, weights.data(), target_count * sizeof(float));
    }
    return weights_blob;
}
#endif

// ---------------------------------------------------------------------------
// Material slots and variants (pal_gpu_materials.hpp)

#if BBLITE_HAS_PBR_RENDERER
std::size_t variant_pipeline_key(std::size_t variant, upstream::RenderPipelineKind kind,
                                 std::initializer_list<bool> flags) {
    std::size_t key =
        variant * upstream::render_pipeline_kind_count + static_cast<std::size_t>(kind);
    for (const bool flag : flags)
        key = key * 2 + (flag ? 1 : 0);
    return key;
}

const TextureData* material_slot_texture(const MaterialRecord& material,
                                         upstream::MaterialTextureSource source,
                                         bool standard_material) {
    using Source = upstream::MaterialTextureSource;
    switch (source) {
    case Source::base_color:
        return &material.base_color_texture;
    case Source::specular_or_metallic_roughness:
        return standard_material ? &material.specular_texture
                                 : &material.metallic_roughness_texture;
    case Source::opacity_or_normal:
        return standard_material ? &material.opacity_texture : &material.normal_texture;
    case Source::ambient_or_emissive:
        return standard_material ? &material.ambient_texture : &material.emissive_texture;
    case Source::standard_emissive:
        return standard_material ? &material.emissive_texture : nullptr;
    case Source::spec_gloss:
        return standard_material ? nullptr : &material.spec_gloss_texture;
    case Source::transmission:
        return standard_material ? nullptr : &material.transmission_texture;
    case Source::thickness:
        return standard_material ? nullptr : &material.thickness_texture;
    case Source::clearcoat:
        return standard_material ? nullptr : &material.clearcoat_texture;
    case Source::clearcoat_roughness:
        return standard_material ? nullptr : &material.clearcoat_roughness_texture;
    case Source::clearcoat_normal:
        return standard_material ? nullptr : &material.clearcoat_normal_texture;
    case Source::sheen_color:
        return standard_material ? nullptr : &material.sheen_color_texture;
    case Source::sheen_roughness:
        return standard_material ? nullptr : &material.sheen_roughness_texture;
    case Source::iridescence:
        return standard_material ? nullptr : &material.iridescence_texture;
    case Source::iridescence_thickness:
        return standard_material ? nullptr : &material.iridescence_thickness_texture;
    case Source::lightmap:
        return &material.lightmap_texture;
    case Source::metallic_reflectance:
        return standard_material ? nullptr : &material.metallic_reflectance_texture;
    case Source::reflectance:
        return standard_material ? nullptr : &material.reflectance_texture;
    case Source::anisotropy:
        return standard_material ? nullptr : &material.anisotropy_texture;
    case Source::translucency_color:
        return standard_material ? nullptr : &material.translucency_color_texture;
    case Source::translucency_intensity:
        return standard_material ? nullptr : &material.translucency_intensity_texture;
    case Source::occlusion_uv2:
        return !standard_material && material.occlusion_texture_uv2 ? &material.occlusion_texture
                                                                    : nullptr;
    case Source::standard_bump:
        return standard_material ? &material.bump_texture : nullptr;
    case Source::standard_reflection:
        return standard_material ? &material.reflection_texture : nullptr;
    // Scene-owned resources carry no record field. The two VAT rows
    // are the mesh's own, like the bone palette beside them.
    case Source::environment_cube:
    case Source::local_probe_cube:
    case Source::brdf_lut:
    case Source::scene_color:
    case Source::bone_palette:
    case Source::vat_palette:
    case Source::vat_instance_params:
    case Source::clustered_lights:
    case Source::clustered_cells:
    case Source::clustered_indices:
        return nullptr;
    }
    return nullptr;
}

bool material_slot_srgb(upstream::MaterialTextureSrgb rule, const MaterialRecord* material,
                        bool standard_material) {
    switch (rule) {
    case upstream::MaterialTextureSrgb::linear:
        return false;
    case upstream::MaterialTextureSrgb::srgb:
        return true;
    case upstream::MaterialTextureSrgb::srgb_unless_standard:
        return !standard_material;
    case upstream::MaterialTextureSrgb::lightmap:
        return material != nullptr && material->lightmap_texture_srgb;
    case upstream::MaterialTextureSrgb::base_color:
        // The slot's encoding is its TEXTURE's, which upstream stores as
        // the `Texture2D`'s own format: the record carries it for the
        // image and the fallback texel alike, so an image is not assumed
        // to be sRGB because it is an image. A transferred texture keeps
        // the same encoding when a Standard diffuse slot takes it.
        return standard_material ? material != nullptr && material->diffuse_texture_srgb
                                 : material == nullptr || material->base_color_srgb;
    }
    return false;
}

std::array<std::uint8_t, 4> material_slot_fallback(upstream::MaterialTextureFallback rule,
                                                   const MaterialRecord* material,
                                                   bool standard_material) {
    constexpr std::array<std::uint8_t, 4> white_texel{255, 255, 255, 255};
    constexpr std::array<std::uint8_t, 4> black_texel{0, 0, 0, 255};
    // A flat tangent-space normal, so a material with no map reads
    // (0, 0, 1) out of the sample and keeps its interpolated normal.
    constexpr std::array<std::uint8_t, 4> flat_normal_texel{128, 128, 255, 255};
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
        return !standard_material && material ? material->base_color_fallback : white_texel;
    case upstream::MaterialTextureFallback::orm_record:
        // The pinned ORM factor texel, so an animated metallic or
        // roughness factor multiplies the authored value rather than
        // white. Standard materials never carry one.
        return !standard_material && material ? material->orm_fallback : white_texel;
    case upstream::MaterialTextureFallback::white_or_emissive_factor: {
        if (standard_material)
            return white_texel;
        const bool has_emissive_factor = material && (material->emissive_factor.r != 0.0f ||
                                                      material->emissive_factor.g != 0.0f ||
                                                      material->emissive_factor.b != 0.0f);
        return has_emissive_factor ? white_texel : black_texel;
    }
    }
    return white_texel;
}

const upstream::MaterialTextureSlot* material_slot_for_binding(std::string_view name) {
    for (const upstream::MaterialTextureSlot& slot : upstream::material_texture_slots) {
        if (slot.texture_name.empty())
            continue;
        if (name == slot.texture_name || name == slot.sampler_name) {
            return &slot;
        }
    }
    return nullptr;
}

const upstream::MaterialTextureSlot*
material_slot_for_source(upstream::MaterialTextureSource source) {
    for (const upstream::MaterialTextureSlot& slot : upstream::material_texture_slots) {
        if (slot.source == source) {
            return &slot;
        }
    }
    return nullptr;
}
#endif

#if BBLITE_PINNED_MATERIALS
bool pinned_lists_have_pinned_draws(const upstream::RenderDrawLists& lists) {
    for (const upstream::RenderDrawList* list : {&lists.opaque, &lists.transparent}) {
        for (const upstream::RenderDrawCommand& draw : list->commands) {
            if (draw.item.material_kind == upstream::RenderMaterialKind::pbr ||
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
                draw.item.material_kind == upstream::RenderMaterialKind::node ||
#endif
                draw.item.material_kind == upstream::RenderMaterialKind::standard) {
                return true;
            }
        }
    }
    return false;
}
#endif

#if BBLITE_STANDARD_SHADOWS
std::span<const upstream::PinnedShadowBinding> standard_shadow_rows(std::size_t variant) {
    const upstream::StandardVariantEntry& entry = upstream::standard_variants[variant];
    return {
        upstream::standard_shadow_bindings.data() + entry.first_shadow_binding,
        entry.shadow_binding_count,
    };
}
#endif

#if BBLITE_PBR_SHADOWS
std::span<const upstream::PinnedShadowBinding> pbr_shadow_rows(std::size_t variant) {
    const upstream::PbrVariantEntry& entry = upstream::pbr_variants[variant];
    return {
        upstream::pbr_shadow_bindings.data() + entry.first_shadow_binding,
        entry.shadow_binding_count,
    };
}
#endif

#if BBLITE_NODE_SHADOWS
std::span<const upstream::PinnedShadowBinding>
node_shadow_rows(const upstream::NodeVariantEntry& entry) {
    return {
        upstream::node_shadow_bindings.data() + entry.first_shadow_binding,
        entry.shadow_binding_count,
    };
}
#endif

std::span<const std::uint32_t> node_source_indices(const ModelGeometry& geometry,
                                                   std::vector<std::uint32_t>& scratch) {
    if (!geometry.source_indices_reversed)
        return geometry.indices;
    scratch = geometry.indices;
    for (std::size_t index = 0; index < scratch.size(); index += 3) {
        std::swap(scratch.at(index + 1), scratch.at(index + 2));
    }
    return scratch;
}

#if BBLITE_NODE_VARIANTS > 0 && BBLITE_NODE_GEOMETRY_VARIANTS > 0
std::size_t require_node_geometry_variant(std::size_t variant, std::size_t geometry_task) {
    const std::size_t geometry_variant =
        upstream::node_geometry_variant_for(variant, geometry_task);
    if (geometry_variant != no_node_geometry_variant) {
        return geometry_variant;
    }
    throw std::runtime_error("node graph " + std::to_string(variant) + " draws in geometry task " +
                             std::to_string(geometry_task) + " with no composed geometry view.");
}
#endif

#if BBLITE_NODE_VARIANTS > 0
std::size_t node_graph_count() {
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
    return upstream::node_graph_count;
#else
    return upstream::node_variants.size();
#endif
}

std::size_t node_draw_slot(std::size_t variant, bool caster,
                           [[maybe_unused]] std::size_t geometry_variant) {
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
    if (geometry_variant != no_node_geometry_variant) {
        return node_geometry_slot(geometry_variant);
    }
#endif
    return node_variant_slot(variant, caster);
}

upstream::NodeVariantStems node_variant_stems(std::size_t slot) {
    const upstream::NodeVariantEntry& entry = node_slot_view(slot);
#if BBLITE_NODE_SHADOWS
    if (node_slot_is_caster(slot)) {
        return {entry.caster.vertex_stem, entry.caster.fragment_stem};
    }
#endif
    return {entry.vertex_stem, entry.fragment_stem};
}
#endif

#if BBLITE_PBR_VARIANTS > 0
PinnedVariantKey pinned_variant_key(const Scene& scene, const Engine& engine,
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
    const MaterialRecord& draw_material = handle_at(engine.materials, draw.item.material);
    key.material_view = draw_material.esm_shadow ? 2u : draw_material.no_color ? 1u : 0u;
    key.material_index = draw_material.source_material.value == invalid_handle
                             ? draw.item.material.value
                             : draw_material.source_material.value;
    if (key.material_index >= upstream::pbr_variant_material_count) {
        key.refusal = "material " + std::to_string(key.material_index) + " is past the " +
                      std::to_string(upstream::pbr_variant_material_count) +
                      " the composed table names";
        return key;
    }
    // The mesh half of the key comes per original renderable. Renderer
    // startup assigns its stable generated-table row and gives every clone
    // the same row, even when clone handles precede later imported meshes.
    const std::uint32_t feature_mesh = composition_feature_mesh(engine, draw.item.mesh);
    key.mesh_features = feature_mesh < upstream::pbr_renderable_mesh_features.size()
                            ? upstream::pbr_renderable_mesh_features[feature_mesh]
                            // Scene code can keep creating meshes after registration, all
                            // from the fixed-set builders; a scene whose builders disagree
                            // publishes npos here and such a draw refuses.
                            : upstream::pbr_runtime_mesh_features;
    if (key.mesh_features == npos) {
        key.refusal = "the scene's runtime meshes carry no single attribute set";
        return key;
    }
    // Scene-code pools attach after generation recorded the mesh's static
    // attribute word. Match the pin's _computeMeshFeatures result at draw
    // time; EXT_mesh_gpu_instancing already carries the bit in the table, so
    // this idempotent OR covers both origins with one rule.
    if (draw.item.mesh.value < engine.meshes.size()) {
        const MeshRecord& record = handle_at(engine.meshes, draw.item.mesh);
        // `_computeMeshFeatures` writes MSH_VAT INSTEAD of
        // MSH_HAS_SKELETON for a baked mesh -- attachVat dropped the live
        // skeleton -- so this is a swap on the static row rather than an
        // OR beside it. Generation composed the swapped row.
        if (record.has_vat) {
            key.mesh_features &= ~static_cast<std::size_t>(upstream::pinned_msh_has_skeleton);
            key.mesh_features |= static_cast<std::size_t>(upstream::pinned_msh_vat);
        }
        if (pinned_record_instanced(record)) {
            key.mesh_features |= upstream::pinned_msh_has_thin_instances;
            // `_computeMeshFeatures` nests this under the pool and reads the
            // mesh's colour stream. Use the binding predicate too, so the
            // selected PBR stage and the stream each backend binds cannot
            // disagree about `instanceColor`.
            if (pinned_record_instance_colored(record)) {
                key.mesh_features |= upstream::pinned_msh_has_instance_color;
            }
        }
        const std::size_t receive_shadows =
            static_cast<std::size_t>(upstream::pinned_msh_receive_shadows);
        if (upstream::pinned_material_receives_shadows(
                key.material_view != 0u, record.receives_shadows,
                upstream::pinned_scene_has_shadows(engine, scene))) {
            key.mesh_features |= receive_shadows;
        } else {
            key.mesh_features &= ~receive_shadows;
        }
    }
    // The light mode, walked the way `writeMeshLightSelection` walks it: how
    // many of the scene's lights affect this mesh decides which arm the pin
    // composed.
    std::uint32_t light_count = 0;
    for (const LightHandle handle : scene.lights) {
        if (handle.value >= engine.lights.size())
            continue;
        const LightRecord& light = handle_at(engine.lights, handle);
        if (!upstream::light_affects_mesh(light, draw.item.mesh)) {
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
        (key.mesh_features & static_cast<std::size_t>(upstream::pinned_msh_receive_shadows)) != 0);
    if (key.light_mode != 1)
        key.single_light_type = "";
    key.tone_mapping = scene.environment.tone_mapping_enabled;
    key.resolved = true;
    return key;
}

std::string pinned_variant_request(const PinnedVariantKey& key, std::size_t geometry_task) {
    if (!key.resolved)
        return "no key: " + key.refusal;
    return "material " + std::to_string(key.material_index) + ", view " +
           std::to_string(key.material_view) + ", mesh features " +
           std::to_string(key.mesh_features) + ", light mode " + std::to_string(key.light_mode) +
           ", single light '" + std::string(key.single_light_type) + "'" + ", tone mapping " +
           (key.tone_mapping ? "on" : "off") + ", geometry task " +
           (geometry_task == npos ? std::string("none") : std::to_string(geometry_task));
}

std::size_t
pinned_variant_for_draw(const Scene& scene, const Engine& engine,
                        const upstream::RenderDrawCommand& draw,
                        // The geometry-output task the draw belongs to, npos for the colour
                        // passes: the selector table keys on it, so a geometry draw resolves
                        // its own MRT arm and never a colour variant.
                        std::size_t geometry_task,
                        // Filled with the key the lookup used, so a miss reports that key
                        // rather than a second derivation of it.
                        PinnedVariantKey* key_out) {
    if (upstream::pbr_variants.empty()) {
        return npos;
    }
    // An animated node moves through its world, which every variant's mesh
    // block carries; an instanced mesh resolves the pin's own thin-instance
    // arm -- its renderable features carry MSH_HAS_THIN_INSTANCES -- and the
    // draw binds the per-instance matrix buffer as the arm's second stream.
    const bool has_bones = draw.item.mesh.value < engine.meshes.size() &&
                           !handle_at(engine.meshes, draw.item.mesh).bone_matrices.empty();
    const PinnedVariantKey key = pinned_variant_key(scene, engine, draw);
    if (!key.resolved)
        return npos;
    if (key_out)
        *key_out = key;
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
        key.material_index, key.material_view, static_cast<std::uint32_t>(key.mesh_features),
        key.light_mode, key.single_light_type, key.tone_mapping, geometry_task);
    if (variant == npos) {
        return npos;
    }
    // A skeleton variant needs the palette to exist or the deformation is
    // lost.
    const bool skeleton_variant = pinned_variant_skeleton(variant);
    if (skeleton_variant && !has_bones) {
        return npos;
    }
    return variant;
}
#endif

#if BBLITE_HAS_PBR_RENDERER
std::string shader_sampler_shortfall(const upstream::ShaderVariantInfo& info, std::size_t carried) {
    return "shader variant '" + std::string(info.name) + "' declares " +
           std::to_string(info.samplers.size()) + " sampler(s); the material carries " +
           std::to_string(carried) + " texture(s).";
}
#endif

#if BBLITE_STANDARD_VARIANTS > 0
StandardVariantKey standard_variant_key(const Scene& scene, const Engine& engine,
                                        const upstream::RenderDrawCommand& draw) {
    StandardVariantKey key;
    if (draw.item.material_kind != upstream::RenderMaterialKind::standard ||
        draw.item.material.value >= engine.materials.size()) {
        return key;
    }
    const MaterialRecord& material = handle_at(engine.materials, draw.item.material);
    key.features = upstream::standard_material_features(material);
    key.plugin_index = material.plugin_signature_index;
    if (material.no_color) {
        key.features |= upstream::standard_no_color_output_flag;
    }
#if BBLITE_SHADOWS_ESM
    if (material.esm_shadow) {
        // `createStandardEsmShadowMaterialView` clears the blend bit before
        // setting its own, so the key says both.
        key.features = (key.features & ~upstream::standard_alpha_blend_flag) |
                       upstream::standard_esm_shadow_output_flag;
    }
#endif
    const std::uint32_t feature_mesh = composition_feature_mesh(engine, draw.item.mesh);
    key.mesh_features = feature_mesh < upstream::standard_renderable_mesh_features.size()
                            ? upstream::standard_renderable_mesh_features[feature_mesh]
                            : upstream::standard_runtime_mesh_features;
    if (key.mesh_features == npos) {
        return key;
    }
    if (draw.item.mesh.value < engine.meshes.size()) {
        const MeshRecord& record = handle_at(engine.meshes, draw.item.mesh);
        if (pinned_record_instanced(record)) {
            key.mesh_features |= upstream::std_msh_has_thin_instances;
            // `_computeMeshFeatures` reads `mesh.thinInstances.colors`, so
            // the colour bit arrives with the pool rather than with the
            // material: a coloured pool composes the Standard family's own
            // final-colour slot, an uncoloured one the plain fragment.
            if (pinned_record_instance_colored(record)) {
                key.mesh_features |= upstream::std_msh_has_instance_color;
            }
        }
        const std::size_t receive_shadows =
            static_cast<std::size_t>(upstream::pinned_msh_receive_shadows);
        if (upstream::pinned_material_receives_shadows(
                material.no_color
#if BBLITE_SHADOWS_ESM
                    || material.esm_shadow
#endif
                ,
                record.receives_shadows, upstream::pinned_scene_has_shadows(engine, scene))) {
            key.mesh_features |= receive_shadows;
        } else {
            key.mesh_features &= ~receive_shadows;
        }
    }
    // `rebuildSingle` computes `receiveShadows` as `!shadowOutput && ...`,
    // so a depth-only view of a mesh that also receives is composed without
    // the shadow fragment and its key carries no receive bit.
    if (material.no_color
#if BBLITE_SHADOWS_ESM
        || material.esm_shadow
#endif
    ) {
        key.mesh_features &= ~static_cast<std::size_t>(upstream::pinned_msh_receive_shadows);
    }
    if (draw.item.geometry < engine.geometries.size() &&
        !engine.geometries[draw.item.geometry].morph_positions.empty()) {
        key.mesh_features |= upstream::std_msh_has_morph_targets;
    }
#if BBLITE_STANDARD_SKELETON
    key.features |=
        upstream::standard_skeleton_features(static_cast<std::uint32_t>(key.mesh_features));
#endif
#if BBLITE_STANDARD_VERTEX_ALPHA
    if (draw.item.mesh.value < engine.meshes.size()) {
        const MeshRecord& record = handle_at(engine.meshes, draw.item.mesh);
        key.features |= upstream::standard_color_alpha_features(
            material.no_color || material.esm_shadow, record.has_vertex_alpha,
            upstream::standard_vertex_colors_enabled &&
                draw.item.geometry < engine.geometries.size() &&
                engine.geometries[draw.item.geometry].has_vertex_colors,
            has_instance_colors(record));
    }
#endif
    key.resolved = true;
    return key;
}

std::string standard_variant_request(const Scene& scene, const Engine& engine,
                                     const upstream::RenderDrawCommand& draw) {
    const StandardVariantKey key = standard_variant_key(scene, engine, draw);
    if (!key.resolved) {
        if (draw.item.material.value >= engine.materials.size()) {
            return "no key: material handle " + std::to_string(draw.item.material.value) +
                   " exceeds " + std::to_string(engine.materials.size()) + " runtime materials";
        }
        return "no key: runtime material flags standard=" +
               std::to_string(handle_at(engine.materials, draw.item.material).standard_material) +
               ", shader=" +
               std::to_string(handle_at(engine.materials, draw.item.material).shader_material) +
               ", draw kind=" + std::to_string(static_cast<std::uint32_t>(draw.item.material_kind));
    }
    return "features " + std::to_string(key.features) + ", mesh features " +
           std::to_string(key.mesh_features);
}

std::size_t
standard_variant_for_draw(const Scene& scene, const Engine& engine,
                          const upstream::RenderDrawCommand& draw, std::size_t geometry_task,
                          // Filled with the derived key when the caller passes one, so the draw
                          // can consume `key.features` instead of re-deriving it.
                          StandardVariantKey* key_out) {
    const StandardVariantKey key = standard_variant_key(scene, engine, draw);
    if (key_out)
        *key_out = key;
    if (!key.resolved) {
        return npos;
    }
    return upstream::standard_variant_for(key.features,
                                          static_cast<std::uint32_t>(key.mesh_features),
                                          geometry_task, key.plugin_index);
}

upstream::StandardMaterialUniforms standard_material_block(const MaterialRecord* material,
                                                           std::uint32_t features) {
    const upstream::StandardMaterialProps props =
        material ? upstream::standard_material_props(*material) : upstream::StandardMaterialProps{};
    upstream::StandardMaterialUniforms block{};
    upstream::write_standard_material(props, upstream::standard_texture_level(features), block);
    return block;
}

upstream::StandardUvTransformUniforms standard_uv_block(const MaterialRecord* material,
                                                        std::uint32_t features) {
    const upstream::StandardMaterialProps props =
        material ? upstream::standard_material_props(*material) : upstream::StandardMaterialProps{};
    upstream::StandardUvTransformUniforms block{};
    upstream::write_standard_uv_transform(
        props, material != nullptr && upstream::standard_uv_inverted(features, *material), block);
    return block;
}
#endif

#if BBLITE_STANDARD_VARIANTS > 0 && BBLITE_HAS_STANDARD_UV_TRANSFORM
upstream::StandardUvTxUniforms standard_uv_transform_block(const MaterialRecord* material) {
    upstream::StandardUvTxUniforms block{};
    if (!material)
        return block;
    upstream::write_std_uv_transform_data(*material, upstream::standard_material_props(*material),
                                          block);
    return block;
}
#endif

// ---------------------------------------------------------------------------
// Shadows (pal_gpu_shadows.hpp)

DepthCompare pass_depth_compare(bool shadow_pass) {
#if BBLITE_SHADOW_RECEIVERS
    if (shadow_pass)
        return upstream::shadow_map_depth_compare;
#else
    (void)shadow_pass;
#endif
    return upstream::pinned_depth_compare;
}

float pass_depth_clear(bool shadow_pass) {
#if BBLITE_SHADOW_RECEIVERS
    if (shadow_pass)
        return upstream::shadow_map_depth_clear;
#else
    (void)shadow_pass;
#endif
    return upstream::pinned_depth_clear;
}

std::uint32_t pass_depth_samples(bool shadow_pass, std::uint32_t scene_samples) {
#if BBLITE_SHADOW_RECEIVERS
    if (shadow_pass)
        return upstream::shadow_map_samples;
#else
    (void)shadow_pass;
#endif
    return scene_samples;
}

#if BBLITE_SHADOW_RECEIVERS
void fitted_shadow_casters(const Engine& engine, const ShadowGeneratorRecord& generator,
                           std::vector<upstream::ShadowCaster>& casters) {
    casters.clear();
    casters.reserve(generator.caster_meshes.size());
    for (const MeshHandle handle : generator.caster_meshes) {
        // The caster array keeps a removed mesh, as the pin's does, and
        // names it (`caster_names`), so the fit reads its last pose and
        // the bounds retirement left on its record.
        const MeshRecord& record = handle_at(engine.meshes, handle);
        upstream::ShadowCaster caster;
        caster.bounds_min = upstream::shadow_caster_bounds_fallback_min;
        caster.bounds_max = upstream::shadow_caster_bounds_fallback_max;
        if (record.geometry < engine.geometries.size()) {
            const ModelGeometry& geometry = engine.geometries[record.geometry];
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
#if BBLITE_SHADOW_MORPH_BOUNDS
            // enableMorphTargetShadows' provider, read LIVE: the weights
            // are what the scene animates, and the fit has to follow them
            // or it bounds a scrambled mesh by its unmorphed box.
            if (generator.morph_shadow_bounds && !geometry.morph_positions.empty()) {
                upstream::ensure_morph_target_ranges(geometry);
                // The two weight lanes handed over as a pointer and a
                // count rather than selected with a ternary. There is no
                // common type between a vector and an array, so the arm
                // this replaced had to build a vector from the array
                // explicitly -- which made the conditional's result a
                // vector PRVALUE and copied the storage lane whole, for
                // every caster of every refreshed generator, on a path
                // that runs each frame. Pointers have a common type and
                // copy nothing.
                const std::vector<float>& storage_weights = record.morph_storage_weights;
                const bool uncapped = !storage_weights.empty();
                upstream::expand_morph_caster_bounds(
                    geometry.morph_bounds,
                    uncapped ? storage_weights.data() : record.morph_weights.data(),
                    uncapped ? storage_weights.size() : record.morph_weights.size(),
                    caster.bounds_min, caster.bounds_max);
            }
#endif
        }
        // `computeDirectionalLightMatrix` reads the mesh's live boundMin and
        // boundMax properties, not the geometry record. Sandblox maintains
        // those properties as the aggregate AABB of each thin-instance pool;
        // ignoring them collapses the fit around the unit prototype and puts
        // almost every receiver outside the shadow map.
        Vec3 minimum{caster.bounds_min[0], caster.bounds_min[1], caster.bounds_min[2]};
        Vec3 maximum{caster.bounds_max[0], caster.bounds_max[1], caster.bounds_max[2]};
        apply_mesh_bound_overrides(record, minimum, maximum);
        caster.bounds_min = {minimum.x, minimum.y, minimum.z};
        caster.bounds_max = {maximum.x, maximum.y, maximum.z};

        // `_castersWorldAabb` gives a live CSM caster with an active
        // ThinInstanceData pool to `_thinInstanceWorldAabb`: every active,
        // non-degenerate matrix transforms the mesh bounds, and mesh.world
        // transforms that result. One carrier per instance lets the pinned
        // cascade fold perform those same two transforms without reducing
        // rotated boxes to an intermediate AABB. The refresh gate already
        // keys on `instance_version`, so this work runs only when the pin's
        // own cache would be invalidated.
#if BBLITE_GPU_INSTANCING && BBLITE_SHADOWS_CSM
        const std::size_t active_instances = thin_instance_active_count(record);
        if (generator.filter == ShadowFilter::csm_directional && record.thin_instanced &&
            active_instances > 0) {
            caster.world = upstream::mesh_world_matrix_f64(engine, record);
            for (std::size_t index = 0; index < active_instances; ++index) {
                const std::array<float, 16>& instance = record.instance_matrices[index];
                if (!upstream::csm_instance_contributes(instance))
                    continue;
                caster.instance = instance;
                caster.has_instance = true;
                casters.push_back(caster);
            }
            continue;
        }
#endif
        caster.world = upstream::mesh_world_matrix_f64(engine, record);
        casters.push_back(caster);
    }
}

ShadowCasterMatrices shadow_caster_matrices(const Engine& engine, const FrameTaskRecord& task) {
    const ShadowGeneratorRecord& generator =
        handle_at(engine.shadow_generators, task.render.shadow_generator);
#if BBLITE_SHADOWS_CSM
    if (generator.filter == ShadowFilter::csm_directional) {
        // A cascade the fit has not filled yet cannot be drawn: the pinned
        // render gate refits before any caster pass runs, and a pass whose
        // layer the fit does not carry would otherwise render through a
        // pair a cascaded generator never writes.
        if (task.render.depth_layer >= generator.csm_cascades.size()) {
            throw std::runtime_error("A cascaded shadow pass names cascade " +
                                     std::to_string(task.render.depth_layer) +
                                     ", which its generator has not fitted.");
        }
        const ShadowCascade& cascade = generator.csm_cascades[task.render.depth_layer];
        return {cascade.caster_view_projection, cascade.view};
    }
#endif
    return {generator.caster_view_projection, generator.caster_view};
}
#endif

// ---------------------------------------------------------------------------
// Scene blocks (pal_gpu_scene_blocks.hpp)

void begin_pinned_velocity_frame(PinnedVelocityHistory& history, const Scene& scene) {
    if (history.frame == 0 || history.topology_version != scene.render_topology_version) {
        history.renderables.clear();
        history.topology_version = scene.render_topology_version;
    }
    ++history.frame;
}

const PinnedVelocityHistory::Renderable&
update_pinned_velocity(PinnedVelocityHistory& history, MeshHandle mesh,
                       const std::array<float, 16>& world) {
    if (history.renderables.size() <= mesh.value) {
        history.renderables.resize(static_cast<std::size_t>(mesh.value) + 1u);
    }
    PinnedVelocityHistory::Renderable& renderable = history.renderables[mesh.value];
    if (!(renderable.mesh == mesh)) {
        renderable = {};
        renderable.mesh = mesh;
        renderable.previous_world = world;
    }
    if (renderable.updated_frame != history.frame) {
        renderable.written_previous_world = renderable.previous_world;
        renderable.written_velocity_enabled = renderable.velocity_ready ? 1.0f : 0.0f;
        renderable.previous_world = world;
        renderable.velocity_ready = true;
        renderable.updated_frame = history.frame;
    }
    return renderable;
}

#if (BBLITE_PINNED_MATERIALS || BBLITE_HAS_BILLBOARDS)
upstream::SceneUniforms pinned_scene_block(const Scene& scene, const Engine& engine,
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
    const Vec3d fo_camera_eye = upstream::arc_rotate_eye_position(camera);
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
        // The pin's executeRenderTaskLinear stamps its negative flag over
        // toneMappingEnabled while a transmission scene's retargeted linear
        // passes run; every composed fragment and background arm then skips
        // its processing tail (`if(scene.vImageInfos.w>=0.0)`) and the
        // trailing image-processing pass applies it once. The captured
        // browser block carries the same -1 (scene30 buffer#1).
        scene.transmission_enabled               ? upstream::pinned_linear_tone_mapping
        : scene.environment.tone_mapping_enabled ? 1.0f
                                                 : 0.0f,
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
    // `writeClipPlaneUbo`, the scene-UBO contributor `setClipPlane`
    // registers. A scene that never clips carries the zero vector, which
    // is the same distance the pin's unwritten lanes produce.
    scene_block.clipPlane = {
        scene.clip_plane.x,
        scene.clip_plane.y,
        scene.clip_plane.z,
        scene.clip_plane.w,
    };
    const std::array<std::array<float, 4>*, 9> harmonics{
        &scene_block.vSphericalL00, &scene_block.vSphericalL1_1, &scene_block.vSphericalL10,
        &scene_block.vSphericalL11, &scene_block.vSphericalL2_2, &scene_block.vSphericalL2_1,
        &scene_block.vSphericalL20, &scene_block.vSphericalL21,  &scene_block.vSphericalL22,
    };
    for (std::size_t index = 0; index < harmonics.size(); ++index) {
        const Color3& band = scene.environment.spherical_harmonics[index];
        *harmonics[index] = {band.r, band.g, band.b, 0.0f};
    }
    return scene_block;
}
#endif

#if BBLITE_HAS_BILLBOARDS
upstream::SceneUniforms billboard_scene_block(const Scene& scene, const Engine& engine,
                                              const CameraRecord& camera,
                                              const std::array<float, 16>& view_projection,
                                              const std::array<float, 16>& view) {
    upstream::SceneUniforms block = pinned_scene_block(scene, engine, camera, view_projection);
    block.viewProjection = view_projection;
    block.view = view;
    return block;
}
#endif

#if BBLITE_PINNED_MATERIALS
std::vector<std::uint8_t> pinned_lights_block(const Scene& scene, const Engine& engine) {
    std::array<std::uint32_t, 4> header{};
    std::array<upstream::LightEntry, upstream::pinned_max_lights> entries{};
    std::uint32_t count = 0;
    for (const LightHandle handle : scene.lights) {
        if (count >= upstream::pinned_max_lights)
            break;
        if (handle.value >= engine.lights.size())
            continue;
        const LightRecord& light = handle_at(engine.lights, handle);
        // Which writer each kind takes is generated: the scene compiles arms
        // only for the kinds it reaches, so the mapping cannot be restated here.
        upstream::write_pinned_light(light, entries[count]);
        ++count;
    }
    header[0] = count;
#if BBLITE_FLOATING_ORIGIN
    apply_light_floating_origin(entries, count, scene, engine);
#endif
    std::vector<std::uint8_t> bytes(sizeof(header) + entries.size() * sizeof(upstream::LightEntry));
    std::memcpy(bytes.data(), header.data(), sizeof(header));
    std::memcpy(bytes.data() + sizeof(header), entries.data(),
                entries.size() * sizeof(upstream::LightEntry));
    return bytes;
}
#endif

#if BBLITE_PINNED_MATERIALS && BBLITE_PINNED_MATERIAL_VARIANTS
upstream::MeshUniforms pinned_mesh_block(const Scene& scene, const Engine& engine, MeshHandle mesh,
                                         const PinnedVelocityHistory* velocity_history) {
    upstream::MeshUniforms block{};
    if (velocity_history && PinnedVelocityBlock<upstream::MeshUniforms>) {
        write_pinned_velocity_tail(*velocity_history, mesh, block);
    } else {
        block.world = mesh_block_world(scene, engine, handle_at(engine.meshes, mesh));
    }
    pinned_mesh_light_selection(scene, engine, mesh, block);
    return block;
}

void update_pinned_velocity_frame(PinnedVelocityHistory& history, const Scene& scene,
                                  const Engine& engine,
                                  const std::vector<upstream::RenderItem>& items) {
    if constexpr (!PinnedVelocityBlock<upstream::MeshUniforms>) {
        return;
    }
    begin_pinned_velocity_frame(history, scene);
    for (const upstream::RenderItem& source : items) {
        const upstream::RenderItem item =
            upstream::bind_render_item(source, engine, source.material);
        if (item.material_kind != upstream::RenderMaterialKind::standard) {
            continue;
        }
        if (item.mesh.value < history.renderables.size()) {
            const auto& renderable = history.renderables[item.mesh.value];
            if (renderable.mesh == item.mesh && renderable.updated_frame == history.frame)
                continue;
        }
        update_pinned_velocity(
            history, item.mesh,
            mesh_block_world(scene, engine, handle_at(engine.meshes, item.mesh)));
    }
}

void write_pinned_velocity_tail(const PinnedVelocityHistory& history, MeshHandle mesh,
                                upstream::MeshUniforms& block) {
    [&]<typename Block>(Block& dependent) {
        if constexpr (PinnedVelocityBlock<Block>) {
            if (mesh.value >= history.renderables.size() ||
                !(history.renderables[mesh.value].mesh == mesh) ||
                history.renderables[mesh.value].updated_frame != history.frame) {
                throw std::logic_error("A geometry task drew a Standard mesh its frame's "
                                       "velocity update did not reach.");
            }
            const PinnedVelocityHistory::Renderable& renderable = history.renderables[mesh.value];
            dependent.world = renderable.previous_world;
            dependent.previousWorld = renderable.written_previous_world;
            dependent.velocityEnabled = renderable.written_velocity_enabled;
        }
    }(block);
}
#endif

#if BBLITE_PINNED_MATERIALS && BBLITE_NODE_VARIANTS > 0
upstream::NodeMeshUniforms node_mesh_block(const Scene& scene, const Engine& engine,
                                           MeshHandle mesh) {
    upstream::NodeMeshUniforms block{};
    const MeshRecord& record = handle_at(engine.meshes, mesh);
    block.world = mesh_block_world(scene, engine, record);
    if (record.receives_shadows) {
        block.receivesShadow[0] = 1.0f;
    }
    // `writeAttributeFlags`: the block's three spare lanes carry whether
    // the mesh supplies uv1, tangents and vertex colours, which is what
    // `MeshAttributeExistsBlock` selects its serialized fallback on. The
    // pin skips these stores for a graph that raised no such block; here
    // they are unconditional, because a module that does not declare the
    // block never reads the lanes and every mesh block is packed by this
    // one function.
    if (record.geometry < engine.geometries.size()) {
        const ModelGeometry& geometry = engine.geometries[record.geometry];
        block.receivesShadow[1] = geometry.has_uvs ? 1.0f : 0.0f;
        block.receivesShadow[2] = geometry.has_tangents ? 1.0f : 0.0f;
        block.receivesShadow[3] = geometry.has_vertex_colors ? 1.0f : 0.0f;
    }
    pinned_mesh_light_selection(scene, engine, mesh, block);
    return block;
}
#endif

// ---------------------------------------------------------------------------
// Picking (pal_gpu_picking.hpp)

#if BBLITE_HAS_PICKING
PickingInfo resolve_pick_result(const std::vector<PickRange>& ranges, std::uint32_t pick_id) {
    if (pick_id == 0)
        return PickingInfo{};
    for (const PickRange& range : ranges) {
        if (pick_id < range.id || pick_id - range.id >= range.count) {
            continue;
        }
        PickingInfo info;
        info.hit = true;
        info.picked_kind = range.kind;
        info.picked_index = range.index;
        info.state->picked_generation = range.generation;
        info.picked_range_offset = pick_id - range.id;
        return info;
    }
    throw std::runtime_error("GPU pick read an id no candidate was drawn under.");
}
#endif

#if BBLITE_HAS_PICKING && BBLITE_HAS_BILLBOARDS
BillboardPickUniforms build_billboard_pick_uniforms(const std::array<float, 16>& view,
                                                    std::uint32_t base_id, float cutoff,
                                                    Vec3 axis) {
    BillboardPickUniforms out;
    upstream::pack_billboard_pick_ubo(view, static_cast<double>(base_id),
                                      static_cast<double>(cutoff), axis, out);
    return out;
}
#endif

#if BBLITE_HAS_PICKING && BBLITE_HAS_SPRITES
void collect_pick_billboard_candidates(
    const Engine& engine, const Scene& scene, std::vector<PickRange>& ranges,
    std::uint32_t& next_id,
    // The caller's scratch, cleared here and refilled: a pick runs per
    // pointer event, so the list keeps its capacity across picks.
    std::vector<PickBillboardCandidate>& candidates) {
    candidates.clear();
    for (std::size_t index = 0; index < scene.billboard_systems.size(); ++index) {
        const BillboardSystemHandle handle = scene.billboard_systems[index];
        const BillboardSystemRecord& system = handle_at(engine.billboard_systems, handle);
        const std::uint32_t base_id = next_id;
        next_id += system.count;
        if (system.count == 0)
            continue;
        // Recorded even for a hidden system: its ids are consumed either
        // way, and nothing else can answer for them.
        ranges.push_back({base_id, PickedNodeKind::billboard_sprite, handle.value, system.count});
        if (!billboard_pick_draws(system))
            continue;
        candidates.push_back({index, base_id, system.count, system.orientation, system.axis});
    }
}
#endif

#if BBLITE_HAS_PICKING
void validate_pick_contributors([[maybe_unused]] const Engine& engine,
                                [[maybe_unused]] const Scene& scene, [[maybe_unused]] bool detailed,
                                bool pick_sources) {
    if (!pick_sources)
        return;
    bool has_splats = false;
#if BBLITE_HAS_SPLATS
    for (const auto handle : scene.splat_meshes) {
        has_splats = has_splats || handle_at(engine.splat_meshes, handle).vertex_count != 0;
    }
#endif
    if (detailed && has_splats) {
        throw std::runtime_error(
            "Detailed picking requires the splat contributor's third attachment.");
    }
#if BBLITE_HAS_BILLBOARDS
    for (const auto handle : scene.billboard_systems) {
        const auto& system = handle_at(engine.billboard_systems, handle);
        if (!billboard_pick_draws(system))
            continue;
        if (system.depth_mode == BillboardDepthMode::cutout) {
            throw std::runtime_error(
                "Cutout billboard picking requires the atlas alpha-cutoff binding.");
        }
#if BBLITE_FLOATING_ORIGIN
        throw std::runtime_error(
            "Billboard picking requires instance positions in the scene's eye-relative frame.");
#else
        if (has_splats) {
            throw std::runtime_error(
                "Billboard and splat picking requires contributor registration order within the scene.");
        }
        if (detailed) {
            throw std::runtime_error(
                "Detailed picking requires the billboard contributor's third attachment.");
        }
#endif
    }
#endif
}
#endif

#if BBLITE_HAS_PICKING && BBLITE_HAS_SPLATS
std::array<float, 3> encode_pick_id_to_color(std::uint32_t id) {
    const std::array<double, 3> color = upstream::encode_id_to_color(static_cast<double>(id));
    return {static_cast<float>(color[0]), static_cast<float>(color[1]),
            static_cast<float>(color[2])};
}
#endif

#if BBLITE_HAS_PICKING && BBLITE_HAS_DETAILED_PICKING
PickDetailReadback decode_pick_detail(const std::uint8_t* texel) {
    std::array<std::uint32_t, 4> lanes{};
    std::memcpy(lanes.data(), texel, sizeof(lanes));
    PickDetailReadback out;
    out.primitive_index =
        lanes[0] == pick_detail_no_primitive ? -1.0 : static_cast<double>(lanes[0]);
    for (std::size_t lane = 0; lane < 3; ++lane) {
        float value = 0.0f;
        std::memcpy(&value, &lanes[lane + 1], sizeof(value));
        out.point[lane] = static_cast<double>(value);
    }
    return out;
}
#endif

#if BBLITE_HAS_PICKING
PickReadback decode_pick_readback(const std::uint8_t* staging, [[maybe_unused]] bool detailed) {
    PickReadback readback;
    readback.pick_id = upstream::decode_pick_id(staging);
    std::memcpy(&readback.depth, staging + pick_depth_offset, sizeof(readback.depth));
#if BBLITE_HAS_DETAILED_PICKING
    if (detailed)
        readback.detail = decode_pick_detail(staging + pick_detail_offset);
#endif
    return readback;
}
#endif

#if BBLITE_HAS_PBR_RENDERER && BBLITE_HAS_PICKING && BBLITE_DEFORM_PICKING
int pick_mesh_projection(const Engine& engine, const MeshRecord& mesh) {
#if BBLITE_VAT
    // The pin deliberately declines VAT before inspecting skeleton or morph.
    if (mesh.has_vat)
        return -1;
#endif
    const bool skeleton = mesh.skinned;
    // Attachment is geometry identity, independent of missing defaults or
    // all-zero animated weights. The visible storage path uses this same
    // transported target set when it allocates the projection's buffers.
    const bool morph =
        mesh.scene_morph_targets ||
        (mesh.gpu_deformation && !engine.geometries.at(mesh.geometry).morph_positions.empty());
    if (!skeleton && !morph)
        return -1;
    if (skeleton && !mesh.pinned_bone_palette) {
        throw std::runtime_error("deformation picking requires the pinned bone palette transport");
    }
    for (std::size_t index = 0; index < upstream::pick_deform_variants.size(); ++index) {
        const auto& variant = upstream::pick_deform_variants[index];
        if (variant.skeleton == skeleton && variant.morph == morph)
            return static_cast<int>(index);
    }
    throw std::runtime_error("pick candidate reached an uncomposed deformation projection");
}
#endif

#if BBLITE_HAS_PBR_RENDERER && BBLITE_HAS_PICKING
std::optional<std::size_t> picker_scene_index(const Engine& engine, GpuPickerHandle picker,
                                              const std::vector<std::shared_ptr<Scene>>& scenes) {
    if (picker.value >= engine.gpu_pickers.size())
        return std::nullopt;
    const auto picked_state = handle_at(engine.gpu_pickers, picker).scene.lock();
    if (!picked_state || picked_state->disposed)
        return std::nullopt;
    for (std::size_t index = 0; index < scenes.size(); ++index) {
        if (scenes[index] && scenes[index]->state == picked_state)
            return index;
    }
    return std::nullopt;
}
#endif

#if BBLITE_HAS_PBR_RENDERER && BBLITE_HAS_PICKING && BBLITE_HAS_DETAILED_PICKING
void finish_detailed_pick(const Engine& engine, PickingInfo& info,
                          const PickDetailReadback& readback,
                          const std::array<float, 16>& view_projection, double sample_x,
                          double sample_y, double width, double height) {
    populate_pick_ray(info, view_projection, sample_x, sample_y, width, height);
    if (info.picked_kind != PickedNodeKind::mesh)
        return;
    PickDetailReadback detail = readback;
    detail.world = upstream::mesh_world_matrix(engine, engine.meshes[info.picked_index]);
    info.detail = detail;
}
#endif

#if BBLITE_HAS_PBR_RENDERER && BBLITE_HAS_PICKING
std::optional<PickRequest> prepare_gpu_pick(const Engine& engine,
                                            [[maybe_unused]] GpuPickerHandle picker,
                                            const Scene& scene, double x, double y) {
    PickRequest request;
#if BBLITE_HAS_DETAILED_PICKING
    // `picker._detailedPicking`, which `enableDetailedPicking` armed: it
    // selects the pin's second pipeline module and the third attachment,
    // so it is read per pick rather than per picker resource.
    request.detailed = detailed_pick_armed(engine, picker);
#endif
    if (scene.camera.value >= engine.cameras.size())
        return std::nullopt;
    const CameraRecord& camera = handle_at(engine.cameras, scene.camera);
    request.camera = &camera;
    if (camera.viewport.has_value()) {
        // The mapping below is the pin's, viewport included, but no reached
        // scene both picks and splits, so the pass is unmeasured through one.
        throw std::runtime_error("A GPU pick through a camera viewport is unmeasured: no "
                                 "reached scene both picks and splits.");
    }
    if (!upstream::map_pick_pointer(
            [&](double width, double height) {
                return upstream::resolve_camera_viewport(camera, width, height);
            },
            [&](double aspect) { return upstream::build_view_projection(camera, aspect); },
            request.scene_uniforms, request.pointer, x, y,
            static_cast<double>(engine.options.width), static_cast<double>(engine.options.height),
            engine.canvas_client_width, engine.canvas_client_height)) {
        return std::nullopt;
    }
    return request;
}

PickingInfo resolve_gpu_pick([[maybe_unused]] const Engine& engine, const PickRequest& request,
                             const std::vector<PickRange>& ranges, const PickReadback& readback) {
    PickingInfo info = resolve_pick_result(ranges, readback.pick_id);
    const upstream::PickPointer& pointer = request.pointer;
    populate_picked_point(info, pointer.view_projection, pointer.sample_x, pointer.sample_y,
                          pointer.w, pointer.h, readback.depth);
#if BBLITE_HAS_DETAILED_PICKING
    if (request.detailed) {
        finish_detailed_pick(engine, info, readback.detail, pointer.view_projection,
                             pointer.sample_x, pointer.sample_y, pointer.w, pointer.h);
    }
#endif
    return info;
}
#endif

// ---------------------------------------------------------------------------
// Render targets (pal_gpu_targets.hpp)

bool geometry_depth_is_borrowed(const Engine& engine, std::size_t task) {
    for (const FrameTaskRecord& record : engine.frame_tasks) {
        if (record.kind == FrameTaskKind::render &&
            record.render.depth.source == RenderTextureSource::geometry_depth &&
            record.render.depth.task.value == task) {
            return true;
        }
    }
    return false;
}

const SolidTexture& effect_texture_for_binding(const EffectWrapperRecord& wrapper,
                                               std::string_view name) {
    for (const EffectTextureSlot& candidate : wrapper.textures) {
        if (candidate.name != name)
            continue;
        if (!candidate.set)
            break;
        return candidate.texture;
    }
    throw std::runtime_error("Effect texture binding '" + std::string(name) +
                             "' was not set before the first render.");
}

void require_effect_uniform_size(const EffectWrapperRecord& wrapper, std::uint32_t uniform_bytes) {
    const std::size_t bytes = wrapper.uniform_values.size() * sizeof(float);
    if (bytes == uniform_bytes)
        return;
    throw std::runtime_error("Effect uniforms carry " + std::to_string(bytes) +
                             " bytes where the declared block takes " +
                             std::to_string(uniform_bytes) + ".");
}

ScaledExtents scaled_target_extents(const RenderTargetRecord& record, std::uint32_t source_width,
                                    std::uint32_t source_height) {
    if (record.resolve_surface_size) {
        const auto size =
            record.resolve_surface_size(source_width, source_height, record.width_ratio);
        return {static_cast<std::uint32_t>(size[0]), static_cast<std::uint32_t>(size[1])};
    }
    if (record.scale_rounding == ScaleRounding::round) {
#if BBLITE_HAS_SCREEN_SPACE
        const upstream::ScreenSpaceScaledSize scaled = upstream::screen_space_scaled_size(
            static_cast<double>(source_width), static_cast<double>(source_height),
            record.width_ratio);
        return ScaledExtents{scaled.width, scaled.height};
#else
        throw std::runtime_error("A render target asks for screen-space rounding in a build "
                                 "that reached no screen-space effect.");
#endif
    }
    return ScaledExtents{scaled_target_extent(source_width, record.width_ratio),
                         scaled_target_extent(source_height, record.height_ratio)};
}

void synchronize_render_target_lifecycles(const Engine& engine) {
    const auto count = engine.render_targets.size();
    for (std::size_t index = 0; index < count; ++index) {
        const auto lifecycle = engine.render_targets[index].lifecycle;
        if (lifecycle)
            lifecycle->synchronize();
    }
}

TextureFormatClass geometry_format_class(const GeometryTextureDescription& description) {
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

// ---------------------------------------------------------------------------
// Pipelines and diagnostics (pal_gpu_pipeline.hpp)

#if BBLITE_HAS_PBR_RENDERER
RenderPipelineKindTraits pipeline_kind_traits(upstream::RenderPipelineKind kind) {
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
        return {Family::pbr, false, Cull::none, false, Topology::line_strip};
    case Kind::pbr_transparent_points:
        return {Family::pbr, true, Cull::none, false, Topology::points};
    case Kind::pbr_transparent_lines:
        return {Family::pbr, true, Cull::none, false, Topology::lines};
    case Kind::pbr_transparent_line_strip:
        return {Family::pbr, true, Cull::none, false, Topology::line_strip};
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
    throw std::runtime_error("render pipeline kind " + std::to_string(static_cast<int>(kind)) +
                             " is not implemented yet.");
}

void validate_render_plan_items(const upstream::RenderPlan& plan) {
    for (const upstream::RenderItem& item : plan.items) {
        if (item.material_kind == upstream::RenderMaterialKind::shader) {
            if (item.shader_variant >= upstream::shader_variant_count()) {
                throw std::runtime_error("this shader material variant is not implemented "
                                         "yet.");
            }
        } else if (item.material_kind == upstream::RenderMaterialKind::node) {
#if BBLITE_NODE_VARIANTS > 0
            if (item.shader_variant >= node_graph_count()) {
                throw std::runtime_error("this node material graph was not composed.");
            }
#else
            throw std::runtime_error("a node material in a build with no composed graphs.");
#endif
        }
    }
}

void reject_uncomposed_family_growth(std::uint32_t added_families) {
#if BBLITE_STANDARD_VARIANTS > 0
    if ((added_families & material_family_standard) != 0 && upstream::standard_variants.empty()) {
        throw std::runtime_error("Post-registration Standard material family has no composed "
                                 "variants.");
    }
#else
    if ((added_families & material_family_standard) != 0) {
        throw std::runtime_error("Post-registration Standard material family in a build with "
                                 "no composed variants.");
    }
#endif
    if ((added_families & material_family_shader) != 0 && upstream::shader_variant_count() == 0) {
        throw std::runtime_error("Post-registration shader material family has no composed "
                                 "variants.");
    }
}
#endif

GeometryTargetClasses geometry_target_classes(const FrameTaskRecord& task) {
    GeometryTargetClasses classes;
    classes.attachments.reserve(task.geometry.attachments.size());
    for (const GeometryTextureDescription& description : task.geometry.attachments) {
        classes.attachments.push_back(geometry_format_class(description));
    }
    classes.trailing_output = task.geometry.target.value != invalid_handle;
    return classes;
}

void require_geometry_target_count(const GeometryTargetClasses& classes,
                                   std::size_t entry_color_target_count, const char* family) {
    const std::size_t total = classes.attachments.size() + (classes.trailing_output ? 1u : 0u);
    if (total == entry_color_target_count)
        return;
    throw std::runtime_error(std::string(family) + " geometry variant writes " +
                             std::to_string(entry_color_target_count) +
                             " targets where its task carries " + std::to_string(total) + ".");
}

#if BBLITE_PINNED_BACKGROUNDS
PinnedBackgroundDraws select_pinned_backgrounds(const FrameOptions& options,
                                                const EnvironmentState& environment) {
    using Kind = upstream::PinnedBackgroundArmKind;
    PinnedBackgroundDraws draws;
    const bool background = options.background_enabled(environment);
    if (background && environment.has_solid_skybox)
        draws.solid = Kind::solid_skybox;
    if (options.skybox_enabled(environment)) {
        draws.environment = environment.skybox_uses_environment ? Kind::hdr_skybox
                            : environment.enable_noise          ? Kind::dds_skybox
                                                                : Kind::dds_skybox_no_dither;
    }
    if (background && environment.has_image_skybox)
        draws.image = Kind::image_skybox;
    if (options.ground_enabled(environment))
        draws.ground = environment.enable_noise ? Kind::ground_dither : Kind::ground;
    return draws;
}
#endif

ClusterRange advance_cluster_range(std::uint32_t index_count, std::uint32_t& cluster_id_base) {
    const std::uint32_t triangle_count = index_count / 3;
    const std::uint32_t id_start = cluster_id_base;
    cluster_id_base += (triangle_count + 127u) / 128u;
    return ClusterRange{triangle_count, id_start};
}

#if BBLITE_HAS_PBR_RENDERER
std::array<float, 4> diagnostic_alpha_options(const upstream::RenderItem& item,
                                              const MaterialRecord* material) {
    std::array<float, 4> options{};
    if (!material) {
        options[2] = 1.0f;
        return options;
    }
    options[0] = item.bucket == upstream::RenderBucket::alpha_blend  ? 2.0f
                 : item.bucket == upstream::RenderBucket::alpha_mask ? 1.0f
                                                                     : 0.0f;
    options[1] = material->alpha_cutoff;
    options[2] = material->alpha;
    return options;
}

DiagnosticIdUniforms diagnostic_id_uniforms(std::uint32_t draw_id,
                                            const std::array<float, 4>& alpha_options) {
    DiagnosticIdUniforms uniforms{};
    uniforms.id_color[0] = static_cast<float>(draw_id & 0xffu) / 255.0f;
    uniforms.id_color[1] = static_cast<float>((draw_id >> 8) & 0xffu) / 255.0f;
    uniforms.id_color[2] = static_cast<float>((draw_id >> 16) & 0xffu) / 255.0f;
    uniforms.id_color[3] = 1.0f;
    std::copy_n(alpha_options.begin(), 4, uniforms.alpha_options);
    return uniforms;
}

DiagnosticClusterUniforms diagnostic_cluster_uniforms(std::uint32_t cluster_base,
                                                      const std::array<float, 4>& alpha_options) {
    DiagnosticClusterUniforms uniforms{};
    uniforms.cluster_options[0] = cluster_base;
    uniforms.cluster_options[1] = 128;
    std::copy_n(alpha_options.begin(), 4, uniforms.alpha_options);
    return uniforms;
}
#endif

// ---------------------------------------------------------------------------
// Shader passes (pal_gpu_shader_passes.hpp)

#if BBLITE_HAS_PBR_RENDERER
bool block_is_shared_scene_matrix(const upstream::ShaderVariantStageBlock& block) {
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

std::array<float, 4> shader_camera_position(const Scene& scene, const Engine& engine,
                                            const CameraRecord& camera) {
    const Vec3d eye = upstream::arc_rotate_eye_position(camera);
#if BBLITE_FLOATING_ORIGIN
    const Vec3d origin = floating_origin_offset(scene, engine);
    return {static_cast<float>(eye.x - origin.x), static_cast<float>(eye.y - origin.y),
            static_cast<float>(eye.z - origin.z), 0.0f};
#else
    (void)scene;
    (void)engine;
    return {static_cast<float>(eye.x), static_cast<float>(eye.y), static_cast<float>(eye.z), 0.0f};
#endif
}

CameraPassMatrices camera_pass_matrices(const Scene& scene, const Engine& engine,
                                        const CameraRecord* camera, double width, double height) {
    CameraPassMatrices matrices;
    if (!camera)
        return matrices;
    matrices.aspect = upstream::effective_aspect_ratio(*camera, width, height);
    matrices.view_projection = upstream::build_view_projection(*camera, matrices.aspect);
    matrices.view = upstream::build_view_matrix(upstream::camera_world_matrix(*camera));
    matrices.projection = upstream::build_scene_projection(*camera, matrices.aspect);
    matrices.camera_position = shader_camera_position(scene, engine, *camera);
    return matrices;
}

void shader_stage_block_floats(const upstream::ShaderVariantStageBlock& block,
                               const ShaderPassMatrices& pass, const MaterialRecord& material,
                               std::vector<float>& floats) {
    // The world a pass without a mesh (a full-screen shader) reads.
    static constexpr std::array<float, 16> identity{
        1.0f, 0.0f, 0.0f, 0.0f, 0.0f, 1.0f, 0.0f, 0.0f,
        0.0f, 0.0f, 1.0f, 0.0f, 0.0f, 0.0f, 0.0f, 1.0f,
    };
    floats.assign(block.float_size, 0.0f);
    std::size_t head = 0;
    const auto copy_from = [&](const float* source, std::size_t count, const char* name) {
        if (!source) {
            throw std::runtime_error(std::string("A shader material declares the '") + name +
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
            copy_from(pass.world ? pass.world->data() : identity.data(), 16, "world");
            head += 16;
            break;
        case upstream::ShaderSystemMatrix::world_view:
            copy_from(pass.world_view ? pass.world_view->data() : nullptr, 16, "worldView");
            head += 16;
            break;
        case upstream::ShaderSystemMatrix::view:
            copy_from(pass.view ? pass.view->data() : nullptr, 16, "view");
            head += 16;
            break;
        case upstream::ShaderSystemMatrix::projection:
            copy_from(pass.projection ? pass.projection->data() : nullptr, 16, "projection");
            head += 16;
            break;
        case upstream::ShaderSystemMatrix::view_projection:
            copy_from(pass.view_projection, 16, "viewProjection");
            head += 16;
            break;
        case upstream::ShaderSystemMatrix::world_view_projection:
            copy_from(pass.world_view_projection ? pass.world_view_projection->data()
                                                 : pass.view_projection,
                      16, "worldViewProjection");
            head += 16;
            break;
        case upstream::ShaderSystemMatrix::camera_position:
            copy_from(pass.camera_position ? pass.camera_position->data() : nullptr, 3,
                      "cameraPosition");
            // vec3 uniform members consume one 16-byte slot.
            head += 4;
            break;
        }
    }
    for (const std::array<std::uint32_t, 3>& gather : block.gather) {
        for (std::uint32_t index = 0; index < gather[2]; ++index) {
            floats[gather[0] + index] = material.shader_uniform_values[gather[1] + index];
        }
    }
}
#endif

} // namespace bbl::pal
