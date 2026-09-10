import ts from "typescript";
import { EmissionMap, EmissionWeakMap, isCompilerInput } from "./emission-transaction.js";
import type { LoweringServices } from "./lowering-services.js";
import { forEachAnalysisNode } from "./analysis-walk.js";

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
    private nextObject = 0;
    private readonly entries = new EmissionMap<ts.Node, Map<string, T>>();

    private identity(value: object): number {
        let id = this.objects.get(value);
        if (id === undefined) { id = this.nextObject++; this.objects.set(value, id); }
        return id;
    }

    key(scope: FunctionEmissionScope, values: readonly unknown[]): string {
        const seen = new Map<object, number>();
        const encode = (value: unknown): string => {
            if (value === null) return "null";
            if (typeof value === "number" && Object.is(value, -0)) return "number:-0";
            if (typeof value === "symbol") {
                if (!this.symbols.has(value)) this.symbols.set(value, this.symbols.size);
                return `symbol:${this.symbols.get(value)}`;
            }
            if (typeof value === "function") return `function:${this.identity(value)}`;
            if (typeof value !== "object") return `${typeof value}:${JSON.stringify(String(value))}`;
            if (isCompilerInput(value)) return `input:${this.identity(value)}`;
            const previous = seen.get(value);
            if (previous !== undefined) return `ref:${previous}`;
            seen.set(value, seen.size);
            if (Array.isArray(value)) return `[${value.map(encode).join(",")}]`;
            if (value instanceof Map) return `map:[${[...value].map(([key, item]) => `${encode(key)}=${encode(item)}`).join(",")}]`;
            if (value instanceof Set) return `set:[${[...value].map(encode).join(",")}]`;
            if (ArrayBuffer.isView(value)) return `view:${this.identity(Object.getPrototypeOf(value))}:${Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)).join(",")}`;
            if (value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) {
                return `buffer:${this.identity(Object.getPrototypeOf(value))}:${Array.from(new Uint8Array(value)).join(",")}`;
            }
            const prototype: unknown = Object.getPrototypeOf(value);
            if (prototype !== Object.prototype && prototype !== null) return `object:${this.identity(value)}`;
            return `{${Reflect.ownKeys(value).map(name => ({ name, key: encode(name) }))
                .sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0).map(({ name, key }) => {
                const descriptor = Object.getOwnPropertyDescriptor(value, name)!;
                return `${key}:${"value" in descriptor ? encode(descriptor.value) : `accessor:${encode(descriptor.get)}:${encode(descriptor.set)}`}`;
            }).join(",")}}`;
        };
        return `${this.identity(scope.lexical)}:${scope.emission}:${scope.block}:${scope.continuation}:${encode(values)}`;
    }

    get(declaration: ts.Node, key: string): T | undefined { return this.entries.get(declaration)?.get(key); }
    set(declaration: ts.Node, key: string, value: T): void {
        let entries = this.entries.get(declaration);
        if (!entries) { entries = new EmissionMap(); this.entries.set(declaration, entries); }
        entries.set(key, value);
    }
}

/** Read lexical dependencies of the body and the source helpers it calls. */
const dependencyCache = new EmissionWeakMap<ts.TypeChecker, WeakMap<ts.FunctionLikeDeclaration, readonly ts.Identifier[]>>();

function dependencyIdentifiers(checker: ts.TypeChecker, root: ts.FunctionLikeDeclaration): readonly ts.Identifier[] {
    let cache = dependencyCache.get(checker);
    if (!cache) { cache = new EmissionWeakMap(); dependencyCache.set(checker, cache); }
    const cached = cache.get(root);
    if (cached) return cached;
    const functions = new Set<ts.FunctionLikeDeclaration>();
    const identifiers = new Map<ts.Symbol, ts.Identifier>();
    const visitFunction = (fn: ts.FunctionLikeDeclaration): void => {
        if (functions.has(fn) || !fn.body || fn.getSourceFile().isDeclarationFile) return;
        functions.add(fn);
        forEachAnalysisNode(fn.body, node => {
            if (ts.isIdentifier(node)) {
                const symbol = checker.getSymbolAtLocation(node);
                if (symbol && !identifiers.has(symbol)) identifiers.set(symbol, node);
            }
            if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
                const called = checker.getResolvedSignature(node)?.declaration;
                if (called && (ts.isFunctionDeclaration(called) || ts.isFunctionExpression(called) ||
                    ts.isArrowFunction(called) || ts.isMethodDeclaration(called) || ts.isConstructorDeclaration(called))) visitFunction(called);
            }
            if (ts.isPropertyAccessExpression(node)) {
                for (const declaration of checker.getSymbolAtLocation(node.name)?.declarations ?? []) {
                    if (ts.isGetAccessorDeclaration(declaration) || ts.isSetAccessorDeclaration(declaration)) visitFunction(declaration);
                }
            }
        }, { types: "skip", memberNames: "skip" });
    };
    visitFunction(root);
    const inside = (declaration: ts.Declaration): boolean => [...functions].some(fn =>
        fn.getSourceFile() === declaration.getSourceFile() && fn.pos <= declaration.pos && fn.end >= declaration.end);
    const result = [...identifiers].flatMap(([symbol, identifier]) => symbol.declarations?.some(inside) ? [] : [identifier]);
    cache.set(root, result);
    return result;
}

export function functionDependencies(
    context: Pick<LoweringServices, "checker" | "lookupIdentifierValue">,
    roots: readonly ts.FunctionLikeDeclaration[],
): unknown[] {
    return [...new Set(roots.flatMap(root => dependencyIdentifiers(context.checker, root)))].flatMap(identifier => {
        const value = context.lookupIdentifierValue(identifier);
        return value ? [[context.checker.getSymbolAtLocation(identifier), value]] : [];
    });
}
