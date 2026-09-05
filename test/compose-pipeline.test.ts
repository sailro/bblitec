import assert from "node:assert/strict";
import test from "node:test";
import {
    dynamicCasterFeatureSets,
    runtimePbrAssetFeatureSets,
    scenePbrMeshFeatureSets,
    staticSceneLightArms,
    uniformRuntimeMeshAttributes,
} from "../src/compose-pipeline.js";

test("dynamic caster views retain imported and scene mesh feature arms", () => {
    assert.deepEqual(
        dynamicCasterFeatureSets([1], [0], [16]),
        [0, 1, 16, 17],
    );
});

test("runtime Standard attributes ignore live shadow receiving but retain attribute ambiguity", () => {
    assert.equal(uniformRuntimeMeshAttributes([0, 256, 0], 256), 0);
    assert.equal(uniformRuntimeMeshAttributes([1, 257], 256), 1);
    assert.equal(uniformRuntimeMeshAttributes([0, 257], 256), undefined);
    assert.equal(uniformRuntimeMeshAttributes([], 256), undefined);
});

test("runtime PBR features combine thin instances with shadow receiving", () => {
    assert.deepEqual(
        runtimePbrAssetFeatureSets([1], [16], [256]),
        [1, 17, 257, 273],
    );
});

test("an always-present pool retains its conditional colour arm", () => {
    assert.deepEqual(
        scenePbrMeshFeatureSets(4, "always", true, 16, 32),
        [20, 52],
    );
    assert.deepEqual(
        scenePbrMeshFeatureSets(4, "possible", true, 16, 32),
        [4, 20, 52],
    );
    assert.deepEqual(
        scenePbrMeshFeatureSets(4, "always", false, 16, 32),
        [20],
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
