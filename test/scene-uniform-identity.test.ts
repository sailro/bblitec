import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { EnvironmentLowerer } from "../src/lowering/environment-lowerer.js";
import { GltfLowerer } from "../src/lowering/gltf-lowerer.js";
import { SceneLowerer } from "../src/lowering/scene-lowerer.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const literal = `{mode: 0, density: .1, start: 0, end: 10, color: [.2, .3, .4]}`;
const taa = `const target = createRenderTarget({size: engine, samples: 1});
    const source = createRenderTask({name: "source", rt: target}, engine, scene);
    const effect = createTaaPostProcessTask({sourceTexture: target, sourceRenderTask: source}, engine, scene);`;
function program(body: string): string {
    return `import {createEngine, createSceneContext, setFog, createRenderTarget,
        createRenderTask, createTaaPostProcessTask} from "@babylonjs/lite";
    async function main(): Promise<void> {
        const engine = await createEngine({});
        const scene = createSceneContext(engine, {defaultRenderTask: false});
        ${body}
    }`;
}

test("TAA fog admits fresh config/color literals and refuses retained identity in either reach order", () => {
    const fresh = compileSource(program(`${taa} setFog(scene, ${literal}); setFog(scene, ${literal});`));
    assert.equal(fresh.cpp.match(/bbl::set_scene_fog\(/g)?.length, 2);
    for (const call of [
        `const fog = ${literal}; setFog(scene, fog);`,
        `const color: [number, number, number] = [.2,.3,.4]; setFog(scene, {mode:0,density:.1,start:0,end:10,color});`,
    ]) {
        assert.doesNotThrow(() => compileSource(program(call)), "Existing non-TAA spelling remains available.");
        for (const body of [`${taa} ${call}`, `${call} ${taa}`]) {
            assert.throws(() => compileSource(program(body)), /TAA requires setFog to receive a fresh inline config/);
        }
    }
    assert.throws(() => compileSource(program(`${taa} const fog = ${literal}; const alias = fog; setFog(scene, alias);`)), /Expected an object literal/);
    assert.throws(() => compileSource(program(`${taa} setFog(scene, null);`)), /Expected an object literal/);
    assert.throws(() => compileSource(program(`${taa} scene.fog = null;`)), /Unsupported|not supported|Cannot assign/);
});

/** Only isolate emitted declarations for this CPU fixture; their bodies stay untouched. */
function cppFunction(source: string, signature: string): string {
    const start = source.indexOf(signature);
    assert.ok(start >= 0, signature);
    const open = source.indexOf("{", start);
    let depth = 1, end = open + 1;
    while (depth && end < source.length) {
        const char = source[end++];
        if (char === "{") ++depth;
        if (char === "}") --depth;
    }
    assert.equal(depth, 0);
    return source.slice(start, end);
}

test("scene object keys observe pin defaults, fresh fog, retained glTF setup and transactional environment publication", async (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) { t.skip("Native fixture compiler unavailable."); return; }
    const context = new LoweringContext();
    const {createSceneContext} = await importPinnedModule<{createSceneContext(surface: object, options: object): Record<string, unknown>}>("scene/scene-core.js");
    const {setFog} = await importPinnedModule<{setFog(scene: object, fog: unknown): void}>("scene/scene-ubo-extras.js");
    const {assembleEnvironmentTextures} = await importPinnedModule<{
        assembleEnvironmentTextures(...args: unknown[]): Record<string, unknown>;
    }>("loader-env/env-helpers.js");
    const engine = {_device: {createSampler: (descriptor: object) => descriptor}};
    const scene = createSceneContext({engine}, {defaultRenderTask: false});
    assert.equal(scene.fog, null);
    assert.equal(scene._envTextures, undefined);
    const fogA = {mode:0,density:.1,start:0,end:10,color:[.2,.3,.4]};
    setFog(scene, fogA);
    assert.equal(scene.fog, fogA, "Mode zero still installs a fog object.");
    fogA.density = .2;
    setFog(scene, fogA);
    assert.equal(scene.fog, fogA, "Reusing a config preserves identity (compiler TAA refusal above).");
    const fogB = {...fogA};
    setFog(scene, fogB);
    assert.notEqual(scene.fog, fogA);
    setFog(scene, null);
    assert.equal(scene.fog, null, "The pin supports null; native source keeps that shape refused.");

    const texture = {createView: () => ({}), destroy() {}};
    const harmonics = new Float32Array(27);
    const environmentA = assembleEnvironmentTextures(texture, texture, harmonics, .8, engine);
    const environmentB = assembleEnvironmentTextures(texture, texture, harmonics, .8, engine);
    assert.notEqual(environmentA, environmentB);
    const ibl = context.sourceFile("src/loader-gltf/gltf-ext-lights-image-based.ts");
    const setupExpression = context.variableInitializer(ibl, "_sceneSetup");
    const setupCode = ts.transpileModule(`const setup = ${setupExpression.getText(ibl)}; return setup;`, {
        compilerOptions: {target: ts.ScriptTarget.ES2022},
    }).outputText;
    const makeSetup = new Function("textures", "envRotationY", "registerEnvSceneUniforms", "specularCube", "brdfLut", setupCode);
    const setupA = makeSetup(environmentA, 0, () => {}, texture, texture) as (scene: Record<string, unknown>) => void;
    setupA(scene); const installed = scene._envTextures;
    setupA(scene); assert.equal(scene._envTextures, installed);
    environmentA.lodGenerationScale = .7;
    assert.equal(scene._envTextures, installed);
    const other = createSceneContext({engine}, {defaultRenderTask: false});
    setupA(other); assert.equal(other._envTextures, installed);
    const setupB = makeSetup(environmentB, 0, () => {}, texture, texture) as typeof setupA;
    setupB(scene); assert.notEqual(scene._envTextures, installed);

    const directory = resolve("artifacts/scene-uniform-identity-check");
    mkdirSync(directory, {recursive:true});
    const environment = new EnvironmentLowerer(context);
    writeFileSync(join(directory,"dds.cpp"), environment.lowerDdsLoaderAdapter().source);
    writeFileSync(join(directory,"hdr.cpp"), environment.lowerHdrLoaderAdapter().source);
    const envFunction = cppFunction(environment.lowerLoaderAdapter({loadEnvironment:true,ddsBackground:false}).source, "void load_environment(");
    const sceneSource = new SceneLowerer(context).lowerCore({fog:true}).source;
    const fogFunction = cppFunction(sceneSource, "void set_scene_fog(");
    const gltfSource = new GltfLowerer(context).lowerLoaderAdapter().source;
    const lambda = cppFunction(gltfSource, "[image_based_environment, identity =");
    const sourcePath = join(directory,"check.cpp"), executable = join(directory,"check.exe");
    writeFileSync(sourcePath, `#include <bblite/runtime.hpp>
#include <bblite/pal.hpp>
#include <cassert>
#include <iostream>
namespace {
std::vector<std::uint8_t> bytes;
bool fail_brdf = false;
}
namespace bbl::pal {
std::vector<std::uint8_t> read_binary_file(const std::string& path) {
    if (path == "brdf") { if (fail_brdf) throw std::runtime_error("brdf"); return {1,2,3}; }
    return bytes;
}
}
namespace bbl {
namespace upstream {
struct ParsedEnvironment { std::array<Color3,9> spherical_harmonics{};
    std::uint32_t width=1, mip_count=1; std::vector<TextureData> faces; };
ParsedEnvironment parse_env_file(const std::vector<std::uint8_t>& input) {
    if (input.empty()) throw std::runtime_error("env");
    ParsedEnvironment result; result.faces.resize(6); result.faces[0].bytes = input; return result;
}
}
void read_dds_skybox(EnvironmentState&, const std::string&) {}
void apply_scene_size(Scene&, double) {}
${envFunction}
${cppFunction(sceneSource, "void require_scene_engine(")}
${fogFunction}
}
int main() {
    using namespace bbl;
    bbl::Engine engine; bbl::Scene scene; scene.engine = &engine;
    assert(scene.state->fog_identity == 0 && scene.state->environment_identity == 0);
    bbl::set_scene_fog(scene, 0,.1f,0,10,{.2f,.3f,.4f});
    const auto fog_a = scene.state->fog_identity;
    assert(fog_a != 0 && scene.fog_mode == 0);
    scene.fog_density = .2f; assert(scene.state->fog_identity == fog_a);
    bbl::Scene alias = scene; alias.fog_density = .3f;
    assert(alias.state->fog_identity == fog_a && scene.fog_density == .3f);
    bbl::set_scene_fog(alias, 0,.3f,0,10,{.2f,.3f,.4f});
    assert(scene.state->fog_identity != fog_a);
    bbl::EnvironmentState image_based_environment;
    auto setup_a = ${lambda};
    setup_a(scene); const auto env_a = scene.state->environment_identity;
    setup_a(alias); assert(scene.state->environment_identity == env_a);
    scene.environment.exposure = 2; scene.environment.contrast = 3; scene.environment.rotation_y = 1;
    assert(scene.state->environment_identity == env_a);
    bbl::Scene other; setup_a(other); assert(other.state->environment_identity == env_a);
    auto setup_b = ${lambda}; setup_b(scene); assert(scene.state->environment_identity != env_a);
    bytes.resize(124 + 6*8); const std::uint8_t magic[]{0x42,0x42,0x4c,0x48,0x44,0x52,0x31,0};
    std::copy(std::begin(magic),std::end(magic),bytes.begin()); bytes[8]=1; bytes[12]=1;
    auto dds = [&] { bbl::load_dds_environment(scene, {"environment","brdf"}); };
    auto hdr = [&] { bbl::load_hdr_environment(scene, {"environment","brdf"}); };
    auto env = [&] { bbl::EnvironmentOptions options; options.environment_url="environment"; options.brdf_url="brdf";
        bbl::load_environment(scene, options); };
    auto verify = [&](auto load) {
        load(); const auto first = scene.state->environment_identity;
        load(); assert(scene.state->environment_identity != first);
        const auto committed = scene.state->environment_identity;
        const auto previous = scene.environment.specular_faces[0].bytes;
        bytes[124] ^= 1; fail_brdf = true; bool failed = false;
        try { load(); } catch(const std::runtime_error&) { failed = true; }
        fail_brdf = false; bytes[124] ^= 1;
        assert(failed && scene.state->environment_identity == committed);
        const auto& current = scene.environment.specular_faces[0].bytes;
        assert(current.size() == previous.size() && std::equal(current.begin(), current.end(), previous.begin()));
    };
    verify(dds); verify(hdr); verify(env);
    const auto committed = scene.state->environment_identity;
    bytes.pop_back(); bool failed=false;
    try { dds(); } catch(const std::runtime_error&) { failed=true; }
    assert(failed && scene.state->environment_identity == committed);
    assert(other.state->environment_identity == env_a);
    std::cout << "scene-uniform-identity: ok\\n";
}
`);
    runNativeFixtureCompiler(native, ["/nologo","/std:c++20","/W4","/WX","/EHsc","/MD",
        `/I${resolve("native/include")}`, `/Fo:${directory}\\`, `/Fe:${executable}`,
        sourcePath, join(directory,"dds.cpp"), join(directory,"hdr.cpp")]);
    assert.match(execFileSync(executable,{encoding:"utf8"}), /scene-uniform-identity: ok/);
});
