/**
 * The sprite frame-animation core, as native records and one stepper.
 *
 * `sprite/sprite-animation.ts` advances a set of frame ranges in lockstep:
 * each holds a range, a delay and an accumulator, and each update moves it by
 * at most one frame. Both reached scenes drive it from their own counted seek
 * loop, whose bound is a native call -- the pin computes it from a query
 * parameter through a plain-data helper, which this compiler emits as a real
 * C++ function -- so the loop is a loop natively and the manager is a record
 * the emitted scene carries rather than a value generation folds.
 *
 * The timing rule is a Babylon compatibility contract, not an implementation
 * detail: an EXACT delay does not step, each update advances at most one
 * frame, and the accumulator carries its remainder by `%`. Getting one of
 * those wrong shifts every animated sprite by a frame, which is why the
 * emitted stepper is gated below against the pin's own statements rather
 * than merely resembling them.
 */
import type { LoweredSource, LoweringContext } from "./context.js";
import { lowerPinnedFunction } from "./pinned-function-lowerer.js";
import type { PinnedBinding } from "./pinned-numeric-lowerer.js";

const animationModule = "src/sprite/sprite-animation.ts";

/**
 * `normalizeDelay` and `advanceSpriteAnimation`, lowered from their own
 * declarations.
 *
 * These two hold the timing rule the whole family turns on -- an EXACT delay
 * does not step, the accumulator keeps its remainder, one update advances at
 * most one frame -- and that rule is a Babylon compatibility contract rather
 * than an implementation detail. Lowering them from the pin's AST is what
 * makes the emitted arithmetic the pin's own: a transcription plus a gate
 * can only prove the PIN still says something, never that the emission does.
 *
 * The three target operations are the map's own: upstream reaches them
 * through a closure triple the family's adapter built, and this port reaches
 * them through a tagged handle, so the calls are bound by the text the body
 * reads them through.
 */
function loweredStepper(context: LoweringContext): string {
    const calls = new Map<string, (args: readonly string[]) => string>([
        [
            "animation.target.setFrame",
            (args) => `set_target_frame(engine, animation.target, ${args[0]})`,
        ],
        [
            "animation.target.remove",
            () => "remove_target(engine, animation.target)",
        ],
        [
            "animation.target.isAlive",
            () => "target_is_alive(engine, animation.target)",
        ],
        ["normalizeDelay", (args) => `normalize_delay(${args[0]})`],
        // The pin's finiteness guard, at the C++ spelling of the same
        // predicate. Both bodies ask it, so the map is shared.
        ["Number.isFinite", (args) => `std::isfinite(${args[0]})`],
        // `animation.onEnd?.()`: an animation here never carries one,
        // because the option that would set it refuses at generation. The
        // pin's optional call is therefore the no-op its own `?.` makes it
        // when the callback is absent -- bound rather than dropped, so the
        // day the option is lowered this is the one place that changes.
        ["animation.onEnd", () => "static_cast<void>(0)"],
    ]);
    const members = new Map<string, PinnedBinding>([
        ["animation.from", { cpp: "animation.from", type: "scalar" }],
        ["animation.to", { cpp: "animation.to", type: "scalar" }],
        ["animation.current", { cpp: "animation.current", type: "scalar" }],
        ["animation.loop", { cpp: "animation.loop", type: "bool" }],
        ["animation.delayMs", { cpp: "animation.delay_ms", type: "scalar" }],
        [
            "animation.accumulatedMs",
            { cpp: "animation.accumulated_ms", type: "scalar" },
        ],
        [
            "animation.animationStarted",
            { cpp: "animation.animation_started", type: "bool" },
        ],
        [
            "animation.removeWhenFinished",
            { cpp: "animation.remove_when_finished", type: "bool" },
        ],
    ]);
    const normalize = lowerPinnedFunction(
        context,
        animationModule,
        "normalizeDelay",
        [{ pinned: "delayMs", kind: "number", cpp: "delay_ms" }],
        {
            cppName: "normalize_delay",
            returns: "double",
            calls,
            // `Number.isFinite(delayMs) && delayMs > 1` is a test, not the
            // value-selecting `&&` the translator refuses by default: both
            // sides are predicates, so the C++ operator is the same answer.
            booleanAnd: true,
        },
    );
    const advance = lowerPinnedFunction(
        context,
        animationModule,
        "advanceSpriteAnimation",
        [
            {
                pinned: "animation",
                kind: "record",
                cpp: "animation",
                annotation: "SpriteFrameAnimation",
                cppType: "SpriteFrameAnimation",
                mutableRecord: true,
                binding: { cpp: "animation", type: "scalar" },
            },
            { pinned: "deltaMs", kind: "number", cpp: "delta_ms" },
        ],
        {
            cppName: "advance_sprite_animation",
            // The pin reaches its sprite through a closure the family's
            // adapter built; a free function is handed the engine that
            // owns it instead, which is what the three bound calls use.
            leadingParameters: ["Engine& engine"],
            returns: {
                type: "bool",
                value: (lowerer, expression) =>
                    expression ? lowerer.expression(expression) : "true",
            },
            // `animation.onEnd?.()` is the one call with no binding: the
            // callback refuses at generation, so a body that reached it
            // would fail here rather than lower to nothing.
            calls,
            memberBindings: members,
            // `!passedEnd` and `animation.loop` are tests, and
            // `direction > 0 ? ... : ...` selects between two of them.
            booleanOr: true,
        },
    );
    return `${normalize}\n\n${advance}`;
}

export class SpriteAnimationLowerer {
    public constructor(private readonly context: LoweringContext) {}

    /**
     * @param billboards Whether the scene reached the billboard family. The
     * target is a tagged handle over two families, and only the families a
     * scene actually built are linked -- so the arm for one it did not is
     * not emitted, exactly as the feature list decides everything else.
     */
    public lowerSpriteAnimation(billboards: boolean): LoweredSource {
        // A family the scene never built has no entry points to call, so
        // its arm is not emitted; the kind can never carry it either.
        const billboardArm = (
            reached: string,
            absent = "return;",
        ): string => (billboards ? `    ${reached}` : `    ${absent}`);

        return {
            modulePath: animationModule,
            symbolName: "updateSpriteAnimationManager",
            header: `#pragma once

// ${this.context.provenance(animationModule, "updateSpriteAnimationManager")}

#include <bblite/runtime.hpp>

namespace bbl::upstream {

SpriteAnimationManagerHandle create_sprite_animation_manager(Engine& engine);
void play_sprite_frame_animation(
    Engine& engine,
    SpriteAnimationManagerHandle manager,
    SpriteAnimationTarget target,
    double from,
    double to,
    bool loop,
    double delay_ms,
    bool remove_when_finished);
void update_sprite_animation_manager(
    Engine& engine,
    SpriteAnimationManagerHandle manager,
    double delta_ms);

} // namespace bbl::upstream
`,
            source: `// ${this.context.provenance(animationModule, "updateSpriteAnimationManager")}
#include <bblite/upstream/sprite_animation.hpp>
#include <bblite/upstream/sprite_layer.hpp>

#include <cmath>
#include <vector>

namespace bbl::upstream {
namespace {

/** The target's own three operations, which upstream carries as a closure
 *  triple built by whichever family created the sprite. */
void set_target_frame(
    Engine& engine,
    const SpriteAnimationTarget& target,
    double frame) {
    if (target.kind == SpriteAnimationTargetKind::sprite_2d) {
        set_sprite_2d_frame_id(engine, target.layer, target.sprite_id, frame);
        return;
    }
${billboardArm("set_billboard_sprite_frame(engine, target.billboard, frame);")}
}

void remove_target(Engine& engine, const SpriteAnimationTarget& target) {
    if (target.kind == SpriteAnimationTargetKind::sprite_2d) {
        remove_sprite_2d_id(engine, target.layer, target.sprite_id);
        return;
    }
${billboardArm("remove_billboard_sprite(engine, target.billboard);")}
}

bool target_is_alive(
    const Engine& engine,
    const SpriteAnimationTarget& target) {
    if (target.kind == SpriteAnimationTargetKind::sprite_2d) {
        return sprite_2d_id_alive(engine, target.layer, target.sprite_id);
    }
${billboardArm("return billboard_sprite_alive(engine, target.billboard);", "return true;")}
}

${loweredStepper(this.context)}

} // namespace

SpriteAnimationManagerHandle create_sprite_animation_manager(
    Engine& engine) {
    engine.sprite_animation_managers.push_back(
        SpriteAnimationManagerRecord{});
    return SpriteAnimationManagerHandle{static_cast<std::uint32_t>(
        engine.sprite_animation_managers.size() - 1)};
}

void play_sprite_frame_animation(
    Engine& engine,
    SpriteAnimationManagerHandle manager,
    SpriteAnimationTarget target,
    double from,
    double to,
    bool loop,
    double delay_ms,
    bool remove_when_finished) {
    // createSpriteFrameAnimation: the range truncates, the animation starts
    // at its first frame, and the target shows that frame before any update.
    SpriteFrameAnimation animation{};
    animation.target = target;
    animation.from = std::trunc(from);
    animation.to = std::trunc(to);
    animation.current = animation.from;
    animation.loop = loop;
    animation.delay_ms = normalize_delay(delay_ms);
    animation.accumulated_ms = 0.0;
    animation.animation_started = true;
    animation.remove_when_finished = remove_when_finished;
    set_target_frame(engine, target, animation.from);
    engine.sprite_animation_managers[manager.value].animations.push_back(
        animation);
}

void update_sprite_animation_manager(
    Engine& engine,
    SpriteAnimationManagerHandle manager,
    double delta_ms) {
    SpriteAnimationManagerRecord& record =
        engine.sprite_animation_managers[manager.value];
    // The pin takes its manager's fixedDeltaMs where one is set; the
    // option that would set it refuses at generation, so every step here
    // is the caller's own delta.
    const double step_ms = delta_ms;
    if (!std::isfinite(step_ms) || step_ms < 0.0) {
        return;
    }
    // The pin snapshots the list so a finishing animation can be removed
    // without corrupting iteration, and removes by identity rather than by
    // a possibly-stale index. Nothing reached adds or clears from a
    // callback -- onEnd refuses at generation -- so the same answer is one
    // pass in place over the list the record already owns.
    std::erase_if(
        record.animations,
        [&](SpriteFrameAnimation& animation) {
            return !advance_sprite_animation(engine, animation, step_ms);
        });
}

} // namespace bbl::upstream
`,
        };
    }
}
