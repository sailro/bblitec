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
export function cppSection(
    source: string,
    first: string,
    next: string,
): string {
    const start = source.indexOf(first),
        end = source.indexOf(next, start);
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
    const pattern = signature
        .trim()
        .split(/(\s+)/)
        .map((part, index, parts) =>
            /^\s+$/.test(part)
                ? /\w$/.test(parts[index - 1]!) && /^\w/.test(parts[index + 1]!)
                    ? "\\s+"
                    : "\\s*"
                : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        )
        .join("");
    for (const match of source.matchAll(new RegExp(pattern, "g"))) {
        const start = match.index;
        let open: number;
        if (
            signature.trimEnd().endsWith("{") ||
            /^(?:struct|class|enum)\b/.test(signature)
        ) {
            open = source.indexOf("{", start);
        } else {
            let parameters = source.indexOf("(", start),
                parameterDepth = 1;
            assert.ok(parameters >= 0, signature);
            while (parameterDepth && ++parameters < source.length) {
                if (source[parameters] === "(") ++parameterDepth;
                if (source[parameters] === ")") --parameterDepth;
            }
            assert.equal(parameterDepth, 0);
            open = source.indexOf("{", parameters);
            if (source.slice(parameters + 1, open).includes(";")) continue;
        }
        assert.ok(open >= 0, signature);
        let depth = 1,
            end = open + 1;
        while (depth && end < source.length) {
            const char = source[end++];
            if (char === "{") ++depth;
            if (char === "}") --depth;
        }
        assert.equal(depth, 0);
        return source.slice(start, end);
    }
    assert.fail(signature);
}

/** Header-only fixtures can opt out of the installed-library prerequisite. */
export function optionalNativeFixtureTools(
    requireVcpkg = true,
): WindowsBuildTools | undefined {
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

/**
 * The configuration a direct fixture compiles against where its own flags
 * are silent: the full scene runtime with capture and decoding, and the
 * development asset and shader directories. The product build defines every
 * macro itself (native/CMakeLists.txt and the generated
 * render_capabilities.hpp); a fixture is its own build, so its defaults are
 * stated here rather than in the headers.
 */
const nativeFixtureMacroDefaults: ReadonlyMap<string, string> = new Map([
    ["BBLITE_ASSET_DIR", '"assets"'],
    ["BBLITE_GPU_SHADER_DIR", '"shaders"'],
    ["BBLITE_VISUAL_CAPTURE", "1"],
    ["BBLITE_HAS_IMAGE_DECODER", "1"],
    ["BBLITE_HAS_ANIMATION", "1"],
    ["BBLITE_HAS_SPRITES", "1"],
    ["BBLITE_HAS_SPRITE_ANIMATION", "1"],
    ["BBLITE_HAS_SHADOWS", "1"],
    ["BBLITE_HAS_PICKING", "1"],
    ["BBLITE_HAS_GIZMOS", "1"],
    ["BBLITE_HAS_CAMERA_GIZMOS", "1"],
    ["BBLITE_HAS_LIGHT_GIZMOS", "1"],
]);

/** A compile's flags plus every fixture default its own flags leave unset. */
function withNativeFixtureMacroDefaults(
    arguments_: readonly string[],
): readonly string[] {
    if (!arguments_.some((argument) => /\.(?:cpp|cc|mm)$/i.test(argument)))
        return arguments_;
    const defined = new Set<string>();
    for (const [index, argument] of arguments_.entries()) {
        const spelled = /^[/-]D(\w*)/.exec(argument);
        if (!spelled) continue;
        const name =
            spelled[1] || /^\w+/.exec(arguments_[index + 1] ?? "")?.[0];
        if (name) defined.add(name);
    }
    return [
        ...[...nativeFixtureMacroDefaults]
            .filter(([name]) => !defined.has(name))
            .map(([name, value]) => `/D${name}=${value}`),
        ...arguments_,
    ];
}

export function runNativeFixtureCompiler(
    tools: WindowsBuildTools,
    arguments_: readonly string[],
): void {
    try {
        execFileSync(
            tools.compiler,
            withNativeFixtureMacroDefaults(arguments_),
            {
                cwd: resolve("."),
                env: tools.environment,
                stdio: "pipe",
            },
        );
    } catch (error) {
        const failure = error as Error & { stdout?: Buffer; stderr?: Buffer };
        throw new Error(
            `${failure.message}\n${failure.stdout?.toString() ?? ""}\n${failure.stderr?.toString() ?? ""}`,
            { cause: error },
        );
    }
}

/** Preserve object paths when distinct source folders contain equal basenames. */
export function buildNativeFixture(
    tools: WindowsBuildTools,
    sources: readonly string[],
    executable: string,
    flags: readonly string[],
): void {
    const objects = sources.map((source) => {
        const object = `${source}.obj`;
        runNativeFixtureCompiler(tools, [
            ...flags,
            "/c",
            source,
            `/Fo${object}`,
        ]);
        return object;
    });
    runNativeFixtureCompiler(tools, [
        "/nologo",
        ...objects,
        `/Fe${executable}`,
    ]);
}

/** Build a retained-UI fixture against the same pinned library and platform fonts. */
export function runRmlUiFixture(
    t: TestContext,
    name: string,
    options: {
        imageDecoder?: boolean;
        includeDirectories?: readonly string[];
    } = {},
): void {
    const tools = optionalNativeFixtureTools();
    const rml = resolve(
        process.env.BBLITE_RMLUI_DIR ?? "artifacts/tools/rmlui",
    );
    if (!tools || !existsSync(join(rml, "lib/rmlui.lib"))) {
        t.skip("The native compiler and pinned RmlUi library are required.");
        return;
    }
    const output = resolve("artifacts", name);
    mkdirSync(output, { recursive: true });
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        "/O2",
        "/Gy",
        "/DBBLITE_HAS_UI=1",
        `/DBBLITE_HAS_IMAGE_DECODER=${options.imageDecoder ? 1 : 0}`,
        "/DRMLUI_STATIC_LIB",
        "/DRMLUI_SDL_VERSION_MAJOR=3",
        `/Fo:${output}/`,
        `/Fe:${executable}`,
        "/I",
        "native/include",
        "/I",
        "native/src",
        ...(options.includeDirectories ?? []).flatMap((path) => ["/I", path]),
        `/external:I${join(rml, "include")}`,
        `/external:I${join(rml, "Backends")}`,
        `/external:I${join(nativeFixtureVcpkgRoot, "include")}`,
        "/external:W0",
        `test/fixtures/${name}-check.cpp`,
        "native/src/pal_system_fonts.cpp",
        ...(options.imageDecoder ? ["native/src/pal_image.cpp"] : []),
        join(rml, "Backends/RmlUi_Platform_SDL.cpp"),
        "/link",
        "/OPT:REF",
        join(rml, "lib/rmlui.lib"),
        join(nativeFixtureVcpkgRoot, "lib/freetype.lib"),
        join(nativeFixtureVcpkgRoot, "lib/lunasvg.lib"),
        join(nativeFixtureVcpkgRoot, "lib/SDL3.lib"),
        ...(options.imageDecoder
            ? [join(nativeFixtureVcpkgRoot, "lib/SDL3_image.lib")]
            : []),
        "dwrite.lib",
        "user32.lib",
    ]);
    assert.equal(
        execFileSync(executable, {
            encoding: "utf8",
            env: {
                ...tools.environment,
                PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${tools.environment.PATH ?? ""}`,
            },
        }),
        "",
    );
}
