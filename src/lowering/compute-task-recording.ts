import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { unwrapExpression } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import type { PinnedBinding } from "./pinned-numeric-lowerer.js";

function recordCallback(context: LoweringContext, name: string) {
    const path = "src/compute/compute-task.ts";
    const { file, declaration } = context.methodDeclaration(
        path,
        "task.record",
    );
    const calls = context.findNodes(
        declaration,
        (node): node is ts.CallExpression =>
            ts.isCallExpression(node) && node.expression.getText(file) === name,
    );
    if (calls.length !== 1)
        return context.contractError(
            declaration,
            `Expected one ${name} callback.`,
        );
    const callback = calls[0]!.arguments[1];
    if (
        !callback ||
        !ts.isArrowFunction(callback) ||
        !ts.isBlock(callback.body)
    )
        return context.contractError(
            calls[0]!,
            "Expected a block compute pass callback.",
        );
    return { path, file, callback, body: callback.body };
}

/** The source gate runs before a compute pass is opened, including empty one-shots. */
export function computeTaskExecutionGateCpp(context: LoweringContext): string {
    const {
        path,
        file,
        callback,
        body: sourceBody,
    } = recordCallback(context, "setComputePassExecuteEnabled");
    if (callback.parameters.length)
        return context.contractError(
            callback,
            "Expected a parameterless compute pass gate.",
        );
    const body = lowerPinnedBody(file, sourceBody.statements, {
        bindings: new Map([
            [
                "task.executionEnabled",
                { cpp: "task.execution_enabled", type: "bool" },
            ],
            [
                "dispatches.length",
                {
                    cpp: "static_cast<double>(task.dispatches.size())",
                    type: "scalar",
                },
            ],
        ]),
        calls: new Map(),
        expression(node, lowerer) {
            if (
                !ts.isPropertyAccessExpression(node) ||
                node.name.text !== "enabled"
            )
                return undefined;
            const owner = unwrapExpression(node.expression);
            if (
                !ts.isElementAccessExpression(owner) ||
                owner.expression.getText(file) !== "dispatches"
            )
                return undefined;
            return `task.dispatches[static_cast<std::size_t>(${lowerer.expression(owner.argumentExpression)})]->enabled`;
        },
        statement(node, _lowerer, indent) {
            if (
                !ts.isExpressionStatement(node) ||
                !ts.isCallExpression(node.expression)
            )
                return undefined;
            if (
                !context.expressionMatchesShape(
                    node.expression,
                    "task._oneShotRecorded?.(task.engine._currentEncoder)",
                )
            )
                return undefined;
            return [
                `${indent}if (task.one_shot_recorded) task.one_shot_recorded(task.engine->current_compute_encoder);`,
            ];
        },
        returnValue(expression, lowerer) {
            if (!expression)
                return context.contractError(
                    callback,
                    "The compute gate must return a boolean.",
                );
            return lowerer.expression(expression);
        },
    });
    return `// ${context.provenance(path, "task.record")}
template<class Task> bool compute_task_execute_enabled(Task& task) {
${body}
}
`;
}

/** Bind-group cache comparisons and ordered dispatch recording from task.record. */
export function computeTaskDispatchRecordingCpp(
    context: LoweringContext,
    production = false,
): string {
    const {
        path,
        file,
        body: sourceBody,
    } = recordCallback(context, "setComputePassExecuteFunc");
    const offsets = context.functionDeclaration(path, "offsetsEqual");
    const equals = lowerPinnedBody(
        offsets.file,
        offsets.declaration.body!.statements,
        {
            bindings: new Map([
                [
                    "a",
                    { cpp: "a", type: "opaque", absentCpp: "!a.has_value()" },
                ],
                [
                    "a.length",
                    { cpp: "static_cast<double>(a->size())", type: "scalar" },
                ],
                [
                    "b.length",
                    { cpp: "static_cast<double>(b.size())", type: "scalar" },
                ],
            ]),
            calls: new Map(),

            expression(node, lowerer) {
                if (!ts.isElementAccessExpression(node)) return undefined;
                const owner = node.expression.getText(offsets.file);
                if (owner !== "a" && owner !== "b") return undefined;
                return `${owner === "a" ? "(*a)" : "b"}[static_cast<std::size_t>(${lowerer.expression(node.argumentExpression)})]`;
            },
            returnValue: (node, lowerer) =>
                node
                    ? lowerer.expression(node)
                    : context.contractError(
                          offsets.declaration,
                          "Expected an offset comparison result.",
                      ),
        },
    );
    const bindings = new Map<string, PinnedBinding>([
        [
            "dispatches.length",
            {
                cpp: "static_cast<double>(task.dispatches.size())",
                type: "scalar",
            },
        ],
        [
            "groups.length",
            { cpp: "static_cast<double>(groups.size())", type: "scalar" },
        ],
        ["dispatch.enabled", { cpp: "dispatch->enabled", type: "bool" }],
        ["dispatch.shader", { cpp: "dispatch->shader", type: "opaque" }],
        ["dispatch.bindings", { cpp: "dispatch->bindings", type: "opaque" }],
        [
            "dispatch._record",
            {
                cpp: "dispatch->record",
                type: "opaque",
                absentCpp: "!dispatch->record",
            },
        ],
        ...["x", "y", "z"].map(
            (axis, index) =>
                [
                    `dispatch._${axis}`,
                    { cpp: `dispatch->dimensions[${index}]`, type: "scalar" },
                ] as const,
        ),
        ["encoder", { cpp: "encoder", type: "opaque" }],
    ]);
    const calls = new Map<string, (args: readonly string[]) => string>([
        [
            "validatedBindings.clear",
            () =>
                production
                    ? "cache.validated->values.clear()"
                    : "cache.validated_bindings.clear()",
        ],
        [
            "validatedBindings.has",
            (args) =>
                `${production ? "cache.validated->values" : "cache.validated_bindings"}.contains(${args.join(", ")})`,
        ],
        [
            "validatedBindings.add",
            (args) =>
                `${production ? "cache.validated->values" : "cache.validated_bindings"}.insert(${args.join(", ")})`,
        ],
        [
            "_getComputePipeline",
            (args) =>
                production
                    ? `get_compute_pipeline(${args[0]})`
                    : `${args[0]}->pipeline()`,
        ],
        [
            "_ensureComputeBindingGroups",
            (args) =>
                production
                    ? `*ensure_compute_binding_groups(${args.join(", ")})`
                    : `${args[0]}->groups(${args[1]})`,
        ],
        [
            "offsetsEqual",
            (args) => `compute_offsets_equal(${args[0]}, *(${args[1]}))`,
        ],
        [
            "encoder.setPipeline",
            (args) => `encoder.set_pipeline(${args.join(", ")})`,
        ],
        [
            "encoder.setBindGroup",
            (args) =>
                `encoder.set_bind_group(static_cast<std::uint32_t>(${args[0]}), ${args[1]}${args.length === 3 ? `, *(${args[2]})` : ""})`,
        ],
        [
            "encoder.dispatchWorkgroups",
            (args) =>
                `encoder.dispatch(${args.map((value) => (production ? `pal::compute_api_dimension(${value})` : `static_cast<std::uint32_t>(${value})`)).join(", ")})`,
        ],
        ["dispatch._record", (args) => `dispatch->record(${args.join(", ")})`],
    ]);
    const indexed = new Map([
        ["dispatches", "task.dispatches"],
        ["groups", "groups"],
        ["lastGroups", "cache.last_groups"],
        ["lastOffsets", "cache.last_offsets"],
        ["dispatch._dynamicOffsets", "dispatch->dynamic_offsets"],
        [
            "dispatch.bindings._zeroDynamicOffsets",
            "dispatch->bindings->zero_offsets",
        ],
    ]);
    const body = lowerPinnedBody(file, sourceBody.statements, {
        bindings,
        calls,

        callShapes: new Map([
            ["validatedBindings.has", "bool"],
            ["offsetsEqual", "bool"],
        ]),
        expression(node, lowerer) {
            if (node.kind === ts.SyntaxKind.NullKeyword) return "std::nullopt";
            if (
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
            ) {
                if (
                    context.expressionMatchesShape(
                        node,
                        "dispatch._getPipeline?.() ?? _getComputePipeline(dispatch.shader)",
                    )
                )
                    return `(dispatch->get_pipeline ? dispatch->get_pipeline() : ${production ? "get_compute_pipeline(dispatch->shader)" : "dispatch->shader->pipeline()"})`;
                return `compute_optional_or(${lowerer.expression(node.left)}, [&]() { return ${lowerer.expression(node.right)}; })`;
            }
            if (!ts.isElementAccessExpression(node)) return undefined;
            const name = node.expression.getText(file),
                owner = indexed.get(name);
            if (!owner) return undefined;
            const index = `static_cast<std::size_t>(${lowerer.expression(node.argumentExpression)})`;
            if (production && name === "dispatch.bindings._zeroDynamicOffsets")
                return `compute_zero_offsets(dispatch->bindings->zero_dynamic_offsets, ${index})`;
            if (name === "dispatches" || name === "groups")
                return `${owner}[${index}]`;
            if (
                ts.isBinaryExpression(node.parent) &&
                node.parent.left === node &&
                node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
            )
                return `js::array_index_write(${owner}, ${index})`;
            return `compute_cached_at(${owner}, ${index})`;
        },
        statement(node, lowerer, indent) {
            if (
                ts.isExpressionStatement(node) &&
                ts.isBinaryExpression(node.expression)
            ) {
                const assignment = node.expression;
                if (
                    assignment.operatorToken.kind ===
                        ts.SyntaxKind.EqualsToken &&
                    ts.isElementAccessExpression(assignment.left)
                ) {
                    const owner = assignment.left.expression.getText(file);
                    if (owner === "lastGroups" || owner === "lastOffsets")
                        return [
                            `${indent}${lowerer.expression(assignment.left)} = ${lowerer.expression(assignment.right)};`,
                        ];
                }
            }
            if (ts.isVariableStatement(node)) {
                const entry = node.declarationList.declarations[0];
                if (
                    node.declarationList.declarations.length !== 1 ||
                    !entry ||
                    !ts.isIdentifier(entry.name) ||
                    !entry.initializer
                )
                    return undefined;
                const name = entry.name.text;
                const pointerTypes: Record<string, string> = {
                    lastPipeline: production
                        ? "std::shared_ptr<pal::ComputePipeline>"
                        : "decltype(task.dispatches[0]->shader->pipeline())",
                    lastShader: "decltype(task.dispatches[0]->shader)",
                };
                if (pointerTypes[name]) {
                    context.assertExpressionShape(
                        entry.initializer,
                        "null",
                        "Empty compute recording cache",
                    );
                    bindings.set(name, {
                        cpp: name,
                        type: "opaque",
                        absentCpp: `!${name}`,
                    });
                    return [`${indent}${pointerTypes[name]} ${name}{};`];
                }
                if (
                    [
                        "dispatch",
                        "pipeline",
                        "groups",
                        "bindGroup",
                        "offsets",
                    ].includes(name)
                ) {
                    const expression = lowerer.expression(entry.initializer);
                    bindings.set(name, {
                        cpp: name,
                        type: "opaque",
                        ...(name === "offsets"
                            ? { absentCpp: "!offsets.has_value()" }
                            : {}),
                    });
                    const reference = name === "groups" || name === "bindGroup";
                    return [
                        `${indent}const auto${reference ? "&" : ""} ${name} = ${expression};`,
                    ];
                }
                return undefined;
            }
            if (
                !ts.isExpressionStatement(node) ||
                !ts.isCallExpression(node.expression)
            )
                return undefined;
            const call = node.expression;
            for (const [name, cpp] of [
                ["lastGroups", "cache.last_groups"],
                ["lastOffsets", "cache.last_offsets"],
            ] as const) {
                if (call.expression.getText(file) !== `${name}.fill`) continue;
                context.assertExpressionShape(
                    call,
                    `${name}.fill(null)`,
                    "Reset compute binding cache",
                );
                return [
                    `${indent}std::fill(${cpp}.begin(), ${cpp}.end(), typename std::decay_t<decltype(${cpp})>::value_type{});`,
                ];
            }
            if (
                context.expressionMatchesShape(
                    call,
                    "_prepareComputeDispatchRecord?.(encoder, dispatch)",
                )
            )
                return [`${indent}if (prepare) prepare(encoder, dispatch);`];
            if (
                context.expressionMatchesShape(
                    call,
                    "task._oneShotRecorded?.(task.engine._currentEncoder)",
                )
            )
                return [
                    `${indent}if (task.one_shot_recorded) task.one_shot_recorded(task.engine->current_compute_encoder);`,
                ];
            return undefined;
        },
    });
    return `template<class Values> auto compute_cached_at(const Values& values, std::size_t index) {
    return index < values.size() ? values[index] : typename Values::value_type{};
}
${
    production
        ? `template<class Values> auto compute_cached_at(const std::optional<Values>& values,std::size_t index) { return values ? compute_cached_at(*values,index) : typename Values::value_type{}; }
inline std::optional<ComputeOffsets> compute_zero_offsets(const std::optional<std::vector<std::vector<double>>>& values,std::size_t index) { if(!values || index>=values->size()) return {}; return ComputeOffsets((*values)[index].begin(),(*values)[index].end()); }
`
        : ""
}
template<class Value,class Fallback> Value compute_optional_or(Value value,Fallback fallback) {
    return value ? value : Value(fallback());
}
// ${context.provenance(path, "offsetsEqual")}
template<class Offsets> bool compute_offsets_equal(const std::optional<Offsets>& a,const Offsets& b) {
${equals}
}
// ${context.provenance(path, "task.record")}
template<class Task,class Encoder,class Cache,class Prepare> void record_compute_dispatches(Task& task,Encoder& encoder,Cache& cache,Prepare& prepare) {
${body}
}
`;
}
