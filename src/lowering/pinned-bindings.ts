import ts from "typescript";
import { declaredSymbol } from "../compiler/symbols.js";
import { unwrapExpression } from "../compiler/syntax.js";
import { moduleSymbols } from "../pinned-program.js";

type Root = ts.Symbol | ts.Node | symbol;
interface BindingKey {
    readonly root: Root;
    readonly path: readonly string[];
}
interface Entry<T> {
    readonly path: readonly string[];
    readonly value: T;
}
type Bindings<T> = Map<Root, Map<string, Entry<T>>>;

/** Source bindings use declaration identity and structural member paths. */
export class PinnedBindings<T> {
    private readonly ports: Bindings<T> = new Map();
    private locals: Bindings<T> = new Map();
    private readonly external = new Map<string, symbol>();
    private readonly identities = new Map<Root, number>();
    private initialized = false;
    private readonly regionDeclarations = new WeakMap<
        ts.Node,
        ReadonlyMap<string, readonly ts.Symbol[]>
    >();

    constructor(private readonly input: ReadonlyMap<string, T>) {}

    /** Resolve the caller's named ports once, at the region's entry scope. */
    public enter(at: ts.Node): void {
        if (this.initialized) return;
        at = this.sourceScope(at);
        this.initialized = true;
        for (const [name, value] of this.input) {
            // Native macro names reserve C++ spellings; they are not source ports.
            if (name.startsWith("@native-macro:")) continue;
            this.put(this.ports, this.portKey(name, at), value);
        }
    }

    public get(node: ts.Expression): T | undefined {
        this.enter(node);
        const occurrence = this.locals.get(unwrapExpression(node))?.get("[]");
        if (occurrence) return occurrence.value;
        const key = this.key(node) ?? {
            root: unwrapExpression(node),
            path: [],
        };
        const path = JSON.stringify(key.path);
        return (
            this.locals.get(key.root)?.get(path)?.value ??
            this.ports.get(key.root)?.get(path)?.value
        );
    }

    public isPort(node: ts.Expression): boolean {
        this.enter(node);
        const key = this.key(node);
        return (
            !!key &&
            this.ports.get(key.root)?.has(JSON.stringify(key.path)) === true
        );
    }

    public port(name: string, at: ts.Node): T | undefined {
        this.enter(at);
        const key = this.portKey(name, this.sourceScope(at));
        const path = JSON.stringify(key.path);
        return (
            this.locals.get(key.root)?.get(path)?.value ??
            this.ports.get(key.root)?.get(path)?.value
        );
    }

    public set(node: ts.Expression, value: T): void {
        // Computed values carry facts for this AST occurrence only.
        node = unwrapExpression(node);
        const key = (ts.isIdentifier(node) ||
        ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node) ||
        node.kind === ts.SyntaxKind.ThisKeyword
            ? this.key(node)
            : undefined) ?? { root: node, path: [] };
        this.put(this.locals, key, value);
    }

    /** Named ports returned by a domain adapter, resolved in its explicit scope. */
    public bindPorts(
        bindings: Iterable<readonly [string, T]>,
        at: ts.Node,
    ): void {
        at = this.sourceScope(at);
        for (const [name, value] of bindings)
            this.put(this.locals, this.portKey(name, at), value);
    }

    public copyMembers(source: ts.Expression, target: ts.Expression): void {
        const from = this.key(source),
            to = this.key(target);
        if (!from || !to) return;
        for (const bindings of [this.ports, this.locals]) {
            for (const entry of [
                ...(bindings.get(from.root)?.values() ?? []),
            ]) {
                if (
                    entry.path.length <= from.path.length ||
                    !from.path.every(
                        (part, index) => entry.path[index] === part,
                    )
                )
                    continue;
                this.put(
                    this.locals,
                    {
                        root: to.root,
                        path: [
                            ...to.path,
                            ...entry.path.slice(from.path.length),
                        ],
                    },
                    entry.value,
                );
            }
        }
    }

    public scoped<R>(action: () => R): R {
        const saved = this.locals;
        this.locals = new Map(
            [...saved].map(([root, entries]) => [root, new Map(entries)]),
        );
        try {
            return action();
        } finally {
            this.locals = saved;
        }
    }

    public identity(node: ts.Identifier): ts.Symbol | symbol {
        return (
            declaredSymbol(
                moduleSymbols(this.sourceScope(node).getSourceFile()),
                node,
            ) ?? this.externalRoot(node.text)
        );
    }

    private externalRoot(name: string): symbol {
        let root = this.external.get(name);
        if (!root) this.external.set(name, (root = Symbol(name)));
        return root;
    }

    private put(bindings: Bindings<T>, key: BindingKey, value: T): void {
        let entries = bindings.get(key.root);
        if (!entries)
            bindings.set(key.root, (entries = new Map<string, Entry<T>>()));
        entries.set(JSON.stringify(key.path), { path: key.path, value });
    }

    private portKey(name: string, at: ts.Node): BindingKey {
        const file = ts.createSourceFile(
            "binding.ts",
            `(${name});`,
            ts.ScriptTarget.Latest,
            true,
        );
        const statement = file.statements[0];
        const key =
            statement && ts.isExpressionStatement(statement)
                ? this.key(statement.expression, at)
                : undefined;
        if (!key) throw new Error(`Unsupported pinned binding port '${name}'.`);
        return key;
    }

    private sourceScope(node: ts.Node): ts.Node {
        const source = (entry: ts.Node): ts.Node | undefined => {
            const original = ts.getOriginalNode(entry);
            return original.getSourceFile()
                ? original
                : ts.forEachChild(original, source);
        };
        const at = source(node);
        if (!at)
            throw new Error(
                `Pinned ${ts.SyntaxKind[node.kind]} has no source scope.`,
            );
        return at;
    }

    private portRoot(name: string, at: ts.Node): Root {
        const checker = moduleSymbols(at.getSourceFile());
        const visible = checker.resolveName(
            name,
            at,
            ts.SymbolFlags.Value,
            false,
        );
        if (visible) return visible;
        // A caller can supply an adapted local declared later in a nested block.
        // Only a unique declaration can resolve a port outside the entry scope.
        // Ambiguous names remain unbound and require an explicit source binding.
        const region =
            ts.findAncestor(at, ts.isFunctionLike) ?? at.getSourceFile();
        let declarations = this.regionDeclarations.get(region);
        if (!declarations) {
            const found = new Map<string, ts.Symbol[]>();
            const visit = (node: ts.Node): void => {
                if (node !== region && ts.isFunctionLike(node)) return;
                if (
                    (ts.isVariableDeclaration(node) ||
                        ts.isBindingElement(node) ||
                        ts.isParameter(node)) &&
                    ts.isIdentifier(node.name)
                ) {
                    const symbol = declaredSymbol(checker, node.name);
                    if (symbol) {
                        const entries = found.get(node.name.text) ?? [];
                        if (!entries.includes(symbol)) entries.push(symbol);
                        found.set(node.name.text, entries);
                    }
                }
                ts.forEachChild(node, visit);
            };
            visit(region);
            this.regionDeclarations.set(region, (declarations = found));
        }
        const candidates = declarations.get(name) ?? [];
        return candidates.length === 1
            ? candidates[0]!
            : this.externalRoot(name);
    }

    private key(
        expression: ts.Expression,
        at?: ts.Node,
    ): BindingKey | undefined {
        const node = unwrapExpression(expression);
        if (ts.isIdentifier(node))
            return {
                root: at ? this.portRoot(node.text, at) : this.identity(node),
                path: [],
            };
        if (node.kind === ts.SyntaxKind.ThisKeyword)
            return {
                root:
                    ts.findAncestor(
                        at ?? node,
                        (parent) =>
                            ts.isFunctionLike(parent) &&
                            !ts.isArrowFunction(parent),
                    ) ?? (at ?? node).getSourceFile(),
                path: [],
            };
        if (ts.isPropertyAccessExpression(node)) {
            const owner = this.key(node.expression, at);
            return (
                owner && {
                    root: owner.root,
                    path: [...owner.path, `property:${node.name.text}`],
                }
            );
        }
        if (ts.isElementAccessExpression(node)) {
            const owner = this.key(node.expression, at);
            const index = unwrapExpression(node.argumentExpression);
            const part = ts.isStringLiteralLike(index)
                ? `property:${index.text}`
                : ts.isNumericLiteral(index)
                  ? `property:${Number(index.text)}`
                  : this.indexKey(index, at);
            return owner && part !== undefined
                ? { root: owner.root, path: [...owner.path, part] }
                : undefined;
        }
        if (ts.isBinaryExpression(node)) {
            const left = this.indexKey(unwrapExpression(node.left), at);
            const right = this.indexKey(unwrapExpression(node.right), at);
            return left !== undefined && right !== undefined
                ? {
                      root: this.externalRoot(
                          `@operator:${node.operatorToken.kind}`,
                      ),
                      path: [left, right],
                  }
                : undefined;
        }
        if (ts.isCallExpression(node)) {
            const callee = this.key(node.expression, at);
            const args = node.arguments.map((argument) =>
                this.indexKey(unwrapExpression(argument), at),
            );
            return callee &&
                args.every((arg): arg is string => arg !== undefined)
                ? {
                      root: callee.root,
                      path: [...callee.path, `call:${JSON.stringify(args)}`],
                  }
                : undefined;
        }
        if (ts.isPrefixUnaryExpression(node)) {
            const operand = this.indexKey(unwrapExpression(node.operand), at);
            return operand === undefined
                ? undefined
                : {
                      root: this.externalRoot(`@operator:${node.operator}`),
                      path: [operand],
                  };
        }
        return undefined;
    }

    private indexKey(node: ts.Expression, at?: ts.Node): string | undefined {
        const key = this.key(node, at);
        if (key) {
            let id = this.identities.get(key.root);
            if (id === undefined)
                this.identities.set(key.root, (id = this.identities.size));
            return JSON.stringify([id, key.path]);
        }
        if (ts.isNumericLiteral(node)) return `number:${Number(node.text)}`;
        if (ts.isStringLiteralLike(node))
            return `string:${JSON.stringify(node.text)}`;
        if (
            node.kind === ts.SyntaxKind.TrueKeyword ||
            node.kind === ts.SyntaxKind.FalseKeyword ||
            node.kind === ts.SyntaxKind.NullKeyword
        )
            return `literal:${node.kind}`;
        return undefined;
    }
}
