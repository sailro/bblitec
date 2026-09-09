import assert from "node:assert/strict";
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

/** Isolate a namespace-level record, including its member implementations. */
export function cppRecord(source: string, signature: string): string {
    const start = source.indexOf(signature);
    const end = source.indexOf("\n};", start);
    assert.ok(start >= 0 && end > start, signature);
    return source.slice(start, end + 3);
}

/** Isolate an emitted declaration for a CPU fixture without changing its body. */
export function cppFunction(source: string, signature: string): string {
    const start = source.indexOf(signature);
    assert.ok(start >= 0, signature);
    let open: number;
    if (signature.trimEnd().endsWith("{") || /^(?:struct|class|enum)\b/.test(signature)) {
        open = source.indexOf("{", start);
    } else {
        let parameters = source.indexOf("(", start), parameterDepth = 1;
        assert.ok(parameters >= 0, signature);
        while (parameterDepth && ++parameters < source.length) {
            if (source[parameters] === "(") ++parameterDepth;
            if (source[parameters] === ")") --parameterDepth;
        }
        assert.equal(parameterDepth, 0);
        open = source.indexOf("{", parameters);
    }
    let depth = 1, end = open + 1;
    while (depth && end < source.length) {
        const char = source[end++];
        if (char === "{") ++depth;
        if (char === "}") --depth;
    }
    assert.equal(depth, 0);
    return source.slice(start, end);
}

/** Header-only fixtures can opt out of the installed-library prerequisite. */
export function optionalNativeFixtureTools(requireVcpkg = true):
    | WindowsBuildTools
    | undefined {
    if (
        process.platform !== "win32" ||
        (requireVcpkg && !existsSync(nativeFixtureVcpkgRoot))
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
