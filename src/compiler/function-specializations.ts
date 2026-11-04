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
    libraryGlobal,
    calledDeclaration,
    calledFunction,
    memberAccessors,
} from "./symbols.js";
import { isSupportedFunction } from "./syntax.js";

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

    key(scope: FunctionEmissionScope, values: readonly unknown[]): string {
        const seen = new Map<object, number>();
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
            tokens.push("{");
            for (let index = 0; index < properties.length; index++) {
                const { name, key } = properties[index]!;
                if (index) tokens.push(",");
                tokens.push(key, ":");
                const descriptor = Object.getOwnPropertyDescriptor(
                    value,
                    name,
                )!;
                if ("value" in descriptor) encode(descriptor.value);
                else {
                    tokens.push("accessor:");
                    // eslint-disable-next-line @typescript-eslint/unbound-method -- Snapshot accessor identities without invoking them.
                    encode(descriptor.get);
                    tokens.push(":");
                    // eslint-disable-next-line @typescript-eslint/unbound-method -- Snapshot accessor identities without invoking them.
                    encode(descriptor.set);
                }
            }
            tokens.push("}");
        };
        encode(values);
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

/** Read lexical dependencies of the body and the source helpers it calls. */
const dependencyCache = new WeakMap<
    ts.TypeChecker,
    WeakMap<ts.FunctionLikeDeclaration, readonly ts.Identifier[]>
>();

function dependencyIdentifiers(
    checker: ts.TypeChecker,
    root: ts.FunctionLikeDeclaration,
): readonly ts.Identifier[] {
    let cache = dependencyCache.get(checker);
    if (!cache) {
        cache = new WeakMap();
        dependencyCache.set(checker, cache);
    }
    const cached = cache.get(root);
    if (cached) return cached;
    const functions = new Set<ts.FunctionLikeDeclaration>();
    const identifiers = new Map<ts.Symbol, ts.Identifier>();
    const visitFunction = (fn: ts.FunctionLikeDeclaration): void => {
        if (
            functions.has(fn) ||
            !fn.body ||
            fn.getSourceFile().isDeclarationFile
        )
            return;
        functions.add(fn);
        forEachAnalysisNode(
            fn.body,
            (node) => {
                if (ts.isIdentifier(node)) {
                    const symbol = declaredSymbol(checker, node);
                    if (symbol && !identifiers.has(symbol))
                        identifiers.set(symbol, node);
                }
                if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
                    const called = ts.isNewExpression(node)
                        ? calledDeclaration(checker, node)
                        : calledFunction(checker, node);
                    if (
                        isSupportedFunction(called) ||
                        (called && ts.isConstructorDeclaration(called))
                    )
                        visitFunction(called);
                }
                if (
                    ts.isPropertyAccessExpression(node) ||
                    ts.isElementAccessExpression(node)
                )
                    for (const accessor of memberAccessors(
                        checker,
                        node,
                        "either",
                    ))
                        visitFunction(accessor);
            },
            { types: "skip", names: "references" },
        );
    };
    visitFunction(root);
    const inside = (declaration: ts.Declaration): boolean =>
        [...functions].some(
            (fn) =>
                fn.getSourceFile() === declaration.getSourceFile() &&
                fn.pos <= declaration.pos &&
                fn.end >= declaration.end,
        );
    const result = [...identifiers].flatMap(([symbol, identifier]) =>
        symbol.declarations?.some(inside) ? [] : [identifier],
    );
    cache.set(root, result);
    return result;
}

export function functionDependencies(
    context: Pick<
        LoweringServices,
        "checker" | "bindings" | "platformDocumentHidden"
    >,
    roots: readonly ts.FunctionLikeDeclaration[],
): unknown[] {
    return [
        ...new Set(
            roots.flatMap((root) =>
                dependencyIdentifiers(context.checker, root),
            ),
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
