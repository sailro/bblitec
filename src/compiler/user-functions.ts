import ts from "typescript";
import { sanitizeCppIdentifier } from "../cpp-literals.js";
import {
    passesByReference,
    type DataType,
    type DataTypeRegistry,
} from "./data-types.js";
import type { Value } from "./types.js";
import {
    readOnlyDataMethods,
    storingDataMethods,
} from "./data-methods.js";

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

/** Strip the type-only and grouping wrappers around an expression. */
export function unwrapExpression(expression: ts.Expression): ts.Expression {
    let current = expression;
    while (
        ts.isParenthesizedExpression(current) ||
        ts.isAsExpression(current) ||
        ts.isTypeAssertionExpression(current) ||
        ts.isNonNullExpression(current) ||
        ts.isSatisfiesExpression(current)
    ) {
        current = current.expression;
    }
    return current;
}

/**
 * The identifier a property/element-access chain is rooted at, if any.
 *
 * The unwrap has to run BETWEEN chain steps, not only once: `(a as X).b[i]`
 * roots at `a`. Every mutation walk in this compiler depends on that, so the
 * loop lives here once; `Compiler.inferredObjectIsMutated` passes its own
 * `unwrap`, which additionally records the `await` expressions it stripped.
 */
export function rootIdentifier(
    expression: ts.Expression,
    unwrap: (expression: ts.Expression) => ts.Expression =
        unwrapExpression,
): ts.Identifier | undefined {
    let current = unwrap(expression);
    while (
        ts.isPropertyAccessExpression(current) ||
        ts.isElementAccessExpression(current)
    ) {
        current = unwrap(current.expression);
    }
    return ts.isIdentifier(current) ? current : undefined;
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
    if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
        return isTarget(node.left);
    }
    if (
        (ts.isPrefixUnaryExpression(node) ||
            ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
            node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
        return isTarget(node.operand);
    }
    return (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        mutatesVia(node.expression.name.text) &&
        isTarget(node.expression.expression)
    );
}

/** `writesThroughRoot`, for a caller outside this module. */
export const writesThroughTrackedRoot = writesThroughRoot;

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

/**
 * The alias-set + fixed-point skeleton every inferred-mutation walk shares.
 *
 * Seeds the tracked set with the declared identifier's symbol, then rewalks
 * the whole source file until a pass adds no alias: a variable declaration
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
        readonly mutates: (
            node: ts.Node,
            scan: AliasedMutationScan,
        ) => boolean;
    },
): boolean {
    const initial = valueSymbol(identifier);
    if (!initial) return false;
    const aliases = new Set<ts.Symbol>([initial]);
    const source = identifier.getSourceFile();
    let changed = true;
    const scan: AliasedMutationScan = {
        namesAlias: (node) =>
            ts.isIdentifier(node) && aliases.has(valueSymbol(node)!),
        containsAlias: (node) => {
            let found = false;
            const visit = (candidate: ts.Node): void => {
                if (found) return;
                if (scan.namesAlias(candidate)) {
                    found = true;
                    return;
                }
                ts.forEachChild(candidate, visit);
            };
            visit(node);
            return found;
        },
        addAlias: (symbol) => {
            if (symbol && !aliases.has(symbol)) {
                aliases.add(symbol);
                changed = true;
            }
        },
    };
    while (changed) {
        changed = false;
        let mutated = false;
        const visit = (node: ts.Node): void => {
            if (mutated) return;
            if (walk.mutates(node, scan)) {
                mutated = true;
                return;
            }
            if (
                ts.isVariableDeclaration(node) &&
                ts.isIdentifier(node.name) &&
                node.initializer &&
                walk.aliasingInitializer(node.initializer, scan)
            ) {
                scan.addAlias(valueSymbol(node.name));
            }
            ts.forEachChild(node, visit);
        };
        ts.forEachChild(source, visit);
        if (mutated) return true;
    }
    return false;
}

/** Conservatively determines whether a function leaves a parameter unchanged. */
export function parameterIsReadOnly(
    checker: ts.TypeChecker,
    declaration: SupportedFunction,
    parameter: ts.Identifier,
    active = new Set<ts.Symbol>(),
): boolean {
    const symbol = checker.getSymbolAtLocation(parameter);
    if (!symbol || !declaration.body) return false;
    if (active.has(symbol)) return true;
    active.add(symbol);
    const aliases = new Set<ts.Symbol>([symbol]);
    const namesParameter = (node: ts.Node): boolean =>
        ts.isIdentifier(node) &&
        aliases.has(checker.getSymbolAtLocation(node)!);
    const containsParameter = (node: ts.Node): boolean => {
        let found = false;
        const visit = (candidate: ts.Node): void => {
            if (found) return;
            if (namesParameter(candidate)) {
                found = true;
                return;
            }
            ts.forEachChild(candidate, visit);
        };
        visit(node);
        return found;
    };
    const rootNamesParameter = (
        expression: ts.Expression,
    ): boolean => {
        const root = rootIdentifier(expression);
        return root !== undefined && namesParameter(root);
    };
    let readOnly = true;
    const visit = (node: ts.Node): void => {
        if (!readOnly) return;
        if (writesThroughRoot(node, rootNamesParameter)) {
            readOnly = false;
            return;
        }
        if (ts.isCallExpression(node)) {
            for (const [index, argument] of node.arguments.entries()) {
                if (!containsParameter(argument)) continue;
                if (
                    ts.isPropertyAccessExpression(
                        node.expression,
                    ) &&
                    !rootNamesParameter(
                        node.expression.expression,
                    ) &&
                    storingDataMethods.has(
                        node.expression.name.text,
                    )
                ) {
                    continue;
                }
                if (!callArgumentIsReadOnly(checker, node, index, active)) {
                    readOnly = false;
                    return;
                }
            }
        }
        if (
            ts.isVariableDeclaration(node) &&
            node.initializer &&
            ts.isIdentifier(node.name) &&
            rootNamesParameter(node.initializer)
        ) {
            const alias = checker.getSymbolAtLocation(
                node.name,
            );
            if (alias) aliases.add(alias);
            return;
        }
        if (
            ts.isVariableDeclaration(node) &&
            node.initializer &&
            containsParameter(node.initializer) &&
            (checker.getTypeAtLocation(node.initializer)
                .flags &
                ts.TypeFlags.Object) !==
                0
        ) {
            // A composite wrapper can retain the parameter and expose a
            // second mutation path that this local alias set cannot follow.
            readOnly = false;
            return;
        }
        ts.forEachChild(node, visit);
    };
    visit(declaration.body);
    active.delete(symbol);
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
    return final && ts.isReturnStatement(final)
        ? final.expression
        : undefined;
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
    active = new Set<SupportedFunction>(),
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
        const declarations = checker.getSymbolAtLocation(identifier)
            ?.declarations;
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
    let reads = false;
    const visit = (node: ts.Node): void => {
        if (reads) return;
        if (ts.isPropertyAccessExpression(node)) {
            // Only the object side is a value read; the member name is not.
            visit(node.expression);
            return;
        }
        if (ts.isIdentifier(node)) {
            if (namesShared(node)) reads = true;
            return;
        }
        ts.forEachChild(node, visit);
    };
    visit(expression);
    return reads;
}

/** Whether a function body writes through a root `isShared` recognizes. */
function writesSharedBinding(
    checker: ts.TypeChecker,
    body: ts.Node,
    isShared: (expression: ts.Expression) => boolean,
    active: Set<SupportedFunction>,
): boolean {
    let writes = false;
    const visit = (node: ts.Node): void => {
        if (writes) return;
        if (writesThroughRoot(node, isShared)) {
            writes = true;
            return;
        }
        if (ts.isCallExpression(node)) {
            const called = checker.getResolvedSignature(node)
                ?.declaration;
            if (
                isSupportedFunction(called) &&
                returnedValueCanMove(checker, called, active)
            ) {
                writes = true;
                return;
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(body);
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
        ts.isShorthandPropertyAssignment(
            identifier.parent,
        ) && identifier.parent.name === identifier
            ? checker.getShorthandAssignmentValueSymbol(
                  identifier.parent,
              )
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
        if (
            ts.isFunctionDeclaration(candidate) &&
            candidate.body
        ) {
            declaration = candidate;
            break;
        }
        if (
            ts.isVariableDeclaration(candidate) &&
            candidate.initializer &&
            (ts.isArrowFunction(candidate.initializer) ||
                ts.isFunctionExpression(
                    candidate.initializer,
                ))
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
    if (declaration.typeParameters?.length) {
        fail(
            declaration.typeParameters[0]!,
            "Generic user functions are not supported.",
        );
    }
    for (const parameter of declaration.parameters) {
        if (
            (!ts.isIdentifier(parameter.name) &&
                !ts.isArrayBindingPattern(parameter.name)) ||
            parameter.dotDotDotToken
        ) {
            fail(
                parameter,
                "User-function parameters must be non-rest identifiers or array binding patterns.",
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
        return resolveFunctionDeclaration(
            checker,
            identifier,
            () => {
                throw unsupported;
            },
        );
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
    const visited = [new Set<ts.Node>(), new Set<ts.Node>()] as const;
    let escapes = false;
    const scan = (root: ts.Node, foreign: boolean): void => {
        const seen = visited[foreign ? 1 : 0];
        if (escapes || seen.has(root)) return;
        seen.add(root);
        const visit = (node: ts.Node, nested: boolean): void => {
            if (escapes) return;
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
                if (namesOwnDeclaration || directCallee) return;
                const resolved = tryResolveFunctionDeclaration(
                    checker,
                    node,
                );
                if (resolved && members.has(resolved)) escapes = true;
                return;
            }
            let childNested = nested;
            if (node !== root && ts.isFunctionLike(node)) {
                childNested =
                    nested ||
                    !(isSupportedFunction(node) && members.has(node));
            }
            if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
                const called =
                    checker.getResolvedSignature(node)?.declaration;
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
            ts.forEachChild(node, (child) => visit(child, childNested));
        };
        visit(root, foreign);
    };
    for (const region of regions) {
        scan(region, false);
        if (escapes) break;
    }
    return escapes;
}

export interface UserFunctionParameterIr {
    declaration: ts.ParameterDeclaration;
    name: ts.BindingName;
    type: ts.Type;
}

export interface UserFunctionIr {
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

export interface UserFunctionContext {
    readonly dataTypes: DataTypeRegistry;
    compileValue(expression: ts.Expression): Value;
    lookupIdentifierValue(
        identifier: ts.Identifier,
    ): Value | undefined;
    compileCondition(expression: ts.Expression): string;
    isBrowserOnlyExpression(expression: ts.Expression): boolean;
    compileForDataSink(
        expression: ts.Expression,
        dataType: DataType,
    ): string;
    dataValue(cpp: string, dataType: DataType): Value;
    emitStatement(statement: ts.Statement): void;
    bindLocalValue(
        identifier: ts.Identifier,
        value: Value,
    ): void;
    bindCompileTimeValue(
        identifier: ts.Identifier,
        value: Value,
    ): void;
    bindParameterValue(
        identifier: ts.Identifier,
        value: Value,
    ): void;
    materializeEscapingValue(
        value: Value,
        label: string,
    ): Value;
    pinValueToTemporary(
        value: Value,
        label: string,
    ): Value;
    pushScope(cppPrefix: string): void;
    popScope(): void;
    allocateUserFunctionPrefix(): string;
    reachJsData(): void;
    captureEmittedLines(emitBody: () => void): string[];
    emitNativeCallbackStorage(
        cppName: string,
        signature: string,
        escapesEmittingScope: boolean,
    ): void;
    beginInlineFrame(wrapped: boolean): void;
    endInlineFrame(): void;
    beginNativeFunctionBody(returnType: DataType | undefined): void;
    endNativeFunctionBody(): void;
    storedDataFunctionCapture(lines: readonly string[]): string;
    emit(line: string): void;
    increaseIndent(): void;
    decreaseIndent(): void;
    fail(node: ts.Node, message: string): never;
}

export class UserFunctionLowerer {
    private readonly directCallCache = new Map<
        SupportedFunction,
        ReadonlySet<SupportedFunction>
    >();
    private readonly recursiveGroupCache = new Map<
        SupportedFunction,
        readonly SupportedFunction[] | null
    >();
    private readonly groupEscapeCache = new Map<
        SupportedFunction,
        boolean
    >();

    private readonly cache = new Map<
        SupportedFunction,
        UserFunctionIr
    >();
    private readonly active =
        new Set<SupportedFunction>();

    public constructor(
        private readonly checker: ts.TypeChecker,
    ) {}

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
        if (value.kind === "tuple" && value.tupleElements) {
            parameter.name.elements.forEach((element, index) => {
                if (ts.isOmittedExpression(element)) return;
                const lane = value.tupleElements![index];
                if (!lane) {
                    context.fail(
                        element,
                        "Array-bound callback parameter reads beyond the supplied tuple.",
                    );
                }
                context.bindParameterValue(element.name as ts.Identifier, lane);
            });
            return;
        }
        if (
            value.kind !== "data" ||
            value.dataType?.kind !== "tuple" ||
            parameter.name.elements.length > value.dataType.arity
        ) {
            context.fail(
                parameter.name,
                "Array-bound callback parameters require a numeric tuple value.",
            );
        }
        parameter.name.elements.forEach((element, index) => {
            if (ts.isOmittedExpression(element)) return;
            context.bindParameterValue(
                element.name as ts.Identifier,
                {
                    kind: "number",
                    cpp: `(${value.cpp})[${index}]`,
                    dataType: { kind: "number" },
                },
            );
        });
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
        inBodyScope: <T>(work: () => T) => T = (work) =>
            work(),
    ): Value | undefined {
        const ir = this.resolve(
            identifier,
            (node, message) =>
                context.fail(node, message),
        );
        if (!ir) {
            return undefined;
        }
        this.validateCall(
            call,
            ir,
            (node, message) =>
                context.fail(node, message),
            true,
        );
        const argumentValues = call.arguments.map(
            (argument) =>
                this.argumentValue(context, argument),
        );
        const recursiveGroup = this.recursiveGroup(
            ir.declaration,
        );
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
            return this.lowerRecursiveGroup(
                context,
                ir,
                call,
                argumentValues,
                [ir.declaration],
            );
        }
        return inBodyScope(() =>
            this.lower(context, ir, argumentValues, call),
        );
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
            (this.checker.getSymbolAtLocation(unwrapped.expression)
                ?.declarations ?? [])
                .some((declaration) =>
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
        if (
            ts.isArrowFunction(argument) ||
            ts.isFunctionExpression(argument)
        ) {
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
        return context.compileValue(argument);
    }

    /**
     * Inlines a call whose target is a bound callback value (a function
     * literal passed as an argument to the enclosing user function).
     */
    public compileCallbackCall(
        context: UserFunctionContext,
        call: ts.CallExpression,
        declaration: SupportedFunction,
        inBodyScope: <T>(work: () => T) => T = (work) =>
            work(),
    ): Value {
        const ir = this.irFor(
            declaration,
            "callback",
            (node, message) =>
                context.fail(node, message),
        );
        this.validateCall(
            call,
            ir,
            (node, message) =>
                context.fail(node, message),
            true,
        );
        // As in `compile`: the arguments were written at the call site
        // and resolve in the scope there, so only the body runs in the
        // scope the callback closed over.
        const argumentValues = call.arguments.map(
            (argument) =>
                this.argumentValue(context, argument),
        );
        return inBodyScope(() =>
            this.lower(context, ir, argumentValues, call),
        );
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
    ): Value | undefined {
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
                return context.compileForDataSink(
                    call.arguments[index]!,
                    type,
                );
            });
            const cpp = `${bound.cpp}(${argumentsCpp.join(", ")})`;
            return bound.nativeCallbackReturnType
                ? context.dataValue(
                      cpp,
                      bound.nativeCallbackReturnType,
                  )
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
            const signature = this.checker.getSignatureFromDeclaration(
                declaration,
            );
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
                        call.arguments[index] ??
                        parameter.initializer;
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
                    return context.compileForDataSink(
                        argument,
                        type,
                    );
                },
            );
            const cpp = `${bound.cpp}(${argumentsCpp.join(", ")})`;
            const returnTsType =
                this.checker.getReturnTypeOfSignature(signature);
            if ((returnTsType.flags & ts.TypeFlags.Void) !== 0) {
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
        if (call.arguments.length > declaration.parameters.length) {
            context.fail(call, "Recursive function received too many arguments.");
        }
        const captured = bound.nativeCallbackStaticArguments;
        if (!captured) {
            context.fail(call, "Recursive function is missing its captured arguments.");
        }
        const runtimeArguments: string[] = [];
        declaration.parameters.forEach((parameter, index) => {
            const argument = call.arguments[index] ?? parameter.initializer;
            if (!argument) {
                context.fail(
                    call,
                    `Recursive function requires argument ${index + 1}.`,
                );
            }
            const type = parameterTypes[index];
            if (type) {
                runtimeArguments.push(
                    context.compileForDataSink(argument, type),
                );
                return;
            }
            const value = this.argumentValue(context, argument);
            const existing = captured[index];
            if (existing && !this.sameCapturedValue(existing, value)) {
                context.fail(
                    argument,
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
        const reachable = new Set<SupportedFunction>();
        const collect = (declaration: SupportedFunction): void => {
            if (reachable.has(declaration)) return;
            reachable.add(declaration);
            for (const called of direct(declaration)) collect(called);
        };
        collect(root);
        const callers = new Map<
            SupportedFunction,
            Set<SupportedFunction>
        >();
        for (const declaration of reachable) {
            for (const called of direct(declaration)) {
                if (!reachable.has(called)) continue;
                const entries = callers.get(called) ?? new Set();
                entries.add(declaration);
                callers.set(called, entries);
            }
        }
        const reachesRoot = new Set<SupportedFunction>([
            root,
        ]);
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
        const callees = new Set<SupportedFunction>();
        const body = declaration.body;
        const visit = (node: ts.Node): void => {
            if (node !== body && ts.isFunctionLike(node)) return;
            if (
                ts.isCallExpression(node) &&
                ts.isIdentifier(node.expression)
            ) {
                const called = tryResolveFunctionDeclaration(
                    this.checker,
                    node.expression,
                );
                if (called) callees.add(called);
                if (
                    node.expression.text === "setTimeout" &&
                    node.arguments[0] &&
                    ts.isIdentifier(node.arguments[0])
                ) {
                    const scheduled = tryResolveFunctionDeclaration(
                        this.checker,
                        node.arguments[0],
                    );
                    if (scheduled) callees.add(scheduled);
                }
            }
            ts.forEachChild(node, visit);
        };
        if (body) visit(body);
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
            new Set(declarations),
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
        call: ts.CallExpression,
        rootArguments: readonly Value[],
        declarations: readonly SupportedFunction[],
    ): Value {
        const entries = declarations.map((declaration) => {
            const ir = this.recursiveIrFor(
                declaration,
                this.declarationName(declaration),
                (node, message) => context.fail(node, message),
            );
            const signature = this.checker.getSignatureFromDeclaration(declaration);
            if (!signature) {
                context.fail(declaration, "Recursive function has no callable signature.");
            }
            const returnTsType = this.checker.getReturnTypeOfSignature(signature);
            const returnType =
                (returnTsType.flags & ts.TypeFlags.Void) !== 0
                    ? undefined
                    : context.dataTypes.fromTsType(returnTsType, declaration);
            if ((returnTsType.flags & ts.TypeFlags.Void) === 0 && !returnType) {
                context.fail(
                    declaration,
                    "Recursive function return type must be plain data or void.",
                );
            }
            const parameterTypes = ir.parameters.map(({ type, declaration: parameter }) => {
                const mapped = context.dataTypes.fromTsType(type, parameter);
                return mapped &&
                    mapped.kind !== "function" &&
                    !context.dataTypes.carriesHandle(mapped)
                    ? mapped
                    : undefined;
            });
            const parameterReadOnly = ir.parameters.map(
                ({ name: parameter }) =>
                    parameterIsReadOnly(
                        this.checker,
                        declaration,
                        parameter as ts.Identifier,
                    ),
            );
            const cppName =
                `bbl_recursive_${context.allocateUserFunctionPrefix()}` +
                sanitizeCppIdentifier(this.declarationName(declaration));
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
            };
        });
        const entryByDeclaration = new Map(
            entries.map((entry) => [entry.declaration, entry]),
        );
        const rootEntry = entryByDeclaration.get(root.declaration)!;
        root.parameters.forEach((parameter, index) => {
            const argument = rootArguments[index];
            if (argument?.kind === "record") {
                rootEntry.parameterTypes[index] = undefined;
                rootEntry.captured[index] = argument;
                return;
            }
            if (rootEntry.parameterTypes[index]) return;
            const value =
                argument ??
                (parameter.declaration.initializer
                    ? context.compileValue(parameter.declaration.initializer)
                    : context.fail(
                          parameter.declaration,
                          `Recursive function requires argument '${parameter.name.getText()}'.`,
                      ));
            rootEntry.captured[index] = value;
        });

        context.reachJsData();
        const escapes = this.groupStorageEscapes(declarations);
        for (const entry of entries) {
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
            context.emitNativeCallbackStorage(
                entry.cppName,
                `${returnCpp}(${parametersCpp.join(", ")})`,
                escapes,
            );
        }

        // These symbol bindings exist only while the specialized bodies are
        // generated. A later source call may observe different compile-time
        // class/resource arguments and receives its own local specialization.
        context.pushScope(context.allocateUserFunctionPrefix());
        try {
            for (const entry of entries) {
                const identifier = this.declarationIdentifier(entry.declaration);
                context.bindLocalValue(identifier, entry.value);
            }
            const pending = new Set(entries);
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
                entry.returnMetadata =
                    this.emitRecursiveFunctionBody(context, entry);
            }
        } finally {
            context.popScope();
        }
        const result = this.compileNativeCallbackCall(
            context,
            call,
            rootEntry.value,
        )!;
        return rootEntry.returnMetadata?.recordProperties
            ? {
                  ...result,
                  recordProperties:
                      rootEntry.returnMetadata.recordProperties,
              }
            : result;
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
            returnType: DataType | undefined;
            parameterTypes: readonly (DataType | undefined)[];
            parameterReadOnly: readonly boolean[];
            cppName: string;
            captured: readonly (Value | undefined)[];
        },
    ): Value | undefined {
        const returnCpp = entry.returnType
            ? context.dataTypes.cppType(entry.returnType)
            : "void";
        let returnMetadata: Value | undefined;
        context.pushScope(context.allocateUserFunctionPrefix());
        try {
            const parameterDeclarations: string[] = [];
            const parameterBindings: Array<{
                parameter: UserFunctionParameterIr;
                value: Value;
            }> = [];
            let runtimeIndex = 0;
            entry.ir.parameters.forEach((parameter, index) => {
                const type = entry.parameterTypes[index];
                if (!type) {
                    parameterBindings.push({
                        parameter,
                        value: entry.captured[index]!,
                    });
                    return;
                }
                const cppName = `bbl_recursive_arg_${runtimeIndex++}`;
                parameterDeclarations.push(
                    `${this.recursiveParameterCpp(context.dataTypes, type, entry.parameterReadOnly[index]!)} ${cppName}`,
                );
                parameterBindings.push({
                    parameter,
                    value: {
                        ...context.dataValue(cppName, type),
                        ...(entry.parameterReadOnly[index]
                            ? { readOnly: true as const }
                            : {}),
                    },
                });
            });
            context.emit(
                `${entry.cppName} = [&](${parameterDeclarations.join(", ")}) -> ${returnCpp} {`,
            );
            context.increaseIndent();
            context.beginNativeFunctionBody(entry.returnType);
            try {
                for (const { parameter, value } of parameterBindings) {
                    this.bindParameter(context, parameter, value);
                }
                const body = entry.declaration.body;
                if (!body) {
                    context.fail(entry.declaration, "Recursive function requires a body.");
                }
                if (ts.isBlock(body)) {
                    for (const statement of body.statements) {
                        if (
                            ts.isReturnStatement(statement) &&
                            statement.expression &&
                            ts.isIdentifier(statement.expression)
                        ) {
                            returnMetadata =
                                context.lookupIdentifierValue(
                                    statement.expression,
                                );
                        }
                        context.emitStatement(statement);
                    }
                } else {
                    if (!entry.returnType) {
                        context.fail(body, "A concise recursive function must return data.");
                    }
                    context.emit(
                        `return ${context.compileForDataSink(body, entry.returnType)};`,
                    );
                }
            } finally {
                context.endNativeFunctionBody();
                context.decreaseIndent();
            }
            context.emit("};");
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

    private declarationIdentifier(declaration: SupportedFunction): ts.Identifier {
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
    ): Value {
        const ir = ts.isIdentifier(declaration)
            ? this.resolve(
                  declaration,
                  (node, message) => context.fail(node, message),
              )
            : this.irFor(
                  declaration,
                  "callback",
                  (node, message) => context.fail(node, message),
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
        return this.lower(
            context,
            ir,
            arguments_.slice(0, ir.parameters.length),
            callNode,
        );
    }

    /** Materializes a read-only closure as a copyable native function value. */
    public compileStoredDataFunction(
        context: UserFunctionContext,
        expression: ts.Identifier | SupportedFunction,
        dataType: DataType & { kind: "function" },
    ): string {
        const unwrapped = ts.isFunctionDeclaration(expression) ||
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
        const ir = this.irFor(
            declaration,
            "stored callback",
            (node, message) => context.fail(node, message),
        );
        if (ir.parameters.length !== dataType.parameters.length) {
            context.fail(
                declaration,
                "Stored function declaration does not match its native data signature.",
            );
        }
        const prefix = context.allocateUserFunctionPrefix();
        const cppName = `${prefix}stored_callback`;
        const parameters = ir.parameters.map((parameter, index) => ({
            parameter,
            type: dataType.parameters[index]!,
            cppName: `${prefix}arg_${index}`,
        }));
        const returnCpp = dataType.result
            ? context.dataTypes.cppType(dataType.result)
            : "void";
        context.pushScope(prefix);
        context.beginNativeFunctionBody(dataType.result);
        let lines: string[] = [];
        try {
            lines = context.captureEmittedLines(() => {
                for (const { parameter, type, cppName: name } of parameters) {
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
                    this.bindParameter(context, parameter, value);
                }
                for (const statement of ir.statements) {
                    context.emitStatement(statement);
                }
                if (ir.returnExpression) {
                    if (!dataType.result) {
                        const discarded = context.compileValue(
                            ir.returnExpression,
                        );
                        if (
                            discarded.kind !== "engine" &&
                            discarded.cpp.length > 0
                        ) {
                            context.emit(
                                discarded.kind !== "void" ||
                                    discarded.requiresExplicitDiscard
                                    ? `static_cast<void>(${discarded.cpp});`
                                    : `${discarded.cpp};`,
                            );
                        }
                    } else {
                        context.emit(
                            `return ${context.compileForDataSink(ir.returnExpression, dataType.result)};`,
                        );
                    }
                }
            });
        } finally {
            context.endNativeFunctionBody();
            context.popScope();
        }
        const capture = context.storedDataFunctionCapture(lines);
        context.emit(
            `${context.dataTypes.cppType(dataType)} ${cppName} = ` +
                `${capture}(${parameters.map(({ type, cppName: name }) => `${context.dataTypes.cppType(type)} ${name}`).join(", ")}) mutable -> ${returnCpp} {`,
        );
        context.increaseIndent();
        for (const line of lines) context.emit(line);
        context.decreaseIndent();
        context.emit("};");
        return cppName;
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
            ? this.resolve(
                  declaration,
                  (node, message) => context.fail(node, message),
              )
            : this.irFor(
                  declaration,
                  "callback",
                  (node, message) => context.fail(node, message),
              );
        if (!ir?.returnExpression || ir.needsValueLambda) {
            context.fail(
                declaration,
                "Array predicates require a final return expression without early value returns.",
            );
        }
        if (this.active.has(ir.declaration)) {
            context.fail(callNode, "Recursive Array predicates are not supported.");
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
                this.bindParameter(context, parameter, value);
            });
            for (const statement of ir.statements) {
                context.emitStatement(statement);
            }
            return {
                kind: "boolean",
                cpp: context.compileCondition(ir.returnExpression),
                dataType: { kind: "boolean" },
            };
        } finally {
            context.popScope();
            this.active.delete(ir.declaration);
        }
    }

    public compileReference(
        context: UserFunctionContext,
        identifier: ts.Identifier,
    ): Value | undefined {
        const ir = this.resolve(
            identifier,
            (node, message) =>
                context.fail(node, message),
        );
        if (!ir) {
            return undefined;
        }
        if (
            ir.parameters.some(
                ({ declaration }) =>
                    !declaration.initializer,
            )
        ) {
            context.fail(
                identifier,
                `Callback '${ir.name}' requires arguments.`,
            );
        }
        return this.lower(
            context,
            ir,
            [],
            identifier,
        );
    }

    private lower(
        context: UserFunctionContext,
        ir: UserFunctionIr,
        arguments_: readonly Value[],
        callNode: ts.Node,
    ): Value {
        if (this.active.has(ir.declaration)) {
            context.fail(
                callNode,
                `Recursive call to '${ir.name}' is not supported.`,
            );
        }
        this.active.add(ir.declaration);
        context.pushScope(
            context.allocateUserFunctionPrefix(),
        );
        try {
            ir.parameters.forEach((parameter, index) => {
                const argument = arguments_[index];
                const value =
                    argument ??
                    (parameter.declaration.initializer
                        ? context.compileValue(
                              parameter.declaration
                                  .initializer,
                          )
                        : parameter.declaration.questionToken
                          ? { kind: "json-null" as const, cpp: "" }
                        : context.fail(
                              parameter.declaration,
                              `Optional parameter '${parameter.name.getText()}' requires a default value in reached user functions.`,
                          ));
                this.bindParameter(context, parameter, value);
            });
            if (ir.needsValueLambda) {
                const returnType = this.valueLambdaReturnType(
                    context,
                    ir,
                    callNode,
                );
                const result = `bbl_fn_${context.allocateUserFunctionPrefix()}result`;
                context.emit(
                    `[[maybe_unused]] const auto ${result} = [&]() -> ${context.dataTypes.cppType(returnType)} {`,
                );
                context.increaseIndent();
                context.beginNativeFunctionBody(returnType);
                try {
                    for (const statement of ir.statements) {
                        context.emitStatement(statement);
                    }
                    context.emit(
                        'throw std::runtime_error("Native value function fell through without returning.");',
                    );
                } finally {
                    context.endNativeFunctionBody();
                    context.decreaseIndent();
                }
                context.emit("}();");
                return context.dataValue(
                    result,
                    returnType,
                );
            }
            if (ir.needsWrapper) {
                context.emit("do {");
                context.increaseIndent();
            }
            context.beginInlineFrame(ir.needsWrapper);
            try {
                for (const statement of ir.statements) {
                    context.emitStatement(statement);
                }
            } finally {
                context.endInlineFrame();
            }
            if (ir.needsWrapper) {
                context.decreaseIndent();
                context.emit("} while (false);");
            }
            if (!ir.returnExpression) return { kind: "void", cpp: "" };
            const returned = context.compileValue(ir.returnExpression);
            const label = `return_${ir.name}`;
            return {
                // A body that wrote state outliving the frame returns an
                // expression OVER that state, so it is read here rather than
                // at the use site, where the next call would have moved it.
                ...(ir.returnNeedsSnapshot
                    ? context.pinValueToTemporary(returned, label)
                    : context.materializeEscapingValue(returned, label)),
                requiresExplicitDiscard: true,
            };
        } finally {
            context.popScope();
            this.active.delete(ir.declaration);
        }
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
        return this.irFor(
            declaration,
            identifier.text,
            fail,
        );
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
                    type: this.checker.getTypeAtLocation(
                        parameter,
                    ),
                };
            },
        );
        const body = declaration.body;
        if (!body) {
            fail(
                declaration,
                "Reached user functions require a body.",
            );
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
            finalStatement &&
            ts.isReturnStatement(finalStatement)
                ? finalStatement
                : undefined;
        const leadingStatements = finalReturn
            ? body.statements.slice(0, -1)
            : body.statements;
        const needsValueLambda =
            this.containsValueReturn(leadingStatements);
        const statements = needsValueLambda
            ? body.statements
            : leadingStatements;
        const earlyReturns = needsValueLambda
            ? "none"
            : this.classifyEarlyReturns(
                  statements,
                  fail,
              );
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
                      returnExpression:
                          finalReturn.expression,
                  }
                : {}),
        };
        this.cache.set(declaration, ir);
        return ir;
    }

    private retainedCanvasFactorySuccessPath(
        declaration: SupportedFunction,
    ):
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

        const statement = declaration.body.statements[0];
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
            catchReturn.expression?.kind !==
                ts.SyntaxKind.NullKeyword
        ) {
            return undefined;
        }
        const successStatements = statement.tryBlock.statements;
        const final = successStatements.at(-1);
        if (
            !final ||
            !ts.isReturnStatement(final) ||
            !final.expression ||
            !ts.isNewExpression(final.expression)
        ) {
            return undefined;
        }
        const constructed = final.expression;
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
        const packagedFetchResponses = new Set<ts.Symbol>();
        for (const current of successStatements.slice(0, -1)) {
            if (ts.isVariableStatement(current)) {
                for (const declaration of current.declarationList.declarations) {
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
            let hasReturn = false;
            const visit = (node: ts.Node): void => {
                if (ts.isFunctionLike(node)) return;
                if (ts.isReturnStatement(node)) {
                    hasReturn = true;
                    return;
                }
                ts.forEachChild(node, visit);
            };
            visit(current);
            if (hasReturn) return undefined;
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
    private packagedImageBitmapSuccessPath(
        declaration: SupportedFunction,
    ):
        | {
              statements: readonly ts.Statement[];
              returnExpression: ts.Expression;
          }
        | undefined {
        if (
            !ts.isFunctionDeclaration(declaration) ||
            !declaration.body ||
            declaration.body.statements.length !== 1
        ) {
            return undefined;
        }
        const statement = declaration.body.statements[0];
        if (
            !statement ||
            !ts.isTryStatement(statement) ||
            statement.finallyBlock ||
            !statement.catchClause
        ) {
            return undefined;
        }
        const catchReturn = statement.catchClause.block.statements[0];
        if (
            statement.catchClause.block.statements.length !== 1 ||
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
        let expression = returned.expression;
        while (ts.isAwaitExpression(expression)) expression = expression.expression;
        if (
            !ts.isCallExpression(expression) ||
            !ts.isIdentifier(expression.expression) ||
            expression.expression.text !== "createImageBitmap"
        ) {
            return undefined;
        }
        if (!statement.tryBlock.getText().includes("fetch(")) return undefined;
        return { statements: [], returnExpression: returned.expression };
    }

    private containsValueReturn(
        statements: readonly ts.Statement[],
    ): boolean {
        let found = false;
        const visit = (node: ts.Node): void => {
            if (found || ts.isFunctionLike(node)) return;
            if (ts.isReturnStatement(node) && node.expression) {
                found = true;
                return;
            }
            ts.forEachChild(node, visit);
        };
        for (const statement of statements) visit(statement);
        return found;
    }

    private valueLambdaReturnType(
        context: UserFunctionContext,
        ir: UserFunctionIr,
        callNode: ts.Node,
    ): DataType {
        const signature =
            this.checker.getSignatureFromDeclaration(
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
            : type;
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
        const visit = (
            node: ts.Node,
            insideBreakable: boolean,
        ): void => {
            if (ts.isFunctionLike(node)) {
                return;
            }
            if (ts.isReturnStatement(node)) {
                if (node.expression) {
                    fail(
                        node,
                        "Internal error: value return was not assigned to a native lambda.",
                    );
                }
                if (insideBreakable) {
                    needsNative = true;
                }
                found = true;
                return;
            }
            const breakable =
                insideBreakable ||
                ts.isIterationStatement(node, false) ||
                ts.isSwitchStatement(node);
            ts.forEachChild(node, (child) =>
                visit(child, breakable),
            );
        };
        for (const statement of statements) {
            visit(statement, false);
        }
        return needsNative
            ? "native"
            : found
              ? "wrapper"
              : "none";
    }

    private validateCall(
        call: ts.CallExpression,
        ir: UserFunctionIr,
        fail: Fail,
        allowExtraArguments = false,
    ): void {
        if (call.arguments.some(ts.isSpreadElement)) {
            fail(
                call,
                "Spread arguments are not supported for user functions.",
            );
        }
        const minimum = ir.parameters.filter(
            ({ declaration }) =>
                !declaration.initializer &&
                !declaration.questionToken,
        ).length;
        if (
            call.arguments.length < minimum ||
            (!allowExtraArguments &&
                call.arguments.length >
                    ir.parameters.length)
        ) {
            fail(
                call,
                `Function '${ir.name}' expects ${minimum}-${ir.parameters.length} arguments, received ${call.arguments.length}.`,
            );
        }
        call.arguments.forEach((argument, index) => {
            const parameter = ir.parameters[index];
            if (!parameter) {
                return;
            }
            const argumentType =
                this.checker.getTypeAtLocation(argument);
            if (
                !this.checker.isTypeAssignableTo(
                    argumentType,
                    parameter.type,
                )
            ) {
                fail(
                    argument,
                    `Argument ${index + 1} of '${ir.name}' is ${this.checker.typeToString(argumentType)}, not ${this.checker.typeToString(parameter.type)}.`,
                );
            }
        });
    }

}
