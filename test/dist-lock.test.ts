import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const lockModule = pathToFileURL(resolve("dist/src/dist-lock.js")).href;

function fixture(t: test.TestContext): string {
    const directory = mkdtempSync(join(tmpdir(), "bblite-dist-lock-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    mkdirSync(join(directory, "dist"));
    mkdirSync(join(directory, "artifacts/.dist-locks"), { recursive: true });
    writeFileSync(join(directory, "dist/alive.js"), "export {};");
    copyFileSync("tools/clean-dist.mjs", join(directory, "clean-dist.mjs"));
    copyFileSync("tools/dist-access.mjs", join(directory, "dist-access.mjs"));
    return directory;
}

function clean(directory: string): ReturnType<typeof spawnSync> {
    return spawnSync(process.execPath, ["clean-dist.mjs"], {
        cwd: directory,
        env: { ...process.env, BBLITE_FORCE_CLEAN: "0" },
        encoding: "utf8",
    });
}

test("independent dist consumers cannot release one another's protection", async (t) => {
    const directory = fixture(t);
    const start = async (command: string) => {
        const child = spawn(
            process.execPath,
            [
                "--input-type=module",
                "-e",
                `import { holdDistLock } from ${JSON.stringify(lockModule)};
                 holdDistLock(${JSON.stringify(command)});
                 process.send("ready");
                 process.on("message", () => process.exit(0));`,
            ],
            {
                cwd: directory,
                env: { ...process.env, BBLITE_DIST_LOCK_HELD: "0" },
                stdio: ["ignore", "ignore", "inherit", "ipc"],
            },
        );
        t.after(() => child.kill());
        const messages: unknown[] = await once(child, "message");
        assert.equal(messages[0], "ready");
        return child;
    };
    const first = await start("compile first");
    const second = await start("compile second");
    assert.equal(
        readdirSync(join(directory, "artifacts/.dist-locks")).length,
        2,
    );
    assert.equal(clean(directory).status, 1);
    const secondExit = once(second, "exit");
    second.send("exit");
    await secondExit;
    assert.equal(
        readdirSync(join(directory, "artifacts/.dist-locks")).length,
        1,
    );
    const refused = clean(directory);
    assert.equal(refused.status, 1);
    assert.match(String(refused.stderr), /compile first/);
    assert.ok(existsSync(join(directory, "dist/alive.js")));
    const firstExit = once(first, "exit");
    first.send("exit");
    await firstExit;
    assert.equal(clean(directory).status, 0);
    assert.equal(existsSync(join(directory, "dist")), false);
});

test("cleanup protects legacy and partially published live records, and removes dead owners", (t) => {
    const directory = fixture(t);
    const legacy = join(directory, "artifacts/.scene-command.lock");
    writeFileSync(
        legacy,
        JSON.stringify({ pid: process.pid, command: "legacy" }),
    );
    assert.equal(clean(directory).status, 1);
    rmSync(legacy);
    const live = join(directory, `artifacts/.dist-locks/${process.pid}.json`);
    writeFileSync(live, "{");
    assert.equal(clean(directory).status, 1);
    rmSync(live);
    const stopped = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    assert.equal(stopped.status, 0);
    const stale = join(directory, `artifacts/.dist-locks/${stopped.pid}.json`);
    writeFileSync(stale, "{");
    assert.equal(clean(directory).status, 0);
    assert.equal(existsSync(stale), false);
    assert.equal(existsSync(join(directory, "dist")), false);
});

test("a dist consumer starting after the writer gate cannot enter", (t) => {
    const directory = fixture(t);
    writeFileSync(
        join(directory, "artifacts/.dist-writer.lock"),
        JSON.stringify({ pid: process.pid }),
    );
    const result = spawnSync(
        process.execPath,
        [
            "--input-type=module",
            "-e",
            `import { holdDistLock } from ${JSON.stringify(lockModule)};
             holdDistLock("late reader");`,
        ],
        {
            cwd: directory,
            env: { ...process.env, BBLITE_DIST_LOCK_HELD: "0" },
            encoding: "utf8",
        },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /dist is being rebuilt/);
    assert.deepEqual(readdirSync(join(directory, "artifacts/.dist-locks")), []);
    assert.ok(existsSync(join(directory, "dist/alive.js")));
});
