import ts from "typescript";
import { forEachAnalysisNode } from "./analysis-walk.js";
import {
    accessedPropertySymbol,
    declarationInDefaultLibrary,
    libraryGlobal,
    resolvedSymbol,
} from "./symbols.js";
import { regularExpressionParts, unwrapExpression } from "./syntax.js";

/** Immutable checked-source facts, independent of emission and its rollbacks. */
interface RegExpEffects {
    readonly files: readonly ts.SourceFile[];
    readonly references: Map<ts.Symbol, ts.Identifier[]>;
    readonly receivers: Map<ts.Symbol, boolean>;
    readonly prototypeUses: ts.Expression[];
    prototypeSafe?: boolean;
}

const effects = new WeakMap<ts.TypeChecker, RegExpEffects>();

function outer(expression: ts.Expression): ts.Expression {
    let result = expression;
    while (
        ts.isExpression(result.parent) &&
        unwrapExpression(result.parent) === expression
    )
        result = result.parent;
    return result;
}

function constant(node: ts.Node): node is ts.VariableDeclaration & {
    name: ts.Identifier;
    initializer: ts.Expression;
} {
    return (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        !!node.initializer &&
        ts.isVariableDeclarationList(node.parent) &&
        (node.parent.flags & ts.NodeFlags.Const) !== 0
    );
}

function declarationName(node: ts.Identifier): boolean {
    return (
        (ts.isVariableDeclaration(node.parent) && node.parent.name === node) ||
        ts.isImportSpecifier(node.parent) ||
        ts.isExportSpecifier(node.parent)
    );
}

function builtinCall(checker: ts.TypeChecker, node: ts.Node): boolean {
    if (!ts.isCallExpression(node) || node.arguments.length !== 1) return false;
    const target = unwrapExpression(node.expression);
    if (
        !ts.isPropertyAccessExpression(target) ||
        (target.name.text !== "test" && target.name.text !== "exec")
    )
        return false;
    const declaration = checker.getResolvedSignature(node)?.declaration;
    if (
        !declaration ||
        !declarationInDefaultLibrary(declaration) ||
        !ts.isInterfaceDeclaration(declaration.parent) ||
        declaration.parent.name.text !== "RegExp"
    )
        return false;
    const primitiveString = (type: ts.Type): boolean =>
        type.isUnion()
            ? type.types.every(primitiveString)
            : (type.flags & ts.TypeFlags.StringLike) !== 0;
    return primitiveString(
        checker.getTypeAtLocation(unwrapExpression(node.arguments[0]!)),
    );
}

function facts(
    checker: ts.TypeChecker,
    files: readonly ts.SourceFile[],
): RegExpEffects {
    const previous = effects.get(checker);
    if (previous?.files === files) return previous;
    const result: RegExpEffects = {
        files,
        references: new Map(),
        receivers: new Map(),
        prototypeUses: [],
    };
    effects.set(checker, result);
    for (const file of files) {
        if (file.isDeclarationFile) continue;
        forEachAnalysisNode(
            file,
            (node) => {
                if (ts.isIdentifier(node)) {
                    const symbol = resolvedSymbol(checker, node);
                    if (symbol) {
                        const references = result.references.get(symbol) ?? [];
                        references.push(node);
                        result.references.set(symbol, references);
                    }
                    const global = libraryGlobal(checker, node);
                    if (global === "eval" || global === "Function")
                        result.prototypeUses.push(node);
                    if (global === "RegExp") {
                        const expression = outer(node);
                        const parent = expression.parent;
                        if (!(
                            (ts.isCallExpression(parent) ||
                                ts.isNewExpression(parent)) &&
                            parent.expression === expression
                        ))
                            result.prototypeUses.push(node);
                    }
                }
                if (
                    !ts.isPropertyAccessExpression(node) &&
                    !ts.isElementAccessExpression(node)
                )
                    return;
                const member = accessedPropertySymbol(checker, node)?.name;
                if (
                    member === "__proto__" ||
                    (member === "prototype" &&
                        libraryGlobal(checker, node.expression) !== undefined)
                )
                    result.prototypeUses.push(node);
                if (
                    (member === "getPrototypeOf" ||
                        member === "setPrototypeOf") &&
                    ["Object", "Reflect"].includes(
                        libraryGlobal(checker, node.expression) ?? "",
                    )
                ) {
                    const expression = outer(node);
                    result.prototypeUses.push(
                        member === "getPrototypeOf" &&
                            ts.isCallExpression(expression.parent) &&
                            expression.parent.expression === expression
                            ? expression.parent
                            : expression,
                    );
                }
            },
            { types: "skip" },
        );
    }
    return result;
}

/** A prototype compared with another value is observed without exposing it. */
function onlyCompared(
    checker: ts.TypeChecker,
    state: RegExpEffects,
    value: ts.Expression,
    seen = new Set<ts.Symbol>(),
): boolean {
    const expression = outer(value);
    const parent = expression.parent;
    if (
        ts.isBinaryExpression(parent) &&
        [
            ts.SyntaxKind.EqualsEqualsToken,
            ts.SyntaxKind.ExclamationEqualsToken,
            ts.SyntaxKind.EqualsEqualsEqualsToken,
            ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ].includes(parent.operatorToken.kind)
    )
        return true;
    if (!constant(parent) || parent.initializer !== expression) return false;
    const symbol = resolvedSymbol(checker, parent.name);
    if (!symbol || seen.has(symbol)) return false;
    seen.add(symbol);
    return (state.references.get(symbol) ?? []).every(
        (reference) =>
            declarationName(reference) ||
            onlyCompared(checker, state, reference, seen),
    );
}

/**
 * test/exec cannot change an unescaped non-g/y literal receiver. The program's
 * checked references also exclude replaced methods and prototype exposure;
 * neither a RegExp annotation nor a method name establishes builtin behavior.
 */
export function isReadOnlyRegExpCall(
    checker: ts.TypeChecker,
    node: ts.Node,
    files: readonly ts.SourceFile[],
): boolean {
    if (!builtinCall(checker, node) || !ts.isCallExpression(node)) return false;
    const target = unwrapExpression(node.expression);
    if (!ts.isPropertyAccessExpression(target)) return false;
    const receiver = unwrapExpression(target.expression);
    if (!ts.isIdentifier(receiver)) return false;
    const state = facts(checker, files);
    state.prototypeSafe ??= state.prototypeUses.every((use) =>
        onlyCompared(checker, state, use),
    );
    if (!state.prototypeSafe) return false;
    const origin = (
        identifier: ts.Identifier,
        seen: Set<ts.Symbol>,
    ): ts.Symbol | undefined => {
        const symbol = resolvedSymbol(checker, identifier);
        const declaration = symbol?.valueDeclaration;
        if (
            !symbol ||
            seen.has(symbol) ||
            !declaration ||
            !constant(declaration)
        )
            return undefined;
        seen.add(symbol);
        const initializer = unwrapExpression(declaration.initializer);
        if (ts.isIdentifier(initializer)) return origin(initializer, seen);
        const flags = ts.isRegularExpressionLiteral(initializer)
            ? regularExpressionParts(initializer)?.flags
            : undefined;
        return flags !== undefined && !/[gy]/.test(flags) ? symbol : undefined;
    };
    const root = origin(receiver, new Set());
    if (!root) return false;
    const cached = state.receivers.get(root);
    if (cached !== undefined) return cached;
    const checked = new Set<ts.Symbol>();
    const safe = (symbol: ts.Symbol): boolean => {
        if (checked.has(symbol)) return true;
        checked.add(symbol);
        return (state.references.get(symbol) ?? []).every((reference) => {
            if (declarationName(reference)) return true;
            const expression = outer(reference);
            const parent = expression.parent;
            if (constant(parent) && parent.initializer === expression) {
                const alias = resolvedSymbol(checker, parent.name);
                return !!alias && safe(alias);
            }
            return (
                ts.isPropertyAccessExpression(parent) &&
                parent.expression === expression &&
                ts.isCallExpression(parent.parent) &&
                parent.parent.expression === parent &&
                builtinCall(checker, parent.parent)
            );
        });
    };
    const result = safe(root);
    state.receivers.set(root, result);
    return result;
}
