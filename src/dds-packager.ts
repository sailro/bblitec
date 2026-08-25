/**
 * Compiles a prefiltered DDS cubemap into the environment package the native
 * runtime reads.
 *
 * Babylon Lite's `loadDdsEnvironment` uploads the DDS mip chain as the
 * specular cube and projects spherical harmonics out of mip 0 at load time.
 * Both halves are decided entirely by the asset, so both are done here at
 * compile time — the same split the HDR path already uses — and the runtime
 * reads a package rather than a container format.
 *
 * The harmonic projection is the pin executed, not transcribed:
 * `src/loader-env/load-dds-env.ts#computeSH` is module-local, so it is
 * reached by re-exporting it out of the pinned module's own text
 * (`importPinnedModuleWithExports`), and its result — the pin ends the
 * projection in its own `shToPolynomial` — goes through the same pre-scale
 * `assembleEnvironmentTextures` applies before the shader reads the
 * polynomial. A pin bump that changes the projection changes the package and
 * the test goldens go red — the drift-detection direction, where the former
 * transcription kept agreeing with itself.
 */

import { preScalePolynomial } from "./hdr-packager.js";
import { importPinnedModuleWithExports } from "./pinned-shader-composer.js";
import { cachedBakeSync, moduleIdentity } from "./bake-cache.js";

const pinnedDdsLoader = await importPinnedModuleWithExports<{
    computeSH: (
        raw: Uint8Array,
        width: number,
        mipCount: number,
    ) => Float32Array;
}>("loader-env/load-dds-env.js", ["computeSH"]);

const ddsMagic = 0x20534444;
const dx10FourCc = 0x30315844;
const packageMagic = new Uint8Array([
    0x42, 0x42, 0x4c, 0x48, 0x44, 0x52, 0x31, 0x00,
]);

export interface DdsCubemap {
    width: number;
    mipCount: number;
    /** Face-major as the file stores it: `faces[face][mip]` rgba16f texels. */
    faces: Uint16Array[][];
    /**
     * The pixel payload as the pinned loader views it: every face's full mip
     * chain, contiguous, in a fresh buffer so the face starts stay aligned
     * the way they are over a fetched `ArrayBuffer`.
     */
    payload: Uint8Array;
}

export function parseDdsCubemap(bytes: Uint8Array): DdsCubemap {
    const view = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
    );
    if (bytes.byteLength < 128 || view.getUint32(0, true) !== ddsMagic) {
        throw new Error("Invalid DDS: missing magic.");
    }
    const width = view.getInt32(12, true);
    const height = view.getInt32(16, true);
    const mipCount = Math.max(view.getInt32(28, true), 1);
    if (width !== height) {
        throw new Error(
            `DDS environment faces must be square, found ${width}x${height}.`,
        );
    }
    if (width <= 0) throw new Error("DDS environment has no pixels.");
    const dataOffset =
        view.getInt32(84, true) === dx10FourCc ? 128 + 20 : 128;

    const faces: Uint16Array[][] = [];
    let offset = dataOffset;
    for (let face = 0; face < 6; face += 1) {
        const mips: Uint16Array[] = [];
        for (let mip = 0; mip < mipCount; mip += 1) {
            const size = Math.max(width >> mip, 1);
            const byteLength = size * size * 8;
            if (offset + byteLength > bytes.byteLength) {
                throw new Error("DDS environment pixel data is truncated.");
            }
            mips.push(
                new Uint16Array(
                    bytes.buffer.slice(
                        bytes.byteOffset + offset,
                        bytes.byteOffset + offset + byteLength,
                    ),
                ),
            );
            offset += byteLength;
        }
        faces.push(mips);
    }
    const payload = new Uint8Array(
        bytes.buffer.slice(
            bytes.byteOffset + dataOffset,
            bytes.byteOffset + bytes.byteLength,
        ),
    );
    return { width, mipCount, faces, payload };
}

/**
 * The chain `loadDdsEnvironment` runs before upload: the pinned `computeSH`
 * projects mip 0 onto the first nine spherical harmonics and returns the
 * polynomial, and `assembleEnvironmentTextures` pre-scales that polynomial
 * before the shader reads it, so the package carries the pre-scaled form the
 * native environment record expects.
 */
export function computeDdsSphericalHarmonics(
    cubemap: DdsCubemap,
): Float32Array {
    return preScalePolynomial(
        pinnedDdsLoader.computeSH(
            cubemap.payload,
            cubemap.width,
            cubemap.mipCount,
        ),
    );
}

/**
 * Emits the same package the HDR path emits — magic, face size, mip count,
 * 27 pre-scaled harmonic floats, then mip-major rgba16f faces — so one
 * native reader serves both. The DDS file stores its faces the other way
 * round, so the mip chain is transposed here.
 */
export function packageDdsEnvironment(bytes: Uint8Array): Uint8Array {
    // The package is deterministic in (asset bytes, pin): the harmonic
    // projection is the pin's own `computeSH` and the repack is fixed
    // arithmetic. A repeat compile replays the package bytes rather
    // than re-projecting and re-transposing the whole mip chain.
    return cachedBakeSync(
        {
            kind: "dds-package",
            version: "1",
            module: moduleIdentity(import.meta.url),
            browser: false,
            parameters: {},
            inputs: [bytes],
        },
        () => buildDdsPackage(bytes),
    );
}

function buildDdsPackage(bytes: Uint8Array): Uint8Array {
    const cubemap = parseDdsCubemap(bytes);
    const sphericalHarmonics = computeDdsSphericalHarmonics(cubemap);

    const headerSize = packageMagic.length + 8 + sphericalHarmonics.byteLength;
    let payloadSize = 0;
    for (const mips of cubemap.faces) {
        for (const mip of mips) payloadSize += mip.byteLength;
    }
    const output = new Uint8Array(headerSize + payloadSize);
    output.set(packageMagic);
    const view = new DataView(output.buffer);
    view.setUint32(8, cubemap.width, true);
    view.setUint32(12, cubemap.mipCount, true);
    for (let index = 0; index < sphericalHarmonics.length; index += 1) {
        view.setFloat32(16 + index * 4, sphericalHarmonics[index]!, true);
    }
    let offset = headerSize;
    for (let mip = 0; mip < cubemap.mipCount; mip += 1) {
        for (let face = 0; face < 6; face += 1) {
            const texels = cubemap.faces[face]![mip]!;
            for (const value of texels) {
                view.setUint16(offset, value, true);
                offset += 2;
            }
        }
    }
    return output;
}
