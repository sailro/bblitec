// Dist consumers retain one record per independent process. The legacy record
// remains readable while a command started by an older build is still running.
import {
    mkdirSync,
    readFileSync,
    readdirSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";

const lockDirectory = "artifacts/.dist-locks";
const writerPath = "artifacts/.dist-writer.lock";

/** @param {unknown} error @param {string} code */
function hasCode(error, code) {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === code
    );
}

/** @param {string} path @param {number | undefined} owner */
function liveLock(path, owner) {
    let raw;
    try {
        raw = readFileSync(path, "utf8");
    } catch (error) {
        if (hasCode(error, "ENOENT")) return undefined;
        throw error;
    }
    /** @type {{ pid?: unknown, command?: unknown, started?: unknown }} */
    let record = {};
    try {
        record = JSON.parse(raw);
    } catch {
        // A live owner may still be publishing its record. Its filename is
        // sufficient to protect it; never clear a partial live record.
    }
    const pid = owner ?? record?.pid;
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0)
        throw new Error(
            `Unreadable dist lock ${path}; inspect it before removing it.`,
        );
    try {
        process.kill(pid, 0);
    } catch (error) {
        if (hasCode(error, "ESRCH")) {
            try {
                unlinkSync(path);
            } catch (removal) {
                if (!hasCode(removal, "ENOENT")) throw removal;
            }
            return undefined;
        }
        // EPERM still means the process exists; other uncertainty also keeps it protected.
    }
    return {
        pid,
        command:
            typeof record?.command === "string"
                ? record.command
                : "unknown command",
        started:
            typeof record?.started === "number" ? record.started : Date.now(),
    };
}

export function assertNoDistConsumers() {
    if (process.env["BBLITE_FORCE_CLEAN"] === "1") return;
    /** @type {Array<{ path: string, pid: number | undefined }>} */
    const paths = [{ path: "artifacts/.scene-command.lock", pid: undefined }];
    try {
        for (const name of readdirSync(lockDirectory)) {
            if (!/^[1-9][0-9]*\.json$/.test(name)) continue;
            paths.push({
                path: join(lockDirectory, name),
                pid: Number(name.slice(0, -5)),
            });
        }
    } catch (error) {
        if (!hasCode(error, "ENOENT")) throw error;
    }
    for (const { path, pid } of paths) {
        const lock = liveLock(path, pid);
        if (!lock) continue;
        const age = Math.round((Date.now() - lock.started) / 1000);
        console.error(
            `Refusing to delete dist/: '${lock.command}' has been running out of it for ${age}s (pid ${lock.pid}).\n` +
                "Wait for it to finish, or set BBLITE_FORCE_CLEAN=1 only if the lock is stale.",
        );
        throw new Error("dist is in use.");
    }
}

/** @param {() => void} action */
export function withDistWriter(action) {
    const inherited = process.env.BBLITE_DIST_WRITER_PID;
    if (inherited !== undefined) {
        const owner = JSON.parse(readFileSync(writerPath, "utf8"));
        if (owner.pid !== Number(inherited))
            throw new Error(
                "The inherited dist writer no longer owns its gate.",
            );
        action();
        return;
    }
    mkdirSync("artifacts", { recursive: true });
    const started = Date.now();
    const wait = new Int32Array(new SharedArrayBuffer(4));
    while (true) {
        try {
            writeFileSync(writerPath, JSON.stringify({ pid: process.pid }), {
                flag: "wx",
            });
            break;
        } catch (error) {
            if (!hasCode(error, "EEXIST")) throw error;
            // Do not unlink a stale writer here: two recovering processes
            // could otherwise remove a newly acquired gate from one another.
            let owner;
            try {
                owner = JSON.parse(readFileSync(writerPath, "utf8"));
            } catch (readError) {
                if (
                    !hasCode(readError, "ENOENT") &&
                    !(readError instanceof SyntaxError)
                )
                    throw readError;
            }
            if (owner && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
                try {
                    process.kill(owner.pid, 0);
                } catch (probeError) {
                    if (hasCode(probeError, "ESRCH"))
                        throw new Error(
                            `Dist writer ${owner.pid} stopped without releasing ${writerPath}; remove that stale file, then rebuild.`,
                            { cause: probeError },
                        );
                }
            }
            if (!owner && Date.now() - started > 1000)
                throw new Error(
                    `Incomplete dist writer record ${writerPath}; inspect it before removing it.`,
                    { cause: error },
                );
            if (Date.now() - started > 120_000)
                throw new Error(
                    `Timed out waiting for ${writerPath}; inspect its owner before removing it.`,
                    { cause: error },
                );
            Atomics.wait(wait, 0, 0, 50);
        }
    }
    process.env.BBLITE_DIST_WRITER_PID = String(process.pid);
    let held = true;
    const release = () => {
        if (!held) return;
        held = false;
        delete process.env.BBLITE_DIST_WRITER_PID;
        unlinkSync(writerPath);
    };
    process.once("exit", release);
    const interrupted = () => process.exit(130);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
        process.once(signal, interrupted);
    try {
        action();
    } finally {
        release();
        process.removeListener("exit", release);
        for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
            process.removeListener(signal, interrupted);
    }
}
