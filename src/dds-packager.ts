/**
 * Compiles a prefiltered DDS cubemap into the environment package the native
 * runtime reads.
 *
 * Babylon Lite's `loadDdsEnvironment` uploads the DDS mip chain as the
 * specular cube and projects spherical harmonics out of mip 0 at load time
 * (`src/loader-env/load-dds-env.ts#computeSH`). Both halves are decided
 * entirely by the asset, so both are done here at compile time — the same
 * split the HDR path already uses — and the runtime reads a package rather
 * than a container format. What this file must reproduce exactly is the
 * harmonic projection, because those 27 floats are shading input.
 */

import { preScalePolynomial, shToPolynomial } from "./hdr-packager.js";

const MAX_HDRI = 4096;

// src/loader-env/load-dds-env.ts SH_BASIS.
const SH_BASIS = [
    Math.sqrt(1 / (4 * Math.PI)),
    Math.sqrt(3 / (4 * Math.PI)),
    Math.sqrt(3 / (4 * Math.PI)),
    Math.sqrt(3 / (4 * Math.PI)),
    Math.sqrt(15 / (4 * Math.PI)),
    Math.sqrt(15 / (4 * Math.PI)),
    Math.sqrt(5 / (16 * Math.PI)),
    Math.sqrt(15 / (4 * Math.PI)),
    Math.sqrt(15 / (16 * Math.PI)),
];

// The cosine-kernel convolution that turns incident radiance into irradiance.
const SH_COS_KERNEL = [
    Math.PI,
    (2 * Math.PI) / 3,
    (2 * Math.PI) / 3,
    (2 * Math.PI) / 3,
    Math.PI / 4,
    Math.PI / 4,
    Math.PI / 4,
    Math.PI / 4,
    Math.PI / 4,
];

/**
 * Face orientations matching the pinned `_FileFaces` order +X, -X, +Y, -Y,
 * +Z, -Z: the face normal followed by the two in-plane axes the file's u and
 * v run along.
 */
const FACES: readonly (readonly number[])[] = [
    [1, 0, 0, 0, 0, -1, 0, -1, 0],
    [-1, 0, 0, 0, 0, 1, 0, -1, 0],
    [0, 1, 0, 1, 0, 0, 0, 0, 1],
    [0, -1, 0, 1, 0, 0, 0, 0, -1],
    [0, 0, 1, 1, 0, 0, 0, -1, 0],
    [0, 0, -1, -1, 0, 0, 0, -1, 0],
];

const ddsMagic = 0x20534444;
const dx10FourCc = 0x30315844;
const packageMagic = new Uint8Array([
    0x42, 0x42, 0x4c, 0x48, 0x44, 0x52, 0x31, 0x00,
]);

function float16ToFloat32(h: number): number {
    const sign = (h >> 15) & 0x1;
    const exponent = (h >> 10) & 0x1f;
    const mantissa = h & 0x3ff;
    if (exponent === 0) {
        return (sign ? -1 : 1) * Math.pow(2, -14) * (mantissa / 1024);
    }
    if (exponent === 31) {
        return mantissa ? NaN : sign ? -Infinity : Infinity;
    }
    return (
        (sign ? -1 : 1) * Math.pow(2, exponent - 15) * (1 + mantissa / 1024)
    );
}

/** The solid angle subtended by a texel corner on the unit cube. */
function areaElement(x: number, y: number): number {
    return Math.atan2(x * y, Math.sqrt(x * x + y * y + 1));
}

export interface DdsCubemap {
    width: number;
    mipCount: number;
    /** Face-major as the file stores it: `faces[face][mip]` rgba16f texels. */
    faces: Uint16Array[][];
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
    return { width, mipCount, faces };
}

/**
 * `src/loader-env/load-dds-env.ts#computeSH`: project mip 0 of the cubemap
 * onto the first nine spherical harmonics, weighting each texel by the solid
 * angle it subtends, then convolve with the cosine kernel and divide by pi to
 * reach Lambertian radiance.
 */
export function computeDdsSphericalHarmonics(
    cubemap: DdsCubemap,
): Float32Array {
    const width = cubemap.width;
    const du = 2.0 / width;
    const halfTexel = 0.5 * du;
    const minUV = halfTexel - 1.0;

    const sh = new Float64Array(27);
    let totalSolidAngle = 0;

    for (let face = 0; face < 6; face += 1) {
        const pixels = cubemap.faces[face]![0]!;
        const f = FACES[face]!;
        const nx = f[0]!;
        const ny = f[1]!;
        const nz = f[2]!;
        const fxx = f[3]!;
        const fxy = f[4]!;
        const fxz = f[5]!;
        const fyx = f[6]!;
        const fyy = f[7]!;
        const fyz = f[8]!;

        let v = minUV;
        for (let row = 0; row < width; row += 1) {
            let u = minUV;
            for (let col = 0; col < width; col += 1) {
                const index = (row * width + col) * 4;
                let red = float16ToFloat32(pixels[index]!);
                let green = float16ToFloat32(pixels[index + 1]!);
                let blue = float16ToFloat32(pixels[index + 2]!);
                if (Number.isNaN(red)) red = 0;
                if (Number.isNaN(green)) green = 0;
                if (Number.isNaN(blue)) blue = 0;
                red = Math.min(Math.max(red, 0), MAX_HDRI);
                green = Math.min(Math.max(green, 0), MAX_HDRI);
                blue = Math.min(Math.max(blue, 0), MAX_HDRI);

                const dx = fxx * u + fyx * v + nx;
                const dy = fxy * u + fyy * v + ny;
                const dz = fxz * u + fyz * v + nz;
                const inverseLength =
                    1 / Math.sqrt(dx * dx + dy * dy + dz * dz);
                const wx = dx * inverseLength;
                const wy = dy * inverseLength;
                const wz = dz * inverseLength;

                const dsa =
                    areaElement(u - halfTexel, v - halfTexel) -
                    areaElement(u - halfTexel, v + halfTexel) -
                    areaElement(u + halfTexel, v - halfTexel) +
                    areaElement(u + halfTexel, v + halfTexel);

                const trig = [
                    1,
                    wy,
                    wz,
                    wx,
                    wx * wy,
                    wy * wz,
                    3 * wz * wz - 1,
                    wx * wz,
                    wx * wx - wy * wy,
                ];
                for (let index9 = 0; index9 < 9; index9 += 1) {
                    const weight = dsa * SH_BASIS[index9]! * trig[index9]!;
                    sh[index9] = sh[index9]! + red * weight;
                    sh[9 + index9] = sh[9 + index9]! + green * weight;
                    sh[18 + index9] = sh[18 + index9]! + blue * weight;
                }

                totalSolidAngle += dsa;
                u += du;
            }
            v += du;
        }
    }

    const correction = (4 * Math.PI) / totalSolidAngle;
    for (let index = 0; index < 27; index += 1) {
        sh[index] = sh[index]! * correction;
    }
    for (let channel = 0; channel < 3; channel += 1) {
        for (let index = 0; index < 9; index += 1) {
            sh[channel * 9 + index] =
                sh[channel * 9 + index]! * SH_COS_KERNEL[index]!;
        }
    }
    const inversePi = 1 / Math.PI;
    for (let index = 0; index < 27; index += 1) {
        sh[index] = sh[index]! * inversePi;
    }
    // `assembleEnvironmentTextures` pre-scales the polynomial before the
    // shader reads it, so the package carries the pre-scaled form the
    // native environment record expects.
    return preScalePolynomial(shToPolynomial(sh));
}

/**
 * Emits the same package the HDR path emits — magic, face size, mip count,
 * 27 pre-scaled harmonic floats, then mip-major rgba16f faces — so one
 * native reader serves both. The DDS file stores its faces the other way
 * round, so the mip chain is transposed here.
 */
export function packageDdsEnvironment(bytes: Uint8Array): Uint8Array {
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
