import { createEngine } from "@babylonjs/lite";

export type Kind = "oak" | "pine";

/** A value export that reaches the engine, so executing this module at generation would refuse. */
export function requireEngine(): typeof createEngine {
    return createEngine;
}
