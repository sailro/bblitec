import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import {readGlb} from "../src/glb-container.js";
import {GLTF_MESH_PLAN} from "../src/gltf-document.js";
import {gltfMeshPlan} from "../src/gltf-mesh-plan.js";
import {packagedFlowGraphPrograms} from "../src/pinned-flow-graph.js";
import {FlowGraphLowerer} from "../src/lowering/flow-graph-lowerer.js";
import {LoweringContext} from "../src/lowering/context.js";
import {doctoredContext} from "./doctored-store.js";

const module = "src/loader-gltf/gltf-feature-interactivity.ts";
function fixture() {
    const glb = readGlb(readFileSync("corpus/babylon-lite/lab/lite/src/demos/Calculator.glb"));
    assert.ok(glb);
    return {document: glb.json, bin: new DataView(glb.binary.buffer, glb.binary.byteOffset, glb.binary.byteLength)};
}

test("interactivity activation, surviving graphs and mesh ownership execute the source feature", async () => {
    const {document, bin} = fixture();
    const base = await gltfMeshPlan(document, bin);
    assert.equal(base.flowGraphs.length, 1);
    assert.equal(base.flowGraphs[0]!.blocks.length, 64);
    assert.deepEqual(base.flowGraphNodes, base.meshes.map(mesh => mesh.node));
    assert.deepEqual(packagedFlowGraphPrograms({...document, [GLTF_MESH_PLAN]: base}), base.flowGraphs);

    const inactive = await gltfMeshPlan(document, bin, doctoredContext("src/loader-gltf/gltf-feature-registry.ts",
        "!!(j.extensions?.KHR_interactivity || j.extensions?.BABYLON_flow_graph)", "false"));
    assert.deepEqual(inactive.flowGraphs, []);
    assert.ok(inactive.flowGraphNodes.every(node => node === null));
    const empty = await gltfMeshPlan(document, bin, doctoredContext(module,
        "graphIndex < graphs.length", "graphIndex < 0"));
    assert.deepEqual(empty.flowGraphs, []);
    assert.ok(empty.flowGraphNodes.every(node => node === null));
    const remapped = await gltfMeshPlan(document, bin, doctoredContext(module,
        "(mesh as InteractivityMesh)._gltfNodeIndex = ni;", "(mesh as InteractivityMesh)._gltfNodeIndex = 0;"));
    assert.ok(remapped.flowGraphNodes.every(node => node === 0));
    const rebound = await gltfMeshPlan(document, bin, doctoredContext(module,
        "{ nodeMap, materials, json: ctx._json }", "{ nodeMap: [...nodeMap].reverse(), materials, json: ctx._json }"));
    const pointer = "/nodes/22/extensions/KHR_node_visibility/visible";
    assert.deepEqual(rebound.flowGraphs[0]!.accessors[pointer]!.target,
        {kind: "node", index: (document.nodes as unknown[]).length - 23});
    const unresolved = await gltfMeshPlan(document, bin, doctoredContext(module,
        "{ nodeMap, materials, json: ctx._json }", "{ nodeMap: [], materials: [], json: ctx._json }"));
    assert.equal(unresolved.flowGraphs[0]!.accessors[pointer], null);
    assert.doesNotThrow(() => new FlowGraphLowerer(new LoweringContext(), [{asset: "Calculator.glb", graphs: unresolved.flowGraphs}]).lower());
});

test("interactivity refuses unrepresented runtime publication and loaded graph wiring", async () => {
    const {document, bin} = fixture();
    for (const [before, after] of [
        ["container.flowGraphRuntimes = runtimes;", "container.flowGraphRuntimes = Promise.resolve([]);"],
        ["rightHanded: true,", "rightHanded: false,"],
        ["{ nodeMap, materials, json: ctx._json }", "{ nodeMap, materials, json: ctx._json, scene: {} }"],
    ]) await assert.rejects(gltfMeshPlan(document, bin, doctoredContext(module, before!, after!)), /Unrepresented/);
    assert.throws(() => packagedFlowGraphPrograms(document), /missing source flow-graph/);
});
