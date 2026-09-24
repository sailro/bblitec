import assert from "node:assert/strict";
import test from "node:test";

import { parseBlendExport } from "../src/lowering/pinned-blend-table.js";

test("reads a blend descriptor's family and cutout arm from the pinned module", () => {
    assert.deepEqual(parseBlendExport("spriteBlendMultiply"), {
        family: "sprite",
        cutout: false,
        symbol: "sprite_blend_multiply",
    });
    // The billboard cutout is the pin's `_depthMode: "cutout"` descriptor.
    assert.deepEqual(parseBlendExport("billboardBlendCutout"), {
        family: "billboard",
        cutout: true,
        symbol: "billboard_blend_cutout",
    });
    assert.equal(parseBlendExport("billboardBlendAlpha")?.cutout, false);
});

test("a pinned export spelled like a blend descriptor is not one", () => {
    // Exported by other pinned modules; a name pattern would take them.
    assert.equal(parseBlendExport("cascadeBlendPercentage"), undefined);
    assert.equal(parseBlendExport("meshBlendTagTexture"), undefined);
    assert.equal(parseBlendExport("spriteBlendUnknown"), undefined);
});
