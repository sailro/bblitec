import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";

test("finite shader keys may select a subset of a compile-time record", () => {
    const result = compileSource(`
import {createEngine,createComputeShader,prepareComputeShader,type ComputeShader} from '@babylonjs/lite';
interface Shaders {readonly horizontal:ComputeShader;readonly vertical:ComputeShader;readonly permute:ComputeShader;}
async function main(){
 const engine=await createEngine(document.createElement('canvas'));
 const options={computeSource:'@compute @workgroup_size(1) fn main() {}',bindings:[]};
 const shaders:Shaders={horizontal:createComputeShader(engine,options),vertical:createComputeShader(engine,options),permute:createComputeShader(engine,options)};
 const axes:('horizontal'|'vertical')[]=['horizontal','vertical'];
 for(const axis of axes) await prepareComputeShader(shaders[axis]);
 await prepareComputeShader(shaders.permute);
}void main();`);
    assert.ok(result.manifest.features.includes("compute:shader"));
    assert.match(result.cpp, /prepare_compute_shader/);
});

test("binding records refuse optional own-property presence that storage cannot distinguish", () => {
    assert.throws(
        () =>
            compileSource(`
import {createEngine,createComputeShader,createComputeBindingSet,type UniformBuffer} from '@babylonjs/lite';
async function main(){
 const engine=await createEngine(document.createElement('canvas'));
 const shader=createComputeShader(engine,{computeSource:'@compute @workgroup_size(1) fn main() {}',bindings:[]});
 const choices:{params?:UniformBuffer}[]=[{}];
 createComputeBindingSet(shader,choices[Math.floor(Math.random())]!);
}void main();`),
        /Compute binding resource records require known own-property presence/,
    );
});
