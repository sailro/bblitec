/**
 * The lock `tools/clean-dist.mjs` refuses to cross.
 *
 * A `scene-command` run executes out of `dist/` for as long as it takes —
 * over an hour for the full matrix — and any `npm run build` started in that
 * window deletes `dist/` under it. The scenes in flight then die with "node
 * exited with status 1", which is indistinguishable from a real regression
 * until you notice which scenes failed make no sense together.
 *
 * The lock records the pid so a crashed run cannot leave a permanent one:
 * the cleaner tests the process and clears a lock whose writer is gone.
 */
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const lockPath = "artifacts/.scene-command.lock";

let held = false;

function release(): void {
    if (!held) return;
    held = false;
    try {
        unlinkSync(lockPath);
    } catch {
        // Already gone: a concurrent cleaner decided we were dead, or the
        // artifacts directory went away. Neither is worth failing a run over.
    }
}

/**
 * Claims the lock for this process and releases it however the process ends.
 *
 * Registered on `exit` rather than only on the happy path, and on the signals
 * a matrix run actually gets interrupted by, because a lock left behind by a
 * Ctrl-C would block every later build until someone read this file.
 */
export function holdDistLock(command: string): void {
    if (held) return;
    try {
        mkdirSync(dirname(lockPath), { recursive: true });
        writeFileSync(
            lockPath,
            JSON.stringify({
                pid: process.pid,
                command,
                started: Date.now(),
            }),
        );
    } catch {
        // Not being able to take the lock is not a reason to refuse to run;
        // it only means a concurrent build would not be caught.
        return;
    }
    held = true;
    process.on("exit", release);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
        process.on(signal, () => {
            release();
            process.exit(130);
        });
    }
}
