import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";

/** Pinned insertion policy over the existing identity-bearing task list. */
export function lowerFrameGraphTaskActions(context: LoweringContext): string {
    const modulePath = "src/frame-graph/frame-graph-actions.ts";
    const { file, declaration } = context.functionDeclaration(
        modulePath,
        "addTaskAfter",
    );
    const body = lowerPinnedBody(file, declaration.body!.statements, {
        bindings: new Map([
            ["task", { cpp: "task", type: "opaque" }],
            ["after", { cpp: "after", type: "opaque" }],
        ]),
        calls: new Map([
            [
                "fg._tasks.indexOf",
                (args) => `js::array_index_of(tasks, ${args[0]})`,
            ],
            ["fg._tasks.push", (args) => `tasks.push_back(${args[0]})`],
        ]),
        callShapes: new Map([["fg._tasks.indexOf", "scalar"]]),
        statement(node, lowerer, indent) {
            if (
                ts.isVariableStatement(node) &&
                node.declarationList.declarations.length === 1
            ) {
                const variable = node.declarationList.declarations[0]!;
                if (
                    ts.isIdentifier(variable.name) &&
                    variable.name.text === "fg" &&
                    variable.initializer
                ) {
                    context.assertExpressionShape(
                        variable.initializer,
                        "resolveFg(target)",
                        "Typed native task-list receiver",
                    );
                    return [];
                }
            }
            if (
                ts.isExpressionStatement(node) &&
                ts.isCallExpression(node.expression) &&
                context.expressionMatchesShape(
                    node.expression.expression,
                    "fg._tasks.splice",
                )
            ) {
                const call = node.expression;
                if (call.arguments.length !== 3)
                    return context.contractError(
                        call,
                        "Expected insertion-only task splice.",
                    );
                context.assertExpressionShape(
                    call.arguments[1]!,
                    "0",
                    "Task insertion removes no tasks",
                );
                return [
                    `${indent}tasks.insert(tasks.begin() + static_cast<std::ptrdiff_t>(${lowerer.expression(call.arguments[0]!)}), ${lowerer.expression(call.arguments[2]!)});`,
                ];
            }
            return undefined;
        },
    });
    return `// ${context.provenance(modulePath, "addTaskAfter")}
static void insert_task_after(std::vector<TaskHandle>& tasks, TaskHandle task, TaskHandle after) {
${body}
}

void add_task_after(Scene& scene, TaskHandle task, TaskHandle after) {
    if (!scene.engine)
        throw std::runtime_error("Scene is not associated with an engine.");
    task_record(*scene.engine, task);
    task_record(*scene.engine, after);
    (insert_task_after)(scene.tasks, task, after);
}

void add_task_after(FrameGraphContext& context, TaskHandle task, TaskHandle after) {
    if (!context.engine)
        throw std::runtime_error("FrameGraphContext is not associated with an engine.");
    task_record(*context.engine, task);
    task_record(*context.engine, after);
    (insert_task_after)(context.tasks, task, after);
}`;
}
