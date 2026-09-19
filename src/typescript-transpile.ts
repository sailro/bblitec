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
