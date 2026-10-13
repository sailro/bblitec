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

const boolean: RecordShape = { kind: "boolean" };
const promiseOf = (value: RecordShape): RecordShape => ({
    kind: "promise",
    value,
});
/** A member whose call the port spells over the receiver and arguments. */
const spelled = (
    shape: RecordShape,
    call: (owner: string, args: readonly string[]) => string,
): MemberSpec => ({ shape, access: (owner) => owner, call });
/** An optional trailing argument, absent when the call omits it. */
const or = (args: readonly string[], index: number, absent = "{}"): string =>
    args[index] ?? absent;
const replaced = new Set([
    "GPUBuffer",
    "GPUDevice",
    "GPUQueue",
    "GPURenderPassEncoder",
    "GPUCommandEncoder",
    "GPUBufferDescriptor",
]);

/**
 * The WebGPU subset the pin's compute, indirect and buffer-mapping paths
 * speak (the streamed splat library), over the same device interface:
 * `gpuRecords` with the mapping members of a buffer, the device's layout,
 * module and pipeline creation and limits, the queue's typed and ranged
 * writes and its completion, and the compute and indirect encoders. The
 * text family keeps `gpuRecords`, whose spellings this does not change.
 */
export const gpuSubsetRecords: readonly RecordSpec[] = [
    ...gpuRecords.filter((spec) => !replaced.has(spec.pinned[0]!)),
    {
        pinned: ["GPUBuffer"],
        cpp: "GpuObject",
        handle: "GpuHandle",
        reference: true,
        native: true,
        members: members([
            ["size", { shape: number, access: (owner) => `${owner}->size` }],
            ["destroy", method(fn([], none), "destroy")],
            [
                "getMappedRange",
                spelled(
                    fn([optional(number), optional(number)], buffer),
                    (owner, args) =>
                        `bbl::gpu_buffer_mapping(${owner}).get_mapped_range(${or(args, 0)}, ${or(args, 1)})`,
                ),
            ],
            [
                "unmap",
                spelled(
                    fn([], none),
                    (owner) => `bbl::gpu_buffer_mapping(${owner}).unmap()`,
                ),
            ],
            [
                "mapAsync",
                spelled(
                    fn(
                        [number, optional(number), optional(number)],
                        promiseOf(none),
                    ),
                    (owner, args) =>
                        `bbl::gpu_buffer_mapping(${owner}).map_async(${args[0]}, ${or(args, 1)}, ${or(args, 2)})`,
                ),
            ],
            [
                "mapState",
                {
                    shape: string,
                    access: (owner) =>
                        `bbl::gpu_buffer_mapping(${owner}).map_state()`,
                },
            ],
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
                "limits",
                {
                    shape: record("GPUSupportedLimits"),
                    access: (owner) => `${owner}->limits()`,
                },
            ],
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
                "createBindGroupLayout",
                method(
                    fn([record("GPUBindGroupLayoutDescriptor")], gpuObject),
                    "create_bind_group_layout",
                ),
            ],
            [
                "createShaderModule",
                method(
                    fn([record("GPUShaderModuleDescriptor")], gpuObject),
                    "create_shader_module",
                ),
            ],
            [
                "createPipelineLayout",
                method(
                    fn([record("GPUPipelineLayoutDescriptor")], gpuObject),
                    "create_pipeline_layout",
                ),
            ],
            [
                "createComputePipeline",
                method(
                    fn([record("GPUComputePipelineDescriptor")], gpuObject),
                    "create_compute_pipeline",
                ),
            ],
            [
                "createRenderPipeline",
                method(
                    fn([record("GPURenderPipelineDescriptor")], gpuObject),
                    "create_render_pipeline",
                ),
            ],
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
                // `writeBuffer(buffer, offset, data[, dataOffset, size])`:
                // all of an ArrayBuffer or typed array, or a byte range of
                // an ArrayBuffer.
                "writeBuffer",
                spelled(
                    fn(
                        [
                            record("GPUBuffer"),
                            number,
                            {
                                kind: "variant",
                                members: [
                                    buffer,
                                    { kind: "typed", element: "f32" },
                                    { kind: "typed", element: "u32" },
                                    { kind: "typed", element: "u8" },
                                ],
                            },
                            number,
                            number,
                        ],
                        none,
                    ),
                    (owner, args) =>
                        `bbl::gpu_queue_write_buffer(*${owner}, ${args.join(", ")})`,
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
            [
                "onSubmittedWorkDone",
                method(fn([], promiseOf(none)), "on_submitted_work_done"),
            ],
        ]),
    },
    {
        pinned: ["GPURenderPassEncoder"],
        cpp: "GpuEncoder",
        handle: "GpuEncoderHandle",
        reference: true,
        native: true,
        members: members([
            ["setPipeline", method(fn([gpuObject], none), "set_pipeline")],
            [
                "setBindGroup",
                method(fn([number, gpuObject], none), "set_bind_group"),
            ],
            [
                "drawIndirect",
                method(
                    fn([record("GPUBuffer"), number], none),
                    "draw_indirect",
                ),
            ],
        ]),
    },
    {
        pinned: ["GPUCommandEncoder"],
        cpp: "GpuCommandEncoder",
        handle: "GpuCommandEncoderHandle",
        reference: true,
        native: true,
        members: members([
            [
                "beginComputePass",
                spelled(
                    fn(
                        [optional(record("GPUComputePassDescriptor"))],
                        record("GPUComputePassEncoder"),
                    ),
                    (owner, args) =>
                        `${owner}->begin_compute_pass(${or(args, 0, "bbl::GpuComputePassDescriptor{}")})`,
                ),
            ],
            [
                "copyBufferToBuffer",
                method(
                    fn(
                        [
                            record("GPUBuffer"),
                            number,
                            record("GPUBuffer"),
                            number,
                            number,
                        ],
                        none,
                    ),
                    "copy_buffer_to_buffer",
                ),
            ],
            [
                "clearBuffer",
                spelled(
                    fn(
                        [
                            record("GPUBuffer"),
                            optional(number),
                            optional(number),
                        ],
                        none,
                    ),
                    (owner, args) =>
                        `${owner}->clear_buffer(${args[0]}, ${or(args, 1)}, ${or(args, 2)})`,
                ),
            ],
        ]),
    },
    {
        pinned: ["GPUComputePassEncoder"],
        cpp: "GpuComputePassEncoder",
        handle: "GpuComputePassEncoderHandle",
        reference: true,
        native: true,
        members: members([
            ["setPipeline", method(fn([gpuObject], none), "set_pipeline")],
            [
                "setBindGroup",
                spelled(
                    fn([number, gpuObject, array(number)], none),
                    (owner, args) =>
                        `${owner}->set_bind_group(${args.join(", ")})`,
                ),
            ],
            [
                "dispatchWorkgroups",
                spelled(
                    fn([number, optional(number), optional(number)], none),
                    (owner, args) =>
                        `${owner}->dispatch_workgroups(${args.join(", ")})`,
                ),
            ],
            [
                "dispatchWorkgroupsIndirect",
                method(
                    fn([record("GPUBuffer"), number], none),
                    "dispatch_workgroups_indirect",
                ),
            ],
            ["end", method(fn([], none), "end")],
        ]),
    },
    descriptor("GPUSupportedLimits", "GpuSupportedLimits", [
        ["maxBufferSize", field(number)],
        ["maxStorageBufferBindingSize", field(number)],
        ["maxComputeWorkgroupsPerDimension", field(number)],
    ]),
    descriptor("GPUBufferDescriptor", "GpuBufferDescriptor", [
        ["label", field(optional(string))],
        ["size", field(number)],
        ["usage", field(number)],
        ["mappedAtCreation", field(boolean)],
    ]),
    descriptor("GPUBindGroupLayoutDescriptor", "GpuBindGroupLayoutDescriptor", [
        ["label", field(optional(string))],
        ["entries", field(array(record("GPUBindGroupLayoutEntry")))],
    ]),
    descriptor("GPUBindGroupLayoutEntry", "GpuBindGroupLayoutEntry", [
        ["binding", field(number)],
        ["visibility", field(number)],
        ["buffer", field(optional(record("GPUBufferBindingLayout")))],
        ["texture", field(optional(record("GPUTextureBindingLayout")))],
    ]),
    descriptor("GPUBufferBindingLayout", "GpuBufferBindingLayout", [
        ["type", field(optional(string))],
        ["hasDynamicOffset", field(optional(boolean))],
        ["minBindingSize", field(optional(number))],
    ]),
    descriptor("GPUTextureBindingLayout", "GpuTextureBindingLayout", [
        ["sampleType", field(optional(string))],
        ["viewDimension", field(optional(string))],
        ["multisampled", field(optional(boolean))],
    ]),
    descriptor("GPUShaderModuleDescriptor", "GpuShaderModuleDescriptor", [
        ["label", field(optional(string))],
        ["code", field(string)],
    ]),
    descriptor("GPUPipelineLayoutDescriptor", "GpuPipelineLayoutDescriptor", [
        ["label", field(optional(string))],
        ["bindGroupLayouts", field(array(gpuObject))],
    ]),
    descriptor("GPUComputePipelineDescriptor", "GpuComputePipelineDescriptor", [
        ["label", field(optional(string))],
        ["layout", field(gpuObject)],
        ["compute", field(record("GPUProgrammableStage"))],
    ]),
    {
        pinned: ["GPUProgrammableStage", "GPUVertexState"],
        cpp: "GpuProgrammableStage",
        reference: false,
        native: true,
        members: members([
            ["module", field(gpuObject)],
            ["entryPoint", field(optional(string))],
        ]),
    },
    descriptor("GPURenderPipelineDescriptor", "GpuRenderPipelineDescriptor", [
        ["label", field(optional(string))],
        ["layout", field(gpuObject)],
        ["vertex", field(record("GPUProgrammableStage"))],
        ["fragment", field(optional(record("GPUFragmentState")))],
        ["primitive", field(optional(record("GPUPrimitiveState")))],
        ["depthStencil", field(optional(record("GPUDepthStencilState")))],
        ["multisample", field(optional(record("GPUMultisampleState")))],
    ]),
    descriptor("GPUFragmentState", "GpuFragmentState", [
        ["module", field(gpuObject)],
        ["entryPoint", field(optional(string))],
        ["targets", field(array(record("GPUColorTargetState")))],
    ]),
    descriptor("GPUColorTargetState", "GpuColorTargetState", [
        ["format", field(string)],
        ["blend", field(optional(record("GPUBlendState")))],
        ["writeMask", field(optional(number))],
    ]),
    descriptor("GPUBlendState", "GpuBlendState", [
        ["color", field(record("GPUBlendComponent"))],
        ["alpha", field(record("GPUBlendComponent"))],
    ]),
    descriptor("GPUBlendComponent", "GpuBlendComponent", [
        ["operation", field(optional(string))],
        ["srcFactor", field(optional(string))],
        ["dstFactor", field(optional(string))],
    ]),
    descriptor("GPUPrimitiveState", "GpuPrimitiveState", [
        ["topology", field(optional(string))],
        ["cullMode", field(optional(string))],
    ]),
    descriptor("GPUDepthStencilState", "GpuDepthStencilState", [
        ["format", field(string)],
        ["depthWriteEnabled", field(optional(boolean))],
        ["depthCompare", field(optional(string))],
    ]),
    descriptor("GPUMultisampleState", "GpuMultisampleState", [
        ["count", field(optional(number))],
    ]),
    descriptor("GPUComputePassDescriptor", "GpuComputePassDescriptor", [
        ["label", field(optional(string))],
    ]),
];

/** WebGPU objects the subset holds without reading a member of them. */
export const gpuSubsetValues: readonly (readonly [string, RecordShape])[] = [
    ["GPUTextureView", gpuObject],
    ["GPUBindGroup", gpuObject],
    ["GPUBindGroupLayout", gpuObject],
    ["GPUShaderModule", gpuObject],
    ["GPUPipelineLayout", gpuObject],
    ["GPUComputePipeline", gpuObject],
    ["GPURenderPipeline", gpuObject],
];

/** `GPUMapMode`, as the specification numbers it. */
export const gpuMapModeConstants: ReadonlyMap<string, number> = new Map([
    ["GPUMapMode.READ", 1],
    ["GPUMapMode.WRITE", 2],
]);
