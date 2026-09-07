import ts from "typescript";
import type { LoweringContext } from "./context.js";

/** A numeric pinned constant, evaluated from its own declaration. */
export function pinnedNumericConstant(
    context: LoweringContext,
    modulePath: string,
    name: string,
): number {
    const file = context.sourceFile(modulePath);
    const evaluate = (expression: ts.Expression): number => {
        const unwrapped = context.unwrapExpression(expression);
        if (ts.isNumericLiteral(unwrapped)) {
            return Number.parseInt(unwrapped.text, 10);
        }
        if (ts.isBinaryExpression(unwrapped)) {
            const left = evaluate(unwrapped.left);
            const right = evaluate(unwrapped.right);
            switch (unwrapped.operatorToken.kind) {
                case ts.SyntaxKind.LessThanLessThanToken:
                    return left << right;
                case ts.SyntaxKind.BarToken:
                    return left | right;
                default:
                    break;
            }
        }
        if (ts.isIdentifier(unwrapped)) {
            return evaluate(context.variableInitializer(file, unwrapped.text));
        }
        throw new Error(
            `Pinned constant ${name} in ${modulePath} is not a shift/or ` +
                "expression over numeric literals.",
        );
    };
    return evaluate(context.variableInitializer(file, name));
}
