#!/usr/bin/env node
// Observe each canvas through the application's SDL event tape and actual GPU pixels.
import assert from 'node:assert/strict';
import {mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {PNG} from 'pngjs';
import {adHocCaptureEnvironment} from '../dist/src/capture-timing.js';
import {resolveNativeExecutable, spawnNativeMeasured, verifyBuildIdentity, verifyDeployedPayload} from '../dist/src/parity-scene.js';

const output = resolve('artifacts/surface-input');
mkdirSync(output, {recursive: true});
rmSync(resolve(output, 'verification.json'), {force: true});
const idle = count => Array(count).fill('-');
const drag = (start, finish) => [...idle(20), `+UiMouseLeft@${start}:360`,
    ...Array.from({length: 12}, (_, index) => `UiMove@${Math.round(start + (finish - start) * (index + 1) / 12)}:360`),
    `-UiMouseLeft@${finish}:360`];
const phases = [
    {name: 'baseline', frame: 90}, {name: 'idle', frame: 180},
    {name: 'left', frame: 90, replay: drag(300, 420)},
    {name: 'right', frame: 90, replay: drag(940, 1060)},
    {name: 'crossing', frame: 90, replay: [...drag(580, 720), 'UiMove@900:360']},
    {name: 'resize', frame: 90, replay: [...idle(20), 'WindowResize@1000:600']},
];
function paneDifference(actual, expected, right) {
    assert.equal(actual.width, expected.width);
    assert.equal(actual.height, expected.height);
    const start = right ? Math.ceil(actual.width / 2) + 4 : 0;
    const end = right ? actual.width : Math.floor(actual.width / 2) - 4;
    let total = 0;
    for (let y = 40; y < actual.height; y++) for (let x = start; x < end; x++)
        for (let lane = 0; lane < 3; lane++) {
            const offset = (y * actual.width + x) * 4 + lane;
            total += Math.abs(actual.data[offset] - expected.data[offset]);
        }
    return total / ((end - start) * (actual.height - 40) * 3);
}
const results = [];
for (const scene of ['scene227', 'scene228']) {
    const generated = resolve('generated', scene);
    const executable = resolveNativeExecutable(resolve('native', `build-${scene}-release`, 'bblite_native.exe'));
    verifyDeployedPayload(executable, generated);
    for (const backend of ['sdl_gpu', 'dawn']) {
        const captures = [];
        for (const phase of phases) {
            const stem = resolve(output, `${scene}-${backend}-${phase.name}`);
            const log = spawnNativeMeasured(executable, {
                ...adHocCaptureEnvironment(), BBLITE_GPU_BACKEND: backend, BBLITE_TEST_PASS: '0',
                BBLITE_MAX_FRAMES: String(phase.frame + 1), BBLITE_SCREENSHOT_FRAME: String(phase.frame),
                BBLITE_SCREENSHOT: stem + '.png', BBLITE_BUILD_STAMP_OUT: stem + '.build-stamp',
                BBLITE_INPUT_REPLAY: (phase.replay ?? []).join(','), BBLITE_CAPTURE_UI: '0',
                BBLITE_GPU_DEBUG: '1', SDL_ASSERT: 'always_ignore',
            }, [], true, 60000);
            writeFileSync(stem + '.log', log);
            assert(!/validation error|gpu error|exception/i.test(log), log);
            verifyBuildIdentity(executable, generated, stem + '.build-stamp');
            const png = PNG.sync.read(readFileSync(stem + '.png'));
            if (phase.name === 'resize') {
                assert.deepEqual([png.width, png.height], [1000, 600], 'Window did not resize');
                // Count geometry against each canvas's own clear color; a colored clear alone must fail.
                for (const right of [false, true]) {
                    const start = right ? Math.ceil(png.width / 2) + 4 : 0;
                    const end = right ? png.width : Math.floor(png.width / 2) - 4;
                    const background = (40 * png.width + start) * 4;
                    let geometryPixels = 0;
                    for (let y = 40; y < png.height; y++) for (let x = start; x < end; x++) {
                        const offset = (y * png.width + x) * 4;
                        if ([0,1,2].some(lane=>Math.abs(png.data[offset+lane]-png.data[background+lane])>30)) ++geometryPixels;
                    }
                    assert(geometryPixels > 1000, 'Resized canvas lost its geometry');
                }
                captures.push({phase: phase.name, dimensions: [png.width, png.height]});
            } else {
                const baseline = captures[0]?.png ?? png;
                const left = paneDifference(png, baseline, false), right = paneDifference(png, baseline, true);
                if (phase.name === 'idle') assert(left === 0 && right === 0, 'Idle canvases changed');
                if (phase.name === 'left' || phase.name === 'crossing') {
                    assert(left > 1, 'Left camera input did not change its canvas');
                    assert.equal(right, 0, 'Left drag changed the right camera');
                }
                if (phase.name === 'right') {
                    assert(right > 1, 'Right camera input did not change its canvas');
                    assert.equal(left, 0, 'Right drag changed the left camera');
                }
                captures.push({phase: phase.name, left, right, png});
            }
        }
        results.push({scene, backend, captures: captures.map(({png, ...result}) => result)});
    }
}
writeFileSync(resolve(output, 'verification.json'), JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(results, null, 2));
