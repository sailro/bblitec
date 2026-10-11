/** Each independent dist consumer owns a lock until it exits. */
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const lockPath = `artifacts/.dist-locks/${process.pid}.json`;

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

/** Children share their parent's lock; independent processes retain separate ones. */
export function holdDistLock(command: string): void {
    if (process.env.BBLITE_DIST_LOCK_HELD === "1") return;
    if (held) return;
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, command, started: Date.now() }),
    );
    held = true;
    if (existsSync("artifacts/.dist-writer.lock")) {
        release();
        throw new Error(
            "dist is being rebuilt; wait for the build to finish before starting a command.",
        );
    }
    process.env.BBLITE_DIST_LOCK_HELD = "1";
    process.on("exit", release);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
        process.on(signal, () => {
            release();
            process.exit(130);
        });
    }
}
