// A value-kind import used only as a type: the transpiler erases it, so the
// pass never loads the sibling that reaches the engine.
import { Kind } from "./kinds.js";

export function typedCounts(): Record<Kind, number> {
    return { oak: 3, pine: 4 };
}
