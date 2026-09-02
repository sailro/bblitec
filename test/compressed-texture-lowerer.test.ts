// The compressed-texture loader's two ends have to agree about one layout:
// the emitted parser reads a KTX1 header, and the transcode packager writes
// one. Both take it from the same derivation off the pinned parser, and
// these tests are what keep that true — a disagreement would otherwise
// surface as the generated parser misreading its own generated container.
import assert from "node:assert/strict";
import test from "node:test";

import {
    CompressedTextureLowerer,
    uploadableCompressedFormats,
} from "../src/lowering/compressed-texture-lowerer.js";
import { LoweringContext } from "../src/lowering/context.js";
import { UpstreamSourceStore } from "../src/upstream-source.js";
import { writeKtx1 } from "../src/basis-transcode.js";

function lowerer(): CompressedTextureLowerer {
    return new CompressedTextureLowerer(
        new LoweringContext(new UpstreamSourceStore()),
    );
}

test("reads the KTX1 header layout off the pinned parser", () => {
    const header = lowerer().headerLayout();
    // The pin's own offsets (ktx-loader.ts parseKtx1). They are asserted
    // here rather than only derived, because every one of them also has to
    // be what a KTX1 file actually holds -- the format is the contract the
    // pin and this port both answer to.
    assert.equal(header.endianness.offset, 12);
    assert.equal(header.endianness.expected, 0x04030201);
    assert.equal(header.glType.offset, 16);
    assert.equal(header.glType.expected, 0);
    assert.equal(header.glFormat.offset, 24);
    assert.equal(header.glFormat.expected, 0);
    assert.equal(header.glInternalFormat, 28);
    assert.equal(header.width, 36);
    assert.equal(header.height, 40);
    assert.equal(header.pixelDepth, 44);
    assert.equal(header.arrayElements, 48);
    assert.equal(header.faces, 52);
    assert.equal(header.mipLevels, 56);
    assert.equal(header.keyValueBytes, 60);
    assert.equal(header.headerSize, 64);
});

test("emits the block-compressed rows both backends bind", () => {
    const emitted = lowerer().lower();
    const names = [
        ...emitted.header.matchAll(/"(bc[^"]+)"/g),
    ].map((match) => match[1]!);
    assert.deepEqual(
        [...new Set(names)].sort(),
        [...uploadableCompressedFormats].sort(),
    );
    // The pin maps two GL enums onto BC1 (its RGB and RGBA spellings), so
    // the row count exceeds the format count by exactly that pair.
    assert.equal(names.length, uploadableCompressedFormats.length + 1);
    // ETC2 and ASTC rows exist in the pinned table and are not emitted:
    // no D3D12 adapter reports either feature, and a container naming one
    // refuses where the pin refuses an unknown format.
    assert.ok(!emitted.header.includes("etc2-"));
    assert.ok(!emitted.header.includes("astc-"));
});

test("resolves a KTX suffix through the pin's own feature mapping", () => {
    const compressed = lowerer();
    assert.equal(
        compressed.suffixFeature("-dxt.ktx"),
        "texture-compression-bc",
    );
    assert.equal(
        compressed.suffixFeature("-astc.ktx"),
        "texture-compression-astc",
    );
    assert.equal(
        compressed.suffixFeature("-etc2.ktx"),
        "texture-compression-etc2",
    );
    assert.equal(compressed.suffixFeature("-pvrtc.ktx"), undefined);
    // The pin's own rewrite: the suffix replaces the last extension, and a
    // query string rides along.
    assert.equal(
        compressed.rewriteUrl("https://host/path/UVgrid.png", "-dxt.ktx"),
        "https://host/path/UVgrid-dxt.ktx",
    );
    assert.equal(
        compressed.rewriteUrl("https://host/grid.png?v=2", "-dxt.ktx"),
        "https://host/grid-dxt.ktx?v=2",
    );
    assert.equal(
        compressed.rewriteUrl("https://host/grid", "-dxt.ktx"),
        "https://host/grid-dxt.ktx",
    );
});

test("packages a transcode the emitted parser reads back", () => {
    const compressed = lowerer();
    const header = compressed.headerLayout();
    // Two levels of a 8x4 BC7 texture: one block row of two, then the tail
    // level, which still occupies one whole block.
    const mips = [
        { width: 8, height: 4, bytes: new Uint8Array(32).fill(0xa5) },
        { width: 4, height: 2, bytes: new Uint8Array(16).fill(0x5a) },
    ];
    const container = writeKtx1(
        { gpuFormat: "bc7-rgba-unorm", width: 8, height: 4, mips },
        compressed.magicBytes(),
        compressed.glInternalFormat("bc7-rgba-unorm"),
        header,
    );
    const view = new DataView(
        container.buffer,
        container.byteOffset,
        container.byteLength,
    );
    const read = (offset: number): number => view.getUint32(offset, true);
    assert.deepEqual(
        [...container.subarray(0, compressed.magicBytes().length)],
        compressed.magicBytes(),
    );
    assert.equal(read(header.endianness.offset), header.endianness.expected);
    assert.equal(read(header.glType.offset), header.glType.expected);
    assert.equal(read(header.glFormat.offset), header.glFormat.expected);
    assert.equal(read(header.glInternalFormat), 0x8e8c);
    assert.equal(read(header.width), 8);
    assert.equal(read(header.height), 4);
    assert.equal(read(header.pixelDepth), 0);
    assert.equal(read(header.arrayElements), 0);
    assert.equal(read(header.faces), 1);
    assert.equal(read(header.mipLevels), 2);
    assert.equal(read(header.keyValueBytes), 0);
    // The level run the parser walks: a size, its bytes, then the pin's own
    // four-byte alignment before the next.
    let offset = header.headerSize;
    for (const mip of mips) {
        assert.equal(read(offset), mip.bytes.length);
        offset += 4;
        assert.deepEqual(
            [...container.subarray(offset, offset + mip.bytes.length)],
            [...mip.bytes],
        );
        offset += (mip.bytes.length + 3) & ~3;
    }
    assert.equal(offset, container.length);
});

test("refuses a transcode whose chain does not halve", () => {
    const compressed = lowerer();
    assert.throws(
        () =>
            writeKtx1(
                {
                    gpuFormat: "bc7-rgba-unorm",
                    width: 8,
                    height: 4,
                    mips: [
                        {
                            width: 8,
                            height: 4,
                            bytes: new Uint8Array(32),
                        },
                        // KTX1 stores no per-level size, so a reader
                        // recovers this one by halving; a level that is not
                        // where halving lands cannot be expressed.
                        { width: 3, height: 2, bytes: new Uint8Array(16) },
                    ],
                },
                compressed.magicBytes(),
                compressed.glInternalFormat("bc7-rgba-unorm"),
                compressed.headerLayout(),
            ),
        /transcoded level 1 is 3x2/,
    );
});

test("refuses to package a format the pinned table has no enum for", () => {
    assert.throws(
        () => lowerer().glInternalFormat("astc-4x4-unorm"),
        /no KTX1 enum for 'astc-4x4-unorm'/,
    );
});

test("packages an sRGB KTX2 slot under the pin's own sRGB twin", () => {
    const compressed = lowerer();
    // A KTX2 transcode is colour-space-agnostic: uploadKtx2Texture2D decodes
    // the same blocks either way and its sRGB argument only picks this twin,
    // so one bake serves both and the container states which view its blocks
    // decode through.
    assert.equal(
        compressed.srgbGpuFormat("bc7-rgba-unorm"),
        "bc7-rgba-unorm-srgb",
    );
    assert.notEqual(
        compressed.glInternalFormat("bc7-rgba-unorm-srgb"),
        compressed.glInternalFormat("bc7-rgba-unorm"),
    );
    assert.throws(
        () => compressed.srgbGpuFormat("bc7-rgba-unorm-srgb"),
        /no twin for 'bc7-rgba-unorm-srgb'/,
    );
});

test("checks a padded capture against the padded chain", () => {
    const compressed = lowerer();
    const block = compressed.blockSize("bc7-rgba-unorm");
    assert.deepEqual(block, { width: 4, height: 4 });
    // ktx2-loader.ts writes each level's BLOCK-PADDED copy extent, where
    // basis-loader.ts writes the level's own size, so the tail level of an
    // 8x4 chain is captured as 4x4 rather than 4x2. Handing the block size
    // over is what states which loader produced the capture.
    const mips = [
        { width: 8, height: 4, bytes: new Uint8Array(32) },
        { width: 4, height: 4, bytes: new Uint8Array(16) },
    ];
    const texture = { gpuFormat: "bc7-rgba-unorm", width: 8, height: 4, mips };
    assert.doesNotThrow(() =>
        writeKtx1(
            texture,
            compressed.magicBytes(),
            compressed.glInternalFormat("bc7-rgba-unorm"),
            compressed.headerLayout(),
            block,
        ),
    );
    assert.throws(
        () =>
            writeKtx1(
                texture,
                compressed.magicBytes(),
                compressed.glInternalFormat("bc7-rgba-unorm"),
                compressed.headerLayout(),
            ),
        /transcoded level 1 is 4x4/,
    );
});
