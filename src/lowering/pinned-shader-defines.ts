/**
 * The `defines` half of the pin's own ShaderMaterial prelude.
 *
 * WGSL has no preprocessor, so `buildShaderPrelude` turns each
 * `createShaderMaterial({ defines })` entry into a module-scope `const`
 * declaration prepended to both stages. That text is the pin's — the type
 * word it picks for a boolean against a number, and `formatDefineValue`'s
 * rule for printing an integer as `2.0` where a fractional value prints
 * bare — so it is read out of the builder's own loop and evaluated rather
 * than restated here.
 *
 * Only the define texts come from the pin. The rest of that prelude is
 * re-addressed by this port (SDL fixes vertex uniforms at register space 1
 * and fragment uniforms at space 3, and vertex attributes take the native
 * `GpuVertex` locations rather than declaration order), which is why this
 * reads one loop body instead of executing the whole builder.
 */
import ts from "typescript";
import type { LoweringContext } from "./context.js";
import {
    PinnedShaderText,
    type ShaderTextBinding,
} from "./pinned-shader-text.js";

export const shaderPipelineModule =
    "src/material/shader/shader-pipeline.ts";

/** A reached `defines` entry, in the pin's own `ShaderDefine` shape. */
export interface PinnedShaderDefine {
    readonly name: string;
    readonly value: boolean | number;
}

/**
 * The pin's define append: `source = \`${source}const ...\`` inside
 * `buildShaderPrelude`'s `for (const define of material.defines)` loop,
 * the prelude accumulator re-bound to itself followed by one define's
 * text.
 */
interface DefinesLoopAppend {
    /** The whole right-hand template, its first span the accumulator. */
    readonly template: ts.TemplateExpression;
    /** The accumulator's name, bound empty when one define is evaluated. */
    readonly accumulator: string;
}

/**
 * Located by the loop's own binding and iterated path rather than by
 * position, and required to be that loop's only statement: a pin that
 * starts appending a second text per define would otherwise have half of
 * it silently dropped.
 */
function definesLoopAppend(context: LoweringContext): DefinesLoopAppend {
    const { declaration } = context.functionDeclaration(
        shaderPipelineModule,
        "buildShaderPrelude",
    );
    let append: DefinesLoopAppend | undefined;
    const visit = (node: ts.Node): void => {
        if (append) return;
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
            const assignment =
                statement &&
                ts.isExpressionStatement(statement) &&
                ts.isBinaryExpression(statement.expression) &&
                statement.expression.operatorToken.kind ===
                    ts.SyntaxKind.EqualsToken
                    ? statement.expression
                    : undefined;
            const accumulator =
                assignment && ts.isIdentifier(assignment.left)
                    ? assignment.left.text
                    : undefined;
            const template =
                assignment && ts.isTemplateExpression(assignment.right)
                    ? assignment.right
                    : undefined;
            const first = template?.templateSpans[0]?.expression;
            if (
                !template ||
                accumulator === undefined ||
                template.head.text !== "" ||
                !first ||
                !ts.isIdentifier(first) ||
                first.text !== accumulator
            ) {
                context.contractError(
                    node,
                    "Pinned buildShaderPrelude no longer appends exactly one text per define to its prelude.",
                );
            }
            append = { template, accumulator };
            return;
        }
        ts.forEachChild(node, visit);
    };
    visit(declaration.body!);
    if (!append) {
        context.contractError(
            declaration,
            "Pinned buildShaderPrelude no longer emits a `defines` loop.",
        );
    }
    return append;
}

/**
 * The pin's own prelude text for a scene's reached defines, in the order
 * `createShaderMaterial` sorted them. The pin appends each define's text
 * to its prelude with no separator, so the texts concatenate as the pin
 * concatenates them.
 */
export function pinnedShaderDefineText(
    context: LoweringContext,
    defines: readonly PinnedShaderDefine[],
): string {
    if (defines.length === 0) {
        return "";
    }
    const { template, accumulator } = definesLoopAppend(context);
    const text = new PinnedShaderText(context);
    return defines
        .map((define) =>
            text.text(
                shaderPipelineModule,
                template,
                new Map<string, ShaderTextBinding>([
                    [accumulator, ""],
                    [
                        "define",
                        { name: define.name, value: define.value },
                    ],
                ]),
            ),
        )
        .join("");
}
