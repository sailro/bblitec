import assert from "node:assert/strict";
import test from "node:test";
import { nodeGeometryAssetRefusal } from "../src/node-geometry-assets.js";
import type { JsonObject } from "../src/gltf-document.js";
import { compileSource } from "../src/compiler.js";

function asset(): JsonObject {
    return {
        nodes: [{mesh: 0, matrix: [-1,0,0,0, 0,2,0,0, 0,0,1,0, 3,4,5,1]}],
        meshes: [{primitives: [{attributes: {POSITION: 0, NORMAL: 1, TEXCOORD_0: 2}}]}],
        accessors: [
            {bufferView:0, byteOffset:12, componentType:5126, type:"VEC3", count:3},
            {bufferView:1, byteOffset:24, componentType:5126, type:"VEC3", count:3},
            {bufferView:2, componentType:5126, type:"VEC2", count:3},
        ],
        bufferViews: [{byteOffset:16}, {byteOffset:80}, {byteOffset:160}],
    };
}

test("node geometry accepts tight source lanes and ignores unused strided views", async () => {
    const document = asset();
    (document.bufferViews as JsonObject[]).push({byteStride:32});
    (document.meshes as JsonObject[]).push({primitives:[{attributes:{POSITION:99}}]});
    assert.equal(await nodeGeometryAssetRefusal(document), undefined);
    const tight = asset();
    (tight.bufferViews as JsonObject[]).forEach((view, index) => { view.byteStride = index === 2 ? 8 : 12; });
    assert.equal(await nodeGeometryAssetRefusal(tight), undefined);
});

test("node geometry rejects each reached strided lane and missing raw normals", async () => {
    for (const [index, name] of ["POSITION", "NORMAL", "TEXCOORD_0"].entries()) {
        const document = asset();
        (document.bufferViews as JsonObject[])[index]!.byteStride = 32;
        assert.match((await nodeGeometryAssetRefusal(document))!, new RegExp(`strided imported ${name}`));
    }
    const missing = asset();
    missing.meshes = [{primitives:[{attributes:{POSITION:0}}]}];
    assert.match((await nodeGeometryAssetRefusal(missing))!, /missing imported NORMAL/);
    const extra = asset();
    extra.meshes = [{primitives:[{attributes:{POSITION:0,NORMAL:1,TEXCOORD_0:2,TANGENT:3}}]}];
    (extra.accessors as JsonObject[]).push({bufferView:3,componentType:5126,type:"VEC4",count:3});
    (extra.bufferViews as JsonObject[]).push({byteStride:32});
    assert.match((await nodeGeometryAssetRefusal(extra))!, /strided imported TANGENT/);
});

test("node geometry keeps imported deformation and attribute formats explicitly bounded", async () => {
    const cases: Array<[Partial<JsonObject>, RegExp]> = [
        [{animations:[{channels:[]}]}, /animated/],
        [{nodes:[{mesh:0, skin:0}]}, /skinned/],
        [{nodes:[{mesh:0, extensions:{EXT_mesh_gpu_instancing:{}}}]}, /instanced/],
        [{meshes:[{primitives:[{targets:[{}], attributes:{POSITION:0,NORMAL:1}}]}]}, /morph targets/],
        [{meshes:[{primitives:[{attributes:{POSITION:0,NORMAL:1,JOINTS_0:3}}]}]}, /joint attributes/],
    ];
    for (const [changes, expected] of cases) assert.match((await nodeGeometryAssetRefusal({...asset(), ...changes}))!, expected);
    const format = asset();
    (format.accessors as JsonObject[])[1]!.componentType = 5122;
    assert.match((await nodeGeometryAssetRefusal(format))!, /non-FLOAT VEC3 imported NORMAL/);
    const count = asset();
    (count.accessors as JsonObject[])[1]!.count = 2;
    assert.match((await nodeGeometryAssetRefusal(count))!, /mismatched imported NORMAL count/);
});

function source(body: string, views = true, viewsFirst = false): string {
    const tasks = views ? `
        await parseNodeMaterialFromSnippet(engine, "", {json:{blocks:[]}});
        createGeometryRendererTask({name:"g", samples:1,
            textureDescriptions:[{type:GeometryTextureType.WORLD_NORMAL}]}, engine, scene);
    ` : "";
    return `
        import {createEngine, createSceneContext, loadGltf, createBox,
            parseNodeMaterialFromSnippet, createGeometryRendererTask, GeometryTextureType,
            cloneTransformNode, setParent, createTransformNode, getContainerMeshes, type Mesh} from "@babylonjs/lite";
        const engine = await createEngine({});
        const scene = createSceneContext(engine);
        const loaded = await loadGltf(engine, "https://example.test/tight.glb");
        const node = createTransformNode("parent");
        const imported = getContainerMeshes(loaded)[0]!;
        ${viewsFirst ? tasks : ""}
        ${body}
        ${viewsFirst ? "" : tasks}
    `;
}

test("node geometry rejects imported transform writers through helpers and aliases in either reach order", () => {
    const writes = [
        "imported.position.x = 2;",
        "imported.rotation.y += .1;",
        "imported.scaling.set(2,2,2);",
        "const position = imported.position; position.x = 2;",
        "const position = imported.position; position.set(1,2,3);",
        "function move(mesh:Mesh) { mesh.position.z = 2; } move(imported);",
        "const bag = {mesh: imported}; bag.mesh.position.x = 2;",
        "setParent(imported, node);",
        "imported.parent = node;",
        "cloneTransformNode(imported);",
        "const root = loaded.entities[0]!; root.position.set(1,2,3);",
        "Object.assign(imported, {position:{x:1,y:2,z:3}});",
    ];
    for (const body of writes) for (const first of [false, true]) {
        assert.throws(() => compileSource(source(body, true, first)), /static imported mesh transforms/, body);
    }
    assert.doesNotThrow(() => compileSource(source("imported.position.x = 2;", false)));
});

test("node geometry preserves proven scene-authored transforms alongside an imported asset", () => {
    assert.doesNotThrow(() => compileSource(source(`
        const mesh = createBox(engine);
        mesh.position.x = 2;
        const position = mesh.position;
        position.set(1,2,3);
        mesh.parent = node;
    `)));
});
