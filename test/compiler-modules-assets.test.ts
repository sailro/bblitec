import {
    cppFunction,
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";
import assert from "node:assert/strict";
import { pinnedPackageSpecifiers } from "../src/capture-suite-reference.js";
import { babylonPackages, isBabylonModule } from "../src/compiler/symbols.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { labDeployment, pinnedAssetUrl } from "./compiler-fixtures.js";

test("a finally handler revoking an object URL completes without a thenable", () => {
    // URL.revokeObjectURL is a library object's static method declared
    // void: its call completes with undefined, so finally discards it.
    const result = compileSource(`
        function load(bytes: Uint8Array): Promise<number> {
            const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
            return Promise.resolve(bytes.length).finally(() => URL.revokeObjectURL(url));
        }
        load(new Uint8Array([1, 2, 3])).then((n) => { if (n !== 3) throw new Error("finally " + n); });
    `);
    assert.match(result.cpp, /\.finally\(/);
    assert.match(result.cpp, /bbl::js::revoke_object_url\(/);
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

test("refuses imports of names the pinned package does not export", () => {
    for (const [statement, name] of [
        [
            `import { createEngine, type Engine as LiteEngine } from "babylon-lite";`,
            "Engine",
        ],
        [
            `import { createEngine, createEngineSoon } from "@babylonjs/lite";`,
            "createEngineSoon",
        ],
        [
            `import { createEngine, missingHelper as helper } from "babylon-lite";`,
            "missingHelper",
        ],
        [`export { NoSuchType } from "babylon-lite";`, "NoSuchType"],
        // A subpath exports what its own module does.
        [
            `import { wgsl, createEngine } from "babylon-lite/shader/wgsl.js";`,
            "createEngine",
        ],
        [
            `import { type WgslSource, wgsl } from "babylon-lite/shader/no-such-module.js";`,
            "WgslSource",
        ],
    ] as const)
        assert.throws(
            () =>
                compileSource(`
                    ${statement}
                    let api: { read: (engine: number) => number } | null = null;
                    api ??= { read: (engine) => engine };
                `),
            (error: unknown) =>
                error instanceof Error &&
                error.message.includes(
                    `does not export '${name}': the pinned package declares no such name.`,
                ) &&
                error.message.startsWith("input.ts:2:"),
        );
    // A subpath's module, not the entry's typings, says what it exports.
    compileSource(`
        import { installPbrTracking } from "babylon-lite/material/tracking/pbr-tracking";
        import { type WgslSource, wgsl } from "babylon-lite/shader/wgsl.js";
        const source: WgslSource = wgsl\`fn main() {}\`;
        void installPbrTracking;
        void source;
    `);
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
            fileName: "test/compiler-multi-file-entry.ts",
        },
    );

    const engineAlias = /auto& (\w+) = v_engine;/.exec(result.cpp);
    assert.ok(engineAlias, "the imported helper borrows the entry engine");
    assert.match(
        result.cpp,
        new RegExp(
            `auto v_fn\\d+_scene = bbl::create_scene_context\\(${engineAlias[1]}\\)`,
        ),
    );
    assert.match(
        result.cpp,
        new RegExp(
            `create_directional_light\\(${engineAlias[1]}, bbl::Vec3\\{0\\.0f, \\(-1\\.0f\\), 0\\.0f\\}, 0\\.75\\)`,
        ),
    );
    assert.match(
        result.cpp,
        /v_fn\d+_scene\.environment\.exposure = static_cast<float>\(1\.25\)/,
    );
    assert.ok(result.manifest.features.includes("light:directional"));
});

test("materializes an object mutated through an imported helper", () => {
    const result = compileSource(
        `
            import {
                writeMutableOutput,
            } from "./fixtures/compiler-modules/mutable-output.js";

            const output = { x: 0, y: 0 };
            writeMutableOutput(3, output);
            const observed = output.y;
        `,
        {
            fileName: "test/compiler-multi-file-entry.ts",
        },
    );

    assert.match(
        result.cpp,
        /bblscene::MutableOutput v_output = bbl::js::make_ref<[^>]+>\([^;]+\);/,
    );
    assert.match(result.cpp, /writeMutableOutput\(3\.0, v_output\)/);
    assert.match(result.cpp, /v_output->y/);
    assert.doesNotMatch(
        result.cpp,
        /writeMutableOutput\(3\.0, bbl::js::make_ref/,
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
            fileName: "test/compiler-multi-file-entry.ts",
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
        result.cpp.indexOf(values[0]) < result.cpp.indexOf(index[0]),
        "dependency storage is initialized before its importer",
    );
    assert.equal(
        (result.cpp.match(new RegExp(`${values[1]}\\.push_back`, "g")) ?? [])
            .length,
        1,
        "the one emitted loop body appends both runtime rows",
    );
    assert.match(result.cpp, new RegExp(`${index[1]}\\.set\\(`));
    assert.match(result.cpp, new RegExp(`${index[1]}\\.get_owned\\(v_key\\)`));
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
            fileName: "test/compiler-multi-file-entry.ts",
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
    assert.ok(alias, "the immutable binding borrows its stable Array wrapper");
    assert.equal(
        (result.cpp.match(new RegExp(`${alias[1]}\\.push_back`, "g")) ?? [])
            .length,
        2,
    );
    assert.match(result.cpp, new RegExp(`bbl::js::number_at\\(${values[1]},`));
});

test("materializes mutable module state used only at call time", () => {
    const result = compileSource(
        `
            import {
                activate,
                installToggle,
                isActive,
            } from "./fixtures/compiler-modules/module-runtime-state.js";
            import { createEngine } from "@babylonjs/lite";

            await createEngine({});
            installToggle();
            activate();
            const selected = isActive();
        `,
        {
            fileName: "test/compiler-multi-file-entry.ts",
        },
    );

    const active = result.cpp.match(
        /auto (v_module\d+_active) = bbl::js::make_gc_shared<bool>\(false\)/,
    );
    assert.ok(active, "the imported module owns one native state slot");
    assert.match(result.cpp, new RegExp(`\\(\\*${active[1]}\\) = true`));
    assert.match(result.cpp, new RegExp(`return \\(\\*${active[1]}\\)`));
    assert.match(result.cpp, /bbl::on_dom_pointer\([^\n]*"pointerdown"/);
    assert.match(
        result.cpp,
        new RegExp(`\\(\\*${active[1]}\\) = !\\(\\(\\*${active[1]}\\)\\)`),
    );
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
            fileName: "test/compiler-multi-file-entry.ts",
        },
    );

    const values = result.cpp.match(
        /bbl::js::Array<double> (v_module\d+_values) =/,
    );
    assert.ok(values, "dependency state has native storage");
    assert.match(
        result.cpp,
        new RegExp(`${values[1]}\\.push_back\\(11\\.0\\)`),
    );
    assert.match(result.cpp, new RegExp(`bbl::js::number_at\\(${values[1]},`));
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
            fileName: "test/compiler-multi-file-entry.ts",
        },
    );

    assert.doesNotMatch(result.cpp, /v_module\d+_row/);
    // The field reads the call's held result.
    assert.match(
        result.cpp,
        /auto (v_bblite_function_result_\d+) = bblscene::buildRow\(\);\s+\[\[maybe_unused\]\] double v_selected = \1\.value;/,
    );
});

test("hoists module record factories out of hot dynamic lookups", () => {
    const result = compileSource(`
        interface Definition {
            name: string;
            opaque: boolean;
        }
        function definition(name: string, opaque = true): Definition {
            return { name, opaque };
        }
        const DEFINITIONS: Record<number, Definition> = {
            1: definition("stone"),
            2: definition("glass", false),
        };
        function opaque(id: number): boolean {
            return DEFINITIONS[id]?.opaque === true;
        }
        const selected = opaque(Math.random() < 0.5 ? 1 : 2);
    `);

    // Entry initialization owns the fresh records once; hot lookups borrow
    // the retained table without rebuilding either entry.
    const entry = cppFunction(result.cpp, "int main()");
    assert.equal((entry.match(/bblscene::definition\(/g) ?? []).length, 2);
    assert.equal((result.cpp.match(/bblscene::definition\(/g) ?? []).length, 2);
    assert.match(
        entry,
        /bbl::js::Dictionary<double, bblscene::Definition> v_DEFINITIONS =/,
    );
    assert.match(result.cpp, /v_DEFINITIONS\.get\(v_fn\d+_id\)/);
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
    assert.match(asset.source, /^generated:data-url:[0-9a-f]{64}$/);
    assert.equal(result.assetPayloads.get(asset.source), dataUrl);
    assert.doesNotMatch(JSON.stringify(result.manifest), /base64/);
    assert.match(asset.output, /^[0-9a-f]{8}-inline\.png$/);
});

test("refuses distinct asset URLs with the same packaged hash and basename", () => {
    assert.throws(
        () =>
            compileSource(`
        import { createEngine, loadTexture2D } from "@babylonjs/lite";
        async function main() {
            const engine = await createEngine({});
            await loadTexture2D(engine, "https://example.com/image.png?id=1rjxuof");
            await loadTexture2D(engine, "https://example.com/image.png?id=qhmpx9");
        }
    `),
        /Packaged asset path '54a76ecc-image.png' names both/,
    );
});

test("erases a catch binding observed only by browser instrumentation", () => {
    const result = compileSource(`
        let recovered = false;
        try {
            throw new Error("failed");
        } catch (error) {
            console.warn("ignored", error);
            recovered = true;
        }
    `);

    assert.match(result.cpp, /catch \(\.\.\.\) \{/);
    assert.match(result.cpp, /v_recovered = true;/);
    assert.doesNotMatch(result.cpp, /ignored/);
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
                    fileName: "test/compiler-multi-file-entry.ts",
                },
            ),
        /test[\\/]fixtures[\\/]compiler-modules[\\/]bad-helper\.ts:\d+:\d+: Unsupported statement:/,
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
        /bbl::js::make_gc_shared<bbl::js::Callback<void\(\)>>\(\)/,
    );
    assert.match(
        result.cpp,
        /bbl::set_timeout\(v_engine, bbl::js::make_closure\(bblscene::bbl_environment_\w+\{bbl_recursive_\w+_owner\}, bblscene::\w+/,
    );
    assert.doesNotMatch(result.cpp, /native_callback_owners/);
});

test("owns only the timer-scheduled recursive callback beyond its scope", () => {
    // The scheduled timer owns poll's callback cell; synchronous countdown
    // borrows its local callback. Neither uses a permanent engine root.
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            const engine = await createEngine({});
            let polls = 0;
            let total = 0;
            const countdown = (value: number): void => {
                if (value <= 0) return;
                total += value;
                countdown(value - 1);
            };
            const poll = (): void => {
                polls += 1;
                if (polls < 5) setTimeout(poll, 40);
            };
            countdown(2);
            poll();
        }
        main();
    `);

    assert.match(
        result.cpp,
        /bbl::set_timeout\(v_engine, bbl::js::make_closure\(bblscene::bbl_environment_\w+\{bbl_recursive_\w*poll_owner\}, bblscene::\w+/,
    );
    assert.match(result.cpp, /bbl::js::Callback<void\(double\)> v_countdown;/);
    assert.equal(
        result.cpp.match(/make_gc_shared<bbl::js::Callback</g)?.length,
        1,
    );
    assert.doesNotMatch(result.cpp, /native_callback_owners|countdown_owner/);
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

    assert.match(result.cpp, /\.position\.x = 3\.0/);
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

test("folds a nullish-coalescing browser query default", () => {
    const source = `
        import {
            createBox,
            createEngine,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const box = createBox(engine);
            const params = new URLSearchParams(window.location.search);
            const seek = parseFloat(params.get("seekTime") ?? "");
            if (!isNaN(seek) && seek > 0) {
                box.position.x = 3;
            }
        }
    `;

    assert.doesNotMatch(compileSource(source).cpp, /\.position\.x = 3\.0/);
    assert.match(
        compileSource(source, { search: "?seekTime=0.5" }).cpp,
        /\.position\.x = 3\.0/,
    );
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

    assert.match(
        result.cpp,
        /for \(; static_cast<double>\(v_block\d+_i\) < 40\.0;/,
    );
    assert.doesNotMatch(result.cpp, /Browser-dependent condition/);
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

test("folds a module helper that reads the pinned query", () => {
    // Thirteen pinned scenes wrap the query read in a named helper --
    // `readCaptureFrame()`, `readCaptureAfterFrames()`, `readSeekTime()` --
    // and branch on its result. The steps inside are the same ones that
    // fold when a scene writes them inline, so putting a name around them
    // cannot stop them folding: otherwise the call lowers to a native
    // function whose body IS the folded constant while every branch over
    // its result stays live, and a scene's interactive arm has to compile
    // at a pose the pin never serves it at.
    const source = `
        import {
            createBox,
            createEngine,
        } from "@babylonjs/lite";

        const DEFAULT_FRAME = 5;

        function readCaptureFrame(): number | null {
            const params = new URLSearchParams(location.search);
            const frameValue = params.get("captureFrame");
            if (frameValue !== null) {
                const frame = Number(frameValue);
                return Number.isFinite(frame) && frame >= 0
                    ? Math.round(frame)
                    : DEFAULT_FRAME;
            }
            return null;
        }

        async function main() {
            const engine = await createEngine({});
            const box = createBox(engine);
            const captureFrame = readCaptureFrame();
            const autoTest = captureFrame !== null;
            if (autoTest) {
                box.position.x = captureFrame!;
            } else {
                box.position.x = 99;
            }
        }
    `;
    const queried = compileSource(source, {
        search: "?captureFrame=7.4",
    });
    assert.match(queried.cpp, /\.position\.x = 7\.0/);
    assert.doesNotMatch(queried.cpp, /readCaptureFrame|99\.0/);
    // The other pose selects the other arm, which is what proves the fold
    // reads the query rather than assuming the capture branch.
    const bare = compileSource(source);
    assert.match(bare.cpp, /\.position\.x = 99\.0/);
    assert.doesNotMatch(bare.cpp, /readCaptureFrame|7\.0/);
});

test("keeps lowering a helper that reads no browser state", () => {
    // The gate that separates a query read from ordinary code. Every other
    // rule of the helper fold holds for `frameCount()` -- module level, no
    // parameters, a body of one `return` this evaluator can walk -- so
    // without the browser-state test it would fold, and a native call the
    // scene means to make would erase.
    const result = compileSource(
        `
        import {
            createBox,
            createEngine,
        } from "@babylonjs/lite";

        function frameCount(): number {
            return 4;
        }

        async function main() {
            const engine = await createEngine({});
            const box = createBox(engine);
            box.position.x = frameCount();
        }
    `,
        { search: "?captureFrame=7" },
    );
    assert.match(result.cpp, /frameCount/);
});

test("folds a Math transform over the native device pixel ratio", () => {
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
    assert.doesNotMatch(result.cpp, /devicePixelRatio/);
    assert.match(result.cpp, /round_js\(1(?:\.0)?\)/);
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

    assert.match(result.cpp, /return false;/);
    assert.match(
        result.cpp,
        /\.position\.x = \(v_bblite_shared_result_\d+ \? 4\.0 : 5\.0\)/,
    );
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
        /parseFloat requires a string value/,
    );
});

test("folds Number.parseFloat exactly as the bare global", () => {
    // ES2015 put the same function object on `Number`, so which spelling a
    // scene wrote cannot decide whether its query value stays browser
    // state or what it folds to. Scene 302 writes the qualified one.
    const qualified = `
        import {
            createBox,
            createEngine,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const box = createBox(engine);
            const params = new URLSearchParams(window.location.search);
            const seek = Number.parseFloat(params.get("seekTime") || "");
            if (isNaN(seek)) {
                box.position.x = 3;
            } else {
                box.position.x = seek;
            }
        }
    `;
    // No query: the parse is NaN, so the guard's own arm is the one kept.
    const bare = compileSource(qualified);
    assert.match(bare.cpp, /\.position\.x = 3\.0/);
    // With the pose's own query it folds to the number generation knows.
    const queried = compileSource(qualified, { search: "?seekTime=0.5" });
    assert.match(queried.cpp, /\.position\.x = 0\.5/);
    assert.doesNotMatch(queried.cpp, /parseFloat/);
});

test("materializes direct browser primitive call arms", () => {
    const result = compileSource(
        `
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
    `,
        { search: "?value=chosen.glb" },
    );

    assert.equal(result.manifest.assets[0]?.source, "chosen.glb");
});

test("compiles Scene 211's pinned meshopt asset request", () => {
    const sourcePath = "corpus/babylon-lite/lab/lite/src/lite/scene211.ts";
    const result = compileSource(readFileSync(resolve(sourcePath), "utf8"), {
        fileName: sourcePath,
    });

    assert.deepEqual(
        result.manifest.assets.map(({ source, kind }) => ({ source, kind })),
        [
            {
                source:
                    "https://cdn.jsdelivr.net/gh/KhronosGroup/" +
                    "glTF-Sample-Assets@main/Models/BrainStem/" +
                    "glTF-Meshopt-EXT/BrainStem.gltf",
                kind: "gltf",
            },
        ],
    );
});

test("refuses to erase a browser call handed the program's own binary data", () => {
    // The browser fills the buffer it is handed; erasing the call left the
    // bytes zero.
    assert.throws(
        () =>
            compileSource(`
                const bytes = new Uint8Array(16);
                void crypto.subtle.digest("SHA-256", bytes);
                console.log(bytes[0]);
            `),
        /'crypto\.subtle\.digest' would erase a call handed the program's own binary data/,
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

        function store(out: { [index: number]: number }, value: number): void {
            out[0] = value;
        }
    `);

    // The fetch replacement is erased setup; a member only the program's
    // types declare, which nothing installs natively, reads absent (an
    // index write installs no named member).
    assert.doesNotMatch(result.cpp, /globalThis|originalFetch/);
    assert.match(result.cpp, /double v_engineKB = 0\.0;/);
    assert.ok(
        result.manifest.adaptations.some(
            ({ id }) => id === "browser-setup-erasure",
        ),
    );
});

test("erases a write-only browser helper rooted at globalThis", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        interface Progress {
            done(): void;
        }

        function installProgress(canvas: HTMLElement): Progress {
            const original = globalThis.fetch.bind(globalThis);
            let raf = 0;
            const schedule = (): void => {
                if (!raf) raf = requestAnimationFrame(() => {
                    canvas.dataset.progress = "50";
                });
            };
            globalThis.fetch = original;
            schedule();
            return {
                done(): void {
                    globalThis.fetch = original;
                    cancelAnimationFrame(raf);
                },
            };
        }

        async function main() {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const progress = installProgress(canvas);
            await createEngine(canvas);
            progress.done();
        }
    `);

    assert.match(result.cpp, /bbl::create_engine/);
    assert.doesNotMatch(
        result.cpp,
        /globalThis|requestAnimationFrame|cancelAnimationFrame|progress/,
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

test("assigns a promised resource tuple into definite-assignment locals", () => {
    const result = compileSource(`
        import { addToScene, createEngine, createSceneContext, getContainerMeshes, isPbrMaterial, loadGltf } from "@babylonjs/lite";
        import type { AssetContainer, Mesh } from "@babylonjs/lite";

        function reveal(container: AssetContainer): void {
            for (const mesh of getContainerMeshes(container)) {
                if (!isPbrMaterial(mesh.material)) {
                    continue;
                }
                mesh.visible = true;
            }
        }

        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            let ship: AssetContainer;
            let rock: AssetContainer;
            [ship, rock] = await Promise.all([
                loadGltf(engine, "ship.glb"),
                loadGltf(engine, "rock.glb"),
            ]);
            addToScene(scene, ship);
            addToScene(scene, rock);
            reveal(ship);
        }
    `);

    assert.equal(
        (
            result.cpp.match(
                /std::optional<std::pair<bbl::StoredEngine, bbl::AssetHandle>> v_(?:ship|rock)\{\};/g,
            ) ?? []
        ).length,
        2,
    );
    assert.equal((result.cpp.match(/bbl::load_gltf/g) ?? []).length, 2);
    const assets = ["ship.glb", "rock.glb"].map((source) => {
        const asset = result.manifest.assets.find(
            (entry) => entry.source === source,
        );
        assert.ok(asset);
        return asset.output;
    });
    const loads = [
        ...result.cpp.matchAll(
            /auto (v_bblite_awaited_\d+) = bbl::load_gltf\((v_engine), bbl::asset_path\("([^"]+)"\)\);/g,
        ),
    ];
    assert.deepEqual(
        loads.map((load) => load[3]),
        assets,
    );
    const snapshots = [
        ...result.cpp.matchAll(
            /const auto (v_bblite_destructure_resource_\d+) = (v_bblite_awaited_\d+);/g,
        ),
    ];
    assert.equal(snapshots.length, 2);
    assert.deepEqual(
        snapshots.map((snapshot) => snapshot[2]),
        loads.map((load) => load[1]),
    );
    assert(loads[1]!.index < snapshots[0]!.index);
    const assignments = [
        ...result.cpp.matchAll(/(v_ship|v_rock) = ([^\n]+);/g),
    ];
    assert.deepEqual(
        assignments.map((assignment) => assignment[1]),
        ["v_ship", "v_rock"],
    );
    assert(snapshots[1]!.index < assignments[0]!.index);
    const assetType = "std::pair<bbl::StoredEngine, bbl::AssetHandle>";
    assignments.forEach((assignment, index) => {
        assert.equal(
            assignment[2]!,
            `bbl::js::Nullable<${assetType}>{${assetType}{bbl::StoredEngine{${loads[index]![2]}}, ${snapshots[index]![1]}}}.to_optional()`,
        );
    });
    assert.equal((result.cpp.match(/bbl::add_to_scene/g) ?? []).length, 2);
});

test("borrows immutable Promise.all results from their ordered owners", () => {
    const result = compileSource(`
        import { createEngine, loadGltf } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const [ship, rock] = await Promise.all([
                loadGltf(engine, "ship.glb"),
                loadGltf(engine, "rock.glb"),
            ]);
            if (ship === rock) throw new Error("asset identities");
        }
    `);

    assert.equal(
        (result.cpp.match(/auto v_bblite_awaited_\d+ =/g) ?? []).length,
        2,
    );
    assert.match(result.cpp, /auto& v_(?:fn\d+_)?ship = v_bblite_awaited_\d+;/);
    assert.match(result.cpp, /auto& v_(?:fn\d+_)?rock = v_bblite_awaited_\d+;/);
    assert.doesNotMatch(
        result.cpp,
        /auto v_(?:fn\d+_)?(?:ship|rock) = v_bblite_awaited_\d+;/,
    );
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
                const name = Math.random() < 0.5 ? "tone.wav" : "tone.wav";
                await loadSound(audio.audioContext, name);
            }
            main();
        `,
        { fileName: "test/compiler-dynamic-audio-entry.ts" },
    );

    assert.equal(result.manifest.assets.length, 1);
    assert.match(result.cpp, /Unknown packaged asset/);
    assert.match(result.cpp, /audio_decode_buffer/);
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
        result.cpp.split(result.manifest.assets[0].output).length - 1,
        1,
    );
});

test("packages runtime-selected module textures as a closed image directory", () => {
    const result = compileSource(
        `
            import { createEngine, loadTexture2D } from "@babylonjs/lite";
            import { demoAssetUrl } from "./demo-asset-url.js";

            const root = demoAssetUrl("./freeciv", import.meta.url);
            const names = new Map<string, string>();
            names.set("terrain", "amplio2/terrain1.png");

            async function main(): Promise<void> {
                const engine = await createEngine({});
                for (const name of names.values()) {
                    await loadTexture2D(engine, root + "/" + name);
                }
            }
            void main();
        `,
        {
            fileName:
                "corpus/babylon-lite/lab/lite/src/demos/freeciv-texture-test.ts",
        },
    );

    assert.equal(result.manifest.assets.length, 11);
    assert.ok(result.manifest.assets.every(({ kind }) => kind === "texture"));
    assert.ok(
        result.manifest.assets.every(({ source }) => /\.png$/i.test(source)),
    );
    assert.match(result.cpp, /Unknown packaged asset/);
    assert.match(result.cpp, /bbl::load_file_texture/);
});

test("a realm's module texture URLs take a union suffix and its address modes at run time", () => {
    const result = compileSource(
        `
            import { createEngine, loadTexture2D } from "@babylonjs/lite";
            import { demoAssetUrl } from "./demo-asset-url.js";

            const sources = [
                { file: "road-straight.png", addressModeU: "clamp-to-edge" },
                { file: "boost-arrow.png", addressModeU: "repeat" },
            ] as const;
            async function main(): Promise<void> {
                const engine = await createEngine(document.querySelector("canvas")!);
                const urls = sources.map((source) => demoAssetUrl(\`./antigravity-racer/track/\${source.file}\`, import.meta.url));
                await Promise.all(
                    sources.map((source, i) =>
                        loadTexture2D(engine, urls[i]!, { addressModeU: source.addressModeU }),
                    ),
                );
            }
            queueMicrotask(() => {});
            void main();
        `,
        {
            fileName:
                "corpus/babylon-lite/lab/lite/src/demos/realm-track-texture-test.ts",
        },
    );

    assert.match(
        result.cpp,
        /bbl::js::concat\("\.\/antigravity-racer\/track\/", bblscene::\w+_to_string\(/,
    );
    assert.match(
        result.cpp,
        /== bblscene::\w+::clamp_to_edge \? bbl::TextureAddressMode::clamp : bbl::TextureAddressMode::repeat\)/,
    );
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

    assert.deepEqual(
        result.manifest.assets.map(({ source }) => source),
        [pinnedAssetUrl("packages/babylon-lite/assets/brdf-lut.png")],
    );
});

test("module URL helpers resolve and rewrite the whole input once", (t) => {
    const result = compileSource(`
        function asset(path: string, moduleUrl: string): string {
            const url = new URL(path, moduleUrl);
            url.pathname = url.pathname.replace("old", "new");
            url.pathname = url.pathname.replace("new", "pre-$&");
            return url.href;
        }
        const tail = "ld dir";
        const folded = asset(\`./assets/o\${tail}\`, import.meta.url);
        if (folded !== "/assets/pre-new%20dir") throw new Error(folded);
        const gate = new Uint8Array([1]);
        const paths = [gate[0] ? "old dir" : "unused", gate[0] ? "../old?q=old#old" : "unused"];
        let calls = 0;
        for (const tail of paths) {
            const actual = asset(\`./dir/\${(++calls, tail)}\`, import.meta.url);
            const expected = calls === 1 ? "/dir/pre-new%20dir" : "/pre-new?q=old#old";
            if (actual !== expected) throw new Error(actual);
        }
        if (calls !== 2) throw new Error("substitution count");
        const host = gate[0] ? "example.org" : "elsewhere.org";
        if (asset(\`https://\${host}/old dir?key=old#old\`, import.meta.url) !== "https://example.org/pre-new%20dir?key=old#old")
            throw new Error("external URL");
        let caught = false;
        try { asset("https://", import.meta.url); } catch { caught = true; }
        if (!caught) throw new Error("invalid URL did not throw");
    `);
    assert.match(result.cpp, /"\/assets\/pre-new%20dir"/);
    assert.match(result.cpp, /\.set_pathname\(bbl::js::string_replace/);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler unavailable");
        return;
    }
    runGeneratedProgram(tools, "compiler-module-url-full-input", result.cpp);
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
        { ...labDeployment, fileName: "test/compiler-multi-file-entry.ts" },
    );

    assert.deepEqual(
        result.manifest.assets.map(({ source }) => source),
        [pinnedAssetUrl("lab/public/bundle/demos/probe.png")],
    );
});

test("keeps pinned root assets independent of adjacent filesystem files", () => {
    const directory = mkdtempSync(join(tmpdir(), "bblite-pinned-asset-"));
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

        assert.deepEqual(
            result.manifest.assets.map(({ source }) => source),
            [pinnedAssetUrl("packages/babylon-lite/assets/brdf-lut.png")],
        );
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

    assert.deepEqual(
        result.manifest.assets.map(({ source }) => source),
        [pinnedAssetUrl("packages/babylon-lite/assets/brdf-lut.png")],
    );
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

test("re-queues a frame yield inside the hoisted continuation", () => {
    const result = compileSource(
        frameYieldScene(
            "    await new Promise<void>((r) => requestAnimationFrame(() => r()));",
        ),
        frameYieldFile,
    );
    assert.doesNotMatch(result.cpp, /requestAnimationFrame/);
    // The yield sits after `startEngine`, where the statements around it
    // already run at a frame boundary -- so it re-queues the rest of the
    // continuation to the NEXT boundary instead of erasing to nothing.
    assert.match(
        result.cpp,
        /bbl::defer_start_continuation_until\(v_engine, \[remaining = 2u\]/,
    );
});

test("re-queues a zero-argument arrow helper for one bounded frame yield", () => {
    const result = compileSource(
        frameYieldScene("    await nextFrame();").replace(
            "async function main(): Promise<void> {",
            `const nextFrame = async (): Promise<void> =>
    new Promise((resolve) => requestAnimationFrame(() => resolve()));
async function main(): Promise<void> {`,
        ),
        frameYieldFile,
    );

    assert.doesNotMatch(result.cpp, /requestAnimationFrame|Promise|nextFrame/);
    assert.match(
        result.cpp,
        /bbl::defer_start_continuation_until\(v_engine, \[remaining = 2u\]/,
    );
});

test("runs the statements after a re-queued yield a frame later", () => {
    // Scene 129's shape: the pick and its dependent mutation follow
    // `await splat.firstSortReady` and one frame yield. The statements
    // after the yield must land inside the NESTED continuation -- the next
    // frame's drain, after that frame's own uploads -- not beside the ones
    // before it.
    const result = compileSource(
        frameYieldScene(
            `    scene.clearColor = { r: 1, g: 0, b: 0, a: 1 };
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    scene.clearColor = { r: 0, g: 1, b: 0, a: 1 };`,
        ),
        frameYieldFile,
    );
    assert.match(
        result.cpp,
        /bbl::defer_start_continuation\(v_engine, \[&\]\(\) \{[^]*?clear_color[^]*?bbl::defer_start_continuation\(v_engine, \[&\]\(\) \{[^]*?clear_color/,
    );
});

test("re-queues once per yield so two yields park two frames out", () => {
    // Scene 271 writ small: consecutive yields are "let two frames
    // elapse", with one drain per frame.
    const result = compileSource(
        frameYieldScene(
            `    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    await new Promise<void>((r) => requestAnimationFrame(() => r()));`,
        ),
        frameYieldFile,
    );
    assert.match(
        result.cpp,
        /defer_start_continuation_until\(v_engine, \[remaining = 3u\]/,
    );
});

/**
 * The escaping-continuation handshake: `resolve` is stored in an outer
 * binding and a scene callback calls it later. Scene 115's shape, spelled
 * small.
 */
function escapingResolveScene(executor: string, awaited: string): string {
    return `import {
    createArcRotateCamera,
    createBox,
    createEngine,
    createSceneContext,
    onBeforeRender,
    registerScene,
    startEngine,
} from "babylon-lite";
async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.camera = createArcRotateCamera(0, 1, 8, { x: 0, y: 0, z: 0 });
    createBox(engine, 2);
    let frames = 0;
    let resolveReady!: () => void;
    const ready = new Promise<void>(${executor});
    onBeforeRender(scene, () => {
        frames++;
        if (frames === 3) {
            resolveReady();
        }
    });
    await registerScene(scene);
    await startEngine(engine);
${awaited}
    scene.clearColor = { r: 0, g: 1, b: 0, a: 1 };
}
main().catch(console.error);
`;
}

test("parks a continuation behind a promise a scene callback resolves", () => {
    const result = compileSource(
        escapingResolveScene(
            `(resolve) => {
        resolveReady = resolve;
    }`,
            "    await ready;",
        ),
        frameYieldFile,
    );
    // The promise itself has no native value: it is a latch the resolver
    // sets and the continuation waits on.
    assert.match(result.cpp, /bool v_ready = false;/);
    assert.match(
        result.cpp,
        /v_resolveReady = \[&v_ready\]\(\) \{ v_ready = true; \};/,
    );
    // And the statements after the await run at the first frame boundary
    // where the latch is set, not at the next one unconditionally.
    assert.match(
        result.cpp,
        /bbl::defer_start_continuation_until\(v_engine, \[&\]\(\) \{ return v_ready; \}, \[&\]\(\) \{/,
    );
    assert.doesNotMatch(result.cpp, /__bblite_start_continuation_until__/);
});

test("a promise executor that does more than let resolve escape compiles in the application realm", () => {
    // The narrowness is the point: an executor that also schedules or
    // calls `resolve` is a different claim about WHEN the wait ends, and
    // falls through to the constructor the application realm keeps pending.
    const result = compileSource(
        escapingResolveScene(
            `(resolve) => {
        resolveReady = resolve;
        resolve();
    }`,
            "    await ready;",
        ),
        frameYieldFile,
    );
    assert.doesNotMatch(result.cpp, /SynchronousPromise/);
    assert.match(result.cpp, /bbl::js::Promise<bbl::js::PromiseVoid>/);
});

test("still erases a frame yield before the loop exists", () => {
    // Before `startEngine` the entry body runs ahead of the first frame's
    // own work, so the original claim holds and the yield erases to
    // nothing -- no continuation, no re-queue.
    const result = compileSource(
        `import {
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
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    await registerScene(scene);
    await startEngine(engine);
}
main().catch(console.error);
`,
        frameYieldFile,
    );
    assert.doesNotMatch(result.cpp, /requestAnimationFrame/);
    assert.doesNotMatch(result.cpp, /defer_start_continuation/);
});

test("refuses a frame yield nested in a block after startEngine", () => {
    // The re-queue is a cut between statements of the entry body; inside a
    // block there is no statement boundary the rest of the continuation
    // could be parked behind, and erasing it there would run the following
    // statements a frame early.
    assert.throws(
        () =>
            compileSource(
                frameYieldScene(
                    `    if (canvas.clientWidth > 0) {
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
    }`,
                ),
                frameYieldFile,
            ),
        /needs the yield to lower at the entry body's own level/,
    );
});

test("re-queues a frame yield inside a helper body inlined after startEngine", () => {
    // A helper's body lowers per call site, and an inlined body with no
    // early return is written out FLAT at the caller's own level -- so the
    // marker lands exactly where an entry-block yield's would, and cutting
    // there parks the statements after the call one frame out. The
    // helper's own locals are declared at that level too, which is what
    // gives them the static storage the nested continuation reads.
    const result = compileSource(
        frameYieldScene("    await settle(scene);").replace(
            "async function main(): Promise<void> {",
            `async function settle(target: SceneContext): Promise<void> {
    target.clearColor = { r: 0, g: 1, b: 0, a: 1 };
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
}
async function main(): Promise<void> {`,
        ),
        frameYieldFile,
    );
    assert.doesNotMatch(result.cpp, /requestAnimationFrame/);
    assert.match(
        result.cpp,
        /bbl::defer_start_continuation\(v_engine, \[&\]\(\) \{[^]*?clear_color[^]*?bbl::defer_start_continuation\(v_engine, \[&\]\(\) \{/,
    );
});

test("unrolls a constant-trip frame-yield loop into one re-queue per frame", () => {
    // Scenes 113/114/115/118's `waitFrames(4)`: the trip count is a
    // generation-known argument, so the loop is written out and the yields
    // become a counted wait, plus the initial post-start boundary.
    const result = compileSource(
        frameYieldScene(
            `    await waitFrames(4);
    scene.clearColor = { r: 1, g: 0, b: 0, a: 1 };`,
        ).replace(
            "async function main(): Promise<void> {",
            `async function waitFrames(frameCount: number): Promise<void> {
    for (let i = 0; i < frameCount; i++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
}
async function main(): Promise<void> {`,
        ),
        frameYieldFile,
    );
    assert.doesNotMatch(result.cpp, /requestAnimationFrame|for \(/);
    assert.match(
        result.cpp,
        /defer_start_continuation_until\(v_engine, \[remaining = 5u\]/,
    );
    // The scene mutation is behind all four boundaries, not beside them.
    assert.match(result.cpp, /defer_start_continuation_until[^]*?clear_color/);
});

test("unrolls a constant-trip frame-yield loop past the ordinary unroll cap", () => {
    // Scene 261's shape: 160 accumulation frames, well past the 32-body
    // static-index cap. A frame yield forces static iteration for the same
    // reason pinned scene construction does -- emitting the body once
    // inside a native loop would record ONE frame boundary for 160
    // iterations, which is the multi-frame wait this runtime refuses.
    const result = compileSource(
        frameYieldScene(
            `    for (let i = 0; i < 160; i++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }`,
        ),
        frameYieldFile,
    );
    assert.match(
        result.cpp,
        /defer_start_continuation_until\(v_engine, \[remaining = 161u\]/,
    );
});

test("still refuses a frame yield in a loop whose trip count is not known", () => {
    // The refusal is about a RUNTIME loop: nothing writes it out, so one
    // emitted yield would stand in for however many the loop runs.
    assert.throws(
        () =>
            compileSource(
                frameYieldScene(
                    `    let frames = 0;
    while (frames < 4) {
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        frames += 1;
    }`,
                ),
                frameYieldFile,
            ),
        /A frame yield inside a loop is a multi-frame wait/,
    );
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
    // `tick` is a kept value (handed to requestAnimationFrame by name), so
    // the counter it writes is a shared cell the frame callback owns.
    assert.match(
        result.cpp,
        /auto v_elapsed = bbl::js::make_gc_shared<double>\(0\.0\);/,
    );
    assert.match(
        result.cpp,
        /animation_frame_callbacks\.push_back\(bbl::js::make_closure\(bblscene::bbl_environment_\w+\{v_elapsed\}, bblscene::\w+/,
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
    // `tick` is handed to requestAnimationFrame by name, so the bindings it
    // writes are cells its closure environment owns past the continuation.
    assert.match(
        result.cpp,
        /bbl::defer_start_continuation\([^]*auto v_\w*last = bbl::js::make_gc_shared<double>\(bbl::pal::performance_milliseconds\(\)\);/,
    );
    assert.match(
        result.cpp,
        /bbl::defer_start_continuation\([^]*auto v_\w*elapsed = bbl::js::make_gc_shared<double>\(0\.0\);/,
    );
    assert.match(result.cpp, /v_\w*phase = 1\.0;/);
    assert.doesNotMatch(result.cpp, /static v_\w*phase = 1\.0;/);
});

test("preserves nested one-shot animation-frame continuations", () => {
    const result = compileSource(`
        import { createEngine, startEngine } from "babylon-lite";
        async function main(): Promise<void> {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            const damage = document.createElement("div");
            document.body.appendChild(damage);
            requestAnimationFrame(() => requestAnimationFrame(() => {
                damage.style.transition = "opacity .5s ease-out";
                damage.style.opacity = "0";
            }));
            await startEngine(engine);
        }
        main();
    `);

    assert.equal(
        (result.cpp.match(/bbl::request_animation_frame\(/g) ?? []).length,
        2,
    );
    assert.match(result.cpp, /ui_set_style_property[^]*"opacity", "0"/);
    assert.doesNotMatch(result.cpp, /animation_frame_callbacks\.push_back/);
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

    // The interval retains `tick`, so the bindings it writes are shared
    // cells the closure environment owns rather than borrowed locals.
    assert.match(
        result.cpp,
        /auto v_ticks = bbl::js::make_gc_shared<double>\(0\.0\);/,
    );
    assert.match(
        result.cpp,
        /bbl::set_interval\(v_engine, bbl::js::make_closure\(bblscene::bbl_environment_\w+\{v_ticks, v_timer, std::ref\(v_engine\)\}, bblscene::\w+/,
    );
    assert.match(result.cpp, /v_\w*previous = \(\*v_\w*ticks\)/);
    assert.match(result.cpp, /\(\*v_\w*ticks\) = \(v_\w*previous \+ 1\.0\)/);
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

    assert.match(
        result.cpp,
        /bbl::set_interval\(v_engine, bbl::js::make_closure\(bblscene::bbl_environment_\w+\{v_fn\d+_ticks\}, bblscene::\w+/,
    );
    assert.match(result.cpp, /\(\*v_\w*ticks\) = \(v_\w*previous \+ 1\.0\)/);
});

test("a recurring timer owns the frame local it captures", () => {
    // The frame callback returns before the timer runs: the timer's
    // environment owns the local's shared cell rather than borrowing it.
    const result = compileSource(`
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
    `);
    assert.match(
        result.cpp,
        /auto (v_\w*frameLocal) = bbl::js::make_gc_shared<double>\(0\.0\);[\s\S]*bbl::set_interval\(v_engine, bbl::js::make_closure\(bblscene::(bbl_environment_\w+)\{\1/,
    );
    const environment =
        /bbl::set_interval\(v_engine, bbl::js::make_closure\(bblscene::(bbl_environment_\w+)\{/.exec(
            result.cpp,
        )![1]!;
    assert.match(
        result.cpp,
        new RegExp(
            `struct ${environment} \\{\\s+std::decay_t<std::shared_ptr<double>> capture0\\{\\};`,
        ),
    );
});

test("writes out a constant-trip frame-yield loop as one boundary per frame", () => {
    // A multi-frame wait is still not a thing this runtime fakes; a loop
    // whose trip count is generation-known is not one. Unrolling writes the
    // body out FLAT once per iteration, so five yields become five
    // sequential ones -- the shape the continuation re-queue already
    // lowers -- rather than one emitted yield standing in for five.
    const result = compileSource(
        frameYieldScene(
            `    for (let i = 0; i < 5; i++) {
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
    }`,
        ),
        frameYieldFile,
    );
    assert.doesNotMatch(result.cpp, /requestAnimationFrame/);
    assert.match(
        result.cpp,
        /defer_start_continuation_until\(v_engine, \[remaining = 6u\]/,
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

test("erases the pinned bounded nested two-frame yield", () => {
    const result = compileSource(
        frameYieldScene(
            "    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(r)));",
        ),
        frameYieldFile,
    );
    assert.doesNotMatch(result.cpp, /requestAnimationFrame|Promise/);
    assert.match(
        result.cpp,
        /bbl::defer_capture_until\([^;]+\[frames = 0u\]\(\) mutable \{ return \+\+frames >= 2u; \}\);/,
    );
});

test("erases Scene 117's exact bounded two-frame helper", () => {
    const result = compileSource(
        frameYieldScene(
            `    function waitTwoFrames(): Promise<number> {
        return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }
    await waitTwoFrames();`,
        ),
        frameYieldFile,
    );
    assert.doesNotMatch(
        result.cpp,
        /requestAnimationFrame|Promise|waitTwoFrames/,
    );
    assert.match(
        result.cpp,
        /bbl::defer_capture_until\([^;]+\[frames = 0u\]\(\) mutable \{ return \+\+frames >= 2u; \}\);/,
    );
});

test("refuses a bounded frame wait beside observable RAF work", () => {
    assert.throws(
        () =>
            compileSource(
                frameYieldScene(
                    `    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    requestAnimationFrame(() => { canvas.dataset.other = "done"; });`,
                ),
                frameYieldFile,
            ),
        /another requestAnimationFrame callback can interleave/,
    );
});

test("does not erase a bounded wait through a shadowed Promise", () => {
    assert.throws(
        () =>
            compileSource(
                frameYieldScene(
                    `    const Promise = globalThis.Promise;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));`,
                ),
                frameYieldFile,
            ),
        // `globalThis.Promise` is the language's Promise, not erasable
        // browser state: the alias itself refuses as a value.
        /Unsupported (?:constructor expression|expression statement:[\s\S]*NewExpression)|Unknown or unsupported variable 'globalThis'/,
    );
});

test("does not erase a bounded wait through a shadowed RAF", () => {
    assert.throws(
        () =>
            compileSource(
                frameYieldScene(
                    `    const requestAnimationFrame = (callback: (time: number) => void): number => {
        callback(0);
        return 0;
    };
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));`,
                ),
                frameYieldFile,
            ),
        /Argument 1 of 'requestAnimationFrame' is \(value: void \| PromiseLike<void>\) => void/,
    );
});

test("compiles a retained nested frame yield in the application realm", () => {
    const result = compileSource(
        frameYieldScene(
            "    const timestamp = await new Promise<number>((r) => requestAnimationFrame(() => requestAnimationFrame(r)));\n    canvas.dataset.timestamp = String(timestamp);",
        ),
        frameYieldFile,
    );
    assert.doesNotMatch(result.cpp, /SynchronousPromise/);
    assert.match(result.cpp, /bbl::js::Promise<double>/);
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

test("materializes entry-module state a main() scene rebinds", () => {
    const result = compileSource(`
        import {
            addToScene,
            createBox,
            createEngine,
            createSceneContext,
            registerScene,
            startEngine,
        } from "@babylonjs/lite";

        let curX = -2;
        let unmoved = 5;

        function place(
            engine: Awaited<ReturnType<typeof createEngine>>,
            scene: ReturnType<typeof createSceneContext>,
        ): void {
            const mesh = createBox(engine, 1);
            mesh.position.set(curX, unmoved, 0);
            addToScene(scene, mesh);
            curX += 2;
        }

        async function main(): Promise<void> {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            curX = -2;
            place(engine, scene);
            place(engine, scene);
            await registerScene(scene);
            await startEngine(engine);
        }

        void main();
    `);

    assert.match(
        result.cpp,
        /double v_curX = \(-2\.0\);/,
        "the rebound module let owns one native slot, declared before the entry body",
    );
    assert.equal(
        (result.cpp.match(/double v_curX = /g) ?? []).length,
        1,
        "declared once, not once per reader",
    );
    // One shared body reads and updates the module's mutable storage.
    assert.equal(
        (result.cpp.match(/bbl::Vec3d\{v_curX, 5\.0, 0\.0\}/g) ?? []).length,
        1,
    );
    assert.doesNotMatch(result.cpp, /v_unmoved/);
    assert.equal((result.cpp.match(/v_curX \+= 2\.0;/g) ?? []).length, 1);
});

test("shares one cell for entry-module state a stored callback rebinds", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        let ticks = 0;

        function bump(): void {
            ticks += 1;
        }

        async function main(): Promise<void> {
            await createEngine({});
            window.addEventListener("pointerdown", () => {
                bump();
            });
            window.setTimeout(() => {
                ticks = 100;
            }, 500);
            bump();
        }

        void main();
    `);

    assert.match(
        result.cpp,
        /auto v_ticks = bbl::js::make_gc_shared<double>\(0\.0\);/,
    );
    // Both retained callbacks capture the same cell, so neither runs
    // against a by-value copy of the value the other last wrote.
    assert.equal(
        (
            result.cpp.match(
                /bbl::(?:on_dom_pointer|set_timeout)\([^\n]+make_closure\(bblscene::bbl_environment_\w+\{v_ticks\}/g,
            ) ?? []
        ).length,
        2,
    );
    assert.match(result.cpp, /\(\*v_ticks\) = 100\.0;/);
    assert.equal(
        (result.cpp.match(/\(\*v_ticks\) \+= 1\.0;/g) ?? []).length,
        1,
    );
});
