import ts from "typescript";
import { LoweringContext } from "./context.js";
import type { PinnedBodyScope } from "./pinned-body-lowerer.js";
import type { PinnedBinding } from "./pinned-numeric-lowerer.js";

/** The pin selects a material independently for each uploaded submesh. */
export function babylonSubmeshMaterialScope(
    context: LoweringContext,
    source: string,
    materialIndex: string,
): PinnedBodyScope {
    const bindings = new Map<string, PinnedBinding>([
        [
            "md.materialId",
            {
                cpp: `string_or(${source}, "materialId")`,
                type: "opaque",
                absentCpp: `string_or(${source}, "materialId").empty()`,
            },
        ],
        ["matIds", { cpp: "mat_ids.has_value()", type: "bool" }],
        ["matIds.length", { cpp: "mat_ids->size()", type: "index" }],
        ["sub.materialIndex", { cpp: materialIndex, type: "index" }],
    ]);
    return {
        bindings,
        calls: new Map([
            ["createStandardMaterial", () => "default_material(engine)"],
        ]),
        booleanAnd: true,
        expression(node, lowerer) {
            if (
                ts.isElementAccessExpression(node) &&
                context.expressionMatchesShape(node.expression, "matIds")
            )
                return `mat_ids->at(static_cast<std::size_t>(${lowerer.expression(node.argumentExpression)}))`;
            if (
                !ts.isBinaryExpression(node) ||
                node.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken
            )
                return undefined;
            const left = context.unwrapExpression(node.left);
            if (context.expressionMatchesShape(left, "multi")) {
                const array = context.unwrapExpression(node.right);
                if (!ts.isArrayLiteralExpression(array))
                    context.contractError(
                        array,
                        "Expected the single-material fallback list.",
                    );
                return `(multi ? *multi : std::vector<std::string>{${array.elements.map((value) => lowerer.expression(value)).join(", ")}})`;
            }
            if (
                ts.isCallExpression(left) &&
                context.expressionMatchesShape(
                    left.expression,
                    "materialMap.get",
                ) &&
                left.arguments.length === 1
            )
                return `([&]() { const auto found = materials.find(${lowerer.expression(left.arguments[0]!)}); return found != materials.end() ? found->second : ${lowerer.expression(node.right)}; }())`;
            return undefined;
        },
        statement(statement, lowerer, indent) {
            if (
                ts.isVariableStatement(statement) &&
                statement.declarationList.declarations.length === 1
            ) {
                const variable = statement.declarationList.declarations[0]!;
                if (!ts.isIdentifier(variable.name)) return undefined;
                if (variable.name.text === "matIds") {
                    if (
                        variable.initializer?.kind !== ts.SyntaxKind.NullKeyword
                    )
                        context.contractError(
                            variable,
                            "Expected an initially absent material ID list.",
                        );
                    return [
                        `${indent}std::optional<std::vector<std::string>> mat_ids;`,
                    ];
                }
                if (variable.name.text === "mat" && !variable.initializer)
                    return [`${indent}MaterialHandle material;`];
                if (variable.name.text === "multi" && variable.initializer) {
                    const call = context.unwrapExpression(variable.initializer);
                    if (
                        !ts.isCallExpression(call) ||
                        !context.expressionMatchesShape(
                            call.expression,
                            "multiMatMap.get",
                        ) ||
                        call.arguments.length !== 1
                    )
                        context.contractError(
                            call,
                            "Expected the multi-material lookup.",
                        );
                    return [
                        `${indent}const auto multi_found = multi_materials.find(${lowerer.expression(call.arguments[0]!)});`,
                        `${indent}const auto* multi = multi_found != multi_materials.end() ? &multi_found->second : nullptr;`,
                    ];
                }
            }
            if (!ts.isExpressionStatement(statement)) return undefined;
            const assignment = context.unwrapExpression(statement.expression);
            if (
                !ts.isBinaryExpression(assignment) ||
                assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
                !ts.isIdentifier(assignment.left)
            )
                return undefined;
            const destination =
                assignment.left.text === "mat"
                    ? "material"
                    : assignment.left.text === "matIds"
                      ? "mat_ids"
                      : undefined;
            return destination
                ? [
                      `${indent}${destination} = ${lowerer.expression(assignment.right)};`,
                  ]
                : undefined;
        },
    };
}
