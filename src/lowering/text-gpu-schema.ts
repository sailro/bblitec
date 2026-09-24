/**
 * The pin's text GPU path as native records: the WebGPU objects, descriptors
 * and encoders it speaks, the engine surface it draws to, and the GPU-side
 * records of text renderables and the standalone text renderer.
 *
 * WebGPU is the platform boundary. The pinned GPU functions lower whole over
 * `bblite/text_gpu.hpp`, whose device, queue and encoders each backend
 * implements with WebGPU's own semantics: a descriptor reaches the backend as
 * the pin builds it, a buffer is created with the pin's size and usage, and a
 * write carries the pin's offsets. Pipelines and their shared quad come from
 * the backend's pipeline cache (`getOrCreateTextPipeline`,
 * `getTextPipelineCache`), camera matrices from the scene's camera input, and
 * the optional alpha-to-coverage resolver hook and variant-pipeline flag are
 * runtime state both backends read.
 */
import type {
    CallAdapter,
    MemberSpec,
    RecordShape,
    RecordSpec,
} from "./pinned-record-lowerer.js";
import { webgpuFlagNamespaces } from "../webgpu-flags.js";

const number: RecordShape = { kind: "number" };
const string: RecordShape = { kind: "string" };
const none: RecordShape = { kind: "void" };
const buffer: RecordShape = { kind: "buffer" };
const record = (name: string): RecordShape => ({ kind: "record", name });
const optional = (value: RecordShape): RecordShape => ({
    kind: "optional",
    value,
});
const array = (element: RecordShape): RecordShape => ({
    kind: "array",
    element,
});
const fn = (
    parameters: readonly RecordShape[],
    result: RecordShape,
): RecordShape => ({ kind: "function", parameters, result });
/** A backend GPU object the text path holds; absent while `null`. */
const gpuObject: RecordShape = {
    kind: "native",
    cpp: "bbl::TextGpuHandle",
    nullable: true,
};
const typedF32: RecordShape = { kind: "typed", element: "f32" };

/** A platform object's method, as the runtime interface spells it. */
const method = (shape: RecordShape, native: string): MemberSpec => ({
    shape,
    access: (owner) => `${owner}->${native}`,
});
const members = (
    entries: readonly (readonly [string, MemberSpec])[],
): ReadonlyMap<string, MemberSpec> => new Map(entries);
const field = (shape: RecordShape, name?: string): MemberSpec =>
    name === undefined ? { shape } : { shape, field: name };

/** A value descriptor the pin builds and a backend reads. */
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
    cpp: "TextGpuEncoder",
    handle: "TextGpuEncoderHandle",
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

export const textGpuRecords: readonly RecordSpec[] = [
    // WebGPU objects: one backend handle each, compared by identity.
    {
        pinned: ["GPUBuffer"],
        cpp: "TextGpuObject",
        handle: "TextGpuHandle",
        reference: true,
        native: true,
        members: members([
            ["size", { shape: number, access: (owner) => `${owner}->size` }],
            ["destroy", method(fn([], none), "destroy")],
        ]),
    },
    {
        pinned: ["GPUTexture"],
        cpp: "TextGpuObject",
        handle: "TextGpuHandle",
        reference: true,
        native: true,
        members: members([
            ["destroy", method(fn([], none), "destroy")],
            ["createView", method(fn([], gpuObject), "create_view")],
        ]),
    },
    {
        pinned: ["GPUDevice"],
        cpp: "TextGpuDevice",
        handle: "TextGpuDeviceHandle",
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
        cpp: "TextGpuDevice",
        handle: "TextGpuDeviceHandle",
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
        cpp: "TextGpuCommandEncoder",
        handle: "TextGpuCommandEncoderHandle",
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
    descriptor("GPUBufferDescriptor", "TextBufferDescriptor", [
        ["label", field(optional(string))],
        ["size", field(number)],
        ["usage", field(number)],
    ]),
    descriptor("GPUTextureDescriptor", "TextTextureDescriptor", [
        ["label", field(optional(string))],
        ["format", field(string)],
        ["size", field(record("GPUExtent3DDict"))],
        ["usage", field(number)],
    ]),
    descriptor("GPUExtent3DDict", "TextExtent3D", [
        ["width", field(number)],
        ["height", field(number)],
        ["depthOrArrayLayers", field(number)],
    ]),
    descriptor("GPUBindGroupDescriptor", "TextBindGroupDescriptor", [
        ["label", field(optional(string))],
        ["layout", field(gpuObject)],
        ["entries", field(array(record("GPUBindGroupEntry")))],
    ]),
    descriptor("GPUBindGroupEntry", "TextBindGroupEntry", [
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
    descriptor("GPUBufferBinding", "TextBufferBinding", [
        ["buffer", field(record("GPUBuffer"))],
        ["offset", field(optional(number))],
        ["size", field(optional(number))],
    ]),
    descriptor("GPUTexelCopyTextureInfo", "TextTexelCopyTextureInfo", [
        ["texture", field(record("GPUTexture"))],
    ]),
    descriptor("GPUTexelCopyBufferLayout", "TextTexelCopyBufferLayout", [
        ["offset", field(optional(number))],
        ["bytesPerRow", field(optional(number))],
        ["rowsPerImage", field(optional(number))],
    ]),
    descriptor(
        "GPURenderBundleEncoderDescriptor",
        "TextRenderBundleEncoderDescriptor",
        [
            ["colorFormats", field(array(string))],
            ["sampleCount", field(optional(number))],
        ],
    ),
    descriptor("GPURenderPassDescriptor", "TextRenderPassDescriptor", [
        [
            "colorAttachments",
            field(array(record("GPURenderPassColorAttachment"))),
        ],
    ]),
    descriptor(
        "GPURenderPassColorAttachment",
        "TextRenderPassColorAttachment",
        [
            ["view", field(gpuObject)],
            // GPUColor: this path passes the dictionary form.
            ["clearValue", field(optional(record("GPUColorDict")))],
            ["loadOp", field(string)],
            ["storeOp", field(string)],
        ],
    ),
    descriptor("GPUColorDict", "Color4d", [
        ["r", field(number)],
        ["g", field(number)],
        ["b", field(number)],
        ["a", field(number)],
    ]),
    // The engine and its primary surface: one native surface the backend
    // points at its device, target size, swapchain view and frame encoder.
    {
        pinned: ["EngineContext", "SurfaceContext"],
        cpp: "TextSurface",
        handle: "TextSurfaceHandle",
        reference: true,
        native: true,
        members: members([
            ["_device", field(record("GPUDevice"), "device")],
            [
                "_currentEncoder",
                field(record("GPUCommandEncoder"), "current_encoder"),
            ],
            ["canvas", field(record("TextSurfaceCanvas"))],
            ["format", field(string)],
            [
                "engine",
                { shape: record("EngineContext"), access: (owner) => owner },
            ],
            ["scRT", field(record("TextSurfaceTarget"), "sc_rt")],
            [
                "_renderingContexts",
                field(array(record("TextRenderer")), "rendering_contexts"),
            ],
        ]),
    },
    descriptor("TextSurfaceCanvas", "TextSurfaceCanvas", [
        ["width", field(number)],
        ["height", field(number)],
    ]),
    descriptor("TextSurfaceTarget", "TextSurfaceTarget", [
        ["_colorView", field(optional(gpuObject), "color_view")],
    ]),
    descriptor("RenderTargetSignature", "TextTargetSignature", [
        ["_colorFormat", field(optional(string), "color_format")],
        ["_depthStencilFormat", field(optional(string), "depth_format")],
        ["_depthCompare", field(optional(string), "depth_compare")],
        ["_sampleCount", field(number, "sample_count")],
    ]),
    descriptor("DrawUpdateContext", "TextDrawUpdateContext", [
        [
            "_camera",
            field(
                {
                    kind: "native",
                    cpp: "bbl::TextCameraInputPointer",
                    nullable: true,
                },
                "camera",
            ),
        ],
        ["targetWidth", field(number)],
        ["targetHeight", field(number)],
    ]),
    // The backend's pipeline cache.
    descriptor("TextPipelineSet", "TextPipelineSet", [
        ["_pipeline", field(gpuObject, "pipeline")],
        ["_variantPipeline", field(gpuObject, "variant_pipeline")],
        ["_cache", field(record("TextPipelineDeviceCache"), "cache")],
    ]),
    {
        pinned: ["TextPipelineDeviceCache"],
        cpp: "TextPipelineDeviceCache",
        handle: "TextPipelineDeviceCacheHandle",
        reference: true,
        native: true,
        members: members([
            ["_bindGroupLayout", field(gpuObject, "bind_group_layout")],
            [
                "_quadVertexBuffer",
                field(record("GPUBuffer"), "quad_vertex_buffer"),
            ],
        ]),
    },
    // The pin's GPU-side records, emitted from its declarations.
    { pinned: ["SharedAtlasGpu"], cpp: "SharedAtlasGpu", reference: true },
    {
        pinned: ["SharedAtlasGpuResult"],
        cpp: "SharedAtlasGpuResult",
        reference: false,
        returnOf: "src/text/_gpu/text-textures.ts#ensureSharedAtlasGpu",
    },
    { pinned: ["TextStyleGpu"], cpp: "TextStyleGpu", reference: true },
    {
        pinned: ["TextRenderableGpu"],
        cpp: "TextRenderableGpu",
        reference: true,
        bases: ["TextStyleGpu"],
    },
    {
        pinned: ["LayerGpu"],
        cpp: "TextLayerGpu",
        reference: true,
        bases: ["TextStyleGpu"],
    },
    {
        pinned: ["BindGroupCacheEntry"],
        cpp: "TextBindGroupCacheEntry",
        reference: true,
    },
    {
        // The only rendering contexts the text path registers are its own.
        pinned: ["TextRenderer", "RenderingContext"],
        cpp: "TextRendererState",
        handle: "TextRenderer",
        reference: true,
        omit: new Map([
            ["_kind", "the renderer's type is its kind"],
            [
                "_update",
                "the native frame calls the lowered textRendererUpdate for each registered renderer",
            ],
            [
                "_record",
                "the native frame calls the lowered textRendererRecord for each registered renderer",
            ],
            ["_resize", "a text renderer has no size-dependent resources"],
            ["_drawCallsPre", "the backend counts a frame's draw calls"],
        ]),
        members: members([
            // GPUColor: the renderer stores the dictionary it was given.
            ["clearColor", field(record("GPUColorDict"))],
        ]),
    },
    {
        pinned: ["TextRendererOptions"],
        cpp: "TextRendererOptions",
        reference: false,
    },
];

/** WebGPU objects the path holds but never reads a member of. */
export const textGpuValues: readonly (readonly [string, RecordShape])[] = [
    ["GPUTextureView", gpuObject],
    ["GPUBindGroup", gpuObject],
    ["GPUBindGroupLayout", gpuObject],
    ["GPURenderPipeline", gpuObject],
    ["GPURenderBundle", gpuObject],
    ["GPUSampler", gpuObject],
    ["GPUExternalTexture", gpuObject],
    ["GPUShaderModule", gpuObject],
    [
        "Camera",
        { kind: "native", cpp: "bbl::TextCameraInputPointer", nullable: true },
    ],
    // A surface's canvas, as its drawable size.
    ["RenderCanvas", record("TextSurfaceCanvas")],
    // Alpha-to-coverage targets reached from text are text renderables.
    ["AlphaToCoverageTarget", record("TextRenderable")],
    ["SupportedAlphaToCoverageTarget", record("TextRenderable")],
];

/**
 * Types `math/types.ts` and `render/renderable.ts` declare; both are
 * type-only, so the source maps do not carry them.
 */
export const textGpuUnresolved: readonly (readonly [string, RecordShape])[] = [
    // A single-precision engine's matrices (the HPM engine is refused
    // by the text surface).
    ["Mat4", typedF32],
    ["Mat4Storage", typedF32],
    ["DrawUpdateContext", record("DrawUpdateContext")],
];

const TEXT_PIPELINE = "src/text/_gpu/text-pipeline.ts";
const CAMERA = "src/camera/camera.ts";

export const textGpuAdapters: readonly (readonly [string, CallAdapter])[] = [
    [
        `${TEXT_PIPELINE}#getOrCreateTextPipeline`,
        {
            cpp: (argument) =>
                `${argument(0)}->device->text_pipeline(${[1, 2, 3, 4, 5, 6].map(argument).join(", ")})`,
        },
    ],
    [
        `${TEXT_PIPELINE}#getTextPipelineCache`,
        { cpp: (argument) => `${argument(0)}->device->text_pipeline_cache()` },
    ],
    [
        `${CAMERA}#getEffectiveAspectRatio`,
        { cpp: (argument) => `${argument(0)}->effective_aspect` },
    ],
    [
        `${CAMERA}#_cameraChangeKey`,
        { cpp: (argument) => `${argument(0)}->change_key` },
    ],
    [
        `${CAMERA}#getViewProjectionMatrix`,
        { cpp: (argument) => `${argument(0)}->view_projection` },
    ],
    [
        // Its only rejection is a node material's build group, which a text
        // renderable has none of.
        "src/render/alpha-to-coverage.ts#assertSupportedTarget",
        { cpp: () => null },
    ],
    [
        "src/render/alpha-to-coverage-hook.ts#_registerAlphaToCoverageResolver",
        {
            cpp: (argument) =>
                `bbl::text_alpha_to_coverage_resolver = ${argument(0)}`,
        },
    ],
];

/** The WebGPU flag globals, as the specification numbers them. */
export const textGpuConstants: ReadonlyMap<string, number> = new Map(
    Object.entries(webgpuFlagNamespaces).flatMap(([namespace, values]) =>
        Object.entries(values).map(
            ([name, value]) => [`${namespace}.${name}`, value] as const,
        ),
    ),
);
