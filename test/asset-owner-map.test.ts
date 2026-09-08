import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { CompileError, compileSource } from "../src/compiler.js";
import { gltfMeshWalks } from "../src/gltf-mesh-walks.js";

const source = ts.createSourceFile("scene104.ts", readFileSync("corpus/babylon-lite/lab/lite/src/lite/scene104.ts", "utf8"), ts.ScriptTarget.Latest, true);
const helpers = source.statements.filter(statement => ts.isFunctionDeclaration(statement) &&
    ["isMeshNode", "hasChildren", "collectByOwner", "buildOwnerMap"].includes(statement.name?.text ?? ""))
    .map(statement => statement.getText()).join("\n");
const compile = (body = helpers) => compileSource(`
    import { createEngine, loadGltf, type AssetContainer, type Mesh, type SceneNode } from "@babylonjs/lite";
    ${body}
    const engine = await createEngine({});
    const asset = await loadGltf(engine, "hierarchy.gltf");
    const groups = buildOwnerMap(asset);
    const selected = groups.get("shared");
    if (selected && selected.length !== 3) throw new Error("Owner group membership changed");
`);

test("asset owner maps retain pinned wrapper names, shared-name groups and primitive order", async () => {
    const result = compile();
    assert.match(result.cpp, /asset_mesh_walk/);
    assert.match(result.cpp, /scene_node_name/);
    const walks = result.manifest.meshWalks!;
    assert.equal(walks.length, 1);
    assert.equal(walks[0]!.kind, "owner-map");
    const hierarchy = {
        asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0, 1, 2] }],
        nodes: [{ name: "shared", mesh: 0 }, { name: "other", mesh: 1 }, { name: "shared", mesh: 1 }],
        meshes: [{ primitives: [{}, {}] }, { primitives: [{}] }],
    };
    assert.deepEqual(await gltfMeshWalks(hierarchy, walks), [[0, 1, 3, 2]]);
    await assert.rejects(gltfMeshWalks(hierarchy, [{
        kind: "owner-map", parameter: "container",
        body: walks[0]!.body.replace("child.name, out", '"wrong", out'),
    }]), /node-wrapper identity/);
});

test("owner-map admission refuses changed grouping, traversal, guards and side effects", () => {
    for (const [from, to] of [
        ["out.get(ownerName)", "out.get(child.name)"],
        ["list.push(child)", "list.push(node)"],
        ["out.set(ownerName, list)", "out.set(child.name, list)"],
        ["? ownerName : child.name", "? child.name : ownerName"],
        ["node.children", "node.otherChildren"],
        ["entity.name, out", '"constant", out'],
        ['"_gpu" in node', '"missing" in node'],
        ["Array.isArray", "Array.isView"],
        ["const list =", "console.log(child); const list ="],
        ["return out;", "return new Map<string, Mesh[]>();"],
    ]) {
        assert.ok(helpers.includes(from!), from);
        assert.throws(() => compile(helpers.replace(from!, to!)), CompileError);
    }
});
