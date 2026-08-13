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

test("rejects writes through data path copies", () => {
    assert.throws(
        () =>
            compileSource(`
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

test("compiles the pinned tetris rules through the plain-data subset", () => {
    const result = compileSource(
        readFileSync(
            resolve("examples/tetris-logic.ts"),
            "utf8",
        ),
        { fileName: "examples/tetris-logic.ts" },
    );

    assert.match(result.cpp, /struct GameState \{/);
    assert.match(
        result.cpp,
        /bool tryMove\(bblscene::GameState& v_fn\d+_g, double v_fn\d+_dCol, double v_fn\d+_dRow, double v_fn\d+_dRot\)/,
    );
    assert.match(
        result.cpp,
        /std::fmod\(\(\(\(\*v_fn\d+_g\.active\)\.rotation \+ v_fn\d+_dRot\) \+ 4\.0\), 4\.0\)/,
    );
    assert.match(result.cpp, /GameSound::gameOver/);
    assert.match(result.cpp, /bbl::js::seed_random\(1u\);/);
    const adaptationIds = result.manifest.adaptations.map(
        ({ id }) => id,
    );
    assert.ok(
        adaptationIds.includes("plain-data-value-model"),
    );
    assert.ok(
        adaptationIds.includes(
            "deterministic-seeded-random",
        ),
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
        /create_arc_rotate_camera\(v_engine, 0\.0f, 1\.0f, 3\.0f/,
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
        new RegExp(`${engine}\\.cameras\\[v_camera\\.value\\]\\.alpha = 1\\.0f`),
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
    assert.match(result.cpp, /\.camera\.value\]\.alpha \+= 0\.3f/);
    assert.match(result.cpp, /\.cameras\[v_camera\.value\]\.beta -= 0\.4f/);
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
            "background-dither-sdl-gpu-disabled",
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
                source: "https://raw.githubusercontent.com/BabylonJS/Babylon-Lite/7184feda683072980735f9a180e6f567ee5717ba/packages/babylon-lite/assets/brdf-lut.png",
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
                source: "https://raw.githubusercontent.com/BabylonJS/Babylon-Lite/7184feda683072980735f9a180e6f567ee5717ba/packages/babylon-lite/assets/brdf-lut.png",
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
    assert.match(result.cpp, /\.alpha \+= bbl::pi/);
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
        /static_cast<float>\(std::sqrt\(800\.0\)\)/,
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
        /static_cast<float>\(\(3\.141592653589793 \/ 2\.15\)\)/,
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
    assert.match(
        result.cpp,
        /bbl::ShaderMaterialVariant::alpha_card/,
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
        /\.position = bbl::Vec3\{\(-26\.695675321687403f\)/,
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
    assert.match(result.cpp, /\.fov = 0\.8f/);
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
        /\.target = bbl::Vec3\{\(-0\.025979936122894287f\), 1\.6681787837296724f, 0\.4591848850250244f\}/,
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
    assert.match(result.cpp, /\.alpha \+= bbl::pi/);
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
