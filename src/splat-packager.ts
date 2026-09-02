/**
 * Compiles a Gaussian-splat asset into the row buffer the native runtime reads.
 *
 * `loadSplat` forks on the container (`isPly` / `isPlyCompressedOrSH`) and
 * converts whatever it finds into ONE interchange form: the 32-byte-per-splat
 * row buffer `buildSplatGeometry` consumes. Upstream's own `.splat` files are
 * that buffer written to disk — scene 126's `Halo_Believe.splat` is byte-for-
 * byte what scene 120's `Halo_Believe.ply` parses to — so packaging a `.ply`
 * here produces the same asset a `.splat` scene fetches directly, and the
 * native loader has one layout to read instead of a container zoo.
 *
 * The conversion is the pin EXECUTED, not folded. A PLY header is a
 * stringly-typed property list whose layout varies per exporter, so what must
 * not drift is the VALUE this particular asset parses to, and only running
 * the pin's own parser can promise that. Folding it would re-derive a text
 * parser in C++ that agrees with upstream until the next exporter quirk.
 * `buildSplatGeometry` is the opposite case and stays a fold: fixed math over
 * a fixed layout, where the shape is the contract.
 *
 * Recorded as an adaptation in the scene's `fidelity.json`.
 */

import {
    assertPinnedSync,
    importPinnedModule,
    importPinnedModuleUnasynced,
    installPinnedImportHook,
} from "./pinned-shader-composer.js";
import { javascriptModuleUrl } from "./data-url.js";
import { cachedBakeSync, moduleIdentity } from "./bake-cache.js";
import {
    GAUSSIAN_SPLATTING_EXTENSION,
    type JsonRecord,
} from "./gltf-document.js";

/** The pin's own parse result. `sh` rides along for the SH-capable arms. */
interface ParsedSplat {
    data: ArrayBuffer;
    sh?: Uint8Array;
    shDegree?: number;
}

const pinnedPlyParser = await importPinnedModule<{
    isPly: (data: ArrayBuffer) => boolean;
    isPlyCompressedOrSH: (data: ArrayBuffer) => boolean;
    convertPlyToSplat: (data: ArrayBuffer) => ParsedSplat;
}>("loader-splat/splat-ply-parser.js");

export interface PackagedSplat {
    /** The row buffer, at the pin's own stride. */
    rows: Uint8Array;
}

/**
 * Parses a fetched splat asset into the interchange row buffer.
 *
 * Refuses the two containers this slice does not carry rather than emitting a
 * buffer the renderer would draw wrong: a compressed or SH-bearing PLY needs
 * the pin's second parser and its own SH pipeline, and a `.sog`/`.spz` needs
 * a ZIP/gzip decoder before either.
 */
export function packageSplat(bytes: Uint8Array): PackagedSplat {
    // `assetBytes` hands back a freshly-allocated array, so the common case
    // already owns its whole buffer and slicing it would copy the asset a
    // second time -- multiple megabytes for a splat.
    const data =
        bytes.byteOffset === 0 &&
        bytes.byteLength === bytes.buffer.byteLength
            ? (bytes.buffer as ArrayBuffer)
            : (bytes.buffer.slice(
                  bytes.byteOffset,
                  bytes.byteOffset + bytes.byteLength,
              ) as ArrayBuffer);

    let rowBuffer: ArrayBuffer | Uint8Array;
    if (pinnedPlyParser.isPly(data)) {
        if (pinnedPlyParser.isPlyCompressedOrSH(data)) {
            throw new Error(
                "Compressed or spherical-harmonic PLY splats are not lowered; " +
                    "the reached slice is the plain PLY and .splat row layout.",
            );
        }
        // The pin's text parse over a multi-megabyte PLY is deterministic
        // in (asset bytes, pin); a repeat compile replays the row buffer.
        // The `.splat` fast path below stays uncached — caching a copy of
        // the input would only spend disk on a no-op.
        rowBuffer = cachedBakeSync(
            {
                kind: "splat-ply",
                version: "1",
                module: moduleIdentity(import.meta.url),
                browser: false,
                parameters: {},
                inputs: [bytes],
            },
            () => {
                const parsed = pinnedPlyParser.convertPlyToSplat(data);
                if (parsed.data.byteLength === 0) {
                    throw new Error(
                        "Splat PLY parsed to an empty row buffer (unsupported property layout).",
                    );
                }
                return new Uint8Array(parsed.data);
            },
        );
    } else {
        // A pre-converted `.splat` is already the row layout; the pin takes
        // this same fast path.
        rowBuffer = data;
    }

    // The stride is not re-typed here: `SplatLowerer` reads ROW_LENGTH off
    // the pinned declaration and the generated loader checks the packaged
    // bytes against it, so a moved stride refuses there rather than agreeing
    // with a copy that can drift.
    if (rowBuffer.byteLength === 0) {
        throw new Error("Splat asset carries no splats.");
    }
    return {
        rows:
            rowBuffer instanceof Uint8Array
                ? rowBuffer
                : new Uint8Array(rowBuffer),
    };
}

/**
 * `KHR_gaussian_splatting`, resolved at generation by the pin's own feature.
 *
 * The extension is not a splat container: it is a POINTS-mode primitive whose
 * per-splat ellipsoid rides in custom vertex attributes, and
 * `gltf-feature-gaussian-splatting.ts` converts it into the *same* 32-byte row
 * buffer `packageSplat` above produces — which is what makes this a packaging
 * join rather than a second loader. Two hooks do it:
 *
 * - `preParse` strips every GS primitive out of its mesh (they must not reach
 *   the core mesh pipeline, which has no topology for them) and stashes the
 *   accessor indices on the document;
 * - `applyAsset` reads those accessors and packs the rows, then hands the
 *   scene wiring back as `_sceneSetup`, which calls `attachParsedSplat` once
 *   per primitive and rotates the resulting cloud 180 degrees about Z.
 *
 * Both are pure functions of the document and its binary chunk — no browser
 * API, no device — so generation runs the pin's own module exactly as
 * `dequantizeGeometry` runs `KHR_mesh_quantization`'s hook, and the packaged
 * asset carries the rows instead of the attributes.
 *
 * The one import that cannot run here is `attachParsedSplat`, which builds a
 * GPU mesh and spawns a sort worker. It is redirected to a recorder, so the
 * name, the row buffer and the TRS the pin's own `_sceneSetup` writes are
 * observed rather than restated; everything that executes is still the pin's
 * text.
 */
export interface GltfGaussianSplat {
    /** `${mesh.name ?? "splat"}_${meshIndex}_${primitiveIndex}`, the pin's. */
    name: string;
    /** The pin's 32-byte-per-splat rows, as `buildSplatGeometry` reads them. */
    rows: Uint8Array;
    /** The Euler rotation `_sceneSetup` left on the attached cloud. */
    rotation: readonly [number, number, number];
}

/** The shape the pinned feature's default export must still have. */
interface PinnedGaussianSplattingFeature {
    id: string;
    preParse: (json: JsonRecord) => unknown;
    applyAsset: (
        meshes: undefined,
        root: undefined,
        context: { _json: JsonRecord; _binChunk: DataView },
    ) => {
        _sceneSetup?: (scene: unknown) => void;
        _gaussianSplats?: unknown[];
    };
}

/** What the redirected `attachParsedSplat` records for one call. */
interface RecordedAttach {
    name: string;
    parsed: ParsedSplat;
    mesh: { rotation: { x: number; y: number; z: number } };
    fragments: unknown;
}

const GS_FEATURE_MODULE = "loader-gltf/gltf-feature-gaussian-splatting.js";
/** The pin's own scratch key, which `preParse` writes and `applyAsset` reads. */
const GS_SCRATCH_KEY = "__gsSplats";

/**
 * Runs the pinned feature over one packaged document, in place.
 *
 * `json` comes back with its GS primitives removed and the pin's scratch key
 * cleared; the returned rows are what the caller appends to the binary chunk.
 * A document declaring the extension with no GS primitive in it yields an
 * empty list and is passed through rather than refused, which is the shape
 * the pin's own `applyAsset` early-returns on.
 */
export async function extractGltfGaussianSplats(
    json: JsonRecord,
    binChunk: DataView,
    label: string,
): Promise<GltfGaussianSplat[]> {
    const recorded: RecordedAttach[] = [];
    const { hook, release } = installPinnedImportHook(
        (entry: RecordedAttach) => {
            recorded.push(entry);
        },
    );
    // `attachParsedSplat` uploads textures and spawns a sort worker, neither
    // of which exists here. The redirect keeps the pin's own call — its
    // arguments, and the TRS its caller then writes, are what generation
    // needs — and stands in only for the GPU half the native runtime owns.
    const recorder = javascriptModuleUrl(
        [
            "export function attachParsedSplat(scene, name, parsed, fragments) {",
            "    const mesh = { rotation: { x: 0, y: 0, z: 0 } };",
            `    globalThis[${JSON.stringify(hook)}](`,
            "        { name, parsed, mesh, fragments });",
            // A synchronous thenable, so the pin's own `.then` callback runs
            // before this returns and the TRS it writes is observed.
            "    return { then: (resolve) => resolve(mesh) };",
            "}",
        ].join("\n"),
    );
    try {
        const module = await importPinnedModuleUnasynced(
            GS_FEATURE_MODULE,
            [],
            new Map([["../loader-splat/load-splat.js", recorder]]),
        );
        const feature = module.default as PinnedGaussianSplattingFeature;
        if (
            feature?.id !== GAUSSIAN_SPLATTING_EXTENSION ||
            typeof feature.preParse !== "function" ||
            typeof feature.applyAsset !== "function"
        ) {
            throw new Error(
                `Pinned ${GS_FEATURE_MODULE} no longer exports a default ` +
                    `${GAUSSIAN_SPLATTING_EXTENSION} feature with preParse and applyAsset ` +
                    "hooks.",
            );
        }
        assertPinnedSync(feature.preParse(json), `${GAUSSIAN_SPLATTING_EXTENSION} preParse`);
        const applied = assertPinnedSync(
            feature.applyAsset(undefined, undefined, {
                _json: json,
                _binChunk: binChunk,
            }),
            `${GAUSSIAN_SPLATTING_EXTENSION} applyAsset`,
        );
        if (json[GS_SCRATCH_KEY] === undefined) {
            return [];
        }
        delete json[GS_SCRATCH_KEY];
        if (
            typeof applied._sceneSetup !== "function" ||
            !Array.isArray(applied._gaussianSplats)
        ) {
            throw new Error(
                `${label}: the pinned ${GAUSSIAN_SPLATTING_EXTENSION} feature no longer hands ` +
                    "its scene wiring back as _sceneSetup plus " +
                    "_gaussianSplats; the conversion this pass observes has " +
                    "moved.",
            );
        }
        // The pin's wiring hands the scene straight to `attachParsedSplat`,
        // which the recorder replaces, so nothing reads a member of it; a
        // pin that starts to throws here naming the property.
        applied._sceneSetup(undefined);
        if (applied._gaussianSplats.length !== recorded.length) {
            throw new Error(
                `${label}: the pinned ${GAUSSIAN_SPLATTING_EXTENSION} feature published ` +
                    `${applied._gaussianSplats.length} splat promise(s) from ` +
                    `${recorded.length} attach call(s); its scene wiring no ` +
                    "longer publishes exactly what it attaches.",
            );
        }
    } finally {
        release();
    }
    return recorded.map((entry) => resolveRecordedSplat(entry, label));
}

/** One recorded attach, checked against the slice this port carries. */
function resolveRecordedSplat(
    entry: RecordedAttach,
    label: string,
): GltfGaussianSplat {
    if (entry.parsed.sh !== undefined || entry.parsed.shDegree !== undefined) {
        throw new Error(
            `${label}: splat '${entry.name}' carries spherical harmonics; ` +
                "the reached slice is the pin's degree-0 row layout, which " +
                "is what the native pipeline samples.",
        );
    }
    if (entry.fragments !== undefined) {
        throw new Error(
            `${label}: the pinned ${GAUSSIAN_SPLATTING_EXTENSION} feature attached splat ` +
                `'${entry.name}' with shader fragments; only a loadSplat call ` +
                "names those, and the generated pipeline composes them from " +
                "that call alone.",
        );
    }
    const written = Object.keys(entry.mesh).sort();
    if (written.length !== 1 || written[0] !== "rotation") {
        throw new Error(
            `${label}: the pinned ${GAUSSIAN_SPLATTING_EXTENSION} scene wiring wrote ` +
                `${written.join(", ")} on the attached cloud; this pass ` +
                "carries its rotation alone into the packaged document.",
        );
    }
    return {
        name: entry.name,
        rows: new Uint8Array(entry.parsed.data),
        rotation: [
            entry.mesh.rotation.x,
            entry.mesh.rotation.y,
            entry.mesh.rotation.z,
        ],
    };
}
