import assert from "node:assert/strict";
import test from "node:test";
import { packageHdrEnvironment, parseRgbe } from "../src/hdr-packager.js";

function smallHdr(): Uint8Array {
    const header = new TextEncoder().encode(
        "#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 2 +X 2\n",
    );
    const pixels = new Uint8Array([
        64, 32, 16, 136,
        32, 64, 16, 136,
        16, 32, 64, 136,
        64, 64, 64, 136,
    ]);
    const result = new Uint8Array(header.length + pixels.length);
    result.set(header);
    result.set(pixels, header.length);
    return result;
}

test("packages a deterministic HDR cubemap representation", () => {
    const image = parseRgbe(smallHdr());
    assert.equal(image.width, 2);
    assert.equal(image.height, 2);
    assert.deepEqual([...image.data.slice(0, 3)], [64, 32, 16]);

    const packaged = packageHdrEnvironment(smallHdr(), 2);
    assert.deepEqual(
        [...packaged.slice(0, 8)],
        [0x42, 0x42, 0x4c, 0x48, 0x44, 0x52, 0x31, 0],
    );
    const view = new DataView(
        packaged.buffer,
        packaged.byteOffset,
        packaged.byteLength,
    );
    assert.equal(view.getUint32(8, true), 2);
    assert.equal(view.getUint32(12, true), 2);
    assert.equal(packaged.byteLength, 364);
});

test("rejects unsupported HDR cubemap dimensions", () => {
    assert.throws(
        () => packageHdrEnvironment(smallHdr(), 3),
        /power of two/,
    );
});
