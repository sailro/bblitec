import ts from "typescript";
import {
    EmissionMap,
    EmissionWeakMap,
    journaled,
} from "./emission-transaction.js";
import type { LoweringServices } from "./lowering-services.js";
import { forEachAnalysisNode } from "./analysis-walk.js";
import {
    declaredSymbol,
    declaredInDefaultLibrary,
    libraryGlobal,
    calledDeclaration,
    calledFunction,
    memberAccessors,
    resolvedSymbol,
    staticAccessKey,
    staticPropertyKey,
    valueSymbolOf,
} from "./symbols.js";
import {
    bindingElementKey,
    classBaseExpression,
    functionOfDeclaration,
    isSupportedFunction,
} from "./syntax.js";
import {
    dispatchedClassMembers,
    isStaticMember,
    localClassOfSymbol,
    protocolClassMembers,
    runTimeKeyMayRunClassCode,
} from "./class-members.js";

/** AST nodes, checker types and symbols are immutable compiler inputs. */
function isCompilerInput(value: object): boolean {
    return (
        ("kind" in value &&
            typeof value.kind === "number" &&
            "pos" in value &&
            typeof value.pos === "number" &&
            "end" in value &&
            typeof value.end === "number") ||
        ("getFlags" in value && typeof value.getFlags === "function")
    );
}

/** A parsed or factory syntax node. */
function isSyntaxNode(value: unknown): value is ts.Node {
    return (
        typeof value === "object" &&
        value !== null &&
        "kind" in value &&
        typeof value.kind === "number" &&
        "getSourceFile" in value
    );
}

/** An own data property, read without running an accessor. */
function ownData(value: object, name: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

/** What a key reads code with: the program the code is in. */
export type SpecializationReads = Pick<LoweringServices, "checker" | "program">;

/**
 * The fields through which a value shares generation state with another:
 * the aggregates the scope-wide searches of a lowering match a binding by
 * (its holder, its collection facts, its callback's owner).
 */
const sharedStateFields = [
    "tupleElements",
    "staticElements",
    "staticElementsOwner",
    "collectionCardinality",
    "callbackRecordOwner",
    "recordProperties",
] as const;

export interface FunctionEmissionScope {
    readonly lexical: object;
    readonly emission: number;
    readonly block: number;
    readonly continuation: number;
}

/** Structural snapshots retain mutable specialization facts and alias topology. */
export class FunctionSpecializations<T> {
    private readonly objects = new EmissionWeakMap<object, number>();
    private readonly symbols = new EmissionMap<symbol, number>();
    @journaled private accessor nextObject = 0;
    private readonly entries = new EmissionMap<ts.Node, Map<string, T>>();
    /**
     * @unjournaled Ordered string-property schemas depend only on immutable
     * name sequences: a trie over each object's own names, in order.
     */
    private readonly propertySchemas: PropertySchemaNode = {
        next: new Map(),
    };

    private identity(value: object): number {
        let id = this.objects.get(value);
        if (id === undefined) {
            id = this.nextObject++;
            this.objects.set(value, id);
        }
        return id;
    }

    /**
     * A captured scope chain (`recordScopes`) holds only the bindings the
     * code that runs in it reads ({@link scopeBindings}): an owner's own
     * methods, getters and setters, and, beside a callback, its
     * declaration. Each scope keeps its place and its identity in the
     * key. An unread binding that shares state with what the key holds is
     * added at the end, so the alias topology the scope-wide searches of
     * a lowering see stays in the key.
     */
    key(
        scope: FunctionEmissionScope,
        values: readonly unknown[],
        reads: SpecializationReads,
    ): string {
        const seen = new Map<object, number>();
        const cpps = new Set<string>();
        const scopes = new Map<
            Map<unknown, unknown>,
            { readonly id: number; readonly included: Set<unknown> }
        >();
        const tokens = [
            `${this.identity(scope.lexical)}:${scope.emission}:${scope.block}:${scope.continuation}:`,
        ];
        const symbolKey = (value: symbol): string => {
            if (!this.symbols.has(value))
                this.symbols.set(value, this.symbols.size);
            return `symbol:${this.symbols.get(value)}`;
        };
        const propertySchema = (value: object) => {
            const names = Reflect.ownKeys(value);
            // A symbol's key is renumbered with its journaled registry, so
            // only all-string schemas are kept.
            let node: PropertySchemaNode | undefined = this.propertySchemas;
            for (const name of names) {
                if (typeof name === "symbol") {
                    node = undefined;
                    break;
                }
                let child: PropertySchemaNode | undefined = node.next.get(name);
                if (!child)
                    node.next.set(
                        name,
                        (child = {
                            next: new Map<string, PropertySchemaNode>(),
                        }),
                    );
                node = child;
            }
            if (node?.properties) return node.properties;
            const properties = names
                .map((name) => ({
                    name,
                    key:
                        typeof name === "symbol"
                            ? symbolKey(name)
                            : `string:${JSON.stringify(name)}`,
                }))
                .sort((left, right) =>
                    left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
                );
            if (node) node.properties = properties;
            return properties;
        };
        const projectScopes = (
            chain: readonly unknown[],
            code: readonly ts.Node[],
        ): void => {
            const read = scopeBindings(reads, code);
            // Code whose reads the walk cannot name keeps its whole scope.
            if (!read) {
                encode(chain);
                return;
            }
            tokens.push("scopes:[");
            for (let index = 0; index < chain.length; index++) {
                if (index) tokens.push(",");
                const bindings = chain[index];
                if (!(bindings instanceof Map)) {
                    encode(bindings);
                    continue;
                }
                let entry = scopes.get(bindings);
                if (!entry) {
                    entry = { id: scopes.size, included: new Set() };
                    scopes.set(bindings, entry);
                }
                tokens.push(`scope:${entry.id}:[`);
                let first = true;
                for (const symbol of read) {
                    if (!bindings.has(symbol)) continue;
                    if (!first) tokens.push(",");
                    first = false;
                    entry.included.add(symbol);
                    encode(symbol);
                    tokens.push("=");
                    encode(bindings.get(symbol));
                }
                tokens.push("]");
            }
            tokens.push("]");
        };
        const held = (value: unknown): boolean =>
            typeof value === "object" && value !== null && seen.has(value);
        const sharesValueState = (value: unknown): boolean => {
            if (typeof value !== "object" || value === null) return false;
            if (seen.has(value)) return true;
            const cpp = ownData(value, "cpp");
            if (typeof cpp === "string" && cpps.has(cpp)) return true;
            // An engine in scope is an implicit resource context.
            const dataType = ownData(value, "dataType");
            if (
                ownData(value, "kind") === "engine" ||
                (typeof dataType === "object" &&
                    dataType !== null &&
                    ownData(dataType, "handle") === "engine")
            )
                return true;
            return sharedStateFields.some((name) => held(ownData(value, name)));
        };
        const sharesState = (binding: unknown): boolean => {
            if (typeof binding !== "object" || binding === null) return false;
            if (seen.has(binding)) return true;
            const value = ownData(binding, "value");
            if (sharesValueState(value)) return true;
            const members =
                typeof value === "object" && value !== null
                    ? ownData(value, "recordProperties")
                    : undefined;
            return (
                typeof members === "object" &&
                members !== null &&
                Object.values(members).some(sharesValueState)
            );
        };
        const encode = (value: unknown): void => {
            if (value === null) {
                tokens.push("null");
                return;
            }
            if (typeof value === "number" && Object.is(value, -0)) {
                tokens.push("number:-0");
                return;
            }
            if (typeof value === "symbol") {
                tokens.push(symbolKey(value));
                return;
            }
            if (typeof value === "function") {
                tokens.push(`function:${this.identity(value)}`);
                return;
            }
            if (typeof value === "string") {
                tokens.push(`string:${JSON.stringify(value)}`);
                return;
            }
            // A number's or boolean's text holds no delimiter (`,]}=:`).
            if (typeof value === "number" || typeof value === "boolean") {
                tokens.push(`${typeof value}:${value}`);
                return;
            }
            if (value === undefined || typeof value === "bigint") {
                tokens.push(`${typeof value}:${JSON.stringify(String(value))}`);
                return;
            }
            if (isCompilerInput(value)) {
                tokens.push(`input:${this.identity(value)}`);
                return;
            }
            const previous = seen.get(value);
            if (previous !== undefined) {
                tokens.push(`ref:${previous}`);
                return;
            }
            seen.set(value, seen.size);
            if (Array.isArray(value)) {
                tokens.push("[");
                const length = value.length;
                for (let index = 0; index < length; index++) {
                    if (index) tokens.push(",");
                    if (index in value) encode(value[index]);
                }
                tokens.push("]");
                return;
            }
            if (value instanceof Map) {
                tokens.push("map:[");
                let first = true;
                for (const [key, item] of value) {
                    if (!first) tokens.push(",");
                    first = false;
                    encode(key);
                    tokens.push("=");
                    encode(item);
                }
                tokens.push("]");
                return;
            }
            if (value instanceof Set) {
                tokens.push("set:[");
                let first = true;
                for (const item of value) {
                    if (!first) tokens.push(",");
                    first = false;
                    encode(item);
                }
                tokens.push("]");
                return;
            }
            const prototype: unknown = Object.getPrototypeOf(value);
            if (
                ArrayBuffer.isView(value) ||
                value instanceof ArrayBuffer ||
                value instanceof SharedArrayBuffer
            ) {
                if (prototype === null || typeof prototype !== "object") {
                    throw new Error(
                        "Compiler buffer snapshots require an object prototype.",
                    );
                }
                const view = ArrayBuffer.isView(value);
                const bytes = view
                    ? new Uint8Array(
                          value.buffer,
                          value.byteOffset,
                          value.byteLength,
                      )
                    : new Uint8Array(value);
                tokens.push(
                    `${view ? "view" : "buffer"}:${this.identity(prototype)}:${Array.from(bytes).join(",")}`,
                );
                return;
            }
            if (prototype !== Object.prototype && prototype !== null) {
                tokens.push(`object:${this.identity(value)}`);
                return;
            }
            const properties = propertySchema(value);
            const cpp = ownData(value, "cpp");
            if (typeof cpp === "string" && cpp !== "") cpps.add(cpp);
            tokens.push("{");
            for (let index = 0; index < properties.length; index++) {
                const { name, key } = properties[index]!;
                if (index) tokens.push(",");
                tokens.push(key, ":");
                const descriptor = Object.getOwnPropertyDescriptor(
                    value,
                    name,
                )!;
                if (
                    name === "recordScopes" &&
                    "value" in descriptor &&
                    Array.isArray(descriptor.value)
                )
                    projectScopes(descriptor.value, ownCode(value));
                else if ("value" in descriptor) encode(descriptor.value);
                else {
                    tokens.push("accessor:");
                    // eslint-disable-next-line @typescript-eslint/unbound-method -- Snapshot accessor identities without invoking them.
                    encode(descriptor.get);
                    tokens.push(":");
                    // eslint-disable-next-line @typescript-eslint/unbound-method -- Snapshot accessor identities without invoking them.
                    encode(descriptor.set);
                }
            }
            // A callback runs its declaration in its owner's scopes.
            const declaration = ownData(value, "callbackDeclaration");
            const owner = ownData(value, "callbackRecordOwner");
            const chain =
                typeof owner === "object" && owner !== null
                    ? ownData(owner, "recordScopes")
                    : undefined;
            if (isSyntaxNode(declaration) && Array.isArray(chain)) {
                tokens.push(",callbackScopes:");
                projectScopes(chain, [declaration]);
            }
            tokens.push("}");
        };
        encode(values);
        for (let grew = true; grew;) {
            grew = false;
            for (const [bindings, { id, included }] of scopes)
                for (const [symbol, binding] of bindings) {
                    if (included.has(symbol) || !sharesState(binding)) continue;
                    included.add(symbol);
                    grew = true;
                    tokens.push(`alias:${id}:`);
                    encode(symbol);
                    tokens.push("=");
                    encode(binding);
                }
        }
        return tokens.join("");
    }

    get(declaration: ts.Node, key: string): T | undefined {
        return this.entries.get(declaration)?.get(key);
    }
    set(declaration: ts.Node, key: string, value: T): void {
        let entries = this.entries.get(declaration);
        if (!entries) {
            entries = new EmissionMap();
            this.entries.set(declaration, entries);
        }
        entries.set(key, value);
    }
}

/**
 * What code reads, through the code it runs: each name it reads or writes,
 * first reference first, keyed by its declared symbol, and the code walked.
 * The walk follows the functions a name refers to (a callback named), the
 * calls the code makes, a constructed class's construction code (its
 * constructor and field initializers, its base's too), the accessors and
 * class members a member access or an object pattern may run
 * ({@link dispatchedClassMembers}: an override, or a class read through an
 * interface or `any`) and the class members the language calls itself
 * ({@link protocolClassMembers}). `unfollowed` is the first place where
 * code may run that no name declares: a key only the run time knows on a
 * receiver that may hold class code, a construction of a class no name
 * declares, `eval`, `Reflect` or `with`.
 */
interface CodeReads {
    readonly names: ReadonlyMap<ts.Symbol, ts.Identifier>;
    /** The symbols scope bindings are kept under ({@link valueSymbolOf}). */
    readonly bindings: ReadonlySet<ts.Symbol>;
    readonly code: ReadonlySet<ts.Node>;
    readonly unfollowed: ts.Node | undefined;
}

/** @unjournaled Derived from the program alone, per code root. */
const codeReadsCache = new WeakMap<
    ts.TypeChecker,
    WeakMap<ts.Node, CodeReads>
>();

function codeReads(reads: SpecializationReads, root: ts.Node): CodeReads {
    const { checker, program } = reads;
    let cache = codeReadsCache.get(checker);
    if (!cache) {
        cache = new WeakMap();
        codeReadsCache.set(checker, cache);
    }
    const cached = cache.get(root);
    if (cached) return cached;
    const names = new Map<ts.Symbol, ts.Identifier>();
    const bindings = new Set<ts.Symbol>();
    const code = new Set<ts.Node>();
    let unfollowed: ts.Node | undefined;
    const pending: ts.Node[] = [
        root,
        ...protocolClassMembers(checker, program),
    ];
    const follow = (node: ts.Node | undefined): void => {
        if (node && !code.has(node)) pending.push(node);
    };
    const construct = (declaration: ts.ClassLikeDeclaration): void => {
        if (code.has(declaration)) return;
        code.add(declaration);
        for (const member of declaration.members)
            if (
                ts.isConstructorDeclaration(member) ||
                (ts.isPropertyDeclaration(member) && !isStaticMember(member))
            )
                follow(member);
        const base = classBaseExpression(declaration);
        if (base) {
            follow(base);
            const extended = localClassOfSymbol(
                resolvedSymbol(checker, base.expression),
            );
            if (extended) construct(extended);
        }
    };
    const name = (identifier: ts.Identifier): void => {
        const symbol = declaredSymbol(checker, identifier);
        if (!symbol || names.has(symbol)) return;
        names.set(symbol, identifier);
        bindings.add(symbol);
        const binding = valueSymbolOf(checker, identifier);
        if (binding) bindings.add(binding);
    };
    const dispatch = (
        key: string | undefined,
        receiver: ts.Node,
        at: ts.Node,
    ): void => {
        const type = checker.getTypeAtLocation(receiver);
        if (key !== undefined)
            for (const member of dispatchedClassMembers(
                checker,
                program,
                key,
                type,
            ))
                follow(member);
        else if (runTimeKeyMayRunClassCode(checker, program, type))
            unfollowed ??= at;
    };
    for (let next = pending.pop(); next; next = pending.pop()) {
        if (code.has(next) || next.getSourceFile().isDeclarationFile) continue;
        code.add(next);
        forEachAnalysisNode(
            next,
            (node) => {
                if (ts.isIdentifier(node)) {
                    name(node);
                    const target = resolvedSymbol(checker, node);
                    const declaration = target?.valueDeclaration;
                    follow(declaration && functionOfDeclaration(declaration));
                    if (
                        (node.text === "eval" || node.text === "Reflect") &&
                        declaredInDefaultLibrary(target)
                    )
                        unfollowed ??= node;
                    return;
                }
                if (ts.isWithStatement(node)) unfollowed ??= node;
                if (
                    ts.isCallExpression(node) ||
                    ts.isNewExpression(node) ||
                    ts.isTaggedTemplateExpression(node)
                ) {
                    const called = ts.isNewExpression(node)
                        ? calledDeclaration(checker, node)
                        : calledFunction(checker, node);
                    if (isSupportedFunction(called)) follow(called);
                    if (ts.isNewExpression(node)) {
                        const constructed = localClassOfSymbol(
                            resolvedSymbol(checker, node.expression),
                        );
                        if (constructed) construct(constructed);
                        else if (!called?.getSourceFile().isDeclarationFile)
                            unfollowed ??= node;
                    }
                }
                if (
                    ts.isPropertyAccessExpression(node) ||
                    ts.isElementAccessExpression(node)
                ) {
                    for (const accessor of memberAccessors(
                        checker,
                        node,
                        "either",
                    ))
                        follow(accessor);
                    // A namespace member reads its module's binding.
                    if (ts.isPropertyAccessExpression(node))
                        if (ts.isIdentifier(node.name)) name(node.name);
                    dispatch(
                        staticAccessKey(checker, node),
                        node.expression,
                        node,
                    );
                }
                if (
                    ts.isBindingElement(node) &&
                    ts.isObjectBindingPattern(node.parent)
                )
                    dispatch(bindingElementKey(node), node.parent, node);
                if (
                    ts.isBinaryExpression(node) &&
                    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                    ts.isObjectLiteralExpression(node.left)
                )
                    for (const property of node.left.properties)
                        dispatch(
                            property.name &&
                                staticPropertyKey(checker, property.name),
                            node.right,
                            property,
                        );
            },
            { types: "skip", names: "references" },
        );
    }
    const result = { names, bindings, code, unfollowed };
    cache.set(root, result);
    return result;
}

/** Read lexical dependencies of the body and the code it runs ({@link codeReads}). */
function dependencyIdentifiers(
    reads: SpecializationReads,
    root: ts.FunctionLikeDeclaration,
): readonly ts.Identifier[] {
    const { names, code } = codeReads(reads, root);
    const contains = (outer: ts.Node, inner: ts.Node): boolean =>
        outer.getSourceFile() === inner.getSourceFile() &&
        outer.pos <= inner.pos &&
        outer.end >= inner.end;
    // A local of code the root is nested in is the root's free variable.
    const inside = (declaration: ts.Declaration): boolean =>
        [...code].some(
            (walked) =>
                contains(walked, declaration) &&
                (walked === root || !contains(walked, root)),
        );
    return [...names].flatMap(([symbol, identifier]) =>
        symbol.declarations?.some(inside) ? [] : [identifier],
    );
}

/**
 * The bindings a captured scope chain holds for code that runs in it: the
 * names it reads or writes, its own locals included (a callback created
 * inside its own invocation closes over them). Undefined when the walk
 * met code it cannot name ({@link CodeReads.unfollowed}): that code may
 * read any binding, so its scope is kept whole.
 */
function scopeBindings(
    reads: SpecializationReads,
    roots: readonly ts.Node[],
): ReadonlySet<ts.Symbol> | undefined {
    if (roots.length === 1) {
        const only = codeReads(reads, roots[0]!);
        return only.unfollowed ? undefined : only.bindings;
    }
    const union = new Set<ts.Symbol>();
    for (const root of roots) {
        const { bindings, unfollowed } = codeReads(reads, root);
        if (unfollowed) return undefined;
        for (const symbol of bindings) union.add(symbol);
    }
    return union;
}

/** The methods, getters and setters a record runs in its own scopes. */
function ownCode(value: object): ts.Node[] {
    return ["recordMethods", "recordGetters", "recordSetters"].flatMap(
        (name) => {
            const members = ownData(value, name);
            return typeof members === "object" && members !== null
                ? Object.values(members).filter(isSyntaxNode)
                : [];
        },
    );
}

export function functionDependencies(
    context: Pick<
        LoweringServices,
        "checker" | "program" | "bindings" | "platformDocumentHidden"
    >,
    roots: readonly ts.FunctionLikeDeclaration[],
): unknown[] {
    return [
        ...new Set(
            roots.flatMap((root) => dependencyIdentifiers(context, root)),
        ),
    ].flatMap((identifier): unknown[] => {
        const value = context.bindings.lookupOptional(identifier);
        // Document visibility is supplied by the current platform dispatch.
        // A helper used by two listeners must capture each listener's parameter.
        const visibility =
            !value &&
            identifier.text === "document" &&
            libraryGlobal(context.checker, identifier) === "document"
                ? context.platformDocumentHidden()
                : undefined;
        return value
            ? [[declaredSymbol(context.checker, identifier), value]]
            : visibility !== undefined
              ? [[declaredSymbol(context.checker, identifier), visibility]]
              : [];
    });
}

/** One step of the property-schema trie: the sorted properties of the names so far. */
interface PropertySchemaNode {
    readonly next: Map<string, PropertySchemaNode>;
    properties?: readonly { name: string | symbol; key: string }[];
}
