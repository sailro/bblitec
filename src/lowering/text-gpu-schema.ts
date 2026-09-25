import {
    recordOf as record,
    optionalOf as optional,
    recordScalars,
} from "./record-shapes.js";
/**
 * The pin's text GPU path as native records: the WebGPU objects, descriptors
 * and encoders it speaks, the engine surface it draws to, and the GPU-side
 * records of text renderables and the standalone text renderer.
 *
 * WebGPU is the platform boundary. The pinned GPU functions lower whole over
 * `bblite/gpu.hpp`, whose device, queue and encoders each backend
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
import { gpuRecords } from "./gpu-schema.js";
import { webgpuFlagNamespaces } from "../webgpu-flags.js";

const { number, string, void: none } = recordScalars;
const fn = (
    parameters: readonly RecordShape[],
    result: RecordShape,
): RecordShape => ({ kind: "function", parameters, result });
/** A backend GPU object the text path holds; absent while `null`. */
const gpuObject: RecordShape = {
    kind: "native",
    cpp: "bbl::GpuHandle",
    nullable: true,
};
const typedF32: RecordShape = { kind: "typed", element: "f32" };

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

export const textGpuRecords: readonly RecordSpec[] = [
    ...gpuRecords,
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
                {
                    shape: record("RenderingContextList"),
                    access: (owner) => `${owner}->engine->rendering_contexts`,
                },
            ],
        ]),
    },
    {
        pinned: ["RenderingContextList"],
        cpp: "RenderingContextList&",
        reference: false,
        native: true,
        members: members([
            [
                "indexOf",
                {
                    shape: fn([record("TextRenderer")], number),
                    access: (owner) => `${owner}.index_of`,
                },
            ],
            [
                "push",
                {
                    shape: fn([record("TextRenderer")], none),
                    access: (owner) =>
                        `([&](const bbl::TextRenderer& context) { ${owner}.push_back(context->kind, context); })`,
                },
            ],
            [
                "splice",
                {
                    shape: fn([number, number], none),
                    access: (owner) =>
                        `([&](double index, double count) { if (count != 1.0) throw std::runtime_error("Rendering context removal count."); ${owner}.erase_at(static_cast<std::size_t>(index)); })`,
                },
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
            ["_resize", "a text renderer has no size-dependent resources"],
            ["_drawCallsPre", "the backend counts a frame's draw calls"],
        ]),
        members: members([
            ["_kind", field(string, "kind")],
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
                `bbl::text_pipelines(${argument(0)}->device).text_pipeline(${[1, 2, 3, 4, 5, 6].map(argument).join(", ")})`,
        },
    ],
    [
        `${TEXT_PIPELINE}#getTextPipelineCache`,
        {
            cpp: (argument) =>
                `bbl::text_pipelines(${argument(0)}->device).text_pipeline_cache()`,
        },
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
