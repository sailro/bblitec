import "@babylonjs/lite";

/** A module that reaches the engine: a type imported from it is skipped by the executed graph, and a pass run from it declines the fold. */
export type Kind = "oak" | "pine";

export function spawnCounts(): Record<Kind, number> {
    return { oak: 3, pine: 4 };
}
