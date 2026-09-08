#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {compareImages} from '../dist/src/parity.js';
import {fixedCaptureEnvironment} from '../dist/src/capture-timing.js';
import {spawnNativeMeasured,verifyBuildIdentity,verifyDeployedPayload} from '../dist/src/parity-scene.js';
const source='corpus/babylon-lite/lab/lite/src/lite/scene46.ts';
const generated=resolve('generated/scene46-live'),executable=resolve('native/build-scene46-live-release/bblite_native.exe');
const output=resolve('artifacts/scene46-controls/native');mkdirSync(output,{recursive:true});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const sourceSha256=sha(readFileSync(source));
const manifest=JSON.parse(readFileSync(resolve(generated,'manifest.json'),'utf8'));
assert.equal(sha(readFileSync(manifest.source)),sourceSha256);
const browser=JSON.parse(readFileSync('artifacts/scene46-controls/browser/observations.json','utf8'));
assert.equal(browser.sourceSha256,sourceSha256);assert.equal(browser.referenceSha256,sha(readFileSync('reference/scene46/babylon-lite-golden.png')));
verifyDeployedPayload(executable,generated);
const idle=n=>Array(n).fill('-');
const phases=[10,60,240].map(frame=>({name:`frame-${frame}`,frame}));
phases.push({name:'pointer-wheel',frame:60,replay:[...idle(20),'+UiMouseLeft@850:340','UiMove@910:355','-UiMouseLeft@910:355','WheelDown']});
phases.push({name:'resize',frame:60,replay:[...idle(20),'WindowResize@1000:600']});
const maxError=(a,b)=>Math.max(...a.map((value,index)=>Math.abs(value-b[index])));
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const pivot=(mesh,point)=>{const q=mesh.rotationQuaternion;const t=cross(q,point).map(v=>2*v),v=cross(q,t);return point.map((p,i)=>mesh.position[i]+p+q[3]*t[i]+v[i]);};
const distance=(a,b)=>Math.hypot(...a.map((v,i)=>v-b[i]));
const results=[];
for(const backend of ['sdl_gpu','dawn']){
 const captures=[];
 for(const phase of phases){
  const stem=resolve(output,backend+'-'+phase.name);
  const log=spawnNativeMeasured(executable,{...fixedCaptureEnvironment(),BBLITE_GPU_BACKEND:backend,BBLITE_TEST_PASS:'0',BBLITE_MAX_FRAMES:String(phase.frame+1),BBLITE_SCREENSHOT_FRAME:String(phase.frame),BBLITE_SCREENSHOT:stem+'.png',BBLITE_RENDER_CAPTURE:stem+'.json',BBLITE_BUILD_STAMP_OUT:stem+'.build-stamp',BBLITE_INPUT_REPLAY:(phase.replay??[]).join(','),BBLITE_GPU_DEBUG:'1',SDL_ASSERT:'always_ignore'},[],true,60000);
  writeFileSync(stem+'.log',log);assert(!/validation error|gpu error|exception/i.test(log),log);verifyBuildIdentity(executable,generated,stem+'.build-stamp');
  const state=JSON.parse(readFileSync(stem+'.json','utf8')),bodies=state.meshes;
  assert.equal(state.frame,phase.frame);assert.equal(bodies.length,16);
  const expected=browser.frames.find(row=>row.frame===phase.frame).bodies;
  const positionErrors=bodies.map((body,index)=>maxError(body.position,expected[index].transform[0]));
  const rotationErrors=bodies.map((body,index)=>Math.min(...[1,-1].map(sign=>maxError(body.rotationQuaternion,expected[index].transform[1].map(v=>v*sign)))));
  if(phase.frame===10){assert(Math.max(...positionErrors)<.01);assert(Math.max(...rotationErrors)<.01);}
  for(const body of bodies)assert(body.position.every(Number.isFinite)&&body.rotationQuaternion.every(Number.isFinite));
  const pivotErrors=[distance(pivot(bodies[0],[-.5,0,-.5]),pivot(bodies[1],[-.5,0,.5])),distance(pivot(bodies[4],[0,0,-.5]),pivot(bodies[5],[0,0,.5])),distance(pivot(bodies[9],[.5,.5,-.5]),pivot(bodies[10],[-.5,-.5,.5]))];
  assert(Math.max(...pivotErrors)<.03,'A ball, hinge or fixed pivot detached');
  const fixedDistance=distance(bodies[2].position,bodies[3].position);assert(Math.abs(fixedDistance-2)<.03);
  const radialDistance=distance(pivot(bodies[14],[0,-.5,0]),pivot(bodies[15],[0,.5,0]));assert(radialDistance>.97&&radialDistance<2.03);
  for(const [a,b] of [[6,7],[11,12]]){const anchor=pivot(bodies[a],[0,0,-.2]),follower=pivot(bodies[b],[0,0,.25]);assert(Math.abs(anchor[0]-follower[0])<.03&&Math.abs(anchor[2]-follower[2])<.03);}
  captures.push({name:phase.name,frame:phase.frame,image:stem+'.png',camera:state.camera,viewport:state.viewport,positions:bodies.map(body=>body.position),rotations:bodies.map(body=>body.rotationQuaternion),positionErrors,rotationErrors,pivotErrors,fixedDistance,radialDistance});
  console.log(`${backend}/${phase.name}: positionError=${Math.max(...positionErrors)}, rotationError=${Math.max(...rotationErrors)}, radialDistance=${radialDistance}`);
 }
 const baseline=captures[1],input=captures[3],resized=captures[4];
 assert.deepEqual(input.camera,baseline.camera);assert.deepEqual(input.positions,baseline.positions);assert.deepEqual(resized.positions,baseline.positions);
 assert.deepEqual(resized.viewport,{width:1000,height:600});assert.notDeepEqual(resized.camera.viewProjection,baseline.camera.viewProjection);
 results.push({backend,captures});
}
for(let index=0;index<phases.length;index++){
 assert.deepEqual(results[0].captures[index].positions,results[1].captures[index].positions);
 assert.equal(compareImages(results[0].captures[index].image,results[1].captures[index].image).maxDiff,0);
}
writeFileSync(resolve(output,'verification.json'),JSON.stringify({sourceSha256,results},null,2)+'\n');
console.log('Scene46 SDL_GPU/Dawn: all seven constraint groups, live input and resize passed.');
