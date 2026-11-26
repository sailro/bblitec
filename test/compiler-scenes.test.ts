import assert from "node:assert/strict";
import { regexText } from "./regex.js";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { UpstreamSourceStore } from "../src/upstream-source.js";
import { CompileError, compileSource } from "../src/compiler.js";
import {
    transpileCommonJs,
    createJavaScriptFunction,
} from "../src/typescript-transpile.js";
import {
    assertCameraScalarWrite,
    labDeployment,
    pinnedAssetUrl,
} from "./compiler-fixtures.js";

test("compiles the Babylon Lite primitives example", () => {
    const source = readFileSync(resolve("examples/primitives.ts"), "utf8");
    const result = compileSource(source, {
        fileName: "examples/primitives.ts",
    });

    assert.deepEqual(result.manifest.features, [
        "core",
        "backend:sdl",
        "camera:arc-rotate",
        "light:hemispheric",
        "material:standard",
        "mesh:box",
        "mesh:ground",
        "renderer:scene",
    ]);
    assert.deepEqual(result.manifest.assets, []);
    assert.deepEqual(result.manifest.runtimeSources, [
        "src/pal.cpp",
        "src/pal_sdl.cpp",
        "src/pal_image.cpp",
        "src/pal_sdl_gpu.cpp",
    ]);
    assert.deepEqual(
        result.manifest.adaptations.map(({ id }) => id),
        [
            "entry-main-wrapper-erasure",
            "browser-setup-erasure",
            "synchronous-aot-await",
            "plain-data-value-model",
            "sdl-platform-boundary",
            "sdl-gpu-shader-backends",
            "shared-material-vertex-transport",
        ],
    );
    assert.deepEqual(result.manifest.generatedSources, [
        "upstream/src/engine.cpp",
        "upstream/src/scene_core.cpp",
        "upstream/src/variant_data.cpp",
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
    assert.match(result.cpp, /bbl::set_material_diffuse_color\(/);
    assert.match(result.cpp, /bbl::start_engine/);
    assert.doesNotMatch(result.cpp, /document|getElementById|Promise/);
    assert.match(result.cmake, /mesh_factories\.cpp/);
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

test("a light read out of a record writes through its typed kind's setters", () => {
    // The record keeps the light's handle, not its factory: the pinned
    // interface it is declared as names the kind, through an asserted
    // intersection too.
    const result = compileSource(`
        import { createEngine, createDirectionalLight, createHemisphericLight } from "@babylonjs/lite";
        import type { DirectionalLight, HemisphericLight } from "@babylonjs/lite";
        interface Lighting { sky: HemisphericLight; sun: DirectionalLight }
        function apply(lighting: Lighting, k: number): void {
            const sun = lighting.sun as DirectionalLight & { _bumpLightVersion?: () => void };
            sun.intensity = k;
            sun.direction.x = k;
            lighting.sun.diffuse = [k, k, k];
            lighting.sky.groundColor = [k, k, k];
            lighting.sky.direction.set(0, 1, k);
        }
        async function main() {
            const engine = await createEngine({});
            const lighting: Lighting = { sun: createDirectionalLight([0, -1, 0]), sky: createHemisphericLight() };
            const all: Lighting[] = [lighting];
            for (let i = 0; i < 2; i++) apply(all[i % 1]!, i * 0.5);
        }
    `);
    assert.match(result.cpp, /\.lights, \(v_\w+\)\.second\)\.intensity = /);
    assert.match(
        result.cpp,
        /bbl::set_light_direction_component\(v_engine, \(v_\w+\)\.second, 0u, /,
    );
    assert.match(result.cpp, /\.second\)\.diffuse_color = bbl::Color3\{/);
    assert.match(result.cpp, /\.second\)\.ground_color = bbl::Color3\{/);
    assert.match(
        result.cpp,
        /bbl::set_hemispheric_light_direction\(v_engine, \(v_\w+->sky\)\.second, /,
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
            const engine = await createEngine(document.createElement("canvas"));
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
        result.manifest.scenePbrMaterials.map(
            ({ sceneMeshIndices }) => sceneMeshIndices,
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

test("connects an audio node to an AudioParam modulation target", () => {
    const result = compileSource(`
        import { createAudioEngineAsync } from "@babylonjs/lite";
        async function main() {
            const audio = await createAudioEngineAsync();
            const lfo = audio.audioContext.createOscillator();
            const scale = audio.audioContext.createGain();
            const output = audio.audioContext.createGain();
            lfo.connect(scale).connect(output.gain);
        }
    `);

    assert.ok(result.manifest.features.includes("audio:engine"));
    assert.ok(result.manifest.features.includes("audio:oscillator"));
    // `connect(param)` as the Web Audio records spell it.
    assert.match(
        result.cpp,
        /bbl::pal::audio_connect\([^\n]*\(bbl::pal::audio_node_param\(v_output, bbl::pal::AudioParamName::Gain\)\)/,
    );
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
    assert.match(
        result.cpp,
        /audio_param_set_value\([^;]*, static_cast<float>\(\(-0\.25\)\)\);/,
    );
    assert.match(result.cpp, /v_tail = v_block\d+_panner;/);
});

test("passes sampled-source start offsets and durations to the audio PAL", () => {
    const result = compileSource(`
        import { createAudioEngineAsync } from "@babylonjs/lite";
        const audio = await createAudioEngineAsync();
        const context = audio.audioContext;
        const source = context.createBufferSource();
        source.buffer = context.createBuffer(1, 48000, 48000);
        source.start(context.currentTime, 0.25);
        source.start(context.currentTime, 0.5, 0.75);
    `);

    assert.match(result.cpp, /audio_node_start\([^;]+, 0\.25,?\)/);
    assert.match(result.cpp, /audio_node_start\([^;]+, 0\.5, 0\.75\)/);
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

    assert.match(result.cpp, /bbl::on_dom_keyboard\([^\n]*"keydown"/);
    assert.match(result.cpp, /bbl::pal::audio_set_loop\([^;]*, true\);/);
    assert.match(
        result.cpp,
        /AudioParamName::PlaybackRate\), static_cast<float>\(0\.75\)\);/,
    );
    assert.match(
        result.cpp,
        /if \(v_fn\d+_ctx\.has_value\(\)\) \{\s+v_bblite_class_field__ctx_\d+ = \*v_fn\d+_ctx;/,
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
        /audio_param_set_value\([^;]*, static_cast<float>\(0\.6\)\);/,
    );
    assert.match(
        result.cpp,
        /\(\*v_bblite_class_field_context_\d+\) = v_[^;]*engine\.context;/,
    );
    assert.match(
        result.cpp,
        /\(\*v_bblite_class_field_output_\d+\) = v_[^;]*output;/,
    );
    assert.match(
        result.cpp,
        /audio_param_set_value\([^;]*, static_cast<float>\(0\.4\)\);/,
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

test("returns a nullable audio context through early value returns", () => {
    const result = compileSource(`
        import { createAudioEngineAsync } from "@babylonjs/lite";

        let context: BaseAudioContext | null = null;
        function currentContext(): BaseAudioContext | null {
            if (context) return context;
            return null;
        }
        const audio = await createAudioEngineAsync();
        context = audio.audioContext;
        const current = currentContext();
        if (current) current.createGain();
    `);

    assert.match(
        result.cpp,
        /bbl::js::Nullable<bbl::pal::AudioContextHandle> bbl_recursive_\w+\(/,
    );
    assert.match(result.cpp, /audio_create_gain\(\(\*v_current\)\)/);
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
        /const float (v_bblite_light_component_\d+) = 2\.0f;\s*bbl::set_light_position_component\([^;]*, 0u, \1\);/,
    );
    assert.match(
        point.cpp,
        /const float (v_bblite_light_component_\d+) = 4\.0f;\s*bbl::set_light_position_component\([^;]*, 2u, \1\);/,
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
        result.manifest.generatedSources.includes("upstream/src/physics.cpp"),
    );
});

test("rejects unknown or unsupported mesh factory options", () => {
    for (const [call, message] of [
        [
            "createBox(engine, { diamater: 2 });",
            "Box options support size, width, height, and depth.",
        ],
        [
            'createBox(engine, { ...JSON.parse("{}") });',
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
                assert.match(error.message, new RegExp(regexText(message)));
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

    // A registered scene renders (its clear color at least), so the scene
    // renderer and the camera modules it reads are reached.
    assert.deepEqual(result.manifest.features, [
        "core",
        "backend:sdl",
        "mesh:box",
        "renderer:scene",
    ]);
    assert.deepEqual(result.manifest.generatedSources, [
        "upstream/src/engine.cpp",
        "upstream/src/scene_core.cpp",
        "upstream/src/variant_data.cpp",
        "upstream/src/camera_arc_rotate.cpp",
        "upstream/src/camera_controls.cpp",
        "upstream/src/renderer_plan.cpp",
        "upstream/src/mesh_factories.cpp",
    ]);
    assert.doesNotMatch(result.cmake, /material_standard|mesh_ground/);
});

test("resolves pinned Babylon types independently of cwd", () => {
    const previous = process.cwd();
    const temporary = mkdtempSync(join(tmpdir(), "bblitec-compiler-"));
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
                fileName: resolve(previous, "examples", "cwd-probe.ts"),
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

test("keeps auxiliary surfaces distinct from their owning engine", () => {
    const result = compileSource(`
        import {
            createEngine,
            createSurface,
            createSceneContext,
            disposeSurface,
            enableSurfaceResizeObserver,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const canvas = document.createElement("canvas");
            document.body.appendChild(canvas);
            const surface = createSurface(engine, canvas);
            const cancelPrimary = enableSurfaceResizeObserver(engine);
            const cancelAuxiliary = enableSurfaceResizeObserver(surface);
            cancelPrimary();
            cancelAuxiliary();
            const scene = createSceneContext(surface);
            const primary = createSceneContext(surface.engine);
            disposeSurface(surface);
        }
    `);

    assert.match(
        result.cpp,
        /auto v_surface = bbl::create_surface\(v_engine, v_canvas\);/,
    );
    assert.match(result.cpp, /bbl::create_scene_context\(v_surface\)/);
    assert.match(result.cpp, /bbl::dispose_surface\(v_surface\)/);
    assert.doesNotMatch(result.cpp, /auto v_surface = v_engine;/);
});

test("shares handle-touching methods beside native siblings", () => {
    const result = compileSource(`
        import {
            createBox,
            createEngine,
        } from "@babylonjs/lite";
        class Spinner {
            speed = 2;
            spin(mesh: Mesh, dt: number): void {
                mesh.rotation.y += this.speed * dt;
            }
            rate(dt: number): number {
                return this.speed * dt;
            }
        }
        async function main(): Promise<void> {
            const engine = await createEngine({});
            const spinner = new Spinner();
            const box = createBox(engine, 1);
            spinner.spin(box, 0.1);
            spinner.spin(box, 0.2);
            const r = spinner.rate(0.5);
        }
        main();
    `);

    // Handle parameters use a shared closure over their instance metadata.
    assert.doesNotMatch(result.cpp, /bblscene::Spinner_spin/);
    assert.equal(
        result.cpp.match(
            /rotation\.y = static_cast<float>\(static_cast<double>\(/g,
        )?.length,
        1,
    );
    // The plain-data sibling on the same instance still emits once.
    assert.match(result.cpp, /bblscene::Spinner_rate\(/);
});

test("native methods read sibling getters through field channels", () => {
    const result = compileSource(`
        class Probe {
            depth = 4;
            private readonly bias = 1;
            get scaled(): number {
                return this.depth * 2;
            }
            sample(offset: number): number {
                return this.scaled + this.bias + offset;
            }
        }
        const probe = new Probe();
        const a = probe.sample(1);
        const b = probe.sample(2);
    `);

    // The getter's field joins the method's channels and its expression
    // inlines at the read site inside the emitted body.
    assert.match(
        result.cpp,
        /double Probe_sample\(\[\[maybe_unused\]\] double& v_fn\d+_this_depth, \[\[maybe_unused\]\] double& v_fn\d+_this_bias, double v_fn\d+_offset\) \{/,
    );
    assert.match(
        result.cpp,
        /\(\(v_fn\d+_this_depth \* 2\.0\) \+ v_fn\d+_this_bias\) \+ v_fn\d+_offset/,
    );
    assert.equal(
        (result.cpp.match(/bblscene::Probe_sample\(/g) ?? []).length,
        2,
    );
});

test("native methods call sibling methods natively", () => {
    const result = compileSource(`
        class Chain {
            base = 10;
            half(value: number): number {
                return value / 2;
            }
            shifted(value: number): number {
                return this.half(value) + this.base;
            }
        }
        const chain = new Chain();
        const a = chain.shifted(8);
        const b = chain.shifted(16);
    `);

    assert.equal(
        result.cpp.match(/double Chain_half\(double v_fn\d+_value\) \{/g)
            ?.length,
        1,
    );
    assert.equal(result.cpp.match(/double Chain_shifted\(/g)?.length, 2);
    // The sibling call inside the emitted body is a native call, not an
    // inline frame.
    assert.match(result.cpp, /bblscene::Chain_half\(v_fn\d+_value\)/);
});

test("shares platform input records with the animation callback", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        interface InputState {
            right: boolean;
            startPressed: boolean;
        }
        interface Actor {
            box: { x: number; y: number };
        }
        await createEngine({});
        const state: InputState = {
            right: false,
            startPressed: false,
        };
        const onKey = (down: boolean) => (event: KeyboardEvent): void => {
            if (event.code === "ArrowRight") state.right = down;
            if (down && event.code === "Enter") state.startPressed = true;
        };
        window.addEventListener("keydown", onKey(true));
        window.addEventListener("keyup", onKey(false));
        const actor: Actor = { box: { x: 0, y: 196 } };
        requestAnimationFrame(() => {
            if (state.startPressed) actor.box.x = 100;
            if (state.right) actor.box.x += 4;
        });
    `);

    const state = result.cpp.match(
        /bblscene::InputState (v_state) = bbl::js::make_ref/,
    );
    assert.ok(state);
    assert.match(result.cpp, new RegExp(`${state[1]}->right = true`));
    assert.match(result.cpp, new RegExp(`if \\(${state[1]}->right\\)`));
    assert.match(result.cpp, /v_actor->box->x \+= 4\.0/);
});

test("a gamepad source built before the engine reads the pads through the Window's engine", () => {
    const directory = resolve("artifacts/gamepad-before-engine");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    const result = compileSource(
        `
        import { createEngine, createSceneContext, createFreeCamera, registerScene, startEngine, onBeforeRender } from "@babylonjs/lite";
        const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
        worker.terminate();
        interface GamepadSource { getGamepads(): readonly (Gamepad | null)[] | null; isActive(): boolean; standard(): number }
        function browserGamepadSource(): GamepadSource {
            const getGamepads = (): readonly (Gamepad | null)[] | null =>
                typeof navigator !== "undefined" && typeof navigator.getGamepads === "function" ? navigator.getGamepads() : null;
            return {
                getGamepads,
                isActive: () => typeof document === "undefined" || (document.visibilityState === "visible" && document.hasFocus()),
                standard: () => {
                    let count = 0;
                    for (const pad of getGamepads() ?? []) if (pad && pad.connected && pad.mapping === "standard") count++;
                    return count;
                },
            };
        }
        async function main(): Promise<void> {
            const source = browserGamepadSource();
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            const scene = createSceneContext(engine);
            scene.camera = createFreeCamera([0, 1, -5], [0, 0, 0]);
            let connected = 0;
            onBeforeRender(scene, () => {
                const pads = source.isActive() ? source.getGamepads() : null;
                connected = source.standard();
                for (const pad of pads ?? []) if (pad) connected++;
            });
            await registerScene(scene);
            await startEngine(engine);
        }
        void main();
    `,
        { fileName: join(directory, "entry.ts") },
    );
    assert.match(
        result.cpp,
        /platform_gamepads\(bbl::pal::window_document_engine\(\)\)/,
    );
    // The Window's input focus gates the source.
    assert.match(result.cpp, /document_hidden.*bbl::document_has_focus\(\)/s);
    // A pad read where no engine exists yet is the Window's too.
    assert.match(
        result.cpp,
        /gamepad_connected\(bbl::pal::window_document_engine\(\), /,
    );
});

test("fully initializes direct property-animation targets", () => {
    const result = compileSource(`
        import {
            createAnimationManager,
            createBox,
            createEngine,
            createPropertyAnimationClip,
            createPropertyAnimationGroup,
        } from "@babylonjs/lite";
        async function main() {
            const engine = await createEngine({});
            const box = createBox(engine);
            const manager = createAnimationManager();
            const clip = createPropertyAnimationClip("move", [{
                path: "position.x",
                keys: [
                    { frame: 0, value: 0 },
                    { frame: 1, value: 1 },
                ],
            }]);
            createPropertyAnimationGroup(manager, box, clip);
        }
    `);

    assert.match(
        result.cpp,
        /PropertyAnimationTarget\{bbl::PropertyAnimationTargetKind::mesh, [^,{}]+, 0u, \{\}\}/,
    );
});

test("evaluates animation factories once when projecting a class record into typed storage", () => {
    const result = compileSource(`
        import {
            createAnimationManager, createBox, createEngine,
            createPropertyAnimationClip, createPropertyAnimationGroup,
            stopAnimation,
            type AnimationGroup, type AnimationManager, type Mesh,
        } from "@babylonjs/lite";
        class Controller {
            private groups: Record<"jump" | "rest", AnimationGroup>;
            constructor(manager: AnimationManager, target: Mesh) {
                const clip = createPropertyAnimationClip("move", [{
                    path: "position.x",
                    keys: [{ frame: 0, value: 0 }, { frame: 1, value: 1 }],
                }]);
                this.groups = {
                    rest: createPropertyAnimationGroup(manager, target, clip),
                    jump: createPropertyAnimationGroup(manager, target, clip),
                };
                stopAnimation(this.groups.jump);
            }
        }
        async function main() {
            const engine = await createEngine({});
            new Controller(createAnimationManager(), createBox(engine));
        }
        void main();
    `);

    // Each factory starts a playing group. Recompiling the literal during
    // typed projection leaves an extra group playing outside the controller.
    assert.equal(
        (result.cpp.match(/bbl::create_property_animation_group\(/g) ?? [])
            .length,
        2,
    );
    assert.match(result.cpp, /bbl::stop_animation\(/);
});

test("captures the live engine by reference in stored callbacks", () => {
    const result = compileSource(`
        import { createBox, createEngine } from "@babylonjs/lite";
        interface Factory { make: () => void }
        async function main() {
            const engine = await createEngine({});
            const factory: Factory = {
                make: () => { createBox(engine); },
            };
            factory.make();
        }
    `);

    assert.match(
        result.cpp,
        /stored_callback\{\d+u, bbl::js::make_closure\(bblscene::bbl_environment_\w+\{std::ref\(v_engine\)\}, bblscene::\w+/,
    );
    assert.match(result.cpp, /std::reference_wrapper<bbl::Engine> capture0;/);
    assert.match(result.cpp, /bbl::create_box\(v_engine,/);
});

test("calls a string method on a parenthesized runtime conditional", () => {
    const result = compileSource(`
        function clean(line: string): string {
            const semi = line.indexOf(";");
            return (semi >= 0 ? line.slice(0, semi) : line).trim();
        }
        // A pure helper handed a known value folds at its call.
        let line = "key=value ; comment";
        if (Date.now() < 0) line = "";
        const value = clean(line);
    `);

    assert.match(result.cpp, /return bbl::js::string_trim\(/);
    assert.match(result.cpp, /v_value = bblscene::clean\(v_line\);/);
    assert.match(result.cpp, /\? bbl::js::string_slice\(/);
    assert.match(result.cpp, /"key=value ; comment"/);
});

test("a native helper's returned record keeps the primitives of a record one of its fields holds", () => {
    // `fadeOf()` returns `{ profile }`, the record `profileOf()` returns,
    // plain or frozen: its result still knows `profile.a`. A write to `a`
    // leaves it a run-time read.
    const source = (profile: string, write = ""): string =>
        `import { createEngine, createSceneContext, createShaderMaterial, wgsl } from "@babylonjs/lite";
interface Profile { a: number }
function profileOf(): Profile { return ${profile}; }
function fadeOf(): { readonly profile: Profile } { const profile = profileOf(); return { profile }; }
async function main(): Promise<void> {
    const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
    createSceneContext(engine);
    const fade = fadeOf();
    ${write}
    const vertex = \`struct VertexOutput { @builtin(position) position: vec4<f32>, };
@vertex fn mainVertex(input: VertexInput) -> VertexOutput { var out: VertexOutput; out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position * \${fade.profile.a.toFixed(1)}, 1.0); return out; }\`;
    createShaderMaterial({ name: "m", vertexSource: wgsl\`\${vertex}\`, fragmentSource: wgsl\`@fragment fn mainFragment() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }\`, attributes: ["position"], uniforms: ["worldViewProjection"] });
}
void main();
`;
    for (const profile of ["{ a: 0.4 }", "Object.freeze({ a: 0.4 })"])
        assert.deepEqual(
            compileSource(source(profile)).manifest.customShaderPrograms.map(
                (program) =>
                    /position \* ([0-9.]+)/.exec(program.vertexSource)?.[1] ??
                    "",
            ),
            ["0.4"],
            profile,
        );
    assert.throws(
        () => compileSource(source("{ a: 0.4 }", "fade.profile.a = 2;")),
        /'vertex' is bound as data without a static string/,
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

test("specializes if/else without breaking lexical block shadowing", () => {
    const result = compileSource(
        readFileSync(resolve("examples/control-flow-scene.ts"), "utf8"),
        {
            fileName: "examples/control-flow-scene.ts",
        },
    );

    const scope = /double (v_fn\d+)_exposure = 1\.25/.exec(result.cpp)?.[1];
    assert.ok(scope);
    assert.match(
        result.cpp,
        new RegExp(`double ${scope}_block\\d+_exposure = 1\\.0`),
    );
    assert.doesNotMatch(result.cpp, /\} else \{/);
    assert.match(
        result.cpp,
        new RegExp(`\\.contrast = static_cast<float>\\(${scope}_exposure\\)`),
    );
});

test("binds a shadow generator created before its light to the eventual scene slot", () => {
    const result = compileSource(`
        import {
            addToScene,
            createBox,
            createEngine,
            createHemisphericLight,
            createPcfSpotlightShadowGenerator,
            createSceneContext,
            createSpotLight,
            setShadowTaskCasterMeshes,
        } from "babylon-lite";

        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            const caster = createBox(engine, 1);
            const spot = createSpotLight([0, 4, 0], [0, -1, 0], 1, 8);
            spot.shadowGenerator =
                createPcfSpotlightShadowGenerator(engine, spot);
            setShadowTaskCasterMeshes(spot.shadowGenerator, [caster]);
            addToScene(scene, createHemisphericLight([0, 1, 0], 1));
            addToScene(scene, spot);
            addToScene(scene, caster);
        }

        void main();
    `);

    assert.deepEqual(result.manifest.sceneLightKinds, ["hemispheric", "spot"]);
    assert.equal(result.manifest.shadowGenerators[0]?.lightIndex, 1);
    assert.match(
        result.cpp,
        /create_pcf_spotlight_shadow_generator[\s\S]*add_to_scene\([^;]*v_spot\)/,
    );
});

test("retains light registration identities through constant resource tuples", () => {
    for (const [declaration, selected] of [
        ["const lights = [spot, sun] as const;", "light"],
        [
            "const lights = [{ light: spot }, { light: sun }] as const;",
            "light.light",
        ],
    ]) {
        const result = compileSource(`
            import {
                addToScene, createDirectionalLight, createEngine,
                createHemisphericLight, createPcfDirectionalShadowGenerator,
                createPcfSpotlightShadowGenerator, createSceneContext, createSpotLight,
            } from "babylon-lite";
            async function main() {
                const engine = await createEngine({});
                const scene = createSceneContext(engine);
                addToScene(scene, createHemisphericLight([0, 1, 0], 1));
                const spot = createSpotLight([0, 4, 0], [0, -1, 0], 1, 8);
                const sun = createDirectionalLight([-1, -2, -1], 1);
                spot.shadowGenerator = createPcfSpotlightShadowGenerator(engine, spot);
                ${declaration}
                for (const light of lights) addToScene(scene, ${selected});
                sun.shadowGenerator = createPcfDirectionalShadowGenerator(engine, sun);
            }
            void main();
        `);
        assert.deepEqual(result.manifest.sceneLightKinds, [
            "hemispheric",
            "spot",
            "directional",
        ]);
        assert.deepEqual(
            result.manifest.shadowGenerators.map(
                ({ lightIndex }) => lightIndex,
            ),
            [1, 2],
        );
        assert.equal(result.manifest.dynamicSceneLights, false);
    }
});

test("keeps shadow-light slots local to each scene", () => {
    const result = compileSource(`
        import {
            addToScene,
            createCsmDirectionalShadowGenerator,
            createDirectionalLight,
            createEngine,
            createHemisphericLight,
            createSceneContext,
        } from "babylon-lite";

        async function main() {
            const engine = await createEngine({});
            const first = createSceneContext(engine);
            const second = createSceneContext(engine);
            addToScene(first, createHemisphericLight([0, 1, 0], 1));
            const sun = createDirectionalLight([-1, -2, -1], 1);
            sun.shadowGenerator =
                createCsmDirectionalShadowGenerator(engine, sun);
            addToScene(first, sun);
            addToScene(second, createHemisphericLight([0, 1, 0], 1));
            addToScene(second, sun);
        }

        void main();
    `);

    assert.equal(result.manifest.shadowGenerators[0]?.lightIndex, 1);
});

test("removes a scene light through parameter and local aliases", () => {
    const result = compileSource(`
        import {
            addToScene,
            createBox,
            createEngine,
            createHemisphericLight,
            createPcfSpotlightShadowGenerator,
            createSceneContext,
            createSpotLight,
            removeFromScene,
            setShadowTaskCasterMeshes,
        } from "babylon-lite";

        function removeAliased(
            scene: ReturnType<typeof createSceneContext>,
            light: ReturnType<typeof createHemisphericLight>,
        ) {
            const alias = light;
            removeFromScene(scene, alias);
        }

        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            const first = createHemisphericLight([0, 1, 0], 1);
            const spot = createSpotLight([0, 4, 0], [0, -1, 0], 1, 8);
            const caster = createBox(engine, 1);
            addToScene(scene, first);
            addToScene(scene, spot);
            spot.shadowGenerator =
                createPcfSpotlightShadowGenerator(engine, spot);
            setShadowTaskCasterMeshes(spot.shadowGenerator, [caster]);
            removeAliased(scene, first);
            addToScene(scene, caster);
        }

        void main();
    `);

    assert.deepEqual(result.manifest.sceneLightKinds, ["spot"]);
    assert.equal(result.manifest.shadowGenerators[0]?.lightIndex, 0);
    assert.match(result.cpp, /remove_from_scene\([^;]+\)/);
});

test("compiles pinned scene 271's live shadow-light replacement unchanged", () => {
    const sourcePath = "corpus/babylon-lite/lab/lite/src/lite/scene271.ts";
    const result = compileSource(readFileSync(resolve(sourcePath), "utf8"), {
        fileName: sourcePath,
    });

    assert.deepEqual(result.manifest.sceneLightKinds, ["spot"]);
    assert.equal(result.manifest.dynamicSceneLights, true);
    assert.deepEqual(
        result.manifest.shadowGenerators.map(({ lightIndex }) => lightIndex),
        [0, 0],
    );
    assert.match(result.cpp, /remove_from_scene\(v_scene, v_lightA\)/);
    assert.match(result.cpp, /unregister_scene\(v_scene\)/);
    const registrations = [
        ...result.cpp.matchAll(/register_scene_with_shadow_support\((\w+)\)/g),
    ];
    assert.equal(registrations.length, 2);
    for (const [, scene] of registrations) {
        assert.match(result.cpp, new RegExp(`auto ${scene} = v_scene;`));
    }
    assert.match(result.cpp, /topology_rebuild_pending/);
    assert.match(result.cpp, /rebuild_scene_renderables\(v_scene\)/);
    assert.match(
        result.cpp,
        /defer_start_continuation_until\(v_engine, \[remaining = 3u\]/,
    );
    assert.doesNotMatch(result.cpp, /requestAnimationFrame|Promise|nextFrame/);
});

test("carries the cascade stabilization and the world-space bias into the generator", () => {
    const source = (options: string) => `
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
            const stable = (localStorage.getItem("stable") ?? "1") === "1";
            const worldBias = Number(localStorage.getItem("bias") ?? "0.05");
            const tier = JSON.parse(localStorage.getItem("tier") ?? '{"shadow":{"stable":true,"far":80}}') as { shadow: { stable: boolean; far: number } };
            createCsmDirectionalShadowGenerator(engine, light, {
                ${options}
            });
        }

        void main();
    `;
    const options = (cpp: string): string =>
        /bbl::CsmDirectionalShadowOptions\{(.*)\}\)\);/.exec(cpp)?.[1] ?? "";
    // The bounding-sphere fit with its light-axis anchor grid, and the
    // world-space bias's far-plane reserve plus per-cascade clip offset:
    // the record keeps both, in the pin's own configuration order.
    assert.equal(
        options(
            compileSource(
                source(
                    "stabilizeCascades: true, worldSpaceBias: 0.5, bias: 0.25,",
                ),
            ).cpp,
        ),
        "bbl::upstream::csm_default_map_size, bbl::upstream::csm_default_num_cascades, " +
            "bbl::upstream::csm_default_lambda, bbl::upstream::csm_default_cascade_blend_percentage, " +
            "true, std::optional<double>{}, 0.25, std::optional<double>{0.5}, " +
            "bbl::upstream::csm_default_darkness, bbl::upstream::csm_default_frustum_edge_falloff, false",
    );
    // An option a conditional spread adds is selected where it is read, and
    // one the scene omits there keeps the pin's default.
    assert.equal(
        options(
            compileSource(
                source(
                    "stabilizeCascades: stable, ...(worldBias > 0 ? { worldSpaceBias: worldBias, darkness: 0.5 } : {}), bias: 0.25,",
                ),
            ).cpp,
        ),
        "bbl::upstream::csm_default_map_size, bbl::upstream::csm_default_num_cascades, " +
            "bbl::upstream::csm_default_lambda, bbl::upstream::csm_default_cascade_blend_percentage, " +
            "v_stable, std::optional<double>{}, 0.25, " +
            "(v_worldBias > 0.0 ? std::optional<double>{v_worldBias} : std::optional<double>{}), " +
            "(v_worldBias > 0.0 ? 0.5 : bbl::upstream::csm_default_darkness), " +
            "bbl::upstream::csm_default_frustum_edge_falloff, false",
    );
    // A run-time boolean read off a parsed document is its condition.
    assert.match(
        options(
            compileSource(
                source(
                    "stabilizeCascades: tier.shadow.stable, shadowMaxZ: tier.shadow.far,",
                ),
            ).cpp,
        ),
        /bbl::upstream::csm_default_cascade_blend_percentage, v_tier\.read_property\("shadow"\)\.read_property\("stable"\)\.truthy\(\), std::optional<double>\{/,
    );
    // The layered map is created from the record at run time: a quality
    // tier sizes it and counts its cascades as the texture extents they are.
    assert.match(
        options(
            compileSource(
                source(
                    "mapSize: worldBias > 1 ? 2048 : 1024, numCascades: stable ? 4 : 2,",
                ),
            ).cpp,
        ),
        /^bbl::gpu_u32\(bbl::gpu_size\(\(v_worldBias > 1\.0 \? 2048\.0 : 1024\.0\)\)\), bbl::gpu_u32\(bbl::gpu_size\(\(v_stable \? 4\.0 : 2\.0\)\)\), /,
    );
    // An ESM map sizes generated resources: no condition selects it.
    assert.throws(
        () =>
            compileSource(
                source("...(stable ? { mapSize: 2048 } : {}),").replaceAll(
                    "createCsmDirectionalShadowGenerator",
                    "createEsmDirectionalShadowGenerator",
                ),
            ),
        /Option 'mapSize' decides generated resources/,
    );
    assert.throws(
        () => compileSource(source("normalBias: 0.5,")),
        /A CSM directional shadow generator options/,
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
    const subset = result.cpp.match(
        /bbl::js::Array<bbl::MeshHandle> (v_\w*next) =/,
    );
    assert.ok(subset);
    assert.match(result.cpp, new RegExp(`array_to_vector\\(${subset[1]}\\)`));
});

test("folds the torus knot's own defaults and takes each named arm", () => {
    // The builder resolves six options through its own `??`, and generation
    // takes the present arm of each -- so an omitted option reaches the
    // record as the PIN's value (radius 2, tube 0.5, 32 and 32 segments,
    // the (2, 3) winding) and a named one as the scene's.
    const defaults = compileSource(`
        import { createTorusKnot, createEngine } from "babylon-lite";
        async function main() {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            createTorusKnot(engine);
        }
        void main();
    `);
    assert.match(
        defaults.cpp,
        /bbl::TorusKnotOptions\{2\.0, 0\.5, 32\.0, 32\.0, 2\.0, 3\.0\}/,
    );

    const named = compileSource(`
        import { createTorusKnot, createEngine } from "babylon-lite";
        async function main() {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            createTorusKnot(engine, {
                radius: 20,
                tube: 5,
                radialSegments: 48,
                tubularSegments: 24,
                p: 3,
                q: 5,
            });
        }
        void main();
    `);
    assert.match(
        named.cpp,
        /bbl::TorusKnotOptions\{20\.0, 5\.0, 48\.0, 24\.0, 3\.0, 5\.0\}/,
    );

    // A partially-named call keeps the pin's answer for what it left out.
    const partial = compileSource(`
        import { createTorusKnot, createEngine } from "babylon-lite";
        async function main() {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            createTorusKnot(engine, { radius: 20, tube: 5 });
        }
        void main();
    `);
    assert.match(
        partial.cpp,
        /bbl::TorusKnotOptions\{20\.0, 5\.0, 32\.0, 32\.0, 2\.0, 3\.0\}/,
    );

    // An option the pinned factory does not have refuses at the call site
    // rather than being dropped into a record that has no field for it.
    assert.throws(
        () =>
            compileSource(`
        import { createTorusKnot, createEngine } from "babylon-lite";
        async function main() {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            createTorusKnot(engine, { radius: 20, sideOrientation: 1 });
        }
        void main();
    `),
        /Reached torus knots name their radius, tube, segment counts/,
    );
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

    assert.equal(result.cpp.match(/bbl::create_engine/g)?.length, 1);
    assert.match(
        result.cpp,
        /auto (v_bblite_inline_engine_\d+) = bbl::create_engine/,
    );
    const engine = result.cpp.match(
        /auto (v_bblite_inline_engine_\d+) = bbl::create_engine/,
    )?.[1];
    assert.ok(engine);
    assert.match(result.cpp, new RegExp(`create_scene_context\\(${engine}\\)`));
    assert.match(
        result.cpp,
        new RegExp(`create_default_camera\\(${engine}, v_scene\\)`),
    );
    assert.match(
        result.cpp,
        new RegExp(
            `write_camera_scalar\\(bbl::handle_at\\(${engine}\\.cameras, \\w+\\), &bbl::CameraRecord::alpha,`,
        ),
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

test("an engine-handle list index with effects runs once, before the right side, on every camera store", () => {
    // A list of handles selects its element by comparing the index with
    // each lane: a single lane compares nothing, three lanes compare twice,
    // and a store's right side may read what the index writes.
    const result = compileSource(`
        import {
            createArcRotateCamera,
            createEngine,
            createSceneContext,
            type ArcRotateCamera,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            const one: ArcRotateCamera[] = [];
            one.push(createArcRotateCamera(0, 1, 5, { x: 0, y: 0, z: 0 }));
            const three: ArcRotateCamera[] = [];
            three.push(createArcRotateCamera(1, 1, 6, { x: 0, y: 0, z: 0 }));
            three.push(createArcRotateCamera(1, 1, 7, { x: 0, y: 0, z: 0 }));
            three.push(createArcRotateCamera(1, 1, 8, { x: 0, y: 0, z: 0 }));
            scene.camera = one[0]!;
            let i = 0;
            one[i++]!.radius = 9;
            let j = 0;
            one[j++]!.fov = j;
            let k = 0;
            three[k++ % 3]!.alpha += 1;
            let m = 0;
            const picked = one[m++]!;
            picked.beta = i + j + k + m;
        }
    `);
    assert.equal(result.cpp.match(/create_arc_rotate_camera\(/g)?.length, 4);
    for (const name of ["v_i", "v_j", "v_k", "v_m"])
        assert.equal(
            result.cpp.split(`${name}++`).length - 1,
            1,
            `${name} is incremented once`,
        );
    assert.match(
        result.cpp,
        /const double (v_bblite_store_key_\d+) = \(v_j\+\+\);[^]*?\.fov = v_j;/,
    );
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

test("lowers a proven container flatten through its source-order carrier", () => {
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

    // The generated permutation retains source order without a native tree.
    assert.match(
        result.cpp,
        /for \(const bbl::MeshHandle [\w]+ : bbl::asset_mesh_walk\([^\n]+, 0\)\)/,
    );
    assert.match(
        result.cpp,
        /set_pbr_unlit\(.*bbl::Color3\{0\.5f, 0\.5f, 0\.5f\}\)/,
    );
});

test("lowers a continue in the consuming loop over a proven container flatten", () => {
    // Continue preserves the source permutation and skips the current body.
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
                const material = mesh.material;
                if (!material) {
                    continue;
                }
                setPbrUnlit(material as PbrMaterialProps, [0.5, 0.5, 0.5]);
            }
        }
    `);

    assert.match(
        result.cpp,
        /for \(const bbl::MeshHandle [\w]+ : bbl::asset_mesh_walk\([^\n]+, 0\)\)/,
    );
    assert.match(result.cpp, /\bcontinue;/);
    assert.match(
        result.cpp,
        /set_pbr_unlit\(.*bbl::Color3\{0\.5f, 0\.5f, 0\.5f\}\)/,
    );
});

test("refuses a break in the consuming loop over a proven container flatten", () => {
    // Partial traversal cannot carry the whole-asset mutation/count proof.
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
                    const asset = await loadGltf(engine, "model.glb");
                    for (const mesh of collectMeshes(asset)) {
                        if (!mesh.material) {
                            break;
                        }
                        setPbrUnlit(mesh.material as PbrMaterialProps, [0.5, 0.5, 0.5]);
                    }
                }
            `),
        /break in a container's mesh walk is not lowered/,
    );
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

const containerFlattenClosure = `
        function collectMeshes(container: AssetContainer): Mesh[] {
            const meshes: Mesh[] = [];
            const visit = (node: unknown): void => {
                if (node && typeof node === "object") {
                    if ("_gpu" in node && "material" in node) {
                        meshes.push(node as unknown as Mesh);
                    }
                    const children = (node as { children?: readonly unknown[] }).children;
                    if (children) {
                        for (const child of children) {
                            visit(child);
                        }
                    }
                }
            };
            for (const entity of container.entities) {
                visit(entity);
            }
            return meshes;
        }
`;

test("source collector packaging refuses rest, default and optional parameters", () => {
    for (const original of [containerFlattenWalk, containerFlattenClosure]) {
        for (const parameter of [
            "...container: [AssetContainer]",
            "container: AssetContainer = {} as AssetContainer",
            "container?: AssetContainer",
        ]) {
            const walk = original
                .replace("container: AssetContainer", parameter)
                .replaceAll(
                    "container.entities",
                    "(container as unknown as AssetContainer).entities",
                );
            // The actual rest parameter receives [asset], so spreading its
            // `.entities` throws. Passing asset directly to the packaged body
            // would silently erase that source behavior.
            if (parameter.startsWith("...")) {
                const collect = createJavaScriptFunction(
                    transpileCommonJs(
                        `${walk}\nreturn collectMeshes;`,
                        "collector-rest.ts",
                    ),
                )() as (container: { entities: object[] }) => object[];
                assert.throws(() => collect({ entities: [] }), TypeError);
            }
            assert.throws(
                () =>
                    compileSource(
                        `
                import {createEngine, loadGltf, type AssetContainer, type Mesh} from "@babylonjs/lite";
                ${walk}
                const engine = await createEngine({});
                const asset = await loadGltf(engine, "model.glb");
                for (const mesh of collectMeshes(asset)) { keep(mesh); }
                function keep(_mesh: Mesh): void {}
            `,
                        { fileName: "collector-parameter.ts" },
                    ),
                (error: unknown) => {
                    assert(error instanceof CompileError);
                    assert.match(
                        error.message,
                        /collector-parameter\.ts:\d+:\d+:/,
                    );
                    return true;
                },
            );
        }
    }
});

test("lowers the closure arrangement of the same container flatten", () => {
    // Scene 73 writes the walk as a closure over the result list with both
    // type guards inlined, which is the recursive visitor with its parts
    // rearranged: the same `_gpu`/`material` probe selects the same nodes
    // and the same `children` descent reaches the same subtrees, so it is
    // answered with the same collection the other two spellings are.
    const result = compileSource(`
        import {
            createEngine,
            loadGltf,
            setPbrUnlit,
        } from "@babylonjs/lite";
        import type { AssetContainer, Mesh, PbrMaterialProps } from "@babylonjs/lite";
${containerFlattenClosure}
        async function main() {
            const engine = await createEngine({});
            const asset = await loadGltf(engine, "model.glb");
            for (const mesh of collectMeshes(asset)) {
                setPbrUnlit(mesh.material as PbrMaterialProps, [0.5, 0.5, 0.5]);
            }
        }
    `);

    assert.match(
        result.cpp,
        /for \(const bbl::MeshHandle [\w]+ : bbl::asset_mesh_walk\([^\n]+, 0\)\)/,
    );
    assert.match(
        result.cpp,
        /set_pbr_unlit\(.*bbl::Color3\{0\.5f, 0\.5f, 0\.5f\}\)/,
    );
    // Nothing emitted the closure itself: the walk is the collection, not
    // a lambda over an entity tree native loading resolved away.
    assert.doesNotMatch(result.cpp, /entities/);
});

test("refuses a closure flatten whose descent skips a node", () => {
    // The descent moved inside the collect arm: a transform node between
    // two meshes would end the walk there, so the proof must not accept it.
    // The call then inlines. Dynamic values can cross recursive unknown
    // parameters, but cannot become native mesh handles by a type assertion.
    assert.throws(
        () =>
            compileSource(`
                import { createEngine, loadGltf } from "@babylonjs/lite";
                import type { AssetContainer, Mesh } from "@babylonjs/lite";

                function collectMeshes(container: AssetContainer): Mesh[] {
                    const meshes: Mesh[] = [];
                    const visit = (node: unknown): void => {
                        if (node && typeof node === "object") {
                            if ("_gpu" in node && "material" in node) {
                                meshes.push(node as unknown as Mesh);
                                const children = (node as { children?: readonly unknown[] }).children;
                                if (children) {
                                    for (const child of children) {
                                        visit(child);
                                    }
                                }
                            }
                        }
                    };
                    for (const entity of container.entities) {
                        visit(entity);
                    }
                    return meshes;
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
        /expected data handle.*"kind":"json"/,
    );
});

test("writes a camera viewport as the pin's own normalized record", () => {
    // `camera.viewport` is a plain optional field upstream rather than a
    // factory call, so the write IS the opt-in -- and the four lanes stay
    // double, because getEffectiveAspectRatio divides two of them before
    // the projection writer's float32 store.
    const result = compileSource(`
        import {
            createArcRotateCamera,
            createEngine,
            createSceneContext,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            scene.camera = createArcRotateCamera(1, 1, 3, { x: 0, y: 0, z: 0 });
            scene.camera.viewport = { x: 0.5, y: 0, width: 0.5, height: 1 };
        }
    `);

    assert.match(
        result.cpp,
        /\.viewport = bbl::NormalizedViewport\{0\.5, 0\.0, 0\.5, 1\.0\}/,
    );
});

test("refuses a camera viewport lane outside the unit square", () => {
    // The pinned render task multiplies the raw fraction by the target
    // extent where the exported resolver clamps it first, so the two agree
    // only inside [0, 1] -- and this port emits the clamping one. A lane it
    // cannot FOLD refuses for the same reason: a check that only sees
    // literals would let a computed lane through with no check at all.
    assert.throws(
        () =>
            compileSource(`
                import {
                    createArcRotateCamera,
                    createEngine,
                    createSceneContext,
                } from "@babylonjs/lite";

                async function main() {
                    const engine = await createEngine({});
                    const scene = createSceneContext(engine);
                    scene.camera = createArcRotateCamera(1, 1, 3, { x: 0, y: 0, z: 0 });
                    scene.camera.viewport = { x: -0.25, y: 0, width: 0.5, height: 1 };
                }
            `),
        /must be a generation-known fraction inside \[0, 1\]/,
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

    assert.match(
        result.cpp,
        /bbl::handle_at\(v_engine\.assets, v_container\)\.meshes/,
    );
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
    assert.match(
        result.cpp,
        /bbl::set_mesh_parent\([^;]+bbl::MeshHandle\{\}\);/,
    );
});

test("parent-only runtime motion dirties the setParent subtree", () => {
    const result = compileSource(`
        import {
            createEngine,
            createBox,
            createSceneContext,
            onBeforeRender,
            setParent,
        } from "@babylonjs/lite";
        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            const parent = createBox(engine, 1);
            const child = createBox(engine, 0.5);
            setParent(child, parent);
            onBeforeRender(scene, () => {
                parent.position.x += 1;
            });
        }
    `);

    assert.match(
        result.cpp,
        /\.meshes, v_parent\)\.position\.x \+= 1\.0;\s*bbl::mark_mesh_dirty\([^,]+, v_parent\);/,
    );
    assert.doesNotMatch(
        result.cpp,
        /\+\+[^;]*\.meshes, v_parent\)\.transform_version/,
    );
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
    // The optional local takes the parent only when the handle is present;
    // an absent parent leaves it empty rather than engaging it with the
    // invalid-handle sentinel.
    const ownedMesh = "std::pair<bbl::StoredEngine, bbl::MeshHandle>";
    const receiver = result.cpp.match(
        new RegExp(
            String.raw`bbl::js::Nullable<${ownedMesh}> (v_bblite_property_owner_\d+) = \(\[&\]\(\) -> bbl::js::Nullable<${ownedMesh}> \{ const auto& (\w+) = v_current; return \2 \? bbl::js::Nullable<${ownedMesh}>\{\*\2\} : bbl::js::Nullable<${ownedMesh}>\{std::nullopt\}; \}\(\)\);`,
        ),
    );
    assert.ok(receiver);
    const pair = `(*${receiver[1]})`;
    // Reads name the entry's engine; the stored parent keeps the pair's owner.
    const parent = `bbl::handle_at(v_engine.meshes, (${pair}).second).parent`;
    const assignment =
        `v_current = bbl::js::Nullable<${ownedMesh}>{((${parent}.value != bbl::invalid_handle) ? ` +
        `bbl::js::Nullable<${ownedMesh}>{${ownedMesh}{bbl::StoredEngine{(*(${pair}).first)}, ${parent}}} : ` +
        `bbl::js::Nullable<${ownedMesh}>{std::nullopt})}.to_optional();`;
    assert.ok(result.cpp.includes(assignment));
    assert.ok(result.cpp.indexOf(receiver[0]) < result.cpp.indexOf(assignment));
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

    assert.match(
        result.cpp,
        /\.meshes, v_anchor\)\.visible = bbl::js::Nullable<bool>\{false\};/,
    );
    assert.ok(result.manifest.features.includes("mesh:visible"));
});

test("folds a light include set to the meshes its ids name", () => {
    const result = compileSource(`
        import {
            createBox,
            createEngine,
            createPointLight,
            createSphere,
            type LightBase,
        } from "@babylonjs/lite";
        function restrict(light: LightBase, ids: readonly string[]): void {
            light.includedOnlyMeshIds = new Set(ids);
        }
        async function main() {
            const engine = await createEngine({});
            const box = createBox(engine, 1);
            box.id = "lit-box";
            const ball = createSphere(engine, { diameter: 1 });
            ball.id = "lit-ball";
            const boxSet = ["lit-box"];
            const ballSet = ["lit-ball"];
            const light = createPointLight([0, 2, 0], 1);
            restrict(light, [...boxSet, ...ballSet]);
            const other = createPointLight([2, 2, 0], 1);
            restrict(other, ballSet);
        }
        void main();
    `);

    // The write lands inside the inlined helper, so the light is that
    // frame's alias of the caller's handle.
    assert.match(
        result.cpp,
        /(v_fn\d+_light) = v_light;[\s\S]*?\.lights, \1\)\.included_meshes = \{v_box, v_ball\};/,
    );
    assert.match(
        result.cpp,
        /(v_fn\d+_light) = v_other;[\s\S]*?\.lights, \1\)\.included_meshes = \{v_ball\};/,
    );
    // `Mesh.id` has one reader upstream and the join folds here, so no
    // record lane carries the string; the scene's own id arrays are its
    // own plain data and stay.
    assert.doesNotMatch(result.cpp, /\.meshes, [^)]*\)\.id\b/);
    assert.ok(result.manifest.features.includes("light:included-meshes"));
});

test("refuses a light include set naming an id no mesh carries", () => {
    assert.throws(
        () =>
            compileSource(`
                import { createBox, createEngine, createPointLight } from "@babylonjs/lite";
                async function main() {
                    const engine = await createEngine({});
                    const box = createBox(engine, 1);
                    box.id = "lit-box";
                    const light = createPointLight([0, 2, 0], 1);
                    light.includedOnlyMeshIds = new Set(["absent"]);
                }
                void main();
            `),
        /No mesh carries the id "absent"/,
    );
});

test("refuses a mesh id write that would stale an emitted include set", () => {
    assert.throws(
        () =>
            compileSource(`
                import { createBox, createEngine, createPointLight } from "@babylonjs/lite";
                async function main() {
                    const engine = await createEngine({});
                    const box = createBox(engine, 1);
                    box.id = "lit-box";
                    const light = createPointLight([0, 2, 0], 1);
                    light.includedOnlyMeshIds = new Set(["lit-box"]);
                    box.id = "renamed";
                }
                void main();
            `),
        /already resolved a light's includedOnlyMeshIds/,
    );
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

test("lowers the canonical setSubtreeVisible export", () => {
    const result = compileSource(`
        import { createBox, createEngine, setSubtreeVisible } from "@babylonjs/lite";
        async function main() {
            const engine = await createEngine({});
            const anchor = createBox(engine, 0.05);
            setSubtreeVisible(anchor, false);
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

    const ownedMesh = "std::pair<bbl::StoredEngine, bbl::MeshHandle>";
    assert.ok(result.cpp.includes(`std::optional<${ownedMesh}> v_mesh{};`));
    assert.match(
        result.cpp,
        /v_mesh = bbl::js::Nullable<std::pair<bbl::StoredEngine, bbl::MeshHandle>>\{std::pair<bbl::StoredEngine, bbl::MeshHandle>\{bbl::StoredEngine\{v_engine\}, bbl::create_sphere\(v_engine, [^\n]+\)\}\}\.to_optional\(\);/,
    );
    assert.equal((result.cpp.match(/bbl::create_sphere\(/g) ?? []).length, 1);
    const receiver = result.cpp.match(
        new RegExp(
            String.raw`if \(v_mesh\.has_value\(\)\) \{\s*\[\[maybe_unused\]\] bbl::js::Nullable<${ownedMesh}> (\w+) = \(\[&\]\(\) -> bbl::js::Nullable<${ownedMesh}> \{ const auto& (\w+) = v_mesh; return \2 \? bbl::js::Nullable<${ownedMesh}>\{\*\2\} : bbl::js::Nullable<${ownedMesh}>\{std::nullopt\}; \}\(\)\);`,
        ),
    );
    assert.ok(receiver);
    const pair = `(*${receiver[1]})`;
    // The entry's engine is in scope: the pair's engine is that engine.
    const engine = "v_engine";
    assert.ok(
        result.cpp.includes(
            `bbl::handle_at(${engine}.meshes, (${pair}).second).position.y = 2.0;`,
        ),
    );
    assert.ok(
        result.cpp.includes(
            `bbl::mark_mesh_dirty(${engine}, (${pair}).second);`,
        ),
    );
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
        /bbl::write_camera_limits\([^,]+, [^,]+, 56u, std::array<std::optional<double>, 6>\{std::nullopt, std::nullopt, std::nullopt, 1\.7, 2\.0, 20\.0\}\)/,
    );
});

test("setCameraLimits writes limits that may be undefined, from a literal, a spread record and a held record", () => {
    const result = compileSource(`
        import { createArcRotateCamera, createEngine, createSceneContext, setCameraLimits, type ArcRotateCamera, type SceneContext } from "@babylonjs/lite";
        interface Walls { lowerBetaLimit: number | undefined; upperBetaLimit: number | undefined; lowerRadiusLimit: number | undefined; upperRadiusLimit: number | undefined }
        const POLE = { lowerBetaLimit: 0.02, upperBetaLimit: 3 } as const;
        function controls(camera: ArcRotateCamera, scene: SceneContext, classicLower: number | undefined, classicUpper: number | undefined) {
            let saved: Walls | null = null;
            function write(walls: Partial<Walls>): void { setCameraLimits(camera, walls, scene); }
            function read(): Walls {
                return { lowerBetaLimit: camera.lowerBetaLimit, upperBetaLimit: camera.upperBetaLimit, lowerRadiusLimit: camera.lowerRadiusLimit, upperRadiusLimit: camera.upperRadiusLimit };
            }
            return {
                sync(): void { write({ lowerBetaLimit: classicLower, upperBetaLimit: classicUpper }); },
                script(on: boolean): void {
                    if (on) { saved ??= read(); write({ ...POLE, lowerRadiusLimit: undefined, upperRadiusLimit: undefined }); }
                    else if (saved) { const restored = saved; saved = null; write(restored); }
                },
                dispose(): void { const base = saved ?? read(); saved = null; write({ ...base, lowerBetaLimit: classicLower, upperBetaLimit: classicUpper }); },
            };
        }
        const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
        const scene = createSceneContext(engine);
        const camera = createArcRotateCamera(0, 1, 8, { x: 0, y: 0, z: 0 });
        scene.camera = camera;
        setCameraLimits(camera, { lowerRadiusLimit: 2, upperRadiusLimit: 20 }, scene);
        const held = controls(camera, scene, Date.now() < 0 ? undefined : 0.3, 1.2);
        held.sync();
        held.script(true);
        held.script(false);
        held.dispose();
    `);
    // Limits that are all numbers write each as present.
    assert.match(
        result.cpp,
        /bbl::write_camera_limits\([^,]+, [^,]+, 48u, std::array<std::optional<double>, 6>\{std::nullopt, std::nullopt, std::nullopt, std::nullopt, 2\.0, 20\.0\}\)/,
    );
    // The keys each record holds are its present mask; a value that may be
    // undefined is written as it is.
    const writes = [
        ...result.cpp.matchAll(
            /bbl::write_camera_limits\([^,]+, [^,]+, (\d+)u, std::array<std::optional<double>, 6>\{std::nullopt, std::nullopt, /g,
        ),
    ].map((match) => match[1]);
    assert.deepEqual(writes, ["48", "12", "60", "60", "60"]);
});

test("lowers Scene 12's imported recursive mesh walk and animated root clones", () => {
    const sourcePath = "corpus/babylon-lite/lab/lite/src/lite/scene12.ts";
    const result = compileSource(readFileSync(resolve(sourcePath), "utf8"), {
        ...labDeployment,
        fileName: sourcePath,
        search: "?seekTime=0.5",
    });

    assert.equal(
        result.cpp.match(
            /for \(const bbl::MeshHandle .*?\.assets, .*?\)\.meshes\)/g,
        )?.length,
        1,
    );
    assert.equal(result.cpp.match(/bbl::clone_asset_root\(/g)?.length, 2);
    assert.match(
        result.cpp,
        /set_asset_root_position_component\([^;]+1u, 3\.0\)/,
    );
    assert.match(
        result.cpp,
        /set_asset_root_position_component\([^;]+1u, \(-3\.0\)\)/,
    );
    assert.equal(result.cpp.match(/bbl::add_asset_entities\(/g)?.length, 2);
    assert.match(result.cpp, /bbl::go_to_frame\([^;]+30\.0, false\)/);

    assert.throws(
        () =>
            compileSource(
                `
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
            `,
                labDeployment,
            ),
        /Unsupported property assignment '.*\.material'/,
    );

    assert.throws(
        () =>
            compileSource(
                `
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
            `,
                labDeployment,
            ),
        // The loop variable shadows the function: the "recursive" call names a node.
        /Call 'assignMaterial' does not resolve to a supported Babylon intrinsic or local function declaration/,
    );

    assert.throws(
        () =>
            compileSource(
                `
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
            `,
                labDeployment,
            ),
        /currently accepts only a scene-created PBR material/,
    );

    assert.throws(
        () =>
            compileSource(
                `
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
            `,
                labDeployment,
            ),
        /A recursive function was called with a different compile-time argument/,
    );
});

test("an enum-like intrinsic option reads its string through one pin table", () => {
    const result = compileSource(`
        import { createEngine, loadSpriteAtlas, createSprite2DLayer, loadTexture2D } from "@babylonjs/lite";
        async function main(smooth: boolean): Promise<void> {
            const engine = await createEngine({});
            const sampling: "linear" | "nearest" = smooth ? "linear" : "nearest";
            const atlas = await loadSpriteAtlas(engine, "sprites.png", { gridSize: [1, 1], sampling });
            createSprite2DLayer(atlas, { capacity: 1, depth: "test-write" });
            await loadTexture2D(engine, "a.png", { addressModeU: smooth ? "repeat" : "mirror-repeat" });
        }
        void main(Math.random() > 0.5);
    `);
    assert.match(
        result.cpp,
        /\(v_fn\d+_sampling == bblscene::\w+::linear \? bbl::TextureFilter::linear : bbl::TextureFilter::nearest\)/,
    );
    assert.match(result.cpp, /bbl::Sprite2DDepthMode::test_write/);
    assert.match(
        result.cpp,
        /\(v_fn\d+_smooth \? bbl::TextureAddressMode::repeat : bbl::TextureAddressMode::mirror\)/,
    );
    // An option a generation-time decision reads takes a known string.
    const engine = `import { createEngine, loadSpriteAtlas, createSprite2DLayer, loadTexture2D } from "@babylonjs/lite";
        async function main(): Promise<void> {
            const engine = await createEngine({});`;
    assert.throws(
        () =>
            compileSource(`${engine}
            const mode: "nearest" | "linear" = Math.random() > 0.5 ? "nearest" : "linear";
            await loadTexture2D(engine, "a.png", { minFilter: mode });
        }
        void main();`),
        /A texture filter must be a generation-known string/,
    );
    assert.throws(
        () =>
            compileSource(`${engine}
            const atlas = await loadSpriteAtlas(engine, "sprites.png", { gridSize: [1, 1] });
            const mode: "none" | "test" = Math.random() > 0.5 ? "none" : "test";
            createSprite2DLayer(atlas, { capacity: 1, depth: mode });
        }
        void main();`),
        /A sprite layer depth mode must be a generation-known string/,
    );
});

test("reads a mesh's renderOrder and copies it, undefined until assigned", () => {
    // The pin's draw reads `mesh.renderOrder ?? default`: copying an
    // unassigned order leaves the copy on its family default.
    const result = compileSource(`
        import { addToScene, createBox, createEngine, createSceneContext } from "@babylonjs/lite";
        const engine = await createEngine({});
        const scene = createSceneContext(engine);
        const base = createBox(engine);
        const patch = createBox(engine);
        if (Math.random() > 0.5) base.renderOrder = 110;
        patch.renderOrder = base.renderOrder;
        addToScene(scene, base);
        addToScene(scene, patch);
    `);

    assert.match(
        result.cpp,
        /const std::optional<double> (v_bblite_render_order_\d+) = [^\n]*bbl::handle_at\(v_engine\.meshes, v_base\)\.render_order_value\(\)/,
    );
    assert.match(
        result.cpp,
        /bbl::handle_at\(v_engine\.meshes, v_patch\)\.render_order = v_bblite_render_order_\d+\.value_or\(0\.0\);/,
    );
    assert.match(
        result.cpp,
        /bbl::handle_at\(v_engine\.meshes, v_patch\)\.has_render_order = v_bblite_render_order_\d+\.has_value\(\);/,
    );
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
            const engine = await createEngine(document.createElement("canvas"));
            await build(engine);
        }
    `);

    assert.match(result.cpp, /bbl::upload_thin_instance_matrices/);
    assert.doesNotMatch(result.cpp, /writeBuffer|_gpuBuffer|_dirtyMin/);
});

/** The pinned pool opening every dynamic thin-instance source is built on. */
const thinInstancePoolSource = (body: string): string => `
    import {
        addThinInstance,
        addToScene,
        createBox,
        createEngine,
        createSceneContext,
        enableThinInstanceGpuCulling,
        createIdentityMat4,
        removeThinInstance,
        setThinInstanceColors,
        setThinInstanceCount,
        setThinInstances,
    } from "@babylonjs/lite";

    async function main() {
        const engine = await createEngine(document.createElement("canvas"));
        const scene = createSceneContext(engine);
        const mesh = createBox(engine);
        setThinInstances(mesh, new Float32Array(16 * 16), 16);
        setThinInstanceCount(mesh, 0);
        enableThinInstanceGpuCulling(mesh);
        addToScene(scene, mesh);
${body}
    }
`;

test("lowers the pinned thin-instance pool lifecycle", () => {
    const result = compileSource(
        thinInstancePoolSource(`
        const first = addThinInstance(mesh, createIdentityMat4());
        const second = addThinInstance(mesh, createIdentityMat4());
        removeThinInstance(mesh, first);
        removeThinInstance(mesh, second);
        const colors = new Float32Array(64);
        colors.fill(1, second * 4, second * 4 + 4);
        colors.copyWithin(first * 4, second * 4, second * 4 + 4);
        setThinInstanceColors(mesh, colors);
        setThinInstanceCount(mesh, mesh.thinInstances!.count - 1);
    `),
    );

    assert.deepEqual(
        result.manifest.features.filter((feature) =>
            feature.startsWith("mesh:thin-instance"),
        ),
        [
            "mesh:thin-instances",
            "mesh:thin-instance-colors",
            "mesh:thin-instances-dynamic",
            "mesh:thin-instance-gpu-culling",
        ],
    );
    // The returned slot is a value the source binds and indexes with.
    assert.match(
        result.cpp,
        /double \w*first = bbl::add_thin_instance\([^,\n]+, \w*mesh, \w*thin_matrix_\d+\)/,
    );
    assert.match(
        result.cpp,
        /bbl::remove_thin_instance\([^,\n]+, \w*mesh, \w*first\)/,
    );
    // The live count read, backed by the record's active count.
    assert.match(result.cpp, /bbl::thin_instance_count\([^,\n]+, \w*mesh\)/);
    // The pin's own `enabled = true` default, folded at the call site.
    assert.match(
        result.cpp,
        /bbl::enable_thin_instance_gpu_culling\([^,\n]+, \w*mesh, true\)/,
    );
    // The ranged typed-array pair, as generic helpers over the receiver.
    assert.match(
        result.cpp,
        /bbl::js::array_fill_range\(\w*colors, static_cast<float>\(1\.0\), \(\w*second \* 4\.0\), \(\(\w*second \* 4\.0\) \+ 4\.0\)\)/,
    );
    assert.match(
        result.cpp,
        /bbl::js::array_copy_within\(\w*colors, \(\w*first \* 4\.0\), \(\w*second \* 4\.0\), \(\(\w*second \* 4\.0\) \+ 4\.0\)\)/,
    );
});

test("records the omitted thin-instance GPU culler as an adaptation", () => {
    const enabled = compileSource(
        thinInstancePoolSource(
            "        addThinInstance(mesh, createIdentityMat4());",
        ),
    );
    const adaptation = enabled.manifest.adaptations.find(
        ({ id }) => id === "thin-instance-gpu-culling-omitted",
    );
    assert.equal(adaptation?.category, "rendering");
    assert.equal(adaptation?.risk, "low");
    assert.match(adaptation?.nativeSemantics ?? "", /every ACTIVE instance/);

    // A statically-`false` opt-in cannot turn the culler on: upstream
    // `_gpuCullingEnabled` starts false, so the pinned body returns at its
    // own idempotence test. There is no omission to record, and recording
    // one would put a fidelity entry naming a divergence that does not
    // exist into a scene that never asked for culling.
    const withCulling = (call: string): string => `
        import {
            addToScene,
            createBox,
            createEngine,
            createSceneContext,
            enableThinInstanceGpuCulling,
            setThinInstances,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine(document.createElement("canvas"));
            const scene = createSceneContext(engine);
            const mesh = createBox(engine);
            setThinInstances(mesh, new Float32Array(16), 1);
${call}
            addToScene(scene, mesh);
        }
    `;
    const disabled = compileSource(
        withCulling("            enableThinInstanceGpuCulling(mesh, false);"),
    );
    assert.doesNotMatch(disabled.cpp, /enable_thin_instance_gpu_culling/);
    assert.ok(
        !disabled.manifest.features.includes("mesh:thin-instance-gpu-culling"),
    );
    assert.ok(
        !disabled.manifest.adaptations.some(
            ({ id }) => id === "thin-instance-gpu-culling-omitted",
        ),
    );
    // The pool itself is still reached, so the scene keeps drawing through
    // the thin-instance arm.
    assert.ok(disabled.manifest.features.includes("mesh:thin-instances"));

    // The pin's own `enabled = true` default, and an explicit `true`, both
    // reach the opt-in and record the omission.
    for (const call of [
        "            enableThinInstanceGpuCulling(mesh);",
        "            enableThinInstanceGpuCulling(mesh, true);",
    ]) {
        const opted = compileSource(withCulling(call));
        assert.match(
            opted.cpp,
            /bbl::enable_thin_instance_gpu_culling\([^,\n]+, \w*mesh, true\)/,
        );
        assert.ok(
            opted.manifest.features.includes("mesh:thin-instance-gpu-culling"),
        );
        assert.ok(
            opted.manifest.adaptations.some(
                ({ id }) => id === "thin-instance-gpu-culling-omitted",
            ),
        );
    }

    // A disable that FOLLOWS an enable still moves the pin's flag, so it
    // keeps its call.
    const toggled = compileSource(
        withCulling(
            "            enableThinInstanceGpuCulling(mesh);\n" +
                "            enableThinInstanceGpuCulling(mesh, false);",
        ),
    );
    assert.match(
        toggled.cpp,
        /bbl::enable_thin_instance_gpu_culling\([^,\n]+, \w*mesh, false\)/,
    );

    // The pin reads `mesh.thinInstances` and throws without one; a mesh
    // generation resolved and never bound a pool on fails at its own line,
    // whichever way the flag was passed.
    for (const argument of ["", ", false", ", true"]) {
        assert.throws(
            () =>
                compileSource(`
                    import {
                        createBox,
                        createEngine,
                        enableThinInstanceGpuCulling,
                    } from "@babylonjs/lite";

                    async function main() {
                        const engine = await createEngine(document.createElement("canvas"));
                        const mesh = createBox(engine);
                        enableThinInstanceGpuCulling(mesh${argument});
                    }
                `),
            /requires a thin-instance pool this mesh never establishes/,
        );
    }
});

test("tests a mesh's thin-instance pool by its presence", () => {
    // `mesh.thinInstances` is undefined until a setter makes the pool, so a
    // guard that makes an empty one only when absent reads the record.
    const { cpp } = compileSource(`
        import {
            addThinInstance,
            createBox,
            createEngine,
            enableThinInstanceGpuCulling,
            removeThinInstance,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine(document.createElement("canvas"));
            const mesh = createBox(engine);
            if (!mesh.thinInstances) {
                addThinInstance(mesh, new Float32Array(16));
                removeThinInstance(mesh, 0);
            }
            enableThinInstanceGpuCulling(mesh, true);
        }
    `);
    assert.match(
        cpp,
        /if \(!\(static_cast<bool>\(bbl::handle_at\([^\n]*\.meshes, [^\n]*\)\.thin_instances\)\)\)/,
    );
});

test("refuses thin-instance pool calls the pin cannot serve", () => {
    const withPool = (body: string): string => `
        import {
            addThinInstance,
            createBox,
            createEngine,
            createIdentityMat4,
            removeThinInstance,
            setThinInstances,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine(document.createElement("canvas"));
            const mesh = createBox(engine);
            setThinInstances(mesh, new Float32Array(16), 1);
${body}
        }
    `;
    assert.throws(
        () => compileSource(withPool("            addThinInstance(mesh);")),
        /Expected 2 arguments/,
    );
    assert.throws(
        () =>
            compileSource(
                withPool("            removeThinInstance(mesh, 0, 1);"),
            ),
        /Expected 2 arguments/,
    );
    // A mesh that holds no pool reads `thinInstances` as undefined; a member
    // read off it throws the pin's TypeError when it runs
    // (`thin_instance_data`), whichever setter a later line reaches.
    assert.match(
        compileSource(`
            import {
                createBox,
                createEngine,
            } from "@babylonjs/lite";

            async function main() {
                const engine = await createEngine(document.createElement("canvas"));
                const mesh = createBox(engine);
                const count = mesh.thinInstances!.count;
                console.log(count);
            }
        `).cpp,
        /bbl::thin_instance_count\(bbl::handle_at\(\w+\.meshes, \w+\)\.thin_instances\)/,
    );
    assert.throws(
        () =>
            compileSource(`
                import { createBox, createEngine } from "@babylonjs/lite";
                async function main() {
                    const engine = await createEngine(document.createElement("canvas"));
                    const mesh = createBox(engine);
                    const values = new Float32Array(8);
                    values.copyWithin(0);
                }
            `),
        /copyWithin expects two or three arguments/,
    );
});

test("keeps a static thin-instance scene free of the pool helpers", () => {
    // Scene 16's shape: a pool established once and never grown. None of
    // the growing half may reach the emitted runtime, which is what keeps
    // every scene that does not drive a live pool byte-identical.
    const result = compileSource(`
        import {
            addToScene,
            createBox,
            createEngine,
            createSceneContext,
            setThinInstanceColors,
            setThinInstances,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine(document.createElement("canvas"));
            const scene = createSceneContext(engine);
            const mesh = createBox(engine);
            const matrices = new Float32Array(32);
            setThinInstances(mesh, matrices, 2);
            setThinInstanceColors(mesh, new Float32Array(8));
            addToScene(scene, mesh);
        }
    `);

    assert.ok(
        !result.manifest.features.includes("mesh:thin-instances-dynamic"),
    );
    assert.ok(
        !result.manifest.features.includes("mesh:thin-instance-gpu-culling"),
    );
    assert.ok(
        !result.manifest.adaptations.some(
            ({ id }) => id === "thin-instance-gpu-culling-omitted",
        ),
    );
    assert.doesNotMatch(result.cpp, /add_thin_instance/);
    assert.doesNotMatch(result.cpp, /remove_thin_instance/);
    assert.doesNotMatch(result.cpp, /bbl::thin_instance_count/);
    assert.doesNotMatch(result.cpp, /enable_thin_instance_gpu_culling/);
});

test("dynamic engine and scene options lower as the pin reads them or refuse", () => {
    const pixelRatio = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        const MAX_DPR = 1;
        async function main() {
            await createEngine({}, { maxDevicePixelRatio: MAX_DPR });
        }
    `);
    assert.doesNotMatch(pixelRatio.cpp, /maxDevicePixelRatio|MAX_DPR/);
    assert.match(pixelRatio.cpp, /EngineOptions\{[^}]*, 0, 1\}/);
    // Without a realm only a static cap of 1 or more sizes the window; any
    // other cap selects the application realm and the pinned resize.
    for (const [cap, realm] of [
        ["cap", true],
        ["0.5", true],
        ["0", true],
        ["3", false],
    ] as const) {
        const compiled = compileSource(`
            import { createEngine } from "@babylonjs/lite";
            const cap: number = JSON.parse("0.75");
            async function main() {
                const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
                await createEngine(canvas, { maxDevicePixelRatio: ${cap} });
            }
            void main();
        `);
        assert.equal(
            compiled.manifest.features.includes("platform:window"),
            realm,
        );
        assert.equal(/bbl::install_surface_resize\(/.test(compiled.cpp), realm);
    }
    assert.throws(
        () =>
            compileSource(`
                import {
                    createEngine,
                } from "@babylonjs/lite";
                async function main() {
                    await createEngine({}, { msaaSamples: 2 });
                }
            `),
        /supports explicit msaaSamples: 1 or 4 only/,
    );
    const runtimeSamples = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        async function main() {
            const msaaSamples = JSON.parse("1");
            await createEngine({}, { msaaSamples });
        }
    `);
    assert.equal(runtimeSamples.manifest.engineMsaaSamples, undefined);
    const staticSceneOption = compileSource(`
        import {
            createEngine,
            createSceneContext,
        } from "@babylonjs/lite";
        async function main() {
            const engine = await createEngine({});
            const enabled = true;
            createSceneContext(engine, { defaultRenderTask: enabled });
        }
    `);
    assert.match(staticSceneOption.cpp, /bbl::create_scene_context/);
    assert.doesNotMatch(
        staticSceneOption.cpp,
        /bbl::configure_scene_render_defaults/,
    );
    // A run-time choice reaches the native scene: the pin's
    // `options?.defaultRenderTask !== false`, the member or the whole record
    // decided as the program runs.
    for (const options of [
        "{ defaultRenderTask: performance.now() > 0 }",
        "performance.now() > 0 ? { defaultRenderTask: false } : undefined",
    ]) {
        const runtime = compileSource(`
            import { createEngine, createSceneContext } from "@babylonjs/lite";
            async function main() {
                const engine = await createEngine({});
                const options = ${options};
                createSceneContext(engine, options);
            }
        `);
        assert.match(
            runtime.cpp,
            /bbl::configure_scene_render_defaults\(bbl::create_scene_context\(v_engine\), (?!true,|false,)[^;]+, 4u\)/,
            options,
        );
    }
});

test("folds and propagates the pinned engine MSAA selections", () => {
    const source = `
        import { createEngine } from "@babylonjs/lite";
        async function main() {
            const selected: 1 | 4 =
                new URLSearchParams(window.location.search).get("msaa") === "4"
                    ? 4
                    : 1;
            await createEngine({}, { msaaSamples: selected });
        }
    `;
    const single = compileSource(source);
    assert.equal(single.manifest.engineMsaaSamples, 1);
    const multisampled = compileSource(source, { search: "?msaa=4" });
    assert.equal(multisampled.manifest.engineMsaaSamples, 4);
});

test("reports invalid Babylon Lite API arguments with source locations", () => {
    assert.throws(
        () =>
            compileSource(
                `import { updateDefaultTextData, createEngine } from "@babylonjs/lite";
async function main() {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    updateDefaultTextData();
}`,
                { fileName: "unsupported.ts" },
            ),
        (error: unknown) => {
            assert.ok(error instanceof CompileError);
            assert.match(error.message, /^unsupported\.ts:5:5:/);
            assert.match(error.message, /Expected 2-3 arguments, received 0/);
            return true;
        },
    );
});

test("compiles pinned Scene 1 BoomBox parity", () => {
    const sourcePath = "corpus/babylon-lite/lab/lite/src/lite/scene1.ts";
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
        "renderer:scene",
    ]);
    assert.deepEqual(result.manifest.runtimeSources, [
        "src/pal.cpp",
        "src/pal_sdl.cpp",
        "src/pal_image.cpp",
        "src/pal_sdl_gpu.cpp",
    ]);
    assert.deepEqual(
        result.manifest.adaptations.map(({ id }) => id),
        [
            "entry-main-wrapper-erasure",
            "browser-setup-erasure",
            "synchronous-aot-await",
            "plain-data-value-model",
            "compile-time-asset-materialization",
            "sdl-platform-boundary",
            "sdl-gpu-shader-backends",
            "shared-material-vertex-transport",
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
                source: pinnedAssetUrl(
                    "packages/babylon-lite/assets/brdf-lut.png",
                ),
                kind: "texture",
            },
        ],
    );
    assert.match(result.cpp, /bbl::load_gltf/);
    assert.match(result.cpp, /bbl::load_environment/);
    assert.match(result.cpp, /bbl::create_default_camera/);
    assertCameraScalarWrite(result.cpp, "alpha", /1\.77538/);
    assert.doesNotMatch(result.cpp, /Object::assign|drawCallCount/);
    assert.match(result.cmake, /gltf_loader\.cpp/);
    assert.deepEqual(result.manifest.generatedSources, [
        "upstream/src/engine.cpp",
        "upstream/src/thin_instance_api.cpp",
        "upstream/src/scene_core.cpp",
        "upstream/src/variant_data.cpp",
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
        "renderer:scene",
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

test("compiles Babylon Lite scene 52 scene-owned HUD disposal", () => {
    const sourcePath = "corpus/babylon-lite/lab/lite/src/lite/scene52.ts";
    const result = compileSource(readFileSync(resolve(sourcePath), "utf8"), {
        fileName: sourcePath,
    });

    assert.match(
        result.cpp,
        /bbl::on_scene_dispose\(v_scene, bbl::js::make_closure\(bblscene::bbl_environment_\w+\{std::ref\(v_hudRenderer\), std::ref\(v_engine\)\}, bblscene::\w+/,
    );
    assert.match(
        result.cpp,
        /bbl::dispose_sprite_renderer\(v_engine, v_hudRenderer\);/,
    );
    assert.doesNotMatch(result.cpp, /onSceneDispose/);
    assert.ok(
        result.manifest.generatedSources.includes(
            "upstream/src/scene_core.cpp",
        ),
    );
    assert.ok(
        result.manifest.generatedSources.includes("upstream/src/sprite_2d.cpp"),
    );
});

test("compiles Babylon Lite scene 53 depth-hosted per-instance-z sprites", () => {
    const sourcePath = "corpus/babylon-lite/lab/lite/src/lite/scene53.ts";
    const result = compileSource(readFileSync(resolve(sourcePath), "utf8"), {
        fileName: sourcePath,
    });

    assert.deepEqual(result.manifest.features, [
        "core",
        "backend:sdl",
        "camera:arc-rotate",
        "light:hemispheric",
        "material:standard",
        "mesh:box",
        "sprite:2d",
        "sprite:2d-depth-host",
        "renderer:sprite",
        "renderer:scene",
    ]);
    assert.match(
        result.cpp,
        /Sprite2DLayerOptions\{[^;]*sprite_blend_opaque\(\)[^;]*Sprite2DDepthMode::test_write/,
    );
    assert.equal(
        result.cpp.match(/static_cast<double>\((?:0\.6|0\.87|0\.95)\), true\}/g)
            ?.length,
        3,
    );
    assert.match(result.cpp, /set_sprite_2d_alpha_to_coverage\([^;]+true\)/);
    assert.match(result.cpp, /add_depth_hosted_sprite_layer\(/);
    assert.equal(result.manifest.pureSpriteVertex, false);
});

test("refuses depth-hosted layers in standalone SpriteRenderers", () => {
    const sourcePath = "corpus/babylon-lite/lab/lite/src/lite/scene53.ts";
    const source = readFileSync(resolve(sourcePath), "utf8");
    const withRendererImports = source.replace(
        "    addDepthHostedSpriteLayerToScene,",
        "    addSpriteRendererLayer,\n    createSpriteRenderer,",
    );

    assert.throws(
        () =>
            compileSource(
                withRendererImports.replace(
                    "    addDepthHostedSpriteLayerToScene(scene, sprites);",
                    "    createSpriteRenderer(engine, { layers: [sprites] });",
                ),
                { fileName: sourcePath },
            ),
        /SpriteRenderer layers require depth: "none"/,
    );
    assert.throws(
        () =>
            compileSource(
                withRendererImports.replace(
                    "    addDepthHostedSpriteLayerToScene(scene, sprites);",
                    "    const renderer = createSpriteRenderer(engine, { layers: [] });\n" +
                        "    addSpriteRendererLayer(renderer, sprites);",
                ),
                { fileName: sourcePath },
            ),
        /SpriteRenderer layers require depth: "none"/,
    );
});

test("keeps sprite layers as handles when returned through data records and arrays", () => {
    const result = compileSource(`
        import {
            addSpriteRendererLayer,
            createEngine,
            createSprite2DLayer,
            createSpriteRenderer,
            loadSpriteAtlas,
            type Sprite2DLayer,
        } from "babylon-lite";

        interface LayerBundle {
            layer: Sprite2DLayer;
            layers: Sprite2DLayer[];
        }

        function bundleLayer(layer: Sprite2DLayer): LayerBundle {
            return { layer, layers: [layer] };
        }

        async function main(): Promise<void> {
            const engine = await createEngine({});
            const atlas = await loadSpriteAtlas(engine, "sprites.png", {
                gridSize: [1, 1],
            });
            const first = bundleLayer(createSprite2DLayer(atlas, {
                capacity: 1,
                depth: "none",
            }));
            const second = bundleLayer(first.layer);
            const bundles = [first, second];
            const mapped = bundles.map((entry) => entry.layer);
            const mixed = [first.layer, second.layer];
            const renderer = createSpriteRenderer(engine, {
                layers: mapped,
            });
            addSpriteRendererLayer(renderer, mixed[0]);
        }
        void main();
    `);

    assert.equal(result.cpp.match(/bbl::create_sprite_2d_layer\(/g)?.length, 1);
    // Engine-owned layer storage passes the layers its pairs hold.
    assert.match(
        result.cpp,
        /SpriteRendererOptions\{\(\[&\] \{ std::vector<bbl::Sprite2DLayerHandle> layers; for \(const auto& layer : v_mapped\) layers\.push_back\(layer\.second\); return layers; \}\(\)\)/,
    );
    assert.doesNotMatch(result.cpp, /std::string v_[^;]*(?:layer|layers)/);
});

test("retains Scene 117's nullable sprite pick record and all hit fields", () => {
    const sourcePath = "corpus/babylon-lite/lab/lite/src/lite/scene117.ts";
    const result = compileSource(readFileSync(resolve(sourcePath), "utf8"), {
        fileName: sourcePath,
    });

    assert.match(
        result.cpp,
        /using SpritePickInfo = bbl::js::Ref<SpritePickInfoData>;/,
    );
    assert.match(
        result.cpp,
        /if \(!hit\) return bblscene::SpritePickInfo\{\};/,
    );
    assert.match(
        result.cpp,
        /pick_sprite_2d\(v_engine, bbl::handle_at\(v_engine\.sprite_renderers, [\s\S]*?\)\.layers,/,
    );
    assert.doesNotMatch(
        result.cpp,
        /array_to_vector\(v_engine\.sprite_renderers/,
    );
    assert.match(
        result.cpp,
        /bbl::js::make_ref<bblscene::SpritePickInfoData>\(bblscene::SpritePickInfoData\{hit->layer, static_cast<double>\(hit->sprite_index\), hit->u, hit->v\}\)/,
    );
    assert.match(result.cpp, /bblscene::SpritePickInfo v_hit = /);
    assert.doesNotMatch(result.cpp, /static bblscene::SpritePickInfo v_hit/);
    assert.match(
        result.cpp,
        /update_sprite_2d_index\(v_engine, v_hit->layer, v_hit->spriteIndex,/,
    );
});

test("retains Scene 118's nullable billboard pick record and all hit fields", () => {
    const sourcePath = "corpus/babylon-lite/lab/lite/src/lite/scene118.ts";
    const result = compileSource(readFileSync(resolve(sourcePath), "utf8"), {
        fileName: sourcePath,
    });

    assert.ok(result.manifest.features.includes("picking:gpu"));
    assert.ok(result.manifest.features.includes("picking:billboard"));
    assert.match(
        result.cpp,
        /using BillboardPickInfo = bbl::js::Ref<BillboardPickInfoData>;/,
    );
    // The pin's own four members, in its own order, at the types the
    // intrinsic validates: a system HANDLE, the sprite slot, the shared
    // readback's nullable point, and the distance beside it.
    assert.match(
        result.cpp,
        /struct BillboardPickInfoData \{\s*bbl::BillboardSystemHandle system;\s*double spriteIndex\{\};\s*bbl::js::Nullable<bbl::js::Tuple<3>> pickedPoint;\s*double distance\{\};\s*template <typename = void> requires \(bbl::js::gc_traceable<bbl::BillboardSystemHandle>\)[\s\S]*?\n\};/,
    );
    // A miss is the pin's `_spritePick ?? null`: an id no billboard
    // contributor owns leaves the payload unset.
    assert.match(
        result.cpp,
        /if \(info\.picked_kind != bbl::PickedNodeKind::billboard_sprite\) return bblscene::BillboardPickInfo\{\};/,
    );
    assert.match(result.cpp, /bbl::pick_billboard_sprite\(v_engine, v_scene, /);
    assert.match(
        result.cpp,
        /bbl::BillboardSystemHandle\{info\.picked_index\}, static_cast<double>\(info\.picked_range_offset\), bbl::picked_point\(info\), info\.distance\}/,
    );
    // `getCameraPosition` goes through the pin's own two-line body,
    // lowered beside the matrix it reads -- one composition, not one per
    // component, and the float-store rule stated where it is ported.
    assert.match(
        result.cpp,
        /const bbl::Vec3d eye = bbl::upstream::camera_position\(bbl::handle_at\(v_engine\.cameras, v_camera\)\); return bblscene::Vec3\{eye\.x, eye\.y, eye\.z\}/,
    );
});

test("a camera position whose record type is a document is a fresh document of its lanes", () => {
    // A parsed position shares the `{ x, y, z }` record type, which then
    // stores documents: the camera's position is one, read off the same
    // composition of the pin's body.
    const result = compileSource(`
        import { createArcRotateCamera, createEngine, getCameraPosition } from "babylon-lite";
        const engine = await createEngine({});
        const camera = createArcRotateCamera(1, 1, 10, { x: 0, y: 0, z: 0 });
        let saved: { x: number; y: number; z: number } = JSON.parse('{"x":1,"y":2,"z":3}') as { x: number; y: number; z: number };
        const eye = getCameraPosition(camera);
        if (eye.y > 100) saved = eye;
        if (saved.x !== 1 || !(eye.y > -100)) throw new Error("eye");
    `);
    assert.match(
        result.cpp,
        /const bbl::Vec3d eye = bbl::upstream::camera_position\(bbl::handle_at\(v_engine\.cameras, v_camera\)\); bbl::js::JsonValue::Object own; own\.emplace_back\("x", bbl::js::json_value\(eye\.x\)\);/,
    );
});

test("a loop reading the camera's position each pass may return from inside", () => {
    // The read records no composition row: the loop runs as written.
    const result = compileSource(`
        import { createArcRotateCamera, createEngine, getCameraPosition } from "babylon-lite";
        const engine = await createEngine({});
        const camera = createArcRotateCamera(1, 1, 10, { x: 0, y: 0, z: 0 });
        const floorAt = (x: number, z: number): number => Math.sin(x) + Math.cos(z);
        function lift(): boolean {
            for (let pass = 0; pass < 4; pass++) {
                const eye = getCameraPosition(camera);
                if (eye.y >= floorAt(eye.x, eye.z) + 0.5) return true;
                const before = camera.beta;
                camera.beta -= 0.1;
                if (camera.beta === before) return false;
            }
            return false;
        }
        if (!lift() && camera.beta > 2) throw new Error("lift");
    `);
    assert.match(
        result.cpp,
        /for \(; v_fn[0-9]+_block[0-9]+_pass < 4; [^)]*\) \{[\s\S]*?bbl::upstream::camera_position\([\s\S]*?return true;/,
    );
});

test("refuses pickBillboardSprite's caller-owned picker by name", () => {
    assert.throws(
        () =>
            compileSource(`
        import {
            createEngine,
            createFacingBillboardSystem,
            createGpuPicker,
            createSceneContext,
            loadSpriteAtlas,
            pickBillboardSprite,
        } from "babylon-lite";

        async function main(): Promise<void> {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            const atlas = await loadSpriteAtlas(engine, "sprites.png", {
                gridSize: [1, 1],
            });
            createFacingBillboardSystem(atlas, { capacity: 1 });
            const picker = createGpuPicker(scene);
            await pickBillboardSprite(scene, 0, 0, picker);
        }
        void main();
    `),
        /optional picker is the pin's own reuse path/,
    );
});

test("lowers the Sprite2D handle and Y-sort entry points", () => {
    const result = compileSource(`
        import {
            addSprite2D,
            createEngine,
            createSprite2DLayer,
            createSpriteRenderer,
            enableSprite2DYSort,
            getSprite2DHandleIndex,
            loadSpriteAtlas,
            registerSpriteRenderer,
            setSprite2DYSortHandleBias,
            startEngine,
            updateSprite2D,
            updateSprite2DIndex,
        } from "babylon-lite";

        async function main(): Promise<void> {
            const engine = await createEngine({});
            const atlas = await loadSpriteAtlas(engine, "sprites.png", {
                gridSize: [1, 1],
            });
            const layer = createSprite2DLayer(atlas, {
                capacity: 4,
                depth: "none",
            });
            const hero = addSprite2D(layer, { positionPx: [1, 2] });
            const ySort = enableSprite2DYSort(layer, { defaultBias: 3 });
            const renderer = createSpriteRenderer(engine, {
                layers: [layer],
            });
            renderer._beforeUpdate.push(() => {
                updateSprite2D(hero, { positionPx: [4, 5] });
                setSprite2DYSortHandleBias(hero, 7);
            });
            registerSpriteRenderer(renderer);
            await startEngine(engine);
            // Both reads feed native work rather than a dataset write, so
            // neither is browser-erased before it lowers.
            if (ySort.enabled) {
                updateSprite2DIndex(
                    layer,
                    getSprite2DHandleIndex(hero),
                    { color: [1, 0, 0, 1] },
                );
            }
        }
        void main();
    `);

    // The enabler is the opt-in that pulls the extension in, and the
    // renderer's own hook list is where a per-frame closure lands.
    assert.ok(result.manifest.features.includes("sprite:2d-y-sort"));
    assert.match(
        result.cpp,
        /bbl::enable_sprite_2d_y_sort\(\w+, \w+, std::optional<double>\{static_cast<double>\(3\.0\)\}\)/,
    );
    assert.match(
        result.cpp,
        /bbl::sprite_renderer_before_update\(\w+, \w+, bbl::js::make_closure\(bblscene::bbl_environment_\w+\{std::ref\(v_hero\), std::ref\(v_engine\), std::ref\(v_layer\)\}, bblscene::\w+/,
    );
    // The hook takes the delta the renderer passes, a double (GC-20).
    assert.match(
        result.cpp,
        /void v_bblite_closure_body_\d+\(\[\[maybe_unused\]\] Environment& \w+, double\)/,
    );
    // Both handle entry points resolve the slot the id names at the call,
    // never the slot the add returned.
    assert.match(result.cpp, /bbl::update_sprite_2d_id\(/);
    assert.match(result.cpp, /bbl::set_sprite_2d_y_sort_bias_id\(/);
    assert.match(result.cpp, /bbl::sprite_2d_handle_index\(/);
    // `ySort.enabled` is a live question about the layer, not a fold.
    assert.match(result.cpp, /bbl::sprite_2d_y_sort_enabled\(/);
});

test("refuses a _beforeUpdate push that is not a SpriteRenderer's", () => {
    assert.throws(
        () =>
            compileSource(`
        import { createEngine, createSceneContext } from "babylon-lite";

        async function main(): Promise<void> {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            (scene as unknown as { _beforeUpdate: Array<() => void> })
                ._beforeUpdate.push(() => undefined);
        }
        void main();
    `),
        /SpriteRenderer's own\s*\/\/?\s*per-frame hook list|per-frame hook list/,
    );
});

test("a sprite scene that never enables Y-sort reaches no Y-sort feature", () => {
    const result = compileSource(`
        import {
            addSprite2DIndex,
            createEngine,
            createSprite2DLayer,
            createSpriteRenderer,
            loadSpriteAtlas,
            registerSpriteRenderer,
            startEngine,
        } from "babylon-lite";

        async function main(): Promise<void> {
            const engine = await createEngine({});
            const atlas = await loadSpriteAtlas(engine, "sprites.png", {
                gridSize: [1, 1],
            });
            const layer = createSprite2DLayer(atlas, {
                capacity: 4,
                depth: "none",
            });
            addSprite2DIndex(layer, { positionPx: [1, 2] });
            registerSpriteRenderer(
                createSpriteRenderer(engine, { layers: [layer] }),
            );
            await startEngine(engine);
        }
        void main();
    `);

    assert.ok(result.manifest.features.includes("sprite:2d"));
    assert.ok(!result.manifest.features.includes("sprite:2d-y-sort"));
});

test("compiles a SpriteRenderer.layers owner only once for picking", () => {
    const result = compileSource(`
        import {
            createEngine,
            createSprite2DLayer,
            createSpriteRenderer,
            loadSpriteAtlas,
            pickSprite2D,
            updateSprite2DIndex,
        } from "babylon-lite";

        async function main(): Promise<void> {
            const engine = await createEngine({});
            const atlas = await loadSpriteAtlas(engine, "sprites.png", {
                gridSize: [1, 1],
            });
            const layer = createSprite2DLayer(atlas, {
                capacity: 1,
                depth: "none",
            });
            const hit = pickSprite2D(
                createSpriteRenderer(engine, { layers: [layer] }).layers,
                0,
                0,
            );
            if (hit) {
                updateSprite2DIndex(hit.layer, hit.spriteIndex, {
                    color: [1, 0, 0, 1],
                });
            }
        }
        void main();
    `);

    assert.equal(
        [...result.cpp.matchAll(/bbl::create_sprite_renderer\(/g)].length,
        1,
    );
    assert.doesNotMatch(result.cpp, /array_to_vector\([^;]*sprite_renderers/);
});

test("preserves native SpriteRenderer.layers through a local pick alias", () => {
    const result = compileSource(`
        import {
            createEngine,
            createSprite2DLayer,
            createSpriteRenderer,
            loadSpriteAtlas,
            pickSprite2D,
        } from "babylon-lite";

        async function main(): Promise<void> {
            const engine = await createEngine({});
            const atlas = await loadSpriteAtlas(engine, "sprites.png", {
                gridSize: [1, 1],
            });
            const layer = createSprite2DLayer(atlas, {
                capacity: 1,
                depth: "none",
            });
            const renderer = createSpriteRenderer(engine, {
                layers: [layer],
            });
            const layers = renderer.layers;
            pickSprite2D(layers, 0, 0);
        }
        void main();
    `);

    assert.match(result.cpp, /auto& v_layers = [^;]+\.layers;/);
    assert.match(result.cpp, /bbl::pick_sprite_2d\(v_engine, v_layers,/);
    assert.doesNotMatch(result.cpp, /array_to_vector\(v_layers\)/);
});

test("passes direct SpriteRenderer.layers to another renderer natively", () => {
    const result = compileSource(`
        import {
            createEngine,
            createSprite2DLayer,
            createSpriteRenderer,
            loadSpriteAtlas,
        } from "babylon-lite";

        async function main(): Promise<void> {
            const engine = await createEngine({});
            const atlas = await loadSpriteAtlas(engine, "sprites.png", {
                gridSize: [1, 1],
            });
            const layer = createSprite2DLayer(atlas, {
                capacity: 1,
                depth: "none",
            });
            const sourceRenderer = createSpriteRenderer(engine, {
                layers: [layer],
            });
            createSpriteRenderer(engine, {
                layers: sourceRenderer.layers,
            });
        }
        void main();
    `);

    assert.match(
        result.cpp,
        /SpriteRendererOptions\{bbl::handle_at\(v_engine\.sprite_renderers, [^;]*?\.layers,/,
    );
    assert.doesNotMatch(result.cpp, /array_to_vector\([^;]*sprite_renderers/);
});

test("does not leak sprite depth metadata across conditional handles", () => {
    const result = compileSource(`
        import {
            createEngine,
            createSprite2DLayer,
            createSpriteRenderer,
            loadSpriteAtlas,
        } from "babylon-lite";

        async function main(): Promise<void> {
            const engine = await createEngine({});
            const atlas = await loadSpriteAtlas(engine, "sprites.png", {
                gridSize: [1, 1],
            });
            const depthLayer = createSprite2DLayer(atlas, {
                capacity: 1,
                depth: "test",
            });
            const flatLayer = createSprite2DLayer(atlas, {
                capacity: 1,
                depth: "none",
            });
            let useDepth = false;
            const selected = useDepth ? depthLayer : flatLayer;
            createSpriteRenderer(engine, { layers: [selected] });
        }
        void main();
    `);

    assert.match(result.cpp, /\(v_useDepth \? v_depthLayer : v_flatLayer\)/);
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
        "renderer:scene",
    ]);
    assert.match(
        result.cpp,
        /bbl::enable_orthographic_camera\(v_engine, v_camera, 6\.0\)/,
    );
    assert.equal(result.manifest.sceneMeshes.length, 10);
    assert.equal(result.cpp.match(/bbl::create_box\(/g)?.length, 1);
    assert.equal(
        result.cpp.match(/array_index_checked\(bblscene::COLORS/g)?.length,
        1,
    );
    // The URL override folds away: no query string reaches a native
    // build, so `Number.isFinite(NaN)` drops the branch.
    assert.doesNotMatch(result.cpp, /ortho_half_height/);
    assert.deepEqual(result.manifest.generatedSources, [
        "upstream/src/engine.cpp",
        "upstream/src/scene_core.cpp",
        "upstream/src/variant_data.cpp",
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

test("compiles Babylon Lite scene 32 unlit glTF", () => {
    const source = readFileSync(
        resolve("corpus/babylon-lite/lab/lite/src/lite/scene32.ts"),
        "utf8",
    );
    const result = compileSource(source, {
        fileName: "corpus/babylon-lite/lab/lite/src/lite/scene32.ts",
    });

    assert.ok(result.manifest.features.includes("loader:gltf"));
    assert.ok(result.manifest.features.includes("renderer:scene"));
    assert.match(
        result.cpp,
        /const double \w+ = \(\w+ \+ 3\.141592653589793\);/,
    );
    assert.match(
        result.cpp,
        /write_camera_scalar\([^\n]+&bbl::CameraRecord::alpha,/,
    );
    assert.match(result.cpp, /UnlitTest\.glb/);
});

test("compiles Babylon Lite scene 168 mirrored winding", () => {
    const source = readFileSync(
        resolve("corpus/babylon-lite/lab/lite/src/lite/scene168.ts"),
        "utf8",
    );
    const result = compileSource(source, {
        ...labDeployment,
        fileName: "corpus/babylon-lite/lab/lite/src/lite/scene168.ts",
    });

    assert.ok(result.manifest.features.includes("loader:gltf"));
    assert.ok(result.manifest.features.includes("renderer:scene"));
    assert.match(result.cpp, /MirroredDoubleSided\.glb/);
    assert.match(
        result.cpp,
        /\.clear_color = bbl::Color4\{0\.05f, 0\.06f, 0\.09f, 1\.0f\}/,
    );
});

test("compiles Babylon Lite scene 257 negative scale", () => {
    const source = readFileSync(
        resolve("corpus/babylon-lite/lab/lite/src/lite/scene257.ts"),
        "utf8",
    );
    const result = compileSource(source, {
        ...labDeployment,
        fileName: "corpus/babylon-lite/lab/lite/src/lite/scene257.ts",
    });

    assert.ok(result.manifest.features.includes("loader:gltf"));
    assert.ok(result.manifest.features.includes("renderer:scene"));
    assert.match(result.cpp, /std::sqrt\(800\.0\)/);
    assert.match(result.cpp, /Node_NegativeScale_01\.glb/);
});

test("compiles Babylon Lite scene 266 negative scale spheres", () => {
    const source = readFileSync(
        resolve("corpus/babylon-lite/lab/lite/src/lite/scene266.ts"),
        "utf8",
    );
    const result = compileSource(source, {
        ...labDeployment,
        fileName: "corpus/babylon-lite/lab/lite/src/lite/scene266.ts",
    });

    assert.ok(result.manifest.features.includes("loader:gltf"));
    assert.ok(result.manifest.features.includes("renderer:scene"));
    assert.match(result.cpp, /NegativeScaleTest\.glb/);
    assert.match(result.cpp, /\(3\.141592653589793 \/ 2\.15\)/);
});

// A module's constant tuple the engine takes as a uniform default stays
// the compile-time value the engine reads, even where the program compares
// open values by identity: the engine keeps its own copy.
test("keeps an imported constant uniform default tuple handed to the engine", () => {
    const directory = mkdtempSync(join(tmpdir(), "bblite-uniform-tuple-"));
    try {
        writeFileSync(
            join(directory, "tint.ts"),
            `export const DEFAULT_TINT: [number, number, number] = [0.25, 0.5, 0.75];`,
        );
        const result = compileSource(
            `
            import { createEngine, createShaderMaterial } from "babylon-lite";
            import { DEFAULT_TINT } from "./tint.js";

            const vertexSource = \`struct VertexOutput {
                @builtin(position) position: vec4<f32>,
            };
            @vertex fn mainVertex(input: VertexInput) -> VertexOutput {
                var out: VertexOutput;
                out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position, 1.0);
                return out;
            }\`;
            const fragmentSource = \`@fragment fn mainFragment() -> @location(0) vec4<f32> {
                return vec4<f32>(shaderUniforms.tint, 1.0);
            }\`;
            function same(left: unknown, right: unknown): boolean {
                return left === right;
            }
            function tinted(options: { tint?: [number, number, number] }): void {
                const color = options.tint ?? DEFAULT_TINT;
                createShaderMaterial({
                    name: "tinted",
                    vertexSource,
                    fragmentSource,
                    attributes: ["position"],
                    uniforms: [
                        "worldViewProjection",
                        { name: "tint", type: "vec3<f32>", defaultValue: color },
                    ],
                });
            }

            async function main() {
                await createEngine({});
                tinted({});
                if (same(1, 2)) throw new Error("same");
            }
            `,
            { fileName: join(directory, "entry.ts") },
        );
        assert.deepEqual(result.manifest.shaderVariants, ["tinted"]);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
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
            velocityFormat: "rgba16float",
        },
    ]);
    assert.match(result.cpp, /bbl::create_geometry_renderer_task/);
    assert.match(result.cpp, /bbl::geometry_task_texture/);
    assert.match(result.cpp, /bbl::create_copy_to_texture_task/);
    assert.match(result.cpp, /bbl::add_live_task\([^;]*, true\)/);
    assert.match(result.cpp, /scene146-impostor-worldPosition/);
    // The loop-built names are folded, so the manifest carries every copy
    // task in the order the scene adds them.
    assert.deepEqual(result.manifest.copyTasks, [
        ...[
            "normViewDepth",
            "viewNormal",
            "worldNormal",
            "worldPosition",
            "reflectivity",
            "albedo",
            "irradiance",
            "localPosition",
            "viewDepth",
            "screenspaceDepth",
            "linearVelocity",
            "realColor",
        ].map((name) => `scene146-impostor-${name}`),
        "scene146-resolve",
        "scene146-to-swap",
    ]);
    assert.match(
        result.cpp,
        /double (v_fn\d+_tileW) = \(1\.0 \/ 6\.0\)[\s\S]*scene146-impostor-worldPosition[^\n]*NormalizedViewport\{\(3\.0 \* \1\), 0\.0, \1, 0\.15\}/,
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
        "frame-graph:target-disposal",
        "frame-graph:live-task-add",
        "renderer:scene",
        "renderer:geometry-output",
    ]);
    assert.equal(result.manifest.assets[0]?.kind, "babylon");
    assert.match(
        result.manifest.assets[0]?.output ?? "",
        /HillValley\/HillValley\.babylon$/,
    );
    assert.match(result.cpp, /bbl::load_babylon/);
    assert.match(result.cpp, /auto v_camera = v_scene\.camera/);
    assert.match(
        result.cpp,
        /const double \w+ = \(-26\.695675321687403\);[\s\S]*set_camera_vector\([^\n]+&bbl::CameraRecord::position,/,
    );
    assert.match(
        result.cpp,
        /scene145-impostor-irradiance[\s\S]*NormalizedViewport\{\(0\.0 \* v_fn\d+_tileW\), 0\.85,/,
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

test("forwards a composite's whole viewport to its factory", () => {
    const fileName = "corpus/babylon-lite/lab/lite/src/lite/scene187.ts";
    const result = compileSource(readFileSync(resolve(fileName), "utf8"), {
        fileName,
    });

    const [smaa] = result.manifest.postProcessComposites;
    assert.equal(smaa?.intrinsic, "createSmaaPostProcessTask");
    // A composite reads the pass settings itself, so `viewport` reaches its
    // factory as config rather than being consumed by the framework. It is
    // four fields: reducing it to the `{x, y}` every other record option is
    // written as moved this half-screen presentation to a full-screen one
    // with nothing said, and printed the missing extents into C++.
    assert.deepEqual(smaa?.options, {
        viewport: { x: 0.5, y: 0, width: 0.5, height: 1 },
        clear: true,
        threshold: 0.03,
        maxSearchSteps: 64,
    });
    assert.equal(smaa?.hasTarget, true);
    assert.ok(result.manifest.features.includes("renderer:post-process"));
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
    const source = readFileSync(
        resolve("corpus/babylon-lite/lab/lite/src/lite/scene248.ts"),
        "utf8",
    );
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
            {
                fileName: sourcePath,
            },
        );
        assert.ok(result.manifest.features.includes("loader:gltf"));
        assert.ok(result.manifest.features.includes("renderer:scene"));
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
            {
                fileName: sourcePath,
            },
        );
        assert.ok(result.manifest.features.includes("animation:property"));
        assert.ok(result.manifest.features.includes("light:directional"));
        assert.match(result.cpp, /create_property_animation_group/);
        assert.match(result.cpp, /start_animation_manager/);
        if (sourcePath.endsWith("scene150.ts")) {
            assert.match(
                result.cpp,
                /create_property_animation_clip\("xSlide", \{.*\}, 10\.0\)/,
            );
        }
    }
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
    assert.match(result.cpp, /\.fixed_delta_ms = 16\.0;/);
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
    assertCameraScalarWrite(
        result.cpp,
        "alpha",
        /\(\w+ \+ 3\.141592653589793\)/,
    );
    const components = ["x", "y", "z"].map((component) => {
        const read = result.cpp.match(
            new RegExp(
                `\\[\\[maybe_unused\\]\\] double (\\w+) = bbl::handle_at\\(([^;]+)\\)\\.target\\.${component};`,
            ),
        );
        assert.ok(read, `missing camera target ${component} snapshot`);
        return read;
    });
    assert.equal(components[0]![2], components[1]![2]);
    assert.equal(components[1]![2], components[2]![2]);
});

test("reads FreeCamera position components", () => {
    const result = compileSource(`
        import {
            createEngine,
            createFreeCamera,
        } from "@babylonjs/lite";

        const engine = await createEngine({});
        const camera = createFreeCamera([1, 2, 3], [0, 0, 0]);
        const x = camera.position.x;
        camera.position.z = x;
        class Controller {
            constructor(private readonly camera: typeof camera) {}
            update(): void {
                this.camera.target.x = this.camera.position.z;
            }
        }
        const controller = new Controller(camera);
        controller.update();
    `);

    assert.match(
        result.cpp,
        /double v_x = bbl::handle_at\(v_engine\.cameras, v_camera\)\.position\.x;/,
    );
    assert.match(
        result.cpp,
        /const double \w+ = bbl::handle_at\(v_engine\.cameras, v_camera\)\.position\.x;[\s\S]*write_camera_vector_component\([^\n]+&bbl::CameraRecord::position, &bbl::Vec3d::z,/,
    );
    assert.match(
        result.cpp,
        /const double \w+ = bbl::handle_at\(v_engine\.cameras, v_fn\d+_camera\)\.position\.z;[\s\S]*write_camera_vector_component\([^\n]+&bbl::CameraRecord::target, &bbl::Vec3d::x,/,
    );
});

test("keeps generated scene locals and equality conditions warning-clean", () => {
    const compileScene = (id: string) => {
        const sourcePath = `corpus/babylon-lite/lab/lite/src/lite/${id}.ts`;
        return compileSource(readFileSync(resolve(sourcePath), "utf8"), {
            ...labDeployment,
            fileName: sourcePath,
        }).cpp;
    };

    const navigation = compileScene("scene170");
    assert.match(navigation, /if \(v_frame == 3\.0\)/);
    assert.doesNotMatch(navigation, /if \(\(v_frame == 3\.0\)\)/);

    const splat = compileScene("scene120");
    assert.match(splat, /\[\[maybe_unused\]\] auto v_splat = bbl::load_splat/);

    // The pin's second splat entry point is its own loader, not a container
    // sniff on the first one's: the call site selects it, so the emitted
    // call does too.
    const spz = compileScene("scene123");
    assert.match(spz, /\[\[maybe_unused\]\] auto v_splat = bbl::load_spz/);

    const importedCamera = compileScene("scene250");
    assert.match(
        importedCamera,
        /\[\[maybe_unused\]\] bool v_bblite_asset_camera_found_\d+ = false;/,
    );

    const discardedMarker = compileScene("scene175");
    assert.match(
        discardedMarker,
        /static_cast<void>\(\(v_bblite_shared_result_\d+\)\.second\);/,
    );
    assert.doesNotMatch(discardedMarker, /^\s*v_fn\d+_sphere;$/m);
});

// The Standard diffuse slot's accepted set, on both axes a render texture
// has. Each of these refusals has been dead once: the depth-only one was
// written against a flag only a geometry task's depth ever carried, and the
// geometry-attachment one existed only as a PAL run-time throw.
const diffuseSlotScene = (imports: string, body: string): string => `import {
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

test("lowers a solid texture into the Standard diffuse slot", () => {
    // The fourth accepted source. It asks none of the three questions the
    // refusals below ask: no attachment aspect, no foreign owner, and no
    // encoding option -- createSolidTexture2D hard-codes rgba8unorm and the
    // value carries no `srgb` field at all.
    const result = compileSource(
        diffuseSlotScene(
            " createSolidTexture2D,",
            "    material.diffuseTexture = " +
                "createSolidTexture2D(engine, 1, 1, 1, 1);",
        ),
        {
            fileName: "corpus/babylon-lite/lab/lite/src/lite/diffuse-solid.ts",
        },
    );
    assert.match(
        result.cpp,
        /bbl::set_standard_diffuse_solid_texture\([^;]*bbl::create_solid_texture\(/,
    );
    assert.ok(
        result.manifest.features.includes(
            "material:standard-diffuse-solid-texture",
        ),
    );
    // The texel factory rides `texture:file`, the TU that defines it.
    assert.ok(result.manifest.features.includes("texture:file"));
});

test("refuses a depth-only render target in the Standard diffuse slot", () => {
    // The pin's depth arm carries `invertY: false` and the nearest sampler;
    // the setter folds the colour arm, so the aspect has to refuse.
    assert.throws(
        () =>
            compileSource(
                diffuseSlotScene(
                    "withSampledDepthTexture,",
                    renderTarget("").replace(
                        "    });",
                        "    }, withSampledDepthTexture);",
                    ),
                ),
                {
                    fileName:
                        "corpus/babylon-lite/lab/lite/src/lite/diffuse-depth.ts",
                },
            ),
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
        json = Buffer.concat([json, Buffer.alloc(4 - (json.length % 4), 0x20)]);
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
    const directory = mkdtempSync(join(tmpdir(), "bblitec-groups-"));
    try {
        writeFileSync(
            join(directory, "model.glb"),
            animationGltfFixture(names),
        );
        return compileSource(source, {
            fileName: join(directory, "scene.ts"),
            ...(options.search !== undefined ? { search: options.search } : {}),
        });
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

test("compiles scene 156's measured cross-fade branch directly", () => {
    const sourcePath = "corpus/babylon-lite/lab/lite/src/lite/scene156.ts";
    const result = compileSource(readFileSync(resolve(sourcePath), "utf8"), {
        fileName: sourcePath,
        search: "?seekTime=1.25",
    });

    assert.ok(result.manifest.features.includes("animation:property-blending"));
    assert.ok(result.manifest.features.includes("animation:weight-fades"));
    assert.match(
        result.cpp,
        /bbl::update_animation_manager\(v_manager, v_engine, 1000\.0\)/,
    );
    assert.match(
        result.cpp,
        /bbl::cross_fade_animation_groups\(v_manager, v_engine, bbl::AnimationWeightFadeTarget::from_property\(v_positiveGroup\), bbl::AnimationWeightFadeTarget::from_property\(v_negativeGroup\), 1000\.0, 1\.0\)/,
    );
    // Both operands are generation-known once the query has folded -- the
    // 1250 from `?seekTime=1.25` and the 1000 from a module constant -- so
    // the elapsed millisecond count is a literal rather than a subtraction
    // the runtime repeats every frame.
    assert.match(
        result.cpp,
        /bbl::update_animation_manager\(v_manager, v_engine, 250\.0\)/,
    );
    assert.equal(
        result.cpp.match(
            /bbl::pause_animation\(v_(?:positive|negative)Group\)/g,
        )?.length,
        2,
    );
    // The search query folds the scene's measured branch, so its live
    // wall-clock arm never reaches native output.
    assert.doesNotMatch(result.cpp, /setTimeout|start_animation_manager/);
});

const HANDLE_COLLECTION_SCENE = (body: string): string => `
    import {
        addAnimationGroups,
        crossFadeAnimationGroups,
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

/** The selected group's seek value is chosen by its owned handle identity. */
function assertAnimationSeekSelection(
    cpp: string,
    receiver: string,
    compared: string,
): void {
    const snapshots = [
        ...cpp.matchAll(
            /const auto (\w+) = bbl::js::snapshot_value\(std::pair<bbl::StoredEngine, bbl::AnimationGroupHandle>\{bbl::StoredEngine\{v_engine\}, (\w+)\}\);/g,
        ),
    ];
    const isOwnedSharedResult = (name: string): boolean => {
        const held = new RegExp(
            `auto&? ${name} = (v_bblite_shared_result_\\d+);`,
        ).exec(cpp);
        const call =
            held &&
            new RegExp(
                `auto ${held[1]} = bbl::js::make_closure\\([^\\n]+, bblscene::(\\w+)\\)\\(`,
            ).exec(cpp);
        return (
            call !== null &&
            cpp.includes(
                `std::pair<bbl::StoredEngine, bbl::AnimationGroupHandle> ${call[1]}(`,
            )
        );
    };
    const ownedCompared = isOwnedSharedResult(compared);
    if (isOwnedSharedResult(receiver) && ownedCompared) {
        assert.ok(
            cpp.includes(
                `bbl::set_animation_current_time(v_engine, (${receiver}).second, (bbl::js::detail::same_value_zero(${receiver}, ${compared}) ? 0.25 : 1.5));`,
            ),
        );
        return;
    }
    assert.ok(
        snapshots.some((left, index) => {
            const right = snapshots[index + 1];
            const rightCpp =
                right?.[2] === compared
                    ? right[1]
                    : ownedCompared
                      ? compared
                      : undefined;
            return (
                left[2] === receiver &&
                rightCpp !== undefined &&
                cpp.includes(
                    `bbl::set_animation_current_time(v_engine, ${receiver}, (bbl::js::detail::same_value_zero(${left[1]}, ${rightCpp}) ? 0.25 : 1.5));`,
                )
            );
        }),
    );
}

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
        /for \(const bbl::AnimationGroupHandle [^ ]+ : bbl::handle_at\(v_engine\.assets, v_container\)\.animation_groups\)/,
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
        /bbl::add_animation_groups\(v_manager, v_engine, std::vector<bbl::AnimationGroupHandle>\{\(v_idle\)\.second, \(v_sadPose\)\.second\}\)/,
    );
    // setAnimationAdditive: frame zero through the pinned conversion.
    assert.match(
        result.cpp,
        /bbl::set_animation_additive_from_frame\(v_engine, \(v_sadPose\)\.second, 0\.0\)/,
    );
    // Each selected receiver keeps the owner-aware identity branch
    // that chooses its source seek value.
    assertAnimationSeekSelection(result.cpp, "v_idle", "v_sadPose");
    assertAnimationSeekSelection(result.cpp, "v_sadPose", "v_sadPose");
    assert.ok(result.manifest.features.includes("animation:gltf-additive"));
    assert.ok(result.manifest.features.includes("animation:gltf-group-time"));
});

test("preserves animation group selection through mutable and readonly array aliases", () => {
    for (const declaration of [
        `const active = [idle];
        const alias = active;
        alias.push(sadPose);`,
        `const active = [idle, sadPose] as const;
        const alias: readonly AnimationGroup[] = active;`,
    ]) {
        const result = compileWithAnimationFixture(
            HANDLE_COLLECTION_SCENE(`
        const idle = requireGroup(groups, "idle");
        const sadPose = requireGroup(groups, "sad_pose");
        ${declaration}
        addAnimationGroups(manager, active);
        addAnimationGroups(manager, alias);
        for (const group of alias) {
            group.currentTime = group === sadPose ? 0.25 : 1.5;
            pauseAnimation(group);
        }
        `),
            ["idle", "sad_pose"],
        );

        // Mutation through one alias updates the selection both aliases
        // register, and iteration retains each selected group's identity.
        assert.equal(
            [
                ...result.cpp.matchAll(
                    /bbl::add_animation_groups\(v_manager, v_engine, std::vector<bbl::AnimationGroupHandle>\{\(v_idle\)\.second, \(v_sadPose\)\.second\}\)/g,
                ),
            ].length,
            2,
        );
        assertAnimationSeekSelection(result.cpp, "v_idle", "v_sadPose");
        assertAnimationSeekSelection(result.cpp, "v_sadPose", "v_sadPose");
        assert.ok(
            result.manifest.features.includes("animation:managed-groups"),
        );
    }
});

test("cross-fades glTF groups without enabling or replacing their mixer", () => {
    const result = compileWithAnimationFixture(
        HANDLE_COLLECTION_SCENE(`
        const idle = requireGroup(groups, "idle");
        const sadPose = requireGroup(groups, "sad_pose");
        addAnimationGroups(manager, [idle, sadPose]);
        enableAnimationBlending(manager);
        setAnimationWeight(idle, 1);
        setAnimationWeight(sadPose, 0);
        crossFadeAnimationGroups(
            manager,
            idle,
            sadPose,
            { durationMs: 1000 }
        );
        `),
        ["idle", "sad_pose"],
    );

    assert.match(result.cpp, /bbl::enable_animation_blending\(v_manager\)/);
    assert.match(
        result.cpp,
        /bbl::cross_fade_animation_groups\(v_manager, v_engine, bbl::AnimationWeightFadeTarget::from_gltf\(\(v_idle\)\.second\), bbl::AnimationWeightFadeTarget::from_gltf\(\(v_sadPose\)\.second\), 1000\.0, 1\.0\)/,
    );
    assert.ok(result.manifest.features.includes("animation:gltf-blending"));
    assert.ok(result.manifest.features.includes("animation:weight-fades"));
    assert.ok(
        !result.manifest.features.includes("animation:property-blending"),
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
        /std::rethrow_exception\(bbl::js::make_error\("Error", "walk was not found", std::exception_ptr\{\}\)\);/,
    );
    assert.doesNotMatch(result.cpp, /\.animation_groups\[0\]/);
});

test("some over a collection tests its members by the search loop and keeps no match", () => {
    const result = compileWithAnimationFixture(
        `
        import { createEngine, loadGltf } from "@babylonjs/lite";

        function firstPresent(names: string[], has: (name: string) => boolean): string | undefined {
            for (const name of names) if (has(name)) return name;
            return undefined;
        }
        async function main() {
            const engine = await createEngine({});
            const container = await loadGltf(engine, "model.glb");
            const groups = container.animationGroups ?? [];
            const picked = firstPresent(["trot", "walk"], (name) => groups.some((group) => group.name === name));
            if (picked !== "walk") throw new Error("no gait");
        }
        `,
        ["walk", "run"],
    );
    assert.match(result.cpp, /bool \w+_found_\d+ = false;/);
    assert.doesNotMatch(result.cpp, /_match/);
    assert.match(result.cpp, /break;/);
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
    const loop =
        /for \(const bbl::AnimationGroupHandle (\w+) : bbl::handle_at\(v_engine.assets, v_container\).animation_groups\)/.exec(
            result.cpp,
        );
    assert.ok(loop);
    assertAnimationSeekSelection(result.cpp, loop[1]!, "v_idle");
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
        /bbl::set_animation_additive\(v_engine, \(v_idle\)\.second, 0\.5\)/,
    );
    assert.match(
        result.cpp,
        /bbl::set_animation_additive_from_frame\(v_engine, \(v_other\)\.second, 0\.0\)/,
    );
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
        /if \(\w*_found_\d+\) return std::pair<[^\n]*>\{\w*_match_\d+, true\};/,
    );
    // ...and the fallback is the guarded element read, prepared only on a
    // miss, whose flag is selected with it for the scene's own guard.
    assert.match(result.cpp, /_present_\d+ = \w+ < v_scene\.meshes\.size\(\)/);
    assert.match(
        result.cpp,
        /return std::pair<[^\n]*>\{\w*_at_\d+, \w*_present_\d+\};/,
    );
    assert.match(result.cpp, /= v_bblite_nullish_selection_\d+\.second;/);
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
        { ...labDeployment, fileName: "examples/material-map-find.ts" },
    );

    assert.match(result.cpp, /for \(const bbl::MeshHandle/);
    assert.match(result.cpp, /\.materials, [^)]+\)\.name/);
    assert.match(
        result.cpp,
        /if \([^\n]*material\.value != bbl::invalid_handle[^\n]*\) \{[\s\S]*?const bbl::js::Nullable<std::string> \w+_optional_compare_\d+\{\w+\}/,
    );
    assert.match(
        result.cpp,
        /v_material\.has_value\(\) && bbl::handle_at\([^;]+occlusion_texture\.has_image\(\)/,
    );
    assert.match(result.cpp, /optional_compare[^\n]*== "metalmat"/);
    assert.match(
        result.cpp,
        /bbl::set_pbr_texture\([^;]*MaterialTextureSlot::occlusion, bbl::solid_texture_file\(/,
    );
    assert.doesNotMatch(result.cpp, /rebuild_material/);
});

test("reads a container's Gaussian splats as the asset's own collection", () => {
    // Scene 226's shape. `container._gaussianSplats` is the loader-owned
    // vector on the asset record, indexed with the same bounds guard every
    // other handle collection takes -- and the local it binds is hoisted to
    // static storage because the read sits after `startEngine`, which is
    // where the pin's own `_sceneSetup` has already filled the list.
    const sourcePath = "corpus/babylon-lite/lab/lite/src/lite/scene226.ts";
    const { cpp } = compileSource(readFileSync(resolve(sourcePath), "utf8"), {
        fileName: sourcePath,
    });
    assert.match(
        cpp,
        /bbl::handle_at\(v_engine\.assets, v_container\)\.gaussian_splats\.size\(\)/,
    );
    assert.match(
        cpp,
        /const bbl::SplatMeshHandle v_bblite_asset_gaussian_splat_at_\d+ =/,
    );
    // `await splat.firstSortReady` is a barrier: this runtime sorts on the
    // frame's own thread before the draw that reads it, so the await emits
    // nothing and the binding it guarded stays warning-clean.
    assert.match(cpp, /\[\[maybe_unused\]\] auto v_splat = /);
});

test("mirrors the pinned _gaussianSplats declaration", () => {
    // The published typings drop `@internal` members, so `program.ts`
    // restores this one from the pinned source at the typings seam and the
    // checker reads its element model from there. A rename or a changed
    // element type has to fail rather than leaving the collection row
    // reading a member that no longer exists.
    const container = new UpstreamSourceStore().getSource(
        "src/asset-container.ts",
    );
    assert.match(
        container,
        /_gaussianSplats\?: Promise<GaussianSplattingMesh>\[\];/,
    );
    assert.doesNotMatch(
        readFileSync(
            resolve("node_modules/@babylonjs/lite/index.d.ts"),
            "utf8",
        ),
        /_gaussianSplats/,
    );
});

test("does not bake a sibling function in a file that draws elsewhere", () => {
    // The trigger is the helper whose own body reads the canvas back, not
    // the file it lives in: scene 187 declares a StandardMaterial factory
    // beside its fence texture, and a file-scoped test sent that factory to
    // Chromium, where it returned an object and failed by the message a
    // returned non-string produces.
    const source = [
        'import { createEngine, createSceneContext, createStandardMaterial, registerScene, startEngine } from "babylon-lite";',
        'import type { StandardMaterialProps } from "babylon-lite";',
        "",
        "function unlit(color: readonly [number, number, number]): StandardMaterialProps {",
        "    const material = createStandardMaterial();",
        "    material.emissiveColor = [color[0], color[1], color[2]];",
        "    return material;",
        "}",
        "",
        "function unusedTextureUrl(): string {",
        '    const canvas = document.createElement("canvas");',
        '    const ctx = canvas.getContext("2d");',
        "    if (!ctx) {",
        '        throw new Error("needs a 2D canvas context");',
        "    }",
        "    ctx.fillRect(0, 0, 4, 4);",
        '    return canvas.toDataURL("image/png");',
        "}",
        "",
        "async function main(): Promise<void> {",
        '    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;',
        "    const engine = await createEngine(canvas);",
        "    const scene = createSceneContext(engine);",
        "    unlit([0.5, 0.25, 0.125]);",
        "    await registerScene(scene);",
        "    await startEngine(engine);",
        "}",
        "",
        "main();",
    ].join("\n");
    const result = compileSource(source, { fileName: "input.ts" });
    assert.deepEqual(result.manifest.assets, []);
    assert.match(
        result.cpp,
        /emissive_factor = bbl::Color3\{0\.5f, 0\.25f, 0\.125f\}/,
    );
});

/** A scene around one CSG chain the caller spells. */
function csgScene(
    body: readonly string[],
    extraImports: readonly string[] = [],
): string {
    return [
        `import { ${[
            ...extraImports,
            "addToScene",
            "createBox",
            "createCsgFromMesh",
            "createEngine",
            "createMeshFromCsg",
            "createSceneContext",
            "createSphere",
            "createStandardMaterial",
            "csgIntersect",
            "csgSubtract",
            "csgUnion",
            "registerScene",
            "startEngine",
        ].join(", ")} } from "babylon-lite";`,
        "",
        "async function main(): Promise<void> {",
        '    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;',
        "    const engine = await createEngine(canvas);",
        "    const scene = createSceneContext(engine);",
        ...body,
        "    await registerScene(scene);",
        "    await startEngine(engine);",
        "}",
        "",
        "main();",
    ].join("\n");
}

test("bakes a CSG boolean into the geometry the pin produced", () => {
    const result = compileSource(
        csgScene([
            "    const box = createBox(engine, 2);",
            // A coarse sphere: this test asserts the emitted SHAPE, and
            // scene 90's own 32 segments cost it 80x the replay for
            // nothing it checks.
            "    const sphere = createSphere(engine, { diameter: 2.5, segments: 8 });",
            '    const carved = createMeshFromCsg(engine, csgSubtract(createCsgFromMesh(box), createCsgFromMesh(sphere)), "carved");',
            "    carved.material = createStandardMaterial();",
            "    addToScene(scene, carved);",
        ]),
        { fileName: "input.ts" },
    );
    assert.ok(result.manifest.features.includes("mesh:csg"));
    assert.ok(result.manifest.features.includes("mesh:from-data"));
    const geometryAssets = result.manifest.assets.filter(
        (asset) => asset.kind === "binary",
    );
    assert.equal(geometryAssets.length, 1);
    assert.ok(
        result.assetPayloads
            .get(geometryAssets[0]!.source)
            ?.startsWith("data:application/x-bblite-mesh;base64,"),
    );
    assert.match(
        result.cpp,
        /bbl::create_mesh_from_data\(v_engine, "carved", v_bblite_baked_geometry_\d+\.positions,/,
    );
    assert.ok(
        result.manifest.adaptations.some(
            ({ id }) => id === "executed-csg-solid",
        ),
    );
});

test("refuses a CSG source the scene has already reached", () => {
    // `createCsgFromMesh` bakes the mesh's world matrix into every polygon,
    // so the solid is replayable only at the transform its factory left.
    assert.throws(
        () =>
            compileSource(
                csgScene([
                    "    const box = createBox(engine, 2);",
                    "    box.position.x = 3;",
                    '    const carved = createMeshFromCsg(engine, csgUnion(createCsgFromMesh(box), createCsgFromMesh(createSphere(engine, { diameter: 1 }))), "carved");',
                    "    addToScene(scene, carved);",
                ]),
                { fileName: "input.ts" },
            ),
        (error: unknown) =>
            error instanceof CompileError &&
            /first use is this call/.test(error.message),
    );
});

test("refuses a CSG source whose geometry generation cannot replay", () => {
    assert.throws(
        () =>
            compileSource(
                csgScene(
                    [
                        "    const plane = createPlane(engine, { width: 1, height: 1 });",
                        '    const carved = createMeshFromCsg(engine, csgIntersect(createCsgFromMesh(plane), createCsgFromMesh(createSphere(engine, { diameter: 1 }))), "carved");',
                        "    addToScene(scene, carved);",
                    ],
                    ["createPlane"],
                ),
                { fileName: "input.ts" },
            ),
        (error: unknown) =>
            error instanceof CompileError &&
            /createBox or createSphere with generation-known options/.test(
                error.message,
            ),
    );
});

test("refuses the multi-material CSG mesh builder by name", () => {
    assert.throws(
        () =>
            compileSource(
                // A subpath exports the sibling the entry does not.
                `import { createMeshesFromCsg } from "babylon-lite/mesh/csg.js";
${csgScene([
    '    const meshes = createMeshesFromCsg(engine, csgSubtract(createCsgFromMesh(createBox(engine, 2)), createCsgFromMesh(createSphere(engine, { diameter: 1 }))), [createStandardMaterial()], "carved");',
    "    addToScene(scene, meshes[0]);",
])}`,
                { fileName: "input.ts" },
            ),
        (error: unknown) =>
            error instanceof CompileError &&
            /one mesh per material slot/.test(error.message),
    );
});

test("carries a physics aggregate's startAsleep into the pinned body add", () => {
    // `createPhysicsAggregate` forwards `options.startAsleep` into
    // `createPhysicsBody(world, node, motionType, startsAsleep = false)`,
    // which is the third argument of the pin's own `HP_World_AddBody`.
    // Scene 44 builds one tower asking for it and one not, so both
    // spellings have to reach the aggregate options from the same helper.
    const sourcePath = "corpus/babylon-lite/lab/lite/src/lite/scene44.ts";
    const result = compileSource(readFileSync(resolve(sourcePath), "utf8"), {
        fileName: sourcePath,
    });
    assert.match(result.cpp, /bbl::js::Nullable<bbl::Vec3d>\{\}, true\}/);
    assert.match(result.cpp, /bbl::js::Nullable<bbl::Vec3d>\{\}, false\}/);
});

test("an aggregate's explicit geometry options fill the lanes the pin declares", () => {
    // The five members `_buildShapeParams` resolves as overrides reach the
    // emitted struct positionally, in the table's own order, so an omitted
    // one has to be the absent lane in place rather than a shifted argument.
    // `examples/regression-physics-aggregate-options.ts` writes one override
    // per member, each different from what its own mesh derives.
    const sourcePath = "examples/regression-physics-aggregate-options.ts";
    const result = compileSource(readFileSync(resolve(sourcePath), "utf8"), {
        fileName: sourcePath,
    });
    const absentVec3 = "bbl::js::Nullable<bbl::Vec3d>\\{\\}";
    const absentNumber = "bbl::js::Nullable<double>\\{\\}";
    const aggregate = (type: string, lanes: readonly string[]): RegExp =>
        new RegExp(
            `PhysicsShapeType::${type}, bbl::upstream::PhysicsAggregateOptions\\{` +
                `1\\.0, ${absentNumber}, ${absentNumber}, ` +
                `bbl::pal::PhysicsShapeHandle\\{\\}, ${lanes.join(", ")}, false\\}`,
        );
    const point = (y: string): string =>
        `bbl::js::Nullable<bbl::Vec3d>\\{bbl::Vec3d\\{0\\.0, ${y}, 0\\.0\\}\\}`;
    // centre, radius, point A, point B, extents.
    assert.match(
        result.cpp,
        aggregate("SPHERE", [
            point("0\\.5"),
            absentNumber,
            absentVec3,
            absentVec3,
            absentVec3,
        ]),
    );
    assert.match(
        result.cpp,
        aggregate("CYLINDER", [
            absentVec3,
            "bbl::js::Nullable<double>\\{0\\.5\\}",
            point("-0\\.5"),
            point("0\\.5"),
            absentVec3,
        ]),
    );
    assert.match(
        result.cpp,
        aggregate("CAPSULE", [
            absentVec3,
            "bbl::js::Nullable<double>\\{0\\.25\\}",
            point("-0\\.5"),
            point("0\\.5"),
            absentVec3,
        ]),
    );
    assert.match(
        result.cpp,
        aggregate("BOX", [
            point("0\\.75"),
            absentNumber,
            absentVec3,
            absentVec3,
            "bbl::js::Nullable<bbl::Vec3d>\\{bbl::Vec3d\\{1\\.0, 1\\.0, 1\\.0\\}\\}",
        ]),
    );
    // The prestep type travels as the pinned enumerator, and its own body is
    // what turns pre-step syncing on.
    assert.match(
        result.cpp,
        /set_physics_body_prestep_type\(\w+\.body, bbl::upstream::PhysicsPrestepType::TELEPORT\)/,
    );
});

test("refuses an aggregate rotation rather than shipping the identity", () => {
    // `rotation` is declared on both pinned bags and lowered on neither, so
    // a rotated primitive would ship the pin's own `?? identity` default
    // instead of the quaternion the scene wrote.
    const sourcePath = "examples/regression-physics-aggregate-options.ts";
    const source = readFileSync(resolve(sourcePath), "utf8").replace(
        "        center: { x: 0, y: 0.75, z: 0 },",
        "        rotation: { x: 0, y: 0, z: 0.383, w: 0.924 },",
    );
    assert.throws(
        () => compileSource(source, { fileName: sourcePath }),
        (error: unknown) =>
            error instanceof CompileError &&
            /A physics aggregate option outside this prototype's reached slice/.test(
                error.message,
            ),
    );
});

test("carries an unnamed capsule option as the zero the pin reads as absent", () => {
    // `createCapsuleData` resolves every option by truthiness
    // (`options.height ? options.height : 1`), so an option the scene did
    // not name and an explicit zero are the SAME answer upstream. The
    // record therefore carries zero for an unnamed option and the emitted
    // body supplies each default itself -- including the two that fall back
    // to another resolved option rather than to a constant.
    const named = compileSource(`
        import { createCapsule, createEngine } from "babylon-lite";
        async function main() {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            createCapsule(engine, { height: 2, radius: 0.5 });
        }
        void main();
    `);
    assert.match(
        named.cpp,
        /bbl::CapsuleOptions\{2\.0, 0\.5, 0\.0, 0\.0, 0\.0, 0\.0, 0\.0, 0\.0, 0\.0\}/,
    );
    const bare = compileSource(`
        import { createCapsule, createEngine } from "babylon-lite";
        async function main() {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            createCapsule(engine);
        }
        void main();
    `);
    assert.match(
        bare.cpp,
        /bbl::CapsuleOptions\{0\.0, 0\.0, 0\.0, 0\.0, 0\.0, 0\.0, 0\.0, 0\.0, 0\.0\}/,
    );
    assert.throws(
        () =>
            compileSource(`
        import { createCapsule, createEngine } from "babylon-lite";
        async function main() {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            createCapsule(engine, { height: 2, orientation: 1 });
        }
        void main();
    `),
        /Reached capsules name their height, radius/,
    );
});

test("parents a mesh to the node lane its parent actually holds", () => {
    // Upstream `parent` is one nullable SceneNode field; this port keeps two
    // handle tables, and a MeshRecord carries both lanes -- so a mesh child
    // takes a mesh parent through the overload over the lane that holds it,
    // and the traversal list `children` is filled by its own push exactly as
    // upstream fills it separately.
    const parented = compileSource(`
        import { addToScene, createCylinder, createEngine, createSceneContext, createSphere } from "babylon-lite";
        async function main() {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            const scene = createSceneContext(engine);
            const cylinder = createCylinder(engine, { height: 2, diameter: 1 });
            const marker = createSphere(engine, { diameter: 0.15 });
            marker.parent = cylinder;
            cylinder.children.push(marker);
            addToScene(scene, cylinder);
            addToScene(scene, marker);
        }
        void main();
    `);
    assert.match(
        parented.cpp,
        /bbl::set_mesh_transform_parent\(\w+, \w+, \w+\);/,
    );
    assert.match(parented.cpp, /bbl::push_mesh_child\(\w+, \w+, \w+\);/);
    assert.ok(parented.manifest.features.includes("mesh:parenting"));
    // A transform node hung under a MESH is a record this port does not
    // have -- TransformNodeRecord keeps only the node lane -- so it still
    // refuses rather than picking a lane.
    assert.throws(
        () =>
            compileSource(`
        import { createCylinder, createEngine, createTransformNode } from "babylon-lite";
        async function main() {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            const cylinder = createCylinder(engine, { height: 2, diameter: 1 });
            const node = createTransformNode("node");
            node.parent = cylinder;
        }
        void main();
    `),
        /Expected transform-node, received mesh/,
    );
});

test("reads a container's flow-graph runtimes and graphs as its own collection", () => {
    // Scene 304's two reads: the awaited runtimes guarded by `?? []`, whose
    // length the scene reports, and the parsed graph at an index. Both
    // are the asset record's list of what addToScene attached.
    const result = compileSource(`
        import { createEngine, loadGltf } from "@babylonjs/lite";
        async function main() {
            const engine = await createEngine({});
            const asset = await loadGltf(engine, "model.glb");
            const runtimes = (await asset.flowGraphRuntimes) ?? [];
            if (runtimes.length === 0) {
                throw new Error("no graph attached");
            }
            const graph = asset.flowGraphs?.[0];
            void graph;
        }
        void main();
    `);
    assert.match(result.cpp, /assets, [^)]*\)\.flow_graph_runtimes\.size\(\)/);
    // The declared graphs are the document's own list, not the runtimes'.
    assert.match(
        result.cpp,
        /const bbl::FlowGraphHandle [\w]+ = [\w]+ \? bbl::handle_at\([\w.]*assets, [^)]*\)\.flow_graphs\[/,
    );
});

test("refuses a container's runtimes read without await", () => {
    // Upstream the member is a promise of the array; the promise object
    // is not the list, so the read has to sit under the await.
    assert.throws(
        () =>
            compileSource(`
        import { createEngine, loadGltf } from "@babylonjs/lite";
        async function main() {
            const engine = await createEngine({});
            const asset = await loadGltf(engine, "model.glb");
            const runtimes = asset.flowGraphRuntimes ?? [];
            if (runtimes.length === 0) {
                throw new Error("no graph attached");
            }
        }
        void main();
    `),
        /is a promise of its collection; read it under await/,
    );
});

test("refuses a flow graph's accessors", () => {
    // The parsed graph's accessor records stay at generation; a handle to
    // the attached runtime is all an index yields.
    assert.throws(
        () =>
            compileSource(`
        import { createEngine, loadGltf } from "@babylonjs/lite";
        async function main() {
            const engine = await createEngine({});
            const asset = await loadGltf(engine, "model.glb");
            const graph = asset.flowGraphs?.[0];
            const offset = graph?.accessors["/materials/4/pbrMetallicRoughness/baseColorTexture/extensions/KHR_texture_transform/offset"]?.get();
            if (offset === undefined) {
                throw new Error("no offset");
            }
        }
        void main();
    `),
        /accessor records \(path-converter\.ts\) stay at generation/,
    );
});

test("render targets take the extents a { width, height } record value holds", () => {
    // A size held in a binding (one record) or returned by a helper (a struct).
    const result = compileSource(`
        import { createEngine, createRenderTargetTexture } from "@babylonjs/lite";
        interface Size { width: number; height: number }
        function sizeFor(scale: number): Size { return { width: Math.round(128 * scale), height: Math.round(64 * scale) }; }
        const scales = [0.5, 1];
        async function main(): Promise<void> {
            const engine = await createEngine({});
            const shadowSize = { width: 64, height: 32 };
            const raw = createRenderTargetTexture(engine, { lbl: "raw", format: "rg16float", samples: 1, size: shadowSize });
            const scaled = createRenderTargetTexture(engine, { lbl: "scaled", format: "rg16float", samples: 1, size: sizeFor(scales[Math.floor(Math.random() * 2)]!) });
            void raw; void scaled;
        }
        void main();
    `);
    assert.match(
        result.cpp,
        /render_target_dimension\(v_shadowSize->width\)[^;]*render_target_dimension\(v_shadowSize->height\)/,
    );
    assert.match(
        result.cpp,
        /render_target_dimension\((v_(?!shadowSize)\w+)(\.|->)width\)[^;]*render_target_dimension\(\1\2height\)/,
    );
});

test("animation owner proofs follow immutable shared returns and reject mutable owners", () => {
    const fixture = (body: string): string => `
        import {createAnimationManager,createPropertyAnimationClip,createPropertyAnimationGroup,
            createBox,type EngineContext,type Mesh} from '@babylonjs/lite';
        function install(first:EngineContext,second:EngineContext,choice:boolean):void {
            const clip=createPropertyAnimationClip('move',[
                {path:'position.x',keys:[{frame:0,value:0},{frame:1,value:1}]}
            ],{frameRate:1});
            ${body}
        }
        const installers:Array<typeof install>=[install];
    `;
    for (const body of [
        `const manager=createAnimationManager({engine:first});
          createPropertyAnimationGroup(manager,createBox(first),clip);`,
        `const manager=createAnimationManager({engine:first});
          const a=createBox(first),b=createBox(first);
          function choose(flag:boolean):Mesh{return flag?a:b;}
          createPropertyAnimationGroup(manager,choose(choice),clip);`,
    ])
        assert.match(
            compileSource(fixture(body)).cpp,
            /bbl::create_property_animation_group/,
        );
    for (const body of [
        `const manager=createAnimationManager({engine:first});
          createPropertyAnimationGroup(manager,createBox(second),clip);`,
        `const manager=createAnimationManager({engine:first});
          const a=createBox(first),b=createBox(second);
          function choose(flag:boolean):Mesh{return flag?a:b;}
          createPropertyAnimationGroup(manager,choose(choice),clip);`,
        `const manager=createAnimationManager({engine:first});
          const a=createBox(first),b=createBox(second);
          function choose():Mesh{return a;}
          let current=choose();if(choice)current=b;
          createPropertyAnimationGroup(manager,current,clip);`,
        `let engine:EngineContext|undefined=first;
          const manager=createAnimationManager({engine});engine=second;
          createPropertyAnimationGroup(manager,createBox(engine),clip);`,
    ])
        assert.throws(
            () => compileSource(fixture(body)),
            /Animation manager and group\/scene belong to different engines/,
        );
});

test("animation lists and cross-fades require every selected group to share its owner", () => {
    const fixture = (different: boolean, list: boolean): string => `
        import {loadGltf,createAnimationManager,addAnimationGroups,crossFadeAnimationGroups} from '@babylonjs/lite';
        import type {AnimationGroup,EngineContext} from '@babylonjs/lite';
        function firstGroup(groups:readonly AnimationGroup[]):AnimationGroup {
            const found=groups.find(group=>group.name==='idle');
            if(!found)throw new Error('missing');return found;
        }
        async function install(first:EngineContext,other:EngineContext) {
            const second=${different ? "other" : "first"};
            const leftContainer=await loadGltf(first,'model.glb');
            const rightContainer=await loadGltf(second,'model.glb');
            const left=firstGroup(leftContainer.animationGroups??[]);
            const right=firstGroup(rightContainer.animationGroups??[]);
            const alias=right;
            const manager=createAnimationManager({engine:first});
            ${
                list
                    ? "addAnimationGroups(manager,[left,alias]);"
                    : "crossFadeAnimationGroups(manager,left,alias,{durationMs:100,toWeight:1});"
            }
        }
        const installers:Array<typeof install>=[install];
    `;
    for (const list of [true, false]) {
        const { cpp } = compileWithAnimationFixture(fixture(false, list), [
            "idle",
        ]);
        assert.match(
            cpp,
            list
                ? /bbl::add_animation_groups/
                : /bbl::cross_fade_animation_groups/,
        );
        assert.throws(
            () => compileWithAnimationFixture(fixture(true, list), ["idle"]),
            list
                ? /Animation groups belong to different engines/
                : /Animation manager and group\/scene belong to different engines/,
        );
    }
});

test("a scene's _renderableVersion reads the native count of its builds", () => {
    const result = compileSource(`
        import { addToScene, createBox, createEngine, createSceneContext } from "@babylonjs/lite";
        async function main(): Promise<void> {
            const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
            const scene = createSceneContext(engine);
            addToScene(scene, createBox(engine));
            const version = (scene as unknown as { _renderableVersion: number })._renderableVersion;
            document.title = String(version);
        }
        void main();
    `);
    assert.match(result.cpp, /bbl::scene_renderable_version\(/);
});
