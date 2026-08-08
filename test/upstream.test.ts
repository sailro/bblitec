import assert from "node:assert/strict";
import test from "node:test";
import { analyzeUpstreamGraph } from "../src/upstream-graph.js";
import {
    lowerArcRotateFactory,
    lowerDefaultCameraFactory,
    lowerEnvParser,
    lowerHemisphericFactory,
    lowerLightMatrix,
} from "../src/upstream-lower.js";
import { LoweringContext } from "../src/lowering/context.js";
import { CameraLowerer } from "../src/lowering/camera-lowerer.js";
import { SceneLowerer } from "../src/lowering/scene-lowerer.js";
import { GltfLowerer } from "../src/lowering/gltf-lowerer.js";
import { UpstreamSourceStore } from "../src/upstream-source.js";

test("loads pinned Babylon Lite TypeScript from published source maps", () => {
    const store = new UpstreamSourceStore();
    assert.equal(store.pin.version, "1.18.0");
    assert.equal(store.pin.sourceVersion, "7184feda683072980735f9a180e6f567ee5717ba");
    assert.match(store.getSource("src/light/light-matrix.ts"), /function localMatrixFromDirection/);
    assert.equal(store.resolvePublicExport("createHemisphericLight").modulePath, "src/light/hemispheric.ts");
});

test("generates the Babylon environment parser from upstream constants", () => {
    const lowered = lowerEnvParser();
    assert.match(lowered.source, /0x86, 0x16, 0x87, 0x96, 0xf6, 0xd6, 0x96, 0x36/);
    assert.match(lowered.source, /constexpr float c1 = 1\.4999984284682104f/);
    assert.match(lowered.source, /face\.mime_type = "image\/png"/);
});

test("generates scene defaults, routing, and idempotent registration", () => {
    const lowered = new SceneLowerer(new LoweringContext()).lowerCore();
    assert.match(lowered.source, /scene\.clear_color = Color4\{\s*0\.2f,\s*0\.2f,\s*0\.3f,\s*1\.0f/s);
    assert.match(lowered.source, /for \(const MeshHandle mesh : record\.meshes\)/);
    assert.match(lowered.source, /registered_scenes\.end\(\)/);
});

test("generates GLB framing validation from upstream constants", () => {
    const lowered = new GltfLowerer(new LoweringContext()).lowerGlbParser();
    assert.match(lowered.source, /0x46546c67/);
    assert.match(lowered.source, /0x4e4f534a/);
    assert.match(lowered.source, /0x4e4942/);
});

test("generates the public hemispheric light factory from upstream defaults", () => {
    const lowered = lowerHemisphericFactory();
    assert.match(lowered.source, /Generated from @babylonjs\/lite@1\.18\.0/);
    assert.match(lowered.source, /light\.diffuse_color = Color3\{1\.0f, 1\.0f, 1\.0f\}/);
    assert.match(lowered.source, /light\.ground_color = Color3\{0\.0f, 0\.0f, 0\.0f\}/);
});

test("generates ArcRotate and default camera factories from upstream constants", () => {
    const lowerer = new CameraLowerer(new LoweringContext());
    const arc = lowerer.lowerArcRotateFactory();
    const framing = lowerDefaultCameraFactory();
    const controls = lowerer.lowerControls();
    assert.match(arc.source, /camera\.fov = 0\.8f/);
    assert.match(arc.source, /camera\.angular_sensibility = 1000\.0f/);
    assert.match(framing.source, /radius = diagonal \* 1\.5f/);
    assert.match(framing.source, /record\.near_plane = radius \* 0\.01f/);
    assert.match(framing.source, /record\.far_plane = radius \* 1000\.0f/);
    assert.match(controls.source, /rotation_epsilon = 0\.001f/);
    assert.match(controls.source, /camera\.inertial_alpha_offset \*= camera\.inertia/);
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
