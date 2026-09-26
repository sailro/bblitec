import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { TestContext } from "node:test";

import type { Feature } from "../src/compiler/types.js";
import {
    discoverWindowsBuildTools,
    type WindowsBuildTools,
} from "../src/development-tools.js";
import {
    featureMacros,
    featureMacroValue,
    renderFeatureMacroHeaders,
    type FeatureMacroReach,
} from "../src/feature-macros.js";
import { developmentVcpkgInstall } from "../src/vcpkg-install.js";

/** The development vcpkg install for `triplet` (the one scene builds link against). */
export function developmentVcpkgRoot(triplet = "x64-windows"): string {
    return resolve(developmentVcpkgInstall().installedDirectory, triplet);
}

export const nativeFixtureVcpkgRoot = developmentVcpkgRoot();

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

/**
 * Isolate a function's declaration (through its `;`), which carries the
 * default arguments its out-of-line definition does not repeat.
 */
export function cppDeclaration(source: string, signature: string): string {
    let from = source.indexOf(signature);
    while (from >= 0) {
        let parameters = source.indexOf("(", from),
            depth = 1;
        while (depth && ++parameters < source.length) {
            if (source[parameters] === "(") ++depth;
            if (source[parameters] === ")") --depth;
        }
        const semicolon = source.indexOf(";", parameters),
            brace = source.indexOf("{", parameters);
        if (semicolon >= 0 && (brace < 0 || semicolon < brace))
            return source.slice(from, semicolon + 1);
        from = source.indexOf(signature, from + signature.length);
    }
    assert.fail(signature);
}

/**
 * The GPU backends' shared concerns as one text, in the order
 * their implementation units include them, then the units holding their bodies:
 * what a fixture that lifts the shared helpers by name reads, whichever
 * concern header or unit holds one.
 */
export function sharedGpuSource(): string {
    const units = sharedGpuUnits.map((unit) => readFileSync(unit, "utf8"));
    const headers = new Set(
        units.flatMap((source) =>
            [...source.matchAll(/^#include "(pal_gpu_\w+\.hpp)"/gm)].map(
                (match) => match[1]!,
            ),
        ),
    );
    return [
        ...[...headers].map((name) =>
            readFileSync(join("native/src", name), "utf8"),
        ),
        ...units,
    ].join("\n");
}

/** The feature families each scene renderer backend compiles as its own unit. */
const sceneRendererFamilies = [
    "meshes",
    "variants",
    "shadows",
    "textures",
    "targets",
    "post_process",
    "picking",
] as const;

/** A scene renderer backend's files: its state header, family units and driver. */
export function sceneBackendFiles(backend: "sdl" | "dawn"): string[] {
    const stem = backend === "sdl" ? "pal_sdl_gpu" : "pal_dawn";
    return [
        `native/src/${stem}_scene.hpp`,
        ...sceneRendererFamilies.map(
            (family) => `native/src/${stem}_scene_${family}.cpp`,
        ),
        `native/src/${stem}.cpp`,
    ];
}

/**
 * A scene renderer backend as one text, header first and driver last: what
 * a fixture that lifts the backend's code by name reads, whichever of its
 * units holds it.
 */
export function sceneBackendSource(backend: "sdl" | "dawn"): string {
    return sceneBackendFiles(backend)
        .map((file) => readFileSync(file, "utf8"))
        .join("\n");
}

/** The units holding the shared GPU helpers' bodies, for a fixture to link. */
const sharedGpuUnits = [
    "native/src/pal_gpu_frame.cpp",
    "native/src/pal_gpu_images.cpp",
    "native/src/pal_gpu_shared.cpp",
] as const;

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
 * The build a direct fixture stands for where its own flags are silent: the
 * scene runtime with animation, sprites, shadows, gizmos and image decoding,
 * visual capture, and the development asset and shader directories.
 *
 * As in the product build, build options are compile definitions and every
 * feature-keyed macro is a header rendered from the one table
 * (`src/feature-macros.ts`): 1 for the features below, and for each
 * `/D<macro>=0|1` a fixture passes, which the harness moves into the headers.
 */
const nativeFixtureBuildOptions: ReadonlyMap<string, string> = new Map([
    ["BBLITE_ASSET_DIR", '"assets"'],
    ["BBLITE_GPU_SHADER_DIR", '"shaders"'],
    ["BBLITE_VISUAL_CAPTURE", "1"],
    ["BBLITE_AUDIO_CAPTURE", "0"],
    ["BBLITE_CHECKED_HANDLES", "0"],
    ["BBLITE_HAS_SDL_GPU", "0"],
    ["BBLITE_HAS_DAWN", "0"],
    ["BBLITE_DAWN_DXC", "0"],
    ["BT_THREADSAFE", "1"],
]);
const nativeFixtureReach: FeatureMacroReach = {
    features: [
        "animation:property",
        "sprite:2d",
        "sprite:animation",
        "shadow:pcf",
        "gizmo:utility-layer",
        "gizmo:camera",
        "gizmo:light",
    ] satisfies Feature[],
    imageCodecs: ["png"],
};

/** Install roots whose headers are external, as imported targets are. */
const thirdPartyIncludeRoots = [
    nativeFixtureVcpkgRoot,
    resolve("artifacts/tools"),
].map((root) => `${root.toLowerCase()}\\`);

function isThirdPartyInclude(path: string): boolean {
    const resolved = `${resolve(path).toLowerCase()}\\`;
    return thirdPartyIncludeRoots.some((root) => resolved.startsWith(root));
}

/** The folder header that includes every macro header (`/FI`). */
const fixtureMacroPrelude = "bblite-fixture-features.hpp";

/**
 * The content-addressed folder holding every feature macro header at the
 * values given, and a prelude including all of them: a fixture compiles
 * slices of units whose own includes it does not carry, so every macro is
 * defined in every fixture unit, 0 or 1. Written once per value set.
 */
function fixtureMacroFolder(overrides: ReadonlyMap<string, boolean>): string {
    const macros = renderFeatureMacroHeaders(
        (row) =>
            overrides.get(row.macro) ??
            featureMacroValue(row, nativeFixtureReach),
    );
    const headers = new Map([
        ...macros,
        [
            fixtureMacroPrelude,
            `#pragma once\n${[...macros.keys()]
                .map((include) => `#include <${include}>\n`)
                .join("")}`,
        ],
    ]);
    const identity = createHash("sha256");
    for (const [include, text] of headers)
        identity.update(`${include}\n${text}`);
    const folder = resolve(
        "artifacts/native-fixture-macros",
        identity.digest("hex").slice(0, 16),
    );
    if (existsSync(join(folder, "complete"))) return folder;
    for (const [include, text] of headers) {
        const path = join(folder, include);
        if (existsSync(path)) continue;
        mkdirSync(dirname(path), { recursive: true });
        // Concurrent fixtures render the same bytes; a rename keeps a
        // reader from ever seeing a partial header.
        const temporary = `${path}.${process.pid}.tmp`;
        writeFileSync(temporary, text);
        try {
            renameSync(temporary, path);
        } catch (error) {
            // Another fixture may have published this immutable header while a
            // compiler opened it. Windows then refuses its replacement.
            if (!existsSync(path) || readFileSync(path, "utf8") !== text)
                throw error;
            rmSync(temporary);
        }
    }
    writeFileSync(join(folder, "complete"), "");
    return folder;
}

/**
 * A compile's flags as the product build would give them: the fixture's
 * feature macros as headers, the build options it leaves unset, third-party
 * headers external, and an undefined name in a `#if` an error.
 */
function nativeFixtureArguments(
    tools: WindowsBuildTools,
    arguments_: readonly string[],
): readonly string[] {
    if (!arguments_.some((argument) => /\.(?:cpp|cc|mm)$/i.test(argument)))
        return arguments_;
    const tableMacros = new Set(featureMacros.map((row) => row.macro));
    const overrides = new Map<string, boolean>();
    const defined = new Set<string>();
    const rest: string[] = [];
    for (let index = 0; index < arguments_.length; ++index) {
        const argument = arguments_[index]!;
        const definition = /^[/-]D(\w*)(?:=(.*))?$/.exec(argument);
        if (definition) {
            const [spelled, value] = definition[1]
                ? [definition[1], definition[2]]
                : (
                      /^(\w+)(?:=(.*))?$/.exec(arguments_[index + 1] ?? "") ??
                      []
                  ).slice(1, 3);
            if (spelled && tableMacros.has(spelled)) {
                if (value !== undefined && value !== "0" && value !== "1")
                    throw new Error(`${spelled} is 0 or 1, not '${value}'.`);
                overrides.set(spelled, value !== "0");
                if (!definition[1]) ++index;
                continue;
            }
            if (spelled) defined.add(spelled);
        }
        const include = /^[/-]I(.*)$/.exec(argument);
        if (include) {
            const path = include[1] || arguments_[index + 1];
            if (path !== undefined && isThirdPartyInclude(path)) {
                rest.push(`/external:I${path}`);
                if (!include[1]) ++index;
                continue;
            }
        }
        rest.push(argument);
    }
    const clang = /clang-cl(?:\.exe)?$/i.test(tools.compiler);
    const macroFolder = fixtureMacroFolder(overrides);
    return [
        `/I${macroFolder}`,
        `/FI${join(macroFolder, fixtureMacroPrelude)}`,
        ...[...nativeFixtureBuildOptions]
            .filter(([name]) => !defined.has(name))
            .map(([name, value]) => `/D${name}=${value}`),
        ...(clang
            ? [
                  "-Wundef",
                  "-Werror=undef",
                  "/DBT_USE_SSE",
                  "/DBT_NO_SIMD_OPERATOR_OVERLOADS",
              ]
            : ["/we4668", "/external:env:INCLUDE", "/external:W0"]),
        ...rest,
    ];
}

export function runNativeFixtureCompiler(
    tools: WindowsBuildTools,
    arguments_: readonly string[],
): void {
    try {
        execFileSync(
            tools.compiler,
            nativeFixtureArguments(tools, arguments_),
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

/**
 * Compiles one generated translation unit in `artifacts/<name>` and runs it:
 * a failed assertion or an uncaught throw in the program fails the caller.
 */
export function runGeneratedProgram(
    tools: WindowsBuildTools,
    name: string,
    cpp: string,
): void {
    const directory = resolve("artifacts", name);
    mkdirSync(directory, { recursive: true });
    const source = join(directory, "check.cpp"),
        executable = join(directory, "check.exe");
    writeFileSync(source, cpp);
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/permissive-",
        "/EHsc",
        "/MD",
        "/fp:precise",
        "/utf-8",
        "/I",
        "native/include",
        "/I",
        join(nativeFixtureVcpkgRoot, "include"),
        `/Fo:${directory}/`,
        `/Fe:${executable}`,
        source,
    ]);
    execFileSync(executable, { stdio: "pipe" });
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
        /** Feature macros and build options beyond the harness defaults. */
        macros?: Readonly<Record<string, 0 | 1>>;
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
        ...Object.entries(options.macros ?? {}).map(
            ([macro, value]) => `/D${macro}=${value}`,
        ),
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
