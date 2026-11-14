import ts from "typescript";
import {
    bindingNameIdentifiers,
    isBlockScopedVariable,
    isValueReference,
} from "./syntax.js";

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

/** @unjournaled Parsed syntax is immutable: per block, where its last binding read ahead is declared. */
const fileForwardReads = new WeakMap<
    ts.SourceFile,
    ReadonlyMap<ts.Node, number>
>();

/**
 * Whether `statement` precedes a `let`/`const` statement of its own block
 * whose name is read ahead of it: a closure `statement` builds or reaches
 * may read that binding before its declaration.
 */
export function precedesForwardRead(statement: ts.Statement): boolean {
    const file = statement.getSourceFile() as ts.SourceFile | undefined;
    if (!file) return false;
    let limits = fileForwardReads.get(file);
    if (!limits) {
        const found = new Map<ts.Node, number>();
        const identifiers = identifiersByName(file);
        for (const node of sourceFileNodes(file)) {
            if (
                !ts.isVariableStatement(node) ||
                !isBlockScopedVariable(node.declarationList)
            )
                continue;
            const readAhead = node.declarationList.declarations.some(
                (declaration) =>
                    bindingNameIdentifiers(declaration.name).some((name) => {
                        for (const read of identifiers.get(name.text) ?? []) {
                            if (read.pos >= node.pos) break;
                            if (
                                read.pos >= node.parent.pos &&
                                isValueReference(read)
                            )
                                return true;
                        }
                        return false;
                    }),
            );
            if (readAhead) found.set(node.parent, node.pos);
        }
        fileForwardReads.set(file, (limits = found));
    }
    return statement.pos < (limits.get(statement.parent) ?? -1);
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
