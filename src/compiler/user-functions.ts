import { commonResourceValue, valueForKind, withNativeMetadata } from "./types.js";
import { metadataFieldsForKind } from "./values/metadata.js";
import { someAnalysisNode, forEachAnalysisNode, findAnalysisNodeWithState } from "./analysis-walk.js";
import { EmissionSet, EmissionMap, EmissionWeakMap } from "./emission-transaction.js";
import type { LoweringServices } from "./lowering-services.js";
import ts from "typescript";
import { CompileError } from "./compile-error.js";
import { typeCanCarryReference } from "./type-facts.js";
import { arrayReturnStorage } from "./array-return-storage.js";
import { sanitizeCppIdentifier } from "../cpp-literals.js";
import {
    passesByReference,
    dataTypesEqual,
    isHandleKind,
    tupleComponents,
    type DataType,
    type DataTypeRegistry,
} from "./data-types.js";
import type { Value } from "./types.js";
import { renderClosure, renderAsyncClosure, type CapturedClosure } from "./closure-captures.js";
import { readOnlyDataMethods, storingDataMethods, isStoringDataCall } from "./data-methods.js";
import { nativeReturnTsType } from "./native-return-type.js";
import { staticNumberValue, type PositiveIntegerContext } from "./option-helpers.js";
import { CompilerSymbols, isDefaultLibraryIdentifier } from "./symbols.js";
import {
    isAssignmentExpression,
    isUpdateExpression,
    mutatingCallTarget,
    rootIdentifier,
    unwrapExpression,
    argumentAt,
} from "./syntax.js";
import { firstReturn, forEachReturn, emitReachableStatements } from "./loop-control.js";
import { FunctionSpecializations, functionDependencies } from "./function-specializations.js";
import { callTypeArguments, mentionsTypeParameter } from "./type-arguments.js";

function generationKnownPrimitive(value: Value): boolean {
    return value.kind === "json-null" || value.staticNumber !== undefined ||
        value.staticString !== undefined || value.staticBoolean !== undefined;
}

/** The index of a declaration's rest parameter, when it declares one. */
function restParameterIndex(declaration: SupportedFunction): number | undefined {
    const index = declaration.parameters.findIndex((parameter) => parameter.dotDotDotToken !== undefined);
    return index >= 0 ? index : undefined;
}

const defaultBindingByChecker = new WeakMap<ts.TypeChecker, WeakMap<SupportedFunction, WeakMap<ts.CallExpression, boolean>>>();

/** Defaults execute in parameter scope after all actual arguments have run. */
export function requiresDefaultParameterBinding(checker: ts.TypeChecker, declaration: SupportedFunction, call: ts.CallExpression): boolean {
    let declarations = defaultBindingByChecker.get(checker);
    if (!declarations) defaultBindingByChecker.set(checker, declarations = new WeakMap());
    let calls = declarations.get(declaration);
    if (!calls) declarations.set(declaration, calls = new WeakMap());
    const cached = calls.get(call);
    if (cached !== undefined) return cached;
    const required = declaration.parameters.some((parameter, index) => {
        if (!parameter.initializer) return false;
        const argument = call.arguments[index];
        const initializer = unwrapExpression(parameter.initializer);
        if (!argument && ts.isIdentifier(initializer)) {
            const alias = checker.getSymbolAtLocation(initializer);
            const symbol = alias && (alias.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(alias) : alias;
            const binding = symbol?.valueDeclaration;
            const type = checker.getTypeAtLocation(initializer);
            if (binding && ts.isVariableDeclaration(binding) && ts.isVariableDeclarationList(binding.parent) &&
                (binding.parent.flags & ts.NodeFlags.Const) !== 0 &&
                (type.flags & (ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral | ts.TypeFlags.BooleanLiteral)) !== 0) return false;
        }
        if (!argument) return someAnalysisNode(unwrapExpression(parameter.initializer), node =>
            ts.isIdentifier(node) || ts.isCallExpression(node) || ts.isNewExpression(node) || node.kind === ts.SyntaxKind.ThisKeyword,
            { skip: ts.isTypeNode });
        const type = checker.getTypeAtLocation(argument);
        return (type.isUnion() ? type.types : [type]).some(member => (member.flags & ts.TypeFlags.Undefined) !== 0);
    });
    calls.set(call, required);
    return required;
}

type Fail = (node: ts.Node, message: string) => never;
export type SupportedFunction =
    | ts.FunctionDeclaration
    | ts.FunctionExpression
    | ts.ArrowFunction
    | ts.MethodDeclaration;

/** The four declaration shapes this compiler inlines, as one narrowing. */
export function isSupportedFunction(
    node: ts.Node | undefined,
): node is SupportedFunction {
    return (
        node !== undefined &&
        (ts.isFunctionDeclaration(node) ||
            ts.isFunctionExpression(node) ||
            ts.isArrowFunction(node) ||
            ts.isMethodDeclaration(node))
    );
}

/**
 * The three shapes that write through a target this walk is tracking: an
 * assignment, an increment, and a method call that mutates.
 *
 * `parameterIsReadOnly` and `returnedValueCanMove` ask different questions of
 * the root — "is it this parameter" and "does it outlive the call" — but they
 * recognize a write the same way, so a family added here has to reach one
 * place rather than several.
 *
 * `mutatesVia` is the third caller's axis. Asked of a value that may be any
 * data kind, the safe answer is "anything not proven read-only"
 * (`readOnlyDataMethods`, the default); asked of a value the caller already
 * knows is an array, whose method set is closed, the exact answer is
 * `mutatingArrayMethods`. Both are legitimate and neither is the other's
 * default, so the predicate is a parameter rather than a second copy of the
 * three clauses.
 */
function writesThroughRoot(
    node: ts.Node,
    isTarget: (expression: ts.Expression) => boolean,
    mutatesVia: (method: string) => boolean = (method) =>
        !readOnlyDataMethods.has(method),
): boolean {
    if (isAssignmentExpression(node)) {
        return isTarget(node.left);
    }
    if (isUpdateExpression(node)) {
        return isTarget(node.operand);
    }
    const target = mutatingCallTarget(node, mutatesVia);
    return target !== undefined && isTarget(target);
}

/** `writesThroughRoot`, for a caller outside this module. */
export const writesThroughTrackedRoot = writesThroughRoot;

const parameterReadOnlyCache = new EmissionWeakMap<
    ts.TypeChecker,
    WeakMap<SupportedFunction, WeakMap<ts.Symbol, boolean>>
>();

/**
 * Whether one call provably leaves the argument at `index` unchanged.
 *
 * Resolved through the checker's own signature rather than through
 * `resolveFunctionDeclaration`, which refuses a generator, a generic or a
 * rest parameter by throwing: right where a call is being LOWERED, wrong
 * for a question asked speculatively over a whole file including calls the
 * scene never reaches. `parameterIsReadOnly` asks it of its own nested
 * calls and `constArrayIsWritten` of every call in a file, so the
 * resolution lives here rather than in each.
 */
export function callArgumentIsReadOnly(
    checker: ts.TypeChecker,
    call: ts.CallExpression,
    index: number,
    active?: Set<ts.Symbol>,
): boolean {
    const argument = call.arguments[index];
    // `Math.hypot(a[0] - b[0], ...)` mentions the composite and hands the
    // callee a number, so there is nothing to write through and nothing to
    // escape into -- which the resolution below could never say, since a
    // builtin has no declaration to prove read-only against. Treating
    // every one of them as a writer made both callers wrong: every
    // arithmetic helper's tuple parameter became mutable, and every
    // module-level constant array read inside one stopped folding.
    if (
        argument !== undefined &&
        !typeCanCarryReference(checker.getTypeAtLocation(argument))
    ) {
        return true;
    }
    const callee = unwrapExpression(call.expression);
    if (index === 0 && ts.isPropertyAccessExpression(callee) && callee.name.text === "keys" &&
        ts.isIdentifier(callee.expression) && callee.expression.text === "Object" &&
        isDefaultLibraryIdentifier(checker, callee.expression)) return true;
    const called = checker.getResolvedSignature(call)?.declaration;
    const parameter = called?.parameters[index]?.name;
    return (
        isSupportedFunction(called) &&
        parameter !== undefined &&
        ts.isIdentifier(parameter) &&
        (active === undefined
            ? parameterIsReadOnly(checker, called, parameter)
            : parameterIsReadOnly(checker, called, parameter, active))
    );
}

/** The tracked-alias queries a mutation walk's per-kind clauses consult. */
export interface AliasedMutationScan {
    /** Whether `node` is an identifier naming a tracked alias. */
    readonly namesAlias: (node: ts.Node) => boolean;
    /** Whether any identifier in the subtree names a tracked alias. */
    readonly containsAlias: (node: ts.Node) => boolean;
    /** Track one more alias; a new symbol queues another pass. */
    readonly addAlias: (symbol: ts.Symbol | undefined) => void;
}

/** A native API that retains an object and writes it after the call returns. */
export function retainedNativeMutationTarget(
    symbols: CompilerSymbols,
    node: ts.Node,
): ts.Expression | undefined {
    return ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
        symbols.importedName(node.expression) === "createPropertyAnimationGroup"
        ? node.arguments[1]
        : undefined;
}

/**
 * The alias-set + fixed-point skeleton every inferred-mutation walk shares.
 *
 * Seeds the tracked set with the declared identifier's symbol, then rewalks
 * the whole source file until a pass adds no alias: a declaration or assignment
 * whose initializer `aliasingInitializer` accepts extends the set (queueing
 * another pass), and the first node `mutates` accepts ends the scan. What
 * counts as an alias-creating initializer and as a mutation site is the
 * per-kind half the callers keep — arrays and plain objects recognize
 * writes differently — and `mutates` may itself extend the set through
 * `addAlias` (the object walk follows call arguments into parameters).
 */
export function aliasedMutationScan(
    identifier: ts.Identifier,
    valueSymbol: (identifier: ts.Identifier) => ts.Symbol | undefined,
    walk: {
        readonly aliasingInitializer: (
            initializer: ts.Expression,
            scan: AliasedMutationScan,
        ) => boolean;
        readonly mutates: (node: ts.Node, scan: AliasedMutationScan) => boolean;
    },
): boolean {
    const initial = valueSymbol(identifier);
    if (!initial) return false;
    const aliases = new EmissionSet<ts.Symbol>([initial]);
    const source = identifier.getSourceFile();
    let changed = true;
    const scan: AliasedMutationScan = {
        namesAlias: (node) =>
            ts.isIdentifier(node) && aliases.has(valueSymbol(node)!),
        containsAlias: (node) => someAnalysisNode(node, scan.namesAlias),
        addAlias: (symbol) => {
            if (symbol && !aliases.has(symbol)) {
                aliases.add(symbol);
                changed = true;
            }
        },
    };
    while (changed) {
        changed = false;
        const mutated = someAnalysisNode(source, (node) => {
            if (walk.mutates(node, scan)) return true;
            if (
                ts.isVariableDeclaration(node) &&
                ts.isIdentifier(node.name) &&
                node.initializer &&
                walk.aliasingInitializer(node.initializer, scan)
            ) {
                scan.addAlias(valueSymbol(node.name));
            }
            if (
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                ts.isIdentifier(node.left) &&
                walk.aliasingInitializer(node.right, scan)
            ) {
                scan.addAlias(valueSymbol(node.left));
            }
            return false;
        });
        if (mutated) return true;
    }
    return false;
}

const parameterMutationCache = new EmissionWeakMap<
    ts.TypeChecker,
    WeakMap<ts.Symbol, boolean>
>();

/** Whether a supported function actually writes through one parameter. */
export function parameterIsMutated(
    checker: ts.TypeChecker,
    declaration: SupportedFunction,
    parameter: ts.Identifier,
    active = new EmissionSet<ts.Symbol>(),
): boolean {
    const symbol = checker.getSymbolAtLocation(parameter);
    if (!symbol || !declaration.body) return false;
    const rootQuery = active.size === 0;
    let checkerCache: WeakMap<ts.Symbol, boolean> | undefined;
    if (rootQuery) {
        checkerCache = parameterMutationCache.get(checker);
        const cached = checkerCache?.get(symbol);
        if (cached !== undefined) return cached;
    }
    if (active.has(symbol)) return false;
    active.add(symbol);
    const symbols = new CompilerSymbols(checker);
    const mutated = aliasedMutationScan(
        parameter,
        (name) => checker.getSymbolAtLocation(name),
        {
            aliasingInitializer: (initializer, scan) => {
                const root = rootIdentifier(unwrapExpression(initializer));
                return root !== undefined && scan.namesAlias(root);
            },
            mutates: (node, scan) => {
                const rootNamesAlias = (expression: ts.Expression): boolean => {
                    const root = rootIdentifier(unwrapExpression(expression));
                    return root !== undefined && scan.namesAlias(root);
                };
                if (writesThroughRoot(node, rootNamesAlias)) return true;
                const retainedTarget = retainedNativeMutationTarget(symbols, node);
                if (retainedTarget && rootNamesAlias(retainedTarget)) return true;
                if (
                    ts.isBinaryExpression(node) &&
                    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                    (ts.isPropertyAccessExpression(node.left) ||
                        ts.isElementAccessExpression(node.left)) &&
                    scan.containsAlias(node.right)
                ) {
                    return true;
                }
                if (isStoringDataCall(node) && node.arguments?.some(scan.containsAlias)) return true;
                if (!ts.isCallExpression(node)) return false;
                const called = checker.getResolvedSignature(node)?.declaration;
                if (!isSupportedFunction(called)) return false;
                for (const [index, argument] of node.arguments.entries()) {
                    if (!scan.containsAlias(argument)) continue;
                    const nested = called.parameters[index]?.name;
                    if (
                        nested !== undefined &&
                        ts.isIdentifier(nested) &&
                        parameterIsMutated(checker, called, nested, active)
                    ) {
                        return true;
                    }
                }
                return false;
            },
        },
    );
    active.delete(symbol);
    if (rootQuery) {
        checkerCache ??= new EmissionWeakMap<ts.Symbol, boolean>();
        checkerCache.set(symbol, mutated);
        parameterMutationCache.set(checker, checkerCache);
    }
    return mutated;
}

/** Conservatively determines whether a function leaves a parameter unchanged. */
export function parameterIsReadOnly(
    checker: ts.TypeChecker,
    declaration: SupportedFunction,
    parameter: ts.Identifier,
    active = new EmissionSet<ts.Symbol>(),
): boolean {
    const symbol = checker.getSymbolAtLocation(parameter);
    if (!symbol || !declaration.body) return false;
    const rootQuery = active.size === 0;
    let checkerCache: WeakMap<ts.Symbol, boolean> | undefined;
    if (rootQuery) {
        checkerCache = parameterReadOnlyCache.get(checker)?.get(declaration);
        const cached = checkerCache?.get(symbol);
        if (cached !== undefined) return cached;
    }
    if (active.has(symbol)) return true;
    active.add(symbol);
    const aliases = new EmissionSet<ts.Symbol>([symbol]);
    const namesParameter = (node: ts.Node): boolean =>
        ts.isIdentifier(node) &&
        aliases.has(checker.getSymbolAtLocation(node)!);
    const containsParameter = (node: ts.Node): boolean => someAnalysisNode(node, namesParameter);
    const rootNamesParameter = (expression: ts.Expression): boolean => {
        const root = rootIdentifier(expression);
        return root !== undefined && namesParameter(root);
    };
    const containsAliasingParameter = (node: ts.Node): boolean => someAnalysisNode(node, namesParameter, {
        skip: candidate => ts.isExpression(candidate) && !typeCanCarryReference(checker.getTypeAtLocation(candidate)),
    });
    const parameterCanAlias = typeCanCarryReference(checker.getTypeAtLocation(parameter));
    const readOnly = !someAnalysisNode(declaration.body, (node) => {
        if (writesThroughRoot(node, rootNamesParameter)) {
            return true;
        }
        if (ts.isCallExpression(node) && parameterCanAlias) {
            for (const [index, argument] of node.arguments.entries()) {
                if (!containsParameter(argument)) continue;
                if (
                    ts.isPropertyAccessExpression(node.expression) &&
                    !rootNamesParameter(node.expression.expression) &&
                    storingDataMethods.has(node.expression.name.text)
                ) {
                    continue;
                }
                if (!callArgumentIsReadOnly(checker, node, index, active)) {
                    return true;
                }
            }
        }
        if (
            ts.isVariableDeclaration(node) &&
            node.initializer &&
            ts.isIdentifier(node.name) &&
            rootNamesParameter(node.initializer) &&
            typeCanCarryReference(checker.getTypeAtLocation(node.initializer))
        ) {
            const alias = checker.getSymbolAtLocation(node.name);
            if (alias) aliases.add(alias);
            return "skip";
        }
        if (
            ts.isVariableDeclaration(node) &&
            node.initializer &&
            containsAliasingParameter(node.initializer) &&
            (checker.getTypeAtLocation(node.initializer).flags &
                ts.TypeFlags.Object) !==
                0
        ) {
            // A composite wrapper can retain the parameter and expose a
            // second mutation path that this local alias set cannot follow.
            return true;
        }
        return false;
    });
    active.delete(symbol);
    if (rootQuery) {
        checkerCache ??= new EmissionWeakMap<ts.Symbol, boolean>();
        checkerCache.set(symbol, readOnly);
        let declarations = parameterReadOnlyCache.get(checker);
        if (!declarations) parameterReadOnlyCache.set(checker, declarations = new EmissionWeakMap());
        declarations.set(declaration, checkerCache);
    }
    return readOnly;
}

/**
 * The expression a supported function's own final `return` yields, if any.
 *
 * The one definition of "what this function returns": `irFor` reads it for the
 * IR's `returnExpression` and the snapshot predicate reads it for the value it
 * has to protect, so the two cannot drift apart.
 */
function finalReturnExpression(
    declaration: SupportedFunction,
): ts.Expression | undefined {
    const body = declaration.body;
    if (!body) return undefined;
    if (!ts.isBlock(body)) return body;
    const final = body.statements.at(-1);
    return final && ts.isReturnStatement(final) ? final.expression : undefined;
}

/**
 * Conservatively determines whether an inlined call's returned value can be
 * moved by a later call in the same expression.
 *
 * The inline lowerer splices a call's returned expression at its use site while
 * emitting the body's statements where the call was, so the two are separated:
 * `set(next(), next(), next())` emits three counter advances and then reads the
 * counter three times, and every component takes the LAST state. Two conditions
 * have to hold together for that, and both are checked here, because either one
 * alone covers most reached functions:
 *
 * - the returned expression READS state that outlives one call — a binding the
 *   module declares above the function (what a returned closure keeps), or one
 *   of its own parameters, which passes by native reference; and
 * - the body WRITES such a binding.
 *
 * A return over the function's own locals is already snapshotted, because the
 * inline frame gives each call its own native storage for them. That is the
 * difference between the two PRNGs the corpus carries: mulberry32 returns an
 * expression over its own `t`, while scene 179's `seededRandom` returns one
 * over the captured `s`, and only the second needs the temporary.
 *
 * The read half is checked first: it walks one expression where the write half
 * walks the whole body and every callee's body, and it answers false often
 * enough to skip a fifth of those walks on doom and two thirds on racer.
 */
function returnedValueCanMove(
    checker: ts.TypeChecker,
    declaration: SupportedFunction,
    active = new EmissionSet<SupportedFunction>(),
): boolean {
    const body = declaration.body;
    const returnExpression = finalReturnExpression(declaration);
    if (!body || !returnExpression) return false;
    if (active.has(declaration)) return false;
    // State that outlives one inline frame. A name from outside the module --
    // `Math`, an imported intrinsic -- is not state this compiler can move at
    // all, which is what keeps `Math.hypot(x, y)` from reading as a write.
    const ownFile = declaration.getSourceFile();
    const namesSharedBinding = (identifier: ts.Identifier): boolean => {
        const declarations =
            checker.getSymbolAtLocation(identifier)?.declarations;
        if (!declarations || declarations.length === 0) return false;
        return declarations.some(
            (node) =>
                (ts.isVariableDeclaration(node) ||
                    ts.isBindingElement(node) ||
                    ts.isParameter(node)) &&
                node.getSourceFile() === ownFile &&
                ts.findAncestor(node, (n) => n === body) === undefined,
        );
    };
    if (!readsSharedBinding(returnExpression, namesSharedBinding)) {
        return false;
    }
    active.add(declaration);
    try {
        return writesSharedBinding(
            checker,
            body,
            (expression) => {
                const root = rootIdentifier(expression);
                // A computed target this walk cannot resolve is assumed shared.
                return !root || namesSharedBinding(root);
            },
            active,
        );
    } finally {
        active.delete(declaration);
    }
}

/** Whether an expression reads a binding `namesShared` recognizes. */
function readsSharedBinding(
    expression: ts.Expression,
    namesShared: (identifier: ts.Identifier) => boolean,
): boolean {
    return someAnalysisNode(expression, node => ts.isIdentifier(node) && namesShared(node), { memberNames: "skip" });
}

/** Whether a function body writes through a root `isShared` recognizes. */
function writesSharedBinding(
    checker: ts.TypeChecker,
    body: ts.Node,
    isShared: (expression: ts.Expression) => boolean,
    active: Set<SupportedFunction>,
): boolean {

    const writes = someAnalysisNode(body, (node) => {
        if (writesThroughRoot(node, isShared)) {
            return true;
        }
        if (ts.isCallExpression(node)) {
            const called = checker.getResolvedSignature(node)?.declaration;
            if (
                isSupportedFunction(called) &&
                returnedValueCanMove(checker, called, active)
            ) {
                return true;
            }
        }
        return false;
    });

    return writes;
}

/**
 * Resolves an identifier to a reachable local function declaration and
 * validates the shared structural constraints (no generators, generics, or
 * rest parameters). Both the inline lowerer and the native data-function
 * lowerer resolve through this helper.
 */
export function resolveFunctionDeclaration(
    checker: ts.TypeChecker,
    identifier: ts.Identifier,
    fail: Fail,
): SupportedFunction | undefined {
    // A record property written in shorthand (`{ sync }`) resolves at
    // its own identifier to the literal's property symbol, so the
    // shorthand's value symbol is what names the function it refers to.
    const symbol =
        ts.isShorthandPropertyAssignment(identifier.parent) &&
        identifier.parent.name === identifier
            ? checker.getShorthandAssignmentValueSymbol(identifier.parent)
            : checker.getSymbolAtLocation(identifier);
    if (!symbol) {
        return undefined;
    }
    const target =
        (symbol.flags & ts.SymbolFlags.Alias) !== 0
            ? checker.getAliasedSymbol(symbol)
            : symbol;
    let declaration: SupportedFunction | undefined;
    for (const candidate of target.declarations ?? []) {
        if (ts.isFunctionDeclaration(candidate) && candidate.body) {
            declaration = candidate;
            break;
        }
        if (
            ts.isVariableDeclaration(candidate) &&
            candidate.initializer &&
            (ts.isArrowFunction(candidate.initializer) ||
                ts.isFunctionExpression(candidate.initializer))
        ) {
            declaration = candidate.initializer;
            break;
        }
    }
    if (!declaration) {
        return undefined;
    }
    if (
        (ts.isFunctionExpression(declaration) ||
            ts.isFunctionDeclaration(declaration)) &&
        declaration.asteriskToken
    ) {
        fail(
            declaration.asteriskToken,
            "Generator functions are not supported.",
        );
    }
    for (const parameter of declaration.parameters) {
        if (
            !ts.isIdentifier(parameter.name) &&
            !ts.isArrayBindingPattern(parameter.name) &&
            !ts.isObjectBindingPattern(parameter.name)
        ) {
            fail(
                parameter,
                "User-function parameters must be identifiers or binding patterns.",
            );
        }
        if (
            parameter.dotDotDotToken &&
            (!ts.isIdentifier(parameter.name) ||
                parameter !== declaration.parameters[declaration.parameters.length - 1])
        ) {
            fail(
                parameter,
                "A rest parameter is the last parameter and an identifier.",
            );
        }
        if (ts.isArrayBindingPattern(parameter.name)) {
            for (const element of parameter.name.elements) {
                if (
                    ts.isOmittedExpression(element) ||
                    !ts.isIdentifier(element.name) ||
                    element.dotDotDotToken ||
                    element.initializer
                ) {
                    fail(
                        element,
                        "Array-bound parameters support plain identifier elements.",
                    );
                }
            }
        }
    }
    return declaration;
}

/**
 * Resolve only a function this lowerer could call directly, without turning a
 * speculative probe into the diagnostic site.
 *
 * Some local calls are consumed by an earlier source-shape lowerer (compressed
 * JSON is one); those declarations may deliberately use language outside the
 * generic user-function surface.  Recursive-group discovery needs to ignore
 * them and let the real call dispatch decide, while an actually reached
 * unsupported call still fails through `resolveFunctionDeclaration` itself.
 * The generation-time Canvas2D probe asks the same question — "is this a
 * declaration the lowerers could accept?" — so it resolves through here too.
 * The strict form's fail contract stays `never`; this wrapper is the one
 * probe shape, converting the refusal into an undefined result.
 */
export function tryResolveFunctionDeclaration(
    checker: ts.TypeChecker,
    identifier: ts.Identifier,
): SupportedFunction | undefined {
    const unsupported = {};
    try {
        return resolveFunctionDeclaration(checker, identifier, () => {
            throw unsupported;
        });
    } catch (error) {
        if (error === unsupported) return undefined;
        throw error;
    }
}

/**
 * Whether a recursive callback's heap `std::function` object can be
 * referenced after the scope that emitted its storage returns.
 *
 * The storage is reachable only through the bindings that exist while the
 * recursive bodies are generated, so the escape surface is the members'
 * own bodies plus every function or constructor inlined into them (an
 * inlined body resolves the same canonical symbol the binding was made
 * under). Within that surface, a reference that is the callee of a direct
 * call runs while the emitting scope is still on the stack, so the owner
 * local already covers it. Any other reference can outlive the scope: a
 * member passed as a value (`setTimeout(tick, 700)` invokes the object
 * after the scope returned) or any reference inside a nested closure,
 * which may itself be retained.
 *
 * Member references resolve through `tryResolveFunctionDeclaration` -- the
 * resolver `directCalls` builds recursive groups with -- so this walk
 * cannot disagree with group discovery about what a member reference is,
 * and inlined callees follow `getResolvedSignature` exactly as
 * `returnedValueCanMove` follows them. Resolution only runs for
 * identifiers whose position is not already safe.
 */
export function recursiveStorageEscapes(
    checker: ts.TypeChecker,
    members: ReadonlySet<SupportedFunction>,
    regions: readonly ts.Node[],
): boolean {
    const visited = [new EmissionSet<ts.Node>(), new EmissionSet<ts.Node>()] as const;
    let escapes = false;
    const scan = (root: ts.Node, foreign: boolean): void => {
        const seen = visited[foreign ? 1 : 0];
        if (escapes || seen.has(root)) return;
        seen.add(root);
        const found = findAnalysisNodeWithState(root, foreign, (node, nested) => {
            if (ts.isIdentifier(node)) {
                const parent = node.parent;
                const namesOwnDeclaration =
                    (ts.isVariableDeclaration(parent) ||
                        ts.isFunctionDeclaration(parent) ||
                        ts.isFunctionExpression(parent) ||
                        ts.isMethodDeclaration(parent) ||
                        ts.isParameter(parent)) &&
                    parent.name === node;
                const directCallee =
                    !nested &&
                    ts.isCallExpression(parent) &&
                    parent.expression === node;
                if (namesOwnDeclaration || directCallee) return false;
                const resolved = tryResolveFunctionDeclaration(checker, node);
                return resolved !== undefined && members.has(resolved);
            }
            if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
                const called = checker.getResolvedSignature(node)?.declaration;
                if (
                    called !== undefined &&
                    (ts.isConstructorDeclaration(called) ||
                        (isSupportedFunction(called) &&
                            !members.has(called))) &&
                    called.body !== undefined
                ) {
                    scan(called.body, nested);
                }
            }
            return escapes;
        }, (node, nested) => nested || (node !== root && ts.isFunctionLike(node) &&
            !(isSupportedFunction(node) && members.has(node))));
        if (found) escapes = true;
    };
    for (const region of regions) {
        scan(region, false);
        if (escapes) break;
    }
    return escapes;
}

interface UserFunctionParameterIr {
    declaration: ts.ParameterDeclaration;
    name: ts.BindingName;
    type: ts.Type;
}

interface UserFunctionIr {
    declaration: SupportedFunction;
    name: string;
    parameters: UserFunctionParameterIr[];
    statements: readonly ts.Statement[];
    returnExpression?: ts.Expression | undefined;
    needsWrapper: boolean;
    needsValueLambda: boolean;
    needsLocalNative: boolean;
    /**
     * The call's returned scalar must be pinned before the next call moves it.
     *
     * It rides the IR rather than being recomputed in `lower()` because
     * `irFor` caches per declaration while `lower()` runs per call site: the
     * walk behind it then runs once per function (measured: 356 walks for 356
     * distinct declarations across the corpus) instead of once per call. A
     * recursive group omits it -- those lower to real native functions whose
     * return already lands in a local.
     */
    returnNeedsSnapshot?: boolean;
}

/** A value record cannot represent an alias into a retained native object. */
class SharedReturnRequiresInline extends Error {}

export interface UserFunctionContext
    extends PositiveIntegerContext,
    Pick<LoweringServices,
        | "options"
        | "withAsyncActivation"
        | "withOwnedCallbackBody"
        | "checker"
        | "dataTypes"
        | "dataLowerer"
        | "useNativeValue"
        | "compileValue"
        | "emitExpressionAsStatement"
        | "emitDiscardedValue"
        | "lookupIdentifierValue"
        | "functionEmissionScope"
        | "activeThis"
        | "canShareFunctionBody"
        | "canReplaySharedCallEffects"
        | "requiresStaticDataIteration"
        | "probeEmission"
        | "compileCondition"
        | "isBrowserOnlyExpression"
        | "isInFrameCallback"
        | "compileForDataSink"
        | "compileStoredDataFunction"
        | "dataValue"
        | "emitStatement"
        | "statementTerminatesAfterLowering"
        | "bindLocalValue"
        | "bindObjectPattern"
        | "bindCompileTimeValue"
        | "rebindCompileTimeValue"
        | "bindParameterValue"
        | "materializeEscapingValue"
        | "pinValueToTemporary"
        | "bindDataTuple"
        | "pushScope"
        | "popScope"
        | "allocateUserFunctionPrefix"
        | "allocateTemporaryCppName"
        | "reachJsData"
        | "captureEmittedLines"
        | "enterRuntimeControlFlow"
        | "leaveRuntimeControlFlow"
        | "emitNativeCallbackStorage"
        | "beginInlineFrame"
        | "endInlineFrame"
        | "beginNativeFunctionBody"
        | "endNativeFunctionBody"
        | "registerNativeBinding"
        | "registerNativeFunction"
        | "registerSharedNativeFunction"
        | "captureManagedClosureLines"
        | "callbackIdentity"
        | "emit"
        | "increaseIndent"
        | "decreaseIndent"
        | "fail"
    > {}

/**
 * The browser-only nullable fallback shape two success-path matchers share:
 * a body that is one `try` whose catch is `return null` and whose try block
 * ends in a `return <expression>`. What each matcher then checks is only its
 * own returned expression.
 */
function nullFallbackTryShape(
    declaration: ts.FunctionLikeDeclaration,
):
    | { tryStatements: readonly ts.Statement[]; returned: ts.Expression }
    | undefined {
    const body = declaration.body;
    if (!body || !ts.isBlock(body) || body.statements.length !== 1) {
        return undefined;
    }
    const statement = body.statements[0];
    if (
        !statement ||
        !ts.isTryStatement(statement) ||
        statement.finallyBlock ||
        !statement.catchClause
    ) {
        return undefined;
    }
    const catchStatements = statement.catchClause.block.statements;
    const catchReturn = catchStatements[0];
    if (
        catchStatements.length !== 1 ||
        !catchReturn ||
        !ts.isReturnStatement(catchReturn) ||
        catchReturn.expression?.kind !== ts.SyntaxKind.NullKeyword
    ) {
        return undefined;
    }
    const returned = statement.tryBlock.statements.at(-1);
    if (!returned || !ts.isReturnStatement(returned) || !returned.expression) {
        return undefined;
    }
    return {
        tryStatements: statement.tryBlock.statements,
        returned: returned.expression,
    };
}

export class UserFunctionLowerer {
    private readonly invocations = new EmissionMap<SupportedFunction, {
        call: ts.CallExpression;
        arguments: readonly Value[];
    }>();

    public invocationFor(declaration: SupportedFunction): { call: ts.CallExpression; arguments: readonly Value[] } | undefined {
        return this.invocations.get(declaration);
    }

    private readonly directCallCache = new EmissionMap<
        SupportedFunction,
        ReadonlySet<SupportedFunction>
    >();
    private readonly recursiveGroupCache = new EmissionMap<
        SupportedFunction,
        readonly SupportedFunction[] | null
    >();
    private readonly groupEscapeCache = new EmissionMap<SupportedFunction, boolean>();
    private readonly emittedRecursiveGroups = new FunctionSpecializations<{
        value: Value;
        returnMetadata: Value | undefined;
    }>();
    private readonly sharedBodyScope = {};
    private readonly readsReceiverCache = new EmissionMap<SupportedFunction, boolean>();

    private readsReceiver(root: SupportedFunction): boolean {
        const cached = this.readsReceiverCache.get(root);
        if (cached !== undefined) return cached;
        const seen = new Set<SupportedFunction>();
        const visit = (declaration: SupportedFunction): boolean => {
            if (seen.has(declaration)) return false;
            seen.add(declaration);
            return (declaration.body !== undefined && someAnalysisNode(declaration.body,
                node => node.kind === ts.SyntaxKind.ThisKeyword, { types: "skip" })) ||
                [...this.directCalls(declaration)].some(visit);
        };
        const result = visit(root);
        this.readsReceiverCache.set(root, result);
        return result;
    }

    private readonly cache = new EmissionMap<SupportedFunction, UserFunctionIr>();
    private readonly activeStoredDataFunctions = new EmissionMap<
        SupportedFunction,
        {
            cpp: string;
            dataType: DataType & { kind: "function" };
        }
    >();
    private readonly active = new EmissionSet<SupportedFunction>();

    public constructor(private readonly checker: ts.TypeChecker) {}

    /** Preserve closed boolean predicates before hoisting would discard their value. */
    public tryCompileStaticPredicate(context: UserFunctionContext, call: ts.CallExpression, identifier: ts.Identifier): Value | undefined {
        const declaration = resolveFunctionDeclaration(this.checker, identifier, (node, message) => context.fail(node, message));
        if (!declaration || this.active.has(declaration) || declaration.typeParameters?.length || restParameterIndex(declaration) !== undefined) return undefined;
        const signature = this.checker.getSignatureFromDeclaration(declaration);
        const flags = signature && this.checker.getReturnTypeOfSignature(signature).flags;
        if (flags === undefined || (flags & ts.TypeFlags.BooleanLike) === 0) return undefined;
        if (call.arguments.some(argument => {
            const node = unwrapExpression(argument);
            const bound = ts.isIdentifier(node) ? context.lookupIdentifierValue(node) : undefined;
            return bound !== undefined && !generationKnownPrimitive(bound);
        })) return undefined;
        try {
            return context.probeEmission(() => {
                const ir = this.irFor(declaration, identifier.text, (node, message) => context.fail(node, message));
                this.validateCall(context, call, ir, (node, message) => context.fail(node, message));
                const values = this.argumentValues(context, call, ir);
                if (!values.every(value => generationKnownPrimitive(value))) return undefined;
                const value = this.lower(context, ir, values, call);
                return value.staticBoolean !== undefined ? value : undefined;
            });
        } catch (error) {
            // Declining this optional specialization leaves the ordinary native
            // or inline path responsible for reached-source diagnostics.
            if (!(error instanceof CompileError)) throw error;
            return undefined;
        }
    }

    public compileSharedMethod(
        context: UserFunctionContext,
        declaration: ts.MethodDeclaration,
        call: ts.CallExpression,
        arguments_: readonly Value[],
    ): Value | undefined {
        const ir = this.irFor(declaration, declaration.name.getText(), (node, message) => context.fail(node, message));
        try {
            return context.probeEmission(() => this.lowerRecursiveGroup(context, ir, call, arguments_, [declaration], false));
        } catch (error) {
            if (!(error instanceof SharedReturnRequiresInline)) throw error;
            return undefined;
        }
    }

    /** Bind one reached parameter, including callback tuple destructuring. */
    private bindParameter(
        context: UserFunctionContext,
        parameter: UserFunctionParameterIr,
        value: Value,
    ): void {
        if (ts.isIdentifier(parameter.name)) {
            context.bindParameterValue(parameter.name, value);
            return;
        }
        if (ts.isObjectBindingPattern(parameter.name)) {
            // `({ a, b = 1 }: Options)`: the pattern binds from the
            // argument exactly as a destructuring declaration would.
            context.bindObjectPattern(parameter.name, value);
            return;
        }
        if (value.kind === "tuple" && value.tupleElements) {
            parameter.name.elements.forEach((element, index) => {
                if (ts.isOmittedExpression(element)) return;
                if (!ts.isIdentifier(element.name)) context.fail(element.name, "Callback tuple bindings require identifiers.");
                const lane = value.tupleElements![index];
                if (!lane) {
                    context.fail(
                        element,
                        "Array-bound callback parameter reads beyond the supplied tuple.",
                    );
                }
                context.bindParameterValue(element.name, lane);
            });
            return;
        }
        if (
            value.kind !== "data" ||
            (value.dataType?.kind !== "tuple" && value.dataType?.kind !== "product")
        ) {
            context.fail(
                parameter.name,
                "Array-bound callback parameters require a native tuple value.",
            );
        }
        parameter.name.elements.forEach((element, index) => {
            if (ts.isOmittedExpression(element)) return;
            if (!ts.isIdentifier(element.name)) context.fail(element.name, "Callback tuple bindings require identifiers.");
            context.bindParameterValue(element.name, context.dataLowerer.fixedTupleElement(value, index, element)!);
        });
    }

    /**
     * Keep a generation-known scalar at the call site when this inlined body
     * cannot mutate it. A normal parameter still gets native storage: this is
     * specialization only where the existing mutation walk proves that
     * rebinding or writing through the parameter is impossible.
     */
    private bindSpecializedParameter(
        context: UserFunctionContext,
        declaration: SupportedFunction,
        parameter: UserFunctionParameterIr,
        value: Value,
    ): void {
        if (
            generationKnownPrimitive(value) &&
            ts.isIdentifier(parameter.name) &&
            parameterIsReadOnly(this.checker, declaration, parameter.name)
        ) {
            context.bindCompileTimeValue(parameter.name, value);
            return;
        }
        this.bindParameter(context, parameter, value);
    }

    /**
     * `inBodyScope` wraps only the body lowering. A record method
     * closes over the scope that built the record, but its arguments
     * are written at the call site and belong to the scope there, so
     * they are evaluated before the wrapper takes effect.
     */
    public compile(
        context: UserFunctionContext,
        call: ts.CallExpression,
        identifier: ts.Identifier,
        inBodyScope: <T>(work: () => T) => T = (work) => work(),
    ): Value | undefined {
        const ir = this.resolve(identifier, (node, message) =>
            context.fail(node, message),
        );
        if (!ir) {
            return undefined;
        }
        this.validateCall(
            context,
            call,
            ir,
            (node, message) => context.fail(node, message),
        );
        const argumentValues = this.argumentValues(context, call, ir);
        this.materializeCyclicRecordCallbacks(
            context,
            ir.declaration,
            argumentValues,
        );
        return this.withCallTypeArguments(context, call, ir.declaration, () => {
            const recursiveGroup = this.recursiveGroup(ir.declaration);
            if (recursiveGroup) {
                return this.lowerRecursiveGroup(
                    context,
                    ir,
                    call,
                    argumentValues,
                    recursiveGroup,
                );
            }
            if (ir.needsLocalNative) {
                return this.lowerRecursiveGroup(context, ir, call, argumentValues, [
                    ir.declaration,
                ]);
            }
            return inBodyScope(() => this.trySharedCall(context, ir, call, argumentValues) ??
                this.lower(context, ir, argumentValues, call, ts.isExpressionStatement(call.parent)));
        });
    }

    private trySharedCall(
        context: UserFunctionContext,
        ir: UserFunctionIr,
        call: ts.Node,
        argumentValues: readonly Value[],
        pinArguments = true,
    ): Value | undefined {
        if (ts.isCallExpression(call) && requiresDefaultParameterBinding(this.checker, ir.declaration, call)) return undefined;
        if (ir.parameters.some((parameter, index) => {
            const value = argumentValues[index];
            return value && (value.staticString !== undefined || value.staticNumber !== undefined || value.staticBoolean !== undefined) &&
                context.dataTypes.fromTsType(this.checker.getTypeAtLocation(parameter.name), parameter.name)?.kind === "union";
        })) return undefined;
        // A generic body is spelled once per instantiation and a rest
        // parameter's arguments are packed per call, so both stay inline.
        if (!ir.declaration.body || !ir.parameters.every(parameter => ts.isIdentifier(parameter.name)) ||
            ir.declaration.typeParameters?.length || restParameterIndex(ir.declaration) !== undefined ||
            !context.canShareFunctionBody(ir.declaration.body)) return undefined;
        const signature = this.checker.getSignatureFromDeclaration(ir.declaration);
        const returned = signature && nativeReturnTsType(this.checker,
            this.checker.getReturnTypeOfSignature(signature), ir.declaration);
        const returnType = returned && context.dataTypes.fromSharedReturnType(returned, ir.declaration);
        if (!returned || (returnType && !context.dataTypes.carriesFunction(returnType))) {
            const group = this.recursiveGroup(ir.declaration);
            const lowerShared = (): Value => this.lowerRecursiveGroup(
                context, ir, call, argumentValues, group ?? [ir.declaration], group !== undefined, pinArguments);
            if (returnType && !context.dataTypes.carriesHandle(returnType) &&
                (returnType.kind !== "struct" || context.dataTypes.isReferenceStruct(returnType.name))) return lowerShared();
            try {
                return context.probeEmission(lowerShared);
            } catch (error) {
                if (!(error instanceof SharedReturnRequiresInline)) throw error;
            }
        }
        return undefined;
    }

    private materializeCyclicRecordCallbacks(
        context: UserFunctionContext,
        target: SupportedFunction,
        arguments_: readonly Value[],
    ): void {
        const reachesTarget = (
            declaration: SupportedFunction,
            seen = new EmissionSet<SupportedFunction>(),
        ): boolean => {
            if (seen.has(declaration)) return false;
            seen.add(declaration);
            for (const callee of this.directCalls(declaration)) {
                if (callee === target || reachesTarget(callee, seen)) {
                    return true;
                }
            }
            return false;
        };
        for (const argument of arguments_) {
            if (argument.kind !== "record") {
                continue;
            }
            const properties =
                argument.recordProperties ?? (argument.recordProperties = {});
            for (const [name, property] of Object.entries(properties)) {
                const declaration = property.callbackDeclaration;
                if (
                    property.kind !== "callback" ||
                    !declaration ||
                    ts.isIdentifier(declaration) ||
                    !reachesTarget(declaration)
                ) {
                    continue;
                }
                const dataType = context.dataTypes.fromTsType(
                    this.checker.getTypeAtLocation(declaration),
                    declaration,
                );
                if (dataType?.kind !== "function") continue;
                const active = this.activeStoredDataFunctions.get(declaration);
                if (active) {
                    properties[name] = {
                        kind: "data",
                        cpp: active.cpp,
                        dataType: active.dataType,
                    };
                    continue;
                }
                const cpp = context.compileStoredDataFunction(
                    declaration,
                    dataType,
                    property.callbackRecordOwner,
                );
                properties[name] = {
                    kind: "data",
                    cpp,
                    dataType,
                };
            }
            for (const [name, method] of Object.entries(
                argument.recordMethods ?? {},
            )) {
                const declaration = ts.isIdentifier(method)
                    ? tryResolveFunctionDeclaration(this.checker, method)
                    : method;
                if (!declaration || !reachesTarget(declaration)) continue;
                const dataType = context.dataTypes.fromTsType(
                    this.checker.getTypeAtLocation(method),
                    method,
                );
                if (dataType?.kind !== "function") continue;
                const active = this.activeStoredDataFunctions.get(declaration);
                if (active) {
                    properties[name] = {
                        kind: "data",
                        cpp: active.cpp,
                        dataType: active.dataType,
                    };
                    delete argument.recordMethods![name];
                    continue;
                }
                const cpp = context.compileStoredDataFunction(
                    declaration,
                    dataType,
                    argument,
                );
                properties[name] = {
                    kind: "data",
                    cpp,
                    dataType,
                };
                delete argument.recordMethods![name];
            }
        }
    }

    /**
     * Inline function-literal arguments and local names bound to function
     * declarations bind as callback values; every other argument compiles
     * normally.
     */
    private argumentValue(
        context: UserFunctionContext,
        argument: ts.Expression,
    ): Value {
        const unwrapped = unwrapExpression(argument);
        if (
            ts.isPropertyAccessExpression(unwrapped) &&
            unwrapped.name.text === "body" &&
            ts.isIdentifier(unwrapped.expression) &&
            unwrapped.expression.text === "document" &&
            (
                this.checker.getSymbolAtLocation(unwrapped.expression)
                    ?.declarations ?? []
            ).some((declaration) =>
                /(?:^|[\\/])lib\.dom\.d\.ts$/i.test(
                    declaration.getSourceFile().fileName,
                ),
            )
        ) {
            return {
                kind: "ui-element",
                cpp: "",
                uiRoot: true,
                truthinessCpp: "true",
            };
        }
        if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) {
            return {
                kind: "callback",
                cpp: "",
                callbackDeclaration: argument,
            };
        }
        if (ts.isIdentifier(argument)) {
            const declaration = resolveFunctionDeclaration(
                this.checker,
                argument,
                (node, message) => context.fail(node, message),
            );
            if (declaration) {
                return {
                    kind: "callback",
                    cpp: "",
                    callbackDeclaration: declaration,
                };
            }
        }
        if (
            context.isBrowserOnlyExpression(argument) &&
            !ts.isCallExpression(argument) &&
            !ts.isIdentifier(argument)
        ) {
            return { kind: "browser", cpp: "" };
        }
        const value = context.compileValue(argument);
        if (value.kind === "number" && value.staticNumber === undefined && !value.parameterBinding) {
            const staticNumber = staticNumberValue(context, argument);
            if (staticNumber !== undefined && Number.isFinite(staticNumber)) return {...value, staticNumber};
        }
        return value;
    }

    /** Compile a call through a bound callback in its lexical scope. */
    public compileCallbackCall(
        context: UserFunctionContext,
        call: ts.CallExpression,
        declaration: SupportedFunction,
        inBodyScope: <T>(work: () => T) => T = (work) => work(),
    ): Value {
        const ir = this.irFor(declaration, "callback", (node, message) =>
            context.fail(node, message),
        );
        this.validateCall(
            context,
            call,
            ir,
            (node, message) => context.fail(node, message),
        );
        // As in `compile`: the arguments were written at the call site
        // and resolve in the scope there, so only the body runs in the
        // scope the callback closed over.
        const argumentValues = this.argumentValues(context, call, ir);
        return this.withCallTypeArguments(context, call, ir.declaration, () =>
            inBodyScope(() => this.trySharedCall(context, ir, call, argumentValues) ??
                this.lower(context, ir, argumentValues, call, ts.isExpressionStatement(call.parent))));
    }

    /**
     * Invokes a local `std::function` produced for a recursive function
     * specialization. Data arguments remain runtime parameters; values
     * outside the data model are captured and must stay identical for every
     * call in the specialization.
     */
    public compileNativeCallbackCall(
        context: UserFunctionContext,
        call: ts.CallExpression,
        bound: Value,
        evaluatedArguments?: readonly Value[],
    ): Value | undefined {
        context.useNativeValue(bound);
        const parameterTypes = bound.nativeCallbackParameterTypes;
        const declaration = bound.callbackDeclaration;
        if (!declaration) {
            if (!parameterTypes || bound.cpp.length === 0) {
                return undefined;
            }
            if (call.arguments.length !== parameterTypes.length) {
                context.fail(
                    call,
                    "Forward native callback received the wrong number of arguments.",
                );
            }
            const argumentsCpp = parameterTypes.map((type, index) => {
                if (!type) {
                    context.fail(
                        call,
                        "Forward native callback parameters must be plain data.",
                    );
                }
                return context.compileForDataSink(argumentAt(call, index), type);
            });
            const cpp = `${bound.cpp}(${argumentsCpp.join(", ")})`;
            return bound.nativeCallbackReturnType
                ? context.dataValue(cpp, bound.nativeCallbackReturnType)
                : { kind: "void", cpp };
        }
        if (ts.isIdentifier(declaration)) {
            if (bound.cpp.length > 0) {
                context.fail(
                    declaration,
                    "Native callback is missing its function signature.",
                );
            }
            return undefined;
        }
        if (!parameterTypes) {
            if (bound.cpp.length === 0) {
                return undefined;
            }
            const signature =
                this.checker.getSignatureFromDeclaration(declaration);
            if (!signature) {
                context.fail(
                    declaration,
                    "Native callback is missing its function signature.",
                );
            }
            if (call.arguments.length > declaration.parameters.length) {
                context.fail(
                    call,
                    "Native callback received too many arguments.",
                );
            }
            const argumentsCpp = declaration.parameters.map(
                (parameter, index) => {
                    const argument =
                        call.arguments[index] ?? parameter.initializer;
                    if (!argument) {
                        context.fail(
                            call,
                            `Native callback requires argument ${index + 1}.`,
                        );
                    }
                    const type = context.dataTypes.fromTsType(
                        this.checker.getTypeAtLocation(parameter),
                        parameter,
                    );
                    if (!type) {
                        context.fail(
                            parameter,
                            "Native callback parameters must have plain-data types.",
                        );
                    }
                    return context.compileForDataSink(argument, type);
                },
            );
            const cpp = `${bound.cpp}(${argumentsCpp.join(", ")})`;
            const returnTsType = nativeReturnTsType(
                this.checker,
                this.checker.getReturnTypeOfSignature(signature),
                declaration,
            );
            if (!returnTsType) {
                return { kind: "void", cpp };
            }
            const returnType = context.dataTypes.fromTsType(
                returnTsType,
                declaration,
            );
            if (!returnType) {
                context.fail(
                    declaration,
                    "Native callback return type must be plain data or void.",
                );
            }
            return context.dataValue(cpp, returnType);
        }
        return this.compileSpecializedCallbackCall(context, call, bound, evaluatedArguments, call.arguments);
    }

    private compileSpecializedCallbackCall(
        context: UserFunctionContext,
        call: ts.Node,
        bound: Value,
        evaluatedArguments?: readonly Value[],
        expressions: readonly ts.Expression[] = [],
    ): Value {
        context.useNativeValue(bound);
        const declaration = bound.callbackDeclaration;
        const parameterTypes = bound.nativeCallbackParameterTypes;
        if (!declaration || ts.isIdentifier(declaration) || !parameterTypes) {
            context.fail(call, "A specialized callback requires its declaration and parameter types.");
        }
        if ((evaluatedArguments?.length ?? expressions.length) > declaration.parameters.length) {
            context.fail(
                call,
                "Recursive function received too many arguments.",
            );
        }
        const captured = bound.nativeCallbackStaticArguments;
        if (!captured) {
            context.fail(
                call,
                "Recursive function is missing its captured arguments.",
            );
        }
        const runtimeArguments: string[] = [];
        declaration.parameters.forEach((parameter, index) => {
            const argument = expressions[index] ?? parameter.initializer;
            const evaluated = evaluatedArguments?.[index] ??
                (!argument && parameter.questionToken ? { kind: "json-null", cpp: "std::nullopt" } satisfies Value : undefined);
            if (!argument && !evaluated) {
                context.fail(
                    call,
                    `Recursive function requires argument ${index + 1}.`,
                );
            }
            const type = parameterTypes[index];
            if (type) {
                const cpp = evaluated ? context.dataLowerer.compileKnownValueForSink(evaluated, type, argument ?? parameter)
                    : context.compileForDataSink(argument!, type);
                if (passesByReference(context.dataTypes, type)) {
                    // Bind both lvalues and temporary identity-bearing containers.
                    const name = context.allocateTemporaryCppName("call_argument");
                    context.emit({ kind: "declaration", type: "auto&&", name: name, initializer: cpp });
                    runtimeArguments.push(name);
                } else runtimeArguments.push(cpp);
                return;
            }
            const value = evaluated ??
                (evaluatedArguments ? captured[index] : undefined) ?? this.argumentValue(context, argument!);
            const existing = captured[index];
            if (existing && !evaluatedArguments && !this.sameCapturedValue(existing, value)) {
                context.fail(
                    argument ?? parameter,
                    "A recursive function was called with a different compile-time argument; separate runtime class/resource specializations are not supported at one call site.",
                );
            }
            captured[index] = existing ?? value;
        });
        const cpp = `${bound.cpp}(${runtimeArguments.join(", ")})`;
        return bound.nativeCallbackReturnType
            ? context.dataValue(cpp, bound.nativeCallbackReturnType)
            : { kind: "void", cpp };
    }

    private sameCapturedValue(left: Value, right: Value): boolean {
        return (
            left === right ||
            (left.kind === right.kind &&
                left.cpp === right.cpp &&
                left.objectIdentityCpp === right.objectIdentityCpp &&
                left.recordProperties === right.recordProperties)
        );
    }

    /** Finds the strongly connected call-graph component containing root. */
    private recursiveGroup(
        root: SupportedFunction,
    ): readonly SupportedFunction[] | undefined {
        const cached = this.recursiveGroupCache.get(root);
        if (cached !== undefined) return cached ?? undefined;
        const direct = (declaration: SupportedFunction) =>
            this.directCalls(declaration);
        const reachable = new EmissionSet<SupportedFunction>();
        const collect = (declaration: SupportedFunction): void => {
            if (reachable.has(declaration)) return;
            reachable.add(declaration);
            for (const called of direct(declaration)) collect(called);
        };
        collect(root);
        const callers = new EmissionMap<SupportedFunction, Set<SupportedFunction>>();
        for (const declaration of reachable) {
            for (const called of direct(declaration)) {
                if (!reachable.has(called)) continue;
                const entries = callers.get(called) ?? new EmissionSet();
                entries.add(declaration);
                callers.set(called, entries);
            }
        }
        const reachesRoot = new EmissionSet<SupportedFunction>([root]);
        const pending = [root];
        while (pending.length > 0) {
            const current = pending.pop()!;
            for (const caller of callers.get(current) ?? []) {
                if (reachesRoot.has(caller)) continue;
                reachesRoot.add(caller);
                pending.push(caller);
            }
        }
        const group = [...reachable].filter((declaration) =>
            reachesRoot.has(declaration),
        );
        if (group.length === 1 && !direct(root).has(root)) {
            this.recursiveGroupCache.set(root, null);
            return undefined;
        }
        const ordered = [
            root,
            ...group.filter((declaration) => declaration !== root),
        ];
        this.recursiveGroupCache.set(root, ordered);
        return ordered;
    }

    private directCalls(
        declaration: SupportedFunction,
    ): ReadonlySet<SupportedFunction> {
        const cached = this.directCallCache.get(declaration);
        if (cached) return cached;
        const callees = new EmissionSet<SupportedFunction>();
        const body = declaration.body;
        if (body) forEachAnalysisNode(body, (node) => {
            if (ts.isCallExpression(node)) {
                // Passing a named callback can call back into this function
                // just as a direct call can (array methods and schedulers).
                for (const argument of node.arguments) {
                    const value = unwrapExpression(argument);
                    const callback = ts.isIdentifier(value) ? tryResolveFunctionDeclaration(this.checker, value) : undefined;
                    if (callback) callees.add(callback);
                }
            }
            if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
                const called = tryResolveFunctionDeclaration(
                    this.checker,
                    node.expression,
                );
                if (called) callees.add(called);
            }
        }, { skip: node => node !== body && ts.isFunctionLike(node) });
        this.directCallCache.set(declaration, callees);
        return callees;
    }

    /**
     * Whether this group's callback storage must outlive the emitting
     * scope. One verdict covers every member: an escaping member's body
     * reaches its siblings through their `[&]`-captured references, so if
     * any member survives the scope, every member's object must. The
     * verdict depends only on source shape, so it is cached per root the
     * way the group itself is.
     */
    private groupStorageEscapes(
        declarations: readonly SupportedFunction[],
    ): boolean {
        const root = declarations[0]!;
        const cached = this.groupEscapeCache.get(root);
        if (cached !== undefined) return cached;
        const escapes = recursiveStorageEscapes(
            this.checker,
            new EmissionSet(declarations),
            declarations.flatMap((declaration) =>
                declaration.body ? [declaration.body] : [],
            ),
        );
        this.groupEscapeCache.set(root, escapes);
        return escapes;
    }

    private lowerRecursiveGroup(
        context: UserFunctionContext,
        root: UserFunctionIr,
        call: ts.Node,
        rootArguments: readonly Value[],
        declarations: readonly SupportedFunction[],
        recursive = true,
        pinArguments = true,
    ): Value {
        const argumentExpressions = pinArguments && ts.isCallExpression(call) ? call.arguments : [];
        const callSiteEffects = !recursive && root.declaration.body !== undefined && context.canReplaySharedCallEffects(root.declaration.body);
        rootArguments = rootArguments.map((value, index) => {
            const expression = argumentExpressions[index];
            return isHandleKind(value.kind) && expression && !ts.isIdentifier(unwrapExpression(expression))
                ? context.pinValueToTemporary(value, "resource_argument", expression)
                : value;
        });
        const entries = declarations.map((declaration) => {
            const name = recursive ? this.declarationName(declaration) : root.name;
            const ir = this.recursiveIrFor(
                declaration,
                name,
                (node, message) => context.fail(node, message),
            );
            const signature =
                this.checker.getSignatureFromDeclaration(declaration);
            if (!signature) {
                context.fail(
                    declaration,
                    "Recursive function has no callable signature.",
                );
            }
            const asyncWithoutValueReturn =
                declaration.modifiers?.some(
                    (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
                ) === true &&
                (!declaration.body ||
                    !this.containsValueReturn(
                        ts.isBlock(declaration.body)
                            ? declaration.body.statements
                            : [],
                    ));
            const returnTsType = asyncWithoutValueReturn
                ? undefined
                : nativeReturnTsType(
                      this.checker,
                      this.checker.getReturnTypeOfSignature(signature),
                      declaration,
                  );
            const mappedReturnType = returnTsType
                ? context.dataTypes.fromSharedReturnType(returnTsType, declaration)
                : undefined;
            const returnType = mappedReturnType?.kind === "struct" && context.dataTypes.carriesHandle(mappedReturnType)
                ? context.dataTypes.markStoredObjectReferences(mappedReturnType)
                : mappedReturnType;
            if (returnTsType && !returnType) {
                context.fail(
                    declaration,
                    "Recursive function return type must be plain data or void.",
                );
            }
            const returnsArray = context.dataTypes.returnsArray(returnType);
            const arrayStorage = returnsArray ? arrayReturnStorage(this.checker, declaration) : undefined;
            const parameterTypes = ir.parameters.map(
                ({ type, declaration: parameter }) => {
                    let mapped = context.dataTypes.fromTsType(
                        type,
                        parameter,
                    );
                    const freshMatchingArray = arrayStorage === "fresh" &&
                        mapped?.kind === "span" && returnType?.kind === "vector" && dataTypesEqual(mapped.element, returnType.element);
                    if (mapped && returnsArray && !freshMatchingArray) {
                        mapped = context.dataTypes.ownReturnedArray(mapped);
                    }
                    const inner = mapped?.kind === "optional" ? mapped.inner : mapped;
                    const platformHandle = inner?.kind === "handle" &&
                        (inner.handle === "gamepad" || inner.handle === "gamepad-button");
                    return mapped &&
                        mapped.kind !== "function" &&
                        (!context.dataTypes.carriesHandle(mapped) || platformHandle)
                        ? mapped
                        : undefined;
                },
            );
            const parameterReadOnly = ir.parameters.map(({ name: parameter }) => {
                if (!ts.isIdentifier(parameter)) context.fail(parameter, "Recursive function parameters require identifiers.");
                return parameterIsReadOnly(
                    this.checker,
                    declaration,
                    parameter,
                );
            });
            const cppName =
                `bbl_recursive_${context.allocateUserFunctionPrefix()}` +
                sanitizeCppIdentifier(name);
            const captured: (Value | undefined)[] = new Array(
                parameterTypes.length,
            );
            const value: Value = {
                kind: "callback",
                cpp: cppName,
                callbackDeclaration: declaration,
                nativeCallbackParameterTypes: parameterTypes,
                nativeCallbackStaticArguments: captured,
                ...(returnType ? { nativeCallbackReturnType: returnType } : {}),
            };
            return {
                ir,
                declaration,
                returnType,
                parameterTypes,
                parameterReadOnly,
                cppName,
                captured,
                value,
                returnMetadata: undefined as Value | undefined,
                callSiteEffects,
                argumentFacts: callSiteEffects && declaration.body && context.requiresStaticDataIteration(declaration.body)
                    ? rootArguments : [],
            };
        });
        const entryByDeclaration = new EmissionMap(
            entries.map((entry) => [entry.declaration, entry]),
        );
        const rootEntry = entryByDeclaration.get(root.declaration)!;
        root.parameters.forEach((parameter, index) => {
            const argument = rootArguments[index];
            const symbol = ts.isIdentifier(parameter.name) ? this.checker.getSymbolAtLocation(parameter.name) : undefined;
            const loopBound = argument?.staticNumber !== undefined && symbol && root.declaration.body &&
                someAnalysisNode(root.declaration.body, node => ts.isForStatement(node) && node.condition !== undefined &&
                    someAnalysisNode(node.condition, part => ts.isIdentifier(part) && this.checker.getSymbolAtLocation(part) === symbol));
            const tupleFacts = argument && rootEntry.argumentFacts.length > 0 &&
                rootEntry.parameterTypes[index]?.kind === "tuple" &&
                (argument.tupleElements || argument.staticElementsOwner?.staticElements || argument.staticElements);
            if (argument?.kind === "record" || tupleFacts || (argument && rootEntry.parameterReadOnly[index] &&
                (argument.staticString !== undefined || argument.staticBoolean !== undefined || loopBound))) {
                rootEntry.parameterTypes[index] = undefined;
                rootEntry.captured[index] = argument;
                return;
            }
            if (rootEntry.parameterTypes[index]) return;
            const value =
                argument ??
                (parameter.declaration.initializer
                    ? context.compileValue(parameter.declaration.initializer)
                    : parameter.declaration.questionToken
                      ? { kind: "json-null", cpp: "std::nullopt" } satisfies Value
                      : context.fail(
                          parameter.declaration,
                          `Recursive function requires argument '${parameter.name.getText()}'.`,
                      ));
            rootEntry.captured[index] = value;
        });

        const escapes = this.groupStorageEscapes(declarations);
        const sharedBody = !recursive;
        const scope = sharedBody
            ? { lexical: this.sharedBodyScope, emission: 0, block: 0, continuation: -1 }
            : context.functionEmissionScope();
        const specialization = callSiteEffects ? undefined : this.emittedRecursiveGroups.key(scope, [
            rootEntry.captured,
            declarations.some(declaration => this.readsReceiver(declaration)) ? context.activeThis() : undefined,
            functionDependencies(context, declarations),
        ]);
        const previous = specialization === undefined ? undefined : this.emittedRecursiveGroups.get(root.declaration, specialization);
        if (previous) {
            const result = this.compileSpecializedCallbackCall(context, call, previous.value, rootArguments, argumentExpressions);
            return this.sharedReturnValue(context, result, previous.returnMetadata, call);
        }
        context.reachJsData();
        const localGroup = escapes && recursive ? undefined : {
            cpp: `bbl_recursive_${context.allocateUserFunctionPrefix()}group`,
            self: `bbl_recursive_${context.allocateUserFunctionPrefix()}self`,
            bodies: new Map<SupportedFunction, string>(),
        };
        for (const [index, entry] of entries.entries()) {
            if (localGroup) {
                entry.value.cpp = recursive ? `${localGroup.self}.template call<${index}>` : localGroup.cpp;
                continue;
            }
            const returnCpp = entry.returnType
                ? context.dataTypes.cppType(entry.returnType)
                : "void";
            const parametersCpp = entry.parameterTypes
                .map((type, index) =>
                    type
                        ? this.recursiveParameterCpp(
                              context.dataTypes,
                              type,
                              entry.parameterReadOnly[index]!,
                          )
                        : undefined,
                )
                .filter((type): type is string => type !== undefined);
            const storage = context.emitNativeCallbackStorage(
                entry.cppName,
                `${returnCpp}(${parametersCpp.join(", ")})`,
                escapes,
            );
            Object.assign(entry.value, storage);
            entry.cppName = storage.cpp;
        }

        // These symbol bindings exist only while the specialized bodies are
        // generated. A later source call may observe different compile-time
        // class/resource arguments and receives its own local specialization.
        context.pushScope(context.allocateUserFunctionPrefix());
        try {
            for (const entry of recursive ? entries : []) {
                const identifier = this.declarationIdentifier(
                    entry.declaration,
                );
                context.bindLocalValue(identifier, entry.value);
            }
            const pending = new EmissionSet(entries);
            while (pending.size > 0) {
                const entry = [...pending].find((candidate) =>
                    candidate.parameterTypes.every(
                        (type, index) =>
                            type !== undefined ||
                            candidate.captured[index] !== undefined,
                    ),
                );
                if (!entry) {
                    context.fail(
                        call,
                        "Recursive function group has a compile-time parameter that no reached call supplies.",
                    );
                }
                pending.delete(entry);
                entry.returnMetadata = this.emitRecursiveFunctionBody(
                    context,
                    entry,
                    escapes,
                    localGroup && {
                        ...(recursive ? { self: localGroup.self } : {}),
                        ...(sharedBody ? { sharedName: localGroup.cpp } : {}),
                        accept: body => localGroup.bodies.set(entry.declaration, body),
                    },
                );
            }
        } finally {
            context.popScope();
        }
        if (localGroup) {
            const bodies = entries.map(entry => localGroup.bodies.get(entry.declaration)!).join(",\n");
            if (sharedBody) rootEntry.value.cpp = bodies;
            else {
                context.emit({ kind: "declaration", type: "auto", name: localGroup.cpp, initializer: recursive ? `bbl::js::make_recursive_group(\n${bodies}\n)` : bodies });
                const binding = context.registerNativeBinding(localGroup.cpp, false, true);
                for (const [index, entry] of entries.entries()) {
                    entry.value.cpp = recursive ? `${localGroup.cpp}.template call<${index}>` : localGroup.cpp;
                    entry.value.nativeCaptures = [binding];
                }
            }
        }
        if (specialization !== undefined) {
            this.emittedRecursiveGroups.set(root.declaration, specialization, {
                value: rootEntry.value, returnMetadata: rootEntry.returnMetadata,
            });
        }
        const result = this.compileSpecializedCallbackCall(
            context,
            call,
            rootEntry.value,
            rootArguments,
            argumentExpressions,
        );
        return this.sharedReturnValue(context, result, rootEntry.returnMetadata, call);
    }

    private sharedReturnValue(context: UserFunctionContext, result: Value, metadata: Value | undefined, call: ts.Node): Value {
        if (!metadata) return result;
        if (isHandleKind(result.kind)) return withNativeMetadata(result, metadata);
        if (result.kind !== "data") return result;
        if (metadata.recordProperties && result.dataType?.kind === "struct")
            result = context.pinValueToTemporary(result, "shared_return", ts.isExpression(call) ? call : undefined);
        const projected = { ...result };
        if (metadata.truthinessCpp === "true") Object.assign(projected, { truthinessCpp: "true", optionalFoundCpp: "true" });
        if (metadata.recordProperties && result.dataType?.kind === "struct") {
            const fields = context.dataTypes.structFields(result.dataType.name, call);
            const member = context.dataTypes.isReferenceStruct(result.dataType.name) ? "->" : ".";
            projected.recordProperties = Object.fromEntries(Object.keys(metadata.recordProperties).map(key => {
                const field = fields.find(field => field.sourceName === key);
                if (!field) throw new SharedReturnRequiresInline();
                return [key, context.dataValue(`(${result.cpp})${member}${field.name}`, field.type)];
            }));
        }
        return projected;
    }

    /** Recursive bodies run as real lambdas, so all return statements stay. */
    private recursiveIrFor(
        declaration: SupportedFunction,
        name: string,
        fail: Fail,
    ): UserFunctionIr {
        const body = declaration.body;
        if (!body) {
            fail(declaration, "Recursive function requires a body.");
        }
        const parameters = declaration.parameters.map(
            (parameter): UserFunctionParameterIr => {
                if (!ts.isIdentifier(parameter.name)) {
                    fail(
                        parameter,
                        "Recursive function parameters must be identifiers.",
                    );
                }
                return {
                    declaration: parameter,
                    name: parameter.name,
                    type: this.checker.getTypeAtLocation(parameter),
                };
            },
        );
        return {
            declaration,
            name,
            parameters,
            statements: ts.isBlock(body) ? body.statements : [],
            needsWrapper: false,
            needsValueLambda: false,
            needsLocalNative: false,
            ...(!ts.isBlock(body) ? { returnExpression: body } : {}),
        };
    }

    private emitRecursiveFunctionBody(
        context: UserFunctionContext,
        entry: {
            ir: UserFunctionIr;
            declaration: SupportedFunction;
            value: Value;
            returnType: DataType | undefined;
            parameterTypes: readonly (DataType | undefined)[];
            parameterReadOnly: readonly boolean[];
            cppName: string;
            captured: readonly (Value | undefined)[];
            callSiteEffects: boolean;
            argumentFacts: readonly Value[];
        },
        escapes: boolean,
        localGroup?: { self?: string; sharedName?: string; accept: (body: string) => void },
    ): Value | undefined {
        const returnCpp = entry.returnType
            ? context.dataTypes.cppType(entry.returnType)
            : "void";
        let returnMetadata: Value | undefined;
        context.pushScope(context.allocateUserFunctionPrefix());
        try {
            const parameterDeclarations: string[] = localGroup?.self ? [`[[maybe_unused]] auto& ${localGroup.self}`] : [];
            const parameterNames: string[] = [];
            const parameterBindings: Array<{
                parameter: UserFunctionParameterIr;
                value: Value;
                compileTime?: boolean;
            }> = [];
            let runtimeIndex = 0;
            const parameterPrefix = context.allocateUserFunctionPrefix();
            entry.ir.parameters.forEach((parameter, index) => {
                const type = entry.parameterTypes[index];
                if (!type) {
                    const value = entry.captured[index]!;
                    const symbol = ts.isIdentifier(parameter.name) ? this.checker.getSymbolAtLocation(parameter.name) : undefined;
                    const stableHandle = isHandleKind(value.kind) && symbol && entry.declaration.body &&
                        !someAnalysisNode(entry.declaration.body, node => {
                            const target = isAssignmentExpression(node) ? unwrapExpression(node.left) :
                                isUpdateExpression(node) ? unwrapExpression(node.operand) : undefined;
                            const rebinds = (target: ts.Expression): boolean => {
                                target = unwrapExpression(target);
                                if (ts.isIdentifier(target)) return this.checker.getSymbolAtLocation(target) === symbol;
                                if (ts.isArrayLiteralExpression(target)) return target.elements.some(rebinds);
                                if (ts.isObjectLiteralExpression(target)) return target.properties.some(property =>
                                    ts.isShorthandPropertyAssignment(property) ? rebinds(property.name) :
                                    ts.isPropertyAssignment(property) ? rebinds(property.initializer) :
                                    ts.isSpreadAssignment(property) && rebinds(property.expression));
                                if (ts.isSpreadElement(target)) return rebinds(target.expression);
                                return ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken && rebinds(target.left);
                            };
                            return target !== undefined && rebinds(target);
                        });
                    parameterBindings.push({
                        parameter,
                        value,
                        compileTime: entry.parameterReadOnly[index] === true || stableHandle === true,
                    });
                    return;
                }
                const cppName = `${parameterPrefix}recursive_arg_${runtimeIndex++}`;
                parameterNames.push(cppName);
                parameterDeclarations.push(
                    `[[maybe_unused]] ${this.recursiveParameterCpp(context.dataTypes, type, entry.parameterReadOnly[index]!)} ${cppName}`,
                );
                parameterBindings.push({
                    parameter,
                    value: {
                        ...context.dataValue(cppName, type),
                        ...(entry.parameterReadOnly[index]
                            ? { readOnly: true as const }
                            : {}),
                        ...(entry.parameterReadOnly[index] && entry.argumentFacts[index]?.staticNumber !== undefined
                            ? { staticNumber: entry.argumentFacts[index]!.staticNumber,
                                nativeBinding: true as const } : {}),
                    },
                });
            });
            const returnedValues: Value[] = [];
            const compileReturn = localGroup && !localGroup.self && entry.returnType &&
                (context.dataTypes.carriesHandle(entry.returnType) || entry.returnType.kind === "struct")
                ? (expression: ts.Expression, type: DataType): string => {
                    const value = context.compileValue(expression);
                    const resourceType = type.kind === "optional" ? type.inner : type;
                    if (resourceType.kind === "handle" && value.kind !== resourceType.handle && value.kind !== "json-null") {
                        throw new SharedReturnRequiresInline();
                    }
                    if (value.retainedNativeRecord || value.cameraVector || value.sceneNodeVector || value.borrowedData ||
                        value.materialUboArrayFields?.size) {
                        throw new SharedReturnRequiresInline();
                    }
                    returnedValues.push(value);
                    return context.dataLowerer.compileKnownValueForSink(value, type, expression);
                }
                : undefined;
            context.beginNativeFunctionBody(entry.returnType, false, {
                runtimeDataLoops: localGroup !== undefined && localGroup.self === undefined,
                callSiteEffects: entry.callSiteEffects,
                ...(compileReturn ? { compileReturn } : {}),
            });
            let captured: CapturedClosure;
            try {
                captured = context.captureManagedClosureLines(() => {
                if (localGroup?.self) context.registerNativeBinding(localGroup.self, true);
                for (const { parameter, value, compileTime } of parameterBindings) {
                    if (value.nativeBinding && parameterNames.includes(value.cpp)) {
                        value.nativeCaptures = [context.registerNativeBinding(value.cpp, true)];
                    }
                    if (compileTime && ts.isIdentifier(parameter.name)) {
                        context.bindCompileTimeValue(parameter.name, value);
                        continue;
                    }
                    this.bindSpecializedParameter(
                        context,
                        entry.declaration,
                        parameter,
                        value,
                    );
                }
                const body = entry.declaration.body;
                if (!body) {
                    context.fail(
                        entry.declaration,
                        "Recursive function requires a body.",
                    );
                }
                if (ts.isBlock(body)) {
                    for (const statement of body.statements) {
                        if (
                            ts.isReturnStatement(statement) &&
                            statement.expression &&
                            ts.isIdentifier(statement.expression)
                        ) {
                            returnMetadata = context.lookupIdentifierValue(
                                statement.expression,
                            );
                        }
                        context.emitStatement(statement);
                        if (context.statementTerminatesAfterLowering(statement)) break;
                    }
                } else {
                    if (!entry.returnType) {
                        context.emitExpressionAsStatement(body);
                    } else {
                        context.emit(
                            `return ${compileReturn ? compileReturn(body, entry.returnType) : context.compileForDataSink(body, entry.returnType)};`,
                        );
                    }
                }
                }, !escapes);
                if (returnedValues.length > 0 && isHandleKind(returnedValues[0]!.kind)) {
                    const common = commonResourceValue(returnedValues[0]!, returnedValues);
                    // The caller owns its result storage and presence test. Callee
                    // locals and capture expressions cannot cross this boundary.
                    returnMetadata = valueForKind(common.kind, {
                        cpp: "",
                        ...(returnedValues.every(value => value.handleIdentity === common.handleIdentity)
                            ? { handleIdentity: common.handleIdentity } : {}),
                        ...Object.fromEntries(metadataFieldsForKind(common.kind).map(key => [key, common[key]])),
                    });
                } else if (returnedValues.length > 0 && returnedValues.every(value =>
                    value.kind === "record" || value.truthinessCpp === "true")) {
                    const properties = returnedValues[0]!.recordProperties;
                    const keys = properties && Object.keys(properties);
                    const sameKeys = keys && returnedValues.every(value => {
                        const current = Object.keys(value.recordProperties ?? {});
                        return current.length === keys.length && current.every((key, index) => key === keys[index]);
                    });
                    returnMetadata = { kind: "record", cpp: "", truthinessCpp: "true",
                        ...(sameKeys ? { recordProperties: properties } : {}) };
                }
            } finally {
                context.endNativeFunctionBody();
            }
            let closure: string;
            if (localGroup?.sharedName) {
                const parameters = [`[[maybe_unused]] auto& ${captured.environment}`, ...parameterDeclarations];
                const sharedName = context.registerSharedNativeFunction(localGroup.sharedName, [
                    `inline constexpr auto ${localGroup.sharedName} = [](${parameters.join(", ")}) -> ${returnCpp} {`,
                    ...captured.lines.map(line => `    ${line}`),
                    "};",
                ], [...captured.localBindings, ...parameterNames]);
                closure = `bbl::js::make_closure(${captured.initializer}, bblscene::${sharedName})`;
                entry.value.nativeCaptures = captured.nativeCaptures;
            } else closure = renderClosure(captured, parameterDeclarations.join(", "), returnCpp);
            if (localGroup) localGroup.accept(closure);
            else context.emit(`${entry.cppName} = ${closure};`);
        } finally {
            context.popScope();
        }
        return returnMetadata;
    }

    private recursiveParameterCpp(
        dataTypes: DataTypeRegistry,
        type: DataType,
        readOnly: boolean,
    ): string {
        const cpp = dataTypes.cppType(type);
        return passesByReference(dataTypes, type)
            ? `${readOnly ? "const " : ""}${cpp}&`
            : cpp;
    }

    private declarationIdentifier(
        declaration: SupportedFunction,
    ): ts.Identifier {
        if (
            (ts.isFunctionDeclaration(declaration) ||
                ts.isFunctionExpression(declaration)) &&
            declaration.name
        ) {
            return declaration.name;
        }
        if (
            ts.isMethodDeclaration(declaration) &&
            ts.isIdentifier(declaration.name)
        ) {
            return declaration.name;
        }
        const parent = declaration.parent;
        if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
            return parent.name;
        }
        throw new Error("Recursive function must have a stable identifier.");
    }

    private declarationName(declaration: SupportedFunction): string {
        return this.declarationIdentifier(declaration).text;
    }

    /** Invokes a callback over values supplied by a lowering operation. */
    public compileCallbackWithValues(
        context: UserFunctionContext,
        declaration:
            | ts.Identifier
            | ts.ArrowFunction
            | ts.FunctionExpression
            | ts.MethodDeclaration,
        arguments_: readonly Value[],
        callNode: ts.Node,
        discardReturn = false,
    ): Value {
        const bound = ts.isIdentifier(declaration) ? context.lookupOptional(declaration) : undefined;
        if (bound?.dataType?.kind === "function") {
            const result = context.dataLowerer.compileFunctionValueCall(bound, arguments_, callNode);
            if (!discardReturn) return result;
            context.emitDiscardedValue(result);
            return {kind: "void", cpp: ""};
        }
        const ir = ts.isIdentifier(declaration)
            ? this.resolve(declaration, (node, message) =>
                  context.fail(node, message),
              )
            : this.irFor(declaration, "callback", (node, message) =>
                  context.fail(node, message),
              );
        if (!ir) {
            context.fail(
                declaration,
                "Compile-time callback does not resolve to a local function.",
            );
        }
        if (
            ir.parameters.length > arguments_.length &&
            ir.parameters
                .slice(arguments_.length)
                .some(({ declaration: parameter }) => !parameter.initializer)
        ) {
            context.fail(
                declaration,
                `Callback '${ir.name}' declares more parameters than the operation supplies.`,
            );
        }
        const values = arguments_.slice(0, ir.parameters.length);
        // The frame driver already retains and invokes this callback. Its
        // self-scheduling source edge is not an immediate recursive call.
        const frameCallback = callNode === declaration && context.isInFrameCallback();
        const group = frameCallback ? undefined : this.recursiveGroup(ir.declaration);
        const shared = bound?.nativeCallbackParameterTypes && bound.cpp
            ? this.compileSpecializedCallbackCall(context, callNode, bound, values)
            : group ? this.lowerRecursiveGroup(context, ir, callNode, values, group, true, false)
                : this.trySharedCall(context, ir, callNode, values, false);
        if (shared) {
            if (!discardReturn) return shared;
            context.emitDiscardedValue(shared);
            return { kind: "void", cpp: "" };
        }
        return this.lower(
            context,
            ir,
            values,
            callNode,
            discardReturn,
        );
    }

    /** Materializes a read-only closure as a copyable native function value. */
    public compileStoredDataFunction(
        context: UserFunctionContext,
        expression: ts.Identifier | SupportedFunction,
        dataType: DataType & { kind: "function" },
        owner?: Value,
    ): string {
        const unwrapped =
            ts.isFunctionDeclaration(expression) ||
            ts.isMethodDeclaration(expression)
                ? expression
                : unwrapExpression(expression);
        const declaration = ts.isIdentifier(unwrapped)
            ? resolveFunctionDeclaration(
                  this.checker,
                  unwrapped,
                  (node, message) => context.fail(node, message),
              )
            : isSupportedFunction(unwrapped)
              ? unwrapped
              : undefined;
        if (!declaration) {
            context.fail(
                expression,
                "Stored function must resolve to a local function declaration or literal.",
            );
        }
        const signature = this.checker.getSignatureFromDeclaration(declaration);
        if (
            dataType.result &&
            dataType.result.kind !== "promise" &&
            signature &&
            !nativeReturnTsType(
                this.checker,
                this.checker.getReturnTypeOfSignature(signature),
                declaration,
            )
        ) {
            const { result: _discarded, ...voidFunction } = dataType;
            void _discarded;
            dataType = voidFunction;
        }
        const ir = this.irFor(declaration, "stored callback", (node, message) =>
            context.fail(node, message),
        );
        const runtimeParameters = ir.parameters.filter(
            (parameter) =>
                (parameter.type.flags &
                    (ts.TypeFlags.Never | ts.TypeFlags.Void)) ===
                0,
        );
        if (runtimeParameters.slice(dataType.parameters.length).some(parameter =>
            !parameter.declaration.initializer && !parameter.declaration.questionToken)) {
            context.fail(
                declaration,
                "Stored function declares more parameters than its native data signature.",
            );
        }
        const prefix = context.allocateUserFunctionPrefix();
        const cppName = `${prefix}stored_callback`;
        const parameters = dataType.parameters.map((type, index) => ({
            parameter: runtimeParameters[index],
            type,
            cppName: `${prefix}arg_${index}`,
        }));
        const asynchronous = !!context.options.workers && ts.getModifiers(declaration)?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) === true;
        const promiseType = dataType.result?.kind === "promise" ? dataType.result : undefined;
        const bodyResult = asynchronous ? promiseType?.result : dataType.result;
        const returnCpp = asynchronous ? context.dataTypes.cppType(promiseType ?? {kind:"promise"})
            : dataType.result ? context.dataTypes.cppType(dataType.result) : "void";
        const ownIdentifier = this.referencesOwnBinding(declaration)
            ? ts.isFunctionDeclaration(declaration)
                ? declaration.name
                : (ts.isArrowFunction(declaration) ||
                        ts.isFunctionExpression(declaration)) &&
                    ts.isVariableDeclaration(declaration.parent) &&
                    declaration.parent.initializer === declaration &&
                    ts.isIdentifier(declaration.parent.name)
                  ? declaration.parent.name
                  : undefined
            : undefined;
        const selfIdentifier = ownIdentifier && !context.lookupIdentifierValue(ownIdentifier)?.sharedStorageCpp
            ? ownIdentifier : undefined;
        const cppType = context.dataTypes.cppType(dataType);
        const selfOwnerCpp = selfIdentifier ? `${cppName}_owner` : undefined;
        const selfWeakCpp = selfIdentifier ? `${cppName}_weak` : undefined;
        if (selfIdentifier) {
            context.emit(
                { kind: "declaration", type: "auto", name: selfOwnerCpp!, initializer: `bbl::js::make_gc_shared<${cppType}>()` },
            );
            context.emit(
                { kind: "declaration", type: `std::weak_ptr<${cppType}>`, name: selfWeakCpp!, initializer: selfOwnerCpp! },
            );
            const selfValue: Value = {
                kind: "data",
                cpp: `bbl::js::retain_callback(${selfWeakCpp}.lock())`,
                dataType,
                nativeCaptures: [context.registerNativeBinding(selfWeakCpp!)],
            };
            if (context.lookupIdentifierValue(selfIdentifier)) {
                context.rebindCompileTimeValue(selfIdentifier, selfValue);
            } else {
                context.bindCompileTimeValue(selfIdentifier, selfValue);
            }
            this.activeStoredDataFunctions.set(declaration, {
                cpp: selfValue.cpp,
                dataType,
            });
        }
        context.pushScope(prefix);
        context.beginNativeFunctionBody(bodyResult, asynchronous && !promiseType, {coroutine:asynchronous});
        let closure: CapturedClosure;
        try {
            const compileBody = () => context.captureManagedClosureLines(() => {
                let runtimeIndex = 0;
                for (const parameter of ir.parameters) {
                    if (
                        (parameter.type.flags &
                            (ts.TypeFlags.Never | ts.TypeFlags.Void)) !==
                        0
                    ) {
                        const initializer = parameter.declaration.initializer;
                        if (initializer) {
                            const evaluated = context.compileValue(initializer);
                            context.emitDiscardedValue(evaluated);
                        }
                        continue;
                    }
                    const supplied = parameters[runtimeIndex++];
                    if (!supplied) {
                        this.bindSpecializedParameter(context, ir.declaration, parameter,
                            this.parameterValue(context, parameter, undefined, undefined));
                        continue;
                    }
                    const { type, cppName: name } = supplied;
                    let value = context.dataValue(name, type);
                    if (
                        parameter.declaration.initializer &&
                        type.kind === "optional"
                    ) {
                        const fallback = context.compileForDataSink(
                            parameter.declaration.initializer,
                            type.inner,
                        );
                        value = context.dataValue(
                            `(${name}.has_value() ? *${name} : ${fallback})`,
                            type.inner,
                        );
                    }
                    this.bindSpecializedParameter(
                        context,
                        ir.declaration,
                        parameter,
                        value,
                    );
                }
                const terminated = emitReachableStatements(context, ir.statements);
                if (!terminated && ir.returnExpression) {
                    if (!bodyResult) {
                        const discarded = context.compileValue(
                            ir.returnExpression,
                        );
                        context.emitDiscardedValue(discarded);
                    } else {
                        context.emit(
                            `${asynchronous ? "co_return" : "return"} ${context.compileForDataSink(ir.returnExpression, bodyResult)};`,
                        );
                    }
                }
                if (asynchronous && !terminated && !bodyResult) context.emit("co_return bbl::js::PromiseVoid{};");
            });
            closure = asynchronous ? context.withOwnedCallbackBody(() => context.withAsyncActivation(compileBody)) : compileBody();
        } finally {
            context.endNativeFunctionBody();
            context.popScope();
            if (selfIdentifier) {
                this.activeStoredDataFunctions.delete(declaration);
            }
        }
        // A callback a container compares carries the identity of the
        // declaration it came from together with the closure that
        // declaration closes over, so it is brace-initialized with that
        // identity beside the closure; everything else is the plain
        // assignment the stored-function model already emitted.
        const identity = dataType.identity
            ? owner?.repeatedCallbackEvaluation
                ? "{bbl::js::next_callback_identity(), "
                : `{${context.callbackIdentity(declaration, owner)}u, `
            : " = ";
        const lambda = asynchronous ? renderAsyncClosure(closure, parameters.map(({type, cppName:name}) =>
            ({type:context.dataTypes.cppType(type), name})), returnCpp, !promiseType)
            : renderClosure(closure, parameters.map(({ type, cppName: name }) =>
                `[[maybe_unused]] ${context.dataTypes.cppType(type)} ${name}`).join(", "), returnCpp);
        context.emit(
            selfIdentifier
                ? dataType.identity
                    ? `(*${selfOwnerCpp}) = ${cppType}${identity}${lambda}};`
                    : `(*${selfOwnerCpp}) = ${lambda};`
                : `${cppType} ${cppName}${identity}${lambda}${dataType.identity ? "}" : ""};`,
        );
        if (selfIdentifier) {
            context.emit(
                { kind: "declaration", type: cppType, name: cppName, initializer: `bbl::js::retain_callback(${selfOwnerCpp})` },
            );
        }
        return cppName;
    }

    private referencesOwnBinding(declaration: SupportedFunction): boolean {
        const identifier = ts.isFunctionDeclaration(declaration)
            ? declaration.name
            : (ts.isArrowFunction(declaration) ||
                    ts.isFunctionExpression(declaration)) &&
                ts.isVariableDeclaration(declaration.parent) &&
                declaration.parent.initializer === declaration &&
                ts.isIdentifier(declaration.parent.name)
              ? declaration.parent.name
              : undefined;
        const valueSymbol = (
            candidate: ts.Identifier,
        ): ts.Symbol | undefined => {
            const found =
                ts.isShorthandPropertyAssignment(candidate.parent) &&
                candidate.parent.name === candidate
                    ? this.checker.getShorthandAssignmentValueSymbol(
                          candidate.parent,
                      )
                    : this.checker.getSymbolAtLocation(candidate);
            return found && (found.flags & ts.SymbolFlags.Alias) !== 0
                ? this.checker.getAliasedSymbol(found)
                : found;
        };
        const symbol = identifier ? valueSymbol(identifier) : undefined;
        if (!symbol || !declaration.body) return false;

        const found = someAnalysisNode(declaration.body, (node) => {
            if (ts.isIdentifier(node) && valueSymbol(node) === symbol) {
                return true;
            }
            return false;
        });

        return found;
    }

    /** Invokes an Array predicate with JavaScript truthiness at its return. */
    public compilePredicateWithValues(
        context: UserFunctionContext,
        declaration:
            | ts.Identifier
            | ts.ArrowFunction
            | ts.FunctionExpression
            | ts.MethodDeclaration,
        arguments_: readonly Value[],
        callNode: ts.Node,
    ): Value {
        const ir = ts.isIdentifier(declaration)
            ? this.resolve(declaration, (node, message) =>
                  context.fail(node, message),
              )
            : this.irFor(declaration, "callback", (node, message) =>
                  context.fail(node, message),
              );
        if (ir?.needsValueLambda) {
            const value = this.lower(context, ir, arguments_, callNode);
            const condition = context.dataLowerer.conditionFromValue(value);
            if (condition === undefined) context.fail(declaration, "Array predicate return has no native truthiness.");
            return { kind: "boolean", cpp: condition, dataType: { kind: "boolean" },
                ...(condition === "true" || condition === "false" ? { staticBoolean: condition === "true" } : {}) };
        }
        if (!ir?.returnExpression) {
            context.fail(
                declaration,
                "Array predicates require a final return expression without early value returns.",
            );
        }
        if (this.active.has(ir.declaration)) {
            context.fail(
                callNode,
                "Recursive Array predicates are not supported.",
            );
        }
        this.active.add(ir.declaration);
        context.pushScope(context.allocateUserFunctionPrefix());
        try {
            ir.parameters.forEach((parameter, index) => {
                const argument = arguments_[index];
                const value =
                    argument ??
                    (parameter.declaration.initializer
                        ? context.compileValue(
                              parameter.declaration.initializer,
                          )
                        : context.fail(
                              parameter.declaration,
                              "Array predicate parameter requires an argument or default.",
                          ));
                this.bindSpecializedParameter(
                    context,
                    ir.declaration,
                    parameter,
                    value,
                );
            });
            for (const statement of ir.statements) {
                context.emitStatement(statement);
            }
            const condition = context.compileCondition(ir.returnExpression);
            return {
                kind: "boolean",
                cpp: condition,
                ...(condition === "true"
                    ? { staticBoolean: true }
                    : condition === "false"
                      ? { staticBoolean: false }
                      : {}),
                dataType: { kind: "boolean" },
            };
        } finally {
            context.popScope();
            this.active.delete(ir.declaration);
        }
    }

    private lower(
        context: UserFunctionContext,
        ir: UserFunctionIr,
        arguments_: readonly Value[],
        callNode: ts.Node,
        discardReturn = false,
    ): Value {
        if (this.active.has(ir.declaration)) {
            context.fail(
                callNode,
                `Recursive call to '${ir.name}' is not supported.`,
            );
        }
        this.active.add(ir.declaration);
        if (ts.isCallExpression(callNode)) this.invocations.set(ir.declaration, { call: callNode, arguments: arguments_ });
        context.pushScope(context.allocateUserFunctionPrefix());
        try {
            ir.parameters.forEach((parameter, index) => {
                const argument = arguments_[index];
                const value = this.parameterValue(context, parameter, argument,
                    ts.isCallExpression(callNode) ? callNode.arguments[index] : undefined);
                this.bindSpecializedParameter(
                    context,
                    ir.declaration,
                    parameter,
                    value,
                );
            });
            if (ir.needsValueLambda) {
                const specialized = context.probeEmission(
                    () => this.lowerStaticReturnPath(context, ir, discardReturn),
                    value => value !== undefined,
                );
                if (specialized) return specialized;
                const returnType = discardReturn ? undefined : this.valueLambdaReturnType(
                    context,
                    ir,
                    callNode,
                );
                const result = `bbl_fn_${context.allocateUserFunctionPrefix()}result`;
                context.emit(
                    `${returnType ? `[[maybe_unused]] const auto ${result} = ` : ""}[&]() -> ${returnType ? context.dataTypes.cppType(returnType) : "void"} {`,
                );
                context.increaseIndent();
                context.beginNativeFunctionBody(returnType, discardReturn);
                try {
                    const terminated = emitReachableStatements(context, ir.statements);
                    if (!terminated && returnType) {
                        context.emit(
                            'throw std::runtime_error("Native value function fell through without returning.");',
                        );
                    }
                } finally {
                    context.endNativeFunctionBody();
                    context.decreaseIndent();
                }
                context.emit("}();");
                return returnType ? context.dataValue(result, returnType) : {kind:"void", cpp:""};
            }
            if (ir.needsWrapper) {
                context.emit("do {");
                context.increaseIndent();
            }
            context.beginInlineFrame(ir.needsWrapper);
            let terminated = false;
            try {
                terminated = emitReachableStatements(context, ir.statements);
            } finally {
                context.endInlineFrame();
            }
            if (ir.needsWrapper) {
                context.decreaseIndent();
                context.emit("} while (false);");
            }
            if (terminated || !ir.returnExpression) return { kind: "void", cpp: "" };
            if (discardReturn) {
                context.emitExpressionAsStatement(ir.returnExpression);
                return { kind: "void", cpp: "" };
            }
            return this.lowerReturnedValue(context, ir, ir.returnExpression);
        } finally {
            context.popScope();
            this.active.delete(ir.declaration);
            this.invocations.delete(ir.declaration);
        }
    }

    /** Keep generation-known branch returns as values, including shader composition records. */
    private lowerStaticReturnPath(
        context: UserFunctionContext,
        ir: UserFunctionIr,
        discardReturn: boolean,
    ): Value | undefined {
        type Outcome = { kind: "returned"; value: Value } | { kind: "continue" } | { kind: "dynamic" };
        const walk = (statements: readonly ts.Statement[]): Outcome => {
            for (const statement of statements) {
                if (ts.isReturnStatement(statement)) {
                    if (!statement.expression) return { kind: "dynamic" };
                    if (discardReturn) {
                        context.emitExpressionAsStatement(statement.expression);
                        return { kind: "returned", value: { kind: "void", cpp: "" } };
                    }
                    return { kind: "returned", value: this.lowerReturnedValue(context, ir, statement.expression) };
                }
                if (ts.isBlock(statement)) {
                    context.pushScope(context.allocateUserFunctionPrefix());
                    let outcome: Outcome;
                    try { outcome = walk(statement.statements); }
                    finally { context.popScope(); }
                    if (outcome.kind !== "continue") return outcome;
                } else if (firstReturn([statement])) {
                    if (!ts.isIfStatement(statement)) return { kind: "dynamic" };
                    const condition = context.compileCondition(statement.expression);
                    if (condition !== "true" && condition !== "false") return { kind: "dynamic" };
                    const branch = condition === "true" ? statement.thenStatement : statement.elseStatement;
                    const outcome = branch ? walk([branch]) : { kind: "continue" } as const;
                    if (outcome.kind !== "continue") return outcome;
                } else {
                    context.emitStatement(statement);
                    if (context.statementTerminatesAfterLowering(statement)) return { kind: "dynamic" };
                }
            }
            return { kind: "continue" };
        };
        const outcome = walk(ir.statements);
        return outcome.kind === "returned" ? outcome.value : undefined;
    }

    private lowerReturnedValue(context: UserFunctionContext, ir: UserFunctionIr, expression: ts.Expression): Value {
        let returned = context.compileValue(expression);
        if (returned.kind === "number" && returned.staticNumber === undefined) {
            const staticNumber = staticNumberValue(context, expression);
            if (staticNumber !== undefined && Number.isFinite(staticNumber)) {
                returned = { ...returned, staticNumber };
            }
        }
        const label = `return_${ir.name}`;
        return {
            // A body that wrote state outliving the frame returns an
            // expression OVER that state, so it is read here rather than
            // at the use site, where the next call would have moved it.
            ...(ir.returnNeedsSnapshot
                ? context.pinValueToTemporary(returned, label, expression)
                : context.materializeEscapingValue(returned, label, expression)),
            requiresExplicitDiscard: true,
        };
    }

    private resolve(
        identifier: ts.Identifier,
        fail: Fail,
    ): UserFunctionIr | undefined {
        const declaration = resolveFunctionDeclaration(
            this.checker,
            identifier,
            fail,
        );
        if (!declaration) {
            return undefined;
        }
        return this.irFor(declaration, identifier.text, fail);
    }

    private irFor(
        declaration: SupportedFunction,
        nameHint: string,
        fail: Fail,
    ): UserFunctionIr {
        const cached = this.cache.get(declaration);
        if (cached) {
            return cached;
        }
        const parameters = declaration.parameters.map(
            (parameter): UserFunctionParameterIr => {
                return {
                    declaration: parameter,
                    name: parameter.name,
                    type: this.checker.getTypeAtLocation(parameter),
                };
            },
        );
        const body = declaration.body;
        if (!body) {
            fail(declaration, "Reached user functions require a body.");
        }

        // A retained Canvas2D helper may expose an async nullable factory so
        // the browser can fall back when an optional fetched asset is absent.
        // Native packaging is closed over every reached fetch: the response is
        // present by construction, and a missing file is already a hard package
        // error. Inline the success arm of this deliberately narrow factory
        // shape, preserving the constructed class value instead of forcing it
        // through the plain-data early-return lambda model.
        const retainedCanvasFactory =
            this.retainedCanvasFactorySuccessPath(declaration) ??
            this.packagedImageBitmapSuccessPath(declaration);
        if (retainedCanvasFactory) {
            const ir: UserFunctionIr = {
                declaration,
                name:
                    (ts.isMethodDeclaration(declaration) &&
                    ts.isIdentifier(declaration.name)
                        ? declaration.name.text
                        : undefined) ?? nameHint,
                parameters,
                statements: retainedCanvasFactory.statements,
                needsWrapper: false,
                needsValueLambda: false,
                needsLocalNative: false,
                returnNeedsSnapshot: false,
                returnExpression: retainedCanvasFactory.returnExpression,
            };
            this.cache.set(declaration, ir);
            return ir;
        }
        // A concise arrow body is exactly `{ return <expression>; }`, so
        // it lowers as the final value return with no statements before
        // it. `frameForIndex: (index) => 8 + (index % 16)` is that shape.
        if (!ts.isBlock(body)) {
            const conciseIr: UserFunctionIr = {
                declaration,
                name: nameHint,
                parameters,
                statements: [],
                needsWrapper: false,
                needsValueLambda: false,
                needsLocalNative: false,
                returnNeedsSnapshot: returnedValueCanMove(
                    this.checker,
                    declaration,
                ),
                returnExpression: body,
            };
            this.cache.set(declaration, conciseIr);
            return conciseIr;
        }
        // The final statement may be a value return. An earlier value return
        // needs actual function control flow, so the call lowers through an
        // immediately-invoked native lambda. Earlier bare returns in a void
        // helper retain the lighter breakable-wrapper path.
        const finalStatement = body.statements.at(-1);
        const finalReturn =
            finalStatement && ts.isReturnStatement(finalStatement)
                ? finalStatement
                : undefined;
        const leadingStatements = finalReturn
            ? body.statements.slice(0, -1)
            : body.statements;
        const needsValueLambda = this.containsValueReturn(leadingStatements);
        const statements = needsValueLambda
            ? body.statements
            : leadingStatements;
        const earlyReturns = needsValueLambda
            ? "none"
            : this.classifyEarlyReturns(statements, fail);
        const needsWrapper = earlyReturns === "wrapper";
        const needsLocalNative = earlyReturns === "native";
        if (needsWrapper && finalReturn?.expression) {
            fail(
                finalReturn,
                "Inlined functions cannot combine a bare early return with a final return value.",
            );
        }
        const ir: UserFunctionIr = {
            declaration,
            name:
                (ts.isFunctionDeclaration(declaration) ||
                ts.isFunctionExpression(declaration)
                    ? declaration.name?.text
                    : undefined) ?? nameHint,
            parameters,
            statements,
            needsWrapper,
            needsValueLambda,
            needsLocalNative,
            returnNeedsSnapshot: returnedValueCanMove(
                this.checker,
                declaration,
            ),
            ...(!needsValueLambda && finalReturn?.expression
                ? {
                      returnExpression: finalReturn.expression,
                  }
                : {}),
        };
        this.cache.set(declaration, ir);
        return ir;
    }

    private retainedCanvasFactorySuccessPath(declaration: SupportedFunction):
        | {
              statements: readonly ts.Statement[];
              returnExpression: ts.Expression;
          }
        | undefined {
        if (
            !ts.isMethodDeclaration(declaration) ||
            (ts.getCombinedModifierFlags(declaration) &
                ts.ModifierFlags.Static) ===
                0 ||
            !ts.isClassDeclaration(declaration.parent) ||
            !declaration.body ||
            declaration.body.statements.length !== 1
        ) {
            return undefined;
        }
        const owner = declaration.parent;
        const ownsRetainedCanvas = owner.members.some((member) => {
            if (!ts.isPropertyDeclaration(member)) return false;
            const type = this.checker.getTypeAtLocation(member);
            const members =
                (type.flags & ts.TypeFlags.Union) !== 0
                    ? (type as ts.UnionType).types
                    : [type];
            return members.some((candidate) => {
                const name = candidate.getSymbol()?.getName();
                return (
                    name === "HTMLCanvasElement" ||
                    name === "OffscreenCanvas" ||
                    name === "CanvasRenderingContext2D"
                );
            });
        });
        if (!ownsRetainedCanvas) return undefined;

        const shape = nullFallbackTryShape(declaration);
        if (!shape || !ts.isNewExpression(shape.returned)) {
            return undefined;
        }
        const successStatements = shape.tryStatements;
        const constructed = shape.returned;
        const constructedSymbol = this.checker.getSymbolAtLocation(
            constructed.expression,
        );
        const ownerSymbol = owner.name
            ? this.checker.getSymbolAtLocation(owner.name)
            : undefined;
        if (!constructedSymbol || constructedSymbol !== ownerSymbol) {
            return undefined;
        }

        const statements: ts.Statement[] = [];
        const packagedFetchResponses = new EmissionSet<ts.Symbol>();
        for (const current of successStatements.slice(0, -1)) {
            if (ts.isVariableStatement(current)) {
                for (const declaration of current.declarationList
                    .declarations) {
                    if (
                        !ts.isIdentifier(declaration.name) ||
                        !declaration.initializer
                    ) {
                        continue;
                    }
                    let initializer: ts.Expression = declaration.initializer;
                    while (ts.isAwaitExpression(initializer)) {
                        initializer = initializer.expression;
                    }
                    const call = unwrapExpression(initializer);
                    if (
                        ts.isCallExpression(call) &&
                        ts.isIdentifier(call.expression) &&
                        call.expression.text === "fetch"
                    ) {
                        const symbol = this.checker.getSymbolAtLocation(
                            declaration.name,
                        );
                        if (symbol) packagedFetchResponses.add(symbol);
                    }
                }
            }
            const condition = ts.isIfStatement(current)
                ? unwrapExpression(current.expression)
                : undefined;
            let packagedFetchMiss = false;
            if (
                condition &&
                ts.isPrefixUnaryExpression(condition) &&
                condition.operator === ts.SyntaxKind.ExclamationToken
            ) {
                const tested = unwrapExpression(condition.operand);
                if (
                    ts.isPropertyAccessExpression(tested) &&
                    tested.name.text === "ok"
                ) {
                    const response = unwrapExpression(tested.expression);
                    const symbol = ts.isIdentifier(response)
                        ? this.checker.getSymbolAtLocation(response)
                        : undefined;
                    packagedFetchMiss =
                        symbol !== undefined &&
                        packagedFetchResponses.has(symbol);
                }
            }
            if (
                packagedFetchMiss &&
                ts.isIfStatement(current) &&
                !current.elseStatement &&
                ts.isReturnStatement(current.thenStatement) &&
                current.thenStatement.expression?.kind ===
                    ts.SyntaxKind.NullKeyword
            ) {
                continue;
            }
            if (firstReturn([current])) return undefined;
            statements.push(current);
        }
        return {
            statements,
            returnExpression: constructed,
        };
    }

    /**
     * A fetched ImageBitmap helper has the same browser-only nullable fallback
     * shape as the retained-canvas factory above. Native atlas packaging closes
     * over every referenced PNG, so only the successful createImageBitmap arm is
     * reachable and the fetch ceremony itself emits no native statements.
     */
    private packagedImageBitmapSuccessPath(declaration: SupportedFunction):
        | {
              statements: readonly ts.Statement[];
              returnExpression: ts.Expression;
          }
        | undefined {
        if (!ts.isFunctionDeclaration(declaration)) {
            return undefined;
        }
        const shape = nullFallbackTryShape(declaration);
        if (!shape) return undefined;
        let expression = shape.returned;
        while (ts.isAwaitExpression(expression))
            expression = expression.expression;
        const isLibraryCall = (node: ts.Node, name: string): boolean =>
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === name &&
            isDefaultLibraryIdentifier(this.checker, node.expression);
        if (!isLibraryCall(expression, "createImageBitmap")) {
            return undefined;
        }
        // The bytes the bitmap decodes come from the library's own `fetch`,
        // reached somewhere in the guarded body.
        if (!shape.tryStatements.some(node => someAnalysisNode(node, candidate => isLibraryCall(candidate, "fetch")))) {
            return undefined;
        }
        return { statements: [], returnExpression: shape.returned };
    }

    private containsValueReturn(statements: readonly ts.Statement[]): boolean {
        return firstReturn(statements, { valued: true }) !== undefined;
    }

    private valueLambdaReturnType(
        context: UserFunctionContext,
        ir: UserFunctionIr,
        callNode: ts.Node,
    ): DataType {
        const signature = this.checker.getSignatureFromDeclaration(
            ir.declaration,
        );
        const type = signature
            ? context.dataTypes.fromTsType(
                  this.checker.getReturnTypeOfSignature(signature),
                  ir.declaration,
              )
            : undefined;
        if (!type) {
            context.fail(
                callNode,
                `Function '${ir.name}' uses early value returns but its return type is outside the native data model.`,
            );
        }
        return type.kind === "struct"
            ? context.dataTypes.markStoredObjectReferences(type)
            : context.dataTypes.ownReturnedArray(type);
    }

    /**
     * Validates early returns in an inlined body: bare returns are allowed
     * outside loops and switches (they lower to a breakable wrapper).
     */
    private classifyEarlyReturns(
        statements: readonly ts.Statement[],
        fail: Fail,
    ): "none" | "wrapper" | "native" {
        let found = false;
        let needsNative = false;
        forEachReturn(statements, (node, insideBreakable) => {
            if (node.expression) {
                fail(node, "Internal error: value return was not assigned to a native lambda.");
            }
            if (insideBreakable) needsNative = true;
            found = true;
        });
        return needsNative ? "native" : found ? "wrapper" : "none";
    }

    /**
     * The call's arguments against the declaration's parameters. Extra
     * arguments beyond the declared list are accepted: JavaScript ignores
     * them, and the per-index loop below has no parameter to check them
     * against, so both callers hand them through unchecked.
     */
    private validateCall(
        context: Pick<UserFunctionContext, "dataTypes">,
        call: ts.CallExpression,
        ir: UserFunctionIr,
        fail: Fail,
    ): void {
        const rest = restParameterIndex(ir.declaration);
        const minimum = ir.parameters.filter(
            ({ declaration }) =>
                !declaration.initializer && !declaration.questionToken && !declaration.dotDotDotToken,
        ).length;
        if (call.arguments.length < minimum && !call.arguments.some(ts.isSpreadElement)) {
            fail(
                call,
                `Function '${ir.name}' expects ${minimum}-${ir.parameters.length} arguments, received ${call.arguments.length}.`,
            );
        }
        // A generic declaration's parameters are typed in its own
        // parameters; the resolved signature spells what this call made
        // of them.
        const resolved = ir.declaration.typeParameters?.length
            ? this.checker.getResolvedSignature(call)
            : undefined;
        call.arguments.forEach((argument, index) => {
            const parameter = ir.parameters[index];
            if (!parameter || ts.isSpreadElement(argument) || (rest !== undefined && index >= rest)) {
                return;
            }
            const resolvedParameter = resolved?.getParameters()[index];
            const parameterType = resolvedParameter
                ? this.checker.getTypeOfSymbol(resolvedParameter)
                : parameter.type;
            const argumentType = this.checker.getTypeAtLocation(argument);
            if (
                !this.checker.isTypeAssignableTo(argumentType, parameterType) &&
                !(parameter.declaration.initializer && (argumentType.isUnion() ? argumentType.types : [argumentType]).every(member =>
                    (member.flags & ts.TypeFlags.Undefined) !== 0 || this.checker.isTypeAssignableTo(member, parameterType))) &&
                // Inside a generic body an argument is typed by a type
                // parameter the checker cannot relate to the callee's
                // concrete type; the data model, which substitutes what
                // the enclosing call bound, decides instead. Asked only
                // then: mapping types allocates struct names, and a probe
                // that declines here must leave none behind.
                !(mentionsTypeParameter(this.checker, argumentType) &&
                    this.dataModelAgrees(context, argumentType, parameterType, argument))
            ) {
                fail(
                    argument,
                    `Argument ${index + 1} of '${ir.name}' is ${this.checker.typeToString(argumentType)}, not ${this.checker.typeToString(parameterType)}.`,
                );
            }
        });
    }

    /** Whether two checker types map to one data type under the active substitutions. */
    private dataModelAgrees(
        context: Pick<UserFunctionContext, "dataTypes">,
        argumentType: ts.Type,
        parameterType: ts.Type,
        node: ts.Node,
    ): boolean {
        const argument = context.dataTypes.fromTsType(argumentType, node);
        const parameter = context.dataTypes.fromTsType(parameterType, node);
        return argument !== undefined && parameter !== undefined && dataTypesEqual(argument, parameter);
    }

    /**
     * The call's arguments as values, with a rest parameter's share packed
     * into one: the compile-time tuple of the trailing arguments, a spread
     * tuple expanded into it, or a spread native array passed through when
     * it is the rest's only source.
     */
    private argumentValues(
        context: UserFunctionContext,
        call: ts.CallExpression,
        ir: UserFunctionIr,
    ): Value[] {
        const rest = restParameterIndex(ir.declaration);
        const pinArguments = requiresDefaultParameterBinding(this.checker, ir.declaration, call);
        const values: Value[] = [];
        const expanded: Value[] = [];
        call.arguments.forEach((argument, index) => {
            const sink = rest !== undefined && index >= rest ? expanded : values;
            if (ts.isSpreadElement(argument)) {
                const spread = this.argumentValue(context, argument.expression);
                if (spread.kind === "tuple") {
                    sink.push(...(spread.tupleElements ?? []));
                    return;
                }
                if (spread.kind === "data" && spread.dataType?.kind === "tuple") {
                    // A numeric tuple's lanes are its arguments, read off
                    // one bound evaluation of the tuple.
                    const arity = spread.dataType.arity;
                    const bound = context.bindDataTuple(spread, arity, "spread_tuple");
                    sink.push(
                        ...tupleComponents(bound, arity, "double").map(
                            (cpp): Value => ({ kind: "number", cpp, dataType: { kind: "number" } }),
                        ),
                    );
                    return;
                }
                if (
                    rest !== undefined &&
                    index === rest &&
                    index === call.arguments.length - 1 &&
                    expanded.length === 0 &&
                    spread.kind === "data" &&
                    (spread.dataType?.kind === "vector" || spread.dataType?.kind === "span")
                ) {
                    values.push(spread);
                    return;
                }
                context.fail(
                    argument,
                    "A spread argument expands a compile-time tuple, or passes one native array as the whole rest parameter.",
                );
            }
            const value = this.argumentValue(context, argument);
            if (pinArguments && value.kind === "data" && value.dataType && value.cpp) {
                const name = context.allocateTemporaryCppName("call_argument");
                context.emit(`const auto ${name} = ${value.cpp};`);
                sink.push(withNativeMetadata(context.dataValue(name, value.dataType), value));
            } else {
                sink.push(pinArguments && value.kind !== "callback"
                    ? context.pinValueToTemporary(value, "call_argument", argument) : value);
            }
        });
        if (rest !== undefined && values.length === rest) {
            values.push({ kind: "tuple", cpp: "", tupleElements: expanded });
        }
        return values;
    }

    private parameterValue(context: UserFunctionContext, parameter: UserFunctionParameterIr, argument: Value | undefined, source: ts.Expression | undefined): Value {
        const initializer = parameter.declaration.initializer;
        if (!initializer) return argument ?? (parameter.declaration.questionToken
            ? { kind: "json-null", cpp: "std::nullopt" }
            : context.fail(parameter.declaration, `Parameter '${parameter.name.getText()}' requires an argument.`));
        if (!argument || argument.kind === "void" || (argument.kind === "json-null" && argument.cpp === "std::nullopt")) {
            if (argument?.kind === "void") context.emitDiscardedValue(argument);
            return context.compileValue(initializer);
        }
        const storage = argument.dataType;
        if (!storage) return argument;
        const sourceType = source ? this.checker.getTypeAtLocation(source) : parameter.type;
        const alternatives = sourceType.isUnion() ? sourceType.types : [sourceType];
        const mayBeUndefined = alternatives.some(type => (type.flags & ts.TypeFlags.Undefined) !== 0);
        const referenceAbsence = (mayBeUndefined || argument.preserveUncheckedLookup) &&
            (storage.kind === "function" || (storage.kind === "struct" && context.dataTypes.isReferenceStruct(storage.name)));
        if (storage.kind !== "optional" && !referenceAbsence) return argument;
        if (alternatives.some(type => (type.flags & ts.TypeFlags.Null) !== 0)) {
            if (!mayBeUndefined) return argument;
            return context.fail(source ?? parameter.declaration, "A default parameter requires a distinct undefined state when its argument can also be null.");
        }
        const type = storage.kind === "optional" ? storage.inner : storage;
        const input = context.allocateTemporaryCppName("default_argument");
        context.emit(`const auto& ${input} = ${argument.cpp};`);
        let fallback = "";
        const lines = context.captureEmittedLines(() => {
            context.enterRuntimeControlFlow();
            try {
                fallback = context.compileForDataSink(initializer, type);
            } finally {
                context.leaveRuntimeControlFlow();
            }
        });
        const result = context.allocateTemporaryCppName("default_value");
        const cppType = context.dataTypes.cppType(type);
        const present = storage.kind === "optional" ? `${input}.has_value()` : `static_cast<bool>(${input})`;
        const selected = storage.kind === "optional" ? `*${input}` : input;
        context.emit(`const ${cppType} ${result} = [&]() -> ${cppType} {\n` +
            `    if (${present}) return ${selected};\n` +
            lines.map(line => `    ${line}\n`).join("") + `    return ${fallback};\n}();`);
        return context.dataValue(result, type);
    }

    /** Runs `work` with the type parameters a generic call binds in force. */
    private withCallTypeArguments<T>(
        context: UserFunctionContext,
        call: ts.CallExpression,
        declaration: SupportedFunction,
        work: () => T,
    ): T {
        const substitution = callTypeArguments(
            this.checker,
            call,
            declaration,
            (node, message) => context.fail(node, message),
        );
        return context.dataTypes.withTypeArguments(substitution, work);
    }
}
