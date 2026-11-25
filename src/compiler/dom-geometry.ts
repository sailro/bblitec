import ts from "typescript";
import type { DataLowerer } from "./data-lowering.js";
import type { DataType } from "./data-types.js";
import type { Value } from "./types.js";

/**
 * DOMMatrix and DOMPoint (`bblite/js_dom_geometry.hpp`): the 2D matrix an
 * SVG element's `getScreenCTM()` measures, read only, with `inverse()`; the
 * point `createSVGPoint()` makes, its components writable, and
 * `matrixTransform(matrix)`.
 */

const MATRIX: DataType = { kind: "dom-matrix" };
const POINT: DataType = { kind: "dom-point" };

/** DOMMatrix members by name: the 2D spelling and its 4x4 aliases. */
const MATRIX_MEMBERS: ReadonlyMap<string, string> = new Map([
    ["a", "a"],
    ["b", "b"],
    ["c", "c"],
    ["d", "d"],
    ["e", "e"],
    ["f", "f"],
    ["m11", "a"],
    ["m12", "b"],
    ["m21", "c"],
    ["m22", "d"],
    ["m41", "e"],
    ["m42", "f"],
]);

const POINT_MEMBERS: ReadonlySet<string> = new Set(["x", "y", "z", "w"]);

/** A new object a call makes, bound once where it is made. */
function made(lowerer: DataLowerer, cpp: string, type: DataType): Value {
    const context = lowerer.context;
    const name = context.allocateTemporaryCppName("dom_geometry");
    context.emit({
        kind: "declaration",
        type: `const ${context.dataTypes.cppType(type)}`,
        name,
        initializer: cpp,
    });
    return lowerer.leafValue(name, type);
}

/** `element.getScreenCTM()`: measured at the call; null outside the document. */
export function domScreenCtm(
    lowerer: DataLowerer,
    engine: string,
    element: string,
): Value {
    return made(lowerer, `bbl::ui_svg_screen_ctm(${engine}, ${element})`, {
        kind: "optional",
        inner: MATRIX,
    });
}

/** `svg.createSVGPoint()`: a new point at the origin. */
export function domPointOrigin(lowerer: DataLowerer): Value {
    return made(lowerer, "bbl::js::dom_point_origin()", POINT);
}

/** A matrix's `a`..`f` (and `m11`..`m42`) or a point's `x`, `y`, `z`, `w`. */
export function domGeometryProperty(
    lowerer: DataLowerer,
    owner: Value,
    property: string,
): Value | undefined {
    const kind = owner.dataType?.kind;
    const member =
        kind === "dom-matrix"
            ? MATRIX_MEMBERS.get(property)
            : kind === "dom-point" && POINT_MEMBERS.has(property)
              ? property
              : undefined;
    if (!member) return undefined;
    const read = lowerer.leafValue(`(${owner.cpp})->${member}`, {
        kind: "number",
    });
    // A point's components change where the program writes them.
    return kind === "dom-point" ? { ...read, impure: true } : read;
}

/** `matrix.inverse()` and `point.matrixTransform(matrix)`. */
export function compileDomGeometryMethod(
    lowerer: DataLowerer,
    call: ts.CallExpression,
    owner: Value,
    method: string,
): Value {
    const context = lowerer.context;
    const kind = owner.dataType?.kind;
    if (kind === "dom-matrix" && method === "inverse") {
        context.expectArgumentCount(call, 0, 0);
        return made(
            lowerer,
            `bbl::js::dom_matrix_inverse(${owner.cpp})`,
            MATRIX,
        );
    }
    if (kind === "dom-point" && method === "matrixTransform") {
        context.expectArgumentCount(call, 1, 1);
        const matrix = lowerer.narrowOptional(
            context.compileValue(call.arguments[0]!),
            call.arguments[0]!,
        );
        if (matrix.dataType?.kind !== "dom-matrix")
            return context.fail(
                call.arguments[0]!,
                "DOMPoint.matrixTransform requires a DOMMatrix; a DOMMatrixInit is not lowered.",
            );
        return made(
            lowerer,
            `bbl::js::dom_point_matrix_transform(${owner.cpp}, ${matrix.cpp})`,
            POINT,
        );
    }
    return context.fail(
        call,
        kind === "dom-matrix"
            ? `DOMMatrix.${method} is not lowered; inverse and its 2D members are.`
            : `DOMPoint.${method} is not lowered; matrixTransform and its components are.`,
    );
}

/** `point.x = value` (or `y`, `z`, `w`); undefined for other targets. */
export function compileDomPointAssignment(
    lowerer: DataLowerer,
    expression: ts.BinaryExpression,
): Value | undefined {
    const context = lowerer.context;
    const left = context.unwrap(expression.left);
    if (
        !ts.isPropertyAccessExpression(left) ||
        lowerer.dataTypeAt(left.expression)?.kind !== "dom-point"
    )
        return undefined;
    const property = left.name.text;
    if (!POINT_MEMBERS.has(property))
        return context.fail(
            left,
            `DOMPoint has no writable '${property}'; x, y, z and w are.`,
        );
    if (expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken)
        return context.fail(
            expression,
            "DOMPoint components support '=' assignments.",
        );
    const owner = context.bindings.pinValueToTemporary(
        lowerer.narrowOptional(
            context.compileValue(left.expression),
            left.expression,
        ),
        "dom_point",
    );
    const stored = context.allocateTemporaryCppName("dom_point_component");
    context.emit({
        kind: "declaration",
        type: "const double",
        name: stored,
        initializer: context.compileNumber(expression.right, "double"),
    });
    context.emit({
        kind: "expression",
        code: `(${owner.cpp})->${property} = ${stored};`,
    });
    return lowerer.leafValue(stored, { kind: "number" });
}
