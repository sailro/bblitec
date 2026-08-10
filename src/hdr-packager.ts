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
    if (
        width >= 8 &&
        width <= 0x7fff &&
        bytes[position] === 2 &&
        bytes[position + 1] === 2 &&
        bytes[position + 2] === ((width >> 8) & 0xff) &&
        bytes[position + 3] === (width & 0xff)
    ) {
        position += 4;
        for (let channel = 0; channel < 4; channel += 1) {
            let pointer = channel;
            let count = 0;
            while (count < width) {
                const marker = bytes[position++]!;
                if (marker > 128) {
                    const runLength = marker - 128;
                    const value = bytes[position++]!;
                    for (let index = 0; index < runLength; index += 1) {
                        scanline[pointer] = value;
                        pointer += 4;
                    }
                    count += runLength;
                } else {
                    if (marker === 0) throw new Error("Invalid HDR scanline run.");
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
        if (position + 4 > bytes.length) throw new Error("HDR pixel data is truncated.");
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

function shToPolynomial(sh: Float64Array): Float32Array {
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

function preScalePolynomial(polynomial: Float32Array): Float32Array {
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

function floatToHalf(value: number): number {
    if (Number.isNaN(value)) return 0x7e00;
    const sign = value < 0 || Object.is(value, -0) ? 0x8000 : 0;
    const absolute = Math.abs(value);
    if (absolute === Number.POSITIVE_INFINITY) return sign | 0x7c00;
    if (absolute === 0) return sign;
    if (absolute >= 65504) return sign | 0x7bff;
    if (absolute < 2 ** -24) return sign;
    if (absolute < 2 ** -14) {
        return sign | Math.round(absolute / 2 ** -24);
    }
    const exponent = Math.floor(Math.log2(absolute));
    const mantissa = absolute / 2 ** exponent - 1;
    let halfExponent = exponent + 15;
    let halfMantissa = Math.round(mantissa * 1024);
    if (halfMantissa === 1024) {
        halfMantissa = 0;
        halfExponent += 1;
    }
    return sign | (halfExponent << 10) | halfMantissa;
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

function halfToFloat(value: number): number {
    const sign = (value & 0x8000) !== 0 ? -1 : 1;
    const exponent = (value >> 10) & 0x1f;
    const mantissa = value & 0x3ff;
    if (exponent === 0) return sign * mantissa * 2 ** -24;
    if (exponent === 0x1f) return mantissa === 0 ? sign * Number.POSITIVE_INFINITY : Number.NaN;
    return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

function downsampleFace(source: Uint16Array, sourceSize: number): Uint16Array {
    const size = Math.max(sourceSize >> 1, 1);
    const result = new Uint16Array(size * size * 4);
    for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
            const destination = (y * size + x) * 4;
            for (let channel = 0; channel < 3; channel += 1) {
                let sum = 0;
                for (let offsetY = 0; offsetY < 2; offsetY += 1) {
                    for (let offsetX = 0; offsetX < 2; offsetX += 1) {
                        const sourceX = Math.min(x * 2 + offsetX, sourceSize - 1);
                        const sourceY = Math.min(y * 2 + offsetY, sourceSize - 1);
                        sum += halfToFloat(
                            source[(sourceY * sourceSize + sourceX) * 4 + channel]!,
                        );
                    }
                }
                result[destination + channel] = floatToHalf(sum * 0.25);
            }
            result[destination + 3] = 0x3c00;
        }
    }
    return result;
}

function mipLevelCount(size: number): number {
    return Math.floor(Math.log2(size)) + 1;
}

export function packageHdrEnvironment(bytes: Uint8Array, faceSize: number): Uint8Array {
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
    const levels: Uint16Array[][] = [cubemapMipZero(image, faceSize)];
    let size = faceSize;
    for (let mip = 1; mip < mipCount; mip += 1) {
        levels.push(levels[mip - 1]!.map((face) => downsampleFace(face, size)));
        size = Math.max(size >> 1, 1);
    }

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
