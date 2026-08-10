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
        "renderer:pbr",
    ]);
    assert.deepEqual(result.manifest.assets, []);
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
            "sdl-platform-boundary",
            "sdl-gpu-shader-backends",
        ],
    );
    assert.deepEqual(result.manifest.generatedSources, [
        "upstream/src/engine.cpp",
        "upstream/src/scene_core.cpp",
        "upstream/src/camera_arc_rotate.cpp",
        "upstream/src/camera_controls.cpp",
        "upstream/src/light_matrix.cpp",
        "upstream/src/light_hemispheric.cpp",
        "upstream/src/renderer_plan.cpp",
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

test("compiles pinned scene 213 GridMaterial options", () => {
    const source = readFileSync(
        resolve("examples/scene213-grid-material.ts"),
        "utf8",
    );
    const result = compileSource(source, {
        fileName: "examples/scene213-grid-material.ts",
    });

    assert.ok(result.manifest.features.includes("material:grid"));
    assert.ok(result.manifest.features.includes("renderer:pbr"));
    assert.ok(
        result.manifest.generatedSources.includes(
            "upstream/src/material_grid.cpp",
        ),
    );
    assert.match(result.cpp, /bbl::create_grid_material/);
    assert.match(result.cpp, /bbl::GridMaterialOptions/);
    assert.match(result.cpp, /0\.6f, 1\.0f, true, false, false, true/);
    assert.match(
        result.cpp,
        /5\.0f, 0\.5f, 1\.0f, 1\.0f, true, false, true, true/,
    );
    assert.ok(
        result.manifest.adaptations.some(
            ({ id }) => id === "grid-tint-specialization",
        ),
    );
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
        "environment:env",
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
            "background-dither-disabled",
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

test("compiles Babylon Lite scene 8 HDR glass sphere", () => {
    const source = readFileSync(
        resolve("examples/scene8-hdr-glass.ts"),
        "utf8",
    );
    const result = compileSource(source, {
        fileName: "examples/scene8-hdr-glass.ts",
    });

    assert.deepEqual(result.manifest.features, [
        "core",
        "backend:sdl",
        "camera:arc-rotate",
        "environment:ibl",
        "environment:hdr",
        "background:skybox",
        "light:point",
        "material:pbr",
        "mesh:sphere",
        "renderer:pbr",
    ]);
    assert.deepEqual(
        result.manifest.assets.map(({ source, kind, faceSize }) => ({
            source,
            kind,
            ...(faceSize === undefined ? {} : { faceSize }),
        })),
        [
            {
                source: "https://playground.babylonjs.com/textures/room.hdr",
                kind: "hdr-environment",
                faceSize: 512,
            },
            {
                source: "https://raw.githubusercontent.com/BabylonJS/Babylon-Lite/master/packages/babylon-lite/assets/brdf-lut.png",
                kind: "texture",
            },
        ],
    );
    assert.match(result.cpp, /bbl::load_hdr_environment/);
    assert.match(result.cpp, /bbl::create_point_light/);
    assert.match(result.cpp, /\.environment\.exposure = 0\.66f/);
    assert.match(result.cpp, /\.environment\.contrast = 1\.66f/);
    assert.match(
        result.cpp,
        /PbrMaterialOptions\{[^}]*0\.0f, 0\.7f, 0\.5f, 0\.2f, false, false, false, 0\.0f, 1\.5f/,
    );
    assert.ok(
        result.manifest.generatedSources.includes(
            "upstream/src/environment_hdr.cpp",
        ),
    );
    assert.ok(
        !result.manifest.generatedSources.includes(
            "upstream/src/env_parse.cpp",
        ),
    );
    assert.ok(
        !result.manifest.generatedSources.includes(
            "upstream/src/environment.cpp",
        ),
    );
    assert.ok(
        result.manifest.generatedSources.includes(
            "upstream/src/light_point.cpp",
        ),
    );
    assert.ok(
        result.manifest.adaptations.some(
            ({ id }) => id === "compile-time-hdr-cubemap",
        ),
    );
    assert.ok(
        !result.manifest.adaptations.some(
            ({ id }) => id === "background-ground-opt-in",
        ),
    );
});

test("compiles independent transmission material gates", () => {
    const source = readFileSync(
        resolve("examples/transmission-volume-gate.ts"),
        "utf8",
    );
    const result = compileSource(source, {
        fileName: "examples/transmission-volume-gate.ts",
    });

    assert.ok(result.manifest.features.includes("renderer:transmission"));
    assert.match(result.cpp, /bbl::enable_scene_transmission/);
    assert.match(
        result.cpp,
        /PbrMaterialOptions\{[^}]*false, false, false, 1\.0f, 1\.5f, 1\.4f, false, true, bbl::Color3\{1\.0f, 0\.35f, 0\.06f\}, 1\.5f/,
    );
});

test("compiles Babylon Lite scene 273 runtime material-family addition", () => {
    const source = readFileSync(
        resolve("examples/scene273-runtime-material-family.ts"),
        "utf8",
    );
    const result = compileSource(source, {
        fileName: "examples/scene273-runtime-material-family.ts",
    });

    assert.deepEqual(result.manifest.features, [
        "core",
        "backend:sdl",
        "camera:arc-rotate",
        "light:hemispheric",
        "material:pbr",
        "material:standard",
        "mesh:box",
        "mesh:ground",
        "renderer:pbr",
    ]);
    assert.match(result.cpp, /\.fixed_delta_ms = 16\.0f/);
    assert.match(result.cpp, /bbl::on_before_render/);
    assert.match(result.cpp, /v_frame\+\+/);
    assert.match(result.cpp, /if \(\(v_frame == 20\.0f\)\)/);
    assert.match(
        result.cpp,
        /PbrMaterialOptions\{[^}]*0\.1f, 0\.4f, 1\.0f, 0\.0f, 1\.0f, 0\.04f, false, false, false, 0\.0f, 1\.5f/,
    );
    assert.match(
        result.cpp,
        /if \(\(v_frame == \(20\.0f \+ 150\.0f\)\)\)/,
    );
    assert.doesNotMatch(result.cpp, /dataset|drawCallCount/);
    assert.deepEqual(result.manifest.generatedSources, [
        "upstream/src/engine.cpp",
        "upstream/src/scene_core.cpp",
        "upstream/src/camera_arc_rotate.cpp",
        "upstream/src/camera_controls.cpp",
        "upstream/src/light_matrix.cpp",
        "upstream/src/light_hemispheric.cpp",
        "upstream/src/renderer_plan.cpp",
        "upstream/src/material_pbr.cpp",
        "upstream/src/material_standard.cpp",
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
        "environment:env",
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

test("compiles Babylon Lite scene 32 unlit glTF", () => {
    const source = readFileSync(resolve("examples/scene32-unlit.ts"), "utf8");
    const result = compileSource(source, {
        fileName: "examples/scene32-unlit.ts",
    });

    assert.ok(result.manifest.features.includes("loader:gltf"));
    assert.ok(result.manifest.features.includes("renderer:pbr"));
    assert.match(result.cpp, /\.alpha \+= bbl::pi/);
    assert.match(result.cpp, /UnlitTest\.glb/);
});

test("compiles Babylon Lite scene 168 mirrored winding", () => {
    const source = readFileSync(resolve("examples/scene168-mirrored-winding.ts"), "utf8");
    const result = compileSource(source, {
        fileName: "examples/scene168-mirrored-winding.ts",
    });

    assert.ok(result.manifest.features.includes("loader:gltf"));
    assert.ok(result.manifest.features.includes("renderer:pbr"));
    assert.match(result.cpp, /MirroredDoubleSided\.glb/);
    assert.match(result.cpp, /\.clear_color = bbl::Color4\{0\.05f, 0\.06f, 0\.09f, 1\.0f\}/);
});

test("compiles Babylon Lite scene 257 negative scale", () => {
    const source = readFileSync(resolve("examples/scene257-negative-scale.ts"), "utf8");
    const result = compileSource(source, {
        fileName: "examples/scene257-negative-scale.ts",
    });

    assert.ok(result.manifest.features.includes("loader:gltf"));
    assert.ok(result.manifest.features.includes("renderer:pbr"));
    assert.match(result.cpp, /std::sqrt\(800\.0f\)/);
    assert.match(result.cpp, /Node_NegativeScale_01\.glb/);
});

test("compiles Babylon Lite scene 266 negative scale spheres", () => {
    const source = readFileSync(resolve("examples/scene266-negative-scale-spheres.ts"), "utf8");
    const result = compileSource(source, {
        fileName: "examples/scene266-negative-scale-spheres.ts",
    });

    assert.ok(result.manifest.features.includes("loader:gltf"));
    assert.ok(result.manifest.features.includes("renderer:pbr"));
    assert.match(result.cpp, /NegativeScaleTest\.glb/);
    assert.match(result.cpp, /bbl::pi \/ 2\.15f/);
});

test("compiles Babylon Lite scene 274 alpha to coverage", () => {
    const source = readFileSync(resolve("examples/scene274-alpha-to-coverage.ts"), "utf8");
    const result = compileSource(source, {
        fileName: "examples/scene274-alpha-to-coverage.ts",
    });

    assert.ok(result.manifest.features.includes("material:shader"));
    assert.ok(result.manifest.features.includes("mesh:plane"));
    assert.ok(result.manifest.features.includes("renderer:pbr"));
    assert.match(result.cpp, /bbl::create_shader_material/);
    assert.match(result.cpp, /bbl::set_alpha_to_coverage/);
    assert.match(result.cpp, /bbl::create_plane/);
    assert.deepEqual(result.manifest.shaderVariants, ["alpha-card"]);
    assert.match(
        result.cpp,
        /bbl::ShaderMaterialVariant::alpha_card/,
    );
    assert.ok(result.manifest.generatedSources.includes("upstream/src/material_shader.cpp"));
});

test("compiles Babylon Lite scene 163 shader alpha cutout", () => {
    const source = readFileSync(
        resolve("examples/scene163-shader-alpha-cutout.ts"),
        "utf8",
    );
    const result = compileSource(source, {
        fileName: "examples/scene163-shader-alpha-cutout.ts",
    });

    assert.ok(result.manifest.features.includes("camera:arc-rotate"));
    assert.ok(result.manifest.features.includes("material:shader"));
    assert.ok(result.manifest.features.includes("mesh:plane"));
    assert.ok(result.manifest.features.includes("renderer:pbr"));
    assert.deepEqual(result.manifest.shaderVariants, ["circular-cutout"]);
    assert.match(
        result.cpp,
        /bbl::ShaderMaterialVariant::circular_cutout/,
    );
    assert.match(
        result.cpp,
        /bbl::PlaneOptions\{3\.0f, 3\.0f\}/,
    );
    assert.ok(
        result.manifest.adaptations.some(
            ({ id }) => id === "typed-reached-shader-variants",
        ),
    );
});

test("compiles Babylon Lite scene 146 geometry outputs and frame graph", () => {
    const source = readFileSync(
        resolve("examples/scene146-geometry-output.ts"),
        "utf8",
    );
    const result = compileSource(source, {
        fileName: "examples/scene146-geometry-output.ts",
    });

    assert.ok(result.manifest.features.includes("renderer:geometry-output"));
    assert.deepEqual(result.manifest.geometryOutputTasks, [
        {
            shaderIndex: 0,
            attachments: [
                "IRRADIANCE",
                "WORLD_POSITION",
                "NORMALIZED_VIEW_DEPTH",
                "VIEW_NORMAL",
                "WORLD_NORMAL",
                "REFLECTIVITY",
                "ALBEDO",
            ],
            emitColor: true,
        },
        {
            shaderIndex: 1,
            attachments: [
                "LOCAL_POSITION",
                "VIEW_DEPTH",
                "SCREENSPACE_DEPTH",
                "LINEAR_VELOCITY",
            ],
            emitColor: false,
        },
    ]);
    assert.match(result.cpp, /bbl::create_geometry_renderer_task/);
    assert.match(result.cpp, /bbl::geometry_task_texture/);
    assert.match(result.cpp, /bbl::create_copy_to_texture_task/);
    assert.match(result.cpp, /bbl::add_task_at_start/);
    assert.match(
        result.cpp,
        /NormalizedViewport\{\(1\.0 \/ 6\.0\), 0\.0, \(1\.0 \/ 6\.0\), 0\.15\}/,
    );
    assert.ok(
        result.manifest.generatedSources.includes(
            "upstream/src/frame_graph_geometry.cpp",
        ),
    );
    assert.ok(
        result.manifest.adaptations.some(
            ({ id }) => id === "sdl-gpu-frame-graph",
        ),
    );
});

test("compiles Babylon Lite scene 116 no-color depth views", () => {
    const source = readFileSync(
        resolve("examples/scene116-no-color-depth.ts"),
        "utf8",
    );
    const result = compileSource(source, {
        fileName: "examples/scene116-no-color-depth.ts",
    });

    assert.ok(result.manifest.features.includes("material:no-color-view"));
    assert.ok(result.manifest.features.includes("mesh:torus"));
    assert.ok(result.manifest.features.includes("renderer:geometry-output"));
    assert.match(result.cpp, /bbl::create_render_target_texture/);
    assert.match(result.cpp, /bbl::create_torus/);
    assert.match(result.cpp, /bbl::create_standard_no_color_material_view/);
    assert.match(result.cpp, /bbl::create_pbr_no_color_material_view/);
    assert.match(result.cpp, /bbl::add_render_task_mesh/);
    assert.match(result.cpp, /emissive_render_texture/);
    assert.match(
        result.cpp,
        /RenderTaskOptions\{"standard-shadow-depth"[\s\S]*v_standardDepthCamera, true, true/,
    );
    assert.ok(
        result.manifest.generatedSources.includes(
            "upstream/src/material_views.cpp",
        ),
    );
    assert.ok(
        result.manifest.generatedSources.includes(
            "upstream/src/frame_graph_geometry.cpp",
        ),
    );
});

test("compiles Babylon Lite scene 145 standard geometry outputs", () => {
    const source = readFileSync(
        resolve("examples/scene145-standard-geometry-output.ts"),
        "utf8",
    );
    const result = compileSource(source, {
        fileName: "examples/scene145-standard-geometry-output.ts",
    });

    assert.deepEqual(result.manifest.features, [
        "core",
        "backend:sdl",
        "camera:free",
        "loader:babylon",
        "material:standard",
        "renderer:pbr",
        "renderer:geometry-output",
    ]);
    assert.equal(result.manifest.assets[0]?.kind, "babylon");
    assert.match(result.manifest.assets[0]?.output ?? "", /HillValley\/HillValley\.babylon$/);
    assert.match(result.cpp, /bbl::load_babylon/);
    assert.match(result.cpp, /bbl::create_free_camera/);
    assert.match(result.cpp, /\.fov = 0\.8985202f/);
    assert.ok(
        result.manifest.generatedSources.includes(
            "upstream/src/babylon_loader.cpp",
        ),
    );
    assert.ok(
        result.manifest.generatedSources.includes(
            "upstream/src/frame_graph_geometry.cpp",
        ),
    );
    assert.equal(result.manifest.geometryOutputTasks.length, 2);
});

test("compiles Babylon Lite scene 248 external glTF", () => {
    const source = readFileSync(resolve("examples/scene248-texture-settings.ts"), "utf8");
    const result = compileSource(source, {
        fileName: "examples/scene248-texture-settings.ts",
    });

    const asset = result.manifest.assets.find(({ kind }) => kind === "gltf");
    assert.equal(asset?.output.endsWith(".glb"), true);
    assert.match(asset?.source ?? "", /TextureSettingsTest\.gltf$/);
    assert.match(result.cpp, /\.fov = 0\.8f/);
    assert.match(result.cpp, /\.near_plane =/);
    assert.match(result.cpp, /\.far_plane =/);
});

test("compiles animated and skinned glTF scenes", () => {
    for (const sourcePath of [
        "examples/scene5-alien.ts",
        "examples/scene240-animated-triangle.ts",
        "examples/scene245-recursive-skeletons.ts",
    ]) {
        const result = compileSource(
            readFileSync(resolve(sourcePath), "utf8"),
            { fileName: sourcePath },
        );
        assert.ok(result.manifest.features.includes("loader:gltf"));
        assert.ok(result.manifest.features.includes("renderer:pbr"));
        assert.equal(result.manifest.assets[0]?.kind, "gltf");
    }
});

test("compiles property animation scenes", () => {
    for (const sourcePath of [
        "examples/scene151-property-transform-animation.ts",
        "examples/scene154-step-time-animation.ts",
    ]) {
        const result = compileSource(
            readFileSync(resolve(sourcePath), "utf8"),
            { fileName: sourcePath },
        );
        assert.ok(
            result.manifest.features.includes(
                "animation:property",
            ),
        );
        assert.ok(
            result.manifest.features.includes(
                "light:directional",
            ),
        );
        assert.match(
            result.cpp,
            /create_property_animation_group/,
        );
        assert.match(
            result.cpp,
            /start_animation_manager/,
        );
    }
});

test("compiles Babylon Lite scene 249 vertex alpha clip", () => {
    const source = readFileSync(
        resolve("examples/scene249-vertex-alpha-clip.ts"),
        "utf8",
    );
    const result = compileSource(source, {
        fileName: "examples/scene249-vertex-alpha-clip.ts",
    });
    const asset = result.manifest.assets.find(({ kind }) => kind === "gltf");
    assert.match(asset?.source ?? "", /VertexColorAlphaClipTest\.gltf$/);
    assert.equal(asset?.output.endsWith(".glb"), true);
    assert.ok(result.manifest.features.includes("loader:gltf"));
    assert.ok(result.manifest.features.includes("renderer:pbr"));
});
