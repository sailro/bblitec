import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";

const url =
    "data:model/gltf+json;base64," +
    Buffer.from(
        JSON.stringify({
            asset: { version: "2.0" },
            scenes: [{ nodes: [] }],
            scene: 0,
        }),
    ).toString("base64");
function source(predicate: string) {
    return `
    import {createEngine, loadGltf} from "@babylonjs/lite";
    async function main() {
        const engine = await createEngine({});
        const asset = await loadGltf(engine, ${JSON.stringify(url)});
        const root = asset.entities.find(entity => ${predicate});
        if (!root) throw new Error("missing root");
        root.position.set(1, 2, 3);
    }
    void main();`;
}

test("glTF entity search tests its first root through the source predicate", () => {
    const result = compileSource(source('!("lightType" in entity)'));
    assert.doesNotMatch(result.cpp, /missing root/);
    assert.match(result.cpp, /asset_root/);
    for (const predicate of ['"lightType" in entity', "Math.random() > 0.5"])
        assert.throws(
            () => compileSource(source(predicate)),
            /Entity search beyond the synthetic glTF root/,
        );
});
