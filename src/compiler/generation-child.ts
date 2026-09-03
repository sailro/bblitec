// A short-lived Node child process, for generation work that is only
// available asynchronously.
//
// Entry compilation is synchronous by design, so anything the compiler needs
// mid-emit that has no synchronous form -- a fetch, a browser evaluation, a
// module the suite server has to transpile -- crosses this boundary instead.
// Four call sites had grown their own copy of the same twenty lines: the
// spawn, the `--input-type=module` script, the maxBuffer, and the throw that
// prefers stderr over an errno. They are one function now, so a fix to the
// error text or the buffer size lands on all of them at once.
//
// The child inherits the parent's environment; each caller adds whatever it
// needs to address its own work. Callers that hand over a large payload use
// `input` rather than the environment, since a command line and an
// environment block both have limits a serialized scene document can reach.
import { spawnSync } from "node:child_process";

export interface GenerationChildOptions {
    /** ESM source run with `--input-type=module`; must write its own stdout. */
    script: string;
    /** What to say the child was doing, when it fails. */
    label: string;
    /** Extra environment for the child, merged over the parent's. */
    env?: Record<string, string>;
    /** Payload on stdin, for a value too large to pass any other way. */
    input?: string;
    /** Default 64 MiB; a baked texture or a scene document needs more. */
    maxBuffer?: number;
}

/** Run the script and return its trimmed stdout, or throw naming `label`. */
export function runGenerationChild(
    options: GenerationChildOptions,
): string {
    const child = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", options.script],
        {
            cwd: process.cwd(),
            ...(options.env
                ? { env: { ...process.env, ...options.env } }
                : {}),
            ...(options.input === undefined
                ? {}
                : { input: options.input }),
            encoding: "utf8",
            maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
        },
    );
    if (child.status !== 0) {
        // stderr first: a child that ran and refused explains itself, while
        // `error.message` is only an errno from a spawn that never started.
        throw new Error(
            `${options.label} failed: ` +
                `${(child.stderr || child.error?.message || "no output").trim()}`,
        );
    }
    return child.stdout.trim();
}
