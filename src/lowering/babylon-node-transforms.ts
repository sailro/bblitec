import ts from "typescript";
import { LoweringContext } from "./context.js";
import type { PinnedBodyScope } from "./pinned-body-lowerer.js";
import type { PinnedNumericLowerer } from "./pinned-numeric-lowerer.js";
import { pinnedNumericMathCalls } from "./pinned-operators.js";

export function babylonNodeTransformScope(
    context: LoweringContext,
    source: string,
): PinnedBodyScope {
    const factory = (
        call: ts.CallExpression,
        lowerer: PinnedNumericLowerer,
    ): string => {
        const quaternion = context.expressionMatchesShape(
            call.expression,
            "createTransformNode",
        );
        const symbol = quaternion ? "createTransformNode" : "initMeshTransform";
        const declaration = context.functionDeclaration(
            quaternion ? "src/scene/transform-node.ts" : "src/mesh/mesh.ts",
            symbol,
        ).declaration;
        const parameters = declaration.parameters;
        if (call.arguments.length !== parameters.length)
            context.contractError(
                call,
                "Expected explicit Babylon node transform arguments.",
            );
        const values = new Map<string, string>();
        parameters.slice(1).forEach((parameter, index) => {
            if (!ts.isIdentifier(parameter.name))
                context.contractError(
                    parameter,
                    "Expected a scalar transform parameter.",
                );
            values.set(
                parameter.name.text,
                lowerer.expression(call.arguments[index + 1]!),
            );
        });
        const lanes = (names: string[], narrow: boolean): string =>
            names
                .map((name) => {
                    const value = values.get(name);
                    if (!value)
                        context.contractError(
                            call,
                            `Unrepresented node transform parameter '${name}'.`,
                        );
                    return narrow ? `static_cast<float>(${value})` : value;
                })
                .join(", ");
        if (values.size !== (quaternion ? 10 : 9))
            context.contractError(
                call,
                "Unrepresented node transform argument.",
            );
        return (
            `upstream::TrsLanes{${quaternion ? "" : `.rotation = Vec3{${lanes(["rx", "ry", "rz"], true)}}, `}` +
            `.scaling = Vec3{${lanes(["sx", "sy", "sz"], true)}}, .position = Vec3d{${lanes(["px", "py", "pz"], false)}}` +
            `${quaternion ? `, .has_rotation_quaternion = true, .rotation_quaternion = Vec4{${lanes(["qx", "qy", "qz", "qw"], true)}}` : ""}}`
        );
    };
    return {
        bindings: new Map(),
        calls: pinnedNumericMathCalls(),
        expression(node, lowerer) {
            if (
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
            ) {
                const left = context.unwrapExpression(node.left);
                if (
                    ts.isElementAccessExpression(left) &&
                    left.questionDotToken &&
                    ts.isPropertyAccessExpression(left.expression) &&
                    ts.isIdentifier(left.expression.expression) &&
                    left.expression.expression.text === "md"
                ) {
                    const field = left.expression.name.text;
                    if (!["position", "rotation", "scaling"].includes(field))
                        context.contractError(
                            left,
                            "Unsupported Babylon transform property.",
                        );
                    return `double_at(${source}, ${JSON.stringify(field)}, static_cast<std::size_t>(${lowerer.expression(left.argumentExpression)}), ${lowerer.expression(node.right)})`;
                }
            }
            if (
                ts.isCallExpression(node) &&
                (context.expressionMatchesShape(
                    node.expression,
                    "initMeshTransform",
                ) ||
                    context.expressionMatchesShape(
                        node.expression,
                        "createTransformNode",
                    ))
            )
                return factory(node, lowerer);
            return undefined;
        },
        returnValue: (value, lowerer) => lowerer.expression(value!),
    };
}
