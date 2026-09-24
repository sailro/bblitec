// Where a scene draws: the surface panes auxiliary canvases share, the
// scene's extent and camera viewport, its active camera, and the
// floating-origin offset every eye-relative consumer subtracts.
#pragma once
#include <bblite/features/has_pbr_renderer.hpp>
#include <bblite/features/has_ui.hpp>
#include "pal_gpu_textures.hpp"

namespace bbl::pal {

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

/**
 * Final viewport/scissor of a scene's own pass: the pass camera's
 * `_applyCameraViewport` rectangle (`upstream::pass_camera_viewport`)
 * composed into the scene's surface pane. A camera-less pass, like one whose
 * camera has no viewport, keeps the whole pane.
 */
#if BBLITE_HAS_PBR_RENDERER
inline std::optional<PixelViewport> scene_camera_viewport(const Engine& engine, const Scene& scene,
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

} // namespace bbl::pal
