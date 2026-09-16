import { createBox } from "@babylonjs/lite";

/** A pure record-builder whose module reaches the engine: the fold cannot run it, so it lowers as ordinary code. */
export function spawnCounts(): Record<"oak" | "pine", number> {
    return { oak: 3, pine: 4 };
}

/** Makes the module reach the engine as a value import, the shape that refuses inlining. */
export function boxFactory(): typeof createBox {
    return createBox;
}
