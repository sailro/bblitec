/**
 * `createGridMaterial`, folded at generation.
 *
 * The pin's grid is a ShaderMaterial: `createGridMaterial` resolves its
 * options, builds its two stages from pure template functions at the
 * resolved option set, and hands them to `createShaderMaterial` with the
 * three system matrices and the five typed uniforms it computes from the
 * options. Generation runs that factory over the scene's own static options
 * and registers the ShaderMaterial it returned as a reached shader program,
 * one per source and state permutation; each material then carries the
 * uniform values the pin computed and normalized. The native shader-material
 * family draws it, so nothing here restates the grid: its sources, uniform
 * layout, blend, culling and depth state are the factory's own.
 */
import { createHash } from "node:crypto";
import ts from "typescript";
import { pinnedModuleExport } from "../lowering/pinned-shader-builders.js";
import { isShaderSystemMatrix } from "../shader-ir.js";
import { shaderUniformValueLayout } from "../shader-material-programs.js";
import { validateObjectProperties } from "./option-helpers.js";
import {
    reachFoldedShaderProgram,
    type ShaderMaterialContext,
} from "./shader-material.js";
import type { CompiledShaderProgram } from "./types.js";

const gridModule = "src/material/grid/grid-material.ts";

/** One grid material as the scene reached it. */
export interface ReachedGridMaterial {
    name: string;
    id: number;
    /** Each custom uniform's normalized value, at its value-layout offset. */
    uniforms: ReadonlyArray<{ offset: number; values: readonly number[] }>;
}

/** The option keys whose values are numbers, booleans and triples. */
const numberOptions = [
    "gridRatio",
    "majorUnitFrequency",
    "minorUnitVisibility",
    "opacity",
    "visibility",
] as const;
const booleanOptions = [
    "antialias",
    "preMultiplyAlpha",
    "useMaxLine",
    "backFaceCulling",
] as const;
const tripleOptions = ["mainColor", "lineColor", "gridOffset"] as const;

/**
 * The scene's options object, evaluated at generation. The factory builds
 * its sources and computes its uniform values from every one of them, so
 * each must be static; `opacityTexture` binds a runtime texture through
 * `setShaderTexture`, which the fold does not carry.
 */
function staticGridOptions(
    context: ShaderMaterialContext,
    expression: ts.Expression,
): Record<string, unknown> {
    const object = context.expectObjectLiteral(expression);
    validateObjectProperties(
        context,
        object,
        ["name", ...numberOptions, ...booleanOptions, ...tripleOptions],
        "Grid material options fold at generation: name, colors, spacing, offset, line frequency and visibility, opacity, antialiasing, premultiplication, max-line composition, visibility and culling, each static; an opacity texture is not supported.",
    );
    const options: Record<string, unknown> = {};
    const name = context.objectProperty(object, "name");
    if (name) options.name = context.compileStaticString(name);
    for (const key of numberOptions) {
        const property = context.objectProperty(object, key);
        if (!property) continue;
        options[key] = staticGridNumber(context, property, key);
    }
    for (const key of booleanOptions) {
        const property = context.objectProperty(object, key);
        if (!property) continue;
        const value = context.compileValue(property).staticBoolean;
        if (value === undefined) {
            context.fail(
                property,
                `GridMaterial option '${key}' must be a static boolean; the pinned factory selects its sources and state from it at generation.`,
            );
        }
        options[key] = value;
    }
    for (const key of tripleOptions) {
        const property = context.objectProperty(object, key);
        if (!property) continue;
        const resolved = context.resolveStaticExpression(property);
        if (
            !ts.isArrayLiteralExpression(resolved) ||
            resolved.elements.length !== 3
        ) {
            context.fail(
                property,
                `GridMaterial option '${key}' must be a static three-component array.`,
            );
        }
        options[key] = resolved.elements.map((element) =>
            staticGridNumber(context, element, key),
        );
    }
    return options;
}

function staticGridNumber(
    context: ShaderMaterialContext,
    expression: ts.Expression,
    key: string,
): number {
    const value = context.compileValue(expression).staticNumber;
    if (value === undefined) {
        context.fail(
            expression,
            `GridMaterial option '${key}' must be a static number; the pinned factory computes its uniform values from it at generation.`,
        );
    }
    return value;
}

function member(value: unknown, key: string): unknown {
    return typeof value === "object" && value !== null
        ? Reflect.get(value, key)
        : undefined;
}

function refuse(what: string): never {
    throw new Error(`Pinned createGridMaterial ${what}.`);
}

function stringMember(value: unknown, key: string): string {
    const found = member(value, key);
    if (typeof found !== "string") refuse(`no longer returns a string ${key}`);
    return found;
}

function booleanMember(value: unknown, key: string): boolean {
    const found = member(value, key);
    if (typeof found !== "boolean") {
        refuse(`no longer returns a boolean ${key}`);
    }
    return found;
}

function emptyList(value: unknown, key: string): void {
    const found = member(value, key);
    if (!Array.isArray(found) || found.length !== 0) {
        refuse(`returns ${key}, which the fold does not carry`);
    }
}

interface FoldedUniform {
    signature: string;
    name: string;
    values?: readonly number[];
}

/**
 * The ShaderMaterial's uniforms as the program declares them -- a system
 * matrix by its bare name, a typed uniform as `name:type` -- with each typed
 * one's value from the material's own normalized slot.
 */
function foldedUniforms(material: unknown): FoldedUniform[] {
    const declarations = member(material, "uniformDecls");
    const slots = member(material, "_uniformValues");
    if (!Array.isArray(declarations) || !(slots instanceof Map)) {
        refuse("no longer returns its uniform declarations and values");
    }
    return declarations.map((declaration: unknown) => {
        const name = stringMember(declaration, "name");
        const type = stringMember(declaration, "type");
        if (
            isShaderSystemMatrix(name) &&
            member(declaration, "defaultValue") === undefined
        ) {
            return { signature: name, name };
        }
        const value = member(slots.get(name), "value");
        if (!(value instanceof Float32Array)) {
            refuse(`no longer normalizes a value for '${name}'`);
        }
        return { signature: `${name}:${type}`, name, values: [...value] };
    });
}

/** Runs the pinned factory and reads back the ShaderMaterial it built. */
function foldGridMaterial(options: Record<string, unknown>): {
    program: Omit<CompiledShaderProgram, "name">;
    uniforms: FoldedUniform[];
} {
    const material = pinnedModuleExport(
        gridModule,
        "createGridMaterial",
    )(options);
    for (const key of ["samplerDecls", "storageBufferDecls", "defines"]) {
        emptyList(material, key);
    }
    const attributes = member(material, "attributes");
    if (
        !Array.isArray(attributes) ||
        !attributes.every(
            (attribute): attribute is string => typeof attribute === "string",
        )
    ) {
        refuse("no longer returns its attribute list");
    }
    const blendMode = stringMember(material, "blendMode");
    if (blendMode !== "alpha" && blendMode !== "additive") {
        refuse(`blends in mode '${blendMode}'`);
    }
    // The factory passes no compare, so the material carries the pin's own
    // pass default -- which is what an absent compare means here.
    if (stringMember(material, "depthCompare") !== "greater-equal") {
        refuse("no longer takes the pass's default depth compare");
    }
    if (
        booleanMember(material, "transmissive") ||
        member(material, "_topology") !== undefined
    ) {
        refuse("no longer builds a plain triangle-list material");
    }
    const uniforms = foldedUniforms(material);
    return {
        program: {
            vertexSource: stringMember(material, "vertexSource"),
            fragmentSource: stringMember(material, "fragmentSource"),
            attributes,
            uniforms: uniforms.map(({ signature }) => signature),
            uniformDefaults: [],
            samplers: [],
            samplerDeclarations: [],
            storageBuffers: [],
            defines: [],
            needAlphaBlending: booleanMember(material, "needAlphaBlending"),
            blendMode,
            needAlphaTesting: booleanMember(material, "needAlphaTesting"),
            backFaceCulling: booleanMember(material, "backFaceCulling"),
            depthWrite: booleanMember(material, "depthWrite"),
        },
        uniforms,
    };
}

/**
 * Registers the grid a `createGridMaterial` call built: one program per
 * source and state permutation, named by that identity, and the material's
 * own uniform values at their offsets.
 */
export function reachGridMaterial(
    context: ShaderMaterialContext,
    call: ts.CallExpression,
    optionsExpression: ts.Expression | undefined,
): ReachedGridMaterial {
    const options = optionsExpression
        ? staticGridOptions(context, optionsExpression)
        : {};
    let folded: ReturnType<typeof foldGridMaterial>;
    try {
        folded = foldGridMaterial(options);
    } catch (error: unknown) {
        context.fail(
            call,
            error instanceof Error ? error.message : String(error),
        );
    }
    const name = `grid-material-${createHash("sha256")
        .update(JSON.stringify(folded.program))
        .digest("hex")
        .slice(0, 12)}`;
    const reached = reachFoldedShaderProgram(
        context,
        call,
        name,
        "grid",
        () => ({
            name,
            ...folded.program,
        }),
    );
    const layout = shaderUniformValueLayout(folded.program.uniforms);
    return {
        ...reached,
        uniforms: folded.uniforms.flatMap(({ name: uniform, values }) => {
            const entry = layout.get(uniform);
            return values && entry ? [{ offset: entry.offset, values }] : [];
        }),
    };
}
