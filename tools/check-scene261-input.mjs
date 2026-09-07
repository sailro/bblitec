#!/usr/bin/env node
// Exact frozen corpus state, plus the separate live TAA camera/resize fixture.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { adHocCaptureEnvironment } from '../dist/src/capture-timing.js';
import { compareImages, compareRegion } from '../dist/src/parity.js';
import { resolveNativeExecutable, spawnNativeMeasured, verifyBuildIdentity, verifyDeployedPayload } from '../dist/src/parity-scene.js';

const [mode, executableArgument, generatedArgument, observationsArgument] = process.argv.slice(2);
assert(['frozen', 'live'].includes(mode) && executableArgument && generatedArgument && (mode === 'live' || observationsArgument),
    'Usage: node tools/check-scene261-input.mjs frozen|live <executable> <generated-directory> [reference-observations.json]');
const executable = resolveNativeExecutable(executableArgument);
const generated = resolve(generatedArgument);
const output = resolve('artifacts/scene261-input', mode);
mkdirSync(output, { recursive: true });
verifyDeployedPayload(executable, generated);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const observations = observationsArgument ? JSON.parse(readFileSync(resolve(observationsArgument), 'utf8')) : undefined;
const reference = observationsArgument ? join(dirname(resolve(observationsArgument)), 'reference.png') : undefined;
if (observations) {
    const manifest = JSON.parse(readFileSync(join(generated, 'manifest.json'), 'utf8'));
    assert.equal(hash(readFileSync(manifest.source)), observations.sourceSha256);
    assert.equal(hash(readFileSync(reference)), observations.referencePngSha256);
    assert.deepEqual(observations.first, observations.idle);
    assert.equal(observations.search, '');
    assert.equal(observations.referenceFrame, null);
    assert.equal(observations.captureTimeSeconds, null);
}
const settings = adHocCaptureEnvironment();
const frame = Number(settings.BBLITE_SCREENSHOT_FRAME);
const orbit = [...Array(20).fill('-'), '+UiMouseLeft@640:360',
    ...Array.from({ length: 12 }, (_, i) => `UiMove@${650 + i * 10}:360`), '-UiMouseLeft@760:360'];
const phases = mode === 'frozen'
    ? [{ name: 'first-ready', frame: 0 }, { name: 'canonical', frame },
        { name: 'idle', frame: frame * 2 }, { name: 'pointer', frame: frame * 2, replay: [...Array(frame).fill('-'), ...orbit] }]
    : [{ name: 'settled', frame }, { name: 'moving', frame: 35, replay: orbit },
        { name: 'recovered', frame, replay: orbit },
        { name: 'resize', frame, replay: [...Array(20).fill('-'), 'WindowResize@960:600'] }];
const results = [];
for (const backend of ['sdl_gpu', 'dawn']) {
    const captures = [];
    for (const phase of phases) {
        const stem = join(output, `${backend}-${phase.name}`);
        for (const suffix of ['.png', '.json', '.build-stamp']) rmSync(stem + suffix, { force: true });
        const log = spawnNativeMeasured(executable, {
            ...settings, BBLITE_GPU_BACKEND: backend, BBLITE_TEST_PASS: '0',
            BBLITE_MAX_FRAMES: String(Math.max(phase.frame + 1, 30)), BBLITE_SCREENSHOT_FRAME: String(phase.frame),
            BBLITE_SCREENSHOT: stem + '.png', BBLITE_RENDER_CAPTURE: stem + '.json',
            BBLITE_BUILD_STAMP_OUT: stem + '.build-stamp', BBLITE_ANIMATION_SEEK_SECONDS: '',
            BBLITE_INPUT_REPLAY: (phase.replay ?? []).join(','), BBLITE_RUNTIME_TRACE: '1',
            BBLITE_GPU_DEBUG: '1', SDL_ASSERT: 'always_ignore',
        }, [], true, 60000);
        writeFileSync(stem + '.log', log);
        assert(!/validation error|gpu error|exception/i.test(log), log);
        verifyBuildIdentity(executable, generated, stem + '.build-stamp');
        const capture = JSON.parse(readFileSync(stem + '.json', 'utf8'));
        const source = capture.temporalTasks.find(task => task.clean);
        const taa = capture.temporalTasks.find(task => task.executions !== undefined);
        assert(source && taa, 'Missing retained source/TAA capture');
        assert.deepEqual(taa.sourceTasks, [source.taskIndex]);
        assert.equal(source.clean.length, 92);
        assert.deepEqual(source.drawn.slice(0, 16), taa.jitterScratch);
        assert.deepEqual(source.drawn.slice(16), source.clean.slice(16));
        assert.equal(taa.lastCameraVersion, source.cache.cameraKey);
        assert.equal(taa.factor, .05);
        if (mode === 'frozen') {
            const expected = observations.first;
            assert.equal(taa.executions, expected.executions, 'Stopped engine continued executing TAA');
            assert.equal(taa.haltonIndex, expected.haltonIndex);
            assert.equal(taa.blendFactor, expected.factor);
            assert.equal(taa.lastCameraVersion, expected.lastCameraVersion);
            // JSON numbers normalize JavaScript -0. Compare retained f32 bits,
            // including signed zero, through exact uint32 word observations.
            for (const key of ['cleanWords', 'drawnWords']) assert.deepEqual(source[key], expected[key], `${key} differs from exact pin`);
            for (const key of ['haltonWords', 'jitterScratchWords']) assert.deepEqual(taa[key], expected[key], `${key} differs from exact pin`);
            for (const key of ['alpha', 'beta', 'radius']) assert.equal(capture.camera[key], expected.camera[key]);
        }
        const full = reference ? compareImages(stem + '.png', reference) : undefined;
        // The source's linear clear color is stored in its unorm render target.
        const foreground = reference ? compareRegion(stem + '.png', reference, [13, 15, 23], 30) : undefined;
        if (full) assert(full.mad < .5 && foreground.mad < .5, `${backend}/${phase.name} exceeds strict image MAD`);
        captures.push({ phase: phase.name, frame: capture.frame, buildStamp: capture.buildStamp,
            image: stem + '.png', camera: capture.camera, viewport: capture.viewport, source, taa, full, foreground });
    }
    if (mode === 'frozen') {
        for (const current of captures.slice(1)) {
            assert.deepEqual(current.source, captures[0].source, 'Frozen source state changed');
            assert.deepEqual(current.taa, captures[0].taa, 'Frozen TAA state changed');
            assert.equal(compareImages(current.image, captures[0].image).mad, 0, 'Frozen image changed');
        }
    } else {
        const [settled, moving, recovered, resized] = captures;
        assert.equal(settled.taa.blendFactor, .05);
        assert.equal(moving.taa.blendFactor, 1, 'Camera movement did not reset accumulation');
        assert.equal(recovered.taa.blendFactor, .05, 'Accumulation did not resume after camera settled');
        assert(moving.source.cache.cameraKey > settled.source.cache.cameraKey);
        assert(Math.abs(recovered.camera.alpha - settled.camera.alpha) > .1);
        assert(compareImages(recovered.image, settled.image).mad > .05, 'Camera input did not change rendered image');
        assert.deepEqual(resized.viewport, { width: 960, height: 600 });
        assert.equal(resized.source.cache.aspect, 960 / 600);
        assert.notDeepEqual(resized.source.clean, settled.source.clean);
        assert.equal(resized.taa.blendFactor, .05);
    }
    results.push({ backend, captures });
}
writeFileSync(join(output, 'verification.json'), JSON.stringify({ mode, reference, results }, null, 2) + '\n');
console.log(JSON.stringify(results.map(({ backend, captures }) => ({ backend, captures: captures.map(({ phase, frame, taa, full, foreground }) => ({
    phase, frame, executions: taa.executions, haltonIndex: taa.haltonIndex, blendFactor: taa.blendFactor,
    fullMad: full?.mad, foregroundMad: foreground?.mad,
})) })), null, 2));
