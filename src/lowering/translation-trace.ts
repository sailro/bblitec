import ts from "typescript";

export interface TranslationTrace {
    file: ts.SourceFile;
    symbolName: string;
    extent: "function" | "specialization" | "selected-body";
    adapters: string[];
    requests: string[];
}

let observer: ((trace: TranslationTrace) => void) | undefined;

export function observePinnedTranslation(
    next: (trace: TranslationTrace) => void,
): () => void {
    const previous = observer;
    observer = next;
    return () => {
        observer = previous;
    };
}

export function pinnedTranslationObserved(): boolean {
    return observer !== undefined;
}

export function tracePinnedTranslation(trace: () => TranslationTrace): void {
    observer?.(trace());
}

/** Per-translator activity; discarded with a failed translation. */
export class TranslationActivity {
    readonly owners = new Set<ts.FunctionDeclaration>();
    readonly requests = new Set<string>();
    private readonly seen = new WeakSet<ts.Node>();

    node(node: ts.Node): void {
        if (this.seen.has(node)) return;
        this.seen.add(node);
        const owner = ts.findAncestor(node, ts.isFunctionDeclaration);
        if (owner) this.owners.add(owner);
    }

    request(kind: string, node: ts.Node, file: ts.SourceFile): void {
        const target = ts.isCallExpression(node) ? node.expression : node;
        const name =
            target.pos >= 0 &&
            (ts.isIdentifier(target) || ts.isPropertyAccessExpression(target))
                ? target.getText(file)
                : ts.SyntaxKind[target.kind];
        this.requests.add(`${kind}: ${name}`);
    }
}
