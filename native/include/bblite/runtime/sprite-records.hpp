#pragma once
// Included within namespace bbl by runtime.hpp.

struct Sprite2DLayerRecord {
    SpriteAtlasHandle atlas{};
    SpriteBlendDescriptor blend{};
    float opacity = 1.0f;
    bool visible = true;
    float order = 0.0f;
    Sprite2DDepthMode depth_mode = Sprite2DDepthMode::none;
    float layer_z = 0.5f;
    Sprite2DView view{};
    Vec2 pivot{0.5f, 0.5f};
    std::uint32_t count = 0;
    std::uint32_t capacity = 0;
    // 13 for pure 2D, 14 when the layer carries the depth slot.
    std::uint32_t instance_floats_per_sprite = 13;
    std::vector<float> instance_data;
    // The CPU-only shadow holding each sprite's true size regardless of
    // visibility, which is what makes hiding a free degenerate quad.
    std::vector<float> saved_size;
    // sprite-2d-uvscroll.ts: the first setSprite2DUvOffset widens the layout
    // by two floats per sprite and stashes the attribute the pipeline pushes.
    // A layer that never scrolls keeps the narrow layout and ships none of it.
    bool uv_scroll = false;
    // sprite-2d-handle.ts: a stable id per sprite over a moving index, so a
    // name a scene holds survives the swap a removal performs. Upstream
    // builds this lazily on the first `addSprite2D`; here it is a plain
    // member, because the map's own empty state already costs a layer that
    // never takes a handle nothing but its inline bytes.
    std::uint32_t next_sprite_id = 1;
    std::unordered_map<std::uint32_t, std::uint32_t> sprite_id_to_index;
    std::vector<std::uint32_t> sprite_index_to_id;
    // sprite-custom-shader.ts: a layer built with a descriptor draws the
    // composed program and binds the fx block beside its layer block. The
    // pin reaches both through a hook that is null until a descriptor
    // exists, so the flag is the same "is there one" question.
    std::uint32_t custom_shader = 0;
    // custom-shader-core.ts: the descriptor's extra textures, in the order
    // they bind after the atlas. Empty unless a custom shader named any.
    std::vector<PixelsTexture> custom_textures;
    // Shader identifiers for custom_textures, in the same order. SDL's
    // compacted shader sidecar uses these to bind only the resources kept.
    std::vector<std::string> custom_texture_names;
    // The `fx.params` vec4, zero until setSprite2DShaderParams writes it.
    Vec4 shader_params{};
    // render/alpha-to-coverage.ts: enabled only on a multisampled,
    // depth-writing scene-hosted pipeline.
    bool alpha_to_coverage = false;
    // Instance mutations accumulate one half-open dirty sprite range. The
    // active backend clears it after the matching version reaches the GPU;
    // a buffer replacement widens it back to the full active range.
    std::uint32_t dirty_sprite_begin = invalid_handle;
    std::uint32_t dirty_sprite_end = 0;
    std::uint64_t version = 0;
    // Version of the range most recently consumed by a PAL pass. A second
    // pass whose upload stamp predates it must refresh the active prefix;
    // a later count-only version bump needs no instance transfer.
    std::uint64_t dirty_sprite_reset_version = 0;
    // Fixed pipeline state moves independently from instance bytes. Runtime
    // UV-scroll widening and alpha-to-coverage changes bump this stamp so an
    // already-created PAL pass can rebuild/reselect the compatible pipeline.
    std::uint64_t pipeline_version = 0;
    // sprite-2d-y-sort.ts `layer._ySortState`: the optional GPU-order
    // permutation and its packed staging buffer. Null until a scene calls
    // `enableSprite2DYSort`, and deliberately OPAQUE here -- upstream keeps
    // the state's fields private to its own optional module and lets the
    // always-loaded mutation, upload and picker paths know only the hook
    // contract below, so the layout lives in the generated Y-sort module
    // and nothing that never enables it links a line of it.
    std::shared_ptr<void> y_sort;
};

/**
 * The rows one instance upload copies, already in the order the GPU reads.
 *
 * `data` is the base of the buffer the copy reads from -- the layer's own
 * canonical instance floats, or the Y-sort module's packed staging buffer --
 * and the half-open `[begin, end)` are slots in THAT buffer, so the two
 * backends' write calls differ in nothing but the API they call.
 */
struct SpriteInstanceUpload {
    const float* data = nullptr;
    std::uint32_t begin = 0;
    std::uint32_t end = 0;
};

/**
 * sprite-2d-y-sort-hook.ts: the one lazily-registered null hook the optional
 * Y-sort module installs the first time a layer enables it.
 *
 * Upstream's mutation, upload and picking modules reach the extension only
 * through this record, which is why enabling is the opt-in trigger rather
 * than any second detector: an engine whose scene never called
 * `enableSprite2DYSort` finds every field empty and takes the canonical
 * logical-order path, exactly as the pin's `_getSprite2DYSortHook()?.` does.
 */
struct Sprite2DYSortHook {
    /** `uploadSorted`'s staging half: pack the rows this copy uploads. */
    std::function<SpriteInstanceUpload(
        Sprite2DLayerRecord&,
        std::uint32_t,
        std::uint32_t)>
        stage;
    /** `getDrawOrder`: draw slot -> logical slot, or null when disabled. */
    std::function<const std::uint32_t*(const Sprite2DLayerRecord&)>
        draw_order;
};

/**
 * A world-space billboard system: an atlas, a packed instance buffer, and
 * the per-system uniforms. Unlike a 2D layer it carries no view of its own —
 * it draws inside the scene's pass against the scene camera and depth
 * buffer, which is what makes it occlude and be occluded by geometry.
 */
enum class BillboardOrientation {
    facing,
    axis_locked,
};

struct BillboardSystemRecord {
    SpriteAtlasHandle atlas{};
    BillboardOrientation orientation = BillboardOrientation::facing;
    BillboardDepthMode depth_mode = BillboardDepthMode::transparent;
    // setAlphaToCoverage: immutable pipeline state, so it is read when the
    // pass is built rather than per frame.
    bool alpha_to_coverage = false;
    SpriteBlendDescriptor blend{};
    float opacity = 1.0f;
    bool visible = true;
    // Zero for a facing system: the facing basis reads the camera instead.
    Vec3 axis{};
    float alpha_cutoff = 0.0f;
    std::uint32_t count = 0;
    // Incremented whenever the active packed instance rows change. Count is
    // not a sufficient upload stamp: a dynamic system may clear and refill
    // the same number of sprites with different positions or atlas frames.
    std::uint64_t instance_version = 0;
    std::uint32_t capacity = 0;
    std::uint32_t instance_floats_per_sprite = 16;
    std::vector<float> instance_data;
    // billboard-sprite-handle.ts: stable ids survive packed-index removal.
    std::uint32_t next_handle_id = 1u;
    std::unordered_map<std::uint32_t, std::uint32_t> handle_id_to_index;
    std::vector<std::uint32_t> index_to_handle_id;
    // The mode-4 second pass's blend; see BillboardSystemOptions.
    SpriteBlendDescriptor add_pass_blend;
    // billboard-custom-shader.ts: the same opt-in the 2D layer carries --
    // a system built with a descriptor draws the composed program and
    // binds the fx block beside its system block.
    std::uint32_t custom_shader = 0;
    // custom-shader-core.ts: the descriptor's extra textures, in the order
    // they bind after the atlas. Empty unless a custom shader named any.
    std::vector<PixelsTexture> custom_textures;
    std::vector<std::string> custom_texture_names;
    // The `fx.params` vec4, zero until setBillboardShaderParams writes it.
    Vec4 shader_params{};
};

struct SpriteRendererRecord {
    std::vector<Sprite2DLayerHandle> layers;
    Color4 clear_value{0.0f, 0.0f, 0.0f, 1.0f};
    bool clear = true;
    // `disposeSpriteRenderer` is idempotent upstream and every entry point
    // it owns checks this first, so the flag is the pin's own state rather
    // than a native lifetime device.
    bool disposed = false;
    // Bumped whenever the layer list itself changes (add / remove / dispose).
    // Each backend builds one `SpriteLayerGpu` per layer, indexed positionally
    // against this vector, so a changed list has to rebuild that pass -- the
    // same version-compare shape `render_topology_version` already gives a
    // scene whose mesh set moved.
    std::uint64_t layers_version = 0;
    bool has_target = false;
    SpriteRenderTextureHandle target{};
    // sprite-renderer.ts `_beforeUpdate`: the hooks `spriteRendererUpdate`
    // runs, with the frame's delta, before it asserts its layers and
    // uploads them. Both the pure-2D node-particle bridges and application
    // code push onto this list, so it is the renderer's own per-frame step
    // rather than the scene's. The delta is the browser's double: the
    // particle bridge divides it by the pin's frame period.
    std::vector<std::function<void(double)>> before_update;
    // The list the frame is iterating. A hook may push another, and
    // upstream iterates the array it entered with, so the run reads a copy
    // -- kept here rather than made fresh each frame, which reuses the
    // capacity after the first one.
    std::vector<std::function<void(double)>> before_update_running;
};

/**
 * A texture an effect samples, under the binding name it was set by.
 *
 * `setEffectTexture` stores the handle on the slot the name owns
 * (`effect-renderer.ts` `findTextureSlot`), so the name travels here for the
 * same reason it does for a node material: which binding a name lands on is
 * the descriptor's answer, and the two are joined where the pin joins them.
 * The reached slice binds a `createSolidTexture2D` 1x1 texel, which is why
 * the slot holds a colour rather than image bytes.
 */
