// The line-system family: `createLineMaterial`, `createLineSystem`,
// `updateLineSystem`.
//
// A polyline system is an ordinary mesh drawn by an ordinary
// `ShaderMaterial`, so nothing here builds a renderer: the geometry goes
// through the generated flatten and `createMeshFromData`, and the material
// is the program `line-material.ts` composes, registered as a scene-local
// shader variant like any other. What the compiler owns is the reach — which
// permutation each call settles, and which shapes refuse.
import ts from "typescript";
import type {
    LineMaterialPermutation,
    ReachedLineMaterial,
} from "../line-material.js";
import type { Value } from "../types.js";
import type { IntrinsicCallContext } from "./context.js";
import {
    staticNumberValue,
    validateObjectProperties,
    type ObjectValidationContext,
    type PositiveIntegerContext,
} from "../option-helpers.js";

export interface LineIntrinsicContext
    extends IntrinsicCallContext,
        ObjectValidationContext,
        PositiveIntegerContext {
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
    compileVec3(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
    compileColor4(expression: ts.Expression): string;
    compileBoolean(expression: ts.Expression): string;
    compileStringLiteral(expression: ts.Expression): string;
    cppString(value: string): string;
    requireDefaultEngine(node: ts.Node): string;
    reachLineMaterial(
        node: ts.Node,
        options: ReachedLineMaterial,
    ): { name: string; id: number };
    lineMaterialPermutation(
        name: string,
        node: ts.Node,
    ): LineMaterialPermutation | undefined;
}

/** The options a reached `createLineMaterial` may name. */
const LINE_MATERIAL_OPTIONS = [
    "name",
    "color",
    "useVertexColor",
    "useVertexAlpha",
    "useThinInstances",
    "useThinInstanceColors",
    "depthWrite",
] as const;

/** The `createLineSystem` options that describe geometry rather than material. */
const GEOMETRY_OPTIONS = ["name", "lines", "colors", "material"] as const;

/** The options a reached `createLineSystem` may name. */
const LINE_SYSTEM_OPTIONS = [
    "name",
    "lines",
    "colors",
    "color",
    "useVertexAlpha",
    "useThinInstances",
    "useThinInstanceColors",
    "material",
] as const;

export function compileLineIntrinsic(
    context: LineIntrinsicContext,
    importedName: string,
    call: ts.CallExpression,
): Value | undefined {
    switch (importedName) {
        case "createLineMaterial": {
            context.recordSceneMaterialSlot();
            context.expectArgumentCount(call, 0, 1);
            const engine = context.requireDefaultEngine(call);
            const options = call.arguments[0]
                ? context.expectObjectLiteral(call.arguments[0]!)
                : undefined;
            if (options) {
                validateObjectProperties(
                    context,
                    options,
                    [...LINE_MATERIAL_OPTIONS],
                    "Reached line materials support name, color, vertex-colour and vertex-alpha state, thin instances and depthWrite.",
                );
                requireStaticName(context, options);
            }
            const flags = lineMaterialFlags(context, options);
            const variant = context.reachLineMaterial(call, flags);
            reachLineFeatures(context, call);
            return {
                kind: "material",
                cpp:
                    `bbl::create_shader_material(${engine}, ` +
                    `${variant.id}u)`,
                engineCpp: engine,
                shaderVariant: variant.name,
            };
        }

        case "createLineSystem": {
            context.expectArgumentCount(call, 2, 2);
            const engine = context.compileValue(call.arguments[0]!);
            context.expectKind(engine, "engine", call.arguments[0]!);
            const options = context.expectObjectLiteral(call.arguments[1]!);
            validateObjectProperties(
                context,
                options,
                [...LINE_SYSTEM_OPTIONS],
                "Reached line systems support name, lines, colors, color, vertex alpha, thin instances and a material.",
            );
            const meshName = staticNameOption(context, options);
            const { lines, colors } = compileGeometry(
                context,
                options,
                "A line system requires its `lines`.",
            );

            const supplied = context.objectProperty(options, "material");
            let variantName: string;
            let materialCpp: string;
            if (supplied) {
                // Everything the material itself settles: the system's own
                // options minus the ones that describe its geometry.
                for (const owned of LINE_SYSTEM_OPTIONS.filter(
                    (option) =>
                        !GEOMETRY_OPTIONS.includes(
                            option as (typeof GEOMETRY_OPTIONS)[number],
                        ),
                )) {
                    if (context.objectProperty(options, owned)) {
                        context.fail(
                            options,
                            `A line system given a \`material\` cannot also set \`${owned}\`; the material owns it.`,
                        );
                    }
                }
                const material = context.compileValue(supplied);
                context.expectKind(material, "material", supplied);
                if (!material.shaderVariant) {
                    context.fail(
                        supplied,
                        "A line system's material comes from createLineMaterial.",
                    );
                }
                variantName = material.shaderVariant;
                materialCpp = material.cpp;
            } else {
                const flags = {
                    ...lineMaterialFlags(context, options),
                    // `createLineSystem` infers the vertex-colour fork from
                    // the geometry rather than taking it as an option.
                    useVertexColor: colors !== undefined,
                };
                const variant = context.reachLineMaterial(options, flags);
                variantName = variant.name;
                materialCpp =
                    `bbl::create_shader_material(${engine.cpp}, ` +
                    `${variant.id}u)`;
                context.recordSceneMaterialSlot();
            }
            const permutation = context.lineMaterialPermutation(
                variantName,
                supplied ?? options,
            );
            if (!permutation) {
                context.fail(
                    supplied ?? options,
                    "A line system's material comes from createLineMaterial.",
                );
            }
            if (permutation.useVertexColor !== (colors !== undefined)) {
                // The pin throws this at load; the compiler knows both
                // halves, so it refuses here instead.
                context.fail(
                    supplied ?? options,
                    "createLineSystem requires material.useVertexColor to match the line color-buffer layout.",
                );
            }
            context.recordSceneMesh("from-data", {
                hasUv2: false,
                hasTangents: false,
                hasColors: colors !== undefined,
            });
            reachLineFeatures(context, call);
            context.reachFeature("mesh:from-data", call);
            return {
                kind: "mesh",
                cpp:
                    `bbl::create_line_system(${engine.cpp}, ` +
                    `${context.cppString(meshName)}, ` +
                    `${lines.cpp}, ${colors?.cpp ?? "{}"}, ` +
                    `${materialCpp})`,
                engineCpp: engine.engineCpp ?? engine.cpp,
            };
        }

        case "updateLineSystem": {
            context.expectArgumentCount(call, 3, 3);
            const engine = context.compileValue(call.arguments[0]!);
            context.expectKind(engine, "engine", call.arguments[0]!);
            const mesh = context.compileValue(call.arguments[1]!);
            context.expectKind(mesh, "mesh", call.arguments[1]!);
            const options = context.expectObjectLiteral(call.arguments[2]!);
            validateObjectProperties(
                context,
                options,
                ["lines", "colors"],
                "A line-system update supports lines and colors.",
            );
            const { lines, colors } = compileGeometry(
                context,
                options,
                "A line-system update requires its `lines`.",
            );
            reachLineFeatures(context, call);
            return {
                kind: "void",
                cpp:
                    `bbl::update_line_system(${engine.cpp}, ${mesh.cpp}, ` +
                    `${lines.cpp}, ${colors?.cpp ?? "{}"})`,
            };
        }

        default:
            return undefined;
    }
}

/**
 * The polylines and their optional per-point colours, which
 * `createLineSystem` and `updateLineSystem` read the same way — the update
 * differing only in what it calls a missing `lines`.
 */
function compileGeometry(
    context: LineIntrinsicContext,
    options: ts.ObjectLiteralExpression,
    missing: string,
): { lines: { cpp: string; counts: number[] }; colors?: { cpp: string } } {
    const linesExpression = context.objectProperty(options, "lines");
    if (!linesExpression) {
        context.fail(options, missing);
    }
    const lines = compileLines(context, linesExpression);
    const colorsExpression = context.objectProperty(options, "colors");
    return {
        lines,
        ...(colorsExpression
            ? {
                  colors: compileColors(
                      context,
                      colorsExpression,
                      lines.counts,
                  ),
              }
            : {}),
    };
}

/**
 * The `name` a call may pass. It reaches nothing native — the pin uses it
 * as its shader-module label, and this port's variant identity is the
 * permutation instead — but a name built at run time is refused rather
 * than dropped.
 */
function requireStaticName(
    context: LineIntrinsicContext,
    options: ts.ObjectLiteralExpression,
): void {
    const name = context.objectProperty(options, "name");
    if (name) {
        context.compileStringLiteral(name);
    }
}

/**
 * The mesh name a line system carries: the static `name` option, or the
 * pinned `options.name ?? "lineSystem"` fallback the lowering asserts in
 * the whole createMeshFromData call shape.
 */
function staticNameOption(
    context: LineIntrinsicContext,
    options: ts.ObjectLiteralExpression,
): string {
    const name = context.objectProperty(options, "name");
    return name ? context.compileStringLiteral(name) : "lineSystem";
}

/** Every line scene compiles the generated flatten and draws it. */
function reachLineFeatures(
    context: LineIntrinsicContext,
    call: ts.CallExpression,
): void {
    context.reachFeature("mesh:lines", call);
    context.reachFeature("material:shader", call);
    context.reachFeature("renderer:pbr", call);
}

/**
 * The permutation flags a reached options literal settles, each resolved
 * through the pin's own default.
 */
function lineMaterialFlags(
    context: LineIntrinsicContext,
    options: ts.ObjectLiteralExpression | undefined,
): {
    useVertexColor: boolean;
    useVertexAlpha: boolean;
    useThinInstances: boolean;
    useThinInstanceColors: boolean;
    color?: [number, number, number, number];
    depthWrite?: boolean;
} {
    const flag = (name: string, fallback: boolean): boolean => {
        const expression = options
            ? context.objectProperty(options, name)
            : undefined;
        if (!expression) {
            return fallback;
        }
        return context.compileBoolean(expression) === "true";
    };
    const useThinInstances = flag("useThinInstances", false);
    const useThinInstanceColors = flag("useThinInstanceColors", false);
    if (useThinInstanceColors && !useThinInstances) {
        context.fail(
            options!,
            "createLineMaterial requires useThinInstances when useThinInstanceColors is enabled.",
        );
    }
    const colorExpression = options
        ? context.objectProperty(options, "color")
        : undefined;
    const depthWriteExpression = options
        ? context.objectProperty(options, "depthWrite")
        : undefined;
    return {
        useVertexColor: flag("useVertexColor", false),
        useVertexAlpha: flag("useVertexAlpha", true),
        useThinInstances,
        useThinInstanceColors,
        ...(colorExpression
            ? { color: staticColor4(context, colorExpression) }
            : {}),
        ...(depthWriteExpression
            ? {
                  depthWrite:
                      context.compileBoolean(depthWriteExpression) ===
                      "true",
              }
            : {}),
    };
}

/**
 * The scene's own polylines, materialized as the nested C++ data the
 * generated flatten reads. The points are the scene's literals — the
 * flatten over them stays the pin's.
 */
function compileLines(
    context: LineIntrinsicContext,
    expression: ts.Expression,
): { cpp: string; counts: number[] } {
    const lines = context.expectStaticArrayLiteral(expression);
    const counts: number[] = [];
    const rows = lines.elements.map((line) => {
        const points = context.expectStaticArrayLiteral(line);
        counts.push(points.elements.length);
        return `{${points.elements
            .map((point) => context.compileVec3(point))
            .join(", ")}}`;
    });
    return {
        cpp: `std::vector<std::vector<bbl::Vec3>>{${rows.join(", ")}}`,
        counts,
    };
}

/** The per-point RGBA rows, checked against the line rows the way the pin checks them. */
function compileColors(
    context: LineIntrinsicContext,
    expression: ts.Expression,
    lineCounts: readonly number[],
): { cpp: string } {
    const colors = context.expectStaticArrayLiteral(expression);
    if (colors.elements.length !== lineCounts.length) {
        context.fail(
            expression,
            "Line system data requires one color row per line.",
        );
    }
    const rows = colors.elements.map((row, index) => {
        const values = context.expectStaticArrayLiteral(row);
        if (values.elements.length !== lineCounts[index]) {
            context.fail(
                row,
                "Line system data requires one color per point.",
            );
        }
        return `{${values.elements
            .map((color) => color4AsVec4(context.compileColor4(color)))
            .join(", ")}}`;
    });
    return {
        cpp: `std::vector<std::vector<bbl::Vec4>>{${rows.join(", ")}}`,
    };
}

/**
 * A `Color4` literal as the `Vec4` the flatten stores. The generated buffer
 * is RGBA floats either way; the compiler's own colour compiler is what
 * resolves the literal, so only the type word changes.
 */
function color4AsVec4(color: string): string {
    return color.replace(/^bbl::Color4\{/, "bbl::Vec4{");
}

/** A `color` literal, resolved to the four floats the variant defaults carry. */
function staticColor4(
    context: LineIntrinsicContext,
    expression: ts.Expression,
): [number, number, number, number] {
    const literal = context.resolveStaticExpression(expression);
    if (!ts.isObjectLiteralExpression(literal)) {
        context.fail(
            expression,
            "Expected a line color object { r, g, b, a }.",
        );
    }
    return ["r", "g", "b", "a"].map((channel) => {
        const property = context.objectProperty(literal, channel);
        if (!property) {
            context.fail(
                literal,
                `Expected a line color '${channel}' channel.`,
            );
        }
        const value = staticNumberValue(context, property);
        if (value === undefined) {
            context.fail(
                property,
                `Expected a static line color '${channel}' channel.`,
            );
        }
        return value;
    }) as [number, number, number, number];
}
