import assert from "node:assert/strict";
import test from "node:test";
import {
    dynamicCasterFeatureSets,
    staticSceneLightArms,
} from "../src/compose-pipeline.js";

test("dynamic caster views retain imported and scene mesh feature arms", () => {
    assert.deepEqual(
        dynamicCasterFeatureSets([1], [0], [16]),
        [0, 1, 16, 17],
    );
});

test("static scene light arms retain the shadow-receiver multi-light path", () => {
    assert.deepEqual(staticSceneLightArms([], false), {
        lightKinds: [],
        multiLight: false,
        noLight: true,
    });
    assert.deepEqual(staticSceneLightArms(["spot"], false), {
        lightKinds: ["spot"],
        multiLight: false,
        noLight: false,
    });
    assert.deepEqual(staticSceneLightArms(["spot"], true), {
        lightKinds: ["spot"],
        multiLight: true,
        noLight: false,
    });
    assert.deepEqual(
        staticSceneLightArms(["point", "directional"], true),
        {
            lightKinds: [],
            multiLight: true,
            noLight: false,
        },
    );
});
