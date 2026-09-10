import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { EOL } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hostOfflineShaderTarget, type OfflineShaderTarget } from "./build-options.js";
import { discoverDevelopmentTools, type DevelopmentTools } from "./development-tools.js";
import { compiledShaderArtifactExtensions, GeneratedTree } from "./generated-tree.js";
import { contentDigest, hashEntries, isCompiledShaderOutput, writeJsonRecord } from "./validation-resume.js";
import { assertReflectedBindings, assertUniformBufferCap, prepareSdlUniformAdaptation, sdlUniformSource,
    normalizeTintHlslBindings, remapPinnedVariantRegisters, shaderStageSlots, type SdlUniformAdaptation } from "./shader-bindings.js";
import { readShaderComposition, shaderStageConstants, type OfflineShaderStage } from "./shader-composition.js";
import { isMainModule, parseFlags } from "./tooling/flags.js";
import { repositoryModuleClosure } from "./bake-cache.js";

interface BinaryFormat {
    kind: "dxil" | "spirv";
    extension: ".dxil" | ".spv";
    flags: readonly string[];
    magic: readonly number[];
}

const binaryFormats: readonly BinaryFormat[] = [
    { kind: "dxil", extension: ".dxil", flags: ["-O3"], magic: [0x44, 0x58, 0x42, 0x43] },
    { kind: "spirv", extension: ".spv", flags: ["-spirv", "-fspv-target-env=vulkan1.0", "-O3"], magic: [3, 2, 0x23, 7] },
];

export function offlineShaderFormats(target: OfflineShaderTarget): { tint: string[]; binaries: readonly BinaryFormat[] } {
    return {
        tint: compiledShaderArtifactExtensions.filter(extension =>
            !binaryFormats.some(format => format.extension === extension) &&
            (extension !== ".msl" || target === "metal" || target === "all")),
        binaries: binaryFormats.filter(format => target === "all" || (format.kind === "dxil" ? target === "d3d12" : target === "vulkan")),
    };
}

export interface ShaderCompilationOptions {
    directories: readonly string[];
    repositoryRoot?: string;
    target?: OfflineShaderTarget;
    tools?: Pick<DevelopmentTools, "dxc" | "tint">;
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
    if (!closure) throw new Error("Cannot resolve the offline shader compiler's import closure.");
    return hashEntries(closure.map(({ path, source }) =>
        `${relative(directory, path).replaceAll("\\", "/")}:${createHash("sha256").update(source).digest("hex")}`).sort());
}

function filesIn(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => entry.name).sort();
}

export function generatedShaderDirectories(root: string, scene?: string): string[] {
    const generated = resolve(root, "generated");
    const directories = scene === undefined
        ? (existsSync(generated) ? readdirSync(generated, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name) : [])
        : [scene];
    return directories.map(name => join(generated, name, "upstream", "shaders")).filter(existsSync);
}

function runCompiler(executable: string, args: readonly string[], environment: NodeJS.ProcessEnv): { stdout: string; stderr: string } {
    const result = spawnSync(executable, args, { encoding: "utf8", env: environment, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`${basename(executable)} failed (${result.status ?? result.signal}) for ${args[0]}.\n${result.stderr}${result.stdout}`);
    }
    return result;
}

function lines(text: string): string[] {
    if (text.length === 0) return [];
    const result = text.split(/\r?\n/);
    if (result.at(-1) === "") result.pop();
    return result;
}

function reflectionText(source: string, stdout: string, stderr: string): string {
    const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return [...lines(stderr), ...lines(stdout)].join(EOL).replace(new RegExp(`^${escaped}(?=:\\d+:\\d+ )`, "gm"), "source.wgsl");
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

function readValidBinary(path: string, format: BinaryFormat): Buffer | undefined {
    if (!existsSync(path)) return undefined;
    const bytes = readFileSync(path);
    return format.magic.every((byte, index) => bytes[index] === byte) ? bytes : undefined;
}

function directoryDigests(directory: string, stages: ReadonlyMap<string, OfflineShaderStage>): { input: string; output: string } {
    const inputs: string[] = [];
    const outputs: string[] = [];
    for (const name of filesIn(directory)) {
        const legacyHlsl = name.endsWith(".hlsl") && !stages.has(name.slice(0, -".hlsl".length));
        const selected = !legacyHlsl && isCompiledShaderOutput(name) ? outputs : inputs;
        selected.push(`${name}:${contentDigest(join(directory, name))}`);
    }
    return { input: hashEntries(inputs), output: hashEntries(outputs) };
}

function directoryIsCurrent(path: string, input: string, output: string): boolean {
    if (!existsSync(path)) return false;
    let record: unknown;
    try { record = JSON.parse(readFileSync(path, "utf8")); } catch { return false; }
    return typeof record === "object" && record !== null && "version" in record && record.version === 1 &&
        "input" in record && record.input === input && "output" in record && record.output === output;
}

/** Content caches serve stages; each directory records its complete input and output bytes. */
export function compileOfflineShaders(options: ShaderCompilationOptions): ShaderCompilationResult {
    const root = resolve(options.repositoryRoot ?? process.cwd());
    const environment = options.environment ?? process.env;
    const target = options.target ?? hostOfflineShaderTarget(process.platform, environment.BBLITE_SHADER_TARGET);
    const formats = offlineShaderFormats(target);
    const tools = options.tools ?? discoverDevelopmentTools({ cwd: root, environment });
    const directories = [...new Set(options.directories.map(directory => resolve(directory)))].sort();
    if (directories.length === 0) throw new Error("No generated shader directories found. Generate a scene first.");
    const needsDxc = formats.binaries.length > 0;
    if (needsDxc && (!tools.dxc || !existsSync(tools.dxc))) throw new Error(`DXC not found for target ${target}; install tools/shader-compiler or set DXC_PATH.`);
    const dxcFiles = needsDxc && tools.dxc
        ? [tools.dxc, ...["dxcompiler.dll", "dxil.dll"].map(name => join(dirname(tools.dxc!), name))].filter(existsSync).sort() : [];
    const compilerHash = sha256(dxcFiles.map(path => `${basename(path)}:${digestUpper(path)}`).join("|"));
    const tintHash = tools.tint && existsSync(tools.tint) ? digestUpper(tools.tint) : "";
    const dxcHash = needsDxc && tools.dxc ? digestUpper(tools.dxc) : "";
    const implementationHash = shaderCompilerIdentity();
    const pinPath = join(root, "upstream", "tint.json");
    const pinHash = existsSync(pinPath) ? contentDigest(pinPath) : "missing";
    const sharedInput = hashEntries([target, compilerHash, tintHash, implementationHash, pinHash]);
    const cacheRoot = join(root, "artifacts", "shader-cache");
    mkdirSync(cacheRoot, { recursive: true });
    const result: ShaderCompilationResult = { compiled: 0, reused: 0, tintCompiled: 0, tintReused: 0, directoriesCompiled: 0, directoriesReused: 0 };

    for (const directory of directories) {
        const stages = readShaderComposition(directory);
        const current = directoryDigests(directory, stages);
        const input = hashEntries([sharedInput, current.input]);
        const checkpointPath = join(cacheRoot, "directories", `${sha256(directory)}.json`);
        if (!options.cold && directoryIsCurrent(checkpointPath, input, current.output)) {
            result.directoriesReused++;
            continue;
        }
        const tree = new GeneratedTree(directory);
        const selectedExtensions = new Set([...formats.tint, ...formats.binaries.map(format => format.extension)]);
        for (const name of filesIn(directory)) {
            const extension = compiledShaderArtifactExtensions.find(extension => name.endsWith(extension));
            if (extension && !selectedExtensions.has(extension)) rmSync(join(directory, name));
        }
        const nativeSources = filesIn(directory).filter(name => name.endsWith(".native.wgsl"));
        const bySource = new Map<string, OfflineShaderStage[]>();
        for (const stage of stages.values()) {
            const sourceStages = bySource.get(stage.sourceName) ?? [];
            sourceStages.push(stage);
            bySource.set(stage.sourceName, sourceStages);
        }
        for (const name of nativeSources) {
            const source = join(directory, name);
            const sourceStages = bySource.get(name);
            if (!sourceStages) throw new Error(`${source} is not declared in composition.json.`);
            if (!tools.tint || !tintHash) throw new Error("Reached WGSL requires pinned Tint; run tools/build-tint.ps1 or set TINT_PATH.");
            let wgsl: string | undefined;
            let uniformAdaptation: SdlUniformAdaptation | undefined;
            for (const stage of sourceStages) {
                const vertex = stage.stem.endsWith(".vert");
                const constants = shaderStageConstants(stage);
                const key = sha256(`tint:${tintHash}|script:${implementationHash}|entry:${stage.entryPoint}|pinned:${stage.pinnedBindings}|vertex:${vertex}|constants:${constants}|formats:${formats.tint.join(",")}|wgsl:${digestUpper(source)}`);
                const cacheBase = join(cacheRoot, `tint-${key}`);
                if (formats.tint.every(extension => existsSync(`${cacheBase}${extension}`))) {
                    for (const extension of formats.tint) tree.write(`${stage.stem}${extension}`, readFileSync(`${cacheBase}${extension}`));
                    result.tintReused++;
                    continue;
                }
                const outputBase = join(directory, stage.stem);
                const pendingHlsl = `${outputBase}.pending-hlsl`;
                const pendingMsl = `${outputBase}.pending-msl`;
                const pendingWgsl = `${outputBase}.pending-sdl.wgsl`;
                const stageArgs = ["--entry-point", stage.entryPoint, ...(constants ? ["--overrides", constants] : [])];
                try {
                    if (wgsl === undefined) {
                        wgsl = readFileSync(source, "utf8");
                        uniformAdaptation = prepareSdlUniformAdaptation(wgsl);
                    }
                    const reflection = runCompiler(tools.tint, [source, ...stageArgs, "--format", "hlsl", "--output-name", pendingHlsl, "--dump-inspector-bindings", "true"], environment);
                    const reflected = reflectionText(source, reflection.stdout, reflection.stderr);
                    if (!stage.pinnedBindings) assertReflectedBindings(wgsl, reflected, source);
                    let sdlSource = source;
                    let hlsl = readFileSync(pendingHlsl, "utf8");
                    const adapted = sdlUniformSource(uniformAdaptation, hlsl, source);
                    if (adapted !== undefined) {
                        sdlSource = pendingWgsl;
                        writeFileSync(sdlSource, `${adapted}${EOL}`);
                        runCompiler(tools.tint, [sdlSource, ...stageArgs, "--format", "hlsl", "--output-name", pendingHlsl], environment);
                        hlsl = readFileSync(pendingHlsl, "utf8");
                        assertUniformBufferCap(hlsl, `${source} (after SDL uniform adaptation)`);
                    }
                    const normalized = stage.pinnedBindings ? remapPinnedVariantRegisters(hlsl, vertex) : normalizeTintHlslBindings(hlsl);
                    tree.write(`${stage.stem}.hlsl`, `${normalized}${EOL}`);
                    tree.write(`${stage.stem}.slots`, `${shaderStageSlots(normalized).map(slot => `${slot.kind}${slot.index} ${slot.name}`).join(EOL)}${EOL}`);
                    tree.write(`${stage.stem}.tint-reflection.txt`, `${reflected}${EOL}`);
                    if (formats.tint.includes(".msl")) {
                        runCompiler(tools.tint, [sdlSource, ...stageArgs, "--format", "msl", "--output-name", pendingMsl], environment);
                        tree.write(`${stage.stem}.msl`, readFileSync(pendingMsl));
                    }
                    for (const extension of formats.tint) cacheArtifact(`${cacheBase}${extension}`, readFileSync(`${outputBase}${extension}`));
                    result.tintCompiled++;
                } finally {
                    for (const temporary of [pendingHlsl, pendingMsl, pendingWgsl]) rmSync(temporary, { force: true });
                }
            }
        }
        for (const name of filesIn(directory).filter(name => name.endsWith(".hlsl"))) {
            const source = join(directory, name);
            const stem = name.slice(0, -".hlsl".length);
            const profile = stem.endsWith(".vert") ? "vs_6_0" : "ps_6_0";
            const entryPoint = stages.get(stem)?.entryPoint ?? "main";
            assertUniformBufferCap(readFileSync(source, "utf8"), source);
            let compiled = false;
            for (const format of formats.binaries) {
                if (!tools.dxc) throw new Error("DXC is required for binary shader formats.");
                const key = sha256(`${compilerHash}|${format.kind}|${profile}|${entryPoint}|${format.flags.join(",")}|${digestUpper(source)}`);
                const cachePath = join(cacheRoot, `${key}${format.extension}`);
                let binary = readValidBinary(cachePath, format);
                if (!binary) {
                    const temporary = `${cachePath}.${process.pid}-${randomUUID()}.tmp`;
                    try {
                        const args = format.kind === "dxil" ? ["-T", profile, "-E", entryPoint, ...format.flags] : [...format.flags, "-T", profile, "-E", entryPoint];
                        runCompiler(tools.dxc, [...args, "-Fo", temporary, source], environment);
                        binary = readValidBinary(temporary, format);
                        if (!binary) throw new Error(`${format.kind} compiler produced an invalid binary for ${source}.`);
                        renameSync(temporary, cachePath);
                    } finally { rmSync(temporary, { force: true }); }
                    compiled = true;
                }
                tree.write(`${stem}${format.extension}`, binary);
            }
            if (needsDxc) {
                if (compiled) result.compiled++;
                else result.reused++;
            }
        }
        let tintCommit: string | undefined;
        if (nativeSources.length > 0) {
            const pin: unknown = JSON.parse(readFileSync(pinPath, "utf8"));
            if (typeof pin !== "object" || pin === null || !("commit" in pin) || typeof pin.commit !== "string") throw new Error(`${pinPath} must declare a Tint commit.`);
            tintCommit = pin.commit;
        }
        const record = { backend: nativeSources.length > 0 ? "tint-wgsl" : "dxc-hlsl", target,
            ...(tintCommit === undefined ? {} : { tintCommit, tintSha256: tintHash }),
            ...(needsDxc ? { dxcCompilerSha256: dxcHash } : {}) };
        tree.write("shader-compiler.json", `${JSON.stringify(record, null, 2).replaceAll("\n", EOL)}${EOL}`);
        writeJsonRecord(checkpointPath, { version: 1, input, output: directoryDigests(directory, stages).output });
        result.directoriesCompiled++;
    }
    return result;
}

export function formatShaderCompilation(result: ShaderCompilationResult): string {
    return `Shader directories: ${result.directoriesCompiled} compiled, ${result.directoriesReused} unchanged.\n` +
        `Tint stages: ${result.tintCompiled} transpiled, ${result.tintReused} replayed from artifacts/shader-cache.\n` +
        `DXC stages: ${result.compiled} compiled, ${result.reused} replayed from artifacts/shader-cache.`;
}

if (isMainModule(import.meta.url)) {
    try {
        const flags = parseFlags(process.argv.slice(2), {
            value: ["--scene", "--target", "--dxc", "--tint"], boolean: ["--cold"],
        }, "shaders");
        const environment = { ...process.env };
        for (const [flag, variable] of [["--dxc", "DXC_PATH"], ["--tint", "TINT_PATH"]] as const) {
            const value = flags.values.get(flag);
            if (value !== undefined) environment[variable] = value;
        }
        console.log(formatShaderCompilation(compileOfflineShaders({
            directories: generatedShaderDirectories(process.cwd(), flags.values.get("--scene")),
            target: hostOfflineShaderTarget(process.platform, flags.values.get("--target") ?? environment.BBLITE_SHADER_TARGET),
            environment,
            cold: flags.flags.has("--cold"),
        })));
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
