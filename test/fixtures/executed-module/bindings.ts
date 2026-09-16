// @ts-nocheck -- extensionless sibling imports, resolved by bblitec's executed-module graph.
import { KINDS, seedCount } from "./counts";
import type { Kind } from "./kinds";

/** Executed at generation: siblings imported without an extension, a type imported from a module that reaches the engine. */
export function emptyBindings(): Record<Kind, number> {
    const bindings = {} as Record<Kind, number>;
    for (const kind of KINDS) bindings[kind] = seedCount(kind);
    return bindings;
}
