// The two extensionless imports are the corpus style bblitec's executed-module graph resolves; the repository's own NodeNext build rejects them.
// @ts-expect-error TS2835
import { KINDS, seedCount } from "./counts";
// @ts-expect-error TS2835
import type { Kind } from "./kinds";

/** Executed at generation: siblings imported without an extension, a type imported from a module that reaches the engine. */
export function emptyBindings(): Record<Kind, number> {
    const bindings = {} as Record<Kind, number>;
    for (const kind of KINDS) bindings[kind] = seedCount(kind);
    return bindings;
}
