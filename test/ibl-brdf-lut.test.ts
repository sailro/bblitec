import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
    generateIblBrdfLutRgba16f,
    getIblBrdfLutProvenance,
} from "../src/ibl-brdf-lut.js";
import { readUpstreamPin } from "../src/upstream-source.js";

function halfToFloat(bits: number): number {
    const sign = (bits & 0x8000) === 0 ? 1 : -1;
    const exponent = (bits >>> 10) & 0x1f;
    const mantissa = bits & 0x3ff;
    if (exponent === 0) {
        return sign * 2 ** -14 * (mantissa / 1024);
    }
    if (exponent === 0x1f) {
        return mantissa === 0 ? sign * Infinity : Number.NaN;
    }
    return sign * 2 ** (exponent - 15) * (1 + mantissa / 1024);
}

// sha256 of the executed pinned LUT bytes, filled from the first real run
// on the reference device; the assertion message prints the actual digest.
const expectedSha256 = "b4fb89ffb67ab282ad0d1ba459796efc67af0d373dde90e39bd6caac42dcf2e8";

test("executes the pinned EXT_lights_image_based BRDF LUT", async () => {
    const bytes = await generateIblBrdfLutRgba16f();
    assert.equal(bytes.byteLength, 256 * 256 * 8);
    const values = new Uint16Array(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength / 2,
    );
    // The shader stores vec4f(bias, scale + bias, 0.0, 1.0); blue and
    // alpha are exact in float16, and the center texel's range holds
    // under any device's rounding ULPs (the old JS derivation measured
    // 0.02192 and 0.85458 there).
    const center = (128 * 256 + 128) * 4;
    const bias = halfToFloat(values[center]!);
    assert.ok(bias > 0.015 && bias < 0.03, `center bias was ${bias}`);
    const scaleBias = halfToFloat(values[center + 1]!);
    assert.ok(
        scaleBias > 0.8 && scaleBias < 0.9,
        `center scale+bias was ${scaleBias}`,
    );
    assert.equal(values[center + 2]!, 0);
    assert.equal(values[center + 3]!, 0x3c00);

    const again = await generateIblBrdfLutRgba16f();
    assert.deepEqual(again, bytes);

    const actualSha256 = createHash("sha256").update(bytes).digest("hex");
    assert.equal(
        actualSha256,
        expectedSha256,
        `BRDF LUT sha256 was ${actualSha256}; pin it as expectedSha256.`,
    );
});

test("reports the pinned BRDF LUT provenance", () => {
    const pin = readUpstreamPin();
    assert.deepEqual(getIblBrdfLutProvenance(), {
        package: `${pin.package}@${pin.version}`,
        sourceCommit: pin.sourceVersion,
        module: "src/loader-gltf/ibl-env-assembly.ts",
        shader: "shaders/hdr-brdf-lut.compute.wgsl",
        sampleCount: 1024,
    });
});
