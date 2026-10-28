/**
 * The pin's MeshLoD library lowered whole: the synchronous core
 * (`mesh-lod-records.ts`), the range source, the request scheduler, the GPU
 * selection, the scene integration, the runtime and the PBR MeshLoD
 * material, as one `PinnedRecordModel` over every lowered library's engine,
 * scene, camera and render-task records (`library-runtime.ts`).
 */
import { type LoweringContext } from "./context.js";
import { pinnedMaxLightsValue } from "./pinned-max-lights.js";
import {
    type MemberSpec,
    PinnedRecordModel,
    type RecordSpec,
} from "./pinned-record-lowerer.js";
import {
    libraryRecordSchema,
    recordModelPerContext,
} from "./library-record-schema.js";
import {
    libraryDrawBatch,
    type LoweredLibrary,
    libraryRuntimeAdapters,
    libraryRuntimeRecords,
    libraryRuntimeUnresolved,
    librarySceneNode,
    sceneMember,
    sceneNodeTransformAdapter,
} from "./library-runtime.js";
import {
    field,
    functionOf as fn,
    members,
    optionalOf as optional,
    promiseOf,
    recordOf as record,
    recordScalars,
} from "./record-shapes.js";
import {
    MESH_LOD_CORE_ADAPTERS,
    MESH_LOD_CORE_MODULES,
    MESH_LOD_CORE_RECORDS,
    MESH_LOD_CORE_SPECS,
} from "./mesh-lod-records.js";

const MESH_LOD = "src/mesh-lod/mesh-lod.ts";
/** The library's scene node. */
const NODE = "MeshLoDInstance";
const { void: none } = recordScalars;

/** The modules whose `?raw` WGSL the library hands WebGPU (GPU selection). */
export const MESH_LOD_SHADER_MODULES = [
    "src/mesh-lod/mesh-lod-selection-gpu.ts",
] as const;

/** The modules the library model lowers beyond the core's. */
const MESH_LOD_LIBRARY_MODULES = [
    "src/mesh-lod/mesh-lod-range-source.ts",
    "src/mesh-lod/mesh-lod-scheduler.ts",
    "src/mesh-lod/mesh-lod-selection-gpu.ts",
    "src/mesh-lod/mesh-lod-scene.ts",
    "src/mesh-lod/mesh-lod-runtime.ts",
    "src/material/pbr/pbr-mesh-lod-compose.ts",
    "src/material/pbr/pbr-mesh-lod-debug.ts",
    "src/material/pbr/pbr-mesh-lod-material.ts",
    "src/material/pbr/pbr-mesh-lod-renderable.ts",
    MESH_LOD,
] as const;

/** The library's public functions a program calls (`LoweredLibrary.roots`). */
const MESH_LOD_APPLICATION_ROOTS: ReadonlyMap<string, string> = new Map(
    [
        "loadMeshLoD",
        "createMeshLoDInstance",
        "addMeshLoDToScene",
        "removeMeshLoDFromScene",
        "setMeshLoDScreenSpaceError",
        "setMeshLoDCacheBudget",
        "setMeshLoDStreamingPaused",
        "setMeshLoDDebugView",
        "setMeshLoDSelectionMode",
        "getMeshLoDDiagnostics",
        "disposeMeshLoDAsset",
    ].map((name) => [name, MESH_LOD] as const),
);

/**
 * The scene members the library keeps (mesh-lod-scene.ts): its registry and
 * the material-rebuild hook it installs beside it.
 */
const meshLoDSceneMembers: readonly (readonly [string, MemberSpec])[] = [
    [
        "_meshLoDRegistry",
        sceneMember(
            "_meshLoDRegistry",
            optional(record("MeshLoDSceneRegistry")),
        ),
    ],
    [
        "_materialRebuild",
        sceneMember(
            "_materialRebuild",
            optional(
                fn(
                    [fn([record("Material")], recordScalars.boolean)],
                    promiseOf(none),
                ),
            ),
        ),
    ],
];

/** A record emitted from its own declaration, under its pinned name. */
const own = (
    pinned: string,
    reference: boolean,
    views: readonly string[] = [],
): RecordSpec => ({ pinned: [pinned, ...views], cpp: pinned, reference });

/**
 * The library's own records, emitted from the pin's declarations: options
 * and inputs as values, the runtime state the pin mutates and shares by
 * identity.
 */
const libraryRecords: readonly RecordSpec[] = [
    // The public surface (mesh-lod.ts).
    own("MeshLoDRequestOptions", false),
    own("MeshLoDLoadOptions", false),
    own("MeshLoDInstanceOptions", false),
    // The live snapshot the asset and its runtime share.
    own("MeshLoDDiagnostics", true, ["MeshLoDMutableDiagnostics"]),
    own("MeshLoDAsset", true),
    // The instance declares its own `visible`; GPU selection reads it as
    // its instance input, by identity.
    librarySceneNode(own(NODE, true, ["MeshLoDGpuInstanceInput"]), [
        "visible",
    ]),
    // The runtime (mesh-lod-runtime.ts).
    own("MeshLoDEffectiveSettings", false),
    own("MeshLoDAssetRuntime", true),
    own("MeshLoDGpuState", true),
    own("MeshLoDFrameSnapshot", true),
    own("MeshLoDStreamSelectionStats", false),
    own("MeshLoDFrameCoordinator", true),
    // Streaming (mesh-lod-scheduler.ts, mesh-lod-range-source.ts).
    own("MeshLoDPageDemand", false),
    own("MeshLoDPageRequest", true),
    own("MeshLoDSchedulerTimers", false),
    own("MeshLoDSchedulerCallbacks", false),
    own("MeshLoDSchedulerConfig", false),
    own("MeshLoDRequestScheduler", true),
    {
        // The URL source reports its transfer through getters.
        ...own("MeshLoDRangeSource", true),
        accessors: new Set(["totalBytes", "completeBytes", "downloadedBytes"]),
    },
    // GPU selection (mesh-lod-selection-gpu.ts).
    own("MeshLoDGpuSelectionParams", false),
    own("MeshLoDGpuSelectionModelInput", false),
    own("MeshLoDGpuSelectedPair", false),
    own("MeshLoDGpuSelectionModelResult", true),
    own("MeshLoDGpuExpansionInput", false),
    own("MeshLoDGpuExpansionResult", true),
    own("MeshLoDGpuAssetBuffers", true),
    own("MeshLoDGpuInstanceState", true),
    own("MeshLoDGpuReadback", true),
    own("MeshLoDSelectionPipelines", true),
    own("MeshLoDGpuBatchState", true),
    own("MeshLoDReadbackSlot", true),
    own("MeshLoDReadbackJob", true),
    own("MeshLoDGpuFrameParams", false),
    own("MeshLoDComputeStep", true),
    own("MeshLoDBufferClear", false),
    own("MeshLoDSelectionJob", true),
    own("MeshLoDGpuSelectionHandles", true),
    // One per render-target signature, flushed by the scene pass.
    libraryDrawBatch("MeshLoDUpdateBatch", "mesh_lod", [
        [
            "queue",
            field(fn([record("MeshLoDSelectionJob")], none), "queue_callback"),
        ],
        [
            "addDisposer",
            field(fn([fn([], none)], fn([], none)), "add_disposer_callback"),
        ],
    ]),
    // The scene integration (mesh-lod-scene.ts).
    {
        // The PBR module's per-batch packet, which the pin keeps `unknown`.
        ...own("MeshLoDSceneBatch", true),
        members: members([
            ["_packet", field(optional(record("MeshLoDBatchPacket")))],
        ]),
    },
    own("MeshLoDSceneRegistry", true),
    own("MeshLoDInstanceSelection", false),
    own("MeshLoDCpuInstanceHistory", false),
    // The PBR MeshLoD material (pbr-mesh-lod-*.ts).
    own("MeshLoDShaderFeatures", false),
    own("MeshLoDFallbacks", false),
    own("MeshLoDMaterialState", true),
    own("MeshLoDMaterialTextures", false),
    own("MeshLoDBatchPacket", true),
];

function meshLoDLibraryModel(context: LoweringContext): PinnedRecordModel {
    return new PinnedRecordModel(
        context,
        context.store.program.modules([
            ...MESH_LOD_CORE_MODULES,
            ...MESH_LOD_LIBRARY_MODULES,
        ]),
        {
            ...libraryRecordSchema(
                [
                    ...libraryRuntimeRecords(meshLoDSceneMembers),
                    ...MESH_LOD_CORE_SPECS,
                    ...libraryRecords,
                ],
                new Map([
                    ...MESH_LOD_CORE_ADAPTERS,
                    ...libraryRuntimeAdapters,
                    sceneNodeTransformAdapter(NODE),
                ]),
            ),
            // The program's calls; the library's own internals stay in its
            // modules' detail namespaces.
            exported: new Set(
                [...MESH_LOD_APPLICATION_ROOTS].map(
                    ([name, module]) => `${module}#${name}`,
                ),
            ),
            // The composed shader's light loop bound.
            moduleValues: new Map([pinnedMaxLightsValue(context)]),
            unresolved: new Map(libraryRuntimeUnresolved),
        },
    );
}

/** The lowered library: its public surface and its header (`loweredLibraryHeader`). */
export const MESH_LOD_LIBRARY: LoweredLibrary = {
    provenance: [MESH_LOD, "loadMeshLoD"],
    roots: MESH_LOD_APPLICATION_ROOTS,
    records: [
        "MeshLoDAsset",
        NODE,
        "MeshLoDMetadata",
        "MeshLoDDiagnostics",
        "MeshLoDLoadOptions",
        "MeshLoDRequestOptions",
        "MeshLoDInstanceOptions",
    ],
    node: NODE,
    model: recordModelPerContext(meshLoDLibraryModel),
    emitted: [
        ...MESH_LOD_CORE_RECORDS,
        ...libraryRecords.map((spec) => spec.pinned[0]!),
    ],
    batch: ["MeshLoDUpdateBatch", "mesh-lod-selection-gpu.ts"],
    includes: ["bblite/pal_meshopt.hpp"],
};
