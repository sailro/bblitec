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
import { webgpuFlagNamespaces } from "../webgpu-flags.js";

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

/** The splat-stream record model over the pinned synchronous core. */
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

const REQUESTS = "src/loader-splat-stream/splat-stream-requests.ts";
const COLLISION = "src/collision/splat-voxel-collision.ts";

/** The pinned modules the transport adds to the core: requests and collision. */
export const SPLAT_STREAM_TRANSPORT_MODULES = [REQUESTS, COLLISION] as const;

const number: RecordShape = { kind: "number" };
const flag: RecordShape = { kind: "boolean" };
const none: RecordShape = { kind: "void" };
const error: RecordShape = { kind: "error" };
const bytes: RecordShape = { kind: "typed", element: "u8" };
const record = (name: string): RecordShape => ({ kind: "record", name });
const optional = (shape: RecordShape): RecordShape => ({
    kind: "optional",
    value: shape,
});
const promise = (value: RecordShape): RecordShape => ({
    kind: "promise",
    value,
});
const fn = (
    parameters: readonly RecordShape[],
    result: RecordShape,
): RecordShape => ({ kind: "function", parameters, result });
const member = (
    shape: RecordShape,
    native: (owner: string, args: readonly string[]) => string,
): MemberSpec => ({ shape, access: (owner) => owner, call: native });
const read = (shape: RecordShape, native: string): MemberSpec => ({
    shape,
    access: (owner) => `${PLATFORM}::${native}(${owner})`,
});
/** A platform object: a handle to state the platform defines. */
const platformObject = (
    pinned: readonly string[],
    state: string,
    handle: string,
    entries: readonly (readonly [string, MemberSpec])[],
): RecordSpec => ({
    pinned,
    cpp: `splat_stream_platform::${state}`,
    handle: `splat_stream_platform::${handle}`,
    reference: true,
    native: true,
    members: new Map(entries),
});
/** A platform dictionary the pin builds as a literal. */
const dictionary = (
    pinned: string,
    cpp: string,
    entries: readonly (readonly [string, RecordShape])[],
): RecordSpec => ({
    pinned: [pinned],
    cpp: `splat_stream_platform::${cpp}`,
    reference: false,
    native: true,
    members: new Map(entries.map(([name, shape]) => [name, { shape }])),
});

const fetchFunction = fn(
    [string, optional(record("RequestInit"))],
    promise(record("Response")),
);

const transportPlatformRecords: readonly RecordSpec[] = [
    platformObject(["AbortSignal"], "AbortSignalState", "AbortSignal", [
        ["aborted", read(flag, "abort_signal_aborted")],
        ["reason", read(error, "abort_signal_reason")],
        [
            "addEventListener",
            member(
                fn(
                    [
                        string,
                        fn([], none),
                        optional(record("AddEventListenerOptions")),
                    ],
                    none,
                ),
                (owner, [type, listener, options]) =>
                    `${PLATFORM}::abort_signal_add_event_listener(${owner}, ${type}, ${listener}, ${options ?? "std::nullopt"})`,
            ),
        ],
        [
            "removeEventListener",
            member(
                fn([string, fn([], none)], none),
                (owner, [type, listener]) =>
                    `${PLATFORM}::abort_signal_remove_event_listener(${owner}, ${type}, ${listener})`,
            ),
        ],
    ]),
    dictionary("AddEventListenerOptions", "AddEventListenerOptions", [
        ["once", optional(flag)],
    ]),
    platformObject(
        ["AbortController"],
        "AbortControllerState",
        "AbortController",
        [
            ["signal", read(record("AbortSignal"), "abort_controller_signal")],
            [
                "abort",
                member(
                    fn([optional(error)], none),
                    (owner, [reason]) =>
                        `${PLATFORM}::abort_controller_abort(${owner}, ${reason ?? "bbl::js::Error{}"})`,
                ),
            ],
        ],
    ),
    dictionary("RequestInit", "RequestInit", [
        ["signal", optional(record("AbortSignal"))],
    ]),
    platformObject(["Response"], "ResponseState", "Response", [
        ["ok", read(flag, "response_ok")],
        ["status", read(number, "response_status")],
        ["url", read(string, "response_url")],
        // The headers are the response's own.
        ["headers", { shape: record("Headers"), access: (owner) => owner }],
        ["body", read(optional(record("ReadableStream")), "response_body")],
    ]),
    platformObject(["Headers"], "ResponseState", "Response", [
        [
            "get",
            member(
                fn([string], optional(string)),
                (owner, [name]) =>
                    `${PLATFORM}::response_header(${owner}, ${name})`,
            ),
        ],
    ]),
    platformObject(
        ["ReadableStream"],
        "ReadableStreamState",
        "ReadableStream",
        [
            [
                "cancel",
                member(
                    fn([], promise(none)),
                    (owner) => `${PLATFORM}::readable_stream_cancel(${owner})`,
                ),
            ],
            [
                "getReader",
                member(
                    fn([], record("ReadableStreamDefaultReader")),
                    (owner) =>
                        `${PLATFORM}::readable_stream_get_reader(${owner})`,
                ),
            ],
        ],
    ),
    platformObject(["ReadableStreamDefaultReader"], "ReaderState", "Reader", [
        [
            "read",
            member(
                fn([], promise(record("ReadableStreamReadResult"))),
                (owner) => `${PLATFORM}::reader_read(${owner})`,
            ),
        ],
        [
            "cancel",
            member(
                fn([], promise(none)),
                (owner) => `${PLATFORM}::reader_cancel(${owner})`,
            ),
        ],
        [
            "releaseLock",
            member(
                fn([], none),
                (owner) => `${PLATFORM}::reader_release_lock(${owner})`,
            ),
        ],
    ]),
    {
        // Either arm of `ReadableStreamReadResult<Uint8Array>`.
        pinned: [
            "ReadableStreamReadResult",
            "ReadableStreamReadDoneResult",
            "ReadableStreamReadValueResult",
        ],
        cpp: "splat_stream_platform::ReadResult",
        reference: false,
        native: true,
        members: new Map<string, MemberSpec>([
            ["done", { shape: flag }],
            ["value", { shape: optional(bytes) }],
        ]),
    },
    platformObject(["Blob"], "BlobState", "Blob", [
        [
            "text",
            member(
                fn([], promise(string)),
                (owner) => `${PLATFORM}::blob_text(${owner})`,
            ),
        ],
    ]),
    dictionary("BlobPropertyBag", "BlobPropertyBag", [
        ["type", optional(string)],
    ]),
    platformObject(["ImageBitmap"], "ImageBitmapState", "ImageBitmap", [
        ["width", read(number, "image_bitmap_width")],
        ["height", read(number, "image_bitmap_height")],
        [
            "close",
            member(
                fn([], none),
                (owner) => `${PLATFORM}::image_bitmap_close(${owner})`,
            ),
        ],
    ]),
    dictionary("ImageBitmapOptions", "ImageBitmapOptions", [
        ["premultiplyAlpha", optional(string)],
        ["colorSpaceConversion", optional(string)],
        ["imageOrientation", optional(string)],
    ]),
    platformObject(["TextDecoder"], "TextDecoderState", "TextDecoder", [
        [
            "decode",
            member(
                fn([bytes], string),
                (owner, [input]) =>
                    `${PLATFORM}::text_decoder_decode(${owner}, ${input})`,
            ),
        ],
    ]),
    dictionary("GPUCopyExternalImageSourceInfo", "CopyExternalImageSource", [
        ["source", record("ImageBitmap")],
        ["flipY", optional(flag)],
    ]),
    dictionary("GPUCopyExternalImageDestInfo", "CopyExternalImageDestination", [
        ["texture", record("GPUTexture")],
        ["premultipliedAlpha", optional(flag)],
    ]),
];

/**
 * The device the requests manager uploads through: `gpu-schema.ts`'s, with
 * the queue's typed-array `writeBuffer` and the bitmap upload.
 */
const transportGpuRecords: readonly RecordSpec[] = [
    ...gpuRecords.filter((spec) => spec.pinned[0] !== "GPUQueue"),
    {
        pinned: ["GPUQueue"],
        cpp: "GpuDevice",
        handle: "GpuDeviceHandle",
        reference: true,
        native: true,
        members: new Map<string, MemberSpec>([
            [
                "writeBuffer",
                member(
                    fn(
                        [
                            record("GPUBuffer"),
                            number,
                            { kind: "typed", element: "f32" },
                        ],
                        none,
                    ),
                    (owner, [buffer, offset, data]) =>
                        `[&](const auto& written) { ${owner}->write_buffer(${buffer}, ${offset}, written.buffer(), static_cast<double>(written.byte_offset()), static_cast<double>(written.byte_length())); }(${data})`,
                ),
            ],
            [
                "copyExternalImageToTexture",
                member(
                    fn(
                        [
                            record("GPUCopyExternalImageSourceInfo"),
                            record("GPUCopyExternalImageDestInfo"),
                            record("GPUExtent3DDict"),
                        ],
                        none,
                    ),
                    (owner, [source, destination, size]) =>
                        `${PLATFORM}::copy_external_image_to_texture(*${owner}, ${source}, ${destination}, ${size})`,
                ),
            ],
        ]),
    },
];

/** The fetch error a transport's retries and preemption carry. */
const rejectWith: MemberSpec = { shape: fn([error], none) };

const transportRecords: readonly RecordSpec[] = [
    ...records.filter(
        (spec) => !gpuRecords.includes(spec) && !platformRecords.includes(spec),
    ),
    ...transportGpuRecords,
    platformRecords[0]!,
    ...transportPlatformRecords,
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
export const SPLAT_STREAM_TRANSPORT_RECORDS = transportRecords
    .filter(
        (spec) =>
            !spec.native &&
            !SPLAT_STREAM_CORE_RECORDS.includes(spec.pinned[0]!),
    )
    .map((spec) => spec.pinned[0]!);

const transportConstructors = new Map<string, CallAdapter>([
    ...constructors,
    [
        "DOMException",
        {
            cpp: (argument) =>
                `${PLATFORM}::dom_exception(${argument(0)}, ${argument(1)})`,
            parameters: [string, string],
        },
    ],
    [
        "AbortController",
        { cpp: () => `${PLATFORM}::abort_controller_create()` },
    ],
    [
        "Blob",
        {
            cpp: (argument) =>
                `${PLATFORM}::blob_create(${argument(0)}, ${argument(1)})`,
            parameters: [
                { kind: "array", element: bytes },
                record("BlobPropertyBag"),
            ],
        },
    ],
    [
        "TextDecoder",
        {
            cpp: (_argument, call) => {
                if ((call.arguments?.length ?? 0) > 0)
                    throw new Error(
                        "The splat-stream TextDecoder is constructed without arguments.",
                    );
                return `${PLATFORM}::text_decoder_create()`;
            },
        },
    ],
]);

/** Platform functions the pin calls: timers, tasks, fetch and image decoding. */
const transportGlobals = new Map<string, CallAdapter>([
    [
        "setTimeout",
        {
            cpp: (argument) =>
                `${PLATFORM}::set_timeout(${argument(0)}, ${argument(1)})`,
            parameters: [fn([], none), number],
        },
    ],
    [
        "clearTimeout",
        {
            cpp: (argument) => `${PLATFORM}::clear_timeout(${argument(0)})`,
            parameters: [number],
        },
    ],
    [
        "queueMicrotask",
        {
            cpp: (argument) => `${PLATFORM}::queue_microtask(${argument(0)})`,
            parameters: [fn([], none)],
        },
    ],
    ["performance.now", { cpp: () => `${PLATFORM}::performance_now()` }],
    [
        // `fetch(url, init)` with a string or a URL object.
        "fetch",
        {
            cpp: (argument) =>
                `${PLATFORM}::fetch(${argument(0)}, ${argument(1)})`,
            parameters: [undefined, record("RequestInit")],
        },
    ],
    [
        "createImageBitmap",
        {
            cpp: (argument) =>
                `${PLATFORM}::create_image_bitmap(${argument(0)}, ${argument(1)})`,
            parameters: [record("Blob"), record("ImageBitmapOptions")],
        },
    ],
]);

const transportGlobalValues = new Map([
    [
        "fetch",
        {
            shape: fetchFunction,
            cpp: `bbl::js::Callback<bbl::js::Promise<${PLATFORM}::Response>(std::string, bbl::js::Nullable<${PLATFORM}::RequestInit>)>([](std::string url, bbl::js::Nullable<${PLATFORM}::RequestInit> init) { return ${PLATFORM}::fetch(url, init ? *init : ${PLATFORM}::RequestInit{}); })`,
        },
    ],
]);

/** The splat-stream record model over the core and its transport. */
export function splatStreamTransportModel(
    context: LoweringContext,
): PinnedRecordModel {
    return new PinnedRecordModel(
        context,
        context.store.program.modules([
            ...SPLAT_STREAM_CORE_MODULES,
            ...SPLAT_STREAM_TRANSPORT_MODULES,
        ]),
        {
            records: transportRecords,
            // `typeof fetch`: the platform's fetch function.
            values: new Map([["fetch", fetchFunction]]),
            adapters,
            constructors: transportConstructors,
            globals: transportGlobals,
            globalValues: transportGlobalValues,
            instanceOf: new Map([
                [
                    "DOMException",
                    (value: string) =>
                        `${PLATFORM}::is_dom_exception(${value})`,
                ],
            ]),
            constants: new Map(
                Object.entries(webgpuFlagNamespaces).flatMap(
                    ([namespace, values]) =>
                        Object.entries(values).map(
                            ([name, value]) =>
                                [`${namespace}.${name}`, value] as const,
                        ),
                ),
            ),
        },
    );
}

/** The exported functions of the transport: the request manager and collision. */
export function splatStreamTransportRoots(
    model: PinnedRecordModel,
): PinnedCallable[] {
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

/** The lowered core and transport: structs, prototypes, definitions and includes. */
export function lowerSplatStreamTransport(context: LoweringContext): {
    readonly structs: string;
    readonly declarations: string;
    readonly definitions: string;
    readonly includes: readonly string[];
} {
    const model = splatStreamTransportModel(context);
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
