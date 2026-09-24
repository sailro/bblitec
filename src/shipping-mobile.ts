import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { discoverDevelopmentTools } from "./development-tools.js";
import { holdDistLock } from "./dist-lock.js";
import type { SceneDefinition } from "./scene-registry.js";
import { writeJsonRecord } from "./tooling/records.js";
import { runLoggedProcess } from "./tooling/logged-process.js";
import { NATIVE_BACKENDS } from "./tooling/artifacts.js";

type MobilePlatform = "android" | "ios";

export function mobilePackageArguments(
    platform: MobilePlatform,
    scene: string,
    values: ReadonlyMap<string, string>,
): string[] {
    const target: string[] = [];
    if (platform === "android") {
        const abi = values.get("--abi") ?? "arm64-v8a";
        if (abi !== "arm64-v8a" && abi !== "x86_64")
            throw new Error("Unsupported Android ABI.");
        const backend = values.get("--backend") ?? "sdl_gpu";
        if (!NATIVE_BACKENDS.some((candidate) => candidate === backend))
            throw new Error(
                `Android packages require --backend ${NATIVE_BACKENDS.join(" or ")}.`,
            );
        target.push(
            "-Abi",
            abi,
            "-ExpectBackend",
            backend.toUpperCase(),
            ...(values.get("--sdk") ? ["-Sdk", values.get("--sdk")!] : []),
            ...(values.get("--device")
                ? ["-Device", values.get("--device")!]
                : []),
        );
    } else if (
        ["--abi", "--sdk", "--device", "--backend"].some((flag) =>
            values.has(flag),
        )
    ) {
        throw new Error(
            "iOS packaging targets ARM64 devices using SDL_GPU. Select Xcode with DEVELOPER_DIR; Android SDK/device/backend options do not apply.",
        );
    }
    const jobs = values.get("--jobs") ?? "8";
    if (!/^[1-9][0-9]*$/.test(jobs))
        throw new Error("--jobs must be a positive integer.");
    if (values.has("--workers") && values.get("--workers") !== "1")
        throw new Error("Mobile packages share dependencies; use --workers 1.");
    return [
        "-NoProfile",
        "-File",
        resolve("tools/package-demo.ps1"),
        "-Platform",
        platform,
        "-Scene",
        scene,
        "-Jobs",
        jobs,
        "-OutputRoot",
        resolve(values.get("--output") ?? "artifacts/releases"),
        ...target,
    ];
}

export async function runMobilePackages(
    platform: MobilePlatform,
    scenes: readonly SceneDefinition[],
    values: ReadonlyMap<string, string>,
    planOnly: boolean,
): Promise<void> {
    const plan = scenes.map((scene) => ({
        scene: scene.id,
        args: mobilePackageArguments(platform, scene.id, values),
    }));
    if (planOnly) {
        console.log(JSON.stringify(plan, null, 2));
        return;
    }
    if (platform === "android" && !values.get("--device"))
        throw new Error(
            "Android packaging requires --device for startup validation.",
        );
    if (platform === "ios" && process.platform !== "darwin")
        throw new Error("iOS packaging requires macOS and Xcode.");
    const tools = discoverDevelopmentTools();
    if (!tools.powershell)
        throw new Error("PowerShell is required for mobile packaging.");
    const logs = resolve(
        "artifacts/shipping",
        `${platform}-${Date.now()}-${process.pid}`,
    );
    mkdirSync(logs, { recursive: true });
    if (platform === "ios") {
        holdDistLock("shipping-ios");
        for (const scene of scenes) {
            console.log(`generate ${scene.id}: running`);
            for (const [stage, args] of [
                [
                    "generate",
                    ["dist/src/scene-command.js", "compile", scene.id],
                ],
                [
                    "metal",
                    [
                        "dist/src/compile-shaders.js",
                        "--scene",
                        scene.id,
                        "--target",
                        "metal",
                    ],
                ],
            ] as const) {
                const log = join(logs, `${stage}-${scene.id}.log`);
                const exit = await runLoggedProcess(
                    process.execPath,
                    [...args],
                    log,
                );
                if (exit !== 0)
                    throw new Error(
                        `${stage} ${scene.id} failed (${exit}); see ${log}`,
                    );
            }
        }
    }
    const results: {
        scene: string;
        status: string;
        exit: number;
        log: string;
    }[] = [];
    for (const item of plan) {
        const log = join(logs, `${item.scene}.log`);
        console.log(`package ${item.scene}: running`);
        const args =
            platform === "ios" ? [...item.args, "-SkipGenerate"] : item.args;
        const exit = await runLoggedProcess(tools.powershell, args, log, {
            env: {
                ...process.env,
                ...(tools.cmake ? { CMAKE_COMMAND: tools.cmake } : {}),
            },
        });
        const status =
            exit === 0
                ? platform === "ios"
                    ? "packaged-unsigned"
                    : "passed"
                : "failed";
        results.push({ scene: item.scene, status, exit, log });
        writeJsonRecord(join(logs, "results.json"), results);
        console.log(`package ${item.scene}: ${status}`);
    }
    if (results.some((result) => result.exit !== 0))
        throw new Error(
            `${platform} packages incomplete; see ${join(logs, "results.json")}`,
        );
}
