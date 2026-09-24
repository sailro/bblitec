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
import {
    assertObservationProvenance,
    loadPng,
    observedImage,
    observedStep,
    requireObservations,
    sha256,
} from "./support.mjs";

/**
 * @import { PluginContext } from "../../dist/src/tooling/check-run.js"
 * @import { ObservedStep } from "./support.mjs"
 */

/**
 * @typedef {{ width: number, height: number }} Extent
 * @typedef {{ offset: number, bytes: number }} ByteRange
 * @typedef {{
 *     id: number,
 *     role: string,
 *     allocationBytes: number,
 *     width: number,
 *     rows: number,
 *     destroyed: boolean,
 *     uploadedBytes: number[],
 *     writtenRanges: ByteRange[],
 *     writes: ByteRange[],
 * }} NativeResource
 * @typedef {{ id: number, value: number }} NativeConstant
 * @typedef {{ binding: number, role: string, resource: number, view: number }} NativeBinding
 * @typedef {{
 *     pipeline: number,
 *     group: number,
 *     quad: number,
 *     instances: number,
 *     colorFormat: string,
 *     depthFormat: string,
 *     depthCompare: string,
 *     depthWrite: boolean,
 *     topology: string,
 *     cullMode: string,
 *     frontFace: string,
 *     samples: number,
 *     sampleMask: number,
 *     blendEnabled: boolean,
 *     alphaToCoverage: boolean,
 *     colorSrcFactor: string,
 *     colorDstFactor: string,
 *     colorOperation: string,
 *     alphaSrcFactor: string,
 *     alphaDstFactor: string,
 *     alphaOperation: string,
 *     vertexConstants: NativeConstant[],
 *     fragmentConstants: NativeConstant[],
 *     bindings: NativeBinding[],
 *     vertices: number,
 *     instanceCount: number,
 *     firstVertex: number,
 *     firstInstance: number,
 *     pushedUniformBytes: number[],
 * }} NativeDraw
 * @typedef {{
 *     frame: number,
 *     textGpu?: { frame: number, resources: NativeResource[], draws: NativeDraw[] },
 * }} NativeCapture the fields read from a phase's render capture
 * @typedef {{ id: number, kind: "buffer", label: string, size: number }} ObservedBuffer
 * @typedef {{ id: number, kind: "texture", label: string, size: Extent }} ObservedTexture
 * @typedef {{ id: number, kind: "view", label: string, texture: number }} ObservedView
 * @typedef {{ id: number, kind: "sampler", label: string }} ObservedSampler
 * @typedef {{
 *     id: number,
 *     offset?: number,
 *     layout?: { offset: number },
 *     bytes: number[] | null,
 * }} ObservedWrite a buffer write carries `offset`, a texture write its data layout; `bytes` is null past 1 MiB
 * @typedef {{ srcFactor?: string, dstFactor?: string, operation?: string }} BlendComponent
 * @typedef {{
 *     id: number,
 *     vertex: { constants: Record<string, number> },
 *     fragment: {
 *         constants: Record<string, number>,
 *         targets: Array<{ blend?: { color: BlendComponent, alpha: BlendComponent } } | null>,
 *     } | null,
 *     depthStencil: { format: string, depthCompare?: string, depthWriteEnabled?: boolean } | null,
 *     primitive: { topology?: string, cullMode?: string, frontFace?: string },
 *     multisample: { count?: number, mask?: number, alphaToCoverageEnabled?: boolean },
 * }} ObservedPipeline
 * @typedef {{
 *     resources: Array<ObservedBuffer | ObservedTexture | ObservedView | ObservedSampler>,
 *     writes: ObservedWrite[],
 *     pipelines: ObservedPipeline[],
 *     groups: Array<{ id: number, entries: Array<{ binding: number, resource: number }> }>,
 *     draws: Array<{
 *         pipeline: number | null,
 *         groups: Array<number | null>,
 *         vertices: Array<{ buffer: number } | null>,
 *         args: number[],
 *     }>,
 * }} Receipts the init script's `window.__gpuReceipts` record
 * @typedef {{
 *     role: string,
 *     id: number,
 *     allocationBytes: number,
 *     uploadedBytes: number,
 *     sha256: string,
 *     writes: ByteRange[],
 * }} ResourceSummary
 * @typedef {{ resources: ResourceSummary[], draws: NativeDraw[] }} ReceiptSummary
 */

const ROLES = new Map([
    ["text-quad-corners", "quad"],
    ["text-renderable-ubo", "uniform"],
    ["text-instance", "instances"],
    ["text-styles", "styles"],
    ["text-glyph-metadata", "metadata"],
    ["text-slug-curves", "curves"],
    ["text-slug-bands", "bands"],
]);
/** @param {Record<string, number> | undefined} value */
const constants = (value) =>
    Object.entries(value ?? {})
        .map(([id, number]) => ({ id: Number(id), value: number }))
        .sort((a, b) => a.id - b.id);

/**
 * @param {NativeCapture} capture
 * @param {Receipts} observed
 * @param {string} backend
 * @param {string} where
 * @returns {ReceiptSummary}
 */
function verifyReceipts(capture, observed, backend, where) {
    const gpu = capture.textGpu;
    assert(gpu, `${where}: missing actual text GPU operation receipts`);
    assert.equal(
        gpu.frame,
        capture.frame,
        `${where}: text draw receipt belongs to a different frame`,
    );
    const resources = new Map(
        gpu.resources.map((resource) => [resource.id, resource]),
    );
    assert.equal(
        resources.size,
        gpu.resources.length,
        `${where}: resource IDs were reused`,
    );
    const expectedResources = new Map(
        observed.resources.map((resource) => [resource.id, resource]),
    );
    /** @type {Map<number, number>} */
    const identity = new Map();
    /** @type {ResourceSummary[]} */
    const summaries = [];
    for (const [label, role] of ROLES) {
        const expected = observed.resources.filter(
            (resource) => resource.label === label,
        );
        /** @type {NativeResource[]} */
        const actual = gpu.resources.filter(
            (resource) =>
                resource.role === role ||
                (role === "uniform" && resource.role === "uniform-shadow"),
        );
        assert.equal(
            actual.length,
            expected.length,
            `${where}: ${role} allocation count`,
        );
        expected.forEach((resource, index) => {
            const native = actual[index];
            assert(native);
            identity.set(resource.id, native.id);
            assert.equal(
                native.destroyed,
                false,
                `${where}: ${role} destroyed while still in use`,
            );
            assert(
                resource.kind === "buffer" || resource.kind === "texture",
                `${where}: ${label} is a ${resource.kind}, not an allocation`,
            );
            const texture = resource.kind === "texture";
            const size = texture
                ? resource.size.width * resource.size.height * 16
                : resource.size;
            assert.equal(
                native.allocationBytes,
                size,
                `${where}: ${role} allocation size`,
            );
            assert.equal(native.width, texture ? resource.size.width : 0);
            assert.equal(native.rows, texture ? resource.size.height : 0);
            const writes = observed.writes.filter(
                (write) => write.id === resource.id,
            );
            assert(
                writes.length,
                `${where}: browser did not observe ${label} uploads`,
            );
            const bytes = Buffer.alloc(size);
            let used = 0;
            for (const write of writes) {
                assert(
                    write.bytes,
                    `${where}: a ${label} upload was too large to record`,
                );
                // A buffer write carries `offset`; a texture write carries its data layout's.
                const offset = write.offset ?? write.layout?.offset ?? 0;
                Buffer.from(write.bytes).copy(bytes, offset);
                used = Math.max(used, offset + write.bytes.length);
            }
            assert.deepEqual(
                native.writtenRanges,
                [{ offset: 0, bytes: used }],
                `${where}: ${role} observed ranges`,
            );
            assert.deepEqual(
                Buffer.from(native.uploadedBytes),
                bytes.subarray(0, used),
                `${where}: ${role}[${index}] uploaded bytes`,
            );
            assert.deepEqual(
                native.writes.map((write) => ({
                    offset: write.offset,
                    bytes: write.bytes,
                })),
                writes.map((write) => {
                    assert(write.bytes);
                    return {
                        offset: write.offset ?? write.layout?.offset ?? 0,
                        bytes: write.bytes.length,
                    };
                }),
                `${where}: ${role}[${index}] write count/order/ranges`,
            );
            summaries.push({
                role: native.role,
                id: native.id,
                allocationBytes: size,
                uploadedBytes: used,
                sha256: sha256(bytes.subarray(0, used)),
                writes: native.writes,
            });
        });
    }
    const draws = observed.draws.slice(-2);
    assert.equal(gpu.draws.length, draws.length, `${where}: draw count`);
    /** @type {Map<number, number>} */
    const groupIdentity = new Map();
    /** @type {Map<number, number>} */
    const pipelineIdentity = new Map();
    /** @type {Map<number, number>} */
    const viewIdentity = new Map();
    draws.forEach((draw, index) => {
        const native = gpu.draws[index];
        assert(native);
        const pipeline = observed.pipelines.find(
            (row) => row.id === draw.pipeline,
        );
        const group = observed.groups.find((row) => row.id === draw.groups[0]);
        assert(
            pipeline && group,
            `${where}: browser draw lacks its pipeline or group`,
        );
        for (const [map, sourceId, nativeId, role] of /** @type {const} */ ([
            [
                groupIdentity,
                group.id,
                native.group,
                backend === "dawn" ? "bind-group" : "binding-set",
            ],
            [pipelineIdentity, pipeline.id, native.pipeline, "pipeline"],
        ])) {
            if (map.has(sourceId))
                assert.equal(
                    nativeId,
                    map.get(sourceId),
                    `${where}: shared source binding identity was lost`,
                );
            else {
                assert(
                    ![...map.values()].includes(nativeId),
                    `${where}: distinct source binding identities collapsed`,
                );
                map.set(sourceId, nativeId);
            }
            assert.equal(
                resources.get(nativeId)?.role,
                role,
                `${where}: draw refers to the wrong resource kind`,
            );
            assert.equal(
                resources.get(nativeId)?.destroyed,
                false,
                `${where}: draw refers to a retired resource`,
            );
        }
        const quad = draw.vertices[0];
        assert(quad, `${where}: the browser draw binds no quad buffer`);
        assert.equal(
            native.quad,
            identity.get(quad.buffer),
            `${where}: quad binding`,
        );
        const instances = draw.vertices[1];
        assert(
            instances,
            `${where}: the browser draw binds no instance buffer`,
        );
        assert.equal(
            native.instances,
            identity.get(instances.buffer),
            `${where}: instances binding`,
        );
        assert.deepEqual(
            [
                native.vertices,
                native.instanceCount,
                native.firstVertex,
                native.firstInstance,
            ],
            draw.args,
            `${where}: draw arguments`,
        );
        assert.equal(
            native.bindings.length,
            group.entries.length,
            `${where}: binding count`,
        );
        for (const binding of group.entries) {
            const expected = expectedResources.get(binding.resource);
            assert(
                expected,
                `${where}: binding ${binding.binding} names no browser resource`,
            );
            const underlying =
                expected.kind === "view" ? expected.texture : expected.id;
            /** @type {NativeBinding | undefined} */
            const actual = native.bindings.find(
                (row) => row.binding === binding.binding,
            );
            assert(actual, `${where}: missing binding ${binding.binding}`);
            assert.equal(
                actual.resource,
                identity.get(underlying),
                `${where}: binding ${binding.binding} owner changed`,
            );
            const owner = expectedResources.get(underlying);
            assert(
                owner,
                `${where}: binding ${binding.binding} views no browser resource`,
            );
            assert.equal(
                actual.role,
                ROLES.get(owner.label),
                `${where}: binding ${binding.binding} role`,
            );
            if (backend === "dawn" && expected.kind === "view") {
                assert.equal(resources.get(actual.view)?.role, "texture-view");
                assert.equal(resources.get(actual.view)?.destroyed, false);
                if (viewIdentity.has(expected.id))
                    assert.equal(actual.view, viewIdentity.get(expected.id));
                else {
                    assert(
                        ![...viewIdentity.values()].includes(actual.view),
                        `${where}: distinct browser views collapsed`,
                    );
                    viewIdentity.set(expected.id, actual.view);
                }
            }
        }
        const fragment = pipeline.fragment;
        assert(
            fragment,
            `${where}: the browser pipeline has no fragment stage`,
        );
        const color = fragment.targets[0];
        // Both PALs use their actual unorm target channel order; the
        // screenshot bytes are normalized by the established capture path.
        assert(
            ["rgba8unorm", "bgra8unorm"].includes(native.colorFormat),
            `${where}: color format`,
        );
        assert(
            pipeline.depthStencil,
            `${where}: the browser pipeline has no depth-stencil state`,
        );
        if (backend === "sdl_gpu") {
            // The SDL default pass uses a depth-only attachment. The source
            // performs no stencil operations; its depth compare/write
            // contract holds and the actual native format is reported.
            assert.equal(pipeline.depthStencil.format, "depth24plus-stencil8");
            assert(
                ["depth32float", "depth24plus"].includes(native.depthFormat),
                `${where}: depth format`,
            );
        } else
            assert.equal(
                native.depthFormat,
                pipeline.depthStencil.format,
                `${where}: depth format`,
            );
        assert.equal(native.depthCompare, pipeline.depthStencil.depthCompare);
        assert.equal(
            native.depthWrite,
            pipeline.depthStencil.depthWriteEnabled,
        );
        for (const name of /** @type {const} */ ([
            "topology",
            "cullMode",
            "frontFace",
        ]))
            assert.equal(
                native[name],
                pipeline.primitive[name],
                `${where}: ${name}`,
            );
        assert.equal(native.samples, pipeline.multisample.count);
        assert.equal(
            native.sampleMask,
            pipeline.multisample.mask ?? 0xffffffff,
        );
        assert.equal(
            native.alphaToCoverage,
            pipeline.multisample.alphaToCoverageEnabled ?? false,
        );
        assert(color, `${where}: the browser pipeline has no colour target`);
        assert.equal(native.blendEnabled, !!color.blend);
        if (color.blend) {
            for (const part of /** @type {const} */ (["color", "alpha"])) {
                for (const [suffix, property] of /** @type {const} */ ([
                    ["SrcFactor", "srcFactor"],
                    ["DstFactor", "dstFactor"],
                    ["Operation", "operation"],
                ]))
                    assert.equal(
                        native[/** @type {const} */ (`${part}${suffix}`)],
                        color.blend[part][property],
                        `${where}: ${part}${suffix}`,
                    );
            }
        }
        assert.deepEqual(
            native.vertexConstants,
            constants(pipeline.vertex.constants),
            `${where}: vertex constants`,
        );
        assert.deepEqual(
            native.fragmentConstants,
            constants(fragment.constants),
            `${where}: fragment constants`,
        );
        const uniformBinding = native.bindings.find(
            (binding) => binding.role === "uniform",
        );
        assert(uniformBinding, `${where}: the draw binds no uniform`);
        const uniform = resources.get(uniformBinding.resource);
        if (backend === "sdl_gpu")
            assert.deepEqual(
                native.pushedUniformBytes,
                uniform?.uploadedBytes,
                `${where}: SDL draw did not push the actual data-owned group uniform bytes`,
            );
        else
            assert.deepEqual(
                native.pushedUniformBytes,
                [],
                `${where}: Dawn pushes no uniform bytes`,
            );
    });
    return { resources: summaries, draws: gpu.draws };
}

/**
 * @param {ObservedStep} step
 * @returns {Receipts}
 */
function observedReceipts(step) {
    assert(step.state, `the observed step '${step.id}' recorded no receipts`);
    return /** @type {Receipts} */ (step.state);
}

/** @param {PluginContext} context */
export function check(context) {
    const observations = requireObservations(context);
    assertObservationProvenance(context, observations);
    const first = observedStep(observations, "first");
    const idle = observedStep(observations, "idle");
    const input = observedStep(observations, "input");
    const resize = observedStep(observations, "resize");
    assert.equal(
        observedReceipts(idle).writes.length,
        observedReceipts(first).writes.length,
        "the browser kept writing while idle",
    );
    assert.deepEqual(
        observedReceipts(input).writes,
        observedReceipts(first).writes,
        "browser input added GPU writes",
    );
    assert.equal(
        compareImages(
            observedImage(context, input.image),
            observedImage(context, first.image),
        ).mad,
        0,
        "the pinned unattached camera responded to browser input",
    );
    const resized = loadPng(observedImage(context, resize.image));
    assert.deepEqual(
        { width: resized.width, height: resized.height },
        { width: 960, height: 600 },
        "the resized browser observation",
    );
    /** @type {Record<string, Array<{ phase: string, observedResources: number }>>} */
    const details = {};
    for (const backend of context.backends) {
        const results = context.results[backend];
        assert(results, `${backend}: no phase results`);
        /** @type {Array<{ id: string } & ReceiptSummary>} */
        const captures = [];
        for (const phase of Object.values(results)) {
            const where = `${backend}/${phase.id}`;
            const expected =
                phase.id === "resize"
                    ? observedReceipts(resize)
                    : observedReceipts(first);
            captures.push({
                id: phase.id,
                ...verifyReceipts(
                    /** @type {NativeCapture} */ (phase.capture),
                    expected,
                    backend,
                    where,
                ),
            });
        }
        const canonical = captures.find(
            (capture) => capture.id === "canonical",
        );
        for (const current of captures.filter(
            (capture) => capture.id === "idle" || capture.id === "input",
        )) {
            assert(canonical, `${backend}: no phase 'canonical'`);
            assert.deepEqual(
                current.resources,
                canonical.resources,
                `${backend}/${current.id}: idle/input added GPU writes or changed bytes`,
            );
            assert.deepEqual(
                current.draws,
                canonical.draws,
                `${backend}/${current.id}: idle/input changed bound resources`,
            );
        }
        details[backend] = captures.map(({ id, resources }) => ({
            phase: id,
            observedResources: resources.length,
        }));
    }
    return { details };
}
