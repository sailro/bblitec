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

export function storedSourceTypes(
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
