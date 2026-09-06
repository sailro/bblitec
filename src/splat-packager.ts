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
import {
    createSuiteSceneServer,
    pinnedBrowserModuleUrl,
} from "./capture-suite-reference.js";
import {
    pageBase64Script,
    runPageGlobal,
    screenshotCaptureBrowserArgs,
} from "./browser-harness.js";
import { javascriptModuleUrl } from "./data-url.js";
import {
    cachedBakeSync,
    cachedJsonBake,
    moduleIdentity,
} from "./bake-cache.js";
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
 * An `.spz` is a different pinned loader and goes to `packageSpz` below, and
 * a `.sog` a third that goes to `packageSog`; neither container reaches here.
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
 * The stand-in for `attachParsedSplat`, which every pinned loader ends on.
 *
 * It uploads textures and spawns a sort worker, neither of which exists
 * here. The redirect keeps the pin's own call — its arguments, and the TRS
 * its caller then writes, are what generation needs — and stands in only for
 * the GPU half the native runtime owns. One copy, because the glTF feature's
 * `_sceneSetup`, `loadSPZ` and `loadSOG` write the cloud's rotation the same
 * way and a second recorder is a second thing to keep in step.
 *
 * The TEXT rather than a module, because the three callers are not all in one
 * engine: the two Node runs import it as a `data:` URL through the wrapper
 * below, and the browser run has the suite server hand it back at the pinned
 * module's own path.
 */
function attachParsedSplatRecorderSource(hook: string): string {
    return [
        "export function attachParsedSplat(scene, name, parsed, fragments) {",
        "    const mesh = { rotation: { x: 0, y: 0, z: 0 } };",
        `    globalThis[${JSON.stringify(hook)}](`,
        "        { name, parsed, mesh, fragments });",
        // A synchronous thenable, so the pin's own `.then` callback runs
        // before this returns and the TRS it writes is observed.
        "    return { then: (resolve) => resolve(mesh) };",
        "}",
    ].join("\n");
}

function attachParsedSplatRecorder(hook: string): string {
    return javascriptModuleUrl(attachParsedSplatRecorderSource(hook));
}

/**
 * One attach as either engine observes it.
 *
 * Two of the three pinned callers of `attachParsedSplat` run here in Node,
 * where the recorded object itself is in hand; the third runs in Chromium
 * (`packageSog`), where only a serialized view of it crosses the page
 * boundary. The CLAIMS are the same either way, so they are stated over this
 * view and both engines answer them.
 */
interface ObservedAttach {
    /** The cloud's name, which only a refusal reads. */
    name: string;
    /** Whether the caller passed shader fragments. */
    fragments: boolean;
    /** Every lane written on the attached cloud, sorted. */
    written: readonly string[];
    rotation: readonly [number, number, number];
}

/**
 * The Node side's projection of one recorded attach into that view.
 *
 * `undefined` is the "the loader attached nothing" case: the view it yields
 * is never read, because the container count refusal below fires first.
 */
function observedAttach(entry: RecordedAttach | undefined): ObservedAttach {
    return {
        name: entry?.name ?? "",
        fragments: entry?.fragments !== undefined,
        written: entry ? Object.keys(entry.mesh).sort() : [],
        rotation: entry
            ? [
                  entry.mesh.rotation.x,
                  entry.mesh.rotation.y,
                  entry.mesh.rotation.z,
              ]
            : [0, 0, 0],
    };
}

function observedRotation(
    observed: ObservedAttach,
    what: string,
): readonly [number, number, number] {
    if (observed.fragments) {
        throw new Error(
            `${what} attached '${observed.name}' with shader fragments; ` +
                "only a loadSplat call names those, and the generated " +
                "pipeline composes them from that call alone.",
        );
    }
    if (
        observed.written.length !== 1 ||
        observed.written[0] !== "rotation"
    ) {
        throw new Error(
            `${what} wrote ${observed.written.join(", ")} on the attached ` +
                "cloud; this pass carries its rotation alone.",
        );
    }
    return observed.rotation;
}

/**
 * One CONTAINER loader's attach: the same view plus the two claims only a
 * whole-loader run can make.
 *
 * `loadSPZ` and `loadSOG` each answer for one container, so "exactly one
 * cloud, and it is the one handed back" is part of what makes reading the
 * TRS off it a port. The glTF feature's wiring attaches one cloud per GS
 * primitive and returns none of them, so it carries neither claim and its
 * caller reads `observedRotation` directly.
 */
interface ObservedContainerAttach extends ObservedAttach {
    /** How many clouds the loader attached. */
    attached: number;
    /** Whether it returned the one it attached. */
    returnedAttached: boolean;
}

/**
 * The four contracts this port carries out of a pinned container loader,
 * checked in one place for both engines.
 *
 * Node holds the recorded object and Chromium hands back a serialized view of
 * it, but the CLAIMS are the same, and stating them twice is how the two
 * would drift. The order is the order a failure is worth reading in: how many
 * clouds, whether the returned one is that cloud, then what the loader did to
 * it.
 */
function observedContainerRotation(
    observed: ObservedContainerAttach,
    what: string,
): readonly [number, number, number] {
    if (observed.attached !== 1) {
        throw new Error(
            `${what} attached ${observed.attached} cloud(s) for one ` +
                "container; this port carries the one it returns.",
        );
    }
    if (!observed.returnedAttached) {
        throw new Error(
            `${what} returned a cloud other than the one it attached; the ` +
                "TRS this pass observes is written on the returned one.",
        );
    }
    return observedRotation(observed, what);
}

const SPZ_MODULE = "loader-splat/load-spz.js";

/** The export surface `packageSpz` asks the pinned SPZ loader for. */
interface PinnedSpzModule {
    loadSPZ?: (scene: unknown, url: string) => Promise<unknown>;
}

/**
 * A container loader's result, as generation reads it.
 *
 * Two of the pin's three splat entry points end by writing a TRS lane on the
 * cloud they attached (`loadSPZ` and `loadSOG` both write a half turn about
 * X), and neither packages anything else the plain rows do not carry — so one
 * shape serves both and the CLI reads the rotation the same way whichever
 * container answered.
 */
export interface PackagedSplatContainer extends PackagedSplat {
    /** The Euler rotation the loader left on the cloud it attached. */
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
 * Not bake-cached, unlike the PLY parse beside it. What there would be to
 * cache is the packaged BYTES — this run hands back a live object graph, not
 * a serialized capture the way `packageSog` below does — and replaying bytes
 * would skip the four contracts it answers: that exactly one cloud was
 * attached, that the loader returned the one it attached, that it passed no
 * shader fragments, and that the only lane it wrote is the rotation. Those
 * are what make the rest of this a port rather than a guess. The inflate and
 * parse cost about 280 ms on the reached container against a 19 ms cache
 * replay, which is what that buys.
 */
export async function packageSpz(
    bytes: Uint8Array,
    url: string,
): Promise<PackagedSplatContainer> {
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
    const entry = recorded[0];
    // Read here rather than inside the recorder, because the pin's own
    // `.then` callback runs on the way out of `loadSPZ` and the TRS it
    // writes is only on the cloud afterwards. That is why each engine
    // projects its own view of the attach and only the CLAIMS are shared.
    const rotation = observedContainerRotation(
        {
            attached: recorded.length,
            returnedAttached: entry !== undefined && mesh === entry.mesh,
            ...observedAttach(entry),
        },
        "Pinned loadSPZ",
    );
    // `attached === 1` is what the first contract above refuses on, so the
    // one recorded attach is in hand here.
    const parsed = entry!.parsed;
    return {
        rotation,
        ...packagedSplat(
            new Uint8Array(parsed.data),
            parsed.sh,
            parsed.shDegree ?? 0,
        ),
    };
}

const SOG_MODULE = "loader-splat/load-sog.js";
const LOAD_SPLAT_MODULE = "loader-splat/load-splat.js";
/** Where the page fetches the container from, on the loopback origin. */
const SOG_SERVED_PATH = "/sog-source.sog";
/** The page global the recorder announces each attach through. */
const SOG_ATTACH_HOOK = "__bblitecSogAttach";
/** The driver the page installs, awaited and called by `runPageGlobal`. */
const SOG_PAGE_GLOBAL = "__bblitecPackageSog";

/** What one `loadSOG` run hands back across the page boundary. */
interface CapturedSog extends ObservedContainerAttach {
    /** The 32-byte rows and the flat SH stream, base64 (see below). */
    rowsBase64: string;
    shBase64: string;
    shDegree: number;
}

/**
 * The page module: run the pinned loader, then hand back what it attached.
 *
 * Bytes cross as base64 for the reason `pageBase64Script` gives — a number
 * per byte turns this cloud's 60 MB into minutes of JSON.
 */
function sogPageModule(): string {
    return `import { loadSOG } from ${JSON.stringify(
        pinnedBrowserModuleUrl(SOG_MODULE),
    )};

${pageBase64Script}
window.${SOG_PAGE_GLOBAL} = async () => {
    const recorded = [];
    window[${JSON.stringify(SOG_ATTACH_HOOK)}] = (entry) => {
        recorded.push(entry);
    };
    const mesh = await loadSOG(undefined, ${JSON.stringify(SOG_SERVED_PATH)});
    const entry = recorded[recorded.length - 1];
    const parsed = entry ? entry.parsed : { data: new ArrayBuffer(0) };
    const sh = parsed.sh ? parsed.sh : new Uint8Array(0);
    return {
        attached: recorded.length,
        returnedAttached: entry !== undefined && mesh === entry.mesh,
        name: entry ? entry.name : "",
        fragments: entry !== undefined && entry.fragments !== undefined,
        written: entry ? Object.keys(entry.mesh).sort() : [],
        rotation: entry
            ? [entry.mesh.rotation.x, entry.mesh.rotation.y, entry.mesh.rotation.z]
            : [0, 0, 0],
        rowsBase64: bblBase64(new Uint8Array(parsed.data)),
        shBase64: bblBase64(sh),
        shDegree: parsed.shDegree ? parsed.shDegree : 0,
    };
};
`;
}

/**
 * Packages a SOG container by running the pin's own `loadSOG` in Chromium.
 *
 * The loader unzips the archive, reads `meta.json`, decodes each WebP and
 * rebuilds the 32-byte rows plus the flat spherical-harmonic stream — and its
 * decode step is `createImageBitmap` into a 2D canvas read back with
 * `getImageData`. That round trip is the BROWSER's, premultiplication and
 * all, and the reference golden is a browser running this same function: a
 * substituted decoder would have to agree with Skia byte for byte to package
 * what the golden drew. So this bake runs the loader where the golden runs it
 * rather than standing in for the one step Node cannot perform, and Chromium
 * answers the zip, the decode and the parse alike.
 *
 * Two boundaries are stood in for, the same two `packageSpz` stands in for:
 * `fetch` answers from the download cache, served back on the loopback origin
 * that hosts the page, and `attachParsedSplat` records instead of building a
 * GPU mesh — through the same recorder text, served over the pinned module's
 * own path so the pin's `load-sog.js` imports it unmodified.
 *
 * Bake-cached, unlike the whole-loader run `packageSpz` performs. What the
 * cache stores is the CAPTURED OBJECT — the JSON that crossed the page
 * boundary — not the packaged bytes, so a replay still answers the four
 * contracts below from that object: exactly one cloud attached, the returned
 * cloud is the attached one, no shader fragments, and the only lane written is
 * the rotation. `basis-transcode.ts` caches its own browser capture on exactly
 * that boundary, with its contract assertion after it.
 *
 * The trade it buys is a whole Chromium launch: the run is 1.65 s on the
 * reached container (412 ms of it inside the loader) against a 126 ms replay
 * of the 80.7 MB capture (77 ms read, 26 ms parse, 23 ms base64). Generation
 * is keyed on `dist`, so every compiler edit regenerates this scene.
 */
export async function packageSog(
    bytes: Uint8Array,
): Promise<PackagedSplatContainer> {
    // Deterministic in (container bytes, pin, browser) — the unzip, the WebP
    // decode and the parse are all the browser's, which is why the browser
    // identity joins the key.
    const captured = await cachedJsonBake<CapturedSog>(
        {
            kind: "splat-sog",
            version: "1",
            module: moduleIdentity(import.meta.url),
            browser: true,
            parameters: {},
            inputs: [bytes],
        },
        async () =>
            (await runPageGlobal(
                createSuiteSceneServer(sogPageModule(), {
                    virtualAssets: { [SOG_SERVED_PATH]: bytes },
                    // Ahead of the repository lookup, so the pinned loader's
                    // own `./load-splat.js` import resolves to the recorder
                    // without the package being touched.
                    virtualModules: {
                        [pinnedBrowserModuleUrl(LOAD_SPLAT_MODULE)]:
                            attachParsedSplatRecorderSource(SOG_ATTACH_HOOK),
                    },
                }),
                SOG_PAGE_GLOBAL,
                {
                    serverName: "SOG package server",
                    browserRequirement:
                        "Packaging a SOG container requires Chrome or Edge.",
                    // The golden capture's flags, because this run reproduces
                    // a decode the golden capture performs: the sRGB pin keeps
                    // the canvas read-back independent of the host display
                    // profile.
                    browserArgs: screenshotCaptureBrowserArgs,
                },
            )) as CapturedSog,
    );
    return {
        rotation: observedContainerRotation(captured, "Pinned loadSOG"),
        // `Buffer.from(text, "base64")` already IS a Uint8Array; wrapping it
        // copies all 60 MB of the reached cloud's rows a second time.
        ...packagedSplat(
            Buffer.from(captured.rowsBase64, "base64"),
            Buffer.from(captured.shBase64, "base64"),
            captured.shDegree,
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
        rotation: observedRotation(
            observedAttach(entry),
            `${label}: the pinned ${GAUSSIAN_SPLATTING_EXTENSION} scene wiring`,
        ),
    };
}
