// Which engine a struct's engine field holds, decided before emission from
// every store the program makes to a property of that name. Struct fields
// are named by their properties and a struct conversion copies a field to
// the field of the same name, so the stores to one name bound every
// struct field so named, whatever struct the data model gives a shape.
// A store's engine is the binding it comes from: a const holding one
// engine, through const aliases, or a parameter every call or construction
// of its function passes the same such binding. A store this cannot follow
// leaves the name's engine unknown.
import ts from "typescript";
import { sourceFileNodes } from "./analysis-walk.js";
import { pinnedHandleKind } from "./data-types.js";
import { namedMember, resolvedSymbol, valueSymbolOf } from "./symbols.js";
import {
    isValueReference,
    unwrapExpression,
    variableKind,
    writeSites,
} from "./syntax.js";

/** The engine binding a store or name resolves to: unknown, or nothing new. */
type Root = ts.Symbol | "unknown" | "cycle";

/** What a store to a name puts there: a value, a parameter property, or something unfollowed. */
type Store = ts.Expression | ts.ParameterDeclaration | "unknown";

const identities = new WeakMap<ts.Program, EngineFieldIdentities>();

/** The program's engine field identities, built once per program. */
export function engineFieldIdentities(
    program: ts.Program,
): EngineFieldIdentities {
    let found = identities.get(program);
    if (!found)
        identities.set(
            program,
            (found = new EngineFieldIdentities(program.getTypeChecker(), [
                ...program.getSourceFiles(),
            ])),
        );
    return found;
}

export class EngineFieldIdentities {
    private stores?: Map<string, Store[]>;
    /** A store whose name the analysis cannot read: every name is unknown. */
    private unnamed = false;
    private identifiers?: Map<string, ts.Identifier[]>;
    private readonly roots = new Map<string, ts.Symbol | undefined>();

    constructor(
        private readonly checker: ts.TypeChecker,
        private readonly files: readonly ts.SourceFile[],
    ) {}

    /** The engine binding every store to a field named `name` puts there, if one. */
    public root(name: string): ts.Symbol | undefined {
        if (this.roots.has(name)) return this.roots.get(name);
        const root = this.nameRoot(name, new Set());
        const found = typeof root === "string" ? undefined : root;
        this.roots.set(name, found);
        return found;
    }

    private nodes(): Iterable<ts.Node> {
        const files = this.files.filter((file) => !file.isDeclarationFile);
        return {
            *[Symbol.iterator]() {
                for (const file of files) yield* sourceFileNodes(file);
            },
        };
    }

    private holdsEngine(node: ts.Node): boolean {
        const type = this.checker.getTypeAtLocation(node);
        return (
            pinnedHandleKind(this.checker.getNonNullableType(type)) === "engine"
        );
    }

    /** Whether a value stored to an engine field may be any engine: an unchecked one. */
    private unchecked(node: ts.Node): boolean {
        return (
            (this.checker.getTypeAtLocation(node).flags &
                (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !==
            0
        );
    }

    private index(): Map<string, Store[]> {
        if (this.stores) return this.stores;
        const stores = new Map<string, Store[]>();
        const add = (name: string, store: Store): void => {
            const list = stores.get(name);
            if (list) list.push(store);
            else stores.set(name, [store]);
        };
        const value = (name: string, expression: ts.Expression): void => {
            if (this.holdsEngine(expression)) add(name, expression);
            else if (this.unchecked(expression)) add(name, "unknown");
        };
        for (const node of this.nodes()) {
            if (
                ts.isPropertyAssignment(node) &&
                ts.isObjectLiteralExpression(node.parent)
            ) {
                const name = ts.isComputedPropertyName(node.name)
                    ? undefined
                    : node.name.text;
                if (name !== undefined) value(name, node.initializer);
                else if (this.holdsEngine(node.initializer))
                    this.unnamed = true;
            } else if (ts.isShorthandPropertyAssignment(node))
                value(node.name.text, node.name);
            else if (
                ts.isParameter(node) &&
                ts.isIdentifier(node.name) &&
                ts.isParameterPropertyDeclaration(node, node.parent) &&
                this.holdsEngine(node)
            )
                add(node.name.text, node);
            else if (
                ts.isPropertyDeclaration(node) &&
                node.initializer &&
                !ts.isComputedPropertyName(node.name) &&
                !ts.isPrivateIdentifier(node.name)
            )
                value(node.name.text, node.initializer);
            for (const site of writeSites(node)) {
                if (!this.holdsEngine(site.target)) continue;
                const member = namedMember(this.checker, site.target);
                if (!member) {
                    // A computed key may write any engine field.
                    if (!ts.isIdentifier(site.target)) this.unnamed = true;
                    continue;
                }
                if (site.kind === "assign" && site.stored)
                    value(member.name, site.stored);
                else add(member.name, "unknown");
            }
        }
        return (this.stores = stores);
    }

    private nameRoot(name: string, visiting: Set<string | ts.Symbol>): Root {
        const stores = this.index();
        if (this.unnamed) return "unknown";
        if (visiting.has(name)) return "cycle";
        visiting.add(name);
        try {
            return agree(
                (stores.get(name) ?? []).map((store) =>
                    store === "unknown"
                        ? "unknown"
                        : ts.isParameter(store)
                          ? this.parameterRoot(store, visiting)
                          : this.expressionRoot(store, visiting),
                ),
            );
        } finally {
            visiting.delete(name);
        }
    }

    private expressionRoot(
        expression: ts.Expression,
        visiting: Set<string | ts.Symbol>,
    ): Root {
        const node = unwrapExpression(expression);
        if (ts.isIdentifier(node)) {
            const symbol = resolvedSymbol(this.checker, node);
            return symbol ? this.bindingRoot(symbol, visiting) : "unknown";
        }
        const member = namedMember(this.checker, node);
        // A field's own engine read back: what that name holds.
        return member && this.holdsEngine(node)
            ? this.nameRoot(member.name, visiting)
            : "unknown";
    }

    private bindingRoot(
        symbol: ts.Symbol,
        visiting: Set<string | ts.Symbol>,
    ): Root {
        const declaration = symbol.valueDeclaration;
        if (!declaration) return "unknown";
        if (ts.isParameter(declaration))
            return this.parameterRoot(declaration, visiting);
        if (
            !ts.isVariableDeclaration(declaration) ||
            variableKind(declaration) !== "const" ||
            !declaration.initializer
        )
            return "unknown";
        // A const holds one engine: its own, or the one it aliases.
        const initializer = unwrapExpression(declaration.initializer);
        return ts.isIdentifier(initializer) ||
            namedMember(this.checker, initializer)
            ? this.expressionRoot(initializer, visiting)
            : symbol;
    }

    /** The engine every call or construction passes a parameter. */
    private parameterRoot(
        parameter: ts.ParameterDeclaration,
        visiting: Set<string | ts.Symbol>,
    ): Root {
        const symbol = ts.isIdentifier(parameter.name)
            ? valueSymbolOf(this.checker, parameter.name)
            : undefined;
        const owner = parameter.parent;
        const index = owner.parameters.indexOf(parameter);
        const target = this.invokedSymbol(owner);
        if (!symbol || !target || parameter.dotDotDotToken) return "unknown";
        if (visiting.has(symbol)) return "cycle";
        visiting.add(symbol);
        try {
            const roots: Root[] = [];
            for (const reference of this.references(target)) {
                const parent = reference.parent;
                const invocation =
                    (ts.isNewExpression(parent) ||
                        ts.isCallExpression(parent)) &&
                    parent.expression === reference
                        ? parent
                        : undefined;
                if (!invocation) {
                    // Reading a static member or testing `instanceof` invokes nothing.
                    if (
                        ts.isPropertyAccessExpression(parent) &&
                        parent.expression === reference
                    )
                        continue;
                    if (
                        ts.isBinaryExpression(parent) &&
                        parent.operatorToken.kind ===
                            ts.SyntaxKind.InstanceOfKeyword
                    )
                        continue;
                    return "unknown";
                }
                const passed = invocation.arguments ?? [];
                if (
                    passed.slice(0, index + 1).some(ts.isSpreadElement) ||
                    !passed[index]
                )
                    return "unknown";
                roots.push(this.expressionRoot(passed[index], visiting));
            }
            return roots.length === 0 ? "unknown" : agree(roots);
        } finally {
            visiting.delete(symbol);
        }
    }

    /** The class a constructor builds, or the function a declaration or const names. */
    private invokedSymbol(
        owner: ts.SignatureDeclaration,
    ): ts.Symbol | undefined {
        const name = ts.isConstructorDeclaration(owner)
            ? ts.isClassDeclaration(owner.parent)
                ? owner.parent.name
                : undefined
            : ts.isFunctionDeclaration(owner)
              ? owner.name
              : (ts.isArrowFunction(owner) || ts.isFunctionExpression(owner)) &&
                  ts.isVariableDeclaration(owner.parent) &&
                  owner.parent.initializer === owner &&
                  variableKind(owner.parent) === "const" &&
                  ts.isIdentifier(owner.parent.name)
                ? owner.parent.name
                : undefined;
        return name && resolvedSymbol(this.checker, name);
    }

    /** Every value reference to `symbol` in the program, by its name. */
    private references(symbol: ts.Symbol): ts.Identifier[] {
        if (!this.identifiers) {
            const identifiers = new Map<string, ts.Identifier[]>();
            for (const node of this.nodes())
                if (ts.isIdentifier(node)) {
                    const list = identifiers.get(node.text);
                    if (list) list.push(node);
                    else identifiers.set(node.text, [node]);
                }
            this.identifiers = identifiers;
        }
        return (this.identifiers.get(symbol.name) ?? []).filter(
            (identifier) =>
                isValueReference(identifier) &&
                resolvedSymbol(this.checker, identifier) === symbol,
        );
    }
}

/** The one binding the roots agree on; a cycle adds nothing. */
function agree(roots: readonly Root[]): Root {
    let found: Root = "cycle";
    for (const root of roots) {
        if (root === "cycle") continue;
        if (root === "unknown") return "unknown";
        if (found === "cycle") found = root;
        else if (found !== root) return "unknown";
    }
    return found;
}
