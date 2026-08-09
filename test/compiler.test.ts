import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { CompileError, compileSource } from "../src/compiler.js";

test("compiles the Babylon Lite primitives example", () => {
    const source = readFileSync(resolve("examples/primitives.ts"), "utf8");
    const result = compileSource(source, { fileName: "examples/primitives.ts" });

    assert.deepEqual(result.manifest.features, [
        "core",
        "backend:sdl",
        "camera:arc-rotate",
        "light:hemispheric",
        "material:standard",
        "mesh:box",
        "mesh:ground",
    ]);
    assert.deepEqual(result.manifest.assets, []);
    assert.deepEqual(result.manifest.runtimeSources, [
        "src/pal.cpp",
        "src/pal_sdl.cpp",
    ]);
    assert.deepEqual(
        result.manifest.adaptations.map(({ id }) => id),
        [
            "entry-main-wrapper-erasure",
            "browser-setup-erasure",
            "synchronous-aot-await",
            "sdl-platform-boundary",
        ],
    );
    assert.deepEqual(result.manifest.generatedSources, [
        "upstream/src/engine.cpp",
        "upstream/src/scene_core.cpp",
        "upstream/src/camera_arc_rotate.cpp",
        "upstream/src/camera_controls.cpp",
        "upstream/src/light_matrix.cpp",
        "upstream/src/light_hemispheric.cpp",
        "upstream/src/material_standard.cpp",
        "upstream/src/mesh_factories.cpp",
    ]);
    assert.match(result.cpp, /bbl::create_box/);
    assert.match(result.cpp, /bbl::create_ground/);
    assert.match(result.cpp, /\.diffuse_color =/);
    assert.match(result.cpp, /bbl::start_engine/);
    assert.doesNotMatch(result.cpp, /document|getElementById|Promise/);
    assert.match(result.cmake, /mesh_factories\.cpp/);
});

test("emits only reached native feature modules", () => {
    const result = compileSource(`
        import { addToScene, createBox, createEngine, createSceneContext, registerScene, startEngine } from "@babylonjs/lite";
        async function main(): Promise<void> {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            const scene = createSceneContext(engine);
            addToScene(scene, createBox(engine, 2));
            await registerScene(scene);
            await startEngine(engine);
        }
        main().catch(console.error);
    `);

    assert.deepEqual(result.manifest.features, ["core", "backend:sdl", "mesh:box"]);
    assert.deepEqual(result.manifest.generatedSources, [
        "upstream/src/engine.cpp",
        "upstream/src/scene_core.cpp",
        "upstream/src/mesh_factories.cpp",
    ]);
    assert.doesNotMatch(result.cmake, /material_standard|mesh_ground|camera_/);
});

test("supports aliased Babylon Lite imports", () => {
    const result = compileSource(`
        import { createEngine as engineFactory, createSceneContext as sceneFactory } from "@babylonjs/lite";
        async function main(): Promise<void> {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await engineFactory(canvas);
            const scene = sceneFactory(engine);
            scene.clearColor = [0, 0, 0, 1];
        }
    `);

    assert.match(result.cpp, /create_engine/);
    assert.match(result.cpp, /\.clear_color =/);
});

test("reports unsupported Babylon Lite APIs with source locations", () => {
    assert.throws(
        () =>
            compileSource(
                `import { createEngine, loadTexture2D } from "@babylonjs/lite";
async function main() {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    await loadTexture2D(engine, "texture.png");
}`,
                { fileName: "unsupported.ts" },
            ),
        (error: unknown) => {
            assert.ok(error instanceof CompileError);
            assert.match(error.message, /^unsupported\.ts:5:11:/);
            assert.match(error.message, /loadTexture2D/);
            return true;
        },
    );
});

test("compiles the authoritative GitHub BoomBox parity scene", () => {
    const source = readFileSync(resolve("examples/boombox.ts"), "utf8");
    const result = compileSource(source, { fileName: "examples/boombox.ts" });

    assert.deepEqual(result.manifest.features, [
        "core",
        "backend:sdl",
        "camera:arc-rotate",
        "camera:default",
        "environment:ibl",
        "background:ground",
        "background:skybox",
        "light:hemispheric",
        "loader:gltf",
        "renderer:pbr",
    ]);
    assert.deepEqual(result.manifest.runtimeSources, [
        "src/pal.cpp",
        "src/pal_sdl.cpp",
        "src/pal_sdl_gpu.cpp",
    ]);
    assert.deepEqual(
        result.manifest.adaptations.map(({ id }) => id),
        [
            "entry-main-wrapper-erasure",
            "browser-setup-erasure",
            "synchronous-aot-await",
            "compile-time-asset-materialization",
            "sdl-platform-boundary",
            "sdl-gpu-shader-backends",
            "background-ground-opt-in",
        ],
    );
    assert.deepEqual(
        result.manifest.assets.map(({ source, kind }) => ({ source, kind })),
        [
            {
                source: "https://playground.babylonjs.com/scenes/BoomBox.glb",
                kind: "gltf",
            },
            {
                source: "https://assets.babylonjs.com/core/environments/environmentSpecular.env",
                kind: "environment",
            },
            {
                source: "https://assets.babylonjs.com/core/environments/backgroundGround.png",
                kind: "texture",
            },
            {
                source: "https://assets.babylonjs.com/core/environments/backgroundSkybox.dds",
                kind: "texture",
            },
            {
                source: "https://raw.githubusercontent.com/BabylonJS/Babylon-Lite/master/packages/babylon-lite/assets/brdf-lut.png",
                kind: "texture",
            },
        ],
    );
    assert.match(result.cpp, /bbl::load_gltf/);
    assert.match(result.cpp, /bbl::load_environment/);
    assert.match(result.cpp, /bbl::create_default_camera/);
    assert.match(result.cpp, /\.alpha = 1\.77538f/);
    assert.doesNotMatch(result.cpp, /performance|Object::assign|drawCallCount/);
    assert.match(result.cmake, /gltf_loader\.cpp/);
    assert.deepEqual(result.manifest.generatedSources, [
        "upstream/src/engine.cpp",
        "upstream/src/scene_core.cpp",
        "upstream/src/camera_arc_rotate.cpp",
        "upstream/src/camera_controls.cpp",
        "upstream/src/camera_default.cpp",
        "upstream/src/env_parse.cpp",
        "upstream/src/environment.cpp",
        "upstream/src/light_matrix.cpp",
        "upstream/src/light_hemispheric.cpp",
        "upstream/src/gltf_glb_parser.cpp",
        "upstream/src/gltf_loader.cpp",
        "upstream/src/renderer_plan.cpp",
    ]);
});

test("compiles Babylon Lite scene 10 PBR rough sphere", () => {
    const source = readFileSync(resolve("examples/scene10-pbr-rough.ts"), "utf8");
    const result = compileSource(source, {
        fileName: "examples/scene10-pbr-rough.ts",
    });

    assert.deepEqual(result.manifest.features, [
        "core",
        "backend:sdl",
        "camera:arc-rotate",
        "light:hemispheric",
        "material:pbr",
        "mesh:sphere",
        "renderer:pbr",
    ]);
    assert.deepEqual(result.manifest.runtimeSources, [
        "src/pal.cpp",
        "src/pal_sdl.cpp",
        "src/pal_sdl_gpu.cpp",
    ]);
    assert.deepEqual(result.manifest.assets, []);
    assert.match(result.cpp, /bbl::create_solid_texture/);
    assert.match(result.cpp, /bbl::create_pbr_material/);
    assert.match(result.cpp, /bbl::create_sphere/);
    assert.match(result.cpp, /\.material =/);
    assert.deepEqual(result.manifest.generatedSources, [
        "upstream/src/engine.cpp",
        "upstream/src/scene_core.cpp",
        "upstream/src/camera_arc_rotate.cpp",
        "upstream/src/camera_controls.cpp",
        "upstream/src/light_matrix.cpp",
        "upstream/src/light_hemispheric.cpp",
        "upstream/src/renderer_plan.cpp",
        "upstream/src/material_pbr.cpp",
        "upstream/src/mesh_factories.cpp",
    ]);
});

test("compiles Babylon Lite scene 13 PBR spheres grid", () => {
    const source = readFileSync(resolve("examples/scene13-pbr-spheres.ts"), "utf8");
    const result = compileSource(source, {
        fileName: "examples/scene13-pbr-spheres.ts",
    });

    assert.deepEqual(result.manifest.features, [
        "core",
        "backend:sdl",
        "camera:arc-rotate",
        "camera:default",
        "environment:ibl",
        "background:ground",
        "light:hemispheric",
        "loader:gltf",
        "renderer:pbr",
    ]);
    assert.deepEqual(
        result.manifest.assets.map(({ source, kind }) => ({ source, kind })),
        [
            {
                source: "https://assets.babylonjs.com/meshes/PBR_Spheres.glb",
                kind: "gltf",
            },
            {
                source: "https://assets.babylonjs.com/core/environments/environmentSpecular.env",
                kind: "environment",
            },
            {
                source: "https://assets.babylonjs.com/core/environments/backgroundGround.png",
                kind: "texture",
            },
            {
                source: "https://raw.githubusercontent.com/BabylonJS/Babylon-Lite/master/packages/babylon-lite/assets/brdf-lut.png",
                kind: "texture",
            },
        ],
    );
    assert.match(result.cpp, /PBR_Spheres\.glb/);
    assert.doesNotMatch(result.cpp, /skipSkybox/);
});
