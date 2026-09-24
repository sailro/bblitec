// The 2D sprite and billboard families' backend-independent half: the
// Sprite2D pipeline plan, the per-frame layer and instance uploads, the
// renderer's update, and the billboard draw plan and upload gate.
#pragma once
#include <bblite/features/has_sprite_renderer.hpp>
#include <bblite/features/has_sprites.hpp>
#include "pal_gpu_surface.hpp"

namespace bbl::pal {

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

#if BBLITE_HAS_SPRITE_RENDERER
/**
 * `spriteRendererUpdate` up to its upload: run the renderer's own per-frame
 * hooks with the frame's delta, then sort its layer list in place
 * (`sort_sprite_renderer_layers`), before anything reads the list.
 *
 * A disposed renderer runs neither, which is the pin's own early return; the
 * hook list is copied because a hook may push another one, and upstream's
 * `for (const hook of rr._beforeUpdate)` iterates the array it entered with.
 */
inline void begin_sprite_renderer_update(Engine& engine, SpriteRendererHandle renderer,
                                         double delta_ms) {
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
#endif

} // namespace bbl::pal
