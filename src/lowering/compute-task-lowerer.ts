import ts from "typescript";
import type { LoweredSource, LoweringContext } from "./context.js";
import { computeTaskLifecycleCpp } from "./compute-task-lifecycle.js";
import { stringLiteral } from "../cpp-literals.js";

export function lowerComputeTask(
    context: LoweringContext,
    execution = false,
): LoweredSource {
    const path = "src/compute/compute-task.ts";
    const { file, declaration } = context.functionDeclaration(
        path,
        "createComputeTask",
    );
    const nameDefault = declaration.parameters[1]?.initializer;
    if (!nameDefault || !ts.isStringLiteral(nameDefault))
        return context.contractError(
            declaration,
            "Expected a compute task name default.",
        );
    const initializer = context.variableInitializer(declaration, "task");
    if (!ts.isObjectLiteralExpression(initializer))
        return context.contractError(
            initializer,
            "Expected a compute task record.",
        );
    const members = new Map(
        initializer.properties.map((property) => [
            property.name?.getText(file),
            property,
        ]),
    );
    const fields: Record<string, string> = {
        name: "name",
        engine: "engine",
        dispatches: "dispatches",
        executionEnabled: "execution_enabled",
        _dispatches: "dispatches",
        _passes: "passes",
        _pass: "pass",
        _disposed: "disposed",
    };
    const assignments: string[] = [];
    for (const [name, member] of members) {
        if (name === "_preload" || name === "record" || name === "dispose") {
            if (!ts.isMethodDeclaration(member))
                return context.contractError(
                    member,
                    "Expected a retained compute task method.",
                );
            continue;
        }
        if (!name || !fields[name])
            return context.contractError(
                member,
                "Unrepresented compute task field.",
            );
        if (name === "_dispatches") {
            if (!ts.isPropertyAssignment(member))
                return context.contractError(
                    member,
                    "Expected the compute dispatch alias.",
                );
            context.assertExpressionShape(
                member.initializer,
                "dispatches",
                "Compute dispatch array identity",
            );
            continue;
        }
        const expression = ts.isShorthandPropertyAssignment(member)
            ? member.name
            : ts.isPropertyAssignment(member)
              ? member.initializer
              : undefined;
        if (!expression)
            return context.contractError(
                member,
                "Expected a compute task field initializer.",
            );
        // Primitive field values and empty native containers retain the source initializer.
        let cpp: string;
        if (name === "engine" || name === "name") {
            context.assertExpressionShape(
                expression,
                name,
                "Compute task factory parameter",
            );
            cpp = name;
        } else if (name === "dispatches") {
            context.assertExpressionShape(
                expression,
                "dispatches",
                "Compute dispatch collection",
            );
            context.assertExpressionShape(
                context.variableInitializer(declaration, "dispatches"),
                "[]",
                "Empty compute dispatch collection",
            );
            cpp = "{}";
        } else if (name === "_passes") {
            context.assertExpressionShape(
                expression,
                "[]",
                "Empty compute passes",
            );
            cpp = "{}";
        } else if (name === "_pass") {
            context.assertExpressionShape(
                expression,
                "null",
                "Absent compute pass",
            );
            cpp = "{}";
        } else if (
            expression.kind === ts.SyntaxKind.TrueKeyword ||
            expression.kind === ts.SyntaxKind.FalseKeyword
        )
            cpp =
                expression.kind === ts.SyntaxKind.TrueKeyword
                    ? "true"
                    : "false";
        else
            return context.contractError(
                expression,
                "Expected a boolean compute task flag.",
            );
        assignments.push(`    task->${fields[name]} = ${cpp};`);
    }
    for (const name of [
        ...Object.keys(fields),
        "_preload",
        "record",
        "dispose",
    ])
        if (!members.has(name))
            return context.contractError(
                initializer,
                `Missing compute task member ${name}.`,
            );
    return {
        modulePath: path,
        symbolName: "createComputeTask",
        header: "",
        source: `#include <bblite/pal_compute_task.hpp>
${execution ? "#include <bblite/pal_compute_task_execution.hpp>" : ""}
namespace bbl {
${computeTaskLifecycleCpp(context, "source_")}
${
    execution
        ? `void add_compute_dispatch(const std::shared_ptr<ComputeTask>& task,const std::shared_ptr<ComputeDispatch>& dispatch) { source_add_compute_dispatch(*task, dispatch); }
void remove_compute_dispatch(const std::shared_ptr<ComputeTask>& task,const std::shared_ptr<ComputeDispatch>& dispatch) { source_remove_compute_dispatch(*task, dispatch); }`
        : ""
}
// ${context.provenance(path, "createComputeTask")}
std::shared_ptr<ComputeTask> create_compute_task(std::shared_ptr<Engine> engine, std::optional<std::string> requested_name) {
    const auto name = requested_name.value_or(${stringLiteral(nameDefault.text)});
    auto task = js::make_gc_shared<ComputeTask>();
${assignments.join("\n")}
    task->dispose = js::make_closure(std::tuple{task}, [](auto& captures) {
        source_dispose_compute_task(*std::get<0>(captures));
    });
${execution ? "    initialize_compute_task_execution(task);" : ""}
    return task;
}
}
`,
    };
}
