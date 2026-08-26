import assert from "node:assert/strict";
import test from "node:test";
import { resolveGeometryExtensions } from "../src/compressed-geometry.js";
import { buildGlb, readGlbFixture } from "./glb-fixture.js";

/**
 * A minimal GLB whose one accessor is sparse: a three-element FLOAT SCALAR
 * over a base of zeros, with the middle element overridden.
 */
function sparseGlb(sparse = true): Uint8Array {
    const base = Buffer.alloc(12); // three zero floats
    const indices = Buffer.from([1]); // UNSIGNED_BYTE, element 1
    const values = Buffer.alloc(4);
    values.writeFloatLE(7.5, 0);
    const padding = Buffer.alloc(3); // keep the value view 4-aligned
    const binary = Buffer.concat([base, indices, padding, values]);
    return buildGlb(
        {
            asset: { version: "2.0" },
            buffers: [{ byteLength: binary.length }],
            bufferViews: [
                { buffer: 0, byteOffset: 0, byteLength: 12 },
                { buffer: 0, byteOffset: 12, byteLength: 1 },
                { buffer: 0, byteOffset: 16, byteLength: 4 },
            ],
            accessors: [
                {
                    bufferView: 0,
                    componentType: 5126,
                    count: 3,
                    type: "SCALAR",
                    ...(sparse
                        ? {
                              sparse: {
                                  count: 1,
                                  indices: {
                                      bufferView: 1,
                                      componentType: 5121,
                                  },
                                  values: { bufferView: 2 },
                              },
                          }
                        : {}),
                },
            ],
        },
        binary,
    );
}

test("materializes sparse accessors through the pinned preParse hook", async () => {
    const { document, binary } = readGlbFixture(
        await resolveGeometryExtensions(sparseGlb(), "sparse.glb"),
    );
    const accessors = document.accessors as Array<Record<string, unknown>>;
    // `.sparse` is gone and the accessor names a freshly appended, tightly
    // packed view -- what the pinned hook leaves behind, and what makes the
    // rest of the loader unaware of sparse.
    assert.equal(accessors[0]!.sparse, undefined);
    assert.equal(accessors[0]!.byteOffset, 0);
    const views = document.bufferViews as Array<Record<string, unknown>>;
    const view = views[accessors[0]!.bufferView as number]!;
    assert.equal(view.byteLength, 12);
    const offset = view.byteOffset as number;
    // The base's zeros survive; the one substitution landed on element 1.
    assert.equal(binary.readFloatLE(offset), 0);
    assert.equal(binary.readFloatLE(offset + 4), 7.5);
    assert.equal(binary.readFloatLE(offset + 8), 0);
});

test("passes an asset with no sparse accessor through byte-for-byte", async () => {
    // The registry's own trigger is the `.sparse` property, so the same
    // document without it must come back as the bytes it went in as.
    const plain = sparseGlb(false);
    assert.deepEqual(
        Buffer.from(await resolveGeometryExtensions(plain, "plain.glb")),
        Buffer.from(plain),
    );
});
