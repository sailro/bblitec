// Scene 275: the native text GPU receipts against the browser's WebGPU
// receipts (checks/plugins/gpu-receipts.init.js): every text allocation
// of each role with the bytes the browser uploaded (a contiguous prefix;
// unused allocation tails are excluded), the write count/order/ranges,
// the two draws' bindings, pipeline state, blend, constants, and the
// pushed uniform bytes on SDL. The idle and input observations must
// equal the first (the pinned camera is unattached); the resized
// observation is the reference for the resized native phase.
import assert from "node:assert/strict";
import { compareImages } from "../../dist/src/parity.js";
import { assertObservationProvenance, loadPng, observedImage, observedStep, requireObservations, sha256 } from "./support.mjs";

const ROLES = new Map([
    ["text-quad-corners", "quad"], ["text-renderable-ubo", "uniform"],
    ["text-instance", "instances"], ["text-styles", "styles"],
    ["text-glyph-metadata", "metadata"], ["text-slug-curves", "curves"], ["text-slug-bands", "bands"],
]);
const constants = (value) => Object.entries(value ?? {}).map(([id, number]) => ({ id: Number(id), value: number })).sort((a, b) => a.id - b.id);

function verifyReceipts(capture, observed, backend, where) {
    const gpu = capture.textGpu;
    assert(gpu, `${where}: missing actual text GPU operation receipts`);
    assert.equal(gpu.frame, capture.frame, `${where}: text draw receipt belongs to a different frame`);
    const resources = new Map(gpu.resources.map((resource) => [resource.id, resource]));
    assert.equal(resources.size, gpu.resources.length, `${where}: resource IDs were reused`);
    const expectedResources = new Map(observed.resources.map((resource) => [resource.id, resource]));
    const identity = new Map();
    const summaries = [];
    for (const [label, role] of ROLES) {
        const expected = observed.resources.filter((resource) => resource.label === label);
        const actual = gpu.resources.filter((resource) => resource.role === role || (role === "uniform" && resource.role === "uniform-shadow"));
        assert.equal(actual.length, expected.length, `${where}: ${role} allocation count`);
        expected.forEach((resource, index) => {
            const native = actual[index];
            identity.set(resource.id, native.id);
            assert.equal(native.destroyed, false, `${where}: ${role} destroyed while still in use`);
            const texture = resource.kind === "texture";
            const size = texture ? resource.size.width * resource.size.height * 16 : resource.size;
            assert.equal(native.allocationBytes, size, `${where}: ${role} allocation size`);
            assert.equal(native.width, texture ? resource.size.width : 0);
            assert.equal(native.rows, texture ? resource.size.height : 0);
            const writes = observed.writes.filter((write) => write.id === resource.id);
            assert(writes.length, `${where}: browser did not observe ${label} uploads`);
            const bytes = Buffer.alloc(size);
            let used = 0;
            for (const write of writes) {
                assert(write.bytes, `${where}: a ${label} upload was too large to record`);
                Buffer.from(write.bytes).copy(bytes, write.offset);
                used = Math.max(used, write.offset + write.bytes.length);
            }
            assert.deepEqual(native.writtenRanges, [{ offset: 0, bytes: used }], `${where}: ${role} observed ranges`);
            assert.deepEqual(Buffer.from(native.uploadedBytes), bytes.subarray(0, used), `${where}: ${role}[${index}] uploaded bytes`);
            assert.deepEqual(native.writes.map((write) => ({ offset: write.offset, bytes: write.bytes })),
                writes.map((write) => ({ offset: write.offset, bytes: write.bytes.length })), `${where}: ${role}[${index}] write count/order/ranges`);
            summaries.push({ role: native.role, id: native.id, allocationBytes: size, uploadedBytes: used, sha256: sha256(bytes.subarray(0, used)), writes: native.writes });
        });
    }
    const draws = observed.draws.slice(-2);
    assert.equal(gpu.draws.length, draws.length, `${where}: draw count`);
    const groupIdentity = new Map(), pipelineIdentity = new Map(), viewIdentity = new Map();
    draws.forEach((draw, index) => {
        const native = gpu.draws[index];
        const pipeline = observed.pipelines.find((row) => row.id === draw.pipeline);
        const group = observed.groups.find((row) => row.id === draw.groups[0]);
        assert(pipeline && group, `${where}: browser draw lacks its pipeline or group`);
        for (const [map, sourceId, nativeId, role] of [
            [groupIdentity, group.id, native.group, backend === "dawn" ? "bind-group" : "binding-set"],
            [pipelineIdentity, pipeline.id, native.pipeline, "pipeline"],
        ]) {
            if (map.has(sourceId)) assert.equal(nativeId, map.get(sourceId), `${where}: shared source binding identity was lost`);
            else { assert(![...map.values()].includes(nativeId), `${where}: distinct source binding identities collapsed`); map.set(sourceId, nativeId); }
            assert.equal(resources.get(nativeId)?.role, role, `${where}: draw refers to the wrong resource kind`);
            assert.equal(resources.get(nativeId).destroyed, false, `${where}: draw refers to a retired resource`);
        }
        assert.equal(native.quad, identity.get(draw.vertices[0].buffer), `${where}: quad binding`);
        assert.equal(native.instances, identity.get(draw.vertices[1].buffer), `${where}: instances binding`);
        assert.deepEqual([native.vertices, native.instanceCount, native.firstVertex, native.firstInstance], draw.args, `${where}: draw arguments`);
        assert.equal(native.bindings.length, group.entries.length, `${where}: binding count`);
        for (const binding of group.entries) {
            const expected = expectedResources.get(binding.resource);
            const underlying = expected.kind === "view" ? expected.texture : expected.id;
            const actual = native.bindings.find((row) => row.binding === binding.binding);
            assert(actual, `${where}: missing binding ${binding.binding}`);
            assert.equal(actual.resource, identity.get(underlying), `${where}: binding ${binding.binding} owner changed`);
            assert.equal(actual.role, ROLES.get(expectedResources.get(underlying).label), `${where}: binding ${binding.binding} role`);
            if (backend === "dawn" && expected.kind === "view") {
                assert.equal(resources.get(actual.view)?.role, "texture-view");
                assert.equal(resources.get(actual.view).destroyed, false);
                if (viewIdentity.has(expected.id)) assert.equal(actual.view, viewIdentity.get(expected.id));
                else {
                    assert(![...viewIdentity.values()].includes(actual.view), `${where}: distinct browser views collapsed`);
                    viewIdentity.set(expected.id, actual.view);
                }
            }
        }
        const color = pipeline.fragment.targets[0];
        // Both PALs use their actual unorm target channel order; the
        // screenshot bytes are normalized by the established capture path.
        assert(["rgba8unorm", "bgra8unorm"].includes(native.colorFormat), `${where}: color format`);
        if (backend === "sdl_gpu") {
            // The SDL default pass uses a depth-only attachment. The source
            // performs no stencil operations; its depth compare/write
            // contract holds and the actual native format is reported.
            assert.equal(pipeline.depthStencil.format, "depth24plus-stencil8");
            assert(["depth32float", "depth24plus"].includes(native.depthFormat), `${where}: depth format`);
        } else assert.equal(native.depthFormat, pipeline.depthStencil.format, `${where}: depth format`);
        assert.equal(native.depthCompare, pipeline.depthStencil.depthCompare);
        assert.equal(native.depthWrite, pipeline.depthStencil.depthWriteEnabled);
        for (const name of ["topology", "cullMode", "frontFace"]) assert.equal(native[name], pipeline.primitive[name], `${where}: ${name}`);
        assert.equal(native.samples, pipeline.multisample.count);
        assert.equal(native.sampleMask, pipeline.multisample.mask ?? 0xffffffff);
        assert.equal(native.alphaToCoverage, pipeline.multisample.alphaToCoverageEnabled ?? false);
        assert.equal(native.blendEnabled, !!color.blend);
        if (color.blend) {
            for (const part of ["color", "alpha"]) {
                for (const [suffix, property] of [["SrcFactor", "srcFactor"], ["DstFactor", "dstFactor"], ["Operation", "operation"]])
                    assert.equal(native[part + suffix], color.blend[part][property], `${where}: ${part}${suffix}`);
            }
        }
        assert.deepEqual(native.vertexConstants, constants(pipeline.vertex.constants), `${where}: vertex constants`);
        assert.deepEqual(native.fragmentConstants, constants(pipeline.fragment.constants), `${where}: fragment constants`);
        const uniform = resources.get(native.bindings.find((binding) => binding.role === "uniform").resource);
        if (backend === "sdl_gpu") assert.deepEqual(native.pushedUniformBytes, uniform.uploadedBytes, `${where}: SDL draw did not push the actual data-owned group uniform bytes`);
        else assert.deepEqual(native.pushedUniformBytes, [], `${where}: Dawn pushes no uniform bytes`);
    });
    return { resources: summaries, draws: gpu.draws };
}

export function check(context) {
    const observations = requireObservations(context);
    assertObservationProvenance(context, observations);
    const first = observedStep(observations, "first");
    const idle = observedStep(observations, "idle");
    const input = observedStep(observations, "input");
    const resize = observedStep(observations, "resize");
    assert.equal(idle.state.writes.length, first.state.writes.length, "the browser kept writing while idle");
    assert.deepEqual(input.state.writes, first.state.writes, "browser input added GPU writes");
    assert.equal(compareImages(observedImage(context, input.image), observedImage(context, first.image)).mad, 0, "the pinned unattached camera responded to browser input");
    const resized = loadPng(observedImage(context, resize.image));
    assert.deepEqual({ width: resized.width, height: resized.height }, { width: 960, height: 600 }, "the resized browser observation");
    const details = {};
    for (const backend of context.backends) {
        const captures = [];
        for (const phase of Object.values(context.results[backend])) {
            const where = `${backend}/${phase.id}`;
            const expected = phase.id === "resize" ? resize.state : first.state;
            captures.push({ id: phase.id, ...verifyReceipts(phase.capture, expected, backend, where) });
        }
        const canonical = captures.find((capture) => capture.id === "canonical");
        for (const current of captures.filter((capture) => capture.id === "idle" || capture.id === "input")) {
            assert.deepEqual(current.resources, canonical.resources, `${backend}/${current.id}: idle/input added GPU writes or changed bytes`);
            assert.deepEqual(current.draws, canonical.draws, `${backend}/${current.id}: idle/input changed bound resources`);
        }
        details[backend] = captures.map(({ id, resources }) => ({ phase: id, observedResources: resources.length }));
    }
    return { details };
}
