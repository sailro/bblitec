#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {suiteBrowserModule,createSuiteSceneServer} from '../dist/src/capture-suite-reference.js';
import {withBrowserPage,waitForSceneReady,screenshotCaptureBrowserArgs} from '../dist/src/browser-harness.js';
import {compareImages} from '../dist/src/parity.js';

const source='corpus/babylon-lite/lab/lite/src/lite/scene49.ts';
const output=resolve('artifacts/scene49-input/browser');
mkdirSync(output,{recursive:true});
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const sourceText=readFileSync(source,'utf8');
const observationHook=`window.__scene49Observe = () => {
 const vector = value => [value.x,value.y,value.z];
 const mesh = value => ({position:vector(value.position),rotation:[value.rotationQuaternion.x,value.rotationQuaternion.y,value.rotationQuaternion.z,value.rotationQuaternion.w]});
 return {queries:window.__queries,camera:{alpha:camera.alpha,beta:camera.beta,radius:camera.radius},
 cylinders:[mesh(groupA.cylinder),mesh(groupB.cylinder)],markers:[mesh(proxOnCylinder),mesh(proxOnCapsule),mesh(castHit)],
 gizmoCreated:!!rotationGizmo,interacting:isGizmoInteracting(canvas),dragging:isGizmoDragging(canvas)};
};`;
assert.equal(sourceText.split('if (!captureQueued && steps >= CAPTURE_STEPS').length,2);
assert.equal(sourceText.split('canvas.addEventListener("pointerdown", async (e) => {').length,2);
const module=suiteBrowserModule(source,text=>text
 .replace('if (!captureQueued && steps >= CAPTURE_STEPS','window.__queries = {prox,cast}; if (!captureQueued && steps >= CAPTURE_STEPS')
 .replace('canvas.addEventListener("pointerdown", async (e) => {',observationHook+'\ncanvas.addEventListener("pointerdown", async (e) => {'));
const server=createSuiteSceneServer(module,{sourcePath:source});
const phases=[];
await withBrowserPage(server,{serverName:'scene49 controls',browserArgs:screenshotCaptureBrowserArgs,viewport:{width:1280,height:720},pageErrorPrefix:'browser'},async(page,origin)=>{
 await waitForSceneReady(page,origin,false);
 const snapshot=async name=>{
   await page.waitForTimeout(150);
   const state=await page.evaluate(()=>window.__scene49Observe());
   const image=resolve(output,name+'.png');
   await page.screenshot({path:image});
   phases.push({name,...state,image});
 };
 await snapshot('baseline');
 await snapshot('idle');
 assert.equal(compareImages(phases[0].image,'reference/scene49/babylon-lite-golden.png').maxDiff,0,'Observation hook changed the golden');
 assert.deepEqual(phases[1].markers,phases[0].markers,'Idle queries changed markers');
 await page.mouse.click(491,210);
 await snapshot('picked');
 assert(phases.at(-1).gizmoCreated,'Cylinder picking did not create rotation gizmo');
 await page.mouse.move(483,270);
 await page.waitForTimeout(500);
 await page.mouse.down();
 await page.waitForTimeout(500);
 assert((await page.evaluate(()=>window.__scene49Observe())).dragging,'Ring did not start a drag');
 await page.mouse.move(495,290,{steps:12});
 await page.mouse.up();
 await snapshot('rotation');
 assert.notDeepEqual(phases.at(-1).cylinders[0].rotation,phases[0].cylinders[0].rotation,'Rotation gizmo did not rotate its cylinder');
 assert.notDeepEqual(phases.at(-1).markers[0].position,phases[0].markers[0].position,'Rotation did not update proximity');
 await page.mouse.click(512,476);
 await snapshot('picked-cast');
 await page.mouse.move(506,515);
 await page.waitForTimeout(500);
 await page.mouse.down();
 await page.waitForTimeout(500);
 assert((await page.evaluate(()=>window.__scene49Observe())).dragging,'Lower ring did not start a drag');
 await page.mouse.move(520,536,{steps:12});
 await page.mouse.up();
 await snapshot('cast-rotation');
 assert.notDeepEqual(phases.at(-1).cylinders[1].rotation,phases[0].cylinders[1].rotation,'Rotation gizmo did not rotate the cast cylinder');
 assert.notDeepEqual(phases.at(-1).markers[2].position,phases[0].markers[2].position,'Rotation did not update shape cast');
 await page.mouse.click(850,340);
 await page.mouse.move(850,340);
 await page.mouse.down();
 await page.mouse.move(910,355,{steps:8});
 await page.mouse.up();
 await snapshot('orbit');
 await page.setViewportSize({width:1000,height:600});
 await page.evaluate(()=>{document.documentElement.style.width='1000px';document.body.style.width='1000px';document.documentElement.style.height='600px';document.body.style.height='600px';const canvas=document.querySelector('canvas');canvas.style.width='1000px';canvas.style.height='600px';canvas.width=1000;canvas.height=600;});
 await snapshot('resize');
});
const document={sourceSha256:sha256(sourceText),moduleSha256:sha256(module),referencePngSha256:sha256(readFileSync('reference/scene49/babylon-lite-golden.png')),phases};
writeFileSync(resolve(output,'observations.json'),JSON.stringify(document,null,2)+'\n');
console.log('Scene49 browser: stable markers, two cylinder picks/rotations, orbit and resize observed.');
