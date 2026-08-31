import assert from "node:assert/strict";
import test from "node:test";
import {
    expandRuntimeMeshFeatureSets,
    pinnedInstanceColorBit,
    pinnedThinInstancesBit,
} from "../src/pinned-mesh-features.js";

test("runtime mesh-feature expansion preserves the full generic lattice", async () => {
    const thin = await pinnedThinInstancesBit();
    const anotherRuntimeBit = thin << 1;

    assert.deepEqual(
        expandRuntimeMeshFeatureSets(
            [0, 64, 64],
            [thin, anotherRuntimeBit],
        ),
        [
            0,
            64,
            thin,
            64 | thin,
            anotherRuntimeBit,
            64 | anotherRuntimeBit,
            thin | anotherRuntimeBit,
            64 | thin | anotherRuntimeBit,
        ],
    );
});

test("expands instance colour only as a thin-instance composite", async () => {
    const thin = await pinnedThinInstancesBit();
    const color = await pinnedInstanceColorBit();

    assert.deepEqual(
        expandRuntimeMeshFeatureSets([0], [thin, thin | color]),
        [0, thin, thin | color],
    );
});
