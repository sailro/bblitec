import ts from "typescript";
import { lowerComputeShaderGpu } from "./compute-shader-gpu-lowerer.js";
import { stringLiteral } from "../cpp-literals.js";
import {
    LoweringContext,
    type LoweredSource,
    unwrapExpression,
    sharedPinnedContext,
} from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import {
    PinnedNumericLowerer,
    type PinnedBinding,
    type PinnedNumericScope,
} from "./pinned-numeric-lowerer.js";
import {
    pinnedRecordLiteral,
    type PinnedRecordSchema,
} from "./pinned-record-literal.js";

const path = "src/compute/compute-shader.ts";
export function computeShaderDefaultEntryPoint(): string {
    const context = sharedPinnedContext();
    const { declaration } = context.functionDeclaration(
        path,
        "createComputeShader",
    );
    const value = context.variableInitializer(declaration, "entryPoint");
    if (
        !ts.isBinaryExpression(value) ||
        value.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken ||
        !ts.isStringLiteralLike(value.right)
    )
        return context.contractError(
            value,
            "Expected the source compute entry-point default.",
        );
    return value.right.text;
}
const shaderFields: Record<string, string> = {
    name: "name",
    _engine: "engine",
    _source: "source",
    _entryPoint: "entry_point",
    _decls: "decls",
    _slots: "slots",
    _dynamicCounts: "dynamic_counts",
    _device: "device",
    _module: "module",
    _layouts: "layouts",
    _pipelineLayout: "pipeline_layout",
    _pipeline: "pipeline",
    _pending: "pending",
    _destroyed: "destroyed",
};
const limits: Record<string, string> = {
    maxBindGroups: "max_bind_groups",
    maxBindingsPerBindGroup: "max_bindings_per_bind_group",
    maxUniformBuffersPerShaderStage: "max_uniform_buffers_per_shader_stage",
    maxStorageBuffersPerShaderStage: "max_storage_buffers_per_shader_stage",
    maxDynamicUniformBuffersPerPipelineLayout:
        "max_dynamic_uniform_buffers_per_pipeline_layout",
    maxDynamicStorageBuffersPerPipelineLayout:
        "max_dynamic_storage_buffers_per_pipeline_layout",
    maxSampledTexturesPerShaderStage: "max_sampled_textures_per_shader_stage",
    maxSamplersPerShaderStage: "max_samplers_per_shader_stage",
    maxStorageTexturesPerShaderStage: "max_storage_textures_per_shader_stage",
};
const methods: Record<
    string,
    { cpp: string; parameters: string; result: string }
> = {
    assertName: {
        cpp: "assert_compute_name",
        parameters: "const std::string& kind,const std::string& name",
        result: "void",
    },
    validateIndex: {
        cpp: "validate_compute_index",
        parameters: "const std::string& kind,double value",
        result: "void",
    },
    createComputeShader: {
        cpp: "create_compute_shader",
        parameters:
            "std::shared_ptr<Engine> engine,const ComputeShaderOptions& options",
        result: "std::shared_ptr<ComputeShader>",
    },
    _assertComputeShaderLive: {
        cpp: "assert_compute_shader_live",
        parameters: "const std::shared_ptr<ComputeShader>& shader",
        result: "void",
    },
    disposeComputeShader: {
        cpp: "dispose_compute_shader",
        parameters: "const std::shared_ptr<ComputeShader>& shader",
        result: "void",
    },
};

function scope(
    context: LoweringContext,
    file: ts.SourceFile,
): PinnedNumericScope {
    const bindings = new Map<string, PinnedBinding>();
    for (const name of [
        "engine",
        "options",
        "shader",
        "kind",
        "entryPoint",
        "decls",
        "slots",
        "pairs",
        "dynamicCounts",
        "limits",
    ])
        bindings.set(name, { cpp: name, type: "opaque" });
    bindings.set("name", {
        cpp: "name",
        type: "opaque",
        absentCpp: "name.empty()",
    });
    bindings.set("value", { cpp: "value", type: "scalar" });
    bindings.set("options.computeSource", {
        cpp: "options.source",
        type: "opaque",
        absentCpp: "options.source.empty()",
    });
    bindings.set("engine._device", {
        cpp: "std::shared_ptr<pal::OffscreenDevice>(engine->offscreen_run, &engine->offscreen_run->device())",
        type: "opaque",
    });
    bindings.set("shader._engine._device", {
        cpp: "std::shared_ptr<pal::OffscreenDevice>(shader->engine->offscreen_run, &shader->engine->offscreen_run->device())",
        type: "opaque",
    });
    for (const [key, cpp] of Object.entries(shaderFields))
        bindings.set(`shader.${key}`, {
            cpp: `shader->${cpp}`,
            type: key === "_destroyed" ? "bool" : "opaque",
        });
    for (const [name, cpp] of Object.entries(limits))
        bindings.set(`limits.${name}`, {
            cpp: `limits.${cpp}`,
            type: "opaque",
            absentCpp: `!limits.${cpp}.has_value()`,
        });
    for (const [name, cpp] of Object.entries({
        name: "name",
        group: "group",
        binding: "binding",
    }))
        bindings.set(`decl.${name}`, {
            cpp: `decl->${cpp}`,
            type: name === "name" ? "opaque" : "scalar",
        });
    for (const key of ["buffer", "sampler", "texture", "storageTexture"]) {
        const cpp = key === "storageTexture" ? "storage_texture" : key;
        bindings.set(`decl._layout.${key}`, {
            cpp: `decl->layout.${cpp}`,
            type: "opaque",
            absentCpp: `!decl->layout.${cpp}.has_value()`,
        });
    }
    bindings.set("decl._layout.buffer.type", {
        cpp: "decl->layout.buffer->type",
        type: "opaque",
    });
    bindings.set("decl._layout.buffer.hasDynamicOffset", {
        cpp: "decl->layout.buffer->has_dynamic_offset",
        type: "bool",
    });
    bindings.set("minBindingSize", {
        cpp: "minBindingSize",
        type: "opaque",
        absentCpp: "!minBindingSize.has_value()",
    });
    bindings.set("Number.MAX_SAFE_INTEGER", {
        cpp: "9007199254740991.0",
        type: "scalar",
    });
    const calls = new Map<string, (args: readonly string[]) => string>([
        [
            "Number.isInteger",
            (args) => `js::number_is_integer(${args.join(", ")})`,
        ],
        ["slots.has", (args) => `slots.contains(${args.join(", ")})`],
        ["pairs.has", (args) => `pairs.contains(${args.join(", ")})`],
        ["pairs.add", (args) => `pairs.insert(${args.join(", ")})`],
        ["assertCount", (args) => `assertCount(${args.join(", ")})`],
        [
            "Number",
            (args) =>
                args[0] === "minBindingSize"
                    ? "minBindingSize.value()"
                    : args[0]!,
        ],
    ]);
    for (const [name, method] of Object.entries(methods))
        calls.set(name, (args) => `${method.cpp}(${args.join(", ")})`);
    return {
        bindings,
        calls,

        callShapes: new Map([
            ["Number.isInteger", "bool"],
            ["slots.has", "bool"],
            ["pairs.has", "bool"],
        ]),
        expression(node, lowerer) {
            if (ts.isStringLiteralLike(node))
                return `std::string{${stringLiteral(node.text)}}`;
            if (node.kind === ts.SyntaxKind.NullKeyword) return "nullptr";
            if (ts.isTemplateExpression(node)) {
                const parts = [`std::string{${stringLiteral(node.head.text)}}`];
                for (const span of node.templateSpans) {
                    const value = lowerer.expression(span.expression),
                        numeric =
                            ts.isPropertyAccessExpression(span.expression) &&
                            ["group", "binding"].includes(
                                span.expression.name.text,
                            );
                    parts.push(
                        numeric ? `js::number_to_string(${value})` : value,
                        `std::string{${stringLiteral(span.literal.text)}}`,
                    );
                }
                return `(${parts.join(" + ")})`;
            }
            if (
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
            ) {
                const text = node.left.getText(file);
                if (text === "options.entryPoint" || text === "options.name")
                    return `options.${text.endsWith("name") ? "name" : "entry_point"}.value_or(${lowerer.expression(node.right)})`;
                if (
                    context.expressionMatchesShape(
                        node.left,
                        "decls.at(-1)?.group",
                    )
                )
                    return `(decls.empty() ? ${lowerer.expression(node.right)} : decls.back()->group)`;
                if (
                    ts.isElementAccessExpression(node.left) &&
                    node.left.expression.getText(file) === "dynamicCounts"
                ) {
                    const index = lowerer.expression(
                        node.left.argumentExpression,
                    );
                    return `(static_cast<std::size_t>(${index}) < dynamicCounts.size() ? dynamicCounts[static_cast<std::size_t>(${index})] : ${lowerer.expression(node.right)})`;
                }
            }
            if (
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind === ts.SyntaxKind.BarBarToken &&
                ts.isCallExpression(node.left) &&
                node.left.expression.getText(file) === "Number"
            ) {
                const arg = node.left.arguments[0];
                if (
                    arg &&
                    ts.isPropertyAccessExpression(arg) &&
                    arg.expression.getText(file) === "engine._device.limits"
                ) {
                    const cpp = limits[arg.name.text];
                    if (!cpp) return undefined;
                    return `js::or_number(engine->offscreen_run->device().compute_shader_limits().${cpp}.value_or(std::numeric_limits<double>::quiet_NaN()), ${lowerer.expression(node.right)})`;
                }
            }
            if (
                context.expressionMatchesShape(
                    node,
                    "decl._layout.buffer?.hasDynamicOffset",
                )
            )
                return "(decl->layout.buffer.has_value() && decl->layout.buffer->has_dynamic_offset)";
            if (ts.isObjectLiteralExpression(node)) {
                const schema: PinnedRecordSchema = {
                    cpp: "ComputeShader",
                    fields: Object.fromEntries(
                        Object.entries(shaderFields).map(([name, cpp]) => [
                            name,
                            { cpp },
                        ]),
                    ),
                };
                return `js::make_gc_shared<ComputeShader>(${pinnedRecordLiteral(context, lowerer, node, schema)})`;
            }
            return undefined;
        },
        forOf(iterated, element) {
            if (iterated !== "decls" || element !== "decl") return undefined;
            return {
                range: "decls",
                bindings: new Map([
                    ...[...bindings].filter(([name]) =>
                        name.startsWith(`${element}.`),
                    ),
                    [element, { cpp: element, type: "opaque" }],
                ]),
            };
        },
        statement(node, lowerer, indent) {
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
                const name = declaration.name.text,
                    initializer = unwrapExpression(declaration.initializer);
                if (name === "entryPoint" || name === "pair") {
                    lowerer.bindPorts(
                        [[name, { cpp: name, type: "opaque" }]],
                        node,
                    );
                    return [
                        `${indent}const auto ${name} = ${lowerer.expression(initializer)};`,
                    ];
                }
                if (name === "decls") {
                    if (
                        !ts.isCallExpression(initializer) ||
                        !ts.isPropertyAccessExpression(
                            initializer.expression,
                        ) ||
                        initializer.expression.name.text !== "sort" ||
                        initializer.arguments.length !== 1 ||
                        !ts.isArrowFunction(initializer.arguments[0]!)
                    )
                        return context.contractError(
                            initializer,
                            "Expected sorted compute declarations.",
                        );
                    context.assertExpressionShape(
                        initializer.expression.expression,
                        "[...(options.bindings ?? [])]",
                        "Compute declaration snapshot",
                    );
                    const compare = initializer.arguments[0];
                    if (
                        compare.parameters.length !== 2 ||
                        compare.parameters[0]!.name.getText(file) !== "a" ||
                        compare.parameters[1]!.name.getText(file) !== "b" ||
                        ts.isBlock(compare.body)
                    )
                        return context.contractError(
                            compare,
                            "Expected compute declaration comparator.",
                        );
                    const order = new PinnedNumericLowerer(file, {
                        bindings: new Map(
                            ["a", "b"].flatMap((name) =>
                                ["group", "binding"].map((key) => [
                                    `${name}.${key}`,
                                    {
                                        cpp: `${name}->${key}`,
                                        type: "scalar",
                                    } as const,
                                ]),
                            ),
                        ),
                        calls: new Map(),
                        expression: (expression, l) =>
                            ts.isBinaryExpression(expression) &&
                            expression.operatorToken.kind ===
                                ts.SyntaxKind.BarBarToken
                                ? `js::or_number(${l.expression(expression.left)}, ${l.expression(expression.right)})`
                                : undefined,
                    }).expression(compare.body);
                    return [
                        `${indent}auto decls = options.bindings;`,
                        `${indent}std::stable_sort(decls.begin(), decls.end(), [](const auto& a,const auto& b){return (${order}) < 0.0;});`,
                    ];
                }
                const records: Record<string, [string, string]> = {
                    slots: [
                        "new Map<string, ComputeBindingSlot>()",
                        "std::map<std::string,ComputeBindingSlot>",
                    ],
                    pairs: ["new Set<string>()", "std::set<std::string>"],
                    dynamicCounts: ["[]", "std::vector<double>"],
                };
                const record = records[name];
                if (record) {
                    context.assertExpressionShape(
                        initializer,
                        record[0],
                        "Compute declaration collection",
                    );
                    return [`${indent}${record[1]} ${name};`];
                }
                if (name === "minBindingSize") {
                    context.assertExpressionShape(
                        initializer,
                        "decl._layout.buffer?.minBindingSize",
                        "Compute buffer minimum size",
                    );
                    return [
                        `${indent}const auto minBindingSize = decl->layout.buffer ? decl->layout.buffer->min_binding_size : std::nullopt;`,
                    ];
                }
                if (name === "limits") {
                    context.assertExpressionShape(
                        initializer,
                        "engine._device.limits",
                        "Compute resource limits",
                    );
                    return [
                        `${indent}const auto limits = engine->offscreen_run->device().compute_shader_limits();`,
                    ];
                }
                if (name === "assertCount") {
                    if (
                        !ts.isArrowFunction(initializer) ||
                        !ts.isBlock(initializer.body) ||
                        initializer.parameters.length !== 3
                    )
                        return context.contractError(
                            initializer,
                            "Expected compute resource count guard.",
                        );
                    const body = lowerPinnedBody(
                        file,
                        initializer.body.statements,
                        {
                            bindings: new Map([
                                ["name", { cpp: "name", type: "opaque" }],
                                ["count", { cpp: "count", type: "scalar" }],
                                [
                                    "maximum",
                                    {
                                        cpp: "maximum.value()",
                                        type: "scalar",
                                        absentCpp: "!maximum.has_value()",
                                    },
                                ],
                            ]),
                            calls: new Map(),
                        },
                    );
                    return [
                        `${indent}const auto assertCount = [](const std::string& name,double count,std::optional<double> maximum){`,
                        body,
                        `${indent}};`,
                    ];
                }
            }
            if (!ts.isExpressionStatement(node)) return undefined;
            const expression = unwrapExpression(node.expression);
            if (
                ts.isBinaryExpression(expression) &&
                ts.isElementAccessExpression(expression.left) &&
                expression.left.expression.getText(file) === "dynamicCounts"
            ) {
                const index = lowerer.expression(
                        expression.left.argumentExpression,
                    ),
                    lines = [
                        `${indent}if (dynamicCounts.size() <= static_cast<std::size_t>(${index})) dynamicCounts.resize(static_cast<std::size_t>(${index}) + 1, 0.0);`,
                    ];
                if (expression.operatorToken.kind === ts.SyntaxKind.EqualsToken)
                    lines.push(
                        `${indent}dynamicCounts[static_cast<std::size_t>(${index})] = ${lowerer.expression(expression.right)};`,
                    );
                else if (
                    expression.operatorToken.kind !==
                        ts.SyntaxKind.QuestionQuestionEqualsToken ||
                    !context.expressionMatchesShape(expression.right, "0")
                )
                    return context.contractError(
                        expression,
                        "Expected dynamic binding count initialization.",
                    );
                return lines;
            }
            if (
                ts.isCallExpression(expression) &&
                expression.expression.getText(file) === "slots.set"
            ) {
                if (expression.arguments.length !== 2)
                    return context.contractError(
                        expression,
                        "Expected named compute binding slot.",
                    );
                const slot = pinnedRecordLiteral(
                    context,
                    lowerer,
                    expression.arguments[1]!,
                    {
                        cpp: "ComputeBindingSlot",
                        fields: {
                            _decl: { cpp: "decl" },
                            _dynamicIndex: { cpp: "dynamic_index" },
                        },
                    },
                );
                return [
                    `${indent}slots.insert_or_assign(${lowerer.expression(expression.arguments[0]!)}, ${slot});`,
                ];
            }
            return undefined;
        },
    };
}

export function lowerComputeShader(context: LoweringContext): LoweredSource {
    const output: string[] = [];
    for (const [name, method] of Object.entries(methods)) {
        const { file, declaration } = context.functionDeclaration(path, name);
        const body = lowerPinnedBody(file, declaration.body!.statements, {
            ...scope(context, file),
            returnValue: (node, lowerer) =>
                node ? lowerer.expression(node) : "",
        });
        output.push(
            `// ${context.provenance(path, name)}\n${name === "assertName" || name === "validateIndex" ? "static " : ""}${method.result} ${method.cpp}(${method.parameters}){\n${body}\n}`,
        );
    }
    return {
        modulePath: path,
        symbolName: "createComputeShader",
        header: "",
        source: `#include <bblite/pal_compute_shader.hpp>\n#include <set>\nnamespace bbl {\n${output.join("\n")}\n${lowerComputeShaderGpu(context)}\n}\n`,
    };
}
