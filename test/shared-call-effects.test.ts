import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerMeshMaterialSetter } from "../src/lowering/mesh-material-setter.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const imports = `import { createEngine, createBox, createStandardMaterial, createPbrMaterial, setPbrUnlit, setPbrEmissive, loadGltf,
    type Material, type PbrMaterialProps } from "@babylonjs/lite";`;
const source = `${imports}
    async function main() {
        const engine = await createEngine({});
        function make(factor: number) { createStandardMaterial(); return createPbrMaterial({metallicFactor: factor}); }
        class Loader { async load(url: string) { return await loadGltf(engine, url); } }
        const first = make(.25); setPbrUnlit(first);
        const second = make(.75); setPbrEmissive(second, {r:1,g:0,b:0});
        const a = createBox(engine); a.material = first;
        const b = createBox(engine); b.material = second;
        const loader = new Loader();
        const firstAsset = await loader.load("a.glb");
        const third = make(.5);
        const secondAsset = await loader.load("a.glb");
        const fourth = make(1);
        if (first === second || third === fourth || firstAsset === secondAsset || a.material !== first || b.material !== second)
            throw new Error("shared call reused a resource identity");
    }
`;

test("shared PBR and glTF calls replay material order, load counts and producer-specific mutations", () => {
    const result = compileSource(source);
    assert.equal(result.cpp.match(/bbl::create_pbr_material\(/g)?.length, 1);
    assert.equal(result.cpp.match(/bbl::create_standard_material\(/g)?.length, 1);
    assert.equal(result.cpp.match(/bbl::load_gltf\(/g)?.length, 1);
    assert.equal(result.manifest.sceneMaterialCount, 8);
    assert.deepEqual(result.manifest.sceneMaterialGltfAssetsBefore, [0,0,0,0,1,1,2,2]);
    const materials = result.manifest.scenePbrMaterials;
    assert.deepEqual(materials.map(material => material.materialsBefore), [1,3,5,7]);
    assert.deepEqual(materials.map(material => material.gltfAssetsBefore), [0,0,1,2]);
    assert.equal(materials[0]?.unlit, true);
    assert.equal(materials[1]?.unlit, undefined);
    assert.deepEqual(materials[1]?.emissiveColor, [1,0,0]);
    assert.equal(materials[0]?.emissiveColor, undefined);
    assert.deepEqual(materials.slice(0,2).map(material => material.sceneMeshIndices), [[0],[1]]);
    assert.deepEqual(result.manifest.assets.map(asset => [asset.source, asset.containerCount]), [["a.glb",2]]);
});

test("void, inferred and annotated resource helpers share bodies with fresh call metadata", () => {
    for (const declaration of [
        "function make(): void { createPbrMaterial({}); }",
        "class Factory { make(): void { createPbrMaterial({}); } } const factory = new Factory(); function make() { factory.make(); }",
        "function make() { return createPbrMaterial({}); }",
        "function make(): Material { return createPbrMaterial({}); }",
        "class Factory { make() { return createPbrMaterial({}); } } const factory = new Factory(); function make() { return factory.make(); }",
    ]) {
        const result = compileSource(`${imports} async function main(){ const engine=await createEngine({}); ${declaration} make(); make(); }`);
        assert.equal(result.cpp.match(/bbl::create_pbr_material\(/g)?.length, 1, declaration);
        assert.deepEqual(result.manifest.scenePbrMaterials.map(material => material.materialsBefore), [0,1], declaration);
    }
});

test("a declined shared resource return rolls back speculative construction effects", () => {
    const result = compileSource(`${imports} async function main() { const engine=await createEngine({});
        function options(): PbrMaterialProps { createPbrMaterial({}); return { metallicFactor: .25 } as PbrMaterialProps; }
        const a = options(), b = options();
        if (a.metallicFactor !== .25 || b.metallicFactor !== .25) throw new Error("record return");
    }`);
    assert.deepEqual(result.manifest.scenePbrMaterials.map(material => material.materialsBefore), [0,1]);
    assert.deepEqual(result.manifest.scenePbrMaterials.map(material => material.metallicFactor), [1,1]);
});

test("per-call numeric material facts remain distinct while the emitted scalar parameters are shared", () => {
    const result = compileSource(`${imports} async function main(){ const engine=await createEngine({});
        function make(factor:number) { return createPbrMaterial({metallicFactor:factor, roughnessFactor:factor}); }
        const a=make(.25), b=make(.75);
    }`);
    assert.deepEqual(result.manifest.scenePbrMaterials.map(material => [material.metallicFactor, material.roughnessFactor]), [[.25,.25],[.75,.75]]);
    assert.equal(result.cpp.match(/bbl::create_pbr_material\(/g)?.length, 1);
});

test("shared material helpers retain tuple and conditional scalar facts", () => {
    const result = compileSource(`${imports} async function main(){ const engine=await createEngine({});
        function make(color:[number,number,number], reflective:boolean) {
            const material=createPbrMaterial({environmentIntensity:reflective ? 1 : .35});
            setPbrUnlit(material,color); return material;
        }
        const a=make([1,0,0],true), b=make([0,1,0],false);
    }`);
    assert.deepEqual(result.manifest.scenePbrMaterials.map(material => material.environmentIntensity), [1,.35]);
    assert.deepEqual(result.manifest.scenePbrMaterials.map(material => material.unlit), [true,true]);
});

test("shared glTF wrappers preserve contiguous load ordering and its refusal", () => {
    const program = (calls: string) => `${imports} async function main(){ const engine=await createEngine({});
        async function load(url: string) { return await loadGltf(engine,url); } ${calls} }`;
    const result = compileSource(program('await load("a.glb"); await load("a.glb"); await load("b.glb"); await load("b.glb");'));
    assert.deepEqual(result.manifest.assets.map(asset => [asset.source,asset.containerCount]), [["a.glb",2],["b.glb",2]]);
    assert.equal(result.cpp.match(/bbl::load_gltf\(/g)?.length, 2);
    assert.throws(() => compileSource(program('await load("a.glb"); await load("b.glb"); await load("a.glb");')), /must be contiguous/);
});

const tools = optionalNativeFixtureTools(false);
test("shared resource definitions execute every construction and retain native handle identity", { skip: !tools }, () => {
    const output = resolve("artifacts/shared-call-effects"); mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "program.hpp"), compileSource(source).cpp);
    const file = join(output, "check.cpp"), executable = join(output, "check.exe");
    writeFileSync(file, `#define main generated_main
        #include "program.hpp"
        #undef main
        #include <cassert>
        unsigned materials = 0, loads = 0, unlit = 0, emissive = 0;
        namespace bbl {
            ${lowerMeshMaterialSetter(new LoweringContext())}
            Engine create_engine(EngineOptions) { return {}; }
            MaterialHandle create_standard_material(Engine& engine) {
                assert(materials % 2 == 0); ++materials; engine.materials.emplace_back(); return {materials - 1};
            }
            MaterialHandle create_pbr_material(Engine& engine, PbrMaterialOptions options) {
                assert(materials % 2 == 1);
                const std::array<float,4> expected{.25f,.75f,.5f,1}; assert(options.metallic_factor == expected[materials / 2]);
                ++materials; engine.materials.emplace_back(); return {materials - 1};
            }
            void set_pbr_unlit(Engine&, MaterialHandle material, std::optional<Color3>) { assert(material.value == 1); ++unlit; }
            void set_pbr_emissive(Engine&, MaterialHandle material, Color3 color) { assert(material.value == 3 && color.r == 1); ++emissive; }
            MeshHandle create_box(Engine& engine, BoxOptions) { engine.meshes.emplace_back(); return {static_cast<std::uint32_t>(engine.meshes.size() - 1)}; }
            std::string asset_path(const std::string& path) { return path; }
            AssetHandle load_gltf(Engine&, const std::string&) { return {loads++}; }
        }
        int main() { assert(generated_main() == 0); assert(materials == 8 && loads == 2 && unlit == 1 && emissive == 1); }
    `);
    runNativeFixtureCompiler(tools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD", "/O2",
        `/Fo:${output}/`, `/Fe:${executable}`, "/I", output, "/I", "native/include", file]);
    assert.equal(execFileSync(executable, { encoding: "utf8" }), "");
});
