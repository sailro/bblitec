import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";

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
