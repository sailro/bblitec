import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";

function sourceWithRootWrite(write: string): string {
    return `
        import {
            createEngine,
            createTransformNode,
            loadGltf,
            setParent,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const container = await loadGltf(engine, "model.glb");
            const root = container.entities[0]!;
            const alias = root;
            const parent = createTransformNode("parent");
            setParent(root, parent);
            ${write}
        }
        void main();
    `;
}

test("refuses imported-root writes through aliases after setParent", () => {
    for (const write of [
        "alias.position.x = 1;",
        "alias.rotation.set(0, 1, 0);",
    ]) {
        assert.throws(
            () => compileSource(sourceWithRootWrite(write)),
            /Writing an imported root after setParent is not lowered/,
        );
    }
});

test("keeps separate roots for repeated loads of one glTF source", () => {
    const result = compileSource(`
        import {
            createEngine,
            createTransformNode,
            loadGltf,
            setParent,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const first = await loadGltf(engine, "model.glb");
            const second = await loadGltf(engine, "model.glb");
            const firstRoot = first.entities[0]!;
            const secondRoot = second.entities[0]!;
            setParent(firstRoot, createTransformNode("parent"));
            secondRoot.position.set(1, 2, 3);
        }
        void main();
    `);

    assert.match(result.cpp, /bbl::set_asset_root_parent\(/);
    assert.equal(
        result.cpp.match(/bbl::set_asset_root_position\(/g)?.length,
        1,
    );
    assert.doesNotMatch(result.cpp, /bbl::set_asset_root_position_component\(/);
});

test("runtime glTF selections retain loader kind and every possible root mutation", () => {
    const prefix = `
        import { createEngine, createTransformNode, loadGltf, setParent } from "@babylonjs/lite";
        async function main() {
            const engine = await createEngine({});
            const first = await loadGltf(engine, "first.glb");
            const second = await loadGltf(engine, "second.glb");
            const selected = Math.random() > 0.5 ? first : second;
            const root = selected.entities[0]!;
    `;
    const result = compileSource(prefix + "root.position.x = 1; } void main();");
    assert.match(result.cpp, /bbl::set_asset_root_position_component/);
    for (const mutation of [
        "setParent(first.entities[0]!, createTransformNode('parent')); root.position.x = 1;",
        "setParent(root, createTransformNode('parent')); second.entities[0]!.position.x = 1;",
    ]) assert.throws(() => compileSource(prefix + mutation + "} void main();"), /Writing an imported root after setParent is not lowered/);
});
