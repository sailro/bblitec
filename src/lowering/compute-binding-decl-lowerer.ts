import ts from "typescript";
import { stringLiteral } from "../cpp-literals.js";
import { featureMacroInclude } from "../feature-macros.js";
import {
    type LoweringContext,
    type LoweredSource,
    unwrapExpression,
} from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import {
    PinnedNumericLowerer,
    type PinnedBinding,
    type PinnedNumericScope,
} from "./pinned-numeric-lowerer.js";
import {
    pinnedRecordLiteral,
    pinnedRecordSchema,
    type PinnedRecordSchema,
} from "./pinned-record-literal.js";

const optionFields: Record<
    string,
    { cpp: string; type: PinnedBinding["type"]; optional?: true }
> = {
    group: { cpp: "group", type: "scalar" },
    binding: { cpp: "binding", type: "scalar" },
    access: { cpp: "access", type: "opaque", optional: true },
    dynamicOffset: { cpp: "dynamic_offset", type: "bool", optional: true },
    minBindingSize: { cpp: "min_binding_size", type: "scalar", optional: true },
    sampleType: { cpp: "sample_type", type: "opaque", optional: true },
    multisampled: { cpp: "multisampled", type: "bool", optional: true },
    type: { cpp: "type", type: "opaque", optional: true },
    format: { cpp: "format", type: "opaque" },
    viewDimension: { cpp: "view_dimension", type: "opaque" },
};
const optionsSchema = pinnedRecordSchema(
    "ComputeBindingOptions",
    Object.fromEntries(
        Object.entries(optionFields).map(([name, field]) => [name, field.cpp]),
    ),
);
const layoutSchema: PinnedRecordSchema = {
    cpp: "ComputeResourceLayout",
    fields: {
        buffer: {
            cpp: "buffer",
            record: pinnedRecordSchema("ComputeBufferLayout", {
                type: "type",
                hasDynamicOffset: "has_dynamic_offset",
                minBindingSize: "min_binding_size",
            }),
        },
        texture: {
            cpp: "texture",
            record: pinnedRecordSchema("ComputeTextureLayout", {
                sampleType: "sample_type",
                viewDimension: "view_dimension",
                multisampled: "multisampled",
            }),
        },
        sampler: {
            cpp: "sampler",
            record: pinnedRecordSchema("ComputeSamplerLayout", {
                type: "type",
            }),
        },
        storageTexture: {
            cpp: "storage_texture",
            record: pinnedRecordSchema("ComputeStorageTextureLayout", {
                access: "access",
                format: "format",
                viewDimension: "view_dimension",
            }),
        },
    },
};
const dataSchema = pinnedRecordSchema("ComputeBindingData", {
    access: "access",
    dynamic: "dynamic",
    minSize: "min_size",
    sampleType: "sample_type",
    multisampled: "multisampled",
    viewDimension: "view_dimension",
    format: "format",
});
const declSchema = pinnedRecordSchema("ComputeBindingDecl", {
    name: "name",
    group: "group",
    binding: "binding",
    _kind: "kind",
    _layout: "layout",
    _data: "data",
});
export const computeBindingFactories: Record<
    string,
    { module: string; cpp: string }
> = {
    computeStorageBufferBinding: {
        module: "compute-storage-buffer-binding",
        cpp: "compute_storage_buffer_binding",
    },
    computeUniformBufferBinding: {
        module: "compute-uniform-buffer-binding",
        cpp: "compute_uniform_buffer_binding",
    },
    _computeTextureViewBinding: {
        module: "compute-texture-binding",
        cpp: "make_compute_texture_view_binding",
    },
    computeTextureBinding: {
        module: "compute-texture-binding",
        cpp: "compute_texture_binding",
    },
    computeTextureViewBinding: {
        module: "compute-texture-view-binding",
        cpp: "compute_texture_view_binding",
    },
    _computeStorageTextureViewBinding: {
        module: "compute-storage-texture-binding",
        cpp: "make_compute_storage_texture_view_binding",
    },
    computeStorageTextureBinding: {
        module: "compute-storage-texture-binding",
        cpp: "compute_storage_texture_binding",
    },
    computeStorageTextureViewBinding: {
        module: "compute-storage-texture-view-binding",
        cpp: "compute_storage_texture_view_binding",
    },
    computeSamplerBinding: {
        module: "compute-sampler-binding",
        cpp: "compute_sampler_binding",
    },
};

function factoryScope(
    context: LoweringContext,
    file: ts.SourceFile,
): PinnedNumericScope {
    const bindings = new Map<string, PinnedBinding>([
        ["name", { cpp: "name", type: "opaque" }],
        ["options", { cpp: "options", type: "opaque" }],
    ]);
    for (const [name, field] of Object.entries(optionFields))
        bindings.set(`options.${name}`, {
            cpp: `options.${field.cpp}${field.optional ? (field.type === "bool" ? ".value_or(false)" : ".value()") : ""}`,
            type: field.type,
            ...(field.optional
                ? { absentCpp: `!options.${field.cpp}.has_value()` }
                : {}),
        });
    const calls = new Map<string, (args: readonly string[]) => string>();
    calls.set("String", (args) => args[0]!);
    calls.set(
        "_isComputeStorageTextureFormat",
        (args) => `is_compute_storage_texture_format(${args.join(", ")})`,
    );
    for (const [name, fn] of Object.entries(computeBindingFactories))
        calls.set(name, (args) => `${fn.cpp}(${args.join(", ")})`);
    return {
        bindings,
        calls,
        booleanOr: true,
        foldConditions: false,
        expression(node, lowerer) {
            if (ts.isStringLiteralLike(node))
                return `std::string{${stringLiteral(node.text)}}`;
            if (ts.isObjectLiteralExpression(node))
                return pinnedRecordLiteral(
                    context,
                    lowerer,
                    node,
                    optionsSchema,
                );
            if (ts.isBinaryExpression(node)) {
                const left = unwrapExpression(node.left);
                if (
                    ts.isPropertyAccessExpression(left) &&
                    left.expression.getText(file) === "options"
                ) {
                    const field = optionFields[left.name.text];
                    if (field?.optional) {
                        const cpp = `options.${field.cpp}`;
                        if (
                            node.operatorToken.kind ===
                            ts.SyntaxKind.QuestionQuestionToken
                        )
                            return `${cpp}.value_or(${lowerer.expression(node.right)})`;
                        if (
                            ts.isIdentifier(node.right) &&
                            node.right.text === "undefined"
                        ) {
                            if (
                                node.operatorToken.kind ===
                                ts.SyntaxKind.ExclamationEqualsEqualsToken
                            )
                                return `${cpp}.has_value()`;
                            if (
                                node.operatorToken.kind ===
                                ts.SyntaxKind.EqualsEqualsEqualsToken
                            )
                                return `!${cpp}.has_value()`;
                        }
                    }
                }
            }
            if (
                ts.isCallExpression(node) &&
                node.expression.getText(file) === "_createComputeBindingDecl"
            ) {
                if (node.arguments.length !== 6)
                    return context.contractError(
                        node,
                        "Expected complete compute declaration.",
                    );
                const args = node.arguments
                    .slice(0, 4)
                    .map((arg) => lowerer.expression(arg));
                args.push(
                    pinnedRecordLiteral(
                        context,
                        lowerer,
                        node.arguments[4]!,
                        layoutSchema,
                    ),
                );
                const data = unwrapExpression(node.arguments[5]!);
                args.push(
                    ts.isObjectLiteralExpression(data)
                        ? pinnedRecordLiteral(
                              context,
                              lowerer,
                              data,
                              dataSchema,
                          )
                        : `([&]() { ComputeBindingData data{}; data.sampler_type = ${lowerer.expression(data)}; return data; })()`,
                );
                return `make_compute_binding_decl(${args.join(", ")})`;
            }
            return undefined;
        },
        statement(node, lowerer, indent) {
            if (
                ts.isExpressionStatement(node) &&
                ts.isCallExpression(node.expression) &&
                node.expression.expression.getText(file) ===
                    "_installComputeBindingResolver"
            ) {
                const args = node.expression.arguments;
                if (
                    args.length < 3 ||
                    args.length > 4 ||
                    !ts.isIdentifier(args[0]!) ||
                    !ts.isIdentifier(args[1]!) ||
                    !ts.isIdentifier(args[2]!)
                )
                    return context.contractError(
                        node,
                        "Expected opt-in compute resolver installation.",
                    );
                const resources: Record<string, string> = {
                    resolveStorageBuffer: "storage_buffer",
                    resolveUniformBuffer: "uniform_buffer",
                    resolveTexture: "texture",
                    resolveSampler: "sampler",
                    resolveStorageTexture: "storage_texture",
                };
                const resource = resources[args[1].text];
                if (
                    !resource ||
                    args[2].text !== args[1].text.replace(/^resolve/, "get")
                )
                    return context.contractError(
                        node,
                        "Unrepresented compute binding resolver pair.",
                    );
                if ((args.length === 4) !== (resource === "texture"))
                    return context.contractError(
                        node,
                        "Compute volatile resolver registration changed.",
                    );
                return [
                    "#if BBLITE_COMPUTE_BINDINGS",
                    `${indent}install_compute_binding_resolver(${lowerer.expression(args[0])},resolve_compute_${resource}_input,get_compute_${resource}_input${args.length === 4 ? ",validate_compute_texture_binding" : ""});`,
                    "#endif",
                ];
            }
            if (
                ts.isVariableStatement(node) &&
                node.declarationList.declarations.length === 1
            ) {
                const declaration = node.declarationList.declarations[0]!;
                if (
                    !ts.isIdentifier(declaration.name) ||
                    !declaration.initializer
                )
                    return undefined;
                const name = declaration.name.text;
                if (["access", "sampleType", "type"].includes(name)) {
                    bindings.set(name, { cpp: name, type: "opaque" });
                    return [
                        `${indent}const auto ${name} = ${lowerer.expression(declaration.initializer)};`,
                    ];
                }
                if (name === "multisampled") {
                    bindings.set(name, { cpp: name, type: "bool" });
                    return [
                        `${indent}const bool ${name} = ${lowerer.expression(declaration.initializer)};`,
                    ];
                }
            }
            return undefined;
        },
    };
}

export function lowerComputeBindingDecl(
    context: LoweringContext,
): LoweredSource {
    const common = context.functionDeclaration(
        "src/compute/compute-binding.ts",
        "_createComputeBindingDecl",
    );
    const expected = [
        "const resourceLayout = layout.buffer ?? layout.sampler ?? layout.texture ?? layout.storageTexture ?? layout.externalTexture;",
        "if (resourceLayout) { Object.freeze(resourceLayout); }",
        "Object.freeze(layout);",
        'if (data && typeof data === "object") { Object.freeze(data); }',
    ];
    if (common.declaration.body!.statements.length !== expected.length + 1)
        return context.contractError(
            common.declaration,
            "Compute declaration freeze structure changed.",
        );
    context.assertStatementShapes(
        common.declaration,
        common.declaration.body!.statements.slice(0, expected.length),
        expected.join("\n"),
        "Compute declaration immutability",
    );
    const returned = common.declaration.body!.statements.at(-1)!;
    if (!ts.isReturnStatement(returned) || !returned.expression)
        return context.contractError(
            returned,
            "Expected frozen compute declaration.",
        );
    const expression = unwrapExpression(returned.expression);
    if (
        !ts.isCallExpression(expression) ||
        expression.expression.getText(common.file) !== "Object.freeze" ||
        expression.arguments.length !== 1
    )
        return context.contractError(
            expression,
            "Expected frozen compute declaration.",
        );
    const lowerer = new PinnedNumericLowerer(common.file, {
        bindings: new Map(
            ["name", "group", "binding", "kind", "layout", "data"].map(
                (name) => [name, { cpp: name, type: "opaque" }],
            ),
        ),
        calls: new Map(),
    });
    const record = pinnedRecordLiteral(
        context,
        lowerer,
        expression.arguments[0]!,
        declSchema,
    );
    const output = [
        `// ${context.provenance("src/compute/compute-binding.ts", "_createComputeBindingDecl")}\nstatic ComputeBindingDeclPtr make_compute_binding_decl(const std::string& name,double group,double binding,double kind,ComputeResourceLayout layout,ComputeBindingData data){return std::make_shared<const ComputeBindingDecl>(${record});}`,
    ];
    const format = context.functionDeclaration(
        "src/resource/compute-storage-texture.ts",
        "_isComputeStorageTextureFormat",
    );
    output.push(
        `static bool is_compute_storage_texture_format(const std::string& format) {\n${lowerPinnedBody(format.file, format.declaration.body!.statements, { bindings: new Map([["format", { cpp: "format", type: "opaque" }]]), calls: new Map(), booleanOr: true, expression: (node) => (ts.isStringLiteralLike(node) ? `std::string{${stringLiteral(node.text)}}` : undefined), returnValue: (node, l) => l.expression(node!) })}\n}`,
    );
    for (const [name, fn] of Object.entries(computeBindingFactories)) {
        const path = `src/compute/${fn.module}.ts`,
            { file, declaration } = context.functionDeclaration(path, name);
        const body = lowerPinnedBody(file, declaration.body!.statements, {
            ...factoryScope(context, file),
            returnValue: (node, l) => l.expression(node!),
        });
        output.push(
            `// ${context.provenance(path, name)}\n${name.startsWith("_") ? "static " : ""}ComputeBindingDeclPtr ${fn.cpp}(const std::string& name,const ComputeBindingOptions& options){\n${body}\n}`,
        );
    }
    return {
        modulePath: "src/compute/compute-binding.ts",
        symbolName: "_createComputeBindingDecl",
        header: "",
        source: `#include <${featureMacroInclude("BBLITE_COMPUTE_BINDINGS")}>\n#include <bblite/pal_compute_binding.hpp>\n#if BBLITE_COMPUTE_BINDINGS\n#include <bblite/pal_compute_bindings.hpp>\n#endif\nnamespace bbl {\n${output.join("\n")}\n}\n`,
    };
}
