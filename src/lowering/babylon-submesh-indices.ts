import ts from "typescript";
import { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";

export function lowerBabylonSubmeshDefaults(context: LoweringContext): string {
    const module = "src/loader-babylon/load-babylon.ts";
    const { file, declaration } = context.functionDeclaration(
        module,
        "loadBabylon",
    );
    const initializer = context.variableInitializer(declaration, "subMeshes");
    const defaults = lowerPinnedBody(
        file,
        [ts.factory.createReturnStatement(initializer)],
        {
            bindings: new Map([
                [
                    "positions.length",
                    {
                        cpp: "static_cast<double>(position_count)",
                        type: "scalar",
                    },
                ],
                [
                    "allIndices.length",
                    { cpp: "static_cast<double>(index_count)", type: "scalar" },
                ],
            ]),
            calls: new Map(),
            returnValue: (value, lowerer) => lowerer.expression(value!),
            expression(node, lowerer) {
                if (
                    ts.isBinaryExpression(node) &&
                    node.operatorToken.kind ===
                        ts.SyntaxKind.QuestionQuestionToken &&
                    context.expressionMatchesShape(node.left, "md.subMeshes")
                )
                    return `((source.contains("subMeshes") && !source.at("subMeshes").is_null()) ? source.at("subMeshes") : ${lowerer.expression(node.right)})`;
                if (ts.isArrayLiteralExpression(node))
                    return `Json::array({${node.elements.map((value) => lowerer.expression(value)).join(", ")}})`;
                if (ts.isObjectLiteralExpression(node))
                    return `Json{${node.properties
                        .map((property) => {
                            if (!ts.isPropertyAssignment(property))
                                context.contractError(
                                    property,
                                    "Unsupported submesh descriptor property.",
                                );
                            return `{${JSON.stringify(context.propertyName(property.name))}, ${lowerer.expression(property.initializer)}}`;
                        })
                        .join(", ")}}`;
                return undefined;
            },
        },
    );
    return `Json babylon_submeshes(const Json& source, std::size_t position_count, std::size_t index_count) {\n${defaults}\n}`;
}
