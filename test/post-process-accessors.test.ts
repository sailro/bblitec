import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { PostProcessLowerer } from "../src/lowering/post-process-lowerer.js";
import { compositeScalarAccessors } from "../src/lowering/post-process-accessors.js";
import { composeComposite } from "../src/pinned-post-process.js";

test("composite scalar accessors retain the inline pass parameter and explicit upload boundary", async () => {
    const result = compileSource(`
import {createEngine,createSceneContext,createRenderTarget,createBloomPostProcessTask} from '@babylonjs/lite';
async function main(){
 const engine=await createEngine(document.createElement('canvas'));
 const scene=createSceneContext(engine);
 const source=createRenderTarget({format:engine.format,samples:1,size:engine});
 const bloom=createBloomPostProcessTask({sourceTexture:source,targetTexture:null,weight:0.32},engine,scene);
 if(bloom.weight!==0){bloom.weight=0;bloom.updateUniforms();}
}void main();`);
    assert.match(result.cpp, /get_composite_post_process_0_weight/);
    assert.match(result.cpp, /set_composite_post_process_0_weight/);
    const request = result.manifest.postProcessComposites[0]!;
    const composite = await composeComposite(request);
    const lowered = new PostProcessLowerer(
        new LoweringContext(),
        [],
        [composite],
    ).lowerTaskRecords();
    assert.match(
        lowered.source,
        /get_composite_post_process_0_weight[\s\S]*?passes\.at\(3\)\.params\.at\(0\)/,
    );
    const setter = lowered.source.slice(
        lowered.source.indexOf("void set_composite_post_process_0_weight"),
    );
    assert.match(setter, /parameter = value/);
    assert.doesNotMatch(setter, /uniforms_dirty/);
});

test("unreached composite accessors are not lowered", () => {
    assert.deepEqual(
        compositeScalarAccessors("createSmaaPostProcessTask", []),
        [],
    );
});
