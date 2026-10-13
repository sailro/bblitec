import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { CompileError, compileSource } from "../src/compiler.js";
import { emitUpstreamGenerated } from "../src/upstream-lower.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

/** A program over the streamed Gaussian-splat API, as the Trogir demo uses it. */
const STREAM_PROGRAM = `
import {
    attachGaussianSplatStream,
    createEngine,
    createFreeCamera,
    createSceneContext,
    disposeEngine,
    disposeGaussianSplatStream,
    disposeScene,
    loadGaussianSplatStream,
    loadSplatVoxelCollision,
    moveSplatVoxelCamera,
    onBeforeRender,
    registerScene,
    startEngine,
} from "@babylonjs/lite";
import type { GaussianSplatStream } from "@babylonjs/lite";

function describe(stream: GaussianSplatStream): string {
    const stats = stream.stats;
    const first = stats.firstFrameMs === null ? "-" : \`\${Math.round(stats.firstFrameMs)}\`;
    const error = stats.error ? stats.error.message : "none";
    return \`\${stats.phase} \${first} \${stats.selectedSplats} \${stats.visibleLeaves}/\${stats.coveredLeaves} \${stats.residentGpuBytes}/\${stats.allocatedGpuBytes} \${stats.residentFiles}/\${stats.pendingRequests} \${error}\`;
}

async function main(): Promise<void> {
    const canvas = document.querySelector("canvas")!;
    const abort = new AbortController();
    const engine = await createEngine(canvas, { requiredLimits: { maxBufferSize: 268435456 } });
    const scene = createSceneContext(engine);
    const camera = createFreeCamera({ x: 0, y: 1, z: -5 }, { x: 0, y: 1, z: 0 });
    scene.camera = camera;
    const collision = await loadSplatVoxelCollision("https://splats.test/collision.json", abort.signal);
    const stream = await loadGaussianSplatStream(engine, "https://splats.test/lod-meta.json", {
        maxSplats: 1000,
        screenError: 2,
        signal: abort.signal,
    });
    stream.rotation.z = Math.PI;
    stream.screenError = stream.screenError + 1;
    stream.maxSplats = Math.max(stream.maxSplats, 2000);
    let previous: [number, number, number] = [camera.position.x, camera.position.y, -camera.position.z];
    const correct = (): void => {
        const requested: [number, number, number] = [camera.position.x, camera.position.y, -camera.position.z];
        previous = moveSplatVoxelCamera(collision, previous, requested);
    };
    scene._beforeRender.push(correct);
    attachGaussianSplatStream(scene, stream);
    onBeforeRender(scene, () => {
        canvas.dataset.stream = describe(stream);
    });
    await registerScene(scene);
    await startEngine(engine);
    await stream.firstFrameReady;
    const index = scene._beforeRender.indexOf(correct);
    if (index >= 0) scene._beforeRender.splice(index, 1);
    abort.abort();
    disposeGaussianSplatStream(scene, stream);
    disposeScene(scene);
    disposeEngine(engine);
}

void main();
`;

test("a stream program lowers its loads, attachment, stats, writes and collision onto the lowered library", (t) => {
    const directory = resolve("artifacts/test-splat-stream-application");
    mkdirSync(directory, { recursive: true });
    const entry = join(directory, "entry.ts");
    writeFileSync(entry, STREAM_PROGRAM);
    const compiled = compileSource(STREAM_PROGRAM, { fileName: entry });
    const { cpp } = compiled;
    for (const feature of [
        "loader:splat-stream",
        "platform:workers",
        "renderer:scene",
        "renderer:geometry-output",
        "camera:view-projection",
    ])
        assert.ok(compiled.manifest.features.includes(feature), feature);
    // The library's own functions, over the stored engine and the scene's state.
    assert.match(
        cpp,
        /bbl::load_gaussian_splat_stream\(bbl::StoredEngine\([^]*stream_options_\d+\)/,
    );
    assert.match(cpp, /stream_options_\d+\.max_splats = 1000/);
    assert.match(
        cpp,
        /stream_options_\d+\.signal = bbl::splat_stream_platform::abort_signal_of\(/,
    );
    assert.match(cpp, /bbl::attach_gaussian_splat_stream\([^;]*\.state, /);
    assert.match(cpp, /bbl::dispose_gaussian_splat_stream\([^;]*\.state, /);
    assert.match(cpp, /bbl::load_splat_voxel_collision\(/);
    assert.match(cpp, /bbl::move_splat_voxel_camera\(/);
    // Stats are the record's getters; `error` is null for an empty error.
    assert.match(cpp, /->get_phase\(\)/);
    assert.match(cpp, /->get_first_frame_ms\(\)/);
    assert.match(cpp, /bbl::splat_stream::stats_error\([^;]*->get_error\(\)\)/);
    // Writes: plain fields, and the Euler proxy's setter.
    assert.match(cpp, /\)->screen_error = /);
    assert.match(cpp, /\)->max_splats = /);
    assert.match(cpp, /bbl::splat_stream::node_euler_write\(\*[^,]+, 2, /);
    assert.match(cpp, /->first_frame_ready/);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    // The lowered library and the program compile together.
    emitUpstreamGenerated(directory, compiled.manifest.features);
    const source = join(directory, "main.cpp");
    writeFileSync(source, cpp);
    runNativeFixtureCompiler(tools, [
        "/c",
        "/DBBLITE_WORKERS=1",
        "/DBBLITE_OFFSCREEN_SURFACES=1",
        "/DBBLITE_ENGINE_WEBGPU=1",
        "/I",
        join(directory, "upstream/include"),
        `/Fo:${join(directory, "main.obj")}`,
        source,
    ]);
});

test("stream members without a native form refuse", () => {
    const refuses = (from: string, to: string, message: RegExp): void => {
        assert.ok(STREAM_PROGRAM.includes(from), from);
        assert.throws(
            () => compileSource(STREAM_PROGRAM.replace(from, to)),
            (error: unknown) =>
                error instanceof CompileError && message.test(error.message),
        );
    };
    refuses(
        "stream.screenError = stream.screenError + 1;",
        "stream.screenError += 1;",
        /A stream member takes a simple assignment natively/,
    );
    refuses(
        "stream.maxSplats = Math.max(stream.maxSplats, 2000);",
        'stream.name = "renamed";',
        /GaussianSplatStream\.name is not a writable stream member/,
    );
    refuses(
        "await stream.firstFrameReady;",
        "await stream.firstFrameReady;\n    canvas.dataset.children = String(stream.children.length);",
        /GaussianSplatStream\.children is not a public stream member read natively/,
    );
});

test("a generic awaited resource, rejection-only and fulfillment-only thens and an inferred record let run as JavaScript does", () => {
    const result = compileSource(`
        async function acquire<T>(resource: Promise<T>, isDisposed: () => boolean, late: (value: T) => void): Promise<T | null> {
            const value = await resource;
            if (isDisposed()) {
                late(value);
                return null;
            }
            return value;
        }
        function observe(readiness: Promise<unknown>): Promise<unknown> {
            void readiness.then(undefined, () => {});
            return readiness;
        }
        function poseOf(x: number): { x: string; y: string } {
            if (x < 0) throw new RangeError("negative");
            return { x: x.toFixed(1), y: String(x * 2) };
        }
        function describe(x: number): string {
            let pose;
            try {
                pose = poseOf(x);
            } catch (reason) {
                if (!(reason instanceof RangeError)) throw reason;
                return "unavailable " + reason.message;
            }
            return pose.x + "," + pose.y;
        }
        async function run(): Promise<void> {
            let late = 0;
            const kept = await acquire(Promise.resolve(5), () => false, () => { late++; });
            const dropped = await acquire(Promise.resolve(7), () => true, (value) => { late += value; });
            let observed = "unobserved";
            const failing = new Promise<number>((_, reject) => reject(new Error("boom")));
            void failing.then(undefined, (reason: unknown) => { observed = (reason as Error).message; });
            const passed = await Promise.resolve(3).then(undefined, () => -1);
            const viaNull = await Promise.resolve(4).then(null, () => -1);
            const viaVoid = await Promise.resolve(6).then(void 0, () => -1);
            const fulfilledOnly = await Promise.resolve(7).then((value) => value + 1, undefined);
            const readiness = observe(Promise.resolve());
            await readiness;
            await Promise.resolve();
            const text = String(kept) + " " + String(dropped) + " " + String(late) + " " + observed + " " + String(passed) + " " + describe(1.25) + " " + describe(-1) + " " + String(viaNull) + " " + String(viaVoid) + " " + String(fulfilledOnly);
            if (text !== "5 null 7 boom 3 1.3,2.5 unavailable negative 4 6 8") throw new Error(text);
            globalThis.close();
        }
        run();
    `);
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools, "Native fixture compiler required");
    // The compared line is what Node computes for the same program.
    runGeneratedProgram(
        tools,
        "splat-stream-application/language",
        result.cpp,
        {
            flags: ["/DBBLITE_WORKERS=1"],
            expectedOutput: "",
            timeoutMs: 15000,
        },
    );
});
