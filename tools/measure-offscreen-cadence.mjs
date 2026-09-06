#!/usr/bin/env node
// Observe the unchanged demo on the same display. The original advances its
// camera by 0.0035 radians per render; frame cadence therefore determines speed.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync } from "node:fs";
import { resolve } from "node:path";
import { createSuiteSceneServer, suiteBrowserModule } from "../dist/src/capture-suite-reference.js";
import { withBrowserPage, screenshotCaptureBrowserArgs } from "../dist/src/browser-harness.js";

const sourcePath = "corpus/babylon-lite/lab/lite/src/demos/offscreen.ts";
const output = resolve("artifacts/offscreen-integration");
mkdirSync(output, { recursive: true });
const server = createSuiteSceneServer(suiteBrowserModule(sourcePath), {
    sourcePath, hostPage: "corpus/babylon-lite/lab/lite/demo-offscreen.html",
});
function observeFrames() {
    const raf = globalThis.requestAnimationFrame.bind(globalThis);
    globalThis.__offscreenCadenceSamples = [];
    globalThis.requestAnimationFrame = callback => raf(timestamp => {
        globalThis.__offscreenCadenceSamples.push(timestamp);
        callback(timestamp);
    });
}
function readRate() {
    const samples = globalThis.__offscreenCadenceSamples;
    if (samples.length < 100) throw new Error("Insufficient original frame samples");
    const seconds = (samples.at(-1) - samples[0]) / 1000;
    const framesPerSecond = (samples.length - 1) / seconds;
    return { frames: samples.length, seconds, framesPerSecond, degreesPerSecond: framesPerSecond * 0.0035 * 180 / Math.PI };
}
const browser = await withBrowserPage(server, { headless: false, serverName: "Offscreen cadence measurement",
    viewport: { width: 1280, height: 720 }, browserArgs: screenshotCaptureBrowserArgs,
    pageErrorPrefix: "Original page error", consoleErrorPrefix: "Original console error" }, async (page, origin) => {
    await page.goto(origin + "/scene.html");
    await page.waitForFunction(() => document.getElementById("renderCanvas")?.dataset.ready === "true", undefined, { timeout: 60000 });
    const worker = page.workers()[0];
    if (!worker) throw new Error("Original worker did not start");
    await new Promise(done => setTimeout(done, 1500));
    await page.evaluate(observeFrames);
    await worker.evaluate(observeFrames);
    await new Promise(done => setTimeout(done, 3500));
    return { main: await page.evaluate(readRate), worker: await worker.evaluate(readRate) };
});
const native = {};
for (const backend of ["sdl_gpu", "dawn"]) {
    const logPath = resolve(output, `cadence-${backend}.log`);
    const fd = openSync(logPath, "w");
    try {
        execFileSync(resolve(process.argv[2] ?? "native/build-offscreen-release/bblite_native.exe"), [], {
            cwd: resolve("generated/offscreen"), timeout: 20000,
            env: { ...process.env, BBLITE_GPU_BACKEND: backend, BBLITE_TEST_PASS: "1", BBLITE_MAX_FRAMES: "900",
                BBLITE_WINDOW_TRACE: "1", BBLITE_RUNTIME_TRACE: "0", BBLITE_RUNTIME_TRACE_INTERVAL: "60",
                BBLITE_SCREENSHOT: "", BBLITE_CAPTURE_ENGINE_FRAME: "", BBLITE_INPUT_REPLAY: "", BBLITE_FRAME_DELTA_MS: "" },
            stdio: ["ignore", fd, fd] });
    } finally { closeSync(fd); }
    const log = readFileSync(logPath, "utf8");
    if (/error|exception/i.test(log)) throw new Error(log);
    const samples = [...log.matchAll(/window frame=(\d+) now-ms=([\d.]+)((?: canvas=\d+:\d+@\d+x\d+)+)/g)]
        .map(match => ({ frame: Number(match[1]), time: Number(match[2]),
            canvases: new Map([...match[3].matchAll(/canvas=(\d+):(\d+)@/g)].map(canvas => [Number(canvas[1]), Number(canvas[2])])) }));
    const first = samples.find(sample => sample.frame >= 120), last = samples.at(-1);
    if (!first || !last || first.canvases.size !== 2 || last.canvases.size !== 2) throw new Error("Missing native canvas samples");
    const seconds = (last.time - first.time) / 1000;
    native[backend] = [...first.canvases].sort(([left], [right]) => left - right).map(([id, start]) => {
        const framesPerSecond = (last.canvases.get(id) - start) / seconds;
        return { canvas: id, seconds, framesPerSecond, degreesPerSecond: framesPerSecond * 0.0035 * 180 / Math.PI };
    });
}
const result = { browser, native };
writeFileSync(resolve(output, "cadence.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
