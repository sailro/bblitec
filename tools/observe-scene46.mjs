#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {suiteBrowserModule,createSuiteSceneServer} from '../dist/src/capture-suite-reference.js';
import {withBrowserPage,waitForSceneReady,screenshotCaptureBrowserArgs} from '../dist/src/browser-harness.js';
import {compareImages} from '../dist/src/parity.js';
const source='corpus/babylon-lite/lab/lite/src/lite/scene46.ts';
const text=readFileSync(source,'utf8');
const marker='ballAndSocket(scene, engine, world);';
assert.equal(text.split(marker).length,2);
const hook=`let observedSteps=0;
const observedStep=hknp.HP_World_Step;
hknp.HP_World_Step=(...args)=>{const result=observedStep(...args);++observedSteps;return result;};
window.__observeConstraints=()=>({steps:observedSteps,viewport:{width:canvas.width,height:canvas.height},
 camera:[scene.camera.position.x,scene.camera.position.y,scene.camera.position.z],
 bodies:world._bodies.map(body=>({mesh:scene.meshes.indexOf(body.node),transform:hknp.HP_Body_GetQTransform(body._hkBody)[1]}))});`;
const module=suiteBrowserModule(source,value=>value.replace(marker,hook+'\n'+marker));
const server=createSuiteSceneServer(module,{sourcePath:source});
const output=resolve('artifacts/scene46-controls/browser');mkdirSync(output,{recursive:true});
const frames=[],input=[];
await withBrowserPage(server,{serverName:'scene46 controls',browserArgs:screenshotCaptureBrowserArgs,viewport:{width:1280,height:720}},async(page,origin)=>{
 for(const frame of [10,60,240]){
  await waitForSceneReady(page,origin,false,`?captureFrame=${frame}`);
  const state=await page.evaluate(()=>window.__observeConstraints());
  assert.equal(state.steps,frame+1);
  const image=resolve(output,`frame-${frame}.png`);await page.screenshot({path:image});
  frames.push({frame,...state,image});
 }
 assert.equal(compareImages(frames[0].image,'reference/scene46/babylon-lite-golden.png').maxDiff,0);
 await waitForSceneReady(page,origin,false);
 const snapshot=async name=>{const state=await page.evaluate(()=>window.__observeConstraints());const image=resolve(output,name+'.png');await page.screenshot({path:image});input.push({name,...state,image});};
 await snapshot('baseline');await page.mouse.move(850,340);await page.mouse.down();await page.mouse.move(910,355,{steps:8});await page.mouse.up();await page.mouse.wheel(0,100);await page.waitForTimeout(150);await snapshot('pointer-wheel');
 assert.deepEqual(input[1].camera,input[0].camera,'Source does not attach camera controls');assert(input[1].steps>input[0].steps);
 await page.setViewportSize({width:1000,height:600});await page.evaluate(()=>{document.documentElement.style.width=document.body.style.width='1000px';document.documentElement.style.height=document.body.style.height='600px';const canvas=document.querySelector('canvas');canvas.style.width='1000px';canvas.style.height='600px';});
 await page.waitForFunction(()=>window.__observeConstraints().viewport.width===1000);await snapshot('resize');
 assert.deepEqual(input[2].viewport,{width:1000,height:600});assert(input[2].steps>input[1].steps);
});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
writeFileSync(resolve(output,'observations.json'),JSON.stringify({sourceSha256:sha(text),moduleSha256:sha(module),referenceSha256:sha(readFileSync('reference/scene46/babylon-lite-golden.png')),frames,input},null,2)+'\n');
console.log('Scene46 browser: observed golden exact; seven groups at frames10/60/240, live input and resize passed.');
