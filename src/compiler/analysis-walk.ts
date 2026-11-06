import ts from "typescript";
import { isValueReference } from "./syntax.js";

interface AnalysisWalkPolicy {
    includeRoot?: boolean;
    functions?: "skip";
    loops?: "skip";
    types?: "skip";
    /**
     * Visit an identifier only where it reads or writes a binding
     * ({@link isValueReference}). A root name is the walk's subject and
     * stands for its binding wherever it sits (`const later = ...`).
     */
    names?: "references";
    skip?: (node: ts.Node) => boolean;
}

type AnalysisMatch = boolean | "skip";

/** @unjournaled Parsed syntax is immutable: each file's node list, kept. */
const fileNodes = new WeakMap<ts.SourceFile, readonly ts.Node[]>();

/**
 * Every node of a parsed source file in preorder, types left out: the
 * per-file index a whole-file scan iterates instead of walking the tree
 * again on each pass.
 */
export function sourceFileNodes(file: ts.SourceFile): readonly ts.Node[] {
    let nodes = fileNodes.get(file);
    if (!nodes) {
        const list: ts.Node[] = [];
        forEachAnalysisNode(
            file,
            (node) => {
                list.push(node);
            },
            { includeRoot: false, types: "skip" },
        );
        nodes = list;
        fileNodes.set(file, nodes);
    }
    return nodes;
}

/** @unjournaled Parsed syntax is immutable: each file's identifiers by name, kept. */
const fileIdentifiers = new WeakMap<
    ts.SourceFile,
    ReadonlyMap<string, readonly ts.Identifier[]>
>();

/** A file's identifiers outside type positions, by name, in source order. */
export function identifiersByName(
    file: ts.SourceFile,
): ReadonlyMap<string, readonly ts.Identifier[]> {
    let known = fileIdentifiers.get(file);
    if (!known) {
        const names = new Map<string, ts.Identifier[]>();
        for (const node of sourceFileNodes(file)) {
            if (!ts.isIdentifier(node)) continue;
            const list = names.get(node.text);
            if (list) list.push(node);
            else names.set(node.text, [node]);
        }
        fileIdentifiers.set(file, (known = names));
    }
    return known;
}

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
    return findAnalysisNodeWithState(
        root,
        undefined,
        matches,
        () => undefined,
        policy,
    );
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
        if (
            (policy.functions === "skip" && ts.isFunctionLike(node)) ||
            (policy.loops === "skip" && ts.isIterationStatement(node, false)) ||
            (policy.types === "skip" && ts.isTypeNode(node)) ||
            (policy.names === "references" &&
                node !== root &&
                ts.isIdentifier(node) &&
                !isValueReference(node)) ||
            policy.skip?.(node)
        )
            return undefined;
        const result = matches(node, state);
        if (result === true) return node;
        if (result === "skip") return undefined;
        const next = childState(node, state);
        return ts.forEachChild(node, (child) => visit(child, next));
    };
    return policy.includeRoot === false
        ? ts.forEachChild(root, (child) => visit(child, initial))
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
    findAnalysisNode(root, (node) => action(node) ?? false, policy);
}

/**
 * A walk over a program's source files (not its declaration files) keeping,
 * in source order, what `select` maps each node to: run once per file list
 * and kept for every replay.
 */
export function sourceFilesWalk<T, A extends readonly unknown[] = []>(
    select: (node: ts.Node, ...args: A) => T | undefined,
): (files: readonly ts.SourceFile[], ...args: A) => readonly T[] {
    const walked = new WeakMap<readonly ts.SourceFile[], readonly T[]>();
    return (files, ...args) => {
        let found = walked.get(files);
        if (!found) {
            const entries: T[] = [];
            for (const file of files)
                if (!file.isDeclarationFile)
                    forEachAnalysisNode(file, (node) => {
                        const entry = select(node, ...args);
                        if (entry !== undefined) entries.push(entry);
                    });
            walked.set(files, (found = entries));
        }
        return found;
    };
}
