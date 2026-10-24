import ts from "typescript";
import { forEachAnalysisNode, someAnalysisNode } from "./analysis-walk.js";
import { EmissionWeakMap } from "./emission-transaction.js";
import { declaredSymbol, valueSymbolOf } from "./symbols.js";
import { unwrapExpression, writeSites, type WriteSite } from "./syntax.js";

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

/** Whether anything rebinds a binding, `++` and `--` included. */
export function isRebound(
    checker: ts.TypeChecker,
    sourceFiles: readonly ts.SourceFile[],
    symbol: ts.Symbol,
): boolean {
    return bindingRebinds(checker, sourceFiles, symbol).length > 0;
}

const directCallBindingCache = new EmissionWeakMap<
    ts.TypeChecker,
    WeakMap<ts.Node, WeakMap<ts.Identifier, boolean>>
>();

/**
 * Whether every reference to the function binding `name` in `scope` is the
 * callee of a direct call, so nothing keeps the function past those calls;
 * with `caller`, each call is also made by code of `caller` itself rather
 * than a function nested in it.
 */
export function bindingIsOnlyCalledDirectly(
    checker: ts.TypeChecker,
    name: ts.Identifier,
    scope: ts.Node,
    caller?: ts.Node,
): boolean {
    const key = caller ?? scope;
    let scopes = directCallBindingCache.get(checker);
    if (!scopes)
        directCallBindingCache.set(checker, (scopes = new EmissionWeakMap()));
    let bindings = scopes.get(key);
    if (!bindings) scopes.set(key, (bindings = new EmissionWeakMap()));
    const cached = caller === undefined ? bindings.get(name) : undefined;
    if (cached !== undefined) return cached;
    const symbol = declaredSymbol(checker, name);
    const onlyCalled =
        !!symbol &&
        !someAnalysisNode(
            scope,
            (node) => {
                if (
                    !ts.isIdentifier(node) ||
                    node === name ||
                    declaredSymbol(checker, node) !== symbol
                )
                    return false;
                const parent = node.parent;
                return (
                    !ts.isCallExpression(parent) ||
                    unwrapExpression(parent.expression) !== node ||
                    (caller !== undefined &&
                        ts.findAncestor(parent, ts.isFunctionLike) !== caller)
                );
            },
            { types: "skip" },
        );
    if (caller === undefined) bindings.set(name, onlyCalled);
    return onlyCalled;
}
