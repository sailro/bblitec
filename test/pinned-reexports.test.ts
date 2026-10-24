import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";

const entry = (from: string, name = "createEngine"): string =>
    `import { ${name} } from "${from}";
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    await ${name}(canvas);`;

test("a pinned export reached through a local re-export is the pinned intrinsic", () => {
    const directory = resolve("artifacts/pinned-reexports");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        resolve(directory, "barrel.ts"),
        'export { createEngine } from "@babylonjs/lite";',
    );
    writeFileSync(
        resolve(directory, "local.ts"),
        'import { createEngine } from "@babylonjs/lite";\nexport { createEngine };',
    );
    writeFileSync(
        resolve(directory, "renamed.ts"),
        'export { createEngine as start } from "@babylonjs/lite";',
    );
    const compile = (source: string): string =>
        compileSource(source, { fileName: resolve(directory, "entry.ts") }).cpp;
    const direct = compile(entry("@babylonjs/lite"));
    assert.equal(compile(entry("./barrel.js")), direct);
    assert.equal(compile(entry("./local.js")), direct);
    assert.equal(compile(entry("./renamed.js", "start")), direct);
});
