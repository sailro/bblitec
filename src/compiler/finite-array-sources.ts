import ts from "typescript";
import { forEachAnalysisNode } from "./analysis-walk.js";
import { declaredSymbol, resolvedSymbol } from "./symbols.js";
import { isLogicalAssignmentOperator, unwrapExpression } from "./syntax.js";

type Slot = ts.Declaration;
interface Write {
    target: ts.Expression | ts.Declaration;
    values: readonly ts.Expression[];
}
interface Binding {
    target: ts.Expression | ts.Declaration;
    source: ts.Expression;
}

function nameOf(node: ts.Node): string | undefined {
    if (ts.isIdentifier(node)) return node.text;
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    if (ts.isElementAccessExpression(node)) {
        const key = unwrapExpression(node.argumentExpression);
        return ts.isStringLiteralLike(key) ? key.text : undefined;
    }
    if (
        (ts.isVariableDeclaration(node) ||
            ts.isPropertySignature(node) ||
            ts.isPropertyDeclaration(node) ||
            ts.isParameter(node) ||
            ts.isFunctionDeclaration(node) ||
            ts.isFunctionExpression(node) ||
            ts.isMethodDeclaration(node) ||
            ts.isMethodSignature(node) ||
            ts.isPropertyAssignment(node)) &&
        node.name &&
        ts.isIdentifier(node.name)
    )
        return node.name.text;
    return undefined;
}

function add<T>(
    index: Map<string, T[]>,
    name: string | undefined,
    item: T,
): void {
    if (name === undefined) return;
    const values = index.get(name) ?? [];
    values.push(item);
    index.set(name, values);
}

/** Source candidates are indexed by spelling, then matched by declaration identity. */
export class FiniteArraySources {
    /** @unjournaled Source writes indexed once during construction; independent of emission. */
    private readonly writes = new Map<string, Write[]>();
    /** @unjournaled Source aliases indexed once during construction; independent of emission. */
    private readonly bindings = new Map<string, Binding[]>();
    /** @unjournaled Source initializers indexed once during construction; independent of emission. */
    private readonly sources = new Map<string, Binding[]>();
    /** @unjournaled Source calls indexed once during construction; independent of emission. */
    private readonly calls = new Map<string, ts.CallExpression[]>();
    /** @unjournaled Source element inventory cached by declaration; independent of emitted types and replay. */
    private readonly elementsBySlot = new Map<Slot, readonly ts.Expression[]>();
    /** @unjournaled Source call inventory cached by producer; independent of emitted specializations and replay. */
    private readonly callsByProducer = new WeakMap<
        ts.Node,
        readonly ts.CallExpression[]
    >();

    public constructor(
        private readonly checker: ts.TypeChecker,
        files: readonly ts.SourceFile[],
    ) {
        for (const file of files) {
            if (file.isDeclarationFile) continue;
            forEachAnalysisNode(
                file,
                (node) => {
                    if (ts.isCallExpression(node)) {
                        add(this.calls, nameOf(node.expression), node);
                        const callee = unwrapExpression(node.expression);
                        if (!ts.isPropertyAccessExpression(callee)) return;
                        const start = ["push", "unshift"].includes(
                            callee.name.text,
                        )
                            ? 0
                            : callee.name.text === "splice"
                              ? 2
                              : undefined;
                        if (start === undefined) return;
                        const target = unwrapExpression(callee.expression);
                        add(this.writes, nameOf(target), {
                            target,
                            values: node.arguments.slice(start),
                        });
                    } else if (
                        ts.isBinaryExpression(node) &&
                        (node.operatorToken.kind ===
                            ts.SyntaxKind.EqualsToken ||
                            isLogicalAssignmentOperator(
                                node.operatorToken.kind,
                            ))
                    ) {
                        const target = unwrapExpression(node.left);
                        const source = unwrapExpression(node.right);
                        this.recordBinding(target, source);
                        if (ts.isElementAccessExpression(target)) {
                            const array = unwrapExpression(target.expression);
                            add(this.writes, nameOf(array), {
                                target: array,
                                values: [source],
                            });
                        }
                    } else if (
                        ts.isVariableDeclaration(node) &&
                        node.initializer
                    ) {
                        this.recordBinding(
                            node,
                            unwrapExpression(node.initializer),
                        );
                    }
                },
                { types: "skip" },
            );
        }
    }

    private recordBinding(
        target: Binding["target"],
        source: ts.Expression,
    ): void {
        const binding = { target, source };
        add(this.bindings, nameOf(source), binding);
        add(this.sources, nameOf(target), binding);
        if (ts.isArrayLiteralExpression(source))
            add(this.writes, nameOf(target), {
                target,
                values: source.elements,
            });
    }

    private slot(node: ts.Node): Slot | undefined {
        while (ts.isTypeNode(node)) node = node.parent;
        if (
            ts.isVariableDeclaration(node) ||
            ts.isPropertySignature(node) ||
            ts.isPropertyDeclaration(node) ||
            ts.isParameter(node) ||
            ts.isFunctionDeclaration(node) ||
            ts.isMethodDeclaration(node) ||
            ts.isPropertyAssignment(node)
        )
            return node;
        const symbol = resolvedSymbol(this.checker, node);
        return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    }

    /** Aliases share one inventory; unrelated fields with the same name do not. */
    private aliases(node: ts.Node): readonly Slot[] {
        const root = this.slot(node);
        if (!root) return [];
        const slots = [root];
        const seen = new Set<Slot>(slots);
        for (let index = 0; index < slots.length; index++) {
            const current = slots[index]!;
            for (const binding of this.sources.get(nameOf(current) ?? "") ??
                []) {
                if (this.slot(binding.target) !== current) continue;
                const source = this.slot(binding.source);
                if (source && !seen.has(source)) {
                    seen.add(source);
                    slots.push(source);
                }
            }
            for (const binding of this.bindings.get(nameOf(current) ?? "") ??
                []) {
                if (this.slot(binding.source) !== current) continue;
                const target = this.slot(binding.target);
                if (target && !seen.has(target)) {
                    seen.add(target);
                    slots.push(target);
                }
            }
        }
        return slots;
    }

    public elements(node: ts.Node): readonly ts.Expression[] {
        const root = this.slot(node);
        if (!root) return [];
        const cached = this.elementsBySlot.get(root);
        if (cached) return cached;
        const aliases = this.aliases(node);
        const values: ts.Expression[] = [];
        for (const slot of aliases)
            for (const write of this.writes.get(nameOf(slot) ?? "") ?? [])
                if (this.slot(write.target) === slot)
                    values.push(...write.values);
        for (const slot of aliases) this.elementsBySlot.set(slot, values);
        return values;
    }

    /** Unmapped arguments are created by the closest non-arrow source function. */
    public argumentsCalls(
        expression: ts.Expression,
    ): readonly ts.CallExpression[] | undefined {
        let node = unwrapExpression(expression);
        const seenAliases = new Set<ts.Node>();
        while (ts.isIdentifier(node) && !seenAliases.has(node)) {
            seenAliases.add(node);
            const declaration = this.slot(node);
            if (
                !declaration ||
                !ts.isVariableDeclaration(declaration) ||
                !declaration.initializer ||
                !ts.isVariableDeclarationList(declaration.parent) ||
                (declaration.parent.flags & ts.NodeFlags.Const) === 0
            )
                break;
            node = unwrapExpression(declaration.initializer);
        }
        if (
            !ts.isIdentifier(node) ||
            node.text !== "arguments" ||
            declaredSymbol(this.checker, node)?.declarations?.length
        )
            return undefined;
        let producer: ts.Node | undefined = node.parent;
        while (
            producer &&
            (!ts.isFunctionLike(producer) || ts.isArrowFunction(producer))
        )
            producer = producer.parent;
        if (!producer || !ts.isFunctionLike(producer)) return [];
        const cached = this.callsByProducer.get(producer);
        if (cached) return cached;
        const parent = producer.parent;
        const named = ts.isFunctionExpression(producer)
            ? ts.isVariableDeclaration(parent) ||
              ts.isPropertyAssignment(parent)
                ? parent
                : ts.isBinaryExpression(parent) && parent.right === producer
                  ? parent.left
                  : producer
            : producer;
        const slots = this.aliases(named);
        const result: ts.CallExpression[] = [];
        const seen = new Set<ts.CallExpression>();
        for (const slot of slots)
            for (const call of this.calls.get(nameOf(slot) ?? "") ?? []) {
                const target = this.slot(unwrapExpression(call.expression));
                if (target !== slot || seen.has(call)) continue;
                seen.add(call);
                result.push(call);
            }
        this.callsByProducer.set(producer, result);
        return result;
    }
}

const indexes = new WeakMap<ts.TypeChecker, FiniteArraySources>();

export function finiteArraySources(
    checker: ts.TypeChecker,
    files: readonly ts.SourceFile[],
): FiniteArraySources {
    let index = indexes.get(checker);
    if (!index) {
        index = new FiniteArraySources(checker, files);
        indexes.set(checker, index);
    }
    return index;
}
