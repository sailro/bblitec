/**
 * The Node flags the compiler runs under. Lowering allocates short-lived
 * values at a high rate: a 64 MB semi-space keeps them in the young
 * generation. V8 sizes it only at startup, so every process that compiles
 * is started with them.
 */
export const COMPILER_NODE_FLAGS: readonly string[] = [
    "--max-semi-space-size=64",
];

/** Whether this process was started with every compiler flag, in its arguments or `NODE_OPTIONS`. */
export function startedWithCompilerNodeFlags(): boolean {
    const given = [
        ...process.execArgv,
        ...(process.env.NODE_OPTIONS?.split(/\s+/) ?? []),
    ].map((flag) => flag.split("=")[0]);
    return COMPILER_NODE_FLAGS.every((flag) =>
        given.includes(flag.split("=")[0]),
    );
}
