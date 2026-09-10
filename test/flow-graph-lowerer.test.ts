// The Calculator's KHR_interactivity graph is the one authored flow graph the
// corpus reaches. Parsing it under Node with the pinned parser and lowering
// it here keeps the emitted program honest against the asset itself: the
// toy's four operators, its ten digit stores, the fifteen key receivers and
// the display's pointer writes are what the asset holds, not what the port
// remembers about it.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import {readFileSync} from "node:fs";
import {readGlb} from "../src/glb-container.js";
import {packageGltfLoadPlan} from "../src/gltf-load-plan.js";
import { LoweringContext } from "../src/lowering/context.js";
import { FlowGraphLowerer } from "../src/lowering/flow-graph-lowerer.js";
import { parseFlowGraphs } from "../src/pinned-flow-graph.js";
import type { FlowGraphProgram } from "../src/pinned-flow-graph.js";

const calculator = resolve("corpus/babylon-lite/lab/lite/src/demos/Calculator.glb");
// One upstream store and one pinned parse for the file; a test that
// mutates the parsed graph takes its own copy.
const context = new LoweringContext();
let parsed: Promise<FlowGraphProgram[]> | undefined;

async function calculatorGraphs(): Promise<FlowGraphProgram[]> {
    parsed ??= (async () => {
        const packaged = readGlb(await packageGltfLoadPlan(readFileSync(calculator), calculator));
        assert.ok(packaged);
        return parseFlowGraphs("Calculator.glb", packaged.json);
    })();
    return structuredClone(await parsed);
}

function lower(graphs: FlowGraphProgram[]): string {
    return new FlowGraphLowerer(context, [
        { asset: "Calculator.glb", graphs },
    ]).lower().source;
}

test("parses the Calculator's graph off the pinned parser", async () => {
    const graphs = await calculatorGraphs();
    assert.equal(graphs.length, 1);
    const [graph] = graphs;
    assert.equal(graph!.graphIndex, 0);
    assert.equal(graph!.blocks.length, 64);
    // One receiver per key: ten digits and five operators.
    assert.equal(
        graph!.blocks.filter((block) => block.type === "OnSelect").length,
        15,
    );
    assert.equal(
        graph!.blocks.filter((block) => block.type === "SceneReadyEvent").length,
        1,
    );
    // One variable, the number on the display.
    assert.deepEqual(Object.keys(graph!.variables), ["0"]);
    // The pin's accessors, executed over recording stand-ins: the minus
    // sign's visibility writes the node's `visible` (the cascade walks its
    // children), its selectability lives in a closure the stand-in never
    // sees, and the two digit materials' offsets write the base-colour
    // texture's lanes plus the pin's dirty bump.
    const accessors = graph!.accessors;
    const touched = (pointer: string): string[] =>
        [...new Set(accessors[pointer]!.touches.map((touch) => touch.path))].sort();
    const visibility = "/nodes/22/extensions/KHR_node_visibility/visible";
    assert.deepEqual(accessors[visibility]!.target, { kind: "node", index: 22 });
    assert.equal(accessors[visibility]!.type, "boolean");
    assert.deepEqual(touched(visibility), ["children.length", "visible"]);
    assert.ok(accessors[visibility]!.touches.some((touch) => touch.path === "visible" && touch.write));
    const selectability = "/nodes/22/extensions/KHR_node_selectability/selectable";
    assert.deepEqual(accessors[selectability]!.target, { kind: "node", index: 22 });
    assert.deepEqual(touched(selectability), []);
    for (const material of [4, 5]) {
        const offset = `/materials/${material}/pbrMetallicRoughness/baseColorTexture/extensions/KHR_texture_transform/offset`;
        assert.deepEqual(accessors[offset]!.target, { kind: "material", index: material });
        assert.equal(accessors[offset]!.type, "Vector2");
        assert.ok(accessors[offset]!.writable);
        assert.deepEqual(touched(offset), ["_uboVersion", "baseColorTexture.uOffset", "baseColorTexture.vOffset"]);
        const scale = `/materials/${material}/pbrMetallicRoughness/baseColorTexture/extensions/KHR_texture_transform/scale`;
        assert.deepEqual(touched(scale), ["_uboVersion", "baseColorTexture.uScale", "baseColorTexture.vScale"]);
    }
});

test("refuses an accessor whose pinned setter touches a member the port has no field for", async () => {
    const graphs = await calculatorGraphs();
    const offset = "/materials/4/pbrMetallicRoughness/baseColorTexture/extensions/KHR_texture_transform/offset";
    const accessor = graphs[0]!.accessors[offset]!;
    accessor.touches = accessor.touches.map((touch) =>
        touch.path === "baseColorTexture.uOffset" ? { ...touch, path: "baseColorTexture.uAng" } : touch,
    );
    assert.throws(() => lower(graphs), /does not map the pin's accessor for \/materials\/4/);
});

test("lowers the Calculator's graph to the asset's own arithmetic", async () => {
    const source = lower(await calculatorGraphs());
    // The display value is the variable through clamp(-99, 99).
    assert.match(
        source,
        /std::min<double>\(std::max<double>\(state\.slot_node_0_value, -99\.0\), 99\.0\)/,
    );
    // A digit key stores itself.
    for (let digit = 0; digit <= 9; digit++) {
        assert.match(source, new RegExp(`state\\.var_0 = ${digit}\\.0;`));
    }
    // The operator keys fold the stored number: +1, -1, x2 and floor(/2).
    assert.match(source, /\(state\.slot_node_0_value \+ 1\.0\)/);
    assert.match(source, /\(state\.slot_node_0_value - 1\.0\)/);
    assert.match(source, /\(state\.slot_node_0_value \* 2\.0\)/);
    assert.match(source, /\(state\.slot_node_0_value \/ 2\.0\)/);
    assert.match(source, /std::floor\(state\.slot_node_8_value\)/);
    // Fifteen receivers, each keyed on the picked node index.
    assert.equal(source.match(/payload\.node_index != \d+\.0/g)?.length, 15);
    // The minus sign hides through the visibility accessor, the digits scroll
    // through the two materials' texture-transform offsets.
    assert.match(source, /set_gltf_node_visible\(host\.engine, host\.asset, 22u, /);
    assert.match(source, /gltf_base_color_transform\(host\.engine, host\.asset, 4u\)\.u_scale/);
    assert.match(source, /gltf_base_color_transform\(host\.engine, host\.asset, 5u\)\.u_scale/);
    assert.equal(
        source.match(/TextureTransform& transform = gltf_base_color_transform\(host\.engine, host\.asset, [45]u\);/g)?.length,
        2,
    );
});

test("refuses a block type outside the admitted set", async () => {
    const graphs = await calculatorGraphs();
    const block = graphs[0]!.blocks.find((candidate) => candidate.type === "Abs");
    assert.ok(block);
    block.type = "Sine";
    assert.throws(() => lower(graphs), /does not lower the 'Sine' block type/);
});
