/**
 * The pin's streamed Gaussian-splat library lowered whole: the synchronous
 * core and the transport (`splat-stream-records.ts`), the GPU state and
 * passes (`splat-stream-gpu.ts`), the renderable (`splat-stream-material.ts`)
 * and the loader that ties them to an engine and a scene
 * (`load-gaussian-splat-stream.ts`), as one `PinnedRecordModel`.
 *
 * The pin's own engine, scene, camera and render-task objects are every
 * lowered library's (`library-runtime.ts`); the stream is a scene node whose
 * TRS triple the pin's world-matrix composition and Euler proxy read.
 */
import { type LoweringContext } from "./context.js";
import {
    type CallAdapter,
    PinnedRecordModel,
    type RecordSpec,
} from "./pinned-record-lowerer.js";
import {
    SPLAT_STREAM_CORE_MODULES,
    SPLAT_STREAM_CORE_RECORDS,
    SPLAT_STREAM_TRANSPORT_MODULES,
    SPLAT_STREAM_TRANSPORT_RECORDS,
    splatStreamTransportSchema,
} from "./splat-stream-records.js";
import {
    field,
    functionOf as fn,
    optionalOf as optional,
    recordOf as record,
    recordScalars,
} from "./record-shapes.js";
import {
    libraryDrawBatch,
    type LoweredLibrary,
    libraryRuntimeAdapters,
    libraryRuntimeRecords,
    libraryRuntimeUnresolved,
    librarySceneNode,
    RUNTIME,
    sceneNodeTransformAdapter,
} from "./library-runtime.js";
import { recordModelPerContext } from "./library-record-schema.js";

const LOAD = "src/loader-splat-stream/load-gaussian-splat-stream.ts";
/** The library's scene node. */
const NODE = "GaussianSplatStream";
const GPU = "src/loader-splat-stream/splat-stream-gpu.ts";
const MATERIAL = "src/loader-splat-stream/splat-stream-material.ts";

/** The library modules that import run-time WGSL. */
export const SPLAT_STREAM_SHADER_MODULES = [GPU, MATERIAL] as const;
const SIGNATURE = "src/engine/render-target-signature.ts";

const GPS = "src/gaussian-point-splatting/gaussian-point-splatting.ts";
export const GPS_PASS = "src/gaussian-point-splatting/gps-pass.ts";
/** The point renderer's modules (gaussian-point-splatting/*). */
const GPS_MODULES = [
    "src/gaussian-point-splatting/gps-state.ts",
    "src/gaussian-point-splatting/gps-shaders.ts",
    "src/gaussian-point-splatting/gps-scene-depth.ts",
    "src/gaussian-point-splatting/gps-reproject.ts",
    GPS_PASS,
    "src/gaussian-point-splatting/gps-suppression.ts",
    "src/gaussian-point-splatting/gps-runtime.ts",
    GPS,
] as const;

/** The modules the library model lowers beyond the core's. */
const SPLAT_STREAM_LIBRARY_MODULES = [
    GPU,
    MATERIAL,
    LOAD,
    SIGNATURE,
    ...GPS_MODULES,
] as const;

const { boolean, void: none } = recordScalars;

/**
 * gps-pass.ts instruments the pin's frame graph (a task's `execute`, its
 * encoder's `beginRenderPass`, a proxy over the pass). Natively the
 * renderer is the frame graph: its scene pass reports whether it drew
 * and pauses for a library's GPU work, resuming with load
 * (library_runtime.hpp, both backends).
 */
const gpsPassAdapters: readonly (readonly [string, CallAdapter])[] = (
    [
        ["installGpsPasses", "gps_install_passes"],
        ["gpsRefreshPasses", "gps_refresh_passes"],
        ["gpsRenderTask", "gps_render_task"],
        ["gpsDefersDraw", "gps_defers_draw"],
        ["gpsPassHasDraws", "gps_pass_has_draws"],
        ["gpsWithPassDepth", "gps_with_pass_depth"],
    ] as const
).map(([pinned, native]) => [
    `${GPS_PASS}#${pinned}`,
    {
        // Every argument the call passes (`isRendering` is optional).
        cpp: (argument, call) =>
            `${RUNTIME}::${native}(${(call.arguments ?? []).map((_, index) => argument(index)).join(", ")})`,
    },
]);

/** The point renderer's records, each its pinned declaration (gaussian-point-splatting/*). */
const gpsRecords: readonly RecordSpec[] = [
    // A point renderer's static target: its pinned declaration. No lowered
    // module builds one, so a caller holds only streams.
    librarySceneNode({
        pinned: ["GaussianSplattingMesh"],
        cpp: "GaussianSplattingMesh",
        reference: true,
        omit: new Map([
            ["_worker", "only the classic mesh's own sort reads its worker"],
        ]),
    }),
    {
        pinned: ["GaussianSplattingGpu"],
        cpp: "GaussianSplattingGpu",
        reference: true,
    },
    {
        pinned: ["GaussianPointSplatting"],
        cpp: "GaussianPointSplatting",
        reference: true,
        accessors: new Set(["progress"]),
    },
    ...[
        "GaussianPointSplattingProgress",
        "GpsAccumulation",
        "GpsSceneDepth",
        "GpsReprojectionTarget",
    ].map((name): RecordSpec => ({
        pinned: [name],
        cpp: name,
        reference: true,
    })),
    {
        // What a program passes `enableGaussianPointSplatting`, field by field.
        pinned: ["GaussianPointSplattingOptions"],
        cpp: "GaussianPointSplattingOptions",
        reference: false,
    },
    ...(
        [
            ["gps-suppression", "Candidate", "GpsSuppressionCandidate"],
            ["gps-suppression", "StaticWork", "GpsStaticWork"],
            ["gps-suppression", "Tracker", "GpsSuppressionTracker"],
            ["gps-reproject", "History", "GpsReprojectionHistory"],
            ["gps-reproject", "Pipelines", "GpsReprojectionPipelines"],
            ["gps-runtime", "Pipelines", "GpsPipelines"],
            ["gps-runtime", "PixelBuffers", "GpsPixelBuffers"],
            ["gps-runtime", "SplatBuffers", "GpsSplatBuffers"],
            ["gps-runtime", "Readback", "GpsReadback"],
            ["gps-runtime", "ViewState", "GpsViewState"],
            ["gps-runtime", "DeviceCache", "GpsDeviceCache"],
        ] as const
    ).map(([module, pinned, cpp]): RecordSpec => ({
        // Qualified: several of these names are declared by other modules too.
        pinned: [`src/gaussian-point-splatting/${module}.ts#${pinned}`],
        cpp,
        reference: true,
    })),
];
/** The library's own records, emitted from the pin's declarations. */
const libraryRecords: readonly RecordSpec[] = [
    libraryDrawBatch("SplatStreamDrawBatch", "splat_stream", [
        ["passGpu", field(record("SplatStreamPassGpu"), "pass_gpu")],
        [
            "queue",
            field(fn([record("PendingProjection")], none), "queue_callback"),
        ],
        [
            "takeBootstrapSignal",
            field(
                fn([], optional({ kind: "promise", value: boolean })),
                "take_bootstrap_signal_callback",
            ),
        ],
    ]),
    librarySceneNode({ pinned: [NODE], cpp: NODE, reference: true }),
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
    ...gpsRecords,
];

/** The library's record model: the transport's schema with the library's own records. */
function splatStreamLibraryModel(context: LoweringContext): PinnedRecordModel {
    const transport = splatStreamTransportSchema(true);
    return new PinnedRecordModel(
        context,
        context.store.program.modules([
            ...SPLAT_STREAM_CORE_MODULES,
            ...SPLAT_STREAM_TRANSPORT_MODULES,
            ...SPLAT_STREAM_LIBRARY_MODULES,
        ]),
        {
            ...transport,
            records: [
                ...transport.records,
                ...libraryRuntimeRecords(),
                ...libraryRecords,
            ],
            adapters: new Map([
                ...transport.adapters,
                ...libraryRuntimeAdapters,
                ...gpsPassAdapters,
                sceneNodeTransformAdapter(NODE),
            ]),
            unresolved: new Map(libraryRuntimeUnresolved),
        },
    );
}

const COLLISION = "src/collision/splat-voxel-collision.ts";

/** The lowered library: its public surface and its header (`loweredLibraryHeader`). */
export const SPLAT_STREAM_LIBRARY: LoweredLibrary = {
    provenance: [LOAD, "loadGaussianSplatStream"],
    roots: new Map([
        ["loadGaussianSplatStream", LOAD],
        ["attachGaussianSplatStream", LOAD],
        ["disposeGaussianSplatStream", LOAD],
        ["loadSplatVoxelCollision", COLLISION],
        ["moveSplatVoxelCamera", COLLISION],
        ["enableGaussianPointSplatting", GPS],
        ["disableGaussianPointSplatting", GPS],
    ]),
    records: [
        NODE,
        "GaussianSplatStreamStats",
        "GaussianSplatStreamOptions",
        "GaussianPointSplatting",
        "GaussianPointSplattingOptions",
        "GaussianPointSplattingProgress",
    ],
    node: NODE,
    model: recordModelPerContext(splatStreamLibraryModel),
    emitted: [
        ...SPLAT_STREAM_CORE_RECORDS,
        ...SPLAT_STREAM_TRANSPORT_RECORDS,
        ...libraryRecords.map((spec) => spec.pinned[0]!),
    ],
    batch: ["SplatStreamDrawBatch", "splat-stream-gpu.ts"],
    includes: ["bblite/upstream/renderer_plan.hpp"],
};
