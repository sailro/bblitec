import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { PNG } from "pngjs";
import {
    iosCaptureEnvironment,
    selectIosSimulator,
    verifyIosNativeExit,
} from "../dist/src/ios-simulator.js";
import { resolveScene } from "../dist/src/scene-registry.js";
import {
    verifyBuildIdentity,
    verifyDeployedPayload,
} from "../dist/src/tooling/native-run.js";
import {
    contentFingerprint,
    writeJsonRecord,
} from "../dist/src/tooling/records.js";

const { values } = parseArgs({
    options: {
        scene: { type: "string" },
        device: { type: "string" },
        bundle: { type: "string" },
        output: { type: "string" },
        app: { type: "string", default: "org.bblite.prototype" },
        backend: { type: "string", default: "dawn" },
        frame: { type: "string" },
        replay: { type: "string" },
        "canvas-only": { type: "boolean", default: false },
    },
});
if (process.platform !== "darwin")
    throw new Error("iOS Simulator smoke requires macOS and Xcode.");
if (!values.scene || !values.device || !values.bundle || !values.output) {
    throw new Error("Use --scene, --device, --bundle and --output.");
}
if (!/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(values.app))
    throw new Error("Invalid application ID.");
if (!["sdl_gpu", "dawn"].includes(values.backend))
    throw new Error("Use --backend sdl_gpu|dawn.");
const frame = values.frame === undefined ? undefined : Number(values.frame);
if (
    frame !== undefined &&
    (!Number.isSafeInteger(frame) || frame < 0 || frame > 1000000)
) {
    throw new Error("--frame must be an integer in [0, 1000000].");
}
if (
    values.replay !== undefined &&
    (frame === undefined || !values.replay.trim())
) {
    throw new Error(
        "--replay requires a nonempty input tape and an explicit --frame.",
    );
}
const output = resolve(values.output);
mkdirSync(output, { recursive: true });
let log = "";
function simctl(args, environment = process.env, timeout = 30000) {
    const result = spawnSync("xcrun", ["simctl", ...args], {
        encoding: "utf8",
        env: environment,
        timeout,
        maxBuffer: 16 * 1024 * 1024,
    });
    log += `$ xcrun simctl ${args.join(" ")}\n${result.stdout ?? ""}${result.stderr ?? ""}`;
    if (result.error) throw result.error;
    if (result.status !== 0)
        throw new Error(
            `simctl ${args[0]} failed (${result.status ?? result.signal}); inspect simulator.log.`,
        );
    return result.stdout.trim();
}
const receipt = {
    platform: "ios-simulator",
    scene: values.scene,
    backend: values.backend,
    runId: randomUUID(),
    bundle: resolve(values.bundle),
    bundleSha256: contentFingerprint([values.bundle]),
    passed: false,
};
let launchedDevice;
try {
    const scene = resolveScene(values.scene);
    const executable = join(receipt.bundle, "bblite_native");
    verifyDeployedPayload(executable, scene.output);
    const device = selectIosSimulator(
        simctl(["list", "devices", "available", "--json"]),
        values.device,
    );
    receipt.device = device;
    simctl(["bootstatus", device.udid, "-b"], process.env, 180000);
    simctl(["install", device.udid, receipt.bundle]);
    const container = simctl([
        "get_app_container",
        device.udid,
        values.app,
        "data",
    ]);
    const screenshot = join(container, "Documents", `${receipt.runId}.png`);
    const stamp = join(container, "Documents", `${receipt.runId}.stamp`);
    const environment = {
        ...iosCaptureEnvironment(scene, values.backend, {
            frame,
            canvasOnly: values["canvas-only"],
            ...(values.replay === undefined
                ? {}
                : { tape: values.replay.split(","), testPass: false }),
        }),
        BBLITE_RUN_ID: receipt.runId,
        BBLITE_SCREENSHOT: screenshot,
        BBLITE_BUILD_STAMP_OUT: stamp,
        SDL_ASSERT: "abort",
    };
    receipt.environment = environment;
    const launchEnvironment = Object.fromEntries(
        Object.entries(process.env).filter(
            ([key]) => !key.startsWith("SIMCTL_CHILD_"),
        ),
    );
    for (const [key, value] of Object.entries(environment))
        launchEnvironment[`SIMCTL_CHILD_${key}`] = value;
    const start = log.length;
    launchedDevice = device.udid;
    simctl(
        [
            "launch",
            "--console",
            "--terminate-running-process",
            device.udid,
            values.app,
        ],
        launchEnvironment,
        120000,
    );
    launchedDevice = undefined;
    verifyIosNativeExit(log.slice(start), receipt.runId);
    verifyBuildIdentity(executable, scene.output, stamp);
    const png = PNG.sync.read(readFileSync(screenshot));
    copyFileSync(screenshot, join(output, "capture.png"));
    copyFileSync(stamp, join(output, "build-stamp.txt"));
    Object.assign(receipt, {
        passed: true,
        width: png.width,
        height: png.height,
    });
    console.log(
        `iOS Simulator smoke passed: ${values.scene}, ${values.backend}, ${device.name}, ${png.width}x${png.height}. ${output}`,
    );
} catch (error) {
    receipt.error = error instanceof Error ? error.message : String(error);
    throw error;
} finally {
    if (launchedDevice) {
        try {
            simctl(["terminate", launchedDevice, values.app]);
        } catch (error) {
            console.error(
                `Simulator cleanup: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
    writeFileSync(join(output, "simulator.log"), log);
    writeJsonRecord(join(output, "report.json"), receipt);
}
