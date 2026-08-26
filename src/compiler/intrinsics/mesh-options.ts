// Mesh option lowering: the size arguments of the primitive builders.
//
// Each function turns a mesh factory's options argument into the
// positional C++ arguments the PAL builder takes, resolving the pinned
// defaults (a box side defaults to its size, a sphere diameter fans
// out per axis) at compile time. The intrinsic lowerer in mesh.ts
// calls these through its context.
import ts from "typescript";
import type { Value } from "../types.js";
import { doubleLiteral } from "../../cpp-literals.js";
import {
    compilePositiveInteger,
    type PositiveIntegerContext,
    validateObjectProperties,
    type ObjectValidationContext,
} from "../option-helpers.js";

export interface MeshOptionContext
    extends ObjectValidationContext,
        PositiveIntegerContext {
    unwrap(expression: ts.Expression): ts.Expression;
    compileValue(expression: ts.Expression): Value;
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
    compileNumber(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
}

export function compileBoxOptions(
    context: MeshOptionContext,
    expression: ts.Expression,
): [string, string, string] {
    const unwrapped = context.unwrap(expression);
    if (ts.isObjectLiteralExpression(unwrapped)) {
        validateObjectProperties(
            context,
            unwrapped,
            ["size", "width", "height", "depth"],
            "Box options support size, width, height, and depth.",
        );
        const size = context.objectProperty(unwrapped, "size");
        const width = context.objectProperty(unwrapped, "width");
        const height = context.objectProperty(unwrapped, "height");
        const depth = context.objectProperty(unwrapped, "depth");
        const compiledSize = size
            ? context.compileNumber(size)
            : "1.0f";
        return [
            width ? context.compileNumber(width) : compiledSize,
            height ? context.compileNumber(height) : compiledSize,
            depth ? context.compileNumber(depth) : compiledSize,
        ];
    }
    const size = context.compileNumber(unwrapped);
    return [size, size, size];
}

/**
 * `createFlatGroundData`'s own defaults, in the order the native record
 * takes them. Both ground builders emit this when the scene passes no
 * options, so the two cannot drift.
 */
export const GROUND_OPTION_DEFAULTS: readonly [
    string,
    string,
    string,
    string,
    string,
] = ["1.0", "1.0", "1u", "1.0f", "1.0f"];

export function compileGroundOptions(
    context: MeshOptionContext,
    expression: ts.Expression,
    // What the heightmap builder adds to the same grid options; validating
    // here rather than twice keeps ONE list of what a ground option may be.
    alsoAllowed: readonly string[] = [],
): [string, string, string, string, string] {
    const object = context.expectObjectLiteral(expression);
    validateObjectProperties(
        context,
        object,
        ["width", "height", "subdivisions", "uvScale", ...alsoAllowed],
        "Ground options support width, height, subdivisions, and uvScale.",
    );
    const width = context.objectProperty(object, "width");
    const height = context.objectProperty(object, "height");
    const subdivisions = context.objectProperty(
        object,
        "subdivisions",
    );
    const uvScale = context.objectProperty(object, "uvScale");
    let compiledUvScale: [string, string] = ["1.0f", "1.0f"];
    if (uvScale) {
        const values = context.expectStaticArrayLiteral(uvScale);
        if (values.elements.length !== 2) {
            context.fail(
                values,
                "Ground uvScale requires [uScale, vScale].",
            );
        }
        compiledUvScale = [
            context.compileNumber(values.elements[0]!),
            context.compileNumber(values.elements[1]!),
        ];
    }
    return [
        width ? context.compileNumber(width, "double") : "1.0",
        height ? context.compileNumber(height, "double") : "1.0",
        subdivisions
            ? compilePositiveInteger(context, subdivisions)
            : "1u",
        compiledUvScale[0],
        compiledUvScale[1],
    ];
}

/**
 * The heightmap builder's options: the flat grid's, plus the displacement range.
 *
 * The pin builds the grid with `createFlatGroundData(opts)` and then displaces
 * it, so the grid fields are read by exactly the rule above and only the two
 * height bounds are this builder's own.
 */
export function compileGroundFromHeightMapOptions(
    context: MeshOptionContext,
    expression: ts.Expression,
): [string, string, string, string, string, string, string] {
    const object = context.expectObjectLiteral(expression);
    const grid = compileGroundOptions(context, expression, [
        "minHeight",
        "maxHeight",
    ]);
    const minHeight = context.objectProperty(object, "minHeight");
    const maxHeight = context.objectProperty(object, "maxHeight");
    return [
        ...grid,
        // Pinned defaults from createGroundFromHeightMap: 0 and 1.
        minHeight ? context.compileNumber(minHeight, "double") : "0.0",
        maxHeight ? context.compileNumber(maxHeight, "double") : "1.0",
    ];
}

export function compilePlaneOptions(
    context: MeshOptionContext,
    expression: ts.Expression,
): [string, string] {
    const object = context.expectObjectLiteral(expression);
    validateObjectProperties(
        context,
        object,
        ["size", "width", "height"],
        "Plane options support only size, width, and height.",
    );
    const size = context.objectProperty(object, "size");
    const width = context.objectProperty(object, "width");
    const height = context.objectProperty(object, "height");
    const compiledSize = size ? context.compileNumber(size) : "1.0f";
    return [
        width ? context.compileNumber(width) : compiledSize,
        height ? context.compileNumber(height) : compiledSize,
    ];
}

export function compileSphereOptions(
    context: MeshOptionContext,
    expression: ts.Expression,
): [string, string, string, string] {
    const unwrapped = context.unwrap(expression);
    if (!ts.isObjectLiteralExpression(unwrapped)) {
        const record = context.compileValue(unwrapped);
        if (
            record.kind !== "record" ||
            !record.recordProperties
        ) {
            context.fail(
                unwrapped,
                "Expected sphere options as an object literal or static record.",
            );
        }
        const supported = new Set([
            "segments",
            "diameter",
            "diameterX",
            "diameterY",
            "diameterZ",
        ]);
        for (const name of Object.keys(
            record.recordProperties,
        )) {
            if (!supported.has(name)) {
                context.fail(
                    unwrapped,
                    "Sphere options support segments, diameter, diameterX, diameterY, and diameterZ.",
                );
            }
        }
        const number = (
            name: string,
            fallback: string,
        ): string => {
            const value =
                record.recordProperties?.[name];
            if (!value) {
                return fallback;
            }
            if (value.kind !== "number") {
                context.fail(
                    unwrapped,
                    `Sphere option '${name}' must be numeric.`,
                );
            }
            // The record's own property was compiled at the default float
            // precision, but the pin halves a diameter as a JavaScript
            // number before the vertex chain rounds. Restate the value at
            // that precision, or widen the expression where the scene
            // computes it.
            return value.staticNumber !== undefined
                ? doubleLiteral(value.staticNumber)
                : `static_cast<double>(${value.cpp})`;
        };
        const diameter = number(
            "diameter",
            "1.0",
        );
        const segments =
            record.recordProperties.segments;
        if (
            segments &&
            (segments.kind !== "number" ||
                segments.staticNumber === undefined ||
                !Number.isInteger(
                    segments.staticNumber,
                ) ||
                segments.staticNumber <= 0)
        ) {
            context.fail(
                unwrapped,
                "Sphere segments must be a positive static integer.",
            );
        }
        return [
            segments
                ? `${segments.staticNumber}u`
                : "32u",
            number("diameterX", diameter),
            number("diameterY", diameter),
            number("diameterZ", diameter),
        ];
    }
    const object = unwrapped;
    validateObjectProperties(
        context,
        object,
        [
            "segments",
            "diameter",
            "diameterX",
            "diameterY",
            "diameterZ",
        ],
        "Sphere options support segments, diameter, diameterX, diameterY, and diameterZ.",
    );
    const segments = context.objectProperty(object, "segments");
    const diameter = context.objectProperty(object, "diameter");
    const diameterX = context.objectProperty(object, "diameterX");
    const diameterY = context.objectProperty(object, "diameterY");
    const diameterZ = context.objectProperty(object, "diameterZ");
    // Doubles, because the pin halves them as JavaScript numbers before the
    // vertex chain rounds: `rx = diameterX / 2` off a float diameter is not
    // `rx` off the pin's. See the mesh-builder contract in docs/fidelity.md.
    const compiledDiameter = diameter
        ? context.compileNumber(diameter, "double")
        : "1.0";
    return [
        segments ? compilePositiveInteger(context, segments) : "32u",
        diameterX
            ? context.compileNumber(diameterX, "double")
            : compiledDiameter,
        diameterY
            ? context.compileNumber(diameterY, "double")
            : compiledDiameter,
        diameterZ
            ? context.compileNumber(diameterZ, "double")
            : compiledDiameter,
    ];
}

export function compileTorusOptions(
    context: MeshOptionContext,
    expression: ts.Expression,
): [string, string, string] {
    const object = context.expectObjectLiteral(expression);
    validateObjectProperties(
        context,
        object,
        ["diameter", "thickness", "tessellation"],
        "Torus options support diameter, thickness, and tessellation.",
    );
    const diameter = context.objectProperty(object, "diameter");
    const thickness = context.objectProperty(object, "thickness");
    const tessellation = context.objectProperty(object, "tessellation");
    return [
        diameter ? context.compileNumber(diameter, "double") : "1.0",
        thickness ? context.compileNumber(thickness, "double") : "0.5",
        tessellation
            ? compilePositiveInteger(context, tessellation)
            : "16u",
    ];
}
