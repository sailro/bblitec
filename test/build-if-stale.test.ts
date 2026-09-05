import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

test("the build wrapper repairs missing JavaScript even when its input stamp matches", (t) => {
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
    write("node_modules/@typescript/native/package.json", '{"version":"fixture","type":"module"}');
    write("node_modules/typescript/package.json", '{"version":"fixture"}');
    write("node_modules/@typescript/native/bin/tsc", `
import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync("dist/src", { recursive: true });
writeFileSync("dist/src/entry.js", "export const answer = 42;");
writeFileSync("dist/compiler-output.json", "{}");
`);
    mkdirSync(join(root, "tools"));
    for (const name of ["build-if-stale.mjs", "clean-dist.mjs"]) {
        copyFileSync(join("tools", name), join(root, "tools", name));
    }
    const build = (): string => execFileSync(process.execPath, ["tools/build-if-stale.mjs"], {
        cwd: root, encoding: "utf8",
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
