import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import {
    PinnedNumericLowerer,
    type PinnedBinding,
} from "./pinned-numeric-lowerer.js";
import { pinnedNumericMathCalls } from "./pinned-operators.js";
import { stringLiteral } from "../cpp-literals.js";

export function computeTextureAccessCpp(context: LoweringContext): string {
    const { file, declaration } = context.functionDeclaration(
        "src/resource/compute-storage-texture-view.ts",
        "normalizeOptions",
    );
    const statements = declaration.body!.statements;
    const variable = (statement: ts.Statement, name: string): boolean =>
        ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.some(
            (entry) => ts.isIdentifier(entry.name) && entry.name.text === name,
        );
    const start = statements.findIndex((statement) =>
        variable(statement, "accesses"),
    );
    const end = statements.findIndex((statement) =>
        variable(statement, "sampled"),
    );
    if (start < 0 || end < start)
        return context.contractError(
            declaration,
            "Compute access normalization is missing.",
        );
    const bindings = new Map<string, PinnedBinding>([
        [
            "accesses.length",
            { cpp: "static_cast<double>(accesses.size())", type: "scalar" },
        ],
        ["access", { cpp: "access", type: "opaque" }],
    ]);
    const body = lowerPinnedBody(file, statements.slice(start, end), {
        bindings,
        calls: new Map([
            ["String", (args) => args[0]!],
            [
                "accesses.includes",
                (args) =>
                    `(std::find(accesses.begin(), accesses.end(), ${args[0]}) != accesses.end())`,
            ],
            ["accesses.push", (args) => `accesses.push_back(${args[0]})`],
        ]),
        expression(node) {
            return ts.isStringLiteral(node)
                ? `std::string_view{${stringLiteral(node.text)}}`
                : undefined;
        },
        statement(node, lowerer, indent) {
            if (ts.isVariableStatement(node) && variable(node, "accesses")) {
                context.assertExpressionShape(
                    node.declarationList.declarations[0]!.initializer!,
                    "[]",
                    "Compute access accumulator",
                );
                return [`${indent}std::vector<std::string> accesses;`];
            }
            if (ts.isForOfStatement(node)) {
                context.assertExpressionShape(
                    node.expression,
                    "requested",
                    "Compute access list",
                );
                if (
                    !ts.isVariableDeclarationList(node.initializer) ||
                    node.initializer.declarations.length !== 1 ||
                    !ts.isIdentifier(node.initializer.declarations[0]!.name) ||
                    node.initializer.declarations[0]!.name.text !== "access"
                )
                    return context.contractError(
                        node,
                        "Compute access iteration changed.",
                    );
                return [
                    `${indent}for (const auto& access : requested) {`,
                    ...lowerer.statements(
                        ts.isBlock(node.statement)
                            ? node.statement.statements
                            : [node.statement],
                        indent + "    ",
                    ),
                    `${indent}}`,
                ];
            }
            return undefined;
        },
    });
    return `inline std::vector<std::string> normalize_compute_texture_accesses(const std::vector<std::string>& requested) {\n${body}\n return accesses;\n}\n`;
}

/** Numeric descriptor rules shared by storage texture allocation backends. */
export function computeTextureDescriptorCpp(context: LoweringContext): string {
    const path = "src/resource/compute-storage-texture-view.ts";
    const validate = context.functionDeclaration(path, "validatePositive");
    const calls = pinnedNumericMathCalls();
    calls.set(
        "Number.isInteger",
        (args) =>
            `(std::isfinite(${args[0]}) && std::floor(${args[0]}) == ${args[0]})`,
    );
    calls.set("Number", (args) => args[0]!);
    calls.set(
        "validatePositive",
        (args) => `validate_compute_texture_dimension(${args.join(", ")})`,
    );
    const validation = lowerPinnedBody(
        validate.file,
        validate.declaration.body!.statements,
        {
            bindings: new Map<string, PinnedBinding>([
                ["name", { cpp: "name", type: "opaque" }],
                ["value", { cpp: "value", type: "scalar" }],
                ["maximum", { cpp: "maximum", type: "scalar" }],
            ]),
            calls,
        },
    );
    const normalize = context.functionDeclaration(path, "normalizeOptions");
    const statements = normalize.declaration.body!.statements;
    const numericEnd = statements.findIndex(
        (statement) =>
            ts.isVariableStatement(statement) &&
            statement.declarationList.declarations.some(
                (entry) =>
                    ts.isIdentifier(entry.name) &&
                    entry.name.text === "requested",
            ),
    );
    if (numericEnd < 0)
        return context.contractError(
            normalize.declaration,
            "Expected access normalization after extent validation.",
        );
    const bindings = new Map<string, PinnedBinding>([
        ["engine._device.limits", { cpp: "limits", type: "opaque" }],
        ["limits.maxTextureDimension1D", { cpp: "limits[0]", type: "scalar" }],
        ["limits.maxTextureDimension2D", { cpp: "limits[1]", type: "scalar" }],
        ["limits.maxTextureDimension3D", { cpp: "limits[2]", type: "scalar" }],
        ["limits.maxTextureArrayLayers", { cpp: "limits[3]", type: "scalar" }],
        [
            "Number.MAX_SAFE_INTEGER",
            { cpp: "9007199254740991.0", type: "scalar" },
        ],
        ["options.width", { cpp: "width", type: "scalar" }],
        ["options.viewDimension", { cpp: "dimension", type: "opaque" }],
        ["options.mipMaps", { cpp: "mip_maps", type: "bool" }],
    ]);
    const dimensions = lowerPinnedBody(
        normalize.file,
        statements.slice(0, numericEnd),
        {
            bindings,
            calls,
            expression(node, lowerer) {
                if (ts.isStringLiteral(node)) return stringLiteral(node.text);
                if (
                    !ts.isBinaryExpression(node) ||
                    node.operatorToken.kind !==
                        ts.SyntaxKind.QuestionQuestionToken
                )
                    return undefined;
                const lhs = node.left.getText(normalize.file);
                const optional =
                    lhs === "options.height"
                        ? "height_option"
                        : lhs === "options.depthOrArrayLayers"
                          ? "depth_option"
                          : undefined;
                return optional
                    ? `${optional}.value_or(${lowerer.expression(node.right)})`
                    : undefined;
            },
        },
    );
    const { file, declaration } = context.functionDeclaration(
        "src/resource/compute-storage-texture.ts",
        "_createComputeStorageTextureGpuState",
    );
    const mipBindings = new Map<string, PinnedBinding>([
        ["options.width", { cpp: "extent[0]", type: "scalar" }],
        ["options.height", { cpp: "extent[1]", type: "scalar" }],
        ["options.depthOrArrayLayers", { cpp: "extent[2]", type: "scalar" }],
        ["options.viewDimension", { cpp: "dimension", type: "opaque" }],
        ["options.mipMaps", { cpp: "mip_maps", type: "bool" }],
    ]);
    const mip = new PinnedNumericLowerer(file, {
        bindings: mipBindings,
        calls,
        expression: (node) =>
            ts.isStringLiteral(node) ? stringLiteral(node.text) : undefined,
    });
    const mipExtent = context.variableInitializer(declaration, "mipExtent");
    const mipExtentCpp = mip.expression(mipExtent);
    mipBindings.set("mipExtent", { cpp: "mip_extent", type: "scalar" });
    const mipCountCpp = mip.expression(
        context.variableInitializer(declaration, "mipLevelCount"),
    );
    return `// ${context.provenance(path, "normalizeOptions")}
inline void validate_compute_texture_dimension(std::string_view name, double value, double maximum) {
${validation}
}

inline std::array<double, 3> normalize_compute_texture_extent(
    double width, std::optional<double> height_option, std::optional<double> depth_option,
    std::string_view dimension, bool mip_maps, const std::array<double, 4>& limits) {
${dimensions}
    return {width, height, depthOrArrayLayers};
}
// ${context.provenance("src/resource/compute-storage-texture.ts", "_createComputeStorageTextureGpuState")}
inline double compute_texture_mip_count(const std::array<double, 3>& extent, std::string_view dimension, bool mip_maps) {
    const double mip_extent = ${mipExtentCpp};
    return ${mipCountCpp};
}
`;
}

/** Sampling and mip-render capabilities are source predicates, not backend guesses. */
export function computeTextureSamplingCpp(context: LoweringContext): string {
    const rules = [
        {
            path: "src/compute/compute-texture-resource.ts",
            name: "_inferComputeTextureFormatSampleType",
            signature:
                "std::string_view compute_texture_sample_type(std::string_view format, const pal::ComputeTextureCapabilities& caps)",
        },
        {
            path: "src/compute/compute-sampler-resource.ts",
            name: "_inferComputeSamplerType",
            signature:
                "std::string_view compute_texture_sampler_type(const pal::ComputeTextureDescriptor::Sampler& sampler)",
        },
        {
            path: "src/resource/compute-storage-mip-support.ts",
            name: "_supportsComputeRenderMipmaps",
            signature:
                "bool compute_texture_render_mips(std::string_view viewDimension, std::string_view format, bool sampled, const pal::ComputeTextureCapabilities& caps)",
        },
        {
            path: "src/resource/compute-storage-texture.ts",
            name: "_resolveComputeStorageTextureSampleType",
            signature:
                "std::string_view resolve_compute_texture_sample_type(std::string_view format, const pal::ComputeTextureDescriptor::Sampler& sampler, const pal::ComputeTextureCapabilities& caps)",
        },
    ];
    return rules
        .map(({ path, name, signature }) => {
            const { file, declaration } = context.functionDeclaration(
                path,
                name,
            );
            const bindings = new Map<string, PinnedBinding>([
                ["format", { cpp: "format", type: "opaque" }],
                ["viewDimension", { cpp: "viewDimension", type: "opaque" }],
                ["sampled", { cpp: "sampled", type: "bool" }],
                ["descriptor.compare", { cpp: "false", type: "bool" }],
                [
                    "descriptor.minFilter",
                    { cpp: "sampler.min_filter", type: "opaque" },
                ],
                [
                    "descriptor.magFilter",
                    { cpp: "sampler.mag_filter", type: "opaque" },
                ],
                [
                    "descriptor.mipmapFilter",
                    { cpp: "sampler.mip_filter", type: "opaque" },
                ],
            ]);
            const expression = (
                node: ts.Expression,
                lowerer: PinnedNumericLowerer,
            ): string | undefined => {
                if (ts.isStringLiteral(node))
                    return `std::string_view{${stringLiteral(node.text)}}`;
                if (
                    ts.isTypeOfExpression(node) &&
                    ts.isIdentifier(node.expression) &&
                    node.expression.text === "format"
                )
                    return 'std::string_view{"string"}';
                if (!ts.isCallExpression(node)) return undefined;
                const callee = node.expression.getText(file);
                if (callee === "engine._device.features.has") {
                    const feature = node.arguments[0];
                    if (
                        node.arguments.length !== 1 ||
                        !feature ||
                        !ts.isStringLiteral(feature)
                    )
                        return context.contractError(
                            node,
                            "Expected a literal GPU capability.",
                        );
                    if (feature.text === "float32-filterable")
                        return "caps.float32_filterable";
                    if (feature.text === "texture-formats-tier1")
                        return "caps.texture_formats_tier1";
                }
                if (callee === "_inferComputeTextureFormatSampleType")
                    return `compute_texture_sample_type(${lowerer.expression(node.arguments[1]!)}, caps)`;
                if (callee === "_inferComputeSamplerType")
                    return "compute_texture_sampler_type(sampler)";
                if (
                    ts.isPropertyAccessExpression(node.expression) &&
                    ts.isIdentifier(node.expression.expression) &&
                    node.expression.expression.text === "format" &&
                    node.arguments.length === 1
                ) {
                    const argument = lowerer.expression(node.arguments[0]!);
                    switch (node.expression.name.text) {
                        case "includes":
                            return `(format.find(${argument}) != std::string_view::npos)`;
                        case "startsWith":
                            return `format.starts_with(${argument})`;
                        case "endsWith":
                            return `format.ends_with(${argument})`;
                    }
                }
                return undefined;
            };
            const body = lowerPinnedBody(file, declaration.body!.statements, {
                bindings,
                calls: new Map(),
                expression,
                callShapes: new Map([["engine._device.features.has", "bool"]]),
                statement(node, lowerer, indent) {
                    if (!ts.isVariableStatement(node)) return undefined;
                    return node.declarationList.declarations.map((entry) => {
                        if (!ts.isIdentifier(entry.name) || !entry.initializer)
                            return context.contractError(
                                entry,
                                "Expected a sampling predicate result.",
                            );
                        const rhs = lowerer.expression(entry.initializer);
                        bindings.set(entry.name.text, {
                            cpp: entry.name.text,
                            type: "opaque",
                        });
                        return `${indent}const std::string_view ${entry.name.text} = ${rhs};`;
                    });
                },
                returnValue(node, lowerer) {
                    return node ? lowerer.expression(node) : "";
                },
            });
            return `// ${context.provenance(path, name)}\ninline ${signature} {\n${body}\n}\n`;
        })
        .join("\n");
}
