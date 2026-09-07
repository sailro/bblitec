#!/usr/bin/env node
// Observe original scene114 picking through the markers its own source places.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {PNG} from 'pngjs';
import {compareImages,compareRegion} from '../dist/src/parity.js';
import {adHocCaptureEnvironment} from '../dist/src/capture-timing.js';
import {resolveNativeExecutable,spawnNativeMeasured,verifyBuildIdentity,verifyDeployedPayload} from '../dist/src/parity-scene.js';

const [executableArgument,generatedArgument,observationsArgument,referenceArgument]=process.argv.slice(2);
assert(executableArgument&&generatedArgument&&observationsArgument,
    'Usage: node tools/check-scene114-input.mjs <executable> <generated-directory> <reference-observations.json> [canonical-reference.png]');
const executable=resolveNativeExecutable(executableArgument);
const generated=resolve(generatedArgument);
const observations=JSON.parse(readFileSync(resolve(observationsArgument),'utf8'));
const reference=resolve(referenceArgument??join(dirname(observationsArgument),'reference.png'));
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const manifest=JSON.parse(readFileSync(join(generated,'manifest.json'),'utf8'));
assert.equal(sha256(readFileSync(manifest.source)),observations.sourceSha256,'Scene source identity changed');
assert.equal(sha256(readFileSync(reference)),observations.referencePngSha256,'Canonical reference identity changed');
assert.equal(observations.diagnosticToCanonical.maxDiff,0,'Reference observation changed the image');
assert.equal(observations.idleImageDifference.maxDiff,0,'Reference scene moved while idle');
const referenceState=observations.first;
assert.deepEqual(referenceState.hits,{
    morphGpuHit:'scene114-morph-target',morphDetailedHit:'scene114-morph-target',
    skeletonGpuHit:'scene114-skeleton-target',skeletonDetailedHit:'scene114-skeleton-target',
});
const markerNames=['morph-gpu-marker','morph-detailed-marker','skeleton-gpu-marker','skeleton-detailed-marker'];
const referenceMarkers=markerNames.map(suffix=>{
    const marker=referenceState.meshes.find(mesh=>mesh.name===`scene114-${suffix}`);
    assert(marker&&marker.position[1]!==-100,`Missing reference marker ${suffix}`);
    return marker;
});
const referencePng=PNG.sync.read(readFileSync(reference));
const background=Array.from(referencePng.data.subarray(0,3));
const settings=adHocCaptureEnvironment();
const canonicalFrame=Number(settings.BBLITE_SCREENSHOT_FRAME);
const phases=[{name:'first-ready',frame:0},{name:'canonical',frame:canonicalFrame},{name:'idle',frame:canonicalFrame*2}];
const output=resolve('artifacts/scene114-input');
mkdirSync(output,{recursive:true});
verifyDeployedPayload(executable,generated);
const results=[];
const errors=(actual,expected)=>actual.map((value,lane)=>Math.abs(value-expected[lane]));
for(const backend of ['sdl_gpu','dawn']){
    const captures=[];
    for(const phase of phases){
        const stem=resolve(output,`${backend}-${phase.name}`);
        for(const suffix of ['.png','.json','.build-stamp'])rmSync(stem+suffix,{force:true});
        const log=spawnNativeMeasured(executable,{
            ...settings,BBLITE_GPU_BACKEND:backend,BBLITE_TEST_PASS:'1',
            BBLITE_MAX_FRAMES:String(Math.max(phase.frame+1,30)),BBLITE_SCREENSHOT_FRAME:String(phase.frame),
            BBLITE_SCREENSHOT:stem+'.png',BBLITE_RENDER_CAPTURE:stem+'.json',BBLITE_BUILD_STAMP_OUT:stem+'.build-stamp',
            BBLITE_ANIMATION_SEEK_SECONDS:'',BBLITE_INPUT_REPLAY:'',BBLITE_RUNTIME_TRACE:'1',
            BBLITE_GPU_DEBUG:'1',SDL_ASSERT:'always_ignore',
        },[],true,60000);
        writeFileSync(stem+'.log',log);
        assert(!/validation error|gpu error|exception/i.test(log),log);
        verifyBuildIdentity(executable,generated,stem+'.build-stamp');
        const capture=JSON.parse(readFileSync(stem+'.json','utf8'));
        assert.equal(capture.meshes.length,referenceState.meshes.length);
        assert.equal(capture.meshes.length,19);
        assert.equal(capture.meshes[0].geometryInfo.vertexCount,4);
        assert.equal(capture.meshes[0].morphStorageWeights[0],1);
        assert.equal(capture.meshes[1].boneMatrixCount,2);
        const markers=referenceMarkers.map(expected=>{
            const actual=capture.meshes[expected.index];
            const positionErrors=errors(actual.position,expected.position);
            const scalingErrors=errors(actual.scaling,expected.scaling);
            // Measured positions agree exactly; the source's scaling fields
            // enter float record lanes (observed maximum error 3.24e-9).
            assert(Math.max(...positionErrors)<1e-7,`${expected.name} point changed`);
            assert(Math.max(...scalingErrors)<1e-7,`${expected.name} barycentric scale changed`);
            return {index:expected.index,name:expected.name,position:actual.position,scaling:actual.scaling,
                referencePosition:expected.position,referenceScaling:expected.scaling,positionErrors,scalingErrors};
        });
        const full=compareImages(stem+'.png',reference);
        const foreground=compareRegion(stem+'.png',reference,background,30);
        assert(full.mad<0.5&&foreground.mad<0.5,`${backend}/${phase.name} exceeded strict image MAD`);
        captures.push({phase:phase.name,frame:capture.frame,buildStamp:capture.buildStamp,full,foreground,markers,
            image:stem+'.png',camera:capture.camera,meshes:capture.meshes});
    }
    for(const capture of captures.slice(1)){
        assert.deepEqual(capture.camera,captures[0].camera,'Idle changed the authored camera');
        assert.deepEqual(capture.meshes,captures[0].meshes,'Idle changed the authored mesh state');
        assert.equal(compareImages(capture.image,captures[0].image).maxDiff,0,'Idle image changed');
    }
    results.push({backend,firstReadyFrame:captures[0].frame,captures});
}
const report={reference,referencePngSha256:observations.referencePngSha256,sourceSha256:observations.sourceSha256,
    background,referenceHits:referenceState.hits,sensitivity:observations.sensitivity,results};
writeFileSync(resolve(output,'verification.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(results.map(({backend,firstReadyFrame,captures})=>({backend,firstReadyFrame,
    phases:captures.map(({phase,full,foreground,markers})=>({phase,fullMad:full.mad,foregroundMad:foreground.mad,markers}))})),null,2));
