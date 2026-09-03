import ts from "typescript";

function transpileTypeScript(
    source: string,
    fileName: string,
    module: ts.ModuleKind,
): string {
    return ts.transpileModule(source, {
        compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module,
        },
        fileName,
    }).outputText;
}

export function transpileCommonJs(
    source: string,
    fileName: string,
): string {
    return transpileTypeScript(
        source,
        fileName,
        ts.ModuleKind.CommonJS,
    );
}

export function transpileForBrowser(
    source: string,
    fileName: string,
): string {
    return transpileTypeScript(
        source,
        fileName,
        ts.ModuleKind.ES2022,
    );
}
