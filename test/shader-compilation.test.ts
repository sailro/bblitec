import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { compileOfflineShaders, offlineShaderFormats } from "../src/compile-shaders.js";
import { assertUniformBufferCap, demotableUniformBlocks, demoteUniformBlocks, normalizeTintHlslBindings,
    prepareSdlUniformAdaptation, remapPinnedVariantRegisters, sdlSpirvSource, sdlUniformSource, shaderStageSlots } from "../src/shader-bindings.js";
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

test("integer and multisampled loads occupy SDL storage texture slots between sampled textures and buffers", () => {
    const source = `ByteAddressBuffer morph : register(t0, space2);
Texture2D<uint4> cells : register(t1, space2);
Texture2D<float4> color : register(t8, space2);
Texture2D<int4> signs : register(t5, space2);
Texture2DMS<float4> samples : register(t6, space2);
SamplerState colorSampler : register(s8, space2);
uint4 value = cells.Load(int3(0, 0, 0));`;
    for (const actual of [normalizeTintHlslBindings(source), remapPinnedVariantRegisters(source, true), remapPinnedVariantRegisters(source, false)]) {
        assert.deepEqual(shaderStageSlots(actual), [
            { kind: "i", index: 0, name: "cells" }, { kind: "i", index: 1, name: "signs" },
            { kind: "i", index: 2, name: "samples" },
            { kind: "r", index: 0, name: "morph" },
            { kind: "s", index: 0, name: "colorSampler" }, { kind: "t", index: 0, name: "color" },
        ]);
        assert.match(actual, /cells : register\(t1,/);
        assert.match(actual, /signs : register\(t2,/);
        assert.match(actual, /samples : register\(t3,/);
        assert.match(actual, /morph : register\(t4,/);
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
    assert.deepEqual(offlineShaderFormats("d3d12").binaries[0]!.flags, ["-O3"]);
    for (const [target, binaries, metal] of [
        ["d3d12", [".dxil"], false], ["vulkan", [".spv", ".demote.spv"], false],
        ["metal", [], true], ["all", [".dxil", ".spv", ".demote.spv"], true],
    ] as const) {
        const formats = offlineShaderFormats(target);
        assert.deepEqual(formats.binaries.map(format => format.extension), binaries);
        assert.equal(formats.tint.includes(".msl"), metal);
    }
});

test("SDL Vulkan combines sampled texture pairs while retaining integer and buffer slots", () => {
    const source = `Texture2D<float4> color : register(t0, space2);
SamplerState colorSampler : register(s0, space2);
Texture2D<uint4> values : register(t1, space2);
ByteAddressBuffer data : register(t2, space2);`;
    const adapted = sdlSpirvSource(source, false);
    assert.match(adapted, /\[\[vk::combinedImageSampler\]\] Texture2D<float4> color/);
    assert.match(adapted, /\[\[vk::combinedImageSampler\]\] SamplerState \w+ : register\(s0, space2\)/);
    assert.doesNotMatch(adapted, /combinedImageSampler\]\] (?:Texture2D<uint4>|ByteAddressBuffer)/);
    assert.deepEqual(shaderStageSlots(adapted).filter(slot => slot.kind !== "s"), shaderStageSlots(source).filter(slot => slot.kind !== "s"));
    const implicit = sdlSpirvSource("Texture2D<float4> color : register(t0);\nSamplerState s : register(s1);", false);
    assert.match(implicit, /color : register\(t0, space2\)/);
    assert.match(implicit, /SamplerState \w+ : register\(s0, space2\)/);
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

function* spirvInstructions(bytes: Buffer): Generator<{ opcode: number; offset: number; words: number }> {
    for (let offset = 20; offset < bytes.length;) {
        const instruction = bytes.readUInt32LE(offset);
        const words = instruction >>> 16;
        assert.ok(words > 0 && offset + words * 4 <= bytes.length);
        yield { opcode: instruction & 0xffff, offset, words };
        offset += words * 4;
    }
}

function fixtureRoot(t: { after: (cleanup: () => void) => void }): string {
    const root = mkdtempSync(join(tmpdir(), "bblite-offline-shaders-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "upstream"));
    copyFileSync("upstream/tint.json", join(root, "upstream/tint.json"));
    return root;
}

test("Vulkan discard has a helper-invocation variant and a baseline device fallback", { skip: !tools.tint || !tools.dxc }, t => {
    const root = fixtureRoot(t);
    const directory = shaderDirectory(root, "discard", `
@fragment fn main(@builtin(position) p: vec4f) -> @location(0) vec4f {
    if (p.x < 20.0) { discard; }
    return vec4f(dpdx(p.x), 0.0, 0.0, 1.0);
}`);
    compileOfflineShaders({ directories: [directory], repositoryRoot: root, target: "vulkan", tools });
    for (const [extension, discard, absent] of [[".spv", 252, 5380], [".demote.spv", 5380, 252]] as const) {
        const opcodes = new Set([...spirvInstructions(readFileSync(join(directory, `simple.frag${extension}`)))].map(i => i.opcode));
        assert.ok(opcodes.has(discard), extension);
        assert.ok(!opcodes.has(absent), extension);
    }
});

test("Vulkan preserves floating-point division and its dependent sampled branch", { skip: !tools.tint || !tools.dxc }, t => {
    const root = fixtureRoot(t);
    const directory = shaderDirectory(root, "division-branch", `
@group(3) @binding(0) var<uniform> params: vec4f;
@group(2) @binding(0) var color: texture_2d<f32>;
@group(2) @binding(1) var colorSampler: sampler;
@fragment fn main(@builtin(position) position: vec4f) -> @location(0) vec4f {
    let ratio = params.x / params.x;
    if (ratio == 1.0) { return vec4f(0.0, 1.0, 0.0, 1.0); }
    return textureSample(color, colorSampler, position.xy / params.yz);
}`);
    compileOfflineShaders({ directories: [directory], repositoryRoot: root, target: "vulkan", tools });
    for (const extension of [".spv", ".demote.spv"]) {
        const opcodes = new Set([...spirvInstructions(readFileSync(join(directory, `simple.frag${extension}`)))].map(instruction => instruction.opcode));
        assert.ok(opcodes.has(136), `${extension} retains OpFDiv instead of folding x/x to one`);
        assert.ok(opcodes.has(180), `${extension} retains the source floating-point comparison`);
        assert.ok(opcodes.has(27), `${extension} retains the branch's combined sampled-image type`);
        assert.ok(!opcodes.has(26), `${extension} does not introduce separate SDL-incompatible samplers`);
    }
});

test("Metal uses SDL buffer slots and preserves bounds checks across reordered runtime arrays", { skip: !tools.tint }, t => {
    const root = fixtureRoot(t);
    const directory = shaderDirectory(root, "metal-bindings", `
@group(2) @binding(7) var<storage, read> later: array<vec4f>;
@group(3) @binding(2) var<uniform> second: vec4f;
@group(2) @binding(0) var<storage, read> fixed: array<vec4f, 4>;
@group(2) @binding(3) var<storage, read> earlier: array<vec4f>;
@group(3) @binding(0) var<uniform> first: vec4f;
@fragment fn main(@builtin(position) position: vec4f) -> @location(0) vec4f {
    let index = u32(position.x);
    return later[index] + second + fixed[index] + earlier[index] + first;
}`);
    compileOfflineShaders({ repositoryRoot: root, directories: [directory], tools, target: "metal" });
    const msl = readFileSync(join(directory, "simple.frag.msl"), "utf8");
    for (const [name, index] of [["first", 0], ["second", 1], ["fixed", 2], ["earlier", 3], ["later", 4]] as const) {
        assert.ok(msl.includes(`${name} [[buffer(${index})]]`), `${name} must occupy SDL buffer ${index}`);
    }
    assert.match(msl, /tint_storage_buffer_sizes \[\[buffer\(30\)\]\]/);
    assert.match(msl, /tint_storage_buffer_sizes\)\[0u\]\.z/);
    assert.match(msl, /tint_storage_buffer_sizes\)\[0u\]\.y/);
    assert.doesNotMatch(msl, /tint_storage_buffer_sizes\)\[0u\]\.x/);
    assert.match(msl, /min\(/, "runtime and fixed-array access retain Tint bounds checks");
    assert.match(msl, /^fragment\s+\w+\s+main0\(/m, "Tint's renamed WGSL main uses the SDL entry point");
});

test("Metal sampler slots follow sampled textures after textureLoad removes an earlier sampler", { skip: !tools.tint }, t => {
    const root = fixtureRoot(t);
    const directory = shaderDirectory(root, "metal-samplers", `
@group(2) @binding(0) var depth: texture_depth_2d;
@group(2) @binding(1) var color: texture_2d<f32>;
@group(2) @binding(2) var colorSampler: sampler;
@fragment fn main() -> @location(0) vec4f {
    return textureSample(color, colorSampler, vec2f(0.5)) * textureLoad(depth, vec2i(0), 0);
}`);
    compileOfflineShaders({ repositoryRoot: root, directories: [directory], tools, target: "metal" });
    const msl = readFileSync(join(directory, "simple.frag.msl"), "utf8");
    assert.match(msl, /depth \[\[texture\(0\)\]\]/);
    assert.match(msl, /color \[\[texture\(1\)\]\]/);
    assert.match(msl, /colorSampler \[\[sampler\(1\)\]\]/);
});

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
    for (const name of ["dxcompiler.dll", "dxil.dll", "libdxcompiler.so", "libdxil.so"]) {
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

test("Vulkan shader binaries match SDL sampled and storage image descriptors", { skip: !tools.tint || !tools.dxc }, t => {
    const root = fixtureRoot(t);
    for (const [name, combined, shader] of [["sampled", true, `
@group(2) @binding(0) var color: texture_2d<f32>;
@group(2) @binding(1) var colorSampler: sampler;
@fragment fn main() -> @location(0) vec4f {
    return textureSample(color, colorSampler, vec2f(0.5));
}`], ["shared-sampler", true, `
@group(2) @binding(0) var first: texture_2d<f32>;
@group(2) @binding(1) var second: texture_2d<f32>;
@group(2) @binding(2) var sharedSampler: sampler;
@fragment fn main() -> @location(0) vec4f {
    return textureSample(first, sharedSampler, vec2f(0.5)) +
        textureSample(second, sharedSampler, vec2f(0.5));
}`], ["sampler-helper", true, `
@group(2) @binding(0) var first: texture_2d<f32>;
@group(2) @binding(1) var second: texture_2d<f32>;
@group(2) @binding(2) var sharedSampler: sampler;
fn sampleColor(tex: texture_2d<f32>, smp: sampler) -> vec4f {
    return textureSampleLevel(tex, smp, vec2f(0.5), 0.0);
}
@fragment fn main() -> @location(0) vec4f {
    return sampleColor(first, sharedSampler) + sampleColor(second, sharedSampler);
}`], ["comparison", true, `
@group(2) @binding(0) var shadow: texture_depth_2d;
@group(2) @binding(1) var comparison: sampler_comparison;
@fragment fn main() -> @location(0) vec4f {
    return vec4f(textureSampleCompare(shadow, comparison, vec2f(0.5), 0.5));
}`], ["loaded", true, `
@group(2) @binding(0) var color: texture_2d<f32>;
@fragment fn main() -> @location(0) vec4f {
    return textureLoad(color, vec2i(0), 0);
}`], ["multisampled", false, `
@group(2) @binding(0) var color: texture_multisampled_2d<f32>;
@fragment fn main() -> @location(0) vec4f {
    return textureLoad(color, vec2i(0), 0);
}`], ["integer", false, `
@group(2) @binding(0) var color: texture_2d<u32>;
@fragment fn main() -> @location(0) vec4f {
    return vec4f(textureLoad(color, vec2i(0), 0));
}`]] as const) {
        const directory = shaderDirectory(root, name, shader);
        compileOfflineShaders({ directories: [directory], tools, target: "vulkan" });
        const bytes = readFileSync(join(directory, "simple.frag.spv"));
        const opcodes = new Set<number>();
        for (const { opcode } of spirvInstructions(bytes)) opcodes.add(opcode);
        assert.equal(opcodes.has(27), combined, `${name}: OpTypeSampledImage must match SDL's descriptor`);
        assert.ok(!opcodes.has(26), "a separate OpTypeSampler cannot use SDL's descriptor layout");
    }
});

test("Vulkan binaries preserve sparse vertex and interstage locations", { skip: !tools.tint || !tools.dxc }, t => {
    const root = fixtureRoot(t);
    const directory = join(root, "shaders");
    mkdirSync(directory);
    const shader = `
struct Input {
    @location(6) color: vec4f,
    @location(0) position: vec3f,
    @location(3) uv: vec2f,
    @location(16) instance: vec4f,
};
struct Output {
    @location(7) color: vec4f,
    @builtin(position) position: vec4f,
    @location(2) uv: vec2f,
};
@vertex fn vertexMain(input: Input) -> Output {
    return Output(input.color, vec4f(input.position, 1.0) + input.instance, input.uv);
}
@fragment fn fragmentMain(@location(2) uv: vec2f, @location(7) color: vec4f) -> @location(0) vec4f {
    return color + vec4f(uv, 0.0, 0.0);
}`;
    const modules = ["vert", "frag"].map(stage => {
        const output = `sparse.${stage}.native.wgsl`;
        writeFileSync(join(directory, output), shader);
        return { output, entryPoint: stage === "vert" ? "vertexMain" : "fragmentMain", pinnedBindings: false };
    });
    writeFileSync(join(directory, "composition.json"), JSON.stringify({ modules }));
    writeFileSync(join(directory, "sparse.vert.demote.spv"), "stale fragment-only variant");
    compileOfflineShaders({ repositoryRoot: root, directories: [directory], tools, target: "vulkan" });
    assert.equal(existsSync(join(directory, "sparse.vert.demote.spv")), false);
    const locations = (stage: string): Map<string, number> => {
        const bytes = readFileSync(join(directory, `sparse.${stage}.spv`));
        const names = new Map<number, string>();
        const decorated = new Map<number, number>();
        for (const { opcode, offset, words } of spirvInstructions(bytes)) {
            if (opcode === 5) { // OpName
                names.set(bytes.readUInt32LE(offset + 4), bytes.subarray(offset + 8, offset + words * 4).toString("utf8").split("\0")[0]!);
            } else if (opcode === 71 && bytes.readUInt32LE(offset + 8) === 30) { // OpDecorate Location
                decorated.set(bytes.readUInt32LE(offset + 4), bytes.readUInt32LE(offset + 12));
            }
        }
        return new Map([...decorated].map(([id, location]) => [names.get(id)!, location]));
    };
    const vertex = locations("vert"), fragment = locations("frag");
    for (const location of [0, 3, 6, 16]) {
        assert.equal(vertex.get(`in.var.TEXCOORD${location}`), location, `vertex input ${location}`);
    }
    for (const location of [2, 7]) {
        assert.equal(vertex.get(`out.var.TEXCOORD${location}`), location, `vertex output ${location}`);
        assert.equal(fragment.get(`in.var.TEXCOORD${location}`), location, `fragment input ${location}`);
    }
    assert.equal(fragment.get("out.var.SV_Target0"), 0);
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
    const marker = "function storageTextureRegisters(source) {";
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
        for (const extension of [".msl", ".dxil", ".spv", ".demote.spv"]) {
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
