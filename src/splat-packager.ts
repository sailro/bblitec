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

import { importPinnedModule } from "./pinned-shader-composer.js";
import { cachedBakeSync, moduleIdentity } from "./bake-cache.js";

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
