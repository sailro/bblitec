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
import ts from "typescript";
import type { LoweredSource, LoweringContext } from "./context.js";

const animationModule = "src/sprite/sprite-animation.ts";

/**
 * The statements this port transcribes, asserted against the pin's own.
 *
 * Each entry is a fragment of `advanceSpriteAnimation`'s source: a pin that
 * moves one fails generation naming it, rather than leaving a stepper that
 * merely looks right. The fragments are the load-bearing lines -- the
 * accumulate, the exact-delay early-out, the remainder, the direction, the
 * end test and the two ways an animation can end.
 */
const ADVANCE_CONTRACT: readonly string[] = [
    "animation.accumulatedMs += deltaMs;",
    "if (animation.accumulatedMs <= animation.delayMs) {",
    "animation.accumulatedMs = animation.accumulatedMs % animation.delayMs;",
    "const direction = animation.from > animation.to ? -1 : 1;",
    "const next = animation.current + direction;",
    "const passedEnd = direction > 0 ? next > animation.to : next < animation.to;",
    "animation.current = animation.from;",
    "animation.current = animation.to;",
    "animation.animationStarted = false;",
];

/** `updateSpriteAnimationManager`'s own two rules, likewise. */
const UPDATE_CONTRACT: readonly string[] = [
    "const stepMs = manager.fixedDeltaMs > 0 ? manager.fixedDeltaMs : deltaMs;",
    "if (!Number.isFinite(stepMs) || stepMs < 0) {",
];

/** `normalizeDelay`'s floor, which is what keeps a zero delay from dividing. */
const NORMALIZE_CONTRACT =
    "return Number.isFinite(delayMs) && delayMs > 1 ? delayMs : 1;";

function assertPinnedStatements(
    context: LoweringContext,
    symbolName: string,
    fragments: readonly string[],
): void {
    const { declaration } = context.functionDeclaration(
        animationModule,
        symbolName,
    );
    const source = declaration.getText().replace(/\s+/g, " ");
    for (const fragment of fragments) {
        if (!source.includes(fragment.replace(/\s+/g, " "))) {
            context.contractError(
                declaration,
                `Expected ${symbolName} to carry '${fragment}'. The ` +
                    "emitted stepper is a transcription of these statements, " +
                    "so a pin that moved one moves the frames every animated " +
                    "sprite lands on.",
            );
        }
    }
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
        assertPinnedStatements(
            this.context,
            "advanceSpriteAnimation",
            ADVANCE_CONTRACT,
        );
        assertPinnedStatements(
            this.context,
            "updateSpriteAnimationManager",
            UPDATE_CONTRACT,
        );
        assertPinnedStatements(this.context, "normalizeDelay", [
            NORMALIZE_CONTRACT,
        ]);
        // `createSpriteFrameAnimation` truncates its range and shows the
        // first frame at once; both are what a caller observes before any
        // update runs.
        const { declaration: create } = this.context.functionDeclaration(
            animationModule,
            "createSpriteFrameAnimation",
        );
        if (
            !this.context.hasNode(
                create,
                (node) =>
                    ts.isCallExpression(node) &&
                    node.getText().includes("target.setFrame(fromFrame)"),
            )
        ) {
            this.context.contractError(
                create,
                "Expected createSpriteFrameAnimation to show its first " +
                    "frame before any update runs.",
            );
        }

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

namespace bbl::upstream {
namespace {

/** normalizeDelay: a delay at or under one millisecond floors to one, which
 *  is what keeps the remainder below from dividing by zero. */
double normalize_delay(double delay_ms) {
    return std::isfinite(delay_ms) && delay_ms > 1.0 ? delay_ms : 1.0;
}

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

/**
 * advanceSpriteAnimation, statement for statement.
 *
 * The three rules that decide which frame a sprite lands on are the pin's
 * own, and the gate in the lowerer asserts each one is still written there:
 * an EXACT delay does not step, the accumulator keeps its remainder, and one
 * update advances at most one frame.
 */
bool advance_sprite_animation(
    Engine& engine,
    SpriteFrameAnimation& animation,
    double delta_ms) {
    if (!target_is_alive(engine, animation.target)) {
        animation.animation_started = false;
        return false;
    }
    if (!animation.animation_started) {
        return true;
    }

    animation.accumulated_ms += delta_ms;
    if (animation.accumulated_ms <= animation.delay_ms) {
        return true;
    }

    animation.accumulated_ms =
        std::fmod(animation.accumulated_ms, animation.delay_ms);
    const double direction = animation.from > animation.to ? -1.0 : 1.0;
    const double next = animation.current + direction;
    const bool passed_end =
        direction > 0.0 ? next > animation.to : next < animation.to;
    if (!passed_end) {
        animation.current = next;
        set_target_frame(engine, animation.target, next);
        return true;
    }

    if (animation.loop) {
        animation.current = animation.from;
        set_target_frame(engine, animation.target, animation.from);
        return true;
    }

    animation.current = animation.to;
    set_target_frame(engine, animation.target, animation.to);
    animation.animation_started = false;
    // The pin's onEnd callback is unreached and refuses at generation.
    if (animation.remove_when_finished) {
        remove_target(engine, animation.target);
    }
    return false;
}

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
    const double step_ms =
        record.fixed_delta_ms > 0.0 ? record.fixed_delta_ms : delta_ms;
    if (!std::isfinite(step_ms) || step_ms < 0.0) {
        return;
    }
    // The pin snapshots the list so a finishing animation can be removed
    // without corrupting iteration, and removes by identity rather than by
    // a possibly-stale index. Nothing reached adds or clears from a
    // callback -- onEnd refuses at generation -- so the same answer is one
    // pass that keeps what survived.
    std::vector<SpriteFrameAnimation> surviving;
    surviving.reserve(record.animations.size());
    for (SpriteFrameAnimation& animation : record.animations) {
        if (advance_sprite_animation(engine, animation, step_ms)) {
            surviving.push_back(animation);
        }
    }
    record.animations = std::move(surviving);
}

} // namespace bbl::upstream
`,
        };
    }
}
