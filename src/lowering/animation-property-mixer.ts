import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import {
    absentBinding,
    PinnedNumericLowerer,
    type PinnedBinding,
} from "./pinned-numeric-lowerer.js";

/** Source mixer passes over admitted public property tracks and native owner identities. */
export function lowerPropertyAnimationMixer(context: LoweringContext): string {
    const module = "src/animation/weighted-pointer-mixer.ts";
    const { file, declaration } = context.functionDeclaration(
        module,
        "_updateWeightedPointerAnimations",
    );
    const bindings = new Map<string, PinnedBinding>([
        ["manager", { cpp: "manager", type: "opaque" }],
        [
            "groups.length",
            {
                cpp: "static_cast<double>(manager.ordered_groups.size())",
                type: "scalar",
            },
        ],
        ["group", { cpp: "group", type: "opaque" }],
        ["group._stopped", { cpp: "stopped(group)", type: "bool" }],
        [
            "group.weight",
            { cpp: "group.property_group->weight", type: "scalar" },
        ],
        ["mixer", { cpp: "mixer", type: "opaque", absentCpp: "!mixer" }],
        ["tracks", { cpp: "mixer", type: "opaque", absentCpp: "!mixer" }],
        [
            "tracks.length",
            {
                cpp: "static_cast<double>(mixer->clip.tracks.size())",
                type: "scalar",
            },
        ],
        ["track", { cpp: "track", type: "opaque" }],
        ["track._afterWrite", absentBinding("undefined")],
        ["bucket", { cpp: "bucket", type: "opaque", absentCpp: "!bucket" }],
        ["bucket.contested", { cpp: "bucket->contested", type: "bool" }],
        ["bucket.active", { cpp: "bucket->active", type: "bool" }],
        ["bucket.quaternion", { cpp: "bucket->quaternion", type: "bool" }],
        [
            "bucket.arity",
            {
                cpp: "static_cast<double>(track_stride(bucket->property, bucket->component))",
                type: "scalar",
            },
        ],
        ["bucket.values", { cpp: "bucket->values", type: "f32" }],
        ["bucket.mix", absentBinding("undefined")],
        ["bucket.afterWrite", absentBinding("undefined")],
        [
            "scratch.bucketCount",
            {
                cpp: "static_cast<double>(manager.buckets.size())",
                type: "scalar",
            },
        ],
        ["scratch.sample", { cpp: "sample", type: "f32" }],
        [
            "onlyPropertyGroups",
            { cpp: "false", type: "bool", staticBoolean: false },
        ],
        ["deltaMs", { cpp: "delta_ms", type: "scalar" }],
    ]);
    const body = lowerPinnedBody(file, declaration.body!.statements, {
        bindings,
        calls: new Map(),
        expression(node, lowerer) {
            if (context.expressionMatchesShape(node, "bucket?.contested"))
                return "(bucket && bucket->contested)";
            if (!ts.isCallExpression(node)) return undefined;
            const callee = node.expression.getText(file);
            if (callee === "trackMaskedOut") {
                context.assertExpressionShape(
                    node,
                    "trackMaskedOut(group, track)",
                    "Public property track mask identity",
                );
                // Public createPropertyAnimationGroup carries no target names or mask.
                return "false";
            }
            if (callee === "findTrackBucket")
                return "find_bucket(*mixer, track_index)";
            if (callee === "getTrackBucket")
                return "get_bucket(*mixer, track_index)";
            if (callee === "advancePropertyGroupTime")
                return `advance_property_group_time(*mixer, ${lowerer.expression(node.arguments[2]!)})`;
            if (callee === "tickAnimationCore") {
                context.assertExpressionShape(
                    node.arguments[0]!,
                    "group",
                    "Property mixer tick identity",
                );
                return `tick_animation_group_reference(engine, group, ${lowerer.expression(node.arguments[1]!)})`;
            }
            if (callee === "normalizeQuaternion")
                return `normalize_blended_quaternion(${lowerer.expression(node.arguments[0]!)})`;
            if (callee === "accumulateWeightedTrack")
                return `accumulate_weighted_track(*bucket, track, sample, ${lowerer.expression(node.arguments[3]!)})`;
            if (callee === "track.writer")
                return "write_track_value(engine, mixer->targets.at(track_index), track.path, track.component, sample)";
            if (callee === "bucket.writer")
                return "write_track_value(engine, bucket->target, bucket->property, bucket->component, bucket->values)";
            if (callee === "evaluatePropertySampler") {
                context.assertExpressionShape(
                    node,
                    "evaluatePropertySampler(track.sampler, t, track.stride, track.quaternion, track.easing, scratch.sample, 0)",
                    "Property sample transport",
                );
                return `sample = evaluate_track(track, ${lowerer.expression(node.arguments[1]!)})`;
            }
            if (callee === "tracks.some") {
                const predicate = node.arguments[0];
                if (
                    !predicate ||
                    !ts.isArrowFunction(predicate) ||
                    ts.isBlock(predicate.body)
                )
                    context.contractError(
                        node,
                        "Expected property track predicate.",
                    );
                const predicateBindings = new Map(bindings);
                predicateBindings.set(
                    "findTrackBucket(scratch, track)?.contested",
                    {
                        cpp: "(candidate && candidate->contested)",
                        type: "bool",
                    },
                );
                const predicateLowerer = new PinnedNumericLowerer(file, {
                    bindings: predicateBindings,
                    calls: new Map([["trackMaskedOut", () => "false"]]),
                });
                return `([&] { for (std::size_t track_index = 0; track_index < mixer->clip.tracks.size(); ++track_index) { const auto* candidate = find_bucket(*mixer, track_index); if (${predicateLowerer.expression(predicate.body)}) return true; } return false; }())`;
            }
            return undefined;
        },
        statement(statement, lowerer, indent) {
            if (
                ts.isVariableStatement(statement) &&
                statement.declarationList.declarations.length === 1
            ) {
                const variable = statement.declarationList.declarations[0]!;
                if (!ts.isIdentifier(variable.name) || !variable.initializer)
                    return undefined;
                const name = variable.name.text;
                const aliases = new Map<string, readonly [string, string]>([
                    ["scratch", ["getScratch(manager)", ""]],
                    ["groups", ["getAnimationGroups(manager)", ""]],
                    [
                        "group",
                        [
                            "groups[groupIndex]!",
                            "const auto group = manager.ordered_groups.at(static_cast<std::size_t>(groupIndex));",
                        ],
                    ],
                    [
                        "mixer",
                        [
                            "group._propertyMixer",
                            "const auto mixer = group.kind == AnimationWeightFadeTargetKind::property ? group.property_group : nullptr;",
                        ],
                    ],
                    [
                        "track",
                        [
                            "tracks[trackIndex]!",
                            "const auto track_index = static_cast<std::size_t>(trackIndex); [[maybe_unused]] const auto& track = mixer->clip.tracks.at(track_index);",
                        ],
                    ],
                ]);
                const alias = aliases.get(name);
                if (alias) {
                    context.assertExpressionShape(
                        variable.initializer,
                        alias[0],
                        "Property mixer storage alias",
                    );
                    lowerer.bindPorts(bindings, variable);
                    return alias[1] ? [`${indent}${alias[1]}`] : [];
                }
                if (name === "tracks") {
                    if (
                        !context.expressionMatchesShape(
                            variable.initializer,
                            "mixer[MIX_TRACKS]",
                        ) &&
                        !context.expressionMatchesShape(
                            variable.initializer,
                            "mixer?.[MIX_TRACKS]",
                        )
                    )
                        context.contractError(
                            variable,
                            "Changed property mixer track identity.",
                        );
                    return [];
                }
                if (name === "bucket") {
                    const initial = context.expressionMatchesShape(
                        variable.initializer,
                        "scratch.buckets[bucketIndex]!",
                    )
                        ? "&manager.buckets.at(static_cast<std::size_t>(bucketIndex))"
                        : lowerer.expression(variable.initializer);
                    lowerer.bindPorts(bindings, variable);
                    return [`${indent}auto* bucket = ${initial};`];
                }
            }
            if (ts.isExpressionStatement(statement)) {
                const node = statement.expression;
                if (
                    context.expressionMatchesShape(
                        node,
                        "scratch.bucketCount = 0",
                    ) ||
                    context.expressionMatchesShape(
                        node,
                        "scratch.buckets.length = 0",
                    )
                )
                    return [`${indent}manager.buckets.clear();`];
                if (
                    context.expressionMatchesShape(
                        node,
                        "scratch.buckets.length = scratch.bucketCount",
                    )
                )
                    return [];
                // Public property groups do not install USD side-effect, mix or outer-manager hooks.
                for (const shape of [
                    "scratch.afterWrites.clear()",
                    "group._propertyMixerHandled = false",
                    "group._propertyMixerHandled = true",
                    "group._mixerCleanup = clearManagerScratch",
                    "_finishWeightedPointerAnimations(manager)",
                ])
                    if (context.expressionMatchesShape(node, shape)) return [];
            }
            return undefined;
        },
        returnValue: (value, lowerer) => lowerer.expression(value!),
    });
    return `// ${context.provenance(module, "_updateWeightedPointerAnimations")}
bool update_weighted_property_animations(Engine& engine, PropertyAnimationManagerRecord& manager, double delta_ms) {
    std::array<float, 4> sample{};
    const auto stopped = [&](const AnimationGroupReference& group) {
        return group.kind == AnimationWeightFadeTargetKind::property ? group.property_group->stopped : engine.assets.at(bbl::handle_at(engine.animation_groups, group.gltf_group).asset).clip_stopped(bbl::handle_at(engine.animation_groups, group.gltf_group).clip);
    };
    const auto find_bucket = [&](const PropertyAnimationGroupRecord& group, std::size_t index) -> PropertyAnimationBucket* {
        const auto& target = group.targets.at(index); const auto& track = group.clip.tracks.at(index);
        const auto identity = target.resolve_object_identity ? target.resolve_object_identity() : PropertyAnimationIdentity{target.object_identity,{}};
        for (auto& bucket : manager.buckets)
            if (bucket.target.kind == target.kind && bucket.target.mesh == target.mesh && bucket.target.index == target.index &&
                bucket.resolved_identity.key == identity.key && bucket.target.property == target.property &&
                bucket.property == track.path && bucket.component == track.component) return &bucket;
        return nullptr;
    };
    const auto get_bucket = [&](const PropertyAnimationGroupRecord& group, std::size_t index) {
        if (auto* bucket = find_bucket(group, index)) { bucket->target = group.targets.at(index); bucket->quaternion = group.clip.tracks.at(index).quaternion; return bucket; }
        const auto& track = group.clip.tracks.at(index); PropertyAnimationBucket bucket;
        bucket.target = group.targets.at(index);
        bucket.resolved_identity = bucket.target.resolve_object_identity ? bucket.target.resolve_object_identity() : PropertyAnimationIdentity{bucket.target.object_identity,{}};
        bucket.property = track.path; bucket.component = track.component; bucket.quaternion = track.quaternion;
        manager.buckets.push_back(std::move(bucket)); return &manager.buckets.back();
    };
${body}
}`;
}
