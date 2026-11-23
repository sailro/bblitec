import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { sameSyntax } from "../compiler/syntax.js";
import { PinnedNumericLowerer } from "./pinned-numeric-lowerer.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";

/** Translate both fields of a pinned extent object in source order. */
function extentFields(
    context: LoweringContext,
    expression: ts.Expression | undefined,
    owner: ts.Node,
    lowerer: PinnedNumericLowerer,
): string {
    if (
        !expression ||
        !ts.isObjectLiteralExpression(expression) ||
        expression.properties.length !== 2
    )
        return context.contractError(
            expression ?? owner,
            "Expected width/height result.",
        );
    const fields = ["width", "height"].map((name, index) => {
        const field = expression.properties[index]!;
        if (
            !ts.isPropertyAssignment(field) ||
            context.propertyName(field.name) !== name
        )
            return context.contractError(field, `Expected ${name} dimension.`);
        return lowerer.expression(field.initializer);
    });
    return `{${fields.join(", ")}}`;
}

/** One resolver for bloom's allocation and re-recording; refuse if the two policies diverge. */
export function lowerBloomTargetSize(context: LoweringContext): string {
    const module = "src/post-process/bloom.ts";
    const create = context.functionDeclaration(
        module,
        "createScaledBloomTarget",
    );
    const resize = context.functionDeclaration(
        module,
        "resizeScaledBloomTarget",
    );
    const factory = context.functionDeclaration(
        module,
        "createBloomPostProcessTask",
    ).declaration;
    const factoryCalls = context.findNodes(factory, ts.isCallExpression);
    for (const symbol of [
        "createScaledBloomTarget",
        "resizeScaledBloomTarget",
    ]) {
        const calls = factoryCalls.filter(
            (call) =>
                ts.isIdentifier(call.expression) &&
                call.expression.text === symbol,
        );
        if (calls.length !== 3)
            context.contractError(
                factory,
                `Expected three bloom targets for ${symbol}.`,
            );
        for (const call of calls) {
            if (call.arguments.length !== 3)
                context.contractError(
                    call,
                    "Expected bloom target, source and scale.",
                );
            context.assertExpressionShape(
                call.arguments[1]!,
                "params.sourceTexture",
                "Bloom target source",
            );
            context.assertExpressionShape(
                call.arguments[2]!,
                "params.bloomScale",
                "Bloom target scale",
            );
        }
    }
    for (const { declaration } of [create, resize])
        context.assertExpressionShape(
            context.variableInitializer(declaration, "sourceSize"),
            "resolveSourceSize(source)",
            "Bloom source dimensions",
        );
    const ret = context.returnedExpression(module, "createScaledBloomTarget");
    if (
        !ts.isCallExpression(ret) ||
        !ts.isIdentifier(ret.expression) ||
        ret.expression.text !== "createRenderTarget" ||
        ret.arguments.length !== 1 ||
        !ts.isObjectLiteralExpression(ret.arguments[0]!)
    )
        return context.contractError(
            ret,
            "Expected bloom target allocation from a descriptor.",
        );
    const size = context.propertyInitializer(ret.arguments[0], "size");
    const writes = context
        .findNodes(resize.declaration, ts.isBinaryExpression)
        .filter(
            (node) =>
                node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                context.expressionMatchesShape(
                    node.left,
                    "target._descriptor.size",
                ),
        );
    if (writes.length !== 1 || !sameSyntax(size, writes[0]!.right))
        return context.contractError(
            resize.declaration,
            "Bloom creation and resize must use the same extent expression.",
        );
    const lowerer = new PinnedNumericLowerer(create.file, {
        bindings: new Map([
            ["sourceSize.width", { cpp: "width", type: "scalar" }],
            ["sourceSize.height", { cpp: "height", type: "scalar" }],
            ["scale", { cpp: "scale", type: "scalar" }],
        ]),
        calls: new Map(),
    });
    return `// ${context.provenance(module, "createScaledBloomTarget,resizeScaledBloomTarget")}
static std::array<double, 2> resolve_bloom_target_size(double width, double height, double scale) {
    return ${extentFields(context, size, create.declaration, lowerer)};
}`;
}

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
    const body = lowerPinnedBody(file, branch.thenStatement.statements, {
        bindings: new Map([
            ["size.scale", { cpp: "surface_scale", type: "scalar" }],
            ["canvas.width", { cpp: "width", type: "scalar" }],
            ["canvas.height", { cpp: "height", type: "scalar" }],
        ]),
        calls: new Map(),
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
            return extentFields(context, expression, declaration, lowerer);
        },
    });
    return `// ${context.provenance("src/engine/render-target.ts", "_resolveRenderTargetSize")}
std::array<double, 2> resolve_surface_render_target_size(double width, double height, double surface_scale) {
${body}
}
`;
}
