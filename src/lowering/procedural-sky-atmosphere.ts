import type { PinnedCallSpelling } from "./pinned-numeric-lowerer.js";
import ts from "typescript";
import {
    type LoweredSource,
    type LoweringContext,
    unwrapExpression,
} from "./context.js";
import {
    lowerPinnedBody,
    type PinnedBodyScope,
} from "./pinned-body-lowerer.js";
import { type PinnedBinding } from "./pinned-numeric-lowerer.js";

import { pinnedRecordLiteral } from "./pinned-record-literal.js";

export const proceduralSkyModule =
    "src/loader-env/procedural-sky-environment.ts";
const optionScalars = [
    "luminance",
    "turbidity",
    "rayleigh",
    "mieCoefficient",
    "mieDirectionalG",
] as const;
const contextScalars = [
    "sunX",
    "sunY",
    "sunZ",
    "sunE",
    "mieG",
    "exposure",
    "whiteScale",
] as const;
const functionNames: Readonly<Record<string, string>> = {
    tonemap: "procedural_sky_tonemap",
    makeCpuContext: "procedural_sky_cpu_context",
    writeSkyColor: "write_procedural_sky_color",
    areaElement: "procedural_sky_area_element",
    validateOptions: "validate_procedural_sky_options",
    computeProceduralSkySunColor: "compute_procedural_sky_sun_color",
    _computeProceduralSkyIrradiance: "compute_procedural_sky_irradiance",
    polynomialToPreScaledHarmonics: "procedural_sky_prescale_polynomial",
    createPreScaledHarmonics: "procedural_sky_prescaled_harmonics",
    writeParameters: "procedural_sky_parameters",
};

/** Atmosphere arithmetic, integration order, rounding and yield points come from the pin. */
export function lowerProceduralSkyAtmosphere(
    context: LoweringContext,
): LoweredSource {
    const signatures: Readonly<Record<string, string>> = {
        tonemap: "double procedural_sky_tonemap(double value)",
        makeCpuContext:
            "ProceduralSkyCpuContext procedural_sky_cpu_context(const ProceduralSkyOptions& options)",
        writeSkyColor:
            "void write_procedural_sky_color(std::vector<float>& output, double offset, double x, double y, double z, const ProceduralSkyCpuContext& context, double minimum = 0)",
        areaElement: "double procedural_sky_area_element(double x, double y)",
        validateOptions:
            "void validate_procedural_sky_options(const ProceduralSkyOptions& options)",
        computeProceduralSkySunColor:
            "std::vector<double> compute_procedural_sky_sun_color(const ProceduralSkyOptions& options)",
        _computeProceduralSkyIrradiance:
            "js::Promise<std::optional<std::vector<float>>> compute_procedural_sky_irradiance(ProceduralSkyOptions options, std::function<js::Promise<js::PromiseVoid>()> yieldTask, std::function<bool()> isCurrent)",
        polynomialToPreScaledHarmonics:
            "std::vector<float> procedural_sky_prescale_polynomial(const std::vector<float>& poly)",
        createPreScaledHarmonics:
            "std::vector<float> procedural_sky_prescaled_harmonics(const std::vector<float>& irradiance)",
        writeParameters:
            "std::vector<float> procedural_sky_parameters(const ProceduralSkyOptions& options)",
    };
    const emit = (name: string): string => {
        const module =
            name === "polynomialToPreScaledHarmonics"
                ? "src/loader-env/load-env.ts"
                : proceduralSkyModule;
        const { file, declaration } = context.functionDeclaration(module, name);
        if (!declaration.body)
            return context.contractError(
                declaration,
                "Expected procedural sky function body.",
            );
        const asynchronous = name === "_computeProceduralSkyIrradiance";
        const bindings = new Map<string, PinnedBinding>();
        const bind = (
            source: string,
            cpp: string,
            type: PinnedBinding["type"] = "scalar",
        ): void => {
            bindings.set(source, { cpp, type });
        };
        const parameters = new Set(
            declaration.parameters.map((parameter) =>
                parameter.name.getText(file),
            ),
        );
        for (const scalar of ["value", "offset", "x", "y", "z", "minimum"])
            if (parameters.has(scalar)) bind(scalar, scalar);
        bind("options", "options", "opaque");
        bind("options.sunDirection", "options.sunDirection", "f64-buffer");
        for (const field of optionScalars)
            bind(`options.${field}`, `options.${field}`);
        bind("context", "context", "opaque");
        for (const field of contextScalars)
            bind(`context.${field}`, `context.${field}`);
        for (const field of ["betaR", "betaM"])
            bind(`context.${field}`, `context.${field}`, "f64-list");
        for (const array of ["output", "poly", "irradiance"])
            if (parameters.has(array)) bind(array, array, "f32");
        bind("Math.PI", "std::numbers::pi");
        const faceSize = context.variableInitializer(
            context.sourceFile(proceduralSkyModule),
            "FACE_SIZE",
        );
        bind(
            "FACE_SIZE",
            context.doubleLiteral(
                context.numericValue(
                    faceSize,
                    context.sourceFile(proceduralSkyModule),
                ),
            ),
        );
        const calls = new Map<string, PinnedCallSpelling>();

        calls.set(
            "Number.isFinite",
            (args) => `std::isfinite(${args.join(", ")})`,
        );
        calls.set("yieldTask", () => "yieldTask()");
        calls.set("isCurrent", () => "isCurrent()");
        for (const [source, cpp] of Object.entries(functionNames))
            calls.set(source, (args) => `${cpp}(${args.join(", ")})`);
        calls.set(
            "environment._scene.surface.engine._device.queue.writeBuffer",
            (args) => `result = ${args[2]}`,
        );
        bind("environment._parameterBuffer", "0.0");
        const scope: PinnedBodyScope = {
            bindings,
            calls,

            callShapes: new Map([["polynomialToPreScaledHarmonics", "f32"]]),
            expression(node, lowerer) {
                if (node.kind === ts.SyntaxKind.NullKeyword)
                    return "std::nullopt";
                if (ts.isAwaitExpression(node))
                    return `(co_await ${lowerer.expression(node.expression)})`;
                if (ts.isArrayLiteralExpression(node))
                    return `std::vector<double>{${node.elements.map((element) => lowerer.expression(element)).join(",")}}`;
                if (ts.isObjectLiteralExpression(node))
                    return pinnedRecordLiteral(context, lowerer, node, {
                        cpp: "ProceduralSkyCpuContext",
                        fields: Object.fromEntries(
                            [...contextScalars, "betaR", "betaM"].map(
                                (field) => [field, { cpp: field }],
                            ),
                        ),
                    });
                if (
                    ts.isCallExpression(node) &&
                    ts.isPropertyAccessExpression(node.expression) &&
                    node.expression.name.text === "map"
                ) {
                    const callback = node.arguments[0];
                    if (
                        node.arguments.length !== 1 ||
                        !callback ||
                        !ts.isArrowFunction(callback) ||
                        ts.isBlock(callback.body) ||
                        callback.parameters.length !== 2 ||
                        !callback.parameters.every((parameter) =>
                            ts.isIdentifier(parameter.name),
                        )
                    )
                        return context.contractError(
                            node,
                            "Sky numeric map requires value and index parameters.",
                        );
                    const value = callback.parameters[0]!.name.getText(file),
                        index = callback.parameters[1]!.name.getText(file);
                    bind(value, value);
                    bind(index, index);
                    const source = lowerer.expression(
                            node.expression.expression,
                        ),
                        mapped = lowerer.expression(callback.body);
                    return `([&](){std::vector<double> mapped; double ${index}=0; for(const double ${value}:${source}) {mapped.push_back(${mapped}); ++${index};} return mapped;}())`;
                }
                if (ts.isElementAccessExpression(node)) {
                    const array = unwrapExpression(node.expression);
                    if (ts.isArrayLiteralExpression(array))
                        return `std::array<double,${array.elements.length}>{${array.elements.map((element) => lowerer.expression(element)).join(",")}}[static_cast<std::size_t>(${lowerer.expression(node.argumentExpression)})]`;
                }
                return undefined;
            },
            statement(node, lowerer, indent) {
                if (asynchronous && ts.isReturnStatement(node))
                    return [
                        `${indent}co_return ${node.expression ? lowerer.expression(node.expression) : "std::nullopt"};`,
                    ];
                if (
                    asynchronous &&
                    ts.isExpressionStatement(node) &&
                    ts.isAwaitExpression(node.expression)
                )
                    return [`${indent}${lowerer.expression(node.expression)};`];
                if (
                    ts.isForOfStatement(node) &&
                    ts.isArrayLiteralExpression(
                        unwrapExpression(node.expression),
                    )
                ) {
                    if (
                        !ts.isVariableDeclarationList(node.initializer) ||
                        node.initializer.declarations.length !== 1 ||
                        !ts.isIdentifier(node.initializer.declarations[0]!.name)
                    )
                        return context.contractError(
                            node,
                            "Expected sky harmonic offset loop.",
                        );
                    const id = node.initializer.declarations[0]!.name.text;
                    bind(id, id);
                    return [
                        `${indent}for(const double ${id}: ${lowerer.expression(node.expression)}) {`,
                        ...lowerer.statements(
                            ts.isBlock(node.statement)
                                ? node.statement.statements
                                : [node.statement],
                            indent + "    ",
                        ),
                        `${indent}}`,
                    ];
                }
                if (
                    !ts.isVariableStatement(node) ||
                    node.declarationList.declarations.length !== 1
                )
                    return undefined;
                const entry = node.declarationList.declarations[0]!;
                if (!entry.initializer) return undefined;
                if (ts.isArrayBindingPattern(entry.name)) {
                    if (
                        !entry.name.elements.every(
                            (element) =>
                                ts.isBindingElement(element) &&
                                ts.isIdentifier(element.name) &&
                                !element.dotDotDotToken &&
                                !element.initializer,
                        )
                    )
                        return context.contractError(
                            entry,
                            "Unsupported sky tuple destructuring.",
                        );
                    const source = lowerer.expression(entry.initializer);
                    return entry.name.elements.map((element, index) => {
                        const id = element.getText(file);
                        bind(id, id);
                        return `${indent}const double ${id} = (${source})[${index}];`;
                    });
                }
                if (!ts.isIdentifier(entry.name)) return undefined;
                const id = entry.name.text;
                if (id === "context")
                    return [
                        `${indent}const auto context = ${lowerer.expression(entry.initializer)};`,
                    ];
                if (name === "makeCpuContext" && id === "betaM") {
                    const value = lowerer.expression(entry.initializer);
                    bind(id, id, "f64-list");
                    return [`${indent}const auto ${id} = ${value};`];
                }
                const initializer = unwrapExpression(entry.initializer);
                if (
                    ts.isNewExpression(initializer) &&
                    ["Float64Array", "F32"].includes(
                        initializer.expression.getText(file),
                    )
                ) {
                    const length = initializer.arguments?.[0];
                    if (
                        initializer.arguments?.length !== 1 ||
                        !length ||
                        !ts.isNumericLiteral(length)
                    )
                        return context.contractError(
                            initializer,
                            "Sky typed-array scratch requires its literal length.",
                        );
                    const single =
                        initializer.expression.getText(file) === "F32";
                    bind(id, id, single ? "f32" : "f64-buffer");
                    return [
                        `${indent}std::vector<${single ? "float" : "double"}> ${id}(static_cast<std::size_t>(${lowerer.expression(length)}));`,
                    ];
                }
                if (
                    ts.isArrayLiteralExpression(initializer) &&
                    initializer.elements.every(ts.isArrayLiteralExpression)
                ) {
                    const rows = initializer.elements.map((row) => {
                        if (!ts.isArrayLiteralExpression(row))
                            return context.contractError(
                                row,
                                "Expected numeric sky table row.",
                            );
                        return `{${row.elements.map((element) => lowerer.expression(element)).join(",")}}`;
                    });
                    bind(id, id, "f64-list-2d");
                    return [
                        `${indent}const std::vector<std::vector<double>> ${id}{${rows.join(",")}};`,
                    ];
                }
                if (ts.isArrayLiteralExpression(initializer)) {
                    const value = lowerer.expression(initializer);
                    bind(id, id, "f64-list");
                    return [`${indent}const auto ${id} = ${value};`];
                }
                return undefined;
            },
            returnValue: (expression, lowerer) =>
                expression ? lowerer.expression(expression) : "",
        };
        const body = lowerPinnedBody(file, declaration.body.statements, scope);
        return `// ${context.provenance(module, name)}\n${signatures[name]} {\n${name === "writeParameters" ? "    std::vector<float> result;\n" : ""}${body}\n${name === "writeParameters" ? "    return result;\n" : ""}}\n`;
    };
    const order = [
        "tonemap",
        "makeCpuContext",
        "writeSkyColor",
        "areaElement",
        "validateOptions",
        "computeProceduralSkySunColor",
        "_computeProceduralSkyIrradiance",
        "polynomialToPreScaledHarmonics",
        "createPreScaledHarmonics",
        "writeParameters",
    ];
    return {
        modulePath: proceduralSkyModule,
        symbolName: "_computeProceduralSkyIrradiance",
        header: `#pragma once
#include <bblite/js_promise.hpp>
#include <array>
#include <functional>
#include <optional>
#include <vector>
namespace bbl {
struct ProceduralSkyOptions {
    std::array<double,3> sunDirection{};
${optionScalars.map((field) => `    double ${field}=0;`).join("\n")}
};
struct ProceduralSkyCpuContext {
${contextScalars.map((field) => `    double ${field}=0;`).join("\n")}
    std::vector<double> betaR, betaM;
};
${Object.values(signatures)
    .map((signature) => `${signature.replace(" = 0", "")};`)
    .join("\n")}
}\n`,
        source: `#include <bblite/upstream/procedural_sky_atmosphere.hpp>\n#include <bblite/js_data.hpp>\n#include <algorithm>\n#include <cmath>\n#include <numbers>\nnamespace bbl {\n${order.map(emit).join("\n")}\n}\n`,
    };
}
