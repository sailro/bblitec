import ts from "typescript";
import { type LoweringContext, unwrapExpression } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import { opaqueElement, type PinnedBinding } from "./pinned-numeric-lowerer.js";

/** Invoke retained scene callbacks in the pin's prepared plugin order. */
export function lowerMaterialPluginUniformBody(
    context: LoweringContext,
): string {
    const path = "src/material/plugin/plugin-bridge-shared.ts";
    const { file, declaration } = context.functionDeclaration(
        path,
        "writePluginUbo",
    );
    return (
        `// ${context.provenance(path, "writePluginUbo")}\n` +
        lowerPinnedBody(file, declaration.body!.statements, {
            calls: new Map(),
            bindings: new Map<string, PinnedBinding>([
                ["data", { cpp: "data", type: "opaque" }],
                ["offsets", { cpp: "offsets", type: "opaque" }],
                // The prepared plugin list, held behind a pointer.
                [
                    "plugins",
                    {
                        cpp: "plugins",
                        type: "opaque",
                        elements: { range: "*plugins", element: opaqueElement },
                    },
                ],
            ]),
            statement(node, lowerer, indent) {
                if (!ts.isExpressionStatement(node)) return undefined;
                const call = unwrapExpression(node.expression);
                if (
                    !ts.isCallExpression(call) ||
                    !call.questionDotToken ||
                    !context.expressionMatchesShape(
                        call.expression,
                        "p.writeUbo",
                    )
                )
                    return undefined;
                return [
                    `${indent}if (p) p(${call.arguments.map((arg) => lowerer.expression(arg)).join(", ")});`,
                ];
            },
        })
    );
}
