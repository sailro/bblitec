import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { EOL } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    hostOfflineShaderTarget,
    type OfflineShaderTarget,
} from "./build-options.js";
import {
    discoverDevelopmentTools,
    type DevelopmentTools,
} from "./development-tools.js";
import {
    compiledShaderArtifactExtensions,
    GeneratedTree,
    isCompiledShaderOutput,
} from "./generated-tree.js";
import {
    contentDigest,
    hashEntries,
    writeJsonRecord,
} from "./tooling/records.js";
import {
    assertReflectedBindings,
    assertUniformBufferCap,
    parseStageLayoutRecord,
    prepareSdlUniformAdaptation,
    sdlUniformSource,
    type SdlUniformAdaptation,
} from "./shader-bindings.js";
import {
    readShaderComposition,
    shaderStageConstants,
    type OfflineShaderStage,
} from "./shader-composition.js";
import { isMainModule, parseFlags } from "./tooling/flags.js";
import { repositoryModuleClosure } from "./bake-cache.js";

/**
 * The offline shader compiler. bblite-tint (tools/tint-sdl) compiles each
 * declared stage of a `.native.wgsl` module with the pinned Tint and emits its
 * HLSL, MSL and SPIR-V already addressed at SDL_GPU's slots, with the `.slots`
 * sidecar the native loader reads; DXC compiles the HLSL to DXIL.
 */

/** DXC's DXIL product: the one binary bblite-tint does not write. */
const dxil = {
    extension: ".dxil",
    flags: ["-O3"],
    magic: [0x44, 0x58, 0x42, 0x43],
} as const;

/** bblite-tint's option writing each of its products. */
const tintProductOptions: ReadonlyMap<string, string> = new Map([
    [".hlsl", "--hlsl"],
    [".msl", "--msl"],
    [".spv", "--spirv"],
    [".demote.spv", "--spirv-demote"],
    [".slots", "--slots"],
]);

export interface OfflineShaderFormats {
    /** bblite-tint's products (`.demote.spv` for fragment stages only). */
    tint: string[];
    /** Whether DXC compiles each stage's HLSL to DXIL. */
    dxil: boolean;
}

export function offlineShaderFormats(
    target: OfflineShaderTarget,
): OfflineShaderFormats {
    const metal = target === "metal" || target === "all";
    const vulkan = target === "vulkan" || target === "all";
    return {
        tint: compiledShaderArtifactExtensions.filter((extension) =>
            extension === dxil.extension
                ? false
                : extension === ".msl"
                  ? metal
                  : extension === ".spv" || extension === ".demote.spv"
                    ? vulkan
                    : true,
        ),
        dxil: target === "d3d12" || target === "all",
    };
}

type StageKind = "vertex" | "fragment" | "compute";

function stageKind(stem: string): StageKind {
    return stem.endsWith(".comp")
        ? "compute"
        : stem.endsWith(".vert")
          ? "vertex"
          : "fragment";
}

export interface ShaderCompilationOptions {
    directories: readonly string[];
    repositoryRoot?: string;
    target?: OfflineShaderTarget;
    tools?: Pick<DevelopmentTools, "dxc" | "bbliteTint">;
    environment?: NodeJS.ProcessEnv;
    cold?: boolean;
}

export interface ShaderCompilationResult {
    compiled: number;
    reused: number;
    tintCompiled: number;
    tintReused: number;
    directoriesCompiled: number;
    directoriesReused: number;
}

function sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

function digestUpper(path: string): string {
    return contentDigest(path).toUpperCase();
}

function shaderCompilerIdentity(): string {
    const entry = fileURLToPath(import.meta.url);
    const directory = dirname(entry);
    const closure = repositoryModuleClosure([entry], directory);
    if (!closure)
        throw new Error(
            "Cannot resolve the offline shader compiler's import closure.",
        );
    return hashEntries(
        closure
            .map(
                ({ path, source }) =>
                    `${relative(directory, path).replaceAll("\\", "/")}:${createHash("sha256").update(source).digest("hex")}`,
            )
            .sort(),
    );
}

function filesIn(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort();
}

export function generatedShaderDirectories(
    root: string,
    scene?: string,
): string[] {
    const generated = resolve(root, "generated");
    const directories =
        scene === undefined
            ? existsSync(generated)
                ? readdirSync(generated, { withFileTypes: true })
                      .filter((entry) => entry.isDirectory())
                      .map((entry) => entry.name)
                : []
            : [scene];
    return directories
        .map((name) => join(generated, name, "upstream", "shaders"))
        .filter(existsSync);
}

function runCompiler(
    executable: string,
    args: readonly string[],
    environment: NodeJS.ProcessEnv,
    source = args[0],
): { stdout: string; stderr: string } {
    const result = spawnSync(executable, args, {
        encoding: "utf8",
        env: environment,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(
            `${basename(executable)} failed (${result.status ?? result.signal}) for ${source}.\n${result.stderr}${result.stdout}`,
        );
    }
    return result;
}

function lines(text: string): string[] {
    if (text.length === 0) return [];
    const result = text.split(/\r?\n/);
    if (result.at(-1) === "") result.pop();
    return result;
}

function cacheArtifact(path: string, bytes: Uint8Array): void {
    const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`;
    try {
        writeFileSync(temporary, bytes);
        renameSync(temporary, path);
    } finally {
        rmSync(temporary, { force: true });
    }
}

function readValidDxil(path: string): Buffer | undefined {
    if (!existsSync(path)) return undefined;
    const bytes = readFileSync(path);
    return dxil.magic.every((byte, index) => bytes[index] === byte)
        ? bytes
        : undefined;
}

function directoryDigests(
    directory: string,
    stages: ReadonlyMap<string, OfflineShaderStage>,
): { input: string; output: string } {
    const inputs: string[] = [];
    const outputs: string[] = [];
    for (const name of filesIn(directory)) {
        const legacyHlsl =
            name.endsWith(".hlsl") &&
            !stages.has(name.slice(0, -".hlsl".length));
        const selected =
            !legacyHlsl && isCompiledShaderOutput(name) ? outputs : inputs;
        selected.push(`${name}:${contentDigest(join(directory, name))}`);
    }
    return { input: hashEntries(inputs), output: hashEntries(outputs) };
}

function directoryIsCurrent(
    path: string,
    input: string,
    output: string,
): boolean {
    if (!existsSync(path)) return false;
    let record: unknown;
    try {
        record = JSON.parse(readFileSync(path, "utf8"));
    } catch {
        return false;
    }
    return (
        typeof record === "object" &&
        record !== null &&
        "version" in record &&
        record.version === 1 &&
        "input" in record &&
        record.input === input &&
        "output" in record &&
        record.output === output
    );
}

/** Content caches serve stages; each directory records its complete input and output bytes. */
export function compileOfflineShaders(
    options: ShaderCompilationOptions,
): ShaderCompilationResult {
    const root = resolve(options.repositoryRoot ?? process.cwd());
    const environment = options.environment ?? process.env;
    const target =
        options.target ??
        hostOfflineShaderTarget(
            process.platform,
            environment.BBLITE_SHADER_TARGET,
        );
    const formats = offlineShaderFormats(target);
    const tools =
        options.tools ?? discoverDevelopmentTools({ cwd: root, environment });
    const directories = [
        ...new Set(options.directories.map((directory) => resolve(directory))),
    ].sort();
    if (directories.length === 0)
        throw new Error(
            "No generated shader directories found. Generate a scene first.",
        );
    const needsDxc = formats.dxil;
    if (needsDxc && (!tools.dxc || !existsSync(tools.dxc)))
        throw new Error(
            `DXC not found for target ${target}; install tools/shader-compiler or set DXC_PATH.`,
        );
    const dxcFiles =
        needsDxc && tools.dxc
            ? [
                  tools.dxc,
                  ...[
                      "dxcompiler.dll",
                      "dxil.dll",
                      "libdxcompiler.so",
                      "libdxil.so",
                  ].map((name) => join(dirname(tools.dxc!), name)),
              ]
                  .filter(existsSync)
                  .sort()
            : [];
    const compilerHash = sha256(
        dxcFiles
            .map((path) => `${basename(path)}:${digestUpper(path)}`)
            .join("|"),
    );
    const tint =
        tools.bbliteTint && existsSync(tools.bbliteTint)
            ? tools.bbliteTint
            : undefined;
    const tintHash = tint ? digestUpper(tint) : "";
    const dxcHash = needsDxc && tools.dxc ? digestUpper(tools.dxc) : "";
    const implementationHash = shaderCompilerIdentity();
    const pinPath = join(root, "upstream", "tint.json");
    const pinHash = existsSync(pinPath) ? contentDigest(pinPath) : "missing";
    const sharedInput = hashEntries([
        target,
        compilerHash,
        tintHash,
        implementationHash,
        pinHash,
    ]);
    const cacheRoot = join(root, "artifacts", "shader-cache");
    mkdirSync(cacheRoot, { recursive: true });
    const result: ShaderCompilationResult = {
        compiled: 0,
        reused: 0,
        tintCompiled: 0,
        tintReused: 0,
        directoriesCompiled: 0,
        directoriesReused: 0,
    };

    for (const directory of directories) {
        const stages = readShaderComposition(directory);
        const current = directoryDigests(directory, stages);
        const input = hashEntries([sharedInput, current.input]);
        const checkpointPath = join(
            cacheRoot,
            "directories",
            `${sha256(directory)}.json`,
        );
        if (
            !options.cold &&
            directoryIsCurrent(checkpointPath, input, current.output)
        ) {
            result.directoriesReused++;
            continue;
        }
        const tree = new GeneratedTree(directory);
        const selectedExtensions = new Set([
            ...formats.tint,
            ...(formats.dxil ? [dxil.extension] : []),
        ]);
        for (const name of filesIn(directory)) {
            const extension = compiledShaderArtifactExtensions.find(
                (extension) => name.endsWith(extension),
            );
            if (
                extension &&
                (!selectedExtensions.has(extension) ||
                    name.endsWith(".vert.demote.spv") ||
                    name.endsWith(".comp.demote.spv"))
            )
                rmSync(join(directory, name));
        }
        const nativeSources = filesIn(directory).filter((name) =>
            name.endsWith(".native.wgsl"),
        );
        const bySource = new Map<string, OfflineShaderStage[]>();
        for (const stage of stages.values()) {
            const sourceStages = bySource.get(stage.sourceName) ?? [];
            sourceStages.push(stage);
            bySource.set(stage.sourceName, sourceStages);
        }
        for (const name of nativeSources) {
            const source = join(directory, name);
            const sourceStages = bySource.get(name);
            if (!sourceStages)
                throw new Error(
                    `${source} is not declared in composition.json.`,
                );
            if (!tint)
                throw new Error(
                    "Reached WGSL requires bblite-tint; run tools/build-tint.ps1 or set BBLITE_TINT_PATH.",
                );
            let wgsl: string | undefined;
            let uniformAdaptation: SdlUniformAdaptation | undefined;
            for (const stage of sourceStages) {
                const kind = stageKind(stage.stem);
                // A native module's stages share one interstage structure
                // whose position both read: placing it first lets a D3D12
                // fragment read a prefix of the vertex locations. A pinned
                // fragment that omits the position keeps Tint's order.
                const positionFirst =
                    !stage.pinnedBindings && kind !== "compute";
                const products = formats.tint.filter(
                    (extension) =>
                        extension !== ".demote.spv" || kind === "fragment",
                );
                const constants = shaderStageConstants(stage);
                const key = sha256(
                    `tint:${tintHash}|script:${implementationHash}|entry:${stage.entryPoint}|stage:${kind}|positionFirst:${positionFirst}|constants:${constants}|formats:${products.join(",")}|wgsl:${digestUpper(source)}`,
                );
                const cacheBase = join(cacheRoot, `tint-${key}`);
                if (
                    products.every((extension) =>
                        existsSync(`${cacheBase}${extension}`),
                    )
                ) {
                    for (const extension of products)
                        tree.write(
                            `${stage.stem}${extension}`,
                            readFileSync(`${cacheBase}${extension}`),
                        );
                    result.tintReused++;
                    continue;
                }
                const outputBase = join(directory, stage.stem);
                const pending = (extension: string): string =>
                    `${outputBase}${extension}.pending`;
                const pendingLayout = pending(".layout.json");
                const pendingWgsl = pending(".sdl.wgsl");
                const written = products.flatMap((extension) => {
                    const option = tintProductOptions.get(extension);
                    return option ? [{ extension, option }] : [];
                });
                const compile = (input: string) =>
                    runCompiler(
                        tint,
                        [
                            input,
                            "--display-name",
                            "source.wgsl",
                            "--entry-point",
                            stage.entryPoint,
                            "--stage",
                            kind,
                            ...(positionFirst ? ["--position-first"] : []),
                            ...(constants ? ["--overrides", constants] : []),
                            ...written.flatMap(({ extension, option }) => [
                                option,
                                pending(extension),
                            ]),
                            "--layout-json",
                            pendingLayout,
                        ],
                        environment,
                        source,
                    );
                try {
                    if (wgsl === undefined) {
                        wgsl = readFileSync(source, "utf8");
                        uniformAdaptation = prepareSdlUniformAdaptation(wgsl);
                    }
                    const reflection = compile(source);
                    const layoutRecord = parseStageLayoutRecord(
                        readFileSync(pendingLayout, "utf8"),
                        source,
                    );
                    if (!stage.pinnedBindings)
                        assertReflectedBindings(
                            wgsl,
                            layoutRecord.bindings,
                            source,
                        );
                    const adapted = sdlUniformSource(
                        uniformAdaptation,
                        layoutRecord.uniformBuffers,
                        source,
                    );
                    if (adapted !== undefined) {
                        writeFileSync(pendingWgsl, `${adapted}${EOL}`);
                        compile(pendingWgsl);
                        assertUniformBufferCap(
                            parseStageLayoutRecord(
                                readFileSync(pendingLayout, "utf8"),
                                source,
                            ).uniformBuffers,
                            `${source} (after SDL uniform adaptation)`,
                        );
                    }
                    for (const { extension } of written)
                        tree.write(
                            `${stage.stem}${extension}`,
                            readFileSync(pending(extension)),
                        );
                    // The reflection record: Tint's diagnostics for the
                    // module, then every entry point's bindings.
                    tree.write(
                        `${stage.stem}.tint-reflection.txt`,
                        `${[...lines(reflection.stderr), ...lines(reflection.stdout)].join(EOL)}${EOL}`,
                    );
                    for (const extension of products)
                        cacheArtifact(
                            `${cacheBase}${extension}`,
                            readFileSync(`${outputBase}${extension}`),
                        );
                    result.tintCompiled++;
                } finally {
                    for (const temporary of [
                        ...written.map(({ extension }) => pending(extension)),
                        pendingLayout,
                        pendingWgsl,
                    ])
                        rmSync(temporary, { force: true });
                }
            }
        }
        if (needsDxc) {
            for (const name of filesIn(directory).filter((name) =>
                name.endsWith(".hlsl"),
            )) {
                const source = join(directory, name);
                const stem = name.slice(0, -".hlsl".length);
                const profile = {
                    compute: "cs_6_0",
                    vertex: "vs_6_0",
                    fragment: "ps_6_0",
                }[stageKind(stem)];
                const entryPoint = stages.get(stem)?.entryPoint ?? "main";
                if (!tools.dxc)
                    throw new Error("DXC is required for DXIL shaders.");
                const key = sha256(
                    `${compilerHash}|dxil|${profile}|${entryPoint}|${dxil.flags.join(",")}|${digestUpper(source)}`,
                );
                const cachePath = join(cacheRoot, `${key}${dxil.extension}`);
                let binary = readValidDxil(cachePath);
                if (binary) {
                    result.reused++;
                } else {
                    const temporary = `${cachePath}.${process.pid}-${randomUUID()}.tmp`;
                    try {
                        runCompiler(
                            tools.dxc,
                            [
                                "-T",
                                profile,
                                "-E",
                                entryPoint,
                                ...dxil.flags,
                                "-Fo",
                                temporary,
                                source,
                            ],
                            environment,
                            source,
                        );
                        binary = readValidDxil(temporary);
                        if (!binary)
                            throw new Error(
                                `DXC produced an invalid DXIL binary for ${source}.`,
                            );
                        renameSync(temporary, cachePath);
                    } finally {
                        rmSync(temporary, { force: true });
                    }
                    result.compiled++;
                }
                tree.write(`${stem}${dxil.extension}`, binary);
            }
        }
        let tintCommit: string | undefined;
        if (nativeSources.length > 0) {
            const pin: unknown = JSON.parse(readFileSync(pinPath, "utf8"));
            if (
                typeof pin !== "object" ||
                pin === null ||
                !("commit" in pin) ||
                typeof pin.commit !== "string"
            )
                throw new Error(`${pinPath} must declare a Tint commit.`);
            tintCommit = pin.commit;
        }
        const record = {
            backend: nativeSources.length > 0 ? "tint-wgsl" : "dxc-hlsl",
            target,
            ...(tintCommit === undefined
                ? {}
                : { tintCommit, bbliteTintSha256: tintHash }),
            ...(needsDxc ? { dxcCompilerSha256: dxcHash } : {}),
        };
        tree.write(
            "shader-compiler.json",
            `${JSON.stringify(record, null, 2).replaceAll("\n", EOL)}${EOL}`,
        );
        writeJsonRecord(checkpointPath, {
            version: 1,
            input,
            output: directoryDigests(directory, stages).output,
        });
        result.directoriesCompiled++;
    }
    return result;
}

export function formatShaderCompilation(
    result: ShaderCompilationResult,
): string {
    return (
        `Shader directories: ${result.directoriesCompiled} compiled, ${result.directoriesReused} unchanged.\n` +
        `bblite-tint stages: ${result.tintCompiled} compiled, ${result.tintReused} replayed from artifacts/shader-cache.\n` +
        `DXC stages: ${result.compiled} compiled, ${result.reused} replayed from artifacts/shader-cache.`
    );
}

if (isMainModule(import.meta.url)) {
    try {
        const flags = parseFlags(
            process.argv.slice(2),
            {
                value: ["--scene", "--target", "--dxc", "--bblite-tint"],
                boolean: ["--cold"],
            },
            "shaders",
        );
        const environment = { ...process.env };
        for (const [flag, variable] of [
            ["--dxc", "DXC_PATH"],
            ["--bblite-tint", "BBLITE_TINT_PATH"],
        ] as const) {
            const value = flags.values.get(flag);
            if (value !== undefined) environment[variable] = value;
        }
        console.log(
            formatShaderCompilation(
                compileOfflineShaders({
                    directories: generatedShaderDirectories(
                        process.cwd(),
                        flags.values.get("--scene"),
                    ),
                    target: hostOfflineShaderTarget(
                        process.platform,
                        flags.values.get("--target") ??
                            environment.BBLITE_SHADER_TARGET,
                    ),
                    environment,
                    cold: flags.flags.has("--cold"),
                }),
            ),
        );
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
