import assert from "node:assert/strict";
import test from "node:test";
import { analyzeUpstreamGraph } from "../src/upstream-graph.js";
import { lowerHemisphericFactory, lowerLightMatrix } from "../src/upstream-lower.js";
import { UpstreamSourceStore } from "../src/upstream-source.js";

test("loads pinned Babylon Lite TypeScript from published source maps", () => {
    const store = new UpstreamSourceStore();
    assert.equal(store.pin.version, "1.18.0");
    assert.equal(store.pin.sourceVersion, "7184feda683072980735f9a180e6f567ee5717ba");
    assert.match(store.getSource("src/light/light-matrix.ts"), /function localMatrixFromDirection/);
    assert.equal(store.resolvePublicExport("createHemisphericLight").modulePath, "src/light/hemispheric.ts");
});

test("generates the public hemispheric light factory from upstream defaults", () => {
    const lowered = lowerHemisphericFactory();
    assert.match(lowered.source, /Generated from @babylonjs\/lite@1\.18\.0/);
    assert.match(lowered.source, /light\.diffuse_color = Color3\{1\.0f, 1\.0f, 1\.0f\}/);
    assert.match(lowered.source, /light\.ground_color = Color3\{0\.0f, 0\.0f, 0\.0f\}/);
});

test("lowers the reachable upstream light matrix implementation", () => {
    const lowered = lowerLightMatrix();
    assert.equal(lowered.modulePath, "src/light/light-matrix.ts");
    assert.match(lowered.source, /std::sqrt/);
    assert.match(lowered.source, /m\[15\] = 1\.0f/);
    assert.match(lowered.source, /Generated from @babylonjs\/lite@1\.18\.0/);
});

test("builds a conservative reachable module graph", () => {
    const graph = analyzeUpstreamGraph(new UpstreamSourceStore(), [
        "createHemisphericLight",
        "createDefaultCamera",
    ]);
    assert.ok(graph.summary.moduleCount > 5);
    assert.ok(graph.modules.some((module) => module.path === "src/light/light-matrix.ts"));
    assert.ok(graph.summary.diagnostics.closures > 0);
});
