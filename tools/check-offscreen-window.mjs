#!/usr/bin/env node
// Targeted original-application checks. SDL's test-owned event tape never
// moves the desktop pointer or sends OS keyboard input.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";

const executable = resolve(process.argv[2] ?? "native/build-offscreen-release/bblite_native.exe");
const output = resolve("artifacts/offscreen-integration");
mkdirSync(output, { recursive: true });
const idle = count => Array(count).fill("UiIdle@0:0");
const samples = log => [...log.matchAll(/window frame=(\d+) now-ms=([\d.]+)((?: canvas=\d+:\d+@\d+x\d+)+)/g)].map(match => ({
    frame: Number(match[1]), time: Number(match[2]),
    canvases: [...match[3].matchAll(/canvas=(\d+):(\d+)@(\d+)x(\d+)/g)].map(canvas => ({
        id: Number(canvas[1]), sequence: Number(canvas[2]), width: Number(canvas[3]), height: Number(canvas[4]),
    })).sort((left, right) => left.id - right.id),
}));
const results = [];
for (const backend of ["sdl_gpu", "dawn"]) {
    for (const phase of ["blocked", "resized"]) {
        const stem = resolve(output, `window-${backend}-${phase}`);
        const replay = [...idle(40), "+UiMouseLeft@640:35", ...idle(20), "-UiMouseLeft@640:35"];
        if (phase === "resized") replay.push(...idle(160), "+UiMouseLeft@640:35", ...idle(20), "-UiMouseLeft@640:35",
            ...idle(100), "WindowResize@700:560");
        rmSync(stem + ".png", { force: true });
        const fd = openSync(stem + ".log", "w");
        try {
            execFileSync(executable, [], { cwd: resolve("generated/offscreen"), timeout: 20000,
                env: { ...process.env, BBLITE_GPU_BACKEND: backend, BBLITE_TEST_PASS: "1",
                    BBLITE_MAX_FRAMES: phase === "blocked" ? "200" : "640",
                    BBLITE_SCREENSHOT_FRAME: phase === "blocked" ? "160" : "580",
                    BBLITE_SCREENSHOT: stem + ".png", BBLITE_INPUT_REPLAY: replay.join(","),
                    BBLITE_RUNTIME_TRACE: "0", BBLITE_WINDOW_TRACE: "1", BBLITE_RUNTIME_TRACE_INTERVAL: "1",
                    BBLITE_CAPTURE_ENGINE_FRAME: "", BBLITE_CAPTURE_UI: "1", BBLITE_FRAME_DELTA_MS: "" },
                stdio: ["ignore", fd, fd] });
        } finally { closeSync(fd); }
        const log = readFileSync(stem + ".log", "utf8");
        assert(!/error|exception/i.test(log), log);
        const frames = samples(log);
        assert(frames.length > 100 && frames.every(frame => frame.canvases.length === 2), "Missing two-canvas progress");
        const blocked = frames.filter(frame => frame.frame >= 80 && frame.frame <= 180);
        const mainDelta = blocked.at(-1).canvases[0].sequence - blocked[0].canvases[0].sequence;
        const workerDelta = blocked.at(-1).canvases[1].sequence - blocked[0].canvases[1].sequence;
        assert(mainDelta <= 8 && workerDelta >= 50, `Block did not isolate the main realm: ${mainDelta}/${workerDelta}`);
        const png = PNG.sync.read(readFileSync(stem + ".png"));
        let left = png.width, right = -1;
        for (let x = 0; x < png.width; ++x) {
            const pixel = (35 * png.width + x) * 4;
            const r = png.data[pixel], g = png.data[pixel + 1], b = png.data[pixel + 2];
            if (r > 90 && r > g * 1.4 && r > b * 1.4) { left = Math.min(left, x); right = x + 1; }
        }
        const center = (left + right) / 2;
        assert(Math.abs(center - png.width / 2) <= 1, `Button is off center: ${center}`);
        if (phase === "blocked") assert(right - left > 270, "Block label did not expand");
        else {
            assert(right - left < 220, "Unblock did not restore the short label");
            const late = frames.filter(frame => frame.frame >= 500);
            assert(late.at(-1).canvases[0].sequence - late[0].canvases[0].sequence > 80, "Main realm did not resume");
            assert(late.every(frame => frame.canvases.every(canvas => canvas.width === 700 && canvas.height === 279)), "Responsive resize did not reach both engines");
        }
        results.push({ backend, phase, mainFramesWhileBlocked: mainDelta, workerFramesWhileBlocked: workerDelta, buttonCenter: center,
            viewport: [png.width, png.height], exitedNormally: true });
    }
}
writeFileSync(resolve(output, "window-check.json"), JSON.stringify(results, null, 2) + "\n");
console.log(JSON.stringify(results, null, 2));
