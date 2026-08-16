// `clean:dist`, with the one interlock it needs.
//
// `npm run build` deletes `dist/` before `tsc` rewrites it, and every
// `npm run scene -- ...` runs `build` first. That is fine on its own. What is
// not fine is running a build while a long `scene-command` is *already*
// running out of `dist/`: the delete lands under the running process and the
// scenes in flight die with "node exited with status 1", which reads exactly
// like a real regression in a matrix run. It has cost two full matrix runs,
// once directly and once through a command that shells out to `build` without
// saying so.
//
// So `scene-command` writes a lock while it runs and this refuses to cross
// it. Plain JavaScript on purpose: it runs before `tsc`, so it cannot import
// anything out of `dist/`.
import { readFileSync, rmSync, unlinkSync } from "node:fs";

const lockPath = "artifacts/.scene-command.lock";

/** The live lock, if there is one. A lock whose process is gone is cleared. */
function liveLock() {
    let raw;
    try {
        raw = readFileSync(lockPath, "utf8");
    } catch {
        return undefined;
    }
    let lock;
    try {
        lock = JSON.parse(raw);
    } catch {
        // An unparseable lock is a crashed writer, not a running one.
        unlinkSync(lockPath);
        return undefined;
    }
    try {
        // Signal 0 tests for existence without delivering anything.
        process.kill(lock.pid, 0);
    } catch (error) {
        // ESRCH is "no such process": the writer died without releasing.
        // EPERM is "it exists but is not ours", which still means live.
        if (error?.code === "ESRCH") {
            unlinkSync(lockPath);
            return undefined;
        }
    }
    return lock;
}

const lock = liveLock();
if (lock && process.env["BBLITE_FORCE_CLEAN"] !== "1") {
    const age = Math.round((Date.now() - (lock.started ?? Date.now())) / 1000);
    console.error(
        `Refusing to delete dist/: 'scene-command ${lock.command}' has been ` +
            `running out of it for ${age}s (pid ${lock.pid}).\n` +
            "Deleting it now would kill that run and report the failure as a " +
            "regression. Wait for it to finish, or set BBLITE_FORCE_CLEAN=1 " +
            "if you are certain the lock is stale.",
    );
    process.exit(1);
}
rmSync("dist", { recursive: true, force: true });
