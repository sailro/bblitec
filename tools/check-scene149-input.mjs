#!/usr/bin/env node
// Camera input and resized output for the unchanged PowerPlant geometry scene.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { PNG } from 'pngjs';
import { adHocCaptureEnvironment } from '../dist/src/capture-timing.js';
import { suiteBrowserModuleDigest } from '../dist/src/capture-suite-reference.js';
import { compareImages, compareRegion } from '../dist/src/parity.js';
import { resolveNativeExecutable, spawnNativeMeasured, verifyBuildIdentity, verifyDeployedPayload } from '../dist/src/parity-scene.js';

const args = process.argv.slice(2);
const verifyExisting = args.includes('--verify-existing');
const [executableArgument, generatedArgument, observationsArgument, outputArgument] = args.filter(arg => arg !== '--verify-existing');
assert(executableArgument && generatedArgument && observationsArgument,
    'Usage: node tools/check-scene149-input.mjs <executable> <generated-directory> <browser-observations.json> [output-directory] [--verify-existing]');
const executable = resolveNativeExecutable(executableArgument);
const generated = resolve(generatedArgument);
const referenceDir = dirname(resolve(observationsArgument));
const output = resolve(outputArgument ?? 'artifacts/scene149-input');
mkdirSync(output, { recursive: true });
rmSync(join(output, 'verification.json'), { force: true });
verifyDeployedPayload(executable, generated);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const observations = JSON.parse(readFileSync(resolve(observationsArgument), 'utf8'));
const manifest = JSON.parse(readFileSync(join(generated, 'manifest.json'), 'utf8'));
assert.equal(hash(readFileSync(manifest.source)), observations.sourceSha256);
assert.equal(suiteBrowserModuleDigest(manifest.source), observations.canonicalModuleSha256);
assert.equal(observations.search, '');
assert.equal(observations.captureTimeSeconds, null);
assert.equal(observations.referenceFrame, null);
assert.equal(observations.resizedStartup.moduleSha256, observations.canonicalModuleSha256);
assert.equal(hash(readFileSync(join(referenceDir, 'input-module.js'))), observations.observerModuleSha256);
for (const state of [observations.initial, observations.orbit, observations.resizedStartup]) {
    assert.equal(hash(readFileSync(join(referenceDir, state.image.file))), state.image.sha256);
    const image = PNG.sync.read(readFileSync(join(referenceDir, state.image.file)));
    assert.deepEqual({ width: image.width, height: image.height }, state.viewport);
}
assert.equal(observations.initial.image.sha256, observations.canonicalPngSha256);
assert(observations.liveResizeLimitation.errors.some(error => error.message.includes('#84')));
assert(observations.liveResizeLimitation.errors.some(error => error.stack.includes('buildResolvePath')));
assert.notDeepEqual(observations.liveResizeLimitation.failedResize.targets.intermediate,
    observations.liveResizeLimitation.failedResize.targets.resolve);
assert.equal(observations.liveResizeLimitation.failedResize.submissions,
    observations.liveResizeLimitation.idleAfterFailure.submissions);

const settings = adHocCaptureEnvironment();
const frame = Number(settings.BBLITE_SCREENSHOT_FRAME);
assert.deepEqual(observations.gesture, { start: [640, 360], moves: [[760, 360]], end: [760, 360], settleFrames: 180 });
const orbit = [...Array(20).fill('-'), '+UiMouseLeft@640:360', 'UiMove@760:360', '-UiMouseLeft@760:360'];
const phases = [
    { name: 'canonical', frame, reference: observations.initial },
    { name: 'orbit', frame: frame * 2, reference: observations.orbit, replay: orbit },
    { name: 'resize', frame, reference: observations.resizedStartup,
        replay: [...Array(20).fill('-'), 'WindowResize@960:600'] },
];
const results = [];
// Source placeStrip(..., 0) displays these seven attachments in the bottom 15%.
const tileNames = ['viewNormal', 'worldNormal', 'worldPosition', 'reflectivity', 'localPosition', 'viewDepth', 'screenspaceDepth'];
function compareTiles(actualPath, referencePath, stem) {
    const images = [actualPath, referencePath].map(path => PNG.sync.read(readFileSync(path)));
    const { width, height } = images[0];
    const top = Math.floor(height * .85);
    return tileNames.map((name, index) => {
        const left = Math.floor(index * width / tileNames.length);
        const right = Math.floor((index + 1) * width / tileNames.length);
        const paths = images.map((image, side) => {
            const crop = new PNG({ width: right - left, height: height - top });
            PNG.bitblt(image, crop, left, top, crop.width, crop.height, 0, 0);
            const path = `${stem}-${name}-${side === 0 ? 'native' : 'browser'}.png`;
            writeFileSync(path, PNG.sync.write(crop));
            return path;
        });
        return { name, rect: { x: left, y: top, width: right - left, height: height - top },
            comparison: compareImages(paths[0], paths[1]) };
    });
}
for (const backend of ['sdl_gpu', 'dawn']) {
    const captures = [];
    for (const phase of phases) {
        const stem = join(output, `${backend}-${phase.name}`);
        if (!verifyExisting) {
            for (const suffix of ['.png', '.json', '.build-stamp']) rmSync(stem + suffix, { force: true });
            const log = spawnNativeMeasured(executable, {
            ...settings, BBLITE_GPU_BACKEND: backend, BBLITE_TEST_PASS: '0',
            BBLITE_MAX_FRAMES: String(phase.frame + 1), BBLITE_SCREENSHOT_FRAME: String(phase.frame),
            BBLITE_SCREENSHOT: stem + '.png', BBLITE_RENDER_CAPTURE: stem + '.json',
            BBLITE_BUILD_STAMP_OUT: stem + '.build-stamp', BBLITE_ANIMATION_SEEK_SECONDS: '',
            BBLITE_INPUT_REPLAY: (phase.replay ?? []).join(','), BBLITE_RUNTIME_TRACE: '1',
            BBLITE_GPU_DEBUG: '1', BBLITE_NODE_GPU_CAPTURE: '', SDL_ASSERT: 'always_ignore',
            }, [], true, 90000);
            writeFileSync(stem + '.log', log);
        }
        const log = readFileSync(stem + '.log', 'utf8');
        assert(!/validation error|gpu error|exception/i.test(log), log);
        verifyBuildIdentity(executable, generated, stem + '.build-stamp');
        const capture = JSON.parse(readFileSync(stem + '.json', 'utf8'));
        assert.equal(capture.frame, phase.frame);
        const png = PNG.sync.read(readFileSync(stem + '.png'));
        assert.deepEqual({ width: png.width, height: png.height }, phase.reference.viewport);
        assert.deepEqual(capture.viewport, phase.reference.viewport);
        const referenceImage = join(referenceDir, phase.reference.image.file);
        const full = compareImages(stem + '.png', referenceImage);
        const foreground = compareRegion(stem + '.png', referenceImage, [51, 51, 76], 8);
        captures.push({ phase: phase.name, frame: capture.frame, buildStamp: capture.buildStamp,
            image: stem + '.png', camera: capture.camera, viewport: capture.viewport, scene: capture.scene,
            full, foreground, tiles: compareTiles(stem + '.png', referenceImage, stem) });
    }
    const [initial, moved, resized] = captures;
    assert(Math.abs(moved.camera.alpha - initial.camera.alpha) > .1, 'Native camera ignored pointer input');
    const orbitImageChange = compareImages(initial.image, moved.image);
    assert(orbitImageChange.mad > .05, 'Native pointer input did not change the rendered image');
    for (const state of [initial, resized]) {
        for (const key of ['alpha', 'beta', 'radius']) assert.equal(state.camera[key], observations.initial.camera[key]);
        assert.deepEqual(state.camera.target, initial.camera.target);
    }
    for (const key of ['alpha', 'beta', 'radius']) assert.equal(moved.camera[key], observations.orbit.camera[key],
        `Settled native ${key} differs from the actual browser pointer gesture`);
    assert.deepEqual(moved.camera.target, initial.camera.target);
    results.push({ backend, captures, orbitImageChange });
}
const backendComparisons = phases.map((phase, i) => {
    const a = results[0].captures[i], b = results[1].captures[i];
    assert.deepEqual(a.camera, b.camera, `${phase.name} camera state differs between backends`);
    return { phase: phase.name, full: compareImages(a.image, b.image),
        foreground: compareRegion(a.image, b.image, [51, 51, 76], 8) };
});
const report = { sourceSha256: observations.sourceSha256, generated, executable, verifyExisting, results, backendComparisons,
    liveResizeLimitation: observations.liveResizeLimitation,
    resizeEvidence: 'Native resized output and all seven displayed tiles are compared with fresh canonical-module browser startup at 960x600; this does not claim the pin survives live resize or directly observe hidden native attachment dimensions.' };
for (const { captures } of results) for (const state of captures) {
    const gate = state.phase === 'canonical' ? .02 : .5;
    assert(state.full.mad < gate && state.foreground.mad < gate, `${state.phase} exceeds full/foreground MAD${gate}`);
    for (const tile of state.tiles) assert(tile.comparison.mad < .5,
        `${state.phase}/${tile.name} exceeds tile MAD0.5`);
}
for (const state of backendComparisons) assert(state.full.mad < .5 && state.foreground.mad < .5,
    `${state.phase} images disagree between backends`);
writeFileSync(join(output, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(results.map(({ backend, captures, orbitImageChange }) => ({ backend,
    orbitImageChange: orbitImageChange.mad,
    captures: captures.map(({ phase, camera, full, foreground, tiles }) => ({ phase, alpha: camera.alpha,
        fullMad: full.mad, foregroundMad: foreground.mad,
        worstTileMad: Math.max(...tiles.map(tile => tile.comparison.mad)) })) })), null, 2));
