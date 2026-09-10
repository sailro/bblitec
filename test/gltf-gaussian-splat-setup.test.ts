import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";
import ts from "typescript";
import {extractGltfGaussianSplats} from "../src/splat-packager.js";
import {LoweringContext} from "../src/lowering/context.js";
import {lowerGltfGaussianSplatSetup} from "../src/lowering/gltf/gaussian-splat-setup.js";
import {transpileCommonJs} from "../src/typescript-transpile.js";
import {doctoredContext} from "./doctored-store.js";
import {meshPlanFixture} from "./gltf-mesh-fixture.js";
import {nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler} from "./native-fixture.js";

const module = "src/loader-gltf/gltf-feature-gaussian-splatting.ts";
const extension = "KHR_gaussian_splatting";
function fixture() {
    return meshPlanFixture({asset: {version: "2.0"}, extensionsUsed: [extension],
        meshes: [{name: "cloud", primitives: [{mode: 0, extensions: {[extension]: {}}}]}]});
}

test("Gaussian-splat activation and row preparation execute the source registry and feature", async () => {
    const run = async (context?: LoweringContext) => {
        const {document, bin} = fixture();
        return {document, splats: await extractGltfGaussianSplats(document, bin, "fixture", context)};
    };
    const base = await run();
    assert.equal(base.splats!.length, 1);
    assert.equal(base.splats![0]!.name, "cloud_0_0");
    assert.equal(base.splats![0]!.rows.length, 96);
    assert.deepEqual(base.splats![0]!.rotation, [0, 0, Math.PI]);
    assert.deepEqual((base.document.meshes as Array<{primitives: unknown[]}>)[0]!.primitives, []);
    assert.equal(base.document.__gsSplats, undefined);
    const inactive = await run(doctoredContext("src/loader-gltf/gltf-feature-registry.ts",
        '[GS, () => import("./gltf-feature-gaussian-splatting.js")]', '["inactive", () => import("./gltf-feature-gaussian-splatting.js")]'));
    assert.equal(inactive.splats, undefined);
    assert.equal((inactive.document.meshes as Array<{primitives: unknown[]}>)[0]!.primitives.length, 1);
    const changed = await run(doctoredContext(module, "mesh.rotation.z = Math.PI;", "mesh.rotation.z = Math.PI / 2;"));
    assert.deepEqual(changed.splats![0]!.rotation, [0, 0, Math.PI / 2]);
    await assert.rejects(run(doctoredContext(module, "return mesh;", "return {};")), /publishes exactly what it attaches/);
});

test("native Gaussian setup creates fresh clouds and appends source results on every add", async t => {
    const native = optionalNativeFixtureTools();
    if (!native) { t.skip("Native fixture compiler unavailable."); return; }
    const contexts = [new LoweringContext(), doctoredContext(module, "mesh.rotation.z = Math.PI;", "mesh.rotation.z = Math.PI / 2;")];
    const cases = contexts.map(context => {
        const {declaration} = context.methodDeclaration(module, "feature.applyAsset");
        const setup = context.unwrapExpression(context.variableInitializer(declaration, "sceneSetup"));
        assert.ok(ts.isArrowFunction(setup));
        const prepared = [{name: "first", buffer: new ArrayBuffer(4)}, {name: "second", buffer: new ArrayBuffer(8)}];
        const ready: unknown[] = [], scene = {};
        const attached: Array<{name: string; rotation: {x: number; y: number; z: number}}> = [];
        const callback = new Function("attachParsedSplat", "prepared", "ready",
            transpileCommonJs(`const setup = ${setup.getText()};`, module) + "\nreturn setup;")(
            (supplied: object, name: string, data: {data: ArrayBuffer}) => {
                assert.equal(supplied, scene); assert.equal(data.data, prepared.find(item => item.name === name)!.buffer);
                const mesh = {name, rotation: {x: 0, y: 0, z: 0}}; attached.push(mesh);
                return {then: (resolve: (mesh: object) => unknown) => resolve(mesh)};
            }, prepared, ready) as (scene: object) => void;
        callback(scene); const firstCount = ready.length; callback(scene);
        assert.deepEqual(ready, attached);
        assert.equal(new Set(ready).size, 4);
        return {firstCount, names: attached.map(mesh => mesh.name), rotations: attached.map(mesh => Math.fround(mesh.rotation.z))};
    });
    const directory = resolve("artifacts/test-gltf-gaussian-splat-setup"); mkdirSync(directory, {recursive: true});
    const file = resolve(directory, "check.cpp"), executable = resolve(directory, "check.exe");
    writeFileSync(resolve(directory, "cases.json"), JSON.stringify(cases));
    writeFileSync(file, `#include <nlohmann/json.hpp>
#include <cassert>
#include <cmath>
#include <cstddef>
#include <fstream>
#include <string>
#include <vector>
struct SplatMeshHandle { std::size_t value; };
struct Rotation { float x = 0, y = 0, z = 0; };
struct Mesh { std::string name; Rotation rotation; };
struct Engine { std::vector<Mesh> splat_meshes; };
struct Scene { Engine* engine; };
struct AssetRecord { std::vector<SplatMeshHandle> gaussian_splats; };
struct Prepared { std::string name; };
${contexts.map((context, index) => `namespace variant_${index} {
${lowerGltfGaussianSplatSetup(context)}
nlohmann::json check() {
    Engine engine; Scene scene{&engine}; AssetRecord asset;
    const std::vector<Prepared> prepared{{"first"}, {"second"}};
    const auto attach = [&](Scene& supplied, const Prepared& item) { assert(&supplied == &scene); const auto index = engine.splat_meshes.size(); engine.splat_meshes.push_back(Mesh{item.name, {}}); return SplatMeshHandle{index}; };
    setup_gltf_gaussian_splats(scene, asset, prepared, attach); const auto first_count = asset.gaussian_splats.size();
    setup_gltf_gaussian_splats(scene, asset, prepared, attach);
    std::vector<std::string> names; std::vector<float> rotations;
    for (std::size_t i = 0; i < asset.gaussian_splats.size(); ++i) { assert(asset.gaussian_splats[i].value == i); names.push_back(engine.splat_meshes[i].name); rotations.push_back(engine.splat_meshes[i].rotation.z); }
    return {{"firstCount", first_count}, {"names", names}, {"rotations", rotations}};
}
}`).join("\n")}
int main() { nlohmann::json cases; std::ifstream("cases.json") >> cases;
${contexts.map((_, index) => `    assert(variant_${index}::check() == cases.at(${index}));`).join("\n")}
}
`);
    runNativeFixtureCompiler(native, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD", "/O2",
        `/Fo:${directory}/`, `/Fe:${executable}`, "/I", resolve(nativeFixtureVcpkgRoot, "include"), file]);
    assert.equal(execFileSync(executable, {cwd: directory, encoding: "utf8"}), "");
});
