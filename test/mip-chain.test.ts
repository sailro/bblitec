import assert from "node:assert/strict";
import test from "node:test";
import { mipChainBytes, mipChainViews } from "../src/mip-chain.js";

test("GPU bake mip views preserve packed bytes, layers and nonzero offsets", () => {
    for (const [width, height, levels, texelBytes, layers] of [
        [8, 4, 4, 4, 1],
        [4, 4, 3, 8, 6],
    ] as const) {
        const bytes = mipChainBytes(width, height, levels, texelBytes, layers);
        const backing = Uint8Array.from(
            { length: bytes + 16 },
            (_, index) => index % 251,
        );
        const payload = backing.subarray(8, bytes + 8);
        const views = mipChainViews(
            payload,
            width,
            height,
            levels,
            texelBytes,
            layers,
        );
        assert.deepEqual(Buffer.concat(views.flat()), Buffer.from(payload));
        let offset = payload.byteOffset;
        for (const [level, faces] of views.entries()) {
            assert.equal(faces.length, layers);
            for (const face of faces) {
                assert.equal(face.buffer, backing.buffer);
                assert.equal(face.byteOffset, offset);
                assert.equal(
                    face.byteLength,
                    Math.max(1, width >> level) *
                        Math.max(1, height >> level) *
                        texelBytes,
                );
                offset += face.byteLength;
            }
        }
        assert.equal(offset, payload.byteOffset + bytes);
    }
});
