import ts from "typescript";
import type { LoweringContext } from "../src/lowering/context.js";

/** A pinned top-level function's source text, unexported, for a source oracle. */
export function pinnedDeclaration(
    context: LoweringContext,
    module: string,
    name: string,
): string {
    return unexported(context.functionDeclaration(module, name).declaration);
}

/**
 * A pinned module's statements past its imports, unexported, for a source
 * oracle; `keep` drops the statements an oracle stands in for.
 */
export function pinnedModuleSource(
    context: LoweringContext,
    module: string,
    keep: (statement: ts.Statement) => boolean = () => true,
): string {
    return context
        .sourceFile(module)
        .statements.filter(
            (statement) =>
                !ts.isImportDeclaration(statement) && keep(statement),
        )
        .map(unexported)
        .join("\n");
}

function unexported(node: ts.Node): string {
    return node.getText().replace(/^export /, "");
}
