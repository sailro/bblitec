import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import {
    collectionBinding,
    type PinnedBinding,
} from "./pinned-numeric-lowerer.js";

const module = "src/scene/scene-change.ts";

/** Lower source callback isolation over native callback and exception storage. */
export function lowerSceneDisposalCallbacks(context: LoweringContext): string {
    return ["throwFailures", "disposeSceneCallbacks"]
        .map((symbol) => {
            const { file, declaration } = context.functionDeclaration(
                module,
                symbol,
            );
            const bindings = new Map<string, PinnedBinding>([
                [
                    "failures",
                    {
                        cpp: "failures",
                        type: "opaque",
                    },
                ],
                [
                    "failures.length",
                    {
                        cpp: "static_cast<double>(failures.size())",
                        type: "scalar",
                    },
                ],
                [
                    "scene._disposables.splice(0)",
                    collectionBinding("std::exchange(scene.disposables, {})"),
                ],
            ]);
            const body = lowerPinnedBody(file, declaration.body!.statements, {
                bindings,
                calls: new Map([
                    ["callback", (args) => `callback(${args.join(", ")})`],
                    ["cleanup", (args) => `cleanup(${args.join(", ")})`],
                    [
                        "failures.push",
                        (args) => `failures.push_back(${args.join(", ")})`,
                    ],
                    [
                        "throwFailures",
                        (args) =>
                            `throw_scene_disposal_failures(${args.join(", ")})`,
                    ],
                ]),
                expression(node, lowerer) {
                    if (
                        ts.isElementAccessExpression(node) &&
                        context.expressionMatchesShape(
                            node.expression,
                            "failures",
                        )
                    )
                        return `failures.at(static_cast<std::size_t>(${lowerer.expression(node.argumentExpression)}))`;
                    return undefined;
                },
                statement(statement, lowerer, indent) {
                    if (ts.isVariableStatement(statement)) {
                        context.assertStatementShapes(
                            statement,
                            [statement],
                            "const failures: unknown[] = [];",
                            "Scene disposal failure storage",
                        );
                        return [
                            `${indent}std::vector<std::exception_ptr> failures;`,
                        ];
                    }
                    if (ts.isTryStatement(statement)) {
                        const clause = statement.catchClause;
                        const name = clause?.variableDeclaration?.name;
                        if (
                            !clause ||
                            !name ||
                            !ts.isIdentifier(name) ||
                            statement.finallyBlock
                        )
                            context.contractError(
                                statement,
                                "Expected a scene disposal failure collector.",
                            );
                        lowerer.bindLocal(name, {
                            cpp: "std::current_exception()",
                            type: "opaque",
                        });
                        return [
                            `${indent}try {`,
                            ...lowerer.statements(
                                statement.tryBlock.statements,
                                indent + "    ",
                            ),
                            `${indent}} catch (...) {`,
                            ...lowerer.statements(
                                clause.block.statements,
                                indent + "    ",
                            ),
                            `${indent}}`,
                        ];
                    }
                    if (ts.isThrowStatement(statement)) {
                        const value = statement.expression;
                        if (ts.isNewExpression(value)) {
                            context.assertExpressionShape(
                                value,
                                "new AggregateError(failures)",
                                "Scene disposal aggregate failure",
                            );
                            return [
                                `${indent}throw js::AggregateError(failures, "");`,
                            ];
                        }
                        return [
                            `${indent}std::rethrow_exception(${lowerer.expression(value)});`,
                        ];
                    }
                    if (
                        ts.isExpressionStatement(statement) &&
                        context.expressionMatchesShape(
                            statement.expression,
                            "scene._disposables.length = 0",
                        )
                    )
                        return [`${indent}scene.disposables.clear();`];
                    return undefined;
                },
            });
            const signature =
                symbol === "throwFailures"
                    ? "void throw_scene_disposal_failures(const std::vector<std::exception_ptr>& failures)"
                    : "template<class Cleanup>\nvoid dispose_scene_callbacks(Scene& scene, const Cleanup& cleanup)";
            return `// ${context.provenance(module, symbol)}\n${signature} {\n${body}\n}`;
        })
        .join("\n");
}
