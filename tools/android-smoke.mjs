import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { PNG } from "pngjs";
import { writeJsonRecord } from "../dist/src/tooling/records.js";
import {
    androidCaptureSettings,
    verifyAndroidNativeRun,
} from "../dist/src/android-capture.js";
import { resolveScene } from "../dist/src/scene-registry.js";
import { NATIVE_BACKENDS } from "../dist/src/tooling/artifacts.js";

const { values } = parseArgs({
    options: {
        adb: { type: "string" },
        device: { type: "string" },
        output: { type: "string" },
        apk: { type: "string" },
        scene: { type: "string" },
        backend: { type: "string", default: "sdl_gpu" },
        "canvas-only": { type: "boolean", default: false },
        app: { type: "string", default: "org.bblite.prototype" },
    },
});
if (!values.adb || !values.output || !values.apk)
    throw new Error("Use --adb, --output, --apk and optionally --device.");
if (!NATIVE_BACKENDS.includes(values.backend))
    throw new Error(`--backend must be ${NATIVE_BACKENDS.join(" or ")}.`);
const output = resolve(values.output);
mkdirSync(output, { recursive: true });
const selector = values.device ? ["-s", values.device] : [];
function adb(...args) {
    return execFileSync(values.adb, [...selector, ...args], {
        timeout: 15000,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
    });
}
const runId = randomUUID();
const app = values.app;
if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(app))
    throw new Error("Invalid application ID.");
const { captureEnvironment, captureFrame } = androidCaptureSettings(
    values.scene ? resolveScene(values.scene) : undefined,
    { canvasOnly: values["canvas-only"], backend: values.backend },
);
const receipt = {
    runId,
    apkSha256: createHash("sha256")
        .update(readFileSync(values.apk))
        .digest("hex"),
    device: adb("get-serialno").toString().trim(),
    model: adb("shell", "getprop", "ro.product.model").toString().trim(),
    api: adb("shell", "getprop", "ro.build.version.sdk").toString().trim(),
    backend: values.backend,
    passed: false,
    ...(values.scene
        ? { scene: values.scene, captureFrame, captureEnvironment }
        : {}),
};
try {
    adb("shell", "am", "force-stop", app);
    adb("shell", "run-as", app, "rm", "-f", "files/capture.png");
    let log = "";
    const logChunks = [];
    let logLength = 0;
    let markerTail = "";
    const exitMarker = new RegExp(`Native exit: -?\\d+ run=${runId}(?:\\s|$)`);
    function appendLog(text) {
        logChunks.push(text);
        logLength += text.length;
        while (logLength > 16 * 1024 * 1024 && logChunks.length > 1)
            logLength -= logChunks.shift().length;
    }
    const logger = spawn(
        values.adb,
        [...selector, "logcat", "-s", "bblite:I", "SDL:E", "AndroidRuntime:E"],
        { windowsHide: true },
    );
    let timer;
    try {
        const finished = new Promise((resolve) => {
            timer = setTimeout(resolve, 90000);
            logger.on("error", (error) => {
                appendLog(error.message);
                resolve();
            });
            logger.on("exit", resolve);
            logger.stdout.on("data", (chunk) => {
                const text = chunk.toString();
                appendLog(text);
                const recent = markerTail + text;
                if (exitMarker.test(recent)) resolve();
                markerTail = recent.slice(-(runId.length + 40));
            });
            logger.stderr.on("data", (chunk) => appendLog(chunk.toString()));
        });
        // The native exit marker owns completion, even if the activity exits before its first presentation.
        adb(
            "shell",
            "am",
            "start",
            "-n",
            `${app}/org.bblite.prototype.MainActivity`,
            "--es",
            "BBLITE_RUN_ID",
            runId,
            "--es",
            "captureFrame",
            captureFrame,
            ...Object.entries(captureEnvironment).flatMap(([key, value]) => [
                "--es",
                key,
                value,
            ]),
            "--ez",
            "capture",
            "true",
        );
        await finished;
    } finally {
        clearTimeout(timer);
        logger.kill();
        log = logChunks.join("");
        writeFileSync(join(output, "logcat.txt"), log);
    }
    verifyAndroidNativeRun(log, runId, values.backend);
    const bytes = adb("exec-out", "run-as", app, "cat", "files/capture.png");
    const png = PNG.sync.read(bytes);
    writeFileSync(join(output, "capture.png"), bytes);
    Object.assign(receipt, {
        passed: true,
        width: png.width,
        height: png.height,
    });
    console.log(
        `Android ${values.backend} smoke passed on ${receipt.model}: ${png.width}x${png.height}. ${output}`,
    );
} catch (error) {
    receipt.error = error instanceof Error ? error.message : String(error);
    throw error;
} finally {
    writeJsonRecord(join(output, "report.json"), receipt);
    adb("shell", "am", "force-stop", app);
}
