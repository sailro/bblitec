import ts from "typescript";

export interface AnalysisWalkPolicy {
    includeRoot?: boolean;
    functions?: "skip";
    loops?: "skip";
    types?: "skip";
    memberNames?: "skip";
    skip?: (node: ts.Node) => boolean;
}

type AnalysisMatch = boolean | "skip";

/** Preorder analysis with explicit boundaries and early termination. */
export function findAnalysisNode<T extends ts.Node>(
    root: ts.Node,
    matches: (node: ts.Node) => node is T,
    policy?: AnalysisWalkPolicy,
): T | undefined;
export function findAnalysisNode(
    root: ts.Node,
    matches: (node: ts.Node) => AnalysisMatch,
    policy?: AnalysisWalkPolicy,
): ts.Node | undefined;
export function findAnalysisNode(
    root: ts.Node,
    matches: (node: ts.Node) => AnalysisMatch,
    policy: AnalysisWalkPolicy = {},
): ts.Node | undefined {
    return findAnalysisNodeWithState(root, undefined, matches, () => undefined, policy);
}

/** Branch-local state is passed to children without leaking into siblings. */
export function findAnalysisNodeWithState<State>(
    root: ts.Node,
    initial: State,
    matches: (node: ts.Node, state: State) => AnalysisMatch,
    childState: (node: ts.Node, state: State) => State,
    policy: AnalysisWalkPolicy = {},
): ts.Node | undefined {
    const visit = (node: ts.Node, state: State): ts.Node | undefined => {
        if ((policy.functions === "skip" && ts.isFunctionLike(node)) ||
            (policy.loops === "skip" && ts.isIterationStatement(node, false)) ||
            (policy.types === "skip" && ts.isTypeNode(node)) || policy.skip?.(node)) return undefined;
        const result = matches(node, state);
        if (result === true) return node;
        if (result === "skip") return undefined;
        const next = childState(node, state);
        if (policy.memberNames === "skip" && ts.isPropertyAccessExpression(node)) return visit(node.expression, next);
        return ts.forEachChild(node, child => visit(child, next));
    };
    return policy.includeRoot === false
        ? ts.forEachChild(root, child => visit(child, initial))
        : visit(root, initial);
}

export function someAnalysisNode(
    root: ts.Node,
    matches: (node: ts.Node) => AnalysisMatch,
    policy?: AnalysisWalkPolicy,
): boolean {
    return findAnalysisNode(root, matches, policy) !== undefined;
}

export function forEachAnalysisNode(
    root: ts.Node,
    action: (node: ts.Node) => "skip" | void,
    policy?: AnalysisWalkPolicy,
): void {
    findAnalysisNode(root, node => action(node) ?? false, policy);
}
