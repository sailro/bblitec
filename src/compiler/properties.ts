// Property reads on the compiled surface.
//
// Every read here answers the same question -- given a handle and a
// property name, which native expression names the value -- and the
// answers differed by about three tokens each while the ceremony around
// them was copied verbatim: resolve the owning engine, index the record
// collection, carry `engineCpp` forward so a later read can resolve the
// engine again. The table below states the three tokens; `readProperty`
// holds the ceremony once.
//
// Reads that are not a field lookup stay in the compiler: `this.x`
// resolves through the instance record, a record read runs its getter, a
// tuple length and an engine's MSAA sample count come from compile-time
// metadata rather than from a native field, and `camera.target`
// synthesizes a three-component record. Those differ in what they *do*,
// not in which field they name.
import type ts from "typescript";

import type { Value, ValueKind } from "./types.js";

/** A property the compiled surface deliberately does not serve. */
interface RefusedProperty {
    owner: ValueKind;
    property: string;
    /** Says why, and what to reach for instead. */
    unsupported: string;
}

interface PropertyRead {
    /** The value kind the owner must have. */
    owner: ValueKind;
    /** The property name as the source writes it. */
    property: string;
    /** The kind the read produces. */
    value: ValueKind;
    /**
     * Exactly one of these says where the value lives:
     *
     *   `record` -- `[collection, field]`, indexed by the owner handle
     *               through the engine it belongs to;
     *   `field`  -- a member of the owner's own expression;
     *   `helper` -- a native function that takes the owner expression;
     *   `retag`  -- the same handle under a different kind, reading
     *               nothing.
     */
    record?: readonly [collection: string, field: string];
    field?: string;
    helper?: string;
    retag?: true;
    /**
     * Rejects an owner this read cannot serve, returning the message.
     * Runs before anything is emitted.
     */
    reject?: (owner: Value) => string | undefined;
}

type PropertyRule = PropertyRead | RefusedProperty;

const propertyRules: readonly PropertyRule[] = [
    {
        // The lab demos reach the raw GPUDevice to writeBuffer
        // thin-instance pools each frame; the compiled surface has a
        // sanctioned equivalent instead of a device escape hatch.
        owner: "engine",
        property: "_device",
        unsupported:
            "engine._device is not part of the compiled surface; update thin-instance pools through flushThinInstances or setThinInstanceCount instead of writing GPU buffers directly.",
    },
    {
        owner: "engine",
        property: "scRT",
        value: "render-target",
        helper: "bbl::swapchain_render_target",
    },
    {
        owner: "camera",
        property: "alpha",
        value: "number",
        record: ["cameras", "alpha"],
    },
    {
        owner: "camera",
        property: "beta",
        value: "number",
        record: ["cameras", "beta"],
    },
    {
        owner: "camera",
        property: "radius",
        value: "number",
        record: ["cameras", "radius"],
    },
    {
        owner: "camera",
        property: "fov",
        value: "number",
        record: ["cameras", "fov"],
    },
    {
        owner: "camera",
        property: "nearPlane",
        value: "number",
        record: ["cameras", "near_plane"],
    },
    {
        owner: "camera",
        property: "farPlane",
        value: "number",
        record: ["cameras", "far_plane"],
    },
    {
        owner: "camera",
        property: "speed",
        value: "number",
        record: ["cameras", "speed"],
    },
    {
        // The native record keeps upstream's spelling of the field.
        owner: "camera",
        property: "angularSensitivity",
        value: "number",
        record: ["cameras", "angular_sensibility"],
    },
    {
        // The pinned bounds object is also reachable as `camera.ortho`
        // after the opt-in.
        owner: "camera",
        property: "ortho",
        value: "camera-ortho",
        retag: true,
    },
    {
        owner: "camera",
        property: "worldMatrix",
        value: "camera-world-matrix",
        retag: true,
        reject: (owner) =>
            owner.cameraKind === "arc-rotate"
                ? undefined
                : "Reached camera worldMatrix access currently requires an ArcRotateCamera.",
    },
    {
        owner: "camera-ortho",
        property: "halfHeight",
        value: "number",
        record: ["cameras", "ortho_half_height"],
    },
    {
        // The opt-in PBR setters take the material back off the mesh it
        // was assigned to (`setPbrSkybox(box.material)`).
        owner: "mesh",
        property: "material",
        value: "material",
        record: ["meshes", "material"],
    },
    {
        owner: "scene",
        property: "clearColor",
        value: "color4",
        field: "clear_color",
    },
    {
        owner: "scene",
        property: "camera",
        value: "camera",
        field: "camera",
    },
    {
        owner: "render-target-texture",
        property: "rt",
        value: "render-target",
        field: "rt",
    },
    {
        owner: "render-target-texture",
        property: "texture",
        value: "render-texture",
        field: "texture",
    },
];

/**
 * The native field a camera property stores into, or undefined when the
 * property is not one of them.
 *
 * Writes go through `assignments.ts`, but they name the same fields, and
 * the map used to be restated at each write site: `camera.speed = 2`
 * compiled while `scene.camera.speed = 2` was refused as an unsupported
 * camera property, purely because one copy listed fewer names than the
 * other. Reads and writes now agree by construction.
 */
export function cameraRecordField(
    property: string,
): string | undefined {
    const rule = propertyRules.find(
        (candidate) =>
            candidate.owner === "camera" &&
            candidate.property === property &&
            "record" in candidate,
    );
    return rule && "record" in rule
        ? rule.record?.[1]
        : undefined;
}

/**
 * The compiler surface `readProperty` needs. Kept to what a field lookup
 * uses, so the table cannot grow a dependency on statement lowering.
 */
export interface PropertyContext {
    requireEngine(value: Value, node: ts.Node): string;
    fail(node: ts.Node, message: string): never;
}

/**
 * Resolves a declared property read, or returns undefined when no rule
 * claims the pair, so the caller can try the readings that are not field
 * lookups.
 */
export function readProperty(
    context: PropertyContext,
    owner: Value,
    property: string,
    expression: ts.PropertyAccessExpression,
): Value | undefined {
    const rule = propertyRules.find(
        (candidate) =>
            candidate.owner === owner.kind &&
            candidate.property === property,
    );
    if (!rule) {
        return undefined;
    }
    if ("unsupported" in rule) {
        context.fail(expression, rule.unsupported);
    }
    const rejection = rule.reject?.(owner);
    if (rejection) {
        context.fail(expression, rejection);
    }
    // An engine handle names itself; anything else carries the engine it
    // was created from, so the value read out of it stays resolvable.
    const engineCpp =
        owner.kind === "engine"
            ? owner.cpp
            : owner.engineCpp;
    const read = (cpp: string): Value => ({
        kind: rule.value,
        cpp,
        ...(engineCpp ? { engineCpp } : {}),
    });
    if (rule.record) {
        const [collection, field] = rule.record;
        const engine = context.requireEngine(
            owner,
            expression,
        );
        return read(
            `${engine}.${collection}[${owner.cpp}.value].${field}`,
        );
    }
    if (rule.field) {
        return read(`${owner.cpp}.${rule.field}`);
    }
    if (rule.helper) {
        return read(`${rule.helper}(${owner.cpp})`);
    }
    return read(owner.cpp);
}
