#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {compareImages} from '../dist/src/parity.js';
import {fixedCaptureEnvironment} from '../dist/src/capture-timing.js';
import {resolveNativeExecutable,spawnNativeMeasured,verifyBuildIdentity,verifyDeployedPayload} from '../dist/src/parity-scene.js';

// Build the byte-identical source copy with no capture query for sustained runs.
const generated = resolve('generated/scene47-live');
const executable = resolveNativeExecutable(resolve('native/build-scene47-live-release/bblite_native.exe'));
const output = resolve('artifacts/scene47-controls/native');
mkdirSync(output,{recursive:true});
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(readFileSync(resolve(generated,'manifest.json'),'utf8'));
const sourceSha256 = sha256(readFileSync('corpus/babylon-lite/lab/lite/src/lite/scene47.ts'));
assert.equal(sha256(readFileSync(manifest.source)),sourceSha256);
const browser = JSON.parse(readFileSync('artifacts/scene47-controls/browser/observations.json','utf8'));
assert.equal(browser.sourceSha256,sourceSha256);
assert.equal(browser.referenceSha256,sha256(readFileSync('reference/scene47/babylon-lite-golden.png')));
verifyDeployedPayload(executable,generated);
const idle = n => Array(n).fill('-');
const phases = [1,60,120,240].map(frame => ({name:`frame-${frame}`,frame}));
phases.push({name:'pointer-wheel',frame:120,replay:[...idle(20),'+UiMouseLeft@850:340','UiMove@910:355','-UiMouseLeft@910:355','WheelDown']});
phases.push({name:'resize',frame:120,replay:[...idle(20),'WindowResize@1000:600']});
const maxError = (a,b) => Math.max(...a.map((value,index)=>Math.abs(value-b[index])));
const results = [];
for (const backend of ['sdl_gpu','dawn']) {
    const captures = [];
    let bodyMeshes,debugMeshes;
    for (const phase of phases) {
        const stem=resolve(output,backend+'-'+phase.name);
        const log=spawnNativeMeasured(executable,{...fixedCaptureEnvironment(),BBLITE_GPU_BACKEND:backend,BBLITE_TEST_PASS:'0',
            BBLITE_MAX_FRAMES:String(phase.frame+1),BBLITE_SCREENSHOT_FRAME:String(phase.frame),BBLITE_SCREENSHOT:stem+'.png',
            BBLITE_RENDER_CAPTURE:stem+'.json',BBLITE_BUILD_STAMP_OUT:stem+'.build-stamp',BBLITE_INPUT_REPLAY:(phase.replay??[]).join(','),
            BBLITE_GPU_DEBUG:'1',SDL_ASSERT:'always_ignore'},[],true,60000);
        writeFileSync(stem+'.log',log);
        assert(!/validation error|gpu error|exception/i.test(log),log);
        verifyBuildIdentity(executable,generated,stem+'.build-stamp');
        const state=JSON.parse(readFileSync(stem+'.json','utf8'));
        assert.equal(state.frame,phase.frame);
        if (!bodyMeshes) {
            const expected=browser.frames[0].bodies;
            bodyMeshes=expected.map((body,index)=>{
                const matches=state.meshes.filter(mesh=>state.draws.some(draw=>draw.mesh===mesh.index && draw.materialKind==='standard') &&
                    maxError(mesh.position,body.position)<.001 && (index!==0 || mesh.geometryInfo.vertexCount===10201));
                assert.equal(matches.length,1,`body${index}: expected one native solid mesh`);
                return matches[0].index;
            });
            debugMeshes=expected.map(body=>{
                const matches=state.meshes.filter(mesh=>state.draws.some(draw=>draw.mesh===mesh.index && draw.materialKind==='shader') && maxError(mesh.position,body.position)<.001);
                assert.equal(matches.length,1,'expected one debug mesh per body');
                return matches[0].index;
            });
        }
        const bodies=bodyMeshes.map(index=>state.meshes[index]);
        const expected=browser.frames.find(row=>row.frame===phase.frame).bodies;
        const positionErrors=bodies.map((body,index)=>maxError(body.position,expected[index].position));
        const rotationErrors=bodies.map((body,index)=>Math.min(maxError(body.rotationQuaternion,expected[index].rotation),
            maxError(body.rotationQuaternion,expected[index].rotation.map(value=>-value))));
        if (phase.frame<=60) {
            assert(Math.max(...positionErrors)<.005,`${backend}/${phase.name}: free-fall positions diverged`);
            assert(Math.max(...rotationErrors)<.001,`${backend}/${phase.name}: free-fall rotations diverged`);
        }
        bodies.forEach((body,index)=>{
            assert(body.position.every(Number.isFinite) && body.rotationQuaternion.every(Number.isFinite));
            const debug=state.meshes[debugMeshes[index]];
            assert.deepEqual(debug.position,body.position,'Viewer detached from its live body');
            assert.deepEqual(debug.rotationQuaternion,body.rotationQuaternion,'Viewer rotation detached from its live body');
        });
        if (phase.frame===240) {
            assert(bodies.slice(1).every(body=>body.position[1]>-3 && body.position[1]<13), 'A falling shape missed the terrain');
        }
        captures.push({name:phase.name,frame:phase.frame,image:stem+'.png',camera:state.camera,viewport:state.viewport,
            positions:bodies.map(body=>body.position),rotations:bodies.map(body=>body.rotationQuaternion),positionErrors,rotationErrors});
        console.log(`${backend}/${phase.name}: max position error ${Math.max(...positionErrors)}`);
    }
    const baseline=captures[2],input=captures[4],resized=captures[5];
    assert.deepEqual(input.camera,baseline.camera,'Source does not attach camera controls');
    assert.deepEqual(input.positions,baseline.positions,'Unhandled input changed the simulation');
    assert.deepEqual(resized.positions,baseline.positions,'Resize changed the simulation');
    assert.deepEqual(resized.viewport,{width:1000,height:600});
    assert.notDeepEqual(resized.camera.viewProjection,baseline.camera.viewProjection);
    results.push({backend,captures});
}
for(let index=0;index<phases.length;index++){
    assert.deepEqual(results[0].captures[index].positions,results[1].captures[index].positions);
    assert.equal(compareImages(results[0].captures[index].image,results[1].captures[index].image).maxDiff,0);
}
writeFileSync(resolve(output,'verification.json'),JSON.stringify({sourceSha256,results},null,2)+'\n');
console.log('Scene47 SDL_GPU/Dawn: free-fall, later contacts, live viewer poses, unhandled input and resize passed.');
