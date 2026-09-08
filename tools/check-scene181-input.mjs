#!/usr/bin/env node
// Observe live form, layout and camera state without changing the pinned entry.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PNG } from 'pngjs';
import { createSuiteSceneServer, suiteBrowserModule } from '../dist/src/capture-suite-reference.js';
import { screenshotCaptureBrowserArgs, waitForSceneReady, withBrowserPage } from '../dist/src/browser-harness.js';
import { adHocCaptureEnvironment } from '../dist/src/capture-timing.js';
import { compareImages, compareRegion } from '../dist/src/parity.js';
import { resolveNativeExecutable, spawnNativeMeasured, verifyBuildIdentity, verifyDeployedPayload } from '../dist/src/parity-scene.js';

const output = resolve(process.argv[2] ?? 'artifacts/scene181-input');
const generated = resolve(process.argv[3] ?? 'generated/scene181');
const executable = resolveNativeExecutable(process.argv[4] ?? 'native/build-scene181-release/bblite_native.exe');
mkdirSync(output, { recursive: true });
verifyDeployedPayload(executable, generated);
const sourcePath = 'corpus/babylon-lite/lab/lite/src/lite/scene181.ts';
const canonical = suiteBrowserModule(sourcePath);
const marker = 'await registerScene(scene);';
assert.equal(canonical.split(marker).length, 2);
const observed = canonical.replace(marker, `window.__textInputObserver = { data, text, camera, engine };\n${marker}`);
writeFileSync(join(output, 'canonical-module.js'), canonical);
writeFileSync(join(output, 'observed-module.js'), observed);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pause = count => Array(count).fill('-');
const edit = text => ['UiClick@80:35', 'UiKey@Ctrl+A', text ? `UiText@${Buffer.from(text).toString('hex')}` : 'UiKey@Backspace', 'UiClick@400:250'];
const phrases = ['New ffi text Ω Ж', 'Line one\nAnother line with AV and é\nNew glyphs stay live.'];
const phases = [
    { name: 'initial', replay: [] },
    { name: 'edit', text: phrases[0], replay: edit(phrases[0]) },
    { name: 'empty', text: '', replay: edit('') },
    { name: 'regrow', text: phrases[1], clearFirst: true, replay: [...edit(''), ...pause(5), ...edit(phrases[1])] },
    { name: 'textarea-resize', resizeForm: true, replay: ['+UiMouseLeft@350:150', 'UiMove@350:230', '-UiMouseLeft@350:230'] },
    { name: 'window-resize', resize: true, replay: ['WindowResize@960:600'] },
    { name: 'orbit', orbit: true, replay: ['+UiMouseLeft@640:360', 'UiMove@760:360', '-UiMouseLeft@760:360'] },
    { name: 'zoom', zoom: true, replay: ['UiWheelUp'] },
];
const frames = (page, count) => page.evaluate(async count => {
    for (let i = 0; i < count; i++) await new Promise(requestAnimationFrame);
}, count);
const records = await withBrowserPage(createSuiteSceneServer(observed, {
    sourcePath, hostPage: 'corpus/babylon-lite/lab/lite/scene181.html',
}), { serverName: 'live text observer', browserArgs: screenshotCaptureBrowserArgs,
    viewport: { width: 1280, height: 720 }, pageErrorPrefix: 'Live text observer' }, async (page, origin) => {
    const results = [];
    for (const phase of phases) {
        await page.setViewportSize({ width: 1280, height: 720 });
        await waitForSceneReady(page, origin, false);
        if (phase.name === 'initial') {
            await page.screenshot({ path: join(output, 'observed.png') });
            assert.equal(compareImages(join(output, 'observed.png'), 'reference/scene181/babylon-lite-golden.png').mad, 0,
                'Observer changed the unchanged source image');
        }
        if (phase.clearFirst) await page.locator('#textInput').fill('');
        if ('text' in phase) { await page.locator('#textInput').fill(phase.text); await page.mouse.click(400, 250); }
        if (phase.resizeForm) {
            await page.mouse.move(350,150); await page.mouse.down(); await page.mouse.move(350,230); await page.mouse.up();
        }
        if (phase.resize) await page.setViewportSize({ width: 960, height: 600 });
        if (phase.orbit) {
            await page.mouse.move(640,360); await page.mouse.down(); await page.mouse.move(760,360); await page.mouse.up();
        }
        if (phase.zoom) { await page.mouse.move(640,360); await page.mouse.wheel(0,-100); }
        await frames(page, 180);
        const state = await page.evaluate(() => {
            const { data, text, camera, engine } = window.__textInputObserver;
            const group = data._groups[0];
            const ids = new Map([...group._curveSet._atlas._glyphSlots].map(([id, slot]) => [slot._index, id]));
            const instances = Array.from({ length: data._instanceCount }, (_, i) => {
                const word = data._instancesU32[i*3+2];
                return word === 0xffffffff ? null : [ids.get(word & 0xffff), data._instances[i*3], data._instances[i*3+1], word >>> 16];
            });
            const rectangle = document.getElementById('textInput').getBoundingClientRect();
            return { width: data.width, height: data.height, instances, styles: Array.from(data._styles),
                camera: { alpha: camera.alpha, beta: camera.beta, radius: camera.radius },
                position: { x: text.position.x, y: text.position.y, z: text.position.z },
                viewport: { width: engine.canvas.width, height: engine.canvas.height },
                form: { width: rectangle.width, height: rectangle.height } };
        });
        if ('text' in phase) {
            assert.equal(state.position.x, -state.width * .01 * .5);
            assert.equal(state.position.y, state.height * .01 * .5);
        }
        const hidden = phase.resizeForm ? undefined : await page.addStyleTag({ content: '#textInput{visibility:hidden!important}' });
        await page.screenshot({ path: join(output, `browser-${phase.name}.png`) });
        if (hidden) await hidden.evaluate(e => e.remove());
        results.push({ ...phase, state });
    }
    return results;
});
assert.equal(records.find(r=>r.resizeForm).state.form.height, 218);
writeFileSync(join(output,'browser-observations.json'), JSON.stringify(records,null,2)+'\n');
const manifest = JSON.parse(readFileSync(join(generated,'manifest.json'), 'utf8'));
const ids = new Map(manifest.textData[0].live.glyphSlots.map((slot,id)=>[slot,id]));
const summaries = [];
for (const backend of ['sdl_gpu','dawn']) for (const phase of records) {
    const stem = join(output, `${backend}-${phase.name}`);
    const log = spawnNativeMeasured(executable, {
        ...adHocCaptureEnvironment(), BBLITE_GPU_BACKEND: backend, BBLITE_TEST_PASS: '0',
        BBLITE_SCREENSHOT: stem+'.png', BBLITE_RENDER_CAPTURE: stem+'.json', BBLITE_BUILD_STAMP_OUT: stem+'.build-stamp',
        BBLITE_SCREENSHOT_FRAME: '240', BBLITE_MAX_FRAMES: '241', BBLITE_ANIMATION_SEEK_SECONDS: '',
        BBLITE_INPUT_REPLAY: [...pause(20), ...phase.replay].join(','), BBLITE_CAPTURE_UI: phase.resizeForm ? '1' : '0',
        BBLITE_RUNTIME_TRACE:'1', BBLITE_GPU_DEBUG:'1', SDL_ASSERT:'always_ignore',
    }, [], true, 60000);
    writeFileSync(stem+'.log',log);
    assert(!/validation error|gpu error|exception/i.test(log), log);
    verifyBuildIdentity(executable,generated,stem+'.build-stamp');
    const capture = JSON.parse(readFileSync(stem+'.json','utf8'));
    const gpu = capture.textGpu;
    assert.deepEqual(capture.viewport, phase.state.viewport);
    for (const key of ['alpha','beta','radius']) assert(Math.abs(capture.camera[key]-phase.state.camera[key])<1e-8,
        `${backend}/${phase.name} camera ${key}: ${capture.camera[key]} vs ${phase.state.camera[key]}`);
    const draw = gpu.draws[0];
    const expectedLive = phase.state.instances.filter(Boolean);
    const actual = [];
    if (draw) {
        const resource = gpu.resources.find(r=>r.id===draw.instances);
        assert(resource && !resource.destroyed);
        const bytes = Buffer.from(resource.uploadedBytes);
        for(let i=0;i<draw.instanceCount;i++) {
            const slot=draw.firstInstance+i, word=bytes.readUInt32LE(slot*12+8);
            if(word!==0xffffffff) actual.push([ids.get(word&0xffff),bytes.readFloatLE(slot*12),bytes.readFloatLE(slot*12+4),word>>>16]);
        }
        const palette = gpu.resources.find(r=>r.role==='styles' && !r.destroyed);
        assert.deepEqual(Array.from({length:phase.state.styles.length},(_,i)=>Buffer.from(palette.uploadedBytes).readFloatLE(i*4)),phase.state.styles);
    }
    assert.deepEqual(actual,expectedLive,`${backend}/${phase.name} actual glyph placements`);
    const reference=join(output,`browser-${phase.name}.png`);
    const full=compareImages(stem+'.png',reference), foreground=compareRegion(stem+'.png',reference,[51,51,76],30);
    assert(full.mad<(phase.resizeForm?.05:.001) && foreground.mad<(phase.resizeForm?.499:.001), `${backend}/${phase.name} canvas ${full.mad}/${foreground.mad}`);
    const nativeImage=PNG.sync.read(readFileSync(stem+'.png'));
    assert.equal(nativeImage.width,phase.state.viewport.width);
    if (phase.resizeForm) {
        const rows = Array.from({length:300},(_,y)=>y).filter(y=>
            [51,51,76].some((color,c)=>nativeImage.data[(y*nativeImage.width+170)*4+c]!==color));
        assert.equal(rows.at(-1)-rows[0]+1,phase.state.form.height,'Native textarea resize height');
    }
    summaries.push({backend,phase:phase.name,viewport:capture.viewport,camera:capture.camera,
        glyphs:actual.length,fullMad:full.mad,foregroundMad:foreground.mad,buildStamp:capture.buildStamp});
}
writeFileSync(join(output,'report.json'), JSON.stringify({
    sourceSha256:hash(readFileSync(sourcePath)),canonicalSha256:hash(canonical),observedSha256:hash(observed),
    browser:records.map(({name,state})=>({name,state})),native:summaries,
},null,2)+'\n');
console.log(`scene181: ${summaries.length} backend/control captures passed; source input, glyphs, palette, camera and canvas agree.`);
