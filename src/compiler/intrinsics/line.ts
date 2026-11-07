import type { LoweringServices } from "../lowering-services.js";
// The line-system family: `createLineMaterial`, `createLineSystem`,
// `updateLineSystem`.
//
// A polyline system is an ordinary mesh drawn by an ordinary
// `ShaderMaterial`, so nothing here builds a renderer: the geometry goes
// through the generated flatten and `createMeshFromData`, and the material
// is the program `line-material.ts` composes, registered as a scene-local
// shader variant like any other. What the compiler owns is the reach — which
// permutation each call settles, and which shapes refuse.
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
import { argumentAt } from "../syntax.js";
import type { Value } from "../types.js";
import type { DataType } from "../data-types.js";
import type { IntrinsicCallContext } from "./context.js";
import {
    staticNumberValue,
    validateObjectProperties,
    type ObjectValidationContext,
    type PositiveIntegerContext,
} from "../option-helpers.js";
import { knownCondition } from "../values/model.js";
import { resolvedLineColor } from "../line-material.js";
import { floatLiteral } from "../../cpp-literals.js";

export interface LineIntrinsicContext
    extends
        IntrinsicCallContext,
        ObjectValidationContext,
        PositiveIntegerContext,
        Pick<
            LoweringServices,
            | "expectObjectLiteral"
            | "expectStaticArrayLiteral"
            | "probeStaticArrayLiteral"
            | "compileValue"
            | "checker"
            | "dataTypes"
            | "dataLowerer"
            | "executedModuleConstantElements"
            | "objectProperty"
            | "compileVec3"
            | "vec3FromRecord"
            | "compileColor4"
            | "compileBoolean"
            | "compileStringLiteral"
            | "cppString"
            | "requireDefaultEngine"
            | "intrinsicOptions"
        > {}

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
            context.sceneManifest.recordSceneMaterialSlot();
            context.expectArgumentCount(call, 0, 1);
            const engine = context.requireDefaultEngine(call);
            const options = call.arguments[0]
                ? context.expectObjectLiteral(argumentAt(call, 0))
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
            const variant = context.intrinsicOptions.reachLineMaterial(
                call,
                flags,
            );
            reachLineFeatures(context, call);
            const created = `bbl::create_shader_material(${engine}, ${variant.id}u)`;
            // A permutation's program carries the colour of the material that
            // registered it; another material of it sets its own, as each
            // pinned material holds its own `lineColor` uniform.
            const registered = context.sceneManifest
                .reachedShaderProgram(variant.name, call)
                .uniformDefaults.find(({ name }) => name === "lineColor");
            const color = resolvedLineColor(flags.color);
            const own =
                registered !== undefined &&
                registered.values.some(
                    (value, index) => value !== color[index],
                );
            const slot = own
                ? context.intrinsicOptions.resolveShaderUniform(
                      {
                          kind: "material",
                          cpp: "material",
                          engineCpp: engine,
                          shaderVariant: variant.name,
                      },
                      call,
                      [4],
                      "lineColor",
                  )
                : undefined;
            return {
                kind: "material",
                cpp: slot
                    ? `[&] { const auto material = ${created}; bbl::set_shader_uniform_value(${engine}, material, ${slot.offset}u, ${color.map((component) => `${floatLiteral(component)}`).join(", ")}); return material; }()`
                    : created,
                engineCpp: engine,
                shaderVariant: variant.name,
            };
        }

        case "createLineSystem":
            return compileLineSystem(context, call, LINE_SYSTEM_SHAPE);

        case "createLines":
            return compileLineSystem(context, call, LINES_SHAPE);

        case "updateLineSystem": {
            context.expectArgumentCount(call, 3, 3);
            const engine = context.compileValue(argumentAt(call, 0));
            context.expectKind(engine, "engine", argumentAt(call, 0));
            const mesh = context.compileValue(argumentAt(call, 1));
            context.expectKind(mesh, "mesh", argumentAt(call, 1));
            const options = context.expectObjectLiteral(argumentAt(call, 2));
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
 * What a line-system call names its geometry and defaults: `createLines`
 * is the pin's one polyline through `createLineSystem`, its `points` the
 * one row of `lines` and its `colors` the one row of colours.
 */
interface LineSystemShape {
    readonly options: readonly string[];
    readonly supported: string;
    readonly missing: string;
    readonly name: string;
    readonly points: boolean;
}

const LINE_SYSTEM_SHAPE: LineSystemShape = {
    options: LINE_SYSTEM_OPTIONS,
    supported:
        "Reached line systems support name, lines, colors, color, vertex alpha, thin instances and a material.",
    missing: "A line system requires its `lines`.",
    name: "lineSystem",
    points: false,
};

const LINES_SHAPE: LineSystemShape = {
    options: LINE_SYSTEM_OPTIONS.map((option) =>
        option === "lines" ? "points" : option,
    ),
    supported:
        "Reached lines support name, points, colors, color, vertex alpha, thin instances and a material.",
    missing: "Lines require their `points`.",
    name: "lines",
    points: true,
};

/** `createLineSystem`, or `createLines` through it. */
function compileLineSystem(
    context: LineIntrinsicContext,
    call: ts.CallExpression,
    shape: LineSystemShape,
): Value {
    context.expectArgumentCount(call, 2, 2);
    const engine = context.compileValue(argumentAt(call, 0));
    context.expectKind(engine, "engine", argumentAt(call, 0));
    const options = context.expectObjectLiteral(argumentAt(call, 1));
    validateObjectProperties(
        context,
        options,
        [...shape.options],
        shape.supported,
    );
    const meshName = staticNameOption(context, options, shape.name);
    const { lines, colors } = compileGeometry(
        context,
        options,
        shape.missing,
        shape.points,
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
        const variant = context.intrinsicOptions.reachLineMaterial(
            options,
            flags,
        );
        variantName = variant.name;
        materialCpp =
            `bbl::create_shader_material(${engine.cpp}, ` + `${variant.id}u)`;
        context.sceneManifest.recordSceneMaterialSlot();
    }
    const permutation = context.intrinsicOptions.lineMaterialPermutation(
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
    const sceneMeshIndex = context.sceneManifest.recordSceneMesh("from-data", {
        hasUv2: false,
        hasTangents: false,
        hasColors: colors !== undefined,
    });
    reachLineFeatures(context, call);
    context.reachFeature("mesh:from-data", call);
    return {
        kind: "mesh",
        sceneMeshIndex,
        cpp:
            `bbl::create_line_system(${engine.cpp}, ` +
            `${context.cppString(meshName)}, ` +
            `${lines.cpp}, ${colors?.cpp ?? "{}"}, ` +
            `${materialCpp})`,
        engineCpp: engine.engineCpp ?? engine.cpp,
    };
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
    points = false,
): {
    lines: { cpp: string; counts?: number[] };
    colors?: { cpp: string };
} {
    const linesExpression = context.objectProperty(
        options,
        points ? "points" : "lines",
    );
    if (!linesExpression) {
        context.fail(options, missing);
    }
    const lines = compileLines(context, linesExpression, points);
    const colorsExpression = context.objectProperty(options, "colors");
    if (colorsExpression && !lines.counts)
        context.fail(
            colorsExpression,
            "Line colours need their lines' point counts known at generation.",
        );
    return {
        lines,
        ...(colorsExpression
            ? {
                  colors: compileColors(
                      context,
                      colorsExpression,
                      lines.counts!,
                      points,
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
    fallback = "lineSystem",
): string {
    const name = context.objectProperty(options, "name");
    return name ? context.compileStringLiteral(name) : fallback;
}

/** Every line scene compiles the generated flatten and draws it. */
function reachLineFeatures(
    context: LineIntrinsicContext,
    call: ts.CallExpression,
): void {
    context.reachFeature("mesh:lines", call);
    context.reachFeature("material:shader", call);
    context.reachFeature("renderer:scene", call);
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
        return knownCondition(context.compileBoolean(expression)) === true;
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
                      knownCondition(
                          context.compileBoolean(depthWriteExpression),
                      ) === true,
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
    points = false,
): { cpp: string; counts?: number[] } {
    if (points) {
        const row = context.probeStaticArrayLiteral(expression);
        if (!row) return runtimeLines(context, expression, true);
        return {
            cpp: `std::vector<std::vector<bbl::Vec3>>{{${row.elements
                .map((point) => context.compileVec3(point, "float"))
                .join(", ")}}}`,
            counts: [row.elements.length],
        };
    }
    // A realm may own an immutable module array as native data. Reuse the
    // compiler's mutation-checked constant execution for its static geometry.
    const executed = context.executedModuleConstantElements(expression);
    if (executed) {
        const counts: number[] = [];
        const rows = executed.map((row) => {
            const points = row.tupleElements;
            if (!points)
                context.fail(expression, "Expected a static array literal.");
            counts.push(points.length);
            return `{${points
                .map((point) =>
                    context.vec3FromRecord(point, expression, "float"),
                )
                .join(", ")}}`;
        });
        return {
            cpp: `std::vector<std::vector<bbl::Vec3>>{${rows.join(", ")}}`,
            counts,
        };
    }
    const lines = context.probeStaticArrayLiteral(expression);
    const literalRows = lines?.elements.map((line) =>
        context.probeStaticArrayLiteral(line),
    );
    if (
        !lines ||
        !literalRows?.every(
            (row): row is ts.ArrayLiteralExpression => row !== undefined,
        )
    )
        return runtimeLines(context, expression, false);
    const counts: number[] = [];
    const rows = literalRows.map((points) => {
        counts.push(points.elements.length);
        return `{${points.elements
            .map((point) => context.compileVec3(point, "float"))
            .join(", ")}}`;
    });
    return {
        cpp: `std::vector<std::vector<bbl::Vec3>>{${rows.join(", ")}}`,
        counts,
    };
}

/**
 * Polylines only the run time knows (`Vec3[][]`, or one `Vec3[]` row), as
 * the nested C++ data the generated flatten reads.
 */
function runtimeLines(
    context: LineIntrinsicContext,
    expression: ts.Expression,
    row: boolean,
): { cpp: string } {
    // Read as owned arrays of the records the option declares
    // (`ReadonlyArray<Vec3>`).
    const owned = (type: DataType | undefined): DataType | undefined =>
        type?.kind === "span" || type?.kind === "vector"
            ? { kind: "vector", element: owned(type.element) ?? type.element }
            : type;
    const declared = context.checker.getContextualType(expression);
    const outer = owned(
        declared
            ? context.dataTypes.fromTsType(declared, expression)
            : undefined,
    );
    const points = row
        ? outer
        : outer?.kind === "vector"
          ? outer.element
          : undefined;
    const point = points?.kind === "vector" ? points.element : undefined;
    if (outer?.kind !== "vector" || point?.kind !== "struct")
        return context.fail(
            expression,
            "Line points are an array of Vec3 records.",
        );
    const source = context.dataLowerer.compileForSink(expression, outer);
    const vec3 = context.vec3FromRecord(
        { kind: "data", cpp: "point", dataType: point },
        expression,
        "float",
    );
    const fill = `for (const auto& point : line) row.push_back(${vec3});`;
    return {
        cpp: row
            ? `[&] { std::vector<std::vector<bbl::Vec3>> rows(1); auto& row = rows[0]; const auto& line = ${source}; ${fill} return rows; }()`
            : `[&] { std::vector<std::vector<bbl::Vec3>> rows; for (const auto& line : ${source}) { auto& row = rows.emplace_back(); ${fill} } return rows; }()`,
    };
}

/** The per-point RGBA rows, checked against the line rows the way the pin checks them. */
function compileColors(
    context: LineIntrinsicContext,
    expression: ts.Expression,
    lineCounts: readonly number[],
    points = false,
): { cpp: string } {
    if (points) {
        const row = context.expectStaticArrayLiteral(expression);
        if (row.elements.length !== lineCounts[0])
            context.fail(row, "Line system data requires one color per point.");
        return {
            cpp: `std::vector<std::vector<bbl::Vec4>>{{${row.elements
                .map((color) => color4AsVec4(context.compileColor4(color)))
                .join(", ")}}}`,
        };
    }
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
            context.fail(row, "Line system data requires one color per point.");
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
