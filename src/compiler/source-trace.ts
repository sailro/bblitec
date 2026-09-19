import ts from "typescript";
import { EmissionWeakSet, emissionArray } from "./emission-transaction.js";

export interface SourceTrace {
    program: ts.Program;
    nodes: ReadonlySet<ts.Node>;
}

type Observer = (traces: readonly SourceTrace[]) => void;
let observer: Observer | undefined;
let pending: SourceTrace[] | undefined;
class ReachedNodes {
    readonly nodes = emissionArray<ts.Node>();
    private readonly seen = new EmissionWeakSet<ts.Node>();
    add(node: ts.Node): void {
        if (this.seen.has(node)) return;
        this.seen.add(node);
        this.nodes.push(node);
    }
}
let reached: ReachedNodes | undefined;

/** Opt-in tooling only. Compilation remains synchronous; restore nested observers. */
export function observeSourceTrace(next: Observer): () => void {
    const previous = observer;
    observer = next;
    return () => {
        observer = previous;
    };
}

/** Publish only after the whole application, including every worker, succeeds. */
export function traceSourceApplication<T>(compile: () => T): T {
    if (!observer) return compile();
    const previous = pending;
    const traces: SourceTrace[] = [];
    pending = traces;
    try {
        const result = compile();
        observer(traces);
        return result;
    } finally {
        pending = previous;
    }
}

/** Failed storage replays discard their nodes; emission probes journal the set. */
export function traceSourceProgram<T>(
    program: ts.Program,
    compile: () => T,
): T {
    if (!pending) return compile();
    const previous = reached;
    const nodes = new ReachedNodes();
    reached = nodes;
    try {
        const result = compile();
        pending.push({ program, nodes: new Set(nodes.nodes) });
        return result;
    } finally {
        reached = previous;
    }
}

/** Record a lowering site, never an entire body or an unselected branch. */
export function traceSourceNode(node: ts.Node): void {
    if (!reached) return;
    reached.add(node);
    if (
        node.parent &&
        ts.isPropertyAssignment(node.parent) &&
        node.parent.initializer === node
    )
        reached.add(node.parent);
    if (
        ts.isParenthesizedExpression(node) ||
        ts.isAsExpression(node) ||
        ts.isTypeAssertionExpression(node) ||
        ts.isNonNullExpression(node) ||
        ts.isAwaitExpression(node) ||
        ts.isVoidExpression(node)
    )
        traceSourceNode(node.expression);
    if (ts.isObjectLiteralExpression(node))
        for (const property of node.properties) reached.add(property);
}
