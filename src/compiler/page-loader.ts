/**
 * A host page's inline module script that dynamically imports the program
 * entry (`if (...) { ... } else { await import("/src/main.ts"); }`).
 *
 * The script is compiled as part of the program: its statements lower before
 * the entry's module work, with the compiler's own condition folds, and the
 * entry import evaluates the entry. That import therefore has to be reached
 * on a path generation decides and be the last thing the script does there;
 * anything after it would run after the entry, which is not represented.
 */
import ts from "typescript";
import type { PageLoaderModule } from "./types.js";
import type { LoweringServices } from "./lowering-services.js";

type PageLoaderContext = Pick<
    LoweringServices,
    "fail" | "isInRuntimeControlFlow" | "unwrap"
>;

export class PageLoader {
    private reached = false;

    public constructor(
        private readonly context: PageLoaderContext,
        private readonly module: PageLoaderModule,
        public readonly sourceFile: ts.SourceFile,
    ) {}

    /** `import(entry)`, `await import(entry)` or `void import(entry)`. */
    private isEntryImport(statement: ts.ExpressionStatement): boolean {
        let expression = this.context.unwrap(statement.expression);
        if (ts.isAwaitExpression(expression) || ts.isVoidExpression(expression))
            expression = this.context.unwrap(expression.expression);
        const [specifier] = ts.isCallExpression(expression)
            ? expression.arguments
            : [];
        return (
            ts.isCallExpression(expression) &&
            expression.expression.kind === ts.SyntaxKind.ImportKeyword &&
            expression.arguments.length === 1 &&
            specifier !== undefined &&
            ts.isStringLiteralLike(specifier) &&
            specifier.text === this.module.specifier
        );
    }

    /** Lower the script's statements; its entry import ends them. */
    public emit(emitStatement: (statement: ts.Statement) => void): void {
        for (const statement of this.sourceFile.statements) {
            if (this.reached)
                this.context.fail(
                    statement,
                    "An inline module script statement after its entry import would run after the entry, which is not represented.",
                );
            emitStatement(statement);
        }
        if (!this.reached)
            this.context.fail(
                this.sourceFile,
                "The page's inline module script does not reach its entry import under this deployment.",
            );
    }

    /**
     * Whether `statement` is the entry import, which lowers to nothing: the
     * entry's own evaluation follows the script.
     */
    public lowerEntryImport(statement: ts.ExpressionStatement): boolean {
        if (
            statement.getSourceFile() !== this.sourceFile ||
            !this.isEntryImport(statement)
        )
            return false;
        if (this.context.isInRuntimeControlFlow())
            this.context.fail(
                statement,
                "The page's entry import runs under a condition generation does not decide.",
            );
        for (let node: ts.Node = statement; node.parent !== this.sourceFile;) {
            const parent = node.parent;
            if (!ts.isBlock(parent) && !ts.isIfStatement(parent))
                this.context.fail(
                    statement,
                    "The page's entry import must be reached through blocks and generation-decided conditions only.",
                );
            if (ts.isBlock(parent) && parent.statements.at(-1) !== node)
                this.context.fail(
                    node,
                    "The page's entry import must be the last statement its script runs.",
                );
            node = parent;
        }
        this.reached = true;
        return true;
    }
}
