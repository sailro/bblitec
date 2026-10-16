import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { joinAssetFeatures } from "../src/asset-feature-join.js";
import { emitAssetSpecializations } from "../src/asset-specializer.js";
import { withMeshPlan } from "./gltf-mesh-fixture.js";

function source(actions: readonly string[]): string {
    return `
import {createEngine,createBox,setThinInstances,createSceneContext,createComputeTask,addTaskAtStart,enableDeviceLostSceneRecovery,
createRenderTarget,createRenderTask,createGeometryRendererTask,GeometryTextureType,addTaskAfter,loadGltf} from "@babylonjs/lite";
async function main(){
 const engine=await createEngine(document.createElement("canvas"));
 const mesh=createBox(engine);
 ${actions.join("\n")}
}
void main();`;
}
const pool = "setThinInstances(mesh,new Float32Array(16),1);";
test("thin pools refuse split frame submissions and admit recovery registration in either source order", () => {
    const frameGraph =
        "const scene=createSceneContext(engine);const task=createComputeTask(engine,'task');addTaskAtStart(scene,task);";
    for (const actions of [
        [pool, frameGraph],
        [frameGraph, pool],
    ])
        assert.throws(
            () => compileSource(source(actions)),
            /shared indirect-argument write ordering/,
        );
    const recovery = "enableDeviceLostSceneRecovery(engine);";
    for (const actions of [
        [pool, recovery],
        [recovery, pool],
    ]) {
        const result = compileSource(source(actions));
        assert.ok(result.manifest.features.includes("mesh:thin-instances"));
        assert.ok(result.manifest.features.includes("engine:device-recovery"));
        assert.ok(
            result.manifest.generatedSources.includes(
                "upstream/src/device_recovery.cpp",
            ),
        );
    }
});
test("thin pools retain ordinary compute resources without a split frame graph", () => {
    const result = compileSource(
        source([
            pool,
            "const task=createComputeTask(engine,'task');task.dispose();",
        ]),
    );
    assert.ok(result.manifest.features.includes("mesh:thin-instances"));
    assert.ok(result.manifest.features.includes("compute:task"));
    assert.ok(!result.manifest.features.includes("compute:frame-graph"));
});

const ordinaryTask = `const scene=createSceneContext(engine,{defaultRenderTask:false});
const target=createRenderTarget({format:engine.format,samples:1,size:engine});
const task=createRenderTask({rt:target,autoMirror:false},engine,scene);
addTaskAfter(scene,task,task);`;
const geometryTask = `const scene=createSceneContext(engine,{defaultRenderTask:false});
const task=createGeometryRendererTask({name:"geometry",samples:1,textureDescriptions:[{type:GeometryTextureType.WORLD_POSITION}]},engine,scene);
addTaskAfter(scene,task,task);`;

test("thin pools retain ordinary render tasks but refuse actual geometry outputs in either source order", () => {
    const ordinary = compileSource(source([pool, ordinaryTask]));
    assert.ok(ordinary.manifest.features.includes("renderer:geometry-output"));
    assert.deepEqual(ordinary.manifest.geometryOutputTasks, []);
    const geometry = compileSource(source([geometryTask]));
    assert.equal(geometry.manifest.geometryOutputTasks.length, 1);
    for (const actions of [
        [pool, geometryTask],
        [geometryTask, pool],
    ])
        assert.throws(
            () => compileSource(source(actions)),
            /geometry-output task buffer ownership/,
        );
});

test("late instanced glTF facts distinguish geometry outputs from ordinary render tasks", async () => {
    const document = await withMeshPlan({
        asset: { version: "2.0" },
        extensionsUsed: ["EXT_mesh_gpu_instancing"],
        nodes: [],
        meshes: [],
        scenes: [{ nodes: [] }],
        scene: 0,
    });
    const specialization = {
        ...emitAssetSpecializations("", [], new Map()),
        gpuInstancing: true,
    };
    for (const [task, refuses] of [
        [ordinaryTask, false],
        [geometryTask, true],
    ] as const) {
        const result = compileSource(
            source([task, 'await loadGltf(engine,"model.glb");']),
        );
        // Reached loader facts can also be supplied by a caller of the asset join.
        result.manifest.features.push("mesh:thin-instances");
        const asset = result.manifest.assets.find(
            (entry) => entry.kind === "gltf",
        )!;
        const joined = joinAssetFeatures({
            result,
            outputPath: "",
            documents: new Map([[asset.output, document]]),
            specialization,
            splatHarmonics: undefined,
        });
        if (refuses)
            await assert.rejects(
                joined,
                /geometry-output task buffer ownership/,
            );
        else await assert.doesNotReject(joined);
    }
});
