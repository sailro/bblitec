import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { discoverDevelopmentTools } from "../src/development-tools.js";

test("pinned RmlUi patch resets remove added files and preserve exact patch verification", () => {
    const tools = discoverDevelopmentTools();
    assert.ok(
        tools.cmake && tools.git,
        "CMake and Git are required for dependency patch validation",
    );
    const artifacts = resolve("artifacts");
    mkdirSync(artifacts, { recursive: true });
    const root = mkdtempSync(join(artifacts, "rmlui-patch-"));
    const checkout = join(root, "source");
    mkdirSync(checkout);
    const env = {
        ...process.env,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "safe.directory",
        GIT_CONFIG_VALUE_0: checkout,
    };
    const git = (...args: string[]) =>
        execFileSync(tools.git!, ["-C", checkout, ...args], {
            env,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        }).trim();
    git("init");
    git("config", "core.autocrlf", "false");
    writeFileSync(join(checkout, "base.txt"), "original\n");
    git("add", "base.txt");
    git(
        "-c",
        "user.name=Patch Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "Fixture base",
    );
    const pin = git("rev-parse", "HEAD");
    const patch = join(root, "maintained.patch");
    const writePatch = (content: string) =>
        writeFileSync(
            patch,
            `--- a/base.txt\n+++ b/base.txt\n@@ -1 +1 @@\n-original\n+patched\n` +
                `--- /dev/null\n+++ b/added.txt\n@@ -0,0 +1 @@\n+${content}\n`,
        );
    const apply = () =>
        spawnSync(
            tools.cmake!,
            [
                `-DRMLUI_SOURCE_DIR=${checkout}`,
                `-DRMLUI_PATCH=${patch}`,
                "-P",
                resolve("native/apply-rmlui-patch.cmake"),
            ],
            { env, encoding: "utf8" },
        );
    const expectApplied = () => {
        const result = apply();
        assert.equal(result.status, 0, result.stdout + result.stderr);
    };
    writePatch("first version");
    expectApplied();
    expectApplied();
    assert.equal(
        readFileSync(join(checkout, "added.txt"), "utf8"),
        "first version\n",
    );
    git("checkout", "--force", "--detach", pin);
    assert.equal(
        existsSync(join(checkout, "added.txt")),
        false,
        "reset drops files introduced by the old patch",
    );
    writePatch("second version");
    expectApplied();
    assert.equal(
        readFileSync(join(checkout, "added.txt"), "utf8"),
        "second version\n",
    );
    writeFileSync(join(checkout, "base.txt"), "unrelated edit\n");
    assert.notEqual(apply().status, 0, "divergent patch inputs still refuse");
    assert.equal(
        readFileSync(join(checkout, "base.txt"), "utf8"),
        "unrelated edit\n",
    );
});
