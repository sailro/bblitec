/**
 * A host page's inline module script that dynamically imports the program
 * entry (`if (...) { ... } else { await import("/src/main.ts"); }`).
 *
 * The script is compiled as part of the program: its statements lower before
 * the entry's module work, with the compiler's own condition folds, and the
 * entry import evaluates the entry. That import therefore has to be the last
 * statement the script runs, reached on a path generation decides; anything
 * after it would run after the entry, which is not represented.
 */
import ts from "typescript";
import { journaled } from "./emission-transaction.js";
import type { PageLoaderProgram } from "./types.js";
import type { LoweringServices } from "./lowering-services.js";
import { unwrapExpression } from "./syntax.js";
import { dynamicImportSpecifier } from "../typescript-module-specifiers.js";

type PageLoaderContext = Pick<
    LoweringServices,
    "fail" | "isInRuntimeControlFlow"
>;

export class PageLoader {
    @journaled private accessor reached = false;
    /** `import(entry)`, `await import(entry)` or `void import(entry)`. */
    private readonly entryImport: ts.ExpressionStatement | undefined;

    public constructor(
        private readonly context: PageLoaderContext,
        private readonly loader: PageLoaderProgram,
    ) {
        const find = (node: ts.Node): ts.ExpressionStatement | undefined => {
            if (ts.isExpressionStatement(node)) {
                let expression = unwrapExpression(node.expression, {
                    await: true,
                });
                if (ts.isVoidExpression(expression))
                    expression = unwrapExpression(expression.expression);
                if (
                    dynamicImportSpecifier(expression)?.text ===
                    loader.specifier
                )
                    return node;
            }
            return ts.forEachChild(node, find);
        };
        this.entryImport = find(loader.sourceFile);
    }

    /** Lower the script's statements; its entry import ends them. */
    public emit(emitStatement: (statement: ts.Statement) => void): void {
        this.loader.sourceFile.statements.forEach(emitStatement);
        if (!this.reached)
            this.context.fail(
                this.entryImport ?? this.loader.sourceFile,
                "The page's inline module script does not reach its entry import as a statement under this deployment.",
            );
    }

    /**
     * Whether `statement` is the entry import, which lowers to nothing: the
     * entry's own evaluation follows the script.
     */
    public lowerEntryImport(statement: ts.ExpressionStatement): boolean {
        if (statement !== this.entryImport) return false;
        if (this.context.isInRuntimeControlFlow())
            this.context.fail(
                statement,
                "The page's entry import runs under a condition generation does not decide.",
            );
        for (let node: ts.Node = statement; !ts.isSourceFile(node);) {
            const parent = node.parent;
            const last =
                ts.isBlock(parent) || ts.isSourceFile(parent)
                    ? parent.statements.at(-1) === node
                    : ts.isIfStatement(parent);
            if (!last)
                this.context.fail(
                    node,
                    "The page's entry import must be the last statement its script runs, through blocks and conditions only.",
                );
            node = parent;
        }
        this.reached = true;
        return true;
    }
}
