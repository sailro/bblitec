import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";

function compileLoads(loads: readonly string[]) {
    return compileSource(`
        import { createEngine, loadGltf } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            ${loads
                .map(
                    (source) =>
                        `await loadGltf(engine, ${JSON.stringify(source)});`,
                )
                .join("\n            ")}
        }
    `);
}

test("preserves contiguous repeated glTF container order", () => {
    const result = compileLoads([
        "a.glb",
        "a.glb",
        "b.glb",
        "b.glb",
    ]);

    assert.deepEqual(
        result.manifest.assets.map(
            ({ source, containerCount }) => ({
                source,
                containerCount,
            }),
        ),
        [
            { source: "a.glb", containerCount: 2 },
            { source: "b.glb", containerCount: 2 },
        ],
    );
    assert.equal(
        result.cpp.match(/bbl::load_gltf\(/g)?.length,
        4,
    );
});

test("refuses an interleaved repeated glTF source", () => {
    assert.throws(
        () => compileLoads(["a.glb", "b.glb", "a.glb"]),
        /a\.glb.*loaded again after a different glTF source.*must be contiguous/s,
    );
});
