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
import { renderClosure, type CapturedClosure, type NativeCaptureBinding } from "./closure-captures.js";
import type { DataTypeRegistry } from "./data-types.js";

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

export interface PropertyAnimationTargetContext {
    readonly dataTypes: DataTypeRegistry;
    fail(node: ts.Node, message: string): never;
    allocateTemporaryCppName(label: string): string;
    captureManagedClosureLines(
        emitBody: () => void,
    ): CapturedClosure;
    withRecordScopes<T>(owner: Value, work: () => T): T;
    compileRecordSetterValue(
        owner: Value,
        setter: ts.SetAccessorDeclaration,
        node: ts.Expression,
        value: Value,
    ): void;
    callbackIdentity(declaration: ts.Node, owner: Value | undefined): number;
    requireDefaultEngine(node: ts.Node): string;
    emit(line: string): void;
    useNativeValue(value: Value): void;
    registerNativeBinding(name: string): NativeCaptureBinding;
    cppString(value: string): string;
    materializeEscapingValue(value: Value, label: string, node?: ts.Expression): Value;
}

/** Callback writers bound to the owner resolved when the group is created. */
export class PropertyAnimationTargetLowerer {
    compile(
        context: PropertyAnimationTargetContext,
        target: Value,
        paths: readonly string[],
        node: ts.Expression,
    ): { cpp: string; engineCpp: string } {
        const bindings = paths.map((path) => {
            const segments = path.split(".");
            const property = segments.pop();
            if (!property || segments.some((segment) => !segment)) {
                context.fail(
                    node,
                    `Property animation path '${path}' must contain nonempty property names.`,
                );
            }
            let owner = target;
            for (const segment of segments) {
                if (owner.dataType?.kind === "struct") {
                    const field = context.dataTypes.structField(owner.dataType.name, segment, node);
                    if (!context.dataTypes.isReferenceStruct(owner.dataType.name)) {
                        context.fail(node, `Property animation path '${path}' requires shared object ownership.`);
                    }
                    context.useNativeValue(target);
                    context.emit(`if (!${owner.cpp}) throw std::runtime_error(${context.cppString(`Property animation path '${path}' requires an object owner.`)});`);
                    owner = { kind: "data", cpp: `${owner.cpp}->${field.name}`, dataType: field.type };
                    continue;
                }
                const next =
                    owner.kind === "record"
                        ? owner.recordProperties?.[segment]
                        : undefined;
                if (!next) {
                    context.fail(
                        node,
                        `Property animation target has no record path '${segments.join(".")}'.`,
                    );
                }
                owner = next;
            }
            if (owner.dataType?.kind === "struct") {
                if (!context.dataTypes.isReferenceStruct(owner.dataType.name)) {
                    context.fail(node, `Property animation path '${path}' requires shared object ownership.`);
                }
                const field = context.dataTypes.structField(owner.dataType.name, property, node);
                if (field.type.kind !== "number" || field.readOnly) {
                    context.fail(node, `Property animation path '${path}' must end at a mutable numeric data field.`);
                }
                if (resolvePropertyAnimationPath(path)?.stride !== 1) {
                    context.fail(node, `Property animation path '${path}' requires a scalar track for a numeric data field.`);
                }
                const captured = context.allocateTemporaryCppName("property_animation_owner");
                context.useNativeValue(target);
                context.emit(`const auto ${captured} = ${owner.cpp};`);
                context.emit(`if (!${captured}) throw std::runtime_error(${context.cppString(`Property animation path '${path}' requires an object owner.`)});`);
                const binding = context.registerNativeBinding(captured);
                return this.scalarTarget(context, property,
                    { kind: "data", cpp: captured, dataType: owner.dataType,
                      nativeCaptures: [binding] },
                    `${captured}->${field.name}`, `${captured}.get()`);
            }
            if (owner.kind === "record" && owner.recordProperties?.[property]?.kind === "number" &&
                !owner.recordSetters?.[property]) {
                if (resolvePropertyAnimationPath(path)?.stride !== 1) {
                    context.fail(node, `Property animation path '${path}' requires a scalar track for a numeric data field.`);
                }
                const retained = context.materializeEscapingValue(owner, "property_animation_owner");
                const field = retained.recordProperties?.[property];
                if (!field?.sharedRecordScalar || !field.sharedStorageCpp) {
                    context.fail(node, `Property animation path '${path}' has no retained scalar storage.`);
                }
                return this.scalarTarget(context, property, field,
                    field.cpp, `${field.sharedStorageCpp}.get()`);
            }
            const setter =
                owner.kind === "record"
                    ? owner.recordSetters?.[property]
                    : undefined;
            if (!setter) {
                context.fail(
                    node,
                    `Property animation path '${path}' must end at a mutable numeric data field or scalar record setter.`,
                );
            }
            const identity = context.callbackIdentity(setter, owner);
            const argument =
                context.allocateTemporaryCppName("property_animation_value");
            const closure =
                context.captureManagedClosureLines(() =>
                    context.withRecordScopes(owner, () =>
                        context.compileRecordSetterValue(
                            owner,
                            setter,
                            node,
                            {
                                kind: "number",
                                cpp: `static_cast<double>(${argument})`,
                                dataType: { kind: "number" },
                            },
                        ),
                    ),
                );
            return (
                `bbl::PropertyAnimationTarget{` +
                `bbl::PropertyAnimationTargetKind::callback, ` +
                `${identity}u, ${renderClosure(closure, `float ${argument}`)}}`
            );
        });
        return {
            cpp: `{${bindings.join(", ")}}`,
            engineCpp: context.requireDefaultEngine(node),
        };
    }

    private scalarTarget(
        context: PropertyAnimationTargetContext,
        property: string,
        retained: Value,
        fieldCpp: string,
        identityCpp: string,
    ): string {
        const argument = context.allocateTemporaryCppName("property_animation_value");
        const closure = context.captureManagedClosureLines(() => {
            context.useNativeValue(retained);
            context.emit(`${fieldCpp} = static_cast<double>(${argument});`);
        });
        return `bbl::PropertyAnimationTarget{bbl::PropertyAnimationTargetKind::callback, 0u, ` +
            `${renderClosure(closure, `float ${argument}`)}, ${identityCpp}, ${context.cppString(property)}}`;
    }
}

export type PropertyAnimationTargetKind = "mesh" | "camera" | "record";

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
    [
        "__record_scalar__",
        {
            native: "record_scalar",
            components: 1,
            target: "record",
            field: "",
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
 * Native lanes retain their whole-vector or component writers. Other
 * static property names use scalar callback tracks; group construction
 * validates the actual target's path and retains its resolved owner.
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
    if (separator < 0 && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(path)) {
        return { lane: propertyAnimationLanes.get("__record_scalar__")!, component: "whole_lane", stride: 1, quaternion: false };
    }
    if (separator < 0) return undefined;
    const lane = propertyAnimationLanes.get(path.slice(0, separator));
    const component = path.slice(separator + 1);
    if (lane && !laneComponents(lane).includes(component)) {
        return undefined;
    }
    if (!lane) {
        const segments = path.split(".");
        if (
            segments.length < 2 ||
            segments.some(
                (segment) =>
                    !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(
                        segment,
                    ),
            )
        ) {
            return undefined;
        }
        return {
            lane: propertyAnimationLanes.get(
                "__record_scalar__",
            )!,
            component: "whole_lane",
            stride: 1,
            quaternion: false,
        };
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
    paths: readonly string[];
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
    const paths: string[] = [];
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
        paths.push(path);
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
    const name = context.compileStaticString(nameExpression);
    return {
        cpp: `bbl::create_property_animation_clip(${context.cppString(name)}, {${compiledTracks.join(", ")}}, ${frameRate})`,
        frameRate,
        duration: "0.0f",
        // A plain object may have scalar fields named by several native
        // lanes. Such clips require object binding at group construction.
        target: targets.size === 1 ? [...targets][0]! : "record",
        paths,
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
