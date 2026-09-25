import ts from "typescript";
import {
    type LoweredSource,
    type LoweringContext,
    unwrapExpression,
} from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import {
    PinnedNumericLowerer,
    type PinnedBinding,
    type PinnedNumericScope,
} from "./pinned-numeric-lowerer.js";
import {
    computeTaskExecutionGateCpp,
    computeTaskDispatchRecordingCpp,
} from "./compute-task-recording.js";

const taskPath = "src/compute/compute-task.ts";
const passPath = "src/frame-graph/compute-pass.ts";

/** Retained carriers and WebGPU command transport around pinned task/pass bodies. */
export function lowerComputeTaskExecution(
    context: LoweringContext,
): LoweredSource {
    const output: string[] = [];
    function scope(
        file: ts.SourceFile,
        passMember = false,
    ): PinnedNumericScope {
        const bindings = new Map<string, PinnedBinding>();
        for (const name of [
            "task",
            "engine",
            "dispatch",
            "pass",
            "tasks",
            "encoder",
            "name",
            "fn",
            "enabled",
        ])
            bindings.set(name, {
                cpp: name === "pass" && passMember ? "this" : name,
                type: "opaque",
            });
        const members: Record<string, [string, "opaque" | "scalar" | "bool"]> =
            {
                "task._disposed": ["task->disposed", "bool"],
                "task.name": ["task->name", "opaque"],
                "task.engine": ["task->engine", "opaque"],
                "task._pass": ["task->pass", "opaque"],
                "task.executionEnabled": ["task->execution_enabled", "bool"],
                "task._dispatches": ["task->dispatches", "opaque"],
                "tasks.length": ["static_cast<double>(tasks.size())", "scalar"],
                "dispatch.bindings": ["dispatch->bindings", "opaque"],
                "dispatch.shader": ["dispatch->shader", "opaque"],
                "engine._currentEncoder": [
                    "engine->current_compute_encoder",
                    "opaque",
                ],
                "pass.name": ["pass->name", "opaque"],
                "pass._parentTask": ["pass->parent", "opaque"],
                "pass._executeEnabled": ["pass->enabled", "opaque"],
                "pass._computeExecute": ["pass->body", "opaque"],
                "pass._beforeExecute": ["pass->before", "opaque"],
                "pass._executeFunc": ["pass->execute_func", "opaque"],
            };
        for (const [source, [cpp, type]] of Object.entries(members)) {
            const value = passMember ? cpp.replaceAll("pass->", "this->") : cpp;
            bindings.set(source, {
                cpp: value,
                type,
                ...(type === "opaque" ? { absentCpp: `!${value}` } : {}),
            });
        }
        const calls = new Map<string, (args: readonly string[]) => string>([
            [
                "createComputePass",
                (args) => `create_compute_pass(${args.join(", ")})`,
            ],
            [
                "setComputePassExecuteEnabled",
                (args) =>
                    `set_compute_pass_execute_enabled(${args.join(", ")})`,
            ],
            [
                "setComputePassExecuteFunc",
                (args) => `set_compute_pass_execute_func(${args.join(", ")})`,
            ],
            [
                "prepareComputeTask",
                (args) => `prepare_compute_task(${args.join(", ")})`,
            ],
            [
                "_ensureComputeBindingGroups",
                (args) => `ensure_compute_binding_groups(${args.join(", ")})`,
            ],
            [
                "prepareComputeShader",
                (args) => `prepare_compute_shader(${args.join(", ")})`,
            ],
            ["pending.push", (args) => `pending.push_back(${args.join(", ")})`],
            [
                "pass._executeEnabled",
                () => `${passMember ? "this" : "pass"}->enabled()`,
            ],
            [
                "pass._dependencies.clear",
                () => `${passMember ? "this" : "pass"}->dependencies.clear()`,
            ],
            ["task._pass!._execute", () => "task->pass->execute()"],
            ["encoder.end", () => "encoder.end()"],
        ]);
        return {
            bindings,
            calls,

            forOf(iterated, element) {
                const range =
                    iterated === "tasks"
                        ? "tasks"
                        : iterated === "task._dispatches"
                          ? "task->dispatches"
                          : undefined;
                if (!range) return undefined;
                return {
                    range,
                    bindings: new Map([
                        ...[...bindings].filter(([name]) =>
                            name.startsWith(`${element}.`),
                        ),
                        [element, { cpp: element, type: "opaque" }],
                    ]),
                };
            },
            callShapes: new Map([["pass._executeEnabled", "bool"]]),
            expression(input, lowerer) {
                const node = unwrapExpression(input);
                if (
                    node.kind === ts.SyntaxKind.NullKeyword ||
                    (ts.isIdentifier(node) && node.text === "undefined")
                )
                    return "{}";
                if (
                    ts.isPropertyAccessExpression(node) &&
                    node.name.text === "engine" &&
                    context.expressionMatchesShape(node.expression, "tasks[0]!")
                )
                    return "tasks[0]->engine";
                if (ts.isCallExpression(node)) {
                    const optional: Record<string, string> = {
                        "task._pass?._dispose()":
                            "(task->pass ? task->pass->dispose() : void())",
                        "task._flushOwned?.()":
                            "(task->flush_owned ? task->flush_owned() : void())",
                        "pass._beforeExecute?.()": `(${passMember ? "this" : "pass"}->before ? ${passMember ? "this" : "pass"}->before() : void())`,
                        "pass._computeExecute?.(encoder)": `(${passMember ? "this" : "pass"}->body ? ${passMember ? "this" : "pass"}->body(encoder) : void())`,
                        "engine._computeOneShotSubmitted?.(encoder)":
                            "(engine->compute_one_shot_submitted ? engine->compute_one_shot_submitted(encoder) : void())",
                    };
                    for (const [shape, cpp] of Object.entries(optional))
                        if (context.expressionMatchesShape(node, shape))
                            return cpp;
                    if (
                        node.expression.getText(file) ===
                        "engine._device.createCommandEncoder"
                    ) {
                        context.assertExpressionShape(
                            node.arguments[0]!,
                            '{label: "direct-compute-tasks"}',
                            "Immediate compute encoder descriptor",
                        );
                        return "std::make_shared<pal::ComputeCommandEncoder>(std::shared_ptr<pal::OffscreenDevice>(engine->offscreen_run, &engine->offscreen_run->device()))";
                    }
                    if (
                        context.expressionMatchesShape(
                            node.expression,
                            "(pass._parentTask.engine as EngineContext)._currentEncoder.beginComputePass",
                        )
                    ) {
                        context.assertExpressionShape(
                            node.arguments[0]!,
                            "{label: pass.name}",
                            "Compute pass descriptor",
                        );
                        return `${passMember ? "this" : "pass"}->parent->engine->current_compute_encoder->begin_compute_pass(${passMember ? "this" : "pass"}->name)`;
                    }
                }
                if (
                    ts.isBinaryExpression(node) &&
                    node.operatorToken.kind ===
                        ts.SyntaxKind.QuestionQuestionToken &&
                    context.expressionMatchesShape(
                        node.left,
                        "dispatch._preparePipeline?.()",
                    )
                )
                    return `(dispatch->prepare_pipeline ? dispatch->prepare_pipeline() : ${lowerer.expression(node.right)})`;
                if (ts.isArrowFunction(node)) {
                    const parent = node.parent;
                    if (
                        ts.isCallExpression(parent) &&
                        parent.expression.getText(file) ===
                            "setComputePassExecuteEnabled"
                    )
                        return "js::make_closure(std::tuple{task}, [](auto& captures) { return compute_task_execute_enabled(*std::get<0>(captures)); })";
                    if (
                        ts.isCallExpression(parent) &&
                        parent.expression.getText(file) ===
                            "setComputePassExecuteFunc"
                    )
                        return "js::make_closure(std::tuple{task, cache}, [](auto& captures, pal::ComputePassEncoder& encoder) { js::Callback<void(pal::ComputePassEncoder&,const std::shared_ptr<ComputeDispatch>&)> prepare; record_compute_dispatches(*std::get<0>(captures), encoder, *std::get<1>(captures), prepare); })";
                    if (!ts.isBlock(node.body)) {
                        const callbackBody = lowerer.expression(node.body);
                        return `js::make_closure(std::tuple{task}, [](auto& captures) { const auto& task = std::get<0>(captures); ${callbackBody}; })`;
                    }
                }
                return undefined;
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
                    const name = declaration.name.text;
                    if (name === "lastGroups" || name === "lastOffsets") {
                        context.assertExpressionShape(
                            declaration.initializer,
                            "[]",
                            "Empty compute pass cache",
                        );
                        return [
                            `${indent}cache->${name === "lastGroups" ? "last_groups" : "last_offsets"} = {};`,
                        ];
                    }
                    if (name === "pending") {
                        context.assertExpressionShape(
                            declaration.initializer,
                            "[]",
                            "Pending compute pipeline preparations",
                        );
                        lowerer.bindPorts(
                            [[name, { cpp: name, type: "opaque" }]],
                            node,
                        );
                        return [
                            `${indent}js::Array<js::Promise<js::PromiseVoid>> pending;`,
                        ];
                    }
                    if (["pass", "encoder", "engine"].includes(name)) {
                        lowerer.bindPorts(
                            [[name, { cpp: name, type: "opaque" }]],
                            node,
                        );
                        return [
                            `${indent}auto ${name} = ${lowerer.expression(declaration.initializer)};`,
                        ];
                    }
                }
                if (!ts.isExpressionStatement(node)) return undefined;
                const value = unwrapExpression(node.expression);
                if (
                    ts.isAwaitExpression(value) &&
                    ts.isCallExpression(value.expression) &&
                    value.expression.expression.getText(file) === "Promise.all"
                )
                    return [
                        `${indent}(void)co_await js::promise_all(${lowerer.expression(value.expression.arguments[0]!)});`,
                    ];
                if (
                    ts.isCallExpression(value) &&
                    value.expression.getText(file) ===
                        "engine._device.queue.submit"
                ) {
                    context.assertExpressionShape(
                        value.arguments[0]!,
                        "[encoder.finish()]",
                        "Direct compute queue command list",
                    );
                    return [
                        `${indent}encoder->finish();`,
                        `${indent}encoder->submit();`,
                    ];
                }
                if (ts.isBinaryExpression(value)) {
                    if (
                        value.operatorToken.kind ===
                        ts.SyntaxKind.BarBarEqualsToken
                    )
                        return [
                            `${indent}${lowerer.expression(value.left)} = ${lowerer.expression(value.left)} || ${lowerer.expression(value.right)};`,
                        ];
                    if (
                        value.operatorToken.kind ===
                            ts.SyntaxKind.EqualsToken &&
                        ts.isElementAccessExpression(value.left) &&
                        value.left.expression.getText(file) === "task._passes"
                    )
                        return [
                            `${indent}js::array_index_write(task->passes, static_cast<std::size_t>(${lowerer.expression(value.left.argumentExpression)})) = ${lowerer.expression(value.right)};`,
                        ];
                }
                return undefined;
            },
        };
    }
    function lowerFunction(
        path: string,
        source: string,
        signature: string,
        method = false,
        passMember = false,
        suffix = "",
    ) {
        const { file, declaration } = method
            ? context.methodDeclaration(path, source)
            : context.functionDeclaration(path, source);
        if (!declaration.body || !ts.isBlock(declaration.body))
            return context.contractError(
                declaration,
                "Expected a compute scheduling body.",
            );
        const body = lowerPinnedBody(file, declaration.body.statements, {
            ...scope(file, passMember),
            returnValue: (value, lowerer) =>
                value ? lowerer.expression(value) : "",
        });
        output.push(
            `// ${context.provenance(path, source)}\n${signature} {\n${body}\n${suffix}\n}\n`,
        );
    }

    // Source object construction is represented by a retained subclass; every data initializer is lowered.
    const factory = context.functionDeclaration(passPath, "createComputePass");
    const initializer = context.variableInitializer(
        factory.declaration,
        "pass",
    );
    if (!ts.isObjectLiteralExpression(initializer))
        return context.contractError(
            initializer,
            "Expected a compute pass record.",
        );
    const fields: Record<string, string> = {
        name: "name",
        _parentTask: "parent",
        _dependencies: "dependencies",
        _executeFunc: "execute_func",
        _computeExecute: "body",
        _executeEnabled: "enabled",
        _beforeExecute: "before",
    };
    const assignments: string[] = [];
    for (const property of initializer.properties) {
        if (ts.isMethodDeclaration(property)) continue;
        if (
            !ts.isPropertyAssignment(property) &&
            !ts.isShorthandPropertyAssignment(property)
        )
            return context.contractError(
                property,
                "Unrepresented compute pass member.",
            );
        const name = context.propertyName(property.name),
            field = name ? fields[name] : undefined;
        if (!field)
            return context.contractError(
                property,
                "Unrepresented compute pass data field.",
            );
        const value = ts.isShorthandPropertyAssignment(property)
            ? property.name
            : property.initializer;
        if (name === "_dependencies") {
            context.assertExpressionShape(
                value,
                "new Set<RenderTarget>()",
                "Empty compute pass dependencies",
            );
            assignments.push(`        pass->${field} = {};`);
        } else {
            const text = new PinnedNumericLowerer(
                factory.file,
                scope(factory.file),
            ).expression(value);
            assignments.push(`        pass->${field} = ${text};`);
        }
    }
    const factoryScope = scope(factory.file),
        originalStatement = factoryScope.statement;
    factoryScope.statement = (node, lowerer, indent) => {
        if (
            ts.isVariableStatement(node) &&
            node.declarationList.declarations[0]?.initializer === initializer
        )
            return [
                `${indent}auto pass = js::make_gc_shared<ComputeRecordedPass>();`,
                ...assignments.map((line) => indent + line.trim()),
            ];
        return originalStatement?.(node, lowerer, indent);
    };
    const factoryBody = lowerPinnedBody(
        factory.file,
        factory.declaration.body!.statements,
        {
            ...factoryScope,
            returnValue: (value, lowerer) =>
                value ? lowerer.expression(value) : "",
        },
    );
    output.push(
        `// ${context.provenance(passPath, "createComputePass")}\nstd::shared_ptr<ComputeRecordedPass> create_compute_pass(const std::string& name,const std::shared_ptr<ComputeTask>& task) {\n${factoryBody}\n}\n`,
    );
    lowerFunction(
        passPath,
        "setComputePassExecuteFunc",
        "void set_compute_pass_execute_func(const std::shared_ptr<ComputeRecordedPass>& pass, js::Callback<void(pal::ComputePassEncoder&)> fn)",
    );
    lowerFunction(
        passPath,
        "setComputePassExecuteEnabled",
        "void set_compute_pass_execute_enabled(const std::shared_ptr<ComputeRecordedPass>& pass, js::Callback<bool()> enabled)",
    );
    lowerFunction(
        passPath,
        "pass._execute",
        "double ComputeRecordedPass::execute()",
        true,
        true,
    );
    lowerFunction(
        passPath,
        "pass._dispose",
        "void ComputeRecordedPass::dispose()",
        true,
        true,
    );
    const record = context.methodDeclaration(taskPath, "task.record");
    if (!record.declaration.body || !ts.isBlock(record.declaration.body))
        return context.contractError(
            record.declaration,
            "Expected compute record method.",
        );
    output.push(
        `// ${context.provenance(taskPath, "task.record")}\nvoid record_compute_task(const std::shared_ptr<ComputeTask>& task,const std::shared_ptr<ComputeValidatedBindings>& validated) {\n    auto cache = js::make_gc_shared<ComputeRecordingCache>();\n    cache->validated = validated;\n${lowerPinnedBody(record.file, record.declaration.body.statements, scope(record.file))}\n}\n`,
    );
    lowerFunction(
        taskPath,
        "submitComputeTasks",
        "void submit_compute_tasks(const std::vector<std::shared_ptr<ComputeTask>>& tasks)",
    );
    lowerFunction(
        taskPath,
        "prepareComputeTask",
        "js::Promise<js::PromiseVoid> prepare_compute_task(std::shared_ptr<ComputeTask> task)",
        false,
        false,
        "    co_return js::PromiseVoid{};",
    );
    const taskFactory = context.functionDeclaration(
        taskPath,
        "createComputeTask",
    );
    context.assertExpressionShape(
        context.variableInitializer(
            taskFactory.declaration,
            "validatedBindings",
        ),
        "new Set<ComputeBindingSet>()",
        "Task binding validation set",
    );
    output.push(
        `void initialize_compute_task_execution(const std::shared_ptr<ComputeTask>& task) {\n    auto validated = js::make_gc_shared<ComputeValidatedBindings>();\n    task->record = js::make_closure(std::tuple{task, validated}, [](auto& captures) { record_compute_task(std::get<0>(captures),std::get<1>(captures)); });\n}\n`,
    );
    return {
        modulePath: taskPath,
        symbolName: "submitComputeTasks",
        header: "",
        source: `#include <bblite/pal_compute_task_execution.hpp>\nnamespace bbl {\n${computeTaskExecutionGateCpp(context)}\n${computeTaskDispatchRecordingCpp(context, true)}\n${output.join("\n")}\n}\n`,
    };
}
