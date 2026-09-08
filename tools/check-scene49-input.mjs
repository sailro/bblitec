#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import HavokPhysics from '@babylonjs/havok';
import {compareImages} from '../dist/src/parity.js';
import {adHocCaptureEnvironment} from '../dist/src/capture-timing.js';
import {resolveNativeExecutable,spawnNativeMeasured,verifyBuildIdentity,verifyDeployedPayload} from '../dist/src/parity-scene.js';

// Build the unchanged source copied to artifacts/scene49-live.ts with no capture query.
const generated=resolve('generated/scene49-live');
const executable=resolveNativeExecutable(resolve('native/build-scene49-live-release/bblite_native.exe'));
const output=resolve('artifacts/scene49-input/native');
mkdirSync(output,{recursive:true});
const manifest=JSON.parse(readFileSync(resolve(generated,'manifest.json'),'utf8'));
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const sourceSha256=sha256(readFileSync('corpus/babylon-lite/lab/lite/src/lite/scene49.ts'));
assert.equal(sha256(readFileSync(manifest.source)),sourceSha256,'Live probe must retain exact scene bytes');
verifyDeployedPayload(executable,generated);
const idle=n=>Array(n).fill('-');
const picked=[...idle(20),'+UiMouseLeft@491:210','-UiMouseLeft@491:210'];
const rotate=(x,y,dx,dy)=>[`UiMove@${x}:${y}`,...idle(12),`+UiMouseLeft@${x}:${y}`,...idle(12),
 ...Array.from({length:12},(_,index)=>`UiMove@${Math.round(x+dx*(index+1)/12)}:${Math.round(y+dy*(index+1)/12)}`),`-UiMouseLeft@${x+dx}:${y+dy}`];
const rotated=[...picked,...idle(12),...rotate(483,270,12,20)];
const castRotated=[...rotated,...idle(12),'+UiMouseLeft@512:476','-UiMouseLeft@512:476',...idle(12),...rotate(506,515,14,21)];
const phases=[{name:'baseline',frame:90},{name:'idle',frame:180},{name:'picked',frame:90,replay:picked},
 {name:'rotation',frame:120,replay:rotated},{name:'cast-rotation',frame:220,replay:castRotated},
 {name:'orbit',frame:90,replay:[...idle(20),'+UiMouseLeft@850:340','UiMove@910:355','-UiMouseLeft@910:355']},
 {name:'resize',frame:90,replay:[...idle(20),'WindowResize@1000:600']}];
const require=createRequire(import.meta.url);
const hp=await HavokPhysics({wasmBinary:new Uint8Array(readFileSync(require.resolve('@babylonjs/havok/lib/esm/HavokPhysics.wasm'))).buffer});
const world=hp.HP_World_Create()[1],collector=hp.HP_QueryCollector_Create(1)[1];
const cylinder=hp.HP_Shape_CreateCylinder([0,-1,0],[0,1,0],.5)[1];
const capsule=hp.HP_Shape_CreateCapsule([0,-.5,0],[0,.5,0],.5)[1];
const bodies=[2.5,-2.5].map(y=>{const b=hp.HP_Body_Create()[1];hp.HP_Body_SetShape(b,capsule);hp.HP_Body_SetMotionType(b,hp.MotionType.STATIC);hp.HP_Body_SetQTransform(b,[[1,y,0],[0,0,0,1]]);hp.HP_World_AddBody(world,b,false);return b;});
hp.HP_World_Step(world,1/60);
const results=[];
try {
 for(const backend of ['sdl_gpu','dawn']) {
  const captures=[];
  for(const phase of phases) {
   const stem=resolve(output,backend+'-'+phase.name);
   const log=spawnNativeMeasured(executable,{...adHocCaptureEnvironment(),BBLITE_GPU_BACKEND:backend,BBLITE_TEST_PASS:'0',
    BBLITE_MAX_FRAMES:String(phase.frame+1),BBLITE_SCREENSHOT_FRAME:String(phase.frame),
    BBLITE_SCREENSHOT:stem+'.png',BBLITE_RENDER_CAPTURE:stem+'.json',BBLITE_BUILD_STAMP_OUT:stem+'.build-stamp',
    BBLITE_INPUT_REPLAY:(phase.replay??[]).join(','),BBLITE_GPU_DEBUG:'1',SDL_ASSERT:'always_ignore'},[],true,60000);
   writeFileSync(stem+'.log',log);
   assert(!/validation error|gpu error|exception/i.test(log),log);
   verifyBuildIdentity(executable,generated,stem+'.build-stamp');
   const state=JSON.parse(readFileSync(stem+'.json','utf8'));
   assert.equal(state.frame,phase.frame);
   hp.HP_World_ShapeProximityWithCollector(world,collector,[cylinder,state.meshes[0].position,state.meshes[0].rotationQuaternion,10,false,[0n]]);
   assert.equal(hp.HP_QueryCollector_GetNumHits(collector)[1],1);
   const prox=hp.HP_QueryCollector_GetShapeProximityResult(collector,0)[1];
   hp.HP_World_ShapeCastWithCollector(world,collector,[cylinder,state.meshes[4].rotationQuaternion,[-1,-2.5,0],[4,-2.5,0],false,[0n]]);
   assert.equal(hp.HP_QueryCollector_GetNumHits(collector)[1],1);
   const cast=hp.HP_QueryCollector_GetShapeCastResult(collector,0)[1];
   const nudge=(p,n)=>[p[0],p[1]+n*.5,p[2]-n*.866];
   const expected=[nudge(prox[1][3],.08),nudge(prox[2][3],.08),nudge(cast[2][3],.2)];
   const markers=[2,3,7].map(i=>state.meshes[i].position);
   const markerErrors=markers.map((p,i)=>p.map((v,lane)=>Math.abs(v-expected[i][lane])));
   assert(Math.max(...markerErrors.flat())<.005,`${backend}/${phase.name}: marker error ${Math.max(...markerErrors.flat())}`);
   captures.push({name:phase.name,image:stem+'.png',camera:state.camera,viewport:state.viewport,meshCount:state.meshes.length,
    rotations:[state.meshes[0].rotationQuaternion,state.meshes[4].rotationQuaternion],markers,expected,markerErrors});
  }
  const [base,stationary,pickedState,rotation,castRotation,orbit,resized]=captures;
  assert.equal(compareImages(base.image,'reference/scene49/babylon-lite-golden.png').maxDiff,0);
  assert.equal(compareImages(base.image,stationary.image).maxDiff,0);
  assert.deepEqual(stationary.markers,base.markers);
  assert(pickedState.meshCount>base.meshCount,'Lazy gizmo was not created');
  assert.notDeepEqual(rotation.rotations[0],base.rotations[0],'Upper gizmo ignored drag');
  assert.notDeepEqual(rotation.markers[0],base.markers[0],'Live proximity ignored rotation');
  assert.notDeepEqual(castRotation.rotations[1],base.rotations[1],'Lower gizmo ignored drag');
  assert.notDeepEqual(castRotation.markers[2],base.markers[2],'Live cast ignored rotation');
  assert(Math.abs(orbit.camera.alpha-base.camera.alpha)>.05,'Camera ignored orbit');
  assert.deepEqual(resized.viewport,{width:1000,height:600});
  assert.notDeepEqual(resized.camera.viewProjection,base.camera.viewProjection);
  results.push({backend,captures});
 }
 for(let phase=0;phase<phases.length;phase++){
  assert.deepEqual(results[0].captures[phase].markers,results[1].captures[phase].markers);
  assert(compareImages(results[0].captures[phase].image,results[1].captures[phase].image).mad<.005);
 }
} finally {
 for(const body of bodies){hp.HP_World_RemoveBody(world,body);hp.HP_Body_Release(body);}
 hp.HP_Shape_Release(cylinder);hp.HP_Shape_Release(capsule);hp.HP_QueryCollector_Release(collector);hp.HP_World_Release(world);
}
writeFileSync(resolve(output,'verification.json'),JSON.stringify({sourceSha256,results},null,2)+'\n');
console.log('Scene49 SDL_GPU/Dawn: exact baseline, stable idle, two live gizmo/query updates, orbit, resize and Havok marker controls passed.');
