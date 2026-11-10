import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { SceneLowerer } from "../src/lowering/scene-lowerer.js";
import {
    lowerThinInstanceApi,
    lowerThinInstanceOwnership,
} from "../src/lowering/thin-instance-lowerer.js";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";
import { pinnedError } from "./pinned-errors.js";

const imports = `import {createEngine,createBox,cloneTransformNode,setThinInstances,setThinInstanceCount,setThinInstanceDrawCount,type Mesh} from "@babylonjs/lite";`;

test("mesh clones retain thin pool and numeric array identities", (t) => {
    const compiled = compileSource(`${imports}
const engine=await createEngine(new OffscreenCanvas(1,1));
const mesh=createBox(engine),other=createBox(engine);
const matrices=new Float32Array(48);
setThinInstances(mesh,matrices,3);
const clone=cloneTransformNode(mesh) as Mesh;
if(clone.thinInstances!==mesh.thinInstances||clone.thinInstances!.matrices!==matrices)throw new Error("shared clone pool");
const originalPool=mesh.thinInstances,clonedPool=clone.thinInstances;
if(originalPool!==clonedPool)throw new Error("named pool identity");
const originalMatrices=originalPool!.matrices;
setThinInstances(other,matrices,3);
if(other.thinInstances===clone.thinInstances)throw new Error("separate pool owner");
setThinInstanceCount(clone,1);
if(mesh.thinInstances!.count!==1)throw new Error("shared clone count");
let caught=false;
try{setThinInstanceDrawCount(mesh,2);}catch(error){caught=error instanceof Error&&error.message==="${pinnedError("setThinInstanceDrawCount requires a fully synchronized fixed-capacity pool")}";}
if(!caught||clone.thinInstances!.count!==1)throw new Error("shared clone sync state");
const wide=new Float64Array(64),view=wide.subarray(16,64);
setThinInstances(other,view,3);
if(other.thinInstances!.matrices!==view||other.thinInstances!.matrices===wide.subarray(16,64))throw new Error("wide view identity");
if(other.thinInstances!.matrices===matrices||matrices===other.thinInstances!.matrices)throw new Error("array arm identity");
if(mesh.thinInstances!==(setThinInstances(mesh,view,3),mesh.thinInstances))throw new Error("pool argument order");
if(clone.thinInstances!==mesh.thinInstances)throw new Error("clone retains pool");
if(originalPool!==clonedPool||originalPool!==mesh.thinInstances||originalPool!.count!==3||originalPool!.matrices!==view||originalMatrices!==matrices)throw new Error("retained pool owner");
if(other.thinInstances!.matrices===(setThinInstances(other,matrices,3),other.thinInstances!.matrices))throw new Error("array argument order");
globalThis.close();
`);
    assert.equal(compiled.manifest.sceneMeshes[2]?.thinInstances, "always");
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required for clone owner checks.");
        return;
    }
    const context = new LoweringContext();
    const thin = lowerThinInstanceApi(context, compiled.manifest.features);
    const scene = new SceneLowerer(context).lowerCore({}).source;
    runGeneratedProgram(
        native,
        "thin-instance-clone-identity",
        `#include <bblite/runtime.hpp>
#include <bblite/thin_instance.hpp>
namespace bbl {
Engine create_engine(EngineOptions) { return {}; }
MeshHandle create_box(Engine& engine, BoxOptions) { return store_mesh_record(engine, MeshRecord{}); }
${lowerThinInstanceOwnership(context)}
${thin}
${cppFunction(scene, "MeshHandle clone_mesh_node(")}
}
${compiled.cpp}`,
        {
            flags: ["/Gy"],
            timeoutMs: 10000,
        },
    );
});

test("a structural view of a mesh reads its thin-instance pool's version", (t) => {
    // The view restates the pool's `_version`, which each pinned thin
    // writer bumps from the 1 its creation sets; a mesh without a pool
    // reads none.
    const compiled =
        compileSource(`import {createEngine,createBox,setThinInstances,setThinInstanceCount,type Mesh} from "@babylonjs/lite";
interface Observed{thinInstances?:{_version?:number|undefined}|null|undefined}
const engine=await createEngine(new OffscreenCanvas(1,1));
const plain=createBox(engine),thin=createBox(engine);
const held:readonly Mesh[]=[plain,thin];
const view=held as unknown as readonly Observed[];
const pool=(index:number):number=>view[index]!.thinInstances?._version??-1;
if(pool(0)!==-1||pool(1)!==-1)throw new Error("absent pools");
setThinInstances(thin,new Float32Array(48),3);
if(pool(0)!==-1||pool(1)!==1)throw new Error("created pool version");
setThinInstanceCount(thin,2);
if(pool(1)!==2)throw new Error("bumped pool version");
globalThis.close();
`);
    assert.match(
        compiled.cpp,
        /bbl::thin_instance_data\(bbl::handle_at\(v_engine\.meshes, .+\)\.thin_instances\)\.version/,
    );
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required for version reads.");
        return;
    }
    const context = new LoweringContext();
    const thin = lowerThinInstanceApi(context, compiled.manifest.features);
    runGeneratedProgram(
        native,
        "thin-instance-version-view",
        `#include <bblite/runtime.hpp>
#include <bblite/thin_instance.hpp>
namespace bbl {
Engine create_engine(EngineOptions) { return {}; }
MeshHandle create_box(Engine& engine, BoxOptions) { return store_mesh_record(engine, MeshRecord{}); }
${lowerThinInstanceOwnership(context)}
${thin}
}
${compiled.cpp}`,
        {
            flags: ["/Gy"],
            timeoutMs: 10000,
        },
    );
});

test("cloning an unbound mesh does not establish a thin pool", () => {
    // The clone reads its own record, which an unbound source gave no pool
    // (a later binding of the source is not the clone's): the member read
    // throws the pin's TypeError when it runs (`thin_instance_data`).
    for (const lateBinding of [
        "",
        "setThinInstances(mesh,new Float32Array(16),1);",
    ])
        assert.match(
            compileSource(`${imports}
const engine=await createEngine(new OffscreenCanvas(1,1));const mesh=createBox(engine);
const clone=cloneTransformNode(mesh) as Mesh;
${lateBinding}
const count=clone.thinInstances!.count;
`).cpp,
            /bbl::thin_instance_count\(bbl::handle_at\(v_engine\.meshes, v_clone\)\.thin_instances\)/,
        );
});
