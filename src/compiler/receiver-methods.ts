import { EmissionSet } from "./emission-transaction.js";

/**
 * The built-in methods that change the container they are called on, one
 * table each analysis and lowering reads. A leaf module, so the analyses
 * that run before lowering (evaluation order, module initialization) read
 * it without importing the lowering.
 */

/** Array methods that can change its length and invalidate element aliases. */
export const resizingArrayMethods: ReadonlySet<string> = new EmissionSet([
    "push",
    "pop",
    "shift",
    "unshift",
    "splice",
]);

/** Array methods that mutate the receiver even when its length is unchanged. */
export const mutatingArrayMethods: ReadonlySet<string> = new EmissionSet([
    ...resizingArrayMethods,
    "copyWithin",
    "fill",
    "reverse",
    "sort",
]);

/**
 * The methods that change the container they are called on: every
 * mutating array method plus the Map/Set writers. A name outside this set
 * writes nothing through its receiver, so a container only ever read
 * through `get`, `has`, `map` or `find` stays folded.
 */
export const receiverWritingMethods: ReadonlySet<string> = new EmissionSet([
    ...mutatingArrayMethods,
    "set",
    "add",
    "clear",
    "delete",
]);
