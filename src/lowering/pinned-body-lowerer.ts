import type ts from "typescript";
import { PinnedNumericLowerer, type PinnedNumericScope } from "./pinned-numeric-lowerer.js";

export type PinnedBodyScope = Omit<PinnedNumericScope, "returnValue"> & {
    returnValue?: (expression: ts.Expression | undefined, lowerer: PinnedNumericLowerer) => string;
};

/** Lower an already selected pinned statement sequence through one numeric scope. */
export function lowerPinnedBody(
    file: ts.SourceFile,
    statements: readonly ts.Statement[],
    scope: PinnedBodyScope,
    indent = "    ",
): string {
    const { returnValue, ...numericScope } = scope;
    const lowerer: PinnedNumericLowerer = new PinnedNumericLowerer(file, {
        ...numericScope,
        ...(returnValue ? { returnValue: expression => returnValue(expression, lowerer) } : {}),
    });
    return lowerer.statements(statements, indent).join("\n");
}
