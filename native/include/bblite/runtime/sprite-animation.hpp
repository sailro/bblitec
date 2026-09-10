#pragma once
// Included within namespace bbl by runtime.hpp.

enum class SpriteAnimationTargetKind : std::uint8_t {
    sprite_2d,
    billboard,
};

/**
 * The sprite a frame animation drives.
 *
 * Upstream this is a closure triple -- `setFrame`, `remove`, `isAlive` --
 * built by whichever family's adapter created it, which is how the animation
 * core stays ignorant of both. A closure is not a thing this port carries, so
 * the same decoupling is a tagged handle: the kind chooses the family and the
 * three operations dispatch on it in one place.
 */
struct SpriteAnimationTarget {
    SpriteAnimationTargetKind kind = SpriteAnimationTargetKind::sprite_2d;
    /** `sprite_2d`: the layer and the sprite's stable id within it. */
    Sprite2DLayerHandle layer{};
    std::uint32_t sprite_id = 0;
    /** `billboard`: the system and the sprite's stable id inside it. */
    BillboardSpriteHandle billboard{};
};

/** One frame-range animation, field for field as the pin declares it. */
struct SpriteFrameAnimation {
    SpriteAnimationTarget target{};
    double from = 0.0;
    double to = 0.0;
    double current = 0.0;
    bool loop = false;
    double delay_ms = 1.0;
    double accumulated_ms = 0.0;
    bool animation_started = true;
    bool remove_when_finished = false;
};

/**
 * A set of frame animations advanced in lockstep.
 *
 * The pin's `fixedDeltaMs` override is absent because its own option is:
 * `createSpriteAnimationManager` takes no options here, so every step is
 * the caller's own delta and a field for the override would have no writer.
 */
struct SpriteAnimationManagerRecord {
    std::vector<SpriteFrameAnimation> animations;
};

struct SpriteAnimationManagerHandle {
    std::uint32_t value = invalid_handle;
};
