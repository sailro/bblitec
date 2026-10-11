import ts from "typescript";

/** The dynamic-code boundary returns unknown until its caller supplies the source contract. */
export function createJavaScriptFunction(
    ...parametersAndBody: string[]
): (...args: unknown[]) => unknown {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- Pinned and generated JavaScript executes only at this explicit boundary.
    return new Function(...parametersAndBody) as (
        ...args: unknown[]
    ) => unknown;
}

function transpileTypeScript(
    source: string,
    fileName: string,
    module: ts.ModuleKind,
): string {
    return ts.transpileModule(source, {
        compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module,
            // The pin's build script default-imports TypeScript's own
            // CommonJS bundle, which declares no `default` export.
            esModuleInterop: true,
        },
        fileName,
    }).outputText;
}

export function transpileCommonJs(source: string, fileName: string): string {
    return transpileTypeScript(source, fileName, ts.ModuleKind.CommonJS);
}

export function transpileForBrowser(source: string, fileName: string): string {
    return transpileTypeScript(source, fileName, ts.ModuleKind.ES2022);
}

/** The index of the first non-whitespace character at or after `index`. */
function afterWhitespace(text: string, index: number): number {
    let end = index;
    while (end < text.length && text[end]!.trim() === "") end += 1;
    return end;
}

/**
 * Module text with every `async` modifier and every `await` operator
 * removed, each with the space that separates it from what follows. The
 * keywords are located as syntax -- a modifier on a function, an await
 * expression -- so a word inside a literal, a comment or a property name is
 * never touched, and the text around them is executed byte for byte.
 */
export function stripAsyncAndAwait(text: string): string {
    const source = ts.createSourceFile(
        "pinned-module.js",
        text,
        ts.ScriptTarget.ES2022,
        true,
        ts.ScriptKind.JS,
    );
    const removed: Array<readonly [number, number]> = [];
    const visit = (node: ts.Node): void => {
        if (ts.canHaveModifiers(node)) {
            for (const modifier of ts.getModifiers(node) ?? []) {
                if (modifier.kind === ts.SyntaxKind.AsyncKeyword) {
                    removed.push([
                        modifier.getStart(source),
                        afterWhitespace(text, modifier.end),
                    ]);
                }
            }
        }
        if (ts.isAwaitExpression(node)) {
            removed.push([
                node.getStart(source),
                node.expression.getStart(source),
            ]);
        }
        if (ts.isForOfStatement(node) && node.awaitModifier) {
            removed.push([
                node.awaitModifier.getStart(source),
                afterWhitespace(text, node.awaitModifier.end),
            ]);
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    let stripped = text;
    for (const [start, end] of removed.sort(
        (left, right) => right[0] - left[0],
    )) {
        stripped = stripped.slice(0, start) + stripped.slice(end);
    }
    return stripped;
}
