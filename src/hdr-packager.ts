import { prefilterCubemapGgx } from "./hdr-prefilter-gpu.js";
import {
    importPinnedModule,
    importPinnedModuleWithExports,
} from "./pinned-shader-composer.js";

/**
 * The HDR package is the pin executed, not transcribed. RGBE parsing and the
 * irradiance chain call the pinned package's own exported functions
 * (`parseRGBE`, `computeSHFromEquirect` — which runs the pin's
 * `shToPolynomial` internally), and mip zero comes back from the pinned
 * `equirectToCubeWGSL` compute the Chromium harness runs for prefiltering,
 * so every byte in the package is produced by the pin's own code. A pin
 * bump that changes any of it changes the package and the test goldens go
 * red — the drift-detection direction, where the former transcriptions kept
 * agreeing with themselves.
 *
 * The pin has no defensive parsing: a truncated or legacy-encoded RGBE file
 * decodes to garbage there exactly as it does here now. Corpus inputs are
 * content-addressed and hash-pinned, so the guards this file used to carry
 * protected nothing reachable.
 */
const pinnedHdrParser = await importPinnedModule<{
    parseRGBE: (buffer: Uint8Array) => HdrImage;
    computeSHFromEquirect: (
        data: Float32Array,
        width: number,
        height: number,
    ) => Float32Array;
}>("loader-hdr/hdr-parser.js");
const pinnedSphericalHarmonics = await importPinnedModule<{
    shToPolynomial: (sh: Float64Array) => Float32Array;
}>("math/spherical-harmonics.js");
/**
 * `polynomialToPreScaledHarmonics` is module-local to the pin, so it is
 * reached by re-exporting it out of the pinned module's own text, the way
 * the DDS packager reaches `computeSH`. The IBL assembly module carries the
 * copy the glTF environment feature executes; the pin keeps it
 * byte-for-byte against the `.env` loader's canonical, and the glTF
 * lowering compares the two at generation.
 */
const pinnedIblAssembly = await importPinnedModuleWithExports<{
    polynomialToPreScaledHarmonics: (polynomial: Float32Array) => Float32Array;
}>("loader-gltf/ibl-env-assembly.js", ["polynomialToPreScaledHarmonics"]);

export const parseRgbe = pinnedHdrParser.parseRGBE;
/** The pin's own `shToPolynomial`, re-exported for the DDS packager. */
export const shToPolynomial = pinnedSphericalHarmonics.shToPolynomial;

const hdrMagic = new Uint8Array([0x42, 0x42, 0x4c, 0x48, 0x44, 0x52, 0x31, 0x00]);

interface HdrImage {
    width: number;
    height: number;
    data: Float32Array;
}

/**
 * The pin's `polynomialToPreScaledHarmonics`, executed, then repacked.
 *
 * The pin lays its nine harmonics out at stride four -- the UBO layout the
 * shader reads, one pad lane per harmonic -- and the package stores them
 * as nine Color3 slots at stride three, which is the layout the native
 * environment loader fills. The repack is this port's only step, and it
 * moves lanes without touching a value, so the package carries the pin's
 * own float32 stores.
 */
export function preScalePolynomial(polynomial: Float32Array): Float32Array {
    const scaled = pinnedIblAssembly.polynomialToPreScaledHarmonics(polynomial);
    if (scaled.length !== 36) {
        throw new Error(
            "Pinned polynomialToPreScaledHarmonics no longer produces nine " +
                `stride-four harmonics (got ${scaled.length} lanes).`,
        );
    }
    const result = new Float32Array(27);
    for (let slot = 0; slot < 9; slot += 1) {
        for (let channel = 0; channel < 3; channel += 1) {
            result[slot * 3 + channel] = scaled[slot * 4 + channel]!;
        }
    }
    return result;
}

function mipLevelCount(size: number): number {
    return Math.floor(Math.log2(size)) + 1;
}

export async function packageHdrEnvironment(bytes: Uint8Array, faceSize: number): Promise<Uint8Array> {
    if (
        !Number.isInteger(faceSize) ||
        faceSize < 1 ||
        faceSize > 2048 ||
        (faceSize & (faceSize - 1)) !== 0
    ) {
        throw new Error("HDR cubemap faceSize must be a power of two between 1 and 2048.");
    }
    const image = parseRgbe(bytes);
    const sphericalHarmonics = preScalePolynomial(
        pinnedHdrParser.computeSHFromEquirect(
            image.data,
            image.width,
            image.height,
        ),
    );
    const mipCount = mipLevelCount(faceSize);
    const levels = await prefilterCubemapGgx(faceSize, mipCount, {
        equirect: image,
    });

    const headerSize = hdrMagic.length + 8 + sphericalHarmonics.byteLength;
    const payloadSize = levels.reduce(
        (total, faces) =>
            total +
            faces.reduce((faceTotal, face) => faceTotal + face.byteLength, 0),
        0,
    );
    const output = new Uint8Array(headerSize + payloadSize);
    output.set(hdrMagic);
    const view = new DataView(output.buffer);
    view.setUint32(8, faceSize, true);
    view.setUint32(12, mipCount, true);
    for (let index = 0; index < sphericalHarmonics.length; index += 1) {
        view.setFloat32(16 + index * 4, sphericalHarmonics[index]!, true);
    }
    let offset = headerSize;
    for (const faces of levels) {
        for (const face of faces) {
            for (const value of face) {
                view.setUint16(offset, value, true);
                offset += 2;
            }
        }
    }
    return output;
}
