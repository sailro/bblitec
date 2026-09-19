import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import { writeJsonRecord } from "../src/validation-resume.js";

test(
    "JSON record replacement tolerates a transient Windows reader",
    { skip: process.platform !== "win32", timeout: 15000 },
    async () => {
        const directory = mkdtempSync(join(tmpdir(), "bblite-record-"));
        const path = join(directory, "report.json");
        const ready = join(directory, "ready");
        writeJsonRecord(path, { completed: 1 });
        const quote = (value: string): string =>
            `'${value.replaceAll("'", "''")}'`;
        const script = `$stream = [IO.File]::Open(${quote(path)}, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read); try { [IO.File]::WriteAllText(${quote(ready)}, 'ready'); Start-Sleep -Milliseconds 250 } finally { $stream.Dispose() }`;
        const child = spawn("pwsh", ["-NoProfile", "-Command", script], {
            windowsHide: true,
            stdio: "ignore",
        });
        const finished = new Promise<number | null | Error>((done) => {
            child.once("error", done);
            child.once("exit", done);
        });
        try {
            const deadline = Date.now() + 10000;
            while (
                !existsSync(ready) &&
                Date.now() < deadline &&
                child.exitCode === null
            )
                await setTimeout(10);
            assert.ok(existsSync(ready), "reader acquired the file");
            writeJsonRecord(path, { completed: 2 });
            assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
                completed: 2,
            });
            assert.equal(await finished, 0);
        } finally {
            await finished;
            assert.equal(dirname(directory), resolve(tmpdir()));
            rmSync(directory, { recursive: true, force: true });
        }
    },
);
