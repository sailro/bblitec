import ts from "typescript";
import { forEachAnalysisNode } from "./analysis-walk.js";
import { valueSymbolOf } from "./symbols.js";
import { writeSites, type WriteSite } from "./syntax.js";

// Source facts outlive emission attempts: one index per checker and file.
const indexes = new WeakMap<
    ts.TypeChecker,
    WeakMap<ts.SourceFile, ReadonlyMap<ts.Symbol, readonly WriteSite[]>>
>();

/**
 * The writes that give a name a new value in one file -- `x = v`, `x += v`,
 * `x ??= v`, a pattern leaf, `x++`, a for-in/of target -- by the binding
 * they rebind.
 */
export function fileRebinds(
    checker: ts.TypeChecker,
    file: ts.SourceFile,
): ReadonlyMap<ts.Symbol, readonly WriteSite[]> {
    let files = indexes.get(checker);
    if (!files) indexes.set(checker, (files = new WeakMap()));
    const cached = files.get(file);
    if (cached) return cached;
    const rebinds = new Map<ts.Symbol, WriteSite[]>();
    forEachAnalysisNode(
        file,
        (node) => {
            for (const site of writeSites(node)) {
                if (!ts.isIdentifier(site.target)) continue;
                const symbol = valueSymbolOf(checker, site.target);
                if (!symbol) continue;
                const sites = rebinds.get(symbol) ?? [];
                sites.push(site);
                rebinds.set(symbol, sites);
            }
        },
        { types: "skip" },
    );
    files.set(file, rebinds);
    return rebinds;
}

/**
 * Every write in the program that rebinds a binding. A module's bindings
 * are rebound only by that module; a global (a script's or the library's)
 * by any source.
 */
export function bindingRebinds(
    checker: ts.TypeChecker,
    sourceFiles: readonly ts.SourceFile[],
    symbol: ts.Symbol,
): readonly WriteSite[] {
    const declaring = new Set(
        (symbol.declarations ?? []).map((declaration) =>
            declaration.getSourceFile(),
        ),
    );
    const files =
        declaring.size > 0 &&
        [...declaring].every((file) => ts.isExternalModule(file))
            ? [...declaring]
            : sourceFiles;
    // A declaration file declares; it never writes.
    return files.flatMap((file) =>
        file.isDeclarationFile
            ? []
            : (fileRebinds(checker, file).get(symbol) ?? []),
    );
}

/** Whether anything rebinds a binding; `updates: false` leaves `++` and `--` out. */
export function isRebound(
    checker: ts.TypeChecker,
    sourceFiles: readonly ts.SourceFile[],
    symbol: ts.Symbol,
    options: { readonly updates: boolean },
): boolean {
    return bindingRebinds(checker, sourceFiles, symbol).some(
        (site) => options.updates || site.kind !== "update",
    );
}
