import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { discoverDevelopmentTools } from "./development-tools.js";
import type { SceneDefinition } from "./scene-registry.js";
import { writeJsonRecord } from "./validation-resume.js";
import { runLoggedProcess } from "./tooling/logged-process.js";

export function androidPackageArguments(scene: string, values: ReadonlyMap<string, string>): string[] {
    const abi = values.get("--abi") ?? "arm64-v8a";
    if (abi !== "arm64-v8a" && abi !== "x86_64") throw new Error("Unsupported Android ABI.");
    const jobs = values.get("--jobs") ?? "8";
    if (!/^[1-9][0-9]*$/.test(jobs)) throw new Error("--jobs must be a positive integer.");
    if (values.has("--workers") && values.get("--workers") !== "1") throw new Error("Android packages share dependencies and a device; use --workers 1.");
    return ["-NoProfile", "-File", resolve("tools/package-demo.ps1"), "-Platform", "android", "-Scene", scene,
        "-Abi", abi, "-Jobs", jobs, "-OutputRoot", resolve(values.get("--output") ?? "artifacts/releases"),
        ...(values.get("--sdk") ? ["-Sdk", values.get("--sdk")!] : []),
        ...(values.get("--device") ? ["-Device", values.get("--device")!] : [])];
}

export async function runAndroidPackages(scenes: readonly SceneDefinition[], values: ReadonlyMap<string, string>, planOnly: boolean): Promise<void> {
    const plan = scenes.map(scene => ({ scene: scene.id, args: androidPackageArguments(scene.id, values) }));
    if (planOnly) { console.log(JSON.stringify(plan, null, 2)); return; }
    if (!values.get("--device")) throw new Error("Android packaging requires --device for startup validation.");
    const tools = discoverDevelopmentTools();
    if (!tools.powershell) throw new Error("PowerShell is required for Android packaging.");
    const logs = resolve("artifacts/shipping", `android-${Date.now()}-${process.pid}`);
    mkdirSync(logs, { recursive: true });
    const results: { scene: string; status: string; exit: number; log: string }[] = [];
    for (const item of plan) {
        const log = join(logs, `${item.scene}.log`);
        console.log(`package ${item.scene}: running`);
        const exit = await runLoggedProcess(tools.powershell, item.args, log,
            { env: { ...process.env, ...(tools.cmake ? { CMAKE_COMMAND: tools.cmake } : {}) } });
        const status = exit === 0 ? "passed" : "failed";
        results.push({ scene: item.scene, status, exit, log });
        writeJsonRecord(join(logs, "results.json"), results);
        console.log(`package ${item.scene}: ${status}`);
    }
    if (results.some(result => result.exit !== 0)) throw new Error(`Android packages incomplete; see ${join(logs, "results.json")}`);
}
