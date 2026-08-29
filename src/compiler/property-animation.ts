// Property-animation lowering: clips, tracks, keys, and group options.
//
// A clip's tracks and keys are static literals, so the whole timeline
// lowers at compile time: paths map to the native track enum, frames
// divide by the resolved frame rate, and key values pad to the
// four-component native key. Group options fold their from/to frames
// through the clip's own frame rate. The intrinsic lowerer in
// animation.ts calls these through its context.
import ts from "typescript";
import type { Value } from "./types.js";

export interface PropertyAnimationContext {
    readonly sourceFile: ts.SourceFile;
    expectObjectLiteral(
        expression: ts.Expression,
    ): ts.ObjectLiteralExpression;
    expectStaticArrayLiteral(
        expression: ts.Expression,
    ): ts.ArrayLiteralExpression;
    objectProperty(
        object: ts.ObjectLiteralExpression,
        name: string,
    ): ts.Expression | undefined;
    resolveStaticExpression(
        expression: ts.Expression,
    ): ts.Expression;
    compileNumber(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
    compileBoolean(expression: ts.Expression): string;
    compileStaticString(
        expression: ts.Expression,
    ): string;
    cppString(value: string): string;
    fail(node: ts.Node, message: string): never;
}

export type PropertyAnimationTargetKind = "mesh" | "camera";

export interface PropertyAnimationLane {
    /** The native `PropertyAnimationPath` enumerator this lane lowers to. */
    native: string;
    /** How wide the lane's value is: the pin's stride for its whole-lane path. */
    components: number;
    /** The record the pinned walk lands on, and the field it names there. */
    target: PropertyAnimationTargetKind;
    field: string;
    /** The native type a whole-lane store constructs, for a lane above one. */
    vector?: string;
    /**
     * A record flag the pinned property setter selects beside the store.
     * `mesh.rotationQuaternion` is the mesh's rotation whichever way it was
     * written, so a component write selects the lane as much as a
     * whole-vector one does.
     */
    selects?: string;
}

/**
 * The animatable LANES, each a property of a record this port holds.
 *
 * A path is any dotted string upstream: `resolvePropertyBinding` walks it,
 * lands on an object and a final property name, and `createPropertyWriter`
 * then writes either the whole value (through its `set`, or component by
 * component) or the one number the path named. Which paths exist is
 * therefore decided by which properties the target object has, not by a
 * list — so this table names the record fields rather than the paths, and
 * `resolvePropertyAnimationPath` derives the paths the pin would resolve
 * against them: the lane itself, plus one per component in the pin's own
 * `"xyzw"` order for a lane wide enough to have them.
 *
 * One lane, one row: which paths resolve, how wide each is, and what a
 * write stores are all facts about the same lane, so the lowerer generates
 * its writer arms and its bucket widths from this table rather than from a
 * second one it would then have to check against this.
 */
export const propertyAnimationLanes: ReadonlyMap<
    string,
    PropertyAnimationLane
> = new Map([
    [
        "position",
        {
            native: "position",
            components: 3,
            target: "mesh",
            field: "position",
            vector: "Vec3d",
        },
    ],
    [
        "scaling",
        {
            native: "scaling",
            components: 3,
            target: "mesh",
            field: "scaling",
            vector: "Vec3",
        },
    ],
    [
        "rotationQuaternion",
        {
            native: "rotation_quaternion",
            components: 4,
            target: "mesh",
            field: "rotation_quaternion",
            vector: "Vec4",
            selects: "has_rotation_quaternion",
        },
    ],
    [
        "alpha",
        {
            native: "camera_alpha",
            components: 1,
            target: "camera",
            field: "alpha",
        },
    ],
]);

/** The pin's component order, from `createPropertyWriter`'s own `"xyzw"`. */
const propertyAnimationComponents = ["x", "y", "z", "w"] as const;

/**
 * The component paths a lane offers, in the pin's own order.
 *
 * A one-wide lane offers none: the pinned walk would reach a number and
 * `asRecord` refuses it. Stated once because both halves consume it — the
 * resolver decides which paths exist, and the lowerer emits one writer arm
 * per component — and a lane whose two halves disagreed would compile a
 * path the generated switch has no arm for.
 */
export function laneComponents(
    lane: PropertyAnimationLane,
): readonly string[] {
    return lane.components === 1
        ? []
        : propertyAnimationComponents.slice(0, lane.components);
}

export interface ResolvedPropertyAnimationPath {
    lane: PropertyAnimationLane;
    /** The native `PropertyAnimationComponent` enumerator. */
    component: string;
    /** The pin's stride for this path: the lane's width, or one. */
    stride: number;
    /** The pin's own `quaternion` derivation for this path. */
    quaternion: boolean;
}

/**
 * One path, resolved the way `resolvePropertyBinding` resolves it: the
 * whole lane, or one component of it.
 *
 * The walk splits on every dot upstream; no lane name contains one, so a
 * path of more than two parts has no lane to land on and resolves to
 * nothing here exactly as it throws there.
 */
export function resolvePropertyAnimationPath(
    path: string,
): ResolvedPropertyAnimationPath | undefined {
    const whole = propertyAnimationLanes.get(path);
    if (whole) {
        return {
            lane: whole,
            component: "whole_lane",
            stride: whole.components,
            // `createPropertyAnimationClip`: the path itself, or a path
            // ending in it, is the rotation channel.
            quaternion: path === "rotationQuaternion",
        };
    }
    const separator = path.lastIndexOf(".");
    if (separator < 0) return undefined;
    const lane = propertyAnimationLanes.get(path.slice(0, separator));
    const component = path.slice(separator + 1);
    if (!lane || !laneComponents(lane).includes(component)) {
        return undefined;
    }
    return {
        lane,
        component,
        stride: 1,
        // The pin's second arm, `path.endsWith(".rotationQuaternion")`,
        // needs a lane whose own value carries a nested rotation
        // quaternion. Every lane above is a number or a number tuple, so
        // that arm has nothing to land on and a component path is never
        // the rotation channel.
        quaternion: false,
    };
}

export function compilePropertyAnimationClip(
    context: PropertyAnimationContext,
    nameExpression: ts.Expression,
    tracksExpression: ts.Expression,
    optionsExpression: ts.Expression | undefined,
): {
    cpp: string;
    frameRate: string;
    duration: string;
    target: PropertyAnimationTargetKind;
} {
    const tracks = context.expectStaticArrayLiteral(tracksExpression);
    if (tracks.elements.length === 0) {
        context.fail(
            tracks,
            "createPropertyAnimationClip requires at least one track.",
        );
    }
    let frameRate = optionsExpression
        ? compilePropertyAnimationFrameRate(
              context,
              optionsExpression,
          )
        : undefined;
    if (!frameRate) {
        const trackFrameRates = tracks.elements
            .map((element) =>
                context.objectProperty(
                    context.expectObjectLiteral(element),
                    "frameRate",
                ),
            )
            .filter(
                (
                    value,
                ): value is ts.Expression =>
                    value !== undefined,
            )
            .map((value) =>
                context.compileNumber(value),
            );
        const distinct = [
            ...new Set(trackFrameRates),
        ];
        if (distinct.length > 1) {
            context.fail(
                tracks,
                "Property animation tracks require one shared frame rate when clip options omit frameRate.",
            );
        }
        frameRate = distinct[0] ?? "60.0f";
    }
    const targets = new Set<PropertyAnimationTargetKind>();
    const compiledTracks = tracks.elements.map((element) => {
        const track = context.expectObjectLiteral(
            context.resolveStaticExpression(element),
        );
        const pathExpression = context.objectProperty(track, "path");
        const keysExpression = context.objectProperty(track, "keys");
        if (!pathExpression || !keysExpression) {
            context.fail(
                track,
                "Property animation tracks require path and keys.",
            );
        }
        const path = context.compileStaticString(pathExpression);
        const binding = resolvePropertyAnimationPath(path);
        if (!binding) {
            context.fail(
                pathExpression,
                `Unsupported property animation path '${path}'.`,
            );
        }
        targets.add(binding.lane.target);
        // `createPropertyAnimationClip` derives the rotation channel as
        // `track.quaternion === true || <the two path arms>`, and
        // `evaluateSampler` then slerps on it whatever the stride is —
        // reading four components out of a three-wide output, which is a
        // read past the key this port's own four-wide key cannot
        // reproduce. So an explicit opt-in that the path does not already
        // imply refuses rather than lerping something the pin slerps.
        const quaternionExpression = context.objectProperty(
            track,
            "quaternion",
        );
        if (
            quaternionExpression &&
            !binding.quaternion &&
            // Anything but a settled `false` is an opt-in this port cannot
            // honour, a value it cannot settle included: both must refuse,
            // because silently dropping the option is what leaves the two
            // sides interpolating differently.
            context.compileBoolean(quaternionExpression) !== "false"
        ) {
            context.fail(
                quaternionExpression,
                `Property animation track '${path}' is ${binding.stride} ` +
                    "component(s) wide; the pinned slerp reads four.",
            );
        }
        const interpolationExpression =
            context.objectProperty(track, "interpolation");
        const interpolation = interpolationExpression
            ? context.compileStaticString(interpolationExpression)
            : "linear";
        if (!["linear", "step"].includes(interpolation)) {
            context.fail(
                interpolationExpression!,
                `Unsupported property animation interpolation '${interpolation}'.`,
            );
        }
        const trackFrameRateExpression =
            context.objectProperty(track, "frameRate");
        const trackFrameRate = trackFrameRateExpression
            ? context.compileNumber(trackFrameRateExpression)
            : frameRate;
        const keys = context.expectStaticArrayLiteral(keysExpression);
        if (keys.elements.length === 0) {
            context.fail(
                keys,
                `Property animation track '${path}' requires at least one key.`,
            );
        }
        const compiledKeys = keys.elements.map((keyElement) => {
            const key = context.expectObjectLiteral(
                context.resolveStaticExpression(keyElement),
            );
            const timeExpression = context.objectProperty(key, "time");
            const frameExpression = context.objectProperty(key, "frame");
            const valueExpression = context.objectProperty(key, "value");
            if (
                (!timeExpression && !frameExpression) ||
                (timeExpression && frameExpression) ||
                !valueExpression
            ) {
                context.fail(
                    key,
                    "Property animation keys require value and exactly one of time or frame.",
                );
            }
            const time = timeExpression
                ? context.compileNumber(timeExpression)
                : `(${context.compileNumber(frameExpression!)} / ${trackFrameRate})`;
            const value = compilePropertyAnimationKeyValue(
                context,
                valueExpression,
                binding.stride,
            );
            return `bbl::PropertyAnimationKey{${time}, ${value}}`;
        });
        return `bbl::PropertyAnimationTrack{bbl::PropertyAnimationPath::${binding.lane.native}, bbl::PropertyAnimationComponent::${binding.component}, bbl::PropertyAnimationInterpolation::${interpolation}, ${binding.quaternion}, {${compiledKeys.join(", ")}}}`;
    });
    if (targets.size > 1) {
        // Upstream resolves each path against the one object the group
        // was bound to, so a clip whose paths name different objects
        // could never have bound at all.
        context.fail(
            tracks,
            "Property animation tracks in one clip must animate the same object kind.",
        );
    }
    const name = context.compileStaticString(nameExpression);
    return {
        cpp: `bbl::create_property_animation_clip(${context.cppString(name)}, {${compiledTracks.join(", ")}}, ${frameRate})`,
        frameRate,
        duration: "0.0f",
        target: [...targets][0] ?? "mesh",
    };
}

function compilePropertyAnimationFrameRate(
    context: PropertyAnimationContext,
    expression: ts.Expression,
): string {
    const options = context.expectObjectLiteral(expression);
    const frameRate = context.objectProperty(options, "frameRate");
    return frameRate
        ? context.compileNumber(frameRate)
        : "60.0f";
}

function compilePropertyAnimationKeyValue(
    context: PropertyAnimationContext,
    expression: ts.Expression,
    components: number,
): string {
    const resolved = context.resolveStaticExpression(expression);
    const values =
        components === 1
            ? [context.compileNumber(resolved)]
            : context.expectStaticArrayLiteral(resolved).elements.map(
                  (element) => context.compileNumber(element),
              );
    if (values.length !== components) {
        context.fail(
            resolved,
            `Property animation value requires ${components} components.`,
        );
    }
    while (values.length < 4) values.push("0.0f");
    return `std::array<float, 4>{${values.join(", ")}}`;
}

export function compilePropertyAnimationGroupOptions(
    context: PropertyAnimationContext,
    expression: ts.Expression | undefined,
    clip: Value,
): string {
    const frameRate =
        clip.animationFrameRate ??
        context.fail(
            expression ?? context.sourceFile,
            "Property animation clip frame rate is unavailable.",
        );
    const duration =
        clip.animationDuration ??
        context.fail(
            expression ?? context.sourceFile,
            "Property animation clip duration is unavailable.",
        );
    if (!expression) {
        return `bbl::PropertyAnimationGroupOptions{0.0f, ${duration}, 1.0f, true}`;
    }
    const options = context.expectObjectLiteral(expression);
    const fromTime = context.objectProperty(options, "fromTime");
    const fromFrame = context.objectProperty(options, "fromFrame");
    const toTime = context.objectProperty(options, "toTime");
    const toFrame = context.objectProperty(options, "toFrame");
    if (fromTime && fromFrame) {
        context.fail(
            options,
            "Property animation group cannot specify both fromTime and fromFrame.",
        );
    }
    if (toTime && toFrame) {
        context.fail(
            options,
            "Property animation group cannot specify both toTime and toFrame.",
        );
    }
    const from = fromTime
        ? context.compileNumber(fromTime)
        : fromFrame
            ? `(${context.compileNumber(fromFrame)} / ${frameRate})`
            : "0.0f";
    const to = toTime
        ? context.compileNumber(toTime)
        : toFrame
            ? `(${context.compileNumber(toFrame)} / ${frameRate})`
            : duration;
    const speedRatio = context.objectProperty(options, "speedRatio");
    const loop = context.objectProperty(options, "loop");
    return `bbl::PropertyAnimationGroupOptions{${from}, ${to}, ${speedRatio ? context.compileNumber(speedRatio) : "1.0f"}, ${loop ? context.compileBoolean(loop) : "true"}}`;
}
