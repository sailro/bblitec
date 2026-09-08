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
    let found: ts.Statement | undefined;
    const visit = (node: ts.Node, insideSwitch: boolean): void => {
        if (found) return;
        if (ts.isIterationStatement(node, false) || ts.isFunctionLike(node)) {
            return;
        }
        if (ts.isBreakStatement(node)) {
            if (breaks && !insideSwitch && (labeled || !node.label)) {
                found = node;
            }
            return;
        }
        if (ts.isContinueStatement(node)) {
            if (continues && (labeled || !node.label)) found = node;
            return;
        }
        if (returns && ts.isReturnStatement(node)) {
            found = node;
            return;
        }
        const nestedSwitch = insideSwitch || ts.isSwitchStatement(node);
        ts.forEachChild(node, (child) => visit(child, nestedSwitch));
    };
    visit(statement, query.insideSwitch ?? false);
    return found;
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
    let found: ts.ReturnStatement | undefined;
    const visit = (node: ts.Node): void => {
        if (found || ts.isFunctionLike(node)) return;
        if (ts.isReturnStatement(node)) {
            if (!query.valued || node.expression) found = node;
            return;
        }
        ts.forEachChild(node, visit);
    };
    for (const root of roots) visit(root);
    return found;
}
