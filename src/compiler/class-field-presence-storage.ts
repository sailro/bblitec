import type { InstanceProperty } from "./class-members.js";

/**
 * A shared class field that one construction binds to a value and another
 * leaves absent: the compile replays with a presence slot for it, so a
 * method inlined on a stored instance reads the one value or nothing.
 */
export class ClassFieldPresenceRequired extends Error {
    constructor(readonly declaration: InstanceProperty) {
        super("A shared class field must store whether it is present.");
    }
}

/** The layout source name of a field's presence slot. */
export function classFieldPresenceSource(property: string): string {
    return `${property}?present`;
}
