import type { SceneDefinition } from "./scene-registry.js";
import {
    measuredRunEnvironment,
    type MeasuredRunOptions,
} from "./tooling/native-run.js";

export interface IosSimulator {
    udid: string;
    name: string;
    state: string;
    runtime: string;
}

export function selectIosSimulator(
    json: string,
    requested: string,
): IosSimulator {
    const root: unknown = JSON.parse(json);
    if (
        !root ||
        typeof root !== "object" ||
        !("devices" in root) ||
        !root.devices ||
        typeof root.devices !== "object" ||
        Array.isArray(root.devices)
    ) {
        throw new Error("simctl returned no device inventory.");
    }
    const matches: IosSimulator[] = [];
    for (const [runtime, entries] of Object.entries(root.devices)) {
        if (!runtime.startsWith("com.apple.CoreSimulator.SimRuntime.iOS-"))
            continue;
        if (!Array.isArray(entries))
            throw new Error("simctl returned an invalid iOS device list.");
        const devices: unknown[] = entries;
        for (const device of devices) {
            if (
                !device ||
                typeof device !== "object" ||
                !("isAvailable" in device) ||
                typeof device.isAvailable !== "boolean" ||
                !("udid" in device) ||
                typeof device.udid !== "string" ||
                !("name" in device) ||
                typeof device.name !== "string" ||
                !("state" in device) ||
                typeof device.state !== "string"
            ) {
                throw new Error("simctl returned an invalid iOS device.");
            }
            if (
                device.isAvailable &&
                (requested === "booted"
                    ? device.state === "Booted"
                    : device.udid === requested)
            ) {
                matches.push({
                    udid: device.udid,
                    name: device.name,
                    state: device.state,
                    runtime,
                });
            }
        }
    }
    if (matches.length !== 1) {
        throw new Error(
            `Expected one available iOS simulator for '${requested}', found ${matches.length}. Use an explicit UDID from xcrun simctl list devices available.`,
        );
    }
    return matches[0]!;
}

export function iosCaptureEnvironment(
    scene: SceneDefinition,
    backend: "sdl_gpu" | "dawn",
    options: Pick<MeasuredRunOptions, "frame" | "tape" | "testPass"> & {
        canvasOnly?: boolean;
    } = {},
): Record<string, string> {
    return measuredRunEnvironment({
        ...options,
        environment: scene.parity?.nativeEnvironment ?? {},
        backend,
        extra: {
            BBLITE_GPU_BACKEND: backend,
            BBLITE_GPU_DEBUG: "1",
            ...(options.canvasOnly ? { BBLITE_CAPTURE_UI: "0" } : {}),
        },
    });
}

export function verifyIosNativeExit(log: string, runId: string): void {
    const exits = [
        ...log.matchAll(/^Native exit: (\d+) run=(\S+)\r?$/gm),
    ].filter((match) => match[2] === runId);
    if (exits.length !== 1)
        throw new Error(
            "The native app did not report one exit for this run; inspect simulator.log.",
        );
    if (exits[0]![1] !== "0")
        throw new Error(
            `The native app exited with status ${exits[0]![1]}; inspect simulator.log.`,
        );
}
