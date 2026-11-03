import ts from "typescript";
import { forEachAnalysisNode } from "./analysis-walk.js";
import { CompileError } from "./compile-error.js";
import { forEachReturn } from "./loop-control.js";
import type { LoweringServices } from "./lowering-services.js";
import {
    declaredInDefaultLibrary,
    resolvedSymbol,
    nullishLiteral,
    parameterInput,
    libraryName,
    calledDeclaration,
    calledFunction,
    namedMember,
    libraryStaticMember,
} from "./symbols.js";
import {
    isObjectIdentityFunction,
    objectIdentityCallArgument,
} from "./static-evaluator.js";
import { readOnlyDataMethods } from "./receiver-methods.js";
import { callWritesReceiver } from "./parameter-effects.js";
import {
    declarationNamed,
    outermostWrapper,
    referenceBases,
    regularExpressionParts,
    unwrapExpression,
    writeSites,
    referenceSite,
    accessKey,
    keyIndex,
    objectLiteralMembers,
    testsTruthinessOnly,
    functionOfDeclaration,
    isSupportedFunction,
    type SupportedFunction,
    variableKind,
    valueConsumer,
    ANY_KEY,
} from "./syntax.js";
import { pathStartsWith, type KeyPath } from "./projections.js";
import {
    typeCanCarryReference,
    unionMembers,
    valueKindOf,
} from "./type-facts.js";
import { bindingRebinds, fileRebinds } from "./binding-rebinds.js";
import { literalHeldValuesAt } from "./kept-values.js";
import { aliasSites, type AliasSite } from "./user-functions.js";
import { browserDeploymentValue } from "./browser-erasure.js";

export type StringDomainContext = Pick<
    LoweringServices,
    | "checker"
    | "sourceFiles"
    | "compileStringLiteral"
    | "probeEmission"
    | "libraryGlobal"
    | "propertyName"
    | "fail"
    | "unwrap"
    | "options"
>;

/** What a consumer adds to the closed string domain. */
export interface StringDomainUse {
    /** Names the consumer in budget refusals ("Packaged URL"). */
    readonly label: string;
    /** The strings a concatenation with unknown parts (undefined) can build, when the consumer bounds them. */
    readonly fragments?: (
        parts: readonly (string | undefined)[],
    ) => readonly string[] | undefined;
}

interface Origin {
    expression: ts.Expression;
    projection: KeyPath;
    environment: Environment;
}
type Environment = ReadonlyMap<ts.Symbol, Origin>;
type Domain = readonly string[] | undefined;
const candidateLimit = 256;
/**
 * The domain of a value no string reaches: a nullish operand `??` replaces,
 * or a branch its own test rules out. Unions skip it.
 */
const nothing: readonly string[] = Object.freeze([]);

/**
 * A read the analysis gave up on: more candidates than it enumerates, or more
 * reads than it spends. Combinators hold it back while another operand can
 * still leave their string unknown, which decides the result without it; the
 * query refuses only a give-up that decides its answer.
 */
class UnboundedDomain extends Error {}

/** A string-building operand as read, its give-up held for the combinator. */
type Operand = Domain | UnboundedDomain;

/**
 * An array method call that stores no element the array did not hold: one
 * that only removes (`pop()`, `shift()`, a `splice` inserting none) or
 * only reorders (`sort`, `reverse`, `copyWithin`).
 */
function storesNoNewElement(
    checker: ts.TypeChecker,
    method: { readonly name: string; readonly expression: ts.Expression },
    call: ts.CallExpression,
): boolean {
    const receiver = checker.getTypeAtLocation(method.expression);
    return (
        (checker.isArrayType(receiver) || checker.isTupleType(receiver)) &&
        !call.arguments.some(ts.isSpreadElement) &&
        (((method.name === "pop" || method.name === "shift") &&
            call.arguments.length === 0) ||
            (method.name === "splice" && call.arguments.length <= 2) ||
            method.name === "sort" ||
            method.name === "reverse" ||
            method.name === "copyWithin")
    );
}

/** An arrow function or a function expression. */
function isFunctionLiteral(
    node: ts.Node,
): node is ts.ArrowFunction | ts.FunctionExpression {
    return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

/**
 * The function literals a function returns when every completion returns
 * one: an arrow's expression body, or each `return`'s value.
 */
function returnedFunctionLiterals(
    fn: SupportedFunction,
): readonly (ts.ArrowFunction | ts.FunctionExpression)[] | undefined {
    if (!fn.body) return undefined;
    if (!ts.isBlock(fn.body)) {
        const body = unwrapExpression(fn.body);
        return isFunctionLiteral(body) ? [body] : undefined;
    }
    const returned: (ts.ArrowFunction | ts.FunctionExpression)[] = [];
    let other = false;
    forEachReturn([fn.body], (statement) => {
        const value =
            statement.expression && unwrapExpression(statement.expression);
        if (value && isFunctionLiteral(value)) returned.push(value);
        else other = true;
    });
    return other || returned.length === 0 ? undefined : returned;
}

/** A named function no code calls or reads: it never runs, so it binds nothing. */
function neverRuns(
    graph: SourceGraph,
    owner: ts.SignatureDeclaration,
): boolean {
    return (
        (ts.isFunctionDeclaration(owner) ||
            ((ts.isArrowFunction(owner) || ts.isFunctionExpression(owner)) &&
                ts.isVariableDeclaration(owner.parent) &&
                owner.parent.initializer === owner)) &&
        (graph.calls.get(owner) ?? []).length === 0 &&
        !graph.escaped.has(owner)
    );
}

interface SourceGraph {
    readonly calls: ReadonlyMap<
        SupportedFunction,
        readonly ts.CallExpression[]
    >;
    readonly writes: ReadonlyMap<ts.Symbol, readonly ts.Expression[]>;
    readonly mutated: ReadonlySet<ts.Symbol>;
    /**
     * Plain `x.a[i].b = v` writes into a binding's object graph, by the
     * binding: the path the write reaches and the value it stores.
     */
    readonly memberWrites: ReadonlyMap<ts.Symbol, readonly MemberWrite[]>;
    /** Mutated bindings some write other than a recorded member write reaches. */
    readonly otherwiseMutated: ReadonlySet<ts.Symbol>;
    /** Local Maps whose every value the source writes visibly. */
    readonly registries: ReadonlyMap<ts.Symbol, MapRegistry>;
    /** Functions some code reads as a value, so calls may reach them unseen. */
    readonly escaped: ReadonlySet<SupportedFunction>;
}

interface MemberWrite {
    readonly path: KeyPath;
    /** Absent: a write whose value the source does not spell (a method writing its receiver). */
    readonly value?: ts.Expression;
}

/** `to`'s object at `toPath` is the aliasing binding's at `fromPath`. */
interface AliasEdge {
    readonly to: ts.Symbol;
    readonly fromPath: KeyPath;
    readonly toPath: KeyPath;
}

/** Deeper alias paths count as a write the target cannot read: aliases may cycle. */
const maxAliasPath = 8;

/** The step an access takes: its key, or any element for an index or a run-time key. */
function memberStep(
    access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): string {
    const key = accessKey(access);
    return key === undefined || keyIndex(key) !== undefined ? ANY_KEY : key;
}

/** A binding: a name, or a class's private field read through any instance. */
type Binding = ts.Identifier | ts.PrivateIdentifier;

/**
 * The private field an access reads (`this.#queue`, `other.#queue`): a
 * binding of its class, which only the class body reads or writes.
 */
function privateField(node: ts.Node): ts.PrivateIdentifier | undefined {
    return ts.isPropertyAccessExpression(node) &&
        ts.isPrivateIdentifier(node.name)
        ? node.name
        : undefined;
}

/** The binding an expression is as a whole: a name or a private field. */
function namedBinding(expression: ts.Expression): Binding | undefined {
    const node = unwrapExpression(expression);
    return ts.isIdentifier(node) ? node : privateField(node);
}

/**
 * The bindings holding the objects `expression` evaluates to or into
 * (`referenceBases`), a private field holding what is read through it.
 */
function heldBindings(expression: ts.Expression): Binding[] {
    return referenceBases(
        expression,
        unwrapExpression,
        (access) => privateField(access) !== undefined,
    ).flatMap((base) => {
        const binding = namedBinding(base);
        return binding ? [binding] : [];
    });
}

/**
 * How many members below what its alias site reads a name holds its value
 * (`AliasSite.holds`): none for the value itself, one per pattern level for a
 * pattern leaf (a rest element adds none), one more for a loop's element.
 */
function aliasDepth(name: ts.Identifier, holds: AliasSite["holds"]): number {
    if (holds === "value" || holds === "returned") return 0;
    let depth = holds === "element" ? 1 : 0;
    for (let node: ts.Node = name; ;) {
        const parent = node.parent;
        const declared = declarationNamed(node);
        if (declared && ts.isBindingElement(declared)) {
            if (!declared.dotDotDotToken) depth++;
            node = declared.parent;
        } else if (
            ts.isShorthandPropertyAssignment(parent) ||
            (ts.isPropertyAssignment(parent) && parent.initializer === node)
        ) {
            depth++;
            node = parent.parent;
        } else if (ts.isArrayLiteralExpression(parent)) {
            depth++;
            node = parent;
        } else if (
            // A default (`[x = 1] = s`) or a rest (`[...xs] = s`) leaves
            // the level to its element.
            (ts.isBinaryExpression(parent) &&
                parent.left === node &&
                parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                (ts.isArrayLiteralExpression(parent.parent) ||
                    ts.isPropertyAssignment(parent.parent))) ||
            ts.isSpreadElement(parent) ||
            ts.isSpreadAssignment(parent)
        )
            node = parent;
        // An assigned loop target (`for (x of xs)`) takes each element.
        else
            return ts.isForOfStatement(parent) && parent.initializer === node
                ? depth + 1
                : depth;
    }
}

/** The path `target` writes below its root binding, when every key is plain. */
function memberWritePath(
    target: ts.Expression,
): { root: Binding; path: KeyPath } | undefined {
    const path: string[] = [];
    let node = unwrapExpression(target);
    while (
        ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)
    ) {
        const field = privateField(node);
        if (field) return path.length > 0 ? { root: field, path } : undefined;
        path.unshift(memberStep(node));
        node = unwrapExpression(node.expression);
    }
    return ts.isIdentifier(node) && path.length > 0
        ? { root: node, path }
        : undefined;
}

/**
 * Whether a name only declares, re-exports or directly calls its function;
 * `m.f` through a namespace import is the use its access makes.
 */
/**
 * The typed places a function named as a value is held where calls through
 * them resolve: an object literal member's contextual member signatures
 * (through `Object.freeze`, which returns its argument), or a `const`'s
 * function type annotation (none when the `const` is unannotated: its calls
 * name the function). Undefined for any other use, an escape: a literal
 * member no typed member declares can be called through any type.
 */
function functionSlots(
    checker: ts.TypeChecker,
    node: ts.Identifier,
): readonly ts.Node[] | undefined {
    const consumer = valueConsumer(node);
    if (consumer.kind === "property") {
        if (!ts.isIdentifier(consumer.name)) return undefined;
        let holder: ts.Expression = consumer.literal;
        for (;;) {
            const held = valueConsumer(holder);
            const freeze =
                held.kind === "argument" &&
                held.index === 0 &&
                libraryStaticMember(checker, held.call.expression);
            if (
                !freeze ||
                freeze.owner !== "Object" ||
                freeze.name !== "freeze"
            )
                break;
            holder = held.call;
        }
        const signatures = (
            checker.getContextualType(holder)?.getProperty(consumer.name.text)
                ?.declarations ?? []
        ).filter(
            (signature) =>
                ts.isMethodSignature(signature) ||
                ts.isPropertySignature(signature),
        );
        return signatures.length ? signatures : undefined;
    }
    if (
        consumer.kind === "initializer" &&
        variableKind(consumer.declaration) === "const"
    ) {
        const { declaration } = consumer;
        return declaration.type && ts.isFunctionTypeNode(declaration.type)
            ? [declaration]
            : [];
    }
    return undefined;
}

function directFunctionUse(node: ts.Identifier): boolean {
    const site = referenceSite(node);
    return (
        site === undefined ||
        ts.isExportSpecifier(node.parent) ||
        (ts.isCallExpression(site.parent) && site.parent.expression === site)
    );
}

/**
 * A `const m = new Map()` no other code reaches: its values are the
 * `m.set(k, v)` arguments, and the elements of array values also include
 * what `m.get(k).push(...)` appends. A Map passed, returned or stored
 * elsewhere, or an array value written any other way, has no registry.
 */
interface MapRegistry {
    readonly values: readonly ts.Expression[];
    readonly pushed: readonly ts.Expression[];
}

/** Array methods whose callback's first parameter is each element. */
const arrayIterationMethods = new Set([
    "map",
    "forEach",
    "filter",
    "find",
    "findIndex",
    "findLast",
    "findLastIndex",
    "some",
    "every",
    "flatMap",
]);
/** Methods that read a Map or shrink it; `set` and `get` are classified. */
const mapReads = new Set([
    "has",
    "size",
    "keys",
    "values",
    "entries",
    "forEach",
    "delete",
    "clear",
]);

function isLibraryMap(checker: ts.TypeChecker, node: ts.Node): boolean {
    const symbol = checker.getNonNullableType(
        checker.getTypeAtLocation(node),
    ).symbol;
    return libraryName(symbol) === "Map";
}

/**
 * Classifies how an array a registry's `get` returned is used: reads keep
 * it closed and `push` arguments join its elements. False when it escapes.
 */
function classifyRegistryArray(
    checker: ts.TypeChecker,
    node: ts.Expression,
    pushed: ts.Expression[],
    depth = 0,
): boolean {
    const use = outermostWrapper(node, { branches: "objects" });
    const parent = use.parent;
    if (ts.isForOfStatement(parent) && parent.expression === use) return true;
    if (ts.isSpreadElement(parent)) return true;
    if (testsTruthinessOnly(use)) return true;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === use) {
        const method = parent.name.text;
        if (method === "push") {
            const call = parent.parent;
            if (!ts.isCallExpression(call) || call.expression !== parent)
                return false;
            pushed.push(...call.arguments);
            return true;
        }
        return method === "length" || readOnlyDataMethods.has(method);
    }
    if (
        depth === 0 &&
        ts.isVariableDeclaration(parent) &&
        parent.initializer === use &&
        ts.isIdentifier(parent.name) &&
        variableKind(parent.parent) === "const"
    ) {
        const alias = resolvedSymbol(checker, parent.name);
        if (!alias) return false;
        let closed = true;
        const scope = parent.parent.parent.parent;
        const visit = (child: ts.Node): void => {
            if (!closed) return;
            if (
                ts.isIdentifier(child) &&
                referenceSite(child) !== undefined &&
                resolvedSymbol(checker, child) === alias
            ) {
                closed = classifyRegistryArray(
                    checker,
                    child,
                    pushed,
                    depth + 1,
                );
                return;
            }
            ts.forEachChild(child, visit);
        };
        visit(scope);
        return closed;
    }
    return false;
}

/** The registry `declaration` declares, when every reference keeps it closed. */
function mapRegistry(
    checker: ts.TypeChecker,
    declaration: ts.VariableDeclaration,
): MapRegistry | undefined {
    if (
        !ts.isIdentifier(declaration.name) ||
        variableKind(declaration.parent) !== "const" ||
        !declaration.initializer
    )
        return undefined;
    const initializer = unwrapExpression(declaration.initializer);
    if (
        !ts.isNewExpression(initializer) ||
        (initializer.arguments?.length ?? 0) !== 0 ||
        !isLibraryMap(checker, declaration.name)
    )
        return undefined;
    const statement = declaration.parent.parent;
    if (
        ts.isVariableStatement(statement) &&
        statement.modifiers?.some(
            (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
        )
    )
        return undefined;
    const symbol = resolvedSymbol(checker, declaration.name);
    if (!symbol) return undefined;
    const values: ts.Expression[] = [];
    const pushed: ts.Expression[] = [];
    let closed = true;
    const visit = (child: ts.Node): void => {
        if (!closed) return;
        if (
            ts.isIdentifier(child) &&
            referenceSite(child) !== undefined &&
            resolvedSymbol(checker, child) === symbol
        ) {
            const parent = child.parent;
            if (
                !ts.isPropertyAccessExpression(parent) ||
                parent.expression !== child
            ) {
                closed = false;
                return;
            }
            const method = parent.name.text;
            const call = parent.parent;
            const called =
                ts.isCallExpression(call) && call.expression === parent;
            if (method === "set" && called && call.arguments.length === 2) {
                // `set` returns the Map itself; a chained or stored result
                // is another reference this walk does not follow.
                values.push(call.arguments[1]!);
                closed = ts.isExpressionStatement(
                    outermostWrapper(call).parent,
                );
            } else if (method === "get" && called)
                closed = classifyRegistryArray(checker, call, pushed);
            else closed = mapReads.has(method);
            return;
        }
        ts.forEachChild(child, visit);
    };
    visit(declaration.parent.parent.parent);
    return closed ? { values, pushed } : undefined;
}

// Source facts outlive emission attempts, but never retain a lowering context.
const sourceGraphs = new WeakMap<ts.TypeChecker, SourceGraph>();

function isLibraryObject(checker: ts.TypeChecker, type: ts.Type): boolean {
    return (
        declaredInDefaultLibrary(type.symbol) &&
        !checker.isArrayType(type) &&
        !checker.isTupleType(type)
    );
}

function sourceGraph(
    checker: ts.TypeChecker,
    sourceFiles: readonly ts.SourceFile[],
): SourceGraph {
    const cached = sourceGraphs.get(checker);
    if (cached) return cached;

    const calls = new Map<SupportedFunction, ts.CallExpression[]>();
    const registries = new Map<ts.Symbol, MapRegistry>();
    const memberWrites = new Map<ts.Symbol, MemberWrite[]>();
    const otherwiseMutated = new Set<ts.Symbol>();
    const escaped = new Set<SupportedFunction>();
    // An object literal's methods implement the members of the type it is
    // written as (`return { show() {} }` from a function typed `Toast`):
    // calls through that type's member reach them.
    const implementations = new Map<ts.Node, SupportedFunction[]>();
    const implement = (
        member: ts.Node,
        functions: readonly SupportedFunction[],
    ): void => {
        implementations.set(member, [
            ...(implementations.get(member) ?? []),
            ...functions,
        ]);
    };
    // A `let` annotated with a function type: calls through it reach every
    // function literal it holds (settled after the walk, with its writes).
    const annotatedFunctionBindings: {
        declaration: ts.VariableDeclaration;
        name: ts.Identifier;
    }[] = [];
    const memberCalls: [ts.Node, ts.CallExpression][] = [];
    const writes = new Map<ts.Symbol, ts.Expression[]>();
    const mutated = new Set<ts.Symbol>();
    const aliases = new Map<ts.Symbol, AliasEdge[]>();
    // Where a source expression holds a binding's object: what a literal holds
    // sits under its key, and an access chain is its root's object at its path.
    const heldPaths = (
        source: ts.Expression,
        add: (root: Binding, fromPath: KeyPath, toPath: KeyPath) => void,
    ): void => {
        for (const { value, path } of [
            { value: source, path: [] },
            ...literalHeldValuesAt(source),
        ]) {
            if (!typeCanCarryReference(checker.getTypeAtLocation(value)))
                continue;
            const chain = memberWritePath(value);
            for (const base of heldBindings(value))
                add(base, path, chain?.root === base ? chain.path : []);
        }
    };
    // A name `depth` members inside what it reads (a pattern leaf, a loop's
    // element) holds an object that far below the source's own path.
    const alias = (target: ts.Node, source: ts.Expression, depth = 0): void => {
        const type = checker.getNonNullableType(
            checker.getTypeAtLocation(target),
        );
        if (!(type.flags & (ts.TypeFlags.Object | ts.TypeFlags.TypeParameter)))
            return;
        // Native object mutations do not mutate the containing authored record.
        if (isLibraryObject(checker, type)) return;
        const from = resolvedSymbol(checker, target);
        if (!from) return;
        // Every binding the source's value can come from: a selection's
        // operands, and what a literal holds.
        heldPaths(source, (root, fromPath, toPath) => {
            const to = resolvedSymbol(checker, root);
            if (!to) return;
            const edges = aliases.get(from) ?? [];
            edges.push({
                to,
                fromPath,
                toPath: [...toPath, ...new Array<string>(depth).fill(ANY_KEY)],
            });
            aliases.set(from, edges);
        });
    };
    // Every binding a write can reach: a selection writes through each operand.
    const mutate = (expression: ts.Expression): void => {
        for (const root of heldBindings(expression)) {
            const symbol = resolvedSymbol(checker, root);
            if (symbol) {
                mutated.add(symbol);
                otherwiseMutated.add(symbol);
            }
        }
    };
    const recordCall = (
        declaration: SupportedFunction,
        call: ts.CallExpression,
    ): void => {
        const sites = calls.get(declaration) ?? [];
        sites.push(call);
        calls.set(declaration, sites);
        declaration.parameters.forEach((parameter, index) => {
            const input = parameterInput(checker, call, declaration, index);
            if (!ts.isIdentifier(parameter.name)) return;
            if (input.kind === "argument")
                alias(parameter.name, input.argument);
            // A spread tuple's element is held one element below it.
            else if (input.kind === "element")
                alias(parameter.name, input.spread, 1);
        });
    };
    for (const source of sourceFiles) {
        forEachAnalysisNode(
            source,
            (node) => {
                if (ts.isIdentifier(node) && !directFunctionUse(node)) {
                    const declaration = resolvedSymbol(
                        checker,
                        node,
                    )?.valueDeclaration;
                    const used =
                        declaration && functionOfDeclaration(declaration);
                    const slots = used && functionSlots(checker, node);
                    if (slots)
                        for (const slot of slots) implement(slot, [used]);
                    else if (used) escaped.add(used);
                }
                // A name a declaration, pattern, loop or assignment binds
                // holds what it reads.
                for (const { name, source, holds } of aliasSites(node))
                    if (holds !== "returned")
                        alias(name, source, aliasDepth(name, holds));
                // A function annotated to return a function type: calls typed
                // by that type reach the literals it returns, when it returns
                // nothing else.
                if (
                    isSupportedFunction(node) &&
                    node.type &&
                    ts.isFunctionTypeNode(node.type)
                ) {
                    const returned = returnedFunctionLiterals(node);
                    if (returned) implement(node, returned);
                }
                if (
                    ts.isVariableDeclaration(node) &&
                    ts.isIdentifier(node.name) &&
                    node.type &&
                    ts.isFunctionTypeNode(node.type) &&
                    variableKind(node) === "let"
                )
                    annotatedFunctionBindings.push({
                        declaration: node,
                        name: node.name,
                    });
                if (
                    ts.isVariableDeclaration(node) &&
                    ts.isIdentifier(node.name) &&
                    node.initializer
                ) {
                    const registry = mapRegistry(checker, node);
                    const symbol =
                        registry && resolvedSymbol(checker, node.name);
                    if (registry && symbol) registries.set(symbol, registry);
                }
                if (ts.isObjectLiteralExpression(node)) {
                    const type = checker.getContextualType(node);
                    for (const property of node.properties) {
                        if (
                            !(
                                ts.isMethodDeclaration(property) ||
                                ts.isPropertyAssignment(property)
                            ) ||
                            !ts.isIdentifier(property.name)
                        )
                            continue;
                        const implementation = ts.isMethodDeclaration(property)
                            ? property
                            : ts.isArrowFunction(property.initializer) ||
                                ts.isFunctionExpression(property.initializer)
                              ? property.initializer
                              : undefined;
                        if (!implementation) continue;
                        const member = type?.getProperty(property.name.text);
                        for (const signature of member?.declarations ?? [])
                            if (
                                ts.isMethodSignature(signature) ||
                                ts.isPropertySignature(signature)
                            )
                                implement(signature, [implementation]);
                    }
                }
                if (ts.isCallExpression(node)) {
                    const declaration = calledFunction(checker, node);
                    const signature = calledDeclaration(checker, node);
                    if (!declaration && signature) {
                        // A property typed as a function type resolves to
                        // that type's signature; the member names it.
                        const member = ts.isFunctionTypeNode(signature)
                            ? signature.parent
                            : signature;
                        memberCalls.push([member, node]);
                    }
                    if (declaration) recordCall(declaration, node);
                    const callee = unwrapExpression(node.expression);
                    // A call through a rebindable binding typed by a function
                    // type resolves to that type: the function it held runs
                    // unseen.
                    const binding = ts.isIdentifier(callee)
                        ? resolvedSymbol(checker, callee)?.valueDeclaration
                        : undefined;
                    const named = binding && functionOfDeclaration(binding);
                    if (named && named !== declaration) escaped.add(named);
                    // `xs.push(v)`, `xs.unshift(v)` and `xs.splice(i, n, v)`
                    // store elements: plain writes at the array's element path
                    // (a spread argument writes each element it spreads).
                    const method = namedMember(checker, callee);
                    const inserted =
                        method?.name === "push" || method?.name === "unshift"
                            ? node.arguments
                            : method?.name === "splice" &&
                                node.arguments.length > 2 &&
                                !node.arguments
                                    .slice(0, 2)
                                    .some(ts.isSpreadElement)
                              ? node.arguments.slice(2)
                              : undefined;
                    const receiver =
                        method && inserted
                            ? unwrapExpression(method.expression)
                            : undefined;
                    const whole = receiver && namedBinding(receiver);
                    const stored = receiver
                        ? whole
                            ? { root: whole, path: [] }
                            : memberWritePath(receiver)
                        : undefined;
                    const storedSymbol =
                        stored && resolvedSymbol(checker, stored.root);
                    if (
                        stored &&
                        storedSymbol &&
                        checker.isArrayType(
                            checker.getTypeAtLocation(receiver!),
                        )
                    ) {
                        mutated.add(storedSymbol);
                        const list = memberWrites.get(storedSymbol) ?? [];
                        for (const value of inserted ?? [])
                            list.push({
                                path: [...stored.path, ANY_KEY],
                                value,
                            });
                        memberWrites.set(storedSymbol, list);
                    } else if (
                        method &&
                        storesNoNewElement(checker, method, node)
                    ) {
                        // Removing or reordering elements stores no value
                        // the array's elements did not already hold.
                    } else if (
                        method &&
                        callWritesReceiver(
                            checker,
                            method.name,
                            method.expression,
                            node,
                        )
                    ) {
                        // A method writing a member's object writes only
                        // under that member's path.
                        const written = ts.isIdentifier(
                            unwrapExpression(method.expression),
                        )
                            ? undefined
                            : memberWritePath(
                                  unwrapExpression(method.expression),
                              );
                        const symbol =
                            written && resolvedSymbol(checker, written.root);
                        if (written && symbol) {
                            mutated.add(symbol);
                            const list = memberWrites.get(symbol) ?? [];
                            list.push({ path: [...written.path, ANY_KEY] });
                            memberWrites.set(symbol, list);
                        } else mutate(method.expression);
                    }
                }
                for (const { target, kind, stored } of writeSites(node)) {
                    // A name's own rebinds come from fileRebinds below.
                    if (ts.isIdentifier(target)) continue;
                    // Setting an array's length removes elements or leaves
                    // holes: it stores no value the elements did not hold.
                    const access = unwrapExpression(target);
                    if (
                        ts.isPropertyAccessExpression(access) &&
                        access.name.text === "length" &&
                        checker.isArrayType(
                            checker.getTypeAtLocation(access.expression),
                        )
                    )
                        continue;
                    // A private field's are its plain `=` writes, each one
                    // holding what it stores; any other leaves it unknown.
                    const field = privateField(access);
                    const fieldSymbol = field && resolvedSymbol(checker, field);
                    if (field && fieldSymbol) {
                        if (kind === "assign" && stored) {
                            const values = writes.get(fieldSymbol) ?? [];
                            values.push(stored);
                            writes.set(fieldSymbol, values);
                            alias(field, stored);
                        } else mutated.add(fieldSymbol);
                        continue;
                    }
                    // Only a plain `=` stores a value this domain can read;
                    // every other write leaves the binding's value unknown.
                    const value = kind === "assign" ? stored : undefined;
                    const written = value && memberWritePath(target);
                    const symbol =
                        written && resolvedSymbol(checker, written.root);
                    if (value && written && symbol) {
                        mutated.add(symbol);
                        const list = memberWrites.get(symbol) ?? [];
                        list.push({ path: written.path, value });
                        memberWrites.set(symbol, list);
                    } else mutate(target);
                }
            },
            { types: "skip" },
        );
        for (const [symbol, sites] of fileRebinds(checker, source))
            for (const { kind, stored } of sites) {
                const value = kind === "assign" ? stored : undefined;
                if (value) {
                    const values = writes.get(symbol) ?? [];
                    values.push(value);
                    writes.set(symbol, values);
                } else mutated.add(symbol);
            }
    }
    for (const { declaration, name } of annotatedFunctionBindings) {
        const symbol = resolvedSymbol(checker, name);
        if (!symbol || mutated.has(symbol)) continue;
        const held = [
            ...(declaration.initializer ? [declaration.initializer] : []),
            ...(writes.get(symbol) ?? []),
        ].map((value) => unwrapExpression(value));
        const literals = held.filter(isFunctionLiteral);
        if (literals.length === held.length) implement(declaration, literals);
    }
    for (const [member, call] of memberCalls)
        for (const implementation of implementations.get(member) ?? [])
            recordCall(implementation, call);
    // A write through an alias reaches each target at the path the alias
    // holds it: inside the held object, under the target's own path there;
    // a write the source does not spell, there as one the target cannot
    // read either.
    const pending = [...mutated];
    const reached = new Map<ts.Symbol, Set<string>>();
    const reach = (target: ts.Symbol, write: MemberWrite): void => {
        const whole =
            write.path.length === 0 ||
            write.path.length > maxAliasPath ||
            (mutated.has(target) && !memberWrites.has(target));
        if (whole) {
            if (otherwiseMutated.has(target)) return;
            otherwiseMutated.add(target);
            mutated.add(target);
            pending.push(target);
            return;
        }
        const seen = reached.get(target) ?? new Set<string>();
        const key = `${write.path.join("\u0000")}\u0001${
            write.value
                ? `${write.value.getSourceFile().fileName}:${write.value.pos}`
                : ""
        }`;
        if (seen.has(key)) return;
        seen.add(key);
        reached.set(target, seen);
        mutated.add(target);
        const list = memberWrites.get(target) ?? [];
        list.push(write);
        memberWrites.set(target, list);
        pending.push(target);
    };
    for (let index = 0; index < pending.length; index++) {
        const source = pending[index]!;
        const writes = memberWrites.get(source);
        const unread = otherwiseMutated.has(source) || !writes;
        for (const edge of aliases.get(source) ?? []) {
            if (unread) reach(edge.to, { path: edge.toPath });
            for (const write of writes ?? [])
                if (
                    write.path.length > edge.fromPath.length &&
                    pathStartsWith(write.path, edge.fromPath)
                )
                    reach(edge.to, {
                        path: [
                            ...edge.toPath,
                            ...write.path.slice(edge.fromPath.length),
                        ],
                        ...(write.value ? { value: write.value } : {}),
                    });
        }
    }
    const graph: SourceGraph = {
        calls,
        writes,
        mutated,
        memberWrites,
        otherwiseMutated,
        registries,
        escaped,
    };
    sourceGraphs.set(checker, graph);
    return graph;
}

/**
 * Every string `expression` can evaluate to, following its declarations,
 * writes, aliases, iterations and calls: undefined when unknown or when no
 * string reaches it, [] for a run-time string no closed set holds.
 */
export function stringDomain(
    context: StringDomainContext,
    expression: ts.Expression,
    use: StringDomainUse,
): Domain {
    let read: Domain;
    try {
        read = new StringDomain(context, use).read(expression, [], new Map());
    } catch (error) {
        if (error instanceof UnboundedDomain)
            return context.fail(expression, error.message);
        throw error;
    }
    return read === nothing ? undefined : read;
}

class StringDomain {
    /**
     * @unjournaled Cycle detection for one domain query, discarded with that
     * query: each node being read, with the query it answers (its
     * projection, read context and enclosing string operations) and the
     * environment it reads in.
     */
    private readonly active = new Map<
        ts.Node,
        { readonly context: string; readonly environment: Environment }
    >();
    /** @unjournaled String-building operands being read (`operand`). */
    private operations = 0;
    private readonly graph: SourceGraph;
    /** @unjournaled Traversal budget for one domain query, discarded with that query. */
    private remaining = 4096;
    /**
     * @unjournaled The projection lengths where an enclosing `??` replaces
     * the value read: an inner one (`queue.shift() ?? null`) leaves the
     * outer ones replacing what they read. Operands of string operations
     * reset them.
     */
    private nullishDepths: readonly number[] = [];

    /**
     * Whether the value read is an operand `??` replaces when nullish: an
     * omitted argument, a missing record member or a nullish literal then
     * contributes nothing.
     */
    private get nullish(): boolean {
        return this.nullishDepths.length > 0;
    }
    /** @unjournaled An optional member can produce undefined instead of throwing. */
    private optionalProjection = false;
    /**
     * @unjournaled Reading an object spread's source: a member it lacks, at
     * any depth of the path, is one the spread never writes.
     */
    private spreadSource = false;

    private inSpreadSource<T>(spreadSource: boolean, read: () => T): T {
        const previous = this.spreadSource;
        this.spreadSource = spreadSource;
        try {
            return read();
        } finally {
            this.spreadSource = previous;
        }
    }
    /** @unjournaled Bindings the enclosing conditional tests truthy: never "". */
    private readonly truthy = new Set<ts.Symbol>();

    constructor(
        private readonly context: StringDomainContext,
        private readonly use: StringDomainUse,
    ) {
        this.graph = sourceGraph(context.checker, context.sourceFiles());
    }

    private exceeded(): UnboundedDomain {
        return new UnboundedDomain(
            `${this.use.label} domain exceeds ${candidateLimit} candidates.`,
        );
    }

    private bounded(values: Iterable<string>): readonly string[] {
        const result = new Set<string>();
        for (const value of values) {
            result.add(value);
            if (result.size > candidateLimit) throw this.exceeded();
        }
        return [...result];
    }

    /** A read whose give-up is returned for the combinator to weigh. */
    private attempt(read: () => Domain): Operand {
        try {
            return read();
        } catch (error) {
            if (error instanceof UnboundedDomain) return error;
            throw error;
        }
    }

    /**
     * One of the alternatives, read in order. `[]` absorbs the rest, and an
     * unknown string decides the union when no fragments can bound it. A
     * give-up waits for a later alternative that can still leave the union
     * open; past the candidate limit the union stops reading, since it can
     * then only end open or unbounded.
     */
    private union(alternatives: Iterable<() => Domain>): Domain {
        const values = new Set<string>();
        let read = 0,
            reached = false,
            unknown = false;
        let unbounded: UnboundedDomain | undefined;
        for (const alternative of alternatives) {
            read++;
            const domain = this.attempt(alternative);
            if (domain === nothing) continue;
            reached = true;
            if (domain instanceof UnboundedDomain) {
                unbounded ??= domain;
                continue;
            }
            if (domain?.length === 0) return [];
            if (domain === undefined) {
                if (!this.use.fragments) return undefined;
                unknown = true;
                continue;
            }
            if (unknown || unbounded) continue;
            for (const value of domain) values.add(value);
            if (values.size > candidateLimit) {
                unbounded = this.exceeded();
                break;
            }
        }
        if (!read) return undefined;
        if (!reached) return nothing;
        if (unknown) return undefined;
        if (unbounded) throw unbounded;
        return [...values];
    }

    public read(
        expression: ts.Expression,
        projection: KeyPath,
        environment: Environment,
    ): Domain {
        if (--this.remaining < 0)
            throw new UnboundedDomain(
                `${this.use.label} provenance exceeds the analysis budget.`,
            );
        const node = unwrapExpression(expression);
        const query = {
            context: [
                projection.join("\u0000"),
                this.nullishDepths.join(","),
                this.truthy.size,
                this.optionalProjection,
                this.operations,
            ].join("\u0001"),
            environment,
        };
        const entered = this.active.get(node);
        // A read reaching itself as the same query through copies alone
        // holds nothing its other sources do not (the least fixed point);
        // through a string operation its strings may grow without bound.
        if (entered)
            return entered.context === query.context &&
                entered.environment === query.environment
                ? nothing
                : undefined;
        this.active.set(node, query);
        const optionalProjection = this.optionalProjection;
        if (
            (ts.isPropertyAccessExpression(node) ||
                ts.isElementAccessExpression(node)) &&
            node.questionDotToken
        )
            this.optionalProjection = true;
        try {
            return this.value(node, projection, environment);
        } finally {
            this.optionalProjection = optionalProjection;
            this.active.delete(node);
        }
    }

    /** Reads an operand that builds a string: its nullish values are not replaced. */
    private operand(
        expression: ts.Expression,
        projection: KeyPath,
        environment: Environment,
    ): Domain {
        const nullishDepths = this.nullishDepths;
        this.nullishDepths = [];
        this.operations++;
        try {
            return this.read(expression, projection, environment);
        } finally {
            this.nullishDepths = nullishDepths;
            this.operations--;
        }
    }

    /** Reads `expression` where its nullish values are replaced (`??`). */
    private replaced(
        expression: ts.Expression,
        projection: KeyPath,
        environment: Environment,
    ): Domain {
        const nullishDepths = this.nullishDepths;
        this.nullishDepths = [...nullishDepths, projection.length];
        try {
            return this.read(expression, projection, environment);
        } finally {
            this.nullishDepths = nullishDepths;
        }
    }

    private value(
        node: ts.Expression,
        projection: KeyPath,
        environment: Environment,
    ): Domain {
        if (
            (this.nullish ||
                (projection.length > 0 && !this.optionalProjection)) &&
            nullishLiteral(this.context.checker, node) !== undefined
        )
            // A member read from null/undefined throws before selecting a URL.
            return nothing;
        // A deployment constant: the value the package is built for.
        if (!projection.length && ts.isPropertyAccessExpression(node)) {
            const deployed = browserDeploymentValue(this.context, node);
            if (typeof deployed === "string") return [deployed];
        }
        if (ts.isIdentifier(node)) {
            const symbol = resolvedSymbol(this.context.checker, node);
            if (!symbol) return undefined;
            const domain = this.identifier(
                node,
                symbol,
                projection,
                environment,
            );
            // A binding its conditional tested truthy holds no "" there.
            if (
                !projection.length &&
                this.truthy.has(symbol) &&
                domain?.length &&
                domain !== nothing
            ) {
                const truthy = domain.filter((value) => value !== "");
                return truthy.length ? truthy : nothing;
            }
            return domain;
        }
        const field = privateField(node);
        if (field) {
            const symbol = resolvedSymbol(this.context.checker, field);
            return symbol
                ? this.identifier(field, symbol, projection, environment)
                : undefined;
        }
        // A spread an element write stores (`xs.push(...ys)`) is each element.
        if (ts.isSpreadElement(node))
            return this.read(
                node.expression,
                [ANY_KEY, ...projection],
                environment,
            );
        if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        )
            return this.union([
                () => this.replaced(node.left, projection, environment),
                () => this.read(node.right, projection, environment),
            ]);
        if (ts.isConditionalExpression(node)) {
            const test = unwrapExpression(node.condition);
            const tested =
                ts.isIdentifier(test) &&
                resolvedSymbol(this.context.checker, test);
            const narrows = tested && !this.truthy.has(tested);
            return this.union([
                () => {
                    if (narrows) this.truthy.add(tested);
                    try {
                        return this.read(
                            node.whenTrue,
                            projection,
                            environment,
                        );
                    } finally {
                        if (narrows) this.truthy.delete(tested);
                    }
                },
                () => this.read(node.whenFalse, projection, environment),
            ]);
        }
        return this.member(node, projection, environment);
    }

    private identifier(
        node: Binding,
        symbol: ts.Symbol,
        projection: KeyPath,
        environment: Environment,
    ): Domain {
        const memberWrites = this.graph.memberWrites.get(symbol);
        if (
            this.graph.mutated.has(symbol) &&
            memberWrites &&
            !this.graph.otherwiseMutated.has(symbol)
        ) {
            // Plain member writes: the value read is the binding's own,
            // or one a write stored on the path the read reaches.
            const reaches = (path: KeyPath): boolean =>
                pathStartsWith(projection, path);
            return this.union([
                () =>
                    this.unwrittenIdentifier(
                        node,
                        symbol,
                        projection,
                        environment,
                    ),
                ...memberWrites
                    .filter((write) => reaches(write.path))
                    .map(
                        (write) => () =>
                            write.value
                                ? this.read(
                                      write.value,
                                      projection.slice(write.path.length),
                                      environment,
                                  )
                                : undefined,
                    ),
            ]);
        }
        // Any other mutation leaves what the binding holds unknown.
        if (this.graph.mutated.has(symbol)) return undefined;
        return this.unwrittenIdentifier(node, symbol, projection, environment);
    }

    /** A binding's value as its declaration, calls and plain rebinds give it. */
    private unwrittenIdentifier(
        node: Binding,
        symbol: ts.Symbol,
        projection: KeyPath,
        environment: Environment,
    ): Domain {
        const declared = (): Domain =>
            this.declaredIdentifier(node, symbol, projection, environment);
        const writes = this.graph.writes.get(symbol) ?? [];
        return writes.length
            ? this.union([
                  declared,
                  ...writes.map(
                      (value) => () =>
                          this.read(value, projection, environment),
                  ),
              ])
            : declared();
    }

    /** A binding's value as its declaration and calls give it. */
    private declaredIdentifier(
        node: Binding,
        symbol: ts.Symbol,
        projection: KeyPath,
        environment: Environment,
    ): Domain {
        const origin = environment.get(symbol);
        if (origin)
            return this.read(
                origin.expression,
                [...origin.projection, ...projection],
                origin.environment,
            );
        const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
        if (declaration && ts.isVariableDeclaration(declaration)) {
            if (
                declaration.getSourceFile() !== node.getSourceFile() &&
                variableKind(declaration.parent) !== "const"
            )
                return [];
            if (declaration.initializer)
                return this.read(
                    declaration.initializer,
                    projection,
                    environment,
                );
            const loop = declaration.parent.parent;
            if (ts.isForOfStatement(loop))
                return this.read(
                    loop.expression,
                    [ANY_KEY, ...projection],
                    environment,
                );
        }
        // A private field holds its initializer until a write; without one it
        // is undefined, as an omitted argument is.
        if (
            declaration &&
            ts.isPropertyDeclaration(declaration) &&
            ts.isPrivateIdentifier(declaration.name)
        )
            return declaration.initializer
                ? this.read(declaration.initializer, projection, environment)
                : this.nullish
                  ? nothing
                  : undefined;
        if (declaration && ts.isParameter(declaration)) {
            const owner =
                ts.isArrowFunction(declaration.parent) ||
                ts.isFunctionExpression(declaration.parent) ||
                ts.isMethodDeclaration(declaration.parent)
                    ? declaration.parent
                    : functionOfDeclaration(declaration.parent);
            if (!owner) return undefined;
            const index = owner.parameters.indexOf(declaration);
            // An array iteration callback's first parameter is each
            // element of the array it iterates.
            const iteration = owner.parent;
            const callee =
                ts.isCallExpression(iteration) &&
                iteration.arguments[0] === owner
                    ? unwrapExpression(iteration.expression)
                    : undefined;
            const method = callee && namedMember(this.context.checker, callee);
            if (
                index === 0 &&
                (ts.isArrowFunction(owner) || ts.isFunctionExpression(owner)) &&
                method
            ) {
                const receiverType = this.context.checker.getTypeAtLocation(
                    method.expression,
                );
                if (
                    (this.context.checker.isArrayType(receiverType) ||
                        this.context.checker.isTupleType(receiverType)) &&
                    arrayIterationMethods.has(method.name)
                )
                    return this.read(
                        method.expression,
                        [ANY_KEY, ...projection],
                        environment,
                    );
            }
            // A method may be reached through any receiver.
            if (neverRuns(this.graph, owner)) return nothing;
            // Calls through a value it escaped as are unseen.
            if (this.graph.escaped.has(owner)) return undefined;
            return this.union(
                (this.graph.calls.get(owner) ?? []).map((call) => () => {
                    const input = parameterInput(
                        this.context.checker,
                        call,
                        owner,
                        index,
                    );
                    // A spread or a rest leaves the argument unknown.
                    if (input.kind === "unknown" || input.kind === "rest")
                        return undefined;
                    // A spread tuple's element is one of its elements.
                    if (input.kind === "element")
                        return this.read(
                            input.spread,
                            [ANY_KEY, ...projection],
                            environment,
                        );
                    const argument =
                        input.kind === "argument"
                            ? input.argument
                            : input.initializer;
                    if (argument)
                        return this.read(argument, projection, environment);
                    // An omitted argument is undefined.
                    return this.nullish ? nothing : undefined;
                }),
            );
        }
        return undefined;
    }

    private member(
        node: ts.Expression,
        projection: KeyPath,
        environment: Environment,
    ): Domain {
        if (ts.isPropertyAccessExpression(node)) {
            const domain = this.read(
                node.expression,
                [node.name.text, ...projection],
                environment,
            );
            if (domain) return domain;
        }
        if (ts.isElementAccessExpression(node))
            return this.read(
                node.expression,
                [memberStep(node), ...projection],
                environment,
            );
        const key = projection[0];
        if (
            ts.isObjectLiteralExpression(node) &&
            key !== undefined &&
            key !== ANY_KEY
        ) {
            const members = objectLiteralMembers(node, (name) =>
                this.context.propertyName(name),
            );
            // The member is its last writer's value, or what a later spread
            // writes where its source has the member.
            let last = members.length - 1;
            for (; last >= 0; --last) {
                const member = members[last]!;
                if (
                    member.kind !== "spread" &&
                    member.kind !== "proto" &&
                    (member.key === key || member.key === undefined)
                )
                    break;
            }
            const writer = members[last];
            if (writer && (writer.key === undefined || !writer.value))
                return undefined;
            const spreads = members
                .slice(last + 1)
                .flatMap((member) =>
                    member.kind === "spread" ? [member.node.expression] : [],
                );
            const value = writer?.value;
            const written = (): Domain =>
                value
                    ? this.inSpreadSource(false, () =>
                          this.read(value, projection.slice(1), environment),
                      )
                    : // A record without the member reads undefined, so a
                      // read through it throws (or, spread, supplies nothing).
                      this.spreadSource ||
                        (projection.length > 1 && !this.optionalProjection) ||
                        this.nullishDepths.includes(projection.length - 1)
                      ? nothing
                      : undefined;
            return spreads.length
                ? this.union([
                      written,
                      ...spreads.map(
                          (spread) => () =>
                              this.inSpreadSource(true, () =>
                                  this.read(spread, projection, environment),
                              ),
                      ),
                  ])
                : written();
        }
        // A record read by a runtime key selects one of its member values.
        if (ts.isObjectLiteralExpression(node) && key === ANY_KEY)
            return this.union(
                node.properties.map(
                    (property) => () =>
                        ts.isPropertyAssignment(property)
                            ? this.read(
                                  property.initializer,
                                  projection.slice(1),
                                  environment,
                              )
                            : ts.isShorthandPropertyAssignment(property)
                              ? this.read(
                                    property.name,
                                    projection.slice(1),
                                    environment,
                                )
                              : undefined,
                ),
            );
        if (ts.isArrayLiteralExpression(node) && key === ANY_KEY)
            return node.elements.length === 0
                ? nothing
                : this.union(
                      node.elements.map(
                          (value) => () =>
                              ts.isSpreadElement(value)
                                  ? this.read(
                                        value.expression,
                                        projection,
                                        environment,
                                    )
                                  : this.read(
                                        value,
                                        projection.slice(1),
                                        environment,
                                    ),
                      ),
                  );
        if (ts.isCallExpression(node))
            return this.call(node, projection, environment);
        if (projection.length) return undefined;
        if (ts.isStringLiteralLike(node)) return [node.text];
        if (ts.isTemplateExpression(node)) {
            const parts: Operand[] = [[node.head.text]];
            for (const span of node.templateSpans)
                parts.push(
                    this.attempt(() =>
                        this.operand(span.expression, [], environment),
                    ),
                    [span.literal.text],
                );
            return this.concatenate(parts);
        }
        if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
            valueKindOf(this.context.checker.getTypeAtLocation(node)) ===
                "string"
        ) {
            const parts: Operand[] = [];
            const collect = (value: ts.Expression): void => {
                const operand = unwrapExpression(value);
                if (
                    ts.isBinaryExpression(operand) &&
                    operand.operatorToken.kind === ts.SyntaxKind.PlusToken &&
                    valueKindOf(
                        this.context.checker.getTypeAtLocation(operand),
                    ) === "string"
                ) {
                    collect(operand.left);
                    collect(operand.right);
                } else
                    parts.push(
                        this.attempt(() =>
                            this.operand(operand, [], environment),
                        ),
                    );
            };
            collect(node);
            return this.concatenate(parts);
        }
        try {
            return this.context.probeEmission(
                () => [this.context.compileStringLiteral(node)],
                () => false,
            );
        } catch (error) {
            if (!(error instanceof CompileError)) throw error;
            return undefined;
        }
    }

    /** An inline callback, or the function a `const` or a declaration names. */
    private callbackFunction(
        expression: ts.Expression | undefined,
    ): Exclude<SupportedFunction, ts.MethodDeclaration> | undefined {
        if (!expression) return undefined;
        const node = unwrapExpression(expression);
        if (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
            return node;
        if (!ts.isIdentifier(node)) return undefined;
        const declaration = resolvedSymbol(
            this.context.checker,
            node,
        )?.valueDeclaration;
        if (
            !declaration ||
            (ts.isVariableDeclaration(declaration) &&
                variableKind(declaration.parent) !== "const")
        )
            return undefined;
        return functionOfDeclaration(declaration);
    }

    private returned(
        declaration: SupportedFunction,
        projection: KeyPath,
        environment: Environment,
    ): Domain {
        if (!declaration.body) return undefined;
        if (!ts.isBlock(declaration.body))
            return this.read(declaration.body, projection, environment);
        const returns: ts.ReturnStatement[] = [];
        forEachReturn([declaration.body], (node) => returns.push(node));
        return this.union(
            returns.map((node) => () => {
                const { expression } = node;
                return expression
                    ? this.read(expression, projection, environment)
                    : undefined;
            }),
        );
    }

    private call(
        call: ts.CallExpression,
        projection: KeyPath,
        environment: Environment,
    ): Domain {
        const declaration = calledFunction(this.context.checker, call);
        if (declaration?.body) {
            const nested = new Map(environment);
            for (const [index, parameter] of declaration.parameters.entries()) {
                if (!ts.isIdentifier(parameter.name)) return undefined;
                const symbol = resolvedSymbol(
                    this.context.checker,
                    parameter.name,
                );
                const input = parameterInput(
                    this.context.checker,
                    call,
                    declaration,
                    index,
                );
                if (input.kind === "unknown" || input.kind === "rest")
                    return undefined;
                if (input.kind === "element") {
                    if (symbol)
                        nested.set(symbol, {
                            expression: input.spread,
                            projection: [ANY_KEY],
                            environment,
                        });
                    continue;
                }
                const argument =
                    input.kind === "argument"
                        ? input.argument
                        : input.initializer;
                if (symbol && argument)
                    nested.set(symbol, {
                        expression: argument,
                        projection: [],
                        environment,
                    });
            }
            return this.returned(declaration, projection, nested);
        }
        const callee = namedMember(
            this.context.checker,
            unwrapExpression(call.expression),
        );
        if (!callee) return undefined;
        const method = callee.name;
        if (
            method === "get" &&
            isLibraryMap(this.context.checker, callee.expression)
        )
            return this.registryValue(
                callee.expression,
                projection,
                environment,
            );
        // Object.freeze returns its argument.
        const frozen =
            method === "freeze"
                ? objectIdentityCallArgument(this.context.checker, call)
                : undefined;
        if (frozen) return this.read(frozen, projection, environment);
        const receiverType = this.context.checker.getTypeAtLocation(
            callee.expression,
        );
        const array =
            this.context.checker.isArrayType(receiverType) ||
            this.context.checker.isTupleType(receiverType);
        if (array && ["find", "at", "pop", "shift"].includes(method))
            return this.read(
                callee.expression,
                [ANY_KEY, ...projection],
                environment,
            );
        if (array && ["slice", "filter", "splice"].includes(method))
            return this.read(callee.expression, projection, environment);
        const from =
            method === "from" &&
            this.context.libraryGlobal(callee.expression) === "Array";
        const flat = array && method === "flatMap";
        if (
            (from || flat || (array && method === "map")) &&
            projection[0] === ANY_KEY
        ) {
            const argument = call.arguments[from ? 1 : 0];
            const iterable = from ? call.arguments[0] : callee.expression;
            if (
                !flat &&
                argument &&
                iterable &&
                isObjectIdentityFunction(this.context.checker, argument)
            )
                return this.read(iterable, projection, environment);
            const callback = this.callbackFunction(argument);
            if (!callback) return undefined;
            const nested = new Map(environment);
            const parameter = callback.parameters[0];
            if (parameter && ts.isIdentifier(parameter.name) && iterable) {
                const symbol = resolvedSymbol(
                    this.context.checker,
                    parameter.name,
                );
                if (symbol)
                    nested.set(symbol, {
                        expression: iterable,
                        projection: [ANY_KEY],
                        environment,
                    });
            }
            if (!flat)
                return this.returned(callback, projection.slice(1), nested);
            // flatMap spreads a returned array one level and keeps any other
            // value; a callback returning both is not followed.
            const checker = this.context.checker;
            const signature = checker.getSignatureFromDeclaration(callback);
            const results = signature
                ? unionMembers(checker.getReturnTypeOfSignature(signature))
                : [];
            const arrays = results.filter(
                (type) =>
                    checker.isArrayType(type) || checker.isTupleType(type),
            ).length;
            if (!results.length || (arrays && arrays !== results.length))
                return undefined;
            return this.returned(
                callback,
                arrays ? projection : projection.slice(1),
                nested,
            );
        }
        // `[a, b].join(separator)` spells its elements in order, a nullish
        // literal as "".
        const joined = unwrapExpression(callee.expression);
        if (
            array &&
            method === "join" &&
            !projection.length &&
            ts.isArrayLiteralExpression(joined) &&
            !joined.elements.some(ts.isSpreadElement)
        ) {
            const separator = call.arguments[0]
                ? this.attempt(() =>
                      this.operand(call.arguments[0]!, [], environment),
                  )
                : [","];
            return this.concatenate(
                joined.elements.flatMap((element, index) => [
                    ...(index ? [separator] : []),
                    nullishLiteral(this.context.checker, element) !== undefined
                        ? [""]
                        : this.attempt(() =>
                              this.operand(element, [], environment),
                          ),
                ]),
            );
        }
        if (projection.length || valueKindOf(receiverType) !== "string")
            return undefined;
        const source = this.attempt(() =>
            this.operand(callee.expression, [], environment),
        );
        if (!source) return undefined;
        if (
            (method === "replace" || method === "replaceAll") &&
            call.arguments.length === 2
        ) {
            const replacement = this.attempt(() =>
                this.operand(call.arguments[1]!, [], environment),
            );
            const patternNode = unwrapExpression(call.arguments[0]!);
            const regex = ts.isRegularExpressionLiteral(patternNode)
                ? regularExpressionParts(patternNode)
                : undefined;
            const patterns = regex
                ? [new RegExp(regex.pattern, regex.flags)]
                : this.attempt(() =>
                      this.operand(patternNode, [], environment),
                  );
            // An unknown operand leaves the result unknown, a give-up beside
            // it included.
            if (!replacement || !patterns) return [];
            if (source instanceof UnboundedDomain) throw source;
            if (replacement instanceof UnboundedDomain) throw replacement;
            if (patterns instanceof UnboundedDomain) throw patterns;
            const candidates = function* () {
                for (const value of source)
                    for (const pattern of patterns)
                        for (const text of replacement)
                            yield method === "replace"
                                ? value.replace(pattern, text)
                                : value.replaceAll(pattern, text);
            };
            return this.bounded(candidates());
        }
        return [];
    }

    /**
     * A closed Map registry's `get`: one of the values it set or, for array
     * values, the elements pushed onto them. A missing key reads undefined,
     * which only a member read (it throws) or `??` (it replaces) rules out.
     */
    private registryValue(
        receiver: ts.Expression,
        projection: KeyPath,
        environment: Environment,
    ): Domain {
        const root = unwrapExpression(receiver);
        const symbol =
            ts.isIdentifier(root) && resolvedSymbol(this.context.checker, root);
        const registry = symbol ? this.graph.registries.get(symbol) : undefined;
        if (!registry || (!projection.length && !this.nullish))
            return undefined;
        if (registry.pushed.length && projection[0] !== ANY_KEY)
            return undefined;
        const alternatives = [
            ...registry.values.map(
                (value) => () => this.read(value, projection, environment),
            ),
            ...registry.pushed.map(
                (value) => () =>
                    this.read(value, projection.slice(1), environment),
            ),
        ];
        return alternatives.length ? this.union(alternatives) : nothing;
    }

    private concatenate(parts: readonly Operand[]): Domain {
        // A part no value reaches means the string is never built.
        if (parts.includes(nothing)) return nothing;
        const read = parts.filter(
            (part): part is Domain => !(part instanceof UnboundedDomain),
        );
        if (read.some((part) => part?.length === 0)) return [];
        // With no fragments to bound it, an unknown part leaves the string
        // unknown, a give-up beside it included.
        if (!this.use.fragments && read.includes(undefined)) return undefined;
        const unbounded = parts.find((part) => part instanceof UnboundedDomain);
        if (unbounded) throw unbounded;
        let patterns: (string | undefined)[][] = [[]];
        for (const part of read) {
            if (patterns.length * (part?.length ?? 1) > candidateLimit)
                throw this.exceeded();
            patterns = patterns.flatMap((prefix) =>
                (part ?? [undefined]).map((value) => [...prefix, value]),
            );
        }
        return this.union(
            patterns.map(
                (pattern) => () =>
                    pattern.every((part) => part !== undefined)
                        ? [pattern.join("")]
                        : this.use.fragments?.(pattern),
            ),
        );
    }
}

/**
 * Whether `symbol` is assigned, and every assignment sits in a named
 * function that no code calls or reads: the binding then keeps its
 * initializer for the whole run, as a `const` would (`let profile = DEFAULT;
 * export function setProfile(p) { profile = p; }` in a program that never
 * sets it). A `let` nothing assigns stays a runtime binding.
 */
export function writtenOnlyInDeadFunctions(
    checker: ts.TypeChecker,
    sourceFiles: readonly ts.SourceFile[],
    symbol: ts.Symbol,
): boolean {
    const writes = bindingRebinds(checker, sourceFiles, symbol);
    const owners = writes.flatMap((write) => {
        const owner = ts.findAncestor(write.node.parent, ts.isFunctionLike);
        return owner ? [owner] : [];
    });
    // The program's call graph is asked only of writes that all sit in
    // functions.
    if (owners.length === 0 || owners.length !== writes.length) return false;
    const graph = sourceGraph(checker, sourceFiles);
    return owners.every((owner) => neverRuns(graph, owner));
}
