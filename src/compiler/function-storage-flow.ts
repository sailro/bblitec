import type ts from "typescript";
import { EmissionMap, EmissionSet } from "./emission-transaction.js";

/** Checked contract identity, independent of the native calling convention. */
export function functionSignatureSite(
    signature: ts.Signature,
): string | undefined {
    const declaration = signature.getDeclaration();
    return declaration
        ? `${declaration.getSourceFile().fileName}:${declaration.pos}:${declaration.end}`
        : undefined;
}

interface StorageContract {
    readonly signatureSite?: string | undefined;
    readonly abi: string;
}

/**
 * Reached callback conversions connect source contracts. A dropped argument
 * conflicts only within that value flow and the storage ABI that drops it.
 * Missing source contracts conservatively share every value of that ABI.
 */
export class FunctionStorageFlow {
    private readonly parents = new EmissionMap<string, string>();
    private readonly reads = new EmissionMap<string, EmissionSet<string>>();
    private readonly passes = new EmissionMap<string, EmissionSet<string>>();

    private key(contract: StorageContract): string {
        return contract.signatureSite === undefined
            ? this.unknown(contract.abi)
            : `source:${contract.signatureSite}`;
    }

    private unknown(abi: string): string {
        return `unknown:${abi}`;
    }

    private root(key: string): string {
        const original = key;
        for (
            let parent = this.parents.get(key);
            parent;
            parent = this.parents.get(key)
        )
            key = parent;
        if (original !== key && this.parents.get(original) !== key)
            this.parents.set(original, key);
        return key;
    }

    private conflicts(abi: string): boolean {
        const reads = this.reads.get(abi);
        const passes = this.passes.get(abi);
        if (!reads?.size || !passes?.size) return false;
        const unknown = this.root(this.unknown(abi));
        const roots = new Set([...reads].map((key) => this.root(key)));
        if (roots.has(unknown)) return true;
        for (const key of passes) {
            const root = this.root(key);
            if (root === unknown || roots.has(root)) return true;
        }
        return false;
    }

    /** Returns false when connecting the contracts exposes a prior conflict. */
    public connect(source: StorageContract, target: StorageContract): boolean {
        const from = this.root(this.key(source));
        const to = this.root(this.key(target));
        if (from === to) return true;
        this.parents.set(to, from);
        for (const abi of this.reads.keys())
            if (this.conflicts(abi)) return false;
        return true;
    }

    public note(contract: StorageContract, use: "reads" | "passes"): boolean {
        const notes = use === "reads" ? this.reads : this.passes;
        let sites = notes.get(contract.abi);
        if (!sites) notes.set(contract.abi, (sites = new EmissionSet()));
        sites.add(this.key(contract));
        return !this.conflicts(contract.abi);
    }
}
