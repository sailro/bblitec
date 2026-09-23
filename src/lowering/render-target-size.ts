import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import { pinnedNumericMathCalls } from "./pinned-operators.js";

/** The scaled arm of the public descriptor resolver; surface selection stays in PAL. */
export function lowerSurfaceRenderTargetSize(context: LoweringContext): string {
    const { file, declaration } = context.functionDeclaration(
        "src/engine/render-target.ts",
        "_resolveRenderTargetSize",
    );
    const branch = declaration.body?.statements.find(ts.isIfStatement);
    if (!branch || !ts.isBlock(branch.thenStatement))
        return context.contractError(
            declaration,
            "Expected scaled surface size branch.",
        );
    context.assertExpressionShape(
        branch.expression,
        '"surface" in size',
        "Surface size selection",
    );
    const calls = pinnedNumericMathCalls();
    calls.set("Number.isFinite", (args) => `std::isfinite(${args.join(", ")})`);
    const body = lowerPinnedBody(file, branch.thenStatement.statements, {
        bindings: new Map([
            ["size.scale", { cpp: "surface_scale", type: "scalar" }],
            ["canvas.width", { cpp: "width", type: "scalar" }],
            ["canvas.height", { cpp: "height", type: "scalar" }],
        ]),
        calls,
        statement: (node) => {
            if (!ts.isVariableStatement(node)) return undefined;
            const entries = node.declarationList.declarations;
            if (entries.length !== 1) return undefined;
            const entry = entries[0]!;
            if (
                !ts.isIdentifier(entry.name) ||
                entry.name.text !== "canvas" ||
                !entry.initializer
            )
                return undefined;
            context.assertExpressionShape(
                entry.initializer,
                "size.surface.canvas",
                "Surface extent owner",
            );
            return [];
        },
        returnValue: (expression, lowerer) => {
            if (
                !expression ||
                !ts.isObjectLiteralExpression(expression) ||
                expression.properties.length !== 2
            )
                return context.contractError(
                    expression ?? declaration,
                    "Expected width/height result.",
                );
            const fields = ["width", "height"].map((name, index) => {
                const field = expression.properties[index]!;
                if (
                    !ts.isPropertyAssignment(field) ||
                    context.propertyName(field.name) !== name
                )
                    return context.contractError(
                        field,
                        `Expected ${name} dimension.`,
                    );
                return lowerer.expression(field.initializer);
            });
            return `{${fields.join(", ")}}`;
        },
    });
    return `// ${context.provenance("src/engine/render-target.ts", "_resolveRenderTargetSize")}
std::array<double, 2> resolve_surface_render_target_size(double width, double height, double surface_scale) {
${body}
}
`;
}
