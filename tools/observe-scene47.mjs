#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {suiteBrowserModule, createSuiteSceneServer} from '../dist/src/capture-suite-reference.js';
import {withBrowserPage, waitForSceneReady, screenshotCaptureBrowserArgs} from '../dist/src/browser-harness.js';
import {compareImages} from '../dist/src/parity.js';

const source = 'corpus/babylon-lite/lab/lite/src/lite/scene47.ts';
const output = resolve('artifacts/scene47-controls/browser');
mkdirSync(output, {recursive:true});
const sourceText = readFileSync(source, 'utf8');
const hook = `window.__scene47Observe = () => {
    const vector = value => [value.x,value.y,value.z];
    return {step:physStep, camera:{alpha:scene.camera.alpha,beta:scene.camera.beta,radius:scene.camera.radius},
        viewport:{width:canvas.width,height:canvas.height},
        bodies:world._bodies.map(body => ({mesh:scene.meshes.indexOf(body.node),type:body._shape._type,
            position:vector(body.node.position), rotation:[body.node.rotationQuaternion.x,body.node.rotationQuaternion.y,body.node.rotationQuaternion.z,body.node.rotationQuaternion.w]}))};
};`;
assert.equal(sourceText.split('await registerScene(scene);').length, 2);
const module = suiteBrowserModule(source, text => text.replace('await registerScene(scene);', hook + '\nawait registerScene(scene);'));
const server = createSuiteSceneServer(module, {sourcePath:source});
const frames = [];
const input = [];
await withBrowserPage(server, {serverName:'scene47 controls', browserArgs:screenshotCaptureBrowserArgs,
    viewport:{width:1280,height:720}, pageErrorPrefix:'browser'}, async(page, origin) => {
    for (const frame of [1,60,120,240]) {
        await waitForSceneReady(page, origin, false, `?captureFrame=${frame}`);
        const state = await page.evaluate(() => window.__scene47Observe());
        assert.equal(state.step, frame);
        const path = resolve(output, `frame-${frame}.png`);
        await page.screenshot({path});
        frames.push({frame, ...state, image:path});
    }
    assert.equal(compareImages(frames[0].image, 'reference/scene47/babylon-lite-golden.png').maxDiff, 0, 'Read-only observation changed the reference');
    await waitForSceneReady(page, origin, false);
    const snapshot = async name => {
        const state = await page.evaluate(() => window.__scene47Observe());
        const path = resolve(output, name+'.png');
        await page.screenshot({path});
        input.push({name, ...state, image:path});
    };
    await snapshot('baseline');
    await page.mouse.move(850,340);
    await page.mouse.down();
    await page.mouse.move(910,355,{steps:8});
    await page.mouse.up();
    await page.mouse.wheel(0,100);
    await page.waitForTimeout(200);
    await snapshot('pointer-wheel');
    assert.deepEqual(input[1].camera, input[0].camera, 'Scene has no attached camera controls');
    assert(input[1].step > input[0].step, 'Physics stopped during input');
    await page.setViewportSize({width:1000,height:600});
    await page.evaluate(() => {
        document.documentElement.style.width = document.body.style.width = '1000px';
        document.documentElement.style.height = document.body.style.height = '600px';
        const canvas = document.querySelector('canvas');
        canvas.style.width='1000px'; canvas.style.height='600px';
    });
    await page.waitForFunction(() => window.__scene47Observe().viewport.width === 1000);
    await snapshot('resize');
    assert.deepEqual(input[2].viewport, {width:1000,height:600});
    assert(input[2].step > input[1].step, 'Physics stopped during resize');
});
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
writeFileSync(resolve(output,'observations.json'), JSON.stringify({sourceSha256:sha256(sourceText),
    moduleSha256:sha256(module), referenceSha256:sha256(readFileSync('reference/scene47/babylon-lite-golden.png')), frames,input},null,2)+'\n');
console.log('Scene47 browser: exact observed reference; frames1/60/120/240; live input and resize passed.');
