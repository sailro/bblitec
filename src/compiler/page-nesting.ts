import ts from "typescript";
import { sourceFileNodes } from "./analysis-walk.js";
import { lookedUpElementId } from "./evaluation-order.js";
import {
    accessedPropertySymbol,
    calledOrigin,
    declaredInDomLibrary,
    declaredSymbol,
    libraryGlobal,
    namedMember,
    resolvedSymbol,
} from "./symbols.js";
import {
    equalityOperator,
    isMemberAccess,
    isValueReference,
    outermostWrapper,
    unwrapExpression,
    variableKind,
    writeSites,
} from "./syntax.js";
import { valueKindOf } from "./type-facts.js";
import type { NativeHostUiNode } from "./types.js";

/** A page node the nesting analysis follows: a host element by id, the document's roots, or an element a `const` creates. */
type PageNode = `id:${string}` | "root" | ts.Symbol;

/** Methods that insert what they are handed into their receiver. */
const CHILD_INSERTIONS: ReadonlySet<string> = new Set([
    "append",
    "appendChild",
    "insertBefore",
    "moveBefore",
    "prepend",
    "replaceChild",
    "replaceChildren",
]);

/** Methods that insert what they are handed beside their receiver. */
const SIBLING_INSERTIONS: ReadonlySet<string> = new Set([
    "after",
    "before",
    "replaceWith",
]);

/** Document methods that create a node outside the page. */
const NODE_CREATIONS: ReadonlySet<string> = new Set([
    "createComment",
    "createDocumentFragment",
    "createElement",
    "createElementNS",
    "createTextNode",
]);

/**
 * Which page elements, found by id, may sit inside which while the program
 * runs: the checked-source counterpart of `uiStaticDescendants`, answered
 * before any projection exists. The host markup places its elements; a
 * node the program inserts goes under its receiver; a node it cannot place,
 * markup it parses (`innerHTML`), a clone, or an id it assigns may put any
 * element anywhere.
 */
export class PageNesting {
    /** Each host element's id, with the ids of the host elements around it. */
    private readonly markup = new Map<string, readonly string[]>();
    /** Ids the markup repeats or the program assigns: any element may hold them. */
    private readonly ambiguous = new Set<string>();
    /** Ids of the document's own elements (`<html>`, `<body>`): they hold every element. */
    private readonly roots = new Set<string>();
    /** Where each node may be inserted. */
    private readonly placements = new Map<PageNode, Set<PageNode>>();
    /** Nodes that may be inserted where the analysis cannot follow. */
    private readonly anywhere = new Set<PageNode>();
    /** Nodes the program may insert unknown nodes under. */
    private readonly unknownUnder = new Set<PageNode>();
    /** An insertion the analysis cannot place at all. */
    private everything = false;

    public constructor(
        private readonly checker: ts.TypeChecker,
        sourceFiles: readonly ts.SourceFile[],
        host:
            | {
                  readonly elements: readonly NativeHostUiNode[];
                  readonly htmlAttributes?: Readonly<Record<string, string>>;
                  readonly bodyAttributes?: Readonly<Record<string, string>>;
              }
            | undefined,
    ) {
        for (const attributes of [host?.htmlAttributes, host?.bodyAttributes])
            if (attributes?.id !== undefined) this.roots.add(attributes.id);
        const visit = (
            nodes: readonly NativeHostUiNode[],
            around: readonly string[],
        ): void => {
            for (const node of nodes) {
                if (node.tag === undefined) continue;
                const id = node.attributes?.id;
                if (id !== undefined) {
                    if (this.markup.has(id)) this.ambiguous.add(id);
                    this.markup.set(id, around);
                }
                visit(
                    node.children ?? [],
                    id === undefined ? around : [...around, id],
                );
            }
        };
        visit(host?.elements ?? [], []);
        const created = this.createdElements(sourceFiles);
        for (const file of sourceFiles) {
            if (file.isDeclarationFile) continue;
            for (const node of sourceFileNodes(file)) this.scan(node, created);
        }
    }

    /** Whether the element with id `outer` may be or hold the one with id `inner`. */
    public mayContain(outer: string, inner: string): boolean {
        if (outer === inner || this.everything || this.roots.has(outer))
            return true;
        if (this.roots.has(inner)) return false;
        for (const id of [outer, inner])
            if (!this.markup.has(id) || this.ambiguous.has(id)) return true;
        const target: PageNode = `id:${outer}`;
        return (
            this.reaches(`id:${inner}`, target) ||
            [...this.unknownUnder].some((node) => this.reaches(node, target))
        );
    }

    /** Whether `from` may sit at or under `target`. */
    private reaches(from: PageNode, target: PageNode): boolean {
        const seen = new Set<PageNode>([from]);
        const pending: PageNode[] = [from];
        for (
            let node = pending.pop();
            node !== undefined;
            node = pending.pop()
        ) {
            if (node === target || this.anywhere.has(node)) return true;
            const parents: PageNode[] = [
                ...(typeof node === "string" && node.startsWith("id:")
                    ? (this.markup.get(node.slice(3)) ?? []).map(
                          (id): PageNode => `id:${id}`,
                      )
                    : []),
                ...(this.placements.get(node) ?? []),
            ];
            for (const parent of parents)
                if (!seen.has(parent)) {
                    seen.add(parent);
                    pending.push(parent);
                }
        }
        return false;
    }

    /**
     * The `const` bindings a creation call initializes whose element is
     * only read through, inserted or compared: anywhere else it may be
     * inserted where the analysis cannot follow.
     */
    private createdElements(
        sourceFiles: readonly ts.SourceFile[],
    ): ReadonlySet<ts.Symbol> {
        const created = new Set<ts.Symbol>();
        for (const file of sourceFiles) {
            if (file.isDeclarationFile) continue;
            for (const node of sourceFileNodes(file))
                if (
                    ts.isVariableDeclaration(node) &&
                    ts.isIdentifier(node.name) &&
                    node.initializer &&
                    variableKind(node) === "const" &&
                    this.isCreation(node.initializer)
                ) {
                    const symbol = declaredSymbol(this.checker, node.name);
                    if (symbol) created.add(symbol);
                }
        }
        return created;
    }

    /** Whether an expression creates a node outside the page. */
    private isCreation(expression: ts.Expression): boolean {
        const call = unwrapExpression(expression);
        if (!ts.isCallExpression(call)) return false;
        const member = namedMember(
            this.checker,
            unwrapExpression(call.expression),
        );
        return (
            member !== undefined &&
            NODE_CREATIONS.has(member.name) &&
            calledOrigin(this.checker, call) === "dom"
        );
    }

    /** The node an expression evaluates to, "fresh" for a new one, or undefined. */
    private node(
        expression: ts.Expression,
        created: ReadonlySet<ts.Symbol>,
    ): PageNode | "fresh" | undefined {
        const id = lookedUpElementId(this.checker, expression);
        if (id !== undefined) return `id:${id}`;
        if (this.isCreation(expression)) return "fresh";
        const value = unwrapExpression(expression);
        const member = namedMember(this.checker, value);
        if (
            member &&
            ["body", "documentElement", "head"].includes(member.name) &&
            libraryGlobal(this.checker, member.expression) === "document"
        )
            return "root";
        const symbol = ts.isIdentifier(value)
            ? resolvedSymbol(this.checker, value)
            : undefined;
        return symbol && created.has(symbol) ? symbol : undefined;
    }

    /** One node's part in the page's shape. */
    private scan(node: ts.Node, created: ReadonlySet<ts.Symbol>): void {
        const checker = this.checker;
        // A created element used other than through its members, as an
        // inserted node or in a comparison may be inserted anywhere.
        if (ts.isIdentifier(node) && isValueReference(node)) {
            const symbol = resolvedSymbol(checker, node);
            if (symbol && created.has(symbol) && !this.placedUse(node))
                this.anywhere.add(symbol);
            return;
        }
        for (const site of writeSites(node)) {
            const target = unwrapExpression(site.target);
            const member = namedMember(checker, target);
            if (
                !member ||
                !declaredInDomLibrary(
                    accessedPropertySymbol(checker, member.access),
                )
            )
                continue;
            if (member.name === "innerHTML")
                this.insertUnknown(member.expression, created);
            else if (member.name === "outerHTML") this.everything = true;
            else if (member.name === "id") this.assignId(site.from);
        }
        if (!ts.isCallExpression(node) || calledOrigin(checker, node) !== "dom")
            return;
        const callee = namedMember(checker, unwrapExpression(node.expression));
        if (!callee) {
            // `document.write` and the like reach no receiver here.
            return;
        }
        const name = callee.name;
        if (name === "cloneNode" || name === "importNode" || name === "write")
            this.everything = true;
        else if (name === "setAttribute" || name === "setAttributeNS") {
            const key = node.arguments[name === "setAttribute" ? 0 : 1];
            const text = key && unwrapExpression(key);
            if (!text || !ts.isStringLiteralLike(text)) this.everything = true;
            else if (text.text.toLowerCase() === "id")
                this.assignId(node.arguments[name === "setAttribute" ? 1 : 2]);
        } else if (name === "insertAdjacentHTML") {
            const position =
                node.arguments[0] && unwrapExpression(node.arguments[0]);
            if (
                position &&
                ts.isStringLiteralLike(position) &&
                ["afterbegin", "beforeend"].includes(
                    position.text.toLowerCase(),
                )
            )
                this.insertUnknown(callee.expression, created);
            else this.everything = true;
        } else if (name === "insertAdjacentElement") {
            const position =
                node.arguments[0] && unwrapExpression(node.arguments[0]);
            const inside =
                position &&
                ts.isStringLiteralLike(position) &&
                ["afterbegin", "beforeend"].includes(
                    position.text.toLowerCase(),
                );
            this.insert(
                inside ? callee.expression : undefined,
                node.arguments.slice(1),
                created,
            );
        } else if (CHILD_INSERTIONS.has(name))
            this.insert(
                callee.expression,
                name === "insertBefore" ||
                    name === "replaceChild" ||
                    name === "moveBefore"
                    ? node.arguments.slice(0, 1)
                    : node.arguments,
                created,
            );
        else if (SIBLING_INSERTIONS.has(name))
            this.insert(undefined, node.arguments, created);
    }

    /** Whether a created element's use keeps it where insertions place it. */
    private placedUse(reference: ts.Identifier): boolean {
        const position = outermostWrapper(reference);
        const parent = position.parent;
        if (isMemberAccess(parent) && parent.expression === position)
            return true;
        if (
            ts.isBinaryExpression(parent) &&
            equalityOperator(parent.operatorToken.kind) !== undefined
        )
            return true;
        if (!ts.isCallExpression(parent)) return false;
        const callee = namedMember(
            this.checker,
            unwrapExpression(parent.expression),
        );
        return (
            callee !== undefined &&
            calledOrigin(this.checker, parent) === "dom" &&
            (CHILD_INSERTIONS.has(callee.name) ||
                SIBLING_INSERTIONS.has(callee.name) ||
                callee.name === "insertAdjacentElement")
        );
    }

    /** `nodes` inserted under `receiver` (beside an unknown node when undefined). */
    private insert(
        receiver: ts.Expression | undefined,
        nodes: readonly ts.Expression[],
        created: ReadonlySet<ts.Symbol>,
    ): void {
        const parent = receiver && this.node(receiver, created);
        for (const argument of nodes) {
            const value = ts.isSpreadElement(argument)
                ? argument.expression
                : argument;
            if (
                !ts.isSpreadElement(argument) &&
                valueKindOf(this.checker.getTypeAtLocation(value)) === "string"
            )
                continue;
            const child = ts.isSpreadElement(argument)
                ? undefined
                : this.node(value, created);
            if (child === "fresh") continue;
            if (parent === undefined || parent === "fresh") {
                if (child === undefined) this.everything = true;
                else this.anywhere.add(child);
            } else if (child === undefined) this.unknownUnder.add(parent);
            else {
                const placements = this.placements.get(child);
                if (placements) placements.add(parent);
                else this.placements.set(child, new Set([parent]));
            }
        }
    }

    /** Unknown nodes (parsed markup) inserted under `receiver`. */
    private insertUnknown(
        receiver: ts.Expression,
        created: ReadonlySet<ts.Symbol>,
    ): void {
        const parent = this.node(receiver, created);
        if (parent === undefined || parent === "fresh") this.everything = true;
        else this.unknownUnder.add(parent);
    }

    /** An element given the id `value` may be any element. */
    private assignId(value: ts.Expression | undefined): void {
        const text = value && unwrapExpression(value);
        if (text && ts.isStringLiteralLike(text)) this.ambiguous.add(text.text);
        else this.everything = true;
    }
}
