import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

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

test("first-skinned DFS reads reachable instances in scene order and tests their live skeletons", (t) => {
    const entry = compileSource(`
        import {createEngine, loadGltf, type Mesh, type TransformNode} from "@babylonjs/lite";
        function first(node: TransformNode): Mesh | null {
            const m = node as unknown as Mesh;
            if (m.skeleton) return m;
            for (const child of (node.children ?? []) as TransformNode[]) {
                const hit = first(child); if (hit) return hit;
            }
            return null;
        }
        async function main() {
            const engine = await createEngine({});
            const asset = await loadGltf(engine, ${JSON.stringify(url)});
            const mesh = first(asset.entities[0] as TransformNode);
            if (mesh) throw new Error("unexpected mesh");
        }
        void main();`);
    assert.match(entry.cpp, /bbl::first_skinned_gltf_descendant\(/);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler unavailable");
        return;
    }
    runGeneratedProgram(
        tools,
        "first-skinned-descendant",
        `
        #include <bblite/runtime.hpp>
        using namespace bbl;
        int main() {
            Engine engine;
            engine.meshes.resize(3);
            engine.assets.resize(1);
            auto& asset = engine.assets[0];
            asset.meshes = {MeshHandle{0}, MeshHandle{1}, MeshHandle{2}};
            engine.meshes[0].skeleton_attached = engine.meshes[1].skeleton_attached = true;
            const auto find = [&] { return first_skinned_gltf_descendant(engine, AssetHandle{0}).value; };
            try { (void)find(); return 1; } catch (const std::runtime_error&) {}
            install_asset_scene_meshes(asset, {1,0,2});
            if (find() != 1) return 2;
            engine.meshes[1].skeleton_attached = false;
            if (find() != 0) return 3;
            install_asset_scene_meshes(asset, {2});
            if (find() != invalid_handle) return 4;
            install_asset_scene_meshes(asset, {});
            if (find() != invalid_handle) return 5;
        }`,
    );
});

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
