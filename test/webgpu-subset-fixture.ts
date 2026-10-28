/**
 * What the WebGPU-subset fixtures share: a lowered library's run-time WGSL
 * compiled for SDL_GPU, the Dawn build they link and their result lines.
 */
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { compileOfflineShaders } from "../src/compile-shaders.js";
import { discoverDevelopmentTools } from "../src/development-tools.js";
import { sharedPinnedContext } from "../src/lowering/context.js";
import {
    pinnedRawShaderImports,
    runtimeWgslModules,
} from "../src/lowering/library-shaders.js";
import {
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runFixtureExecutable,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

/**
 * A lowered library's run-time WGSL as SDL_GPU deploys it (`runtimeWgslModules`):
 * each module's every stage, compiled under the name its text and entry
 * point give it (`wgslStageStem`).
 */
export async function compileLibraryShaders(
    root: string,
    modules: readonly string[],
): Promise<string> {
    const directory = join(root, "generated/library/upstream/shaders");
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory, { recursive: true });
    mkdirSync(join(root, "upstream"), { recursive: true });
    copyFileSync("upstream/tint.json", join(root, "upstream/tint.json"));
    const compiled = runtimeWgslModules(
        pinnedRawShaderImports(sharedPinnedContext(), modules),
    ).map(({ output, data, entryPoint, alsoStages }) => {
        writeFileSync(join(directory, basename(output)), data);
        return {
            output: basename(output),
            entryPoint,
            pinnedBindings: true,
            alsoStages,
        };
    });
    writeFileSync(
        join(directory, "composition.json"),
        JSON.stringify({ modules: compiled }),
    );
    await compileOfflineShaders({
        directories: [directory],
        repositoryRoot: root,
        target: "d3d12",
        tools: discoverDevelopmentTools(),
    });
    return directory;
}

/** The Dawn build the fixtures link. */
export const dawnRoot = resolve("artifacts/tools/dawn");

/** One backend's fixture build: its sources, includes and defines, and its run's arguments. */
export interface WebGpuFixture {
    readonly output: string;
    readonly sources: readonly string[];
    readonly includes: readonly string[];
    readonly defines?: readonly string[];
    readonly libraries?: readonly string[];
    readonly args?: readonly string[];
    /** SDL_GPU's compiled stages (`compileLibraryShaders`). */
    readonly shaders?: string | undefined;
    readonly timeoutMs?: number;
}

/**
 * A WebGPU-subset fixture built and run on one backend: Dawn links its own
 * build, SDL_GPU the vcpkg SDL and the compiled stages; undefined where the
 * backend's tools are absent. Returns its result lines.
 */
export function runWebGpuFixture(
    backend: "dawn" | "sdl",
    fixture: WebGpuFixture,
): Map<string, string> | undefined {
    const tools = optionalNativeFixtureTools(false);
    if (
        !tools ||
        (backend === "dawn" &&
            !existsSync(join(dawnRoot, "lib/webgpu_dawn.lib")))
    )
        return undefined;
    mkdirSync(fixture.output, { recursive: true });
    const executable = join(fixture.output, "check.exe");
    const dawn = backend === "dawn";
    runNativeFixtureCompiler(tools, [
        ...(fixture.defines ?? []),
        ...(dawn
            ? ["/DBBLITE_HAS_DAWN=1", `/external:I${join(dawnRoot, "include")}`]
            : ["/DBBLITE_VISUAL_CAPTURE=0"]),
        `/I${resolve("native/src")}`,
        `/I${resolve("test/fixtures/webgpu-subset")}`,
        ...fixture.includes.map((include) => `/I${include}`),
        `/Fo:${fixture.output}/`,
        `/Fe:${executable}`,
        ...fixture.sources,
        "/link",
        ...(dawn ? [join(dawnRoot, "lib/webgpu_dawn.lib")] : ["SDL3.lib"]),
        `/LIBPATH:${join(nativeFixtureVcpkgRoot, "lib")}`,
        ...(fixture.libraries ?? []),
    ]);
    return resultLines(
        runFixtureExecutable(executable, {
            args: fixture.args ?? [],
            timeoutMs: fixture.timeoutMs ?? 120000,
            env: {
                ...process.env,
                ...(fixture.shaders
                    ? { BBLITE_GPU_SHADER_DIR: fixture.shaders }
                    : {}),
                PATH: [
                    ...(dawn ? [join(dawnRoot, "bin")] : []),
                    join(nativeFixtureVcpkgRoot, "bin"),
                    process.env.PATH ?? "",
                ].join(";"),
            },
        }),
    );
}

/** The fixture's result lines, keyed by their first word. */
export function resultLines(output: string): Map<string, string> {
    const lines = new Map<string, string>();
    for (const line of output.split(/\r?\n/)) {
        const space = line.indexOf(" ");
        if (space > 0) lines.set(line.slice(0, space), line.slice(space + 1));
    }
    return lines;
}
