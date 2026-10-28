/** WebGPU declarations shared by pinned record families at the platform boundary. */
import {
    arrayOf as array,
    descriptor,
    field,
    functionOf as fn,
    gpuObjectShape as gpuObject,
    members,
    promiseOf,
    recordOf as record,
    optionalOf as optional,
    recordScalars,
    spelled,
} from "./record-shapes.js";
import type {
    MemberSpec,
    RecordShape,
    RecordSpec,
} from "./pinned-record-lowerer.js";
import { copyExternalImageToTexture } from "./web-platform-schema.js";
const { number, boolean, string, void: none } = recordScalars;
const buffer: RecordShape = { kind: "buffer" };
/** A queue write's `AllowSharedBufferSource`: an ArrayBuffer or a typed array. */
const bufferSource: RecordShape = {
    kind: "variant",
    members: [
        buffer,
        { kind: "typed", element: "f32array" },
        { kind: "typed", element: "u32array" },
        { kind: "typed", element: "u8array" },
    ],
};
const method = (shape: RecordShape, native: string): MemberSpec => ({
    shape,
    access: (owner) => `${owner}->${native}`,
});
const encoder = (pinned: string): RecordSpec => ({
    pinned: [pinned],
    cpp: "GpuEncoder",
    handle: "GpuEncoderHandle",
    reference: true,
    native: true,
    proxy: "bbl::GpuEncoderProxy",
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
        [
            // WebGPU's defaults fill an omitted count (gpu.hpp).
            "draw",
            method(
                fn(
                    [
                        number,
                        optional(number),
                        optional(number),
                        optional(number),
                    ],
                    none,
                ),
                "draw",
            ),
        ],
        [
            "drawIndirect",
            method(fn([record("GPUBuffer"), number], none), "draw_indirect"),
        ],
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
            [
                "createView",
                spelled(
                    fn(
                        [optional(record("GPUTextureViewDescriptor"))],
                        gpuObject,
                    ),
                    (owner, args) =>
                        args.length > 0
                            ? `bbl::gpu_texture_view(*${owner}, ${args[0]})`
                            : `${owner}->create_view()`,
                ),
            ],
            ["width", field(number, "width")],
            ["height", field(number, "height")],
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
                    "texture",
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
                // `writeBuffer(buffer, offset, data[, dataOffset, size])`:
                // all of an ArrayBuffer or typed array, or a byte range of
                // an ArrayBuffer.
                "writeBuffer",
                spelled(
                    fn(
                        [
                            record("GPUBuffer"),
                            number,
                            bufferSource,
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
                spelled(
                    fn(
                        [
                            record("GPUTexelCopyTextureInfo"),
                            bufferSource,
                            record("GPUTexelCopyBufferLayout"),
                            record("GPUExtent3DDict"),
                        ],
                        none,
                    ),
                    (owner, args) =>
                        `bbl::gpu_queue_write_texture(*${owner}, ${args.join(", ")})`,
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
        ["mappedAtCreation", field(boolean)],
    ]),
    descriptor("GPUTextureDescriptor", "GpuTextureDescriptor", [
        ["label", field(optional(string))],
        ["format", field(string)],
        ["size", field(record("GPUExtent3DDict"))],
        ["usage", field(number)],
        ["sampleCount", field(optional(number))],
    ]),
    {
        ...descriptor("GPUExtent3DDict", "GpuExtent3D", [
            ["width", field(number)],
            ["height", field(number)],
            ["depthOrArrayLayers", field(number)],
        ]),
        sequence: ["width", "height", "depthOrArrayLayers"],
    },
    descriptor("GPUTextureViewDescriptor", "GpuTextureViewDescriptor", [
        ["aspect", field(optional(string))],
        ["dimension", field(optional(string))],
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
        ["label", field(optional(string))],
        [
            "colorAttachments",
            field(array(record("GPURenderPassColorAttachment"))),
        ],
        [
            "depthStencilAttachment",
            field(optional(record("GPURenderPassDepthStencilAttachment"))),
        ],
    ]),
    descriptor(
        "GPURenderPassDepthStencilAttachment",
        "GpuRenderPassDepthStencilAttachment",
        [
            ["view", field(gpuObject)],
            ["depthClearValue", field(optional(number))],
            ["depthLoadOp", field(optional(string))],
            ["depthStoreOp", field(optional(string))],
        ],
    ),
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

/** `GPUPipelineLayout | "auto"` (gpu.hpp `GpuPipelineLayoutChoice`). */
const pipelineLayout: RecordShape = {
    kind: "native",
    cpp: "bbl::GpuPipelineLayoutChoice",
};
/** An optional trailing argument, absent when the call omits it. */
const or = (args: readonly string[], index: number, absent = "{}"): string =>
    args[index] ?? absent;
/** A `gpuRecords` record with members the subset adds. */
const extending = (
    pinned: string,
    added: readonly (readonly [string, MemberSpec])[],
): RecordSpec => {
    const base = gpuRecords.find((spec) => spec.pinned[0] === pinned);
    if (!base) throw new Error(`No GPU record ${pinned} to extend.`);
    return { ...base, members: members([...(base.members ?? []), ...added]) };
};
/** The subset's members on `gpuRecords` records, each record whole. */
const subsetExtensions: readonly RecordSpec[] = [
    extending("GPUBuffer", [
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
    extending("GPUDevice", [
        [
            "limits",
            {
                shape: record("GPUSupportedLimits"),
                access: (owner) => `${owner}->limits()`,
            },
        ],
        [
            "createBindGroupLayout",
            method(
                fn([record("GPUBindGroupLayoutDescriptor")], gpuObject),
                "create_bind_group_layout",
            ),
        ],
        [
            "createSampler",
            // `createSampler()` takes WebGPU's defaults.
            spelled(
                fn([record("GPUSamplerDescriptor")], gpuObject),
                (owner, args) =>
                    `${owner}->create_sampler(${or(args, 0, "bbl::GpuSamplerDescriptor{}")})`,
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
                fn(
                    [record("GPUComputePipelineDescriptor")],
                    record("GPUComputePipeline"),
                ),
                "compute_pipeline",
            ),
        ],
        [
            "createRenderPipeline",
            method(
                fn(
                    [record("GPURenderPipelineDescriptor")],
                    record("GPURenderPipeline"),
                ),
                "render_pipeline",
            ),
        ],
    ]),
    extending("GPUQueue", [
        [
            "onSubmittedWorkDone",
            method(fn([], promiseOf(none)), "on_submitted_work_done"),
        ],
        // A decoded ImageBitmap's upload (web-platform-schema.ts).
        copyExternalImageToTexture,
    ]),
    extending("GPUCommandEncoder", [
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
                    [record("GPUBuffer"), optional(number), optional(number)],
                    none,
                ),
                (owner, args) =>
                    `${owner}->clear_buffer(${args[0]}, ${or(args, 1)}, ${or(args, 2)})`,
            ),
        ],
    ]),
];

/**
 * The WebGPU subset the pin's compute, indirect and buffer-mapping paths
 * speak (the streamed splat library), over the same device interface:
 * `gpuRecords` with the mapping members of a buffer, the device's layout,
 * module and pipeline creation and limits, the queue's typed and ranged
 * writes and its completion, and the compute and indirect encoders. The
 * text family keeps `gpuRecords`, whose spellings this does not change.
 */
export const gpuSubsetRecords: readonly RecordSpec[] = [
    ...gpuRecords.map(
        (spec) =>
            subsetExtensions.find(
                (extension) => extension.pinned[0] === spec.pinned[0],
            ) ?? spec,
    ),
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
                // One to three counts, each the overload's own.
                spelled(
                    fn([number, number, number], none),
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
    descriptor("GPUSamplerDescriptor", "GpuSamplerDescriptor", [
        ["label", field(optional(string))],
        ["addressModeU", field(optional(string))],
        ["addressModeV", field(optional(string))],
        ["addressModeW", field(optional(string))],
        ["magFilter", field(optional(string))],
        ["minFilter", field(optional(string))],
        ["mipmapFilter", field(optional(string))],
        ["lodMinClamp", field(optional(number))],
        ["lodMaxClamp", field(optional(number))],
        ["compare", field(optional(string))],
        ["maxAnisotropy", field(optional(number))],
    ]),
    descriptor("GPUSupportedLimits", "GpuSupportedLimits", [
        ["maxBufferSize", field(number)],
        ["maxStorageBufferBindingSize", field(number)],
        ["maxComputeWorkgroupsPerDimension", field(number)],
    ]),
    descriptor("GPUBindGroupLayoutDescriptor", "GpuBindGroupLayoutDescriptor", [
        ["label", field(optional(string))],
        ["entries", field(array(record("GPUBindGroupLayoutEntry")))],
    ]),
    descriptor("GPUBindGroupLayoutEntry", "GpuBindGroupLayoutEntry", [
        ["binding", field(number)],
        ["visibility", field(number)],
        ["buffer", field(optional(record("GPUBufferBindingLayout")))],
        ["sampler", field(optional(record("GPUSamplerBindingLayout")))],
        ["texture", field(optional(record("GPUTextureBindingLayout")))],
    ]),
    descriptor("GPUSamplerBindingLayout", "GpuSamplerBindingLayout", [
        ["type", field(optional(string))],
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
    {
        // One native pipeline handle, compute or render: its label (a pass
        // named after its pipeline) and its layouts are read back.
        pinned: ["GPUComputePipeline", "GPURenderPipeline"],
        cpp: "GpuObject",
        handle: "GpuHandle",
        reference: true,
        native: true,
        members: members([
            ["label", field(string, "label")],
            [
                "getBindGroupLayout",
                method(fn([number], gpuObject), "get_bind_group_layout"),
            ],
        ]),
    },
    descriptor("GPUComputePipelineDescriptor", "GpuComputePipelineDescriptor", [
        ["label", field(optional(string))],
        ["layout", field(pipelineLayout)],
        ["compute", field(record("GPUProgrammableStage"))],
    ]),
    descriptor("GPUProgrammableStage", "GpuProgrammableStage", [
        ["module", field(gpuObject)],
        ["entryPoint", field(optional(string))],
    ]),
    // The subset's vertex stages fetch from storage; a vertex buffer list
    // the backends refuse unless empty.
    descriptor("GPUVertexState", "GpuVertexState", [
        ["module", field(gpuObject)],
        ["entryPoint", field(optional(string))],
        ["buffers", field(optional(array({ kind: "object" })))],
    ]),
    descriptor("GPURenderPipelineDescriptor", "GpuRenderPipelineDescriptor", [
        ["label", field(optional(string))],
        ["layout", field(pipelineLayout)],
        ["vertex", field(record("GPUVertexState"))],
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
        ["frontFace", field(optional(string))],
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
    ["GPUSampler", gpuObject],
    ["GPUBindGroup", gpuObject],
    ["GPUBindGroupLayout", gpuObject],
    ["GPUShaderModule", gpuObject],
    ["GPUPipelineLayout", gpuObject],
];

/** `GPUMapMode`, as the specification numbers it. */
export const gpuMapModeConstants: ReadonlyMap<string, number> = new Map([
    ["GPUMapMode.READ", 1],
    ["GPUMapMode.WRITE", 2],
]);
