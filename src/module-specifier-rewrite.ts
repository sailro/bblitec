import ts from "typescript";
import { applyTextEdits, type TextEdit } from "./text-edits.js";
import { moduleSpecifiers } from "./typescript-module-specifiers.js";

/**
 * What one import specifier becomes: another specifier, written in the
 * original's quotes, or -- for a dynamic `import(...)` only -- an expression
 * that replaces the whole call.
 */
type SpecifierRewrite =
    { readonly specifier: string } | { readonly expression: string };

/**
 * Module text with its import specifiers rewritten where `rewrite` answers.
 *
 * Every static import/export and dynamic-import specifier is found through
 * the module's AST, so a specifier-shaped string inside a literal or a
 * comment is never touched, and a specifier keeps its own quote character.
 * The script kind follows `fileName`'s extension.
 */
export function rewriteModuleSpecifiers(
    source: string,
    fileName: string,
    rewrite: (specifier: ts.StringLiteralLike) => SpecifierRewrite | undefined,
): string {
    const file = ts.createSourceFile(
        fileName,
        source,
        ts.ScriptTarget.Latest,
        true,
    );
    const edits: TextEdit[] = [];
    for (const specifier of moduleSpecifiers(file)) {
        const replacement = rewrite(specifier);
        if (replacement === undefined) continue;
        if ("specifier" in replacement) {
            const start = specifier.getStart(file);
            const quote = source[start]!;
            edits.push({
                start,
                end: specifier.getEnd(),
                text: `${quote}${replacement.specifier}${quote}`,
            });
            continue;
        }
        const call = specifier.parent;
        if (!ts.isCallExpression(call)) {
            throw new Error(
                `${fileName}: only a dynamic import can be replaced by an ` +
                    `expression, not '${specifier.text}'.`,
            );
        }
        edits.push({
            start: call.getStart(file),
            end: call.getEnd(),
            text: replacement.expression,
        });
    }
    return applyTextEdits(source, edits);
}
