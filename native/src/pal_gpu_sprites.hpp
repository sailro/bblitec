// The 2D sprite and billboard families' backend-independent half: the
// Sprite2D pipeline plan, the per-frame layer and instance uploads, the
// renderer's update, and the billboard draw plan and upload gate.
#pragma once
#include <bblite/features/has_sprite_renderer.hpp>
#include <bblite/features/has_sprites.hpp>

#include <bblite/runtime.hpp>
#include <bblite/upstream/render_capabilities.hpp>
#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <string>
#include "pal_record_sync.hpp"

namespace bbl::pal {

#if BBLITE_HAS_SPRITES
bool sprite_blend_equal(const SpriteBlendDescriptor& left, const SpriteBlendDescriptor& right);

/** Backend-neutral fixed/layout choices for one Sprite2D pipeline. */
struct SpriteLayerPipelinePlan {
    bool scroll = false;
    bool has_depth = false;
    bool depth_write = false;
    bool alpha_to_coverage = false;
    std::uint32_t instance_stride_bytes = 0;
};

SpriteLayerPipelinePlan sprite_layer_pipeline_plan(const Sprite2DLayerRecord& layer);

/**
 * A layer's program: the pin's module for its permutation, deployed whole
 * under this stem -- the stock program (0) or a custom one (its 1-based
 * index) -- with `<stem>.vert` and `<stem>.frag` both compiled from it.
 * `spriteProgramStem` (upstream-lower.ts) deploys the same names.
 */
std::string sprite_program_stem(std::uint32_t program, const SpriteLayerPipelinePlan& plan);

/** Fixed pipeline identity for layers targeting the same scene pass. */
bool sprite_scene_pipeline_compatible(const Sprite2DLayerRecord& left,
                                      const Sprite2DLayerRecord& right);
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
void refuse_disposed_sprite_render_texture_in_use(const Engine& engine);

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

SpriteDirtyRange resolve_sprite_dirty_range(const Sprite2DLayerRecord& layer, bool uploaded,
                                            std::uint64_t uploaded_version);

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
SpriteInstanceUpload resolve_sprite_instance_upload(Engine& engine, Sprite2DLayerRecord& layer,
                                                    bool uploaded, std::uint64_t uploaded_version);

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
void begin_sprite_renderer_update(Engine& engine, SpriteRendererHandle renderer, double delta_ms);
#endif

/**
 * Whether a standalone driver's pass list still mirrors
 * `engine.sprite_renderer_contexts()` one-to-one, in order. Both
 * backends' pass records carry the renderer handle, so one comparison
 * serves either list; a mismatch means a callback registered or disposed
 * a renderer and the passes must be rebuilt.
 */
template <typename SpritePassList>
inline bool sprite_passes_match_registered(const Engine& engine, const SpritePassList& passes) {
    std::size_t index = 0;
    for (const auto& renderer : engine.sprite_renderer_contexts()) {
        if (index == passes.size() || passes[index].renderer.value != renderer.value) {
            return false;
        }
        ++index;
    }
    return index == passes.size();
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

BillboardDrawPlan billboard_draw_plan(const BillboardSystemRecord& system);

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
bool billboard_needs_upload(const BillboardSystemRecord& system, const BillboardUploadStamp& stamp,
                            const std::array<float, 16>& view, [[maybe_unused]] Vec3d fo_offset);

void stamp_billboard_upload(BillboardUploadStamp& stamp, const BillboardSystemRecord& system,
                            const std::array<float, 16>& view, [[maybe_unused]] Vec3d fo_offset);
#endif

} // namespace bbl::pal
