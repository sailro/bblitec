import ts from "typescript";
import { forEachAnalysisNode } from "./analysis-walk.js";

/** Immutable source candidates survive emission rollback and storage replays. */
const candidatesByChecker = new WeakMap<
    ts.TypeChecker,
    {
        nodes: readonly ts.TypeNode[];
        next: number;
        types: ts.Type[];
        seen: Set<ts.Type>;
    }
>();

/** Structural storage proofs depend only on the checked source, not emitted layouts. */
const referenceStorageByChecker = new WeakMap<
    ts.TypeChecker,
    WeakMap<ts.Type, boolean>
>();

export function sourceTypeRequiresReferenceStorage(
    checker: ts.TypeChecker,
    sources: readonly ts.SourceFile[],
    sourceType: ts.Type,
): boolean {
    const target = checker.getNonNullableType(sourceType);
    let cache = referenceStorageByChecker.get(checker);
    if (!cache) {
        cache = new WeakMap();
        referenceStorageByChecker.set(checker, cache);
    }
    const cached = cache.get(target);
    if (cached !== undefined) return cached;
    for (const candidate of storedSourceTypes(checker, sources)) {
        if (
            candidate === target ||
            (candidate.aliasSymbol !== undefined &&
                candidate.aliasSymbol === target.aliasSymbol) ||
            (candidate.symbol !== undefined &&
                candidate.symbol === target.symbol) ||
            // Coalesced native layouts retain structurally equivalent demands.
            (checker.isTypeAssignableTo(candidate, target) &&
                checker.isTypeAssignableTo(target, candidate))
        ) {
            cache.set(target, true);
            return true;
        }
    }
    cache.set(target, false);
    return false;
}

function storedSourceTypes(
    checker: ts.TypeChecker,
    sources: readonly ts.SourceFile[],
): Iterable<ts.Type> {
    let candidates = candidatesByChecker.get(checker);
    if (!candidates) {
        const nodes: ts.TypeNode[] = [];
        for (const source of sources) {
            if (source.isDeclarationFile) continue;
            forEachAnalysisNode(source, (node) => {
                if (ts.isArrayTypeNode(node)) nodes.push(node.elementType);
                else if (
                    ts.isPropertyDeclaration(node) ||
                    ts.isPropertySignature(node) ||
                    ts.isMethodDeclaration(node)
                ) {
                    if (node.type) nodes.push(node.type);
                } else if (
                    ts.isTypeReferenceNode(node) &&
                    ts.isIdentifier(node.typeName)
                ) {
                    const index = ["Map", "ReadonlyMap", "Record"].includes(
                        node.typeName.text,
                    )
                        ? 1
                        : ["Array", "ReadonlyArray", "Set"].includes(
                                node.typeName.text,
                            )
                          ? 0
                          : -1;
                    const type =
                        index >= 0 ? node.typeArguments?.[index] : undefined;
                    if (type) nodes.push(type);
                }
            });
        }
        candidatesByChecker.set(
            checker,
            (candidates = { nodes, next: 0, types: [], seen: new Set() }),
        );
    }
    return (function* () {
        for (let index = 0; ; index++) {
            while (
                index >= candidates.types.length &&
                candidates.next < candidates.nodes.length
            ) {
                const type = checker.getNonNullableType(
                    checker.getTypeFromTypeNode(
                        candidates.nodes[candidates.next]!,
                    ),
                );
                candidates.next++;
                if (!candidates.seen.has(type)) {
                    candidates.seen.add(type);
                    candidates.types.push(type);
                }
            }
            const type = candidates.types[index];
            if (!type) return;
            yield type;
        }
    })();
}
