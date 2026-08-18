import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
    computeDdsSphericalHarmonics,
    packageDdsEnvironment,
    parseDdsCubemap,
} from "../src/dds-packager.js";
import { preScalePolynomial } from "../src/hdr-packager.js";
import { importPinnedModuleWithExports } from "../src/pinned-shader-composer.js";

interface PinnedDdsLoaderInternals {
    computeSH: (
        raw: Uint8Array,
        width: number,
        mipCount: number,
    ) => Float32Array;
}

function pinnedComputeSH(): Promise<PinnedDdsLoaderInternals> {
    return importPinnedModuleWithExports<PinnedDdsLoaderInternals>(
        "loader-env/load-dds-env.js",
        ["computeSH"],
    );
}

/**
 * A minimal legacy-header DDS cubemap: 2x2 faces, two mips, rgba16f, with
 * only the fields the parser and the pinned loader read populated. Texels
 * are distinct finite halfs so a face or mip transposition cannot cancel
 * out of the goldens.
 */
function smallDds(): Uint8Array {
    const bytes = new Uint8Array(128 + 6 * 5 * 8);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x20534444, true);
    view.setInt32(12, 2, true);
    view.setInt32(16, 2, true);
    view.setInt32(28, 2, true);
    let offset = 128;
    for (let face = 0; face < 6; face += 1) {
        let texel = 0;
        for (const size of [2, 1]) {
            for (let pixel = 0; pixel < size * size; pixel += 1) {
                view.setUint16(offset, 0x3c00 + face * 16 + texel, true);
                view.setUint16(offset + 2, 0x3800 + texel, true);
                view.setUint16(offset + 4, 0x3400 + face, true);
                view.setUint16(offset + 6, 0x3c00, true);
                offset += 8;
                texel += 1;
            }
        }
    }
    return bytes;
}

test("reaches the module-local pinned computeSH and runs its projection", async () => {
    // The seam itself: `computeSH` is not on the pinned module's export
    // surface, so it comes out of the module's own text via the appended
    // export, and projects the smallest possible cubemap — one texel per
    // face — into the 27-float polynomial. The golden locks the pinned
    // projection: a pin bump that changes it goes red here.
    const { computeSH } = await pinnedComputeSH();
    const raw = new Uint8Array(6 * 4 * 2);
    const view = new DataView(raw.buffer);
    for (let face = 0; face < 6; face += 1) {
        view.setUint16(face * 8, 0x3c00 + face, true);
        view.setUint16(face * 8 + 2, 0x3800, true);
        view.setUint16(face * 8 + 4, 0x3400, true);
        view.setUint16(face * 8 + 6, 0x3c00, true);
    }
    const polynomial = computeSH(raw, 1, 1);
    assert.equal(polynomial.length, 27);
    assert.ok([...polynomial].every(Number.isFinite));
    assert.equal(
        createHash("sha256")
            .update(
                new Uint8Array(
                    polynomial.buffer,
                    polynomial.byteOffset,
                    polynomial.byteLength,
                ),
            )
            .digest("hex"),
        "870de855f4c934f6fb01cd8274603934c8a194f407ae27d34135e3d494d01e3d",
    );
});

test("packages a deterministic DDS cubemap representation", () => {
    const cubemap = parseDdsCubemap(smallDds());
    assert.equal(cubemap.width, 2);
    assert.equal(cubemap.mipCount, 2);

    const packaged = packageDdsEnvironment(smallDds());
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
    // The harmonics are the pin executed, so this golden is a drift
    // detector: a pin bump that changes the projection goes red here. It is
    // also byte-for-byte what the former transcription produced, so every
    // generated DDS package survived the swap unchanged.
    assert.equal(
        createHash("sha256").update(packaged).digest("hex"),
        "7c4ed9676d1fedd9365993af138288c0f3206cb929584febe42d5f8bc7ea9434",
    );
});

test("applies exactly the pinned loader's chain to the harmonics", async () => {
    // `loadDdsEnvironment` hands `computeSH`'s polynomial straight to
    // `assembleEnvironmentTextures`, which pre-scales it before the shader
    // reads it; the packager must run that chain and nothing else.
    const { computeSH } = await pinnedComputeSH();
    const cubemap = parseDdsCubemap(smallDds());
    assert.deepEqual(
        computeDdsSphericalHarmonics(cubemap),
        preScalePolynomial(
            computeSH(cubemap.payload, cubemap.width, cubemap.mipCount),
        ),
    );
});
