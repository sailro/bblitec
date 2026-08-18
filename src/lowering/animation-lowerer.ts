import ts from "typescript";
import { LoweredSource, LoweringContext } from "./context.js";

export class AnimationLowerer {
    public constructor(private readonly context: LoweringContext) {}

    public lowerPropertyAnimation(): LoweredSource {
        const propertyModule = "src/animation/property-animation.ts";
        const managerModule = "src/animation/animation-manager.ts";
        const groupModule = "src/animation/animation-group.ts";
        const evaluateModule = "src/animation/evaluate.ts";
        this.context.functionDeclaration(
            propertyModule,
            "createPropertyAnimationClip",
        );
        this.context.functionDeclaration(
            propertyModule,
            "createPropertyAnimationGroup",
        );
        this.context.functionDeclaration(
            managerModule,
            "createAnimationManager",
        );
        this.context.functionDeclaration(
            managerModule,
            "startAnimationManager",
        );
        const { declaration: evaluateSampler } =
            this.context.functionDeclaration(
                evaluateModule,
                "evaluateSampler",
            );
        if (
            !this.context.hasNode(
                evaluateSampler,
                (node) =>
                    ts.isIdentifier(node) &&
                    node.text === "INTERP_STEP",
            )
        ) {
            this.context.contractError(
                evaluateSampler,
                "Expected STEP interpolation handling.",
            );
        }
        if (
            !this.context.hasCall(
                evaluateSampler,
                "quatSlerp",
            )
        ) {
            this.context.contractError(
                evaluateSampler,
                "Expected quaternion slerp interpolation.",
            );
        }
        // The STEP tie-break, paired with the emitted `evaluate_track`
        // STEP branch (`time >= track.keys[right].time ? right : left`):
        // a query landing exactly on a key time takes the LATER key's
        // value, so the `>=` comparison direction is pinned rather than
        // trusted. The shape is asserted whole because every part of it
        // is structural — there is no tunable constant to flow.
        const stepSources = this.context
            .findNodes(
                evaluateSampler,
                (node): node is ts.VariableDeclaration =>
                    ts.isVariableDeclaration(node),
            )
            .filter(
                (candidate) =>
                    ts.isIdentifier(candidate.name) &&
                    candidate.name.text === "srcOff" &&
                    candidate.initializer !== undefined &&
                    ts.isBinaryExpression(
                        this.context.unwrapExpression(
                            candidate.initializer,
                        ),
                    ),
            );
        if (stepSources.length !== 1) {
            this.context.contractError(
                evaluateSampler,
                "Expected one STEP source-offset computation.",
            );
        }
        this.context.assertExpressionShape(
            stepSources[0]!.initializer!,
            "(t >= t1 ? idx + 1 : idx) * stride",
            "STEP tie-break",
        );
        // The near-parallel slerp threshold feeds the emitted
        // `slerp_quaternion` guard (`if (dot > ...)`) directly, so a pin
        // retune changes the generated literal — a deliberate byte-gate
        // signal — instead of passing behind a presence check. The
        // structural filter (a `dot > <literal>` comparison) also pins
        // the comparison direction. The `std::clamp(dot, -1.0f, 1.0f)`
        // ahead of the emitted acos has no pinned counterpart: it is our
        // defensive guard, unreachable while dot <= this threshold.
        const { file: evaluateFile, declaration: quatSlerp } =
            this.context.functionDeclaration(
                evaluateModule,
                "quatSlerp",
            );
        const parallelThresholds = this.context
            .findNodes(
                quatSlerp,
                (node): node is ts.BinaryExpression =>
                    ts.isBinaryExpression(node),
            )
            .filter(
                (expression) =>
                    expression.operatorToken.kind ===
                        ts.SyntaxKind.GreaterThanToken &&
                    ts.isIdentifier(expression.left) &&
                    expression.left.text === "dot" &&
                    ts.isNumericLiteral(expression.right),
            );
        if (parallelThresholds.length !== 1) {
            this.context.contractError(
                quatSlerp,
                "Expected one near-parallel slerp threshold.",
            );
        }
        const slerpParallelThreshold =
            this.context.numericValue(
                parallelThresholds[0]!.right,
                evaluateFile,
            );
        // The playback tick the emitted `tick_group` transcribes lives on
        // the controller `createPointerAnimationGroup` builds. Everything
        // load-bearing in it is pinned here: the ms-per-second divisor
        // flows into the emitted advance (as its reciprocal — the
        // existing emitted form multiplies), and the loop-wrap
        // arithmetic, its negative-wrap correction, and the play-range
        // clamp are shape-asserted against the exact emitted lines.
        const { file: propertyFile, declaration: pointerGroup } =
            this.context.functionDeclaration(
                propertyModule,
                "createPointerAnimationGroup",
            );
        const tickExpressions = this.context.findNodes(
            pointerGroup,
            (node): node is ts.BinaryExpression =>
                ts.isBinaryExpression(node),
        );
        const timeAssignment = (
            operator: ts.SyntaxKind,
            select: (right: ts.Expression) => boolean,
            label: string,
        ): ts.BinaryExpression => {
            const matches = tickExpressions.filter(
                (expression) =>
                    expression.operatorToken.kind ===
                        operator &&
                    this.context
                        .propertyPath(expression.left)
                        ?.join(".") === "ctrl.time" &&
                    select(
                        this.context.unwrapExpression(
                            expression.right,
                        ),
                    ),
            );
            if (matches.length !== 1) {
                this.context.contractError(
                    pointerGroup,
                    `Expected one ${label}.`,
                );
            }
            return matches[0]!;
        };
        // Advance: `ctrl.time += (deltaMs / 1000) * ctrl.speedRatio`.
        // Structural checks rather than a full shape assert, so the
        // divisor is free to flow into the emission.
        const advance = timeAssignment(
            ts.SyntaxKind.PlusEqualsToken,
            (right) => ts.isBinaryExpression(right),
            "playback advance",
        );
        const advanceProduct = this.context.unwrapExpression(
            advance.right,
        );
        if (
            !ts.isBinaryExpression(advanceProduct) ||
            advanceProduct.operatorToken.kind !==
                ts.SyntaxKind.AsteriskToken ||
            this.context
                .propertyPath(advanceProduct.right)
                ?.join(".") !== "ctrl.speedRatio"
        ) {
            this.context.contractError(
                advance,
                "Expected the playback advance to scale by the speed ratio.",
            );
        }
        const advanceRate = this.context.unwrapExpression(
            advanceProduct.left,
        );
        if (
            !ts.isBinaryExpression(advanceRate) ||
            advanceRate.operatorToken.kind !==
                ts.SyntaxKind.SlashToken ||
            !ts.isIdentifier(advanceRate.left) ||
            advanceRate.left.text !== "deltaMs"
        ) {
            this.context.contractError(
                advance,
                "Expected the playback advance to divide the frame delta.",
            );
        }
        const msPerSecond = this.context.numericValue(
            advanceRate.right,
            propertyFile,
        );
        // The loop wrap and its negative-wrap correction, paired with the
        // emitted `if (group->loop)` branch (`std::fmod` mirrors the
        // pinned `%`, whose result carries the dividend's sign — the
        // reason the correction exists).
        const loopWrap = timeAssignment(
            ts.SyntaxKind.EqualsToken,
            (right) => ts.isBinaryExpression(right),
            "loop wrap",
        );
        this.context.assertExpressionShape(
            loopWrap.right,
            "fromTime + ((ctrl.time - fromTime) % duration)",
            "Animation loop wrap",
        );
        const wrapCorrection = timeAssignment(
            ts.SyntaxKind.PlusEqualsToken,
            (right) => ts.isIdentifier(right),
            "wrap correction",
        );
        this.context.assertExpressionShape(
            wrapCorrection,
            "ctrl.time += duration",
            "Animation wrap correction",
        );
        const wrapGuards = tickExpressions.filter(
            (expression) =>
                expression.operatorToken.kind ===
                    ts.SyntaxKind.LessThanToken &&
                this.context
                    .propertyPath(expression.left)
                    ?.join(".") === "ctrl.time",
        );
        if (wrapGuards.length !== 1) {
            this.context.contractError(
                pointerGroup,
                "Expected one wrap-correction guard.",
            );
        }
        this.context.assertExpressionShape(
            wrapGuards[0]!,
            "ctrl.time < fromTime",
            "Animation wrap-correction guard",
        );
        // The play-range clamp, paired with the emitted non-loop branch's
        // `std::clamp(current_time, from_time, to_time)` (max against the
        // lower bound, min against the upper) and reused by the emitted
        // seeker in `start_animation_manager`.
        const rangeClamp = timeAssignment(
            ts.SyntaxKind.EqualsToken,
            (right) => ts.isCallExpression(right),
            "play-range clamp",
        );
        this.context.assertExpressionShape(
            rangeClamp.right,
            "Math.min(Math.max(ctrl.time, fromTime), toTime)",
            "Animation play-range clamp",
        );
        // The degenerate-range guard, paired with the emitted
        // `if (duration <= 0.0f) return;`. The pinned Math.max(0, ...)
        // never changes the guarded comparison's outcome, so the
        // emission carries the bare difference.
        this.context.assertExpressionShape(
            this.context.variableInitializer(
                pointerGroup,
                "duration",
            ),
            "Math.max(0, toTime - fromTime)",
            "Animation tick duration",
        );
        const durationGuards = tickExpressions.filter(
            (expression) =>
                expression.operatorToken.kind ===
                    ts.SyntaxKind.LessThanEqualsToken &&
                ts.isIdentifier(expression.left) &&
                expression.left.text === "duration",
        );
        if (durationGuards.length !== 1) {
            this.context.contractError(
                pointerGroup,
                "Expected one degenerate-range guard.",
            );
        }
        this.context.assertExpressionShape(
            durationGuards[0]!,
            "duration <= 0",
            "Animation degenerate-range guard",
        );
        // The seek conversion, paired with the emitted `go_to_frame`
        // (`frame / group->clip.frame_rate`). The pinned
        // `|| DEFAULT_FRAME_RATE` fallback is dead in the generated
        // runtime: `create_property_animation_clip` throws on
        // non-positive frame rates, so the clip's rate is always usable.
        const { declaration: goToFrame } =
            this.context.functionDeclaration(
                groupModule,
                "goToFrame",
            );
        const seekAssignments = this.context
            .findNodes(
                goToFrame,
                (node): node is ts.BinaryExpression =>
                    ts.isBinaryExpression(node),
            )
            .filter(
                (expression) =>
                    expression.operatorToken.kind ===
                        ts.SyntaxKind.EqualsToken &&
                    this.context
                        .propertyPath(expression.left)
                        ?.join(".") === "group.currentTime" &&
                    ts.isBinaryExpression(
                        this.context.unwrapExpression(
                            expression.right,
                        ),
                    ),
            );
        if (seekAssignments.length !== 1) {
            this.context.contractError(
                goToFrame,
                "Expected one frame-to-time seek conversion.",
            );
        }
        this.context.assertExpressionShape(
            seekAssignments[0]!.right,
            "frame / (group.frameRate || DEFAULT_FRAME_RATE)",
            "Animation seek conversion",
        );

        return {
            modulePath: propertyModule,
            symbolName:
                "createAnimationManager,createPropertyAnimationClip,createPropertyAnimationGroup,startAnimationManager,goToFrame",
            header: "",
            source: `// ${this.context.provenance(
                propertyModule,
                "property animation manager, clips, groups, interpolation, and seeking",
            )}
#include <bblite/runtime.hpp>

#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <utility>

namespace bbl {
namespace {

std::array<float, 4> normalized_quaternion(
    std::array<float, 4> value) {
    const float length = std::sqrt(
        value[0] * value[0] +
        value[1] * value[1] +
        value[2] * value[2] +
        value[3] * value[3]);
    if (length <= 0.0f) {
        return {0.0f, 0.0f, 0.0f, 1.0f};
    }
    for (float& component : value) component /= length;
    return value;
}

std::array<float, 4> slerp_quaternion(
    std::array<float, 4> left,
    std::array<float, 4> right,
    float amount) {
    float dot =
        left[0] * right[0] +
        left[1] * right[1] +
        left[2] * right[2] +
        left[3] * right[3];
    if (dot < 0.0f) {
        for (float& component : right) component = -component;
        dot = -dot;
    }
    if (dot > ${this.context.floatLiteral(slerpParallelThreshold)}) {
        std::array<float, 4> result{};
        for (std::size_t index = 0; index < result.size(); ++index) {
            result[index] =
                left[index] +
                (right[index] - left[index]) * amount;
        }
        return normalized_quaternion(result);
    }
    dot = std::clamp(dot, -1.0f, 1.0f);
    const float theta = std::acos(dot);
    const float sin_theta = std::sin(theta);
    const float left_weight =
        std::sin((1.0f - amount) * theta) / sin_theta;
    const float right_weight =
        std::sin(amount * theta) / sin_theta;
    std::array<float, 4> result{};
    for (std::size_t index = 0; index < result.size(); ++index) {
        result[index] =
            left[index] * left_weight +
            right[index] * right_weight;
    }
    return result;
}

std::array<float, 4> evaluate_track(
    const PropertyAnimationTrack& track,
    float time) {
    if (track.keys.empty()) {
        throw std::runtime_error(
            "Property animation track has no keys.");
    }
    if (
        track.keys.size() == 1 ||
        time <= track.keys.front().time) {
        return track.keys.front().value;
    }
    if (time >= track.keys.back().time) {
        return track.keys.back().value;
    }
    std::size_t right = 1;
    while (
        right < track.keys.size() &&
        track.keys[right].time < time) {
        ++right;
    }
    const std::size_t left = right - 1;
    if (
        track.interpolation ==
        PropertyAnimationInterpolation::step) {
        return time >= track.keys[right].time
            ? track.keys[right].value
            : track.keys[left].value;
    }
    const float span =
        track.keys[right].time -
        track.keys[left].time;
    const float amount =
        span > 0.0f
            ? (time - track.keys[left].time) / span
            : 0.0f;
    if (
        track.path ==
        PropertyAnimationPath::rotation_quaternion) {
        return slerp_quaternion(
            track.keys[left].value,
            track.keys[right].value,
            amount);
    }
    std::array<float, 4> result{};
    for (std::size_t index = 0; index < result.size(); ++index) {
        result[index] =
            track.keys[left].value[index] +
            (
                track.keys[right].value[index] -
                track.keys[left].value[index]) *
                amount;
    }
    return result;
}

void apply_group(
    Engine& engine,
    const PropertyAnimationGroup& group) {
    if (!group || group->target.value >= engine.meshes.size()) {
        throw std::runtime_error(
            "Property animation group has an invalid mesh target.");
    }
    MeshRecord& mesh = engine.meshes[group->target.value];
    for (const PropertyAnimationTrack& track :
         group->clip.tracks) {
        const std::array<float, 4> value =
            evaluate_track(track, group->current_time);
        switch (track.path) {
            case PropertyAnimationPath::position:
                mesh.position = Vec3{
                    value[0], value[1], value[2]};
                break;
            case PropertyAnimationPath::position_x:
                mesh.position.x = value[0];
                break;
            case PropertyAnimationPath::scaling:
                mesh.scaling = Vec3{
                    value[0], value[1], value[2]};
                break;
            case PropertyAnimationPath::rotation_quaternion:
                mesh.rotation_quaternion = Vec4{
                    value[0], value[1], value[2], value[3]};
                mesh.has_rotation_quaternion = true;
                break;
        }
    }
    ++mesh.transform_version;
}

void tick_group(
    Engine& engine,
    const PropertyAnimationGroup& group,
    float delta_ms) {
    if (!group || !group->playing) return;
    group->current_time +=
        delta_ms * ${this.context.floatLiteral(1 / msPerSecond)} * group->speed_ratio;
    const float duration =
        group->to_time - group->from_time;
    if (duration <= 0.0f) return;
    if (group->loop) {
        group->current_time =
            group->from_time +
            std::fmod(
                group->current_time - group->from_time,
                duration);
        if (group->current_time < group->from_time) {
            group->current_time += duration;
        }
    } else {
        group->current_time = std::clamp(
            group->current_time,
            group->from_time,
            group->to_time);
    }
    apply_group(engine, group);
}

} // namespace

PropertyAnimationManager create_animation_manager() {
    return std::make_shared<PropertyAnimationManagerRecord>();
}

PropertyAnimationClip create_property_animation_clip(
    std::string name,
    std::vector<PropertyAnimationTrack> tracks,
    float frame_rate) {
    if (tracks.empty()) {
        throw std::runtime_error(
            "createPropertyAnimationClip requires at least one track.");
    }
    if (!(frame_rate > 0.0f)) {
        throw std::runtime_error(
            "Property animation frame rate must be positive.");
    }
    PropertyAnimationClip clip;
    clip.name = std::move(name);
    clip.tracks = std::move(tracks);
    clip.frame_rate = frame_rate;
    for (const PropertyAnimationTrack& track : clip.tracks) {
        if (track.keys.empty()) {
            throw std::runtime_error(
                "Property animation track requires at least one key.");
        }
        clip.duration = std::max(
            clip.duration,
            track.keys.back().time);
    }
    return clip;
}

PropertyAnimationGroup create_property_animation_group(
    PropertyAnimationManager manager,
    MeshHandle target,
    PropertyAnimationClip clip,
    PropertyAnimationGroupOptions options) {
    if (!manager) {
        throw std::runtime_error(
            "Property animation manager is null.");
    }
    if (!(options.to_time > options.from_time)) {
        throw std::runtime_error(
            "Animation play range must have toTime greater than fromTime.");
    }
    auto group =
        std::make_shared<PropertyAnimationGroupRecord>();
    group->target = target;
    group->clip = std::move(clip);
    group->from_time = options.from_time;
    group->to_time = options.to_time;
    group->current_time = options.from_time;
    group->speed_ratio = options.speed_ratio;
    group->loop = options.loop;
    manager->groups.push_back(group);
    return group;
}

void start_animation_manager(
    PropertyAnimationManager manager,
    Scene& scene) {
    if (!manager || !scene.engine) {
        throw std::runtime_error(
            "Animation manager requires a scene engine.");
    }
    if (manager->started) return;
    manager->started = true;
    Engine* engine = scene.engine;
    scene.before_render.push_back(
        [manager, engine](float delta_ms) {
            for (const PropertyAnimationGroup& group :
                 manager->groups) {
                tick_group(*engine, group, delta_ms);
            }
        });
    scene.animation_seekers.push_back(
        [manager, engine](float time) {
            for (const PropertyAnimationGroup& group :
                 manager->groups) {
                if (!group) continue;
                group->current_time = std::clamp(
                    time,
                    group->from_time,
                    group->to_time);
                group->playing = false;
                apply_group(*engine, group);
            }
        });
}

void go_to_frame(
    PropertyAnimationGroup group,
    Engine& engine,
    float frame) {
    if (!group) {
        throw std::runtime_error(
            "Property animation group is null.");
    }
    group->current_time =
        frame / group->clip.frame_rate;
    group->playing = false;
    apply_group(engine, group);
}

} // namespace bbl
`,
        };
    }
}
