import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
    generatedSourceRules,
    reachedGeneratedSources,
} from "../src/generated-sources.js";

test("reaches only the sources a feature set implies", () => {
    // Nothing reached still builds the engine and scene core.
    assert.deepEqual(reachedGeneratedSources([]), [
        "upstream/src/engine.cpp",
        "upstream/src/scene_core.cpp",
    ]);

    // A free camera reaches the shared arc-rotate math and controls too,
    // which is why the rule lists three camera features.
    assert.deepEqual(reachedGeneratedSources(["camera:free"]), [
        "upstream/src/engine.cpp",
        "upstream/src/scene_core.cpp",
        "upstream/src/camera_arc_rotate.cpp",
        "upstream/src/camera_controls.cpp",
        "upstream/src/camera_free.cpp",
    ]);

    // Several mesh features share one factory source; it appears once.
    const meshes = reachedGeneratedSources([
        "mesh:box",
        "mesh:sphere",
        "mesh:thin-instances",
    ]);
    assert.deepEqual(
        meshes.filter(
            (source) =>
                source === "upstream/src/mesh_factories.cpp",
        ),
        ["upstream/src/mesh_factories.cpp"],
    );
});

test("keeps the manifest order stable regardless of feature order", () => {
    const forward = reachedGeneratedSources([
        "material:standard",
        "renderer:pbr",
        "camera:arc-rotate",
    ]);
    const reversed = reachedGeneratedSources([
        "camera:arc-rotate",
        "renderer:pbr",
        "material:standard",
    ]);
    assert.deepEqual(forward, reversed);
    assert.deepEqual(forward, [
        "upstream/src/engine.cpp",
        "upstream/src/scene_core.cpp",
        "upstream/src/camera_arc_rotate.cpp",
        "upstream/src/camera_controls.cpp",
        "upstream/src/renderer_plan.cpp",
        "upstream/src/material_standard.cpp",
    ]);
});

test("is the only place a generated source is declared", () => {
    // The emitter is checked against this table at generation time; the
    // compiler must not carry a second copy of the mapping.
    const compiler = readFileSync("src/compiler.ts", "utf8");
    assert.doesNotMatch(compiler, /generatedSources\.push/);
    assert.match(compiler, /reachedGeneratedSources\(features\)/);

    const upstream = readFileSync("src/upstream-lower.ts", "utf8");
    assert.match(
        upstream,
        /Generated source table disagrees with what was emitted/,
    );

    // Every rule names a real source path exactly once.
    const paths = generatedSourceRules.map((rule) => rule.source);
    assert.equal(new Set(paths).size, paths.length);
    for (const path of paths) {
        assert.match(path, /^upstream\/src\/[a-z_0-9]+\.cpp$/);
    }
});
