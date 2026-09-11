import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";

import {
    discoverWindowsBuildTools,
    type WindowsBuildTools,
} from "../src/development-tools.js";

export const nativeFixtureVcpkgRoot = resolve(
    "artifacts/vcpkg-installed/development-full/x64-windows",
);

/** Isolate contiguous emitted helpers, refusing a missing or reversed boundary. */
export function cppSection(source: string, first: string, next: string): string {
    const start = source.indexOf(first), end = source.indexOf(next, start);
    assert.ok(start >= 0 && end > start, `${first} through ${next}`);
    return source.slice(start, end);
}

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

/** Build a retained-UI fixture against the same pinned library and platform fonts. */
export function runRmlUiFixture(t: TestContext, name: string): void {
    const tools = optionalNativeFixtureTools();
    const rml = resolve(process.env.BBLITE_RMLUI_DIR ?? "artifacts/tools/rmlui");
    if (!tools || !existsSync(join(rml, "lib/rmlui.lib"))) {
        t.skip("The native compiler and pinned RmlUi library are required."); return;
    }
    const output = resolve("artifacts", name);
    mkdirSync(output, { recursive: true });
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD", "/O2", "/Gy",
        "/DBBLITE_HAS_UI=1", "/DBBLITE_HAS_IMAGE_DECODER=0", "/DRMLUI_STATIC_LIB", "/DRMLUI_SDL_VERSION_MAJOR=3",
        `/Fo:${output}/`, `/Fe:${executable}`, "/I", "native/include", "/I", "native/src",
        `/external:I${join(rml, "include")}`, `/external:I${join(rml, "Backends")}`,
        `/external:I${join(nativeFixtureVcpkgRoot, "include")}`, "/external:W0",
        `test/fixtures/${name}-check.cpp`, "native/src/pal_system_fonts.cpp",
        join(rml, "Backends/RmlUi_Platform_SDL.cpp"), "/link", "/OPT:REF",
        join(rml, "lib/rmlui.lib"), join(nativeFixtureVcpkgRoot, "lib/freetype.lib"),
        join(nativeFixtureVcpkgRoot, "lib/lunasvg.lib"), join(nativeFixtureVcpkgRoot, "lib/SDL3.lib"),
        "dwrite.lib", "user32.lib"]);
    assert.equal(execFileSync(executable, { encoding: "utf8",
        env: { ...tools.environment, PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${tools.environment.PATH ?? ""}` },
    }), "");
}
