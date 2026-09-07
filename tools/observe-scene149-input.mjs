#!/usr/bin/env node
// Observe the unchanged scene's controls, and a separately sized startup harness.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createSuiteSceneServer, suiteBrowserModule } from '../dist/src/capture-suite-reference.js';
import { screenshotCaptureBrowserArgs, waitForSceneReady, withBrowserPage } from '../dist/src/browser-harness.js';
import { compareImages } from '../dist/src/parity.js';

const [referenceArgument, outputArgument] = process.argv.slice(2);
assert(referenceArgument, 'Usage: node tools/observe-scene149-input.mjs <canonical-reference-directory> [output-directory]');
const reference = resolve(referenceArgument);
const output = resolve(outputArgument ?? 'artifacts/scene149-input-reference');
mkdirSync(output, { recursive: true });
const sourcePath = 'corpus/babylon-lite/lab/lite/src/lite/scene149.ts';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = suiteBrowserModule(sourcePath);
assert.equal(canonical, readFileSync(join(reference, 'canonical-module.js'), 'utf8'));
const marker = 'await registerScene(scene);';
assert.equal(canonical.split(marker).length, 2);
const observed = canonical.replace(marker, `
window.__scene149Input = {engine, scene, camera, intermediateTarget, ssIntermediate, geomTaskA, geomTaskB, submissions: 0};
const submit = engine._device.queue.submit.bind(engine._device.queue);
engine._device.queue.submit = (...args) => { const result = submit(...args); window.__scene149Input.submissions++; return result; };
${marker}`);
writeFileSync(join(output, 'input-module.js'), observed);
const frames = (page, count) => page.evaluate(async n => {
    for (let i = 0; i < n; i++) await new Promise(requestAnimationFrame);
}, count);
const imageRecord = name => ({ file: name + '.png', sha256: hash(readFileSync(join(output, name + '.png'))) });
const options = { serverName: 'scene149 input observer', browserArgs: screenshotCaptureBrowserArgs,
    viewport: { width: 1280, height: 720 }, pageErrorPrefix: 'scene149 input' };
const live = await withBrowserPage(createSuiteSceneServer(observed, { sourcePath }), options, async (page, origin) => {
    const errors = [];
    page.on('pageerror', error => errors.push({ message: error.message, stack: error.stack }));
    await waitForSceneReady(page, origin, false);
    const state = () => page.evaluate(() => {
        const x = window.__scene149Input;
        const extent = rt => ({ width: rt._width, height: rt._height });
        return { camera: { alpha: x.camera.alpha, beta: x.camera.beta, radius: x.camera.radius,
            target: { x: x.camera.target.x, y: x.camera.target.y, z: x.camera.target.z } },
        viewport: { width: x.engine.canvas.width, height: x.engine.canvas.height },
        draws: x.engine.drawCallCount, submissions: x.submissions,
        targets: Object.fromEntries([
            ['intermediate', extent(x.intermediateTarget)], ['resolve', extent(x.ssIntermediate)],
            ...['geomTaskA', 'geomTaskB'].flatMap(name => Object.entries(x[name])
                .filter(([key, value]) => key.startsWith('geometry') && value && typeof value === 'object' && '_width' in value)
                .map(([key, value]) => [name + '.' + key, extent(value)])),
        ]) };
    });
    const capture = async name => {
        await page.locator('#renderCanvas').screenshot({ path: join(output, name + '.png') });
        return { ...await state(), image: imageRecord(name) };
    };
    const initial = await capture('initial');
    assert.equal(compareImages(join(output, initial.image.file), join(reference, 'reference.png')).mad, 0,
        'Observation changed the canonical image');
    assert.deepEqual(errors, []);
    // Actual pointer events run before resize: the pin's resize failure stops its RAF loop.
    await page.mouse.move(640, 360);
    await page.mouse.down();
    // One movement avoids host scheduling changing the inertia cutoff between moves.
    await page.mouse.move(760, 360);
    await page.mouse.up();
    await frames(page, 180);
    const orbit = await capture('orbit');
    assert(Math.abs(orbit.camera.alpha - initial.camera.alpha) > .1);
    const changed = compareImages(join(output, orbit.image.file), join(output, initial.image.file));
    assert(changed.mad > .05, 'Pointer input did not change the rendered image');
    assert(orbit.submissions > initial.submissions);
    assert.deepEqual(errors, []);
    await page.setViewportSize({ width: 960, height: 600 });
    await page.addStyleTag({ content: 'html,body,canvas{width:960px!important;height:600px!important}' });
    await frames(page, 30);
    const failedResize = await state();
    await frames(page, 30);
    const idleAfterFailure = await state();
    assert(errors.some(error => error.message.includes('#84')));
    assert.equal(failedResize.submissions, idleAfterFailure.submissions, 'Expected pin RAF to stop after its thrown resize error');
    assert.notDeepEqual(failedResize.targets.intermediate, failedResize.targets.resolve);
    return { initial, orbit, orbitImageChange: changed,
        liveResizeLimitation: { errors, failedResize, idleAfterFailure } };
});
// Only the generated HTML harness changes. The module served here is byte-for-byte canonical.
const resized = await withBrowserPage(createSuiteSceneServer(canonical, { sourcePath }),
    { ...options, viewport: { width: 960, height: 600 } }, async (page, origin) => {
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        let harness;
        await page.route('**/scene.html', async route => {
            const response = await route.fetch();
            const original = await response.text();
            assert.equal(original.split('width:1280px;height:720px').length, 2);
            assert.equal(original.split('width="1280" height="720"').length, 2);
            const resizedHtml = original.replace('width:1280px;height:720px', 'width:960px;height:600px')
                .replace('width="1280" height="720"', 'width="960" height="600"');
            harness = { originalSha256: hash(original), resizedSha256: hash(resizedHtml),
                changes: ['CSS width/height 1280px/720px -> 960px/600px', 'canvas width/height 1280/720 -> 960/600'] };
            await route.fulfill({ response, body: resizedHtml });
        });
        await waitForSceneReady(page, origin, false);
        await page.locator('#renderCanvas').screenshot({ path: join(output, 'startup-960x600.png') });
        const state = await page.locator('#renderCanvas').evaluate(canvas => ({
            viewport: { width: canvas.width, height: canvas.height }, draws: Number(canvas.dataset.drawCalls),
            materialCount: Number(canvas.dataset.materialCount) }));
        assert.deepEqual(state.viewport, { width: 960, height: 600 });
        assert.deepEqual(errors, []);
        return { ...state, harness, moduleSha256: hash(canonical), image: imageRecord('startup-960x600') };
    });
const result = { sourcePath, sourceSha256: hash(readFileSync(sourcePath)), canonicalModuleSha256: hash(canonical),
    observerModuleSha256: hash(observed), canonicalPngSha256: hash(readFileSync(join(reference, 'reference.png'))),
    search: '', captureTimeSeconds: null, referenceFrame: null,
    gesture: { start: [640, 360], moves: [[760, 360]], end: [760, 360], settleFrames: 180 },
    ...live, resizedStartup: resized };
writeFileSync(join(output, 'observations.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
