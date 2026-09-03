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
    importPinnedModuleFetching,
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

/**
 * The pin's second container parser, which `loadSplat` reaches through a
 * dynamic import exactly when `isPlyCompressedOrSH` says so.
 *
 * Executed for the same reason its plain sibling is — a PLY header is a
 * per-exporter property list, so the parsed VALUE is what must not drift —
 * and it is imported here at module scope rather than lazily because
 * generation has already decided it needs a parser by the time it asks.
 * The only Web API in its body is `TextDecoder`, which Node has.
 */
const pinnedCompressedPlyParser = await importPinnedModule<{
    convertCompressedPlyToParsedSplat: (data: ArrayBuffer) => ParsedSplat;
}>("loader-splat/splat-ply-compressed.js");

/**
 * The spherical harmonics a compressed PLY carries beside its rows.
 *
 * `shDegree` bands the per-splat coefficient count the pin's own shader
 * builder derives from it: `((d + 1)^2 - 1) * 3` bytes per splat.
 */
export interface PackagedSplatHarmonics {
    degree: number;
    bytes: Uint8Array;
}

export interface PackagedSplat {
    /** The row buffer, at the pin's own stride. */
    rows: Uint8Array;
    /**
     * Present only for a container the pin parsed spherical harmonics out
     * of. It travels beside the row buffer rather than inside it: the rows
     * ARE upstream's own `.splat` layout, and a scene fetching a `.splat`
     * directly must package to the same bytes.
     */
    harmonics?: PackagedSplatHarmonics;
}

/**
 * Frames one parse result as the bytes the bake cache stores.
 *
 * `cachedBakeSync` replays a single buffer, and the compressed parse
 * produces two — the rows and the SH stream — so the cached entry carries
 * both behind a fixed twelve-byte prefix. The prefix is INTERNAL to the
 * cache: what ships is the row buffer and, beside it, the SH stream exactly
 * as the pin's parser produced it.
 */
const CACHE_PREFIX_BYTES = 12;

function frameParsedSplat(parsed: ParsedSplat): Uint8Array {
    const rows = new Uint8Array(parsed.data);
    const sh = parsed.sh ?? new Uint8Array(0);
    const framed = new Uint8Array(CACHE_PREFIX_BYTES + rows.length + sh.length);
    const header = new DataView(framed.buffer, 0, CACHE_PREFIX_BYTES);
    header.setUint32(0, rows.length, true);
    header.setUint32(4, sh.length, true);
    header.setUint32(8, parsed.shDegree ?? 0, true);
    framed.set(rows, CACHE_PREFIX_BYTES);
    framed.set(sh, CACHE_PREFIX_BYTES + rows.length);
    return framed;
}

/**
 * One parse's two outputs as the packaged pair, wherever they came from.
 *
 * Both pinned containers answer in the same shape and this port asks the
 * same question of both — are there harmonics, and does this cloud have
 * splats at all — so the rule lives once. It is the `attachParsedSplat`
 * fork itself (`parsed.sh && parsed.shDegree > 0`), taken at generation.
 */
function packagedSplat(
    rows: Uint8Array,
    sh: Uint8Array | undefined,
    degree: number,
): PackagedSplat {
    // The stride is not re-typed here: `SplatLowerer` reads ROW_LENGTH off
    // the pinned declaration and the generated loader checks the packaged
    // bytes against it, so a moved stride refuses there rather than agreeing
    // with a copy that can drift.
    if (rows.byteLength === 0) {
        throw new Error("Splat asset carries no splats.");
    }
    return sh === undefined || sh.byteLength === 0 || degree === 0
        ? { rows }
        : { rows, harmonics: { degree, bytes: sh } };
}

function unframeParsedSplat(framed: Uint8Array): PackagedSplat {
    const header = new DataView(
        framed.buffer,
        framed.byteOffset,
        CACHE_PREFIX_BYTES,
    );
    const rowBytes = header.getUint32(0, true);
    const shBytes = header.getUint32(4, true);
    return packagedSplat(
        framed.subarray(CACHE_PREFIX_BYTES, CACHE_PREFIX_BYTES + rowBytes),
        framed.subarray(
            CACHE_PREFIX_BYTES + rowBytes,
            CACHE_PREFIX_BYTES + rowBytes + shBytes,
        ),
        header.getUint32(8, true),
    );
}

/**
 * Parses a fetched splat asset into the interchange row buffer.
 *
 * Both PLY containers reach the pin's own parser, on the same fork
 * `loadSplat` takes: `isPlyCompressedOrSH` selects the chunked/SH parser the
 * pin dynamically imports, and either one yields the same 32-byte rows plus,
 * for the compressed container, a flat spherical-harmonic byte stream.
 * An `.spz` is a different pinned loader and goes to `packageSpz` below;
 * `.sog` still refuses, pending a ZIP and a WebP decoder.
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

    if (!pinnedPlyParser.isPly(data)) {
        // A pre-converted `.splat` is already the row layout; the pin takes
        // this same fast path.
        return packagedSplat(new Uint8Array(data), undefined, 0);
    }
    const compressed = pinnedPlyParser.isPlyCompressedOrSH(data);
    // The pin's text parse over a multi-megabyte PLY is deterministic
    // in (asset bytes, pin); a repeat compile replays the row buffer.
    // The `.splat` fast path above stays uncached — caching a copy of
    // the input would only spend disk on a no-op.
    return unframeParsedSplat(
        cachedBakeSync(
            {
                kind: "splat-ply",
                version: "2",
                module: moduleIdentity(import.meta.url),
                browser: false,
                parameters: {},
                inputs: [bytes],
            },
            () => {
                const parsed = compressed
                    ? pinnedCompressedPlyParser
                          .convertCompressedPlyToParsedSplat(data)
                    : pinnedPlyParser.convertPlyToSplat(data);
                if (parsed.data.byteLength === 0) {
                    throw new Error(
                        "Splat PLY parsed to an empty row buffer (unsupported property layout).",
                    );
                }
                return frameParsedSplat(parsed);
            },
        ),
    );
}

/** What the redirected `attachParsedSplat` records for one call. */
interface RecordedAttach {
    name: string;
    parsed: ParsedSplat;
    mesh: { rotation: { x: number; y: number; z: number } };
    fragments: unknown;
}

/**
 * The stand-in for `attachParsedSplat`, which both pinned loaders end on.
 *
 * It uploads textures and spawns a sort worker, neither of which exists
 * here. The redirect keeps the pin's own call — its arguments, and the TRS
 * its caller then writes, are what generation needs — and stands in only for
 * the GPU half the native runtime owns. One copy, because the glTF feature's
 * `_sceneSetup` and `loadSPZ` write the cloud's rotation the same way and a
 * second recorder is a second thing to keep in step.
 */
function attachParsedSplatRecorder(hook: string): string {
    return javascriptModuleUrl(
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
}

/**
 * One recorded attach checked against the slice this port carries out of a
 * pinned loader: the shader plugins it may not pass, and the one TRS lane
 * its caller may write.
 *
 * Both pinned callers of `attachParsedSplat` observed here are checked the
 * same way, because both are the same claim — that everything the pin did
 * to the cloud after building it is the rotation this returns.
 */
function recordedRotation(
    entry: RecordedAttach,
    what: string,
): readonly [number, number, number] {
    if (entry.fragments !== undefined) {
        throw new Error(
            `${what} attached '${entry.name}' with shader fragments; only ` +
                "a loadSplat call names those, and the generated pipeline " +
                "composes them from that call alone.",
        );
    }
    const written = Object.keys(entry.mesh).sort();
    if (written.length !== 1 || written[0] !== "rotation") {
        throw new Error(
            `${what} wrote ${written.join(", ")} on the attached cloud; ` +
                "this pass carries its rotation alone.",
        );
    }
    return [
        entry.mesh.rotation.x,
        entry.mesh.rotation.y,
        entry.mesh.rotation.z,
    ];
}

const SPZ_MODULE = "loader-splat/load-spz.js";

/** The export surface `packageSpz` asks the pinned SPZ loader for. */
interface PinnedSpzModule {
    loadSPZ?: (scene: unknown, url: string) => Promise<unknown>;
}

/** The pin's `loadSPZ` result, as generation reads it. */
export interface PackagedSpz extends PackagedSplat {
    /** The Euler rotation `loadSPZ` left on the cloud it attached. */
    rotation: readonly [number, number, number];
}

/**
 * Packages an SPZ container by running the pin's own `loadSPZ`.
 *
 * The whole loader executes, not just its parse: it tests the two gzip magic
 * bytes, inflates through `DecompressionStream`, runs the module-local
 * `parseSpz` over the result and then writes a half turn about X on the cloud
 * it attached. Every one of those is something this port would otherwise
 * restate, and the last one is not even in a function generation could
 * import — so the loader is executed end to end with its two boundaries
 * stood in for: `fetch` answers from the bytes the download cache already
 * holds, and `attachParsedSplat` records instead of building a GPU mesh.
 *
 * Not bake-cached, unlike the PLY parse beside it. Replaying bytes would
 * skip the four contracts below — that exactly one cloud was attached, that
 * the loader returned the one it attached, that it passed no shader
 * fragments, and that the only lane it wrote is the rotation — and those are
 * what make the rest of this a port rather than a guess. The inflate and
 * parse cost about 280 ms on the reached container against a 19 ms cache
 * replay, which is what that buys.
 */
export async function packageSpz(
    bytes: Uint8Array,
    url: string,
): Promise<PackagedSpz> {
    const recorded: RecordedAttach[] = [];
    const attach = installPinnedImportHook((entry: RecordedAttach) => {
        recorded.push(entry);
    });
    let mesh: unknown;
    let fetching:
        | { module: PinnedSpzModule; release: () => void }
        | undefined;
    try {
        fetching = await importPinnedModuleFetching<PinnedSpzModule>(
            SPZ_MODULE,
            (requested) => {
                if (requested !== url) {
                    throw new Error(
                        `Pinned ${SPZ_MODULE} fetched '${requested}' rather ` +
                            `than the container it was given ('${url}').`,
                    );
                }
                return bytes;
            },
            new Map([["./load-splat.js", attachParsedSplatRecorder(attach.hook)]]),
        );
        const module = fetching.module;
        if (typeof module.loadSPZ !== "function") {
            throw new Error(
                `Pinned ${SPZ_MODULE} no longer exports loadSPZ.`,
            );
        }
        mesh = await module.loadSPZ(undefined, url);
    } finally {
        // Both stand-ins go together: each retains this call's container and
        // its parse, which are ~75 MB for the reached cloud, and neither is
        // reachable once the loader has run.
        attach.release();
        fetching?.release();
    }
    if (recorded.length !== 1) {
        throw new Error(
            `Pinned loadSPZ attached ${recorded.length} cloud(s) for one ` +
                "container; this port carries the one it returns.",
        );
    }
    const entry = recorded[0]!;
    if (mesh !== entry.mesh) {
        throw new Error(
            "Pinned loadSPZ returned a cloud other than the one it " +
                "attached; the TRS this pass observes is written on the " +
                "returned one.",
        );
    }
    return {
        rotation: recordedRotation(entry, "Pinned loadSPZ"),
        ...packagedSplat(
            new Uint8Array(entry.parsed.data),
            entry.parsed.sh,
            entry.parsed.shDegree ?? 0,
        ),
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
    const recorder = attachParsedSplatRecorder(hook);
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
    return {
        name: entry.name,
        rows: new Uint8Array(entry.parsed.data),
        rotation: recordedRotation(
            entry,
            `${label}: the pinned ${GAUSSIAN_SPLATTING_EXTENSION} scene wiring`,
        ),
    };
}
