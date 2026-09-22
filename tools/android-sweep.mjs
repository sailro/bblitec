import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { scenes } from "../dist/src/scene-registry.js";
import {
    compareImages,
    compareRegion,
    generateDiffMap,
    imageDimensions,
} from "../dist/src/parity.js";
import { resolveParityThresholds } from "../dist/src/parity-scene.js";
import { writeJsonRecord } from "../dist/src/validation-resume.js";
import { runConcurrently } from "../dist/src/run-concurrently.js";
import { runLoggedProcess } from "../dist/src/tooling/logged-process.js";
import { holdDistLock } from "../dist/src/dist-lock.js";
import { NATIVE_BACKENDS } from "../dist/src/tooling/artifacts.js";
import { compileOfflineShaders } from "../dist/src/compile-shaders.js";
import { refreshBuildStamp } from "../dist/src/generation-stamp.js";

const { values } = parseArgs({
    options: {
        sdk: { type: "string", default: process.env.ANDROID_HOME },
        device: { type: "string" },
        abi: { type: "string", default: "x86_64" },
        jobs: { type: "string", default: "8" },
        scene: { type: "string", multiple: true },
        parallel: { type: "string", default: "4" },
        backend: { type: "string", default: "sdl_gpu" },
    },
});
if (!values.sdk || !values.device) throw new Error("Use --sdk and --device.");
if (!["x86_64", "arm64-v8a"].includes(values.abi))
    throw new Error("Unsupported ABI.");
if (!NATIVE_BACKENDS.includes(values.backend))
    throw new Error(`--backend must be ${NATIVE_BACKENDS.join(" or ")}.`);
if (!/^[1-9][0-9]*$/.test(values.jobs))
    throw new Error("--jobs must be a positive integer.");
if (!/^[1-9][0-9]*$/.test(values.parallel))
    throw new Error("--parallel must be a positive integer.");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
holdDistLock("android-sweep");
const selected = values.scene
    ? scenes.filter((scene) => values.scene.includes(scene.id))
    : scenes;
if (values.scene?.some((id) => !selected.some((scene) => scene.id === id)))
    throw new Error("Unknown scene selection.");
const variant = `${values.abi}${values.backend === "sdl_gpu" ? "" : "-dawn"}`;
const adb = join(
    resolve(values.sdk),
    "platform-tools",
    process.platform === "win32" ? "adb.exe" : "adb",
);
function device(...args) {
    return execFileSync(adb, ["-s", values.device, ...args], {
        encoding: "utf8",
        timeout: 30000,
        windowsHide: true,
    });
}
const runId = randomUUID();
const output = join(root, "artifacts/android/sweep", runId);
mkdirSync(output, { recursive: true });
const report = {
    runId,
    startedAt: new Date().toISOString(),
    abi: values.abi,
    backend: values.backend,
    device: values.device,
    model: device("shell", "getprop", "ro.product.model").trim(),
    api: device("shell", "getprop", "ro.build.version.sdk").trim(),
    total: selected.length,
    results: [],
};
function save() {
    writeJsonRecord(join(output, "report.json"), report);
}
async function run(program, args, logPath) {
    const code = await runLoggedProcess(program, args, logPath, { cwd: root });
    if (code !== 0)
        throw new Error(
            `${program} exited with status ${code}; see ${logPath}`,
        );
}
console.log(`Android sweep: ${selected.length} scenes. Results: ${output}`);
save();
if (values.scene) {
    for (const scene of selected)
        await run(
            process.execPath,
            ["dist/src/scene-command.js", "compile", scene.id],
            join(output, `generation-${scene.id}.log`),
        );
} else {
    await run(
        process.execPath,
        ["dist/src/scene-command.js", "compile", "all"],
        join(output, "generation.log"),
    );
}
if (values.backend === "sdl_gpu") {
    writeJsonRecord(
        join(output, "shaders.json"),
        compileOfflineShaders({
            directories: selected
                .map((scene) => resolve(scene.output, "upstream/shaders"))
                .filter(existsSync),
            repositoryRoot: root,
            target: "vulkan",
        }),
    );
}
for (const scene of selected)
    refreshBuildStamp(resolve(scene.output), { generatedInputsChanged: true });
process.env.BBLITE_ANDROID_INPUTS_PREPARED = "1";
// Reconcile the complete dependency set once; parallel builders only read it.
const generatedDirectories = join(output, "generation-directories.txt");
writeFileSync(
    generatedDirectories,
    selected
        .map((scene) => resolve(scene.output).replaceAll("\\", "/"))
        .join("\n"),
);
await run(
    "pwsh",
    [
        "-NoProfile",
        "-File",
        "tools/android.ps1",
        "-Scene",
        selected[0].id,
        "-Sdk",
        values.sdk,
        "-Abi",
        values.abi,
        "-Backend",
        values.backend,
        "-Jobs",
        values.jobs,
        "-SkipGenerate",
        "-SweepGeneratedDirectoriesFile",
        generatedDirectories,
    ],
    join(output, "dependencies.log"),
);
const originalSize =
    device("shell", "wm", "size").match(/Override size: (\d+x\d+)/)?.[1] ??
    "reset";
let captureQueue = Promise.resolve();
async function captureScene(scene, result, sceneOutput) {
    const apk = join(
        root,
        "artifacts/android",
        scene.id,
        variant,
        `bblite-${scene.id}-${values.abi}.apk`,
    );
    result.stage = "install";
    save();
    writeFileSync(
        join(sceneOutput, "install.log"),
        device("install", "-r", apk),
    );
    const reference = scene.parity?.reference.path;
    const dimensions =
        reference && existsSync(reference)
            ? imageDimensions(reference)
            : undefined;
    if (dimensions) {
        const { width, height } = dimensions;
        device("shell", "wm", "size", `${width}x${height}`);
    }
    result.stage = "capture";
    save();
    await run(
        process.execPath,
        [
            "tools/android-smoke.mjs",
            "--adb",
            adb,
            "--device",
            values.device,
            "--apk",
            apk,
            "--output",
            sceneOutput,
            "--scene",
            scene.id,
            "--backend",
            values.backend,
        ],
        join(sceneOutput, "capture.log"),
    );
    result.capture = JSON.parse(
        readFileSync(join(sceneOutput, "report.json"), "utf8"),
    );
    if (!dimensions) {
        result.status = "captured";
        result.reason =
            "No registered golden image; visual parity was not assessed.";
    } else {
        result.stage = "compare";
        save();
        const actual = join(sceneOutput, "capture.png");
        if (
            dimensions.width !== result.capture.width ||
            dimensions.height !== result.capture.height
        ) {
            throw new Error(
                `Capture dimensions ${result.capture.width}x${result.capture.height} differ from reference ${dimensions.width}x${dimensions.height}.`,
            );
        }
        result.full = compareImages(actual, reference);
        result.foreground = compareRegion(
            actual,
            reference,
            scene.parity.backgroundColor,
            scene.parity.backgroundThreshold,
        );
        result.thresholds = resolveParityThresholds(
            scene.parity,
            values.backend,
        );
        result.status =
            result.thresholds.gate === "diagnostic-only"
                ? "captured"
                : result.full.mad <= result.thresholds.maxMad &&
                    result.foreground.mad <= result.thresholds.maxRegionMad
                  ? "passed"
                  : "parity-failed";
        if (result.status === "parity-failed")
            generateDiffMap(actual, reference, join(sceneOutput, "diff.png"));
    }
}
async function runScene(scene) {
    const sceneOutput = join(output, scene.id);
    mkdirSync(sceneOutput, { recursive: true });
    const result = {
        scene: scene.id,
        status: "running",
        stage: "build",
        startedAt: new Date().toISOString(),
    };
    report.results.push(result);
    save();
    console.log(
        `[${report.results.length}/${selected.length}] ${scene.id}: building`,
    );
    try {
        await run(
            "pwsh",
            [
                "-NoProfile",
                "-File",
                "tools/android.ps1",
                "-Scene",
                scene.id,
                "-Sdk",
                values.sdk,
                "-Abi",
                values.abi,
                "-Backend",
                values.backend,
                "-Jobs",
                values.jobs,
                "-SkipGenerate",
                "-UseInstalledDependencies",
            ],
            join(sceneOutput, "build.log"),
        );
        result.stage = "waiting-for-device";
        save();
        const capture = captureQueue.then(() =>
            captureScene(scene, result, sceneOutput),
        );
        captureQueue = capture.catch(() => {});
        await capture;
    } catch (error) {
        result.status = "failed";
        result.reason = error.message;
    }
    result.completedAt = new Date().toISOString();
    save();
    console.log(
        `${scene.id}: ${result.status}${result.reason ? ` (${result.reason})` : ""}`,
    );
}
try {
    await runConcurrently(
        selected,
        Number(values.parallel),
        (scene) => scene.id,
        runScene,
    );
} finally {
    device("shell", "wm", "size", originalSize);
}
report.completedAt = new Date().toISOString();
report.counts = {};
for (const result of report.results)
    report.counts[result.status] = (report.counts[result.status] ?? 0) + 1;
save();
console.log(JSON.stringify(report.counts));
console.log(`Report: ${join(output, "report.json")}`);
if (
    report.results.some(
        (result) => !["passed", "captured"].includes(result.status),
    )
)
    process.exitCode = 1;
