import { prefilterCubemapGgx } from "./hdr-prefilter-gpu.js";
import { floatToHalf } from "./half-float.js";

const hdrMagic = new Uint8Array([0x42, 0x42, 0x4c, 0x48, 0x44, 0x52, 0x31, 0x00]);

interface HdrImage {
    width: number;
    height: number;
    data: Float32Array;
}

const faceCorners = new Float32Array([
    1, -1, 1, -1, -1, 1, 1, 1, 1, -1, 1, 1,
    -1, -1, -1, 1, -1, -1, -1, 1, -1, 1, 1, -1,
    -1, -1, -1, -1, -1, 1, 1, -1, -1, 1, -1, 1,
    1, 1, -1, 1, 1, 1, -1, 1, -1, -1, 1, 1,
    1, -1, -1, 1, -1, 1, 1, 1, -1, 1, 1, 1,
    -1, -1, 1, -1, -1, -1, -1, 1, 1, -1, 1, -1,
]);

function readLine(bytes: Uint8Array, position: { value: number }): string {
    let result = "";
    while (position.value < bytes.length) {
        const code = bytes[position.value++]!;
        if (code === 10) break;
        if (code !== 13) result += String.fromCharCode(code);
    }
    return result;
}

function rgbeToFloat(
    r: number,
    g: number,
    b: number,
    exponent: number,
    output: Float32Array,
    offset: number,
): void {
    if (exponent === 0) {
        output[offset] = 0;
        output[offset + 1] = 0;
        output[offset + 2] = 0;
        return;
    }
    const scale = 2 ** (exponent - 136);
    output[offset] = r * scale;
    output[offset + 1] = g * scale;
    output[offset + 2] = b * scale;
}

function decodeScanline(
    bytes: Uint8Array,
    position: number,
    width: number,
    output: Float32Array,
    outputOffset: number,
    scanline: Uint8Array,
): number {
    const requireBytes = (
        count: number,
        context: string,
    ): void => {
        if (position + count > bytes.length) {
            throw new Error(`HDR ${context} is truncated.`);
        }
    };
    if (
        width >= 8 &&
        width <= 0x7fff &&
        bytes[position] === 2 &&
        bytes[position + 1] === 2 &&
        bytes[position + 2] === ((width >> 8) & 0xff) &&
        bytes[position + 3] === (width & 0xff)
    ) {
        requireBytes(4, "scanline header");
        position += 4;
        for (let channel = 0; channel < 4; channel += 1) {
            let pointer = channel;
            let count = 0;
            while (count < width) {
                requireBytes(1, "scanline run marker");
                const marker = bytes[position++]!;
                if (marker > 128) {
                    const runLength = marker - 128;
                    if (count + runLength > width) {
                        throw new Error(
                            "Invalid HDR scanline run length.",
                        );
                    }
                    requireBytes(1, "scanline run value");
                    const value = bytes[position++]!;
                    for (let index = 0; index < runLength; index += 1) {
                        scanline[pointer] = value;
                        pointer += 4;
                    }
                    count += runLength;
                } else {
                    if (marker === 0) throw new Error("Invalid HDR scanline run.");
                    if (count + marker > width) {
                        throw new Error(
                            "Invalid HDR scanline literal length.",
                        );
                    }
                    requireBytes(marker, "scanline literal");
                    for (let index = 0; index < marker; index += 1) {
                        scanline[pointer] = bytes[position++]!;
                        pointer += 4;
                    }
                    count += marker;
                }
            }
        }
        for (let x = 0; x < width; x += 1) {
            const source = x * 4;
            rgbeToFloat(
                scanline[source]!,
                scanline[source + 1]!,
                scanline[source + 2]!,
                scanline[source + 3]!,
                output,
                outputOffset + x * 3,
            );
        }
        return position;
    }

    for (let x = 0; x < width; x += 1) {
        requireBytes(4, "pixel data");
        if (
            x > 0 &&
            bytes[position] === 1 &&
            bytes[position + 1] === 1 &&
            bytes[position + 2] === 1
        ) {
            throw new Error(
                "Legacy HDR scanline repeat encoding is unsupported.",
            );
        }
        rgbeToFloat(
            bytes[position]!,
            bytes[position + 1]!,
            bytes[position + 2]!,
            bytes[position + 3]!,
            output,
            outputOffset + x * 3,
        );
        position += 4;
    }
    return position;
}

export function parseRgbe(bytes: Uint8Array): HdrImage {
    const position = { value: 0 };
    const signature = readLine(bytes, position);
    if (!signature.startsWith("#?")) {
        throw new Error("Invalid HDR: missing #? signature.");
    }

    let format = "";
    while (position.value < bytes.length) {
        const line = readLine(bytes, position);
        if (line === "") break;
        if (line.startsWith("FORMAT=")) format = line.slice(7);
    }
    if (format && format !== "32-bit_rle_rgbe") {
        throw new Error(`Unsupported HDR format: ${format}.`);
    }

    const resolution = readLine(bytes, position);
    const match = resolution.match(/-Y\s+(\d+)\s+\+X\s+(\d+)/);
    if (!match) throw new Error(`Invalid HDR resolution: ${resolution}.`);
    const height = Number.parseInt(match[1]!, 10);
    const width = Number.parseInt(match[2]!, 10);
    if (width <= 0 || height <= 0) throw new Error("HDR dimensions must be positive.");

    const data = new Float32Array(width * height * 3);
    const scanline = new Uint8Array(width * 4);
    let pixelPosition = position.value;
    for (let y = 0; y < height; y += 1) {
        pixelPosition = decodeScanline(
            bytes,
            pixelPosition,
            width,
            data,
            y * width * 3,
            scanline,
        );
    }
    return { width, height, data };
}

export function shToPolynomial(sh: Float64Array): Float32Array {
    const inversePi = 1 / Math.PI;
    const polynomial = new Float32Array(27);
    for (let channel = 0; channel < 3; channel += 1) {
        const offset = channel * 9;
        const l00 = sh[offset]!;
        const l1_1 = sh[offset + 1]!;
        const l10 = sh[offset + 2]!;
        const l11 = sh[offset + 3]!;
        const l2_2 = sh[offset + 4]!;
        const l2_1 = sh[offset + 5]!;
        const l20 = sh[offset + 6]!;
        const l21 = sh[offset + 7]!;
        const l22 = sh[offset + 8]!;
        polynomial[channel] = l11 * 1.02333 * inversePi;
        polynomial[3 + channel] = l1_1 * 1.02333 * inversePi;
        polynomial[6 + channel] = l10 * 1.02333 * inversePi;
        polynomial[9 + channel] =
            (l00 * 0.886227 - l20 * 0.247708 + l22 * 0.429043) * inversePi;
        polynomial[12 + channel] =
            (l00 * 0.886227 - l20 * 0.247708 - l22 * 0.429043) * inversePi;
        polynomial[15 + channel] =
            (l00 * 0.886227 + l20 * 0.495417) * inversePi;
        polynomial[18 + channel] = l2_1 * 0.858086 * inversePi;
        polynomial[21 + channel] = l21 * 0.858086 * inversePi;
        polynomial[24 + channel] = l2_2 * 0.858086 * inversePi;
    }
    return polynomial;
}

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

function computeSphericalHarmonics(image: HdrImage): Float32Array {
    const sh = new Float64Array(27);
    let totalWeight = 0;
    for (let y = 0; y < image.height; y += 1) {
        const phi = ((y + 0.5) / image.height) * Math.PI;
        const sinPhi = Math.sin(phi);
        const cosPhi = Math.cos(phi);
        const solidAngle =
            sinPhi * (Math.PI / image.height) * ((2 * Math.PI) / image.width);
        for (let x = 0; x < image.width; x += 1) {
            const theta = ((2 * (x + 0.5)) / image.width - 1) * Math.PI;
            const directionX = sinPhi * Math.sin(theta);
            const directionY = cosPhi;
            const directionZ = sinPhi * Math.cos(theta);
            const pixel = (y * image.width + x) * 3;
            let red = image.data[pixel]!;
            let green = image.data[pixel + 1]!;
            let blue = image.data[pixel + 2]!;
            const maximum = Math.max(red, green, blue);
            if (maximum > 4096) {
                const scale = 4096 / maximum;
                red *= scale;
                green *= scale;
                blue *= scale;
            }
            const basis = [
                0.282094791773878,
                0.48860251190292 * directionY,
                0.48860251190292 * directionZ,
                0.48860251190292 * directionX,
                1.092548430592079 * directionX * directionY,
                1.092548430592079 * directionY * directionZ,
                0.31539156525252 * (3 * directionZ * directionZ - 1),
                1.092548430592079 * directionX * directionZ,
                0.54627421529604 *
                    (directionX * directionX - directionY * directionY),
            ];
            totalWeight += solidAngle;
            for (let index = 0; index < 9; index += 1) {
                const weightedBasis = basis[index]! * solidAngle;
                sh[index] = sh[index]! + red * weightedBasis;
                sh[9 + index] = sh[9 + index]! + green * weightedBasis;
                sh[18 + index] =
                    sh[18 + index]! + blue * weightedBasis;
            }
        }
    }
    const correction = (4 * Math.PI) / totalWeight;
    const irradianceScale = [1, 2 / 3, 2 / 3, 2 / 3, 0.25, 0.25, 0.25, 0.25, 0.25];
    for (let channel = 0; channel < 3; channel += 1) {
        for (let index = 0; index < 9; index += 1) {
            const offset = channel * 9 + index;
            sh[offset] =
                sh[offset]! * correction * irradianceScale[index]!;
        }
    }
    return preScalePolynomial(shToPolynomial(sh));
}

function cubemapMipZero(image: HdrImage, faceSize: number): Uint16Array[] {
    const result: Uint16Array[] = [];
    for (let face = 0; face < 6; face += 1) {
        const pixels = new Uint16Array(faceSize * faceSize * 4);
        const corner = face * 12;
        for (let y = 0; y < faceSize; y += 1) {
            const v = y / faceSize;
            for (let x = 0; x < faceSize; x += 1) {
                const u = x / faceSize;
                let directionX =
                    faceCorners[corner]! * (1 - u) * (1 - v) +
                    faceCorners[corner + 3]! * u * (1 - v) +
                    faceCorners[corner + 6]! * (1 - u) * v +
                    faceCorners[corner + 9]! * u * v;
                let directionY =
                    faceCorners[corner + 1]! * (1 - u) * (1 - v) +
                    faceCorners[corner + 4]! * u * (1 - v) +
                    faceCorners[corner + 7]! * (1 - u) * v +
                    faceCorners[corner + 10]! * u * v;
                let directionZ =
                    faceCorners[corner + 2]! * (1 - u) * (1 - v) +
                    faceCorners[corner + 5]! * u * (1 - v) +
                    faceCorners[corner + 8]! * (1 - u) * v +
                    faceCorners[corner + 11]! * u * v;
                const inverseLength =
                    1 /
                    Math.sqrt(
                        directionX * directionX +
                            directionY * directionY +
                            directionZ * directionZ,
                    );
                directionX *= inverseLength;
                directionY *= inverseLength;
                directionZ *= inverseLength;
                const theta = Math.atan2(directionZ, directionX);
                const phi = Math.acos(Math.max(-1, Math.min(1, directionY)));
                const sourceX = Math.max(
                    0,
                    Math.min(
                        image.width - 1,
                        Math.round((theta / Math.PI * 0.5 + 0.5) * image.width),
                    ),
                );
                const sourceYRaw = Math.max(
                    0,
                    Math.min(
                        image.height - 1,
                        Math.round((phi / Math.PI) * image.height),
                    ),
                );
                const sourceY = image.height - sourceYRaw - 1;
                const source = (sourceY * image.width + sourceX) * 3;
                const destination = (y * faceSize + x) * 4;
                pixels[destination] = floatToHalf(image.data[source]!);
                pixels[destination + 1] = floatToHalf(image.data[source + 1]!);
                pixels[destination + 2] = floatToHalf(image.data[source + 2]!);
                pixels[destination + 3] = 0x3c00;
            }
        }
        result.push(pixels);
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
    const sphericalHarmonics = computeSphericalHarmonics(image);
    const mipCount = mipLevelCount(faceSize);
    const mipZero = cubemapMipZero(image, faceSize);
    const levels = await prefilterCubemapGgx(mipZero, faceSize, mipCount, image);

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
