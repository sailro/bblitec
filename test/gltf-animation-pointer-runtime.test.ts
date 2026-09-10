import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";
import ts from "typescript";
import {LoweringContext} from "../src/lowering/context.js";
import {gltfAnimationPointerRuntimeCpp} from "../src/lowering/gltf/animation-pointer-runtime.js";
import {lowerGltfAnimationPointerWriters} from "../src/lowering/gltf/animation-pointer-writers.js";
import {gltfAnimationPointerOwnersCpp} from "../src/lowering/gltf/animation-pointer-owners.js";
import {gltfMaterialValueRuntime} from "../src/lowering/gltf/material-value-runtime.js";
import {gltfMaterialProjection} from "../src/lowering/gltf/material-projection.js";
import {lowerGltfMaterialProperties} from "../src/lowering/gltf/material-properties.js";
import {transpileCommonJs} from "../src/typescript-transpile.js";
import {doctoredContext} from "./doctored-store.js";
import {recordAnimationMaterialState, readAnimationMaterialState} from "../src/gltf-animation-material-state.js";
import {LightLowerer} from "../src/lowering/light-lowerer.js";
import {cppFunction, nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler} from "./native-fixture.js";

test("material initialization patches retain source clones and exact numeric values", () => {
    const texture = {uScale: 1, nested: {unchanged: true}}, material: Record<string, unknown> = {texture, scalar: 0};
    const read = recordAnimationMaterialState([material]);
    material.texture = {...texture, _animPriv: true}; material.scalar = -0; material.other = {value: Infinity};
    const state = read();
    assert.deepEqual(state, [{index: 0, patches: [
        {path: ["texture"], operation: "clone"}, {path: ["texture", "_animPriv"], operation: "set", value: {kind: "literal", value: true}},
        {path: ["scalar"], operation: "set", value: {kind: "number", value: "-0"}},
        {path: ["other"], operation: "set", value: {kind: "object", fields: {value: {kind: "number", value: "Infinity"}}}},
    ]}]);
    assert.deepEqual(readAnimationMaterialState(JSON.parse(JSON.stringify(state)), 1), state);
    assert.throws(() => readAnimationMaterialState(state, 0), /Invalid packaged/);
});

test("bound source writers retain aliases and refresh independent native material and light writes", async t => {
    const native = optionalNativeFixtureTools(); if (!native) return t.skip("Native fixture tools unavailable");
    const context = new LoweringContext(), lowered = lowerGltfAnimationPointerWriters(context);
    const iorDeclaration = context.functionDeclaration("src/loader-gltf/animation-pointer-ext.ts", "iorToF0Factor").declaration;
    const iorFactor = new Function("exports", transpileCommonJs(`${iorDeclaration.getText()}\nreturn iorToF0Factor;`, "ior.ts"))({}) as (value: number) => number;
    const materialContexts = [context, doctoredContext("src/loader-gltf/animation-pointer-basecolor.ts",
        "mat._baseColorFactor = [1, 1, 1, 1];", "mat._baseColorFactor = [0.5, 0.5, 0.5, 0.5];")];
    const materialLowerings = materialContexts.map(context => lowerGltfMaterialProperties(context));
    const whiteCases = [];
    for (const [version, context] of materialContexts.entries()) for (const present of [false, true])
        for (const image of [false, true]) for (const selected of [false, true]) for (const module of [false, true]) {
            const input = {_baseColorFactor: [.2, .4, .6, .8], ...(present ? {_rawMatDef: {}} : {}), _baseColorImage: image ? {} : null};
            const definitions = new WeakSet<object>(); if (selected && input._rawMatDef) definitions.add(input._rawMatDef);
            const definition = context.functionDeclaration("src/loader-gltf/animation-pointer-basecolor.ts", "whiteFallback").declaration;
            const white = new Function("exports", "_animBaseColorDefs", transpileCommonJs(`${definition.getText()}\nreturn whiteFallback;`, "white.ts"))({}, definitions);
            const feature = context.sourceFile("src/loader-gltf/gltf-feature-animation-pointer.ts");
            const methods = context.findNodes(feature, (node): node is ts.MethodDeclaration =>
                ts.isMethodDeclaration(node) && node.name.getText() === "applyMaterial");
            const apply = new Function("mat", "_baseColorMod", transpileCommonJs(`return (async () => ${methods[0]!.body!.getText()})();`, "apply.ts"));
            const result = await apply(input, module ? {whiteFallback: white} : null);
            whiteCases.push({version, present, image, selected, module, factor: input._baseColorFactor, returned: result?.baseColorFactor ?? null});
        }
    const writer = (body: string) => lowered.writers.find(writer => writer.declaration.body.getText().includes(body))!.site;
    const closure = (site: string, values: Record<string, unknown>) => ({kind: "closure", site, values});
    const mat = {kind: "material", index: 0, path: []};
    const textureOwners = [
        {path: ["ormTexture"], field: "orm"},
        {path: ["occlusionTexture"], field: "occlusion"},
        {path: ["_anisotropy", "texture"], field: "anisotropy"},
        {path: ["_subsurface", "translucency", "colorTexture"], field: "translucency_color"},
        {path: ["_subsurface", "translucency", "intensityTexture"], field: "translucency_intensity"},
        {path: ["_metallicReflectanceTexture"], field: "metallic_reflectance"},
        {path: ["_reflectanceTexture"], field: "reflectance"},
    ];
    const captures = {
        base: closure(writer("mat.baseColorFactor![0]"), {mat}),
        roughness: closure(writer("mat.roughnessFactor ="), {mat}),
        uv: closure(writer("tex.uAng ="), {mat, tex: {...mat, path: ["ormTexture"]}}),
        transmission: closure(writer("refr.intensity ="), {mat, refr: {...mat, path: ["_subsurface", "refraction"]}}),
        ior: closure(writer("mat._metallicF0Factor ="), {mat}),
        thickness: closure(writer("ss.thickness.max ="), {mat,
            m: {kind: "array", values: ["pointer", "0", "thicknessFactor"].map(value => ({kind: "literal", value}))}}),
        light: closure(writer('field === "color"'), {
            field: {kind: "literal", value: "spot/outerConeAngle"},
            getLight: closure(lowered.writers.find(writer => writer.kind === "lookup")!.site,
                {ctx: {kind: "context"}, lightIdx: {kind: "literal", value: 0}}),
        }),
    };
    const directory = resolve("artifacts/test-gltf-animation-pointer-runtime"); mkdirSync(directory, {recursive: true});
    writeFileSync(resolve(directory, "cases.json"), JSON.stringify({...captures, whiteCases,
        textureOwners: textureOwners.map(({path}) => closure(writer("tex.uScale ="),
            {mat, tex: {...mat, path}, isScale: {kind: "literal", value: false}})),
    }));
    const projection = gltfMaterialProjection(true);
    const file = resolve(directory, "check.cpp"), executable = resolve(directory, "check.exe");
    const spot = new LightLowerer(context).lowerSpotFactory().source;
    writeFileSync(file, `#include <bblite/runtime.hpp>
#include <bblite/ts_runtime.hpp>
#include <bblite/js_data.hpp>
#include <bit>
#include <cassert>
#include <fstream>
namespace bbl {
const ts::JsonValue* optional(const ts::JsonValue::Object& value, const std::string& key) {
    const auto found = value.find(key); return found == value.end() ? nullptr : &found->second;
}
std::size_t gltf_checked_index(double value) {
    if (!std::isfinite(value) || value < 0 || std::floor(value) != value) throw std::runtime_error("Invalid index.");
    return static_cast<std::size_t>(value);
}
struct GltfPbrObject;
struct GltfMaterialTexture {
    struct Identity { std::weak_ptr<GltfPbrObject> value; };
    std::shared_ptr<Identity> identity = std::make_shared<Identity>();
    int image = 7;
    explicit operator bool() const { return true; }
    GltfMaterialTexture clone() const { auto result = *this; result.identity = std::make_shared<Identity>(); return result; }
};
using GltfMaterialImage = std::shared_ptr<int>;
${gltfMaterialValueRuntime}
${["void gltf_pbr_number(", "void gltf_pbr_color(", "void gltf_pbr_transform("].map(signature => cppFunction(projection, signature)).join("\n")}
${gltfAnimationPointerOwnersCpp}
${lowered.source}
${gltfAnimationPointerRuntimeCpp()}
${cppFunction(spot, "void refresh_spot_light_cone(")}
struct GltfPbrContext { bool base_color_definition = false, base_color_module = false; };
${materialLowerings.map((lowered, index) => `namespace white_${index} {
${[lowered.functions.find(target => target.name === "whiteFallback")!, lowered.features.find(feature => feature.handler.module.endsWith("/gltf-feature-animation-pointer.ts"))!.handler]
        .map(target => cppFunction(lowered.source, `GltfPbrValue ${target.cpp}(`)).join("\n")}
}`).join("\n")}
}
int main(int argc, char** argv) {
    assert(argc == 2); using namespace bbl;
    std::ifstream input(argv[1]); const auto cases = ts::JsonValue::from_native(nlohmann::json::parse(nlohmann::json::parse(input).dump()));
    for (const auto& item : cases.as_object().at("whiteCases").as_array()) {
        const auto& fields = item.as_object(); auto core = GltfPbrValue::object();
        core.set("_baseColorFactor", GltfPbrValue{std::vector<double>{.2, .4, .6, .8}});
        if (fields.at("present").as_boolean()) core.set("_rawMatDef", GltfPbrValue::object());
        if (fields.at("image").as_boolean()) core.set("_baseColorImage", GltfPbrValue::object());
        const GltfPbrContext context{fields.at("selected").as_boolean(), fields.at("module").as_boolean()};
        const auto result = fields.at("version").as_number() == 0
            ? white_0::gltf_pbr_gltf_feature_animation_pointer_applyMaterial(core, context)
            : white_1::gltf_pbr_gltf_feature_animation_pointer_applyMaterial(core, context);
        for (std::size_t index = 0; index < 4; ++index)
            assert(core.get("_baseColorFactor").at(static_cast<double>(index)).number() == fields.at("factor").as_array()[index].as_number());
        assert(result.nullish() == fields.at("returned").is_null());
        if (!result.nullish()) for (std::size_t index = 0; index < 4; ++index)
            assert(result.get("baseColorFactor").at(static_cast<double>(index)).number() == fields.at("returned").as_array()[index].as_number());
    }
    ${textureOwners.map(({path, field}, index) => `{
        Engine owner_engine; owner_engine.materials.resize(2);
        auto& material = owner_engine.materials[0];
        material.${field}_transform.u_offset = 11; material.${field}_transform.v_offset = 12;
        auto props = GltfPbrValue::object(), owner = props;
        ${path.slice(0, -1).map(key => `{
            auto child = GltfPbrValue::object(); owner.set(${JSON.stringify(key)}, child); owner = child;
        }`).join("\n")}
        auto shared_texture = GltfPbrValue{GltfMaterialTexture{}};
        shared_texture.set("uOffset", GltfPbrValue{11.0}); shared_texture.set("vOffset", GltfPbrValue{12.0});
        const auto private_texture = shared_texture.clone();
        owner.set(${JSON.stringify(path.at(-1))}, private_texture); props.set("_uboVersion", GltfPbrValue{0.0});
        auto runtime = std::make_shared<GltfAnimationPointerRuntime>(); runtime->engine = &owner_engine;
        runtime->handles = {MaterialHandle{0}}; runtime->properties = {props};
        auto animate = gltf_bind_animation_pointer(runtime, cases.as_object().at("textureOwners").as_array().at(${index}));
        animate(std::vector<float>{.25f, .75f}, 0.0);
        assert(material.${field}_transform.u_offset == .25f && material.${field}_transform.v_offset == .75f);
        assert(private_texture.get("uOffset").number() == .25 && shared_texture.get("uOffset").number() == 11);
        assert(owner_engine.materials[1].${field}_transform.u_offset == 0);
        ${field === "orm" || field === "occlusion" ? `++material.${field}_texture_generation;
        material.${field}_transform.u_offset = 21; material.${field}_transform.v_offset = 22;
        animate(std::vector<float>{.5f, 1.25f}, 0.0);
        assert(material.${field}_transform.u_offset == 21 && material.${field}_transform.v_offset == 22);
        assert(private_texture.get("uOffset").number() == .5 && private_texture.get("vOffset").number() == 1.25);` : ""}
    }`).join("\n")}
    Engine engine; engine.materials.resize(2); engine.lights.resize(1);
    auto& material = engine.materials[0];
    material.source_base_color_factor = std::make_shared<std::vector<double>>(std::initializer_list<double>{.1, .2, .3, .4});
    material.roughness_factor = static_cast<float>(.123456789012345);
    material.emissive_factor = Color3{.11f, .22f, .33f};
    material.index_of_refraction = 1.5f; material.source_refraction_intensity = 0.0;
    auto props = GltfPbrValue::object(), texture = GltfPbrValue{GltfMaterialTexture{}}, refraction = GltfPbrValue::object(), subsurface = GltfPbrValue::object();
    refraction.set("intensity", GltfPbrValue{0.0}); refraction.set("indexOfRefraction", GltfPbrValue{1.5}); subsurface.set("refraction", refraction);
    props.set("_subsurface", subsurface); props.set("ormTexture", texture); props.set("_uboVersion", GltfPbrValue{1.0});
    props.set("roughnessFactor", GltfPbrValue{.123456789012345});
    props.set("_emissiveColor", GltfPbrValue::array({GltfPbrValue{.11}, GltfPbrValue{.22}, GltfPbrValue{.33}}));
    auto runtime = std::make_shared<GltfAnimationPointerRuntime>(); runtime->engine = &engine;
    runtime->handles = {MaterialHandle{0}, MaterialHandle{1}}; runtime->properties = {props, GltfPbrValue::object()}; runtime->document = GltfPbrValue::object();
    auto base = gltf_bind_animation_pointer(runtime, cases.as_object().at("base"));
    const auto publicArray = material.source_base_color_factor;
    base(std::vector<float>{.25f, .5f, .75f, 1.0f}, 0.0);
    assert(material.source_base_color_factor == publicArray && (*publicArray)[2] == .75);
    assert(props.get("baseColorFactor").at(1).number() == .5);
    assert(props.get("roughnessFactor").number() == .123456789012345);
    assert(material.roughness_factor == static_cast<float>(.123456789012345));
    material.emissive_factor.g = .875f; material.roughness_factor = .625f; (*publicArray)[0] = .125;
    auto transmission = gltf_bind_animation_pointer(runtime, cases.as_object().at("transmission"));
    transmission(std::vector<float>{.375f}, 0.0);
    assert(material.emissive_factor.g == .875f && props.get("_emissiveColor").at(1).number() == .875);
    assert(props.get("roughnessFactor").number() == .625 && props.get("baseColorFactor").at(0).number() == .125);
    assert(material.transmission_factor == .375f && material.source_refraction_intensity == .375 && material.source_transmissive);
    assert(engine.materials[1].transmission_factor == 0.0f);
    auto animateIor = gltf_bind_animation_pointer(runtime, cases.as_object().at("ior"));
    ${[1, 1.2, 1.5, 2, 3].map(sample => `animateIor(std::vector<float>{static_cast<float>(${context.doubleLiteral(sample)})}, 0.0);
    assert(material.index_of_refraction == static_cast<float>(${context.doubleLiteral(sample)}));
    assert(material.metallic_f0_factor == static_cast<float>(${context.doubleLiteral(iorFactor(Math.fround(sample)))}));
    assert(material.specular_weight == 1.0f);`).join("\n")}
    auto animateThickness = gltf_bind_animation_pointer(runtime, cases.as_object().at("thickness"));
    animateThickness(std::vector<float>{.25f}, 0.0);
    assert(material.thickness == .25f && material.use_thickness_as_depth);
    auto uv = gltf_bind_animation_pointer(runtime, cases.as_object().at("uv"));
    uv(std::vector<float>{.5f}, 0.0); assert(material.orm_transform.rotation == .5f);
    ++material.orm_texture_generation; material.orm_transform.rotation = .75f;
    uv(std::vector<float>{1.25f}, 0.0);
    assert(texture.get("uAng").number() == 1.25 && material.orm_transform.rotation == .75f);
    assert(!props.get("ormTexture").equals(texture) && props.get("ormTexture").get("uAng").number() == .75);
    const auto patch = ts::JsonValue::from_native(nlohmann::json::parse(R"({"path":["normalTexture"],"operation":"clone"})"));
    props.set("normalTexture", texture); gltf_pointer_material_patch(props, patch);
    assert(!props.get("normalTexture").equals(texture) && props.get("normalTexture").texture().image == 7);
    auto& light = engine.lights[0]; light.kind = LightKind::spot; refresh_spot_light_cone(light, .6);
    runtime->add_light(LightHandle{0}, ts::JsonValue::from_native(nlohmann::json::parse(R"({"kind":"spot","intensity":1,"range":1.7976931348623157e308,"diffuse":[0.1,0.2,0.3],"specular":[0.4,0.5,0.6],"spot":{"angle":0.6},"bumpVersion":true})")));
    bool present = false; int reads = 0, bumps = 0;
    runtime->lookup_light = [&](std::size_t index) -> std::optional<LightHandle> { assert(index == 0); ++reads; return present ? std::optional{LightHandle{0}} : std::nullopt; };
    runtime->set_light_angle = [](Engine& engine, LightHandle handle, double angle) { refresh_spot_light_cone(engine.lights[handle.value], angle); };
    runtime->bump_light_version = [&](Engine&, LightHandle) { ++bumps; };
    runtime->configure_light_effects();
    auto animateLight = gltf_bind_animation_pointer(runtime, cases.as_object().at("light"));
    animateLight(std::vector<float>{.5f}, 0.0); assert(reads == 1 && bumps == 0 && light.angle == .6);
    present = true; light.intensity = 3.0f;
    animateLight(std::vector<float>{.5f}, 0.0);
    assert(reads == 2 && bumps == 1 && light.angle == 1.0 && light.cos_half_angle == static_cast<float>(std::cos(.5)) && light.intensity == 3.0f && light.range == std::numeric_limits<float>::max());
    std::weak_ptr<GltfAnimationPointerRuntime> lifetime = runtime;
    base = {}; transmission = {}; uv = {}; animateIor = {}; animateThickness = {}; animateLight = {}; runtime.reset(); assert(lifetime.expired());
}
`);
    runNativeFixtureCompiler(native, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD", "/O2",
        `/Fo:${directory}/`, `/Fe:${executable}`, "/I", "native/include", "/I", resolve(nativeFixtureVcpkgRoot, "include"), file]);
    execFileSync(executable, [resolve(directory, "cases.json")], {stdio: "pipe"});
});
