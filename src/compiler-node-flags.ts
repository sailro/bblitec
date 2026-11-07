import { isDeepStrictEqual } from "node:util";

/**
 * The Node flags the compiler runs under. Lowering allocates short-lived
 * values at a high rate: a 64 MB semi-space keeps them in the young
 * generation. V8 sizes it only at startup, so every process that compiles
 * is started with them.
 */
export const COMPILER_NODE_FLAGS: readonly string[] = [
    "--max-semi-space-size=64",
];

function nodeOptions(environment: NodeJS.ProcessEnv): string[] {
    return (environment.NODE_OPTIONS ?? "")
        .split(/\s+/)
        .filter((option) => option !== "");
}

/** This process's Node flags: its own arguments, then `NODE_OPTIONS`'s. */
function processNodeFlags(): string[] {
    return [...process.execArgv, ...nodeOptions(process.env)];
}

/** Node flags split into the `--conditions` they name, in each spelling Node takes, and the rest. */
function splitConditions(flags: readonly string[]): {
    conditions: string[];
    rest: string[];
} {
    const conditions: string[] = [];
    const rest: string[] = [];
    for (let index = 0; index < flags.length; index += 1) {
        const flag = flags[index]!;
        const inline = /^(?:--conditions|-C)=(.+)$/.exec(flag);
        if (inline) conditions.push(inline[1]!);
        else if (
            (flag === "--conditions" || flag === "-C") &&
            index + 1 < flags.length
        )
            conditions.push(flags[(index += 1)]!);
        else rest.push(flag);
    }
    return { conditions, rest };
}

/** Whether this process was started with every compiler flag, in its arguments or `NODE_OPTIONS`. */
export function startedWithCompilerNodeFlags(): boolean {
    const given = processNodeFlags().map((flag) => flag.split("=")[0]);
    return COMPILER_NODE_FLAGS.every((flag) =>
        given.includes(flag.split("=")[0]),
    );
}

let buildConditions: readonly string[] | undefined;

/**
 * The bundler conditions this process builds a program under: Node's own
 * `--conditions`, which select the pin's `#` imports for every pinned
 * module the compiler executes and for every pinned source it reads
 * (`pinned-build-conditions.ts`). Node takes them at startup, so they are
 * the process's from its start.
 */
export function pinnedBuildConditions(): readonly string[] {
    return (buildConditions ??= splitConditions(processNodeFlags()).conditions);
}

/** Whether this process builds under exactly `conditions`, in order. */
export function buildsUnderConditions(conditions: readonly string[]): boolean {
    return isDeepStrictEqual([...pinnedBuildConditions()], [...conditions]);
}

/**
 * A child process environment building under `conditions`: its Node
 * resolves imports under them alone.
 */
export function buildConditionsEnvironment(
    conditions: readonly string[],
    environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
    return {
        ...environment,
        NODE_OPTIONS: [
            ...splitConditions(nodeOptions(environment)).rest,
            ...conditions.map((condition) => `--conditions=${condition}`),
        ].join(" "),
    };
}

/**
 * This process's own Node arguments without the conditions they name, for
 * a child that takes its conditions from `buildConditionsEnvironment`.
 */
export function execArgvWithoutConditions(): string[] {
    return splitConditions(process.execArgv).rest;
}
