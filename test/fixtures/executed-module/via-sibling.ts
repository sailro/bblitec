import { spawnCounts } from "./kinds.js";

/** Reaches the engine only through a sibling, which the child discovers when it inlines the graph. */
export function siblingCounts(): Record<"oak" | "pine", number> {
    return spawnCounts();
}
