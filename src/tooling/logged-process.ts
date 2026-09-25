import { spawn, spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";

/**
 * Run a child to completion with inherited stdio, throwing on a spawn
 * error or a nonzero exit — the one synchronous "must succeed" spawn the
 * tools share.
 */
export function runChecked(
    command: string,
    args: readonly string[],
    environment: NodeJS.ProcessEnv = process.env,
): void {
    const result = spawnSync(command, args, {
        stdio: "inherit",
        env: environment,
        windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`${command} exited with status ${result.status}.`);
    }
}

/** Run with stdout/stderr in one log, retaining the caller's exit-code policy. */
export async function runLoggedProcess(
    command: string,
    args: string[],
    logPath: string,
    options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<number> {
    const log = openSync(logPath, "w");
    try {
        return await new Promise<number>((done, fail) => {
            const child = spawn(command, args, {
                ...options,
                windowsHide: true,
                stdio: ["ignore", log, log],
            });
            child.once("error", fail);
            child.once("close", (code) => done(code ?? 1));
        });
    } finally {
        closeSync(log);
    }
}
