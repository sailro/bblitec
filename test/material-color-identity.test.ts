import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";
import {compileSource} from "../src/compiler.js";
import {importPinnedModule} from "../src/pinned-shader-composer.js";
import {LoweringContext} from "../src/lowering/context.js";
import {FactoryLowerer} from "../src/lowering/factory/material-factories.js";
import {SceneLowerer} from "../src/lowering/scene-lowerer.js";
import {cppFunction, optionalNativeFixtureTools, runNativeFixtureCompiler} from "./native-fixture.js";
import {composeScenePbrVariants} from "../src/pinned-material-arms.js";
import {pinnedSceneArms} from "../src/pinned-scene-arms.js";

const program = `
import {createEngine,createPbrMaterial,createStandardMaterial} from "@babylonjs/lite";
import type {Material} from "@babylonjs/lite";
function color(material: Material) {
    const mat = material as {baseColorFactor?: readonly number[]; diffuseColor?: readonly number[]};
    return mat.baseColorFactor ?? mat.diffuseColor ?? [.8,.8,.8];
}
async function main() {
    const engine = await createEngine({});
    const values = [.123456789012345,.2,.3,1];
    function readonlyIdentity(input: readonly number[]): readonly number[] {
        if (input.length === 0) return [.8, .8, .8];
        return input;
    }
    class ColorReader { read(input: readonly number[]): readonly number[] { return readonlyIdentity(input); } }
    const reader = new ColorReader();
    const identity = readonlyIdentity(values), throughMethod = reader.read(values);
    if (identity !== values || throughMethod !== values) throw new Error("readonly return identity");
    const fresh = readonlyIdentity([]), anotherFresh = readonlyIdentity([]);
    if (fresh === anotherFresh || fresh[0] !== .8) throw new Error("readonly return owns fallback");
    function recursiveIdentity(input: readonly number[], count: number): readonly number[] {
        return count > 0 ? recursiveIdentity(input, count - 1) : input;
    }
    const callbacks: ((input: readonly number[]) => readonly number[])[] = [readonlyIdentity];
    const fromCallback = callbacks[0]!(values);
    if (recursiveIdentity(values, 3) !== values || fromCallback !== values)
        throw new Error("recursive and stored readonly return identity");
    const callbackFallback = callbacks[0]!([]);
    values[1] = .75;
    if (fromCallback[1] !== .75 || throughMethod[1] !== .75 || callbackFallback[0] !== .8)
        throw new Error("readonly result lifetime and alias mutation");
    const pbr = createPbrMaterial({baseColorFactor:values});
    const a = color(pbr);
    const b = color(pbr);
    if (a !== values || a !== b || a.length !== 4 || a[0] !== .123456789012345) throw new Error("retained PBR factor");
    values[0] = .875;
    if (a[0] !== .875) throw new Error("source alias write");
    const white = createPbrMaterial({baseColorFactor:[1,1,1,1]});
    const absent = createPbrMaterial({});
    if (color(white).length !== 4 || color(absent)[0] !== .8) throw new Error("explicit white vs absent");
    const standard = createStandardMaterial();
    const another = createStandardMaterial();
    const before = color(standard);
    if (before.length !== 3 || before[0] !== 1 || before === color(another)) throw new Error("fresh Standard default");
    const replacement = [.987654321012345,.4,.7];
    standard.diffuseColor = replacement;
    const after = color(standard);
    if (after !== replacement || after === before || after[0] !== .987654321012345) throw new Error("whole replacement");
    replacement[1] = .625;
    if (after[1] !== .625 || before[1] !== 1) throw new Error("old alias survives replacement");
    let active = standard;
    function nextColor(): number[] {active = another; return [.125,.25,.5];}
    active.diffuseColor = nextColor();
    if (standard.diffuseColor[0] !== .125 || another.diffuseColor[0] !== 1) throw new Error("assignment owner before RHS");
    let previous: number[] = [];
    for (let i=0;i<300;i++) {
        const row=createStandardMaterial();
        const channels=[i/300,.5,1];
        row.diffuseColor=channels;
        const observed=color(row);
        if(observed!==channels || observed===previous || observed[0]!==i/300) throw new Error("runtime color row identity/value");
        previous=observed;
    }
}
`;

test("compiled material colors retain source identity, double width, fallback and replacement", async (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) {t.skip("Native fixture compiler unavailable."); return;}
    const {createPbrMaterial} = await importPinnedModule<{
        createPbrMaterial(props: {baseColorFactor?: number[]}): {baseColorFactor?: number[]};
    }>("material/pbr/pbr-material.js");
    const {createStandardMaterial} = await importPinnedModule<{
        createStandardMaterial(): {diffuseColor: number[]};
    }>("material/standard/create-standard-material.js");
    const values = [.123456789012345,.2,.3,1];
    const pbr = createPbrMaterial({baseColorFactor:values});
    assert.equal(pbr.baseColorFactor, values);
    values[0] = .875;
    assert.equal(pbr.baseColorFactor![0], .875);
    assert.equal(createPbrMaterial({}).baseColorFactor, undefined);
    assert.deepEqual(createPbrMaterial({baseColorFactor:[1,1,1,1]}).baseColorFactor, [1,1,1,1]);
    const standard = createStandardMaterial(), another = createStandardMaterial();
    const old = standard.diffuseColor;
    assert.notEqual(old, another.diffuseColor);
    standard.diffuseColor = values;
    assert.equal(standard.diffuseColor, values);
    assert.deepEqual(old, [1,1,1]);
    const compiled = compileSource(program);
    const arms = await pinnedSceneArms({lightKinds:[],multiLight:false,noLight:true,toneMapping:[false],environment:false,fog:false});
    const variants = await composeScenePbrVariants(compiled.manifest.scenePbrMaterials!, arms);
    assert.ok(variants.some(variant => variant.fragmentWgsl.includes("material.baseColorFactor")));
    const lowerer = new FactoryLowerer(new LoweringContext());
    const pbrFactory = lowerer.lowerPbrMaterialFactory().source;
    const factories = cppFunction(pbrFactory, "[[maybe_unused]] static TextureData solid_texture_data(") + "\n" +
        cppFunction(pbrFactory, "[[maybe_unused]] static FileTexture retained_solid_texture(") + "\n" +
        cppFunction(pbrFactory, "MaterialHandle create_pbr_material(") + "\n" +
        cppFunction(lowerer.lowerStandardMaterialFactory().source, "MaterialHandle create_standard_material(");
    const sceneSource = new SceneLowerer(new LoweringContext()).lowerCore().source;
    const registration = ["void require_scene_engine(","std::uint32_t material_family_bit(","std::uint32_t scene_material_families(",
        "void drain_scene_deferred_builders(","void register_scene("].map(name => cppFunction(sceneSource,name)).join("\n");
    const legacy = cppFunction(compileSource(`import {createEngine,createStandardMaterial} from "@babylonjs/lite";
        async function main(){const engine=await createEngine({});const material=createStandardMaterial();
        material.diffuseColor={r:.2,g:.3,b:.4};
        const channels:[number,number,number]=[.2,.3,.4];
        const tupleMaterial=createStandardMaterial();tupleMaterial.diffuseColor=channels;}`).cpp, "int main(")
        .replace("int main(", "int legacy_source_main(")
        .replace("return 0;", `v_engine.meshes.emplace_back(); v_engine.meshes[0].material = v_material;
            v_engine.meshes.emplace_back(); v_engine.meshes[1].material = v_tupleMaterial;
            bbl::Scene scene; scene.engine=&v_engine; scene.meshes.push_back(bbl::MeshHandle{0});
            scene.meshes.push_back(bbl::MeshHandle{1});
            bbl::register_scene(scene);
            assert(v_engine.materials[v_material.value].diffuse_color.r == .2f);
            assert(v_engine.materials[v_material.value].diffuse_color.g == .3f);
            assert(v_engine.materials[v_material.value].diffuse_color.b == .4f);
            assert(v_engine.materials[v_tupleMaterial.value].diffuse_color.r == .2f);
            assert(v_engine.materials[v_tupleMaterial.value].diffuse_color.g == .3f);
            assert(v_engine.materials[v_tupleMaterial.value].diffuse_color.b == .4f);
            return 0;`);
    const directory = resolve("artifacts/test-material-color-identity");
    mkdirSync(directory, {recursive:true});
    const source = resolve(directory,"check.cpp"), executable = resolve(directory,"check.exe");
    writeFileSync(source, `#include <bblite/runtime.hpp>\n#include <bblite/js_data.hpp>\n#include <cassert>\nnamespace bbl {\nEngine create_engine(EngineOptions) {return {};}\n${factories}\n${registration}\n}
#define main source_main
${compiled.cpp}
#undef main
${legacy}
int main() {
    if (source_main()) return 1;
    if (legacy_source_main()) return 1;
    bbl::Engine engine;
    const auto material = bbl::create_standard_material(engine);
    auto alias = *bbl::material_color(engine,material,bbl::MaterialColorSlot::diffuse_color);
    alias[0] = .625;
    engine.meshes.emplace_back(); engine.meshes[0].material = material;
    bbl::Scene scene; scene.engine = &engine; scene.meshes.push_back(bbl::MeshHandle{0});
    bbl::register_scene(scene);
    assert(engine.materials[material.value].diffuse_color.r == .625f);
    alias[0] = .875;
    bbl::register_scene(scene);
    assert(engine.materials[material.value].diffuse_color.r == .625f);
    assert((*bbl::material_color(engine,material,bbl::MaterialColorSlot::diffuse_color))[0] == .875);
    auto replacement = bbl::js::Array<double>{.1,.2,.3};
    bool refused = false;
    try { bbl::set_material_diffuse_color(engine,material,replacement); }
    catch (const std::runtime_error&) { refused = true; }
    assert(refused && engine.materials[material.value].diffuse_color.r == .625f);
    assert((*bbl::material_color(engine,material,bbl::MaterialColorSlot::diffuse_color))[0] == .875);
    const auto fresh = bbl::create_standard_material(engine);
    bbl::set_material_diffuse_color(engine,fresh,replacement);
    assert(engine.materials[fresh.value].diffuse_color.r == .1f);
    engine.meshes.emplace_back(); engine.meshes.back().material = fresh;
    scene.meshes.push_back(bbl::MeshHandle{1});
    refused = false;
    try { bbl::set_material_diffuse_color(engine,fresh,replacement); }
    catch (const std::runtime_error&) { refused = true; }
    assert(refused);
    engine.materials.clear(); bbl::js::collect_cycles();
    assert(alias[0] == .875);
}
`);
    runNativeFixtureCompiler(native,["/nologo","/std:c++20","/EHsc","/W4","/WX","/Od",
        `/I${resolve("native/include")}`,source,`/Fe:${executable}`,`/Fo:${resolve(directory,"check.obj")}`]);
    execFileSync(executable,[],{stdio:"pipe"});
});

test("numeric material reads refuse co-reached legacy color objects in either source order", () => {
    for (const statements of [
        `const p=createPbrMaterial({baseColorFactor:{r:1,g:1,b:1,a:1}}); color(p);`,
        `const p=createPbrMaterial({}); color(p); createPbrMaterial({baseColorFactor:{r:1,g:1,b:1,a:1}});`,
        `const p=createStandardMaterial(); p.diffuseColor={r:1,g:1,b:1}; color(p);`,
        `const p=createStandardMaterial(); function channels():[number,number,number]{return [.1,.2,.3];}p.diffuseColor=channels();color(p);`,
    ]) {
        assert.throws(() => compileSource(program.slice(0,program.indexOf("async function main")) +
            `async function main(){const engine=await createEngine({});${statements}}`), /requires retained numeric-array producers/);
    }
});

test("material-color transport refuses unsupported widths and later material-group snapshots", () => {
    const prefix = `import {createEngine,createPbrMaterial,createStandardMaterial,createSceneContext,createBox,addToScene,registerScene,onBeforeRender,rebuildSceneRenderables} from "@babylonjs/lite";
        async function main(){const engine=await createEngine({});const scene=createSceneContext(engine);const p=createStandardMaterial();
        const color=(p as {diffuseColor?:readonly number[]}).diffuseColor; if(!color)throw new Error("presence");`;
    for (const statement of [
        `registerScene(scene); addToScene(scene,createBox(engine,{}));`,
        `registerScene(scene); p.diffuseColor=[.2,.4,.6];`,
        `onBeforeRender(scene,()=>{p.diffuseColor=[.2,.4,.6];});`,
        `rebuildSceneRenderables(scene);`,
        `registerScene(scene); registerScene(createSceneContext(engine));`,
    ]) assert.throws(() => compileSource(prefix+statement+"}"), /per-group UBO snapshots|independent material-group UBO snapshots/);
    assert.throws(() => compileSource(prefix+`createPbrMaterial({baseColorFactor:[1,2,3]});}`), /four-channel numeric array/);
    assert.throws(() => compileSource(prefix+`p.diffuseColor=[1,2];}`), /three-channel numeric array/);
    assert.throws(() => compileSource(prefix+`const values:readonly number[]=[1,1,1,1];createPbrMaterial({baseColorFactor:values});}`), /static readonly tuple cannot retain material color identity/);
    const writeOnly = prefix.slice(0, prefix.indexOf("const color="));
    assert.match(compileSource(writeOnly+`registerScene(scene);p.diffuseColor=[.2,.4,.6];}`).cpp, /set_material_diffuse_color/);
    assert.match(compileSource(writeOnly+`onBeforeRender(scene,()=>{p.diffuseColor=[.2,.4,.6];});}`).cpp, /set_material_diffuse_color/);
    assert.doesNotThrow(() => compileSource(writeOnly+`registerScene(scene);p.diffuseColor={r:.2,g:.4,b:.6};}`));
    assert.doesNotThrow(() => compileSource(writeOnly+`p.diffuseColor=[.2,.4,.6];rebuildSceneRenderables(scene);}`));
    assert.throws(() => compileSource(writeOnly+`const channels=[.2,.4,.6];p.diffuseColor=channels;rebuildSceneRenderables(scene);}`), /per-group UBO snapshots/);
    assert.throws(() => compileSource(writeOnly+`const channels=[.2,.4,.6,1];createPbrMaterial({baseColorFactor:channels});rebuildSceneRenderables(scene);}`), /per-group UBO snapshots/);
});

test("glTF public factor presence comes from the pinned conditional and retains its array", async () => {
    const {assemblePbrProps} = await importPinnedModule<{
        assemblePbrProps(mat: object,base:object,orm:object,normal:undefined,emissive:undefined,extensions:object): {baseColorFactor?: number[]};
    }>("loader-gltf/gltf-pbr-builder.js");
    const {assemblePbrPropsExt} = await importPinnedModule<{
        assemblePbrPropsExt(mat: object,textures: object,extensions: object): {baseColorFactor?: number[]};
    }>("loader-gltf/gltf-pbr-builder-ext.js");
    const texture = {};
    for (const image of [null, {}]) for (const factor of [[1,1,1,1],[.123456789012345,.4,.7,.8]]) {
        const mat = assemblePbrProps({_baseColorImage:image,_baseColorFactor:factor,_normalScale:1,_alphaMode:"OPAQUE"},texture,texture,undefined,undefined,{});
        assert.equal(mat.baseColorFactor, image && factor[0] !== 1 ? factor : undefined);
        const extended = assemblePbrPropsExt({_baseColorImage:image,_baseColorFactor:factor,_normalScale:1,_alphaMode:"OPAQUE"}, {baseColorTexture:texture}, {});
        assert.equal(extended.baseColorFactor, mat.baseColorFactor);
    }
});
