/**
 * The loop-control questions every lowering asks of a statement, answered
 * by one walk each.
 *
 * `enclosingLoopControl` finds the first control statement that would
 * leave the loop a statement sits in. Descent stops at a nested loop and at
 * a function-like, because a control statement there binds to that one; an
 * unqualified `break` additionally binds to a nested `switch`, so descent
 * tracks that too (a `continue` inside a switch still leaves the loop). The
 * query says which statements count: `break`s and `continue`s by default,
 * `return`s when a caller folding the loop away needs them, and labeled
 * forms unless the caller only wants the ones a switch lowering must
 * express itself. The statement itself comes back so a caller can refuse
 * at it by name.
 *
 * `firstReturn` is the other rule every return search shares: a `return`
 * anywhere below the roots, through nested loops and switches, stopping
 * only at a function-like whose return is its own.
 */
import ts from "typescript";
import { findAnalysisNode, findAnalysisNodeWithState } from "./analysis-walk.js";

export interface LoopControlQuery {
    /** Count `break` (default true). */
    readonly breaks?: boolean;
    /** Count `continue` (default true). */
    readonly continues?: boolean;
    /** Count `return` (default false). */
    readonly returns?: boolean;
    /** Count labeled `break`/`continue` as well (default true). */
    readonly labeled?: boolean;
    /** Start as if already inside a `switch` (default false). */
    readonly insideSwitch?: boolean;
}

export function enclosingLoopControl(
    statement: ts.Statement,
    query: LoopControlQuery = {},
): ts.Statement | undefined {
    const breaks = query.breaks ?? true;
    const continues = query.continues ?? true;
    const returns = query.returns ?? false;
    const labeled = query.labeled ?? true;
    const found = findAnalysisNodeWithState(statement, query.insideSwitch ?? false, (node, insideSwitch) => {
        if (ts.isBreakStatement(node)) {
            return breaks && !insideSwitch && (labeled || !node.label);
        }
        if (ts.isContinueStatement(node)) {
            return continues && (labeled || !node.label);
        }
        return returns && ts.isReturnStatement(node);
    }, (node, insideSwitch) => insideSwitch || ts.isSwitchStatement(node), { functions: "skip", loops: "skip" });
    return found && ts.isStatement(found) ? found : undefined;
}

/** Own returns, with the loop/switch boundary a native early return must cross. */
export function forEachReturn(
    roots: readonly ts.Node[],
    action: (node: ts.ReturnStatement, insideBreakable: boolean) => void,
): void {
    for (const root of roots) findAnalysisNodeWithState(root, false, (node, insideBreakable) => {
        if (!ts.isReturnStatement(node)) return false;
        action(node, insideBreakable);
        return "skip";
    }, (node, insideBreakable) => insideBreakable || ts.isIterationStatement(node, false) || ts.isSwitchStatement(node),
    { functions: "skip" });
}

export interface ReturnQuery {
    /** Count only a `return` that carries a value (default: any `return`). */
    readonly valued?: boolean;
}

/** The first `return` below the roots, in source order, or undefined. */
export function firstReturn(
    roots: readonly ts.Node[],
    query: ReturnQuery = {},
): ts.ReturnStatement | undefined {
    for (const root of roots) {
        const found = findAnalysisNode(root,
            (node): node is ts.ReturnStatement => ts.isReturnStatement(node) && (!query.valued || !!node.expression),
            { functions: "skip" });
        if (found) return found;
    }
    return undefined;
}
