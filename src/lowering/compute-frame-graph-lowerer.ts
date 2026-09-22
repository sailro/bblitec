import ts from "typescript";
import type { LoweredSource, LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import { stringLiteral } from "../cpp-literals.js";
import { type PinnedBinding } from "./pinned-numeric-lowerer.js";

/** Project source registration/recording onto native graph task handles. */
export function lowerComputeFrameGraph(
    context: LoweringContext,
): LoweredSource {
    const output: string[] = [];
    const actions = "src/frame-graph/frame-graph-actions.ts",
        graph = "src/frame-graph/frame-graph.ts";
    for (const [path, source, signature] of [
        [
            actions,
            "addTaskAtStart",
            "void prepend_compute_frame_task(Engine& engine,std::vector<TaskHandle>& tasks,TaskHandle task)",
        ],
        [
            graph,
            "_appendTask",
            "void append_compute_frame_task(std::vector<TaskHandle>& tasks,TaskHandle task)",
        ],
        [
            graph,
            "recordTask",
            "void record_compute_frame_task(const std::shared_ptr<ComputeTask>& task)",
        ],
    ] as const) {
        const { file, declaration } = context.functionDeclaration(path, source);
        const bindings = new Map<string, PinnedBinding>([
            ["task", { cpp: "task", type: "opaque" }],
            [
                "fg._currentProcessedTask",
                { cpp: "current_task", type: "opaque" },
            ],
        ]);
        const body = lowerPinnedBody(file, declaration.body!.statements, {
            bindings,
            calls: new Map<string, (args: readonly string[]) => string>([
                [
                    "fg._tasks.push",
                    (args) => `tasks.push_back(${args.join(", ")})`,
                ],
                ["task.record", () => "task->record()"],
            ]),
            expression(node) {
                if (ts.isStringLiteral(node)) return stringLiteral(node.text);
                if (node.kind === ts.SyntaxKind.NullKeyword) return "{}";
                if (context.expressionMatchesShape(node, "fg._tasks[0]?.name"))
                    return "compute_frame_task_name(engine,tasks.empty() ? TaskHandle{} : tasks.front())";
                return undefined;
            },
            statement(node, lowerer, indent) {
                if (
                    ts.isVariableStatement(node) &&
                    node.declarationList.declarations.length === 1
                ) {
                    const declaration = node.declarationList.declarations[0]!;
                    if (
                        ts.isIdentifier(declaration.name) &&
                        declaration.name.text === "fg" &&
                        declaration.initializer
                    ) {
                        context.assertExpressionShape(
                            declaration.initializer,
                            "resolveFg(target)",
                            "Typed native graph receiver",
                        );
                        return [];
                    }
                }
                if (!ts.isExpressionStatement(node)) return undefined;
                const expression = node.expression;
                if (
                    ts.isCallExpression(expression) &&
                    expression.expression.getText(file) === "fg._tasks.splice"
                ) {
                    if (expression.arguments.length !== 3)
                        return context.contractError(
                            expression,
                            "Expected source task insertion.",
                        );
                    context.assertExpressionShape(
                        expression.arguments[1]!,
                        "0",
                        "Task insertion removes no tasks",
                    );
                    return [
                        `${indent}tasks.insert(tasks.begin() + static_cast<std::ptrdiff_t>(compute_frame_native_insertion_index(engine, tasks, ${lowerer.expression(expression.arguments[0]!)})), ${lowerer.expression(expression.arguments[2]!)});`,
                    ];
                }
                if (
                    ts.isBinaryExpression(expression) &&
                    expression.operatorToken.kind ===
                        ts.SyntaxKind.EqualsToken &&
                    expression.left.getText(file) === "task._passes.length"
                ) {
                    context.assertExpressionShape(
                        expression.right,
                        "0",
                        "Recorded pass collection reset",
                    );
                    return [`${indent}task->passes.clear();`];
                }
                return undefined;
            },
        });
        output.push(
            `// ${context.provenance(path, source)}\n${signature} {\n${source === "recordTask" ? "    std::shared_ptr<ComputeTask> current_task;\n" : ""}${body}\n}\n`,
        );
    }
    const execute = context.methodDeclaration(graph, "fg.execute");
    if (!execute.declaration.body || !ts.isBlock(execute.declaration.body))
        return context.contractError(
            execute.declaration,
            "Expected frame graph execution body.",
        );
    const body = lowerPinnedBody(
        execute.file,
        execute.declaration.body.statements,
        {
            bindings: new Map<string, PinnedBinding>([
                [
                    "task.executionEnabled",
                    { cpp: "task->execution_enabled", type: "bool" },
                ],
                [
                    "task.execute",
                    { cpp: "static_cast<bool>(task->execute)", type: "bool" },
                ],
            ]),
            calls: new Map([
                ["pass._execute", () => "pass->execute()"],
                ["task.execute", () => "task->execute()"],
            ]),
            forOf(iterated, element) {
                const range =
                    iterated === "fg._tasks"
                        ? "tasks"
                        : iterated === "task._passes"
                          ? "task->passes"
                          : undefined;
                if (!range) return undefined;
                return {
                    range,
                    bindings: new Map([
                        [element, { cpp: element, type: "opaque" }],
                    ]),
                };
            },
            returnValue: (value, lowerer) =>
                value ? lowerer.expression(value) : "",
        },
    );
    output.push(
        `// ${context.provenance(graph, "fg.execute")}\ndouble execute_compute_frame_tasks(const std::vector<std::shared_ptr<ComputeTask>>& tasks) {\n${body}\n}\n`,
    );
    return {
        modulePath: graph,
        symbolName: "recordTask",
        header: "",
        source: `#include <bblite/pal_compute_frame_graph.hpp>\nnamespace bbl {\n${output.join("\n")}\n}\n`,
    };
}
