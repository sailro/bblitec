import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

function fixture(t: test.TestContext) {
    const root = mkdtempSync(join(tmpdir(), "bblite-dist-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const write = (path: string, contents: string): void => {
        const target = join(root, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, contents);
    };
    write("package.json", '{"type":"module"}');
    write("package-lock.json", "{}");
    write("tsconfig.json", "{}");
    write("src/entry.ts", "export const answer = 42;");
    write("test/types.d.ts", "declare const fixture: number;");
    write(
        "node_modules/@typescript/native/package.json",
        '{"version":"fixture","type":"module"}',
    );
    write("node_modules/typescript/package.json", '{"version":"fixture"}');
    write(
        "node_modules/@typescript/native/bin/tsc",
        `
import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync("dist/src", { recursive: true });
writeFileSync("dist/src/entry.js", "export const answer = 42;");
writeFileSync("dist/compiler-output.json", "{}");
`,
    );
    mkdirSync(join(root, "tools"));
    for (const name of [
        "build-if-stale.mjs",
        "clean-dist.mjs",
        "dist-access.mjs",
    ]) {
        copyFileSync(join("tools", name), join(root, "tools", name));
    }
    return { root, write };
}

test("the build wrapper repairs missing JavaScript even when its input stamp matches", (t) => {
    const { root, write } = fixture(t);
    const build = (): string =>
        execFileSync(process.execPath, ["tools/build-if-stale.mjs"], {
            cwd: root,
            encoding: "utf8",
        });
    build();
    assert.match(build(), /up to date/);
    rmSync(join(root, "dist/src/entry.js"));
    assert.doesNotMatch(build(), /up to date/);
    assert.ok(existsSync(join(root, "dist/src/entry.js")));
    // Output inventory comes from the successful compiler run, regardless
    // of whether an emitted file has a same-named TypeScript source.
    rmSync(join(root, "dist/compiler-output.json"));
    assert.doesNotMatch(build(), /up to date/);
    assert.ok(existsSync(join(root, "dist/compiler-output.json")));
    write("dist/.build-stamp", "malformed");
    assert.doesNotMatch(build(), /up to date/);
    assert.match(build(), /up to date/);
});

test("parallel builds publish one complete dist tree without cleaning a running compiler", async (t) => {
    const { root, write } = fixture(t);
    write(
        "node_modules/@typescript/native/bin/tsc",
        `import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
         appendFileSync("compiles.log", "compile\\n");
         mkdirSync("dist/src", { recursive: true });
         writeFileSync("dist/src/entry.js", "export const answer = 42;");
         Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);
         if (!existsSync("dist/src/entry.js")) throw new Error("dist disappeared while compiling");
         writeFileSync("dist/compiler-output.json", "{}");`,
    );
    const build = () =>
        promisify(execFile)(process.execPath, ["tools/build-if-stale.mjs"], {
            cwd: root,
            encoding: "utf8",
        });
    const results = await Promise.all([build(), build()]);
    assert.equal(readFileSync(join(root, "compiles.log"), "utf8"), "compile\n");
    assert.equal(
        results.filter((result) => /up to date/.test(result.stdout)).length,
        1,
    );
    assert.ok(existsSync(join(root, "dist/src/entry.js")));
    assert.ok(existsSync(join(root, "dist/compiler-output.json")));
    assert.equal(existsSync(join(root, "artifacts/.dist-writer.lock")), false);
});

test("a failed compiler releases its writer gate without publishing a build stamp", (t) => {
    const { root, write } = fixture(t);
    write("node_modules/@typescript/native/bin/tsc", "process.exit(7);");
    assert.throws(() =>
        execFileSync(process.execPath, ["tools/build-if-stale.mjs"], {
            cwd: root,
            encoding: "utf8",
        }),
    );
    assert.equal(existsSync(join(root, "artifacts/.dist-writer.lock")), false);
    assert.equal(existsSync(join(root, "dist/.build-stamp")), false);
});
