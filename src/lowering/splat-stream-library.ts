/**
 * The pin's streamed Gaussian-splat library lowered whole: the synchronous
 * core and the transport (`splat-stream-records.ts`), the GPU state and
 * passes (`splat-stream-gpu.ts`), the renderable (`splat-stream-material.ts`)
 * and the loader that ties them to an engine and a scene
 * (`load-gaussian-splat-stream.ts`), as one `PinnedRecordModel`.
 *
 * The pin's own engine, scene, camera and render-task objects are the
 * native ones, reached through `bblite/splat_stream_runtime.hpp`: the engine
 * is a `StoredEngine` whose `_device` is `Engine::webgpu_device` and whose
 * `_currentEncoder` is the frame encoder the scene pass names while it
 * prepares external renderables; a scene is its shared `SceneState`; a
 * camera is the scene camera's record, read through the generated camera
 * math; a renderable, its bindings and their update batches are the
 * `gpu_renderable.hpp` interfaces the scene pass drives; a scene node is the
 * TRS triple the pin's world-matrix composition and Euler proxy read.
 */
import ts from "typescript";
import { type LoweringContext } from "./context.js";
import {
    pinnedEulerProxy,
    pinnedQuaternionMath,
} from "./pinned-euler-proxy.js";
import {
    PinnedNumericLowerer,
    type PinnedBinding,
} from "./pinned-numeric-lowerer.js";
import {
    type CallAdapter,
    type MemberSpec,
    type PinnedCallable,
    PinnedRecordModel,
    type RecordShape,
    type RecordSpec,
} from "./pinned-record-lowerer.js";
import {
    gpuMapModeConstants,
    gpuSubsetRecords,
    gpuSubsetValues,
} from "./gpu-schema.js";
import {
    SPLAT_STREAM_CORE_MODULES,
    SPLAT_STREAM_CORE_RECORDS,
    SPLAT_STREAM_TRANSPORT_MODULES,
    SPLAT_STREAM_TRANSPORT_RECORDS,
    splatStreamTransportModel,
} from "./splat-stream-records.js";
import { webgpuFlagNamespaces } from "../webgpu-flags.js";
import { stringLiteral } from "../cpp-literals.js";
import {
    pinnedRawShaderImports,
    SPLAT_STREAM_SHADER_MODULES,
} from "./splat-stream-shaders.js";
import {
    arrayOf as array,
    optionalOf as optional,
    recordOf as record,
    recordScalars,
} from "./record-shapes.js";

const LOAD = "src/loader-splat-stream/load-gaussian-splat-stream.ts";
const GPU = "src/loader-splat-stream/splat-stream-gpu.ts";
const MATERIAL = "src/loader-splat-stream/splat-stream-material.ts";
const CAMERA = "src/camera/camera.ts";
const SIGNATURE = "src/engine/render-target-signature.ts";

/** The modules the library model lowers beyond the core's. */
export const SPLAT_STREAM_LIBRARY_MODULES = [
    GPU,
    MATERIAL,
    LOAD,
    SIGNATURE,
] as const;

const RUNTIME = "bbl::splat_stream";
const { number, boolean, string, void: none } = recordScalars;
const typedF32: RecordShape = { kind: "typed", element: "f32" };
const gpuObject: RecordShape = {
    kind: "native",
    cpp: "bbl::GpuHandle",
    nullable: true,
};
const fn = (
    parameters: readonly RecordShape[],
    result: RecordShape,
): RecordShape => ({ kind: "function", parameters, result });
const field = (shape: RecordShape, name?: string): MemberSpec =>
    name === undefined ? { shape } : { shape, field: name };
const read = (shape: RecordShape, native: string): MemberSpec => ({
    shape,
    access: (owner) => `${RUNTIME}::${native}(${owner})`,
});
const members = (
    entries: readonly (readonly [string, MemberSpec])[],
): ReadonlyMap<string, MemberSpec> => new Map(entries);
/**
 * `scene.<list>.<method>(...)` through the scene-list helpers scene programs
 * use too (`bbl::scene_list_push` / `_index_of` / `_splice`, runtime.hpp),
 * over the list's SceneState field.
 */
const sceneListMember = (
    method: "push" | "indexOf" | "splice",
    field: string,
    shape: RecordShape,
): readonly [string, MemberSpec] => [
    method,
    {
        shape,
        access: (owner) => owner,
        call: (owner, args) =>
            `bbl::scene_list_${method === "indexOf" ? "index_of" : method}(${owner}->${field}, ${args.join(", ")})`,
    },
];
/** A scene list the pin pushes to, searches and splices by identity. */
const list = (native: string): MemberSpec => ({
    shape: { kind: "record", name: native },
    access: (owner) => owner,
});

/** `DrawUpdateBatch`'s members, as the scene pass calls them. */
const drawUpdateBatchMembers: readonly (readonly [string, MemberSpec])[] = [
    ["_retired", field(boolean, "retired_flag")],
    ["reset", field(fn([], none), "reset_callback")],
    ["flush", field(fn([record("EngineContext")], none), "flush_callback")],
    ["destroy", field(fn([], none), "destroy_callback")],
];

/** The engine, scene, camera and render-task objects the library reaches. */
const runtimeRecords: readonly RecordSpec[] = [
    {
        // The engine the stream was loaded on: its WebGPU-subset device and
        // the frame encoder a scene pass names while batches flush.
        pinned: ["EngineContext"],
        cpp: "Engine",
        handle: "StoredEngine",
        reference: true,
        native: true,
        members: members([
            ["_device", read(record("GPUDevice"), "engine_device")],
            [
                "_currentEncoder",
                read(record("GPUCommandEncoder"), "engine_encoder"),
            ],
        ]),
    },
    {
        // `scene.surface`: the scene's engine.
        pinned: ["SurfaceContext"],
        cpp: "SceneState",
        handle: "SplatStreamScene",
        reference: true,
        native: true,
        members: members([
            ["engine", read(record("EngineContext"), "scene_engine")],
        ]),
    },
    {
        pinned: ["SceneContext"],
        cpp: "SceneState",
        handle: "SplatStreamScene",
        reference: true,
        native: true,
        members: members([
            [
                "surface",
                { shape: record("SurfaceContext"), access: (owner) => owner },
            ],
            [
                "_built",
                {
                    shape: boolean,
                    access: (owner) => `${owner}->source_built`,
                },
            ],
            ["_beforeRender", list("SplatStreamBeforeRenderList")],
            ["_disposables", list("SplatStreamDisposableList")],
            ["_renderables", list("SplatStreamRenderableList")],
            [
                // Only advanced (`++`): the counter renderers follow.
                "_renderableVersion",
                field(number, "renderable_version"),
            ],
        ]),
    },
    // The scene's lists, through the scene-list helpers scene programs use
    // too (`runtime.hpp`), by their SceneState field. A renderable joins
    // the scene only through a deferred builder, which binds its engine.
    ...(
        [
            [
                "SplatStreamBeforeRenderList",
                fn([number], none),
                "before_render",
                true,
            ],
            ["SplatStreamDisposableList", fn([], none), "disposables", true],
            [
                "SplatStreamRenderableList",
                record("Renderable"),
                "external_renderables",
                false,
            ],
        ] as const
    ).map(([name, element, field, pushed]): RecordSpec => ({
        pinned: [name],
        cpp: "SceneState",
        handle: "SplatStreamScene",
        reference: true,
        native: true,
        members: members([
            ...(pushed
                ? [sceneListMember("push", field, fn([element], number))]
                : []),
            sceneListMember("indexOf", field, fn([element], number)),
            sceneListMember("splice", field, fn([number, number], none)),
        ]),
    })),
    {
        // What a deferred builder publishes when the scene builds.
        pinned: ["DeferredSceneRenderables"],
        cpp: "splat_stream::DeferredRenderables",
        reference: false,
        native: true,
        members: members([
            ["renderables", field(array(record("Renderable")))],
            ["dispose", field(optional(fn([], none)))],
        ]),
    },
    {
        // The scene camera a pass draws with, read through its record.
        pinned: ["Camera"],
        cpp: "splat_stream::Camera",
        reference: false,
        native: true,
        members: members([
            ["ortho", read(boolean, "camera_ortho")],
            [
                "viewport",
                read(optional(record("NormalizedViewport")), "camera_viewport"),
            ],
            ["nearPlane", read(number, "camera_near_plane")],
        ]),
    },
    {
        pinned: ["NormalizedViewport"],
        cpp: "NormalizedViewport",
        reference: false,
        native: true,
        members: members([
            ["x", field(number)],
            ["y", field(number)],
            ["width", field(number)],
            ["height", field(number)],
        ]),
    },
    {
        pinned: ["Vec3"],
        cpp: "Vec3d",
        reference: false,
        native: true,
        members: members([
            ["x", field(number)],
            ["y", field(number)],
            ["z", field(number)],
        ]),
    },
    {
        // A scene pass's attachments, one object per distinct signature.
        pinned: ["RenderTargetSignature"],
        cpp: "GpuRenderTargetSignature",
        handle: "SplatStreamTargetSignature",
        reference: true,
        native: true,
        members: members([
            ["_colorFormat", read(optional(string), "signature_color_format")],
            [
                "_depthStencilFormat",
                field(optional(string), "depth_stencil_format"),
            ],
            ["_depthCompare", field(optional(string), "depth_compare")],
            ["_sampleCount", field(number, "sample_count")],
        ]),
    },
    {
        pinned: ["DrawUpdateContext"],
        cpp: "splat_stream::DrawContext",
        reference: false,
        native: true,
        members: members([
            ["targetWidth", field(number, "target_width")],
            ["targetHeight", field(number, "target_height")],
            ["_camera", field(optional(record("Camera")), "camera")],
        ]),
    },
    {
        pinned: ["Renderable"],
        cpp: "splat_stream::Renderable",
        reference: true,
        native: true,
        members: members([
            ["order", field(number, "order_value")],
            ["isTransparent", field(boolean, "is_transparent")],
            [
                "bind",
                field(
                    fn(
                        [
                            record("EngineContext"),
                            record("RenderTargetSignature"),
                        ],
                        record("DrawBinding"),
                    ),
                    "bind_callback",
                ),
            ],
        ]),
    },
    {
        pinned: ["DrawBinding"],
        cpp: "splat_stream::DrawBinding",
        reference: true,
        native: true,
        members: members([
            ["renderable", field(record("Renderable"))],
            ["pipeline", field(gpuObject, "pipeline_value")],
            [
                "update",
                field(
                    optional(fn([record("DrawUpdateContext")], none)),
                    "update_callback",
                ),
            ],
            [
                "draw",
                field(
                    fn(
                        [
                            record("GPURenderPassEncoder"),
                            record("EngineContext"),
                        ],
                        number,
                    ),
                    "draw_callback",
                ),
            ],
            [
                "_updateBatches",
                field(
                    optional(array(record("DrawUpdateBatch"))),
                    "update_batch_list",
                ),
            ],
        ]),
    },
    {
        pinned: ["DrawUpdateBatch"],
        cpp: "splat_stream::DrawUpdateBatch",
        reference: true,
        native: true,
        members: members(drawUpdateBatchMembers),
    },
    {
        // `SplatStreamDrawBatch extends DrawUpdateBatch`: the base is a
        // type-only declaration, so the batch's own struct is native too.
        pinned: ["SplatStreamDrawBatch"],
        cpp: "splat_stream::DrawBatch",
        reference: true,
        native: true,
        bases: ["DrawUpdateBatch"],
        members: members([
            ...drawUpdateBatchMembers,
            ["passGpu", field(record("SplatStreamPassGpu"), "pass_gpu")],
            [
                "queue",
                field(
                    fn([record("PendingProjection")], none),
                    "queue_callback",
                ),
            ],
            [
                "takeBootstrapSignal",
                field(
                    fn([], optional({ kind: "promise", value: boolean })),
                    "take_bootstrap_signal_callback",
                ),
            ],
        ]),
    },
    {
        // The TRS triple `initSceneNodeTransform` adds, as the pin's
        // world-matrix composition reads it.
        pinned: ["SceneNode"],
        cpp: "splat_stream::SceneNode",
        reference: true,
        native: true,
        members: members([
            ["name", field(string)],
            ["children", field(array({ kind: "object" }))],
            ["worldMatrix", read(typedF32, "node_world_matrix")],
        ]),
    },
];

const PLATFORM = "bbl::splat_stream_platform";
const bytes: RecordShape = { kind: "typed", element: "u8" };

/**
 * The manifest's streaming UTF-8 decode (`new TextDecoder("utf-8", { fatal:
 * true })`, `decode(chunk, { stream: true })`, `decode()`) beside the
 * transport's plain one: the platform's Encoding Standard decoder.
 */
const textDecoderRecords: readonly RecordSpec[] = [
    {
        pinned: ["TextDecoder"],
        cpp: "splat_stream_platform::TextDecoderState",
        handle: "splat_stream_platform::TextDecoder",
        reference: true,
        native: true,
        members: members([
            [
                "decode",
                {
                    shape: fn(
                        [
                            optional(bytes),
                            optional(record("TextDecodeOptions")),
                        ],
                        string,
                    ),
                    access: (owner) => owner,
                    call: (owner, args) =>
                        args.length === 0
                            ? `${PLATFORM}::text_decoder_flush(${owner})`
                            : args.length === 1
                              ? `${PLATFORM}::text_decoder_decode(${owner}, *${args[0]})`
                              : `${PLATFORM}::text_decoder_decode(${owner}, *${args[0]}, ${args[1]})`,
                },
            ],
        ]),
    },
    {
        pinned: ["TextDecoderOptions"],
        cpp: "splat_stream_platform::TextDecoderOptions",
        reference: false,
        native: true,
        members: members([
            ["fatal", field(optional(boolean))],
            ["ignoreBOM", field(optional(boolean), "ignore_bom")],
        ]),
    },
    {
        pinned: ["TextDecodeOptions"],
        cpp: "splat_stream_platform::TextDecodeOptions",
        reference: false,
        native: true,
        members: members([["stream", field(optional(boolean))]]),
    },
];

const textDecoderConstructor: CallAdapter = {
    cpp: (argument, call) =>
        (call.arguments?.length ?? 0) === 0
            ? `${PLATFORM}::text_decoder_create()`
            : `${PLATFORM}::text_decoder_create(${argument(0)}, ${(call.arguments?.length ?? 0) > 1 ? argument(1) : "{}"})`,
    parameters: [string, optional(record("TextDecoderOptions"))],
};

/**
 * The WebGPU subset with the queue's bitmap upload, which the platform
 * performs from the decoded bitmap's bytes.
 */
const streamGpuRecords: readonly RecordSpec[] = gpuSubsetRecords.map((spec) =>
    spec.pinned[0] === "GPUQueue"
        ? {
              ...spec,
              members: new Map([
                  ...(spec.members ?? []),
                  [
                      "copyExternalImageToTexture",
                      {
                          shape: fn(
                              [
                                  record("GPUCopyExternalImageSourceInfo"),
                                  record("GPUCopyExternalImageDestInfo"),
                                  record("GPUExtent3DDict"),
                              ],
                              none,
                          ),
                          access: (owner: string) => owner,
                          call: (owner: string, args: readonly string[]) =>
                              `${PLATFORM}::copy_external_image_to_texture(*${owner}, ${args.join(", ")})`,
                      },
                  ],
              ]),
          }
        : spec,
);

/** The library's own records, emitted from the pin's declarations. */
const libraryRecords: readonly RecordSpec[] = [
    {
        pinned: ["GaussianSplatStream"],
        cpp: "GaussianSplatStream",
        reference: true,
        bases: ["SceneNode"],
        // The SceneNode members the library never reads live in the native
        // node: the TRS triple and the Euler proxy the application writes.
        omit: new Map(
            [
                "position",
                "rotationQuaternion",
                "rotation",
                "scaling",
                "parent",
                "worldMatrixVersion",
                "_localMatrix",
                "_localMatrixLocked",
                "visible",
                "metadata",
                "_cloneNode",
            ].map((name) => [
                name,
                "the native scene node holds the transform the library reads as worldMatrix",
            ]),
        ),
        members: members([["children", field(array({ kind: "object" }))]]),
    },
    {
        pinned: ["GaussianSplatStreamStats"],
        cpp: "GaussianSplatStreamStats",
        reference: true,
        accessors: new Set([
            "phase",
            "visibleLeaves",
            "coveredLeaves",
            "targetLeaves",
            "selectedSplats",
            "residentFiles",
            "queuedFiles",
            "pendingRequests",
            "residentGpuBytes",
            "allocatedGpuBytes",
            "fetchedBytes",
            "firstFrameMs",
            "error",
        ]),
    },
    {
        pinned: ["GaussianSplatStreamStatsSnapshot"],
        cpp: "GaussianSplatStreamStatsSnapshot",
        reference: true,
    },
    {
        pinned: ["StreamLeafRuntime"],
        cpp: "StreamLeafRuntime",
        reference: true,
    },
    {
        pinned: ["StreamBindingSelection"],
        cpp: "StreamBindingSelection",
        reference: true,
    },
    {
        pinned: ["StreamAggregateSelectionCache"],
        cpp: "StreamAggregateSelectionCache",
        reference: true,
    },
    {
        pinned: ["StreamSourceRuntime"],
        cpp: "StreamSourceRuntime",
        reference: true,
    },
    {
        // The pin's test seams: never set natively, so every read is absent
        // and the platform path runs.
        pinned: ["SplatStreamRuntimeDependencies"],
        cpp: "SplatStreamRuntimeDependencies",
        reference: true,
    },
    { pinned: ["StreamAttachment"], cpp: "StreamAttachment", reference: true },
    {
        pinned: ["FirstFrameDeferred"],
        cpp: "FirstFrameDeferred",
        reference: true,
    },
    {
        pinned: ["SplatStreamSourceGpu"],
        cpp: "SplatStreamSourceGpu",
        reference: true,
    },
    {
        pinned: ["SplatStreamGpuInterval"],
        cpp: "SplatStreamGpuInterval",
        reference: true,
    },
    {
        pinned: ["SharedPipelines"],
        cpp: "SplatStreamPipelines",
        reference: true,
    },
    {
        pinned: ["SplatStreamGpuState"],
        cpp: "SplatStreamGpuState",
        reference: true,
    },
    { pinned: ["ScanLevel"], cpp: "SplatStreamScanLevel", reference: true },
    {
        pinned: ["CompactScanLevel"],
        cpp: "SplatStreamCompactScanLevel",
        reference: true,
    },
    {
        pinned: ["SplatStreamPassGpu"],
        cpp: "SplatStreamPassGpu",
        reference: true,
    },
    {
        pinned: ["PendingProjection"],
        cpp: "SplatStreamPendingProjection",
        reference: true,
    },
    {
        pinned: ["RenderPipelineEntry"],
        cpp: "SplatStreamRenderPipelineEntry",
        reference: true,
    },
];

/** The library's platform calls into the native engine, scene and camera. */
const libraryAdapters: readonly (readonly [string, CallAdapter])[] = [
    [
        "src/engine/gpu-resource-retirement.ts#retireGpuResources",
        {
            cpp: (argument) =>
                `${RUNTIME}::retire_gpu_resources(${argument(0)}, ${argument(1)})`,
        },
    ],
    [
        // The scene pass collects every binding's batches already.
        "src/render/draw-update-batches.ts#enableDrawBatchCollection",
        { cpp: (argument) => `static_cast<void>(${argument(0)})` },
    ],
    [
        "src/render/scene-helpers.ts#getSceneBindGroupLayout",
        {
            cpp: (argument) =>
                `${RUNTIME}::scene_bind_group_layout(${argument(0)})`,
        },
    ],
    [
        "src/scene/scene-core.ts#addDeferredSceneRenderables",
        {
            cpp: (argument) =>
                `${RUNTIME}::add_deferred_scene_renderables(${argument(0)}, ${argument(1)})`,
            // The stream's builder publishes synchronously.
            parameters: [
                record("SceneContext"),
                fn(
                    [record("EngineContext"), record("SceneContext")],
                    record("DeferredSceneRenderables"),
                ),
            ],
        },
    ],
    [
        // The node's TRS triple starts at the pin's defaults.
        "src/scene/scene-node.ts#initSceneNodeTransform",
        {
            cpp: (argument) => argument(0),
            parameters: [record("GaussianSplatStream")],
        },
    ],
    [
        `${CAMERA}#getCameraPosition`,
        { cpp: (argument) => `${RUNTIME}::camera_position(${argument(0)})` },
    ],
    [
        `${CAMERA}#getEffectiveAspectRatio`,
        {
            cpp: (argument) =>
                `${RUNTIME}::camera_effective_aspect_ratio(${argument(0)}, ${argument(1)}, ${argument(2)})`,
        },
    ],
    [
        `${CAMERA}#getProjectionMatrix`,
        {
            cpp: (argument) =>
                `${RUNTIME}::camera_projection_matrix(${argument(0)}, ${argument(1)})`,
        },
    ],
    [
        `${CAMERA}#getViewProjectionMatrix`,
        {
            cpp: (argument) =>
                `${RUNTIME}::camera_view_projection_matrix(${argument(0)}, ${argument(1)})`,
        },
    ],
    [
        `${CAMERA}#getViewMatrix`,
        {
            cpp: (argument) => `${RUNTIME}::camera_view_matrix(${argument(0)})`,
        },
    ],
];

/** Types declared in modules the source maps do not carry. */
const libraryUnresolved: readonly (readonly [string, RecordShape])[] = [
    ["Mat4", typedF32],
    ["Mat4Storage", typedF32],
    ["Vec3", record("Vec3")],
    ["DrawUpdateContext", record("DrawUpdateContext")],
    ["Renderable", record("Renderable")],
    ["DrawBinding", record("DrawBinding")],
    ["DrawUpdateBatch", record("DrawUpdateBatch")],
];

/** Types the checker resolves that a native value represents. */
const libraryValues: readonly (readonly [string, RecordShape])[] = [
    // A single-precision engine's matrices.
    ["Mat4", typedF32],
    ["Mat4Storage", typedF32],
];

/** The library's record model over every reached module. */
export function splatStreamLibraryModel(
    context: LoweringContext,
): PinnedRecordModel {
    const core = splatStreamTransportModel(context).schema;
    const own = new Set(
        [
            ...streamGpuRecords,
            ...runtimeRecords,
            ...libraryRecords,
            ...textDecoderRecords,
        ].flatMap((spec) => spec.pinned),
    );
    const coreRecords = core.records
        .filter((spec) => !spec.pinned.some((name) => own.has(name)))
        .map((spec) =>
            // The loader reads the option's (absent) test seams.
            spec.pinned[0] === "GaussianSplatStreamOptions"
                ? {
                      pinned: spec.pinned,
                      cpp: spec.cpp,
                      reference: spec.reference,
                  }
                : spec,
        );
    return new PinnedRecordModel(
        context,
        context.store.program.modules([
            ...SPLAT_STREAM_CORE_MODULES,
            ...SPLAT_STREAM_TRANSPORT_MODULES,
            ...SPLAT_STREAM_LIBRARY_MODULES,
        ]),
        {
            ...core,
            records: [
                ...coreRecords,
                ...streamGpuRecords,
                ...runtimeRecords,
                ...libraryRecords,
                ...textDecoderRecords,
            ],
            constructors: new Map([
                ...(core.constructors ?? []),
                ["TextDecoder", textDecoderConstructor],
            ]),
            values: new Map([
                ...core.values,
                ...gpuSubsetValues,
                ...libraryValues,
            ]),
            adapters: new Map([...core.adapters, ...libraryAdapters]),
            // The run-time WGSL each module imports, byte for byte: SDL_GPU
            // finds its stages by the text's hash.
            moduleValues: new Map([
                ...(core.moduleValues ?? []),
                ...pinnedRawShaderImports(
                    context,
                    SPLAT_STREAM_SHADER_MODULES,
                ).map(
                    ({ module, name, code }) =>
                        [
                            `${module}#${name}`,
                            {
                                shape: string,
                                cpp: `std::string(${stringLiteral(code)})`,
                            },
                        ] as const,
                ),
            ]),
            unresolved: new Map([
                ...(core.unresolved ?? []),
                ...libraryUnresolved,
            ]),
            constants: new Map([
                ...(core.constants ?? []),
                ...gpuMapModeConstants,
                ...Object.entries(webgpuFlagNamespaces).flatMap(
                    ([namespace, values]) =>
                        Object.entries(values).map(
                            ([name, value]) =>
                                [`${namespace}.${name}`, value] as const,
                        ),
                ),
            ]),
        },
    );
}

/** The public functions the application reaches. */
export function splatStreamLibraryRoots(
    model: PinnedRecordModel,
): PinnedCallable[] {
    return [
        model.functionDeclaration(LOAD, "loadGaussianSplatStream"),
        model.functionDeclaration(LOAD, "attachGaussianSplatStream"),
        model.functionDeclaration(LOAD, "disposeGaussianSplatStream"),
    ];
}

const COLLISION = "src/collision/splat-voxel-collision.ts";

/** Every root the application compiler can call. */
function applicationRoots(model: PinnedRecordModel): PinnedCallable[] {
    return [
        ...splatStreamLibraryRoots(model),
        model.functionDeclaration(COLLISION, "loadSplatVoxelCollision"),
        model.functionDeclaration(COLLISION, "moveSplatVoxelCamera"),
    ];
}

/** The draw batch's struct: native, since its base is a type-only declaration. */
function drawBatchStruct(model: PinnedRecordModel): string {
    const record = model.record("SplatStreamDrawBatch");
    const base = new Set(drawUpdateBatchMembers.map(([name]) => name));
    const own = [...record.members().values()].filter(
        (member) => !base.has(member.name),
    );
    return `namespace splat_stream {
/** \`SplatStreamDrawBatch\` (splat-stream-gpu.ts), a \`DrawUpdateBatch\` the scene pass drives. */
struct DrawBatch final : DrawUpdateBatch {
${own.map((member) => `    ${model.cppType(member.shape)} ${member.field}{};`).join("\n")}
    void gc_trace(const bbl::js::TraceVisitor& visitor) const {
        DrawUpdateBatch::gc_trace(visitor);
${own.map((member) => `        visitor(${member.field});`).join("\n")}
    }
};
} // namespace splat_stream`;
}

/**
 * The camera functions the library calls, over the generated pinned camera
 * math, and the stream node's world matrix and Euler proxy, from the pin's
 * world-matrix composition, ObservableQuat and createEulerProxy.
 */
function nativePrelude(context: LoweringContext): string {
    const { file, declaration: quaternion } = context.classDeclaration(
        "src/math/observable-quat.ts",
        "ObservableQuat",
    );
    const set = quaternion.members.find(
        (node): node is ts.MethodDeclaration =>
            ts.isMethodDeclaration(node) && node.name.getText(file) === "set",
    );
    if (!set?.body)
        context.contractError(quaternion, "Expected ObservableQuat.set.");
    const scalar = (cpp: string): PinnedBinding => ({ cpp, type: "scalar" });
    const lanes = ["x", "y", "z", "w"] as const;
    const setQuaternion = new PinnedNumericLowerer(file, {
        bindings: new Map<string, PinnedBinding>([
            ["this._version", scalar("node.quaternion_version")],
            ...lanes.map((lane): [string, PinnedBinding] => [
                `this._${lane}`,
                scalar(`node.rotation_quaternion.${lane}`),
            ]),
            ...lanes.map((lane): [string, PinnedBinding] => [
                lane,
                scalar(lane),
            ]),
        ]),
        // The world matrix is composed on read; nothing caches it.
        calls: new Map([["this._onDirty", () => "static_cast<void>(node)"]]),
    }).statements(set.body.statements, "    ");
    return `namespace splat_stream {
/** \`getCameraPosition(camera)\`: the eye in the camera's world matrix. */
[[nodiscard]] inline Vec3d camera_position(const Camera& camera) {
    const auto world = upstream::camera_world_matrix(camera.record());
    return {static_cast<double>(world[12]), static_cast<double>(world[13]),
            static_cast<double>(world[14])};
}
/** \`getEffectiveAspectRatio(camera, width, height)\`. */
[[nodiscard]] inline double camera_effective_aspect_ratio(const js::Nullable<Camera>& camera,
                                                          double width, double height) {
    return camera ? upstream::effective_aspect_ratio(camera->record(), width, height)
                  : width / height;
}
[[nodiscard]] inline js::F32Array camera_projection_matrix(const Camera& camera, double aspect) {
    return upstream::get_camera_projection_matrix(camera.record(), aspect);
}
[[nodiscard]] inline js::F32Array camera_view_projection_matrix(const Camera& camera,
                                                                double aspect) {
    return upstream::get_camera_view_projection_matrix(camera.record(), aspect);
}
[[nodiscard]] inline js::F32Array camera_view_matrix(const Camera& camera) {
    return upstream::get_camera_view_matrix(camera.record());
}

${pinnedQuaternionMath(context)}
/** ObservableQuat.set over the node's quaternion. */
inline void node_set_quaternion(SceneNode& node, double x, double y, double z, double w) {
${setQuaternion.join("\n")}
}
${pinnedEulerProxy(context, {
    parameters: "SceneNode& node",
    arguments: "node",
    prefix: "node_euler",
    rotation: "node.rotation",
    quaternion: "node.rotation_quaternion",
    version: "node.quaternion_version",
    syncedVersion: "node.synced_quaternion_version",
    mathNamespace: "bbl::splat_stream",
    setQuaternion: (args) => `node_set_quaternion(node, ${args.join(", ")})`,
})}
/** \`node.worldMatrix\`: the TRS composition, in the allocator's Float32Array. */
template <class Node>
[[nodiscard]] js::F32Array node_world_matrix(const std::shared_ptr<Node>& owner) {
    const SceneNode& node = *owner;
    const auto world = upstream::trs_matrix(upstream::TrsLanes64{
        .rotation = node.rotation,
        .scaling = node.scaling,
        .position = node.position,
        .has_rotation_quaternion = true,
        .rotation_quaternion = node.rotation_quaternion});
    return js::F32Array(world.begin(), world.end());
}
} // namespace splat_stream`;
}

/** The generated library header: every reached function over its records. */
export function splatStreamLibraryHeader(context: LoweringContext): string {
    const model = splatStreamLibraryModel(context);
    const { declarations, definitions } = model.lower(applicationRoots(model));
    const emitted = [
        ...SPLAT_STREAM_CORE_RECORDS,
        ...SPLAT_STREAM_TRANSPORT_RECORDS,
        ...libraryRecords.map((spec) => spec.pinned[0]!),
        ...model.literalRecords(),
    ].filter(
        (name, index, names) =>
            names.indexOf(name) === index && !model.record(name).spec.native,
    );
    const structs = model.structs(emitted);
    const includes = [
        "bblite/pinned_records.hpp",
        "bblite/gpu.hpp",
        "bblite/splat_stream_platform.hpp",
        "bblite/splat_stream_runtime.hpp",
        "bblite/upstream/camera_math.hpp",
        "bblite/upstream/pinned_world_transform.hpp",
        "bblite/upstream/renderer_plan.hpp",
        ...model.includes,
    ];
    return `#pragma once
// ${context.provenance(LOAD, "loadGaussianSplatStream")}
${includes.map((header) => `#include <${header}>`).join("\n")}
#include <array>
#include <cmath>
#include <string>
#include <utility>
#include <vector>

namespace bbl {
namespace splat_stream {
struct DrawBatch;
} // namespace splat_stream
${structs}
${drawBatchStruct(model)}
${nativePrelude(context)}
${declarations}
${definitions}
} // namespace bbl
`;
}
