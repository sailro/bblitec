/**
 * WGSL host-shareable layout: where each member of a uniform block lands.
 *
 * The one statement of the rule. The compiler mirrors composed uniform blocks
 * into C++ through it, the shader IR lays out a program's custom uniforms
 * through it, and the capture decoders read browser buffers through it, so a
 * stride fix reaches generation and diagnosis at once. It reads types as the
 * typed WGSL front end (`parseWgslType` in `shader-ir.ts`) reflects them, never
 * as spellings.
 */

/** A WGSL type as the layout rule reads it: its name and template arguments. */
export interface WgslTypeShape {
    name: string;
    /** Nested types, or an element count written as an integer literal. */
    arguments: ReadonlyArray<WgslTypeShape | number>;
}

export interface WgslLayout {
    size: number;
    align: number;
}

/** WGSL's scalar and vector shorthands, as the element type they abbreviate. */
const shorthandVectors: Readonly<
    Record<string, { components: number; element: string }>
> = {
    vec2f: { components: 2, element: "f32" },
    vec3f: { components: 3, element: "f32" },
    vec4f: { components: 4, element: "f32" },
    vec2i: { components: 2, element: "i32" },
    vec3i: { components: 3, element: "i32" },
    vec4i: { components: 4, element: "i32" },
    vec2u: { components: 2, element: "u32" },
    vec3u: { components: 3, element: "u32" },
    vec4u: { components: 4, element: "u32" },
};

const scalars = new Set(["f32", "i32", "u32"]);

function vectorComponents(name: string): 2 | 3 | 4 | undefined {
    return name === "vec2"
        ? 2
        : name === "vec3"
          ? 3
          : name === "vec4"
            ? 4
            : undefined;
}

/** A vector's component count and element type, or undefined. */
export function wgslVector(
    type: WgslTypeShape,
): { components: number; element: string } | undefined {
    const shorthand = shorthandVectors[type.name];
    if (shorthand && type.arguments.length === 0) return shorthand;
    const components = vectorComponents(type.name);
    const element = type.arguments[0];
    if (
        components === undefined ||
        type.arguments.length !== 1 ||
        typeof element !== "object" ||
        element.arguments.length !== 0 ||
        !scalars.has(element.name)
    ) {
        return undefined;
    }
    return { components, element: element.name };
}

/** A float matrix's column and row counts, or undefined. */
export function wgslMatrix(
    type: WgslTypeShape,
): { columns: number; rows: number } | undefined {
    const shorthand =
        type.arguments.length === 0 && type.name.endsWith("f")
            ? type.name.slice(0, -1)
            : undefined;
    const name = shorthand ?? type.name;
    if (name.length !== 6 || !name.startsWith("mat") || name[4] !== "x") {
        return undefined;
    }
    const columns = Number(name[3]);
    const rows = Number(name[5]);
    if (![2, 3, 4].includes(columns) || ![2, 3, 4].includes(rows))
        return undefined;
    if (shorthand === undefined) {
        const element = type.arguments[0];
        if (
            type.arguments.length !== 1 ||
            typeof element !== "object" ||
            element.name !== "f32" ||
            element.arguments.length !== 0
        ) {
            return undefined;
        }
    }
    return { columns, rows };
}

export function roundUp(alignment: number, value: number): number {
    return Math.ceil(value / alignment) * alignment;
}

/**
 * The uniform-address-space size and alignment of a type a composed Babylon
 * Lite block declares. Anything else is reported as unknown rather than
 * guessed, because a wrong stride silently shifts every later field.
 */
export function layoutOf(type: WgslTypeShape): WgslLayout | undefined {
    if (type.arguments.length === 0 && scalars.has(type.name))
        return { size: 4, align: 4 };
    const vector = wgslVector(type);
    if (vector) {
        return vector.components === 3
            ? { size: 12, align: 16 }
            : { size: vector.components * 4, align: vector.components * 4 };
    }
    const matrix = wgslMatrix(type);
    if (matrix) {
        const columnStride = matrix.rows === 3 ? 16 : matrix.rows * 4;
        return { size: matrix.columns * columnStride, align: 16 };
    }
    const [element, count] = type.arguments;
    if (
        type.name === "array" &&
        type.arguments.length === 2 &&
        typeof element === "object" &&
        typeof count === "number"
    ) {
        const elementLayout = layoutOf(element);
        if (!elementLayout) return undefined;
        // Uniform arrays round their stride up to 16.
        const align = Math.max(elementLayout.align, 16);
        return {
            size: roundUp(align, elementLayout.size) * count,
            align,
        };
    }
    return undefined;
}

/**
 * Member offsets of a struct, its size rounded to its own alignment, and the
 * extent its last member ends at. A member of unknown layout makes the whole
 * struct unknown.
 */
export function fieldOffsets(
    fields: ReadonlyArray<{ type: WgslTypeShape }>,
): { offsets: number[]; size: number; extent: number } | undefined {
    let offset = 0;
    let maxAlign = 1;
    const offsets: number[] = [];
    for (const field of fields) {
        const layout = layoutOf(field.type);
        if (!layout) return undefined;
        offset = roundUp(layout.align, offset);
        offsets.push(offset);
        offset += layout.size;
        maxAlign = Math.max(maxAlign, layout.align);
    }
    return { offsets, size: roundUp(maxAlign, offset), extent: offset };
}
