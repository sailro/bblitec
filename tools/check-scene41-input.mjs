#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {compareImages,compareRegion} from '../dist/src/parity.js';
import {fixedCaptureEnvironment} from '../dist/src/capture-timing.js';
import {spawnNativeMeasured,verifyBuildIdentity,verifyDeployedPayload} from '../dist/src/parity-scene.js';

// Process an exact copy of the corpus source at artifacts/scene41-live.ts, without a capture query.
const generated=resolve('generated/scene41-live');
const executable=resolve('native/build-scene41-live-release/bblite_native.exe');
const output=resolve(process.argv[2]??'artifacts/scene41-input');
mkdirSync(output,{recursive:true});
const digest=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const manifest=JSON.parse(readFileSync(resolve(generated,'manifest.json'),'utf8'));
assert.equal(digest(manifest.source),digest('corpus/babylon-lite/lab/lite/src/lite/scene41.ts'));
verifyDeployedPayload(executable,generated);
const idle=count=>Array(count).fill('-');
const phases=[
 {name:'early',frame:10},
 {name:'falling',frame:30},
 {name:'landing',frame:90},
 {name:'drag',frame:30,replay:[...idle(15),'+UiMouseLeft@850:400','UiMove@910:415','-UiMouseLeft@910:415']},
 {name:'resize',frame:30,replay:[...idle(15),'WindowResize@1000:600']},
];
const reports=[];
for(const backend of ['sdl_gpu','dawn']) {
 const captured=[];
 for(const phase of phases) {
  const stem=resolve(output,backend+'-'+phase.name);
  const log=spawnNativeMeasured(executable,{
   ...fixedCaptureEnvironment(),BBLITE_GPU_BACKEND:backend,BBLITE_TEST_PASS:'0',
   BBLITE_SCREENSHOT_FRAME:String(phase.frame),BBLITE_MAX_FRAMES:String(phase.frame+1),
   BBLITE_SCREENSHOT:stem+'.png',BBLITE_RENDER_CAPTURE:stem+'.json',BBLITE_BUILD_STAMP_OUT:stem+'.build-stamp',
   BBLITE_INPUT_REPLAY:(phase.replay??[]).join(','),BBLITE_GPU_DEBUG:'1',SDL_ASSERT:'always_ignore',
  },[],true,60000);
  writeFileSync(stem+'.log',log);
  assert(!/validation error|gpu error|exception/i.test(log),log);
  verifyBuildIdentity(executable,generated,stem+'.build-stamp');
  const state=JSON.parse(readFileSync(stem+'.json','utf8'));
  assert.equal(state.frame,phase.frame);
  assert.equal(state.meshes.length,16);
  const overlays=state.draws.filter(draw=>draw.pipeline==='shader');
  assert.equal(overlays.length,7);
  for(const draw of overlays) {
   assert.equal(draw.order,1000);
   const mesh=state.meshes[draw.mesh];
   const packet=draw.uniforms.find(uniform=>uniform.type.startsWith('physics-debug-lines'));
   assert(packet);
   for(let axis=0;axis<3;++axis) assert(Math.abs(packet.floats[28+axis]-mesh.position[axis])<1e-6);
   assert.deepEqual(mesh.scaling,[1,1,1]);
   assert(mesh.position.every(Number.isFinite));
  }
  for(const [body,overlay] of [[4,5],[6,7],[10,11],[12,13]]) {
   assert.deepEqual(state.meshes[body].position,state.meshes[overlay].position);
   assert.deepEqual(state.meshes[body].rotationQuaternion,state.meshes[overlay].rotationQuaternion);
  }
  assert.deepEqual([4,6,8].map(index=>state.meshes[index].geometry),[0,0,0]);
  assert.deepEqual([10,12,14].map(index=>state.meshes[index].geometry),[1,1,1]);
  if(phase.name==='early') {
   assert(compareImages(stem+'.png','reference/scene41/babylon-lite-golden.png').mad<0.3);
   assert(compareRegion(stem+'.png','reference/scene41/babylon-lite-golden.png',[51,51,76],30).mad<0.4);
  }
  captured.push({name:phase.name,camera:state.camera,viewport:state.viewport,positions:overlays.map(draw=>state.meshes[draw.mesh].position),
   image:stem+'.png',geometry:state.meshes.map(mesh=>mesh.geometry)});
 }
 const [early,falling,landing,dragged,resized]=captured;
 assert.notDeepEqual(early.positions,falling.positions);
 assert.notDeepEqual(falling.positions,landing.positions);
 // The authored scene does not attach camera controls.
 assert.deepEqual(dragged.camera,falling.camera);
 assert.deepEqual(resized.viewport,{width:1000,height:600});
 assert.deepEqual(dragged.positions,falling.positions);
 assert.deepEqual(resized.positions,falling.positions);
 for(const phase of captured) assert.deepEqual(phase.geometry,early.geometry);
 reports.push({backend,captured});
}
for(let phase=0;phase<phases.length;++phase) {
 assert.deepEqual(reports[0].captured[phase].positions,reports[1].captured[phase].positions);
 assert(compareImages(reports[0].captured[phase].image,reports[1].captured[phase].image).maxDiff<=1);
}
writeFileSync(resolve(output,'report.json'),JSON.stringify(reports,null,2)+'\n');
console.log('Scene41 SDL_GPU/Dawn: strict early parity, live falling/landing, seven retained overlays, shared clone geometry, fixed-camera input and resize passed.');
