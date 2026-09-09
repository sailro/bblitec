import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compileOfflineShaders, offlineShaderFormats } from "../src/compile-shaders.js";
import { assertUniformBufferCap, demotableUniformBlocks, demoteUniformBlocks, normalizeTintHlslBindings,
    prepareSdlUniformAdaptation, remapPinnedVariantRegisters, sdlUniformSource, shaderStageSlots } from "../src/shader-bindings.js";
import { readShaderComposition, shaderStageConstants } from "../src/shader-composition.js";
import { discoverDevelopmentTools } from "../src/development-tools.js";

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
