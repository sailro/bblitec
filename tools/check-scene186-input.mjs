#!/usr/bin/env node
// Observe actual camera state, material inputs and rendered pixels on both backends.
import assert from 'node:assert/strict';
import {mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {adHocCaptureEnvironment} from '../dist/src/capture-timing.js';
import {compareImages} from '../dist/src/parity.js';
import {resolveNativeExecutable, spawnNativeMeasured, verifyBuildIdentity, verifyDeployedPayload} from '../dist/src/parity-scene.js';

const generated=resolve('generated/scene186');
const executable=resolveNativeExecutable(resolve('native/build-scene186-release/bblite_native.exe'));
const output=resolve('artifacts/scene186-input');
mkdirSync(output,{recursive:true});
rmSync(resolve(output,'verification.json'),{force:true});
verifyDeployedPayload(executable,generated);
const idle=count=>Array(count).fill('-');
const phases=[{name:'baseline',frame:90},{name:'idle',frame:180},
    {name:'look',frame:90,replay:[...idle(20),'+UiMouseLeft@640:360','UiMove@760:390','-UiMouseLeft@760:390']},
    {name:'resize',frame:90,replay:[...idle(20),'WindowResize@1000:600']}];
const results=[];
for(const backend of ['sdl_gpu','dawn']) {
    const captures=[];
    for(const phase of phases) {
        const stem=resolve(output,`${backend}-${phase.name}`);
        const log=spawnNativeMeasured(executable,{
            ...adHocCaptureEnvironment(),BBLITE_GPU_BACKEND:backend,BBLITE_TEST_PASS:'0',
            BBLITE_MAX_FRAMES:String(phase.frame+1),BBLITE_SCREENSHOT_FRAME:String(phase.frame),
            BBLITE_SCREENSHOT:stem+'.png',BBLITE_RENDER_CAPTURE:stem+'.json',BBLITE_BUILD_STAMP_OUT:stem+'.build-stamp',
            BBLITE_INPUT_REPLAY:(phase.replay??[]).join(','),BBLITE_GPU_DEBUG:'1',SDL_ASSERT:'always_ignore',
        },[],true,60000);
        writeFileSync(stem+'.log',log);
        assert(!/validation error|gpu error|exception/i.test(log),log);
        verifyBuildIdentity(executable,generated,stem+'.build-stamp');
        const capture=JSON.parse(readFileSync(stem+'.json','utf8'));
        assert.equal(capture.frame,phase.frame);
        assert.equal(capture.meshes.length,8,'Room resource factories did not retain eight faces');
        const floors=capture.materials.filter(material=>material.directIntensity===0);
        assert.equal(floors.length,4,'Reflective floors lost their direct-intensity writes');
        assert.equal(capture.materials.filter(material=>material.environmentIntensity===0).length,4);
        const orm=floors.map(material=>material.textures.find(texture=>texture.slot==='metallicRoughness'));
        assert(orm.every(texture=>texture?.byteLength===4),'Reflective floor ORM is not the solid replacement');
        assert.equal(new Set(orm.map(texture=>texture.digest)).size,1);
        // FNV-1a receipt for the pin's rgba8unorm store of (1, .01, 1, 1): [255, 3, 255, 255].
        assert.equal(orm[0].digest,'62a3b2648e85e545','ORM bytes differ from the authored replacement');
        captures.push({phase:phase.name,image:stem+'.png',camera:capture.camera,viewport:capture.viewport,
            materialCount:capture.materials.length,meshCount:capture.meshes.length,ormDigest:orm[0].digest});
    }
    const [baseline,stationary,look,resized]=captures;
    assert.deepEqual(stationary.camera,baseline.camera,'Idle camera drift');
    assert.equal(compareImages(stationary.image,baseline.image).mad,0,'Idle image drift');
    assert(Math.abs(look.camera.freeYaw-baseline.camera.freeYaw)>.05,'Free camera ignored horizontal input');
    assert(Math.abs(look.camera.freePitch-baseline.camera.freePitch)>.01,'Free camera ignored vertical input');
    assert.deepEqual(look.camera.position,baseline.camera.position,'Looking translated the camera');
    assert(compareImages(look.image,baseline.image).mad>1,'Camera input did not change reflections');
    assert.deepEqual(resized.viewport,{width:1000,height:600});
    for(const key of ['position','freeYaw','freePitch']) assert.deepEqual(resized.camera[key],baseline.camera[key]);
    assert.notDeepEqual(resized.camera.viewProjection,baseline.camera.viewProjection,'Resize did not change projection');
    results.push({backend,captures});
}
for(let index=0;index<phases.length;index++) {
    const left=results[0].captures[index],right=results[1].captures[index];
    assert.deepEqual(left.camera,right.camera,'Backend camera states differ');
    assert(compareImages(left.image,right.image).mad<.005,'Backend reflections differ after interaction');
}
writeFileSync(resolve(output,'verification.json'),JSON.stringify(results,null,2)+'\n');
console.log('Scene 186: camera, idle, resize and eight-face/four-ORM observations passed on SDL_GPU and Dawn.');
