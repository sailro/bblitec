#!/usr/bin/env node
// Compare real text uploads and draw bindings with the unchanged pinned scene.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PNG } from 'pngjs';
import { adHocCaptureEnvironment } from '../dist/src/capture-timing.js';
import { compareImages, compareRegion } from '../dist/src/parity.js';
import { resolveNativeExecutable, spawnNativeMeasured, verifyBuildIdentity, verifyDeployedPayload } from '../dist/src/parity-scene.js';

const [executableArgument, generatedArgument, referenceArgument, outputArgument] = process.argv.slice(2);
assert(executableArgument && generatedArgument && referenceArgument,
    'Usage: node tools/check-scene275-input.mjs <executable> <generated-directory> <browser-reference-directory> [output-directory]');
const executable = resolveNativeExecutable(executableArgument);
const generated = resolve(generatedArgument);
const reference = resolve(referenceArgument);
const output = resolve(outputArgument ?? 'artifacts/scene275-input');
mkdirSync(output, { recursive: true });
verifyDeployedPayload(executable, generated);
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const imageSize = (path, expected) => {
    const { width, height } = PNG.sync.read(readFileSync(path));
    assert.deepEqual({ width, height }, expected, `Image dimensions: ${path}`);
};
const manifest = json(join(generated, 'manifest.json'));
const metadata = json(join(reference, 'metadata.json'));
const browser = json(join(reference, 'observations.json'));
assert.equal(hash(readFileSync(manifest.source)), metadata.sourceSha256);
assert.equal(hash(readFileSync(join(reference, 'canonical-module.js'))), metadata.canonicalModuleSha256);
assert.equal(hash(readFileSync(join(reference, 'reference.png'))), metadata.referencePngSha256);
assert.equal(hash(readFileSync(join(reference, 'resize.png'))), browser.resizePngSha256);
assert.equal(hash(readFileSync(join(reference, 'observed-module.js'))), browser.observationModuleSha256);
assert.equal(metadata.search, '');
assert.equal(metadata.referenceFrame, null);
assert.equal(metadata.captureTimeSeconds, null);
for (const image of ['reference.png', 'observed.png', 'input.png'])
    imageSize(join(reference, image), { width: 1280, height: 720 });
imageSize(join(reference, 'resize.png'), { width: 960, height: 600 });
assert.equal(compareImages(join(reference, 'observed.png'), join(reference, 'reference.png')).mad, 0,
    'Observer changed the canonical image');
assert.equal(compareImages(join(reference, 'input.png'), join(reference, 'reference.png')).mad, 0,
    'Pinned unattached camera responded to input');
assert.equal(browser.idleWriteCount, browser.first.observation.writes.length);
assert.deepEqual(browser.input.observation.writes, browser.first.observation.writes);

const roles = new Map([
    ['text-quad-corners', 'quad'], ['text-renderable-ubo', 'uniform'],
    ['text-instance', 'instances'], ['text-styles', 'styles'],
    ['text-glyph-metadata', 'metadata'], ['text-slug-curves', 'curves'], ['text-slug-bands', 'bands'],
]);
const constants = value => Object.entries(value ?? {}).map(([id, number]) => ({ id: Number(id), value: number }))
    .sort((a, b) => a.id - b.id);

function verifyReceipts(capture, observed, backend) {
    const gpu = capture.textGpu;
    assert(gpu, 'Missing actual text GPU operation receipts');
    assert.equal(gpu.frame, capture.frame, 'Text draw receipt belongs to a different frame');
    const resources = new Map(gpu.resources.map(resource => [resource.id, resource]));
    assert.equal(resources.size, gpu.resources.length, 'Resource IDs were reused');
    const expectedResources = new Map(observed.resources.map(resource => [resource.id, resource]));
    const identity = new Map();
    const summaries = [];
    for (const [label, role] of roles) {
        const expected = observed.resources.filter(resource => resource.label === label);
        const actual = gpu.resources.filter(resource => resource.role === role || (role === 'uniform' && resource.role === 'uniform-shadow'));
        assert.equal(actual.length, expected.length, `${role} allocation count`);
        expected.forEach((resource, index) => {
            const native = actual[index];
            identity.set(resource.id, native.id);
            assert.equal(native.destroyed, false, `${role} destroyed while still in use`);
            const texture = resource.kind === 'texture';
            const size = texture ? resource.size.width * resource.size.height * 16 : resource.size;
            assert.equal(native.allocationBytes, size, `${role} allocation size`);
            assert.equal(native.width, texture ? resource.size.width : 0);
            assert.equal(native.rows, texture ? resource.size.height : 0);
            const writes = observed.writes.filter(write => write.id === resource.id);
            assert(writes.length, `Browser did not observe ${label} uploads`);
            const bytes = Buffer.alloc(size);
            let used = 0;
            for (const write of writes) {
                const offset = write.offset ?? write.layout?.offset ?? 0;
                Buffer.from(write.bytes).copy(bytes, offset);
                used = Math.max(used, offset + write.bytes.length);
            }
            // These scenes initialize one contiguous prefix; unused allocation
            // tails are deliberately excluded from the byte comparison.
            assert.deepEqual(native.writtenRanges, [{ offset: 0, bytes: used }], `${role} observed ranges`);
            assert.deepEqual(Buffer.from(native.uploadedBytes), bytes.subarray(0, used), `${role}[${index}] uploaded bytes`);
            assert.deepEqual(native.writes.map(write => ({ offset: write.offset, bytes: write.bytes })),
                writes.map(write => ({ offset: write.offset ?? write.layout?.offset ?? 0, bytes: write.bytes.length })),
                `${role}[${index}] write count/order/ranges`);
            summaries.push({ role: native.role, id: native.id, allocationBytes: size, uploadedBytes: used,
                sha256: hash(bytes.subarray(0, used)), writes: native.writes });
        });
    }
    const draws = observed.draws.slice(-2);
    assert.equal(gpu.draws.length, draws.length);
    const groupIdentity = new Map(), pipelineIdentity = new Map(), viewIdentity = new Map();
    draws.forEach((draw, index) => {
        const native = gpu.draws[index];
        const pipeline = observed.pipelines.find(row => row.id === draw.pipeline);
        const group = observed.groups.find(row => row.id === draw.groups[0]);
        assert(pipeline && group, 'Browser draw lacks its pipeline or group');
        for (const [map, sourceId, nativeId, role] of [
            [groupIdentity, group.id, native.group, backend === 'dawn' ? 'bind-group' : 'binding-set'],
            [pipelineIdentity, pipeline.id, native.pipeline, 'pipeline'],
        ]) {
            if (map.has(sourceId)) assert.equal(nativeId, map.get(sourceId), 'Shared source binding identity was lost');
            else { assert(![...map.values()].includes(nativeId), 'Distinct source binding identities collapsed'); map.set(sourceId, nativeId); }
            assert.equal(resources.get(nativeId)?.role, role, 'Draw refers to the wrong resource kind');
            assert.equal(resources.get(nativeId).destroyed, false, 'Draw refers to a retired resource');
        }
        assert.equal(native.quad, identity.get(draw.vertices[0].buffer));
        assert.equal(native.instances, identity.get(draw.vertices[1].buffer));
        assert.deepEqual([native.vertices, native.instanceCount, native.firstVertex, native.firstInstance], draw.args);
        assert.equal(native.bindings.length, group.entries.length);
        for (const binding of group.entries) {
            const expected = expectedResources.get(binding.resource);
            const underlying = expected.kind === 'view' ? expected.texture : expected.id;
            const actual = native.bindings.find(row => row.binding === binding.binding);
            assert(actual, `Missing binding ${binding.binding}`);
            assert.equal(actual.resource, identity.get(underlying), `Binding ${binding.binding} owner changed`);
            assert.equal(actual.role, roles.get(expectedResources.get(underlying).label));
            if (backend === 'dawn' && expected.kind === 'view') {
                assert.equal(resources.get(actual.view)?.role, 'texture-view');
                assert.equal(resources.get(actual.view).destroyed, false);
                if (viewIdentity.has(expected.id)) assert.equal(actual.view, viewIdentity.get(expected.id));
                else {
                    assert(![...viewIdentity.values()].includes(actual.view), 'Distinct browser views collapsed');
                    viewIdentity.set(expected.id, actual.view);
                }
            }
        }
        const color = pipeline.fragment.targets[0];
        // Both PALs use their actual unorm target channel order; bytes in the
        // screenshot are normalized by the established capture path.
        assert(['rgba8unorm', 'bgra8unorm'].includes(native.colorFormat));
        if (backend === 'sdl_gpu') {
            // The existing SDL default pass uses a depth-only attachment.
            // This source performs no stencil operations; retain its depth
            // compare/write contract and report the actual native format.
            assert.equal(pipeline.depthStencil.format, 'depth24plus-stencil8');
            assert(['depth32float', 'depth24plus'].includes(native.depthFormat));
        } else assert.equal(native.depthFormat, pipeline.depthStencil.format);
        assert.equal(native.depthCompare, pipeline.depthStencil.depthCompare);
        assert.equal(native.depthWrite, pipeline.depthStencil.depthWriteEnabled);
        for (const name of ['topology', 'cullMode', 'frontFace']) assert.equal(native[name], pipeline.primitive[name]);
        assert.equal(native.samples, pipeline.multisample.count);
        assert.equal(native.sampleMask, pipeline.multisample.mask ?? 0xffffffff);
        assert.equal(native.alphaToCoverage, pipeline.multisample.alphaToCoverageEnabled ?? false);
        assert.equal(native.blendEnabled, !!color.blend);
        if (color.blend) {
            for (const part of ['color', 'alpha']) {
                for (const [suffix, property] of [['SrcFactor', 'srcFactor'], ['DstFactor', 'dstFactor'], ['Operation', 'operation']])
                    assert.equal(native[part + suffix], color.blend[part][property]);
            }
        }
        assert.deepEqual(native.vertexConstants, constants(pipeline.vertex.constants));
        assert.deepEqual(native.fragmentConstants, constants(pipeline.fragment.constants));
        const uniform = resources.get(native.bindings.find(binding => binding.role === 'uniform').resource);
        if (backend === 'sdl_gpu') assert.deepEqual(native.pushedUniformBytes, uniform.uploadedBytes,
            'SDL draw did not push the actual data-owned group uniform bytes');
        else assert.deepEqual(native.pushedUniformBytes, []);
    });
    return { resources: summaries, draws: gpu.draws };
}

const settings = adHocCaptureEnvironment();
const frame = Number(settings.BBLITE_SCREENSHOT_FRAME);
const input = [...Array(20).fill('-'), '+UiMouseLeft@640:360',
    ...Array.from({ length: 12 }, (_, i) => `UiMove@${650 + i * 10}:360`), '-UiMouseLeft@760:360',
    '+KeyW', ...Array(12).fill('-'), '-KeyW'];
const phases = [{ name: 'canonical', frame }, { name: 'idle', frame: frame * 2 },
    { name: 'input', frame, replay: input },
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
        const capture = json(stem + '.json');
        const resized = phase.name === 'resize';
        assert.deepEqual(capture.viewport, resized ? { width: 960, height: 600 } : { width: 1280, height: 720 });
        imageSize(stem + '.png', capture.viewport);
        const expected = resized ? browser.resize : browser.first;
        const receipts = verifyReceipts(capture, expected.observation, backend);
        const image = join(reference, resized ? 'resize.png' : 'reference.png');
        const full = compareImages(stem + '.png', image);
        const foreground = compareRegion(stem + '.png', image, [9, 11, 18], 30);
        assert(full.mad < .5 && foreground.mad < .5, `${backend}/${phase.name} exceeds strict image MAD: ${full.mad}/${foreground.mad}`);
        captures.push({ phase: phase.name, frame: capture.frame, buildStamp: capture.buildStamp,
            image: stem + '.png', camera: capture.camera, viewport: capture.viewport, ...receipts, full, foreground });
    }
    for (const current of captures.slice(1, 3)) {
        assert.deepEqual(current.camera, captures[0].camera, 'Unattached camera moved');
        assert.deepEqual(current.resources, captures[0].resources, 'Idle/input added GPU writes or changed bytes');
        assert.deepEqual(current.draws, captures[0].draws, 'Idle/input changed bound resources');
        assert.equal(compareImages(current.image, captures[0].image).mad, 0);
    }
    results.push({ backend, captures });
}
writeFileSync(join(output, 'verification.json'), JSON.stringify({ reference, metadata, results }, null, 2) + '\n');
console.log(JSON.stringify(results.map(({ backend, captures }) => ({ backend, captures: captures.map(({ phase, full, foreground, resources }) => ({
    phase, fullMad: full.mad, foregroundMad: foreground.mad, observedResources: resources.length,
})) })), null, 2));
