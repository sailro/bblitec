import ts from "typescript";
import { stringLiteral } from "../cpp-literals.js";
import { type LoweringContext, unwrapExpression } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import {
    type PinnedBinding,
    type PinnedNumericScope,
} from "./pinned-numeric-lowerer.js";
import {
    pinnedRecordLiteral,
    type PinnedRecordSchema,
} from "./pinned-record-literal.js";

const path = "src/compute/compute-shader.ts";
const methods = {
    layoutEntry: [
        "compute_layout_entry",
        "pal::ComputeLayoutEntry",
        "const ComputeBindingDeclPtr& decl",
    ],
    _getComputeGroupLayouts: [
        "get_compute_group_layouts",
        "std::shared_ptr<pal::ComputeGroupLayouts>",
        "const std::shared_ptr<ComputeShader>& shader",
    ],
    pipelineDescriptor: [
        "compute_pipeline_descriptor",
        "pal::ComputePipelineDescriptor",
        "const std::shared_ptr<ComputeShader>& shader",
    ],
    _getComputePipeline: [
        "get_compute_pipeline",
        "std::shared_ptr<pal::ComputePipeline>",
        "const std::shared_ptr<ComputeShader>& shader",
    ],
} as const;

function gpuScope(
    context: LoweringContext,
    file: ts.SourceFile,
    method: string,
    reaction = false,
): PinnedNumericScope {
    const bindings = new Map<string, PinnedBinding>();
    for (const name of [
        "shader",
        "decl",
        "device",
        "layouts",
        "entries",
        "promise",
        "pipeline",
    ])
        bindings.set(name, { cpp: name, type: "opaque" });
    bindings.set("promise", {
        cpp: "promise",
        type: "opaque",
        absentCpp: "!promise",
    });
    bindings.set("shader._destroyed", {
        cpp: "shader->destroyed",
        type: "bool",
    });
    for (const [name, field] of Object.entries({
        name: "name",
        _source: "source",
        _entryPoint: "entry_point",
        _decls: "decls",
        _layouts: "layouts",
        _pipelineLayout: "pipeline_layout",
        _module: "module",
        _pipeline: "pipeline",
        _pending: "pending",
    }))
        bindings.set(`shader.${name}`, {
            cpp: `shader->${field}`,
            type: "opaque",
            ...([
                "_layouts",
                "_pipelineLayout",
                "_module",
                "_pipeline",
                "_pending",
            ].includes(name)
                ? { absentCpp: `!shader->${field}` }
                : {}),
        });
    bindings.set("shader._engine._device", {
        cpp: "std::shared_ptr<pal::OffscreenDevice>(shader->engine->offscreen_run, &shader->engine->offscreen_run->device())",
        type: "opaque",
    });
    bindings.set("decl.binding", { cpp: "decl->binding", type: "scalar" });
    bindings.set("decl.group", { cpp: "decl->group", type: "scalar" });
    bindings.set("decl._layout", { cpp: "decl->layout", type: "opaque" });
    bindings.set("SS.COMPUTE", { cpp: "4.0", type: "scalar" });
    const calls = new Map<string, (args: readonly string[]) => string>([
        [
            "_assertComputeShaderLive",
            (args) => `assert_compute_shader_live(${args.join(", ")})`,
        ],
        [
            "shader._engine._device.createBindGroupLayout",
            (args) =>
                `shader->device->create_compute_group_layout(${args.join(", ")})`,
        ],
        [
            "shader._engine._device.createPipelineLayout",
            (args) =>
                `shader->device->create_compute_pipeline_layout(${args.join(", ")})`,
        ],
        [
            "shader._engine._device.createComputePipeline",
            (args) =>
                `shader->device->create_compute_pipeline(${args.join(", ")})`,
        ],
        [
            "device.createShaderModule",
            (args) =>
                `device->create_compute_shader_module(${args.join(", ")}, shader->artifact)`,
        ],
        [
            "device.createComputePipelineAsync",
            (args) =>
                `pal::prepare_compute_pipeline(device, ${args.join(", ")})`,
        ],
        ["layouts.push", (args) => `layouts->push_back(${args.join(", ")})`],
    ]);
    for (const [name, [cpp]] of Object.entries(methods))
        calls.set(name, (args) => `${cpp}(${args.join(", ")})`);
    return {
        bindings,
        calls,
        foldConditions: false,
        expression(node, lowerer) {
            if (ts.isStringLiteralLike(node))
                return `std::string{${stringLiteral(node.text)}}`;
            if (node.kind === ts.SyntaxKind.NullKeyword) return "nullptr";
            if (ts.isNonNullExpression(node))
                return lowerer.expression(node.expression);
            if (ts.isTemplateExpression(node))
                return [
                    `std::string{${stringLiteral(node.head.text)}}`,
                    ...node.templateSpans.flatMap((span) => [
                        span.expression.getText(file) === "group"
                            ? `js::number_to_string(static_cast<double>(${lowerer.expression(span.expression)}))`
                            : lowerer.expression(span.expression),
                        `std::string{${stringLiteral(span.literal.text)}}`,
                    ]),
                ].join(" + ");
            if (
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind ===
                    ts.SyntaxKind.QuestionQuestionEqualsToken
            ) {
                const left = lowerer.expression(node.left),
                    right = lowerer.expression(node.right);
                return `([&](){ if (!${left}) ${left} = ${right}; return ${left}; })()`;
            }
            if (
                context.expressionMatchesShape(
                    node,
                    "shader._decls.at(-1)?.group ?? -1",
                )
            )
                return "(shader->decls.empty() ? -1.0 : shader->decls.back()->group)";
            if (!ts.isObjectLiteralExpression(node)) return undefined;
            let schema: PinnedRecordSchema;
            if (method === "layoutEntry")
                schema = {
                    cpp: "pal::ComputeLayoutEntry",
                    fields: {
                        binding: { cpp: "binding" },
                        visibility: { cpp: "visibility" },
                    },
                    spread: (value, l) => {
                        context.assertExpressionShape(
                            value,
                            "decl._layout",
                            "Compute binding layout spread",
                        );
                        return `static_cast<ComputeResourceLayout&>(record) = ${l.expression(value)};`;
                    },
                };
            else if (
                node.properties.some(
                    (property) =>
                        ts.isPropertyAssignment(property) &&
                        property.name.getText(file) === "entries",
                ) ||
                node.properties.some(
                    (property) =>
                        ts.isShorthandPropertyAssignment(property) &&
                        property.name.text === "entries",
                )
            )
                schema = {
                    cpp: "pal::ComputeGroupLayoutDescriptor",
                    fields: {
                        label: { cpp: "label" },
                        entries: { cpp: "entries" },
                    },
                };
            else if (
                node.properties.some(
                    (property) =>
                        ts.isPropertyAssignment(property) &&
                        property.name.getText(file) === "bindGroupLayouts",
                )
            )
                schema = {
                    cpp: "pal::ComputePipelineLayoutDescriptor",
                    fields: {
                        label: { cpp: "label" },
                        bindGroupLayouts: { cpp: "groups" },
                    },
                    spread: (value) => {
                        context.assertExpressionShape(
                            value,
                            "_pipelineLayoutDescriptorExtension?.(shader)",
                            "Uninstalled compute immediate extension",
                        );
                        return "";
                    },
                };
            else if (
                node.properties.some(
                    (property) =>
                        ts.isPropertyAssignment(property) &&
                        property.name.getText(file) === "code",
                )
            )
                schema = {
                    cpp: "pal::ComputeShaderModuleDescriptor",
                    fields: {
                        label: { cpp: "label" },
                        code: { cpp: "source" },
                    },
                };
            else
                schema = {
                    cpp: "pal::ComputePipelineDescriptor",
                    fields: {
                        label: { cpp: "label" },
                        layout: { cpp: "layout" },
                        compute: {
                            cpp: "compute",
                            record: {
                                cpp: "pal::ComputeStageDescriptor",
                                fields: {
                                    module: { cpp: "module" },
                                    entryPoint: { cpp: "entry_point" },
                                },
                            },
                        },
                    },
                };
            return pinnedRecordLiteral(context, lowerer, node, schema);
        },
        statement(node, lowerer, indent) {
            if (method === "prepareComputeShader") {
                if (ts.isReturnStatement(node) && !reaction) {
                    if (node.expression)
                        return context.contractError(
                            node,
                            "Expected void compute preparation return.",
                        );
                    return [`${indent}co_return js::PromiseVoid{};`];
                }
                if (ts.isTryStatement(node)) {
                    if (
                        !node.catchClause ||
                        node.finallyBlock ||
                        node.catchClause.variableDeclaration?.name.getText(
                            file,
                        ) !== "error"
                    )
                        return context.contractError(
                            node,
                            "Expected compute preparation rejection guard.",
                        );
                    return [
                        `${indent}try {`,
                        ...lowerer.statements(
                            node.tryBlock.statements,
                            indent + "    ",
                        ),
                        `${indent}} catch (...) {`,
                        ...lowerer.statements(
                            node.catchClause.block.statements,
                            indent + "    ",
                        ),
                        `${indent}}`,
                    ];
                }
                if (ts.isThrowStatement(node)) {
                    context.assertExpressionShape(
                        node.expression,
                        "error",
                        "Compute preparation rethrow",
                    );
                    return [`${indent}throw;`];
                }
                if (
                    ts.isExpressionStatement(node) &&
                    ts.isAwaitExpression(node.expression)
                ) {
                    context.assertExpressionShape(
                        node.expression.expression,
                        "promise",
                        "Compute preparation await",
                    );
                    return [`${indent}(void)co_await promise->result;`];
                }
                if (
                    ts.isExpressionStatement(node) &&
                    ts.isCallExpression(node.expression) &&
                    node.expression.expression.getText(file) === "promise.then"
                ) {
                    const call = node.expression;
                    if (call.arguments.length !== 2)
                        return context.contractError(
                            call,
                            "Expected compute preparation settlement handlers.",
                        );
                    const callbacks = call.arguments.map((argument, index) => {
                        if (
                            !ts.isArrowFunction(argument) ||
                            !ts.isBlock(argument.body) ||
                            argument.parameters.length !== (index === 0 ? 1 : 0)
                        )
                            return context.contractError(
                                argument,
                                "Expected compute preparation settlement callback.",
                            );
                        if (
                            index === 0 &&
                            argument.parameters[0]!.name.getText(file) !==
                                "pipeline"
                        )
                            return context.contractError(
                                argument,
                                "Expected prepared compute pipeline.",
                            );
                        const body = lowerPinnedBody(
                            file,
                            argument.body.statements,
                            gpuScope(context, file, method, true),
                        );
                        return `js::make_closure(std::tuple{shader, device, promise}, [](auto& environment, ${index === 0 ? "const std::shared_ptr<pal::ComputePipeline>& pipeline" : "std::exception_ptr"}) { auto& [shader, device, promise] = environment;\n${body}\n})`;
                    });
                    return [
                        `${indent}(void)promise->result.then(${callbacks.join(", ")});`,
                    ];
                }
            }
            if (
                ts.isExpressionStatement(node) &&
                ts.isBinaryExpression(node.expression) &&
                node.expression.operatorToken.kind ===
                    ts.SyntaxKind.QuestionQuestionEqualsToken
            )
                return [`${indent}${lowerer.expression(node.expression)};`];
            if (
                !ts.isVariableStatement(node) ||
                node.declarationList.declarations.length !== 1
            )
                return undefined;
            const declaration = node.declarationList.declarations[0]!;
            if (!ts.isIdentifier(declaration.name) || !declaration.initializer)
                return undefined;
            const name = declaration.name.text,
                initializer = unwrapExpression(declaration.initializer);
            if (name === "layouts") {
                context.assertExpressionShape(
                    initializer,
                    "[]",
                    "Compute layouts array",
                );
                return [
                    `${indent}auto layouts = std::make_shared<pal::ComputeGroupLayouts>();`,
                ];
            }
            if (name === "device" || name === "promise")
                return [
                    `${indent}${name === "device" ? "const " : ""}auto ${name} = ${lowerer.expression(initializer)};`,
                ];
            if (name !== "entries") return undefined;
            if (
                !ts.isCallExpression(initializer) ||
                !ts.isPropertyAccessExpression(initializer.expression) ||
                initializer.expression.name.text !== "map" ||
                initializer.arguments.length !== 1 ||
                !context.expressionMatchesShape(
                    initializer.arguments[0]!,
                    "layoutEntry",
                )
            )
                return context.contractError(
                    initializer,
                    "Expected compute layout entry mapping.",
                );
            const filter = initializer.expression.expression;
            if (
                !ts.isCallExpression(filter) ||
                !ts.isPropertyAccessExpression(filter.expression) ||
                filter.expression.name.text !== "filter" ||
                filter.arguments.length !== 1 ||
                !ts.isArrowFunction(filter.arguments[0]!)
            )
                return context.contractError(
                    filter,
                    "Expected compute group declaration filtering.",
                );
            context.assertExpressionShape(
                filter.expression.expression,
                "shader._decls",
                "Compute group declaration input",
            );
            const callback = filter.arguments[0];
            if (
                callback.parameters.length !== 1 ||
                callback.parameters[0]!.name.getText(file) !== "decl" ||
                ts.isBlock(callback.body)
            )
                return context.contractError(
                    callback,
                    "Expected compute group filter callback.",
                );
            return [
                `${indent}std::vector<pal::ComputeLayoutEntry> entries;`,
                `${indent}for (const auto& decl : shader->decls) if (${lowerer.expression(callback.body)}) entries.push_back(${lowerer.expression(initializer.arguments[0]!)}(decl));`,
            ];
        },
    };
}

export function lowerComputeShaderGpu(context: LoweringContext): string {
    const output: string[] = [];
    for (const [name, [cpp, result, parameters]] of Object.entries(methods)) {
        const { file, declaration } = context.functionDeclaration(path, name);
        const scope = gpuScope(context, file, name);
        scope.bindings.set("layoutEntry", {
            cpp: "compute_layout_entry",
            type: "opaque",
        });
        const body = lowerPinnedBody(file, declaration.body!.statements, {
            ...scope,
            returnValue: (node, lowerer) =>
                node ? lowerer.expression(node) : "",
        });
        output.push(
            `// ${context.provenance(path, name)}\n${name.startsWith("_") ? "" : "static "}${result} ${cpp}(${parameters}){\n${body}\n}`,
        );
    }
    const { file, declaration } = context.functionDeclaration(
        path,
        "prepareComputeShader",
    );
    const body = lowerPinnedBody(
        file,
        declaration.body!.statements,
        gpuScope(context, file, "prepareComputeShader"),
    );
    output.push(
        `// ${context.provenance(path, "prepareComputeShader")}\njs::Promise<js::PromiseVoid> prepare_compute_shader(std::shared_ptr<ComputeShader> shader){\n${body}\nco_return js::PromiseVoid{};\n}`,
    );
    return output.join("\n");
}
