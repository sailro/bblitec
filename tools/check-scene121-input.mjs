#!/usr/bin/env node
// Verify the unchanged scene's retained byte mutation, idle state and camera input.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {basename,dirname,join,resolve} from 'node:path';
import {downloadCached} from '../dist/src/asset-download-cache.js';
import {adHocCaptureEnvironment} from '../dist/src/capture-timing.js';
import {compareImages,compareRegion} from '../dist/src/parity.js';
import {resolveNativeExecutable,spawnNativeMeasured,verifyBuildIdentity,verifyDeployedPayload} from '../dist/src/parity-scene.js';

const [executableArgument,generatedArgument,observationsArgument,referenceArgument]=process.argv.slice(2);
assert(executableArgument&&generatedArgument&&observationsArgument,
    'Usage: node tools/check-scene121-input.mjs <executable> <generated-directory> <reference-observations.json> [canonical-reference.png]');
const executable=resolveNativeExecutable(executableArgument);
const generated=resolve(generatedArgument);
const observations=JSON.parse(readFileSync(resolve(observationsArgument),'utf8'));
const reference=resolve(referenceArgument??join(dirname(observationsArgument),'reference.png'));
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const manifest=JSON.parse(readFileSync(join(generated,'manifest.json'),'utf8'));
const source=readFileSync(manifest.source);
assert.equal(sha256(source),observations.sourceSha256,'Scene source identity changed');
assert.equal(sha256(readFileSync(reference)),observations.referencePngSha256,'Canonical reference identity changed');
assert.equal(observations.search,'');
assert.equal(observations.referenceFrame,null);
assert.equal(observations.captureTimeSeconds,null);
assert.deepEqual(observations.first,observations.idle,'Reference retained data changed while idle');
const assetUrl='https://cdn.jsdelivr.net/gh/CedricGuillemet/dump@master/Halo_Believe.splat';
assert(source.toString().includes(assetUrl),'The source asset URL changed');
const original=Buffer.from(await downloadCached(assetUrl));
assert.equal(sha256(original),observations.assetSha256,'Raw source asset identity changed');
const expected=Buffer.from(original);
for(let row=0;row<30000;row++)expected.writeFloatLE(expected.readFloatLE(row*32+4)-2,row*32+4);
assert.equal(sha256(expected),observations.expectedDataSha256,'Authored F32 writes differ from the browser');
assert.equal(expected.length,observations.byteLength);

const settings=adHocCaptureEnvironment();
const canonicalFrame=Number(settings.BBLITE_SCREENSHOT_FRAME);
const orbitReplay=[...Array(20).fill('-'),'+UiMouseLeft@640:360',
    ...Array.from({length:12},(_,i)=>`UiMove@${650+i*10}:360`),'-UiMouseLeft@760:360'];
const phases=[{name:'first-ready',frame:0},{name:'canonical',frame:canonicalFrame},
    {name:'idle',frame:canonicalFrame*2},{name:'orbit',frame:canonicalFrame,replay:orbitReplay}];
const output=resolve('artifacts/scene121-input');
mkdirSync(output,{recursive:true});
verifyDeployedPayload(executable,generated);
const results=[];
for(const backend of ['sdl_gpu','dawn']){
    const captures=[];
    for(const phase of phases){
        const stem=resolve(output,`${backend}-${phase.name}`);
        for(const suffix of ['.png','.json','.build-stamp'])rmSync(stem+suffix,{force:true});
        for(const file of readdirSync(output)){
            if(file.startsWith(basename(stem)+'.json.splat-')&&file.endsWith('.bin'))rmSync(join(output,file));
        }
        const log=spawnNativeMeasured(executable,{
            ...settings,BBLITE_GPU_BACKEND:backend,BBLITE_TEST_PASS:'0',
            BBLITE_MAX_FRAMES:String(Math.max(phase.frame+1,30)),BBLITE_SCREENSHOT_FRAME:String(phase.frame),
            BBLITE_SCREENSHOT:stem+'.png',BBLITE_RENDER_CAPTURE:stem+'.json',BBLITE_BUILD_STAMP_OUT:stem+'.build-stamp',
            BBLITE_ANIMATION_SEEK_SECONDS:'',BBLITE_INPUT_REPLAY:(phase.replay??[]).join(','),BBLITE_RUNTIME_TRACE:'1',
            BBLITE_GPU_DEBUG:'1',SDL_ASSERT:'always_ignore',
        },[],true,60000);
        writeFileSync(stem+'.log',log);
        assert(!/validation error|gpu error|exception/i.test(log),log);
        verifyBuildIdentity(executable,generated,stem+'.build-stamp');
        const capture=JSON.parse(readFileSync(stem+'.json','utf8'));
        assert.equal(capture.splats.length,1);
        const splat=capture.splats[0];
        assert.equal(splat.vertexCount,observations.rowCount);
        assert.equal(splat.dataVersion,1,'The authored update did not commit exactly once');
        assert.equal(splat.byteLength,expected.length);
        const data=readFileSync(resolve(dirname(stem),splat.retainedDataFile));
        assert.deepEqual(data,expected,'The complete retained source bytes differ');
        const dataSha256=sha256(data);
        assert.equal(dataSha256,observations.first.dataSha256);
        for(const field of ['boundMin','boundMax'])
            assert.deepEqual(splat[field].map(Math.fround),observations.first[field],`${field} differs from the pin`);
        for(const sample of observations.first.sampleRows)
            for(let lane=0;lane<3;lane++)assert.equal(data.readFloatLE(sample.row*32+lane*4),sample.position[lane]);
        const full=compareImages(stem+'.png',reference);
        const foreground=compareRegion(stem+'.png',reference,[0,0,0],30);
        if(!phase.replay)assert(full.mad<0.5&&foreground.mad<0.5,`${backend}/${phase.name} exceeded strict image MAD`);
        const {retainedDataFile,...state}=splat;
        captures.push({phase:phase.name,frame:capture.frame,buildStamp:capture.buildStamp,full,foreground,
            image:stem+'.png',camera:capture.camera,state,dataSha256,retainedDataFile});
    }
    const [first,canonical,idle,orbit]=captures;
    for(const capture of captures){
        assert.deepEqual(capture.state,first.state,'Scene work or camera input changed retained splat state');
        assert.equal(capture.dataSha256,first.dataSha256);
    }
    assert.deepEqual(first.camera,canonical.camera);
    assert.deepEqual(canonical.camera,idle.camera);
    const idleDifference=compareImages(idle.image,canonical.image);
    // The browser's own idle captures vary slightly. Measure image stability;
    // byte and scene state stability above remain exact checks.
    assert(idleDifference.mad<0.5,'Idle image changed beyond the strict image gate');
    const orbitDifference=compareImages(orbit.image,canonical.image);
    assert(Math.abs(orbit.camera.alpha-canonical.camera.alpha)>0.1,'Authored camera input did not turn the camera');
    assert(orbitDifference.mad>0.05,'Orbit did not change the rendered splats');
    results.push({backend,firstReadyFrame:first.frame,idleDifference,orbitDifference,captures});
}
const report={reference,sourceSha256:observations.sourceSha256,referencePngSha256:observations.referencePngSha256,
    assetSha256:observations.assetSha256,expectedDataSha256:observations.expectedDataSha256,
    browserIdleDifference:observations.idleDifference,results};
writeFileSync(join(output,'verification.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(results.map(({backend,firstReadyFrame,idleDifference,orbitDifference,captures})=>({
    backend,firstReadyFrame,idleDifference,orbitDifference,
    captures:captures.map(({phase,frame,full,foreground,dataSha256})=>({phase,frame,fullMad:full.mad,foregroundMad:foreground.mad,dataSha256}))
})),null,2));
