import assert from "node:assert/strict";
import test from "node:test";
import { generateIblBrdfLutRgba16f } from "../src/ibl-brdf-lut.js";

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

test("generates the pinned EXT_lights_image_based BRDF LUT", () => {
    const bytes = generateIblBrdfLutRgba16f();
    assert.equal(bytes.byteLength, 256 * 256 * 8);
    const values = new Uint16Array(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength / 2,
    );
    const center = (128 * 256 + 128) * 4;
    assert.ok(
        Math.abs(halfToFloat(values[center]!) - 0.02192) < 0.0001,
    );
    assert.ok(
        Math.abs(halfToFloat(values[center + 1]!) - 0.85458) < 0.001,
    );
    assert.equal(values[center + 2]!, 0);
    assert.equal(halfToFloat(values[center + 3]!), 1);
});
