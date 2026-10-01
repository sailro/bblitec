import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import {
    lowerMeshGeometryResize,
    lowerRenderBundleInvalidation,
} from "../src/lowering/mesh-geometry-resize.js";

/**
 * Engine calls whose pinned effect native frame loops and generation already
 * own, and the `performance.timeOrigin` read.
 */

const compile = (body: string) =>
    compileSource(`
        import {
            createEngine,
            enableShaderMaterialUniformCaching,
            resizeEngine,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            ${body}
        }
    `);

test("accepts resizeEngine and shader uniform caching with nothing left to run", () => {
    const { cpp } = compile(`
        enableShaderMaterialUniformCaching();
        resizeEngine(engine);
    `);
    assert.doesNotMatch(cpp, /resize|uniform_caching/i);
});

test("the pinned uniform caching only swaps the shader uniform writers", () => {
    const context = new LoweringContext();
    const { declaration } = context.functionDeclaration(
        "src/material/shader/enable-shader-material-uniform-caching.ts",
        "enableShaderMaterialUniformCaching",
    );
    context.assertStatementShapes(
        declaration,
        declaration.body!.statements,
        "_installShaderUniformWriters(writeCachedSystemUniforms, writeCachedCustomUniforms);",
        "shader uniform caching",
    );
});

test("reads performance.timeOrigin as the epoch time of the performance clock's zero", () => {
    const { cpp } = compile(`
        const origin = performance.timeOrigin;
        console.log(origin + performance.now());
    `);
    assert.match(cpp, /bbl::pal::performance_time_origin\(\)/);
});

test("invalidateRenderBundles reaches the native invalidation", () => {
    const compiled = compileSource(`
        import { createEngine, createMeshFromData, invalidateRenderBundles, resizeMeshGeometry } from "@babylonjs/lite";
        async function main() {
            const engine = await createEngine({});
            const mesh = createMeshFromData(engine, "m", new Float32Array(9), new Float32Array(9), new Uint32Array([0, 1, 2]));
            invalidateRenderBundles(engine);
            resizeMeshGeometry(engine, mesh, new Float32Array(9), new Float32Array(9), new Uint32Array([0, 1, 2]));
        }
    `);
    assert.ok(
        compiled.manifest.features.includes("mesh:render-bundle-invalidation"),
    );
    assert.match(compiled.cpp, /bbl::invalidate_render_bundles\(/);
});

test("the pinned invalidation lowers once, shared with geometry resizing", () => {
    const context = new LoweringContext();
    const invalidation = lowerRenderBundleInvalidation(context);
    assert.ok(
        invalidation.includes("void invalidate_render_bundles(Engine& engine)"),
    );
    assert.ok(invalidation.includes("++engine.draw_list_epoch"));
    assert.ok(invalidation.includes("render_topology_version++"));
    const shared = lowerMeshGeometryResize(context, true);
    assert.ok(shared.includes("invalidate_render_bundles(engine)"));
    assert.ok(!shared.includes("invalidate_mesh_geometry_bundles"));
    assert.ok(
        lowerMeshGeometryResize(context, false).includes(
            "static void invalidate_mesh_geometry_bundles(Engine& engine)",
        ),
    );
});

test("ArcRotate sensibility writes reach the camera record the controls read", () => {
    const { cpp } = compileSource(`
        import { createArcRotateCamera, createEngine } from "@babylonjs/lite";
        async function main() {
            await createEngine({});
            const camera = createArcRotateCamera(0, 1, 5, { x: 0, y: 0, z: 0 });
            camera.panningSensibility = 14;
            camera.angularSensibility = Math.max(500, camera.radius);
        }
    `);
    assert.match(cpp, /\.panning_sensibility = 14\.0/);
    assert.match(cpp, /\.angular_sensibility = /);
});
