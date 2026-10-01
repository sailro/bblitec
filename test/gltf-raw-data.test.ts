import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { compileSource } from "../src/compiler.js";

/**
 * `loadGltf(engine, bytes)` over the `arrayBuffer()` of a generation-time
 * fetch loads the packaged file, which the pin parses without a base URL.
 */

const output = resolve("artifacts/gltf-raw-data");
mkdirSync(output, { recursive: true });
copyFileSync(
    resolve("examples/assets/regression/gltf-uv-sets.gltf"),
    resolve(output, "embedded.gltf"),
);
writeFileSync(
    resolve(output, "external.gltf"),
    JSON.stringify({
        asset: { version: "2.0" },
        buffers: [{ uri: "external.bin", byteLength: 4 }],
    }),
);

const compile = (body: string) =>
    compileSource(
        `
        import { createEngine, loadGltf } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            ${body}
        }
    `,
        { fileName: resolve(output, "input.ts") },
    );

test("loads the packaged file a fetched response's bytes come from", () => {
    const result = compile(`
        const url = "embedded.gltf";
        const response = await fetch(url);
        if (!response.ok) throw new Error("missing");
        const loaded = await loadGltf(engine, await response.arrayBuffer());
        void loaded;
    `);
    assert.deepEqual(
        result.manifest.assets.map(({ kind }) => kind),
        ["gltf"],
    );
    assert.match(result.cpp, /bbl::load_gltf\(v_engine, bbl::asset_path\(/);
    assert.doesNotMatch(result.cpp, /read_binary_file/);
});

test("refuses raw data that names a resource it cannot resolve", () => {
    assert.throws(
        () =>
            compile(`
        const response = await fetch("external.gltf");
        await loadGltf(engine, await response.arrayBuffer());
    `),
        /loadGltf raw data has no base URL to resolve 'external\.bin'/,
    );
});

test("refuses raw data that is not a fetched response's bytes", () => {
    assert.throws(
        () =>
            compile(`
        await loadGltf(engine, new ArrayBuffer(8));
    `),
        /loadGltf raw data must be the arrayBuffer\(\) of a generation-time fetch response/,
    );
});
