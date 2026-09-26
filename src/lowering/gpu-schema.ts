import {
    arrayOf as array,
    recordOf as record,
    optionalOf as optional,
    recordScalars,
} from "./record-shapes.js";
/** WebGPU declarations shared by pinned record families at the platform boundary. */
import type {
    MemberSpec,
    RecordShape,
    RecordSpec,
} from "./pinned-record-lowerer.js";
const { number, string, void: none } = recordScalars;
const buffer: RecordShape = { kind: "buffer" };
const gpuObject: RecordShape = {
    kind: "native",
    cpp: "bbl::GpuHandle",
    nullable: true,
};
const fn = (
    parameters: readonly RecordShape[],
    result: RecordShape,
): RecordShape => ({ kind: "function", parameters, result });
const method = (shape: RecordShape, native: string): MemberSpec => ({
    shape,
    access: (owner) => `${owner}->${native}`,
});
const members = (
    entries: readonly (readonly [string, MemberSpec])[],
): ReadonlyMap<string, MemberSpec> => new Map(entries);
const field = (shape: RecordShape, name?: string): MemberSpec =>
    name === undefined ? { shape } : { shape, field: name };
const descriptor = (
    pinned: string,
    cpp: string,
    entries: readonly (readonly [string, MemberSpec])[],
): RecordSpec => ({
    pinned: [pinned],
    cpp,
    reference: false,
    native: true,
    members: members(entries),
});
const encoder = (pinned: string): RecordSpec => ({
    pinned: [pinned],
    cpp: "GpuEncoder",
    handle: "GpuEncoderHandle",
    reference: true,
    native: true,
    members: members([
        ["setPipeline", method(fn([gpuObject], none), "set_pipeline")],
        [
            "setVertexBuffer",
            method(
                fn([number, record("GPUBuffer")], none),
                "set_vertex_buffer",
            ),
        ],
        [
            "setBindGroup",
            method(fn([number, gpuObject], none), "set_bind_group"),
        ],
        ["draw", method(fn([number, number, number, number], none), "draw")],
        ["finish", method(fn([], gpuObject), "finish")],
        [
            "executeBundles",
            method(fn([array(gpuObject)], none), "execute_bundles"),
        ],
        ["end", method(fn([], none), "end")],
    ]),
});

export const gpuRecords: readonly RecordSpec[] = [
    // WebGPU objects: one backend handle each, compared by identity.
    {
        pinned: ["GPUBuffer"],
        cpp: "GpuObject",
        handle: "GpuHandle",
        reference: true,
        native: true,
        members: members([
            ["size", { shape: number, access: (owner) => `${owner}->size` }],
            ["destroy", method(fn([], none), "destroy")],
        ]),
    },
    {
        pinned: ["GPUTexture"],
        cpp: "GpuObject",
        handle: "GpuHandle",
        reference: true,
        native: true,
        members: members([
            ["destroy", method(fn([], none), "destroy")],
            ["createView", method(fn([], gpuObject), "create_view")],
        ]),
    },
    {
        pinned: ["GPUDevice"],
        cpp: "GpuDevice",
        handle: "GpuDeviceHandle",
        reference: true,
        native: true,
        members: members([
            [
                "createBuffer",
                method(
                    fn([record("GPUBufferDescriptor")], record("GPUBuffer")),
                    "create_buffer",
                ),
            ],
            [
                "createTexture",
                method(
                    fn([record("GPUTextureDescriptor")], record("GPUTexture")),
                    "create_texture",
                ),
            ],
            [
                "createBindGroup",
                method(
                    fn([record("GPUBindGroupDescriptor")], gpuObject),
                    "create_bind_group",
                ),
            ],
            [
                "createRenderBundleEncoder",
                method(
                    fn(
                        [record("GPURenderBundleEncoderDescriptor")],
                        record("GPURenderBundleEncoder"),
                    ),
                    "create_render_bundle_encoder",
                ),
            ],
            // The queue is the device's own.
            ["queue", { shape: record("GPUQueue"), access: (owner) => owner }],
        ]),
    },
    {
        pinned: ["GPUQueue"],
        cpp: "GpuDevice",
        handle: "GpuDeviceHandle",
        reference: true,
        native: true,
        members: members([
            [
                "writeBuffer",
                method(
                    fn(
                        [record("GPUBuffer"), number, buffer, number, number],
                        none,
                    ),
                    "write_buffer",
                ),
            ],
            [
                "writeTexture",
                method(
                    fn(
                        [
                            record("GPUTexelCopyTextureInfo"),
                            buffer,
                            record("GPUTexelCopyBufferLayout"),
                            record("GPUExtent3DDict"),
                        ],
                        none,
                    ),
                    "write_texture",
                ),
            ],
        ]),
    },
    encoder("GPURenderPassEncoder"),
    encoder("GPURenderBundleEncoder"),
    {
        pinned: ["GPUCommandEncoder"],
        cpp: "GpuCommandEncoder",
        handle: "GpuCommandEncoderHandle",
        reference: true,
        native: true,
        members: members([
            [
                "beginRenderPass",
                method(
                    fn(
                        [record("GPURenderPassDescriptor")],
                        record("GPURenderPassEncoder"),
                    ),
                    "begin_render_pass",
                ),
            ],
        ]),
    },
    // Descriptors.
    descriptor("GPUBufferDescriptor", "GpuBufferDescriptor", [
        ["label", field(optional(string))],
        ["size", field(number)],
        ["usage", field(number)],
    ]),
    descriptor("GPUTextureDescriptor", "GpuTextureDescriptor", [
        ["label", field(optional(string))],
        ["format", field(string)],
        ["size", field(record("GPUExtent3DDict"))],
        ["usage", field(number)],
    ]),
    descriptor("GPUExtent3DDict", "GpuExtent3D", [
        ["width", field(number)],
        ["height", field(number)],
        ["depthOrArrayLayers", field(number)],
    ]),
    descriptor("GPUBindGroupDescriptor", "GpuBindGroupDescriptor", [
        ["label", field(optional(string))],
        ["layout", field(gpuObject)],
        ["entries", field(array(record("GPUBindGroupEntry")))],
    ]),
    descriptor("GPUBindGroupEntry", "GpuBindGroupEntry", [
        ["binding", field(number)],
        [
            "resource",
            // GPUBindingResource: a buffer binding, or a view or sampler.
            field({
                kind: "variant",
                members: [record("GPUBufferBinding"), gpuObject],
            }),
        ],
    ]),
    descriptor("GPUBufferBinding", "GpuBufferBinding", [
        ["buffer", field(record("GPUBuffer"))],
        ["offset", field(optional(number))],
        ["size", field(optional(number))],
    ]),
    descriptor("GPUTexelCopyTextureInfo", "GpuTexelCopyTextureInfo", [
        ["texture", field(record("GPUTexture"))],
    ]),
    descriptor("GPUTexelCopyBufferLayout", "GpuTexelCopyBufferLayout", [
        ["offset", field(optional(number))],
        ["bytesPerRow", field(optional(number))],
        ["rowsPerImage", field(optional(number))],
    ]),
    descriptor(
        "GPURenderBundleEncoderDescriptor",
        "GpuRenderBundleEncoderDescriptor",
        [
            ["colorFormats", field(array(string))],
            ["sampleCount", field(optional(number))],
        ],
    ),
    descriptor("GPURenderPassDescriptor", "GpuRenderPassDescriptor", [
        [
            "colorAttachments",
            field(array(record("GPURenderPassColorAttachment"))),
        ],
    ]),
    descriptor("GPURenderPassColorAttachment", "GpuRenderPassColorAttachment", [
        ["view", field(gpuObject)],
        // GPUColor: this path passes the dictionary form.
        ["clearValue", field(optional(record("GPUColorDict")))],
        ["loadOp", field(string)],
        ["storeOp", field(string)],
    ]),
    descriptor("GPUColorDict", "Color4d", [
        ["r", field(number)],
        ["g", field(number)],
        ["b", field(number)],
        ["a", field(number)],
    ]),
];
