import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";
import ts from "typescript";
import {LoweringContext} from "../src/lowering/context.js";
import {lowerGltfAnimationPointerWriters, type GltfPointerWriterFunction} from "../src/lowering/gltf/animation-pointer-writers.js";
import {gltfMaterialValueRuntime} from "../src/lowering/gltf/material-value-runtime.js";
import {gltfAnimationPointerOwnersCpp} from "../src/lowering/gltf/animation-pointer-owners.js";
import {compileSource} from "../src/compiler.js";
import {transpileCommonJs} from "../src/typescript-transpile.js";
import {doctoredContext} from "./doctored-store.js";
import {nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler} from "./native-fixture.js";

type Value = Record<string, unknown>;
function sourceWriter(context: LoweringContext, writer: GltfPointerWriterFunction, captures: Value, effects: Value): (...args: unknown[]) => unknown {
    const declarations = context.sourceFile(writer.site.split(":")[0]!).statements
        .filter(ts.isFunctionDeclaration).map(value => value.getText()).join("\n");
    const names = [...Object.keys(effects), ...writer.captures];
    const source = `${declarations}\nreturn (${writer.declaration.getText()});`;
    return new Function("exports", ...names, transpileCommonJs(source, "pointer-writer.ts"))({},
        ...Object.values(effects), ...writer.captures.map(name => captures[name])) as (...args: unknown[]) => unknown;
}

function sourceCases(context: LoweringContext, writers: GltfPointerWriterFunction[]) {
    const cases: Value[] = [];
    const lookup = writers.find(writer => writer.kind === "lookup")!;
    for (const writer of writers) for (let variant = 0; variant < 8; ++variant) {
        const input = {
            mat: {_uboVersion: 3, baseColorFactor: [1,1,1,1], baseColorTexture: {uScale: 1, vScale: 1, uOffset: 0, vOffset: 0, uAng: 0},
                ...(variant === 1 ? {} : {_emissiveColor: [2,3,4]}), _animEmissiveFactor: [.1,.2,.3], _animEmissiveStrength: 2,
                _subsurface: {refraction: {intensity: 1, indexOfRefraction: 1.5}, thickness: {min: 0, max: .2}, tint: {color: [1,1,1], atDistance: 1}},
                _iridescence: {isEnabled: true, intensity: 1, indexOfRefraction: 1.3, maximumThickness: 250}},
            n: {visible: true}, document: {},
            light: variant === 0 ? null : {lightType: variant === 1 ? "point" : "spot", intensity: 1, range: 8, angle: .6,
                ...(variant === 2 ? {} : {diffuse: [1,1,1], specular: [1,1,1]})},
            field: ["color", "intensity", "range", "spot/outerConeAngle"][variant % 4],
            branch: ["thicknessFactor", "attenuationDistance", "attenuationColor", "iridescenceFactor", "iridescenceIor", "iridescenceThicknessMaximum"][variant % 6],
            isScale: variant % 2 === 0, withBump: variant !== 3,
        };
        const state: typeof input & {light: (NonNullable<typeof input.light> & {_bumpLightVersion?: () => void}) | null} = structuredClone(input);
        const events = {visibility: 0, lookup: 0, bump: 0};
        if (state.light && state.withBump) state.light._bumpLightVersion = () => { ++events.bump; };
        const effects = {
            setSubtreeVisible(node: Value, visible: boolean) { node.visible = visible; ++events.visibility; },
            getGltfPunctualLight(document: object, index: number) { assert.equal(document, state.document); assert.equal(index, 0); ++events.lookup; return state.light; },
        };
        const captures = {mat: state.mat, n: state.n, tex: state.mat.baseColorTexture, refr: state.mat._subsurface.refraction,
            iri: state.mat._iridescence, m: ["pointer", "0", state.branch], isScale: state.isScale,
            field: state.field, ctx: {_json: state.document}, lightIdx: 0,
            getLight: sourceWriter(context, lookup, {ctx: {_json: state.document}, lightIdx: 0}, effects)};
        const output = Float32Array.from([99, -.25, .5, .75, 1.125, 2.25]);
        const result = sourceWriter(context, writer, captures, effects)(...(writer.kind === "writer" ? [output, 1] : []));
        if (state.light) delete state.light._bumpLightVersion;
        cases.push({site: writer.site, lookupSite: lookup.site, input, output: [...output], expected: state, events,
            ...(writer.kind === "lookup" ? {result: result ?? null} : {})});
    }
    return cases;
}

test("source pointer bodies and native aliased stores agree across every writer and guard", async t => {
    const native = optionalNativeFixtureTools(); if (!native) return t.skip("Native fixture tools unavailable");
    const contexts = [new LoweringContext(), doctoredContext("src/loader-gltf/animation-pointer-lights.ts", "light.angle = out[off]! * 2;", "light.angle = out[off]! * 3;")];
    const lowered = contexts.map(context => lowerGltfAnimationPointerWriters(context));
    const cases = lowered.map((value, index) => sourceCases(contexts[index]!, value.writers));
    assert.ok(cases[0]!.length >= 100);
    assert.notDeepEqual(cases[0], cases[1]);
    const directory = resolve("artifacts/test-gltf-animation-pointer-writers"); mkdirSync(directory, {recursive: true});
    writeFileSync(resolve(directory, "cases.json"), JSON.stringify(cases));
    const file = resolve(directory, "check.cpp"), executable = resolve(directory, "check.exe");
    writeFileSync(file, `#include <bblite/ts_runtime.hpp>
#include <cassert>
#include <fstream>
#include <memory>
namespace ts = bbl::ts;
namespace bbl { const ts::JsonValue* optional(const ts::JsonValue::Object& value, const std::string& key) {
    const auto found = value.find(key); return found == value.end() ? nullptr : &found->second;
} }
struct GltfPbrObject;
struct GltfMaterialTexture {
    struct Identity { std::weak_ptr<GltfPbrObject> value; };
    std::shared_ptr<Identity> identity = std::make_shared<Identity>();
    explicit operator bool() const { return true; }
    GltfMaterialTexture clone() const { return {}; }
};
using GltfMaterialImage = std::shared_ptr<int>;
${gltfMaterialValueRuntime}
${gltfAnimationPointerOwnersCpp}
GltfPbrValue mutable_value(const nlohmann::json& value) {
    if (value.is_null()) return GltfPbrValue{nullptr};
    if (value.is_boolean()) return GltfPbrValue{value.get<bool>()};
    if (value.is_number()) return GltfPbrValue{value.get<double>()};
    if (value.is_string()) return GltfPbrValue{value.get<std::string>()};
    if (value.is_array()) { auto result = GltfPbrValue::array({}); for (const auto& item : value) result.push(mutable_value(item)); return result; }
    auto result = GltfPbrValue::object(); for (const auto& [key, item] : value.items()) result.set(key, mutable_value(item)); return result;
}
void equal(const GltfPbrValue& actual, const nlohmann::json& expected) {
    if (expected.is_null()) { assert(actual.nullish()); return; }
    if (expected.is_boolean()) { assert(actual.equals(GltfPbrValue{expected.get<bool>()})); return; }
    if (expected.is_string()) { assert(actual.string() == expected.get<std::string>()); return; }
    if (expected.is_number()) { assert(actual.number() == expected.get<double>()); return; }
    assert(actual.size() == expected.size());
    if (expected.is_array()) { for (std::size_t index = 0; index < expected.size(); ++index) equal(actual.at(double(index)), expected[index]); return; }
    for (const auto& [key, value] : expected.items()) equal(actual.get(key), value);
}
${lowered.map((value, index) => `namespace version_${index} {
${value.source}
void run(const nlohmann::json& item) {
    auto state = mutable_value(item.at("input")), captures = GltfPbrValue::object();
    const auto mat = state.get("mat"), light = state.get("light"), document = state.get("document");
    if (light && state.get("withBump").truthy()) light.set("_bumpLightVersion", GltfPbrValue{true});
    auto context = GltfPbrValue::object(); context.set("_json", document);
    for (const auto& key : {"mat", "n", "field", "isScale"}) captures.set(key, state.get(key));
    captures.set("tex", mat.get("baseColorTexture")); captures.set("refr", mat.get("_subsurface").get("refraction"));
    captures.set("iri", mat.get("_iridescence")); captures.set("m", GltfPbrValue::array({GltfPbrValue{"pointer"}, GltfPbrValue{"0"}, state.get("branch")}));
    captures.set("ctx", context); captures.set("lightIdx", GltfPbrValue{0.0});
    auto helper = GltfPbrValue::object(), helperCaptures = GltfPbrValue::object();
    helperCaptures.set("ctx", context); helperCaptures.set("lightIdx", GltfPbrValue{0.0});
    helper.set("site", GltfPbrValue{item.at("lookupSite").get<std::string>()}); helper.set("values", helperCaptures);
    captures.set("getLight", helper);
    std::size_t visibility = 0, lookup = 0, bump = 0;
    GltfAnimationPointerEffects effects;
    effects.set_visibility = [&](GltfPbrValue node, GltfPbrValue visible) { node.set("visible", visible); ++visibility; return GltfPbrValue{}; };
    effects.lookup_light = [&](GltfPbrValue owner, GltfPbrValue slot) { assert(owner.equals(document)); assert(slot.number() == 0); ++lookup; return light; };
    effects.bump_light_version = [&](GltfPbrValue target) { assert(target.equals(light)); ++bump; return GltfPbrValue{}; };
    effects.invoke_closure = [&](GltfPbrValue closure) { return gltf_animation_pointer_function(closure.get("site").string())(effects, closure.get("values"), {}, {}); };
    auto output = item.at("output").get<std::vector<float>>();
    const auto borrowed = GltfPbrValue::float32(output); assert(!borrowed.is_array()); assert(borrowed.get("length").number() == double(output.size()));
    const auto result = gltf_animation_pointer_function(item.at("site").get<std::string>())(effects, captures, borrowed, GltfPbrValue{1.0});
    if (light) light.erase("_bumpLightVersion");
    equal(state, item.at("expected"));
    if (item.contains("result")) equal(result, item.at("result"));
    assert(visibility == item.at("events").at("visibility")); assert(lookup == item.at("events").at("lookup")); assert(bump == item.at("events").at("bump"));
}
}`).join("\n")}
void capture_owners() {
    const auto mat = GltfPbrValue::object(), tex = GltfPbrValue::object();
    mat.set("ormTexture", tex);
    const auto encoded = ts::JsonValue::from_native(nlohmann::json{{"kind", "closure"}, {"site", "root"}, {"values", {
        {"mat", {{"kind", "material"}, {"index", 3}, {"path", nlohmann::json::array()}}},
        {"tex", {{"kind", "material"}, {"index", 3}, {"path", {"ormTexture"}}}},
        {"getLight", {{"kind", "closure"}, {"site", "lookup"}, {"values", {{"ctx", {{"kind", "context"}}}}}}},
    }}});
    GltfAnimationPointerCaptureOwners owners; owners.context = GltfPbrValue::object();
    owners.material = [&](std::size_t index, const std::vector<std::string>& path) { assert(index == 3); return path.empty() ? mat : tex; };
    std::vector<std::string> sites;
    owners.bind_closure = [&](const std::string& site, GltfPbrValue fields) { sites.push_back(site); return fields; };
    const auto decoded = read_gltf_animation_pointer_capture(encoded, owners);
    assert(decoded.get("mat").equals(mat) && decoded.get("tex").equals(tex));
    assert(decoded.get("getLight").get("ctx").equals(owners.context));
    assert((sites == std::vector<std::string>{"lookup", "root"}));
}
int main() { nlohmann::json cases; std::ifstream("cases.json") >> cases;
${lowered.map((_, index) => `    for (const auto& item : cases[${index}]) version_${index}::run(item);`).join("\n")}
    capture_owners();
}
`);
    runNativeFixtureCompiler(native, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD", "/O2",
        `/Fo:${directory}/`, `/Fe:${executable}`, "/I", "native/include", "/I", resolve(nativeFixtureVcpkgRoot, "include"), file]);
    assert.equal(execFileSync(executable, {cwd: directory, encoding: "utf8"}), "");
});

test("admitted glTF ORM and occlusion replacements cannot reattach their original file wrapper", () => {
    const source = (slot: string, replacement: string) => `
        import {addToScene, createEngine, createSceneContext, createSolidTexture2D, loadGltf, registerScene, startEngine} from "@babylonjs/lite";
        import type {PbrMaterialProps} from "@babylonjs/lite";
        async function main() {
            const engine = await createEngine({}); const scene = createSceneContext(engine);
            const asset = await loadGltf(engine, "/model.glb"); addToScene(scene, asset);
            const material = scene.meshes[0]!.material as PbrMaterialProps;
            const old = material.${slot}!; material.${slot} = ${replacement};
            await registerScene(scene); await startEngine(engine);
        }
        void main();`;
    for (const slot of ["ormTexture", "occlusionTexture"]) {
        assert.throws(() => compileSource(source(slot, "old")), /requires a solid texture|uses createSolidTexture2D/);
        assert.match(compileSource(source(slot, "createSolidTexture2D(engine, 1, 1, 1)")).cpp, /set_material_orm_file|set_pbr_occlusion_solid_texture/);
    }
});
