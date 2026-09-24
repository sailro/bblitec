/** Awaits only its own promises, so the pass settles before generation reads it. */
export async function settledCounts(): Promise<Record<"oak", number>> {
    const oak = await Promise.resolve(3);
    return { oak };
}

/** Waits on a promise nothing resolves, so the pass cannot settle at generation. */
export function pendingCounts(): Promise<Record<"oak", number>> {
    return new Promise(() => undefined);
}

/** Reaches a host global the pass realm does not hold. */
export function hostCounts(): Record<"oak", number> {
    return { oak: process.pid };
}

/** Writes a global of the realm it runs in, which must not outlive the pass. */
export function globalCounts(): Record<"oak", number> {
    Reflect.set(globalThis, "bblGenerationPassLeak", true);
    return { oak: 3 };
}
