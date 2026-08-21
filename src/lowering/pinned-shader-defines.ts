/**
 * The `defines` half of the pin's own ShaderMaterial prelude.
 *
 * WGSL has no preprocessor, so `buildShaderPrelude` turns each
 * `createShaderMaterial({ defines })` entry into a module-scope `const`
 * declaration prepended to both stages. That line is the pin's — the type
 * word it picks for a boolean against a number, and `formatDefineValue`'s
 * rule for printing an integer as `2.0` where a fractional value prints
 * bare — so it is read out of the builder's own loop and evaluated rather
 * than restated here.
 *
 * Only the define lines come from the pin. The rest of that prelude is
 * re-addressed by this port (SDL fixes vertex uniforms at register space 1
 * and fragment uniforms at space 3, and vertex attributes take the native
 * `GpuVertex` locations rather than declaration order), which is why this
 * reads one loop body instead of executing the whole builder.
 */
import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { PinnedShaderText } from "./pinned-shader-text.js";

export const shaderPipelineModule =
    "src/material/shader/shader-pipeline.ts";

/** A reached `defines` entry, in the pin's own `ShaderDefine` shape. */
export interface PinnedShaderDefine {
    readonly name: string;
    readonly value: boolean | number;
}

/**
 * The `wgsl += ...` template inside `buildShaderPrelude`'s
 * `for (const define of material.defines)` loop.
 *
 * Located by the loop's own binding and iterated path rather than by
 * position, and required to be that loop's only statement: a pin that
 * starts emitting a second line per define would otherwise have half of it
 * silently dropped.
 */
function definesLoopTemplate(
    context: LoweringContext,
): ts.Expression {
    const { declaration } = context.functionDeclaration(
        shaderPipelineModule,
        "buildShaderPrelude",
    );
    let template: ts.Expression | undefined;
    const visit = (node: ts.Node): void => {
        if (template) return;
        if (
            ts.isForOfStatement(node) &&
            ts.isVariableDeclarationList(node.initializer) &&
            node.initializer.declarations.length === 1 &&
            ts.isIdentifier(node.initializer.declarations[0]!.name) &&
            node.initializer.declarations[0]!.name.text === "define" &&
            context.propertyPath(node.expression)?.join(".") ===
                "material.defines"
        ) {
            const body = ts.isBlock(node.statement)
                ? node.statement.statements
                : [node.statement];
            const statement = body.length === 1 ? body[0] : undefined;
            if (
                !statement ||
                !ts.isExpressionStatement(statement) ||
                !ts.isBinaryExpression(statement.expression) ||
                statement.expression.operatorToken.kind !==
                    ts.SyntaxKind.PlusEqualsToken
            ) {
                context.contractError(
                    node,
                    "Pinned buildShaderPrelude no longer appends exactly one line per define.",
                );
            }
            template = statement.expression.right;
            return;
        }
        ts.forEachChild(node, visit);
    };
    visit(declaration.body!);
    if (!template) {
        context.contractError(
            declaration,
            "Pinned buildShaderPrelude no longer emits a `defines` loop.",
        );
    }
    return template;
}

/**
 * The pin's own prelude text for a scene's reached defines, in the order
 * `createShaderMaterial` sorted them. Each line already ends in the
 * newline the pinned template carries, so the block concatenates.
 */
export function pinnedShaderDefineLines(
    context: LoweringContext,
    defines: readonly PinnedShaderDefine[],
): string {
    if (defines.length === 0) {
        return "";
    }
    const template = definesLoopTemplate(context);
    const text = new PinnedShaderText(context);
    return defines
        .map((define) =>
            text.text(
                shaderPipelineModule,
                template,
                new Map([
                    [
                        "define",
                        { name: define.name, value: define.value },
                    ],
                ]),
            ),
        )
        .join("");
}
