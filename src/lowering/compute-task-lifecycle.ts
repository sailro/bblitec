import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { unwrapExpression } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import type { PinnedBinding } from "./pinned-numeric-lowerer.js";

/** Source task membership and teardown over the native task's retained carriers. */
export function computeTaskLifecycleCpp(
    context: LoweringContext,
    prefix = "",
): string {
    const path = "src/compute/compute-task.ts";
    const output: string[] = [];
    for (const [sourceName, cppName, method] of [
        ["addComputeDispatch", "add_compute_dispatch", false],
        ["removeComputeDispatch", "remove_compute_dispatch", false],
        ["task.dispose", "dispose_compute_task", true],
    ] as const) {
        const { file, declaration } = method
            ? context.methodDeclaration(path, sourceName)
            : context.functionDeclaration(path, sourceName);
        if (!declaration.body || !ts.isBlock(declaration.body))
            return context.contractError(
                declaration,
                "Expected a compute task body.",
            );
        const bindings = new Map<string, PinnedBinding>([
            ["task._disposed", { cpp: "task.disposed", type: "bool" }],
            ["task.name", { cpp: "task.name", type: "opaque" }],
            ["task.engine", { cpp: "task.engine", type: "opaque" }],
            [
                "dispatch.shader._engine",
                { cpp: "dispatch->shader->engine", type: "opaque" },
            ],
            ["dispatch", { cpp: "dispatch", type: "opaque" }],
        ]);
        const calls = new Map<string, (args: readonly string[]) => string>([
            [
                "task._dispatches.includes",
                (args) =>
                    `(js::array_index_of(task.dispatches, ${args.join(", ")}) >= 0)`,
            ],
            [
                "task._dispatches.indexOf",
                (args) =>
                    `js::array_index_of(task.dispatches, ${args.join(", ")})`,
            ],
            [
                "task._dispatches.push",
                (args) => `task.dispatches.push_back(${args.join(", ")})`,
            ],
            [
                "task._dispatches.splice",
                (args) =>
                    `(void)js::array_splice(task.dispatches, ${args.join(", ")}, {})`,
            ],
        ]);
        const body = lowerPinnedBody(file, declaration.body.statements, {
            bindings,
            calls,
            callShapes: new Map([
                ["task._dispatches.includes", "bool"],
                ["task._dispatches.indexOf", "scalar"],
            ]),
            statement(node, _lowerer, indent) {
                if (!ts.isExpressionStatement(node)) return undefined;
                const value = unwrapExpression(node.expression);
                if (ts.isCallExpression(value)) {
                    const optionalCalls: Record<string, string> = {
                        "task._oneShotDispose?.()":
                            "if (task.one_shot_dispose) task.one_shot_dispose();",
                        "task._pass?._dispose()":
                            "if (task.pass) task.pass->dispose();",
                        "task._disposeOwned?.()":
                            "if (task.dispose_owned) task.dispose_owned();",
                    };
                    for (const [shape, cpp] of Object.entries(optionalCalls))
                        if (context.expressionMatchesShape(value, shape))
                            return [`${indent}${cpp}`];
                }
                if (
                    !ts.isBinaryExpression(value) ||
                    value.operatorToken.kind !== ts.SyntaxKind.EqualsToken
                )
                    return undefined;
                const target = value.left.getText(file);
                const arrays: Record<string, string> = {
                    "task._passes.length": "task.passes",
                    "task._dispatches.length": "task.dispatches",
                };
                if (arrays[target]) {
                    context.assertExpressionShape(
                        value.right,
                        "0",
                        "Empty compute task collection",
                    );
                    return [`${indent}${arrays[target]}.clear();`];
                }
                if (target === "task._pass") {
                    context.assertExpressionShape(
                        value.right,
                        "null",
                        "Released compute pass",
                    );
                    return [`${indent}task.pass.reset();`];
                }
                const cleared: Record<string, string> = {
                    "task._uniformArenas": "uniform_arenas",
                    "task._flushOwned": "flush_owned",
                    "task._disposeOwned": "dispose_owned",
                    "task._oneShotRecorded": "one_shot_recorded",
                    "task._oneShotDispose": "one_shot_dispose",
                };
                if (cleared[target]) {
                    context.assertExpressionShape(
                        value.right,
                        "undefined",
                        "Released compute task hook",
                    );
                    return [`${indent}task.${cleared[target]} = {};`];
                }
                return undefined;
            },
        });
        output.push(`// ${context.provenance(path, sourceName)}
template<class Task${method ? "" : ", class Dispatch"}> void ${prefix}${cppName}(Task& task${method ? "" : ", const Dispatch& dispatch"}) {
${body}
}
`);
    }
    return output.join("\n");
}
