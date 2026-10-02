import type ts from "typescript";

/** One reached instantiation of a stored generic function. */
export interface GenericFunctionDemand {
    family: string;
    key: string;
    arguments: readonly ts.Type[];
    parameters: readonly (ts.Type | undefined)[];
    frames: readonly ReadonlyMap<ts.Symbol, ts.Type>[];
    ancestors: readonly string[];
}

export function sameTypeFrames(
    left: GenericFunctionDemand["frames"],
    right: GenericFunctionDemand["frames"],
): boolean {
    return (
        left.length === right.length &&
        left.every((frame, index) => {
            const other = right[index]!;
            return (
                frame.size === other.size &&
                [...frame].every(([symbol, type]) => other.get(symbol) === type)
            );
        })
    );
}

/** Source identities and reached signatures persist while emission replays one Program. */
export class GenericFunctionStorage {
    private readonly families = new Map<
        ts.Signature,
        Array<{ key: string; frames: GenericFunctionDemand["frames"] }>
    >();
    private readonly demands = new Map<
        string,
        Map<string, GenericFunctionDemand>
    >();
    private nextFamily = 0;

    public family(
        signature: ts.Signature,
        frames: GenericFunctionDemand["frames"],
    ): string {
        const families = this.families.get(signature) ?? [];
        const found = families.find((family) =>
            sameTypeFrames(family.frames, frames),
        );
        if (found) return found.key;
        const key = String(this.nextFamily++);
        families.push({ key, frames: frames.map((frame) => new Map(frame)) });
        this.families.set(signature, families);
        return key;
    }

    public get(family: string): readonly GenericFunctionDemand[] {
        return [...(this.demands.get(family)?.values() ?? [])];
    }

    public add(demand: GenericFunctionDemand): boolean {
        const family =
            this.demands.get(demand.family) ??
            new Map<string, GenericFunctionDemand>();
        if (family.has(demand.key)) return false;
        family.set(demand.key, demand);
        this.demands.set(demand.family, family);
        return true;
    }
}

/** Earlier callback storage must contain every reached concrete signature. */
export class GenericFunctionStorageRequired extends Error {
    constructor(readonly demand: GenericFunctionDemand) {
        super("A stored generic function requires a concrete signature.");
    }
}
