/**
 * The pin's MeshLoD library as native records, and its bodies lowered over
 * them by `PinnedRecordModel`.
 *
 * The synchronous core is lowered whole: the error records
 * (`mesh-lod-errors.ts`), the container parser (`mesh-lod-format.ts`), the
 * page decoder (`mesh-lod-page-decoder.ts`), the selection math and the CPU
 * selector (`mesh-lod-selection-math.ts`, `mesh-lod-selection-cpu.ts`) and
 * the caches (`mesh-lod-cache.ts`) are the pin's own statements over structs
 * emitted from the pin's own declarations.
 */
import ts from "typescript";
import { type LoweringContext } from "./context.js";
import {
    type CallAdapter,
    type PinnedCallable,
    PinnedRecordModel,
    type RecordSpec,
} from "./pinned-record-lowerer.js";
import {
    libraryRecordSchema,
    type LoweredRecordFamily,
} from "./library-record-schema.js";
import {
    LIBRARY_RUNTIME_HEADER,
    libraryEngineRecords,
} from "./library-runtime.js";
import {
    functionOf as fn,
    nativeObject,
    optionalOf as optional,
    promiseOf as promise,
    reads,
    recordScalars,
    spelled,
    typedU8,
} from "./record-shapes.js";

const ERRORS = "src/mesh-lod/mesh-lod-errors.ts";
const FORMAT = "src/mesh-lod/mesh-lod-format.ts";
const PAGE_DECODER = "src/mesh-lod/mesh-lod-page-decoder.ts";
const SELECTION_MATH = "src/mesh-lod/mesh-lod-selection-math.ts";
const SELECTION_CPU = "src/mesh-lod/mesh-lod-selection-cpu.ts";
const CACHE = "src/mesh-lod/mesh-lod-cache.ts";

/** The pinned modules the synchronous core lowers. */
export const MESH_LOD_CORE_MODULES = [
    ERRORS,
    FORMAT,
    PAGE_DECODER,
    SELECTION_MATH,
    SELECTION_CPU,
    CACHE,
] as const;

const { number, string, void: none } = recordScalars;

/** The core's own records, emitted from the pin's declarations, in emission order. */
export const MESH_LOD_CORE_SPECS: readonly RecordSpec[] = [
    {
        // An Error the library builds and then fills (`MeshLoDErrorMutable`).
        pinned: ["MeshLoDError", "MeshLoDErrorMutable"],
        cpp: "MeshLoDError",
        reference: true,
    },
    {
        pinned: ["MeshLoDErrorContext"],
        cpp: "MeshLoDErrorContext",
        reference: false,
    },
    // The container's parsed records: read-only values the pin never
    // compares by identity.
    { pinned: ["MeshLoDHeader"], cpp: "MeshLoDHeader", reference: false },
    {
        pinned: ["MeshLoDSectionEntry"],
        cpp: "MeshLoDSectionEntry",
        reference: false,
    },
    {
        pinned: ["MeshLoDProvenance"],
        cpp: "MeshLoDProvenance",
        reference: false,
    },
    { pinned: ["MeshLoDGroup"], cpp: "MeshLoDGroup", reference: false },
    { pinned: ["MeshLoDCluster"], cpp: "MeshLoDCluster", reference: false },
    {
        pinned: ["MeshLoDHierarchyNode"],
        cpp: "MeshLoDHierarchyNode",
        reference: false,
    },
    {
        pinned: ["MeshLoDPageRecord"],
        cpp: "MeshLoDPageRecord",
        reference: false,
    },
    {
        pinned: ["ParsedMeshLoDContainer"],
        cpp: "ParsedMeshLoDContainer",
        reference: true,
    },
    { pinned: ["MeshLoDMetadata"], cpp: "MeshLoDMetadata", reference: false },
    { pinned: ["Reader"], cpp: "MeshLoDReader", reference: true },
    {
        pinned: ["DecodedMeshLoDPage"],
        cpp: "DecodedMeshLoDPage",
        reference: false,
    },
    // The browser's `meshopt_decoder.js` is meshoptimizer's decoder built to
    // WebAssembly; natively it is the same library (platform:meshopt).
    nativeObject(["MeshoptDecoderModule"], "pal::MeshoptDecoder", [
        ["ready", reads(promise(none), (owner) => `${owner}.ready()`)],
        [
            "decodeGltfBuffer",
            spelled(
                fn(
                    [
                        typedU8,
                        number,
                        number,
                        typedU8,
                        string,
                        optional(string),
                    ],
                    none,
                ),
                (owner, args) =>
                    `${owner}.decode_gltf_buffer(${args.join(", ")})`,
            ),
        ],
    ]),
    // Selection.
    { pinned: ["ProjectedSphere"], cpp: "ProjectedSphere", reference: false },
    { pinned: ["MeshLoDCamera"], cpp: "MeshLoDCamera", reference: false },
    {
        pinned: ["MeshLoDSelectionInput"],
        cpp: "MeshLoDSelectionInput",
        reference: false,
    },
    {
        pinned: ["MeshLoDDesiredPage"],
        cpp: "MeshLoDDesiredPage",
        reference: false,
    },
    {
        pinned: ["MeshLoDSelectionResult"],
        cpp: "MeshLoDSelectionResult",
        reference: true,
    },
    // Residency: the arena, the per-page runtime and the CPU page cache are
    // mutated where the pin holds them; the arena lives on the engine's device.
    ...libraryEngineRecords,
    { pinned: ["MeshLoDArena"], cpp: "MeshLoDArena", reference: true },
    {
        pinned: ["MeshLoDEvictionPolicy"],
        cpp: "MeshLoDEvictionPolicy",
        reference: false,
    },
    {
        pinned: ["MeshLoDPageRuntime"],
        cpp: "MeshLoDPageRuntime",
        reference: true,
    },
    { pinned: ["CpuCacheEntry"], cpp: "MeshLoDCpuCacheEntry", reference: true },
    {
        pinned: ["MeshLoDCpuPageCache"],
        cpp: "MeshLoDCpuPageCache",
        reference: true,
    },
];

/**
 * The platform's own work: the browser injects `meshopt_decoder.js`; the
 * native decoder is linked, so its load settles at once.
 */
export const MESH_LOD_CORE_ADAPTERS: ReadonlyMap<string, CallAdapter> = new Map(
    [
        [
            "src/loader-gltf/meshopt-decode.ts#loadMeshoptScript",
            { cpp: () => "bbl::pal::load_meshopt_decoder()" },
        ],
    ],
);

/** The records the core's header declares, in emission order. */
export const MESH_LOD_CORE_RECORDS = MESH_LOD_CORE_SPECS.map(
    (spec) => spec.pinned[0]!,
);

function meshLoDCoreModel(context: LoweringContext): PinnedRecordModel {
    return new PinnedRecordModel(
        context,
        context.store.program.modules([...MESH_LOD_CORE_MODULES]),
        libraryRecordSchema(MESH_LOD_CORE_SPECS, MESH_LOD_CORE_ADAPTERS),
    );
}

/** Every exported function of the synchronous core. */
function meshLoDCoreRoots(model: PinnedRecordModel): PinnedCallable[] {
    const roots: PinnedCallable[] = [];
    for (const module of MESH_LOD_CORE_MODULES) {
        const file = model.typed.sourceFile(module);
        for (const statement of file.statements)
            if (
                ts.isFunctionDeclaration(statement) &&
                statement.name &&
                statement.body &&
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
export function lowerMeshLoDCore(
    context: LoweringContext,
): LoweredRecordFamily {
    const model = meshLoDCoreModel(context);
    const { declarations, definitions } = model.lower(meshLoDCoreRoots(model));
    return {
        structs: model.structs([
            ...MESH_LOD_CORE_RECORDS,
            ...model.literalRecords(),
        ]),
        declarations,
        definitions,
        // The native records' own headers: the decoder and the engine.
        includes: [
            "bblite/pal_meshopt.hpp",
            LIBRARY_RUNTIME_HEADER,
            ...model.includes,
        ],
    };
}
