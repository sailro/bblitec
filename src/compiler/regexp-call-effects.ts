import ts from "typescript";
import { forEachAnalysisNode } from "./analysis-walk.js";
import {
    accessedPropertySymbol,
    declarationInDefaultLibrary,
    declaredIn,
    libraryGlobal,
    resolvedSymbol,
} from "./symbols.js";
import {
    outermostWrapper,
    regularExpressionParts,
    unwrapExpression,
    referenceSite,
} from "./syntax.js";

/** Immutable checked-source facts, independent of emission and its rollbacks. */
interface RegExpEffects {
    readonly files: readonly ts.SourceFile[];
    readonly references: Map<ts.Symbol, ts.Identifier[]>;
    readonly receivers: Map<ts.Symbol, boolean>;
    readonly prototypeUses: ts.Node[];
    prototypeSafe?: boolean;
}

const effects = new WeakMap<ts.TypeChecker, RegExpEffects>();

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

/**
 * A name that declares, imports or exports rather than uses: no
 * {@link referenceSite}, so `m.re` through a namespace import stays a use.
 */
function declarationName(node: ts.Identifier): boolean {
    return (
        referenceSite(node) === undefined || ts.isExportSpecifier(node.parent)
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
                    // Receivers and their aliases are constants; only their
                    // references are ever checked.
                    const symbol = resolvedSymbol(checker, node);
                    if (
                        symbol?.valueDeclaration &&
                        constant(symbol.valueDeclaration)
                    ) {
                        const references = result.references.get(symbol) ?? [];
                        references.push(node);
                        result.references.set(symbol, references);
                    }
                    const global = libraryGlobal(checker, node);
                    if (global === "eval" || global === "Function")
                        result.prototypeUses.push(node);
                    if (global === "RegExp") {
                        const expression = outermostWrapper(node);
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
                const key = ts.isElementAccessExpression(node)
                    ? checker.getTypeAtLocation(node.argumentExpression)
                    : undefined;
                const member =
                    accessedPropertySymbol(checker, node)?.name ??
                    (ts.isPropertyAccessExpression(node)
                        ? node.name.text
                        : key?.isStringLiteral()
                          ? key.value
                          : undefined);
                if (
                    member === "__proto__" ||
                    member === "prototype" ||
                    member === "constructor"
                )
                    result.prototypeUses.push(node);
                if (
                    (member === "getPrototypeOf" ||
                        member === "setPrototypeOf") &&
                    ["Object", "Reflect"].includes(
                        libraryGlobal(checker, node.expression) ?? "",
                    )
                ) {
                    const expression = outermostWrapper(node);
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

/** Observations that do not pass a prototype to application code. */
function onlyObserved(
    checker: ts.TypeChecker,
    state: RegExpEffects,
    value: ts.Node,
    constructor = false,
    seen = new Set<ts.Symbol>(),
): boolean {
    const expression = outermostWrapper(value);
    const parent = expression.parent;
    // Another builtin constructor's prototype is not on a RegExp's lookup
    // path for `test`/`exec` (RegExp.prototype owns both), whatever code
    // does with it (`GPUAdapter.prototype.requestDevice = ...`).
    const constructorName =
        ts.isPropertyAccessExpression(expression) &&
        expression.name.text === "prototype" &&
        ts.isIdentifier(unwrapExpression(expression.expression))
            ? (unwrapExpression(expression.expression) as ts.Identifier)
            : undefined;
    const owner =
        constructorName &&
        declaredIn(
            resolvedSymbol(checker, constructorName),
            "default-lib",
            "dom",
            "webgpu",
        )
            ? constructorName.text
            : undefined;
    if (
        owner !== undefined &&
        owner !== "RegExp" &&
        owner !== "Function" &&
        owner !== "eval"
    )
        return true;
    if (
        ts.isPropertyAccessExpression(expression) &&
        expression.name.text === "prototype" &&
        libraryGlobal(checker, expression.expression) === "Object" &&
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === expression &&
        parent.name.text === "hasOwnProperty"
    ) {
        const method = outermostWrapper(parent);
        const invoke = method.parent;
        if (
            ts.isPropertyAccessExpression(invoke) &&
            invoke.expression === method &&
            invoke.name.text === "call"
        ) {
            const target = outermostWrapper(invoke);
            const call = target.parent;
            if (
                ts.isCallExpression(call) &&
                call.expression === target &&
                call.arguments.length === 2
            ) {
                // The prototype only supplies the builtin method. The call's
                // receiver is its first argument, and the result is boolean.
                const declaration =
                    checker.getResolvedSignature(call)?.declaration;
                if (declaration && declarationInDefaultLibrary(declaration))
                    return true;
            }
        }
    }
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
    if (
        constructor &&
        ts.isNewExpression(parent) &&
        parent.expression === expression &&
        parent.arguments?.length === 1 &&
        !ts.isSpreadElement(parent.arguments[0]!)
    ) {
        // In particular, an extracted Function constructor cannot compile
        // source from a primitive number. A string or coercible object is
        // still an escape, as are calls and constructor-property reads.
        const type = checker.getTypeAtLocation(parent.arguments[0]!);
        const numeric = (member: ts.Type): boolean =>
            member.isUnion()
                ? member.types.every(numeric)
                : (member.flags & ts.TypeFlags.NumberLike) !== 0;
        if (numeric(type)) return true;
    }
    if (!constant(parent) || parent.initializer !== expression) return false;
    const symbol = resolvedSymbol(checker, parent.name);
    if (!symbol || seen.has(symbol)) return false;
    seen.add(symbol);
    return (state.references.get(symbol) ?? []).every(
        (reference) =>
            declarationName(reference) ||
            onlyObserved(checker, state, reference, constructor, seen),
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
    const state = facts(checker, files);
    state.prototypeSafe ??= state.prototypeUses.every((use) =>
        onlyObserved(
            checker,
            state,
            use,
            ts.isPropertyAccessExpression(use) &&
                use.name.text === "constructor",
        ),
    );
    if (!state.prototypeSafe) return false;
    const cached = state.receivers.get(root);
    if (cached !== undefined) return cached;
    const checked = new Set<ts.Symbol>();
    const safe = (symbol: ts.Symbol): boolean => {
        if (checked.has(symbol)) return true;
        checked.add(symbol);
        return (state.references.get(symbol) ?? []).every((reference) => {
            if (declarationName(reference)) return true;
            const expression = outermostWrapper(reference);
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
