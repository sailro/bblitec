import { readdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import ts from "typescript";
import { forEachAnalysisNode } from "./analysis-walk.js";
import { resolveBundledAsset } from "./assets.js";
import { deploymentUrl } from "./deployment.js";
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
} from "./symbols.js";
import {
    isObjectIdentityFunction,
    objectIdentityCallArgument,
} from "./static-evaluator.js";
import {
    readOnlyDataMethods,
    receiverWritingMethods,
} from "./receiver-methods.js";
import {
    outermostWrapper,
    regularExpressionParts,
    rootIdentifier,
    unwrapExpression,
    writeSites,
    referenceSite,
    accessKey,
    keyIndex,
    lastWriter,
    objectLiteralMembers,
    testsTruthinessOnly,
    functionOfDeclaration,
    type SupportedFunction,
    variableKind,
} from "./syntax.js";
import { valueKindOf } from "./type-facts.js";
import { bindingRebinds, fileRebinds } from "./binding-rebinds.js";

type Context = Pick<
    LoweringServices,
    | "checker"
    | "options"
    | "sourceFiles"
    | "compileStringLiteral"
    | "probeEmission"
    | "libraryGlobal"
    | "propertyName"
    | "fail"
>;
const element = Symbol("array element");
type Projection = readonly (string | typeof element)[];
interface Origin {
    expression: ts.Expression;
    projection: Projection;
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
    readonly path: Projection;
    readonly value: ts.Expression;
}

/** The step an access takes: its key, or any element for an index or a run-time key. */
function memberStep(
    access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): string | typeof element {
    const key = accessKey(access);
    return key === undefined || keyIndex(key) !== undefined ? element : key;
}

/** The path `target` writes below its root binding, when every key is plain. */
function memberWritePath(
    target: ts.Expression,
): { root: ts.Identifier; path: Projection } | undefined {
    const path: (string | typeof element)[] = [];
    let node = unwrapExpression(target);
    while (
        ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)
    ) {
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
    const memberCalls: [ts.Node, ts.CallExpression][] = [];
    const writes = new Map<ts.Symbol, ts.Expression[]>();
    const mutated = new Set<ts.Symbol>();
    const aliases = new Map<ts.Symbol, Set<ts.Symbol>>();
    const alias = (target: ts.Node, source: ts.Expression): void => {
        const type = checker.getNonNullableType(
            checker.getTypeAtLocation(target),
        );
        if (!(type.flags & (ts.TypeFlags.Object | ts.TypeFlags.TypeParameter)))
            return;
        // Native object mutations do not mutate the containing authored record.
        if (isLibraryObject(checker, type)) return;
        const from = resolvedSymbol(checker, target);
        const root = rootIdentifier(source);
        const to = root && resolvedSymbol(checker, root);
        if (from && to) {
            const targets = aliases.get(from) ?? new Set<ts.Symbol>();
            targets.add(to);
            aliases.set(from, targets);
        }
    };
    const mutate = (expression: ts.Expression): void => {
        const root = rootIdentifier(expression);
        const symbol = root && resolvedSymbol(checker, root);
        if (symbol) {
            mutated.add(symbol);
            otherwiseMutated.add(symbol);
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
            if (ts.isIdentifier(parameter.name) && input.kind === "argument")
                alias(parameter.name, input.argument);
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
                    if (used) escaped.add(used);
                }
                if (
                    ts.isVariableDeclaration(node) &&
                    ts.isIdentifier(node.name) &&
                    node.initializer
                ) {
                    alias(node.name, node.initializer);
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
                        for (const signature of member?.declarations ?? []) {
                            if (
                                !ts.isMethodSignature(signature) &&
                                !ts.isPropertySignature(signature)
                            )
                                continue;
                            const implemented =
                                implementations.get(signature) ?? [];
                            implemented.push(implementation);
                            implementations.set(signature, implemented);
                        }
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
                    // `xs.push(v)` / `xs.unshift(v)` store elements: plain
                    // writes at the array's element path.
                    const receiver =
                        ts.isPropertyAccessExpression(callee) &&
                        (callee.name.text === "push" ||
                            callee.name.text === "unshift")
                            ? unwrapExpression(callee.expression)
                            : undefined;
                    const stored = receiver
                        ? ts.isIdentifier(receiver)
                            ? { root: receiver, path: [] as Projection }
                            : memberWritePath(receiver)
                        : undefined;
                    const storedSymbol =
                        stored && resolvedSymbol(checker, stored.root);
                    if (
                        stored &&
                        storedSymbol &&
                        checker.isArrayType(
                            checker.getTypeAtLocation(receiver!),
                        ) &&
                        !node.arguments.some(ts.isSpreadElement)
                    ) {
                        mutated.add(storedSymbol);
                        const list = memberWrites.get(storedSymbol) ?? [];
                        for (const value of node.arguments)
                            list.push({
                                path: [...stored.path, element],
                                value,
                            });
                        memberWrites.set(storedSymbol, list);
                    } else if (
                        ts.isPropertyAccessExpression(callee) &&
                        receiverWritingMethods.has(callee.name.text)
                    )
                        mutate(callee.expression);
                }
                for (const { target, kind, stored } of writeSites(node)) {
                    // A name's own rebinds come from fileRebinds below.
                    if (ts.isIdentifier(target)) continue;
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
    for (const [member, call] of memberCalls)
        for (const implementation of implementations.get(member) ?? [])
            recordCall(implementation, call);
    const pending = [...mutated];
    for (let index = 0; index < pending.length; index++) {
        for (const target of aliases.get(pending[index]!) ?? []) {
            // A write through an alias is not one of the target's own.
            otherwiseMutated.add(target);
            if (mutated.has(target)) continue;
            mutated.add(target);
            pending.push(target);
        }
    }
    // An alias's own member writes reach its targets too.
    for (const symbol of memberWrites.keys())
        for (const target of aliases.get(symbol) ?? [])
            otherwiseMutated.add(target);
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
 * Fetch-local discovery follows the selected value's declarations and calls.
 * Unknown filename fragments can select only existing files matching an
 * authored pattern in one fixed, non-root local directory. This is a package
 * inventory, not a constant value: the original expression still runs and the
 * response lookup rejects every key outside that inventory.
 */
export function assetUrlDomain(
    context: Context,
    expression: ts.Expression,
    unpackaged: (url: string) => boolean = () => false,
): Domain {
    const read = new AssetUrlDomain(context, expression).read(
        expression,
        [],
        new Map(),
    );
    const domain =
        read === nothing ? undefined : read?.filter((url) => !unpackaged(url));
    const base = deploymentUrl(context.options);
    const safe = domain?.every((source) => {
        if (/%2f|%5c|\\/i.test(source)) return false;
        const path = source.split(/[?#]/, 1)[0]!;
        let decoded: string;
        try {
            decoded = decodeURIComponent(path);
        } catch {
            return false;
        }
        if (decoded.split("/").some((part) => part === "." || part === ".."))
            return false;
        let url: URL;
        try {
            url = new URL(source, base);
        } catch {
            return false;
        }
        return (
            url.origin === base.origin &&
            !url.username &&
            !url.password &&
            !url.pathname.endsWith("/")
        );
    });
    if (domain && !safe)
        context.fail(
            expression,
            "Packaged URL provenance requires local URLs without traversal or encoded separators.",
        );
    return domain;
}

class AssetUrlDomain {
    /** @unjournaled Cycle detection for one URL-domain query, discarded with that query. */
    private readonly active = new Set<ts.Node>();
    private readonly graph: SourceGraph;
    /** @unjournaled Traversal budget for one URL-domain query, discarded with that query. */
    private remaining = 4096;
    /**
     * @unjournaled Whether the value read is an operand `??` replaces when
     * nullish: an omitted argument, a missing record member or a nullish
     * literal then contributes nothing. Operands of string operations reset it.
     */
    private nullish = false;
    /** @unjournaled The projection length where `??` replaces the value read. */
    private nullishDepth = 0;
    /** @unjournaled An optional member can produce undefined instead of throwing. */
    private optionalProjection = false;
    /** @unjournaled Bindings the enclosing conditional tests truthy: never "". */
    private readonly truthy = new Set<ts.Symbol>();

    constructor(
        private readonly context: Context,
        private readonly site: ts.Node,
    ) {
        this.graph = sourceGraph(context.checker, context.sourceFiles());
    }

    private bounded(values: Iterable<string>): readonly string[] {
        const result = new Set<string>();
        for (const value of values) {
            result.add(value);
            if (result.size > candidateLimit)
                this.context.fail(
                    this.site,
                    `Packaged URL domain exceeds ${candidateLimit} candidates.`,
                );
        }
        return [...result];
    }

    private union(domains: readonly Domain[]): Domain {
        const values = domains.filter((value) => value !== nothing);
        if (domains.length && !values.length) return nothing;
        if (values.some((value) => value?.length === 0)) return [];
        return values.length &&
            values.every(
                (value): value is readonly string[] =>
                    value !== undefined && value.length > 0,
            )
            ? this.bounded(values.flat())
            : undefined;
    }

    public read(
        expression: ts.Expression,
        projection: Projection,
        environment: Environment,
    ): Domain {
        if (--this.remaining < 0)
            this.context.fail(
                this.site,
                "Packaged URL provenance exceeds the analysis budget.",
            );
        const node = unwrapExpression(expression);
        if (this.active.has(node)) return undefined;
        this.active.add(node);
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
        projection: Projection,
        environment: Environment,
    ): Domain {
        const nullish = this.nullish;
        this.nullish = false;
        try {
            return this.read(expression, projection, environment);
        } finally {
            this.nullish = nullish;
        }
    }

    /** Reads `expression` where its nullish values are replaced (`??`). */
    private replaced(
        expression: ts.Expression,
        projection: Projection,
        environment: Environment,
    ): Domain {
        const nullish = this.nullish;
        const nullishDepth = this.nullishDepth;
        this.nullish = true;
        this.nullishDepth = projection.length;
        try {
            return this.read(expression, projection, environment);
        } finally {
            this.nullish = nullish;
            this.nullishDepth = nullishDepth;
        }
    }

    private value(
        node: ts.Expression,
        projection: Projection,
        environment: Environment,
    ): Domain {
        if (
            (this.nullish ||
                (projection.length > 0 && !this.optionalProjection)) &&
            nullishLiteral(this.context.checker, node) !== undefined
        )
            // A member read from null/undefined throws before selecting a URL.
            return nothing;
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
        if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        )
            return this.union([
                this.replaced(node.left, projection, environment),
                this.read(node.right, projection, environment),
            ]);
        if (ts.isConditionalExpression(node)) {
            const test = unwrapExpression(node.condition);
            const tested =
                ts.isIdentifier(test) &&
                resolvedSymbol(this.context.checker, test);
            const narrows = tested && !this.truthy.has(tested);
            if (narrows) this.truthy.add(tested);
            let whenTrue: Domain;
            try {
                whenTrue = this.read(node.whenTrue, projection, environment);
            } finally {
                if (narrows) this.truthy.delete(tested);
            }
            return this.union([
                whenTrue,
                this.read(node.whenFalse, projection, environment),
            ]);
        }
        return this.member(node, projection, environment);
    }

    private identifier(
        node: ts.Identifier,
        symbol: ts.Symbol,
        projection: Projection,
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
            const reaches = (path: Projection): boolean =>
                path.length <= projection.length &&
                path.every(
                    (key, index) =>
                        key === projection[index] ||
                        key === element ||
                        projection[index] === element,
                );
            return this.union([
                this.unwrittenIdentifier(node, symbol, projection, environment),
                ...memberWrites
                    .filter((write) => reaches(write.path))
                    .map((write) =>
                        this.read(
                            write.value,
                            projection.slice(write.path.length),
                            environment,
                        ),
                    ),
            ]);
        }
        if (this.graph.mutated.has(symbol)) {
            const type = this.context.checker.getTypeAtLocation(node);
            // Native browser objects (including the existing module URL
            // helper's URL) retain their separate admission mechanism.
            return isLibraryObject(this.context.checker, type) ? undefined : [];
        }
        return this.unwrittenIdentifier(node, symbol, projection, environment);
    }

    /** A binding's value as its declaration and calls give it. */
    private unwrittenIdentifier(
        node: ts.Identifier,
        symbol: ts.Symbol,
        projection: Projection,
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
            if (declaration.initializer) {
                const writes = this.graph.writes.get(symbol) ?? [];
                return this.union(
                    [declaration.initializer, ...writes].map((value) =>
                        this.read(value, projection, environment),
                    ),
                );
            }
            const loop = declaration.parent.parent;
            if (ts.isForOfStatement(loop))
                return this.read(
                    loop.expression,
                    [element, ...projection],
                    environment,
                );
        }
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
            if (
                index === 0 &&
                (ts.isArrowFunction(owner) || ts.isFunctionExpression(owner)) &&
                callee &&
                ts.isPropertyAccessExpression(callee)
            ) {
                const receiverType = this.context.checker.getTypeAtLocation(
                    callee.expression,
                );
                if (
                    (this.context.checker.isArrayType(receiverType) ||
                        this.context.checker.isTupleType(receiverType)) &&
                    arrayIterationMethods.has(callee.name.text)
                )
                    return this.read(
                        callee.expression,
                        [element, ...projection],
                        environment,
                    );
            }
            // A method may be reached through any receiver.
            if (neverRuns(this.graph, owner)) return nothing;
            return this.union(
                (this.graph.calls.get(owner) ?? []).map((call) => {
                    const input = parameterInput(
                        this.context.checker,
                        call,
                        owner,
                        index,
                    );
                    // A spread or a rest leaves the argument unknown.
                    if (input.kind === "unknown" || input.kind === "rest")
                        return undefined;
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
        projection: Projection,
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
        if (
            ts.isObjectLiteralExpression(node) &&
            typeof projection[0] === "string"
        ) {
            const key = projection[0];
            const writer = lastWriter(
                objectLiteralMembers(node, (name) =>
                    this.context.propertyName(name),
                ),
                key,
            );
            if (writer === "unknown" || (writer && !writer.value))
                return undefined;
            if (writer?.value)
                return this.read(
                    writer.value,
                    projection.slice(1),
                    environment,
                );
            // A record without the member reads undefined.
            return this.nullish && projection.length === this.nullishDepth + 1
                ? nothing
                : undefined;
        }
        // A record read by a runtime key selects one of its member values.
        if (ts.isObjectLiteralExpression(node) && projection[0] === element)
            return this.union(
                node.properties.map((property) =>
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
        if (ts.isArrayLiteralExpression(node) && projection[0] === element)
            return node.elements.length === 0
                ? nothing
                : this.union(
                      node.elements.map((value) =>
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
            const parts: Domain[] = [[node.head.text]];
            for (const span of node.templateSpans)
                parts.push(this.operand(span.expression, [], environment), [
                    span.literal.text,
                ]);
            return this.concatenate(parts);
        }
        if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
            valueKindOf(this.context.checker.getTypeAtLocation(node)) ===
                "string"
        ) {
            const parts: Domain[] = [];
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
                } else parts.push(this.operand(operand, [], environment));
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

    private returned(
        declaration: SupportedFunction,
        projection: Projection,
        environment: Environment,
    ): Domain {
        if (!declaration.body) return undefined;
        if (!ts.isBlock(declaration.body))
            return this.read(declaration.body, projection, environment);
        const values: Domain[] = [];
        forEachReturn([declaration.body], (node) => {
            values.push(
                node.expression
                    ? this.read(node.expression, projection, environment)
                    : undefined,
            );
        });
        return this.union(values);
    }

    private call(
        call: ts.CallExpression,
        projection: Projection,
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
        const callee = unwrapExpression(call.expression);
        if (!ts.isPropertyAccessExpression(callee)) return undefined;
        const method = callee.name.text;
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
                ? objectIdentityCallArgument(call, (node) =>
                      this.context.libraryGlobal(node),
                  )
                : undefined;
        if (frozen) return this.read(frozen, projection, environment);
        const receiverType = this.context.checker.getTypeAtLocation(
            callee.expression,
        );
        const array =
            this.context.checker.isArrayType(receiverType) ||
            this.context.checker.isTupleType(receiverType);
        if (array && ["find", "at"].includes(method))
            return this.read(
                callee.expression,
                [element, ...projection],
                environment,
            );
        if (array && ["slice", "filter"].includes(method))
            return this.read(callee.expression, projection, environment);
        const from =
            method === "from" &&
            this.context.libraryGlobal(callee.expression) === "Array";
        if (
            (from || (array && method === "map")) &&
            projection[0] === element
        ) {
            const callback = call.arguments[from ? 1 : 0];
            const iterable = from ? call.arguments[0] : callee.expression;
            if (
                callback &&
                iterable &&
                isObjectIdentityFunction(callback, (node) =>
                    this.context.libraryGlobal(node),
                )
            )
                return this.read(iterable, projection, environment);
            if (
                !callback ||
                !(
                    ts.isArrowFunction(callback) ||
                    ts.isFunctionExpression(callback)
                )
            )
                return undefined;
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
                        projection: [element],
                        environment,
                    });
            }
            return this.returned(callback, projection.slice(1), nested);
        }
        if (projection.length || valueKindOf(receiverType) !== "string")
            return undefined;
        const source = this.operand(callee.expression, [], environment);
        if (!source) return undefined;
        if (
            (method === "replace" || method === "replaceAll") &&
            call.arguments.length === 2
        ) {
            const replacement = this.operand(
                call.arguments[1]!,
                [],
                environment,
            );
            const patternNode = unwrapExpression(call.arguments[0]!);
            const regex = ts.isRegularExpressionLiteral(patternNode)
                ? regularExpressionParts(patternNode)
                : undefined;
            const patterns = regex
                ? [new RegExp(regex.pattern, regex.flags)]
                : this.operand(patternNode, [], environment);
            if (!replacement || !patterns) return [];
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
        projection: Projection,
        environment: Environment,
    ): Domain {
        const root = unwrapExpression(receiver);
        const symbol =
            ts.isIdentifier(root) && resolvedSymbol(this.context.checker, root);
        const registry = symbol ? this.graph.registries.get(symbol) : undefined;
        if (!registry || (!projection.length && !this.nullish))
            return undefined;
        const domains = registry.values.map((value) =>
            this.read(value, projection, environment),
        );
        if (registry.pushed.length) {
            if (projection[0] !== element) return undefined;
            domains.push(
                ...registry.pushed.map((value) =>
                    this.read(value, projection.slice(1), environment),
                ),
            );
        }
        return domains.length ? this.union(domains) : nothing;
    }

    private concatenate(parts: readonly Domain[]): Domain {
        // A part no value reaches means the string is never built.
        if (parts.includes(nothing)) return nothing;
        if (parts.some((part) => part?.length === 0)) return [];
        let patterns: (string | undefined)[][] = [[]];
        for (const part of parts) {
            if (patterns.length * (part?.length ?? 1) > candidateLimit)
                this.context.fail(
                    this.site,
                    `Packaged URL domain exceeds ${candidateLimit} candidates.`,
                );
            patterns = patterns.flatMap((prefix) =>
                (part ?? [undefined]).map((value) => [...prefix, value]),
            );
        }
        return this.union(
            patterns.map((pattern) =>
                pattern.every((part) => part !== undefined)
                    ? [pattern.join("")]
                    : this.files(pattern),
            ),
        );
    }

    private files(parts: readonly (string | undefined)[]): Domain {
        const first = parts.indexOf(undefined);
        const prefix = parts.slice(0, first).join("");
        const slash = prefix.lastIndexOf("/");
        if (slash < 1 || prefix.includes("?") || prefix.includes("#"))
            return undefined;
        const logicalDirectory = prefix.slice(0, slash + 1);
        const base = deploymentUrl(this.context.options);
        const logicalUrl = new URL(logicalDirectory, base);
        if (
            logicalUrl.origin !== base.origin ||
            logicalUrl.pathname === base.pathname ||
            /%2f|%5c|\\/i.test(
                parts.filter((part) => part !== undefined).join(""),
            )
        )
            return undefined;
        let decoded: string;
        try {
            decoded = decodeURIComponent(logicalDirectory);
        } catch {
            return undefined;
        }
        if (decoded.split("/").some((part) => part === "." || part === ".."))
            return undefined;
        let source: string;
        // Root-path arguments may be prefixed by the deployment base in a
        // helper. Discovery is provisional; final keys resolve through the
        // normal deployment resolver after the helper's transformations.
        const discovery =
            logicalDirectory.startsWith("/") && this.context.options.publicDir
                ? { ...this.context.options, siteUrl: base.origin + "/" }
                : this.context.options;
        try {
            source = resolveBundledAsset(
                logicalDirectory,
                this.context.options.fileName,
                discovery,
            );
        } catch {
            return undefined;
        }
        if (/^[a-z][a-z\d+.-]*:\/\//i.test(source)) return undefined;
        const directory = resolve(
            dirname(resolve(this.context.options.fileName)),
            source,
        );
        // The authored directory must stay below its deployment or entry root.
        const root = resolve(
            this.context.options.publicDir ??
                dirname(resolve(this.context.options.fileName)),
        );
        const path = relative(root, directory);
        if (
            !path ||
            isAbsolute(path) ||
            path === ".." ||
            path.startsWith("..\\") ||
            path.startsWith("../")
        )
            return undefined;
        const pattern = parts
            .map((part) =>
                part === undefined
                    ? "[^/?#\\\\]*"
                    : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
            )
            .join("");
        const query =
            parts
                .slice(first + 1)
                .join("")
                .match(/[?#].*$/)?.[0] ?? "";
        // A dynamic query is not a finite packaged URL domain.
        let inQuery = false;
        for (const part of parts) {
            if (part === undefined && inQuery) return [];
            if (part !== undefined && /[?#]/.test(part)) inQuery = true;
        }
        const match = new RegExp(`^${pattern}$`);
        let files;
        try {
            files = readdirSync(directory, { withFileTypes: true });
        } catch {
            return undefined;
        }
        if (files.length > 4096)
            this.context.fail(
                this.site,
                "Packaged URL directory exceeds the discovery budget.",
            );
        return this.bounded(
            files
                .filter((file) => file.isFile())
                .flatMap((file) =>
                    [
                        logicalDirectory + file.name + query,
                        logicalDirectory +
                            encodeURIComponent(file.name) +
                            query,
                    ].filter((value) => match.test(value)),
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
