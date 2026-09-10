import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { compileOfflineShaders, offlineShaderFormats } from "../src/compile-shaders.js";
import { assertUniformBufferCap, demotableUniformBlocks, demoteUniformBlocks, normalizeTintHlslBindings,
    prepareSdlUniformAdaptation, remapPinnedVariantRegisters, sdlUniformSource, shaderStageSlots } from "../src/shader-bindings.js";
import { readShaderComposition, shaderStageConstants } from "../src/shader-composition.js";
import { discoverDevelopmentTools } from "../src/development-tools.js";
import { repositoryModuleClosure } from "../src/bake-cache.js";

const tools = discoverDevelopmentTools();

test("pinned registers order textures before storage and preserve uniform order across groups", () => {
    const source = `cbuffer cbuffer_mesh : register(b4, space1) {};
cbuffer cbuffer_scene : register(b8, space0) {};
ByteAddressBuffer morph : register(t1, space0);
Texture2D<float4> palette : register(t9, space1);
SamplerState paletteSampler : register(s12, space1);
Texture2D depth : register(t5, space0);
SamplerComparisonState depthSampler : register(s5, space0);`;
    for (const vertex of [true, false]) {
        const actual = remapPinnedVariantRegisters(source, vertex);
        assert.match(actual, new RegExp(`cbuffer_scene : register\\(b0, space${vertex ? 1 : 3}\\)`));
        assert.match(actual, new RegExp(`morph : register\\(t2, space${vertex ? 0 : 2}\\)`));
        assert.deepEqual(shaderStageSlots(actual), [
            { kind: "b", index: 0, name: "scene" }, { kind: "b", index: 1, name: "mesh" },
            { kind: "r", index: 0, name: "morph" },
            { kind: "s", index: 0, name: "depthSampler" }, { kind: "s", index: 1, name: "paletteSampler" },
            { kind: "t", index: 0, name: "depth" }, { kind: "t", index: 1, name: "palette" },
        ]);
    }
});

test("owned bindings compact per space and move position declarations with their aggregate values", () => {
    const source = `Texture2D<float4> color : register(t9, space2);
ByteAddressBuffer data : register(t7, space0);
struct main_outputs {
  float2 uv : TEXCOORD0;
  float4 p : SV_Position;
  uint layer : SV_RenderTargetArrayIndex;
};
main_outputs result = {uv, position, layer};
discard;`;
    const actual = normalizeTintHlslBindings(source);
    assert.match(actual, /struct main_outputs \{\n  float4 p : SV_Position;\n  float2 uv : TEXCOORD0;/);
    assert.match(actual, /result = \{position, uv, layer\};/);
    assert.match(actual, /clip\(-1\.0f\);/);
    assert.deepEqual(shaderStageSlots(actual), [
        { kind: "r", index: 0, name: "data" }, { kind: "t", index: 0, name: "color" },
    ]);
});

test("integer texture loads occupy SDL storage texture slots between sampled textures and buffers", () => {
    const source = `ByteAddressBuffer morph : register(t0, space2);
Texture2D<uint4> cells : register(t1, space2);
Texture2D<float4> color : register(t8, space2);
Texture2D<int4> signs : register(t5, space2);
SamplerState colorSampler : register(s8, space2);
uint4 value = cells.Load(int3(0, 0, 0));`;
    for (const actual of [normalizeTintHlslBindings(source), remapPinnedVariantRegisters(source, true), remapPinnedVariantRegisters(source, false)]) {
        assert.deepEqual(shaderStageSlots(actual), [
            { kind: "i", index: 0, name: "cells" }, { kind: "i", index: 1, name: "signs" },
            { kind: "r", index: 0, name: "morph" },
            { kind: "s", index: 0, name: "colorSampler" }, { kind: "t", index: 0, name: "color" },
        ]);
        assert.match(actual, /cells : register\(t1,/);
        assert.match(actual, /signs : register\(t2,/);
        assert.match(actual, /morph : register\(t3,/);
        assert.ok(actual.includes("uint4 value = cells.Load(int3(0, 0, 0));"));
    }
});

test("uniform adaptation admits only layout-compatible blocks and caps every stage", () => {
    const wgsl = `var<uniform> scene: Scene;
var<uniform> localProbeData: Probe;
var<uniform> gp: Params;
var<uniform> shadowInfo_0: Shadow;
var<uniform> csmInfo_1: Cascade;
var<uniform> nmeShadowParams: Node;`;
    const blocks = demotableUniformBlocks(wgsl);
    assert.deepEqual(blocks, ["localProbeData", "gp", "nmeShadowParams", "shadowInfo_0", "csmInfo_1"]);
    assert.equal(demoteUniformBlocks(wgsl, blocks), wgsl.replaceAll("var<uniform>", "var<storage, read>").replace("var<storage, read> scene", "var<uniform> scene"));
    const hlsl = ["scene", "lights", "mesh", "mat", "other"].map((name, index) => `cbuffer ${name}:register(b${index}) {}`).join("\n");
    assert.throws(() => assertUniformBufferCap(hlsl, "custom.frag"), /custom.frag binds 5.*scene, lights, mesh, mat, other/);
    assert.doesNotThrow(() => assertUniformBufferCap(hlsl.slice(0, hlsl.lastIndexOf("cbuffer")), "custom.frag"));
    assert.equal(sdlUniformSource(prepareSdlUniformAdaptation(wgsl), "", "local-probe.frag"), demoteUniformBlocks(wgsl, blocks));
    const params = "var<uniform> gp: Params;";
    assert.equal(sdlUniformSource(prepareSdlUniformAdaptation(params), "", "params.frag"), undefined);
    assert.equal(sdlUniformSource(prepareSdlUniformAdaptation(params), hlsl, "params.frag"), "var<storage, read> gp: Params;");
});

test("offline targets select only their executable format", () => {
    for (const [target, binaries, metal] of [
        ["d3d12", [".dxil"], false], ["vulkan", [".spv"], false],
        ["metal", [], true], ["all", [".dxil", ".spv"], true],
    ] as const) {
        const formats = offlineShaderFormats(target);
        assert.deepEqual(formats.binaries.map(format => format.extension), binaries);
        assert.equal(formats.tint.includes(".msl"), metal);
    }
});

const fragment = `@fragment fn main() -> @location(0) vec4f { return vec4f(0.25, 0.5, 0.75, 1.0); }\n`;
function shaderDirectory(root: string, scene: string, shader = fragment): string {
    const directory = join(root, "generated", scene, "upstream/shaders");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "simple.frag.native.wgsl"), shader);
    writeFileSync(join(directory, "composition.json"), JSON.stringify({ modules: [{
        output: "upstream/shaders/simple.frag.native.wgsl", entryPoint: "main", pinnedBindings: false,
    }] }));
    return directory;
}

function fixtureRoot(t: { after: (cleanup: () => void) => void }): string {
    const root = mkdtempSync(join(tmpdir(), "bblite-offline-shaders-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "upstream"));
    copyFileSync("upstream/tint.json", join(root, "upstream/tint.json"));
    return root;
}

test("directory checkpoints isolate edits, ignore unchanged writes, and repair missing or changed products", { skip: !tools.tint }, t => {
    const root = fixtureRoot(t);
    const directories = [shaderDirectory(root, "first"), shaderDirectory(root, "second")];
    const compile = () => compileOfflineShaders({ repositoryRoot: root, directories, tools, target: "metal" });
    assert.equal(compile().directoriesCompiled, 2);
    assert.equal(compile().directoriesReused, 2);
    const first = directories[0]!;
    const second = directories[1]!;
    const firstSource = join(first, "simple.frag.native.wgsl");
    utimesSync(firstSource, new Date(2000, 0), new Date(2000, 0));
    assert.equal(compile().directoriesReused, 2, "a checkout of identical bytes keeps the checkpoint");
    writeFileSync(firstSource, fragment.replace("0.25", "0.75"));
    const changed = compile();
    assert.equal(changed.directoriesCompiled, 1);
    assert.equal(changed.directoriesReused, 1);
    assert.equal(changed.tintCompiled, 1);
    const artifact = join(first, "simple.frag.hlsl");
    const expected = readFileSync(artifact);
    writeFileSync(artifact, "corrupt");
    const snapshotTime = new Date(2001, 0);
    utimesSync(artifact, snapshotTime, snapshotTime);
    const repaired = compile();
    assert.equal(repaired.directoriesReused, 1);
    assert.equal(repaired.tintCompiled, 0);
    assert.equal(repaired.tintReused, 1);
    assert.deepEqual(readFileSync(artifact), expected);
    assert.ok(statSync(artifact).mtimeMs > snapshotTime.getTime());
    rmSync(join(second, "simple.frag.slots"));
    const restored = compile();
    assert.equal(restored.directoriesReused, 1);
    assert.equal(restored.tintReused, 1);
    assert.ok(existsSync(join(second, "simple.frag.slots")));
    const checkpoints = join(root, "artifacts/shader-cache/directories");
    for (const name of readdirSync(checkpoints)) writeFileSync(join(checkpoints, name), "invalid JSON");
    assert.equal(compile().directoriesCompiled, 2);
});

test("shader checkpoints include DXC codegen DLL contents only for DXC targets", t => {
    const root = fixtureRoot(t);
    const directory = join(root, "shaders");
    mkdirSync(directory);
    const dxc = join(root, "dxc.exe");
    writeFileSync(dxc, "compiler identity");
    const localTools = { dxc, tint: undefined };
    const compile = (target: "metal" | "d3d12") => compileOfflineShaders({
        repositoryRoot: root, directories: [directory], tools: localTools, target,
    });
    // An empty shader directory records tools without executing these identity fixtures.
    assert.equal(compile("d3d12").directoriesCompiled, 1);
    assert.equal(compile("d3d12").directoriesReused, 1);
    for (const name of ["dxcompiler.dll", "dxil.dll"]) {
        const path = join(root, name);
        writeFileSync(path, "installed");
        assert.equal(compile("d3d12").directoriesCompiled, 1);
        assert.equal(compile("d3d12").directoriesReused, 1);
        writeFileSync(path, "replaced compiler");
        assert.equal(compile("d3d12").directoriesCompiled, 1);
        assert.equal(compile("metal").directoriesCompiled, 1);
        writeFileSync(path, "ignored by Metal");
        assert.equal(compile("metal").directoriesReused, 1);
    }
});

test("binding adapter changes invalidate cached sidecars and reordered shader binaries", { skip: !tools.tint || !tools.dxc }, t => {
    const root = fixtureRoot(t);
    const directory = shaderDirectory(root, "integer", `@group(2) @binding(0) var values: texture_2d<u32>;
@group(2) @binding(1) var color: texture_2d<f32>;
@group(2) @binding(2) var colorSampler: sampler;
@fragment fn main() -> @location(0) vec4f {
    return textureSample(color, colorSampler, vec2f(0.5)) + vec4f(textureLoad(values, vec2i(0), 0));
}`);
    const compilerRoot = mkdtempSync(resolve("artifacts/test-shader-implementation-"));
    t.after(() => rmSync(compilerRoot, { recursive: true, force: true }));
    const entry = fileURLToPath(new URL("../src/compile-shaders.js", import.meta.url));
    const sourceRoot = dirname(entry);
    const closure = repositoryModuleClosure([entry], sourceRoot);
    assert.ok(closure);
    for (const module of closure) {
        const path = join(compilerRoot, relative(sourceRoot, module.path));
        mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, module.source);
    }
    const bindingPath = join(compilerRoot, "shader-bindings.js");
    const current = readFileSync(bindingPath, "utf8");
    const marker = "function integerTextureRegisters(source) {";
    assert.ok(current.includes(marker));
    // Reproduce the old classification in an isolated compiler copy.
    writeFileSync(bindingPath, current.replace(marker, `${marker}\nsource = "";`));
    const script = `import {compileOfflineShaders} from ${JSON.stringify(pathToFileURL(join(compilerRoot, "compile-shaders.js")).href)};
process.stdout.write(JSON.stringify(compileOfflineShaders(${JSON.stringify({ repositoryRoot: root, directories: [directory], tools, target: "d3d12" })})));`;
    const compile = () => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" })) as { directoriesCompiled: number; directoriesReused: number; tintCompiled: number; compiled: number };
    assert.equal(compile().directoriesCompiled, 1);
    assert.equal(compile().directoriesReused, 1);
    const oldBinary = readFileSync(join(directory, "simple.frag.dxil"));
    assert.ok(!readFileSync(join(directory, "simple.frag.slots"), "utf8").includes("i0 values"));
    writeFileSync(bindingPath, current);
    const refreshed = compile();
    assert.equal(refreshed.directoriesCompiled, 1);
    assert.equal(refreshed.tintCompiled, 1);
    assert.equal(refreshed.compiled, 1);
    assert.match(readFileSync(join(directory, "simple.frag.slots"), "utf8"), /i0 values/);
    assert.notDeepEqual(readFileSync(join(directory, "simple.frag.dxil")), oldBinary);
    assert.equal(compile().directoriesReused, 1);
});

test("target switches remove unrequested products and specialize all formats", { skip: !tools.tint || !tools.dxc }, t => {
    const root = fixtureRoot(t);
    const directory = shaderDirectory(root, "formats");
    for (const target of ["all", "metal", "d3d12", "vulkan"] as const) {
        compileOfflineShaders({ repositoryRoot: root, directories: [directory], tools, target });
        const formats = offlineShaderFormats(target);
        for (const extension of [".msl", ".dxil", ".spv"]) {
            assert.equal(existsSync(join(directory, `simple.frag${extension}`)),
                formats.tint.includes(extension) || formats.binaries.some(format => format.extension === extension), `${target}: ${extension}`);
        }
    }
});

test("failed shader directories never acquire a completion checkpoint", { skip: !tools.tint }, t => {
    const root = fixtureRoot(t);
    const first = shaderDirectory(root, "a-first");
    const second = shaderDirectory(root, "b-second", "invalid WGSL");
    const compile = () => compileOfflineShaders({ repositoryRoot: root, directories: [first, second], tools, target: "metal" });
    assert.throws(compile, /tint.*failed/i);
    writeFileSync(join(second, "simple.frag.native.wgsl"), fragment);
    const result = compile();
    assert.equal(result.directoriesReused, 1);
    assert.equal(result.directoriesCompiled, 1);
    assert.equal(result.tintReused, 1);
});

test("composition parsing validates constants and extra stage identities", t => {
    const directory = shaderDirectory(fixtureRoot(t), "composition");
    const manifest = join(directory, "composition.json");
    const module = { output: "simple.frag.native.wgsl", entryPoint: "main", pinnedBindings: true,
        constants: [{ id: 7, value: 0.75 }, { id: 0, value: 1 }],
        alsoStages: [{ stem: "other.frag", entryPoint: "other" }],
    };
    const write = () => writeFileSync(manifest, JSON.stringify({ modules: [module] }));
    write();
    const stages = readShaderComposition(directory);
    assert.equal(shaderStageConstants(stages.get("simple.frag")!), "0=1,7=0.75");
    assert.equal(stages.get("other.frag")?.sourceName, "simple.frag.native.wgsl");
    module.constants.push({ id: 0, value: 2 });
    write();
    assert.throws(() => readShaderComposition(directory), /Duplicate shader constant/);
    module.constants.pop();
    module.alsoStages[0]!.stem = "../escape.frag";
    write();
    assert.throws(() => readShaderComposition(directory), /Invalid shader stage stem/);
});
