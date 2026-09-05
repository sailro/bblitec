import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import {
    discoverWindowsBuildTools,
    type WindowsBuildTools,
} from "../src/development-tools.js";

export const nativeFixtureVcpkgRoot = resolve(
    "artifacts/vcpkg-installed/development-full/x64-windows",
);

export function optionalNativeFixtureTools():
    | WindowsBuildTools
    | undefined {
    if (
        process.platform !== "win32" ||
        !existsSync(nativeFixtureVcpkgRoot)
    ) {
        return undefined;
    }
    try {
        return discoverWindowsBuildTools("msvc");
    } catch (error) {
        if (error instanceof Error) return undefined;
        throw error;
    }
}

export function runNativeFixtureCompiler(
    tools: WindowsBuildTools,
    arguments_: readonly string[],
): void {
    try {
        execFileSync(tools.compiler, arguments_, {
            cwd: resolve("."),
            env: tools.environment,
            stdio: "pipe",
        });
    } catch (error) {
        const failure = error as Error & { stdout?: Buffer; stderr?: Buffer };
        throw new Error(`${failure.message}\n${failure.stdout ?? ""}\n${failure.stderr ?? ""}`, { cause: error });
    }
}
