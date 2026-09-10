import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";
import {asObject, asRecords, GLTF_MESH_PLAN, type JsonObject} from "../src/gltf-document.js";
import {gltfMeshPlan, packageGltfMeshPlan, packagedGltfMeshPlan} from "../src/gltf-mesh-plan.js";
import {gltfNodeLights} from "../src/pinned-material-arms.js";
import {GltfLowerer} from "../src/lowering/gltf/loader.js";
import {LoweringContext} from "../src/lowering/context.js";
import {buildGlb} from "./glb-fixture.js";
import {doctoredContext} from "./doctored-store.js";
import {meshPlanFixture, readPackedGltfAttribute} from "./gltf-mesh-fixture.js";
import {cppFunction, cppSection, nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler} from "./native-fixture.js";

const module = "src/loader-gltf/gltf-feature-lights-punctual.ts";
function fixture() {
    const light = (index: number) => ({KHR_lights_punctual: {light: index}});
    return meshPlanFixture({
        extensionsUsed: ["KHR_lights_punctual"],
        extensions: {KHR_lights_punctual: {lights: [
            {type: "point", color: [0.25, 0.5, 1]},
            {type: "directional", intensity: 2},
            {type: "spot", range: 4, spot: {outerConeAngle: 0.3}},
            {type: "unknown"}, {type: "point"},
        ]}},
        nodes: [
            {mesh: 0, children: [1, 2, 3]},
            {translation: [1, 2, 3], extensions: light(0)},
            {translation: [0, 4, 0], rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2], extensions: light(1)},
            {translation: [0, 0, 5], extensions: light(2)},
            {translation: [-2, 0, 0], extensions: light(0)},
            {extensions: light(3)}, {extensions: light(7)},
        ],
        meshes: [{primitives: [{}]}], scenes: [{nodes: [0]}],
    });
}

test("source light constructors retain defaults, selected parents, baked worlds and definition aliases", async () => {
    const {document, bin} = fixture();
    const binary = await packageGltfMeshPlan(document, bin);
    const plan = packagedGltfMeshPlan(document);
    assert.deepEqual(plan.lights.map(light => [light.kind, light.node]), [["point", 1], ["directional", 2], ["spot", 3], ["point", null]]);
    assert.deepEqual(plan.sceneLights, [0, 1, 2, 3]);
    assert.deepEqual(plan.lightTargets, [3, 1, 2, null, null]);
    const worlds = plan.lights.map(light => readPackedGltfAttribute(document, binary, light.world));
    assert.deepEqual(worlds[0]!.slice(12, 15), [-1, 2, 3]);
    assert.deepEqual(worlds[3]!.slice(12, 15).map(value => value + 0), [2, 0, 0]);
    assert.ok(Math.abs(worlds[1]![8]! - 1) < 1e-6);
    assert.ok(Math.abs(worlds[1]![10]!) < 1e-6);
    assert.deepEqual(plan.lights[0]!.diffuse, [0.25, 0.5, 1]);
    assert.deepEqual(plan.lights[0]!.specular, plan.lights[0]!.diffuse);
    assert.equal(plan.lights[0]!.intensity, 1);
    assert.equal(plan.lights[0]!.range, Number.MAX_VALUE);
    assert.equal(plan.lights[1]!.range, undefined);
    assert.deepEqual(plan.lights[2]!.spot, {angle: 0.6, cosine: Math.fround(Math.cos(0.3)), exponent: 1});
    const directory = resolve("artifacts/test-gltf-light-plan");
    mkdirSync(directory, {recursive: true});
    const file = resolve(directory, "lights.glb");
    writeFileSync(file, buildGlb(document, binary));
    assert.deepEqual(gltfNodeLights(file), {count: 4, kinds: ["point", "directional", "spot"]});
});

test("feature and constructor changes flow through the light plan", async () => {
    const {document, bin} = fixture();
    const changed = async (needle: string, replacement: string) => gltfMeshPlan(document, bin, doctoredContext(module, needle, replacement));
    const intensity = await changed("def.intensity ?? 1", "def.intensity ?? 3");
    assert.deepEqual(intensity.lights.map(light => light.intensity), [3, 2, 3, 3]);
    const color = await changed(": [1, 1, 1];", ": [1, 0.5, 1];");
    assert.deepEqual(color.lights[2]!.diffuse, [1, 0.5, 1]);
    const range = await changed("def.range !== undefined ? def.range : Number.MAX_VALUE", "def.range !== undefined ? def.range : 1000");
    assert.deepEqual(range.lights.map(light => light.range), [1000, undefined, 4, 1000]);
    const angle = await changed("createSpotLight([px, py, pz], dir, outer * 2, 1, intensity)", "createSpotLight([px, py, pz], dir, outer * 3, 2, intensity)");
    assert.equal(angle.lights[2]!.spot!.angle, 0.3 * 3);
    assert.equal(angle.lights[2]!.spot!.cosine, Math.fround(Math.cos(0.3 * 3 * 0.5)));
    assert.equal(angle.lights[2]!.spot!.exponent, 2);
    const constructor = await gltfMeshPlan(document, bin, doctoredContext("src/light/spot-light.ts",
        "Math.cos(angle * 0.5)", "Math.cos(angle * 0.25)"));
    assert.equal(constructor.lights[2]!.spot!.cosine, Math.fround(Math.cos(0.15)));
});

test("source light membership, order, repetition and pointer identity remain independent", async () => {
    const {document, bin} = fixture();
    const reversed = await gltfMeshPlan(document, bin, doctoredContext(module, "return { entities: lights };", "return { entities: lights.reverse() };"));
    assert.deepEqual(reversed.lights.map(light => light.node), [null, 3, 2, 1]);
    assert.deepEqual(reversed.lightTargets, [0, 2, 1, null, null]);
    const repeated = await gltfMeshPlan(document, bin, doctoredContext(module, "return { entities: lights };", "return { entities: [...lights, ...lights] };"));
    assert.equal(repeated.lights.length, 4);
    assert.deepEqual(repeated.sceneLights, [0, 1, 2, 3, 0, 1, 2, 3]);
    const filtered = await gltfMeshPlan(document, bin, doctoredContext(module,
        "if (lightIdx === undefined)", "if (lightIdx === undefined || nodeIdx === 1)"));
    assert.deepEqual(filtered.lights.map(light => light.node), [2, 3, null]);
    assert.deepEqual(filtered.lightTargets, [2, 0, 1, null, null]);
    const registration = await gltfMeshPlan(document, bin, doctoredContext("src/scene/scene-core.ts",
        "ctx.lights.push(entity as LightBase);", "if (entity.intensity > 1) ctx.lights.push(entity as LightBase);"));
    assert.deepEqual(registration.sceneLights, [0]);
    assert.deepEqual(registration.lights.map(light => light.node), [2, null, 3]);
    assert.deepEqual(registration.lightTargets, [1, 0, 2, null, null]);
});

test("feature activation and source light budgets control admission without leaking bindings across loads", async () => {
    const {document, bin} = fixture();
    const original = structuredClone(document);
    assert.equal((await gltfMeshPlan(document, bin)).lights.length, 4);
    const disabled = await gltfMeshPlan(document, bin, doctoredContext("src/loader-gltf/load-gltf.ts",
        "_appendEnabledGltfFeatures(json, features);", "features.length = 0;"));
    assert.deepEqual(disabled.lights, []);
    assert.deepEqual(disabled.lightTargets, [null, null, null, null, null]);
    assert.deepEqual(document, original);
    assert.deepEqual((await gltfMeshPlan({...document, extensionsUsed: []}, bin)).lights, []);
    document.nodes = [...asRecords(document.nodes), ...Array.from({length: 20}, () => ({extensions: {KHR_lights_punctual: {light: 0}}}))];
    await assert.rejects(gltfMeshPlan(document, bin), /requested MAX_LIGHTS/);
    const extensions = asObject(document.extensions)!;
    extensions.KHR_lights_punctual = {lights: []};
    assert.deepEqual((await gltfMeshPlan(document, bin)).lights, []);
});

test("unrepresented light resources and invalid packaged bindings refuse", async () => {
    const {document, bin} = fixture();
    await assert.rejects(gltfMeshPlan(document, bin, doctoredContext("src/light/directional-light.ts",
        'lightType: "directional" as const', 'lightType: "ambient" as const')), /Unsupported glTF light kind/);
    await packageGltfMeshPlan(document, bin);
    const plan = packagedGltfMeshPlan(document);
    const invalid: JsonObject[] = [
        {...plan, lights: undefined}, {...plan, sceneLights: [99]}, {...plan, lightTargets: [99]}, {...plan, lightTargets: []},
        ...[{...plan.lights[0], world: 999}, {...plan.lights[0], node: 99}, {...plan.lights[0], diffuse: [1]},
            {...plan.lights[0], intensity: NaN}, {...plan.lights[0], kind: "ambient"}, {...plan.lights[2], spot: {}}]
            .map(light => ({...plan, lights: [light, ...plan.lights.slice(1)]})),
    ];
    for (const value of invalid) assert.throws(() => packagedGltfMeshPlan({...document, [GLTF_MESH_PLAN]: value}), /Invalid|Unsupported|Missing/);
});

test("native light transport preserves source worlds, registration aliases and nullable node/definition bindings", async t => {
    const tools = optionalNativeFixtureTools();
    if (!tools) { t.skip("Native fixture compiler unavailable."); return; }
    const contexts = [new LoweringContext(),
        doctoredContext(module, "return { entities: lights };", "return { entities: [...lights, ...lights] };"),
        doctoredContext("src/scene/scene-core.ts", "ctx.lights.push(entity as LightBase);", "if (entity.intensity > 1) ctx.lights.push(entity as LightBase);"),
        doctoredContext("src/loader-gltf/load-gltf.ts", "_appendEnabledGltfFeatures(json, features);", "features.length = 0;"),
    ];
    const cases = [];
    for (const context of contexts) {
        const {document, bin} = fixture();
        const binary = await packageGltfMeshPlan(document, bin, context);
        const plan = packagedGltfMeshPlan(document);
        const worlds = plan.lights.map(light => ({accessor: light.world,
            bits: [...new Uint32Array(Float32Array.from(readPackedGltfAttribute(document, binary, light.world)).buffer)]}));
        cases.push({plan, worlds});
    }
    const directory = resolve("artifacts/test-gltf-light-plan"); mkdirSync(directory, {recursive: true});
    writeFileSync(resolve(directory, "native-cases.json"), JSON.stringify(cases));
    const loader = new GltfLowerer(new LoweringContext()).lowerLoaderAdapter({animationPointer: true}).source;
    const file = resolve(directory, "check.cpp"), executable = resolve(directory, "check.exe");
    writeFileSync(file, `#include <bblite/runtime.hpp>
#include <bblite/ts_runtime.hpp>
#include <bit>
#include <cassert>
#include <fstream>
namespace bbl {
using JsonObject = ts::JsonValue::Object;
${["const ts::JsonValue& required(", "const ts::JsonValue* optional(", "std::size_t unsigned_value(", "struct AnimatedLightBinding {"].map(signature => cppFunction(loader, signature) + (signature.startsWith("struct") ? ";" : "")).join("\n")}
struct WorldView { std::string type = "VEC4"; int component_type = 5126; std::size_t count = 4; std::array<float, 16> matrix{}; };
void check(const nlohmann::json& input) {
    const auto document = ts::JsonValue::from_native(input.at("plan"));
    const auto& mesh_plan = document.as_object();
    std::map<std::size_t, WorldView> accessors;
    for (const auto& world : input.at("worlds")) {
        auto& matrix = accessors[world.at("accessor").get<std::size_t>()].matrix;
        for (std::size_t i = 0; i < matrix.size(); ++i) matrix[i] = std::bit_cast<float>(world.at("bits")[i].get<std::uint32_t>());
    }
    const auto read_matrix = [](const WorldView& world, std::size_t index) { assert(index == 0); return world.matrix; };
    Engine engine; engine.lights.resize(2); AssetRecord asset;
    std::vector<AnimatedLightBinding> light_node_bindings;
${cppSection(loader, "    std::vector<LightHandle> loaded_lights;", "    const auto animation_runtime =")}
    const auto& expected = input.at("plan");
    assert(engine.lights.size() == expected.at("lights").size() + 2);
    std::size_t binding = 0;
    for (std::size_t i = 0; i < expected.at("lights").size(); ++i) {
        const auto& source = expected.at("lights")[i]; const auto& light = engine.lights[i + 2];
        const auto& world = accessors.at(source.at("world").get<std::size_t>()).matrix;
        const auto bits = [](float value) { return std::bit_cast<std::uint32_t>(value); };
        assert(bits(light.position.x) == bits(world[12]) && bits(light.position.y) == bits(world[13]) && bits(light.position.z) == bits(world[14]));
        assert(bits(light.direction.x) == bits(world[8]) && bits(light.direction.y) == bits(world[9]) && bits(light.direction.z) == bits(world[10]));
        const auto& diffuse = source.at("diffuse"); const auto& specular = source.at("specular");
        assert(light.diffuse_color.r == diffuse[0].get<float>() && light.diffuse_color.g == diffuse[1].get<float>() && light.diffuse_color.b == diffuse[2].get<float>());
        assert(light.specular_color.r == specular[0].get<float>() && light.specular_color.g == specular[1].get<float>() && light.specular_color.b == specular[2].get<float>());
        assert(light.intensity == source.at("intensity").get<float>());
        const double range = source.value("range", static_cast<double>(std::numeric_limits<float>::max()));
        assert(light.range == static_cast<float>(std::min(range, static_cast<double>(std::numeric_limits<float>::max()))));
        const auto kind = source.at("kind").get<std::string>();
        assert(light.kind == (kind == "point" ? LightKind::point : kind == "spot" ? LightKind::spot : LightKind::directional));
        if (source.contains("spot")) {
            const auto& spot = source.at("spot");
            assert(light.angle == spot.at("angle").get<double>());
            assert(bits(light.cos_half_angle) == bits(spot.at("cosine").get<float>()));
            assert(light.exponent == spot.at("exponent").get<float>());
        }
        if (!source.at("node").is_null()) {
            assert(light_node_bindings.at(binding).light.value == i + 2);
            assert(light_node_bindings.at(binding++).node == source.at("node").get<std::size_t>());
        }
    }
    assert(binding == light_node_bindings.size());
    assert(asset.lights.size() == expected.at("sceneLights").size());
    for (std::size_t i = 0; i < asset.lights.size(); ++i) assert(asset.lights[i].value == expected.at("sceneLights")[i].get<std::uint32_t>() + 2);
    assert(punctual_lights.size() == expected.at("lightTargets").size());
    for (std::size_t i = 0; i < punctual_lights.size(); ++i) {
        const auto& target = expected.at("lightTargets")[i];
        assert(punctual_lights[i].value == (target.is_null() ? LightHandle{}.value : target.get<std::uint32_t>() + 2));
    }
}
}
int main() { nlohmann::json cases; std::ifstream("native-cases.json") >> cases; for (const auto& input : cases) bbl::check(input); }
`);
    runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD", "/O2",
        `/Fo:${directory}/`, `/Fe:${executable}`, "/I", "native/include", "/I", resolve(nativeFixtureVcpkgRoot, "include"), file]);
    assert.equal(execFileSync(executable, {cwd: directory, encoding: "utf8"}), "");
});
