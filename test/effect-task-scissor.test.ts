import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { compileSource } from "../src/compiler.js";
import { discoverDevelopmentTools } from "../src/development-tools.js";
import { LoweringContext } from "../src/lowering/context.js";
import {
    EffectLowerer,
    lowerEffectTaskScissor,
} from "../src/lowering/effect-lowerer.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import {
    cppFunction,
    cppRecord,
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runFixtureExecutable,
    runGeneratedProgram,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

/**
 * `EffectRenderTask.scissor` (src/effect/effect-renderer.ts): the pin's
 * execute against the native rectangle at pixel edges, the program's write
 * of a run-time viewport or null, and both backends' pass over a target.
 */

interface Scissor {
    x: number;
    y: number;
    width: number;
    height: number;
}

interface PinTask {
    scissor?: Scissor | null;
    record(): void;
    execute(): number;
}

const TARGET = { width: 10, height: 7 };

/** Run-time rectangles at pixel edges, past the target, empty and not a number. */
const ROUNDING_CASES: readonly (Scissor | null)[] = [
    null,
    { x: 0, y: 0, width: 1, height: 1 },
    { x: 0.25, y: 0.5, width: 0.5, height: 0.25 },
    { x: 0.3, y: 0.2, width: 0.4, height: 0.6 },
    { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
    { x: 1 / 3, y: 1 / 7, width: 1 / 3, height: 2 / 7 },
    { x: -0.5, y: -0.25, width: 2, height: 1.5 },
    { x: 0.75, y: -0.5, width: 0.5, height: 1 },
    { x: 1.5, y: 0, width: 0.5, height: 1 },
    { x: 0, y: 1.2, width: 1, height: 0.5 },
    { x: 0.2, y: 0.2, width: 0, height: 0.5 },
    { x: 0.2, y: 0.2, width: 0.5, height: -0.1 },
    { x: 0.5, y: 0.5, width: 1e-9, height: 1e-9 },
    { x: 0.5, y: 0.5, width: 1e-17, height: 0.5 },
    { x: 0, y: 0, width: Infinity, height: 1 },
    { x: -Infinity, y: 0, width: 1, height: 1 },
    { x: -0, y: -0, width: 1, height: 1 },
    { x: NaN, y: 0, width: 1, height: 1 },
    { x: 0, y: 0, width: NaN, height: 1 },
];

/** What a pass under each one rasterizes on both backends. */
const GPU_CASES: readonly (Scissor | null)[] = [
    null,
    { x: 0, y: 0, width: 0.5, height: 0.5 },
    { x: 0.25, y: 0.5, width: 0.5, height: 0.25 },
    { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
    { x: 0.75, y: -0.5, width: 0.5, height: 1 },
    { x: 0.5, y: 0.5, width: 1e-9, height: 1e-9 },
    { x: 0.2, y: 0.2, width: 0, height: 0.5 },
];

/** WebIDL `[EnforceRange] unsigned long`, the type of `setScissorRect`'s arguments. */
function gpuIntegerCoordinate(value: number): boolean {
    return (
        Number.isFinite(value) &&
        Math.trunc(value) >= 0 &&
        Math.trunc(value) <= 0xffffffff
    );
}

/**
 * The pin's own execute over each scissor: `whole` draws the target, `none`
 * ends the pass undrawn, `x y w h` draws under that `setScissorRect`, and
 * `throws` hands it an argument WebIDL rejects.
 */
async function pinnedScissors(
    scissors: readonly (Scissor | null)[],
): Promise<string[]> {
    const { createEffectWrapper, createEffectRenderTask } =
        await importPinnedModule<{
            createEffectWrapper(
                this: void,
                engine: object,
                options: object,
            ): object;
            createEffectRenderTask(
                this: void,
                config: object,
                engine: object,
            ): PinTask;
        }>("effect/effect-renderer.js");
    let calls: string[] = [];
    const pass = {
        setScissorRect: (...rect: number[]) =>
            calls.push(
                rect.every(gpuIntegerCoordinate) ? rect.join(" ") : "throws",
            ),
        setPipeline() {},
        setBindGroup() {},
        draw: () => calls.push("draw"),
        end() {},
    };
    const engine = {
        _device: {
            createShaderModule: () => ({}),
            createBindGroupLayout: () => ({}),
            createPipelineLayout: () => ({}),
            createRenderPipeline: () => ({}),
        },
        _currentEncoder: { beginRenderPass: () => pass },
    };
    const task = createEffectRenderTask(
        {
            name: "scissor",
            effect: createEffectWrapper(engine, {
                name: "scissor",
                fragmentWGSL: "",
                bindings: [],
            }),
            target: {
                _descriptor: { format: "rgba8unorm", samples: 1 },
                _eager: true,
                _width: TARGET.width,
                _height: TARGET.height,
            },
        },
        engine,
    );
    task.record();
    return scissors.map((scissor) => {
        calls = [];
        task.scissor = scissor;
        const drawn = task.execute();
        if (drawn === 0) {
            assert.deepEqual(calls, []);
            return "none";
        }
        const [rect, draw] = calls.length === 1 ? ["whole", ...calls] : calls;
        assert.equal(draw, "draw");
        return rect!;
    });
}

/** A JavaScript number as the C++ double it is: its shortest spelling round-trips. */
function cppNumber(value: number): string {
    if (Number.isNaN(value)) return "std::numeric_limits<double>::quiet_NaN()";
    if (!Number.isFinite(value))
        return `${value < 0 ? "-" : ""}std::numeric_limits<double>::infinity()`;
    return Object.is(value, -0) ? "-0.0" : String(value);
}

/** The fixture's case table (test/fixtures/effect-task-scissor/check.hpp). */
function casesHeader(scissors: readonly (Scissor | null)[]): string {
    const rows = scissors.map((scissor) =>
        scissor
            ? `    {true, ${[scissor.x, scissor.y, scissor.width, scissor.height].map(cppNumber).join(", ")}},`
            : "    {},",
    );
    return `#pragma once
#include <limits>
constexpr std::uint32_t target_width = ${TARGET.width};
constexpr std::uint32_t target_height = ${TARGET.height};
const effect_task_scissor::Case cases[] = {
${rows.join("\n")}
};
`;
}

/** The lowered scissor and the shared draw rule both backends' task passes call. */
function sharedDraw(): string {
    const targets = readFileSync("native/src/pal_gpu_targets.hpp", "utf8");
    return `namespace bbl {
${lowerEffectTaskScissor(new LoweringContext())}
} // namespace bbl
namespace bbl::pal {
${cppRecord(targets, "struct EffectTaskDraw {")}
${cppFunction(targets, "[[nodiscard]] inline EffectTaskDraw effect_task_draw(")}
} // namespace bbl::pal
`;
}

/** A scene drawing one effect render task into a target of its own. */
const PROGRAM = `import {createEngine,createSceneContext,createFreeCamera,createSphere,addToScene,registerScene,addTask,
createRenderTargetTexture,createEffectWrapper,createEffectRenderTask,createStandardMaterial,startEngine,
onBeforeRender} from "@babylonjs/lite";
import type { NormalizedViewport } from "@babylonjs/lite";
const engine=await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
const scene=createSceneContext(engine);
scene.camera=createFreeCamera([0,0,-5],[0,0,0]);
const sphere=createSphere(engine,{diameter:1});
sphere.material=createStandardMaterial();
addToScene(scene,sphere);
const target=createRenderTargetTexture(engine,{lbl:"outline",format:"rgba8unorm",samples:1,size:{width:4,height:4}});
const effect=createEffectWrapper(engine,{name:"outline",fragmentWGSL:"@fragment fn effectFragment() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }",bindings:[]});
const task=createEffectRenderTask({name:"outline",effect,target:target.rt,clear:false},engine,scene);
addTask(scene,task);
`;

const STARTED = `await registerScene(scene);
await startEngine(engine);
`;

test("EffectRenderTask.scissor stores a run-time viewport or null and refuses a copy the program can tell apart", () => {
    // The application's write: a rectangle a helper computes every frame,
    // or null for the whole target.
    const written = compileSource(
        `${PROGRAM}function region(t: number): NormalizedViewport | null {
            if (t > 3) return null;
            if (t > 2) return { x: 0, y: 0, width: 0, height: 0 };
            return { x: t * 0.1, y: 0.25, width: 0.5 - t * 0.1, height: 0.5 };
        }
        let frame = 0;
        onBeforeRender(scene, () => {
            frame++;
            task.scissor = frame % 2 ? region(frame % 5) : null;
        });
        ${STARTED}`,
    );
    assert.ok(written.manifest.features.includes("effect:task-scissor"));
    assert.match(
        written.cpp,
        /const auto& (v_\w+) = \(bbl::js::number_truthy\(std::fmod\(v_frame, 2\.0\)\) \? bblscene::region\(std::fmod\(v_frame, 5\.0\)\) : bblscene::NormalizedViewport\{\}\);\n\s*bbl::handle_at\(v_engine\.frame_tasks, v_task\)\.effect_scissor = static_cast<bool>\(\1\) \? std::optional<bbl::NormalizedViewport>\{bbl::NormalizedViewport\{\1->x, \1->y, \1->width, \1->height\}\} : std::nullopt;/,
    );
    const cleared = compileSource(`${PROGRAM}task.scissor = null;\n${STARTED}`);
    assert.ok(cleared.manifest.features.includes("effect:task-scissor"));
    assert.match(cleared.cpp, /\.effect_scissor = static_cast<bool>\(/);
    // The pin reads the object it keeps at every execute; a write to one of
    // its lanes would reach the pin and miss the native copy.
    assert.throws(
        () =>
            compileSource(
                `${PROGRAM}const region: NormalizedViewport = { x: 0, y: 0, width: 1, height: 1 };
                task.scissor = region;
                onBeforeRender(scene, () => { region.x += 0.01; });
                ${STARTED}`,
            ),
        /EffectRenderTask\.scissor keeps the object it is given, which the native task copies, and the program writes 'x' of such records\./,
    );
    // Only a program that writes it reaches the lowered scissor.
    const context = new LoweringContext();
    assert.doesNotMatch(
        new EffectLowerer(context).lowerFactory().source,
        /effect_task_scissor/,
    );
    assert.match(
        new EffectLowerer(context).lowerFactory({ taskScissor: true }).source,
        /std::optional<PixelViewport> effect_task_scissor\(/,
    );
});

test("an effect task's native scissor rounds as the pin's execute does at pixel edges", async (t) => {
    const expected = await pinnedScissors(ROUNDING_CASES);
    // The edges the cases are chosen for: a fraction landing past a pixel
    // edge rounds outward, a positive width can cover no pixel, and a
    // rectangle past the target clamps to it.
    assert.equal(expected[0], "whole");
    assert.equal(expected[4], "1 4 3 3");
    assert.equal(expected[6], "0 0 10 7");
    assert.equal(expected[13], "none");
    assert.equal(expected.at(-1), "throws");
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler unavailable");
        return;
    }
    const output = runGeneratedProgram(
        tools,
        "test-effect-task-scissor/rounding",
        `#include <bblite/runtime.hpp>
#include <cstdio>
#include <stdexcept>
#include "check.hpp"
${sharedDraw()}
#include "cases.hpp"
int main() {
    for (const effect_task_scissor::Case& scissor : cases) {
        try {
            const bbl::pal::EffectTaskDraw draw = bbl::pal::effect_task_draw(
                effect_task_scissor::task_of(scissor), target_width, target_height);
            if (!draw.draws)
                std::printf("none\\n");
            else if (!draw.scissor)
                std::printf("whole\\n");
            else
                std::printf("%d %d %d %d\\n", draw.scissor->x, draw.scissor->y,
                            draw.scissor->width, draw.scissor->height);
        } catch (const std::runtime_error&) {
            std::printf("throws\\n");
        }
    }
}
`,
        {
            flags: [
                "/DBBLITE_EFFECT_TASK_SCISSOR=1",
                `/I${resolve("test/fixtures/effect-task-scissor")}`,
                `/I${writeCases("rounding", ROUNDING_CASES)}`,
            ],
            timeoutMs: 10000,
        },
    );
    assert.deepEqual(output.trim().split(/\r?\n/), expected);
});

/** Writes a case table where a fixture includes it; returns its folder. */
function writeCases(
    name: string,
    scissors: readonly (Scissor | null)[],
    lifted?: string,
): string {
    const directory = resolve("artifacts/test-effect-task-scissor", name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "cases.hpp"), casesHeader(scissors));
    if (lifted !== undefined)
        writeFileSync(
            join(directory, "lifted.hpp"),
            `#pragma once\n${sharedDraw()}${lifted}`,
        );
    return directory;
}

/** Each case's pixels, as the fixture prints them (`print_case`), from the pin's rectangles. */
function expectedPixels(rectangles: readonly string[]): string[] {
    return rectangles.map((rectangle, index) => {
        const [x, y, width, height] =
            rectangle === "whole"
                ? [0, 0, TARGET.width, TARGET.height]
                : rectangle === "none"
                  ? [0, 0, 0, 0]
                  : rectangle.split(" ").map(Number);
        const rows = Array.from({ length: TARGET.height }, (_, row) =>
            Array.from({ length: TARGET.width }, (_, column) =>
                column >= x! &&
                column < x! + width! &&
                row >= y! &&
                row < y! + height!
                    ? "d"
                    : "c",
            ).join(""),
        );
        return `case ${index} ${rows.join("/")}`;
    });
}

/** The fixture's printed cases, ending with its `<backend> ok` line. */
function printedCases(output: string, backend: string): string[] {
    const lines = output.trim().split(/\r?\n/);
    assert.equal(lines.at(-1), `${backend} ok`);
    return lines.slice(0, -1);
}

/** A backend's own scissor setter and effect task pass, lifted from their files. */
function liftedBackend(
    setter: readonly [file: string, signature: string],
    pass: readonly [file: string, signature: string],
): string {
    const lift = ([file, signature]: readonly [string, string]): string =>
        cppFunction(readFileSync(file, "utf8"), signature);
    return `namespace bbl::pal {
${lift(setter)}
${lift(pass)}
} // namespace bbl::pal
`;
}

test("both backends rasterize only an effect task's scissor and keep its clear whole", async (t: TestContext) => {
    const expected = expectedPixels(await pinnedScissors(GPU_CASES));
    // The bottom-left quarter is the bottom rows: the pin's rectangle is
    // normalized from the bottom, the backends' from the top.
    assert.equal(
        expected[1],
        "case 1 cccccccccc/cccccccccc/cccccccccc/dddddccccc/dddddccccc/dddddccccc/dddddccccc",
    );
    assert.match(expected.at(-1)!, /^case \d+ [c/]+$/);
    const tools = optionalNativeFixtureTools();
    const development = discoverDevelopmentTools();
    const fixtures = resolve("test/fixtures/effect-task-scissor");
    const ran: string[] = [];
    if (tools && development.dxc) {
        const directory = writeCases(
            "sdl",
            GPU_CASES,
            liftedBackend(
                [
                    "native/src/pal_sdl_gpu_shared.hpp",
                    "inline void set_pass_scissor(SDL_GPURenderPass* pass,",
                ],
                [
                    "native/src/pal_sdl_gpu_effect.hpp",
                    "inline void record_effect_task_pass(",
                ],
            ),
        );
        const stages = {
            vertex: [
                "vs_6_0",
                "float4 main(uint id : SV_VertexID) : SV_Position { float2 corner = float2((id << 1) & 2, id & 2); return float4(corner * 2 - 1, 0, 1); }",
            ],
            fragment: [
                "ps_6_0",
                "float4 main() : SV_Target0 { return float4(1, 0, 0, 1); }",
            ],
        } as const;
        for (const [stage, [profile, source]] of Object.entries(stages)) {
            writeFileSync(join(directory, `${stage}.hlsl`), source);
            execFileSync(
                development.dxc,
                [
                    "-T",
                    profile,
                    "-E",
                    "main",
                    "-WX",
                    "-Fo",
                    join(directory, `${stage}.dxil`),
                    join(directory, `${stage}.hlsl`),
                ],
                { stdio: "pipe" },
            );
        }
        const executable = join(directory, "check.exe");
        runNativeFixtureCompiler(tools, [
            "/DBBLITE_EFFECT_TASK_SCISSOR=1",
            `/I${fixtures}`,
            `/I${directory}`,
            `/Fo:${directory}/`,
            `/Fe:${executable}`,
            join(fixtures, "sdl.cpp"),
            "/link",
            `/LIBPATH:${join(nativeFixtureVcpkgRoot, "lib")}`,
            "SDL3.lib",
        ]);
        const output = runFixtureExecutable(executable, {
            args: [
                join(directory, "vertex.dxil"),
                join(directory, "fragment.dxil"),
            ],
            timeoutMs: 120000,
            env: {
                ...process.env,
                PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${process.env.PATH ?? ""}`,
            },
        });
        assert.deepEqual(printedCases(output, "sdl"), expected);
        ran.push("sdl");
    }
    if (tools && development.dawnInstalled) {
        const dawn = development.dawnDirectory;
        const directory = writeCases(
            "dawn",
            GPU_CASES,
            liftedBackend(
                [
                    "native/src/pal_dawn_resources.hpp",
                    "inline void set_pass_scissor(WGPURenderPassEncoder pass,",
                ],
                [
                    "native/src/pal_dawn_effect.hpp",
                    "inline void record_dawn_effect_task_pass(",
                ],
            ),
        );
        const executable = join(directory, "check.exe");
        runNativeFixtureCompiler(tools, [
            "/DBBLITE_EFFECT_TASK_SCISSOR=1",
            `/external:I${join(dawn, "include")}`,
            `/I${fixtures}`,
            `/I${directory}`,
            `/Fo:${directory}/`,
            `/Fe:${executable}`,
            join(fixtures, "dawn.cpp"),
            "/link",
            join(dawn, "lib/webgpu_dawn.lib"),
        ]);
        const output = runFixtureExecutable(executable, {
            timeoutMs: 120000,
            env: {
                ...process.env,
                PATH: `${join(dawn, "bin")};${process.env.PATH ?? ""}`,
            },
        });
        assert.deepEqual(printedCases(output, "dawn"), expected);
        ran.push("dawn");
    }
    if (ran.length < 2)
        t.skip(
            `Ran ${ran.join(", ") || "no backend"}: a backend's compiler, DXC or Dawn is unavailable.`,
        );
});
