import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { packageHdrEnvironment, parseRgbe } from "../src/hdr-packager.js";
import {
    getHdrGgxPrefilterProvenance,
    prefilterCubemapGgx,
} from "../src/hdr-prefilter-gpu.js";
import { readUpstreamPin } from "../src/upstream-source.js";

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

function hdrBytes(
    width: number,
    height: number,
    pixels: readonly number[],
): Uint8Array {
    const header = new TextEncoder().encode(
        `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`,
    );
    const result = new Uint8Array(
        header.length + pixels.length,
    );
    result.set(header);
    result.set(pixels, header.length);
    return result;
}

function rleHdr(): Uint8Array {
    return hdrBytes(
        8,
        1,
        [
            2, 2, 0, 8,
            136, 64,
            136, 32,
            136, 16,
            136, 136,
        ],
    );
}

test("packages a deterministic HDR cubemap representation", async () => {
    const image = parseRgbe(smallHdr());
    assert.equal(image.width, 2);
    assert.equal(image.height, 2);
    assert.deepEqual([...image.data.slice(0, 3)], [64, 32, 16]);

    const packaged = await packageHdrEnvironment(smallHdr(), 2);
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
    assert.equal(
        createHash("sha256").update(packaged).digest("hex"),
        "e600de7cca4608446b5e9b5d1ac7d5780efdbfa333f177daddaaee54378146fe",
    );
});

test("decodes valid HDR scanline RLE", () => {
    const image = parseRgbe(rleHdr());
    assert.equal(image.width, 8);
    assert.equal(image.height, 1);
    for (let pixel = 0; pixel < 8; pixel += 1) {
        assert.deepEqual(
            [...image.data.slice(pixel * 3, pixel * 3 + 3)],
            [64, 32, 16],
        );
    }
});

test("rejects truncated and overflowing HDR scanline RLE", () => {
    const truncated = rleHdr().slice(0, -1);
    assert.throws(
        () => parseRgbe(truncated),
        /scanline run value is truncated/,
    );

    const overflow = hdrBytes(
        8,
        1,
        [
            2, 2, 0, 8,
            137, 64,
        ],
    );
    assert.throws(
        () => parseRgbe(overflow),
        /Invalid HDR scanline run length/,
    );
});

test("rejects unsupported legacy HDR repeat encoding", () => {
    const legacy = hdrBytes(
        2,
        1,
        [
            64, 32, 16, 136,
            1, 1, 1, 1,
        ],
    );
    assert.throws(
        () => parseRgbe(legacy),
        /Legacy HDR scanline repeat encoding is unsupported/,
    );
});

test("rejects unsupported HDR cubemap dimensions", async () => {
    await assert.rejects(
        packageHdrEnvironment(smallHdr(), 3),
        /power of two/,
    );
});

test("preserves mip zero and deterministically applies pinned GGX semantics", async () => {
    const faceSize = 4;
    const faces = Array.from({ length: 6 }, (_, face) => {
        const pixels = new Uint16Array(faceSize * faceSize * 4);
        for (let pixel = 0; pixel < faceSize * faceSize; pixel += 1) {
            pixels[pixel * 4] = 0x3c00 + face * 16 + pixel;
            pixels[pixel * 4 + 1] = 0x3800 + pixel;
            pixels[pixel * 4 + 2] = 0x3400 + face;
            pixels[pixel * 4 + 3] = 0x3c00;
        }
        return pixels;
    });
    const first = await prefilterCubemapGgx(faces, faceSize, 3);
    const second = await prefilterCubemapGgx(faces, faceSize, 3);
    assert.strictEqual(first[0], faces);
    assert.deepEqual(first, second);
    assert.notDeepEqual(first[1]![0], faces[0]!.slice(0, first[1]![0]!.length));

    const digest = createHash("sha256");
    for (const mip of first) {
        for (const face of mip) digest.update(new Uint8Array(face.buffer));
    }
    assert.equal(
        digest.digest("hex"),
        "1c33fe95c972aea59fb51fd9bfacae79ed084b9523cbc3270b4f468fd22c4755",
    );
    const pin = readUpstreamPin();
    assert.deepEqual(getHdrGgxPrefilterProvenance(), {
        package: `${pin.package}@${pin.version}`,
        sourceCommit: pin.sourceVersion,
        module: "src/loader-hdr/hdr-ibl-pipeline.ts",
        shader: "shaders/hdr-prefilter-cube.compute.wgsl",
        sampleCount: 1024,
    });
});
