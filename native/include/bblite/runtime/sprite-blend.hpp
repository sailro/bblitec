#pragma once
// Included within namespace bbl by runtime.hpp.

enum class SpriteBlendFactor {
    zero,
    one,
    src_alpha,
    one_minus_src_alpha,
    dst,
    dst_alpha,
};

struct SpriteBlendComponent {
    SpriteBlendFactor src = SpriteBlendFactor::one;
    SpriteBlendFactor dst = SpriteBlendFactor::zero;
};

/**
 * billboard-blend.ts `_depthMode`: which depth path a mode selects.
 * `transparent` blends without writing depth and is sorted far to near;
 * `cutout` discards below the alpha cutoff, writes depth, and draws with the
 * opaque meshes instead, so the GPU resolves overlap and no sort is needed.
 */
enum class BillboardDepthMode {
    transparent,
    cutout,
};

struct SpriteBlendDescriptor {
    // `_descriptor` absent upstream means no colour blend at all.
    bool enabled = true;
    // Only the billboard family declares one; the 2D descriptors leave it
    // at the transparent default, which is the path they all take.
    BillboardDepthMode depth_mode = BillboardDepthMode::transparent;
    SpriteBlendComponent color{};
    SpriteBlendComponent alpha{};
    // `_premultipliedOpacity`: per-layer opacity scales RGB as well as A.
    bool premultiplied_opacity = false;
    // `_particlePasses`: the exact Babylon.js particle blends, and the one
    // field only `particle-blend.ts` ever sets. Zero is every public
    // descriptor; one is Multiply, which draws the pin's own private
    // fragment; two is MultiplyAdd, which draws that pass and then a stock
    // Add pass over the same instances. The count rides the descriptor
    // because that is where upstream puts it -- the registrar forks on
    // `blendMode._particlePasses`, never on the numeric mode.
    int particle_passes = 0;
};

/** sprite-2d.ts `Sprite2DView`. Identity is a pixel-perfect HUD. */
struct Sprite2DView {
    Vec2 position_px{};
    float zoom = 1.0f;
    float rotation = 0.0f;
};

/** sprite-2d.ts `depth`: which render path owns this layer. */
enum class Sprite2DDepthMode {
    none,
    test,
    test_write,
};

/**
 * A Gaussian-splat cloud, as `loadSplat` leaves it.
 *
 * The four RGBA32F payloads and the centres are what
 * `upstream::build_splat_geometry` produced from the packaged row buffer;
 * the backends upload the payloads once and re-run the sort whenever the
 * view-depth transform drifts, which is `postSplatSortIfDirty`'s rule.
 *
 * The pin's own transform state rides here too: a splat mesh is a scene node
 * with position/rotation/scaling, and the world matrix multiplies into the
 * depth transform. No reached scene moves one, so the world stays identity
 * and the field exists to keep the depth kernel written the way the pin
 * writes it rather than folded away.
 */
