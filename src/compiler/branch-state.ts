import { EmissionMap } from "./emission-transaction.js";

/** Branch-local changes restore existing bindings; newly emitted bindings remain registered. */
export class BranchState<State extends string> {
    private readonly values = new EmissionMap<string, State>();
    /** @unjournaled Synchronous restoration frames are always removed by their owning finally. */
    private readonly frames: Map<string, State | undefined>[] = [];

    public get(name: string): State | undefined {
        return this.values.get(name);
    }

    public set(name: string, state: State): void {
        const previous = this.values.get(name);
        if (previous === state) return;
        for (const frame of this.frames)
            if (!frame.has(name)) frame.set(name, previous);
        this.values.set(name, state);
    }

    public withRestoredChanges<T>(work: () => T): T {
        const originals = new Map<string, State | undefined>();
        this.frames.push(originals);
        try {
            return work();
        } finally {
            this.frames.pop();
            for (const [name, state] of originals)
                if (state !== undefined) this.values.set(name, state);
        }
    }
}
