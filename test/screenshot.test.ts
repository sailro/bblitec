import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { compileSource } from "../src/compiler.js";
import { discoverDevelopmentTools } from "../src/development-tools.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerScreenshotReadback } from "../src/lowering/screenshot-readback-lowerer.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import {
    cppFunction,
    cppRecord,
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runFixtureExecutable,
    runNativeFixtureCompiler,
    writeFixtureHeaders,
} from "./native-fixture.js";

/**
 * `captureScreenshot` (src/engine/screenshot.ts, screenshot-readback.ts): the
 * program's request and its record, the lowered stride and unpack against the
 * pin's own `finish`, and both backends' copy and map of an 8-bit image.
 */

const WIDTH = 70;
const HEIGHT = 3;

/** Texels in memory order, with alpha below 255 so the unpack's opaque alpha shows. */
function texels(): Uint8Array {
    return Uint8Array.from({ length: WIDTH * HEIGHT * 4 }, (_, index) =>
        index % 4 === 3 ? (index * 11) % 200 : (index * 7 + 13) % 256,
    );
}

interface PinnedRequest {
    resolve(shot: {
        width: number;
        height: number;
        data: Uint8ClampedArray;
    }): void;
    reject(error: unknown): void;
}

/**
 * The pin's service and finish over a copy of `bytes` (tightly packed): the
 * stride its copy lands at, and the hex of the image it resolves.
 */
async function pinnedShot(
    bytes: Uint8Array,
    format: "rgba8unorm" | "bgra8unorm",
): Promise<{ bytesPerRow: number; hex: string; shared: boolean }> {
    const { createCaptureService } = await importPinnedModule<{
        createCaptureService(
            this: void,
        ): (surface: object, encoder: object) => void;
    }>("engine/screenshot-readback.js");
    // The browser's `GPUMapMode`, which the pin's finish reads.
    (globalThis as { GPUMapMode?: { READ: number } }).GPUMapMode ??= {
        READ: 1,
    };
    let bytesPerRow = 0;
    const buffer = {
        mapAsync: () => Promise.resolve(),
        getMappedRange: () => {
            const rows = new Uint8Array(bytesPerRow * HEIGHT);
            for (let row = 0; row < HEIGHT; row++)
                rows.set(
                    bytes.subarray(row * WIDTH * 4, (row + 1) * WIDTH * 4),
                    row * bytesPerRow,
                );
            return rows.buffer;
        },
        unmap() {},
        destroy() {},
    };
    const results: Promise<{ data: Uint8ClampedArray }>[] = [];
    const queue: PinnedRequest[] = [];
    for (let index = 0; index < 2; index++)
        results.push(
            new Promise((resolveShot, reject) =>
                queue.push({ resolve: resolveShot, reject }),
            ),
        );
    createCaptureService()(
        {
            _captureQueue: queue,
            _swapchainCopySrc: true,
            scRT: { _colorTexture: {}, _width: WIDTH, _height: HEIGHT },
            engine: { _device: { createBuffer: () => buffer } },
            format,
        },
        {
            copyTextureToBuffer: (
                _source: object,
                destination: { bytesPerRow: number },
            ) => {
                bytesPerRow = destination.bytesPerRow;
            },
        },
    );
    const [first, second] = await Promise.all(results);
    return {
        bytesPerRow,
        hex: Buffer.from(first!.data).toString("hex"),
        shared: first === second,
    };
}

function casesHeader(bytes: Uint8Array): string {
    return `#pragma once
constexpr std::uint32_t width = ${WIDTH};
constexpr std::uint32_t height = ${HEIGHT};
constexpr std::uint8_t texels[] = {${[...bytes].join(",")}};
`;
}

/** Writes the lowered unpack, the cases and `lifted` where a fixture includes them. */
function fixtureDirectory(name: string, lifted = ""): string {
    return writeFixtureHeaders(`test-screenshot/${name}`, {
        "cases.hpp": casesHeader(texels()),
        "lifted.hpp": `#pragma once\n${lowerScreenshotReadback(new LoweringContext()).source}\n${lifted}`,
    });
}

const PROGRAM = `import { createEngine, createSceneContext, createFreeCamera, createSphere, addToScene, registerScene, startEngine, createStandardMaterial, captureScreenshot } from "@babylonjs/lite";
const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
const scene = createSceneContext(engine);
scene.camera = createFreeCamera([0, 0, -5], [0, 0, 0]);
const sphere = createSphere(engine, { diameter: 1 });
sphere.material = createStandardMaterial();
addToScene(scene, sphere);
await registerScene(scene);
await startEngine(engine);
`;

test("captureScreenshot settles the pin's Screenshot record from a serviced frame", () => {
    const result = compileSource(
        `${PROGRAM}const shot = await captureScreenshot(engine);
        const { width, height, data } = shot;
        console.log(width, height, data.length, data[3]);`,
    );
    assert.ok(result.manifest.features.includes("engine:screenshot"));
    assert.ok(
        result.manifest.generatedSources.includes(
            "upstream/src/screenshot_readback.cpp",
        ),
    );
    assert.match(
        result.cpp,
        /co_await bbl::pal::capture_screenshot\([^;]*\)\.then\(\[\]\(const std::shared_ptr<bbl::pal::Screenshot>& settled\) \{ return bbl::pal::project_screenshot<(bblscene::\w+)>\(settled, \[\]\(const bbl::pal::Screenshot& shot\) \{ return bbl::js::make_ref<bblscene::\w+>\(bblscene::\w+\{shot\.width, shot\.height, shot\.data\}\); \}\); \}\)/,
    );
    const plain = compileSource(`${PROGRAM}console.log(1);`);
    assert.ok(!plain.manifest.features.includes("engine:screenshot"));
});

test("both backends copy and map an 8-bit presented image the pin's unpack reads", async (t: TestContext) => {
    const bytes = texels();
    const expected = await Promise.all(
        (["rgba8unorm", "bgra8unorm"] as const).map(async (format) => {
            const shot = await pinnedShot(bytes, format);
            return `${format} ${shot.bytesPerRow} ${shot.hex}`;
        }),
    );
    const tools = optionalNativeFixtureTools();
    const development = discoverDevelopmentTools();
    const fixtures = resolve("test/fixtures/screenshot");
    const lift = (file: string, ...signatures: string[]): string =>
        signatures
            .map((signature) =>
                /^(?:struct|class) /.test(signature)
                    ? cppRecord(readFileSync(file, "utf8"), signature)
                    : cppFunction(readFileSync(file, "utf8"), signature),
            )
            .join("\n");
    const ran: string[] = [];
    if (tools) {
        const directory = fixtureDirectory(
            "sdl",
            `namespace bbl::pal {
${lift("native/src/pal_sdl_gpu_shared.hpp", "struct SdlTextureDownload {", "inline SdlTextureDownload record_sdl_texture_download(", "class SdlReadbackMap {")}
} // namespace bbl::pal
`,
        );
        const executable = join(directory, "check.exe");
        runNativeFixtureCompiler(tools, [
            "/DBBLITE_SCREENSHOT_CAPTURE=1",
            `/I${resolve("native/src")}`,
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
            timeoutMs: 120000,
            env: {
                ...process.env,
                PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${process.env.PATH ?? ""}`,
            },
        });
        assert.deepEqual(output.trim().split(/\r?\n/), [...expected, "sdl ok"]);
        ran.push("sdl");
    }
    if (tools && development.dawnInstalled) {
        const dawn = development.dawnDirectory;
        const directory = fixtureDirectory(
            "dawn",
            `namespace bbl::pal {
${lift("native/src/pal_dawn_shared.hpp", "inline void wait_for(WGPUInstance instance, WGPUFuture future) {", "class DawnReadbackMap {", "struct DawnSurfaceCapture {", "inline DawnSurfaceCapture record_dawn_texture_copy(")}
} // namespace bbl::pal
`,
        );
        const executable = join(directory, "check.exe");
        runNativeFixtureCompiler(tools, [
            "/DBBLITE_SCREENSHOT_CAPTURE=1",
            `/external:I${join(dawn, "include")}`,
            `/I${resolve("native/src")}`,
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
        assert.deepEqual(output.trim().split(/\r?\n/), [
            ...expected,
            "dawn ok",
        ]);
        ran.push("dawn");
    }
    if (ran.length < 2)
        t.skip(
            `Ran ${ran.join(", ") || "no backend"}: a backend's compiler or Dawn is unavailable.`,
        );
});
