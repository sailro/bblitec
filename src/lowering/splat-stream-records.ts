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
 * The platform boundaries, each named by the declaration it replaces, are
 * `bblite/splat_stream_platform.hpp`'s: URL parsing and the abort signal an
 * option carries. WebGPU objects the cache destroys are `gpu-schema.ts`'s.
 */
import ts from "typescript";
import { type LoweringContext } from "./context.js";
import {
    type CallAdapter,
    type MemberSpec,
    type PinnedCallable,
    PinnedRecordModel,
    type RecordShape,
    type RecordSpec,
} from "./pinned-record-lowerer.js";
import { gpuRecords } from "./gpu-schema.js";

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

const PLATFORM = "bbl::splat_stream_platform";
const string: RecordShape = { kind: "string" };

const platformRecords: readonly RecordSpec[] = [
    {
        // WHATWG URL: parsed, resolved and serialized by the platform.
        pinned: ["URL"],
        cpp: "splat_stream_platform::UrlState",
        handle: "splat_stream_platform::Url",
        reference: true,
        native: true,
        members: new Map<string, MemberSpec>([
            [
                "href",
                {
                    shape: string,
                    access: (owner) => `${PLATFORM}::url_href(${owner})`,
                },
            ],
            [
                "protocol",
                {
                    shape: string,
                    access: (owner) => `${PLATFORM}::url_protocol(${owner})`,
                },
            ],
            [
                "pathname",
                {
                    shape: string,
                    access: (owner) => `${PLATFORM}::url_pathname(${owner})`,
                    assign: (owner, value) =>
                        `${PLATFORM}::url_set_pathname(${owner}, ${value})`,
                },
            ],
        ]),
    },
    {
        pinned: ["AbortSignal"],
        cpp: "splat_stream_platform::AbortSignalState",
        handle: "splat_stream_platform::AbortSignal",
        reference: true,
        native: true,
        members: new Map(),
    },
];

const records: readonly RecordSpec[] = [
    ...gpuRecords,
    ...platformRecords,
    {
        pinned: ["GaussianSplatStreamOptions"],
        cpp: "GaussianSplatStreamOptions",
        reference: false,
        omit: new Map([
            [
                "_runtime",
                "the runtime seams are the pin's test hooks; the native stream runs its platform",
            ],
        ]),
    },
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
    { pinned: ["Candidate"], cpp: "SelectionCandidate", reference: true },
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
export const SPLAT_STREAM_CORE_RECORDS = records
    .filter((spec) => !spec.native)
    .map((spec) => spec.pinned[0]!);

const adapters = new Map<string, CallAdapter>();

const constructors = new Map<string, CallAdapter>([
    [
        "URL",
        {
            cpp: (argument, call) =>
                (call.arguments?.length ?? 0) > 1
                    ? `${PLATFORM}::url_parse(${argument(0)}, ${argument(1)})`
                    : `${PLATFORM}::url_parse(${argument(0)})`,
            parameters: [string, string],
        },
    ],
]);

/** The splat-stream record model over the pinned streaming modules. */
export function splatStreamRecordModel(
    context: LoweringContext,
): PinnedRecordModel {
    return new PinnedRecordModel(
        context,
        context.store.program.modules([...SPLAT_STREAM_CORE_MODULES]),
        {
            records,
            values: new Map(),
            adapters,
            constructors,
        },
    );
}

/** One root of the lowered core: a module function by name. */
export interface SplatStreamRoot {
    readonly module: string;
    readonly name: string;
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
export function splatStreamCoreRoots(
    model: PinnedRecordModel,
): PinnedCallable[] {
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

/** The lowered synchronous core: structs, prototypes, definitions and includes. */
export function lowerSplatStreamCore(context: LoweringContext): {
    readonly structs: string;
    readonly declarations: string;
    readonly definitions: string;
    readonly includes: readonly string[];
} {
    const model = splatStreamRecordModel(context);
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
