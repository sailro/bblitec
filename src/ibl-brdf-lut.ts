import { floatToHalf } from "./half-float.js";

const lutSize = 256;
const sampleCount = 1024;

// Offline form of loader-gltf's pinned hdr-brdf-lut.compute WGSL.
function radicalInverse(index: number): number {
    let bits = index >>> 0;
    bits = ((bits << 16) | (bits >>> 16)) >>> 0;
    bits = (((bits & 0x55555555) << 1) | ((bits & 0xaaaaaaaa) >>> 1)) >>> 0;
    bits = (((bits & 0x33333333) << 2) | ((bits & 0xcccccccc) >>> 2)) >>> 0;
    bits = (((bits & 0x0f0f0f0f) << 4) | ((bits & 0xf0f0f0f0) >>> 4)) >>> 0;
    bits = (((bits & 0x00ff00ff) << 8) | ((bits & 0xff00ff00) >>> 8)) >>> 0;
    return bits * 2.3283064365386963e-10;
}

export function generateIblBrdfLutRgba16f(): Uint8Array {
    const radical = new Float64Array(sampleCount);
    const cosine = new Float64Array(sampleCount);
    const sine = new Float64Array(sampleCount);
    for (let sample = 0; sample < sampleCount; ++sample) {
        radical[sample] = radicalInverse(sample);
        const phi = 2 * Math.PI * (sample / sampleCount);
        cosine[sample] = Math.cos(phi);
        sine[sample] = Math.sin(phi);
    }

    const values = new Uint16Array(lutSize * lutSize * 4);
    for (let y = 0; y < lutSize; ++y) {
        const roughness = Math.max((y + 0.5) / lutSize, 0.04);
        const alphaSquared = roughness ** 4;
        for (let x = 0; x < lutSize; ++x) {
            const ndotV = Math.max((x + 0.5) / lutSize, 0.001);
            const viewX = Math.sqrt(1 - ndotV * ndotV);
            let scale = 0;
            let bias = 0;
            for (let sample = 0; sample < sampleCount; ++sample) {
                const xi = radical[sample]!;
                const tangent =
                    Math.sqrt(
                        (1 - xi) /
                        (1 + (alphaSquared - 1) * xi),
                    );
                const radial = Math.sqrt(1 - tangent * tangent);
                const halfX = cosine[sample]! * radial;
                const halfZ = tangent;
                const vdotH = Math.max(
                    viewX * halfX + ndotV * halfZ,
                    0,
                );
                const lightZ = Math.max(
                    2 * vdotH * halfZ - ndotV,
                    0,
                );
                if (lightZ <= 0 || halfZ <= 0) continue;
                const visibility =
                    (
                        0.5 /
                        Math.max(
                            lightZ *
                                Math.sqrt(
                                    ndotV * ndotV *
                                        (1 - alphaSquared) +
                                    alphaSquared,
                                ) +
                            ndotV *
                                Math.sqrt(
                                    lightZ * lightZ *
                                        (1 - alphaSquared) +
                                    alphaSquared,
                                ),
                            1e-6,
                        )
                    ) *
                    lightZ *
                    (4 * vdotH / halfZ);
                const fresnel = (1 - vdotH) ** 5;
                scale += (1 - fresnel) * visibility;
                bias += fresnel * visibility;
            }
            const offset = (y * lutSize + x) * 4;
            values[offset] = floatToHalf(bias / sampleCount);
            values[offset + 1] = floatToHalf(
                (scale + bias) / sampleCount,
            );
            values[offset + 2] = 0;
            values[offset + 3] = floatToHalf(1);
        }
    }
    return new Uint8Array(values.buffer);
}
