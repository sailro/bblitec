import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { FactoryLowerer } from "../src/lowering/factory-lowerer.js";
import { LoweringContext } from "../src/lowering/context.js";
import { cppFunction, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const fileName = "test/fixtures/solid-texture-storage.ts";
const source = readFileSync(fileName, "utf8");
const tools = optionalNativeFixtureTools(false);

test("solid Texture2D helper and container identities match the pinned producer", async () => {
    const pin = await import("@babylonjs/lite");
    const writes: number[][] = [];
    const samplers: unknown[] = [];
    const engine = { _device: {
        createTexture: () => ({ createView: () => ({}) }),
        createSampler: (options: unknown) => { samplers.push(options); return {}; },
        queue: { writeTexture: (_target: unknown, bytes: Uint8Array) => writes.push([...bytes]) },
    } };
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    await new Function("require", "exports", "document", js.replace(/main\(\);\s*$/, "return main();"))(
        () => ({ ...pin, createEngine: async () => engine }), {}, { getElementById: () => ({}) },
    );
    assert.deepEqual(writes, [[64, 128, 191, 255], [64, 128, 191, 255]]);
    assert.equal(samplers.length, 1);
    const result = compileSource(source, { fileName });
    assert.match(result.cpp, /bbl::solid_texture_file\(/);
    assert.match(result.cpp, /bbl::StoredTexture/);
});

test("generated solid texture storage preserves identity, payload and independent file IDs", { skip: !tools }, () => {
    const directory = resolve("artifacts/solid-texture-storage");
    mkdirSync(directory, { recursive: true });
    const result = compileSource(source, { fileName });
    writeFileSync(join(directory, "program.hpp"), result.cpp);
    const factory = new FactoryLowerer(new LoweringContext()).lowerFileTextureFactory().source;
    writeFileSync(join(directory, "factory.hpp"), `namespace bbl {
${cppFunction(factory, "[[maybe_unused]] static TextureData solid_texture_data(")}
${cppFunction(factory, "SolidTexture create_solid_texture(")}
${cppFunction(factory, "FileTexture solid_texture_file(")}
}`);
    const cpp = join(directory, "check.cpp");
    writeFileSync(cpp, `#define main generated_main
#include "program.hpp"
#undef main
#include <algorithm>
#include <cmath>
#include <cassert>
#include "factory.hpp"
namespace bbl { Engine create_engine(EngineOptions) { return {}; } }
int main() {
    assert(generated_main() == 0);
    bbl::Engine engine;
    engine.next_file_texture_identity = 7;
    const auto solid = bbl::create_solid_texture(engine, .25f, .5f, .75f, 1.f);
    const auto stored = bbl::solid_texture_file(solid);
    assert(stored.identity == 7 && engine.next_file_texture_identity == 8);
    const std::array<std::uint8_t, 4> bytes{64, 128, 191, 255};
    assert(std::equal(stored.data.bytes.begin(), stored.data.bytes.end(), bytes.begin(), bytes.end()));
    assert(stored.width == 1 && stored.height == 1);
    assert(stored.data.sampler.min_filter == bbl::TextureFilter::linear);
    assert(stored.data.sampler.mag_filter == bbl::TextureFilter::linear);
    assert(stored.data.sampler.mipmap_mode == bbl::TextureMipmapMode::nearest);
    assert(stored.data.sampler.address_u == bbl::TextureAddressMode::clamp);
    assert(stored.data.sampler.address_v == bbl::TextureAddressMode::clamp);
    assert(stored.data.sampler.max_lod == 0.f);
    bbl::FileTexture file; file.identity = engine.next_file_texture_identity++;
    assert(file != stored);
}`);
    const executable = join(directory, "check.exe");
    runNativeFixtureCompiler(tools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/O2", "/fp:precise", `/Fo:${directory}\\`, `/Fe:${executable}`, "/I", "native/include", cpp]);
    execFileSync(executable);
});
