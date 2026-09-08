#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createSuiteSceneServer, suiteBrowserModule } from "../dist/src/capture-suite-reference.js";
import { screenshotCaptureBrowserArgs, withBrowserPage } from "../dist/src/browser-harness.js";
import { compareImages } from "../dist/src/parity.js";

const output = resolve(process.argv[2] ?? "artifacts/scene164-controls");
mkdirSync(output, { recursive: true });
const sourcePath = "corpus/babylon-lite/lab/lite/src/lite/scene164.ts";
const module = suiteBrowserModule(sourcePath);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
writeFileSync(join(output, "canonical-module.js"), module);
const flags = ["deviceLost", "deviceRecovered", "deviceReplaced", "environmentIdentityPreserved", "environmentRebuilt", "fallbackRebuilt", "shadowRebuilt", "backgroundsRebuilt", "ready"];
const report = { sourceSha256: hash(readFileSync(sourcePath)), moduleSha256: hash(module), browser: {}, native: {} };
const frames = (page, count) => page.evaluate(async n => { for (let i = 0; i < n; ++i) await new Promise(requestAnimationFrame); }, count);
await withBrowserPage(createSuiteSceneServer(module, { sourcePath }), {
    serverName: "device recovery observer", browserArgs: screenshotCaptureBrowserArgs,
    viewport: { width: 1280, height: 720 }, pageErrorPrefix: "Device recovery observer",
}, async (page, origin) => {
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${origin}/scene.html`);
    await page.waitForFunction(() => document.getElementById("renderCanvas")?.dataset.preLossReady === "true", undefined, { timeout: 120000 });
    await page.locator("#renderCanvas").screenshot({ path: join(output, "browser-before.png") });
    report.browser.before = await page.locator("#renderCanvas").evaluate(canvas => ({ ...canvas.dataset }));
    await page.locator("#renderCanvas").evaluate(canvas => { canvas.dataset.captured = "true"; });
    await page.waitForFunction(() => document.getElementById("renderCanvas")?.dataset.ready === "true", undefined, { timeout: 120000 });
    await page.locator("#renderCanvas").screenshot({ path: join(output, "browser-after.png") });
    report.browser.after = await page.locator("#renderCanvas").evaluate(canvas => ({ ...canvas.dataset }));
    for (const flag of flags) assert.equal(report.browser.after[flag], "true", flag);
    assert.ok(Number(report.browser.after.postRecoveryFrames) >= 20);
    assert.ok(Number(report.browser.after.drawCalls) > 0);
    report.browser.recoveryMad = compareImages(join(output, "browser-before.png"), join(output, "browser-after.png")).mad;
    assert.equal(report.browser.recoveryMad, 0);
    await page.addStyleTag({ content: "html,body,canvas{width:100%;height:100%}" });
    await page.setViewportSize({ width: 960, height: 540 });
    await frames(page, 4);
    report.browser.resized = await page.locator("#renderCanvas").evaluate(canvas => [canvas.width, canvas.height]);
    assert.deepEqual(report.browser.resized, [960, 540]);
    await page.mouse.move(480, 270);
    await page.mouse.wheel(0, -100);
    await frames(page, 20);
    await page.setViewportSize({ width: 1280, height: 720 });
    await frames(page, 4);
    await page.locator("#renderCanvas").screenshot({ path: join(output, "browser-input.png") });
    report.browser.inputMad = compareImages(join(output, "browser-after.png"), join(output, "browser-input.png")).mad;
    assert.ok(report.browser.inputMad > 0.1);
    await page.evaluate(() => globalThis.__scene164Dispose());
    report.browser.disposed = await page.locator("#renderCanvas").evaluate(canvas => ({ ...canvas.dataset }));
    await frames(page, 4);
    assert.equal(await page.locator("#renderCanvas").getAttribute("data-frame-count"), report.browser.disposed.frameCount);
    assert.equal(report.browser.disposed.disposed, "true");
    assert.deepEqual(errors, []);
});

const executable = resolve("native/build-scene164-release/bblite_native.exe");
for (const backend of ["sdl_gpu", "dawn"]) {
    const tape = Array(111).fill("-");
    tape[0] = "Dataset@captured=true";
    tape[4] = "WindowResize@960:540";
    tape[45] = "WindowResize@1280:720";
    tape[46] = "+UiMouseLeft@640:360";
    tape[47] = "UiMove@680:360";
    tape[48] = "-UiMouseLeft@680:360";
    tape[70] = "DeviceLoss";
    tape[110] = "GlobalCall@__scene164Dispose";
    const started = performance.now();
    const result = spawnSync(executable, [], { encoding: "utf8", timeout: 60000, windowsHide: true, cwd: resolve("native/build-scene164-release"), env: {
            ...process.env, BBLITE_GPU_BACKEND: backend, BBLITE_RUNTIME_TRACE: "1", BBLITE_MAX_FRAMES: "200", BBLITE_INPUT_REPLAY: tape.join(","),
            BBLITE_SCREENSHOT: join(output, `native-${backend}.png`), BBLITE_SCREENSHOT_FRAME: "50", BBLITE_GPU_DEBUG: "1",
        }, stdio: ["ignore", "pipe", "pipe"] });
    const log = String(result.stdout ?? "") + String(result.stderr ?? "");
    writeFileSync(join(output, `native-${backend}.log`), log);
    assert.equal(result.status, 0, log);
    for (const flag of flags) assert.ok(log.includes(`dataset ${flag}=true`), flag);
    assert.ok(log.includes("dataset disposed=true"));
    assert.match(log, /dataset drawCalls=[1-9]\d*/);
    assert.doesNotMatch(log, /dataset (?:gpuError|recoveryError|recoveryFailed)=/);
    const generations = [...log.matchAll(/recovery generation=(\d+) draws=(\d+)/g)].map(match => ({ generation: Number(match[1]), draws: Number(match[2]) }));
    assert.deepEqual(generations.map(row => row.generation), [2, 3]);
    assert.ok(generations.every(row => row.draws > 0));
    const windows = [...log.matchAll(/window (?:create|reuse) id=(\d+) native=(\w+)/g)].map(match => match.slice(1));
    assert.equal(windows.length, 3);
    assert.deepEqual(windows, Array(3).fill(windows[0]));
    const alphas = [...log.matchAll(/camera frame=\d+.* alpha=([0-9.]+)/g)].map(match => Number(match[1]));
    assert.ok(alphas.some(alpha => Math.abs(alpha - alphas[0]) > 0.01));
    assert.match(log, /size=960x540/);
    assert.ok(log.includes("size=1280x720"));
    report.native[backend] = { elapsedMs: performance.now() - started, generations, windows, initialAlpha: alphas[0], finalAlpha: alphas.at(-1), log: `native-${backend}.log` };
}
writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
