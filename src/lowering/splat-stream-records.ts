/**
 * The pin's streamed Gaussian-splat library as native records, and its
 * bodies lowered over them by `PinnedRecordModel`.
 *
 * The synchronous core is lowered whole: option normalization
 * (`splat-stream-types.ts`), manifest and SOG metadata parsing
 * (`splat-stream-meta.ts`), LOD selection (`splat-stream-selection.ts`),
 * the source cache (`splat-stream-cache.ts`) and the GPU ledger
 * (`splat-stream-gpu-ledger.ts`) are the pin's own statements over structs
 * emitted from the pin's own declarations. A parsed document is the
 * runtime's dynamic JSON value.
 *
 * The web platform is `web-platform-schema.ts`'s and the WebGPU objects the
 * cache destroys are `gpu-schema.ts`'s subset, both composed whole.
 */
import ts from "typescript";
import { type LoweringContext } from "./context.js";
import {
    type MemberSpec,
    type PinnedCallable,
    PinnedRecordModel,
    type RecordSchema,
    type RecordSpec,
} from "./pinned-record-lowerer.js";
import {
    libraryRecordSchema,
    type LoweredRecordFamily,
} from "./library-record-schema.js";
import { functionOf as fn } from "./record-shapes.js";

const TYPES = "src/loader-splat-stream/splat-stream-types.ts";
const META = "src/loader-splat-stream/splat-stream-meta.ts";
const SELECTION = "src/loader-splat-stream/splat-stream-selection.ts";
const CACHE = "src/loader-splat-stream/splat-stream-cache.ts";
const LEDGER = "src/loader-splat-stream/splat-stream-gpu-ledger.ts";

/** The pinned modules the synchronous core lowers. */
export const SPLAT_STREAM_CORE_MODULES = [
    TYPES,
    META,
    SELECTION,
    CACHE,
    LEDGER,
] as const;

/**
 * `GaussianSplatStreamOptions`: the core and its transport do not run the
 * loader, whose `_runtime` test seams the library's records type.
 */
function optionsRecord(runtimeSeams: boolean): RecordSpec {
    return {
        pinned: ["GaussianSplatStreamOptions"],
        cpp: "GaussianSplatStreamOptions",
        reference: false,
        ...(runtimeSeams
            ? {}
            : {
                  omit: new Map([
                      [
                          "_runtime",
                          "the runtime seams are the loader's test hooks, typed by the library's records",
                      ],
                  ]),
              }),
    };
}

/** The core's own records, emitted from the pin's declarations, in emission order. */
const coreRecords: readonly RecordSpec[] = [
    {
        pinned: ["NormalizedSplatStreamOptions"],
        cpp: "NormalizedSplatStreamOptions",
        reference: false,
    },
    {
        // The parser's mutable working record is the representation it
        // retains.
        pinned: ["StreamRepresentation", "RawRepresentation"],
        cpp: "StreamRepresentation",
        reference: true,
    },
    { pinned: ["StreamBound"], cpp: "StreamBound", reference: true },
    {
        // `StreamBranch | StreamLeaf`: one struct, discriminated by `kind`.
        pinned: ["StreamTreeNode", "StreamLeaf", "StreamBranch"],
        cpp: "StreamTreeNode",
        reference: true,
        bases: ["StreamBound"],
    },
    { pinned: ["StreamSource"], cpp: "StreamSource", reference: true },
    { pinned: ["StreamManifest"], cpp: "StreamManifest", reference: true },
    {
        pinned: ["SogV2SourceMetadata"],
        cpp: "SogV2SourceMetadata",
        reference: true,
    },
    { pinned: ["SogImageInfo"], cpp: "SogImageInfo", reference: true },
    { pinned: ["SogInterval"], cpp: "SogInterval", reference: true },
    { pinned: ["FrustumPlane"], cpp: "FrustumPlane", reference: true },
    {
        pinned: ["CandidatePlanOptions"],
        cpp: "CandidatePlanOptions",
        reference: false,
    },
    {
        pinned: ["StreamSelectionInput"],
        cpp: "StreamSelectionInput",
        reference: false,
        bases: ["CandidatePlanOptions"],
    },
    { pinned: ["StreamSelection"], cpp: "StreamSelection", reference: true },
    {
        pinned: ["StreamSelectionPlan"],
        cpp: "StreamSelectionPlan",
        reference: true,
    },
    { pinned: ["VisibleLeaf"], cpp: "VisibleLeaf", reference: true },
    {
        pinned: ["src/loader-splat-stream/splat-stream-selection.ts#Candidate"],
        cpp: "SelectionCandidate",
        reference: true,
    },
    {
        pinned: ["SplatSourceGpuResources"],
        cpp: "SplatSourceGpuResources",
        reference: true,
    },
    {
        pinned: ["SplatSourceCacheEntry"],
        cpp: "SplatSourceCacheEntry",
        reference: true,
    },
    { pinned: ["SplatSourceCache"], cpp: "SplatSourceCache", reference: true },
    {
        pinned: ["SplatStreamGpuLedger"],
        cpp: "SplatStreamGpuLedger",
        reference: true,
    },
];

/** The records the core's header declares, in emission order. */
export const SPLAT_STREAM_CORE_RECORDS = [
    "GaussianSplatStreamOptions",
    ...coreRecords.map((spec) => spec.pinned[0]!),
];

/** The splat-stream record model over the pinned synchronous core. */
function splatStreamCoreModel(context: LoweringContext): PinnedRecordModel {
    return new PinnedRecordModel(
        context,
        context.store.program.modules([...SPLAT_STREAM_CORE_MODULES]),
        libraryRecordSchema([optionsRecord(false), ...coreRecords]),
    );
}

/**
 * Exported core functions over the engine, which the stream's integration
 * lowers with the engine's records: the retirement hook fences source
 * destruction behind the engine's next submission.
 */
const ENGINE_BOUND: ReadonlySet<string> = new Set([
    `${CACHE}#createSplatSourceRetirement`,
]);

/** Every exported function of the synchronous core. */
function splatStreamCoreRoots(model: PinnedRecordModel): PinnedCallable[] {
    const roots: PinnedCallable[] = [];
    for (const module of SPLAT_STREAM_CORE_MODULES) {
        const file = model.typed.sourceFile(module);
        for (const statement of file.statements)
            if (
                ts.isFunctionDeclaration(statement) &&
                statement.name &&
                statement.body &&
                !ENGINE_BOUND.has(`${module}#${statement.name.text}`) &&
                ts
                    .getModifiers(statement)
                    ?.some(
                        (modifier) =>
                            modifier.kind === ts.SyntaxKind.ExportKeyword,
                    )
            )
                roots.push(statement);
    }
    return roots;
}

/** The lowered synchronous core. */
export function lowerSplatStreamCore(
    context: LoweringContext,
): LoweredRecordFamily {
    const model = splatStreamCoreModel(context);
    const { declarations, definitions } = model.lower(
        splatStreamCoreRoots(model),
    );
    return {
        structs: model.structs([
            ...SPLAT_STREAM_CORE_RECORDS,
            ...model.literalRecords(),
        ]),
        declarations,
        definitions,
        includes: [...model.includes],
    };
}

const REQUESTS = "src/loader-splat-stream/splat-stream-requests.ts";
const COLLISION = "src/collision/splat-voxel-collision.ts";

/** The pinned modules the transport adds to the core: requests and collision. */
export const SPLAT_STREAM_TRANSPORT_MODULES = [REQUESTS, COLLISION] as const;

/** The fetch error a transport's retries and preemption carry. */
const rejectWith: MemberSpec = {
    shape: fn([{ kind: "error" }], { kind: "void" }),
};

/** The transport's own records, beyond the core's, in emission order. */
const transportRecords: readonly RecordSpec[] = [
    {
        pinned: ["SplatSourceRequest"],
        cpp: "SplatSourceRequest",
        reference: true,
    },
    {
        pinned: ["PreparedSplatSource"],
        cpp: "PreparedSplatSource",
        reference: true,
    },
    {
        pinned: ["SplatStreamRequestDependencies"],
        cpp: "SplatStreamRequestDependencies",
        reference: false,
    },
    {
        pinned: ["SplatStreamRequestManager"],
        cpp: "SplatStreamRequestManager",
        reference: true,
        accessors: new Set([
            "cpuBytes",
            "fetchedBytes",
            "pendingRequests",
            "queuedFiles",
            "disposed",
        ]),
    },
    {
        pinned: ["RequestJob"],
        cpp: "SplatRequestJob",
        reference: true,
        members: new Map([["reject", rejectWith]]),
    },
    {
        pinned: ["Waiter"],
        cpp: "SplatRequestWaiter",
        reference: true,
        members: new Map([["reject", rejectWith]]),
    },
    {
        pinned: ["CpuWaiter"],
        cpp: "SplatCpuWaiter",
        reference: true,
        members: new Map([["reject", rejectWith]]),
    },
    { pinned: ["FetchedBody"], cpp: "SplatFetchedBody", reference: true },
    {
        pinned: ["SplatGpuBudgetPressureError"],
        cpp: "SplatGpuBudgetPressureError",
        reference: true,
    },
    {
        pinned: ["TransientHttpError"],
        cpp: "TransientHttpError",
        reference: true,
    },
    {
        pinned: ["PreparationPreemptedError"],
        cpp: "PreparationPreemptedError",
        reference: true,
    },
    {
        pinned: ["ExclusiveAdmissionRequired"],
        cpp: "ExclusiveAdmissionRequired",
        reference: true,
    },
    {
        pinned: ["SplatVoxelCollision"],
        cpp: "SplatVoxelCollision",
        reference: true,
    },
];

/** The records the transport's header declares beyond the core's, in emission order. */
export const SPLAT_STREAM_TRANSPORT_RECORDS = transportRecords.map(
    (spec) => spec.pinned[0]!,
);

/**
 * The schema of the core and its transport. With `runtimeSeams`, the
 * options carry the loader's `_runtime`, which a caller's records type.
 */
export function splatStreamTransportSchema(runtimeSeams = false): RecordSchema {
    return libraryRecordSchema([
        optionsRecord(runtimeSeams),
        ...coreRecords,
        ...transportRecords,
    ]);
}

/** The exported functions of the transport: the request manager and collision. */
function splatStreamTransportRoots(model: PinnedRecordModel): PinnedCallable[] {
    return [
        model.functionDeclaration(REQUESTS, "createSplatStreamRequestManager"),
        model.functionDeclaration(COLLISION, "loadSplatVoxelCollision"),
        model.functionDeclaration(COLLISION, "parseSplatVoxelCollision"),
        model.functionDeclaration(COLLISION, "moveSplatVoxelCamera"),
        model.classMember(
            REQUESTS,
            "SplatGpuBudgetPressureError",
            "constructor",
            "constructor",
        ),
    ];
}

/** The lowered core and transport. */
export function lowerSplatStreamTransport(
    context: LoweringContext,
): LoweredRecordFamily {
    const model = new PinnedRecordModel(
        context,
        context.store.program.modules([
            ...SPLAT_STREAM_CORE_MODULES,
            ...SPLAT_STREAM_TRANSPORT_MODULES,
        ]),
        splatStreamTransportSchema(),
    );
    const { declarations, definitions } = model.lower([
        ...splatStreamCoreRoots(model),
        ...splatStreamTransportRoots(model),
    ]);
    return {
        structs: model.structs([
            ...SPLAT_STREAM_CORE_RECORDS,
            ...SPLAT_STREAM_TRANSPORT_RECORDS,
            ...model.literalRecords(),
        ]),
        declarations,
        definitions,
        includes: [...model.includes],
    };
}
