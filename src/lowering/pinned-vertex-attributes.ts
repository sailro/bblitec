// The pinned per-instance vertex attribute rows the sprite families declare.
//
// Both the 2D layer (`sprite-pipeline.ts`'s `instanceAttributes`) and the
// billboard system (`billboard-pipeline.ts`'s pipeline `attributes`) state
// their instance layout as `GPUVertexAttribute` literals over named byte
// offset constants, and both render backends translate the emitted rows into
// their API's own descriptors. The literal is read and the table emitted
// here, once, so a moved slot or widened format fails generation for either
// family instead of drifting inside a second reader.
import ts from "typescript";
import type { LoweringContext } from "./context.js";

/** One per-instance vertex attribute, at the pin's own byte offset. */
export interface PinnedVertexAttribute {
    location: number;
    offsetBytes: number;
    floatCount: number;
}

/** The float lanes a pinned `float32`/`float32xN` vertex format carries. */
export function vertexFormatFloats(
    context: LoweringContext,
    format: string,
    at: ts.Node,
): number {
    const match = /^float32(?:x([234]))?$/.exec(format);
    if (!match) {
        return context.contractError(
            at,
            `Unsupported sprite attribute format '${format}'.`,
        );
    }
    return match[1] === undefined ? 1 : Number(match[1]);
}

/**
 * One `{ shaderLocation, offset: <NAMED_OFFSET>, format }` literal, with the
 * offset constant resolved in the literal's own module.
 */
export function pinnedVertexAttribute(
    context: LoweringContext,
    element: ts.Expression,
): PinnedVertexAttribute {
    const literal = context.unwrapExpression(element);
    if (!ts.isObjectLiteralExpression(literal)) {
        return context.contractError(
            literal,
            "Expected a pinned sprite attribute object literal.",
        );
    }
    const file = literal.getSourceFile();
    if (literal.properties.length !== 3) {
        context.contractError(
            literal,
            "Pinned sprite attribute must name shaderLocation, offset and format only.",
        );
    }
    const offset = context.unwrapExpression(
        context.propertyInitializer(literal, "offset"),
    );
    if (!ts.isIdentifier(offset)) {
        return context.contractError(
            offset,
            "Expected a named sprite offset constant.",
        );
    }
    const format = context.unwrapExpression(
        context.propertyInitializer(literal, "format"),
    );
    if (!ts.isStringLiteral(format)) {
        return context.contractError(
            format,
            "Expected a sprite attribute format string.",
        );
    }
    return {
        location: context.numericValue(
            context.propertyInitializer(literal, "shaderLocation"),
            file,
        ),
        offsetBytes: context.numericValue(
            context.variableInitializer(file, offset.text),
            file,
        ),
        floatCount: vertexFormatFloats(context, format.text, format),
    };
}

/**
 * Every row of a pinned attribute array, which must tile `instanceFloats`
 * exactly: the last attribute ends where the family's floats-per-sprite says
 * the instance does, or the two pinned modules disagree.
 */
export function pinnedVertexAttributeRows(
    context: LoweringContext,
    array: ts.Expression,
    instanceFloats: number,
): PinnedVertexAttribute[] {
    const literal = context.unwrapExpression(array);
    if (!ts.isArrayLiteralExpression(literal)) {
        return context.contractError(
            literal,
            "Expected a pinned vertex attribute array literal.",
        );
    }
    const rows = literal.elements.map((element) =>
        pinnedVertexAttribute(context, element),
    );
    const lastEnd = rows.reduce(
        (max, row) => Math.max(max, row.offsetBytes + row.floatCount * 4),
        0,
    );
    if (lastEnd !== instanceFloats * 4) {
        context.contractError(
            literal,
            `Pinned sprite attributes end at ${lastEnd} bytes, expected ${instanceFloats * 4}.`,
        );
    }
    return rows;
}

/** One row as the C++ aggregate both families' attribute structs declare. */
export function vertexAttributeCpp(row: PinnedVertexAttribute): string {
    return `${row.location}u, ${row.offsetBytes}u, ${row.floatCount}u`;
}

/** A family's whole attribute table, as the `constexpr` array it binds. */
export function vertexAttributeTableCpp(
    elementType: string,
    name: string,
    rows: readonly PinnedVertexAttribute[],
): string {
    return `inline constexpr std::array<${elementType}, ${rows.length}>
    ${name}{{
${rows.map((row) => `        {${vertexAttributeCpp(row)}},`).join("\n")}
    }};`;
}
