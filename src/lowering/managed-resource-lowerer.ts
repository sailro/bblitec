import ts from "typescript";
import type { LoweredSource, LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import { unwrapExpression } from "./context.js";

export function lowerManagedResources(context: LoweringContext): LoweredSource {
    const path = "src/resource/managed-resource-hooks.ts";
    const { file, declaration } = context.functionDeclaration(
        path,
        "registerManagedResourceDisposer",
    );
    const bindings = new Map([
        [
            "disposers.length",
            {
                cpp: "static_cast<double>(disposers->size())",
                type: "scalar" as const,
            },
        ],
        ["dispose", { cpp: "dispose", type: "opaque" as const }],
    ]);
    const body = lowerPinnedBody(file, declaration.body!.statements, {
        bindings,
        calls: new Map([
            [
                "disposers.push",
                (args) => `disposers->push_back(${args.join(", ")})`,
            ],
        ]),
        statement(node, _lowerer, indent) {
            if (ts.isVariableStatement(node)) {
                const entries = node.declarationList.declarations;
                if (
                    entries.length !== 1 ||
                    !ts.isIdentifier(entries[0]!.name) ||
                    entries[0]!.name.text !== "disposers" ||
                    !entries[0]!.initializer
                )
                    return undefined;
                context.assertExpressionShape(
                    entries[0]!.initializer,
                    "engine._managedResourceDisposers ??= []",
                    "Managed resource disposer storage",
                );
                return [
                    `${indent}if (!engine.managed_resource_disposers) engine.managed_resource_disposers = std::make_shared<std::vector<std::function<void()>>>();`,
                    `${indent}const auto disposers = engine.managed_resource_disposers;`,
                ];
            }
            if (
                !ts.isExpressionStatement(node) ||
                !ts.isBinaryExpression(node.expression) ||
                node.expression.operatorToken.kind !==
                    ts.SyntaxKind.EqualsToken ||
                node.expression.left.getText(file) !==
                    "engine._disposeManagedResources"
            )
                return undefined;
            const callback = node.expression.right;
            if (
                !ts.isArrowFunction(callback) ||
                callback.parameters.length ||
                !ts.isBlock(callback.body)
            )
                return context.contractError(
                    callback,
                    "Expected the managed resource teardown callback.",
                );
            const cleanup = lowerPinnedBody(
                file,
                callback.body.statements,
                {
                    bindings,
                    calls: new Map(),
                    expression(expression, lowerer) {
                        if (
                            !ts.isCallExpression(expression) ||
                            expression.arguments.length
                        )
                            return undefined;
                        const callee = unwrapExpression(expression.expression);
                        if (
                            !ts.isElementAccessExpression(callee) ||
                            callee.expression.getText(file) !== "disposers"
                        )
                            return undefined;
                        return `(*disposers)[static_cast<std::size_t>(${lowerer.expression(callee.argumentExpression)})]()`;
                    },
                },
                indent + "    ",
            );
            return [
                `${indent}engine.dispose_managed_resources = [disposers] {`,
                cleanup,
                `${indent}};`,
            ];
        },
    });
    return {
        modulePath: path,
        symbolName: "registerManagedResourceDisposer",
        header: "",
        source: `#include <bblite/runtime.hpp>
namespace bbl {
// ${context.provenance(path, "registerManagedResourceDisposer")}
void register_managed_resource_disposer(Engine& engine,std::function<void()> dispose) {
${body}
}
}
`,
    };
}
