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
import { PinnedRecordModel, type RecordSpec } from "./pinned-record-lowerer.js";
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

/** The modules the library model lowers beyond the core's. */
const SPLAT_STREAM_LIBRARY_MODULES = [GPU, MATERIAL, LOAD, SIGNATURE] as const;

const { boolean, void: none } = recordScalars;
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
    ]),
    records: [NODE, "GaussianSplatStreamStats", "GaussianSplatStreamOptions"],
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
