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

/**
 * The reached property paths, each with the native track enumerator it
 * lowers to and how many components its keys carry.
 *
 * Upstream reads a track's stride off its first key value
 * (`getTrackStride`) because a path is any dotted string there; here the
 * path is one of a closed set resolved at compile time, so the count is
 * a property of the path. Both consumers read this one table: key
 * validation below, and the emitted mixer's bucket width, which the
 * animation lowerer generates from it.
 */
export type PropertyAnimationTargetKind = "mesh" | "camera";

export const propertyAnimationPaths: ReadonlyMap<
    string,
    {
        native: string;
        components: number;
        target: PropertyAnimationTargetKind;
    }
> = new Map([
    [
        "position",
        { native: "position", components: 3, target: "mesh" },
    ],
    [
        "position.x",
        {
            native: "position_x",
            components: 1,
            target: "mesh",
        },
    ],
    [
        "scaling",
        { native: "scaling", components: 3, target: "mesh" },
    ],
    [
        "rotationQuaternion",
        {
            native: "rotation_quaternion",
            components: 4,
            target: "mesh",
        },
    ],
    [
        "alpha",
        {
            native: "camera_alpha",
            components: 1,
            target: "camera",
        },
    ],
]);

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
        const pathInfo = propertyAnimationPaths.get(path);
        if (!pathInfo) {
            context.fail(
                pathExpression,
                `Unsupported property animation path '${path}'.`,
            );
        }
        targets.add(pathInfo.target);
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
                pathInfo.components,
            );
            return `bbl::PropertyAnimationKey{${time}, ${value}}`;
        });
        return `bbl::PropertyAnimationTrack{bbl::PropertyAnimationPath::${pathInfo.native}, bbl::PropertyAnimationInterpolation::${interpolation}, {${compiledKeys.join(", ")}}}`;
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
