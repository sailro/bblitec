import { prefilterCubemapGgx } from "./hdr-prefilter-gpu.js";
import { importPinnedModule } from "./pinned-shader-composer.js";

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
 * `polynomialToPreScaledHarmonics`, ported term for term from
 * `loader-gltf/ibl-env-assembly.ts`. The pinned function is module-local —
 * not exported — so it cannot be imported the way the parser above is; the
 * constants are anchored instead by a test that reads them out of the pinned
 * source, so a pin bump that moves one fails the suite rather than drifting.
 */
export function preScalePolynomial(polynomial: Float32Array): Float32Array {
    const result = new Float32Array(27);
    for (let channel = 0; channel < 3; channel += 1) {
        const x = polynomial[channel]!;
        const y = polynomial[3 + channel]!;
        const z = polynomial[6 + channel]!;
        const xx = polynomial[9 + channel]!;
        const yy = polynomial[12 + channel]!;
        const zz = polynomial[15 + channel]!;
        const yz = polynomial[18 + channel]!;
        const zx = polynomial[21 + channel]!;
        const xy = polynomial[24 + channel]!;
        result[channel] =
            (xx + yy) * 0.3333338747897695 + zz * 0.33333298856284405;
        result[3 + channel] = y * 1.4999984284682104;
        result[6 + channel] = z * 1.4999984284682104;
        result[9 + channel] = x * 1.4999984284682104;
        result[12 + channel] = xy * 3.999982863580422;
        result[15 + channel] = yz * 3.999982863580422;
        result[18 + channel] =
            zz * 1.3333326611423701 - (xx + yy) * 0.6666653397393608;
        result[21 + channel] = zx * 3.999982863580422;
        result[24 + channel] = (xx - yy) * 1.999991431790211;
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
