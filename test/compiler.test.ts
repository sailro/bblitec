import assert from "node:assert/strict";
import {
    mkdtempSync,
    readFileSync,
    rmSync,
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

test("lowers a light vector set to its own kind's entry point", () => {
    const result = compileSource(`
        import {
            createEngine,
            createSpotLight,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const spot = createSpotLight([0, 0, 0], [0, 1, 0], 1.5, 10);
            spot.position.set(1, 2, 3);
            spot.direction.set(0, -1, 0);
        }
    `);
    assert.match(
        result.cpp,
        /bbl::set_spot_light_position\([^;]*bbl::Vec3\{1\.0f, 2\.0f, 3\.0f\}\);/,
    );
    assert.match(result.cpp, /bbl::set_spot_light_direction\(/);
    // A vector the kind carries upstream but no reached scene writes stays
    // unlowered and refuses by name, the way the scalar table's unreached
    // spot properties do.
    assert.throws(
        () =>
            compileSource(`
                import {
                    createEngine,
                    createPointLight,
                } from "@babylonjs/lite";

                async function main() {
                    const engine = await createEngine({});
                    const point = createPointLight([0, 1, 0]);
                    point.position.set(1, 2, 3);
                }
            `),
        /A point light has no 'position' to set\./,
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
        /GroundOptions\{6\.0f, 7\.0f, 4u, bbl::Vec2\{2\.0f, 3\.0f\}\}/,
    );
    assert.match(
        result.cpp,
        /SphereOptions\{8u, 2\.0f, 4\.0f, 5\.0f\}/,
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
        /create_sphere_data\(bbl::SphereOptions\{32u, 1\.0f, 1\.0f, 1\.0f\}\)/,
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
    assert.match(result.cpp, /struct Item \{/);
    assert.match(
        result.cpp,
        /bbl::js::Nullable<bblscene::Item> current;/,
    );
    assert.match(
        result.cpp,
        /bbl::js::Array<bblscene::Tag> tags;/,
    );
    assert.match(
        result.cpp,
        /push_back\(bblscene::Item\{2\.0, true\}\)/,
    );
    assert.match(
        result.cpp,
        /push_back\(bblscene::Tag::busy\)/,
    );
    assert.match(
        result.cpp,
        /current = std::nullopt;/,
    );
    assert.match(
        result.cpp,
        /\(\*v_fn\d+_bucket\.current\)\.weight/,
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
        /bbl::js::array_filled<double>\(6\.0, 0\.0\)/,
    );
    assert.match(
        result.cpp,
        /v_board\[bbl::js::array_index\(2\.0\)\] = 5\.0;/,
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
        /for \(const auto& v_bblite_item_\d+ : v_board\)/,
    );
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
        /inline const std::array<std::array<double, 2>, 3> WEIGHTS = \{\{\{\{1\.0, 2\.0\}\}, \{\{3\.0, 4\.0\}\}, \{\{5\.0, 6\.0\}\}\}\};/,
    );
    assert.match(
        result.cpp,
        /double v_staticRead = 3\.0f;/,
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
    assert.match(result.cpp, /double v_\w*total = 0\.0/);
    assert.doesNotMatch(result.cpp, /struct Stack/);
    // The default `repeat = 2` unrolls twice and the explicit `1` once,
    // so the count is what proves the default was applied.
    assert.equal(
        (result.cpp.match(/push_back/g) ?? []).length,
        3,
    );
});

test("rejects value-returning class methods", () => {
    assert.throws(
        () =>
            compileSource(`
                class Counter {
                    private n = 1;
                    value(): number {
                        return this.n;
                    }
                }
                const counter = new Counter();
                const total = counter.value();
            `),
        /lowers void methods only/,
    );
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

test("rejects reassigning a resource-holding class field", () => {
    // A resource field is a compile-time binding, not storage, so a
    // second write would be visible on every path rather than the one
    // that took it.
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

test("binds const data-path locals as aliases", () => {
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

    // The local binds a reference, so the write reaches the holder the
    // way a JavaScript object binding does.
    assert.match(result.cpp, /&\s+v_\w*alias = /);
});

test("rejects using an alias after its container is resized", () => {
    assert.throws(
        () =>
            compileSource(`
                interface Entry { value: number; }
                const list: Entry[] = [{ value: 1 }];
                const entry = list[0]!;
                list.push({ value: 2 });
                entry.value = 5;
            `),
        /resized after the binding/,
    );
});

test("keeps mutable data-path locals value copies", () => {
    assert.throws(
        () =>
            compileSource(`
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
            `),
        /value copy of a data path; writes through aliases/,
    );
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
            /v_fn0_total \+= static_cast<float>\(\(v_fn\d+_index \* 2\.0\)\);/g,
        )?.length,
        3,
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
        /bbl::create_mesh_from_data\(v_engine, v_cube\.positions, v_cube\.normals, v_cube\.indices, v_cube\.uvs, \{\}, \{\}, \{\}\)/,
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
        /bbl::load_file_texture\(v_engine, bbl::asset_path\("[0-9a-f]+-ebf71b300f43563f\.png"\), bbl::TextureSamplerState\{bbl::TextureFilter::nearest, bbl::TextureFilter::nearest, bbl::TextureMipmapMode::nearest, bbl::TextureAddressMode::repeat, bbl::TextureAddressMode::repeat, 1\.0f, 0\.0f\}, false, true\)/,
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
});

test("requires srgb base-color file textures", () => {
    assert.throws(
        () =>
            compileSource(`
                import {
                    createEngine,
                    createPbrMaterial,
                    createSolidTexture2D,
                    loadTexture2D,
                } from "@babylonjs/lite";

                async function main() {
                    const engine = await createEngine({});
                    const texture = await loadTexture2D(engine, "/textures/nme/ebf71b300f43563f.png");
                    const material = createPbrMaterial({
                        baseColorTexture: texture,
                        ormTexture: createSolidTexture2D(engine, 1, 0.5, 0),
                    });
                }
            `),
        /Base-color file textures require srgb: true/,
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
            /v_fn0_samples \+= v_fn0_block\d+_index/g,
        )?.length,
        3,
    );
    assert.match(
        result.cpp,
        /while \(\(v_fn0_remaining > 0\.0\)\)/,
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
    assert.match(result.cpp, /while \(\(v_index < 10\.0\)\)/);
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
        /for \(; \(v_block\d+_index < bblscene::count\(\)\); v_block\d+_index\+\+\) \{/,
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
        /for \(const auto& v_bblite_item_\d+ : bblscene::values\(\)\) \{/,
    );
    assert.match(
        result.cpp,
        /v_total \+= v_bblite_item_\d+;/,
    );
});

test("rejects non-array runtime iterables", () => {
    assert.throws(
        () =>
            compileSource(`
                for (const item of "abc") {
                    const value = item;
                }
            `),
        /Expected a static array literal/,
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
        /test[\\/]fixtures[\\/]compiler-modules[\\/]bad-helper\.ts:\d+:\d+: Unsupported statement: DoStatement/,
    );
});

test("rejects recursive local functions", () => {
    assert.throws(
        () =>
            compileSource(`
                function recurse(value: number): number {
                    return recurse(value);
                }
                const value = recurse(1);
            `),
        /Recursive call to 'recurse' is not supported/,
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
            /\.position\.x = static_cast<float>\(v_counter\);/,
        );
        assert.doesNotMatch(result.cpp, /\.position\.x = 0\.0f;/);
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
        /\.position\.x = static_cast<float>\(v_offset\)/,
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
    assert.match(result.cpp, /\.base_color_factor\.a \+= 0\.1f/);
    assert.match(result.cpp, /\.specular_power -= 1\.0f/);
    assert.match(result.cpp, /\.position\.x -= 0\.02f/);
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
        /double v_fn0_value = \(v_fn0_flag \? 0\.6f : 0\.4f\);/,
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
        /\.position\.x = 3\.0f/,
    );
});

test("rejects unsupported dynamic engine and scene options", () => {
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
                `import { createCylinder, createEngine } from "@babylonjs/lite";
async function main() {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    createCylinder(engine);
}`,
                { fileName: "unsupported.ts" },
            ),
        (error: unknown) => {
            assert.ok(error instanceof CompileError);
            assert.match(error.message, /^unsupported\.ts:5:5:/);
            assert.match(error.message, /createCylinder/);
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
        /if \(\(!\(v_added\) && \(v_frame >= 20\.0\)\)\)/,
    );
    assert.match(
        result.cpp,
        /PbrMaterialOptions\{[^}]*0\.1f, 0\.4f, 1\.0f, 0\.0f, 1\.0f, 0\.04f, false, false, false, 0\.0f, 1\.5f/,
    );
    assert.match(
        result.cpp,
        /if \(\(v_added && \(v_frame >= \(20\.0 \+ 150\.0\)\)\)\)/,
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
        /double v_fn0_block\d+_i = 3\.0;[\s\S]*scene146-impostor-worldPosition[\s\S]*NormalizedViewport\{\(v_fn0_block\d+_i \* v_fn0_tileW\), v_fn0_y, v_fn0_tileW, 0\.15\}/,
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
        /\[\[maybe_unused\]\] double v_x = v_engine\.cameras\[v_cam\.value\]\.target\.x;/,
    );
    assert.match(
        result.cpp,
        /\[\[maybe_unused\]\] double v_z = v_engine\.cameras\[v_cam\.value\]\.target\.z;/,
    );
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
