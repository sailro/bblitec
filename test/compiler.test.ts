import assert from "node:assert/strict";
import { pinnedPackageSpecifiers } from "../src/capture-suite-reference.js";
import {
    babylonPackages,
    isBabylonModule,
} from "../src/compiler/symbols.js";
import {
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
    join,
    resolve,
} from "node:path";
import test from "node:test";
import { readUpstreamPin } from "../src/upstream-source.js";
import { CompileError, compileSource } from "../src/compiler.js";

/** A curated asset URL served from the pinned upstream tree; derived from
 *  the pin so a version bump does not churn these assertions. */
function pinnedAssetUrl(path: string): string {
    return (
        "https://raw.githubusercontent.com/BabylonJS/Babylon-Lite/" +
        `${readUpstreamPin().sourceVersion}/${path}`
    );
}

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

test("compiles pinned scene 2 directional light colors", () => {
    const sourcePath = "corpus/babylon-lite/lab/lite/src/lite/scene2.ts";
    const result = compileSource(
        readFileSync(resolve(sourcePath), "utf8"),
        { fileName: sourcePath },
    );

    assert.ok(result.manifest.features.includes("light:directional"));
    assert.ok(result.manifest.features.includes("material:standard"));
    assert.match(
        result.cpp,
        /\.lights\[v_light\.value\]\.diffuse_color = bbl::Color3\{1\.0f, 0\.0f, 0\.0f\}/,
    );
    assert.match(
        result.cpp,
        /\.lights\[v_light\.value\]\.specular_color = bbl::Color3\{0\.0f, 1\.0f, 0\.0f\}/,
    );
});

test("enforces light subtype property contracts", () => {
    const result = compileSource(`
        import {
            createEngine,
            createHemisphericLight,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const light = createHemisphericLight();
            light.diffuseColor = [0.25, 0.5, 0.75];
            light.specularColor = [0.75, 0.5, 0.25];
        }
    `);
    assert.match(
        result.cpp,
        /\.diffuse_color = bbl::Color3\{0\.25f, 0\.5f, 0\.75f\}/,
    );
    assert.throws(
        () =>
            compileSource(`
                import {
                    createDirectionalLight,
                    createEngine,
                } from "@babylonjs/lite";

                async function main() {
                    const engine = await createEngine({});
                    const light = createDirectionalLight([0, -1, 0]);
                    light.range = 10;
                }
            `),
        /Unsupported property assignment 'light\.range'/,
    );
});

test("records exact static scene composition reachability", () => {
    const result = compileSource(`
        import {
            addToScene,
            createBox,
            createEngine,
            createHemisphericLight,
            createPbrMaterial,
            createSceneContext,
            createSolidTexture2D,
            setThinInstances,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            addToScene(scene, createHemisphericLight([0, 1, 0], 1));

            const base = createSolidTexture2D(engine, 1, 1, 1);
            const orm = createSolidTexture2D(engine, 1, 0.5, 0);

            const plain = createBox(engine);
            plain.material = createPbrMaterial({ baseColorTexture: base, ormTexture: orm, baseColorFactor: [1, 0, 0, 1] });
            addToScene(scene, plain);

            const instanced = createBox(engine);
            instanced.material = createPbrMaterial({ baseColorTexture: base, ormTexture: orm, baseColorFactor: [0, 1, 0, 1] });
            setThinInstances(instanced, new Float32Array(16), 1);
            addToScene(scene, instanced);
        }
    `);

    assert.deepEqual(result.manifest.sceneLightKinds, ["hemispheric"]);
    assert.equal(result.manifest.dynamicSceneLights, false);
    assert.equal(result.manifest.mutableToneMappingEnabled, false);
    assert.deepEqual(
        result.manifest.scenePbrMaterials.map(({ sceneMeshIndices }) =>
            sceneMeshIndices
        ),
        [[0], [1]],
    );
    assert.deepEqual(
        result.manifest.sceneMeshes.map(({ thinInstances }) => thinInstances),
        [undefined, "always"],
    );
});

test("audio node factories publish independent link features", () => {
    const result = compileSource(`
        import { createAudioEngineAsync } from "@babylonjs/lite";
        async function main() {
            const audio = await createAudioEngineAsync();
            const oscillator = audio.audioContext.createOscillator();
            const state = audio.audioContext.state;
            if (state === "running") oscillator.start(audio.audioContext.currentTime);
        }
    `);

    assert.ok(result.manifest.features.includes("audio:engine"));
    assert.ok(result.manifest.features.includes("audio:oscillator"));
    assert.ok(!result.manifest.features.includes("audio:biquad-filter"));
    assert.ok(!result.manifest.features.includes("audio:stereo-panner"));
    assert.match(result.cpp, /bbl::pal::audio_state\(/);
});

test("folds feature detection for supported Web Audio factories", () => {
    const result = compileSource(`
        import { createAudioEngineAsync } from "@babylonjs/lite";
        async function main() {
            const audio = await createAudioEngineAsync();
            const ctx = audio.audioContext;
            const gain = ctx.createGain();
            let tail: AudioNode = gain;
            if (typeof ctx.createStereoPanner === "function") {
                const panner = ctx.createStereoPanner();
                panner.pan.value = -0.25;
                tail = panner;
            }
            tail.connect(ctx.destination);
        }
    `);

    assert.ok(result.manifest.features.includes("audio:stereo-panner"));
    assert.match(result.cpp, /audio_create_stereo_panner\(/);
    assert.match(result.cpp, /audio_param_set_value\([^;]*, \(-0\.25f\)\);/);
    assert.match(result.cpp, /v_tail = v_block\d+_panner;/);
});

test("runs successful nullable audio constructors and preserves source loops", () => {
    const result = compileSource(`
        import {
            createAudioEngineAsync,
            createEngine,
            type AudioEngine,
        } from "@babylonjs/lite";

        class LoopingSound {
            private readonly _engine: AudioEngine | null;
            private readonly _ctx: BaseAudioContext | null;
            private readonly _source: AudioBufferSourceNode | null;

            private constructor(
                engine: AudioEngine | null,
                ctx: BaseAudioContext | null,
                source: AudioBufferSourceNode | null,
            ) {
                this._engine = engine;
                this._ctx = ctx;
                this._source = source;
                if (ctx) {
                    const unlock = (): void => this._start();
                    window.addEventListener("keydown", unlock, { once: true });
                }
            }

            static async create(): Promise<LoopingSound> {
                try {
                    const engine = await createAudioEngineAsync();
                    const ctx = engine.audioContext;
                    const source = ctx.createBufferSource();
                    return new LoopingSound(engine, ctx, source);
                } catch {
                    return new LoopingSound(null, null, null);
                }
            }

            private _start(): void {
                if (!this._source) return;
                this._source.loop = true;
                this._source.playbackRate.value = 0.75;
                this._source.start();
            }
        }

        await createEngine({});
        await LoopingSound.create();
    `);

    assert.match(result.cpp, /bbl::on_key_down\(/);
    assert.match(result.cpp, /bbl::pal::audio_set_loop\([^;]*, true\);/);
    assert.match(
        result.cpp,
        /AudioParamName::PlaybackRate\), 0\.75f\);/,
    );
});

test("preserves Web Audio writes and nullable class resource assignments", () => {
    const result = compileSource(`
        import {
            createAudioEngineAsync,
            createSoundSourceAsync,
            type AudioEngine,
        } from "@babylonjs/lite";

        class SoundGraph {
            private engine: AudioEngine | null = null;
            private context: BaseAudioContext | null = null;
            private output: GainNode | null = null;

            async start(): Promise<void> {
                const engine = await createAudioEngineAsync();
                const output = engine.audioContext.createGain();
                output.gain.value = 0.6;
                await createSoundSourceAsync(engine, output);
                this.engine = engine;
                this.context = engine.audioContext;
                this.output = output;
                const optionalOutput = this.output ?? undefined;
                if (optionalOutput) optionalOutput.gain.value = 0.4;
            }
        }

        const graph = new SoundGraph();
        void graph.start();
    `);

    assert.match(
        result.cpp,
        /audio_param_set_value\([^;]*, 0\.6f\);/,
    );
    assert.match(
        result.cpp,
        /class_field_context_\d+ = v_[^;]*engine;/,
    );
    assert.match(
        result.cpp,
        /class_field_output_\d+ = v_[^;]*output;/,
    );
    assert.match(
        result.cpp,
        /audio_param_set_value\([^;]*, 0\.4f\);/,
    );
});

test("copies an empty nullable audio resource without dereferencing it", () => {
    const result = compileSource(`
        import { createAudioEngineAsync } from "@babylonjs/lite";

        let context: BaseAudioContext | null = null;
        function tick(): void {
            const current = context;
            if (!current) return;
            current.createGain();
        }
        tick();
        const audio = await createAudioEngineAsync();
        context = audio.audioContext;
    `);

    assert.match(
        result.cpp,
        /std::optional<bbl::pal::AudioContextHandle> v_(?:fn\d+_)?current = v_context;/,
    );
    assert.doesNotMatch(
        result.cpp,
        /std::optional<bbl::pal::AudioContextHandle> v_(?:fn\d+_)?current = \(\*v_context\);/,
    );
});

test("lowers a light vector set to its own kind's entry point", () => {
    const result = compileSource(`
        import {
            createEngine,
            createSpotLight,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const spot = createSpotLight([0, 0, 0], [0, 1, 0], 1.2, 10);
            spot.position.set(1, 2, 3);
            spot.direction.set(0, -1, 0);
        }
    `);
    assert.match(
        result.cpp,
        /bbl::set_spot_light_position\([^;]*bbl::Vec3\{1\.0f, 2\.0f, 3\.0f\}\);/,
    );
    assert.match(result.cpp, /bbl::set_spot_light_direction\(/);
    assert.match(
        result.cpp,
        /bbl::create_spot_light\([^;]*, 1\.2, 10\.0f, 1\.0f\)/,
    );
    const point = compileSource(`
        import {
            createEngine,
            createPointLight,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const point = createPointLight([0, 1, 0]);
            point.position.x = 2;
            point.position.z = 4;
        }
    `);
    assert.match(
        point.cpp,
        /bbl::set_point_light_position\([^;]*bbl::Vec3\{2\.0f, [^,]*\.position\.y, [^}]*\.position\.z\}\);/,
    );
    assert.match(
        point.cpp,
        /bbl::set_point_light_position\([^;]*bbl::Vec3\{[^,]*\.position\.x, [^,]*\.position\.y, 4\.0f\}\);/,
    );
});

test("keeps scene mesh bound overrides on the camera's object-local path", () => {
    const result = compileSource(`
        import {
            addToScene,
            createDefaultCamera,
            createEngine,
            createSceneContext,
            createSphere,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            const marker = createSphere(engine, { diameter: 0.005 });
            marker.boundMin = [0, 0.0175, -0.2025];
            marker.boundMax = [0, 0.0225, -0.1975];
            addToScene(scene, marker);
            createDefaultCamera(scene);
        }
    `);
    assert.match(result.cpp, /\.bounds_min_override = bbl::Vec3\{/);
    assert.match(result.cpp, /\.has_bounds_min_override = true/);
    assert.match(result.cpp, /\.bounds_max_override = bbl::Vec3\{/);
    assert.match(result.cpp, /\.has_bounds_max_override = true/);
});

test("keeps Scene 40 mesh bound overrides on the physics aggregate path", () => {
    const sourcePath = "corpus/babylon-lite/lab/lite/src/lite/scene40.ts";
    const anchor =
        "const sphere = createSphere(engine, { diameter: 2, segments: 32 });";
    const source = readFileSync(resolve(sourcePath), "utf8").replace(
        anchor,
        `${anchor}\n    sphere.boundMin = [-2, -3, -4];\n    sphere.boundMax = [2, 3, 4];`,
    );
    assert.notEqual(source, readFileSync(resolve(sourcePath), "utf8"));

    const result = compileSource(source, { fileName: sourcePath });
    const minimumStore = result.cpp.indexOf(".bounds_min_override =");
    const maximumStore = result.cpp.indexOf(".bounds_max_override =");
    const aggregate = result.cpp.indexOf(
        "bbl::upstream::create_physics_aggregate(",
    );
    assert.ok(minimumStore >= 0);
    assert.ok(maximumStore > minimumStore);
    assert.ok(aggregate > maximumStore);
    assert.ok(result.manifest.features.includes("physics:aggregate"));
    assert.ok(
        result.manifest.generatedSources.includes(
            "upstream/src/physics.cpp",
        ),
    );
});

test("preserves reached box, ground, and sphere options", () => {
    const result = compileSource(`
        import {
            createBox,
            createEngine,
            createGround,
            createSphere,
        } from "@babylonjs/lite";
        async function main(): Promise<void> {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            const box = createBox(engine, {
                size: 2,
                width: 3,
            });
            const ground = createGround(engine, {
                width: 6,
                height: 7,
                subdivisions: 4,
                uvScale: [2, 3],
            });
            const sphere = createSphere(engine, {
                segments: 8,
                diameter: 2,
                diameterY: 4,
                diameterZ: 5,
            });
        }
    `);

    assert.match(
        result.cpp,
        /BoxOptions\{3\.0f, 2\.0f, 2\.0f\}/,
    );
    assert.match(
        result.cpp,
        /GroundOptions\{6\.0, 7\.0, 4u, bbl::Vec2\{2\.0f, 3\.0f\}\}/,
    );
    assert.match(
        result.cpp,
        /SphereOptions\{8u, 2\.0, 4\.0, 5\.0\}/,
    );
});

test("compiles pinned Standard material morph targets", () => {
    const sourcePath =
        "corpus/babylon-lite/lab/lite/src/lite/scene252.ts";
    const result = compileSource(
        readFileSync(resolve(sourcePath), "utf8"),
        { fileName: sourcePath },
    );

    assert.deepEqual(result.manifest.features, [
        "core",
        "backend:sdl",
        "camera:arc-rotate",
        "light:directional",
        "material:standard",
        "mesh:morph-targets",
        "mesh:sphere",
        "renderer:pbr",
    ]);
    assert.match(
        result.cpp,
        /create_sphere_data\(bbl::SphereOptions\{32u, 1\.0, 1\.0, 1\.0\}\)/,
    );
    assert.match(
        result.cpp,
        /attach_morph_target\([^;]*v_deltas, \{\}, static_cast<float>\(static_cast<double>\([^)]*vertex_count\)\), 1\.0f\)/,
    );
    assert.ok(
        result.manifest.generatedSources.includes(
            "upstream/src/mesh_factories.cpp",
        ),
    );
});

test("rejects multiple direct morph targets", () => {
    assert.throws(
        () =>
            compileSource(`
                import {
                    createEngine,
                    createMorphTargets,
                } from "@babylonjs/lite";
                async function main(): Promise<void> {
                    const engine = await createEngine({});
                    const positions = new Float32Array(9);
                    createMorphTargets(
                        engine,
                        [
                            { positions, normals: null },
                            { positions, normals: null },
                        ],
                        3,
                        [1, 0],
                    );
                }
            `),
        /Direct createMorphTargets currently supports exactly one target/,
    );
});

test("updates weights through a named direct morph binding", () => {
    const result = compileSource(`
        import {
            createEngine,
            createMorphTargets,
            createSphere,
            setMorphTargetWeights,
        } from "@babylonjs/lite";
        async function main(): Promise<void> {
            const engine = await createEngine({});
            const sphere = createSphere(engine, {
                segments: 3,
            });
            const positions = new Float32Array(198);
            const morph = createMorphTargets(
                engine,
                [{ positions, normals: null }],
                66,
                [0],
            );
            sphere.morphTargets = morph;
            const weights = new Float32Array([1]);
            setMorphTargetWeights(engine, morph, weights);
        }
    `);

    assert.match(
        result.cpp,
        /attach_morph_target\([^;]*v_sphere[^;]*v_positions[^;]*66\.0f, 0\.0f\)/,
    );
    assert.match(
        result.cpp,
        /set_morph_target_weights\([^;]*v_sphere, v_weights\)/,
    );
    assert.doesNotMatch(
        result.cpp,
        /auto v_morph =\s*;/,
    );
});

test("rejects unknown or unsupported mesh factory options", () => {
    for (const [call, message] of [
        [
            "createBox(engine, { diamater: 2 });",
            "Box options support size, width, height, and depth.",
        ],
        [
            "createBox(engine, { ...{ size: 2 } });",
            "Box options support size, width, height, and depth.",
        ],
        [
            "createGround(engine, { minHeight: 0 });",
            "Ground options support width, height, subdivisions, and uvScale.",
        ],
        [
            "createSphere(engine, { subdivisions: 8 });",
            "Sphere options support segments, diameter, diameterX, diameterY, and diameterZ.",
        ],
    ] as const) {
        assert.throws(
            () =>
                compileSource(`
                    import {
                        createBox,
                        createEngine,
                        createGround,
                        createSphere,
                    } from "@babylonjs/lite";
                    async function main(): Promise<void> {
                        const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
                        const engine = await createEngine(canvas);
                        ${call}
                    }
                `),
            (error: unknown) => {
                assert.ok(error instanceof CompileError);
                assert.match(error.message, new RegExp(message.replace(
                    /[.*+?^${}()|[\]\\]/g,
                    "\\$&",
                )));
                return true;
            },
        );
    }
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

test("resolves pinned Babylon types independently of cwd", () => {
    const previous = process.cwd();
    const temporary = mkdtempSync(
        join(tmpdir(), "bblitec-compiler-"),
    );
    try {
        process.chdir(temporary);
        const result = compileSource(
            `
                import {
                    createEngine as makeEngine,
                } from "@babylonjs/lite";

                async function main() {
                    const engine = await makeEngine({});
                }
            `,
            {
                fileName: resolve(
                    previous,
                    "examples",
                    "cwd-probe.ts",
                ),
            },
        );
        assert.match(result.cpp, /bbl::create_engine/);
    } finally {
        process.chdir(previous);
        rmSync(temporary, {
            recursive: true,
            force: true,
        });
    }
});

test("lowers imported typed user functions and constants", () => {
    const result = compileSource(
        `
            import {
                createEngine,
                startEngine,
            } from "@babylonjs/lite";
            import {
                buildScene,
                configureScene as tuneScene,
            } from "./fixtures/compiler-modules/index.js";

            async function main() {
                const engine = await createEngine({});
                const scene = buildScene(engine);
                tuneScene(scene);
                startEngine(engine);
            }
        `,
        {
            fileName:
                "test/compiler-multi-file-entry.ts",
        },
    );

    assert.match(
        result.cpp,
        /auto& v_fn0_engine = v_engine/,
    );
    assert.match(
        result.cpp,
        /auto v_fn0_scene = bbl::create_scene_context\(v_fn0_engine\)/,
    );
    assert.match(
        result.cpp,
        /create_directional_light\(v_engine, bbl::Vec3\{0\.0f, \(-1\.0f\), 0\.0f\}, 0\.75f\)/,
    );
    assert.match(
        result.cpp,
        /v_fn1_scene\.environment\.exposure = static_cast<float>\(v_fn1_exposure\)/,
    );
    assert.ok(
        result.manifest.features.includes(
            "light:directional",
        ),
    );
});

test("executes imported module initializers once in dependency order", () => {
    const result = compileSource(
        `
            import {
                index,
            } from "./fixtures/compiler-modules/module-derived.js";

            let key = "v1";
            const selected = index.get(key) ?? 0;
        `,
        {
            fileName:
                "test/compiler-multi-file-entry.ts",
        },
    );

    const values = result.cpp.match(
        /bbl::js::Array<double> (v_module\d+_values) =/,
    );
    const index = result.cpp.match(
        /bbl::js::Map<std::string, double> (v_module\d+_index) =/,
    );
    assert.ok(values, "the dependency's exported array has native storage");
    assert.ok(index, "the importer module's exported map has native storage");
    assert.ok(
        result.cpp.indexOf(values[0]!) <
            result.cpp.indexOf(index[0]!),
        "dependency storage is initialized before its importer",
    );
    assert.equal(
        (result.cpp.match(new RegExp(`${values[1]}\\.push_back`, "g")) ?? [])
            .length,
        2,
    );
    assert.match(
        result.cpp,
        new RegExp(`${index[1]}\\.set\\(`),
    );
    assert.match(
        result.cpp,
        new RegExp(`${index[1]}\\.get\\(v_key\\)`),
    );
});

test("materializes private module state observed by an exported function", () => {
    const result = compileSource(
        `
            import {
                valueAt,
            } from "./fixtures/compiler-modules/module-private-state.js";

            const selected = valueAt(1);
        `,
        {
            fileName:
                "test/compiler-multi-file-entry.ts",
        },
    );

    const values = result.cpp.match(
        /bbl::js::Array<double> (v_module\d+_values) =/,
    );
    assert.ok(values, "private state has native storage");
    const alias = result.cpp.match(
        new RegExp(
            `bbl::js::Array<double>& (v_module\\d+_target) = ${values[1]}`,
        ),
    );
    assert.ok(alias, "the JavaScript container alias remains a reference");
    assert.equal(
        (result.cpp.match(new RegExp(`${alias[1]}\\.push_back`, "g")) ?? [])
            .length,
        2,
    );
    assert.match(
        result.cpp,
        new RegExp(`${values[1]}\\[bbl::js::array_index\\(v_fn\\d+_index\\)\\]`),
    );
});

test("materializes an inferred array mutated through a local alias", () => {
    const result = compileSource(`
        const values = [0];
        const alias = values;
        alias.push(4);
        const selected = values[1];
    `);

    const values = result.cpp.match(
        /bbl::js::Array<double> (v_values) =/,
    );
    assert.ok(values);
    assert.match(
        result.cpp,
        new RegExp(`bbl::js::Array<double>& v_alias = ${values[1]}`),
    );
    assert.match(result.cpp, /v_alias\.push_back\(4\.0\)/);
});

test("materializes state populated by a dependent registrar module", () => {
    const result = compileSource(
        `
            import {
                firstValue,
            } from "./fixtures/compiler-modules/module-registrar.js";

            const selected = firstValue();
        `,
        {
            fileName:
                "test/compiler-multi-file-entry.ts",
        },
    );

    const values = result.cpp.match(
        /bbl::js::Array<double> (v_module\d+_values) =/,
    );
    assert.ok(values, "dependency state has native storage");
    assert.match(result.cpp, new RegExp(`${values[1]}\\.push_back\\(11\\.0\\)`));
    assert.match(
        result.cpp,
        new RegExp(`${values[1]}\\[bbl::js::array_index\\(0\\.0\\)\\]`),
    );
});

test("keeps pure imported data builders on the static path", () => {
    const result = compileSource(
        `
            import {
                row,
            } from "./fixtures/compiler-modules/module-built.js";

            const selected = row.value;
        `,
        {
            fileName:
                "test/compiler-multi-file-entry.ts",
        },
    );

    assert.doesNotMatch(result.cpp, /v_module\d+_row/);
    assert.match(
        result.cpp,
        /double v_selected = bblscene::buildRow\(\)\.value;/,
    );
});

test("uses TypeChecker types for local function arguments", () => {
    assert.throws(
        () =>
            compileSource(
                `
                    import {
                        createEngine,
                    } from "@babylonjs/lite";
                    import {
                        configureScene,
                    } from "./fixtures/compiler-modules/index.js";

                    async function main() {
                        const engine = await createEngine({});
                        configureScene(engine);
                    }
                `,
                {
                    fileName:
                        "test/compiler-multi-file-entry.ts",
                },
            ),
        /Argument 1 of 'configureScene' is EngineContext, not SceneContext/,
    );
});

test("emits plain-data user functions once as native functions", () => {
    const result = compileSource(`
        function doubled(value: number): number {
            const result = value * 2;
            return result;
        }
        const first = doubled(2);
        const second = doubled(3);
    `);

    assert.equal(
        result.cpp.match(/double doubled\(double v_fn0_value\) \{/g)
            ?.length,
        1,
    );
    assert.match(
        result.cpp,
        /double v_first = bblscene::doubled\(2\.0\);/,
    );
    assert.match(
        result.cpp,
        /double v_second = bblscene::doubled\(3\.0\);/,
    );
    assert.match(
        result.cpp,
        /return v_fn0_result;/,
    );
});

test("stabilizes stored record representation before native parameter emission", () => {
    const result = compileSource(`
        interface Archive {
            names: Map<string, number>;
            bytes: Uint8Array;
        }
        interface Holder { archive: Archive }

        function indexOf(archive: Archive, name: string): number {
            return archive.names.get(name) ?? -1;
        }
        function parse(seed: string | number): Archive {
            const names = new Map<string, number>();
            names.set(String(seed), 3);
            return {
                names,
                bytes: new Uint8Array(4),
            };
        }

        const archive = parse("START");
        const index = indexOf(archive, "START");
        const holder: Holder = { archive };
    `);

    assert.match(
        result.cpp,
        /using Archive = std::shared_ptr<ArchiveData>;/,
    );
    assert.match(
        result.cpp,
        /double indexOf\(bblscene::Archive v_fn\d+_archive, std::string v_fn\d+_name\)/,
    );
    assert.match(result.cpp, /v_fn\d+_archive->names\.get\(/);
    assert.doesNotMatch(result.cpp, /v_fn\d+_archive\.names/);
});

test("supports early returns in native data functions", () => {
    const result = compileSource(`
        function clamp01(value: number): number {
            if (value < 0) {
                return 0;
            }
            if (value > 1) {
                return 1;
            }
            return value;
        }
        const low = clamp01(-2);
        const high = clamp01(3);
    `);

    assert.equal(
        result.cpp.match(/return 0\.0;/g)?.length,
        1,
    );
    assert.match(result.cpp, /return 1\.0;/);
    assert.match(result.cpp, /return v_fn0_value;/);
});

test("keeps closures over entry locals on the inline path", () => {
    const result = compileSource(`
        import {
            createArcRotateCamera,
            createEngine,
            createSceneContext,
            registerScene,
            startEngine,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            const camera = createArcRotateCamera(1, 1, 5, { x: 0, y: 0, z: 0 });
            scene.camera = camera;
            const nudge = (): void => {
                camera.alpha = camera.alpha + 0.5;
            };
            nudge();
            nudge();
            await registerScene(scene);
            await startEngine(engine);
        }
    `);

    assert.doesNotMatch(result.cpp, /bblscene::nudge/);
    assert.equal(
        result.cpp.match(
            /cameras\[v_camera\.value\]\.alpha = /g,
        )?.length,
        2,
    );
});

test("lowers '??' over the data model", () => {
    const result = compileSource(`
        interface Slot {
            fallback: number;
            current: number | null;
        }
        function pick(slot: Slot): number {
            return slot.current ?? slot.fallback;
        }
        const slot: Slot = { fallback: 4, current: null };
        const viaFunction = pick(slot);
        const atTopLevel = slot.current ?? 6;
        const identity = (atTopLevel ?? 987654) + viaFunction;
    `);
    // An optional left evaluates once into a temporary and selects
    // natively, with the fallback inside the ternary -- JavaScript's own
    // laziness.
    assert.match(
        result.cpp,
        /const auto (v_bblite_nullish_\d+) = [^;]+;\s*return \(\1\.has_value\(\) \? \(\*\1\) : v_fn\d+_slot\.fallback\);/,
    );
    // A left the model proves non-nullish IS the result: the dead right
    // side is discarded exactly as JavaScript never evaluates it.
    assert.doesNotMatch(result.cpp, /987654/);
});

test("'??' outside its lowerable routes refuses by name", () => {
    assert.throws(
        () =>
            compileSource(`
        import {
            createArcRotateCamera,
            createEngine,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const camera = createArcRotateCamera(1, 1, 5, { x: 0, y: 0, z: 0 });
            const doubled = camera ?? camera;
        }
        void main();
    `),
        /'\?\?' lowers over a static record property, an asset-derived handle collection, a handle a search produced, or a data-model value/,
    );
});

test("'??' reaches sinks and conditions through the same dispatch", () => {
    const result = compileSource(`
        interface Item {
            weight: number;
        }
        interface Bag {
            primary: Item | null;
            backup: Item;
        }
        function armed(flag: boolean): boolean | null {
            if (flag) {
                return true;
            }
            return null;
        }
        function pick(bag: Bag): number {
            const chosen: Item = bag.primary ?? bag.backup;
            return chosen.weight;
        }
        const bag: Bag = { primary: null, backup: { weight: 2 } };
        const weight = pick(bag);
        let count = 0;
        if (armed(false) ?? false) {
            count = count + 1;
        }
    `);
    // The sink arm serves the struct sink from the one select (string and
    // enum inners follow as soon as the model can produce a null of them);
    // the condition position routes the selected boolean.
    assert.match(
        result.cpp,
        /bblscene::Item v_fn\d+_chosen = \(static_cast<bool>\(v_fn\d+_bag\.primary\) \? v_fn\d+_bag\.primary : v_fn\d+_bag\.backup\);/,
    );
    assert.match(
        result.cpp,
        /if \(\(v_bblite_nullish_\d+\.has_value\(\) \? \(\*v_bblite_nullish_\d+\) : false\)\)/,
    );
});

test("lowers optional data property and element chains generically", () => {
    const result = compileSource(`
        type Trigger = "push" | "switch";
        interface Def {
            trigger: Trigger;
            speed: number;
        }
        function isSwitch(def: Def | undefined): boolean {
            return def?.trigger === "switch";
        }
        function speed(def: Def | undefined): number {
            return def?.speed ?? 0;
        }
        const rows: Def[] = [{ trigger: "push", speed: 2 }];
        let index = 1;
        const selected = rows[index]?.speed ?? speed(undefined);
        const matched = isSwitch(undefined);
    `);

    assert.match(
        result.cpp,
        /static_cast<bool>\(v_fn\d+_def\) \? bbl::js::Nullable<double>\{v_fn\d+_def->speed\} : bbl::js::Nullable<double>\{std::nullopt\}/,
    );
    assert.match(
        result.cpp,
        /bbl::js::Nullable<bblscene::Trigger>/,
    );
    assert.match(
        result.cpp,
        /v_bblite_optional_compare_\d+\.has_value\(\) &&/,
    );
    assert.match(result.cpp, /#include <bblite\/js_data\.hpp>/);
    assert.match(result.cpp, /bbl::js::array_has_index\(/);
    assert.match(result.cpp, /bbl::js::array_at_or_default\(/);
});

test("lowers interface-typed structs, optionals, and enums", () => {
    const result = compileSource(`
        type Tag = "idle" | "busy";
        interface Item {
            weight: number;
            active: boolean;
        }
        interface Bucket {
            items: Item[];
            current: Item | null;
            tags: Tag[];
            total: number;
        }
        function makeBucket(): Bucket {
            return {
                items: [],
                current: null,
                tags: [],
                total: 0,
            };
        }
        function fill(bucket: Bucket): void {
            bucket.items.push({ weight: 2, active: true });
            bucket.current = { weight: 3, active: false };
            bucket.tags.push("busy");
            bucket.total += bucket.items.length;
            if (bucket.current !== null) {
                bucket.total += bucket.current.weight;
            }
            bucket.current = null;
        }
        const bucket = makeBucket();
        fill(bucket);
        const total = bucket.total;
    `);

    assert.match(result.cpp, /enum class Tag \{/);
    assert.match(result.cpp, /struct ItemData \{/);
    assert.match(
        result.cpp,
        /using Item = std::shared_ptr<ItemData>;/,
    );
    assert.match(
        result.cpp,
        /bblscene::Item current;/,
    );
    assert.match(
        result.cpp,
        /bbl::js::Array<bblscene::Tag> tags;/,
    );
    assert.match(
        result.cpp,
        /push_back\(std::make_shared<bblscene::ItemData>\(bblscene::ItemData\{2\.0, true\}\)\)/,
    );
    assert.match(
        result.cpp,
        /push_back\(bblscene::Tag::busy\)/,
    );
    assert.match(
        result.cpp,
        /current = bblscene::Item\{\};/,
    );
    assert.match(
        result.cpp,
        /v_fn\d+_bucket\.current->weight/,
    );
    assert.ok(
        result.manifest.adaptations.some(
            ({ id }) => id === "plain-data-value-model",
        ),
    );
});

test("lowers dynamic arrays with fill, pop, truncation, and index writes", () => {
    const result = compileSource(`
        const board: number[] = new Array<number>(6).fill(0);
        board[2] = 5;
        const popped = board.pop()!;
        board.length = 3;
        const scratch: number[] = new Array(4);
        scratch[0] = board.length;
        let sum = 0;
        for (const value of board) {
            sum += value;
        }
    `);

    assert.match(
        result.cpp,
        /bbl::js::Array<double>\(static_cast<std::size_t>\(6\.0\), 0\.0\)/,
    );
    assert.match(
        result.cpp,
        /bbl::js::array_index_write\(v_board, bbl::js::array_index\(2\.0\)\) = 5\.0;/,
    );
    assert.match(
        result.cpp,
        /double v_popped = bbl::js::array_pop\(v_board\);/,
    );
    assert.match(
        result.cpp,
        /bbl::js::array_truncate\(v_board, 3\.0\);/,
    );
    assert.match(
        result.cpp,
        /bbl::js::Array<double>\(static_cast<std::size_t>\(4\.0\)\)/,
    );
    assert.match(
        result.cpp,
        /for \(auto&& v_bblite_item_\d+ : v_board\)/,
    );
});

test("lowers nested Array.from length allocations", () => {
    const result = compileSource(`
        const grid: number[][] = Array.from(
            { length: 2 },
            () => Array.from({ length: 3 }, () => 7),
        );
        grid[1]![2] = 9;
    `);

    assert.match(
        result.cpp,
        /const std::size_t v_bblite_array_from_count_\d+ = static_cast<std::size_t>\(2\.0\);/,
    );
    assert.match(
        result.cpp,
        /bbl::js::Array<bbl::js::Array<double>> v_bblite_array_from_result_\d+;/,
    );
    assert.match(
        result.cpp,
        /bbl::js::Array<double> v_bblite_array_from_result_\d+;/,
    );
    assert.match(result.cpp, /\.push_back\(7\.0\);/);
});

test("stores homogeneous object tuples with JavaScript array identity", () => {
    const result = compileSource(`
        interface Point { x: number }
        const point: Point = { x: 1 };
        const edges: [Point, Point][][] = Array.from(
            { length: 2 },
            () => [],
        );
        edges[0]!.push([point, point]);
        edges[0]![0]![1]!.x = 4;
    `);

    assert.match(result.cpp, /bbl::js::Array<bbl::js::Array<bbl::js::Array<bblscene::Point>>>/);
    assert.match(result.cpp, /\.push_back\(bbl::js::Array<bblscene::Point>\{/);
});

test("marks object tuple elements as references before emitting their users", () => {
    const result = compileSource(`
        interface Point { x: number }
        const points: [Point, Point] = [
            { x: Math.random() },
            { x: Math.random() },
        ];
        const index = Math.floor(Math.random() * 2);
        const selected = points[index]!;
        const x = selected.x;
        const later: Point[] = [];
        later.push({ x: 3 });
    `);

    assert.match(result.cpp, /using Point = std::shared_ptr<PointData>;/);
    assert.match(result.cpp, /v_selected->x/);
    assert.match(
        result.cpp,
        /bbl::js::Array<bblscene::Point>\{std::make_shared<bblscene::PointData>/,
    );
});

test("materializes an inferred array before a runtime element read", () => {
    const result = compileSource(`
        interface Point { x: number }
        const source: Point[] = [{ x: 1 }, { x: 2 }, { x: 3 }];
        const i = Math.floor(Math.random() * 3);
        const triplet = [source[0]!, source[1]!, source[2]!];
        const selected = triplet[i]!;
        selected.x = 9;
    `);

    assert.match(result.cpp, /bbl::js::Array<bblscene::Point> v_triplet/);
    assert.match(result.cpp, /v_triplet\[bbl::js::array_index\(v_i\)\]/);
    assert.equal((result.cpp.match(/bbl::js::random_js\(\)/g) ?? []).length, 1);
});

test("snapshots a returned value the next call in the same expression moves", () => {
    // Scene 179's `seededRandom` shape: the returned arrow advances the state
    // it closes over and returns an expression READING that state, so three
    // draws in one argument list must not all read the final value.
    const result = compileSource(`
        import { createBox, createEngine } from "@babylonjs/lite";

        function seededRandom(seed: number): () => number {
            let s = seed >>> 0;
            return () => {
                s = (1664525 * s + 1013904223) >>> 0;
                return s / 0x100000000;
            };
        }

        async function main() {
            const engine = await createEngine({});
            const rnd = seededRandom(7);
            const box = createBox(engine);
            box.position.set(rnd(), rnd(), rnd());
        }
    `);

    const snapshots = [
        ...result.cpp.matchAll(
            /const double (v_bblite_return_\w+) = \(v_\w+_s \/ 4294967296\.0\);/g,
        ),
    ].map(([, name]) => name);
    assert.equal(snapshots.length, 3);
    assert.equal(new Set(snapshots).size, 3);
    assert.match(
        result.cpp,
        new RegExp(
            `position = bbl::Vec3d\\{${snapshots[0]!}, ${snapshots[1]!}, ${snapshots[2]!}\\}`,
        ),
    );
});

test("leaves a returned value its own locals already snapshot", () => {
    // The corpus's other PRNG: mulberry32 advances `a` but returns an
    // expression over `t`, a local the inline frame allocates per call, so the
    // splice is already safe and no temporary is introduced.
    const result = compileSource(`
        import { createBox, createEngine } from "@babylonjs/lite";

        function mulberry32(seed: number): () => number {
            let a = seed >>> 0;
            return () => {
                a = (a + 0x6d2b79f5) | 0;
                let t = Math.imul(a ^ (a >>> 15), 1 | a);
                t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
                return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
            };
        }

        async function main() {
            const engine = await createEngine({});
            const rand = mulberry32(1337);
            const box = createBox(engine);
            box.position.set(rand(), rand(), rand());
        }
    `);

    assert.doesNotMatch(result.cpp, /v_bblite_return_/);
});

test("rebinds a vector from a helper proven to return a fresh array", () => {
    const result = compileSource(`
        function clipped(input: number[]): number[] {
            const out: number[] = [];
            if (input.length === 0) return out;
            out.push(input[0]!);
            return out;
        }
        let poly: number[] = [1, 2, 3];
        poly = clipped(poly);
    `);

    assert.match(result.cpp, /v_poly = bblscene::clipped\(v_poly\);/);
});

test("folds string-literal comparisons in specialized callbacks", () => {
    const result = compileSource(`
        const classify = (kind: "coin" | "flower"): number =>
            kind === "flower" ? 1 : 0;
        const coin = classify("coin");
        const flower = classify("flower");
    `);

    assert.doesNotMatch(result.cpp, /"(?:coin|flower)" == "flower"/);
    assert.match(
        result.cpp,
        /std::string\("coin"\) == std::string\("flower"\)/,
    );
    assert.match(
        result.cpp,
        /std::string\("flower"\) == std::string\("flower"\)/,
    );
});

test("materializes mutable intersection-typed object locals", () => {
    const result = compileSource(`
        interface Contacts {
            grounded: boolean;
            wall: -1 | 0 | 1;
        }
        function move(): { vx: number } & Contacts {
            const result: { vx: number } & Contacts = {
                vx: 2,
                grounded: false,
                wall: 0,
            };
            result.grounded = true;
            result.wall = 1;
            return result;
        }
        const moved = move();
    `);

    assert.match(result.cpp, /\.grounded = true;/);
    assert.match(result.cpp, /\.wall = 1\.0;/);
    assert.doesNotMatch(result.cpp, /false = true|0\.0 =/);
});

test("keeps returned callbacks as compile-time bindings", () => {
    const result = compileSource(`
        const makeAdder = (amount: number) => (value: number): number =>
            value + amount;
        const addTwo = makeAdder(2);
        const total = addTwo(3);
    `);

    assert.doesNotMatch(result.cpp, /auto v_addTwo =\s*;/);
    assert.match(result.cpp, /double v_total = \(v_fn\d+_value \+ v_fn\d+_amount\);/);
});

test("coerces missing partial Record numbers to NaN in arithmetic", () => {
    const result = compileSource(`
        type Kind = "a" | "b";
        interface Item { kind: Kind }
        const foot: Partial<Record<Kind, number>> = { a: 0.5 };
        const items: Item[] = [{ kind: "a" }, { kind: "b" }];
        let total = 0;
        for (const item of items) {
            total += 1 - foot[item.kind];
        }
    `);

    assert.match(result.cpp, /bbl::js::Nullable<double>/);
    assert.match(result.cpp, /bbl::js::number_from_optional/);
});

test("materializes constant-expression tuple tables for runtime break", () => {
    const result = compileSource(`
        const TILE = 70;
        function launch(): number {
            const shots: readonly [number, number][] = [
                [-TILE * 2, -TILE * 7.5],
                [TILE * 2, -TILE * 7.5],
            ];
            let total = 0;
            for (const [vx, vy] of shots) {
                total += vy;
                if (vx > 0) break;
            }
            return total;
        }
        const total = launch();
    `);

    assert.match(result.cpp, /inline const std::array/);
    assert.match(result.cpp, /for \(auto&& v_bblite_item_/);
});

test("materializes runtime-valued static maps as native arrays", () => {
    const result = compileSource(`
        let offset = 2;
        const mapped = ["a", "b"].map((_, index) => offset + index);
        const picked = mapped[Math.floor(Math.random() * mapped.length)]!;
    `);

    assert.match(
        result.cpp,
        /bbl::js::Array<double> v_mapped = bbl::js::Array<double>\{/,
    );
    assert.match(result.cpp, /v_mapped\[bbl::js::array_index\(/);
});

test("returns the value of chained numeric field assignments", () => {
    const result = compileSource(`
        interface Box { w: number; h: number }
        const box: Box = { w: 1, h: 1 };
        box.w = box.h = 42;
    `);

    assert.match(result.cpp, /v_box\.w = \(v_box\.h = 42\.0\);/);
});

test("returns the value of chained scalar-local assignments", () => {
    const result = compileSource(`
        let x = 1;
        let y = 2;
        let z = 3;
        x = y = z = 0;
    `);

    assert.match(result.cpp, /v_x = \(v_y = \(v_z = 0\.0\)\);/);
});

test("spreads a native partial struct into a wider struct", () => {
    const result = compileSource(`
        interface Options {
            label?: string;
            enabled?: boolean;
        }
        interface Item {
            id: number;
            label?: string;
            enabled?: boolean;
        }
        const options: Options = { label: "ready" };
        const item: Item = { id: 3, ...options };
    `);

    assert.match(
        result.cpp,
        /if \(v_options\.label\.has_value\(\)\) \{/,
    );
    assert.match(
        result.cpp,
        /v_item\.label = \*v_options\.label;/,
    );
    assert.match(
        result.cpp,
        /if \(v_options\.enabled\.has_value\(\)\) \{/,
    );
});

test("lowers array callbacks through one native iteration protocol", () => {
    const result = compileSource(`
        const values: number[] = [1, 2, 3];
        const found = values.find((value, index, owner) => value === owner[index]);
        const filtered = values.filter((value) => value > 1);
        const present = values.some((value) => value === 2);
        const mapped = values.map((value) => value * 2);
        let total = 0;
        values.forEach((value) => { total += value; });
    `);

    for (const label of [
        "find_source",
        "filter_source",
        "some_source",
        "map_source",
        "for_each_source",
    ]) {
        assert.match(
            result.cpp,
            new RegExp(`v_bblite_${label}_\\d+`),
        );
    }
    assert.match(
        result.cpp,
        /v_bblite_find_result_\d+ = v_bblite_find_source_\d+\[/,
    );
    assert.match(result.cpp, /v_bblite_filter_result_\d+\.push_back/);
    assert.match(result.cpp, /v_bblite_some_result_\d+ = true/);
    assert.match(result.cpp, /v_bblite_map_result_\d+\.push_back/);
    assert.match(
        result.cpp,
        /const std::size_t v_bblite_for_each_count_\d+/,
    );
});

test("unrolls some over a readonly tuple table", () => {
    const result = compileSource(`
        const ranges: ReadonlyArray<readonly [number, number]> = [
            [1, 3],
            [8, 10],
        ];
        function contains(value: number): boolean {
            return ranges.some(([first, last]) =>
                value >= first && value <= last,
            );
        }
        let value = 9;
        const found = contains(value);
    `);

    assert.match(
        result.cpp,
        /return .*v_fn\d+_first.*v_fn\d+_last.*\|\|.*v_fn\d+_first.*v_fn\d+_last/,
    );
});

test("unrolls destructured forEach blocks over readonly tuple tables", () => {
    const result = compileSource(`
        const ranges: ReadonlyArray<readonly [number, number]> = [
            [1, 3],
            [8, 10],
        ];
        const widths: number[] = [];
        ranges.forEach(([first, last], index) => {
            if (index === 0) widths.push(last - first);
        });
    `);

    assert.equal(
        result.cpp.match(/v_widths\.push_back/g)?.length,
        1,
    );
});

test("writes a tuple lane at its sink's own width", () => {
    // A lane is stored and read back by a sink it cannot see, so the width
    // belongs to the sink: `position.set` is a double record field, and a
    // lane frozen at the default float width would round it a step early —
    // half a unit at the large-world coordinates scene 206 writes.
    const result = compileSource(`
        import {
            createBox,
            createEngine,
            createSceneContext,
            registerScene,
            startEngine,
        } from "babylon-lite";

        const OFFSET = 5_000_000;

        async function main(): Promise<void> {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            const scene = createSceneContext(engine);
            const place = (at: [number, number, number]): void => {
                const box = createBox(engine, 1);
                box.position.set(at[0], at[1], at[2]);
            };
            place([OFFSET, 0.65, OFFSET + 2.45]);
            await registerScene(scene);
            await startEngine(engine);
        }
        void main();
    `);

    assert.match(
        result.cpp,
        /position = bbl::Vec3d\{5000000\.0, 0\.65, 5000002\.45\};/,
    );
});

test("leaves an ordinary numeric expression unfolded", () => {
    // The boundary `laneValue` draws. `staticNumber` is also what a
    // condition reads to fold, and an unrolled loop's index carries one, so
    // recording the fold on every number Value would additionally collapse
    // conditions over that index — a different change with its own
    // measurement. A lane's width is undecided; this one's is not.
    const result = compileSource(`
        const SIZE = 4;
        let total = 0;
        for (let i = 0; i < 3; i++) {
            total += SIZE * 2 + i;
        }
    `);

    assert.match(result.cpp, /\(4\.0 \* 2\.0\)/);
});

test("materializes static tables under runtime indices only", () => {
    const result = compileSource(`
        const WEIGHTS: readonly (readonly [number, number])[] = [
            [1, 2],
            [3, 4],
            [5, 6],
        ];
        const staticRead = WEIGHTS[1][0];
        function pick(index: number): number {
            return WEIGHTS[index]![1];
        }
        let total = pick(2);
        for (const [left, right] of WEIGHTS) {
            total += left + right;
        }
    `);

    assert.match(
        result.cpp,
        /inline const std::array<bbl::js::Tuple<2>, 3> WEIGHTS = \{\{\{1\.0, 2\.0\}, \{3\.0, 4\.0\}, \{5\.0, 6\.0\}\}\};/,
    );
    // The table's own lanes are doubles, and so is the local, so the read
    // is written at that width rather than at the default float one.
    assert.match(
        result.cpp,
        /double v_staticRead = 3\.0;/,
    );
    assert.match(
        result.cpp,
        /bblscene::WEIGHTS\[bbl::js::array_index\(v_fn\d+_index\)\]\[bbl::js::array_index\(1\.0\)\]/,
    );
    assert.match(
        result.cpp,
        /v_total \+= \(v_bblite_item_\d+\[0\] \+ v_bblite_item_\d+\[1\]\);/,
    );
});


test("lowers a class instance into per-field bindings", () => {
    const result = compileSource(`
        class Stack {
            private readonly heights: number[] = [];
            private total = 0;
            add(height: number, repeat = 2): void {
                for (let i = 0; i < repeat; i++) {
                    this.heights.push(height);
                    this.total += height;
                }
            }
        }
        const stack = new Stack();
        stack.add(1);
        stack.add(2, 1);
    `);

    // No runtime object survives: fields are locals, methods inline.
    assert.match(
        result.cpp,
        /bbl::js::Array<double> v_\w*heights/,
    );
    assert.match(
        result.cpp,
        /double v_bblite_class_field_total_\d+ = 0\.0/,
    );
    assert.doesNotMatch(result.cpp, /struct Stack/);
    // Each call gets its own inlined runtime loop, with the default and
    // explicit repeat values preserved at their call sites.
    assert.match(result.cpp, /v_fn\d+_repeat = 2\.0/);
    assert.match(result.cpp, /v_fn\d+_repeat = 1\.0/);
    assert.equal(
        (result.cpp.match(/push_back/g) ?? []).length,
        2,
    );
});

test("initializes constructor parameter-properties before the body", () => {
    const result = compileSource(`
        class Accumulator {
            private total = 0;
            constructor(private readonly scale: number) {
                this.initialize(scale);
            }
            private initialize(value: number): void {
                this.total = value;
            }
            add(value: number): void {
                this.total += value * this.scale;
            }
        }
        const accumulator = new Accumulator(2);
        accumulator.add(3);
    `);

    assert.match(result.cpp, /double v_fn\d+_scale = 2\.0/);
    assert.match(
        result.cpp,
        /v_bblite_class_field_total_\d+ = v_fn\d+_value/,
    );
    assert.match(
        result.cpp,
        /v_bblite_class_field_total_\d+ \+= \(v_fn\d+_value \* v_fn\d+_scale\)/,
    );
});

test("iterates data nested inside a class record field", () => {
    const result = compileSource(`
        interface Entry { enabled: boolean; }
        interface Catalog { entries: Entry[]; }
        class Counter {
            private readonly catalog: Catalog;
            private total = 0;
            constructor(catalog: Catalog) {
                this.catalog = catalog;
                this.scan();
            }
            private scan(): void {
                for (const entry of this.catalog.entries) {
                    if (!entry.enabled) continue;
                    this.total += 1;
                }
            }
        }
        const entries: Entry[] = [
            { enabled: false },
            { enabled: true },
        ];
        const counter = new Counter({ entries });
    `);

    assert.match(result.cpp, /for \(auto&&/);
    assert.match(result.cpp, /continue;/);
});

test("materializes a numeric Record for dynamic optional lookup", () => {
    const result = compileSource(`
        interface Definition { enabled: boolean; weight: number; }
        const definitions: Record<number, Definition> = {
            1: { enabled: true, weight: 2 },
            7: { enabled: false, weight: 4 },
        };
        function lookup(key: number): Definition | undefined {
            return definitions[key];
        }
        let key = 7;
        const definition = lookup(key);
    `);

    assert.match(
        result.cpp,
        /static bbl::js::Map<double, bblscene::Definition> values/,
    );
    assert.match(result.cpp, /\.get\(v_\w*key\)/);
});

test("guards a missing open Record key before dereferencing its local", () => {
    const result = compileSource(`
        const weapons: Record<string, number> = { Digit1: 1, Digit2: 2 };
        function select(code: string): number {
            const weapon = weapons[code];
            if (weapon !== undefined) return weapon;
            return -1;
        }
        let code = "ArrowUp";
        const selected = select(code);
    `);

    const lookup = result.cpp.match(
        /bbl::js::Nullable<double> (v_\w*weapon) = .*\.get\(.*\);/,
    );
    assert.ok(lookup);
    const local = lookup[1]!;
    const guard = result.cpp.indexOf(`${local}.has_value()`);
    const dereference = result.cpp.indexOf(`(*${local})`);
    assert.ok(guard >= 0, "the undefined guard tests the stored lookup");
    assert.ok(
        dereference > guard,
        "the lookup is not dereferenced until after its guard",
    );
    assert.doesNotMatch(
        result.cpp,
        /double& v_\w*weapon = \*[^;]+\.get\(/,
    );
});

test("inserts runtime keys through a named open Record alias", () => {
    const result = compileSource(`
        type Values = Record<string, string>;
        function insert(key: string, value: string): Values {
            const entries: Values = {};
            entries[key] = value;
            return entries;
        }
        const entries = insert("name", "value");
        const missing = Number(entries["missing"]) || 0;
    `);

    assert.match(result.cpp, /bbl::js::Map<std::string, std::string>/);
    assert.match(result.cpp, /v_fn\d+_entries\.set\(v_fn\d+_key, v_fn\d+_value\);/);
    assert.match(result.cpp, /std::numeric_limits<double>::quiet_NaN\(\)/);
});

test("preserves object identity through a dynamic Record lookup", () => {
    const result = compileSource(`
        interface Entry { value: number; }
        const entries: Record<string, Entry> = {
            one: { value: 1 },
        };
        function mutate(code: string): void {
            const entry = entries[code];
            if (entry !== undefined) entry.value++;
        }
        let code = "missing";
        mutate(code);
    `);

    assert.match(
        result.cpp,
        /using Entry = std::shared_ptr<EntryData>;/,
    );
    assert.match(
        result.cpp,
        /static bbl::js::Map<std::string, bblscene::Entry> values/,
    );
    assert.match(result.cpp, /\.get\(v_\w*code\)/);
    assert.match(result.cpp, /static_cast<bool>\(v_\w*entry\)/);
    assert.match(result.cpp, /v_\w*entry->value\+\+;/);
});

test("keeps generic Record instantiations type-distinct", () => {
    const result = compileSource(`
        type Area = "overworld" | "cave";
        interface Cell { x: number; y: number; }
        interface World {
            areas: Record<Area, Cell>;
            entries: Record<string, Cell>;
        }
        const entries: Record<string, Cell> = {
            start: { x: 1, y: 2 },
        };
        const world: World = {
            areas: {
                overworld: { x: 3, y: 4 },
                cave: { x: 5, y: 6 },
            },
            entries,
        };
    `);

    assert.match(result.cpp, /Generated by bblitec/);
});

test("materializes Object.values from a closed Record", () => {
    const result = compileSource(`
        type Area = "one" | "two";
        interface Cell { value: number; }
        function main() {
            const cells: Record<Area, Cell> = {
                one: { value: 1 },
                two: { value: 2 },
            };
            const values = Object.values(cells);
        }
    `);

    assert.match(result.cpp, /\.begin\(\), .*\.end\(\)/);
});

test("stores and mutates a runtime string local", () => {
    const result = compileSource(`
        function build(bytes: Uint8Array): { name: string } {
            let name = "";
            for (let i = 0; i < bytes.length; i++) {
                name += String.fromCharCode(bytes[i]!);
            }
            name = name.toUpperCase();
            return { name };
        }
        const record = build(new Uint8Array([97, 98]));
    `);

    assert.match(result.cpp, /std::string v_\w*name = ""/);
    assert.match(result.cpp, /v_\w*name \+= bbl::js::string_from_char_code/);
    assert.match(result.cpp, /v_\w*name = bbl::js::string_upper/);
});

test("preserves undefined in typeof for maybe-absent runtime values", () => {
    assert.doesNotThrow(() =>
        compileSource(`
            const absent = typeof undefined;
            const nil = typeof null;
        `)
    );
    const result = compileSource(`
        interface Entry { value: number; }
        const entries: Entry[] = [];
        let index = 0;
        const entry = entries[index];
        const kind = typeof entry;
    `);
    assert.match(
        result.cpp,
        /v_bblite_element_found_\d+ \? "object" : "undefined"/,
    );
});

test("specializes typeof for a settled inlined union parameter", () => {
    const result = compileSource(`
        function select(value: string | number): number {
            return typeof value === "number"
                ? value
                : 3;
        }
        const fromString = select("abc");
        const fromNumber = select(7);
    `);

    assert.match(result.cpp, /double v_fromString = 3\.0/);
    assert.match(result.cpp, /double v_fromNumber = v_fn\d+_value/);
});

test("preserves existence guards for dynamically indexed object arrays", () => {
    const result = compileSource(`
        const sets: Set<number>[] = [new Set<number>(), new Set<number>()];
        let left = 0;
        let right = 1;
        if (sets[left] && sets[right]) {
            sets[left].add(right);
            sets[right].add(left);
        }
    `);

    assert.match(
        result.cpp,
        /if \(\(bbl::js::array_has_index\([^)]*\) && bbl::js::array_has_index\([^)]*\)\)\)/,
    );
    assert.equal((result.cpp.match(/\.add\(/g) ?? []).length, 2);
});

test("carries an unchecked object element's existence through a local", () => {
    const result = compileSource(`
        interface Entry { value: number; }
        const entries: Entry[] = [{ value: 4 }];
        let index = 1;
        const entry = entries[index];
        const values = entry ? [entry.value] : [];
    `);

    assert.match(result.cpp, /bbl::js::array_at_or_default\(/);
    assert.match(
        result.cpp,
        /const bool v_bblite_element_found_\d+ = static_cast<bool>\(v_entry\)/,
    );
});

test("materializes an iterable spread as a native array", () => {
    const result = compileSource(`
        const sets: Set<number>[] = [new Set<number>([1, 2])];
        const arrays = sets.map((set) => [...set]);
        const first = arrays[0]![0]!;
    `);

    assert.match(
        result.cpp,
        /bbl::js::array_from_iterable<double>\(/,
    );
});

test("lowers typed values returned by class methods", () => {
    const result = compileSource(`
        class Counter {
            private n = 1;
            value(enabled: boolean): number {
                if (!enabled) return 0;
                return this.n;
            }
        }
        const counter = new Counter();
        let enabled = true;
        const total = counter.value(enabled);
    `);

    assert.match(result.cpp, /\[&\]\(\) -> double \{/);
    assert.match(result.cpp, /return 0\.0;/);
    assert.match(
        result.cpp,
        /return v_bblite_class_field_n_\d+;/,
    );
});

test("lowers direct recursive plain-data class methods once", () => {
    const result = compileSource(`
        class Counter {
            sum(n: number): number {
                if (n <= 0) return 0;
                return n + this.sum(n - 1);
            }
        }
        const counter = new Counter();
        const total = counter.sum(3);
    `);

    assert.match(result.cpp, /std::function<double\(double\)>/);
    assert.match(result.cpp, /recursive_method\(\(v_.*n - 1\.0\)\)/);
    assert.ok(result.cpp.length < 20_000);
});

test("folds static readonly class scalars", () => {
    const result = compileSource(`
        class Particle {
            private static readonly GRAVITY = 520;
            step(dt: number): number {
                return Particle.GRAVITY * dt;
            }
        }
        const particle = new Particle();
        const fall = particle.step(0.5);
    `);

    assert.match(result.cpp, /return \(520\.0 \* v_fn\d+_dt\);/);
    assert.doesNotMatch(result.cpp, /class_field_GRAVITY/);
});

test("rejects class inheritance", () => {
    assert.throws(
        () =>
            compileSource(`
                class Base {
                    protected n = 1;
                }
                class Derived extends Base {
                    bump(): void {
                        this.n += 1;
                    }
                }
                const derived = new Derived();
                derived.bump();
            `),
        /inheritance is outside the supported subset/,
    );
});

test("materializes a constructor-assigned resource field once", () => {
    const result = compileSource(`
        import {
            createBox,
            createEngine,
            createStandardMaterial,
        } from "@babylonjs/lite";
        class Painter {
            private material: StandardMaterial;
            constructor() {
                this.material = createStandardMaterial();
            }
            paint(mesh: Mesh): void {
                mesh.material = this.material;
            }
        }
        async function main(): Promise<void> {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            const painter = new Painter();
            painter.paint(createBox(engine, 1));
            painter.paint(createBox(engine, 2));
        }
        main();
    `);

    assert.equal(
        result.cpp.match(/bbl::create_standard_material/g)?.length,
        1,
    );
});

test("copies inlined handle parameters before a factory can reallocate their owner", () => {
    const result = compileSource(`
        import {
            createBox,
            createEngine,
            createStandardMaterial,
        } from "@babylonjs/lite";

        function build(engine: EngineContext, material: Material): Mesh {
            const mesh = createBox(engine, 1);
            mesh.material = material;
            return mesh;
        }

        async function main(): Promise<void> {
            const engine = await createEngine({});
            const source = createBox(engine, 1);
            source.material = createStandardMaterial();
            build(engine, source.material);
        }
    `);

    assert.match(
        result.cpp,
        /auto v_fn\d+_material = v_engine\.meshes\[v_source\.value\]\.material;/,
    );
    assert.doesNotMatch(
        result.cpp,
        /auto&& v_fn\d+_material = v_engine\.meshes\[v_source\.value\]\.material;/,
    );
});

test("gives constructor-assigned resource fields distinct native storage", () => {
    const result = compileSource(`
        import {
            addToScene,
            createBox,
            createEngine,
            createSceneContext,
        } from "@babylonjs/lite";
        class Renderer {
            private engine: EngineContext;
            private scene: SceneContext;
            constructor(engine: EngineContext, scene: SceneContext) {
                this.engine = engine;
                this.scene = scene;
            }
            draw(): void {
                addToScene(this.scene, createBox(this.engine, 1));
            }
        }
        async function main(): Promise<void> {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            const scene = createSceneContext(engine);
            const renderer = new Renderer(engine, scene);
            renderer.draw();
        }
        main();
    `);

    assert.doesNotMatch(
        result.cpp,
        /auto&\s+(v_[A-Za-z0-9_]+)\s*=\s*\1;/,
    );
    assert.match(result.cpp, /v_bblite_class_field_engine_/);
    assert.match(result.cpp, /v_bblite_class_field_scene_/);
});

test("rejects reassigning a resource-holding class field", () => {
    // Resource storage is wired once; branch-sensitive rebinding needs a
    // runtime class representation that this subset does not yet provide.
    assert.throws(
        () =>
            compileSource(`
                import {
                    createEngine,
                    createStandardMaterial,
                } from "@babylonjs/lite";
                class Painter {
                    private material: StandardMaterial;
                    constructor(material: StandardMaterial) {
                        this.material = material;
                    }
                    swap(other: StandardMaterial): void {
                        this.material = other;
                    }
                }
                async function main(): Promise<void> {
                    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
                    const engine = await createEngine(canvas);
                    const painter = new Painter(createStandardMaterial());
                    painter.swap(createStandardMaterial());
                }
                main();
            `),
        /is already bound; a class field that holds a resource is wired once/,
    );
});

test("lowers a Record keyed by a string union into tag-ordered slots", () => {
    const result = compileSource(`
        type Mode = "pets" | "arcade" | "smooth";
        interface RenderSet { scale: number; }
        const sets: Record<Mode, RenderSet> = {
            pets: { scale: 1 },
            arcade: { scale: 2 },
            smooth: { scale: 3 },
        };
        let mode: Mode = "smooth";
        const active = sets[mode];
        const picked = active.scale + sets["arcade"].scale;
    `);
    // Enum members are numbered in sorted order, so the slots emit as
    // arcade, pets, smooth regardless of how the literal was written.
    assert.match(
        result.cpp,
        /enum class Mode \{\s*arcade,\s*pets,\s*smooth,/,
    );
    // pets/arcade/smooth were written in that order and pinned to
    // temporaries in it; the map then takes them in tag order.
    assert.match(
        result.cpp,
        /RenderSet v_bblite_slot_0 = bblscene::RenderSet\{1\.0\};/,
    );
    assert.match(
        result.cpp,
        /RenderSet v_bblite_slot_1 = bblscene::RenderSet\{2\.0\};/,
    );
    assert.match(
        result.cpp,
        /bbl::js::EnumMap<bblscene::RenderSet, 3>\{v_bblite_slot_1, v_bblite_slot_0, v_bblite_slot_2\}/,
    );
    // Both a runtime tag and a literal key index the same way.
    assert.match(result.cpp, /enum_map_at\(v_sets, v_mode\)/);
    assert.match(
        result.cpp,
        /enum_map_at\(v_sets, bblscene::Mode::arcade\)/,
    );
});

test("evaluates Record slots in source order, places them in tag order", () => {
    // A slot initializer can emit statements, and JavaScript runs those
    // in the order the properties were written. Compiling in tag order
    // instead would reorder the side effects.
    const result = compileSource(`
        type Mode = "pets" | "arcade";
        function count(n: number): number[] {
            const out: number[] = [];
            for (let i = 0; i < n; i++) { out.push(i); }
            return out;
        }
        const sets: Record<Mode, number[]> = {
            pets: count(2),
            arcade: count(3),
        };
        let mode: Mode = "pets";
        const picked = sets[mode].length;
    `);
    // `pets` is written first, so its call runs first...
    const first = result.cpp.indexOf("count(2.0)");
    const second = result.cpp.indexOf("count(3.0)");
    assert.ok(first > 0 && second > first);
    // ...into a temporary, because `arcade` sorts first and therefore
    // takes slot 0. Without the temporaries the braced initializer
    // would run the calls in slot order instead.
    assert.match(
        result.cpp,
        /(\w+) = bblscene::count\(2\.0\);/,
    );
    assert.match(
        result.cpp,
        /EnumMap<bbl::js::Array<double>, 2>\{v_bblite_slot_4, v_bblite_slot_3\}/,
    );
});

test("skips Record slot temporaries when the orders already agree", () => {
    // Written in tag order, the braces already evaluate left to right
    // in source order, so no temporary is needed.
    const result = compileSource(`
        type Mode = "pets" | "arcade";
        function count(n: number): number[] {
            const out: number[] = [];
            for (let i = 0; i < n; i++) { out.push(i); }
            return out;
        }
        const sets: Record<Mode, number[]> = {
            arcade: count(3),
            pets: count(2),
        };
        let mode: Mode = "pets";
        const picked = sets[mode].length;
    `);
    assert.doesNotMatch(result.cpp, /v_bblite_slot/);
    assert.match(
        result.cpp,
        /EnumMap<bbl::js::Array<double>, 2>\{bblscene::count\(3\.0\), bblscene::count\(2\.0\)\}/,
    );
});

test("rejects a Record literal missing a slot", () => {
    assert.throws(
        () =>
            compileSource(`
                type Mode = "pets" | "arcade" | "smooth";
                const sets: Record<Mode, number> = { pets: 1, arcade: 2 };
                let mode: Mode = "pets";
                const picked = sets[mode];
            `),
        /Record literal is missing the 'smooth' slot/,
    );
});

test("keeps an interface with the same keys a struct", () => {
    // Only the `Record` alias becomes a tag-indexed map; an ordinary
    // interface that happens to share the key names stays a struct, so
    // existing scenes keep the representation they had.
    const result = compileSource(`
        interface Plain { pets: number; arcade: number; smooth: number; }
        const plain: Plain = { pets: 1, arcade: 2, smooth: 3 };
        const picked = plain.arcade;
    `);
    assert.match(result.cpp, /struct Plain/);
    assert.doesNotMatch(result.cpp, /EnumMap/);
});

test("a record's methods and getter reach the scope it closed over", () => {
    // The factory's scope is left before the record is used, so the
    // record has to carry it: both the inlined method and the getter
    // must still resolve `currentMode` to the factory's local.
    const result = compileSource(`
        type Mode = "pets" | "arcade";
        function createRenderer() {
            let currentMode: Mode = "pets";
            function setMode(mode: Mode): void {
                currentMode = mode;
            }
            return {
                setMode,
                get mode() { return currentMode; },
            };
        }
        const sets: Record<Mode, number> = { pets: 1, arcade: 2 };
        const renderer = createRenderer();
        renderer.setMode("arcade");
        const picked = sets[renderer.mode];
    `);
    const state = result.cpp.match(
        /Mode (v_\w*currentMode) = bblscene::Mode::pets;/,
    );
    assert.ok(state);
    const local = state[1]!;
    // The method writes the captured local...
    assert.match(
        result.cpp,
        new RegExp(`${local} = bblscene::Mode::arcade;`),
    );
    // ...and the getter reads it, rather than a snapshot of it.
    assert.match(
        result.cpp,
        new RegExp(`enum_map_at\\(v_sets, ${local}\\)`),
    );
});

test("a record getter must be a single return", () => {
    assert.throws(
        () =>
            compileSource(`
                const api = {
                    get total() {
                        let sum = 0;
                        return sum;
                    },
                };
                const read = api.total;
            `),
        /must be a single return statement/,
    );
});

test("compiles record method arguments in the caller's scope", () => {
    // `chosen` belongs to the call site, not to the record's captured
    // scope, so it must resolve there.
    const result = compileSource(`
        type Mode = "pets" | "arcade";
        function createRenderer() {
            let currentMode: Mode = "pets";
            function setMode(mode: Mode): void {
                currentMode = mode;
            }
            return { setMode, get mode() { return currentMode; } };
        }
        const sets: Record<Mode, number> = { pets: 1, arcade: 2 };
        const renderer = createRenderer();
        const chosen: Mode = "arcade";
        renderer.setMode(chosen);
        const picked = sets[renderer.mode];
    `);
    assert.match(
        result.cpp,
        /Mode v_chosen = bblscene::Mode::arcade;/,
    );
});

test("cycles a constant tag array with indexOf and a runtime index", () => {
    // The demo's `toggleMode`. The array folds to a compile-time tuple
    // on its own, so a computed index needs it materialized.
    const result = compileSource(`
        type Mode = "pets" | "arcade" | "smooth";
        const MODE_CYCLE: readonly Mode[] = ["pets", "arcade", "smooth"];
        let currentMode: Mode = "arcade";
        const next = MODE_CYCLE[(MODE_CYCLE.indexOf(currentMode) + 1) % MODE_CYCLE.length]!;
        currentMode = next;
    `);
    assert.match(
        result.cpp,
        /inline const std::array<bblscene::Mode, 3> MODE_CYCLE\{bblscene::Mode::pets, bblscene::Mode::arcade, bblscene::Mode::smooth\}/,
    );
    // Both the search and the index read that one constant...
    assert.match(
        result.cpp,
        /array_index_of\(bblscene::MODE_CYCLE, v_currentMode\)/,
    );
    assert.equal(
        (
            result.cpp.match(
                /inline const std::array<bblscene::Mode/g,
            ) ?? []
        ).length,
        1,
    );
    // ...and the element copies, since a span's elements are const.
    assert.match(
        result.cpp,
        /bblscene::Mode v_next = bblscene::MODE_CYCLE\[/,
    );
});

test("searches a runtime array with indexOf", () => {
    const result = compileSource(`
        const ys: number[] = [3, 5, 7];
        let needle = 5;
        const found = ys.indexOf(needle);
    `);
    assert.match(
        result.cpp,
        /array_index_of\(v_ys, v_needle\)/,
    );
});

test("materializes a constant number array with double elements", () => {
    // The tuple's own element text is a float literal; widening one
    // back to double does not always give the value the needle holds.
    const result = compileSource(`
        const xs = [0.1, 0.2];
        let needle = 0.2;
        const found = xs.indexOf(needle);
    `);
    assert.match(
        result.cpp,
        /inline const std::array<double, 2> xs\{0\.1, 0\.2\}/,
    );
    assert.match(
        result.cpp,
        /array_index_of\(bblscene::xs, v_needle\)/,
    );
});

test("rejects indexOf where JavaScript would compare by identity", () => {
    assert.throws(
        () =>
            compileSource(`
                interface Point { x: number; }
                const points: Point[] = [{ x: 1 }];
                const found = points.indexOf(points[0]!);
            `),
        /JavaScript would compare by identity here/,
    );
});

test("binds object data-path locals with shared identity", () => {
    const result = compileSource(`
        interface Holder {
            inner: { count: number };
        }
        function poke(holder: Holder): void {
            const alias = holder.inner;
            alias.count = 5;
        }
        const holder: Holder = {
            inner: { count: 1 },
        };
        poke(holder);
    `);

    // Copying the shared object handle preserves JavaScript identity, so the
    // field write still reaches the object stored in the holder.
    assert.match(
        result.cpp,
        /bblscene::Record\d+ v_fn\d+_alias = v_fn\d+_holder\.inner;/,
    );
    assert.match(result.cpp, /v_fn\d+_alias->count = 5\.0;/);
});

test("copies spread objects and destructures reference-backed array entries", () => {
    const result = compileSource(`
        interface Row {
            row: number;
            colors: number[];
        }
        function sumRows(rows: Row[]): number {
            let total = 0;
            for (const { row, colors } of rows) {
                total += row + colors[0]!;
            }
            return total;
        }
        const rows: Row[] = [];
        const original: Row = { row: 1, colors: [2, 3] };
        const moved: Row = { ...original, row: original.row + 1 };
        rows.push(original, moved);
        const total = sumRows(rows);
    `);

    assert.match(
        result.cpp,
        /bblscene::Row v_moved = std::make_shared<bblscene::RowData>\(\*\(v_original\)\);/,
    );
    assert.match(result.cpp, /v_moved->row = \(v_original->row \+ 1\.0\);/);
    assert.match(
        result.cpp,
        /v_bblite_item_\d+->row/,
    );
    assert.match(
        result.cpp,
        /v_bblite_item_\d+->colors/,
    );
});

test("keeps an object element alive after its container is resized", () => {
    const result = compileSource(`
        interface Entry { value: number; }
        const list: Entry[] = [{ value: 1 }];
        const entry = list[0]!;
        list.push({ value: 2 });
        entry.value = 5;
    `);
    assert.match(
        result.cpp,
        /bblscene::Entry v_entry = v_list\[bbl::js::array_index\(0\.0\)\];/,
    );
    assert.match(result.cpp, /v_entry->value = 5\.0;/);
});

test("mutable object aliases retain JavaScript identity", () => {
    const result = compileSource(`
        interface Holder {
            inner: { count: number };
        }
        function poke(holder: Holder): void {
            let alias = holder.inner;
            alias.count = 5;
        }
        const holder: Holder = {
            inner: { count: 1 },
        };
        poke(holder);
    `);
    assert.match(
        result.cpp,
        /bblscene::Record\d+ v_fn\d+_alias = v_fn\d+_holder\.inner;/,
    );
    assert.match(result.cpp, /v_fn\d+_alias->count = 5\.0;/);
});

test("seeds Math.random deterministically and records the adaptation", () => {
    const result = compileSource(`
        function roll(sides: number): number {
            return Math.floor(Math.random() * sides);
        }
        const value = roll(6);
    `);

    assert.match(
        result.cpp,
        /bbl::js::seed_random\(1u\);/,
    );
    assert.match(
        result.cpp,
        /std::floor\(\(bbl::js::random_js\(\) \* v_fn\d+_sides\)\)/,
    );
    assert.ok(
        result.manifest.adaptations.some(
            ({ id }) =>
                id === "deterministic-seeded-random",
        ),
    );
});

test("lowers Math.imul through its exact wrapped 32-bit semantics", () => {
    const result = compileSource(`
        function step(state: number): number {
            return Math.imul(state ^ (state >>> 15), state | 1);
        }
        const next = step(-1);
    `);

    assert.match(
        result.cpp,
        /bbl::js::math_imul\(bbl::js::bitwise_xor\([^,]+, bbl::js::shift_right_unsigned\([^)]*\)\), bbl::js::bitwise_or\([^)]*\)\)/,
    );
});

test("lowers Array.every with JavaScript empty-array and early-exit semantics", () => {
    const result = compileSource(`
        const points: [number, number][] = [[0, 0], [3, 4]];
        const distant = points.every(([x, y]) => Math.hypot(x, y) >= 0);
    `);

    assert.match(result.cpp, /bool \w*_every_result_\d+ = true;/);
    assert.match(result.cpp, /if \(!\(std::hypot\([^)]*\) >= 0\.0\)\) \{/);
    assert.match(result.cpp, /\w*_every_result_\d+ = false;\s+break;/);
});

test("lowers typed arrays with storage-exact reads and writes", () => {
    const result = compileSource(`
        function build(): Float32Array {
            const values: number[] = [];
            values.push(0.25, 0.5, 0.75);
            return new Float32Array(values);
        }
        const data = build();
        const first = data[0]!;
        data[1] = 2.5;
        const count = data.length;
        const indices = new Uint32Array([0, 1, 2]);
        indices[0] = 7;
        const signed = new Int32Array([-1, 2147483648]);
        signed[0] = 4294967295;
        const signedShorts = new Int16Array([-1, 32768]);
        signedShorts[0] = 65535;
        const zeros = new Float32Array(8);
    `);

    assert.match(
        result.cpp,
        /bbl::js::f32_array_from\(v_fn\d+_values\)/,
    );
    assert.match(
        result.cpp,
        /\(v_fn\d+_values\.push_back\(0\.25\), v_fn\d+_values\.push_back\(0\.5\), v_fn\d+_values\.push_back\(0\.75\)\);/,
    );
    assert.match(
        result.cpp,
        /double v_first = static_cast<double>\(v_data\[bbl::js::array_index\(0\.0\)\]\);/,
    );
    assert.match(
        result.cpp,
        /v_data\[bbl::js::array_index\(1\.0\)\] = static_cast<float>\(2\.5\);/,
    );
    assert.match(
        result.cpp,
        /v_indices\[bbl::js::array_index\(0\.0\)\] = bbl::js::to_uint32\(7\.0\);/,
    );
    assert.match(
        result.cpp,
        /bbl::js::u32_array_from\(bbl::js::Array<double>\{0\.0, 1\.0, 2\.0\}\)/,
    );
    assert.match(
        result.cpp,
        /bbl::js::f32_array_sized\(8\.0\)/,
    );
    assert.match(
        result.cpp,
        /bbl::js::i32_array_from\(bbl::js::Array<double>\{\(-1\.0\), 2147483648\.0\}\)/,
    );
    assert.match(
        result.cpp,
        /v_signed\[bbl::js::array_index\(0\.0\)\] = bbl::js::to_int32\(4294967295\.0\);/,
    );
    assert.match(
        result.cpp,
        /bbl::js::i16_array_from\(bbl::js::Array<double>\{\(-1\.0\), 32768\.0\}\)/,
    );
    assert.match(
        result.cpp,
        /v_signedShorts\[bbl::js::array_index\(0\.0\)\] = bbl::js::to_int16\(65535\.0\);/,
    );
});

test("defaults omitted Uint8Array slice and subarray bounds", () => {
    const result = compileSource(`
        const source = new Uint8Array([1, 2, 3]);
        const copy = source.slice();
        const view = source.subarray();
        const buffer = source.buffer;
        const tail = new Uint8Array(buffer, 1);
        const middle = new Uint8Array(buffer, 1, 1).slice();
    `);

    assert.match(
        result.cpp,
        /v_source\.slice\(bbl::js::array_index\(0\.0\), bbl::js::array_index\(static_cast<double>\(v_source\.size\(\)\)\)\)/,
    );
    assert.match(
        result.cpp,
        /v_source\.subarray\(bbl::js::array_index\(0\.0\), bbl::js::array_index\(static_cast<double>\(v_source\.size\(\)\)\)\)/,
    );
    assert.match(
        result.cpp,
        /bbl::js::U8Array\(v_buffer, bbl::js::array_index\(1\.0\)\)/,
    );
    assert.match(
        result.cpp,
        /bbl::js::U8Array\(v_buffer, bbl::js::array_index\(1\.0\), bbl::js::array_index\(1\.0\)\)\.slice/,
    );
});

test("copies vector-backed typed arrays through slice", () => {
    const result = compileSource(`
        const source = new Float32Array([1, 2, 3]);
        const copy = source.slice();
        const tail = source.slice(-2);
    `);

    assert.match(
        result.cpp,
        /bbl::js::typed_array_slice\(v_source, 0\.0, static_cast<double>\(v_source\.size\(\)\)\)/,
    );
    assert.match(
        result.cpp,
        /bbl::js::typed_array_slice\(v_source, \(-2\.0\), static_cast<double>\(v_source\.size\(\)\)\)/,
    );
});

test("rebinds optional typed arrays from fresh constructors", () => {
    const result = compileSource(`
        let bytes: Uint8Array | null = null;
        bytes = new Uint8Array(4).slice();
        let signed: Int32Array | null = null;
        signed = new Int32Array(2);
    `);

    assert.match(
        result.cpp,
        /v_bytes = bbl::js::Nullable<bbl::js::U8Array>\{bbl::js::u8_array_sized\(4\.0\)\.slice/,
    );
    assert.match(
        result.cpp,
        /v_signed = bbl::js::Nullable<bbl::js::I32Array>\{bbl::js::i32_array_sized\(2\.0\)\};/,
    );
});

test("distinguishes omitted and explicit zero DataView lengths", () => {
    const result = compileSource(`
        const bytes = new Uint8Array(4);
        const remaining = new DataView(bytes.buffer, 2);
        const empty = new DataView(bytes.buffer, 2, 0);
        const totalBytes = bytes.buffer.byteLength;
        const byte = remaining.getUint8(0);
        const signed = remaining.getInt8(0);
        const scalar = remaining.getFloat32(0, true);
    `);

    assert.match(
        result.cpp,
        /bbl::js::DataView\(v_bytes\.buffer\(\), bbl::js::array_index\(2\.0\)\);/,
    );
    assert.match(
        result.cpp,
        /bbl::js::DataView\(v_bytes\.buffer\(\), bbl::js::array_index\(2\.0\), bbl::js::array_index\(0\.0\)\);/,
    );
    assert.match(result.cpp, /v_remaining\.get_uint8\(bbl::js::array_index\(0\.0\)\)/);
    assert.match(result.cpp, /v_bytes\.buffer\(\)\.byte_length\(\)/);
    assert.match(result.cpp, /v_remaining\.get_int8\(bbl::js::array_index\(0\.0\)\)/);
    assert.match(result.cpp, /v_remaining\.get_float32\(bbl::js::array_index\(0\.0\), true\)/);
});

test("indexes runtime strings as one-character strings", () => {
    const result = compileSource(`
        function opening(text: string, index: number): boolean {
            return text[index] === "{" && text.toLowerCase() === text;
        }
        const found = opening("{}", 0);
    `);

    assert.match(
        result.cpp,
        /std::string\(bbl::js::string_at\(v_fn\d+_text, bbl::js::array_index\(v_fn\d+_index\)\)\) == std::string\("\{"\)/,
    );
    assert.match(result.cpp, /bbl::js::string_lower\(v_fn\d+_text\)/);
});

test("narrows guarded optional strings before trim", () => {
    const result = compileSource(`
        function clean(value: string | undefined): string {
            if (!value) return "";
            return value.trim();
        }
        const cleaned = clean(" value ");
        const words = cleaned.split(/\\s+/);
        const numbers = "1 2".split(/\\s+/).map(Number);
    `);

    assert.match(result.cpp, /bbl::js::string_trim\(\(\*v_fn\d+_value\)\)/);
    assert.match(result.cpp, /bbl::js::RegExp\("\\\\s\+", false, false\)\.split\(v_cleaned\)/);
    assert.match(result.cpp, /bbl::js::number_from_string\(v_bblite_map_source_\d+\[v_bblite_map_index_\d+\]\)/);
});

test("inlines function-valued parameters at their call sites", () => {
    const result = compileSource(`
        function apply(count: number, producer: (index: number) => number): number {
            let total = 0;
            for (let index = 0; index < count; index++) {
                total += producer(index);
            }
            return total;
        }
        const doubled = apply(3, (index) => {
            return index * 2;
        });
    `);

    assert.equal(
        result.cpp.match(
            /double v_fn\d+_index = \d\.0;/g,
        )?.length,
        3,
    );
    assert.equal(
        result.cpp.match(
            /v_fn0_total \+= \(v_fn\d+_index \* 2\.0\);/g,
        )?.length,
        3,
    );
    const named = compileSource(`
        function apply(count: number, producer: (index: number) => number): number {
            let total = 0;
            for (let index = 0; index < count; index++) {
                total += producer(index);
            }
            return total;
        }
        const offset = 5;
        const produce = (index: number): number => index + offset;
        const result = apply(2, produce);
    `);
    assert.equal(
        named.cpp.match(
            /v_fn\d+_total \+= \(v_fn\d+_index \+ 5\.0\);/g,
        )?.length,
        2,
    );
});

test("keeps mutable locals unfolded when bound as arguments", () => {
    const result = compileSource(`
        function twice(value: number): number {
            return value * 2;
        }
        let counter = 0;
        counter++;
        const result = twice(counter);
    `);

    assert.match(
        result.cpp,
        /bblscene::twice\(v_counter\)/,
    );
    assert.doesNotMatch(
        result.cpp,
        /bblscene::twice\(0\.0\)/,
    );
});

test("lowers early bare returns of inlined closures through a wrapper", () => {
    const result = compileSource(`
        const values: number[] = [];
        function record(value: number): void {
            if (value < 0) {
                return;
            }
            values.push(value);
        }
        record(-1);
        record(2);
    `);

    assert.match(result.cpp, /do \{/);
    assert.match(result.cpp, /\} while \(false\);/);
    assert.match(result.cpp, /break;/);
});

test("supports mutable tuple locals with runtime index writes", () => {
    const result = compileSource(`
        function axisVector(axis: number, sign: number): number {
            const p: [number, number, number] = [0, 0, 0];
            p[axis] = sign;
            return p[0] + p[1] + p[2];
        }
        const total = axisVector(1, 5) || 1;
    `);

    assert.match(
        result.cpp,
        /bbl::js::Tuple<3> v_fn\d+_p = bbl::js::Tuple<3>\{0\.0, 0\.0, 0\.0\};/,
    );
    assert.match(
        result.cpp,
        /v_fn\d+_p\[bbl::js::array_index\(v_fn\d+_axis\)\] = v_fn\d+_sign;/,
    );
    assert.match(
        result.cpp,
        /bbl::js::or_number\(bblscene::axisVector\(1\.0, 5\.0\), 1\.0\)/,
    );
});

test("compiles generated mesh data and the file-texture contract", () => {
    const result = compileSource(
        readFileSync(
            resolve("examples/regression-runtime-sweep.ts"),
            "utf8",
        ),
        { fileName: "examples/regression-runtime-sweep.ts" },
    );

    assert.ok(
        result.manifest.features.includes(
            "mesh:from-data",
        ),
    );
    assert.ok(
        result.manifest.features.includes(
            "mesh:thin-instances",
        ),
    );
    assert.ok(
        result.manifest.features.includes(
            "mesh:thin-instances-dynamic",
        ),
    );
    assert.ok(
        result.manifest.features.includes("scene:remove"),
    );
    assert.match(
        result.cpp,
        /bbl::create_mesh_from_data\(v_engine, "[^"]+", v_cube\.positions, v_cube\.normals, v_cube\.indices, v_cube\.uvs, \{\}, \{\}, \{\}\)/,
    );
    // The pool is adopted by name; the capacity expression itself is not
    // part of the contract.
    assert.match(
        result.cpp,
        /bbl::set_thin_instances\(v_engine, v_latticeA, v_bufferA, /,
    );
    // A file texture materializes as a compile-time asset and loads through
    // the pinned sampler contract (nearest, unmipped, sRGB base color),
    // attaching after the material exists.
    assert.match(
        result.cpp,
        /bbl::load_file_texture\(v_engine, bbl::asset_path\("[0-9a-f]+-ebf71b300f43563f\.png"\), bbl::TextureSamplerState\{bbl::TextureFilter::nearest, bbl::TextureFilter::nearest, bbl::TextureMipmapMode::nearest, bbl::TextureAddressMode::repeat, bbl::TextureAddressMode::repeat, 1\.0f, 0\.0f\}, false, true, false\)/,
    );
    assert.match(
        result.cpp,
        /bbl::set_material_base_color_file\(v_engine, v_bblite_material_\d+, v_decalTexture\);/,
    );
    assert.ok(
        result.manifest.assets.some((asset) =>
            asset.output.endsWith(
                "ebf71b300f43563f.png",
            ),
        ),
    );
    assert.doesNotMatch(
        result.cpp,
        /(?:Engine|Surface)Context\d*Data/,
        "type probes must not leak unused context declarations",
    );
});

test("keeps data URL asset payloads out of the generated manifest", () => {
    const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
    const result = compileSource(`
        import { createEngine, loadTexture2D } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            await loadTexture2D(engine, "${dataUrl}", { mipMaps: false });
        }
    `);
    const asset = result.manifest.assets[0];

    assert.ok(asset);
    assert.match(
        asset.source,
        /^generated:data-url:[0-9a-f]{64}$/,
    );
    assert.equal(result.assetPayloads.get(asset.source), dataUrl);
    assert.doesNotMatch(JSON.stringify(result.manifest), /base64/);
    assert.match(asset.output, /^[0-9a-f]{8}-inline\.png$/);
});

test("carries file-texture address modes into the sampler", () => {
    const result = compileSource(`
        import { createEngine, loadTexture2D } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            await loadTexture2D(
                engine,
                "/textures/nme/ebf71b300f43563f.png",
                {
                    addressModeU: "clamp-to-edge",
                    addressModeV: "mirror-repeat",
                },
            );
        }
    `);

    assert.match(
        result.cpp,
        /TextureAddressMode::clamp, bbl::TextureAddressMode::mirror/,
    );
});

test("carries a base-color image's own encoding, either way", () => {
    // Upstream keeps the format on the `Texture2D` `loadTexture2D` built
    // (`opts.srgb ?? false` picks `rgba8unorm-srgb` or `rgba8unorm`), so the
    // slot samples what the scene asked for. A material that decodes its own
    // albedo — `setPbrGammaAlbedo` — loads the linear one.
    const load = (options: string) =>
        compileSource(`
            import {
                createEngine,
                createPbrMaterial,
                createSolidTexture2D,
                loadTexture2D,
            } from "@babylonjs/lite";

            async function main() {
                const engine = await createEngine({});
                const texture = await loadTexture2D(engine, "/textures/nme/ebf71b300f43563f.png"${options});
                const material = createPbrMaterial({
                    baseColorTexture: texture,
                    ormTexture: createSolidTexture2D(engine, 1, 0.5, 0),
                });
            }
        `).cpp;
    // The penultimate `load_file_texture` argument is the requested encoding;
    // premultiplication follows it. The attach carries the encoding onto the
    // record's own base-colour lane.
    assert.match(load(", { srgb: true }"), /bbl::load_file_texture\([^\n]+, true, false\)/);
    assert.match(load(""), /bbl::load_file_texture\([^\n]+, false, false\)/);
    for (const options of [", { srgb: true }", ""]) {
        assert.match(
            load(options),
            /bbl::set_material_base_color_file\(/,
        );
    }
});

test("separates transmission-capable PBR from linear image processing", () => {
    const compile = (activation: string) =>
        compileSource(`
            import {
                createEngine,
                createPbrMaterial,
                createSceneContext,
                createSolidTexture2D,
                enableSceneTransmission,
                setPbrSkybox,
            } from "@babylonjs/lite";

            async function main() {
                const engine = await createEngine({});
                const scene = createSceneContext(engine);
                const material = createPbrMaterial({
                    baseColorTexture: createSolidTexture2D(engine, 1, 1, 1),
                    ormTexture: createSolidTexture2D(engine, 1, 0.5, 0),
                });
                ${activation}
            }
        `).manifest.features;

    const skybox = compile("setPbrSkybox(material);");
    assert.ok(skybox.includes("renderer:transmission"));
    assert.ok(!skybox.includes("material:pbr-linear-image-processing"));

    const retargeted = compile("enableSceneTransmission(scene, engine);");
    assert.ok(retargeted.includes("renderer:transmission"));
    assert.ok(retargeted.includes("material:pbr-linear-image-processing"));
});

test("carries scene-code PBR occlusion strength into composition and runtime", () => {
    const result = compileSource(`
        import {
            createEngine,
            createPbrMaterial,
            createSolidTexture2D,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            createPbrMaterial({
                baseColorTexture: createSolidTexture2D(engine, 1, 1, 1),
                ormTexture: createSolidTexture2D(engine, 1, 0.5, 0),
                occlusionStrength: 0,
            });
        }
    `);

    assert.equal(
        result.manifest.scenePbrMaterials[0]?.occlusionStrength,
        0,
    );
    assert.match(
        result.cpp,
        /\.occlusion_strength = 0\.0f, \.metallic_f0_factor = 1\.0f/,
    );
    assert.doesNotMatch(
        result.cpp,
        /\.materials\[[^\]]+\.value\]\.occlusion_strength =/,
    );

    const defaultResult = compileSource(`
        import {
            createEngine,
            createPbrMaterial,
            createSolidTexture2D,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            createPbrMaterial({
                baseColorTexture: createSolidTexture2D(engine, 1, 1, 1),
                ormTexture: createSolidTexture2D(engine, 1, 0.5, 0),
            });
        }
    `);
    assert.equal(
        defaultResult.manifest.scenePbrMaterials[0]?.occlusionStrength,
        undefined,
    );
    assert.match(
        defaultResult.cpp,
        /\.occlusion_strength = 1\.0f, \.metallic_f0_factor = 1\.0f/,
    );

    assert.throws(
        () =>
            compileSource(`
                import {
                    createArcRotateCamera,
                    createEngine,
                    createPbrMaterial,
                    createSolidTexture2D,
                } from "@babylonjs/lite";

                async function main() {
                    const engine = await createEngine({});
                    const camera = createArcRotateCamera(0, 1, 10, { x: 0, y: 0, z: 0 });
                    createPbrMaterial({
                        baseColorTexture: createSolidTexture2D(engine, 1, 1, 1),
                        ormTexture: createSolidTexture2D(engine, 1, 0.5, 0),
                        occlusionStrength: camera.alpha,
                    });
                }
            `),
        /occlusionStrength must be a finite static number/,
    );

    for (const nonfinite of ["1 / 0", "0 / 0"]) {
        assert.throws(
            () =>
                compileSource(`
                    import {
                        createEngine,
                        createPbrMaterial,
                        createSolidTexture2D,
                    } from "@babylonjs/lite";

                    async function main() {
                        const engine = await createEngine({});
                        createPbrMaterial({
                            baseColorTexture: createSolidTexture2D(engine, 1, 1, 1),
                            ormTexture: createSolidTexture2D(engine, 1, 0.5, 0),
                            occlusionStrength: ${nonfinite},
                        });
                    }
                `),
            /occlusionStrength must be a finite static number/,
        );
    }
});

test("carries scene-code PBR specular AA into composition and runtime", () => {
    const result = compileSource(`
        import {
            createEngine,
            createPbrMaterial,
            createSolidTexture2D,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            createPbrMaterial({
                baseColorTexture: createSolidTexture2D(engine, 1, 1, 1),
                ormTexture: createSolidTexture2D(engine, 1, 0.5, 0),
                enableSpecularAA: true,
            });
        }
    `);

    assert.equal(
        result.manifest.scenePbrMaterials[0]?.enableSpecularAA,
        true,
    );
    assert.match(
        result.cpp,
        /\.double_sided = false, \.specular_aa = true, \.skybox_mode = false/,
    );

    assert.throws(
        () =>
            compileSource(`
                import {
                    createArcRotateCamera,
                    createEngine,
                    createPbrMaterial,
                    createSolidTexture2D,
                } from "@babylonjs/lite";

                async function main() {
                    const engine = await createEngine({});
                    const camera = createArcRotateCamera(0, 1, 10, { x: 0, y: 0, z: 0 });
                    createPbrMaterial({
                        baseColorTexture: createSolidTexture2D(engine, 1, 1, 1),
                        ormTexture: createSolidTexture2D(engine, 1, 0.5, 0),
                        enableSpecularAA: camera.alpha > 0,
                    });
                }
            `),
        /Expected a boolean literal/,
    );
});

test("derives mapped PBR emissive colours from static source expressions", () => {
    const result = compileSource(`
        import {
            createEngine,
            createPbrMaterial,
            createSolidTexture2D,
            setPbrEmissive,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const base = createSolidTexture2D(engine, 1, 1, 1);
            const orm = createSolidTexture2D(engine, 1, 0.5, 0);
            const colors: readonly [number, number, number][] = [
                [0.95, 0.24, 0.52],
                [0.22, 0.34, 0.95],
            ];
            colors.map((rgb) => {
                const material = createPbrMaterial({
                    baseColorTexture: base,
                    baseColorFactor: [rgb[0], rgb[1], rgb[2], 1],
                    ormTexture: orm,
                });
                setPbrEmissive(material, [
                    rgb[0] * 0.35,
                    rgb[1] * 0.35,
                    rgb[2] * 0.35,
                ]);
                return material;
            });
        }
    `);

    assert.deepEqual(
        result.manifest.scenePbrMaterials.map(
            ({ emissiveColor }) => emissiveColor,
        ),
        [
            [0.95 * 0.35, 0.24 * 0.35, 0.52 * 0.35],
            [0.22 * 0.35, 0.34 * 0.35, 0.95 * 0.35],
        ],
    );
    assert.equal(
        result.cpp.match(/bbl::set_pbr_emissive\(/g)?.length,
        2,
    );
    assert.match(
        result.cpp,
        /static_cast<float>\(\(0\.95 \* 0\.35\)\)/,
    );
});

test("lowers Scene 26's static translucency and thickness map", () => {
    const result = compileSource(`
        import {
            createEngine,
            createPbrMaterial,
            createSolidTexture2D,
            loadTexture2D,
            setPbrSubsurface,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const thickness = await loadTexture2D(
                engine,
                "data:image/png;base64,iVBORw0KGgo=",
                { invertY: false },
            );
            const material = createPbrMaterial({
                baseColorTexture: createSolidTexture2D(engine, 1, 1, 1),
                ormTexture: createSolidTexture2D(engine, 1, 0.16, 0),
                enableSpecularAA: true,
            });
            setPbrSubsurface(material, {
                translucency: {
                    intensity: 1,
                    color: [1, 0.5, 0.25],
                    diffusionDistance: [1, 2, 3],
                },
                thickness: { texture: thickness, min: 0, max: 2.2 },
            });
        }
    `);

    assert.deepEqual(result.manifest.scenePbrMaterials[0]?.subsurface, {
        intensity: 1,
        color: [1, 0.5, 0.25],
        diffusionDistance: [1, 2, 3],
        hasThicknessTexture: true,
        minimumThickness: 0,
        maximumThickness: 2.2,
    });
    assert.match(
        result.cpp,
        /bbl::set_pbr_subsurface\([^;]*1\.0f, bbl::Color3\{1\.0f, 0\.5f, 0\.25f\}, bbl::Color3\{1\.0f, 2\.0f, 3\.0f\}, 0\.0f, 2\.2f, v_thickness\);/,
    );

    assert.throws(
        () =>
            compileSource(`
                import {
                    createEngine,
                    createPbrMaterial,
                    createSolidTexture2D,
                    setPbrSubsurface,
                } from "@babylonjs/lite";

                async function main() {
                    const engine = await createEngine({});
                    const material = createPbrMaterial({
                        baseColorTexture: createSolidTexture2D(engine, 1, 1, 1),
                        ormTexture: createSolidTexture2D(engine, 1, 1, 0),
                    });
                    setPbrSubsurface(material, {
                        translucency: { diffusionDistance: [1, 1 / 0, 1] },
                        thickness: {
                            texture: createSolidTexture2D(engine, 1, 1, 1),
                        },
                    });
                }
            `),
        /diffusionDistance must be a finite static RGB tuple/,
    );
});

test("derives PBR layer manifests from source values, not emitted C++", () => {
    const result = compileSource(`
        import {
            createEngine,
            createPbrMaterial,
            createSolidTexture2D,
            setPbrClearCoat,
            setPbrIridescence,
            setPbrSheen,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const material = createPbrMaterial({
                baseColorTexture: createSolidTexture2D(engine, 1, 1, 1),
                ormTexture: createSolidTexture2D(engine, 1, 0.5, 0),
            });
            const computed = Math.sqrt(0.25);
            setPbrClearCoat(material, {
                isEnabled: true,
                intensity: computed,
                roughness: computed,
                indexOfRefraction: computed,
            });
            setPbrIridescence(material, {
                isEnabled: true,
                intensity: computed,
                indexOfRefraction: computed,
                minimumThickness: computed,
                maximumThickness: computed,
            });
            setPbrSheen(material, {
                isEnabled: true,
                color: [computed, computed, computed],
                roughness: computed,
                intensity: computed,
            });
        }
    `);

    const material = result.manifest.scenePbrMaterials[0];
    assert.deepEqual(material?.clearCoat, { isEnabled: true });
    assert.deepEqual(material?.iridescence, { isEnabled: true });
    assert.deepEqual(material?.sheen, {
        isEnabled: true,
        hasTexture: false,
        albedoScaling: false,
    });
    assert.match(result.cpp, /std::sqrt\(0\.25\)/);
    assert.doesNotMatch(JSON.stringify(result.manifest), /null/);
});

test("preserves scene-code internal metallic F0 creation state", () => {
    const compileMaterial = (
        extraOption: string,
        setup = "",
    ) =>
        compileSource(`
            import {
                createArcRotateCamera,
                createEngine,
                createPbrMaterial,
                createSolidTexture2D,
            } from "@babylonjs/lite";

            async function main() {
                const engine = await createEngine({});
                ${setup}
                createPbrMaterial({
                    baseColorTexture: createSolidTexture2D(engine, 1, 1, 1),
                    ormTexture: createSolidTexture2D(engine, 1, 0.5, 0),
                    ${extraOption}
                });
            }
        `);

    const result = compileMaterial("_metallicF0Factor: 0.95,");
    assert.equal(
        result.manifest.scenePbrMaterials[0]?.metallicF0Factor,
        0.95,
    );
    assert.match(
        result.cpp,
        /\.occlusion_strength = 1\.0f, \.metallic_f0_factor = 0\.95f/,
    );
    assert.doesNotMatch(
        result.cpp,
        /\.materials\[[^\]]+\.value\]\.(?:metallic_f0_factor|specular_weight) =/,
    );

    const defaultResult = compileMaterial("");
    assert.equal(
        defaultResult.manifest.scenePbrMaterials[0]?.metallicF0Factor,
        undefined,
    );
    assert.match(
        defaultResult.cpp,
        /\.occlusion_strength = 1\.0f, \.metallic_f0_factor = 1\.0f/,
    );

    assert.throws(
        () =>
            compileMaterial(
                "_metallicF0Factor: camera.alpha,",
                "const camera = createArcRotateCamera(0, 1, 10, { x: 0, y: 0, z: 0 });",
            ),
        /_metallicF0Factor must be a finite static number/,
    );
    assert.throws(
        () => compileMaterial("_metallicF0Factor: 1 / 0,"),
        /_metallicF0Factor must be a finite static number/,
    );
    assert.throws(
        () => compileMaterial("_specularWeight: 0.5,"),
        /Reached PBR lowering supports/,
    );
});

test("lowers Scene 12 metallic-reflectance setter shapes", () => {
    const result = compileSource(`
        import {
            createEngine,
            createPbrMaterial,
            createSolidTexture2D,
            loadTexture2D,
            setPbrMetallicReflectance,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const metallic = await loadTexture2D(
                engine,
                "/textures/nme/ebf71b300f43563f.png",
            );
            const reflectance = await loadTexture2D(
                engine,
                "/textures/nme/ebf71b300f43563f.png",
            );
            const base = createSolidTexture2D(engine, 1, 1, 1);
            const orm = createSolidTexture2D(engine, 1, 0.5, 0);
            const r = Math.pow(255 / 255, 2.2);
            const g = Math.pow(250 / 255, 2.2);

            function makeMaterial(options: {
                metallic?: typeof metallic;
                reflectance?: typeof reflectance;
                alphaOnly?: boolean;
            }) {
                const material = createPbrMaterial({
                    baseColorTexture: base,
                    ormTexture: orm,
                    _metallicF0Factor: 0.95,
                });
                setPbrMetallicReflectance(material, {
                    color: [r, g, g],
                    texture: options.metallic,
                    reflectanceTexture: options.reflectance,
                    useOnlyMetallicFromTexture: options.alphaOnly,
                });
                return material;
            }

            makeMaterial({ metallic });
            makeMaterial({ reflectance });
            makeMaterial({ metallic, reflectance, alphaOnly: true });
        }
    `);

    assert.deepEqual(
        result.manifest.scenePbrMaterials.map(
            (material) => material.metallicReflectance,
        ),
        [
            {
                hasColor: true,
                hasMetallicTexture: true,
                hasReflectanceTexture: false,
            },
            {
                hasColor: true,
                hasMetallicTexture: false,
                hasReflectanceTexture: true,
            },
            {
                hasColor: true,
                hasMetallicTexture: true,
                hasReflectanceTexture: true,
                useOnlyMetallicFromTexture: true,
            },
        ],
    );
    assert.equal(
        result.cpp.match(/bbl::set_pbr_metallic_reflectance\(/g)?.length,
        3,
    );
    assert.ok(
        result.manifest.features.includes("material:metallic-reflectance"),
    );
});

test("accumulates repeated metallic-reflectance setter fields", () => {
    const result = compileSource(`
        import {
            createEngine,
            createPbrMaterial,
            createSolidTexture2D,
            loadTexture2D,
            setPbrMetallicReflectance,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const metallic = await loadTexture2D(
                engine,
                "/textures/nme/ebf71b300f43563f.png",
            );
            const reflectance = await loadTexture2D(
                engine,
                "/textures/nme/ebf71b300f43563f.png",
            );
            const material = createPbrMaterial({
                baseColorTexture: createSolidTexture2D(engine, 1, 1, 1),
                ormTexture: createSolidTexture2D(engine, 1, 0.5, 0),
            });
            setPbrMetallicReflectance(material, {
                texture: metallic,
                useOnlyMetallicFromTexture: true,
            });
            setPbrMetallicReflectance(material, {
                reflectanceTexture: reflectance,
            });
        }
    `);

    assert.deepEqual(
        result.manifest.scenePbrMaterials[0]?.metallicReflectance,
        {
            hasColor: false,
            hasMetallicTexture: true,
            hasReflectanceTexture: true,
            useOnlyMetallicFromTexture: true,
        },
    );
    assert.equal(
        result.cpp.match(/bbl::set_pbr_metallic_reflectance\(/g)?.length,
        2,
    );
});

test("refuses unsupported metallic-reflectance setter inputs", () => {
    const compileSetter = (
        textureSetup: string,
        options: string,
    ) => compileSource(`
        import {
            createEngine,
            createPbrMaterial,
            createSolidTexture2D,
            loadTexture2D,
            setPbrMetallicReflectance,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const material = createPbrMaterial({
                baseColorTexture: createSolidTexture2D(engine, 1, 1, 1),
                ormTexture: createSolidTexture2D(engine, 1, 0.5, 0),
            });
            ${textureSetup}
            setPbrMetallicReflectance(material, { ${options} });
        }
    `);

    assert.throws(
        () => compileSetter(
            `const map = await loadTexture2D(
                engine,
                "/textures/nme/ebf71b300f43563f.png",
                { srgb: true },
            );`,
            "texture: map",
        ),
        /Metallic-reflectance maps must be linear textures/,
    );
    assert.throws(
        () => compileSetter(
            "const map = createSolidTexture2D(engine, 1, 1, 1);",
            "texture: map",
        ),
        /must come from loadTexture2D/,
    );
    for (const option of ["f0Factor: 0.5", "specularWeight: 0.5"]) {
        assert.throws(
            () => compileSetter("", option),
            /Reached metallic-reflectance lowering supports/,
        );
    }
    assert.throws(
        () => compileSetter(
            "const value = Math.pow(0.5, 2.2);",
            "color: [value, value, value]",
        ),
        /color-only metallic-reflectance setter requires finite static RGB values/,
    );
});

test("supports lexical block shadowing and if/else", () => {
    const result = compileSource(
        readFileSync(
            resolve("examples/control-flow-scene.ts"),
            "utf8",
        ),
        {
            fileName:
                "examples/control-flow-scene.ts",
        },
    );

    assert.match(
        result.cpp,
        /double v_fn0_exposure = v_fn0_requestedExposure/,
    );
    assert.match(
        result.cpp,
        /double v_fn0_block\d+_exposure = 1\.0/,
    );
    assert.match(result.cpp, /\} else \{/);
    assert.match(
        result.cpp,
        /\.contrast = static_cast<float>\(v_fn0_exposure\)/,
    );
});

test("restores outer symbols after explicit blocks", () => {
    const result = compileSource(`
        const value = 1;
        {
            const value = 2;
            const inside = value * 3;
        }
        const outside = value * 4;
    `);

    assert.match(
        result.cpp,
        /double v_value = 1\.0/,
    );
    assert.match(
        result.cpp,
        /double v_block\d+_value = 2\.0/,
    );
    assert.match(
        result.cpp,
        /double v_outside = \(1\.0 \* 4\.0\)/,
    );
    assert.doesNotMatch(
        result.cpp,
        /v_outside = \(v_block\d+_value/,
    );
});

test("lowers numeric for and while loops", () => {
    const result = compileSource(
        readFileSync(
            resolve("examples/control-flow-scene.ts"),
            "utf8",
        ),
        {
            fileName:
                "examples/control-flow-scene.ts",
        },
    );

    assert.equal(
        result.cpp.match(
            /v_fn0_samples \+= [012]\.0/g,
        )?.length,
        3,
    );
    assert.match(
        result.cpp,
        /while \(v_fn0_remaining > 0\.0\)/,
    );
    assert.match(result.cpp, /v_fn0_remaining--/);
});

test("lowers break and continue in runtime loops", () => {
    const result = compileSource(`
        let total = 0;
        let index = 0;
        while (index < 10) {
            index++;
            if (index === 3) {
                continue;
            }
            if (index > 6) {
                break;
            }
            total += index;
        }
    `);

    assert.match(result.cpp, /continue;/);
    assert.match(result.cpp, /break;/);
    assert.match(result.cpp, /while \(v_index < 10\.0\)/);
});

test("keeps the for incrementor reachable from continue", () => {
    const result = compileSource(`
        let total = 0;
        for (let index = 0; index < count(); index++) {
            if (index === 1) {
                continue;
            }
            total += index;
        }
        function count(): number {
            return 4;
        }
    `);

    assert.match(
        result.cpp,
        /for \(; v_block\d+_index < bblscene::count\(\); v_block\d+_index\+\+\) \{/,
    );
    assert.match(result.cpp, /continue;/);
});

test("rejects labeled loop control explicitly", () => {
    assert.throws(
        () =>
            compileSource(`
                let value = 0;
                outer: while (value < 2) {
                    value++;
                    continue outer;
                }
            `),
        /Unsupported statement: LabeledStatement/,
    );
});

test("lowers numeric switch statements to native branches", () => {
    const result = compileSource(`
        function scoreFor(lines: number): number {
            switch (lines) {
                case 1:
                    return 100;
                case 2:
                case 3:
                    return 300;
                default:
                    return 0;
            }
        }
        const score = scoreFor(2);
    `);

    assert.match(
        result.cpp,
        /const double v_bblite_switch_\d+ = v_fn0_lines;/,
    );
    assert.match(
        result.cpp,
        /if \(v_bblite_switch_\d+ == 1\.0\) \{/,
    );
    assert.match(
        result.cpp,
        /\} else if \(v_bblite_switch_\d+ == 2\.0 \|\| v_bblite_switch_\d+ == 3\.0\) \{/,
    );
    assert.match(result.cpp, /\} else \{/);
});

test("rejects switch cases that fall through with statements", () => {
    assert.throws(
        () =>
            compileSource(`
                function pick(value: number): number {
                    switch (value) {
                        case 1:
                            value += 1;
                        case 2:
                            return value;
                        default:
                            return 0;
                    }
                }
                const picked = pick(1);
            `),
        /Non-empty switch cases must end with break or return/,
    );
});

test("unrolls for-of over static arrays", () => {
    const result = compileSource(
        readFileSync(
            resolve("examples/control-flow-scene.ts"),
            "utf8",
        ),
        {
            fileName:
                "examples/control-flow-scene.ts",
        },
    );

    assert.equal(
        result.cpp.match(
            /samples \+= v_fn0_block\d+_bonus/g,
        )?.length,
        3,
    );
    assert.match(
        result.cpp,
        /double v_fn0_block\d+_bonus = 1\.0/,
    );
    assert.match(
        result.cpp,
        /double v_fn0_block\d+_bonus = 3\.0/,
    );
});

test("unrolls a counted loop over a container it built and never resized", () => {
    // The data model gives an annotated array literal a `vector`, whose
    // length is a run-time read. A container nothing can resize has a length
    // generation knows, and knowing it is what lets the loop unroll — which
    // is the difference between three records and one made three times.
    const result = compileSource(`
        const rows: [number, number][] = [[1, 2], [3, 4], [5, 6]];
        let total = 0;
        for (let i = 0; i < rows.length; i++) {
            const [left, right] = rows[i]!;
            total += left + right + i;
        }
    `);

    assert.doesNotMatch(result.cpp, /for \(/);
    assert.equal(
        result.cpp.match(/v_total \+=/g)?.length,
        3,
    );
});

test("keeps large constant-count data loops at runtime", () => {
    const result = compileSource(`
        const bytes = new Uint8Array(256);
        for (let i = 0; i < 256; i++) {
            bytes[i] = i;
        }
    `);

    assert.match(
        result.cpp,
        /for \(; v_block\d+_i < 256\.0; v_block\d+_i\+\+\) \{/,
    );
    assert.equal(
        result.cpp.match(/bbl::js::to_uint8\(v_block\d+_i\)/g)?.length,
        1,
    );
});

test("statically iterates large loops that reach pinned scene construction", () => {
    const result = compileSource(`
        import { createBox, createEngine } from "babylon-lite";
        function addBox(engine: Awaited<ReturnType<typeof createEngine>>): void {
            createBox(engine, 1);
        }
        async function main(): Promise<void> {
            const engine = await createEngine({});
            for (let i = 0; i < 40; i++) {
                addBox(engine);
            }
        }
    `);

    assert.doesNotMatch(result.cpp, /for \(/);
    assert.equal(result.cpp.match(/bbl::create_box\(/g)?.length, 40);
});

test("grows JavaScript arrays on indexed writes", () => {
    const result = compileSource(`
        interface Row { value: number }
        const rows: Row[] = [];
        rows[4] = { value: 7 };
    `);

    assert.match(
        result.cpp,
        /bbl::js::array_index_write\(v_rows, bbl::js::array_index\(4\.0\)\) = /,
    );
});

test("preserves inferred object identity through container storage", () => {
    const result = compileSource(`
        interface Image { frame: number }
        interface Pending { img: Image }
        const image = { frame: -1 };
        const pending: Pending[] = [];
        pending.push({ img: image });
        pending[0]!.img.frame = 4;
        const observed = image.frame;
    `);

    assert.match(
        result.cpp,
        /bblscene::Image v_image = std::make_shared<bblscene::ImageData>/,
    );
    assert.match(result.cpp, /v_image->frame/);
});

test("keeps a rebound inferred Map object nullable until its fallback", () => {
    const result = compileSource(`
        interface Batch { values: number[] }
        function batchFor(map: Map<string, Batch>, name: string): Batch {
            let batch = map.get(name);
            if (!batch) {
                batch = { values: [] };
                map.set(name, batch);
            }
            return batch;
        }
        const batches = new Map<string, Batch>();
        let name = "walls";
        batchFor(batches, name);
    `);

    assert.match(result.cpp, /static_cast<bool>\(v_\w*batch\)/);
    assert.match(result.cpp, /v_\w*batch = std::make_shared/);
});

test("keeps a rebound inferred array object as a writable reference", () => {
    const result = compileSource(`
        interface Frame { rotated: boolean; values: number[] }
        const frames: (Frame | undefined)[] = [];
        let frame = frames[0];
        if (!frame) {
            frame = { rotated: false, values: [] };
            frames[0] = frame;
        }
        frame.rotated = true;
    `);

    assert.match(result.cpp, /static_cast<bool>\(v_frame\)/);
    assert.match(result.cpp, /v_frame->rotated = true/);
});

test("evaluates conditional data-branch preparation lazily", () => {
    const result = compileSource(`
        interface Row { value: number }
        const rows: Row[] = [{ value: 2 }];
        let index = -1;
        const selected = index >= 0 ? rows[index]! : null;
        const nested = selected ? rows[selected.value]! : null;
    `);

    const guardedIndex = result.cpp.indexOf("= v_selected->value;");
    assert.notEqual(guardedIndex, -1);
    const branch = result.cpp.lastIndexOf(
        "if (v_bblite_element_found_",
        guardedIndex,
    );
    assert.notEqual(branch, -1);
    assert.ok(branch < guardedIndex);
    assert.equal(
        result.cpp.match(/= v_selected->value;/g)?.length,
        1,
    );
});

test("emits an unrolled body flat, so what it declares outlives the loop", () => {
    // Unrolling a loop IS writing its statements out. A C++ block would make
    // each iteration's locals invisible to everything after it, and a scene
    // that collects what its body creates names exactly those locals.
    const result = compileSource(`
        const rows: [number, number][] = [[1, 2], [3, 4]];
        let total = 0;
        for (let i = 0; i < rows.length; i++) {
            const scaled = rows[i]![0] * 2;
            total += scaled;
        }
    `);

    assert.doesNotMatch(result.cpp, /^ *\{$/m);
});

test("keeps the run-time length where the container is resized", () => {
    // The fold is allowed only while nothing can change the count. One
    // `push` anywhere in the entry source withdraws it, whether it runs
    // before the loop or after.
    const result = compileSource(`
        const rows: [number, number][] = [[1, 2], [3, 4], [5, 6]];
        let total = 0;
        for (let i = 0; i < rows.length; i++) {
            total += rows[i]![0];
        }
        rows.push([7, 8]);
    `);

    assert.match(result.cpp, /for \(; v_block\d+_i < bbl::js::array_length/);
});

test("withdraws the length fold from a container handed to a call", () => {
    // The case a downstream invalidation hook cannot catch. Every reached
    // function inlines, and a container parameter binds BY REFERENCE, so the
    // callee's `list.push` grows the caller's array while being spelled
    // against a name the scan never sees. Handing the name to any call is
    // what gives up the fold.
    const result = compileSource(`
        function grow(list: number[]): void {
            list.push(9);
        }
        const offsets: number[] = [1, 2, 3];
        grow(offsets);
        let total = 0;
        for (let i = 0; i < offsets.length; i++) {
            total += offsets[i]!;
        }
    `);

    assert.match(result.cpp, /for \(; v_block\d+_i < bbl::js::array_length/);
    assert.match(
        result.cpp,
        /void grow\(bbl::js::Array<double>& v_fn\d+_list\)/,
    );
});

test("a list a loop grows decides its shape at the first push", () => {
    // The shape a scene writes to build a ribbon's paths: an empty
    // annotated list, grown per iteration. The list has no element to take
    // its kind from until the first push, and the loop unrolls, so the
    // whole thing is complete at generation.
    const result = compileSource(`
        const rows: { x: number; y: number; z: number }[][] = [];
        for (let p = 0; p < 2; p++) {
            const row: { x: number; y: number; z: number }[] = [];
            for (let i = 0; i < 2; i++) {
                row.push({ x: i, y: p, z: 0 });
            }
            rows.push(row);
        }
    `);

    assert.doesNotMatch(result.cpp, /for \(/);
    assert.equal(
        result.cpp.match(
            /push_back\(std::make_shared<bblscene::Record\d+Data>/g,
        )?.length,
        4,
    );
});

test("keeps an inferred static handle list available to render composition", () => {
    const result = compileSource(`
        import {
            addToScene,
            createBox,
            createDirectionalLight,
            createEngine,
            createPcfDirectionalShadowGenerator,
            createSceneContext,
            createSphere,
            setShadowTaskCasterMeshes,
        } from "babylon-lite";

        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            const light = createDirectionalLight([-1, -2, -1], 1);
            addToScene(scene, light);
            const sphere = createSphere(engine, { diameter: 1 });
            addToScene(scene, sphere);
            const casters = [sphere];
            for (let i = 0; i < 2; i++) {
                const box = createBox(engine, 1);
                addToScene(scene, box);
                casters.push(box);
            }
            const shadow = createPcfDirectionalShadowGenerator(
                engine,
                light,
            );
            setShadowTaskCasterMeshes(shadow, casters);
        }

        void main();
    `);

    assert.equal(
        result.manifest.shadowGenerators[0]?.casters.length,
        3,
    );
    assert.doesNotMatch(result.cpp, /Array<bbl::MeshHandle> v_casters/);
});

test("records the camera-fitted single-map adaptation for CSM shadows", () => {
    const result = compileSource(`
        import {
            addToScene,
            createCsmDirectionalShadowGenerator,
            createDirectionalLight,
            createEngine,
            createSceneContext,
        } from "babylon-lite";

        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            const light = createDirectionalLight([-1, -2, -1], 1);
            addToScene(scene, light);
            createCsmDirectionalShadowGenerator(engine, light, {
                mapSize: 2048,
                numCascades: 4,
                lambda: 0.6,
                bias: 0.00008,
                darkness: 0.2,
            });
        }

        void main();
    `);

    assert.ok(result.manifest.features.includes("shadow:csm-single-map"));
    assert.ok(!result.manifest.features.includes("shadow:pcf-directional"));
    assert.match(result.cpp, /create_csm_directional_shadow_generator/);
    assert.match(result.cpp, /CsmDirectionalShadowOptions\{/);
    assert.ok(
        result.manifest.adaptations.some(
            ({ id }) => id === "csm-single-map-near-cascade",
        ),
    );
});

test("updates a shadow task from a runtime subset of its composed casters", () => {
    const result = compileSource(`
        import {
            addToScene,
            createBox,
            createDirectionalLight,
            createEngine,
            createPcfDirectionalShadowGenerator,
            createSceneContext,
            onBeforeRender,
            setShadowTaskCasterMeshes,
            type Mesh,
        } from "babylon-lite";

        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            const light = createDirectionalLight([-1, -2, -1], 1);
            const mesh = createBox(engine, 1);
            addToScene(scene, light);
            addToScene(scene, mesh);
            const shadow = createPcfDirectionalShadowGenerator(engine, light);
            setShadowTaskCasterMeshes(shadow, [mesh]);
            let include = true;
            onBeforeRender(scene, () => {
                const next: Mesh[] = [];
                if (include) next.push(mesh);
                setShadowTaskCasterMeshes(shadow, next);
                include = !include;
            });
        }
        void main();
    `);

    assert.equal(result.manifest.shadowGenerators[0]?.casters.length, 1);
    assert.match(result.cpp, /array_to_vector\(v_next\)/);
});

test("compares handles read from runtime arrays by object identity", () => {
    const result = compileSource(`
        import { createBox, createEngine, type Mesh } from "babylon-lite";
        async function main() {
            const engine = await createEngine({});
            const mesh = createBox(engine, 1);
            const meshes: Mesh[] = [mesh];
            const same = meshes.some((entry, index) => entry !== meshes[index]);
            if (same) mesh.position.y = 1;
        }
        void main();
    `);

    assert.match(result.cpp, /\.value != .*\.value/);
});

test("rebinds JavaScript arrays through their shared native identity", () => {
    const result = compileSource(`
        let current: number[] = [1];
        const alias = current;
        const next: number[] = [2];
        current = next;
        alias.push(3);
    `);

    assert.match(result.cpp, /v_current = v_next;/);
    assert.match(result.cpp, /v_alias\.push_back\(3\.0\)/);
});

test("asks the pin's cone-tip question of the option the scene named", () => {
    // `createCylinderData` clamps a zero diameter for its ring maths and
    // asks `options.diameterTop === 0` separately, of the NAMED option. So
    // a zero reaching it through the `diameter` shorthand answers NO, a
    // named zero answers YES, and neither answer needs the value to be a
    // compile-time constant.
    const shorthand = compileSource(`
        import { createCylinder, createEngine } from "babylon-lite";
        async function main() {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            createCylinder(engine, { height: 2, diameter: 1 - 1 });
        }
        void main();
    `);
    assert.match(shorthand.cpp, /, false\}\)/);

    const named = compileSource(`
        import { createCylinder, createEngine } from "babylon-lite";
        async function main() {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            createCylinder(engine, { height: 2, diameterTop: 0, diameterBottom: 1 });
        }
        void main();
    `);
    assert.match(named.cpp, /\(0\.0 == 0\.0\)\}\)/);
});

test("iterates runtime data arrays with range-for", () => {
    const result = compileSource(`
        function values(): number[] {
            return [1, 2, 3];
        }
        let total = 0;
        for (const value of values()) {
            total += value;
        }
    `);

    assert.match(
        result.cpp,
        /for \(auto&& v_bblite_item_\d+ : bblscene::values\(\)\) \{/,
    );
    assert.match(
        result.cpp,
        /v_total \+= v_bblite_item_\d+;/,
    );
});

test("iterates strings through their JavaScript characters", () => {
    const result = compileSource(`
        for (const item of "abc") {
            const value = item;
        }
    `);
    assert.match(
        result.cpp,
        /for \(auto&& v_bblite_item_\d+ : bbl::js::string_characters\("abc"\)\)/,
    );
});

test("reports unsupported syntax in imported functions", () => {
    assert.throws(
        () =>
            compileSource(
                `
                    import {
                        createEngine,
                    } from "@babylonjs/lite";
                    import {
                        unsupportedLoop,
                    } from "./fixtures/compiler-modules/bad-helper.js";

                    async function main() {
                        const engine = await createEngine({});
                        unsupportedLoop(engine);
                    }
                `,
                {
                    fileName:
                        "test/compiler-multi-file-entry.ts",
                },
            ),
        /test[\\/]fixtures[\\/]compiler-modules[\\/]bad-helper\.ts:\d+:\d+: Unsupported statement:/,
    );
});

test("lowers do-while loops with post-tested conditions", () => {
    const result = compileSource(`
        let value = 0;
        do {
            value++;
        } while (value < 3);
    `);
    assert.match(
        result.cpp,
        /do \{[\s\S]*v_value\+\+;[\s\S]*\} while \(v_value < 3\.0\);/,
    );
});

test("lowers recursive plain-data functions natively", () => {
    const result = compileSource(`
        function recurse(value: number): number {
            if (value <= 0) return 0;
            return recurse(value - 1);
        }
        const value = recurse(1);
    `);
    assert.match(
        result.cpp,
        /double recurse\(double v_\w*value\);/,
    );
    assert.match(
        result.cpp,
        /return bblscene::recurse\(\(v_\w*value - 1\.0\)\);/,
    );
});

test("retains recursive timer callbacks after their source scope returns", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        function startCountdown(): void {
            let count = 0;
            const tick = (): void => {
                count++;
                if (count < 4) setTimeout(tick, 700);
            };
            tick();
        }

        async function main(): Promise<void> {
            const engine = await createEngine({});
            startCountdown();
        }
        main();
    `);
    assert.match(
        result.cpp,
        /std::make_shared<std::function<void\(\)>>\(\)/,
    );
    assert.match(
        result.cpp,
        /v_engine\.native_callback_owners\.push_back\(/,
    );
    assert.match(
        result.cpp,
        /auto& bbl_recursive_\w+ = \*bbl_recursive_\w+_owner;/,
    );
});

test("keeps synchronous recursive callbacks local to native data functions", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        function triangular(limit: number): number {
            let total = 0;
            const visit = (value: number): void => {
                if (value <= 0) return;
                total += value;
                visit(value - 1);
            };
            visit(limit);
            return total;
        }

        async function main(): Promise<void> {
            const engine = await createEngine({});
            const total = triangular(3);
        }
        main();
    `);

    const definition = result.cpp.match(
        /double triangular\([^]*?\n\}/,
    )?.[0];
    assert.ok(definition);
    assert.match(
        definition,
        /std::function<void\(double\)> v_fn\d+_visit/,
    );
    assert.doesNotMatch(definition, /native_callback_owners|v_engine/);
});

test("snapshots scalar members of records retained by classes", () => {
    const result = compileSource(`
        import { createBox, createEngine, type Mesh } from "@babylonjs/lite";

        interface Vehicle { body: Mesh; element: HTMLElement; bodyRestY: number }
        function makeVehicle(body: Mesh): Vehicle {
            return {
                body,
                element: document.createElement("div"),
                bodyRestY: body.position.y,
            };
        }
        class Controller {
            private readonly vehicle: Vehicle;
            constructor(vehicle: Vehicle) { this.vehicle = vehicle; }
            value(): number { return this.vehicle.bodyRestY; }
        }

        async function main(): Promise<void> {
            const engine = await createEngine({});
            const body = createBox(engine, 1);
            const vehicle = makeVehicle(body);
            const controller = new Controller(vehicle);
            body.position.y = 10;
            body.position.y = controller.value();
        }
        main();
    `);
    assert.match(
        result.cpp,
        /double v_\w*return_makeVehicle_bodyRestY_\d+ = v_engine\.meshes\[v_\w*body\.value\]\.position\.y;/,
    );
    assert.equal(
        (result.cpp.match(/return_makeVehicle_bodyRestY/g) ?? []).length,
        2,
    );
});

test("reads mutated flat-entry variables from live generated state", () => {
    const body = `
        const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
        const engine = await createEngine(canvas);
        const scene = createSceneContext(engine);
        const box = createBox(engine, 1);
        let counter = 0;
        counter++;
        counter++;
        box.position.x = counter;
    `;
    const imports = `
        import {
            createBox,
            createEngine,
            createSceneContext,
        } from "@babylonjs/lite";
    `;
    const flat = compileSource(`${imports}${body}`);
    const main = compileSource(`
        ${imports}
        async function main(): Promise<void> {
            ${body}
        }
    `);

    for (const result of [flat, main]) {
        assert.match(
            result.cpp,
            /double v_counter = 0\.0;\s+v_counter\+\+;\s+v_counter\+\+;/s,
        );
        assert.match(
            result.cpp,
            /\.position\.x = v_counter;/,
        );
        assert.doesNotMatch(result.cpp, /\.position\.x = 0\.0;/);
    }
});

test("compiles the flat-entry compiler state regression scene", () => {
    const sourcePath = "examples/regression-compiler-state.ts";
    const result = compileSource(
        readFileSync(resolve(sourcePath), "utf8"),
        { fileName: sourcePath },
    );

    assert.match(result.cpp, /double v_offset = 0\.0/);
    assert.match(result.cpp, /v_offset\+\+/);
    assert.match(
        result.cpp,
        /\.position\.x = v_offset/,
    );
    assert.match(result.cpp, /\.rotation\.y \+= 0\.3f/);
    // Transform writes mark the mesh dirty so the backends re-upload
    // its baked vertices, exactly like the property-animation
    // evaluator's bump.
    assert.match(
        result.cpp,
        /\+\+v_engine\.meshes\[[^\]]+\]\.transform_version;/,
    );
    assert.ok(
        !result.manifest.adaptations.some(
            ({ id }) => id === "entry-main-wrapper-erasure",
        ),
    );
});

test("retains module-level let constants for main entries", () => {
    const result = compileSource(`
        import {
            createArcRotateCamera,
            createEngine,
            createSceneContext,
        } from "@babylonjs/lite";
        let radius = 3;
        async function main(): Promise<void> {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            const scene = createSceneContext(engine);
            const camera = createArcRotateCamera(
                0,
                1,
                radius,
                { x: 0, y: 0, z: 0 },
            );
            scene.camera = camera;
        }
    `);

    assert.match(
        result.cpp,
        /create_arc_rotate_camera\(v_engine, 0\.0, 1\.0, 3\.0/,
    );
});

test("binds inline engine creation exactly once", () => {
    const result = compileSource(`
        import {
            createDefaultCamera,
            createEngine,
            createSceneContext,
        } from "@babylonjs/lite";
        async function main(): Promise<void> {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const scene = createSceneContext(await createEngine(canvas));
            const camera = createDefaultCamera(scene);
            scene.camera = camera;
            camera.alpha = 1;
        }
    `);

    assert.equal(
        result.cpp.match(/bbl::create_engine/g)?.length,
        1,
    );
    assert.match(
        result.cpp,
        /auto (v_bblite_inline_engine_\d+) = bbl::create_engine/,
    );
    const engine = result.cpp.match(
        /auto (v_bblite_inline_engine_\d+) = bbl::create_engine/,
    )?.[1];
    assert.ok(engine);
    assert.match(
        result.cpp,
        new RegExp(`create_scene_context\\(${engine}\\)`),
    );
    assert.match(
        result.cpp,
        new RegExp(`create_default_camera\\(${engine}, v_scene\\)`),
    );
    assert.match(
        result.cpp,
        new RegExp(`${engine}\\.cameras\\[v_camera\\.value\\]\\.alpha = 1\\.0;`),
    );
});

test("rejects every second named or inline engine", () => {
    for (const declarations of [
        `
            const first = await createEngine(canvas);
            const second = await createEngine(canvas);
        `,
        `
            const scene = createSceneContext(await createEngine(canvas));
            const second = await createEngine(canvas);
        `,
        `
            const first = await createEngine(canvas);
            const scene = createSceneContext(await createEngine(canvas));
        `,
    ]) {
        assert.throws(
            () =>
                compileSource(`
                    import {
                        createEngine,
                        createSceneContext,
                    } from "@babylonjs/lite";
                    async function main(): Promise<void> {
                        const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
                        ${declarations}
                    }
                `),
            (error: unknown) => {
                assert.ok(error instanceof CompileError);
                assert.match(
                    error.message,
                    /supports one engine per entry point/,
                );
                return true;
            },
        );
    }
});

test("preserves compound assignments for numeric properties", () => {
    const result = compileSource(`
        import {
            createArcRotateCamera,
            createBox,
            createEngine,
            createSceneContext,
            createStandardMaterial,
            onBeforeRender,
        } from "@babylonjs/lite";
        async function main(): Promise<void> {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            const scene = createSceneContext(engine);
            const camera = createArcRotateCamera(0, 1, 2, { x: 0, y: 0, z: 0 });
            scene.camera = camera;
            const box = createBox(engine, 1);
            const material = createStandardMaterial();
            box.material = material;
            scene.fixedDeltaMs += 1;
            scene.imageProcessing.exposure -= 0.1;
            scene.imageProcessing.contrast += 0.2;
            scene.camera.alpha += 0.3;
            camera.beta -= 0.4;
            material.alpha += 0.1;
            material.specularPower -= 1;
            onBeforeRender(scene, () => {
                box.position.x -= 0.02;
                box.rotation.y += 0.01;
                box.scaling.z += 0.03;
            });
        }
    `);

    assert.match(result.cpp, /\.fixed_delta_ms \+= 1\.0f/);
    assert.match(result.cpp, /\.environment\.exposure -= 0\.1f/);
    assert.match(result.cpp, /\.environment\.contrast \+= 0\.2f/);
    assert.match(result.cpp, /\.camera\.value\]\.alpha \+= 0\.3;/);
    assert.match(result.cpp, /\.cameras\[v_camera\.value\]\.beta -= 0\.4;/);
    assert.match(result.cpp, /\.alpha \+= 0\.1f/);
    assert.match(result.cpp, /\.specular_power -= 1\.0f/);
    assert.match(result.cpp, /\.position\.x -= 0\.02/);
    assert.match(result.cpp, /\.rotation\.y \+= 0\.01f/);
    assert.match(result.cpp, /\.scaling\.z \+= 0\.03f/);
});

test("records awaits lowered by static expression evaluation", () => {
    const result = compileSource(`
        import {
            addToScene,
            createEngine,
            createPointLight,
            createSceneContext,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            const light = createPointLight([0, 1, 0]);
            light.intensity = await 2;
            addToScene(scene, light);
        }
    `);

    assert.ok(
        result.manifest.adaptations.some(
            ({ id }) => id === "synchronous-aot-await",
        ),
    );
});

test("captures function-local const values once", () => {
    const result = compileSource(`
        import {
            createArcRotateCamera,
            createBox,
            createEngine,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const camera = createArcRotateCamera(
                0,
                1,
                5,
                [0, 0, 0],
            );
            camera.radius = 5;
            const captured = camera.radius;
            camera.radius = 9;
            const box = createBox(engine, captured);
        }
    `);

    assert.match(
        result.cpp,
        /double v_captured = v_engine\.cameras\[v_camera\.value\]\.radius/,
    );
    assert.match(
        result.cpp,
        /BoxOptions\{static_cast<float>\(v_captured\), static_cast<float>\(v_captured\), static_cast<float>\(v_captured\)\}/,
    );
});

test("does not collapse conditional values to the true branch", () => {
    const result = compileSource(`
        function choose(flag: boolean): number {
            const value = flag ? 0.6 : 0.4;
            return value;
        }
        const selected = choose(false);
    `);

    assert.match(
        result.cpp,
        /double v_fn0_value = \(v_fn0_flag \? 0\.6 : 0\.4\);/,
    );
    assert.doesNotMatch(
        result.cpp,
        /double v_fn0_value = 0\.6;/,
    );
});

test("folds browser query conditions for the native default environment", () => {
    const result = compileSource(`
        import {
            createBox,
            createEngine,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const box = createBox(engine);
            const params = new URLSearchParams(window.location.search);
            const seek = parseFloat(params.get("seekTime") || "");
            if (isNaN(seek)) {
                box.position.x = 3;
            }
        }
    `);

    assert.match(
        result.cpp,
        /\.position\.x = 3\.0/,
    );
});

test("folds browser query predicates inside a runtime condition", () => {
    const source = `
        import {
            createBox,
            createEngine,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const box = createBox(engine);
            const params = new URLSearchParams(window.location.search);
            const seek = parseFloat(params.get("seekTime") || "");
            let frameCount = 0;
            if (!isNaN(seek) && seek > 0 && frameCount === 10) {
                box.position.x = 3;
            }
        }
    `;

    assert.doesNotMatch(compileSource(source).cpp, /\.position\.x = 3\.0/);
    const queried = compileSource(source, { search: "?seekTime=0.5" });
    assert.match(queried.cpp, /if \(v_frameCount == 10\.0\)/);
    assert.match(queried.cpp, /\.position\.x = 3\.0/);
});

test("keeps a resolved browser number in a native counted loop", () => {
    const result = compileSource(
        `
            const params = new URLSearchParams(window.location.search);
            const count = parseFloat(params.get("count") || "");
            let total = 0;
            for (let i = 0; i < count; i++) {
                total += i;
            }
        `,
        { search: "?count=40" },
    );

    assert.match(result.cpp, /for \(; v_block\d+_i < 40\.0;/);
    assert.doesNotMatch(result.cpp, /Browser-dependent condition/);
});

test("does not lower an unreachable logical right operand", () => {
    assert.doesNotThrow(() =>
        compileSource(`
            if (false && document.getElementById("definitelyMissing")) {
                throw new Error("unreachable");
            }
            if (true || document.getElementById("definitelyMissing")) {
                const reached = 1;
            }
        `),
    );
});

test("folds the browser canvas guard around a void-wrapped auto-run", () => {
    const result = compileSource(`
        import {
            createBox,
            createEngine,
        } from "@babylonjs/lite";

        async function scene(canvas: HTMLCanvasElement) {
            const engine = await createEngine(canvas);
            createBox(engine);
        }

        const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
        if (canvas) {
            void scene(canvas);
        }
    `);

    assert.match(result.cpp, /bbl::create_box/);
    assert.doesNotMatch(result.cpp, /document|getElementById/);

    assert.throws(
        () =>
            compileSource(`
                if (document.getElementById("definitelyMissing")) {
                    console.log("unreachable");
                }
            `),
        /Browser-dependent condition cannot be determined/,
    );

    assert.throws(
        () => compileSource(`void 1;`),
        /Unsupported expression statement/,
    );
});

test("erases optional DOM-local writes without dropping adjacent native state", () => {
    const result = compileSource(`
        let enabled = false;
        const button = document.getElementById("toggle") as HTMLButtonElement | null;
        function setEnabled(on: boolean): void {
            enabled = on;
            if (button) {
                button.textContent = on ? "enabled" : "disabled";
                button.setAttribute("aria-pressed", String(on));
            }
        }
        setEnabled(true);
    `);

    assert.match(result.cpp, /v_enabled = v_fn\d+_on;/);
    assert.doesNotMatch(
        result.cpp,
        /button|textContent|setAttribute|aria-pressed/,
    );
});

test("erases event callbacks owned by an optional DOM local", () => {
    const result = compileSource(`
        let enabled = true;
        const button = document.getElementById("toggle") as HTMLButtonElement | null;
        if (button) {
            button.addEventListener("click", () => {
                enabled = !enabled;
                button.textContent = enabled ? "enabled" : "disabled";
            });
        }
        if (enabled) {
            const reached = 1;
        }
    `);

    assert.match(result.cpp, /bool v_enabled = true;/);
    assert.doesNotMatch(
        result.cpp,
        /button|addEventListener|textContent/,
    );
});

test("uses JavaScript truthiness for browser query values in conditions", () => {
    const source = `
        import {
            createBox,
            createEngine,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const params = new URLSearchParams(window.location.search);
            if (params.get("enabled")) {
                createBox(engine);
            }
        }
    `;

    assert.doesNotMatch(compileSource(source).cpp, /bbl::create_box/);
    assert.match(
        compileSource(source, { search: "?enabled=yes" }).cpp,
        /bbl::create_box/,
    );
});

test("preserves falsy browser values selected by logical and", () => {
    const result = compileSource(
        `
            import {
                createBox,
                createEngine,
            } from "@babylonjs/lite";

            async function main() {
                const engine = await createEngine({});
                const box = createBox(engine);
                const params = new URLSearchParams(window.location.search);
                const missing = params.get("missing") && true;
                const empty = params.get("empty") && true;
                const zero = parseFloat(params.get("zero") || "") && true;
                box.position.x = missing === null ? 1 : 2;
                box.position.y = empty === "" ? 3 : 4;
                box.position.z = zero === 0 ? 5 : 6;
            }
        `,
        { search: "?empty=&zero=0" },
    );

    assert.match(result.cpp, /\.position\.x = 1\.0;/);
    assert.match(result.cpp, /\.position\.y = 3\.0;/);
    assert.match(result.cpp, /\.position\.z = 5\.0;/);
});

test("folds browser numeric predicates in conditional values", () => {
    const source = `
        import {
            createBox,
            createEngine,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const box = createBox(engine);
            const params = new URLSearchParams(window.location.search);
            const seek = parseFloat(params.get("seekTime") || "");
            box.position.x = Number.isFinite(seek) ? seek : 3;
            box.position.y = isNaN(seek) ? 4 : seek;
            const seekFrame = seek * 60;
            box.position.z = seekFrame;
        }
    `;
    const result = compileSource(source);

    assert.match(result.cpp, /\.position\.x = 3\.0/);
    assert.match(result.cpp, /\.position\.y = 4\.0/);
    assert.doesNotMatch(result.cpp, /Number\.isFinite|isNaN|\? 0\.0/);

    const queried = compileSource(source, {
        search: "?seekTime=1.5",
    });
    assert.match(queried.cpp, /\.position\.x = 1\.5/);
    assert.match(queried.cpp, /\.position\.y = 1\.5/);
    assert.match(queried.cpp, /\.position\.z = 90\.0/);
});

test("compiles a Math transform over a query the reference pins", () => {
    // A physics scene reads the step its capture is pinned at as
    // `Math.round(frame)` over `Number(params.get(...))`. The browser-only
    // taint runs through Math so an UNRESOLVED diagnostic still erases with
    // its source; a resolved one has to keep compiling, or the query the
    // reference already answered is refused instead.
    const source = `
        import {
            createBox,
            createEngine,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const box = createBox(engine);
            const params = new URLSearchParams(window.location.search);
            const raw = params.get("captureFrame");
            if (raw !== null) {
                const frame = Number(raw);
                box.position.x = Number.isFinite(frame)
                    ? Math.round(frame)
                    : 0;
            }
        }
    `;
    const queried = compileSource(source, {
        search: "?captureFrame=120.4",
    });
    assert.match(queried.cpp, /\.position\.x = bbl::js::round_js\(120\.4\)/);
});

test("erases a Math transform over an unresolved browser value", () => {
    // The other half of the same rule: nothing answers `devicePixelRatio` at
    // generation, so the whole diagnostic erases with its browser source
    // rather than compiling a call over a value this port does not carry.
    const result = compileSource(`
        import {
            createBox,
            createEngine,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const box = createBox(engine);
            console.log(Math.round(window.devicePixelRatio));
            box.position.x = 2;
        }
    `);
    assert.doesNotMatch(result.cpp, /round_js|devicePixelRatio/);
    assert.match(result.cpp, /\.position\.x = 2\.0/);
});

test("does not fold shadowed browser predicate names", () => {
    const result = compileSource(`
        import {
            createBox,
            createEngine,
        } from "@babylonjs/lite";

        const isNaN = (_value: number): boolean => false;

        async function main() {
            const engine = await createEngine({});
            const box = createBox(engine);
            const params = new URLSearchParams(window.location.search);
            const seek = parseFloat(params.get("seekTime") || "");
            box.position.x = isNaN(seek) ? 4 : 5;
        }
    `);

    assert.match(result.cpp, /\.position\.x = 5\.0/);
});

test("does not browser-fold ordinary parseFloat calls", () => {
    assert.throws(
        () =>
            compileSource(`
                import {
                    createBox,
                    createEngine,
                } from "@babylonjs/lite";

                async function main() {
                    const engine = await createEngine({});
                    const box = createBox(engine);
                    const numeric = 1.5;
                    box.position.x = parseFloat(numeric as any);
                }
            `),
        /Call 'parseFloat' does not resolve/,
    );
});

test("materializes direct browser primitive call arms", () => {
    const result = compileSource(`
        import {
            createEngine,
            loadGltf,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const params = new URLSearchParams(window.location.search);
            const selected = params.has("value")
                ? params.get("value")!
                : "fallback.glb";
            await loadGltf(engine, selected);
        }
    `, { search: "?value=chosen.glb" });

    assert.equal(result.manifest.assets[0]?.source, "chosen.glb");
});

const containerFlattenWalk = `
        function collectMeshes(container: AssetContainer): Mesh[] {
            const out: Mesh[] = [];
            const stack: unknown[] = [...container.entities];
            while (stack.length > 0) {
                const node = stack.pop() as { _gpu?: unknown; material?: unknown; children?: unknown[] } | undefined;
                if (!node) {
                    continue;
                }
                if ("_gpu" in node && "material" in node) {
                    out.push(node as unknown as Mesh);
                }
                if (node.children?.length) {
                    stack.push(...node.children);
                }
            }
            return out;
        }
`;

test("lowers a proven container flatten to the loader's own mesh list", () => {
    const result = compileSource(`
        import {
            createEngine,
            loadGltf,
            setPbrUnlit,
        } from "@babylonjs/lite";
        import type { AssetContainer, Mesh, PbrMaterialProps } from "@babylonjs/lite";
${containerFlattenWalk}
        async function main() {
            const engine = await createEngine({});
            const asset = await loadGltf(engine, "model.glb");
            for (const mesh of collectMeshes(asset)) {
                setPbrUnlit(mesh.material as PbrMaterialProps, [0.5, 0.5, 0.5]);
            }
        }
    `);

    // The walk is answered by the asset's flattened meshes, so nothing in
    // the emitted body walks an entity tree the loader resolved away.
    assert.match(result.cpp, /for \(const bbl::MeshHandle [\w]+ : [\w.]*assets\[[^\]]*\]\.meshes\)/);
    assert.match(result.cpp, /set_pbr_unlit\(.*bbl::Color3\{0\.5f, 0\.5f, 0\.5f\}\)/);
});

test("refuses a container flatten whose renderable test is not the walk's", () => {
    // The same walk with `"_gpu" in node` alone: it would also collect a
    // node the loader made no mesh record for, so the proof must not accept
    // it and the body refuses where it reads the entity tree.
    assert.throws(
        () =>
            compileSource(`
                import { createEngine, loadGltf } from "@babylonjs/lite";
                import type { AssetContainer, Mesh } from "@babylonjs/lite";

                function collectMeshes(container: AssetContainer): Mesh[] {
                    const out: Mesh[] = [];
                    const stack: unknown[] = [...container.entities];
                    while (stack.length > 0) {
                        const node = stack.pop() as { _gpu?: unknown; children?: unknown[] } | undefined;
                        if (!node) {
                            continue;
                        }
                        if ("_gpu" in node) {
                            out.push(node as unknown as Mesh);
                        }
                        if (node.children?.length) {
                            stack.push(...node.children);
                        }
                    }
                    return out;
                }

                async function main() {
                    const engine = await createEngine({});
                    const asset = await loadGltf(engine, "model.glb");
                    for (const mesh of collectMeshes(asset)) {
                        keep(mesh);
                    }
                }

                function keep(_mesh: Mesh): void {}
            `),
        /container\.entities/,
    );
});

test("licenses the container-wide unlit stamp only from the proven walk", () => {
    // `getContainerMeshes` yields the same handles, but a bound result is
    // just a collection: nothing says the loop that follows reaches all of
    // it, and the unlit arm composes per document.
    assert.throws(
        () =>
            compileSource(`
                import {
                    createEngine,
                    getContainerMeshes,
                    loadGltf,
                    setPbrUnlit,
                } from "@babylonjs/lite";
                import type { PbrMaterialProps } from "@babylonjs/lite";

                async function main() {
                    const engine = await createEngine({});
                    const asset = await loadGltf(engine, "model.glb");
                    const meshes = getContainerMeshes(asset);
                    for (const mesh of meshes) {
                        setPbrUnlit(mesh.material as PbrMaterialProps);
                    }
                }
            `),
        /setPbrUnlit names no scene-code PBR material/,
    );
});

test("refuses a container-wide unlit stamp on a twice-loaded asset", () => {
    // Both containers share one asset record, and the unlit arm is composed
    // from the document, so stamping the first would compose the second
    // unlit as well.
    assert.throws(
        () =>
            compileSource(`
                import {
                    createEngine,
                    loadGltf,
                    setPbrUnlit,
                } from "@babylonjs/lite";
                import type { AssetContainer, Mesh, PbrMaterialProps } from "@babylonjs/lite";
${containerFlattenWalk}
                async function main() {
                    const engine = await createEngine({});
                    const left = await loadGltf(engine, "model.glb");
                    const right = await loadGltf(engine, "model.glb");
                    keep(right);
                    for (const mesh of collectMeshes(left)) {
                        setPbrUnlit(mesh.material as PbrMaterialProps, [0.5, 0.5, 0.5]);
                    }
                }

                function keep(_container: AssetContainer): void {}
            `),
        /is loaded more than once/,
    );
});

test("exposes only the pinned glTF container root entity", () => {
    const result = compileSource(`
        import {
            createEngine,
            loadGltf,
        } from "@babylonjs/lite";

        function keepRoot(_root: unknown): void {}

        async function main() {
            const engine = await createEngine({});
            const container = await loadGltf(engine, "model.glb");
            const root = container.entities[0];
            keepRoot(root);
        }
    `);

    assert.equal(result.manifest.assets[0]?.kind, "gltf");

    assert.throws(
        () =>
            compileSource(`
                import { createArcRotateCamera, createEngine, loadGltf } from "@babylonjs/lite";

                function keepRoot(_root: unknown): void {}

                async function main() {
                    const engine = await createEngine({});
                    const container = await loadGltf(engine, "model.glb");
                    const camera = createArcRotateCamera(0, 1, 10, { x: 0, y: 0, z: 0 });
                    keepRoot(container.entities[camera.alpha]);
                }
            `),
        /entities are indexed only at static index 0/,
    );

    assert.throws(
        () =>
            compileSource(`
                import { createEngine, loadGltf } from "@babylonjs/lite";

                function keepRoot(_root: unknown): void {}

                async function main() {
                    const engine = await createEngine({});
                    const container = await loadGltf(engine, "model.glb");
                    keepRoot(container.entities[1]);
                }
            `),
        /entities are indexed only at static index 0/,
    );

    assert.throws(
        () =>
            compileSource(`
                import { createEngine, loadBabylon } from "@babylonjs/lite";

                function keepRoot(_root: unknown): void {}

                async function main() {
                    const engine = await createEngine({});
                    const container = await loadBabylon(engine, "scene.babylon", {
                        loadCamera: false,
                        loadTextures: false,
                    });
                    keepRoot(container.entities[0]);
                }
            `),
        /Indexing entities is lowered for a glTF container/,
    );

    assert.throws(
        () =>
            compileSource(`
                import {
                    addToScene,
                    createEngine,
                    createSceneContext,
                    loadGltf,
                } from "@babylonjs/lite";

                async function main() {
                    const engine = await createEngine({});
                    const scene = createSceneContext(engine);
                    const container = await loadGltf(engine, "model.glb");
                    addToScene(scene, container.entities[0]);
                }
            `),
        /received asset-root/,
    );
});

test("exposes getContainerMeshes through the asset's flattened mesh collection", () => {
    const result = compileSource(`
        import {
            createBox,
            createEngine,
            getContainerMeshes,
            loadGltf,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const container = await loadGltf(engine, "model.glb");
            const meshes = getContainerMeshes(container);
            const rebuilt = createBox(engine, 1);
            for (const mesh of meshes) {
                mesh.position.x = 1;
                rebuilt.material = mesh.material;
            }
        }
    `);

    assert.match(result.cpp, /engine\.assets\[v_container\.value\]\.meshes/);
    assert.match(result.cpp, /for \(const bbl::MeshHandle/);
    assert.equal(result.manifest.sceneMeshes[0]?.assetPbrMaterial, true);
});

test("lowers setParent for mesh attachment and detachment", () => {
    const result = compileSource(`
        import { createEngine, createBox, setParent } from "@babylonjs/lite";
        async function main() {
            const engine = await createEngine({});
            const parent = createBox(engine, 1);
            const child = createBox(engine, 1);
            setParent(child, parent);
            setParent(child, null);
        }
    `);

    assert.match(result.cpp, /bbl::set_mesh_parent\([^;]+v_parent\);/);
    assert.match(result.cpp, /bbl::set_mesh_parent\([^;]+bbl::MeshHandle\{\}\);/);
});

test("reads mesh.parent as the nullable handle setParent owns", () => {
    const result = compileSource(`
        import { createEngine, createSphere, setParent, type Mesh } from "@babylonjs/lite";
        async function main() {
            const engine = await createEngine({});
            const root = createSphere(engine, { diameter: 1 });
            const child = createSphere(engine, { diameter: 0.5 });
            setParent(child, root);
            let current: Mesh | null = child;
            current = current.parent;
            if (child.parent === null) child.position.y = 1;
        }
        void main();
    `);

    assert.match(result.cpp, /\.parent\.value != bbl::invalid_handle/);
    assert.match(
        result.cpp,
        /if \([^\n]*\.parent\.value != bbl::invalid_handle[^\n]*\) \{[\s\S]{0,180}v_current = [^;]*\.parent;[\s\S]{0,100}v_current\.reset\(\);/,
    );
});

test("reads the live local bounds retained with mesh geometry", () => {
    const result = compileSource(`
        import { createEngine, createSphere } from "@babylonjs/lite";
        async function main() {
            const engine = await createEngine({});
            const mesh = createSphere(engine, { diameter: 1 });
            const minimum = mesh.boundMin ?? [-0.5, -0.5, -0.5];
            const maximum = mesh.boundMax ?? [0.5, 0.5, 0.5];
            mesh.position.x = minimum[0]! + maximum[0]!;
        }
        void main();
    `);

    assert.match(result.cpp, /mesh_bound_min_array/);
    assert.match(result.cpp, /mesh_bound_max_array/);
});

test("stores mesh visibility in the live mesh record", () => {
    const result = compileSource(`
        import { createBox, createEngine } from "@babylonjs/lite";
        async function main() {
            const engine = await createEngine({});
            const anchor = createBox(engine, 0.05);
            anchor.visible = false;
        }
        void main();
    `);

    assert.match(result.cpp, /\.meshes\[v_anchor\.value\]\.visible = false;/);
    assert.ok(result.manifest.features.includes("mesh:visible"));
});

test("lowers setMeshVisible through the pinned subtree visibility helper", () => {
    const result = compileSource(`
        import { createBox, createEngine, setMeshVisible } from "@babylonjs/lite";
        async function main() {
            const engine = await createEngine({});
            const anchor = createBox(engine, 0.05);
            setMeshVisible(anchor, false);
        }
        void main();
    `);

    assert.match(result.cpp, /bbl::set_mesh_visible\([^;]*, false\)/);
    assert.ok(result.manifest.features.includes("mesh:visible"));
});

test("stores and fills a nullable mesh local", () => {
    const result = compileSource(`
        import { createEngine, createSphere, type Mesh } from "@babylonjs/lite";
        async function main() {
            const engine = await createEngine({});
            let mesh: Mesh | null = null;
            mesh = createSphere(engine, { diameter: 1 });
            if (mesh) mesh.position.y = 2;
        }
        void main();
    `);

    assert.match(result.cpp, /std::optional<bbl::MeshHandle> v_mesh;/);
    assert.match(result.cpp, /v_mesh = bbl::create_sphere/);
});

test("retains a static false through a readonly receiveShadows parameter", () => {
    const result = compileSource(`
        import { createEngine, createSphere, type Mesh } from "@babylonjs/lite";
        function configure(mesh: Mesh, receive: boolean): void {
            mesh.receiveShadows = receive;
        }
        async function main() {
            const engine = await createEngine({});
            const mesh = createSphere(engine, { diameter: 1 });
            configure(mesh, false);
        }
        void main();
    `);

    assert.doesNotMatch(result.cpp, /receives_shadows = true/);
});

test("retains both shadow receiver variants for runtime mesh parameters", () => {
    const result = compileSource(`
        import { createEngine, createSphere, type Mesh } from "@babylonjs/lite";
        function configure(meshes: Mesh[]): void {
            meshes.pop();
            for (const mesh of meshes) mesh.receiveShadows = true;
        }
        async function main() {
            const engine = await createEngine({});
            const mesh = createSphere(engine, { diameter: 1 });
            const meshes: Mesh[] = [mesh];
            configure(meshes);
        }
        void main();
    `);

    assert.equal(result.manifest.dynamicShadowReceivers, true);
    assert.match(result.cpp, /\.receives_shadows = true;/);
});

test("lowers setCameraLimits with the fields present in the pinned options record", () => {
    const result = compileSource(`
        import { createEngine, createArcRotateCamera, setCameraLimits } from "@babylonjs/lite";
        async function main() {
            const engine = await createEngine({});
            const camera = createArcRotateCamera(0, 1, 5, [0, 0, 0]);
            setCameraLimits(camera, {
                upperBetaLimit: 1.7,
                lowerRadiusLimit: 2,
                upperRadiusLimit: 20,
            });
        }
        void main();
    `);

    assert.match(
        result.cpp,
        /bbl::set_camera_limits\([^,]+, [^,]+, 56u, std::array<double, 6>\{0\.0, 0\.0, 0\.0, 1\.7, 2\.0, 20\.0\}\)/,
    );
});

test("lowers Scene 12's imported recursive mesh walk and animated root clones", () => {
    const sourcePath =
        "corpus/babylon-lite/lab/lite/src/lite/scene12.ts";
    const result = compileSource(
        readFileSync(resolve(sourcePath), "utf8"),
        {
            fileName: sourcePath,
            search: "?seekTime=0.5",
        },
    );

    assert.equal(
        result.cpp.match(
            /for \(const bbl::MeshHandle .*?\.assets\[.*?\.value\]\.meshes\)/g,
        )?.length,
        3,
    );
    assert.equal(
        result.cpp.match(/bbl::clone_asset_root\(/g)?.length,
        2,
    );
    assert.match(
        result.cpp,
        /set_asset_root_position_component\([^;]+1u, 3\.0f\)/,
    );
    assert.match(
        result.cpp,
        /set_asset_root_position_component\([^;]+1u, \(-3\.0f\)\)/,
    );
    assert.equal(
        result.cpp.match(/bbl::add_asset_entities\(/g)?.length,
        2,
    );
    assert.match(
        result.cpp,
        /bbl::go_to_frame\([^;]+30\.0f, false\)/,
    );

    assert.throws(
        () =>
            compileSource(`
                import {
                    createEngine,
                    createStandardMaterial,
                    loadGltf,
                } from "@babylonjs/lite";
                import type { TransformNode } from "@babylonjs/lite";

                function assignImmediateChildren(
                    node: TransformNode,
                    material: ReturnType<typeof createStandardMaterial>,
                ): void {
                    for (const child of node.children) {
                        (child as any).material = material;
                    }
                }

                async function main() {
                    const engine = await createEngine({});
                    const container = await loadGltf(engine, "model.glb");
                    const material = createStandardMaterial();
                    assignImmediateChildren(
                        container.entities[0] as TransformNode,
                        material,
                    );
                }
            `),
        /only for the effect-only recursive TransformNode material walk/,
    );

    assert.throws(
        () =>
            compileSource(`
                import {
                    createEngine,
                    createPbrMaterial,
                    createSolidTexture2D,
                    loadGltf,
                } from "@babylonjs/lite";
                import type { TransformNode } from "@babylonjs/lite";

                function assignMaterial(
                    node: TransformNode,
                    material: ReturnType<typeof createPbrMaterial>,
                ): void {
                    for (const assignMaterial of node.children) {
                        if ("children" in assignMaterial && "rotationQuaternion" in assignMaterial && !("_gpu" in assignMaterial)) {
                            assignMaterial(assignMaterial as TransformNode, material);
                        } else {
                            (assignMaterial as any).material = material;
                        }
                    }
                }

                async function main() {
                    const engine = await createEngine({});
                    const container = await loadGltf(engine, "model.glb");
                    const base = createSolidTexture2D(engine, 1, 1, 1);
                    const orm = createSolidTexture2D(engine, 1, 0.5, 0);
                    assignMaterial(
                        container.entities[0] as TransformNode,
                        createPbrMaterial({
                            baseColorTexture: base,
                            ormTexture: orm,
                        }),
                    );
                }
            `),
        /only for the effect-only recursive TransformNode material walk/,
    );

    assert.throws(
        () =>
            compileSource(`
                import {
                    createEngine,
                    createStandardMaterial,
                    loadGltf,
                } from "@babylonjs/lite";
                import type { TransformNode } from "@babylonjs/lite";

                function assignMaterial(
                    node: TransformNode,
                    material: ReturnType<typeof createStandardMaterial>,
                ): void {
                    for (const child of node.children) {
                        if ("children" in child && "rotationQuaternion" in child && !("_gpu" in child)) {
                            assignMaterial(child as TransformNode, material);
                        } else {
                            (child as any).material = material;
                        }
                    }
                }

                async function main() {
                    const engine = await createEngine({});
                    const container = await loadGltf(engine, "model.glb");
                    assignMaterial(
                        container.entities[0] as TransformNode,
                        createStandardMaterial(),
                    );
                }
            `),
        /currently accepts only a scene-created PBR material/,
    );

    assert.throws(
        () =>
            compileSource(`
                import {
                    createEngine,
                    createStandardMaterial,
                    loadGltf,
                } from "@babylonjs/lite";
                import type { TransformNode } from "@babylonjs/lite";

                function assignMaterial(
                    node: TransformNode,
                    material: ReturnType<typeof createStandardMaterial>,
                ): void {
                    material.alpha = 0.5;
                    for (const child of node.children) {
                        if ("children" in child && "rotationQuaternion" in child && !("_gpu" in child)) {
                            assignMaterial(child as TransformNode, material);
                        } else {
                            (child as any).material = material;
                        }
                    }
                }

                async function main() {
                    const engine = await createEngine({});
                    const container = await loadGltf(engine, "model.glb");
                    assignMaterial(
                        container.entities[0] as TransformNode,
                        createStandardMaterial(),
                    );
                }
            `),
        /only for the effect-only recursive TransformNode material walk/,
    );
});

test("records direct browser primitive materialization", () => {
    const result = compileSource(`
        import {
            createBox,
            createEngine,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const box = createBox(engine);
            box.position.x = parseFloat(
                new URLSearchParams(window.location.search).get("x") || "3"
            );
        }
    `);

    assert.match(result.cpp, /\.position\.x = 3\.0;/);
    assert.ok(
        result.manifest.adaptations.some(
            ({ id }) => id === "browser-setup-erasure",
        ),
    );
});

test("lowers platform time declarations to the native clock", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main() {
            const started = performance.now();
            await createEngine({});
        }
    `);

    assert.match(
        result.cpp,
        /bbl::pal::performance_milliseconds\(\)/,
    );
    assert.ok(
        !result.manifest.adaptations.some(
            ({ id }) => id === "browser-setup-erasure",
        ),
    );
});

test("erases browser declarations rooted at globalThis", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main() {
            const engineKB = Math.max(
                0,
                (globalThis as { engineKB?: number }).engineKB ?? 0,
            );
            const originalFetch = globalThis.fetch.bind(globalThis);
            globalThis.fetch = originalFetch;
            await createEngine({});
        }
    `);

    assert.doesNotMatch(result.cpp, /globalThis|engineKB|originalFetch/);
    assert.ok(
        result.manifest.adaptations.some(
            ({ id }) => id === "browser-setup-erasure",
        ),
    );
});

test("preserves argument calls when erasing a browser-only call", () => {
    const result = compileSource(`
        import { createBox, createEngine } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            let state = 0;
            function advance(): number {
                state++;
                return state;
            }
            console.log("state", advance());
            const box = createBox(engine);
            box.position.x = state;
        }
    `);

    assert.match(result.cpp, /v_state\+\+;/);
    assert.match(result.cpp, /\.position\.x = v_state;/);
    assert.doesNotMatch(result.cpp, /console/);
});

test("lowers boolean negation in value position", () => {
    const result = compileSource(`
        import { createBox, createEngine } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            let muted = false;
            function setMuted(value: boolean): void {
                muted = value;
            }
            setMuted(!muted);
            if (muted) {
                createBox(engine);
            }
        }
    `);

    assert.match(result.cpp, /bool v_fn\d+_value = !\(v_muted\);/);
    assert.match(result.cpp, /v_muted = v_fn\d+_value;/);
    assert.match(result.cpp, /if \(v_muted\)/);
});

test("swaps mutable numeric locals through destructuring", () => {
    const result = compileSource(`
        let left = 1;
        let right = 2;
        [left, right] = [right, left];
    `);

    assert.equal((result.cpp.match(/const double .*swap/g) ?? []).length, 2);
    assert.match(result.cpp, /v_left = .*swap/);
    assert.match(result.cpp, /v_right = .*swap/);
});

test("folds static n-ary Math extrema before browser short circuiting", () => {
    const result = compileSource(`
        import { createBox, createEngine } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const estimate = Math.max(0, Math.round(1_050_000));
            if (estimate > 0 || document.getElementById("loading")) {
                createBox(engine);
            }
        }
    `);

    assert.match(result.cpp, /bbl::create_box/);
    assert.match(result.cpp, /v_estimate = 1050000\.0/);
    assert.doesNotMatch(result.cpp, /document|getElementById/);
});

test("erases imported browser helpers with only browser and static inputs", () => {
    const result = compileSource(
        `
            import { createEngine } from "@babylonjs/lite";
            import { installBrowserHelper } from "./fixtures/compiler-modules/browser-helper.js";

            async function main() {
                const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
                const progress = installBrowserHelper(canvas, { estimatedBytes: 42 });
                progress.done();
                await createEngine(canvas);
            }
        `,
        { fileName: "test/compiler-multi-file-entry.ts" },
    );

    assert.doesNotMatch(result.cpp, /globalThis|fetch|dataset|progress/);
    assert.ok(
        result.manifest.adaptations.some(
            ({ id }) => id === "browser-setup-erasure",
        ),
    );
});

test("erases nullable DOM-only class factories as absent native objects", () => {
    const result = compileSource(
        `
            import { createBox, createEngine } from "@babylonjs/lite";
            import { BrowserHud } from "./fixtures/compiler-modules/browser-hud.js";

            async function main() {
                const engine = await createEngine({});
                const hud = await BrowserHud.create();
                if (hud) {
                    hud.update(42);
                }
                createBox(engine);
            }
        `,
        { fileName: "test/compiler-multi-file-entry.ts" },
    );

    assert.match(result.cpp, /bbl::create_box/);
    assert.doesNotMatch(result.cpp, /fetch|BrowserHud|hud\.bin/);
    assert.ok(
        result.manifest.adaptations.some(
            ({ id }) => id === "browser-setup-erasure",
        ),
    );
});

test("stores immediately resolved promise values in data maps", () => {
    const result = compileSource(`
        async function load(): Promise<number> {
            return 3;
        }
        const pending = new Map<string, Promise<number>>();
        pending.set("item", load());
        const loaded = pending.get("item");
    `);

    assert.match(result.cpp, /bbl::js::Map<std::string, double>/);
    assert.match(result.cpp, /\.set\([^,]+, bblscene::load\(\)\)/);
});

test("settles Promise.all over an eagerly mapped native array", () => {
    const result = compileSource(`
        const loaded: string[] = [];
        const unique = new Map<string, string>();
        unique.set("one", "one");
        unique.set("two", "two");
        async function loadAll(): Promise<void> {
            await Promise.all([...unique.values()].map(async (name) => {
                loaded.push(name);
            }));
        }
        void loadAll();
    `);

    assert.match(result.cpp, /for \(std::size_t/);
    assert.match(result.cpp, /v_loaded\.push_back/);
    assert.doesNotMatch(result.cpp, /Promise/);
});

test("projects open string records into optional struct parameters", () => {
    const result = compileSource(`
        type Entity = Record<string, string>;
        interface SpawnEnt {
            classname?: string;
            origin?: string;
        }
        function spawn(entities: SpawnEnt[]): number {
            return entities.length;
        }
        const entities: Entity[] = [{ classname: "monster" }];
        const count = spawn(entities);
    `);

    assert.match(result.cpp, /project_result/);
    assert.match(result.cpp, /\.get\("classname"\)/);
    assert.match(result.cpp, /\.get\("origin"\)/);
});

test("runs data cleanup in finally across an early return", () => {
    const result = compileSource(`
        const pending = new Map<string, number>();
        function load(): number {
            try {
                return 3;
            } finally {
                pending.delete("item");
            }
        }
        const loaded = load();
    `);

    assert.match(result.cpp, /bbl::js::finally\(\[&\]\(\) \{/);
    assert.match(result.cpp, /v_pending\.erase\("item"\)/);
});

test("packages a closed directory for runtime-selected audio fetches", () => {
    const result = compileSource(
        `
            import { createAudioEngineAsync } from "@babylonjs/lite";

            async function loadSound(ctx: BaseAudioContext, name: string) {
                const response = await fetch(
                    "fixtures/compiler-modules/dynamic-audio/" + name
                );
                return ctx.decodeAudioData(await response.arrayBuffer());
            }

            async function main() {
                const audio = await createAudioEngineAsync();
                await loadSound(audio.audioContext, "tone.wav");
            }
            main();
        `,
        { fileName: "test/compiler-dynamic-audio-entry.ts" },
    );

    assert.equal(result.manifest.assets.length, 1);
    assert.match(result.cpp, /Unknown packaged asset/);
    assert.match(result.cpp, /audio_decode_file/);
});

test("deduplicates static and directory-discovered module assets", () => {
    const result = compileSource(
        `
            import { moduleAssetUrl } from "./fixtures/compiler-modules/asset-url-helper.js";

            const soundRoot = moduleAssetUrl(
                "./fixtures/compiler-modules/dynamic-audio",
                import.meta.url,
            );
            const tone = moduleAssetUrl(
                "./fixtures/compiler-modules/dynamic-audio/tone.wav",
                import.meta.url,
            );

            async function load(url: string): Promise<ArrayBuffer> {
                const response = await fetch(url);
                return response.arrayBuffer();
            }

            async function main(): Promise<void> {
                const sounds = new Set([tone]);
                for (const url of sounds) await load(url);
            }
            void soundRoot;
            void main();
        `,
        { fileName: "test/compiler-module-audio-entry.ts" },
    );

    assert.equal(result.manifest.assets.length, 1);
    assert.equal(
        result.manifest.assets[0]?.source,
        "fixtures/compiler-modules/dynamic-audio/tone.wav",
    );
    assert.equal(
        result.cpp.split(result.manifest.assets[0]!.output).length - 1,
        1,
    );
});

test("preserves numeric tuple identity except through array spread", () => {
    const result = compileSource(`
        type V3 = [number, number, number];
        interface Bounds { mins: V3; }
        const source: Bounds = { mins: [1, 2, 3] };
        const alias: V3 = source.mins;
        const copy: V3 = [...source.mins];
    `);

    assert.match(
        result.cpp,
        /bbl::js::Tuple<3>& v_alias = v_source\.mins;/,
    );
    assert.match(
        result.cpp,
        /bbl::js::Tuple<3> v_copy = bbl::js::clone_tuple\(v_source\.mins\);/,
    );
});

test("tests runtime strings against RegExp values", () => {
    const result = compileSource(`
        const items = /^(item_|weapon_)/;
        function isItem(name: string): boolean {
            return items.test(name);
        }
        const found = isItem("item_shells");
    `);

    assert.match(result.cpp, /\.test\(/);
});

test("mutates a Map array fallback before storing it back", () => {
    const result = compileSource(`
        const groups = new Map<string, number[]>();
        const key = "items";
        const list = groups.get(key) ?? [];
        list.push(3);
        groups.set(key, list);
    `);

    assert.match(result.cpp, /v_list\.push_back\(3\.0\)/);
    assert.match(result.cpp, /v_groups\.set\("items", v_list\)/);
});

test("serializes a runtime string enum for a string Set lookup", () => {
    const result = compileSource(`
        type Kind = "door" | "button";
        const kinds = new Set(["door", "button"]);
        function includes(kind: Kind): boolean {
            return kinds.has(kind);
        }
        const runtimeKind: Kind = Math.random() > 0.5 ? "door" : "button";
        const found = includes(runtimeKind);
    `);

    assert.match(result.cpp, /Kind_to_string/);
    assert.match(result.cpp, /v_kinds\.has\(/);
});

test("coerces Array predicate return expressions with JavaScript truthiness", () => {
    const result = compileSource(`
        interface Entry { name: string; bytes: Uint8Array | null; }
        const entries: Entry[] = [{ name: "sky", bytes: new Uint8Array(2) }];
        const index = entries.findIndex(
            (entry) => entry && entry.name.startsWith("sky") && entry.bytes
        );
    `);

    assert.match(result.cpp, /find_index_result/);
});

test("keeps early boolean returns in block Array predicates", () => {
    const result = compileSource(`
        const values = [1, 2, 3];
        const positive = values.filter((value) => {
            if (value < 2) return false;
            return value > 0;
        });
    `);

    assert.match(result.cpp, /filter_result/);
});

test("erases decoder-base setup rooted at import.meta.url", () => {
    const result = compileSource(
        `
            import { createEngine } from "@babylonjs/lite";
            import { configureDemoDecoderBases } from "./fixtures/compiler-modules/demo-decoder-base.js";

            async function main() {
                await configureDemoDecoderBases(import.meta.url);
                await createEngine({});
            }
        `,
        { fileName: "test/compiler-multi-file-entry.ts" },
    );

    assert.doesNotMatch(result.cpp, /import|setDracoBaseUrl|setMeshoptBaseUrl/);
    assert.ok(
        result.manifest.adaptations.some(
            ({ id }) => id === "browser-setup-erasure",
        ),
    );
});

test("erases browser-only try-catch setup", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main() {
            try {
                Object.defineProperty(globalThis, "devicePixelRatio", {
                    configurable: true,
                    get: () => 2,
                });
            } catch {
                console.warn("browser rejected the override");
            }
            await createEngine({});
        }
    `);

    assert.doesNotMatch(result.cpp, /defineProperty|devicePixelRatio|console/);
    const nativeCatch = compileSource(`
        import { createBox, createEngine } from "@babylonjs/lite";
        async function main() {
            const engine = await createEngine({});
            try {
                createBox(engine);
            } catch {}
        }
    `);
    assert.match(
        nativeCatch.cpp,
        /try \{[\s\S]*bbl::create_box[\s\S]*\} catch \(\.\.\.\) \{/,
    );
});

test("lowers platform listeners through generic engine callbacks", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main() {
            await createEngine({});
            let state = 0;
            window.addEventListener("keydown", (event) => {
                if (event.repeat) return;
                switch (event.code) {
                    case "ArrowLeft":
                        state -= 1;
                        break;
                    case "Space":
                        event.preventDefault();
                        state += 1;
                        break;
                }
            });
            window.addEventListener("keyup", (event) => {
                if (event.code === "Escape") state = 0;
            });
            window.addEventListener("pointerdown", () => {
                state = 1;
            });
            document.addEventListener("visibilitychange", () => {
                if (document.hidden) state = 0;
            });
        }
    `);

    assert.match(result.cpp, /bbl::on_key_down/);
    assert.match(result.cpp, /bbl::on_key_up/);
    assert.match(result.cpp, /bbl::on_pointer_down/);
    assert.match(result.cpp, /bbl::on_visibility_change/);
    assert.match(result.cpp, /const bbl::PlatformKeyboardEvent&/);
    assert.match(result.cpp, /std::string_view/);
    assert.match(result.cpp, /\.code/);
    assert.match(result.cpp, /\.repeat/);
    assert.doesNotMatch(result.cpp, /addEventListener|preventDefault|document\.hidden/);
});

test("maps canvas pointer offsets to its platform-relative coordinates", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main() {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            await createEngine(canvas);
            canvas.addEventListener("pointerdown", (event) => {
                const state = event.offsetX + event.clientX + event.offsetY + event.clientY + event.button;
                canvas.dataset.pointerState = \`\${state}\`;
            });
        }
    `);

    assert.match(result.cpp, /bbl::on_mouse_down/);
    assert.equal((result.cpp.match(/\.client_x/g) ?? []).length, 2);
    assert.equal((result.cpp.match(/\.client_y/g) ?? []).length, 2);
    assert.match(result.cpp, /\.button/);
    assert.doesNotMatch(result.cpp, /offset[XY]/);
    assert.match(result.cpp, /\[\[maybe_unused\]\] double v_fn\d+_state/);
});

test("lowers focusable-canvas FPS controls and pointer lock", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main() {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            await createEngine(canvas);
            let key = "";
            let locked = false;
            let yaw = 0;
            let wheel = 0;
            document.addEventListener("pointerlockchange", () => {
                locked = document.pointerLockElement === canvas;
            });
            canvas.addEventListener("keydown", (event) => {
                key = event.code;
            });
            canvas.addEventListener("keyup", () => {
                key = "";
            });
            canvas.addEventListener("pointerdown", (event) => {
                if ((event.buttons & 2) && document.pointerLockElement !== canvas) {
                    void canvas.requestPointerLock();
                }
            });
            canvas.addEventListener("pointerup", (event) => {
                if (!(event.buttons & 2) && document.pointerLockElement === canvas) {
                    document.exitPointerLock();
                }
            });
            canvas.addEventListener("pointermove", (event) => {
                if (locked) yaw += event.movementX + event.movementY;
            });
            canvas.addEventListener("wheel", (event) => {
                event.preventDefault();
                wheel += event.deltaY;
            });
            canvas.addEventListener("pointercancel", () => {
                locked = false;
            });
        }
    `);

    assert.match(result.cpp, /bbl::on_key_down/);
    assert.match(result.cpp, /bbl::on_key_up/);
    assert.match(result.cpp, /bbl::on_mouse_move/);
    assert.match(result.cpp, /bbl::on_mouse_wheel/);
    assert.match(result.cpp, /bbl::on_mouse_cancel/);
    assert.match(result.cpp, /bbl::on_pointer_lock_change/);
    assert.match(result.cpp, /bbl::request_pointer_lock/);
    assert.match(result.cpp, /bbl::exit_pointer_lock/);
    assert.match(result.cpp, /\.pointer_locked/);
    assert.match(result.cpp, /\.movement_x/);
    assert.match(result.cpp, /\.movement_y/);
    assert.match(result.cpp, /\.delta_y/);
    assert.doesNotMatch(
        result.cpp,
        /addEventListener|requestPointerLock|exitPointerLock|preventDefault/,
    );
});

test("keeps callback-local declarations inside platform listeners", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main() {
            await createEngine({});
            let on = true;
            let state = 0;
            const toggle = {
                toggle(): boolean {
                    on = !on;
                    return on;
                },
            };
            window.addEventListener("keydown", (event) => {
                if (event.key === "c") {
                    const nowOn = toggle.toggle();
                    state = nowOn ? 1 : 0;
                }
            });
        }
    `);

    const listener = result.cpp.indexOf("bbl::on_key_down");
    const toggleAssignment = result.cpp.indexOf("v_on = !(v_on)");
    assert.ok(listener >= 0);
    assert.ok(toggleAssignment > listener);
});

test("lowers Uint16Array construction, mutation, and native references", () => {
    const result = compileSource(`
        function write(values: Uint16Array, fill: number): void {
            values.fill(fill);
            values[0] = 65537;
        }

        const values = new Uint16Array([1, 2]);
        write(values, 7);
        const selected = values[0];
    `);

    assert.match(result.cpp, /bbl::js::u16_array_from/);
    assert.match(result.cpp, /bbl::js::U16Array&/);
    assert.match(result.cpp, /bbl::js::to_uint16\(65537\.0\)/);
    assert.match(result.cpp, /bbl::js::array_fill/);
    assert.match(result.cpp, /static_cast<double>\(/);
});

test("carries explicit alpha blending and mesh render order", () => {
    const result = compileSource(`
        import {
            createBox,
            createEngine,
            createPbrMaterial,
            createSolidTexture2D,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const mesh = createBox(engine);
            mesh.material = createPbrMaterial({
                baseColorTexture: createSolidTexture2D(engine, 1, 1, 1),
                ormTexture: createSolidTexture2D(engine, 1, 1, 1),
                baseColorFactor: [0.25, 0.5, 0.75, 0.5],
                alphaBlend: true,
            });
            mesh.renderOrder = 7;
        }
    `);

    assert.match(
        result.cpp,
        /\.base_color_factor = bbl::Color4\{0\.25f, 0\.5f, 0\.75f, 0\.5f\}/,
    );
    assert.match(result.cpp, /\.alpha_blend = true/);
    assert.match(result.cpp, /\.render_order = 7\.0/);
    assert.match(result.cpp, /\.has_render_order = true/);
});

test("folds module-relative demo asset URLs to the pinned public root", () => {
    const result = compileSource(
        `
            import { createEngine, loadTexture2D } from "@babylonjs/lite";
            import { moduleAssetUrl } from "./fixtures/compiler-modules/asset-url-helper.js";

            const textureUrl = moduleAssetUrl("./brdf-lut.png", import.meta.url);
            async function main() {
                const engine = await createEngine({});
                await loadTexture2D(engine, textureUrl);
            }
        `,
        { fileName: "test/compiler-multi-file-entry.ts" },
    );

    assert.deepEqual(result.manifest.assets.map(({ source }) => source), [
        pinnedAssetUrl("packages/babylon-lite/assets/brdf-lut.png"),
    ]);
});

test("applies every recognized module URL pathname transformation", () => {
    const result = compileSource(
        `
            import { createEngine, loadTexture2D } from "@babylonjs/lite";
            import { moduleAssetUrl } from "./fixtures/compiler-modules/asset-url-helper.js";

            const textureUrl = moduleAssetUrl(
                "/lite/bundle/demos/probe.png",
                import.meta.url,
            );
            async function main() {
                const engine = await createEngine({});
                await loadTexture2D(engine, textureUrl);
            }
        `,
        { fileName: "test/compiler-multi-file-entry.ts" },
    );

    assert.deepEqual(result.manifest.assets.map(({ source }) => source), [
        pinnedAssetUrl("lab/public/bundle/demos/probe.png"),
    ]);
});

test("keeps pinned root assets independent of adjacent filesystem files", () => {
    const directory = mkdtempSync(
        join(tmpdir(), "bblite-pinned-asset-"),
    );
    try {
        writeFileSync(join(directory, "brdf-lut.png"), "not the pin");
        const result = compileSource(
            `
                import { createEngine, loadTexture2D } from "@babylonjs/lite";
                async function main() {
                    const engine = await createEngine({});
                    await loadTexture2D(engine, "/brdf-lut.png");
                }
            `,
            { fileName: join(directory, "entry.ts") },
        );

        assert.deepEqual(result.manifest.assets.map(({ source }) => source), [
            pinnedAssetUrl("packages/babylon-lite/assets/brdf-lut.png"),
        ]);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("folds module-relative asset URLs inside an imported consumer", () => {
    const result = compileSource(
        `
            import { createEngine } from "@babylonjs/lite";
            import { loadModuleTexture } from "./fixtures/compiler-modules/asset-url-consumer.js";

            async function main() {
                const engine = await createEngine({});
                await loadModuleTexture(engine);
            }
        `,
        { fileName: "test/compiler-multi-file-entry.ts" },
    );

    assert.deepEqual(result.manifest.assets.map(({ source }) => source), [
        pinnedAssetUrl("packages/babylon-lite/assets/brdf-lut.png"),
    ]);
});

test("materializes static fetched JSON through records, tuples, and typed arrays", () => {
    const result = compileSource(
        `
            import {
                createEngine,
                createMeshFromData,
            } from "@babylonjs/lite";

            interface Part {
                positions: number[];
                normals: number[];
                uvs: number[];
                indices: number[];
            }

            async function loadPart(url: string): Promise<Part> {
                const response = await fetch(url);
                if (!response.ok) {
                    throw new Error(\`HTTP \${response.status}\`);
                }
                const document = (await response.json()) as Record<string, Part>;
                return document.part!;
            }

            async function main() {
                const engine = await createEngine({});
                const part = await loadPart(
                    "./fixtures/compiler-modules/static-geometry.json",
                );
                createMeshFromData(
                    engine,
                    "part",
                    new Float32Array(part.positions),
                    new Float32Array(part.normals),
                    new Uint32Array(part.indices),
                    new Float32Array(part.uvs),
                );
            }
        `,
        { fileName: "test/compiler-static-fetch-entry.ts" },
    );

    assert.match(result.cpp, /f32_array_from/);
    assert.match(result.cpp, /u32_array_from/);
    assert.doesNotMatch(result.cpp, /fetch|Response|JSON/);
});

test("preserves static template URLs through text-fetch helpers", () => {
    const result = compileSource(
        `
            async function fetchText(url: string): Promise<string> {
                const response = await fetch(url);
                if (!response.ok) throw new Error(String(response.status));
                return response.text();
            }

            async function load(baseUrl: string): Promise<string> {
                return fetchText(\`${"${baseUrl}"}.json\`);
            }

            async function main() {
                const base = "./fixtures/compiler-modules/static-geometry";
                const source = await load(base);
                const label = \`bytes: ${"${source}"}\`;
            }
        `,
        { fileName: "test/compiler-static-text-fetch-entry.ts" },
    );

    assert.match(result.cpp, /bytes:/);
    assert.doesNotMatch(result.cpp, /fetch|Response/);
});

test("lowers global RegExp exec loops and lastIndex", () => {
    const result = compileSource(`
        const ATTRIBUTE = /(\\w+)\\s*=\\s*"([^"]*)"/g;

        function names(source: string): string[] {
            const result: string[] = [];
            ATTRIBUTE.lastIndex = 0;
            let match: RegExpExecArray | null;
            while ((match = ATTRIBUTE.exec(source)) !== null) {
                result.push(match[1]!);
            }
            return result;
        }

        function main() {
            const result = names('x="1" y="2"');
        }
    `);

    assert.match(result.cpp, /bbl::js::RegExp/);
    assert.match(result.cpp, /\.last_index = 0\.0/);
    assert.match(result.cpp, /\.exec\(/);
});

test("converts runtime strings with Number", () => {
    const result = compileSource(`
        function main() {
            let value = "42";
            const converted = Number(value);
        }
    `);

    assert.match(result.cpp, /bbl::js::number_from_string\(v_value\)/);
});

test("packages a local root-relative binary fetch for native ArrayBuffer reads", () => {
    const result = compileSource(
        `
            async function main() {
                const response = await fetch(
                    "/fixtures/compiler-modules/static-geometry.json",
                );
                if (!response.ok) throw new Error(String(response.status));
                const bytes = await response.arrayBuffer();
            }
        `,
        { fileName: "test/compiler-local-root-entry.ts" },
    );

    assert.deepEqual(result.manifest.assets, [
        {
            source: "fixtures/compiler-modules/static-geometry.json",
            output: result.manifest.assets[0]!.output,
            kind: "binary",
        },
    ]);
    assert.match(
        result.cpp,
        /bbl::js::ArrayBuffer\(bbl::pal::read_binary_file\(bbl::asset_path\(/,
    );
    assert.doesNotMatch(result.cpp, /raw\.githubusercontent\.com/);
});

test("lowers a direct thin-instance upload helper", () => {
    const result = compileSource(`
        import {
            createBox,
            createEngine,
            setThinInstances,
        } from "@babylonjs/lite";
        import type { EngineContext, Mesh } from "@babylonjs/lite";

        async function build(engine: EngineContext): Promise<void> {
            const device = engine._device;
            function uploadMatrices(
                mesh: Mesh,
                buf: Float32Array,
                instances: number,
            ): void {
                const ti = mesh.thinInstances!;
                if (ti._gpuBuffer) {
                    device.queue.writeBuffer(
                        ti._gpuBuffer,
                        0,
                        buf.buffer,
                        buf.byteOffset,
                        instances * 64,
                    );
                    return;
                }
                ti._version++;
                ti._dirtyMin = 0;
                ti._dirtyMax = instances;
            }

            const mesh = createBox(engine);
            const matrices = new Float32Array(32);
            setThinInstances(mesh, matrices, 2);
            uploadMatrices(mesh, matrices, 2);
        }

        async function main() {
            const engine = await createEngine({});
            await build(engine);
        }
    `);

    assert.match(result.cpp, /bbl::upload_thin_instance_matrices/);
    assert.doesNotMatch(result.cpp, /writeBuffer|_gpuBuffer|_dirtyMin/);
});

test("folds static string concatenation in asset arguments", () => {
    const result = compileSource(`
        import {
            createEngine,
            loadGltf,
            loadTexture2D,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const root = "https://example.com/assets/";
            await loadGltf(engine, root + "model.glb");
            await loadTexture2D(engine, root + "texture.png");
        }
    `);

    assert.deepEqual(
        result.manifest.assets.map(({ source }) => source),
        [
            "https://example.com/assets/model.glb",
            "https://example.com/assets/texture.png",
        ],
    );
});

test("prunes browser-selected typed data branches", () => {
    const result = compileSource(`
        interface Pick { value: number; }

        const params = new URLSearchParams(window.location.search);
        const seek = parseFloat(params.get("seekTime") || "");
        const picked: Pick = isNaN(seek)
            ? { value: 3 }
            : { value: document.title.length };
    `);

    assert.match(result.cpp, /Pick v_picked = .*\{3\.0\}/);
    assert.doesNotMatch(result.cpp, /document|title/);
});

test("reads the query the reference pose is captured at", () => {
    const source = `
        import {
            createBox,
            createEngine,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const box = createBox(engine);
            const params = new URLSearchParams(window.location.search);
            const seek = parseFloat(params.get("seekTime") || "");
            let x = 0;
            if (!isNaN(seek) && seek > 0) {
                x = 1;
            } else if (!isNaN(seek)) {
                x = 2;
            } else {
                x = 3;
            }
            box.position.x = x;
        }
    `;
    // Bare, as every scene the pin serves without a query compiles today.
    assert.match(compileSource(source).cpp, /v_x = 3\.0;/);
    // At the pose scene 23's own spec serves: present, and not above zero.
    assert.match(
        compileSource(source, { search: "?seekTime=0" }).cpp,
        /v_x = 2\.0;/,
    );
    // And a pose that names a time takes the arm above zero.
    assert.match(
        compileSource(source, { search: "?seekTime=1.5" }).cpp,
        /v_x = 1\.0;/,
    );
});

test("dispatches a pinned subpath import as the pinned package", () => {
    // The pin's own scenes reach modules its entry point does not
    // re-export. Installing tracking is one of them, and it emits nothing:
    // every primitive it defines preserves its value and only marks the UBO
    // dirty on a later write, which generation already knows about.
    const result = compileSource(`
        import {
            createEngine,
            createPbrMaterial,
            createSolidTexture2D,
        } from "@babylonjs/lite";
        import { installPbrTracking } from "babylon-lite/material/tracking/pbr-tracking";

        async function main() {
            const engine = await createEngine({});
            const material = createPbrMaterial({
                baseColorTexture: createSolidTexture2D(engine, 1, 1, 1),
                ormTexture: createSolidTexture2D(engine, 1, 1, 0),
            });
            installPbrTracking(material);
        }
    `);
    assert.doesNotMatch(result.cpp, /install_pbr_tracking|installPbrTracking/);
    assert.match(result.cpp, /create_pbr_material/);
});

test("rejects unsupported dynamic engine and scene options", () => {
    const pixelRatio = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        const MAX_DPR = 1;
        async function main() {
            await createEngine({}, { maxDevicePixelRatio: MAX_DPR });
        }
    `);
    assert.doesNotMatch(pixelRatio.cpp, /maxDevicePixelRatio|MAX_DPR/);
    assert.throws(
        () =>
            compileSource(`
                import { createEngine } from "@babylonjs/lite";
                async function main(cap: number) {
                    await createEngine({}, { maxDevicePixelRatio: cap });
                }
            `),
        /maxDevicePixelRatio must be a static number/,
    );
    assert.throws(
        () =>
            compileSource(`
                import { createEngine } from "@babylonjs/lite";
                async function main() {
                    await createEngine({}, { maxDevicePixelRatio: 0.5 });
                }
            `),
        /support maxDevicePixelRatio values of 1 or greater/,
    );
    assert.throws(
        () =>
            compileSource(`
                import {
                    createEngine,
                } from "@babylonjs/lite";
                async function main() {
                    const engine = await createEngine({}, {
                        msaaSamples: 1,
                    });
                }
            `),
        /supports explicit msaaSamples: 4 only/,
    );
    assert.throws(
        () =>
            compileSource(`
                import {
                    createEngine,
                    createSceneContext,
                } from "@babylonjs/lite";
                async function main() {
                    const engine = await createEngine({});
                    const enabled = true;
                    const scene = createSceneContext(engine, {
                        defaultRenderTask: enabled,
                    });
                }
            `),
        /defaultRenderTask must be a static boolean/,
    );
});

test("rejects compound assignments for nonnumeric properties", () => {
    const source = (assignment: string): string => `
        import {
            createArcRotateCamera,
            createBox,
            createEngine,
            createSceneContext,
            createStandardMaterial,
        } from "@babylonjs/lite";
        async function main(): Promise<void> {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            const scene = createSceneContext(engine);
            const camera = createArcRotateCamera(0, 1, 2, { x: 0, y: 0, z: 0 });
            const box = createBox(engine, 1);
            const material = createStandardMaterial();
            ${assignment}
        }
    `;
    for (const [assignment, target] of [
        ["scene.clearColor += [0, 0, 0, 1];", "scene clearColor"],
        ["scene.camera -= camera;", "scene camera"],
        ["box.material += material;", "mesh material"],
        ["material.diffuseColor -= [1, 1, 1];", "material diffuseColor"],
        ["material.disableLighting += true;", "material disableLighting"],
        [
            "scene.imageProcessing.toneMappingEnabled -= true;",
            "image-processing property 'toneMappingEnabled'",
        ],
    ] as const) {
        assert.throws(
            () => compileSource(source(assignment)),
            (error: unknown) => {
                assert.ok(error instanceof CompileError);
                assert.match(
                    error.message,
                    new RegExp(
                        `Compound assignment is not supported for ${target.replace(
                            /[.*+?^${}()|[\]\\]/g,
                            "\\$&",
                        )}`,
                    ),
                );
                return true;
            },
        );
    }
});

test("compiles pinned scene 213 GridMaterial options", () => {
    const source = readFileSync(
        resolve("corpus/babylon-lite/lab/lite/src/lite/scene213.ts"),
        "utf8",
    );
    const result = compileSource(source, {
        fileName: "corpus/babylon-lite/lab/lite/src/lite/scene213.ts",
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
                `import { createTorusKnot, createEngine } from "@babylonjs/lite";
async function main() {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    createTorusKnot(engine);
}`,
                { fileName: "unsupported.ts" },
            ),
        (error: unknown) => {
            assert.ok(error instanceof CompileError);
            assert.match(error.message, /^unsupported\.ts:5:5:/);
            assert.match(error.message, /createTorusKnot/);
            return true;
        },
    );
});

test("compiles pinned Scene 1 BoomBox parity", () => {
    const sourcePath =
        "corpus/babylon-lite/lab/lite/src/lite/scene1.ts";
    const source = readFileSync(resolve(sourcePath), "utf8");
    const result = compileSource(source, {
        fileName: sourcePath,
    });

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
                source: pinnedAssetUrl("packages/babylon-lite/assets/brdf-lut.png"),
                kind: "texture",
            },
        ],
    );
    assert.match(result.cpp, /bbl::load_gltf/);
    assert.match(result.cpp, /bbl::load_environment/);
    assert.match(result.cpp, /bbl::create_default_camera/);
    assert.match(result.cpp, /\.alpha = 1\.77538;/);
    assert.doesNotMatch(result.cpp, /Object::assign|drawCallCount/);
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
    const source = readFileSync(resolve("corpus/babylon-lite/lab/lite/src/lite/scene10.ts"), "utf8");
    const result = compileSource(source, {
        fileName: "corpus/babylon-lite/lab/lite/src/lite/scene10.ts",
    });

    assert.deepEqual(result.manifest.features, [
        "core",
        "backend:sdl",
        "camera:arc-rotate",
        "light:hemispheric",
        "material:pbr",
        "mesh:sphere",
        "texture:file",
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
        "upstream/src/texture_file.cpp",
        "upstream/src/mesh_factories.cpp",
    ]);
});

test("compiles Babylon Lite scene 8 HDR glass sphere", () => {
    const source = readFileSync(
        resolve("corpus/babylon-lite/lab/lite/src/lite/scene8.ts"),
        "utf8",
    );
    const result = compileSource(source, {
        fileName: "corpus/babylon-lite/lab/lite/src/lite/scene8.ts",
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
        "texture:file",
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
                source: "generated:pinned-ibl-brdf-lut",
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
        /\.environment_intensity = 0\.7f, \.alpha = 0\.5f, \.alpha_blend = false, \.reflectance = 0\.2f/,
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

test("compiles Babylon Lite scene 176 transmission, IOR, and volume", () => {
    const sourcePath =
        "corpus/babylon-lite/lab/lite/src/lite/scene176.ts";
    const result = compileSource(
        readFileSync(resolve(sourcePath), "utf8"),
        { fileName: sourcePath },
    );

    assert.ok(
        result.manifest.features.includes("renderer:transmission"),
    );
    assert.match(result.cpp, /bbl::enable_scene_transmission/);
    assert.match(
        result.cpp,
        /bbl::on_before_render\([^]*\[&\]\(\[\[maybe_unused\]\] float /,
    );
    // The amber body's transmission, IOR, volume, and skybox-mode
    // material state arrive through the glTF loader; the scene's own
    // PBR material carries the skybox-mode backdrop.
    assert.match(
        result.cpp,
        /bbl::create_pbr_material\(/,
    );
    assert.ok(
        result.manifest.assets.some(({ output }) =>
            /\.glb$/.test(output),
        ),
    );
});

test("compiles Babylon Lite scene 273 runtime material-family addition", () => {
    const source = readFileSync(
        resolve("corpus/babylon-lite/lab/lite/src/lite/scene273.ts"),
        "utf8",
    );
    const result = compileSource(source, {
        fileName: "corpus/babylon-lite/lab/lite/src/lite/scene273.ts",
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
        "texture:file",
        "renderer:pbr",
    ]);
    assert.match(result.cpp, /\.fixed_delta_ms = 16\.0f/);
    assert.match(result.cpp, /bbl::on_before_render/);
    assert.match(result.cpp, /v_frame\+\+/);
    assert.match(
        result.cpp,
        /if \(\(!\(v_added\) && v_frame >= 20\.0\)\)/,
    );
    assert.match(
        result.cpp,
        /\.metallic_factor = 0\.1f, \.roughness_factor = 0\.4f, \.direct_intensity = 1\.0f/,
    );
    assert.match(
        result.cpp,
        /if \(\(v_added && v_frame >= \(20\.0 \+ 150\.0\)\)\)/,
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
        "upstream/src/texture_file.cpp",
        "upstream/src/material_standard.cpp",
        "upstream/src/mesh_factories.cpp",
    ]);
});

test("compiles Babylon Lite scene 267 Standard vertex colors", () => {
    const source = readFileSync(
        resolve("corpus/babylon-lite/lab/lite/src/lite/scene267.ts"),
        "utf8",
    );
    const result = compileSource(source, {
        fileName: "corpus/babylon-lite/lab/lite/src/lite/scene267.ts",
    });

    assert.deepEqual(result.manifest.features, [
        "core",
        "backend:sdl",
        "camera:arc-rotate",
        "material:standard",
        "material:standard-vertex-colors",
        "mesh:from-data",
        "renderer:pbr",
    ]);
    // The RGBA colors ride the ninth createMeshFromData slot, after the
    // three optional typed arrays the scene skips with `undefined`.
    assert.match(
        result.cpp,
        /create_mesh_from_data\([^;]*\{\}, \{\}, \{\}, bbl::js::f32_array_from\(bbl::js::Array<double>\{0\.0, 0\.0, 1\.0, 1\.0, 1\.0, 0\.0, 1\.0, 1\.0, 0\.0, 1\.0, 0\.0, 1\.0, 1\.0, 1\.0, 0\.0, 1\.0\}\)\)/,
    );
    assert.match(result.cpp, /\.disable_lighting = true;/);
    assert.match(result.cpp, /\.double_sided = !\(false\);/);
    // enableStandardVertexColors installs a shader fragment upstream, so
    // it reaches the feature and emits no statement.
    assert.doesNotMatch(result.cpp, /vertex_colors/);
    assert.deepEqual(result.manifest.generatedSources, [
        "upstream/src/engine.cpp",
        "upstream/src/scene_core.cpp",
        "upstream/src/camera_arc_rotate.cpp",
        "upstream/src/camera_controls.cpp",
        "upstream/src/renderer_plan.cpp",
        "upstream/src/material_standard.cpp",
        "upstream/src/mesh_factories.cpp",
    ]);
});

test("compiles Babylon Lite scene 268 orthographic camera", () => {
    const source = readFileSync(
        resolve("corpus/babylon-lite/lab/lite/src/lite/scene268.ts"),
        "utf8",
    );
    const result = compileSource(source, {
        fileName: "corpus/babylon-lite/lab/lite/src/lite/scene268.ts",
    });

    assert.deepEqual(result.manifest.features, [
        "core",
        "backend:sdl",
        "camera:arc-rotate",
        "camera:orthographic",
        "light:hemispheric",
        "material:standard",
        "mesh:box",
        "renderer:pbr",
    ]);
    assert.match(
        result.cpp,
        /bbl::enable_orthographic_camera\(v_engine, v_camera, 6\.0\)/,
    );
    // Module-level constant arrays resolve through their initializers:
    // the loop bound folds and the color table indexes at compile time.
    assert.match(
        result.cpp,
        /diffuse_color = bbl::Color3\{0\.85f, 0\.25f, 0\.25f\}/,
    );
    assert.match(
        result.cpp,
        /diffuse_color = bbl::Color3\{0\.65f, 0\.35f, 0\.85f\}/,
    );
    // The URL override folds away: no query string reaches a native
    // build, so `Number.isFinite(NaN)` drops the branch.
    assert.doesNotMatch(result.cpp, /ortho_half_height/);
    assert.deepEqual(result.manifest.generatedSources, [
        "upstream/src/engine.cpp",
        "upstream/src/scene_core.cpp",
        "upstream/src/camera_arc_rotate.cpp",
        "upstream/src/camera_controls.cpp",
        "upstream/src/camera_orthographic.cpp",
        "upstream/src/light_matrix.cpp",
        "upstream/src/light_hemispheric.cpp",
        "upstream/src/renderer_plan.cpp",
        "upstream/src/material_standard.cpp",
        "upstream/src/mesh_factories.cpp",
    ]);
});

test("compiles Babylon Lite scene 13 PBR spheres grid", () => {
    const source = readFileSync(resolve("corpus/babylon-lite/lab/lite/src/lite/scene13.ts"), "utf8");
    const result = compileSource(source, {
        fileName: "corpus/babylon-lite/lab/lite/src/lite/scene13.ts",
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
                source: pinnedAssetUrl("packages/babylon-lite/assets/brdf-lut.png"),
                kind: "texture",
            },
        ],
    );
    assert.match(result.cpp, /PBR_Spheres\.glb/);
    assert.doesNotMatch(result.cpp, /skipSkybox/);
});

test("compiles Babylon Lite scene 32 unlit glTF", () => {
    const source = readFileSync(resolve("corpus/babylon-lite/lab/lite/src/lite/scene32.ts"), "utf8");
    const result = compileSource(source, {
        fileName: "corpus/babylon-lite/lab/lite/src/lite/scene32.ts",
    });

    assert.ok(result.manifest.features.includes("loader:gltf"));
    assert.ok(result.manifest.features.includes("renderer:pbr"));
    assert.match(result.cpp, /\.alpha \+= 3\.141592653589793;/);
    assert.match(result.cpp, /UnlitTest\.glb/);
});

test("compiles Babylon Lite scene 168 mirrored winding", () => {
    const source = readFileSync(resolve("corpus/babylon-lite/lab/lite/src/lite/scene168.ts"), "utf8");
    const result = compileSource(source, {
        fileName: "corpus/babylon-lite/lab/lite/src/lite/scene168.ts",
    });

    assert.ok(result.manifest.features.includes("loader:gltf"));
    assert.ok(result.manifest.features.includes("renderer:pbr"));
    assert.match(result.cpp, /MirroredDoubleSided\.glb/);
    assert.match(result.cpp, /\.clear_color = bbl::Color4\{0\.05f, 0\.06f, 0\.09f, 1\.0f\}/);
});

test("compiles Babylon Lite scene 257 negative scale", () => {
    const source = readFileSync(resolve("corpus/babylon-lite/lab/lite/src/lite/scene257.ts"), "utf8");
    const result = compileSource(source, {
        fileName: "corpus/babylon-lite/lab/lite/src/lite/scene257.ts",
    });

    assert.ok(result.manifest.features.includes("loader:gltf"));
    assert.ok(result.manifest.features.includes("renderer:pbr"));
    assert.match(
        result.cpp,
        /std::sqrt\(800\.0\)/,
    );
    assert.match(result.cpp, /Node_NegativeScale_01\.glb/);
});

test("compiles Babylon Lite scene 266 negative scale spheres", () => {
    const source = readFileSync(resolve("corpus/babylon-lite/lab/lite/src/lite/scene266.ts"), "utf8");
    const result = compileSource(source, {
        fileName: "corpus/babylon-lite/lab/lite/src/lite/scene266.ts",
    });

    assert.ok(result.manifest.features.includes("loader:gltf"));
    assert.ok(result.manifest.features.includes("renderer:pbr"));
    assert.match(result.cpp, /NegativeScaleTest\.glb/);
    assert.match(
        result.cpp,
        /\(3\.141592653589793 \/ 2\.15\)/,
    );
});

test("compiles Babylon Lite scene 274 alpha to coverage", () => {
    const source = readFileSync(resolve("corpus/babylon-lite/lab/lite/src/lite/scene274.ts"), "utf8");
    const result = compileSource(source, {
        fileName: "corpus/babylon-lite/lab/lite/src/lite/scene274.ts",
    });

    assert.ok(result.manifest.features.includes("material:shader"));
    assert.ok(result.manifest.features.includes("mesh:plane"));
    assert.ok(result.manifest.features.includes("renderer:pbr"));
    assert.match(result.cpp, /bbl::create_shader_material/);
    assert.match(result.cpp, /bbl::set_alpha_to_coverage/);
    assert.match(result.cpp, /bbl::create_plane/);
    assert.deepEqual(result.manifest.shaderVariants, ["alpha-card"]);
    assert.deepEqual(result.manifest.customShaderPrograms, []);
    assert.match(
        result.cpp,
        /bbl::create_shader_material\(v_engine, 0u\)/,
    );
    assert.ok(result.manifest.generatedSources.includes("upstream/src/material_shader.cpp"));
});

test("compiles Babylon Lite scene 163 shader alpha cutout", () => {
    const source = readFileSync(
        resolve("corpus/babylon-lite/lab/lite/src/lite/scene163.ts"),
        "utf8",
    );
    const result = compileSource(source, {
        fileName: "corpus/babylon-lite/lab/lite/src/lite/scene163.ts",
    });

    assert.ok(result.manifest.features.includes("camera:arc-rotate"));
    assert.ok(result.manifest.features.includes("material:shader"));
    assert.ok(result.manifest.features.includes("mesh:plane"));
    assert.ok(result.manifest.features.includes("renderer:pbr"));
    assert.deepEqual(result.manifest.shaderVariants, ["circular-cutout"]);
    assert.deepEqual(result.manifest.customShaderPrograms, []);
    assert.match(
        result.cpp,
        /bbl::create_shader_material\(v_engine, 0u\)/,
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

const SHADER_SAMPLER_SOURCE = (options: string, fragmentBody: string): string => `
    import {
        addToScene,
        createEngine,
        createPlane,
        createSceneContext,
        createShaderMaterial,
        createSolidTexture2D,
        loadTexture2D,
        registerScene,
        setShaderTexture,
        startEngine,
    } from "@babylonjs/lite";

    const vertexSource = \`struct VertexOutput{@builtin(position) position:vec4<f32>,@location(0) uv:vec2<f32>,};
@vertex fn mainVertex(input:VertexInput)->VertexOutput{var out:VertexOutput;out.position=shaderSystem.worldViewProjection*vec4<f32>(input.position,1.0);out.uv=input.uv;return out;}\`;
    const fragmentSource = \`struct VertexOutput{@builtin(position) position:vec4<f32>,@location(0) uv:vec2<f32>,};
@fragment fn mainFragment(input:VertexOutput)->@location(0) vec4<f32>{${fragmentBody}}\`;

    async function main() {
        const engine = await createEngine({});
        const scene = createSceneContext(engine);
        const material = createShaderMaterial({
            name: "probe",
            vertexSource,
            fragmentSource,
            attributes: ["position", "uv"],
            uniforms: ["worldViewProjection"],
            ${options}
        });
        ${options.includes("samplers") ? 'setShaderTexture(material, "albedo", await loadTexture2D(engine, "/textures/nme/ebf71b300f43563f.png"));' : ""}
        const plane = createPlane(engine, { width: 1, height: 1 });
        plane.material = material;
        addToScene(scene, plane);
        await registerScene(scene);
        await startEngine(engine);
    }
`;

test("reaches a shader material's samplers and defines", () => {
    const result = compileSource(
        SHADER_SAMPLER_SOURCE(
            `samplers: ["albedo"],
            defines: { TINT: true, Scale: 2 },`,
            "if(TINT){return textureSample(albedo,albedoSampler,input.uv)*Scale;}return vec4<f32>(1.0,0.0,0.0,1.0);",
        ),
    );
    const [program] = result.manifest.customShaderPrograms;
    assert.deepEqual(program?.samplers, ["albedo"]);
    // createShaderMaterial sorts the normalized set by name, and the
    // prelude emits it in that order.
    assert.deepEqual(program?.defines, [
        { name: "Scale", value: 2 },
        { name: "TINT", value: true },
    ]);
    // The slot the setter resolved is the declared index.
    assert.match(result.cpp, /bbl::set_shader_texture\([^)]*, 0u,/);
});

test("folds a numeric shader source factory at its reached call", () => {
    const result = compileSource(`
        import { createEngine, createShaderMaterial } from "babylon-lite";

        const vertexSource = (depthBias: number) => \`struct VertexOutput {
            @builtin(position) position: vec4<f32>,
        };
        const DEPTH_BIAS: f32 = \${depthBias.toExponential(6)};
        @vertex fn mainVertex(input: VertexInput) -> VertexOutput {
            var out: VertexOutput;
            out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position, 1.0);
            out.position.z = out.position.z + DEPTH_BIAS / out.position.w;
            return out;
        }\`;
        const fragmentSource = \`@fragment fn mainFragment() -> @location(0) vec4<f32> {
            return vec4<f32>(1.0);
        }\`;

        function makeMaterial(depthBias = 0) {
            return createShaderMaterial({
                name: "numeric-source-factory",
                vertexSource: vertexSource(depthBias),
                fragmentSource,
                attributes: ["position"],
                uniforms: ["worldViewProjection"],
            });
        }

        async function main() {
            await createEngine({});
            makeMaterial();
        }
    `);

    assert.match(
        result.manifest.customShaderPrograms[0]?.vertexSource ?? "",
        /shaderUniforms\.bblDynamicDepthBias/,
    );
    assert.deepEqual(
        result.manifest.customShaderPrograms[0]?.uniforms,
        ["worldViewProjection", "bblDynamicDepthBias:f32"],
    );
    assert.match(
        result.cpp,
        /bbl::set_shader_uniform_value\([^;]*, 0u, static_cast<float>\([^)]*depthBias\)\);/,
    );
});

test("preserves shader-material identity through a typed class field", () => {
    const result = compileSource(`
        import {
            createEngine,
            createShaderMaterial,
            setShaderFloat,
            type ShaderMaterial,
        } from "babylon-lite";

        const vertexSource = \`struct VertexOutput {
            @builtin(position) position: vec4<f32>,
        };
        @vertex fn mainVertex(input: VertexInput) -> VertexOutput {
            var out: VertexOutput;
            out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position, 1.0);
            return out;
        }\`;
        const fragmentSource = \`@fragment fn mainFragment() -> @location(0) vec4<f32> {
            return vec4<f32>(shaderUniforms.brightness);
        }\`;

        class MaterialOwner {
            private readonly material: ShaderMaterial;

            constructor() {
                this.material = createShaderMaterial({
                    name: "class-owned",
                    vertexSource,
                    fragmentSource,
                    attributes: ["position"],
                    uniforms: [
                        "worldViewProjection",
                        { name: "brightness", type: "f32", defaultValue: 1 },
                    ],
                });
                setShaderFloat(this.material, "brightness", 2.4);
            }
        }

        async function main() {
            await createEngine({});
            const owner = new MaterialOwner();
        }
    `);

    assert.deepEqual(result.manifest.shaderVariants, ["class-owned"]);
    assert.match(
        result.cpp,
        /bbl::set_scene_shader_uniform_value\([^;]*, 0u, 0u, 2\.4f\);/,
    );
});

test("carries pixels textures through typed records and maps", () => {
    const result = compileSource(`
        import {
            createEngine,
            createShaderMaterial,
            createTexture2DFromPixels,
            setShaderTexture,
            type Texture2D,
        } from "babylon-lite";

        interface CachedImage {
            texture: Texture2D;
            width: number;
            height: number;
        }

        const vertexSource = \`struct VertexOutput{@builtin(position) position:vec4<f32>,};
@vertex fn mainVertex(input:VertexInput)->VertexOutput{var out:VertexOutput;out.position=shaderSystem.worldViewProjection*vec4<f32>(input.position,1.0);return out;}\`;
        const fragmentSource = \`@fragment fn mainFragment()->@location(0) vec4<f32>{return textureSample(image,imageSampler,vec2<f32>(0.5));}\`;

        async function main() {
            const engine = await createEngine({});
            const images = new Map<string, CachedImage | null>();
            const texture = createTexture2DFromPixels(
                engine,
                new Uint8Array([255, 0, 0, 255]),
                1,
                1,
            );
            images.set("red", { texture, width: 1, height: 1 });
            const cached = images.get("red");
            if (!cached) throw new Error("missing image");
            const material = createShaderMaterial({
                name: "cached-pixels",
                vertexSource,
                fragmentSource,
                attributes: ["position"],
                uniforms: ["worldViewProjection"],
                samplers: ["image"],
            });
            setShaderTexture(material, "image", cached.texture);
        }
    `);

    assert.match(
        result.cpp,
        /bbl::js::Map<std::string, bblscene::CachedImage>/,
    );
    assert.match(result.cpp, /bbl::PixelsTexture texture;/);
    assert.match(result.cpp, /bbl::set_shader_pixels_texture\(/);
});

test("refuses the shader-material sampler and define shapes outside the reached slice", () => {
    // A typed ShaderSamplerDecl changes the declared WGSL texture and
    // sampler types, so it refuses rather than compiling to the float/2d
    // pair a plain string means.
    assert.throws(
        () =>
            compileSource(
                SHADER_SAMPLER_SOURCE(
                    `samplers: [{ name: "albedo", sampleType: "depth" }],`,
                    "return textureSample(albedo,albedoSampler,input.uv);",
                ),
            ),
        /typed sampler declaration is not lowered/,
    );
    // SDL_GPU gives a vertex texture its own register space.
    assert.throws(
        () =>
            compileSource(
                SHADER_SAMPLER_SOURCE(
                    `samplers: ["albedo"],`,
                    "return textureSample(albedo,albedoSampler,input.uv);",
                ).replace(
                    "out.position=shaderSystem.worldViewProjection*vec4<f32>(input.position,1.0);",
                    "out.position=shaderSystem.worldViewProjection*vec4<f32>(input.position,1.0)+textureSample(albedo,albedoSampler,input.uv);",
                ),
            ),
        /read by the vertex stage/,
    );
    // The pin reserves both halves of the generated pair.
    assert.throws(
        () =>
            compileSource(
                SHADER_SAMPLER_SOURCE(
                    `samplers: ["albedo"],
                    defines: { albedoSampler: true },`,
                    "return textureSample(albedo,albedoSampler,input.uv);",
                ),
            ),
        /collides with another generated identifier/,
    );
    // A define carries a static boolean or number and nothing else.
    assert.throws(
        () =>
            compileSource(
                SHADER_SAMPLER_SOURCE(
                    `defines: { TINT: "yes" },`,
                    "if(TINT){return vec4<f32>(1.0,0.0,0.0,1.0);}return vec4<f32>(0.0,0.0,0.0,1.0);",
                ),
            ),
        /Expected a static numeric literal/,
    );
});

test("matches shader variants through parsed WGSL IR", () => {
    const source = readFileSync(
        resolve("corpus/babylon-lite/lab/lite/src/lite/scene163.ts"),
        "utf8",
    ).replace(
        "struct VertexOutput {",
        "// Semantically irrelevant shader comment.\nstruct VertexOutput\n{",
    );
    const result = compileSource(source, {
        fileName: "corpus/babylon-lite/lab/lite/src/lite/scene163.ts",
    });

    assert.deepEqual(
        result.manifest.shaderVariants,
        ["circular-cutout"],
    );
});

test("reports invalid reached WGSL at the shader options", () => {
    const source = readFileSync(
        resolve("corpus/babylon-lite/lab/lite/src/lite/scene163.ts"),
        "utf8",
    ).replace(
        "if(distance(input.uv,vec2<f32>(0.5,0.5))<0.18)",
        "if()",
    );

    assert.throws(
        () =>
            compileSource(source, {
                fileName:
                    "corpus/babylon-lite/lab/lite/src/lite/scene163.ts",
            }),
        /corpus\/babylon-lite\/lab\/lite\/src\/lite\/scene163\.ts:\d+:\d+: Invalid reached shader material WGSL:/,
    );
});

test("compiles shader materials inside a frame-graph render task", () => {
    const source = readFileSync(
        resolve("examples/audit-shader-frame-graph.ts"),
        "utf8",
    );
    const result = compileSource(source, {
        fileName: "examples/audit-shader-frame-graph.ts",
    });

    assert.ok(result.manifest.features.includes("material:shader"));
    assert.ok(
        result.manifest.features.includes("renderer:geometry-output"),
    );
    assert.deepEqual(
        result.manifest.shaderVariants,
        ["alpha-card", "circular-cutout"],
    );
    assert.match(result.cpp, /create_render_task/);
    assert.match(result.cpp, /add_task/);
});

test("compiles Babylon Lite scene 146 geometry outputs and frame graph", () => {
    const source = readFileSync(
        resolve("corpus/babylon-lite/lab/lite/src/lite/scene146.ts"),
        "utf8",
    );
    const result = compileSource(source, {
        fileName: "corpus/babylon-lite/lab/lite/src/lite/scene146.ts",
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
        /scene146-impostor-worldPosition/,
    );
    assert.match(
        result.cpp,
        /double v_fn0_tileW = \(1\.0 \/ 6\.0\)/,
    );
    assert.match(
        result.cpp,
        /scene146-impostor-worldPosition[\s\S]*NormalizedViewport\{\(3\.0 \* v_fn0_tileW\), v_fn0_y, v_fn0_tileW, 0\.15\}/,
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
        resolve("corpus/babylon-lite/lab/lite/src/lite/scene116.ts"),
        "utf8",
    );
    const result = compileSource(source, {
        fileName: "corpus/babylon-lite/lab/lite/src/lite/scene116.ts",
    });

    assert.ok(result.manifest.features.includes("material:no-color-view"));
    assert.ok(result.manifest.features.includes("mesh:torus"));
    assert.ok(result.manifest.features.includes("renderer:geometry-output"));
    assert.match(result.cpp, /bbl::create_render_target_texture/);
    assert.match(result.cpp, /bbl::create_torus/);
    assert.match(result.cpp, /bbl::create_standard_no_color_material_view/);
    assert.match(result.cpp, /bbl::create_pbr_no_color_material_view/);
    assert.match(result.cpp, /bbl::add_render_task_mesh/);
    // 1.23 moved the Standard emissive texture behind its own setter; the
    // scene calls that, and the record write is inside it.
    assert.match(result.cpp, /bbl::set_standard_emissive_texture/);
    assert.match(
        result.cpp,
        /RenderTaskOptions\{"standard-shadow-depth"[\s\S]*v_standardDepthCamera, true, true/,
    );
    assert.match(
        result.cpp,
        /RenderTaskOptions\{"default-render-task"[\s\S]*CameraHandle\{\}, false, true, true, true\}/,
        "the compiler-owned default task must retain the scene background stages",
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
    assert.ok(
        result.manifest.adaptations.some(
            ({ id }) =>
                id === "readable-default-render-task",
        ),
    );
});

test("compiles Babylon Lite scene 145 standard geometry outputs", () => {
    const source = readFileSync(
        resolve("corpus/babylon-lite/lab/lite/src/lite/scene145.ts"),
        "utf8",
    );
    const result = compileSource(source, {
        fileName: "corpus/babylon-lite/lab/lite/src/lite/scene145.ts",
    });

    assert.deepEqual(result.manifest.features, [
        "core",
        "backend:sdl",
        "camera:free",
        "loader:babylon",
        "material:standard",
        "frame-graph:resources",
        "renderer:pbr",
        "renderer:geometry-output",
    ]);
    assert.equal(result.manifest.assets[0]?.kind, "babylon");
    assert.match(result.manifest.assets[0]?.output ?? "", /HillValley\/HillValley\.babylon$/);
    assert.match(result.cpp, /bbl::load_babylon/);
    assert.match(result.cpp, /auto v_camera = v_scene\.camera/);
    assert.match(
        result.cpp,
        /\.position = bbl::Vec3d\{\(-26\.695675321687403\)/,
    );
    assert.match(
        result.cpp,
        /double v_fn\d+_y = 0\.85;/,
    );
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

test("compiles a scene-less uniform-effect frame graph without the scene renderer", () => {
    const fileName =
        "corpus/babylon-lite/lab/lite/src/demos/torus-states.ts";
    const source = readFileSync(resolve(fileName), "utf8");
    const result = compileSource(source, { fileName });

    assert.deepEqual(result.manifest.features, [
        "core",
        "backend:sdl",
        "frame-graph:resources",
        "renderer:frame-graph",
        "effect:wrapper",
        "effect:task",
        "renderer:post-process",
    ]);
    assert.deepEqual(result.manifest.runtimeSources, [
        "src/pal.cpp",
        "src/pal_sdl.cpp",
        "src/pal_sdl_gpu_frame_graph.cpp",
    ]);
    assert.ok(
        result.manifest.generatedSources.includes(
            "upstream/src/frame_graph_resources.cpp",
        ),
    );
    assert.ok(
        result.manifest.generatedSources.includes(
            "upstream/src/frame_graph_context.cpp",
        ),
    );
    assert.ok(!result.manifest.features.includes("renderer:pbr"));
    assert.ok(!result.manifest.features.includes("renderer:geometry-output"));
    assert.doesNotMatch(result.cmake, /pal_sdl_gpu\.cpp/);
    assert.match(result.cpp, /bbl::create_frame_graph_context/);
    assert.match(result.cpp, /bbl::on_frame_graph_update/);
    assert.match(
        result.cpp,
        /v_from = std::make_shared<bblscene::MorphStateData>/,
    );
});

test("compiles a scene-less post-process frame graph without effect tasks", () => {
    const fileName = "test/fixtures/frame-graph-post-process-only.ts";
    const result = compileSource(readFileSync(resolve(fileName), "utf8"), {
        fileName,
    });

    assert.deepEqual(result.manifest.features, [
        "core",
        "backend:sdl",
        "frame-graph:resources",
        "renderer:frame-graph",
        "renderer:post-process",
    ]);
    assert.ok(!result.manifest.features.includes("effect:wrapper"));
    assert.ok(!result.manifest.features.includes("effect:task"));
    assert.doesNotMatch(result.cpp, /create_effect_render_task/);
});

test("compiles Babylon Lite scene 248 external glTF", () => {
    const source = readFileSync(resolve("corpus/babylon-lite/lab/lite/src/lite/scene248.ts"), "utf8");
    const result = compileSource(source, {
        fileName: "corpus/babylon-lite/lab/lite/src/lite/scene248.ts",
    });

    const asset = result.manifest.assets.find(({ kind }) => kind === "gltf");
    assert.equal(asset?.output.endsWith(".glb"), true);
    assert.match(asset?.source ?? "", /TextureSettingsTest\.gltf$/);
    assert.match(result.cpp, /\.fov = 0\.8;/);
    assert.match(result.cpp, /\.near_plane =/);
    assert.match(result.cpp, /\.far_plane =/);
});

test("compiles animated and skinned glTF scenes", () => {
    for (const sourcePath of [
        "corpus/babylon-lite/lab/lite/src/lite/scene5.ts",
        "corpus/babylon-lite/lab/lite/src/lite/scene240.ts",
        "corpus/babylon-lite/lab/lite/src/lite/scene245.ts",
        "examples/regression-track-clamp.ts",
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
        "corpus/babylon-lite/lab/lite/src/lite/scene150.ts",
        "corpus/babylon-lite/lab/lite/src/lite/scene151.ts",
        "corpus/babylon-lite/lab/lite/src/lite/scene154.ts",
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
        if (sourcePath.endsWith("scene150.ts")) {
            assert.match(
                result.cpp,
                /create_property_animation_clip\("xSlide", \{.*\}, 10\.0f\)/,
            );
        }
    }
});

test("compiles Babylon Lite scene 249 vertex alpha clip", () => {
    const source = readFileSync(
        resolve("corpus/babylon-lite/lab/lite/src/lite/scene249.ts"),
        "utf8",
    );
    const result = compileSource(source, {
        fileName: "corpus/babylon-lite/lab/lite/src/lite/scene249.ts",
    });
    const asset = result.manifest.assets.find(({ kind }) => kind === "gltf");
    assert.match(asset?.source ?? "", /VertexColorAlphaClipTest\.gltf$/);
    assert.equal(asset?.output.endsWith(".glb"), true);
    assert.ok(result.manifest.features.includes("loader:gltf"));
    assert.ok(result.manifest.features.includes("renderer:pbr"));
});

test("compiles Babylon Lite scene 7 camera target assignment", () => {
    const source = readFileSync(
        resolve("corpus/babylon-lite/lab/lite/src/lite/scene7.ts"),
        "utf8",
    );
    const result = compileSource(source, {
        fileName: "corpus/babylon-lite/lab/lite/src/lite/scene7.ts",
    });
    assert.ok(result.manifest.features.includes("loader:gltf"));
    assert.ok(result.manifest.features.includes("camera:default"));
    assert.match(
        result.cpp,
        /\.target = bbl::Vec3d\{\(-0\.025979936122894287\), 1\.6681787837296724, 0\.4591848850250244\}/,
    );
    assert.match(result.cpp, /\.fixed_delta_ms = 16\.0f/);
});

test("compiles Babylon Lite scene 35 camera target destructuring", () => {
    const source = readFileSync(
        resolve("corpus/babylon-lite/lab/lite/src/lite/scene35.ts"),
        "utf8",
    );
    const result = compileSource(source, {
        fileName: "corpus/babylon-lite/lab/lite/src/lite/scene35.ts",
    });
    assert.ok(result.manifest.features.includes("loader:gltf"));
    assert.ok(result.manifest.features.includes("camera:default"));
    assert.match(result.cpp, /\.alpha \+= 3\.141592653589793;/);
    assert.match(
        result.cpp,
        /\[\[maybe_unused\]\] static double v_x = v_engine\.cameras\[v_cam\.value\]\.target\.x;/,
    );
    assert.match(
        result.cpp,
        /\[\[maybe_unused\]\] static double v_z = v_engine\.cameras\[v_cam\.value\]\.target\.z;/,
    );
});

test("keeps generated scene locals and equality conditions warning-clean", () => {
    const compileScene = (id: string) => {
        const sourcePath =
            `corpus/babylon-lite/lab/lite/src/lite/${id}.ts`;
        return compileSource(
            readFileSync(resolve(sourcePath), "utf8"),
            { fileName: sourcePath },
        ).cpp;
    };

    const navigation = compileScene("scene170");
    assert.match(navigation, /if \(v_frame == 3\.0\)/);
    assert.doesNotMatch(navigation, /if \(\(v_frame == 3\.0\)\)/);

    const splat = compileScene("scene120");
    assert.match(
        splat,
        /\[\[maybe_unused\]\] auto v_splat = bbl::load_splat/,
    );

    const importedCamera = compileScene("scene250");
    assert.match(
        importedCamera,
        /\[\[maybe_unused\]\] bool v_bblite_asset_camera_found_\d+ = false;/,
    );

    const discardedMarker = compileScene("scene175");
    assert.match(
        discardedMarker,
        /static_cast<void>\(v_fn\d+_sphere\);/,
    );
    assert.doesNotMatch(discardedMarker, /^\s*v_fn\d+_sphere;$/m);
});

test("compiles Babylon Lite scene 216 PBR fog", () => {
    const source = readFileSync(
        resolve("corpus/babylon-lite/lab/lite/src/lite/scene216.ts"),
        "utf8",
    );
    const result = compileSource(source, {
        fileName: "corpus/babylon-lite/lab/lite/src/lite/scene216.ts",
    });
    assert.ok(result.manifest.features.includes("renderer:fog"));
    assert.ok(result.manifest.features.includes("renderer:pbr"));
    assert.match(
        result.cpp,
        /bbl::set_scene_fog\(v_scene, 3\.0f, 0\.0f, 12\.0f, 60\.0f, bbl::Color3\{0\.7f, 0\.75f, 0\.82f\}\)/,
    );
});

test("compiles Babylon Lite scene 3 Standard fog and image skybox", () => {
    const source = readFileSync(
        resolve("corpus/babylon-lite/lab/lite/src/lite/scene3.ts"),
        "utf8",
    );
    const result = compileSource(source, {
        fileName: "corpus/babylon-lite/lab/lite/src/lite/scene3.ts",
    });
    assert.ok(result.manifest.features.includes("renderer:fog"));
    assert.ok(result.manifest.features.includes("material:standard"));
    assert.ok(
        result.manifest.features.includes("background:image-skybox"),
    );
    assert.ok(
        result.manifest.generatedSources.includes(
            "upstream/src/image_skybox.cpp",
        ),
    );
    const faces = result.manifest.assets.filter(({ source: url }) =>
        /skybox_[pn][xyz]\.jpg$/.test(url),
    );
    assert.equal(faces.length, 6);
    assert.match(
        result.cpp,
        /bbl::set_scene_fog\(v_scene, 1\.0f, 0\.02f, 0\.0f, 1000\.0f, bbl::Color3\{0\.9f, 0\.9f, 0\.85f\}\)/,
    );
    assert.match(result.cpp, /bbl::load_image_skybox\(v_scene, /);
});

test("writes lighting-only environment rotation into native scene state", () => {
    const result = compileSource(`
        import {
            createEngine,
            createSceneContext,
            loadEnvironment,
            setEnvironmentRotation,
        } from "babylon-lite";

        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            await loadEnvironment(scene, "/studio.env", {
                skipSkybox: true,
                skipGround: true,
                brdfUrl: "/brdf-lut.png",
            });
            setEnvironmentRotation(scene, 1.9);
        }
    `);

    assert.ok(result.manifest.features.includes("environment:ibl"));
    assert.match(
        result.cpp,
        /v_scene\.environment\.rotation_y = 1\.9f;/,
    );
});

test("accepts the DDS loader's inert skybox and ground skip flags", () => {
    const result = compileSource(`
        import {
            createEngine,
            createSceneContext,
            loadDdsEnvironment,
        } from "babylon-lite";

        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            await loadDdsEnvironment(scene, "/studio.dds", {
                brdfUrl: "/brdf-lut.png",
                skipSkybox: true,
                skipGround: true,
            });
        }
    `);

    assert.ok(result.manifest.features.includes("environment:ibl"));
    assert.ok(result.manifest.features.includes("environment:dds"));
    assert.deepEqual(
        result.manifest.assets.map(({ source, kind }) => ({ source, kind })),
        [
            {
                source: pinnedAssetUrl("lab/public/studio.dds"),
                kind: "dds-environment",
            },
            {
                source: pinnedAssetUrl(
                    "packages/babylon-lite/assets/brdf-lut.png",
                ),
                kind: "texture",
            },
        ],
    );
    assert.match(result.cpp, /bbl::load_dds_environment\(/);
    assert.doesNotMatch(result.cpp, /skipSkybox|skipGround/);
});

test("does not activate IBL from environment rotation alone", () => {
    const result = compileSource(`
        import {
            createEngine,
            createSceneContext,
            setEnvironmentRotation,
        } from "babylon-lite";

        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            setEnvironmentRotation(scene, 1.9);
        }
    `);

    assert.ok(!result.manifest.features.includes("environment:ibl"));
    assert.match(
        result.cpp,
        /v_scene\.environment\.rotation_y = 1\.9f;/,
    );
});

test("rejects rotating a visible environment skybox in either call order", () => {
    const prelude = `
        import {
            createEngine,
            createSceneContext,
            loadEnvironment,
            setEnvironmentRotation,
        } from "babylon-lite";

        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
    `;
    const visibleSkybox = `
        await loadEnvironment(scene, "/studio.env", {
            skyboxUrl: "/studio.env",
            skipGround: true,
        });
    `;

    assert.throws(
        () =>
            compileSource(
                `${prelude}${visibleSkybox}
                    setEnvironmentRotation(scene, 1.9);
                }`,
            ),
        /rotating one requires native skybox rotation support/,
    );
    assert.throws(
        () =>
            compileSource(
                `${prelude}
                    setEnvironmentRotation(scene, 1.9);
                    ${visibleSkybox}
                }`,
            ),
        /Loading a visible environment skybox after setEnvironmentRotation requires native skybox rotation support/,
    );
});

test("tracks environment rotation boundaries through scene parameters", () => {
    assert.throws(
        () =>
            compileSource(`
                import {
                    createEngine,
                    createSceneContext,
                    loadEnvironment,
                    setEnvironmentRotation,
                } from "babylon-lite";
                import type { SceneContext } from "babylon-lite";

                async function addSkybox(scene: SceneContext) {
                    await loadEnvironment(scene, "/studio.env", {
                        skyboxUrl: "/studio.env",
                        skipGround: true,
                    });
                }

                async function main() {
                    const engine = await createEngine({});
                    const scene = createSceneContext(engine);
                    await addSkybox(scene);
                    setEnvironmentRotation(scene, 1.9);
                }
            `),
        /rotating one requires native skybox rotation support/,
    );
    assert.throws(
        () =>
            compileSource(`
                import {
                    createEngine,
                    createSceneContext,
                    loadEnvironment,
                    setEnvironmentRotation,
                } from "babylon-lite";
                import type { SceneContext } from "babylon-lite";

                function rotate(scene: SceneContext) {
                    setEnvironmentRotation(scene, 1.9);
                }

                async function main() {
                    const engine = await createEngine({});
                    const scene = createSceneContext(engine);
                    rotate(scene);
                    await loadEnvironment(scene, "/studio.env", {
                        skyboxUrl: "/studio.env",
                        skipGround: true,
                    });
                }
            `),
        /Loading a visible environment skybox after setEnvironmentRotation requires native skybox rotation support/,
    );
});

test("rejects setFog with a runtime fog mode", () => {
    assert.throws(
        () =>
            compileSource(
                `import { createEngine, createSceneContext, setFog, registerScene, startEngine } from "babylon-lite";
async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    setFog(scene, { mode: 5 as 0 | 1 | 2 | 3, density: 0.1, start: 0, end: 10, color: [1, 1, 1] });
    await registerScene(scene);
    await startEngine(engine);
}
void main();
`,
                { fileName: "corpus/babylon-lite/lab/lite/src/lite/fog-mode.ts" },
            ),
        /setFog mode must be a static 0 \(none\), 1 \(exp\), 2 \(exp2\), or 3 \(linear\) literal/,
    );
});

// The Standard diffuse slot's accepted set, on both axes a render texture
// has. Each of these refusals has been dead once: the depth-only one was
// written against a flag only a geometry task's depth ever carried, and the
// geometry-attachment one existed only as a PAL run-time throw.
const diffuseSlotScene = (
    imports: string,
    body: string,
): string => `import {
    addToScene,
    createArcRotateCamera,
    createBox,
    createEngine,
    createRenderTargetTexture,
    createSceneContext,
    createStandardMaterial,
    registerScene,
    startEngine,${imports}
} from "babylon-lite";
async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.camera = createArcRotateCamera(0, 1, 8, { x: 0, y: 0, z: 0 });
    const box = createBox(engine, 2);
    const material = createStandardMaterial();
${body}
    box.material = material;
    addToScene(scene, box);
    await registerScene(scene);
    await startEngine(engine);
}
main().catch(console.error);
`;

const renderTarget = (format: string): string =>
    `    const { texture } = createRenderTargetTexture(engine, {
        lbl: "r",${format}
        dFormat: "depth24plus",
        size: { width: 64, height: 64 },
    });
    material.diffuseTexture = texture;`;

test("lowers a colour render target into the Standard diffuse slot", () => {
    const result = compileSource(
        diffuseSlotScene("", renderTarget('\n        format: "rgba8unorm",')),
        {
            fileName: "corpus/babylon-lite/lab/lite/src/lite/diffuse-colour.ts",
        },
    );
    assert.match(result.cpp, /bbl::set_standard_diffuse_render_texture\(/);
    assert.ok(
        result.manifest.features.includes(
            "material:standard-diffuse-render-texture",
        ),
    );
});

test("refuses a depth-only render target in the Standard diffuse slot", () => {
    // The pin's depth arm carries `invertY: false` and the nearest sampler;
    // the setter folds the colour arm, so the aspect has to refuse.
    assert.throws(
        () =>
            compileSource(diffuseSlotScene("", renderTarget("")), {
                fileName:
                    "corpus/babylon-lite/lab/lite/src/lite/diffuse-depth.ts",
            }),
        /diffuseTexture is sampled as colour, so it cannot be a depth attachment/,
    );
});

test("refuses a geometry attachment in the Standard diffuse slot", () => {
    // Ownership, not aspect: a geometry task's MRT attachment is a colour
    // texture, and still not something this slot may name.
    assert.throws(
        () =>
            compileSource(
                diffuseSlotScene(
                    " createGeometryRendererTask, GeometryTextureType,",
                    `    const geometry = createGeometryRendererTask(
        {
            name: "g",
            samples: 1,
            textureDescriptions: [
                { type: GeometryTextureType.WORLD_NORMAL },
            ],
        },
        engine,
        scene,
    );
    material.diffuseTexture = geometry.geometryWorldNormalTexture!;`,
                ),
                {
                    fileName:
                        "corpus/babylon-lite/lab/lite/src/lite/diffuse-geometry.ts",
                },
            ),
        /diffuseTexture accepts render-target textures, received a geometry one/,
    );
});

// The single-frame yield, and the three shapes that must keep refusing.
// `isFrameYield` erases "one more frame has drawn", which this runtime
// satisfies by construction. A count of frames is a different claim, and the
// corpus writes it as a LOOP over the very shape that is erased — so the
// loop, not the expression, is what tells them apart.
const frameYieldScene = (body: string): string => `import {
    createArcRotateCamera,
    createBox,
    createEngine,
    createSceneContext,
    registerScene,
    startEngine,
} from "babylon-lite";
async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.camera = createArcRotateCamera(0, 1, 8, { x: 0, y: 0, z: 0 });
    createBox(engine, 2);
    await registerScene(scene);
    await startEngine(engine);
${body}
}
main().catch(console.error);
`;

const frameYieldFile = {
    fileName: "corpus/babylon-lite/lab/lite/src/lite/frame-yield.ts",
};

test("erases a single-frame yield", () => {
    const result = compileSource(
        frameYieldScene(
            "    await new Promise<void>((r) => requestAnimationFrame(() => r()));",
        ),
        frameYieldFile,
    );
    assert.doesNotMatch(result.cpp, /requestAnimationFrame/);
});

test("registers pre-start application animation loops before rendering", () => {
    const result = compileSource(`
        import { createEngine, startEngine } from "babylon-lite";
        async function main(): Promise<void> {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            let elapsed = 0;
            const tick = (time: number): void => {
                elapsed = time;
                requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
            await startEngine(engine);
        }
        main();
    `);

    assert.match(result.cpp, /animation_frame_callbacks\.push_back/);
    assert.match(
        result.cpp,
        /animation_frame_callbacks\.push_back\(\[&\]\(\[\[maybe_unused\]\] double /,
    );
    assert.doesNotMatch(
        result.cpp,
        /static_cast<float>\(bbl::pal::performance_milliseconds\(\)\)/,
    );
    assert.doesNotMatch(
        result.cpp,
        /post_render_animation_frame_callbacks\.push_back/,
    );
    assert.doesNotMatch(result.cpp, /create_scene_context|register_scene/);
});

test("registers post-start application animation loops after rendering", () => {
    const result = compileSource(`
        import { createEngine, startEngine } from "babylon-lite";
        async function main(): Promise<void> {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            await startEngine(engine);
            let last = performance.now();
            let elapsed = 0;
            let phase = 0;
            phase = 1;
            const tick = (time: number): void => {
                elapsed += time - last;
                last = time;
                requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
        }
        main();
    `);

    assert.match(
        result.cpp,
        /post_render_animation_frame_callbacks\.push_back/,
    );
    assert.match(
        result.cpp,
        /bbl::defer_callback\([^]*static double v_\w*last = bbl::pal::performance_milliseconds\(\);/,
    );
    assert.match(
        result.cpp,
        /bbl::defer_callback\([^]*static double v_\w*elapsed = 0\.0;/,
    );
    assert.match(result.cpp, /v_\w*phase = 1\.0;/);
    assert.doesNotMatch(result.cpp, /static v_\w*phase = 1\.0;/);
});

test("lowers recurring browser timers onto the frame conductor", () => {
    const result = compileSource(`
        import { createEngine, startEngine } from "babylon-lite";
        async function main(): Promise<void> {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            let timer: ReturnType<typeof setInterval> | null = null;
            let ticks = 0;
            const tick = (): void => {
                const previous = ticks;
                ticks = previous + 1;
                if (ticks > 2 && timer !== null) {
                    clearInterval(timer);
                    timer = null;
                }
            };
            timer = setInterval(tick, 30);
            await startEngine(engine);
        }
        main();
    `);

    assert.match(result.cpp, /bbl::set_interval\(v_engine, \[&\]\(\) \{/);
    assert.match(result.cpp, /v_\w*previous = v_\w*ticks/);
    assert.match(result.cpp, /v_\w*ticks = \(v_\w*previous \+ 1\.0\)/);
    assert.match(result.cpp, /bbl::clear_interval\(v_engine,/);
    assert.doesNotMatch(result.cpp, /setInterval|clearInterval/);
});

test("lets recurring timers read persistent factory closure state", () => {
    const result = compileSource(`
        import { createEngine, startEngine } from "babylon-lite";
        async function main(): Promise<void> {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            const makeTimer = () => {
                let ticks = 0;
                const tick = (): void => {
                    const previous = ticks;
                    ticks = previous + 1;
                };
                return { start: (): void => { setInterval(tick, 30); } };
            };
            const timer = makeTimer();
            await startEngine(engine);
            requestAnimationFrame(() => timer.start());
        }
        main();
    `);

    assert.match(result.cpp, /bbl::set_interval\(v_engine, \[&\]\(\) \{/);
    assert.match(result.cpp, /v_\w*ticks = \(v_\w*previous \+ 1\.0\)/);
});

test("refuses recurring timers that capture an outer frame local", () => {
    assert.throws(
        () => compileSource(`
            import { createEngine, startEngine } from "babylon-lite";
            async function main(): Promise<void> {
                const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
                const engine = await createEngine(canvas);
                await startEngine(engine);
                requestAnimationFrame(() => {
                    let frameLocal = 0;
                    setInterval(() => { frameLocal += 1; }, 30);
                });
            }
            main();
        `),
        /deferred callback cannot name 'frameLocal'/,
    );
});

test("refuses a frame yield inside a loop as the multi-frame wait it is", () => {
    assert.throws(
        () =>
            compileSource(
                frameYieldScene(
                    `    for (let i = 0; i < 5; i++) {
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
    }`,
                ),
                frameYieldFile,
            ),
        /frame yield inside a loop is a multi-frame wait/,
    );
});

test("defers the capture behind a promise that resolves on a frame count", () => {
    // Scenes 269 and 270 verbatim: the executor's body is a block that
    // re-arms `requestAnimationFrame` until a counter passes. This is NOT
    // the single-frame yield above and is not erased -- the condition is
    // the scene's own, and upstream it gates `canvas.dataset.ready`, which
    // is the flag the harness screenshots on. So the port keeps it and
    // holds the capture behind it.
    const result = compileSource(
        frameYieldScene(
            `    let frame = 0;
    await new Promise<void>((resolve) => {
        const wait = (): void => (frame > 4 ? resolve() : requestAnimationFrame(wait));
        wait();
    });`,
        ),
        frameYieldFile,
    );
    assert.match(
        result.cpp,
        /bbl::defer_capture_until\([^;]*\[&\]\(\) \{ return [^;]*> 4\.0; \}\);/,
    );
});

test("refuses a nested frame yield, which waits two frames", () => {
    assert.throws(
        () =>
            compileSource(
                frameYieldScene(
                    "    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(r)));",
                ),
                frameYieldFile,
            ),
        /Unsupported expression statement: NewExpression/,
    );
});

// ---------------------------------------------------------------------------
// The line-system family
// ---------------------------------------------------------------------------

const LINE_SCENE = (body: string, imports = ""): string => `
    import { addToScene, createArcRotateCamera, createEngine, createLineSystem, createSceneContext, registerScene, startEngine${imports} } from "babylon-lite";

    async function main(): Promise<void> {
        const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
        const engine = await createEngine(canvas);
        const scene = createSceneContext(engine);
${body}
        scene.camera = createArcRotateCamera(0, 1, 12, { x: 0, y: 0, z: 0 });
        await registerScene(scene);
        await startEngine(engine);
    }
`;

const UNIFORM_LINE_SYSTEM = `        addToScene(
            scene,
            createLineSystem(engine, {
                name: "lines",
                lines: [[{ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }, { x: 2, y: 0, z: 0 }]],
                color: { r: 0.25, g: 0.85, b: 1, a: 1 },
                useVertexAlpha: false,
            }),
        );`;

test("composes the pin's own line material for the permutation a scene reaches", () => {
    const result = compileSource(LINE_SCENE(UNIFORM_LINE_SYSTEM));
    const [program] = result.manifest.customShaderPrograms;
    // The variant's identity is the permutation: the pin names every line
    // material "LineMaterial" while composing a different program per flag
    // set, so a scene reaching two forms registers two variants.
    assert.equal(program?.name, "line-material-opaque");
    assert.equal(program?.topology, "line-list");
    // The two system matrices the pin's own stage reads, plus the uniform a
    // stage with no colour varying declares instead.
    assert.deepEqual(program?.uniforms, [
        "world",
        "viewProjection",
        "lineColor:vec4<f32>",
    ]);
    assert.deepEqual(program?.attributes, ["position"]);
    assert.deepEqual(program?.uniformDefaults, [
        { name: "lineColor", values: [0.25, 0.85, 1, 1] },
    ]);
    // useVertexAlpha false: no blend, so the pin's own depthWrite default
    // resolves the other way.
    assert.equal(program?.needAlphaBlending, false);
    assert.equal(program?.depthWrite, true);
    assert.equal(program?.backFaceCulling, false);
    assert.match(
        program?.vertexSource ?? "",
        /out\.position=shaderSystem\.viewProjection\*finalWorld\*vec4<f32>\(input\.position,1\.0\)/,
    );
    assert.match(
        program?.fragmentSource ?? "",
        /return shaderUniforms\.lineColor;/,
    );
    assert.ok(result.manifest.features.includes("mesh:lines"));
});

test("infers a line system's vertex-colour fork from its geometry", () => {
    const result = compileSource(
        LINE_SCENE(`        addToScene(
            scene,
            createLineSystem(engine, {
                lines: [[{ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }]],
                colors: [[{ r: 1, g: 0, b: 0, a: 1 }, { r: 0, g: 1, b: 0, a: 0.5 }]],
            }),
        );`),
    );
    const [program] = result.manifest.customShaderPrograms;
    assert.equal(program?.name, "line-material-vc");
    assert.deepEqual(program?.attributes, ["position", "color"]);
    // A stage carrying the colour varying declares no uniform at all.
    assert.deepEqual(program?.uniforms, ["world", "viewProjection"]);
    assert.equal(program?.needAlphaBlending, true);
    assert.equal(program?.depthWrite, false);
    assert.match(program?.fragmentSource ?? "", /return input\.color;/);
});

test("reads the thin-instance lanes the pin's own module appends", () => {
    const result = compileSource(
        LINE_SCENE(
            `        const material = createLineMaterial({
            useThinInstances: true,
            useThinInstanceColors: true,
        });
        const mesh = createLineSystem(engine, {
            lines: [[{ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }]],
            material,
        });
        setThinInstances(mesh, new Float32Array(32), 2);
        setThinInstanceColors(mesh, new Float32Array(8));
        addToScene(scene, mesh);`,
            ", createLineMaterial, setThinInstanceColors, setThinInstances",
        ),
    );
    const [program] = result.manifest.customShaderPrograms;
    assert.equal(program?.name, "line-material-ti-tic");
    assert.equal(program?.useThinInstanceColors, true);
    assert.match(
        program?.vertexSource ?? "",
        /let instanceWorld=mat4x4<f32>\(input\.world0,input\.world1,input\.world2,input\.world3\)/,
    );
    assert.match(program?.vertexSource ?? "", /out\.color=input\.instanceColor;/);
    assert.ok(
        result.manifest.features.includes("mesh:thin-instance-colors"),
    );
    // The pool keeps referencing the caller's array, so a temporary is
    // bound to a name whose lifetime is the frame loop.
    assert.match(
        result.cpp,
        /bbl::js::F32Array v_bblite_thin_instances_\d+ = /,
    );
});

test("refuses the line shapes outside the reached slice", () => {
    // The pin throws when a supplied material's vertex-colour setting and
    // the geometry's colour buffer disagree; the compiler knows both.
    assert.throws(
        () =>
            compileSource(
                LINE_SCENE(
                    `        const material = createLineMaterial({ useVertexColor: true });
        addToScene(
            scene,
            createLineSystem(engine, {
                lines: [[{ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }]],
                material,
            }),
        );`,
                    ", createLineMaterial",
                ),
            ),
        /material\.useVertexColor to match the line color-buffer layout/,
    );
    // Instance colours without instances is the pin's own refusal.
    assert.throws(
        () =>
            compileSource(
                LINE_SCENE(
                    `        const material = createLineMaterial({ useThinInstanceColors: true });
        addToScene(scene, createLineSystem(engine, { lines: [[{ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }]], material }));`,
                    ", createLineMaterial",
                ),
            ),
        /requires useThinInstances when useThinInstanceColors is enabled/,
    );
    // A shader material the line factory did not build: it carries a
    // variant like a line material and composes no line-list program.
    assert.throws(
        () =>
            compileSource(
                LINE_SCENE(
                    `        const material = createShaderMaterial({
            name: "plain",
            vertexSource: "struct VertexOutput{@builtin(position) position:vec4<f32>,};@vertex fn mainVertex(input:VertexInput)->VertexOutput{var out:VertexOutput;out.position=shaderSystem.worldViewProjection*vec4<f32>(input.position,1.0);return out;}",
            fragmentSource: "@fragment fn mainFragment()->@location(0) vec4<f32>{return vec4<f32>(1.0,1.0,1.0,1.0);}",
            attributes: ["position"],
            uniforms: ["worldViewProjection"],
        });
        addToScene(scene, createLineSystem(engine, { lines: [[{ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }]], material }));`,
                    ", createShaderMaterial",
                ),
            ),
        /line system's material comes from createLineMaterial/,
    );
    // One colour row per line, one colour per point: both are the pin's own
    // validation, refused at generation where it throws at load.
    assert.throws(
        () =>
            compileSource(
                LINE_SCENE(`        addToScene(
            scene,
            createLineSystem(engine, {
                lines: [[{ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }]],
                colors: [[{ r: 1, g: 0, b: 0, a: 1 }]],
            }),
        );`),
            ),
        /one color per point/,
    );
});

/**
 * A minimal GLB whose JSON chunk declares named animations — what the
 * handle-collection concept's static `.find` reads. No BIN chunk: the
 * members come from the document alone.
 */
function animationGltfFixture(names: readonly string[]): Buffer {
    const document = {
        asset: { version: "2.0" },
        animations: names.map((name) => ({
            name,
            channels: [],
            samplers: [],
        })),
    };
    let json = Buffer.from(JSON.stringify(document), "utf8");
    if (json.length % 4 !== 0) {
        json = Buffer.concat([
            json,
            Buffer.alloc(4 - (json.length % 4), 0x20),
        ]);
    }
    const header = Buffer.alloc(20);
    header.writeUInt32LE(0x46546c67, 0);
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(20 + json.length, 8);
    header.writeUInt32LE(json.length, 12);
    header.writeUInt32LE(0x4e4f534a, 16);
    return Buffer.concat([header, json]);
}

/** Compiles a scene beside a written animation fixture. */
function compileWithAnimationFixture(
    source: string,
    names: readonly string[],
    options: { search?: string } = {},
): ReturnType<typeof compileSource> {
    const directory = mkdtempSync(
        join(tmpdir(), "bblitec-groups-"),
    );
    try {
        writeFileSync(
            join(directory, "model.glb"),
            animationGltfFixture(names),
        );
        return compileSource(source, {
            fileName: join(directory, "scene.ts"),
            ...(options.search !== undefined
                ? { search: options.search }
                : {}),
        });
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

const HANDLE_COLLECTION_SCENE = (body: string): string => `
    import {
        addAnimationGroups,
        createAnimationManager,
        createEngine,
        enableAnimationBlending,
        loadGltf,
        pauseAnimation,
        playAnimation,
        setAnimationAdditive,
        setAnimationWeight,
        stopAnimation,
    } from "@babylonjs/lite";
    import type { AnimationGroup } from "@babylonjs/lite";

    function requireGroup(
        groups: readonly AnimationGroup[],
        name: string,
    ): AnimationGroup {
        const group = groups.find(
            (candidate) => candidate.name === name,
        );
        if (!group) {
            throw new Error(
                \`fixture group "\${name}" was not found\`,
            );
        }
        return group;
    }

    async function main() {
        const engine = await createEngine({});
        const container = await loadGltf(engine, "model.glb");
        const manager = createAnimationManager({ engine });
        const groups = container.animationGroups ?? [];
${body}
    }
`;

test("binds a loader group collection, resolves finds statically, and erases the proven-dead throw", () => {
    const result = compileWithAnimationFixture(
        HANDLE_COLLECTION_SCENE(`
        for (const group of groups) {
            stopAnimation(group);
            setAnimationWeight(group, 0);
        }
        const idle = requireGroup(groups, "idle");
        const sadPose = requireGroup(groups, "sad_pose");
        const active = [idle, sadPose];
        addAnimationGroups(manager, active);
        playAnimation(idle);
        playAnimation(sadPose);
        setAnimationAdditive(sadPose, { referenceFrame: 0 });
        setAnimationWeight(sadPose, 1);
        for (const group of active) {
            group.currentTime = group === sadPose ? 0.25 : 1.5;
            pauseAnimation(group);
        }
        enableAnimationBlending(manager);
        `),
        ["idle", "agree", "sad_pose"],
    );

    // The bound collection iterates as the same native loop the inline
    // property read emits.
    assert.match(
        result.cpp,
        /for \(const bbl::AnimationGroupHandle [^ ]+ : v_engine\.assets\[v_container\.value\]\.animation_groups\)/,
    );
    // The finds resolved against the materialized document: idle is
    // animation 0, sad_pose animation 2 — no search loop, no found flag.
    assert.match(result.cpp, /\.animation_groups\[0\]/);
    assert.match(result.cpp, /\.animation_groups\[2\]/);
    assert.doesNotMatch(result.cpp, /_match/);
    assert.doesNotMatch(result.cpp, /_found/);
    // The scene's own not-found guard read a constant truth, so its
    // throw arm erased.
    assert.doesNotMatch(result.cpp, /was not found/);
    // The tuple local reaches addAnimationGroups as the selected pair.
    assert.match(
        result.cpp,
        /bbl::add_animation_groups\([^;]*std::vector<bbl::AnimationGroupHandle>\{v_idle, v_sadPose\}\)/,
    );
    // setAnimationAdditive: frame zero through the pinned conversion.
    assert.match(
        result.cpp,
        /bbl::set_animation_additive_from_frame\(v_engine, [^,]+, 0\.0f\)/,
    );
    // The handle ternary folded per unrolled element: the additive pose
    // keeps its own time, the other group takes the seek value.
    assert.match(
        result.cpp,
        /bbl::set_animation_current_time\(v_engine, [^,]+, 0\.25\)/,
    );
    assert.match(
        result.cpp,
        /bbl::set_animation_current_time\(v_engine, [^,]+, 1\.5\)/,
    );
    assert.ok(
        result.manifest.features.includes(
            "animation:gltf-additive",
        ),
    );
    assert.ok(
        result.manifest.features.includes(
            "animation:gltf-group-time",
        ),
    );
});

test("a find the materialized asset cannot serve fails generation with the scene's own message", () => {
    assert.throws(
        () =>
            compileWithAnimationFixture(
                HANDLE_COLLECTION_SCENE(`
        const missing = requireGroup(groups, "missing");
        playAnimation(missing);
                `),
                ["idle", "agree", "sad_pose"],
            ),
        /fixture group "missing" was not found[\s\S]*'idle', 'agree', 'sad_pose'/,
    );
});

test("an inline collection find keeps the loaded search loop and the runtime guard", () => {
    // The pre-concept shape (scene 157): the collection never travels, so
    // the search stays a real loop and the scene's guard reads its found
    // flag — byte-shape pinned so the concept's static path cannot leak
    // into it.
    const result = compileWithAnimationFixture(
        `
        import {
            createEngine,
            loadGltf,
            playAnimation,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const container = await loadGltf(engine, "model.glb");
            const walk = container.animationGroups?.find(
                (group) => group.name === "walk",
            );
            if (!walk) {
                throw new Error("walk was not found");
            }
            playAnimation(walk);
        }
        `,
        ["walk", "run"],
    );
    assert.match(result.cpp, /_match/);
    assert.match(result.cpp, /_found/);
    assert.match(
        result.cpp,
        /throw std::runtime_error\("walk was not found"\);/,
    );
    assert.doesNotMatch(result.cpp, /\.animation_groups\[0\]/);
});

test("handle identity compares at run time when a side has no generation-known slot", () => {
    const result = compileWithAnimationFixture(
        HANDLE_COLLECTION_SCENE(`
        const idle = requireGroup(groups, "idle");
        for (const group of groups) {
            group.currentTime = group === idle ? 0.25 : 1.5;
        }
        `),
        ["idle", "agree"],
    );
    assert.match(
        result.cpp,
        /\.value == v_idle\.value\) \? 0\.25 : 1\.5\)/,
    );
});

test("setAnimationAdditive resolves its options at generation exactly where the pin throws", () => {
    // The mutual exclusion.
    assert.throws(
        () =>
            compileWithAnimationFixture(
                HANDLE_COLLECTION_SCENE(`
        const idle = requireGroup(groups, "idle");
        setAnimationAdditive(idle, { referenceFrame: 0, referenceTime: 1 });
                `),
                ["idle"],
            ),
        /not both/,
    );
    // The finite/non-negative reference guard.
    assert.throws(
        () =>
            compileWithAnimationFixture(
                HANDLE_COLLECTION_SCENE(`
        const idle = requireGroup(groups, "idle");
        setAnimationAdditive(idle, { referenceFrame: -1 });
                `),
                ["idle"],
            ),
        /finite non-negative/,
    );
    // The referenceTime arm passes the value through untouched, and no
    // options means frame zero.
    const result = compileWithAnimationFixture(
        HANDLE_COLLECTION_SCENE(`
        const idle = requireGroup(groups, "idle");
        const other = requireGroup(groups, "agree");
        setAnimationAdditive(idle, { referenceTime: 0.5 });
        setAnimationAdditive(other);
        `),
        ["idle", "agree"],
    );
    assert.match(
        result.cpp,
        /bbl::set_animation_additive\(v_engine, [^,]+, 0\.5f\)/,
    );
    assert.match(
        result.cpp,
        /bbl::set_animation_additive_from_frame\(v_engine, [^,]+, 0\.0f\)/,
    );
});

test("every pinned package spelling reaches the served module", () => {
    // `capture-suite-reference.ts` rewrites specifiers with a regex literal
    // and `compiler/symbols.ts` dispatches them with a predicate. Neither can
    // read the other, so this is what keeps the two lists the same one.
    for (const packageName of babylonPackages) {
        assert.match(
            pinnedPackageSpecifiers(`import x from "${packageName}";`),
            /"\/node_modules\/@babylonjs\/lite\/lib\/index\.js"/,
            `${packageName} is not rewritten to the served module.`,
        );
        assert.match(
            pinnedPackageSpecifiers(`import x from "${packageName}/mesh/a";`),
            /"\/node_modules\/@babylonjs\/lite\/lib\/mesh\/a\.js"/,
            `${packageName} subpaths are not rewritten to the served module.`,
        );
        assert.ok(
            isBabylonModule(packageName) &&
                isBabylonModule(`${packageName}/mesh/a`),
        );
    }
});

test("a mesh search by name selects at run time, with an indexed fallback and the record names the factories pin", () => {
    const result = compileSource(
        `
        import {
            createEngine,
            createSceneContext,
            createSphere,
            addToScene,
            registerScene,
            startEngine,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            const sphere = createSphere(engine, { diameter: 1 });
            sphere.name = "hero";
            addToScene(scene, sphere);
            const found = scene.meshes.find(
                (m) => m.name === "hero",
            ) ?? scene.meshes[0];
            if (!found) {
                throw new Error("no mesh");
            }
            found.position.y = 1;
            await registerScene(scene);
            await startEngine(engine);
        }

        void main();
        `,
        { fileName: "examples/mesh-name-find.ts" },
    );
    // The scene's write lands on the record the factory named.
    assert.match(result.cpp, /\.name = "hero";/);
    // The search is the loaded loop over record names, and the miss
    // selects the fallback...
    assert.match(
        result.cpp,
        /std::string\([^\n]*\.name\) == std::string\("hero"\)/,
    );
    assert.match(
        result.cpp,
        /_found_\d+ \? \w*_match_\d+ : \w*_at_\d+/,
    );
    // ...and the fallback is the guarded element read whose flag
    // composes into the scene's own not-found guard.
    assert.match(result.cpp, /_present_\d+ = \w+ < v_scene\.meshes\.size\(\)/);
    assert.match(result.cpp, /_found_\d+ \|\| \w*_present_\d+/);
});

test("fuses a mesh-material map/find and replaces an asset occlusion texture before startup", () => {
    const result = compileSource(
        `
        import {
            addToScene,
            createEngine,
            createSceneContext,
            createSolidTexture2D,
            loadGltf,
            rebuildMaterial,
            registerScene,
            startEngine,
        } from "@babylonjs/lite";
        import type { PbrMaterialProps } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            const asset = await loadGltf(engine, "/model.glb");
            addToScene(scene, asset);
            await registerScene(scene);
            const material = scene.meshes
                .map((mesh) => mesh.material)
                .find((candidate): candidate is PbrMaterialProps =>
                    !!candidate && candidate.name === "metalmat",
                );
            if (material?.occlusionTexture) {
                material.occlusionTexture =
                    createSolidTexture2D(engine, 1, 1, 1);
                rebuildMaterial(scene, material, {
                    rebuildFrameGraph: true,
                });
            }
            await startEngine(engine);
        }

        void main();
        `,
        { fileName: "examples/material-map-find.ts" },
    );

    assert.match(result.cpp, /for \(const bbl::MeshHandle/);
    assert.match(
        result.cpp,
        /\.materials\[[^\]]+\]\.name/,
    );
    assert.match(
        result.cpp,
        /if \([^\n]*material\.value != bbl::invalid_handle[^\n]*\) \{\n\s+auto [^\n]+;\n\s+const bbl::js::Nullable<std::string>[^\n]*\.materials\[/,
    );
    assert.match(result.cpp, /optional_compare[^\n]*== "metalmat"/);
    assert.match(result.cpp, /bbl::set_pbr_occlusion_solid_texture\(/);
    assert.doesNotMatch(result.cpp, /rebuild_material/);
});

test("refuses rebuildMaterial after native startup has begun", () => {
    assert.throws(
        () =>
            compileSource(`
                import {
                    createEngine,
                    createPbrMaterial,
                    createSceneContext,
                    rebuildMaterial,
                    startEngine,
                } from "@babylonjs/lite";
                async function main() {
                    const engine = await createEngine({});
                    const scene = createSceneContext(engine);
                    const material = createPbrMaterial({});
                    await startEngine(engine);
                    rebuildMaterial(scene, material);
                }
                void main();
            `),
        /live GPU material resource replacement/,
    );
});
