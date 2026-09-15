import ts from "typescript";
import { PinnedNumericLowerer, type PinnedNumericScope } from "./pinned-numeric-lowerer.js";
import { tracePinnedTranslation } from "./translation-trace.js";

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
    const result = lowerer.statements(statements, indent).join("\n");
    for (const owner of lowerer.translationActivity?.owners ?? []) {
        const symbolName = owner.name?.text;
        if (symbolName) tracePinnedTranslation(() => ({ file, symbolName,
            extent: "selected-body", adapters: ["body-scope"],
            requests: [...lowerer.translationActivity!.requests].sort() }));
    }
    return result;
}
