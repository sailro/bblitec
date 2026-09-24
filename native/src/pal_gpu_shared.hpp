// Vertex packing shared by the SDL_GPU and Dawn render backends.
// Moved verbatim from pal_sdl_gpu.cpp so both backends upload
// byte-identical vertex data.
#pragma once
#include <bblite/features/compute_frame_graph.hpp>
#include <bblite/features/device_recovery.hpp>
#include <bblite/features/has_audio.hpp>
#include <bblite/features/has_billboards.hpp>
#include <bblite/features/has_detailed_picking.hpp>
#include <bblite/features/has_pbr_renderer.hpp>
#include <bblite/features/has_picking.hpp>
#include <bblite/features/has_post_process.hpp>
#include <bblite/features/has_screen_space.hpp>
#include <bblite/features/has_splats.hpp>
#include <bblite/features/has_sprites.hpp>
#include <bblite/features/has_standard_uv_transform.hpp>
#include <bblite/features/has_ui.hpp>
#include <bblite/features/shadow_morph_bounds.hpp>
#include <bblite/features/shadows_csm.hpp>
#include <bblite/features/workers.hpp>

#include "pal_compressed_formats.hpp"
#include "pal_record_sync.hpp"
#if BBLITE_HAS_AUDIO
#include <bblite/pal_audio.hpp>
#endif

#include <span>
#include "pal_device_options.hpp"

#include <bblite/pal.hpp>
#include <bblite/pal_image.hpp>
#include <bblite/runtime.hpp>
#include <bblite/teardown.hpp>
// The generator's capability defines, ahead of the first test of one.
#include <bblite/upstream/render_capabilities.hpp>
#if BBLITE_WORKERS
#include <bblite/pal_offscreen.hpp>
#endif
#if BBLITE_COMPUTE_FRAME_GRAPH
#include <bblite/pal_compute_frame_graph.hpp>
#endif
#if BBLITE_GPU_INSTANCE_COLORS
#include <bblite/js_data.hpp>
#endif
// The backend-neutral RmlUi frame types, for the scissor clamp every UI
// consumer applies to a recorded draw before encoding it.
#if BBLITE_HAS_UI
#include <bblite/pal_ui.hpp>
#endif
// An always-emitted pinned read every scene shape carries: the surface
// sample count (the effect drivers compile with no renderer_plan.hpp, so it
// cannot ride that header).
#include <bblite/upstream/pinned_surface.hpp>
// Material slots and mesh transforms belong to scene renderers.
#if BBLITE_HAS_PBR_RENDERER
#include <bblite/upstream/material_texture_slots.hpp>
#include <bblite/upstream/pinned_world_transform.hpp>
#include <bblite/upstream/pinned_rgbd.hpp>
#include <bblite/upstream/pinned_matrix.hpp>
#endif
#include <bblite/upstream/pinned_texture.hpp>
#if BBLITE_HAS_SCREEN_SPACE
#include <bblite/upstream/frame_graph_screen_space.hpp>
#include <bblite/upstream/screen_space_shaders.hpp>
#endif
#if BBLITE_HAS_PICKING
#include <bblite/upstream/picking_math.hpp>
#if BBLITE_DEFORM_PICKING
#include <bblite/upstream/picking_projection.hpp>
#endif
#endif
// The render plan is generated only for scenes that register a
// SceneContext; a sprite-only scene has none, and reaches this header for
// the frame options, capture gate and clock alone.
#if BBLITE_HAS_PBR_RENDERER
#include <bblite/upstream/renderer_plan.hpp>
#endif
// The billboard family's own generated layout, for the pick contributor's
// attribute agreement below. Emitted only for a scene that builds a system.
#if BBLITE_HAS_BILLBOARDS
#include <bblite/upstream/billboard_system.hpp>
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
// The pin's background arms as its factories built them, with the lowered
// builders that fill their buffers. Both backends build and draw from it.
#if BBLITE_PINNED_BACKGROUNDS
#include <bblite/upstream/pinned_backgrounds.hpp>
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
#if BBLITE_GPU_MORPH_STORAGE
#include <bblite/upstream/morph_targets.hpp>
#endif
#include <atomic>
#include <cstdio>

namespace bbl::pal {
class TextGpuCapture;

#if BBLITE_DEVICE_RECOVERY
inline thread_local Engine* draw_count_engine = nullptr;
struct DrawCountScope {
    Engine* previous;
    explicit DrawCountScope(Engine& engine) : previous(draw_count_engine) {
        draw_count_engine = &engine;
    }
    ~DrawCountScope() { draw_count_engine = previous; }
};
#endif

template <typename Function, typename... Args>
inline void count_gpu_draw(Function function, Args&&... args) {
#if BBLITE_DEVICE_RECOVERY
    if (draw_count_engine)
        ++draw_count_engine->draw_call_count;
#endif
    function(std::forward<Args>(args)...);
}

/**
 * The `std::size_t` sentinel this file's comments already call `npos`: an
 * unresolved variant, an unbuilt program, a draw outside any geometry task.
 * Defined once so the backends and the selectors spell the absence the same
 * way instead of repeating the `numeric_limits` incantation per site.
 */
inline constexpr std::size_t npos = std::numeric_limits<std::size_t>::max();

#if BBLITE_LOCAL_CUBEMAP
// Replay the pin's recorded copies over the retained source face payloads.
// Decoding/upload uses the same path as an ordinary environment cubemap.
inline EnvironmentState local_cubemap_texture(const LocalCubemapRecord& local) {
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

/** Whether the scene set a backend planned at startup has changed. */
inline bool registered_scene_set_changed(const Engine& engine,
                                         const std::vector<std::shared_ptr<Scene>>& planned) {
    if (engine.registered_scenes.size() != planned.size())
        return true;
    for (std::size_t i = 0; i < planned.size(); ++i) {
        const std::shared_ptr<Scene>& current = engine.registered_scenes[i];
        if (static_cast<bool>(current) != static_cast<bool>(planned[i])) {
            return true;
        }
        if (current && !current->shares_identity(*planned[i]))
            return true;
    }
    return false;
}

/** Stop this render plan whenever its scene set changes, including removal. */
inline bool
request_renderer_restart_if_scene_set_changed(Engine& engine,
                                              const std::vector<std::shared_ptr<Scene>>& planned) {
#if BBLITE_DEVICE_RECOVERY
    if (engine.device_recovery && engine.device_recovery->requested)
        return true;
#endif
    if (!registered_scene_set_changed(engine, planned))
        return false;
    engine.renderer_restart_requested = !engine.registered_scenes.empty();
    return true;
}

/**
 * Native presents every browser canvas through one operating-system window.
 * Retained layout supplies each canvas's actual rectangle when the page
 * attached the canvas to the projected document (scenes 227 and 228). A
 * canvas the source created and appended to host chrome outside that
 * document -- antigravity-racer's second player -- is never laid out, so
 * the primary scene and every registered auxiliary surface scene without a
 * rectangle share the window in equal horizontal panes, in registration
 * order. The scene's render targets use the pane extent; only presentation
 * applies its offset.
 */
#if BBLITE_HAS_UI
inline bool surface_canvas_laid_out(const Engine& engine, UiElementHandle canvas) {
    const auto& rect = handle_at(engine.ui_elements, canvas).client_rect;
    return rect.width > 0.0 && rect.height > 0.0;
}

inline PixelViewport laid_out_canvas_pane(const Engine& engine, UiElementHandle canvas,
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

/** An auxiliary registered scene whose surface canvas retained layout never placed. */
inline bool unplaced_surface_scene(const Engine& engine, const Scene& scene) {
    return scene.surface_canvas.has_value() &&
           !surface_canvas_laid_out(engine, *scene.surface_canvas);
}
#endif

/**
 * The equal pane of `scene` among the primary scene and the unplaced
 * auxiliary surface scenes, or nullopt when there is no such split (one
 * pane only) or `scene` is not one of them (a utility-layer overlay).
 */
inline std::optional<PixelViewport> equal_surface_pane(const Engine& engine, const Scene& scene,
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

inline std::optional<PixelViewport> scene_surface_pane(const Engine& engine, const Scene& scene,
                                                       std::uint32_t width, std::uint32_t height) {
#if BBLITE_HAS_UI
    if (scene.surface_canvas && surface_canvas_laid_out(engine, *scene.surface_canvas)) {
        return laid_out_canvas_pane(engine, *scene.surface_canvas, width, height);
    }
#endif
    return equal_surface_pane(engine, scene, width, height);
}

/** The pane of the registered scene presenting through `surface_canvas`. */
inline std::optional<PixelViewport>
surface_canvas_pane(const Engine& engine, std::optional<UiElementHandle> surface_canvas,
                    std::uint32_t target_width, std::uint32_t target_height) {
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

inline std::pair<std::uint32_t, std::uint32_t>
surface_target_extent(const Engine& engine, const RenderTargetRecord& target, std::uint32_t width,
                      std::uint32_t height) {
    const auto pane = surface_canvas_pane(engine, target.surface_canvas, width, height);
    return {target.width > 0 ? target.width
            : pane           ? static_cast<std::uint32_t>(pane->width)
                             : width,
            target.height > 0 ? target.height
            : pane            ? static_cast<std::uint32_t>(pane->height)
                              : height};
}

template <typename Targets>
inline bool surface_targets_changed(const Engine& engine, const Targets& targets,
                                    std::uint32_t width, std::uint32_t height) {
    for (std::size_t i = 0; i < engine.render_targets.size(); ++i) {
        const auto& record = engine.render_targets[i];
        if (!record.surface_canvas)
            continue;
        const auto [expected_width, expected_height] =
            surface_target_extent(engine, record, width, height);
        if (targets[i].width != expected_width || targets[i].height != expected_height)
            return true;
    }
    return false;
}

/** Target extent used when building one surface scene's projection. */
inline PixelViewport scene_surface_extent(const Engine& engine, const Scene& scene,
                                          std::uint32_t target_width, std::uint32_t target_height) {
    return scene_surface_pane(engine, scene, target_width, target_height)
        .value_or(PixelViewport{
            0,
            0,
            static_cast<std::int32_t>(target_width),
            static_cast<std::int32_t>(target_height),
        });
}

/** Final viewport/scissor after composing a camera viewport into its pane. */
#if BBLITE_HAS_PBR_RENDERER
inline std::optional<PixelViewport> scene_camera_viewport(const Engine& engine, const Scene& scene,
                                                          const CameraRecord& camera,
                                                          std::uint32_t target_width,
                                                          std::uint32_t target_height) {
    const std::optional<PixelViewport> pane =
        scene_surface_pane(engine, scene, target_width, target_height);
    if (!pane.has_value()) {
        if (!camera.viewport.has_value())
            return std::nullopt;
        return upstream::resolve_camera_viewport(camera, static_cast<double>(target_width),
                                                 static_cast<double>(target_height));
    }
    if (!camera.viewport.has_value())
        return pane;
    PixelViewport viewport = upstream::resolve_camera_viewport(
        camera, static_cast<double>(pane->width), static_cast<double>(pane->height));
    viewport.x += pane->x;
    viewport.y += pane->y;
    return viewport;
}
#endif

/**
 * The scene's active camera, read from the live `scene.camera` at each
 * use as the pin reads it, or null when the scene has none. Without one
 * the pin still runs the scene pass: it clears and draws, but writes no
 * scene block (`_writePassSceneUBO` returns first, render-task-base.ts),
 * so the pass draws through the zero block the frame starts with and
 * nothing it projects reaches a fragment.
 */
inline CameraRecord* scene_camera(Engine& engine, const Scene& scene) {
    return handle_find(engine.cameras, scene.camera);
}

/**
 * A render task's camera, the pin's `cfg.cam ?? scene.camera`: the task's
 * own when it was given one, else `scene`'s, the camera of the scene it
 * renders. Null is the no-camera pass `scene_camera` describes.
 */
inline const CameraRecord* render_task_camera(const Engine& engine, const FrameTaskRecord& task,
                                              const CameraRecord* scene) {
    const CameraRecord* own =
        task.render.has_camera ? handle_find(engine.cameras, task.render.camera) : nullptr;
    return own ? own : scene;
}

/**
 * The pin's nullish camera, as a record.
 *
 * `getEffectiveAspectRatio` and `resolveCameraViewport` both answer the
 * whole target for a camera with no viewport, so a scene that has no camera
 * at all goes through the same pinned bodies over this rather than having
 * the whole-target answer restated at each call -- the restatement being the
 * copy that drifts when the pin's own arm moves. Only its absent viewport is
 * read; it carries no pose.
 *
 * File scope, so no call pays a function-local static's initialization
 * guard, and OUTSIDE the floating-origin block below: the shadow refresh
 * that reads it is not gated on that feature, and putting it inside broke
 * every scene without one.
 */
inline const CameraRecord no_camera_record{};

#if BBLITE_FLOATING_ORIGIN
/**
 * The active camera's world translation, which every consumer subtracts.
 *
 * The pin derives the offset from `scene.camera.worldMatrix` at the moment
 * of use rather than mirroring it into scene state
 * (large-world/floating-origin.ts `getFloatingOriginOffset`), so this port
 * reads it the same way -- one accessor, so the mesh world, the view
 * transpose and the lights block cannot disagree about which camera the
 * frame is relative to. With no camera the pin returns the zero vector, so
 * that arm is explicit here rather than the eye of a record no factory
 * built.
 *
 * In the camera's own width, not the float world matrix's: under the pin's
 * high-precision matrix the camera's storage is F64, so the offset is the
 * unrounded eye and every `large - large = small` runs at full width.
 */
inline Vec3d floating_origin_offset(const Scene& scene, const Engine& engine) {
    const CameraRecord* camera = handle_find(engine.cameras, scene.camera);
    return camera ? upstream::arc_rotate_eye_position(*camera) : Vec3d{};
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
inline void apply_light_floating_origin(std::span<upstream::LightEntry> entries,
                                        std::uint32_t count, const Scene& scene,
                                        const Engine& engine) {
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

#if BBLITE_HAS_SPRITES
inline bool sprite_blend_equal(const SpriteBlendDescriptor& left,
                               const SpriteBlendDescriptor& right) {
    return left.enabled == right.enabled && left.color.src == right.color.src &&
           left.color.dst == right.color.dst && left.alpha.src == right.alpha.src &&
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

inline SpriteLayerPipelinePlan sprite_layer_pipeline_plan(const Sprite2DLayerRecord& layer) {
    const bool has_depth = layer.depth_mode != Sprite2DDepthMode::none;
    return SpriteLayerPipelinePlan{
        layer.uv_scroll, has_depth, layer.depth_mode == Sprite2DDepthMode::test_write,
        layer.alpha_to_coverage,
        layer.instance_floats_per_sprite * static_cast<std::uint32_t>(sizeof(float))};
}

/**
 * A layer's program: the pin's module for its permutation, deployed whole
 * under this stem -- the stock program (0) or a custom one (its 1-based
 * index) -- with `<stem>.vert` and `<stem>.frag` both compiled from it.
 * `spriteProgramStem` (upstream-lower.ts) deploys the same names.
 */
inline std::string sprite_program_stem(std::uint32_t program, const SpriteLayerPipelinePlan& plan) {
    std::string stem = program == 0u   ? std::string("sprite")
                       : program == 1u ? std::string("sprite_custom")
                                       : "sprite_custom_" + std::to_string(program);
    if (plan.has_depth)
        stem += "_depth";
    if (plan.scroll)
        stem += "_uvscroll";
    return stem;
}

/** Fixed pipeline identity for layers targeting the same scene pass. */
inline bool sprite_scene_pipeline_compatible(const Sprite2DLayerRecord& left,
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
#endif

#if BBLITE_HAS_PBR_RENDERER
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
inline std::size_t variant_pipeline_key(std::size_t variant, upstream::RenderPipelineKind kind,
                                        std::initializer_list<bool> flags) {
    std::size_t key =
        variant * upstream::render_pipeline_kind_count + static_cast<std::size_t>(kind);
    for (const bool flag : flags)
        key = key * 2 + (flag ? 1 : 0);
    return key;
}

/**
 * The variant an ESM caster pipeline is keyed by.
 *
 * A caster's colour format is its own generator's recorded row, so two
 * generators whose factories returned different formats must not share a
 * pipeline. Folding the generator's ESM ordinal into the VARIANT rather
 * than into the key is what keeps that fold independent of how many flags
 * `variant_pipeline_key` happens to pack.
 */
inline std::size_t esm_keyed_variant(std::size_t variant, std::size_t variant_count,
                                     std::uint32_t esm_shadow_index) {
    return esm_shadow_index == invalid_handle ? variant
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
    if (shadow_pass)
        return upstream::shadow_map_depth_compare;
#else
    (void)shadow_pass;
#endif
    return upstream::pinned_depth_compare;
}

inline float pass_depth_clear(bool shadow_pass) {
#if BBLITE_SHADOW_RECEIVERS
    if (shadow_pass)
        return upstream::shadow_map_depth_clear;
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
inline std::uint32_t pass_depth_samples(bool shadow_pass, std::uint32_t scene_samples) {
#if BBLITE_SHADOW_RECEIVERS
    if (shadow_pass)
        return upstream::shadow_map_samples;
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
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iomanip>
#include <iostream>
#include <limits>
#include <memory>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace bbl::pal {

#if BBLITE_HAS_PBR_RENDERER
/**
 * The floating-origin offset, or the zero vector when the mode is off.
 *
 * The `#if` lives here rather than at each call site: a consumer asks what
 * the offset is and gets one answer, whichever build it is in.
 */
inline Vec3d frame_floating_origin_offset([[maybe_unused]] const Scene& scene,
                                          [[maybe_unused]] const Engine& engine) {
#if BBLITE_FLOATING_ORIGIN
    return floating_origin_offset(scene, engine);
#else
    return Vec3d{};
#endif
}

/**
 * The world one mesh draw's block carries: the pin's `mesh.worldMatrix`,
 * packed the way every material family packs it -- `packMat4IntoF32` over
 * the stored f32 matrix, or under floating origin
 * `packMat4IntoF32WithOffset` over the double composition. A thin-instance
 * matrix, a bone palette and a morph compose on top of it inside the vertex
 * stage, as the pin's `finalWorld` does, so every family and pass asks here.
 */
inline std::array<float, 16> mesh_block_world([[maybe_unused]] const Scene& scene,
                                              const Engine& engine, const MeshRecord& record) {
#if BBLITE_FLOATING_ORIGIN
    return upstream::mesh_world_eye_relative(engine, record, floating_origin_offset(scene, engine));
#else
    return upstream::mesh_world_matrix(engine, record);
#endif
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
inline bool geometry_depth_is_borrowed(const Engine& engine, std::size_t task) {
    for (const FrameTaskRecord& record : engine.frame_tasks) {
        if (record.kind == FrameTaskKind::render &&
            record.render.depth.source == RenderTextureSource::geometry_depth &&
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
    throw std::runtime_error("Depth-only render target has no color texture.");
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

/**
 * A geometry task's Standard renderables' velocity state
 * (`standard-geometry-renderable.ts`), one per mesh slot.
 *
 * The pin builds one renderable per bound mesh. It packs the mesh's world
 * as `previousWorld` when built and starts with `velocityReady` false; each
 * frame's update writes the mesh block from that snapshot and flag, then
 * snapshots the current world and sets the flag, so a renderable's first
 * frame writes `velocityEnabled` 0 and the composed vertex's previous clip
 * falls back to the current one. The task rebuilds every renderable when
 * the scene's renderable version moves (`rebuildBoundMeshes`), which here is
 * the scene's `render_topology_version`, and a slot a new mesh reuses is a
 * new renderable. The composed velocity arm and its block tail belong to the
 * Standard geometry output alone, so the history is written for nothing
 * else. Unguarded because the geometry encode names it in both backends
 * whatever the variant count.
 */
struct PinnedVelocityHistory {
    struct Renderable {
        MeshHandle mesh{};
        /** The pin's `previousWorld` snapshot and `velocityReady`. */
        std::array<float, 16> previous_world{};
        bool velocity_ready = false;
        /**
         * The history frame this renderable last updated in and what that
         * update wrote: the pin updates each bound renderable once a frame,
         * before any draw, so every draw of the mesh in the frame binds the
         * same block.
         */
        std::uint64_t updated_frame = 0;
        std::array<float, 16> written_previous_world{};
        float written_velocity_enabled = 0.0f;
    };
    std::uint64_t frame = 0;
    std::uint64_t topology_version = 0;
    std::vector<Renderable> renderables;
};

/** Opens a task frame; a moved renderable version rebuilds every renderable. */
inline void begin_pinned_velocity_frame(PinnedVelocityHistory& history, const Scene& scene) {
    if (history.frame == 0 || history.topology_version != scene.render_topology_version) {
        history.renderables.clear();
        history.topology_version = scene.render_topology_version;
    }
    ++history.frame;
}

/**
 * The renderable's update for this frame, run once however many draws the
 * mesh has: builds the renderable on its first frame, then writes the
 * snapshot and flag and snapshots `world`.
 */
inline const PinnedVelocityHistory::Renderable&
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

// Where the per-instance streams sit in the shared attribute table both
// backends bind against. The matrix columns take the four lanes after the
// vertex attributes, and the RGBA stream a material with
// `useThinInstanceColors` reads takes the one after them -- the same
// numbers `src/shader-ir.ts` specializes the WGSL to, stated once here so
// the two backends cannot disagree about them.
inline constexpr std::uint32_t instance_matrix_first_location = 16;
inline constexpr std::uint32_t instance_color_location = instance_matrix_first_location + 4;

struct GpuVertex {
    float position[3];
    float normal[3];
    float tangent[4];
    float uv[2];
    float uv2[2];
    float color[4];
#if BBLITE_GPU_DEFORMATION
    float joints[4];
    float weights[4];
    float morph_position_0[3];
    float morph_position_1[3];
    float morph_normal_0[3];
    float morph_normal_1[3];
    float morph_tangent_0[3];
    float morph_tangent_1[3];
#if BBLITE_PBR_VARIANTS > 0 || BBLITE_STANDARD_SKELETON
    // The pin's own skinned vertex stages take joint indices as integers where
    // the transcribed one takes them as floats. Both are carried while the two
    // paths coexist, and this sits last so no existing attribute offset moves;
    // the float pair goes away with the transcription.
    std::uint32_t joint_indices[4];
#endif
#endif
};
#if BBLITE_GPU_DEFORMATION && (BBLITE_PBR_VARIANTS > 0 || BBLITE_STANDARD_SKELETON)
static_assert(sizeof(GpuVertex) == 192);
#elif BBLITE_GPU_DEFORMATION
static_assert(sizeof(GpuVertex) == 176);
#else
static_assert(sizeof(GpuVertex) == 72);
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
inline constexpr std::uint32_t vertex_stream_slot(VertexInputStream stream) {
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
inline constexpr std::string_view vertex_stream_group(VertexInputStream stream) {
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
inline constexpr std::uint64_t vertex_stream_stride([[maybe_unused]] VertexInputStream stream) {
#if BBLITE_GPU_INSTANCING
    if (stream != VertexInputStream::vertex) {
        return upstream::pinned_instance_group_stride(vertex_stream_group(stream));
    }
#endif
    return sizeof(GpuVertex);
}

/** Whether a stream steps per instance rather than per vertex. */
inline constexpr bool vertex_stream_is_instanced(VertexInputStream stream) {
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
#if BBLITE_HAS_PBR_RENDERER
inline const TextureData* material_slot_texture(const MaterialRecord& material,
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

/** Whether one slot uploads through an sRGB view, per the table's rule. */
inline bool material_slot_srgb(upstream::MaterialTextureSrgb rule, const MaterialRecord* material,
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

/** The 1x1 texel an image-less slot uploads, per the table's rule. */
inline std::array<std::uint8_t, 4> material_slot_fallback(upstream::MaterialTextureFallback rule,
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

/**
 * The table row serving one of the pin's own binding names, or nullptr.
 *
 * The names are Babylon's, the rows are generated, and this is where the
 * two meet for both backends' pinned bind paths. A variant that declares a
 * resource the table does not know fails by name rather than sampling
 * whatever sat at that index.
 */
inline const upstream::MaterialTextureSlot* material_slot_for_binding(std::string_view name) {
    for (const upstream::MaterialTextureSlot& slot : upstream::material_texture_slots) {
        if (slot.texture_name.empty())
            continue;
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
inline const upstream::MaterialTextureSlot*
material_slot_for_source(upstream::MaterialTextureSource source) {
    for (const upstream::MaterialTextureSlot& slot : upstream::material_texture_slots) {
        if (slot.source == source) {
            return &slot;
        }
    }
    return nullptr;
}

#endif

#if BBLITE_GPU_DEFORMATION
// Vertex deformation uniforms shared by both render backends (moved
// verbatim from pal_sdl_gpu.cpp).
struct DeformationUniforms {
    std::array<std::array<float, 16>, 64> bone_matrices{};
    float morph_weights[4]{};
    float options[4]{};
};

inline DeformationUniforms build_deformation_uniforms(const MeshRecord& mesh) {
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

#if BBLITE_HAS_PICKING
// GPU picking's backend-independent half. The arithmetic -- the pointer
// mapping, the two shears, the id encoding and decoding -- is lowered from
// `picking/gpu-picker.ts`, `picking/gs-picking-pipeline.ts` and the
// splat picking fragment into `upstream/picking_math.hpp`; the records and
// the orchestration both backends share are here.

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
    std::uint32_t excluded_thin_instance_start = 0;
    std::uint32_t excluded_thin_instance_count = 0;
    std::uint32_t _pad = 0;
};

#if BBLITE_HAS_SPLATS
using upstream::compute_cloud_pick_matrix;
#endif

/**
 * One candidate the pick pass drew, in submission order.
 *
 * Upstream keeps mesh ranges and contributor ranges apart because a thin
 * instance makes a mesh's range wider than one id; nothing in the reached
 * slice does, so one id is one node and the two lists are one -- except
 * for a billboard system, which is the shape the pin's contributor seam
 * was drawn for: one entity owns `system.count` consecutive ids, and
 * `pick_id - id` is the sprite's own slot.
 */
struct PickRange {
    std::uint32_t id = 0;
    PickedNodeKind kind = PickedNodeKind::none;
    std::uint32_t index = invalid_handle;
    std::uint32_t count = 1;
    /** A mesh candidate's handle generation (`MeshHandle::generation`). */
    std::uint32_t generation = 0;
};

/**
 * The id the one-pixel target held, resolved against what was drawn.
 *
 * Zero is the cleared attachment, which is upstream's "nothing here"; an
 * id no range claims cannot happen while the draw loop and the range list
 * agree, and saying so is cheaper than debugging a silent miss if they
 * ever stop agreeing.
 */
inline PickingInfo resolve_pick_result(const std::vector<PickRange>& ranges,
                                       std::uint32_t pick_id) {
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

/**
 * The pin's `BB` block for one billboard system's pick draw, 48 bytes.
 *
 * `packBillboardPickUbo` writes the camera basis the pick vertex stage
 * expands its quad around. It cannot read that basis from the pick scene
 * block -- that carries only the sheared view projection -- so upstream
 * lifts rows 0 and 1 out of the column-major VIEW matrix on the CPU,
 * which is the same `normalize(view rowN)` the visible billboard stage
 * derives. `cutoff` is a cutout system's alpha cutoff and zero otherwise;
 * `axis` is the lock axis an axis-locked basis reads and the facing
 * system's zero vector otherwise.
 */
struct BillboardPickUniforms {
    std::array<float, 3> cam_right{};
    std::uint32_t base_id = 0;
    std::array<float, 3> cam_up{};
    float cutoff = 0.0f;
    std::array<float, 3> axis{};
    float pad = 0.0f;
};
static_assert(sizeof(BillboardPickUniforms) == 48, "the pin's billboard pick UBO is 48 bytes");

#if BBLITE_HAS_BILLBOARDS
/** One system's block, packed by the pin's `packBillboardPickUbo`. */
inline BillboardPickUniforms build_billboard_pick_uniforms(const std::array<float, 16>& view,
                                                           std::uint32_t base_id, float cutoff,
                                                           Vec3 axis) {
    BillboardPickUniforms out;
    upstream::pack_billboard_pick_ubo(view, static_cast<double>(base_id),
                                      static_cast<double>(cutoff), axis, out);
    return out;
}
#endif

/** The pin's contributor gate: a hidden or empty system draws nothing. */
#if BBLITE_HAS_SPRITES
inline bool billboard_pick_draws(const BillboardSystemRecord& system) {
    return system.visible && system.count != 0;
}

#if BBLITE_HAS_BILLBOARDS
/**
 * How many of the visible stage's instance attributes the pick stage
 * reads: locations 0..5, everything but the colour lane the pick fragment
 * replaces with an id. The table is the billboard lowerer's, generated
 * from the RENDER pipeline's own byte offsets -- which is exactly what the
 * pick module's private copy of them must equal -- so the agreement is
 * asserted at compile time rather than re-checked per pipeline build.
 */
inline constexpr std::size_t billboard_pick_attributes = 6;
static_assert(upstream::billboard_instance_attributes.size() >= billboard_pick_attributes,
              "the pinned billboard layout dropped an attribute the pick stage reads");
static_assert(
    [] {
        for (std::size_t index = 0; index < billboard_pick_attributes; ++index) {
            if (upstream::billboard_instance_attributes[index].shader_location != index) {
                return false;
            }
        }
        return true;
    }(),
    "the pinned billboard attributes no longer arrive in location order");
#endif

/**
 * The composed module a system's orientation picks through.
 *
 * Only the vertex stage forks -- the pin's `makeBillboardPickWgsl` swaps
 * `basis()` and nothing else -- so the second orientation deploys one
 * vertex stem and shares the first's fragment, exactly as the visible
 * billboard pair does.
 */
inline const char* billboard_pick_vertex_stem(BillboardOrientation orientation) {
    return orientation == BillboardOrientation::axis_locked ? "picking-billboard-axis-locked.vert"
                                                            : "picking-billboard.vert";
}
inline const char* billboard_pick_fragment_stem() { return "picking-billboard.frag"; }

/** One billboard system the pick pass draws, and the range it owns. */
struct PickBillboardCandidate {
    /** Index into `scene.billboard_systems`, which keys per-system GPU state. */
    std::size_t system_index = 0;
    std::uint32_t base_id = 0;
    std::uint32_t count = 0;
    BillboardOrientation orientation = BillboardOrientation::facing;
    Vec3 axis{};
};

/**
 * The billboard half of the contributor walk, decided once for both
 * backends -- the twin of `collect_pick_mesh_candidates` below, and for
 * the same reason: the id policy is what the two backends must not drift
 * on, since `pick_id - base_id` is the sprite index a scene reads back.
 *
 * The pin gives one system `system.count` consecutive ids and lets a
 * hidden or empty one CONSUME its range without drawing, so the mapping
 * stays positional (`pick-contributor.ts`: "a hidden/empty entity still
 * consumes its ids"). Both halves live here; each backend keeps only its
 * pipeline and bind mechanics.
 */
inline void collect_pick_billboard_candidates(
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

/** Refuse unsupported contributors only when this scene's pick pass draws them. */
inline void validate_pick_contributors([[maybe_unused]] const Engine& engine,
                                       [[maybe_unused]] const Scene& scene,
                                       [[maybe_unused]] bool detailed, bool pick_sources) {
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

#if BBLITE_HAS_SPLATS
/** `encodeIdToColor`, stored through the cloud's F32 picking block. */
inline std::array<float, 3> encode_pick_id_to_color(std::uint32_t id) {
    const std::array<double, 3> color = upstream::encode_id_to_color(static_cast<double>(id));
    return {static_cast<float>(color[0]), static_cast<float>(color[1]),
            static_cast<float>(color[2])};
}
#endif

/**
 * One pick's readback layout, stated once for both backends.
 *
 * Every attachment is copied into its own 256-byte row of one staging
 * buffer, so the row count and the buffer size are the same fact -- and a
 * mismatch between the buffer's SIZE and the map's LENGTH truncates
 * silently rather than failing, which is why neither backend spells it.
 */
inline constexpr std::uint32_t pick_readback_row = 256;
inline constexpr std::uint32_t pick_color_targets = BBLITE_HAS_DETAILED_PICKING ? 3u : 2u;
inline constexpr std::uint32_t pick_depth_offset = 1u * pick_readback_row;
inline constexpr std::uint32_t pick_detail_offset = 2u * pick_readback_row;
inline constexpr std::uint64_t pick_staging_bytes =
    static_cast<std::uint64_t>(pick_color_targets) * pick_readback_row;

#if BBLITE_HAS_DETAILED_PICKING
/**
 * The detailed attachment's one texel, read the way the pin's
 * `readDetailTarget` reads it.
 *
 * The pin's detailed fragment packs
 * `vec4u(primitiveIndex, bitcast<u32>(local.x), .y, .z)` into an
 * `rgba32uint` target, and the readback reinterprets the same sixteen
 * bytes twice: lane 0 as a `u32` where `0xffffffff` is "no primitive",
 * lanes 1..3 back through `Float32Array` as the interpolated position.
 * Both backends copy that texel and decode it here, once.
 */
/**
 * The primitive-index lane's "no primitive" clear, spelled once.
 *
 * The pin clears the detail attachment's red lane to 0xFFFFFFFF and
 * `decode_pick_detail` tests for exactly that word. Backends state a clear
 * as a colour, and SDL's is float: 4294967295.0f is not representable, so
 * writing the literal there rounds to 4294967296.0 and the two backends
 * clear to different words. Kept as a double here and converted by each
 * backend, so the value has one home and the rounding is visible where it
 * happens rather than hidden in a literal.
 */
inline constexpr std::uint32_t pick_detail_no_primitive = 0xFFFFFFFFu;
inline constexpr double pick_detail_clear_red = static_cast<double>(pick_detail_no_primitive);

inline PickDetailReadback decode_pick_detail(const std::uint8_t* texel) {
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

/**
 * `picker._detailedPicking`, which `enableDetailedPicking` arms.
 *
 * Read per pick rather than per picker resource, because it selects the
 * pin's second pipeline module and a third attachment for THAT call.
 */
inline bool detailed_pick_armed(const Engine& engine, GpuPickerHandle picker) {
    return picker.value < engine.gpu_pickers.size() &&
           handle_at(engine.gpu_pickers, picker).detailed;
}
#endif

/**
 * The pin's clears for the pick pass's colour attachments, in attachment
 * order: 0 is "nothing here" for the id, 1 is "nothing here" for the depth
 * colour under reverse-Z, and the detail lane's no-primitive word. The depth
 * buffer clears to 0. Each backend states these in its own colour type.
 */
inline constexpr std::array<std::array<double, 4>, pick_color_targets> pick_color_clears{{
    {0.0, 0.0, 0.0, 0.0},
    {1.0, 0.0, 0.0, 0.0},
#if BBLITE_HAS_DETAILED_PICKING
    {pick_detail_clear_red, 0.0, 0.0, 0.0},
#endif
}};
inline constexpr double pick_depth_clear = 0.0;

/** One pick's staging rows, decoded: the id, the depth colour, the detail. */
struct PickReadback {
    std::uint32_t pick_id = 0;
    float depth = 1.0f;
#if BBLITE_HAS_DETAILED_PICKING
    PickDetailReadback detail{};
#endif
};

/**
 * The pin's readback of the mapped staging buffer: `pickId` through its own
 * lowered decode, `depth` as the row's first float, and the detail texel
 * only when the pick was detailed. Both backends map the same layout.
 */
inline PickReadback decode_pick_readback(const std::uint8_t* staging,
                                         [[maybe_unused]] bool detailed) {
    PickReadback readback;
    readback.pick_id = upstream::decode_pick_id(staging);
    std::memcpy(&readback.depth, staging + pick_depth_offset, sizeof(readback.depth));
#if BBLITE_HAS_DETAILED_PICKING
    if (detailed)
        readback.detail = decode_pick_detail(staging + pick_detail_offset);
#endif
    return readback;
}

/**
 * Clears `engine.pick_hook` when the frame loop's scope ends, however it
 * ends. The hook holds the backend state, the scene and the render plan
 * by reference, all of which die with that scope; clearing it on
 * destruction makes that structural in both exit arms instead of relying
 * on a copy of the reset in each.
 */
class PickHookGuard {
public:
    explicit PickHookGuard(Engine& engine) : engine_(engine) {}
    PickHookGuard(const PickHookGuard&) = delete;
    PickHookGuard& operator=(const PickHookGuard&) = delete;
    ~PickHookGuard() { engine_.pick_hook = nullptr; }

private:
    Engine& engine_;
};

#endif

/**
 * One mesh's vertex buffer: its geometry's local lanes, uploaded once as the
 * pin's own `createMappedBuffer` uploads them. A node's world never enters
 * these bytes -- it reaches the vertex stage through the mesh block
 * (`mesh_block_world`) -- so a transform-only change uploads nothing.
 *
 * The morph lanes carry the geometry's first two targets for the
 * vertex-attribute morph transport.
 */
inline std::vector<GpuVertex> mesh_gpu_vertices(const ModelGeometry& geometry,
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

/**
 * What identifies one immutable shader-geometry upload in a backend cache.
 *
 * The cache exists so short-lived custom-shader meshes that repeat one
 * geometry -- particles, falling blocks, mob parts -- share a buffer. It
 * used to keep a CPU copy of every cached geometry to compare against,
 * which for a streaming voxel world meant a copy of every chunk mesh held
 * for the whole time the mesh was drawn, hundreds of megabytes that never
 * matched anything. A 64-bit content hash beside the two counts is the
 * identity now; the bytes are kept only for a small geometry, where an
 * exact compare confirms the hash and where sharing actually happens.
 */
struct SharedGeometryIdentity {
    std::size_t vertex_count = 0;
    std::size_t index_count = 0;
    std::uint64_t hash = 0;
};

/** Below this many vertices a cached geometry also keeps its bytes. */
inline constexpr std::size_t shared_geometry_bytes_kept_below = 4096;

inline std::uint64_t fnv1a_append(std::uint64_t hash, const void* data, std::size_t size) {
    const auto* bytes = static_cast<const std::uint8_t*>(data);
    for (std::size_t index = 0; index < size; ++index) {
        hash ^= bytes[index];
        hash *= 1099511628211ull;
    }
    return hash;
}

inline SharedGeometryIdentity shared_geometry_identity(const std::vector<GpuVertex>& vertices,
                                                       const std::vector<std::uint32_t>& indices) {
    std::uint64_t hash = 14695981039346656037ull;
    hash = fnv1a_append(hash, vertices.data(), vertices.size() * sizeof(GpuVertex));
    hash = fnv1a_append(hash, indices.data(), indices.size() * sizeof(std::uint32_t));
    return {vertices.size(), indices.size(), hash};
}

inline bool shared_geometry_keeps_bytes(const std::vector<GpuVertex>& vertices) {
    return vertices.size() < shared_geometry_bytes_kept_below;
}

/** Find an exact immutable shader-geometry upload in a backend cache. */
template <typename SharedGeometry>
inline SharedGeometry*
find_shared_shader_geometry(const std::vector<std::unique_ptr<SharedGeometry>>& cache,
                            const SharedGeometryIdentity& identity,
                            const std::vector<GpuVertex>& vertices,
                            const std::vector<std::uint32_t>& indices) {
    const auto found = std::find_if(
        cache.begin(), cache.end(), [&](const std::unique_ptr<SharedGeometry>& candidate) {
            if (candidate->identity.vertex_count != identity.vertex_count ||
                candidate->identity.index_count != identity.index_count ||
                candidate->identity.hash != identity.hash) {
                return false;
            }
            // A kept copy confirms the hash byte for byte; a geometry too
            // large to keep is matched on the hash alone.
            if (candidate->vertices.empty() && !vertices.empty())
                return true;
            return candidate->indices == indices &&
                   (vertices.empty() || std::memcmp(candidate->vertices.data(), vertices.data(),
                                                    vertices.size() * sizeof(GpuVertex)) == 0);
        });
    return found == cache.end() ? nullptr : found->get();
}

/** Find the backend texture upload owned by one shader material. */
template <typename SharedTextures>
inline SharedTextures*
find_shared_shader_material_textures(const std::vector<std::unique_ptr<SharedTextures>>& cache,
                                     MaterialHandle material) {
    const auto found = std::find_if(cache.begin(), cache.end(),
                                    [&](const std::unique_ptr<SharedTextures>& candidate) {
                                        return candidate->material.value == material.value;
                                    });
    return found == cache.end() ? nullptr : found->get();
}

/**
 * Drops one mesh's reference to a backend-owned shared cache entry. It runs
 * on the noexcept mesh-release paths, so an underflow -- a broken ownership
 * count -- ends the process naming itself instead of throwing.
 */
template <typename Shared>
inline void release_shared_user(Shared*& shared, const char* underflow_message) noexcept {
    if (!shared)
        return;
    if (shared->users == 0) {
        terminate_after("release_shared_user", underflow_message);
    }
    --shared->users;
    shared = nullptr;
}

/** Releases and erases cache entries after their last mesh retires. */
template <typename Cache, typename Release>
inline void prune_unused_shared(Cache& cache, Release release) {
    const auto unused = std::remove_if(cache.begin(), cache.end(), [&](const auto& entry) {
        if (entry->users != 0)
            return false;
        release(*entry);
        return true;
    });
    cache.erase(unused, cache.end());
}

/** Releases all backend objects in a cache during renderer teardown. */
template <typename Cache, typename Release>
inline void release_all_shared(Cache& cache, Release release) {
    for (const auto& entry : cache) {
        release(*entry);
    }
    cache.clear();
}

/**
 * The find-or-create walk both backends' post-process program caches share:
 * a linear scan of a small grown vector under the caller's own key equality,
 * then the caller's builder appended once. Returns the entry's INDEX because
 * the vector grows -- a pointer is reallocated out from under a pass the
 * moment a later pass creates a second program. The program types and their
 * keys stay each backend's own: SDL_GPU's key omits the bind-group shape
 * (`extra_textures`, `uniform_binding`, `uniform_size`) that Dawn's layout
 * bakes in, which is why the template takes a match predicate rather than a
 * key struct.
 */
template <typename Program, typename Matches, typename Build>
inline std::size_t find_or_create_program(std::vector<Program>& programs, Matches matches,
                                          Build build) {
    for (std::size_t index = 0; index < programs.size(); ++index) {
        if (matches(programs[index]))
            return index;
    }
    programs.push_back(build());
    return programs.size() - 1;
}

#if BBLITE_HAS_PBR_RENDERER
#if BBLITE_HAS_PICKING
#if BBLITE_DEFORM_PICKING
/** Match the pin's skeleton/morph projection key for this live candidate. */
inline int pick_mesh_projection(const Engine& engine, const MeshRecord& mesh) {
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

/** One mesh the pick pass will draw: its plan item and its uniform block. */
struct PickMeshCandidate {
    std::size_t item_index = 0;
    PickMeshUniforms uniforms{};
#if BBLITE_GPU_INSTANCING
    /** The advanced pipeline draws one invocation and id per active row. */
    bool thin = false;
    std::uint32_t instance_count = 1;
#endif
#if BBLITE_DEFORM_PICKING
    /** Index in the generated projection table; -1 is the affine pipeline. */
    int deform = -1;
#endif
};

#if BBLITE_GPU_INSTANCING
inline std::size_t thin_instance_active_count(const MeshRecord& record);
#endif

/**
 * The render-plan walk both pick passes share: which meshes are drawn, in
 * which order, under which id, and with which world matrix.
 *
 * The RENDER PLAN, not `scene.meshes`: the backend mesh list is indexed by
 * plan item, and the plan skips a mesh with no geometry -- so the two agree
 * only while nothing has been skipped or removed. Walking the plan is also
 * what makes a scene's own `removeFromScene` visible to a later pick, since
 * `rematch_render_meshes` rebuilds both together. `has_geometry` is the one
 * backend fact in the walk (whether the row's GPU buffers exist); the
 * generated pick predicate over the live record, the world-or-identity
 * selection and the id/range assignment are decided here, once, so the two
 * backends cannot drift on which mesh answers a pick.
 */
inline std::optional<std::size_t>
picker_scene_index(const Engine& engine, GpuPickerHandle picker,
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

template <typename HasGeometry>
inline std::vector<PickMeshCandidate>
collect_pick_mesh_candidates(const Engine& engine, [[maybe_unused]] const Scene& scene,
                             const upstream::RenderPlan& render_plan, std::size_t gpu_mesh_count,
                             const HasGeometry& has_geometry, std::vector<PickRange>& ranges,
                             std::uint32_t& next_id, const Engine::PickFilter* filter = nullptr,
                             [[maybe_unused]] bool detailed = false) {
    std::vector<PickMeshCandidate> candidates;
    for (std::size_t item_index = 0;
         item_index < render_plan.items.size() && item_index < gpu_mesh_count; ++item_index) {
        const MeshHandle handle = render_plan.items[item_index].mesh;
        if (!has_geometry(item_index))
            continue;
        // A mesh the pin's picker would not take never enters the pass, so
        // it can neither answer a pick nor occlude one behind it. The
        // predicate is generated, and it reads the live record rather than
        // the plan's snapshot of it.
        if (!upstream::pick_candidate(handle_at(engine.meshes, handle))) {
            continue;
        }
        // The pin's `pickFilter` arm: a mesh the supplied filter refuses
        // neither answers nor occludes, and consumes no id.
        if (filter && !(*filter)(handle)) {
            continue;
        }
        PickMeshCandidate candidate;
        candidate.item_index = item_index;
        const MeshRecord& pick_mesh = handle_at(engine.meshes, handle);
#if BBLITE_GPU_INSTANCING
        candidate.thin = pick_mesh.thin_instanced;
        if (candidate.thin) {
            candidate.instance_count =
                static_cast<std::uint32_t>(thin_instance_active_count(pick_mesh));
            if (candidate.instance_count == 0)
                continue;
            if (detailed)
                throw std::runtime_error(
                    "Detailed picking requires the selected thin-instance world matrix.");
        }
#endif
#if BBLITE_DEFORM_PICKING
        candidate.deform = pick_mesh_projection(engine, pick_mesh);
#if BBLITE_GPU_INSTANCING
        if (candidate.thin && candidate.deform >= 0) {
            throw std::runtime_error("thin-instance deformation picking is not supported");
        }
#endif
#endif
        // `gpu-picker.ts` copies `mesh.worldMatrix` as stored, with no
        // floating-origin offset: the projection arms compose the instance
        // matrix or the palette on top of it in the vertex stage.
        candidate.uniforms.world = upstream::mesh_world_matrix(engine, pick_mesh);
        candidate.uniforms.pick_id = next_id;
        candidates.push_back(candidate);
        const std::uint32_t id_count =
#if BBLITE_GPU_INSTANCING
            candidate.thin ? candidate.instance_count :
#endif
                           1u;
        ranges.push_back(
            {next_id, PickedNodeKind::mesh, handle.value, id_count, handle.generation});
        next_id += id_count;
    }
    return candidates;
}

#if BBLITE_HAS_DETAILED_PICKING
/**
 * The tail of the pin's own `pickAsyncImpl` for a detailed pick, decided
 * once for both backends -- the twin of `collect_pick_mesh_candidates`
 * above, and for the same reason: what the CPU solve is handed is what
 * the two backends must not drift on.
 *
 * The ray is the pin's `info.ray = detailed ? pickRay : null`, and the
 * world is `mesh.worldMatrix`, the matrix the pass drew the mesh's local
 * lanes through. Upstream snapshots it before an asynchronous readback;
 * here the draw and the readback are one synchronous call, so
 * `copyDetailedWorldMatrix`'s reason -- an animation tick between them --
 * cannot arise.
 */
inline void finish_detailed_pick(const Engine& engine, PickingInfo& info,
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

/**
 * The backend-neutral preamble of one GPU pick over the scene the picker
 * renders (`picker_scene_index`): whether the pick is detailed, the camera,
 * and the pin's own pointer mapping and scene block (`map_pick_pointer`,
 * lowered from `pickAsyncImpl`). Each backend keeps its pipelines, uploads,
 * draws and the staging copy; what they share is decided here once.
 */
struct PickRequest {
    const CameraRecord* camera = nullptr;
    bool detailed = false;
    upstream::PickPointer pointer{};
    PickSceneUniforms scene_uniforms{};
};

/** Empty where the pin answers the empty info: no camera, or a miss. */
inline std::optional<PickRequest> prepare_gpu_pick(const Engine& engine,
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

/**
 * The tail of `pickAsyncImpl` once the staging rows are read: the id
 * against what was drawn, the picked point reconstructed from the depth at
 * the pick's own sample, and a detailed pick's ray and solve inputs.
 */
inline PickingInfo resolve_gpu_pick([[maybe_unused]] const Engine& engine,
                                    const PickRequest& request,
                                    const std::vector<PickRange>& ranges,
                                    const PickReadback& readback) {
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
#endif

#if BBLITE_HAS_PBR_RENDERER
inline std::optional<std::array<float, 16>> shader_world_view(const std::array<float, 16>* view,
                                                              const std::array<float, 16>& world) {
    return view ? std::optional<std::array<float, 16>>{upstream::matrix_product(*view, world)}
                : std::nullopt;
}
#endif

/**
 * Whether a live pool has outgrown the instance buffers its registration
 * allocated.
 *
 * `addThinInstance` doubles a full pool, so a mesh registered with sixteen
 * rows can be drawing thirty-two of them a frame later. Both backends size
 * both instance buffers -- matrices and the colour lane -- from the same
 * row count at registration, so this is one question rather than two, and
 * it is asked before the version-gated upload that would otherwise write
 * past the end.
 */
inline bool thin_instance_pool_grew(const MeshRecord& record, std::uint32_t allocated_rows) {
    return record.thin_instanced &&
           record.instance_matrices.size() > static_cast<std::size_t>(allocated_rows);
}

inline std::size_t thin_instance_active_count(const MeshRecord& record) {
    return std::min(static_cast<std::size_t>(record.instance_count),
                    record.instance_matrices.size());
}

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
 * Resolve one declared input onto the vertex's own lanes, which hold the
 * geometry's local values for every family and view.
 */
inline PinnedVertexInput pinned_vertex_input(std::string_view name) {
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
    return has_instance_colors(record);
}

#endif

#if BBLITE_GPU_INSTANCE_COLORS
// Snapshot a retained caller view at the versioned GPU upload boundary.
inline std::vector<float> instance_colors_for_upload(const MeshRecord& mesh) {
    if (!mesh.instance_color_source)
        return mesh.instance_colors;
    const auto& source = *mesh.instance_color_source;
    std::vector<float> colors(source.size());
    for (std::size_t lane = 0; lane < colors.size(); ++lane)
        colors[lane] = source.load(lane);
    return colors;
}
#endif

/**
 * Whether a task's draw lists contain a draw the pinned path owns — a PBR
 * draw, a Standard one now that both families run Babylon's own composed
 * stages, or a node one in a build that composed geometry views. A geometry
 * task with none writes no pinned blocks at all. It lives here rather than in
 * the backend that asks: SDL_GPU stopped needing it when the depth convention
 * collapsed and the matrix seam went with it, and the question is the
 * backends' shared one whenever either asks it again.
 *
 * The node arm matters for the FRAME PROLOGUE rather than for any block this
 * predicate's callers write: the task's scene block and its gpUniforms are
 * written by whichever family writer runs first, so a task whose list is all
 * node draws still has to reach one of them — which is also why this sits
 * outside the two material families' guard rather than inside it.
 */
#if BBLITE_PINNED_MATERIALS
inline bool pinned_lists_have_pinned_draws(const upstream::RenderDrawLists& lists) {
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
/**
 * The composed group-2 rows one variant declares.
 *
 * `createShadowFragment` emits three per shadow-casting light and the
 * generated table stores them contiguously, so the slice is the variant's
 * own half-open range -- spelled here rather than at each backend's every
 * lookup. Both material families wrap that one core, so their rows are one
 * shape and a backend builds either family's group 2 from one walk.
 */
inline std::span<const upstream::PinnedShadowBinding> standard_shadow_rows(std::size_t variant) {
    const upstream::StandardVariantEntry& entry = upstream::standard_variants[variant];
    return {
        upstream::standard_shadow_bindings.data() + entry.first_shadow_binding,
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
inline std::span<const upstream::PinnedShadowBinding> pbr_shadow_rows(std::size_t variant) {
    const upstream::PbrVariantEntry& entry = upstream::pbr_variants[variant];
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
inline std::span<const upstream::PinnedShadowBinding>
node_shadow_rows(const upstream::NodeVariantEntry& entry) {
    return {
        upstream::node_shadow_bindings.data() + entry.first_shadow_binding,
        entry.shadow_binding_count,
    };
}
#endif

/** Restore source winding after a loader baked a reflected node transform. */
inline std::span<const std::uint32_t> node_source_indices(const ModelGeometry& geometry,
                                                          std::vector<std::uint32_t>& scratch) {
    if (!geometry.source_indices_reversed)
        return geometry.indices;
    scratch = geometry.indices;
    for (std::size_t index = 0; index < scratch.size(); index += 3) {
        std::swap(scratch.at(index + 1), scratch.at(index + 2));
    }
    return scratch;
}

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
inline constexpr std::size_t node_variant_slot(std::size_t variant, bool caster) {
    return variant * 2 + (caster ? 1 : 0);
}

inline std::size_t node_view_slots() { return upstream::node_variants.size() * 2; }

/** The graph one slot names, and which of its two views. */
inline constexpr std::size_t node_slot_variant(std::size_t slot) { return slot / 2; }

inline constexpr bool node_slot_is_caster(std::size_t slot) { return slot % 2 == 1; }
#else
// A build composing no node caster has one view per graph, so the slot IS
// the variant and every backend's per-slot table keeps its old size.
inline constexpr std::size_t node_variant_slot(std::size_t variant, [[maybe_unused]] bool caster) {
    return variant;
}

inline std::size_t node_view_slots() { return upstream::node_variants.size(); }

inline constexpr std::size_t node_slot_variant(std::size_t slot) { return slot; }

inline constexpr bool node_slot_is_caster(std::size_t) { return false; }
#endif

/** No geometry view: what both PALs pass for a colour or caster draw, and
 *  what the generated lookup returns for a pair it composed none for. Stated
 *  outside the guard because every node draw site names it, and checked
 *  against the generated spelling where that exists. */
inline constexpr std::size_t no_node_geometry_variant = npos;

#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
static_assert(no_node_geometry_variant == upstream::node_no_geometry_variant,
              "The PAL sentinel must be the generated table's own.");

/**
 * A graph's geometry-output views, continuing the same slot run.
 *
 * They are not a third view of the pair above: one graph composes ONE
 * geometry module per task it is drawn in, so a geometry view is a
 * `node_variants` row of its own after every graph's, and its slot is that
 * row's -- with the caster half of the pair unused, because a geometry view
 * never casts. Each backend's per-slot module, layout and `.slots` tables
 * then serve all three kinds unchanged.
 */
inline std::size_t node_geometry_slot(std::size_t geometry_variant) {
    return node_variant_slot(upstream::node_geometry_entry(geometry_variant), false);
}

/**
 * The view one graph composed for one task, or a refusal naming both.
 *
 * A geometry task draws every mesh the scene admits and composition walks
 * every task the scene registered, so a node draw reaching a task with no
 * composed view is a generation gap rather than a scene mistake -- and it is
 * the same gap on either backend, so the message is stated once here beside
 * `require_geometry_target_count`.
 */
inline std::size_t require_node_geometry_variant(std::size_t variant, std::size_t geometry_task) {
    const std::size_t geometry_variant =
        upstream::node_geometry_variant_for(variant, geometry_task);
    if (geometry_variant != no_node_geometry_variant) {
        return geometry_variant;
    }
    throw std::runtime_error("node graph " + std::to_string(variant) + " draws in geometry task " +
                             std::to_string(geometry_task) + " with no composed geometry view.");
}
#endif

/**
 * How many `node_variants` rows are graphs.
 *
 * The render plan's `shader_variant` names a GRAPH, so this rather than
 * `node_variants.size()` is what an out-of-range plan item is refused
 * against: the geometry views a scene composed continue the same table
 * after every graph.
 */
inline std::size_t node_graph_count() {
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
    return upstream::node_graph_count;
#else
    return upstream::node_variants.size();
#endif
}

/**
 * The slot one node draw's resources live in.
 *
 * A geometry view is keyed by the composed view rather than by the graph --
 * one graph drawn in two tasks composed two modules -- so the callers that
 * know which view a draw is agree here rather than each spelling it out.
 */
inline std::size_t node_draw_slot(std::size_t variant, bool caster,
                                  [[maybe_unused]] std::size_t geometry_variant) {
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
    if (geometry_variant != no_node_geometry_variant) {
        return node_geometry_slot(geometry_variant);
    }
#endif
    return node_variant_slot(variant, caster);
}

/** Every per-slot table both backends size: the colour and caster views of
 *  every row `node_variants` carries, graphs and geometry views alike. */
inline std::size_t node_variant_slots() { return node_view_slots(); }

/**
 * The compiled view one slot names.
 *
 * A graph's three modules are separate emits — the geometry one walks the
 * graph again from its own terminal — so their vertex inputs, texture pairs
 * and uniform blocks are separate ranges into the same tables, carried by
 * separate rows of the one table. Both backends bind a draw from the row
 * its slot names rather than from a per-view branch at every use.
 */
inline const upstream::NodeVariantEntry& node_slot_view(std::size_t slot) {
    return upstream::node_variants[node_slot_variant(slot)];
}

/**
 * The two stems one slot's modules deploy under.
 *
 * Which of a graph's compiled views a slot names decides both, so the pair
 * travels together rather than as a ternary per load site.
 */
inline upstream::NodeVariantStems node_variant_stems(std::size_t slot) {
    const upstream::NodeVariantEntry& entry = node_slot_view(slot);
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
 * carrier is filled here and the fold stays the pin's. Geometry bounds start
 * from the pin's fallback and live public bound overrides are applied last.
 *
 * Not the ESM generator's alone: BOTH directional generators fit their
 * volume to the caster bounds, because a directional light has no position
 * to project from. Only the spot generator builds its volume from the
 * light, which is why this is gated on the receiver half rather than on
 * either filter.
 */
inline void fitted_shadow_casters(const Engine& engine, const ShadowGeneratorRecord& generator,
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
inline void for_each_shadow_generator(const Scene& scene, const Engine& engine, Visit&& visit) {
    for (std::size_t slot = 0; slot < scene.lights.size(); ++slot) {
        const LightHandle light = scene.lights[slot];
        if (light.value >= engine.lights.size())
            continue;
        const ShadowGeneratorHandle handle = handle_at(engine.lights, light).shadow_generator;
        if (handle.value >= engine.shadow_generators.size())
            continue;
        visit(handle, light, slot);
    }
}

/**
 * The light-space pair one caster pass renders through.
 *
 * A cascaded generator draws one pass per cascade and each carries that
 * cascade's own biased view-projection; every other generator has one pass
 * and the pair on the record. Which one a pass takes is decided by the
 * generator's own FILTER, not by whether an index happens to be in range,
 * and it is decided once here because both backends ask the same question.
 */
struct ShadowCasterMatrices {
    const std::array<float, 16>& view_projection;
    const std::array<float, 16>& view;
};

inline ShadowCasterMatrices shadow_caster_matrices(const Engine& engine,
                                                   const FrameTaskRecord& task) {
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

/** The refresh's own carriers, kept by each backend across frames. */
struct ShadowRefreshState {
    /** Refilled per generator by the ESM caster fold, never reallocated. */
    std::vector<upstream::ShadowCaster> casters;
    /**
     * The receiver block each generator last uploaded, by handle, against
     * which the next frame's is compared. `renderPcfShadowMap` re-uploads
     * only when the light moved, and for a static one those bytes are
     * identical every frame. The carrier holds whichever of the two shapes
     * the generator publishes -- 96 bytes for a single-map receiver, 320
     * for a cascaded one -- and its own size beside them.
     */
    std::vector<upstream::ShadowReceiverBlock> blocks;
    /** Whether `blocks[handle]` holds an upload yet. */
    std::vector<bool> uploaded;
    /** The enabled value last synchronized into this backend's receiver allocation. */
    std::vector<upstream::ShadowEnabledUploadState> enabled_uploads;
    /**
     * The pinned render gate's `_last*` lanes, by handle — the state each
     * `render*ShadowMap` hook keeps on its task between frames, plus the
     * frame's `due` verdict `refresh_shadow_generators` writes for the
     * task loop. Backend state rather than a record field because the
     * pin's is task state: each backend's task loop skips against what IT
     * last rendered.
     */
    std::vector<upstream::ShadowRefreshGate> gates;
    /**
     * Frame-graph texture recreation (a resize, a target added) released
     * every rendered map, so what the gate knows is rendered no longer
     * exists. Clearing the sentinels makes each generator's next frame
     * render, the way a fresh pinned task state's `-1` lanes do.
     */
    void invalidate_rendered_maps() {
        for (upstream::ShadowRefreshGate& gate : gates) {
            gate.rendered = false;
        }
    }
};

/**
 * Refresh every generator the scene's lights name, then hand each to the
 * backend.
 *
 * What is shared is the refresh and BOTH dirty tests. The outer one is the
 * pin's render gate: every `render*ShadowMap` hook returns before the
 * matrix fit and the caster pass when neither the casters' nor the light's
 * version moved (`shadow_refresh_due` carries the full rule), so the fit
 * runs — the ESM/directional one re-reading its casters' world bounds, the
 * PCF spot rebuilding from the light's live position and direction — only
 * on the frames the pin would run it. The inner one is the receiver block:
 * what falls out of a fit is re-uploaded only when it moved. All of that
 * is engine-side math with one right answer.
 *
 * What stays per backend is the resource each keeps for a generator, which
 * is what the visitor receives: the record, its own handle, its dense
 * position in the light order, the block, and whether that block is new.
 * The gate's verdict lands on the gate itself (`gates[handle].due`), which
 * the backend's task loop reads to skip the pass itself. A gated frame
 * whose block is already uploaded skips the visitor too: the fit did not
 * run, so the block's bytes are provably the ones the backend holds.
 */
template <typename Visit>
inline void refresh_shadow_generators(const Scene& scene, Engine& engine,
                                      ShadowRefreshState& refresh, Visit&& visit) {
    if (refresh.blocks.size() < engine.shadow_generators.size()) {
        refresh.blocks.resize(engine.shadow_generators.size());
        refresh.uploaded.resize(engine.shadow_generators.size(), false);
        refresh.enabled_uploads.resize(engine.shadow_generators.size());
        refresh.gates.resize(engine.shadow_generators.size());
    }
    // The pin's own floating-origin offset for a shadow map:
    // `renderPcfShadowMap` and `renderEsmShadowMap` each read the active
    // camera's world translation and build the light view and the caster fit
    // against it, so the map lands in the same eye-relative frame the mesh
    // worlds are packed into. Off the mode this is the zero vector, which is
    // the pin's own `foCam ? ... : 0`. A frame constant, so it is read once
    // here rather than per generator.
    const Vec3d eye = frame_floating_origin_offset(scene, engine);
#if BBLITE_SHADOWS_CSM
    // `csmCameraAspect` is `getEffectiveAspectRatio(camera, rt._width,
    // rt._height)`, so a camera carrying a viewport fits its cascades to
    // the frustum it actually draws. A scene with no camera goes through
    // the same pinned body over a default record -- whose viewport is
    // empty, which IS the pin's nullish camera -- rather than restating the
    // whole-target ratio, where the second copy would be the one that
    // drifts. A frame constant like `eye` above, so it is read once here
    // rather than per generator.
    const PixelViewport surface_extent =
        scene_surface_extent(engine, scene, engine.options.width, engine.options.height);
    const CameraRecord* const aspect_camera = scene_camera(engine, scene);
    const double csm_camera_aspect = upstream::effective_aspect_ratio(
        aspect_camera ? *aspect_camera : no_camera_record,
        static_cast<double>(surface_extent.width), static_cast<double>(surface_extent.height));
#endif
    for_each_shadow_generator(
        scene, engine, [&](ShadowGeneratorHandle handle, LightHandle light, std::size_t slot) {
            ShadowGeneratorRecord& generator = handle_at(engine.shadow_generators, handle);
            const LightRecord& light_record = handle_at(engine.lights, light);
            upstream::ShadowRefreshGate& gate = handle_at(refresh.gates, handle);
            const auto notify_receivers = [&](const upstream::ShadowReceiverBlock& block) {
#if BBLITE_SHADOWS_CSM
                const auto receiver_callbacks = generator.csm_receiver_callbacks;
                if (generator.filter == ShadowFilter::csm_directional && receiver_callbacks &&
                    !receiver_callbacks->empty()) {
                    js::F32Array values(block.size / sizeof(float));
                    if (!values.empty())
                        std::memcpy(values.data(), block.bytes.data(), block.size);
                    receiver_callbacks->dispatch(values);
                }
#else
                (void)block;
#endif
            };
            // A backend refresh owns each receiver allocation and its source upload state.
            bool shadow_enabled = true;
            if (generator.runtime_enabled) {
                upstream::ShadowReceiverBlock block =
                    handle_at(refresh.uploaded, handle)
                        ? handle_at(refresh.blocks, handle)
                        : upstream::shadow_receiver_block(generator);
#if BBLITE_SHADOWS_CSM
                if (generator.filter == ShadowFilter::csm_directional &&
                    !handle_at(refresh.uploaded, handle))
                    block.bytes.fill(std::byte{});
#endif
                // Shadow receiver slots remain allocated for this refresh state's lifetime.
                const std::uint64_t receiver_identity =
                    static_cast<std::uint64_t>(handle.value) + 1;
                shadow_enabled = upstream::synchronize_shadow_enabled(
                    generator, handle_at(refresh.enabled_uploads, handle), receiver_identity,
                    [&]() -> std::optional<js::F32Array> {
#if BBLITE_SHADOWS_CSM
                        js::F32Array values(block.size / sizeof(float));
                        if (!values.empty())
                            std::memcpy(values.data(), block.bytes.data(), block.size);
                        return values;
#else
                        return std::nullopt;
#endif
                    },
                    [&]() -> std::shared_ptr<PlatformEventListeners<void(const js::F32Array&)>> {
#if BBLITE_SHADOWS_CSM
                        return generator.csm_receiver_callbacks;
#else
                        return {};
#endif
                    },
                    [&](std::uint64_t, double byte_offset, const auto& data) {
                        const auto offset = static_cast<std::size_t>(byte_offset);
                        const auto bytes = data.size() * sizeof(float);
                        if (offset > block.size || bytes > block.size - offset)
                            throw std::runtime_error(
                                "Shadow enabled receiver upload exceeds its block.");
                        std::memcpy(block.bytes.data() + offset, data.data(), bytes);
                        visit(generator, handle, slot, block, true);
                        handle_at(refresh.blocks, handle) = block;
                        handle_at(refresh.uploaded, handle) = true;
                    });
            }
            const upstream::CsmCameraKey* csm_camera = nullptr;
#if BBLITE_SHADOWS_CSM
            const double aspect = csm_camera_aspect;
            // `renderCsmShadowMap` keys its gate on the camera the cascade
            // is fitted to — change key and aspect — in place of the
            // single-map generators' floating-origin term. The key here is
            // what the fit consumes: the camera view-projection (aspect
            // folded in) and the near/far pair the split formula reads. A
            // forced generator's gate returns before reading it, so the
            // key is built only when the gate will.
            const CameraRecord* const fit_camera = scene_camera(engine, scene);
            const bool csm_fit =
                generator.filter == ShadowFilter::csm_directional && fit_camera != nullptr;
            upstream::CsmCameraKey camera_key;
            if (csm_fit)
                csm_camera = &camera_key;
            if (csm_fit && !generator.force_refresh_every_frame) {
                camera_key.view_projection = upstream::build_view_projection(*fit_camera, aspect);
                camera_key.near_plane = fit_camera->near_plane;
                camera_key.far_plane = fit_camera->far_plane;
            }
#endif
            // The pin's render gate, ahead of each family's fit exactly as
            // each `render*ShadowMap` hook tests it ahead of its own. On a
            // skipped frame the generator's matrices — and so the block
            // below — keep their last-render values. The verdict lands on
            // the gate, where each backend's task loop reads it to skip
            // the caster pass itself.
            const bool due =
                shadow_enabled && upstream::shadow_refresh_due(engine, generator, light_record, eye,
                                                               csm_camera, gate);
            gate.due = due;
            if (due) {
                if (generator.filter == ShadowFilter::pcf_spot) {
                    upstream::update_pcf_spot_shadow(generator, light_record, eye);
                } else {
                    // Every directional fit re-reads its casters' world
                    // bounds; the spot rebuild reads only the light. The
                    // PCF directional arm needs no define of its own: it
                    // shares every resource the spot generator builds, and
                    // what it needs beside them -- the caster fit -- is
                    // the receiver half's, not the ESM's.
                    fitted_shadow_casters(engine, generator, refresh.casters);
#if BBLITE_SHADOWS_ESM
                    if (generator.filter == ShadowFilter::esm_directional) {
                        upstream::update_esm_directional_shadow(generator, light_record,
                                                                refresh.casters, eye);
                    } else
#endif
#if BBLITE_SHADOWS_CSM
                        if (csm_fit) {
                        upstream::update_csm_cascades(generator, light_record,
                                                      handle_at(engine.cameras, scene.camera),
                                                      aspect, refresh.casters);
                    } else
#endif
                    {
                        upstream::update_pcf_directional_shadow(generator, light_record,
                                                                refresh.casters, eye);
                    }
                }
            } else if (handle_at(refresh.uploaded, handle)) {
                // A gated frame's fit did not run, so the block's bytes
                // are provably the ones already uploaded: the pack, the
                // compare and the visitor are skipped with the pass.
                return;
            }
            const upstream::ShadowReceiverBlock block = upstream::shadow_receiver_block(generator);
            notify_receivers(block);
            const bool moved =
                !handle_at(refresh.uploaded, handle) || block != handle_at(refresh.blocks, handle);
            handle_at(refresh.blocks, handle) = block;
            handle_at(refresh.uploaded, handle) = true;
            visit(generator, handle, slot, block, moved);
        });
}
#endif

#if BBLITE_PINNED_MATERIALS || BBLITE_HAS_BILLBOARDS
/**
 * The pin's per-pass scene block.
 *
 * Every member is the one the pin's own declaration names; the fragment reads
 * its view direction from `vEyePosition` and its reflection path from `view`,
 * both from the camera the pass renders with. Shared, because the block is the
 * pin's rather than either backend's: Dawn uploads it to a buffer and SDL_GPU
 * pushes it at a uniform slot, and neither should decide what is in it.
 */
inline upstream::SceneUniforms pinned_scene_block(const Scene& scene, const Engine& engine,
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
/**
 * The scene block a billboard program binds at its group 0: the pin's
 * block for the pass, over the view projection and view the pass draws
 * billboards with. A pass without a camera carries the zero block the pin
 * never writes, as every composed family's does.
 */
inline upstream::SceneUniforms billboard_scene_block(const Scene& scene, const Engine& engine,
                                                     const CameraRecord* camera,
                                                     const std::array<float, 16>& view_projection,
                                                     const std::array<float, 16>& view) {
    upstream::SceneUniforms block =
        camera ? pinned_scene_block(scene, engine, *camera, view_projection)
               : upstream::SceneUniforms{};
    block.viewProjection = view_projection;
    block.view = view;
    return block;
}
#endif

#if BBLITE_PINNED_MATERIALS
/**
 * The pin's per-pass lights block: a u32 count, three words of padding, then
 * MAX_LIGHTS entries.
 *
 * `fillLightsData` writes that count through a Float32Array view of the same
 * buffer, so it lands in the first four bytes. Returned as bytes because that is
 * what both a buffer upload and a uniform push take.
 */
inline std::vector<std::uint8_t> pinned_lights_block(const Scene& scene, const Engine& engine) {
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
inline void pinned_mesh_light_selection(const Scene& scene, const Engine& engine, MeshHandle mesh,
                                        Block& block) {
    if constexpr (requires {
                      block.li;
                      block.lc;
                  }) {
        std::uint32_t count = 0;
        std::uint32_t light_index = 0;
        for (const LightHandle handle : scene.lights) {
            if (light_index >= upstream::pinned_max_lights)
                break;
            if (handle.value >= engine.lights.size())
                continue;
            if (upstream::light_affects_mesh(handle_at(engine.lights, handle), mesh)) {
                block.li[count / 4][count % 4] = light_index;
                ++count;
            }
            ++light_index;
        }
        block.lc = count;
    }
}

#if BBLITE_PINNED_MATERIAL_VARIANTS
/** The pin's `MeshUniforms` for one mesh: its world and its light selection. */
inline upstream::MeshUniforms pinned_mesh_block(const Scene& scene, const Engine& engine,
                                                MeshHandle mesh) {
    upstream::MeshUniforms block{};
    block.world = mesh_block_world(scene, engine, handle_at(engine.meshes, mesh));
    pinned_mesh_light_selection(scene, engine, mesh, block);
    return block;
}

/**
 * A geometry task's pre-draw update (`geometry-renderer-task.ts` executes
 * every bound renderable's `update` before its first draw): each Standard
 * mesh of the layer's plan, the hidden ones included, because the pin
 * reads visibility only at the draw.
 */
inline void update_pinned_velocity_frame(PinnedVelocityHistory& history, const Scene& scene,
                                         const Engine& engine,
                                         const std::vector<upstream::RenderItem>& items) {
    begin_pinned_velocity_frame(history, scene);
    for (const upstream::RenderItem& source : items) {
        const upstream::RenderItem item =
            upstream::bind_render_item(source, engine, source.material);
        if (item.material_kind != upstream::RenderMaterialKind::standard) {
            continue;
        }
        update_pinned_velocity(
            history, item.mesh,
            mesh_block_world(scene, engine, handle_at(engine.meshes, item.mesh)));
    }
}

/**
 * The Standard geometry output's block tail (`standard-geometry-renderable.ts`
 * `_baseUpdate`): what this frame's update wrote for the mesh. The generic
 * lambda makes the access dependent: outside a template both `if constexpr`
 * branches must compile, and most scenes' mirrored MeshUniforms carries no
 * velocity tail.
 */
inline void write_pinned_velocity_tail(const PinnedVelocityHistory& history, MeshHandle mesh,
                                       upstream::MeshUniforms& block) {
    [&](auto& dependent) {
        if constexpr (requires {
                          dependent.previousWorld;
                          dependent.velocityEnabled;
                      }) {
            if (mesh.value >= history.renderables.size() ||
                !(history.renderables[mesh.value].mesh == mesh) ||
                history.renderables[mesh.value].updated_frame != history.frame) {
                throw std::logic_error("A geometry task drew a Standard mesh its frame's "
                                       "velocity update did not reach.");
            }
            const PinnedVelocityHistory::Renderable& renderable = history.renderables[mesh.value];
            dependent.previousWorld = renderable.written_previous_world;
            dependent.velocityEnabled = renderable.written_velocity_enabled;
        }
    }(block);
}
#endif

#if BBLITE_NODE_VARIANTS > 0
/**
 * A node graph's per-draw mesh block (`node-renderable.ts`).
 *
 * The pin packs the mesh's world matrix, `receiveShadows ? 1 : 0` in the
 * shadow lane, and the same light selection every family uses.
 *
 * The shadow lane is a VALUE here where it is a composition key for the
 * other two families: `node-shadow.ts` mixes each light's factor by it
 * (`mix(1.0, _sf[i], meshU.receivesShadow.x)`), so one composed module
 * draws a receiving mesh and a non-receiving one alike.
 */
inline upstream::NodeMeshUniforms node_mesh_block(const Scene& scene, const Engine& engine,
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
/** Whether a variant's vertex stage samples the bone palette. */
inline bool pinned_variant_skeleton(std::size_t variant) {
    return upstream::pbr_variants[variant].key.find("skeleton") != std::string_view::npos;
}

/**
 * Whether a variant deforms from a BAKED vertex-animation texture.
 *
 * The key carries the composed fragment ids, so this reads the same way
 * the skeleton test above does. The two are mutually exclusive by
 * construction: `_computeMeshFeatures` writes MSH_VAT where it would have
 * written MSH_HAS_SKELETON, never both. A baked draw reads the VAT rows --
 * the palettes the live path uploads, copied by the bake -- and neither arm
 * changes the world the mesh block carries.
 */
inline bool pinned_variant_vat(std::size_t variant) {
    return upstream::pbr_variants[variant].key.find("vat") != std::string_view::npos;
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

inline PinnedVariantKey pinned_variant_key(const Scene& scene, const Engine& engine,
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

/**
 * What a failed PBR variant lookup was asked for.
 *
 * The same diagnostic the Standard family carries, built from the key the
 * lookup actually used rather than from a second derivation: a miss means
 * the runtime derivation and the composed selector table disagree, and a key
 * that differed from the one that missed would name the wrong half.
 */
inline std::string pinned_variant_request(const PinnedVariantKey& key,
                                          std::size_t geometry_task = npos) {
    if (!key.resolved)
        return "no key: " + key.refusal;
    return "material " + std::to_string(key.material_index) + ", view " +
           std::to_string(key.material_view) + ", mesh features " +
           std::to_string(key.mesh_features) + ", light mode " + std::to_string(key.light_mode) +
           ", single light '" + std::string(key.single_light_type) + "'" + ", tone mapping " +
           (key.tone_mapping ? "on" : "off") + ", geometry task " +
           (geometry_task == npos ? std::string("none") : std::to_string(geometry_task));
}

inline std::size_t
pinned_variant_for_draw(const Scene& scene, const Engine& engine,
                        const upstream::RenderDrawCommand& draw,
                        // The geometry-output task the draw belongs to, npos for the colour
                        // passes: the selector table keys on it, so a geometry draw resolves
                        // its own MRT arm and never a colour variant.
                        std::size_t geometry_task = npos,
                        // Filled with the key the lookup used, so a miss reports that key
                        // rather than a second derivation of it.
                        PinnedVariantKey* key_out = nullptr) {
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

/**
 * The baked texture's shape: the bone palette's own row, `frame_count`
 * rows tall. Both backends size and fill from this; only the upload
 * mechanics stay per API.
 */
struct VatTextureLayout {
    std::uint32_t width;
    std::uint32_t height;
    std::uint32_t row_bytes;
    std::uint32_t bytes;
};

inline VatTextureLayout vat_texture_layout(std::uint32_t bones, std::uint32_t frames) {
    const std::uint32_t width = bones * 4u;
    return VatTextureLayout{width, frames, width * 16u, width * 16u * frames};
}

template <class Mesh, class Bake, class Settings, class Instances, class UploadInstances>
void sync_pinned_vat(Mesh& mesh, const MeshRecord& record, const Engine& engine, Bake&& upload_bake,
                     Settings&& upload_settings, [[maybe_unused]] Instances&& recreate_instances,
                     [[maybe_unused]] UploadInstances&& upload_instances) {
    if (!record.has_vat || record.vat.bake >= engine.vat_bakes.size())
        return;
    const auto& bake = engine.vat_bakes[record.vat.bake];
    if (bake.bone_count == 0 || bake.frame_count == 0)
        return;
    if (mesh.pinned_vat_bones != bake.bone_count || mesh.pinned_vat_frames != bake.frame_count) {
        upload_bake(bake, vat_texture_layout(bake.bone_count, bake.frame_count));
        mesh.pinned_vat_bones = bake.bone_count;
        mesh.pinned_vat_frames = bake.frame_count;
    }
    upload_settings(record.vat);
#if BBLITE_VAT_INSTANCES
    const auto& vat = record.vat;
    if (vat.instance_texels == 0)
        return;
    if (mesh.pinned_vat_instance_texels != vat.instance_texels) {
        recreate_instances(vat);
        mesh.pinned_vat_instance_texels = vat.instance_texels;
        mesh.pinned_vat_instance_version = 0;
    }
    if (mesh.pinned_vat_instance_version != vat.instance_version) {
        upload_instances(vat, VatTextureLayout{vat.instance_texels, 1u, vat.instance_texels * 16u,
                                               vat.instance_texels * 16u});
        mesh.pinned_vat_instance_version = vat.instance_version;
    }
#endif
}
#endif

#if BBLITE_PBR_VARIANTS > 0 || BBLITE_STANDARD_SKELETON
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

/** A palette texture whose bytes no record version has been streamed to yet. */
inline constexpr std::uint64_t unsynced_bone_palette = ~std::uint64_t{0};

/**
 * One mesh's pinned bone palette, brought in step with its record: the
 * texture is rebuilt when the bone count moved and rewritten when the
 * palette's version did. `MeshRecord::bone_matrices` already holds the
 * pin's `invMeshWorld * jointWorld * IBM` product, so the bytes travel
 * unchanged. The backend supplies its texture creation
 * (`recreate(layout)`, releasing the previous texture) and its upload
 * (`upload(floats, layout)`).
 */
template <typename GpuMesh, typename Recreate, typename Upload>
inline void sync_pinned_bone_palette(GpuMesh& mesh, const MeshRecord& record, Recreate&& recreate,
                                     Upload&& upload) {
    const auto bones = static_cast<std::uint32_t>(record.bone_matrices.size());
    if (bones == 0)
        return;
    const BonePaletteLayout palette = bone_palette_layout(bones);
    if (mesh.pinned_bone_count != bones) {
        recreate(palette);
        mesh.pinned_bone_count = bones;
        mesh.pinned_bone_version = unsynced_bone_palette;
    }
    if (mesh.pinned_bone_version == record.bone_matrices_version)
        return;
    upload(record.bone_matrices.data()->data(), palette);
    mesh.pinned_bone_version = record.bone_matrices_version;
}
#endif

#if BBLITE_HAS_PBR_RENDERER
/**
 * A shader material carrying fewer textures than its stage samples.
 *
 * Both backends raise it through their own error function, so the message
 * is composed once here the way `standard_variant_request` already is. It
 * describes a generation bug -- the record is filled by the compiled
 * `setShaderTexture` calls -- rather than a draw to skip.
 */
inline std::string shader_sampler_shortfall(const upstream::ShaderVariantInfo& info,
                                            std::size_t carried) {
    return "shader variant '" + std::string(info.name) + "' declares " +
           std::to_string(info.samplers.size()) + " sampler(s); the material carries " +
           std::to_string(carried) + " texture(s).";
}

/** A compiled stage keeping a register the material never declared. */
inline std::string shader_sampler_unmapped(const upstream::ShaderVariantInfo& info,
                                           const std::string& texture_name) {
    return "shader variant '" + std::string(info.name) + "' binds texture '" + texture_name +
           "', which its samplers option never declared.";
}
#endif

#if BBLITE_STANDARD_VARIANTS > 0
/** The pair `standard_variant_for` looks a draw up by, or none. */
struct StandardVariantKey {
    std::uint32_t features = 0;
    std::uint32_t plugin_index = 0;
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
inline StandardVariantKey standard_variant_key(const Scene& scene, const Engine& engine,
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

/**
 * What a failed Standard variant lookup was asked for.
 *
 * A miss means the runtime derivation and the composed selector table
 * disagree, which is what an upstream feature-derivation change looks like
 * from here.
 */
inline std::string standard_variant_request(const Scene& scene, const Engine& engine,
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
inline std::size_t
standard_variant_for_draw(const Scene& scene, const Engine& engine,
                          const upstream::RenderDrawCommand& draw, std::size_t geometry_task = npos,
                          // Filled with the derived key when the caller passes one, so the draw
                          // can consume `key.features` instead of re-deriving it.
                          StandardVariantKey* key_out = nullptr) {
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

/**
 * The Standard material block for one draw: the pin's own writer over the
 * record-filled props. A material-less item keeps the pin's defaults, the
 * way `createStandardMaterial` seeds them.
 */
inline upstream::StandardMaterialUniforms standard_material_block(const MaterialRecord* material,
                                                                  std::uint32_t features) {
    const upstream::StandardMaterialProps props =
        material ? upstream::standard_material_props(*material) : upstream::StandardMaterialProps{};
    upstream::StandardMaterialUniforms block{};
    upstream::write_standard_material(props, upstream::standard_texture_level(features), block);
    return block;
}

/** The vertex-stage UV block for one draw, by the pin's own writer. */
inline upstream::StandardUvTransformUniforms standard_uv_block(const MaterialRecord* material,
                                                               std::uint32_t features) {
    const upstream::StandardMaterialProps props =
        material ? upstream::standard_material_props(*material) : upstream::StandardMaterialProps{};
    upstream::StandardUvTransformUniforms block{};
    upstream::write_standard_uv_transform(
        props, material != nullptr && upstream::standard_uv_inverted(features, *material), block);
    return block;
}

#if BBLITE_HAS_STANDARD_UV_TRANSFORM
/**
 * `stdUvTransformExt`'s own block, by the pin's own per-channel writer.
 *
 * The extension replaces the base `up` block's assignment in the vertex
 * stage rather than removing it, so both blocks bind on a marked material
 * and this one is what the varyings actually read.
 */
inline upstream::StandardUvTxUniforms standard_uv_transform_block(const MaterialRecord* material) {
    upstream::StandardUvTxUniforms block{};
    if (!material)
        return block;
    upstream::write_std_uv_transform_data(*material, upstream::standard_material_props(*material),
                                          block);
    return block;
}
#endif
#endif

#if BBLITE_GPU_MORPH_STORAGE
// Storage-buffer morph payloads shared by both render backends. The deltas
// are the pin's own packing (`upstream::pack_morph_deltas`); the weights
// blob carries a 16-byte header the shader reads before the float array.
// The empty binding still needs the 16-byte header plus one runtime-array
// element. Both WebGPU and Metal validate that 20-byte minimum.
inline constexpr std::array<std::uint32_t, 5> empty_morph_weight_data{};

/**
 * The float array behind the weights blob's 16-byte header: one weight
 * per target, zero past the record's stored values. Split out because a
 * version-gated re-upload may rewrite just this span (the header is
 * constant after creation), and both backends must fill it identically.
 */
inline std::vector<float> morph_weight_values(const ModelGeometry& geometry,
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

inline std::vector<std::uint8_t> pack_morph_weights(const ModelGeometry& geometry,
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

inline std::uint16_t float_to_half(float value) {
    std::uint32_t bits = 0;
    std::memcpy(&bits, &value, sizeof(bits));
    const std::uint16_t sign = static_cast<std::uint16_t>((bits >> 16) & 0x8000u);
    const std::uint32_t exponent = (bits >> 23) & 0xffu;
    const std::uint32_t mantissa = bits & 0x7fffffu;
    if (exponent == 0xffu) {
        return static_cast<std::uint16_t>(sign | (mantissa == 0 ? 0x7c00u : 0x7e00u));
    }
    const int half_exponent = static_cast<int>(exponent) - 127 + 15;
    if (half_exponent >= 0x1f) {
        return static_cast<std::uint16_t>(sign | 0x7c00u);
    }
    if (half_exponent <= 0) {
        if (half_exponent < -10)
            return sign;
        const std::uint32_t normalized = mantissa | 0x800000u;
        const int shift = 14 - half_exponent;
        const std::uint32_t rounded =
            (normalized + (1u << (shift - 1)) - 1u + ((normalized >> shift) & 1u)) >> shift;
        return static_cast<std::uint16_t>(sign | rounded);
    }
    const std::uint32_t rounded = mantissa + 0xfffu + ((mantissa >> 13) & 1u);
    if ((rounded & 0x800000u) != 0) {
        const int next_exponent = half_exponent + 1;
        return static_cast<std::uint16_t>(
            next_exponent >= 0x1f ? sign | 0x7c00u
                                  : sign | static_cast<std::uint16_t>(next_exponent << 10));
    }
    return static_cast<std::uint16_t>(sign | static_cast<std::uint16_t>(half_exponent << 10) |
                                      static_cast<std::uint16_t>(rounded >> 13));
}

// The RGBD decode both render backends upload through.
#if BBLITE_HAS_PBR_RENDERER
inline std::vector<std::uint16_t> decode_rgbd(const TextureData& texture_data, int& width,
                                              int& height) {
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

/**
 * Whether the compiled environment carries a complete specular cube: a
 * nonzero extent and mip count, and one face per (mip, face) cell. Moved
 * verbatim from the two scene renderers' upload paths; what each backend
 * does WITHOUT one stays deliberately its own (SDL uploads fallback faces,
 * Dawn keeps its startup fallback cube).
 */
#endif

inline bool environment_cube_present(const EnvironmentState& environment) {
    return environment.specular_width != 0 && environment.specular_mip_count != 0 &&
           (environment.specular_gpu ||
            environment.specular_faces.size() >=
                static_cast<std::size_t>(environment.specular_mip_count) * 6);
}

/**
 * The DDS skybox payload walk both backends upload through: face-major,
 * each face's mip chain in file order, with the running byte offset and the
 * truncation guard decided here, once. `visit` receives one
 * (face, mip, extent, offset, byte_size) cell and performs the backend's
 * own upload; rgba16f texels at 8 bytes each, as the parser promised.
 */
template <typename Visit>
inline void for_each_dds_skybox_level(const EnvironmentState& environment, const Visit& visit) {
    const TextureData& data = environment.skybox_texture;
    std::size_t offset = environment.skybox_data_offset;
    for (std::uint32_t face = 0; face < 6; ++face) {
        for (std::uint32_t mip = 0; mip < environment.skybox_mip_count; ++mip) {
            const std::uint32_t size = std::max(environment.skybox_width >> mip, 1u);
            const std::size_t byte_size = static_cast<std::size_t>(size) * size * 8;
            if (offset + byte_size > data.bytes.size()) {
                throw std::runtime_error("DDS skybox pixel data is truncated.");
            }
            visit(face, mip, size, offset, byte_size);
            offset += byte_size;
        }
    }
}

#if BBLITE_HAS_UI
/** A recorded UI draw's scissor, clamped to the frame it was recorded in. */
struct UiScissorRect {
    int left = 0;
    int top = 0;
    int width = 0;
    int height = 0;
};

/**
 * One recorded UI draw's scissor rectangle, clamped to the frame extent, or
 * nothing for a draw the clamp empties (or that carries no indices). Shared
 * so the two backend compositors cannot drift on how a recorded rectangle
 * meets the surface.
 */
inline std::optional<UiScissorRect> clamped_ui_scissor(const UiRenderDraw& draw,
                                                       std::uint32_t frame_width,
                                                       std::uint32_t frame_height) {
    const int left = std::clamp(draw.scissor_x, 0, static_cast<int>(frame_width));
    const int top = std::clamp(draw.scissor_y, 0, static_cast<int>(frame_height));
    const int right = std::clamp(draw.scissor_x + static_cast<int>(draw.scissor_width), 0,
                                 static_cast<int>(frame_width));
    const int bottom = std::clamp(draw.scissor_y + static_cast<int>(draw.scissor_height), 0,
                                  static_cast<int>(frame_height));
    if (right <= left || bottom <= top || draw.index_count == 0) {
        return std::nullopt;
    }
    return UiScissorRect{left, top, right - left, bottom - top};
}
#endif

/**
 * The warmup every renderer's benchmark discards before sampling: a
 * tenth of the requested frames, clamped to [10, 120]. One policy for
 * both GPU frame loops and their sprite variants, so the published
 * numbers of any two renderers cover the same measured span of a run.
 */
[[nodiscard]] inline long benchmark_warmup_frames(long benchmark_frames) {
    return benchmark_frames > 0 ? std::min(120L, std::max(10L, benchmark_frames / 10)) : 0;
}

// How a measured run is driven, parsed once for whichever backend runs it.
struct FrameOptions {
    std::string screenshot_path;
    std::string id_buffer_path;
    std::string cluster_buffer_path;
    std::string shader_directory;
    std::string copy_task_filter;
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
    // A double, as `BBLITE_FRAME_DELTA_MS` is written and as the browser's
    // frame timestamps are; see `FrameClock::advance`.
    double frame_delta_ms = 0.0;

    [[nodiscard]] bool skip_copy_task(const CopyTaskOptions& copy) const {
        return !copy_task_filter.empty() && copy.has_viewport &&
               copy.name.find("-impostor-") != std::string::npos && copy.name != copy_task_filter;
    }
    [[nodiscard]] bool full_copy_viewport(const CopyTaskOptions& copy) const {
        return !copy_task_filter.empty() && copy.name == copy_task_filter;
    }

    /** Frames to run: a benchmark adds its warmup to the request. */
    [[nodiscard]] long frame_budget() const {
        return benchmark_frames > 0 ? benchmark_frames + benchmark_warmup() : max_frames;
    }
    [[nodiscard]] bool benchmarking() const { return benchmark_frames > 0; }
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
    [[nodiscard]] bool background_enabled(const EnvironmentState& environment) const {
        return background_flag == "1" || background_flag == "true" ||
               (background_flag.empty() && environment.background_enabled_by_default);
    }
    /** The skybox draws with the background when the scene carries one. */
    [[nodiscard]] bool skybox_enabled(const EnvironmentState& environment) const {
        return background_enabled(environment) && environment.has_skybox;
    }
    /** The scene's ground draws unless the flag refuses it. */
    [[nodiscard]] bool ground_enabled(const EnvironmentState& environment) const {
        return environment.has_ground && ground_flag != "0" && ground_flag != "false";
    }
};

inline DeviceOptions frame_device_options(const FrameOptions& frame) {
    return {frame.test_pass, frame.benchmark_requested, frame.gpu_debug};
}

inline long frame_option_number(const char* name) {
    const std::string value = environment_variable(name);
    return value.empty() ? 0L : std::strtol(value.c_str(), nullptr, 10);
}

inline FrameOptions read_frame_options() {
    FrameOptions options;
    options.screenshot_path = environment_variable("BBLITE_SCREENSHOT");
    options.id_buffer_path = environment_variable("BBLITE_ID_BUFFER");
    options.cluster_buffer_path = environment_variable("BBLITE_CLUSTER_BUFFER");
    options.shader_directory = environment_variable("BBLITE_GPU_SHADER_DIR");
    options.copy_task_filter = environment_variable("BBLITE_COPY_TASK");
    options.render_capture_path = environment_variable("BBLITE_RENDER_CAPTURE");
#if !BBLITE_VISUAL_CAPTURE
    if (!options.screenshot_path.empty() || !options.id_buffer_path.empty() ||
        !options.cluster_buffer_path.empty() || !options.render_capture_path.empty()) {
        throw std::runtime_error(
            "Visual capture is disabled in this build (BBLITE_VISUAL_CAPTURE=OFF).");
    }
#endif
    options.gpu_debug = environment_variable("BBLITE_GPU_DEBUG") == "1";
    options.test_pass = environment_variable("BBLITE_TEST_PASS") == "1";
    options.single_sample = environment_variable("BBLITE_MSAA") == "1";
    options.capture_ui = environment_variable("BBLITE_CAPTURE_UI") != "0";
    options.background_flag = environment_variable("BBLITE_BACKGROUND");
    options.ground_flag = environment_variable("BBLITE_GROUND");
    options.screenshot_frame = frame_option_number("BBLITE_SCREENSHOT_FRAME");
    options.max_frames = frame_option_number("BBLITE_MAX_FRAMES");
    options.benchmark_frames = frame_option_number("BBLITE_BENCHMARK_FRAMES");
    options.benchmark_requested = !environment_variable("BBLITE_BENCHMARK_FRAMES").empty();
    const std::string seek = environment_variable("BBLITE_ANIMATION_SEEK_SECONDS");
    options.animation_seek_seconds = seek.empty() ? 0.0 : std::strtod(seek.c_str(), nullptr);
    const std::string frame_delta = environment_variable("BBLITE_FRAME_DELTA_MS");
    options.frame_delta_ms = frame_delta.empty() ? 0.0 : std::strtod(frame_delta.c_str(), nullptr);
#if BBLITE_WORKERS
    // A worker renders into a leased canvas. The Window owns presentation,
    // screenshots and process lifetime for all of its canvases together.
    if (OffscreenRun::current()) {
        options.screenshot_path.clear();
        options.max_frames = 0;
        options.benchmark_frames = 0;
        options.benchmark_requested = false;
    }
#endif
    return options;
}

/**
 * A measured seek runs every registered animation seeker to the
 * requested time before the first frame; both frame loops apply the same
 * request so a seeked capture renders the same pose on either backend.
 */
inline void apply_animation_seek(const FrameOptions& options, const Scene& scene) {
    if (options.animation_seek_seconds == 0.0)
        return;
    for (const auto& seek : scene.animation_seekers) {
        seek(options.animation_seek_seconds);
    }
}

#if BBLITE_HAS_SPRITES
/**
 * Refuse the one dispose schedule no backend can honour, before either
 * releases the GPU texture behind the record.
 *
 * The generated dispose only flags the record; releasing the texture
 * would dangle the borrowed atlas binding of any layer still drawn with
 * it. (Upstream fails the same schedule too — as a WebGPU validation
 * error on the destroyed texture.) One walk decides for both backends,
 * so the refusal cannot become an SDL-undefined/Dawn-validation split.
 *
 * One walk covers every disposed record at once — a hit is a hit
 * whichever record it borrows — so each per-frame texture sync runs it
 * once, before its first release, while any record is disposed. A layer
 * registered over a long-disposed record is still caught at its next
 * sync, exactly as when the walk ran per record; a frame with nothing
 * disposed never walks at all.
 */
inline void refuse_disposed_sprite_render_texture_in_use(const Engine& engine) {
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

template <class Pass, class Create, class ReleaseLayer, class AtlasHandle, class ReleaseAtlas>
void reconcile_sprite_membership(const Engine& engine, Pass& pass, Create&& create,
                                 ReleaseLayer&& release_layer, AtlasHandle&& atlas_handle,
                                 ReleaseAtlas&& release_atlas) {
    const auto& renderer = handle_at(engine.sprite_renderers, pass.renderer);
    reconcile_ordered_records(
        renderer.layers, pass.layers, [](const auto& layer) { return layer.layer; }, create,
        release_layer);
    retire_unreferenced_records(
        pass.atlases,
        [&](const auto& atlas) {
            return std::any_of(renderer.layers.begin(), renderer.layers.end(),
                               [&](const auto handle) {
                                   return handle_at(engine.sprite_layers, handle).atlas.value ==
                                          atlas_handle(atlas).value;
                               });
        },
        release_atlas);
    pass.layers_version = renderer.layers_version;
}

/**
 * The instance rows one GPU copy of a layer must upload this frame.
 *
 * Another pass may already have consumed the layer's shared current
 * range. Its reset stamp tells a later copy to recover with the whole
 * active prefix rather than treating the now-empty range as count-only —
 * so a copy that never uploaded, or whose last upload predates the
 * stamp, takes `[0, count)`, and every other copy takes the shared range
 * clamped to the active count. An empty result means nothing moved.
 * Byte-identical in both backends, so derived once; only the write call
 * itself stays with the backend.
 */
struct SpriteDirtyRange {
    std::uint32_t begin = 0;
    std::uint32_t end = 0;
};

inline SpriteDirtyRange resolve_sprite_dirty_range(const Sprite2DLayerRecord& layer, bool uploaded,
                                                   std::uint64_t uploaded_version) {
    const bool needs_full_upload = !uploaded || uploaded_version < layer.dirty_sprite_reset_version;
    return {needs_full_upload ? 0u : std::min(layer.dirty_sprite_begin, layer.count),
            needs_full_upload ? layer.count : std::min(layer.dirty_sprite_end, layer.count)};
}

/**
 * The rows an instance copy transfers, once the optional Y-sort extension
 * has had its say.
 *
 * `uploadSpriteInstances` asks the hook first and uses what it returns
 * (`sprite-pipeline.ts`); an engine with no enabled layer finds it empty and
 * transfers the canonical logical rows the derivation above named. Shared for
 * the same reason the derivation is: both backends copy the same bytes to the
 * same offsets and differ only in the write call.
 */
inline SpriteInstanceUpload resolve_sprite_instance_upload(Engine& engine,
                                                           Sprite2DLayerRecord& layer,
                                                           bool uploaded,
                                                           std::uint64_t uploaded_version) {
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

/**
 * `spriteRendererUpdate`'s first act: run the renderer's own per-frame hooks
 * with the frame's delta, before anything reads its layer list.
 *
 * A disposed renderer runs none, which is the pin's own early return; the
 * list is copied because a hook may push another one, and upstream's
 * `for (const hook of rr._beforeUpdate)` iterates the array it entered with.
 */
inline void run_sprite_renderer_before_update(Engine& engine, SpriteRendererHandle renderer,
                                              double delta_ms) {
    if (renderer.value >= engine.sprite_renderers.size())
        return;
    SpriteRendererRecord& record = handle_at(engine.sprite_renderers, renderer);
    if (record.disposed || record.before_update.empty())
        return;
    // Copied into the record's own scratch rather than a fresh vector: the
    // copy is what makes this iterate the list it entered with, the way
    // upstream's `for (const hook of rr._beforeUpdate)` does, and assigning
    // into a retained buffer keeps that guarantee while paying the
    // allocation once instead of once per renderer per frame.
    record.before_update_running.assign(record.before_update.begin(), record.before_update.end());
    for (const auto& hook : record.before_update_running) {
        hook(delta_ms);
    }
}

/**
 * Whether a standalone driver's pass list still mirrors
 * `engine.registered_sprite_renderers` one-to-one, in order. Both
 * backends' pass records carry the renderer handle, so one comparison
 * serves either list; a mismatch means a callback registered or disposed
 * a renderer and the passes must be rebuilt.
 */
template <typename SpritePassList>
inline bool sprite_passes_match_registered(const Engine& engine, const SpritePassList& passes) {
    if (passes.size() != engine.registered_sprite_renderers.size()) {
        return false;
    }
    for (std::size_t index = 0; index < passes.size(); ++index) {
        if (passes[index].renderer.value != engine.registered_sprite_renderers[index].value) {
            return false;
        }
    }
    return true;
}

/**
 * The end of the run of consecutive sprite passes that share one output
 * target, starting at `first_index`.
 *
 * Registration order is draw order, and every renderer aiming at the
 * same target joins the same GPU render pass — the first one's clear
 * applies, the rest load — so the grouping is pure range computation
 * over the renderer records and identical for both backends.
 */
template <typename SpritePassList>
inline std::size_t sprite_pass_target_run_end(const Engine& engine, const SpritePassList& passes,
                                              std::size_t first_index) {
    const SpriteRendererRecord& first_renderer =
        engine.sprite_renderers[passes[first_index].renderer.value];
    std::size_t end_index = first_index + 1;
    while (end_index < passes.size()) {
        const SpriteRendererRecord& next =
            engine.sprite_renderers[passes[end_index].renderer.value];
        if (next.has_target != first_renderer.has_target ||
            (next.has_target && next.target.value != first_renderer.target.value)) {
            break;
        }
        ++end_index;
    }
    return end_index;
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
    /** The program's stem: `<stem>.vert` and `<stem>.frag` compile from one module. */
    const char* program_stem;
    bool axis_locked;
    /** The pinned depth table pairs `transparent` with writes off, which
     *  is what makes the sorted draw order the composite, and `cutout`
     *  with writes on, which lets the GPU resolve overlap instead. */
    bool cutout_writes_depth;

    std::uint32_t particle_passes;
};

inline BillboardDrawPlan billboard_draw_plan(const BillboardSystemRecord& system) {
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
inline bool billboard_needs_upload(const BillboardSystemRecord& system,
                                   const BillboardUploadStamp& stamp,
                                   const std::array<float, 16>& view,
                                   [[maybe_unused]] Vec3d fo_offset) {
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

inline void stamp_billboard_upload(BillboardUploadStamp& stamp, const BillboardSystemRecord& system,
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
#endif

inline const SolidTexture& effect_texture_for_binding(const EffectWrapperRecord& wrapper,
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

/**
 * The uniform floats a scene set must fill the block the descriptor
 * declared exactly: a short write leaves a stale or zero tail behind the
 * declared size, silently and differently per backend.
 */
inline void require_effect_uniform_size(const EffectWrapperRecord& wrapper,
                                        std::uint32_t uniform_bytes) {
    const std::size_t bytes = wrapper.uniform_values.size() * sizeof(float);
    if (bytes == uniform_bytes)
        return;
    throw std::runtime_error("Effect uniforms carry " + std::to_string(bytes) +
                             " bytes where the declared block takes " +
                             std::to_string(uniform_bytes) + ".");
}

/**
 * The delta a scene's before-render callbacks advance by.
 *
 * A scene that sets `fixedDeltaMs` pins it, which is how the measured
 * animated scenes stay deterministic. Everything else advances by the
 * elapsed frame time. Window realms use their supplied RAF timestamp,
 * matching the pinned engine; direct renderers sample the wall clock.
 * The first frame reports zero.
 */
class FrameClock {
public:
    // A double, as the browser's DOMHighResTimeStamp difference is: a
    // renderer hook that divides the delta by the pin's frame period
    // (`deltaMs / FRAME_MS`) reads exactly the ratio the browser computes
    // under the same fixed step, where a float step would leave it one
    // part in ten million short. Scene callbacks still take the float the
    // engine API declares.
    [[nodiscard]] double advance(double fixed_delta_ms) {
        std::optional<double> frame_timestamp;
#if BBLITE_WORKERS
        if (const auto* run = OffscreenRun::current())
            frame_timestamp = run->animation_frame_timestamp();
#endif
        const double now = frame_timestamp ? *frame_timestamp : monotonic_milliseconds();
        const bool first_frame = !previous_;
        const double measured = previous_ ? now - *previous_ : 0.0;
        previous_ = now;
        const double delta_ms = fixed_delta_ms > 0.0 && !first_frame ? fixed_delta_ms : measured;
        if (fixed_delta_ms > 0.0) {
            advance_performance_milliseconds(delta_ms);
        }
        return delta_ms;
    }

private:
    std::optional<double> previous_;
};

/**
 * Decode a texture's bytes to RGBA, substituting a 1x1 fallback texel
 * when the scene carries none, and apply the pinned `invertY` flip. The
 * result is what both backends upload, so it is produced once.
 */
inline DecodedImage decode_uploadable_image(const TextureData& texture_data,
                                            const std::array<std::uint8_t, 4>& fallback) {
    if (texture_data.gpu_source || texture_data.render_source)
        throw std::runtime_error("GPU-backed texture requires a live sampled-resource binding.");
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
        image = decode_image(js::ArrayBuffer(texture_data.bytes));
    }
    if (texture_data.premultiply_alpha) {
        premultiply_image_alpha(image);
    }
    if (texture_data.invert_y && image.height > 1) {
        const std::size_t row_bytes = static_cast<std::size_t>(image.width) * 4;
        std::vector<std::uint8_t> row(row_bytes);
        for (int y = 0; y < image.height / 2; ++y) {
            std::uint8_t* top = image.rgba.data() + static_cast<std::size_t>(y) * row_bytes;
            std::uint8_t* bottom =
                image.rgba.data() + static_cast<std::size_t>(image.height - 1 - y) * row_bytes;
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

inline CompressedMipCopy compressed_mip_copy(const CompressedTexture& texture,
                                             const CompressedMipLevel& mip) {
    const std::uint32_t blocks_per_row =
        (mip.width + texture.block_width - 1) / texture.block_width;
    const std::uint32_t block_rows = (mip.height + texture.block_height - 1) / texture.block_height;
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
#define BBLITE_FORMAT_ENUM(id, name, sdl, dawn) id,
    BBLITE_COMPRESSED_FORMATS(BBLITE_FORMAT_ENUM)
#undef BBLITE_FORMAT_ENUM
};

inline CompressedBlockFormat compressed_block_format(std::string_view name) {
#define BBLITE_FORMAT_NAME(id, text, sdl, dawn)                                                    \
    if (name == (text))                                                                            \
        return CompressedBlockFormat::id;
    BBLITE_COMPRESSED_FORMATS(BBLITE_FORMAT_NAME)
#undef BBLITE_FORMAT_NAME
    throw std::runtime_error("No compressed texture format for '" + std::string(name) + "'.");
}

template <typename Supports>
const CompressedTexture& select_compressed_texture(const TextureData& data, Supports supports) {
    if (supports(data.compressed.format))
        return data.compressed;
    if (data.compressed_alternatives) {
        for (const auto& candidate : *data.compressed_alternatives) {
            if (supports(candidate.format))
                return candidate;
        }
    }
    throw std::runtime_error("This device cannot sample any packaged compressed texture variant.");
}

inline std::uint32_t full_mip_chain(std::uint32_t width, std::uint32_t height) {
    return static_cast<std::uint32_t>(upstream::mip_level_count(width, height));
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
#if BBLITE_HAS_SPRITES
inline std::uint32_t atlas_mip_levels(const SpriteAtlasRecord& atlas) {
    return atlas.mip_maps ? full_mip_chain(atlas.width, atlas.height) : 1u;
}
#endif

using upstream::transmission_grab_size;
using upstream::transmission_sampler_max_anisotropy;

inline std::uint32_t transmission_grab_mip_count() {
    return static_cast<std::uint32_t>(
        upstream::transmission_mip_level_count(transmission_grab_size, transmission_grab_size));
}

/**
 * Whether one draw's material is transmissive — the predicate behind the
 * pinned mid-pass break: `executePassWithTransmission` grabs the scene
 * colour before the FIRST draw this returns true for. The once-per-frame
 * latch and the pass surgery around it stay per backend.
 */
inline bool transmissive_draw_material(const MaterialRecord* material) {
    return material != nullptr &&
           (material->transmission_factor > 0.0f || !material->transmission_texture.bytes.empty());
}

/**
 * The pixels a target scaled from another occupies, by the pin's own rule:
 * `max(1, floor(extent * ratio))`, evaluated against whatever the source
 * resolved to this build.
 */
inline std::uint32_t scaled_target_extent(std::uint32_t source, double ratio) {
    return static_cast<std::uint32_t>(
        std::max(1.0, std::floor(static_cast<double>(source) * ratio)));
}

/** Both extents of a target sized from another, see `scaled_target_extents`. */
struct ScaledExtents {
    std::uint32_t width = 0;
    std::uint32_t height = 0;
};

/**
 * A scaled target's extents under the rounding its record names: the
 * composite rule above, or the screen-space effects' own
 * `computeScreenSpaceScaledSize`, which generation lowers from the pin and
 * which takes one scale for both axes. A record asking for that rule in a
 * build that reached no screen-space effect names a generation defect, so
 * it fails rather than rounding the other way.
 */
inline ScaledExtents scaled_target_extents(const RenderTargetRecord& record,
                                           std::uint32_t source_width,
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

template <class Format> struct RenderTargetPlan {
    std::uint32_t width, height;
    Format color_format;
};

inline void synchronize_render_target_lifecycles(const Engine& engine) {
    const auto count = engine.render_targets.size();
    for (std::size_t index = 0; index < count; ++index) {
        const auto lifecycle = engine.render_targets[index].lifecycle;
        if (lifecycle)
            lifecycle->synchronize();
    }
}

/** Resolve source-relative sizes and inherited formats before allocating GPU resources. */
template <class Format, class Convert>
std::vector<RenderTargetPlan<Format>>
plan_render_targets(const Engine& engine, std::uint32_t width, std::uint32_t height,
                    Format surface_format, Convert&& convert) {
    std::vector<RenderTargetPlan<Format>> plans;
    plans.reserve(engine.render_targets.size());
    for (const auto& record : engine.render_targets) {
        auto [target_width, target_height] = surface_target_extent(engine, record, width, height);
        Format format = surface_format;
        if (record.scale_source.value != invalid_handle) {
            if (record.scale_source.value >= plans.size()) {
                throw std::runtime_error("A render target must scale from an earlier target.");
            }
            const auto& source = plans[record.scale_source.value];
            const auto scaled = scaled_target_extents(record, source.width, source.height);
            target_width = scaled.width;
            target_height = scaled.height;
            format = source.color_format;
        }
        if (record.swapchain)
            format = surface_format;
        else if (record.has_format)
            format = convert(record.format);
        plans.push_back({target_width, target_height, format});
    }
    return plans;
}

#if BBLITE_HAS_SCREEN_SPACE
template <class Clear, class Stage, class PostProcess>
void record_screen_space_decision(const ScreenSpaceFrameDecision& decision, bool composite,
                                  Clear&& clear, Stage&& stage, PostProcess&& post_process) {
    if (decision.clear_identity) {
        clear(false);
        clear(true);
    }
    if (decision.run_effect) {
        stage(true, decision.producer_uniforms.data());
        stage(false, decision.temporal_uniforms.data());
        post_process(0u);
    }
    if (composite)
        post_process(1u);
}

/**
 * What the generated screen-space frame function reads off a backend's
 * targets: the depth source's and the raw target's extents, and the
 * allocation identities its texture-identity tests compare (docs/fidelity.md).
 * Both backends keep those three fields on their target rows under the same
 * names, so one reader serves both.
 */
template <typename RenderTargets>
ScreenSpaceFrameInputs screen_space_frame_inputs(const RenderTargets& targets,
                                                 const ScreenSpaceTaskOptions& task) {
    const auto& depth = targets.at(task.depth.value);
    const auto& source = targets.at(task.source.value);
    const auto& raw = targets.at(task.raw.value);
    const auto& stable = targets.at(task.stable.value);
    const auto& history = targets.at(task.history.value);
    ScreenSpaceFrameInputs inputs;
    inputs.depth_width = depth.width;
    inputs.depth_height = depth.height;
    inputs.effect_width = raw.width;
    inputs.effect_height = raw.height;
    inputs.depth_allocation = depth.allocation;
    inputs.color_allocation = source.allocation;
    inputs.raw_allocation = raw.allocation;
    inputs.stable_allocation = stable.allocation;
    inputs.history_allocation = history.allocation;
    return inputs;
}
#endif

#if BBLITE_HAS_POST_PROCESS
/** One post-process pass's resolved output and source extents. */
struct PostProcessExtent {
    std::uint32_t output_width = 0;
    std::uint32_t output_height = 0;
    std::uint32_t source_width = 0;
    std::uint32_t source_height = 0;
};

/**
 * The extents both backends resolve one post-process pass against: the
 * output target's own size (the frame's, when the pass presents to the
 * swapchain), and the sampled target's when the pass names another render
 * target whose backend row exists -- otherwise the source inherits the
 * output extent. `RenderTargets` is each backend's per-target state
 * vector; only its rows' `width`/`height` are read.
 */
template <typename RenderTargets>
inline PostProcessExtent
resolve_post_process_extent(const RenderTargetRecord& output_record,
                            const RenderTargets& render_targets, const PostProcessPassOptions& pass,
                            std::uint32_t frame_width, std::uint32_t frame_height) {
    PostProcessExtent extent;
    extent.output_width =
        output_record.swapchain ? frame_width : handle_at(render_targets, pass.output_target).width;
    extent.output_height = output_record.swapchain
                               ? frame_height
                               : handle_at(render_targets, pass.output_target).height;
    extent.source_width = extent.output_width;
    extent.source_height = extent.output_height;
    if (pass.source.source == RenderTextureSource::render_target &&
        pass.source.target.value < render_targets.size()) {
        extent.source_width = handle_at(render_targets, pass.source.target).width;
        extent.source_height = handle_at(render_targets, pass.source.target).height;
    }
    return extent;
}
#endif

inline TextureFormatClass geometry_format_class(const GeometryTextureDescription& description) {
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
    return type == GeometryTextureType::normalized_view_depth ? 1.0f : 0.0f;
}

/**
 * The three blend-factor tuples the corpus reaches, stated once. A
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

// ShaderMaterial blendMode "additive": color src-alpha + destination,
// alpha source + destination, exactly as the pin's shader pipeline states it.
inline constexpr BlendFactors shader_additive_blend{
    BlendFactor::src_alpha,
    BlendFactor::one,
    BlendFactor::one,
    BlendFactor::one,
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
inline bool alpha_to_coverage_enabled(bool wants_a2c, std::uint32_t samples) {
    return wants_a2c && samples > 1;
}

#if BBLITE_HAS_PBR_RENDERER
/**
 * The fixed-function facts one `RenderPipelineKind` carries, decoded once
 * for both backends: the material family, whether the draw blends, the
 * cull mode and the front face. The plan's own enums carry the answers,
 * so a backend keeps only its API-enum translation — the same split the
 * depth compare already uses. A new enumerator must be given an arm here
 * rather than inheriting one.
 */
struct RenderPipelineKindTraits {
    upstream::RenderMaterialKind family{};
    bool transparent{};
    upstream::RenderCullMode cull{};
    bool clockwise_front_face{};
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

inline RenderPipelineKindTraits pipeline_kind_traits(upstream::RenderPipelineKind kind) {
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

/**
 * Reconcile one backend's uploaded mesh rows with a rebuilt render plan.
 *
 * Plans preserve scene order, so a forward scan moves surviving rows,
 * releases removed rows, and uploads only new rows. The GPU resource type and
 * its release/upload operations remain backend-owned.
 */
template <typename GpuMesh, typename ReleaseMesh, typename UploadItem>
inline std::vector<GpuMesh>
rematch_render_meshes(const std::vector<upstream::RenderItem>& previous_items,
                      const std::vector<upstream::RenderItem>& updated_items,
                      std::vector<GpuMesh>& uploaded_meshes, ReleaseMesh&& release_mesh,
                      UploadItem&& upload_item) {
    if (previous_items.size() != uploaded_meshes.size()) {
        throw std::runtime_error("Render plan and uploaded mesh rows are out of sync.");
    }
    // The whole mesh handle: a row uploaded for a retired mesh must not
    // survive into the mesh that reused its slot (and possibly its
    // geometry slot) before this rebuild.
    const auto same_source = [](const upstream::RenderItem& left,
                                const upstream::RenderItem& right) {
        return left.mesh == right.mesh && left.geometry == right.geometry &&
               left.material.value == right.material.value;
    };
    std::vector<GpuMesh> result;
    result.reserve(updated_items.size());
    std::size_t previous_index = 0;
    for (const upstream::RenderItem& item : updated_items) {
        std::size_t scan = previous_index;
        while (scan < previous_items.size() && !same_source(previous_items[scan], item)) {
            ++scan;
        }
        if (scan < previous_items.size()) {
            for (std::size_t dropped = previous_index; dropped < scan; ++dropped) {
                release_mesh(uploaded_meshes[dropped]);
            }
            result.push_back(std::move(uploaded_meshes[scan]));
            previous_index = scan + 1;
            continue;
        }
        result.push_back(upload_item(item));
    }
    for (std::size_t dropped = previous_index; dropped < uploaded_meshes.size(); ++dropped) {
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

/** Rebuild an existing overlay's rows before uploads/encoding, using backend-owned leases. */
template <typename GpuMesh, typename ReleaseMesh, typename UploadItem>
inline bool refresh_overlay_render_plans(Engine& engine, std::vector<upstream::RenderPlan>& plans,
                                         std::vector<std::vector<GpuMesh>>& meshes,
                                         std::vector<std::uint64_t>& versions,
                                         bool draw_lists_changed, ReleaseMesh&& release_mesh,
                                         UploadItem&& upload_item) {
    if (plans.size() != meshes.size() || plans.size() != versions.size() ||
        plans.size() + 1 != engine.registered_scenes.size()) {
        throw std::runtime_error("Overlay registration changed after renderer initialization.");
    }
    bool changed = false;
    for (std::size_t layer = 0; layer < plans.size(); ++layer) {
        Scene& scene = *engine.registered_scenes[layer + 1];
        if (scene.render_topology_version != versions[layer]) {
            reject_uncomposed_family_growth(scene.material_family_mask);
            upstream::RenderPlan updated = upstream::build_render_plan(scene, engine);
            validate_render_plan_items(updated);
            meshes[layer] = rematch_render_meshes(plans[layer].items, updated.items, meshes[layer],
                                                  release_mesh, upload_item);
            plans[layer] = std::move(updated);
            versions[layer] = scene.render_topology_version;
            changed = true;
        } else if (draw_lists_changed) {
            plans[layer].draw_lists = upstream::build_render_draw_lists(plans[layer].items, engine);
            changed = true;
        }
    }
    return changed;
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

inline GeometryTargetClasses geometry_target_classes(const FrameTaskRecord& task) {
    GeometryTargetClasses classes;
    classes.attachments.reserve(task.geometry.attachments.size());
    for (const GeometryTextureDescription& description : task.geometry.attachments) {
        classes.attachments.push_back(geometry_format_class(description));
    }
    classes.trailing_output = task.geometry.target.value != invalid_handle;
    return classes;
}

/**
 * The count assertion beside the list: a variant composed for N targets
 * over a task carrying M is the same generation bug on either backend,
 * so the refusal is stated once. `family` names the variant family the
 * caller resolves ("pinned", "standard" or "node").
 */
inline void require_geometry_target_count(const GeometryTargetClasses& classes,
                                          std::size_t entry_color_target_count,
                                          const char* family) {
    const std::size_t total = classes.attachments.size() + (classes.trailing_output ? 1u : 0u);
    if (total == entry_color_target_count)
        return;
    throw std::runtime_error(std::string(family) + " geometry variant writes " +
                             std::to_string(entry_color_target_count) +
                             " targets where its task carries " + std::to_string(total) + ".");
}

/**
 * The colour formats a geometry task's pipeline renders into, in
 * attachment order: one per composed class and, when the task keeps
 * `emitColor`'s output, the frame's colour format last. `format` maps a
 * class onto the backend's own format enum and `trailing` is that
 * backend's frame colour format, so both backends build their MRT target
 * descriptions from this one list.
 */
template <typename Format, typename FormatOf>
inline std::vector<Format>
geometry_color_target_formats(const FrameTaskRecord& task, std::size_t entry_color_target_count,
                              const char* family, FormatOf&& format, Format trailing) {
    const GeometryTargetClasses classes = geometry_target_classes(task);
    require_geometry_target_count(classes, entry_color_target_count, family);
    std::vector<Format> formats;
    formats.reserve(classes.attachments.size() + 1u);
    for (const TextureFormatClass format_class : classes.attachments) {
        formats.push_back(format(format_class));
    }
    if (classes.trailing_output)
        formats.push_back(trailing);
    return formats;
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

#if BBLITE_PINNED_BACKGROUNDS
/**
 * The background arms a run draws, by the stage slot each one fills.
 *
 * The entry points push one renderable per arm, and the pin keys each
 * arm's pipeline on its own flags: the ground and the DDS skybox compose
 * WGSL_DITHER or WGSL_NO_DITHER on `enableNoise`, and the environment
 * skybox is the .env arm when it samples the environment's own cube.
 * Stated once, so both backends build and draw the same arms.
 */
struct PinnedBackgroundDraws {
    std::optional<upstream::PinnedBackgroundArmKind> solid;
    std::optional<upstream::PinnedBackgroundArmKind> environment;
    std::optional<upstream::PinnedBackgroundArmKind> image;
    std::optional<upstream::PinnedBackgroundArmKind> ground;

    [[nodiscard]] std::optional<upstream::PinnedBackgroundArmKind> skybox(SkyboxLayer layer) const {
        switch (layer) {
        case SkyboxLayer::solid:
            return solid;
        case SkyboxLayer::environment:
            return environment;
        case SkyboxLayer::image:
            return image;
        }
        return std::nullopt;
    }

    template <typename Visit> void for_each(Visit visit) const {
        for (const std::optional<upstream::PinnedBackgroundArmKind>& kind :
             {solid, environment, image, ground}) {
            if (kind)
                visit(*kind);
        }
    }
};

inline PinnedBackgroundDraws select_pinned_backgrounds(const FrameOptions& options,
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

/**
 * Cluster ids advance in fixed 128-triangle groups, and the id and
 * cluster buffers are compared against the browser's, so both backends
 * have to number them identically.
 */
struct ClusterRange {
    std::uint32_t triangle_count;
    std::uint32_t id_start;
};

inline ClusterRange advance_cluster_range(std::uint32_t index_count,
                                          std::uint32_t& cluster_id_base) {
    const std::uint32_t triangle_count = index_count / 3;
    const std::uint32_t id_start = cluster_id_base;
    cluster_id_base += (triangle_count + 127u) / 128u;
    return ClusterRange{triangle_count, id_start};
}

#if BBLITE_HAS_PBR_RENDERER
/**
 * The alpha state the diagnostic shaders read: the bucket as a mode, the
 * cutoff, and the material alpha. A material-less item renders opaque at
 * full alpha.
 */
inline std::array<float, 4> diagnostic_alpha_options(const upstream::RenderItem& item,
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

inline DiagnosticIdUniforms diagnostic_id_uniforms(std::uint32_t draw_id,
                                                   const std::array<float, 4>& alpha_options) {
    DiagnosticIdUniforms uniforms{};
    uniforms.id_color[0] = static_cast<float>(draw_id & 0xffu) / 255.0f;
    uniforms.id_color[1] = static_cast<float>((draw_id >> 8) & 0xffu) / 255.0f;
    uniforms.id_color[2] = static_cast<float>((draw_id >> 16) & 0xffu) / 255.0f;
    uniforms.id_color[3] = 1.0f;
    std::copy_n(alpha_options.begin(), 4, uniforms.alpha_options);
    return uniforms;
}

inline DiagnosticClusterUniforms
diagnostic_cluster_uniforms(std::uint32_t cluster_base, const std::array<float, 4>& alpha_options) {
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
inline bool block_is_shared_scene_matrix(const upstream::ShaderVariantStageBlock& block) {
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

/**
 * One shader draw's own matrix lanes, derived once and consumed
 * identically by both backends' draw loops and the render capture: the
 * mesh block's world (`_shaderWorldMatrix`), the world-view-projection
 * product, and the world-view product when the pass carries a view. The record owns the
 * storage the patched ShaderPassMatrices points into, so keep it alive
 * through the block writes made against `apply`'s result.
 */
struct ShaderDrawMatrices {
    std::array<float, 16> world;
    std::array<float, 16> world_view_projection;
    std::optional<std::array<float, 16>> world_view;

    ShaderDrawMatrices(const Scene& scene, const Engine& engine, const MeshRecord& mesh,
                       const ShaderPassMatrices& pass)
        : world(mesh_block_world(scene, engine, mesh)),
          world_view_projection(upstream::matrix_product(pass.view_projection, world)),
          world_view(shader_world_view(pass.view, world)) {}

    /** The pass matrices with this draw's three lanes patched in. */
    [[nodiscard]] ShaderPassMatrices apply(const ShaderPassMatrices& pass) const {
        ShaderPassMatrices patched = pass;
        patched.world = &world;
        patched.world_view = world_view ? &*world_view : nullptr;
        patched.world_view_projection = &world_view_projection;
        return patched;
    }
};

/** Camera position in the same absolute/eye-relative frame as shader world. */
inline std::array<float, 4> shader_camera_position(const Scene& scene, const Engine& engine,
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

/**
 * One camera pass's matrices -- the effective aspect, the view-projection,
 * its two factors and the eye -- built from one camera so a pass cannot mix
 * two sources. A pass without a camera keeps the zeros of the scene block
 * the pin never writes for it (see `scene_camera`).
 */
struct CameraPassMatrices {
    double aspect = 0.0;
    std::array<float, 16> view_projection{};
    std::array<float, 16> view{};
    std::array<float, 16> projection{};
    std::array<float, 4> camera_position{};

    /** The pass matrices a shader draw reads, pointing into this record. */
    [[nodiscard]] ShaderPassMatrices pass() const {
        ShaderPassMatrices matrices{view_projection.data(), &view, &projection};
        matrices.camera_position = &camera_position;
        return matrices;
    }
};

/**
 * `camera`'s pass over a `width` x `height` extent. The aspect is the
 * pinned `getEffectiveAspectRatio`, a division of two JavaScript numbers
 * that reaches the projection writers in double: a camera carrying a
 * viewport scales the extent's ratio by the viewport's own. The projection
 * is the pin's `getProjectionMatrix`, the arm that branches on the camera,
 * rather than the perspective writer the skybox takes.
 */
inline CameraPassMatrices camera_pass_matrices(const Scene& scene, const Engine& engine,
                                               const CameraRecord* camera, double width,
                                               double height) {
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

/** A render task's clear colour, the pin's `cfg.clrColor ?? sc.clearColor`, read live at the pass. */
inline Color4 render_task_clear_color(const FrameTaskRecord& task) {
    return task.render.clear_color ? *task.render.clear_color : task.source_scene->clear_color;
}

/**
 * One custom-shader stage block: declared system matrices followed by the
 * reflected gathers from the material's flat value storage. These exact
 * floats feed SDL pushes, Dawn buffer writes and render capture.
 *
 * Filled into a caller-owned scratch rather than a returned vector so the
 * per-draw walks in all three consumers reuse one allocation; `assign`
 * zero-fills every element, so the bytes match a freshly sized vector's.
 */
inline void shader_stage_block_floats(const upstream::ShaderVariantStageBlock& block,
                                      const ShaderPassMatrices& pass,
                                      const MaterialRecord& material, std::vector<float>& floats) {
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

/** Give every pre-render application RAF callback this turn's one timestamp. */
inline void run_animation_frame_callbacks(Engine& engine) {
    engine.animation_frame_after_render = false;
    engine.animation_frame_timestamp_ms = performance_milliseconds();
    const auto persistent_callbacks = engine.animation_frame_callbacks;
    auto once_callbacks = std::move(engine.animation_frame_once_callbacks);
    engine.animation_frame_once_callbacks.clear();
    for (const auto& callback : persistent_callbacks) {
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
[[nodiscard]] inline double advance_frame(Engine& engine, Scene& scene, FrameClock& frame_clock,
                                          double frame_delta_ms) {
    if (engine.stopped) {
        return 0.0;
    }
    const double delta_ms = frame_clock.advance(frame_delta_ms);
    run_animation_frame_callbacks(engine);
    const double scene_delta_ms = scene_callback_delta(scene, delta_ms);
    // The scene callback API is the engine's float delta.
    const float callback_delta_ms = static_cast<float>(scene_delta_ms);
    // A callback may dispose its own scene while it is running. Snapshot the
    // dispatch list so clearing SceneState::before_render cannot destroy the
    // currently executing std::function (or invalidate the next iterator).
    const auto root_callbacks = scene.before_render;
    for (const auto& callback : root_callbacks) {
        callback(callback_delta_ms);
    }
    if (scene.state->process_material_groups)
        scene.state->process_material_groups(scene);
    // Every other registered scene's own callbacks. A swapchain overlay
    // layer is a second SceneContext with its own `_beforeRender` list --
    // the utility layer's camera forwarding and each gizmo's follow live
    // there -- and upstream runs a scene's callbacks as part of rendering
    // it, so a layer that is drawn is a layer whose callbacks ran.
    const auto registered_scenes = engine.registered_scenes;
    for (const std::shared_ptr<Scene>& registered : registered_scenes) {
        if (!registered || registered->shares_identity(scene))
            continue;
        const auto registered_delta_ms =
            static_cast<float>(scene_callback_delta(*registered, delta_ms));
        const auto callbacks = registered->before_render;
        for (const auto& callback : callbacks) {
            callback(registered_delta_ms);
        }
        if (registered->state->process_material_groups)
            registered->state->process_material_groups(*registered);
    }
    return scene_delta_ms;
}

/**
 * The same boundary for a loop with no scene. A `SpriteRenderer` or an
 * `EffectRenderer` is its own rendering context on the engine, but an
 * application can still own a requestAnimationFrame loop and queue a
 * timeout. Both run from the same frame clock as custom-shader time.
 */
[[nodiscard]] inline double advance_frame(Engine& engine, FrameClock& frame_clock,
                                          double frame_delta_ms) {
    if (engine.stopped) {
        return 0.0;
    }
    const double delta_ms = frame_clock.advance(frame_delta_ms);
    run_animation_frame_callbacks(engine);
    return delta_ms;
}

/** The measured update boundary for a standalone FrameGraphContext. */
[[nodiscard]] inline double advance_frame(Engine& engine, FrameGraphContext& context,
                                          FrameClock& frame_clock, double frame_delta_ms) {
    if (engine.stopped)
        return 0.0;
    const double delta_ms = frame_clock.advance(frame_delta_ms);
    run_animation_frame_callbacks(engine);
    const float callback_delta_ms = static_cast<float>(delta_ms);
    for (const auto& callback : context.updates) {
        callback(callback_delta_ms);
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
    if (engine.drain_material_jobs)
        engine.drain_material_jobs(engine);
#if BBLITE_DEVICE_RECOVERY
    complete_device_recovery(engine);
#endif
    js::collect_at_frame_boundary();
    if (engine.stopped)
        return;
    engine.animation_frame_after_render = true;
    auto once_callbacks = std::move(engine.post_render_animation_frame_once_callbacks);
    engine.post_render_animation_frame_once_callbacks.clear();
    if (engine.post_render_animation_frame_callbacks_armed) {
        for (const auto& callback : engine.post_render_animation_frame_callbacks) {
            callback(engine.animation_frame_timestamp_ms);
        }
        for (const auto& callback : once_callbacks) {
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
#if BBLITE_HAS_AUDIO
    audio_collect_finished();
#endif
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
    CaptureGate(const FrameOptions& options, long limit, const Engine* engine = nullptr)
        : options_(&options), limit_(limit), engine_(engine) {}

    bool screenshot_saved = false;
    bool id_buffer_saved = false;
    bool cluster_buffer_saved = false;
    bool render_capture_saved = false;

    /**
     * The standalone loops' render capture, gated and marked here.
     *
     * The capture describes CPU state alone — the same records the
     * loop's uploads read — written once, at the frame the screenshot
     * gate names, exactly as the scene loops write theirs beside their
     * screenshots. Six drivers each spelled the gate before this owned
     * it, which is the class's founding reason. Defined in
     * pal_render_capture.hpp beside the writer it calls, so a TU that
     * includes only this header carries no undefined inline.
     */
    void maybe_write_standalone_render_capture(const char* backend, const Engine& engine,
                                               std::uint32_t width, std::uint32_t height,
                                               long frame, TextGpuCapture* text_capture = nullptr);

    /** Whether this run was asked for any capture at all. */
    [[nodiscard]] bool requested() const {
        return BBLITE_VISUAL_CAPTURE &&
               (!options_->screenshot_path.empty() || !options_->id_buffer_path.empty() ||
                !options_->cluster_buffer_path.empty() || !options_->render_capture_path.empty());
    }

    [[nodiscard]] bool pending() const {
        return (!options_->screenshot_path.empty() && !screenshot_saved) ||
               (!options_->id_buffer_path.empty() && !id_buffer_saved) ||
               (!options_->cluster_buffer_path.empty() && !cluster_buffer_saved) ||
               (!options_->render_capture_path.empty() && !render_capture_saved);
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
    [[nodiscard]] bool engine_stopped() const { return engine_ != nullptr && engine_->stopped; }

    /**
     * Whether every bounded multi-frame drain the scene declared has
     * resolved. A scene that declares none is ready from frame zero.
     *
     * It lives here for the reason `engine_stopped` does: the condition
     * belongs to the run rather than to one renderer, and every loop that
     * hands this gate an engine gets the same answer.
     */
    [[nodiscard]] bool drains_resolved() const {
        if (engine_ == nullptr)
            return true;
        // `startEngine` resolves after its first render. The compiler queues
        // source following that await at the matching native frame boundary;
        // capturing while it is still pending would freeze the initial scene
        // instead of the state whose browser-ready marker follows it.
        if (engine_->pending_start_continuations != 0)
            return false;
        for (const std::function<bool()>& ready : engine_->capture_ready) {
            if (!ready || !ready())
                return false;
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
        if (!running || limit_ <= 0 || frame < limit_)
            return running;
        if (!pending())
            return false;
        // Past the budget, a pending capture keeps the loop alive while the
        // program's own start-up continuations are still draining -- a
        // scene that awaits nine frame boundaries before its state is
        // final (scene 118 waits, picks, then waits again) cannot be
        // captured before they resolve, and the browser harness waits for
        // that scene's ready marker the same way -- and then for a short
        // grace counted from the frame they resolved on, because the
        // capture check runs before the frame's drain and a topology
        // change defers a capture by one more frame. The drain cap bounds
        // a program that never resolves.
        if (!drains_resolved())
            return frame < limit_ + drain_cap_frames;
        if (drains_resolved_at_ < 0)
            drains_resolved_at_ = frame;
        return frame < std::max(limit_, drains_resolved_at_) + grace_frames;
    }

    static constexpr long grace_frames = 8;
    static constexpr long drain_cap_frames = 600;

private:
    const FrameOptions* options_;
    long limit_;
    const Engine* engine_;
    /** The first frame `keep_running` saw the drains resolved, or -1. */
    mutable long drains_resolved_at_ = -1;
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
inline void report_benchmark(std::vector<double> samples, const char* backend,
                             const std::string& driver) {
    if (samples.empty())
        return;
    std::sort(samples.begin(), samples.end());
    double sum = 0.0;
    for (const double sample : samples)
        sum += sample;
    const std::size_t p95_index = std::min(
        samples.size() - 1, static_cast<std::size_t>(std::ceil(samples.size() * 0.95)) - 1);
    const std::ios_base::fmtflags flags = std::cout.flags();
    const std::streamsize precision = std::cout.precision();
    std::cout << std::fixed << std::setprecision(3) << "Babylon Lite " << backend
              << " benchmark | driver=" << driver << " | frames=" << samples.size()
              << " | average=" << (sum / samples.size())
              << " ms | median=" << samples[samples.size() / 2]
              << " ms | p95=" << samples[p95_index] << " ms | min=" << samples.front()
              << " ms | max=" << samples.back() << " ms\n";
    std::cout.flags(flags);
    std::cout.precision(precision);
}

/**
 * The BBLITE_CPU_PROFILE startup marks both scene frame loops print --
 * the same phases under the same field names, so the lines are parsed
 * and compared across backends. One home keeps the format from
 * drifting; only the backend label differs:
 * `[cpu][<label>-startup] phase=<name> phase_ms=<ms> elapsed_ms=<ms>`.
 *
 * The instance is called like the lambda it replaced --
 * `cpu_startup_mark("render-plan")` -- and prints nothing when
 * profiling is off, while still anchoring its clock at construction.
 */
class CpuStartupMark {
public:
    CpuStartupMark(bool enabled, const char* label)
        : enabled_(enabled), label_(label), start_(monotonic_milliseconds()), previous_(start_) {}

    void operator()(const char* phase) {
        if (!enabled_)
            return;
        const double now = monotonic_milliseconds();
        std::fprintf(stderr, "[cpu][%s-startup] phase=%s phase_ms=%.3f elapsed_ms=%.3f\n", label_,
                     phase, now - previous_, now - start_);
        previous_ = now;
    }

private:
    bool enabled_;
    const char* label_;
    double start_;
    double previous_;
};

/**
 * The per-frame BBLITE_CPU_PROFILE line, printed by both scene frame
 * loops every 30th frame and on frames taking at least 10 ms, so the field
 * order lives once. `write_ms` is Dawn's own phase -- the per-draw
 * uniform writes WebGPU's no-push-constants model forces -- and the
 * field appears only when the caller measured one, so each backend's
 * line keeps exactly the bytes it always printed.
 */
inline bool frame_profile_due(long frame, double elapsed_ms) {
    return frame % 30 == 0 || elapsed_ms >= 10;
}

inline void print_cpu_frame_profile(long frame, double total_ms, double acquire_ms,
                                    double update_ms, double upload_ms,
                                    const std::optional<double>& write_ms, double encode_submit_ms,
                                    std::size_t render_items, std::size_t draw_commands) {
    std::ostringstream line;
    line << std::fixed << std::setprecision(3) << "[cpu][frame] frame=" << frame
         << " total_ms=" << total_ms << " acquire_ms=" << acquire_ms << " update_ms=" << update_ms
         << " upload_ms=" << upload_ms;
    if (write_ms.has_value())
        line << " write_ms=" << *write_ms;
    line << " encode_submit_ms=" << encode_submit_ms << " render_items=" << render_items
         << " draw_commands=" << draw_commands << '\n';
    std::fputs(line.str().c_str(), stderr);
}

/**
 * The per-frame BBLITE_MEM_PROFILE line, printed by every frame loop on
 * the BBLITE_CPU_PROFILE cadence (every `memory_profile_frames`th frame),
 * so `scene -- memory` parses one format. It answers whether a long run
 * settles: the working set, how many mesh records the engine holds
 * against how many the scene still draws, the CPU geometry bytes still
 * allocated (a retired mesh's are released by removeFromScene), and the
 * backend's live GPU meshes and shared-geometry cache. A loop without a
 * scene or a geometry cache (the sprite renderers) prints zeros there.
 *
 * A process can run several engines at once (a Window host's canvases,
 * each on its realm's thread). Every loop counts its own frames and reads
 * its own thread's GC registry, so each prints one ordered stream under
 * its own `engine=` number, assigned in start order.
 */
inline constexpr long memory_profile_frames = 30;

class MemoryProfile {
public:
    [[nodiscard]] bool due(long frame) const {
        return stream_ != 0 && frame % memory_profile_frames == 0;
    }
    void print(long frame, const bbl::Engine& engine, std::size_t scene_meshes,
               std::size_t gpu_meshes, std::size_t shared_geometries,
               std::size_t shared_geometry_bytes) const;
    /** The scene-loop form: the backend's mesh list and shared-geometry cache. */
    template <typename GpuMesh, typename SharedGeometry>
    void print(long frame, const bbl::Engine& engine, const bbl::Scene& scene,
               const std::vector<GpuMesh>& gpu_meshes,
               const std::vector<std::unique_ptr<SharedGeometry>>& cache) const {
        std::size_t bytes = 0;
        for (const auto& geometry : cache) {
            bytes += geometry->identity.vertex_count * sizeof(GpuVertex) +
                     geometry->identity.index_count * sizeof(std::uint32_t);
        }
        print(frame, engine, scene.meshes.size(), gpu_meshes.size(), cache.size(), bytes);
    }

private:
    static std::uint32_t start() {
        static std::atomic<std::uint32_t> started = 0;
        return environment_variable("BBLITE_MEM_PROFILE") == "1" ? ++started : 0;
    }
    const std::uint32_t stream_ = start();
};

inline void MemoryProfile::print(long frame, const bbl::Engine& engine, std::size_t scene_meshes,
                                 std::size_t gpu_meshes, std::size_t shared_geometries,
                                 std::size_t shared_geometry_bytes) const {
    std::size_t live_geometries = 0;
    std::size_t geometry_bytes = 0;
    for (const bbl::ModelGeometry& geometry : engine.geometries) {
        if (geometry.vertices.empty())
            continue;
        ++live_geometries;
        geometry_bytes += geometry.vertices.size() * sizeof(bbl::ModelVertex) +
                          geometry.indices.size() * sizeof(std::uint32_t);
        for (const auto* targets :
             {&geometry.morph_positions, &geometry.morph_normals, &geometry.morph_tangents}) {
            for (const std::vector<Vec3>& target : *targets) {
                geometry_bytes += target.size() * sizeof(Vec3);
            }
        }
    }
    constexpr double mb = 1024.0 * 1024.0;
    std::ostringstream line;
    line << std::fixed << std::setprecision(1) << "[mem][frame] engine=" << stream_
         << " frame=" << frame << " working_set_mb=" << bbl::pal::process_working_set_bytes() / mb
         << " mesh_records=" << engine.meshes.size() - engine.free_mesh_slots.size()
         << " scene_meshes=" << scene_meshes << " transform_node_records="
         << engine.transform_nodes.size() - engine.free_transform_node_slots.size()
         << " gc_nodes=" << bbl::js::managed_node_count()
         << " gc_allocations=" << bbl::js::gc::registry.total_allocations
         << " geometry_records=" << engine.geometries.size() - engine.free_geometry_slots.size()
         << " live_geometries=" << live_geometries << " geometry_mb=" << geometry_bytes / mb
         << " gpu_meshes=" << gpu_meshes << " shared_geometries=" << shared_geometries
         << " shared_geometry_mb=" << shared_geometry_bytes / mb << '\n';
    std::fputs(line.str().c_str(), stderr);
}

/**
 * Refuse a flag this backend does not implement rather than rendering
 * something else: a silent no-op would be measured as a backend delta.
 * `backend` is the caller's own label; the text names no other backend,
 * because which one implements a diagnostic is that backend's to state.
 */
inline void reject_unsupported_frame_options(const FrameOptions& options, const char* backend,
                                             bool supports_single_sample, bool supports_copy_task) {
    if (options.single_sample && !supports_single_sample) {
        throw std::runtime_error(std::string("BBLITE_MSAA is not supported by the ") + backend +
                                 " backend; run the single-sample diagnostic through a scene "
                                 "renderer that supports it.");
    }
    if (!options.copy_task_filter.empty() && !supports_copy_task) {
        throw std::runtime_error(std::string("BBLITE_COPY_TASK is not supported by the ") +
                                 backend +
                                 " backend; the geometry copy-task diagnostic runs through a "
                                 "scene renderer that supports it.");
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
        decoded = mantissa == 0 ? std::numeric_limits<float>::infinity()
                                : std::numeric_limits<float>::quiet_NaN();
    } else {
        decoded = std::ldexp(1.0f + static_cast<float>(mantissa) / 1024.0f,
                             static_cast<int>(exponent) - 15);
    }
    if (negative)
        decoded = -decoded;
    return static_cast<std::uint8_t>(std::lround(std::clamp(decoded, 0.0f, 1.0f) * 255.0f));
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

inline std::vector<std::uint8_t> convert_readback_rows(const std::uint8_t* mapped,
                                                       std::uint32_t width, std::uint32_t height,
                                                       std::uint32_t aligned_row_bytes,
                                                       ReadbackFormatClass format) {
    const std::uint32_t output_row_bytes = width * 4;
    std::vector<std::uint8_t> rgba(static_cast<std::size_t>(output_row_bytes) * height);
    for (std::uint32_t y = 0; y < height; ++y) {
        const std::uint8_t* source_row = mapped + static_cast<std::size_t>(y) * aligned_row_bytes;
        std::uint8_t* destination_row =
            rgba.data() + static_cast<std::size_t>(y) * output_row_bytes;
        if (format == ReadbackFormatClass::rgba16_float) {
            const auto* source_pixels = reinterpret_cast<const std::uint16_t*>(source_row);
            for (std::uint32_t x = 0; x < width; ++x) {
                for (std::uint32_t channel = 0; channel < 4; ++channel) {
                    destination_row[x * 4 + channel] = half_to_byte(source_pixels[x * 4 + channel]);
                }
            }
        } else if (format == ReadbackFormatClass::r16_float) {
            const auto* source_pixels = reinterpret_cast<const std::uint16_t*>(source_row);
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
                    std::swap(destination_row[x * 4], destination_row[x * 4 + 2]);
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
inline void write_readback_raw_rows(std::ostream& raw, const std::uint8_t* mapped,
                                    std::uint32_t height, std::uint32_t aligned_row_bytes,
                                    std::uint32_t source_row_bytes) {
    for (std::uint32_t y = 0; y < height; ++y) {
        raw.write(
            reinterpret_cast<const char*>(mapped + static_cast<std::size_t>(y) * aligned_row_bytes),
            source_row_bytes);
    }
}

} // namespace bbl::pal
