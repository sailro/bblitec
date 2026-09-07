#!/usr/bin/env node
// Full demo clock/input check. Controlled deltas exercise 60/240-fps timing;
// live runs separately compare simulated time with actual elapsed wall time.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, createWriteStream } from "node:fs";
import { resolve } from "node:path";
import { createSuiteSceneServer, suiteBrowserModule } from "../dist/src/capture-suite-reference.js";
import { withBrowserPage, screenshotCaptureBrowserArgs } from "../dist/src/browser-harness.js";
import { getScene } from "../dist/src/scene-registry.js";
import { resolveNativeExecutable, verifyBuildIdentity, verifyDeployedPayload } from "../dist/src/parity-scene.js";

const output = resolve("artifacts/break-meshes-timing");
mkdirSync(output, { recursive: true });
const scene = getScene("break-meshes");
const sourcePath = scene.source;
const executable = resolveNativeExecutable(process.argv[2], scene.buildDirectory);
verifyDeployedPayload(executable, scene.output);
const results = [];
const module = suiteBrowserModule(sourcePath, source => {
    const marker = "await registerSceneWithShadowSupport(scene);";
    assert.equal(source.split(marker).length, 2);
    return source.replace(marker, `
globalThis.__physicsTiming = { world, scene, samples: [] };
world._afterStep ??= [];
world._afterStep.push(seconds => globalThis.__physicsTiming.samples.push({ seconds, now: performance.now() }));
${marker}`);
});

function summarize(samples) {
    assert(samples.length > 30, "Insufficient physics steps");
    const seconds = samples.slice(1).reduce((sum, sample) => sum + sample.seconds, 0);
    const wallSeconds = (samples.at(-1).now - samples[0].now) / 1000;
    return { steps: samples.length - 1, seconds, wallSeconds, simulatedPerWallSecond: seconds / wallSeconds };
}

function controlledTime(samples) {
    return { steps: samples.length, seconds: samples.reduce((sum, sample) => sum + sample.seconds, 0) };
}

for (const fps of [60, 240, null]) {
    const label = fps ?? "live";
    const server = createSuiteSceneServer(module, { sourcePath });
    const browser = await withBrowserPage(server, {
        headless: false, serverName: "Break Meshes timing",
        viewport: { width: 1280, height: 720 }, browserArgs: screenshotCaptureBrowserArgs,
        pageErrorPrefix: "BBL page error", consoleErrorPrefix: "BBL console error",
    }, async (page, origin) => {
        if (fps !== null) await page.addInitScript(rate => {
            const raf = globalThis.requestAnimationFrame.bind(globalThis);
            let previous, timestamp = 1;
            globalThis.requestAnimationFrame = callback => raf(now => {
                if (now !== previous) { timestamp += 1000 / rate; previous = now; }
                callback(timestamp);
            });
        }, fps);
        await page.goto(origin + "/scene.html");
        await page.waitForFunction(() => document.getElementById("renderCanvas")?.dataset.ready === "true", undefined, { timeout: 60000 });
        await page.mouse.click(640, 370);
        await page.waitForFunction(() => globalThis.__physicsTiming.world._bodies.some(body => body.motionType === 2));
        await page.evaluate(() => { globalThis.__physicsTiming.samples = []; });
        if (fps === null) {
            await page.waitForFunction(() => {
                const samples = globalThis.__physicsTiming.samples;
                return samples.length > 30 && samples.at(-1).now - samples[0].now >= 2500;
            });
        } else await page.waitForFunction(count => globalThis.__physicsTiming.samples.length >= count, fps * 2 + 1);
        const observed = await page.evaluate(count => {
            const { world, scene, samples } = globalThis.__physicsTiming;
            return { sceneFixed: scene.fixedDeltaMs ?? 0, worldFixed: world._fixedDeltaMs,
                dynamicBodies: world._bodies.filter(body => body.motionType === 2).length,
                samples: count === null ? samples : samples.slice(0, count) };
        }, fps === null ? null : fps * 2 + 1);
        assert.equal(observed.sceneFixed, 0);
        assert.equal(observed.worldFixed, 0);
        await page.screenshot({ path: resolve(output, `browser-${label}.png`) });
        return { implementation: "browser", fps,
            ...(fps === null ? summarize(observed.samples) : controlledTime(observed.samples.slice(1))),
            dynamicBodies: observed.dynamicBodies };
    });
    results.push(browser);
    if (fps === null) assert(Math.abs(browser.simulatedPerWallSecond - 1) < 0.05, JSON.stringify(browser));
    else assert(Math.abs(browser.seconds - 2) < 1e-5, JSON.stringify(browser));

    for (const backend of ["sdl_gpu", "dawn"]) {
        const maxFrames = fps === null ? 900 : fps * 2 + 1;
        const stem = resolve(output, `${backend}-${label}`);
        const stampPath = stem + ".stamp";
        writeFileSync(stampPath, "");
        const samples = [], firstPositions = new Map(), lastPositions = new Map();
        const log = createWriteStream(stem + ".log");
        let pending = "";
        const child = spawn(executable, [], { cwd: resolve(scene.output),
            env: { ...process.env, BBLITE_GPU_BACKEND: backend, BBLITE_TEST_PASS: "1",
                BBLITE_MAX_FRAMES: String(maxFrames), BBLITE_FRAME_DELTA_MS: fps === null ? "" : String(1000 / fps),
                BBLITE_PHYSICS_TRACE: "1", BBLITE_RUNTIME_TRACE: "0", BBLITE_CPU_PROFILE: "0",
                BBLITE_BUILD_STAMP_OUT: stampPath,
                BBLITE_SCREENSHOT: stem + ".png", BBLITE_SCREENSHOT_FRAME: String(maxFrames - 1),
                BBLITE_CAPTURE_ENGINE_FRAME: "", BBLITE_ANIMATION_SEEK_SECONDS: "",
                BBLITE_INPUT_REPLAY: [...Array(10).fill("UiIdle@0:0"), "+UiMouseLeft@640:370", "-UiMouseLeft@640:370"].join(",") },
            stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        child.stdout.on("data", chunk => log.write(chunk));
        child.stderr.on("data", chunk => {
            log.write(chunk);
            pending += chunk.toString();
            const lines = pending.split(/\r?\n/);
            pending = lines.pop();
            for (const line of lines) {
                const match = line.match(/^\[physics\] step (\d+) dt ([\d.]+) body (\d+) pos (.*)$/);
                if (!match) continue;
                const [, step, dt, body, position] = match;
                if (+body === 0) samples.push({ seconds: +dt, now: performance.now() });
                if (+step === 0) firstPositions.set(body, position);
                lastPositions.set(body, position);
            }
        });
        const timeout = setTimeout(() => child.kill(), 60000);
        try {
            await new Promise((done, reject) => {
                child.on("error", reject);
                child.on("close", code => code === 0 ? done() : reject(new Error(`${backend}-${label} exited ${code}; see ${stem}.log`)));
            });
        } finally { clearTimeout(timeout); await new Promise(done => log.end(done)); }
        verifyBuildIdentity(executable, scene.output, stampPath);
        assert(firstPositions.size > 100, "Missing demo physics bodies");
        const movedBodies = [...lastPositions].filter(([body, position]) => firstPositions.get(body) !== position).length;
        assert(movedBodies >= 14, `Shatter input did not move the pieces: ${movedBodies}`);
        const measured = fps === null ? samples.slice(120, -20) : samples;
        const native = { implementation: backend, fps,
            ...(fps === null ? summarize(measured) : controlledTime(measured)), movedBodies };
        if (fps === null) {
            assert(native.wallSeconds > 1, "Live measurement was too short");
            assert(Math.abs(native.simulatedPerWallSecond - browser.simulatedPerWallSecond) < 0.05, JSON.stringify(native));
        } else {
            assert.equal(samples.length, fps * 2);
            assert(Math.abs(native.seconds - browser.seconds) < 1e-5, JSON.stringify({ native, browser }));
        }
        results.push(native);
    }
    console.log(`Passed Break Meshes ${label}: browser, SDL_GPU, Dawn`);
}
writeFileSync(resolve(output, "results.json"), JSON.stringify(results, null, 2) + "\n");
console.table(results);
