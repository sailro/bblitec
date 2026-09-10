import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";
import {compileSource} from "../src/compiler.js";
import {asObject, GLTF_MESH_PLAN, type JsonObject} from "../src/gltf-document.js";
import {gltfMeshPlan, packageGltfMeshPlan, packagedGltfMeshPlan} from "../src/gltf-mesh-plan.js";
import {GltfLowerer} from "../src/lowering/gltf/loader.js";
import {CameraLowerer} from "../src/lowering/camera-lowerer.js";
import {LoweringContext} from "../src/lowering/context.js";
import {doctoredContext} from "./doctored-store.js";
import {meshPlanFixture, readPackedGltfAttribute} from "./gltf-mesh-fixture.js";
import {cppFunction, cppSection, nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler} from "./native-fixture.js";

const module = "src/loader-gltf/gltf-feature-camera.ts";
const enabled = {cameras: true};
function fixture(extra: JsonObject = {}) {
    return meshPlanFixture({
        nodes: [{mesh: 0, children: [1]}, {camera: 0, translation: [1, 2, 3], scale: [2, 2, 2]},
            {camera: 1, translation: [4, 5, 6]}, {camera: 99}],
        meshes: [{primitives: [{}]}], scenes: [{nodes: [0]}],
        cameras: [{type: "perspective", perspective: {yfov: .55, znear: .02}},
            {name: "outside", type: "perspective", perspective: {yfov: .8, znear: .1, zfar: 100}}], ...extra,
    });
}

test("source camera construction preserves selected and baked parents and public scalar state", async () => {
    const {document, bin} = fixture();
    const binary = await packageGltfMeshPlan(document, bin, undefined, enabled);
    const plan = packagedGltfMeshPlan(document);
    assert.deepEqual(plan.containerCameras, [0, 1]);
    assert.equal(plan.cameras[0]!.binding!.node, 1);
    assert.equal(plan.cameras[1]!.binding, null);
    assert.deepEqual(plan.cameras.map(camera => [camera.name, camera.fov, camera.nearPlane, camera.farPlane]),
        [["camera0", .55, .02, 1e6], ["outside", .8, .1, 100]]);
    for (const camera of plan.cameras) {
        assert.deepEqual(camera.position, [0, 0, 0]); assert.deepEqual(camera.target, [0, 0, -1]);
        assert.equal(camera.speed, 2); assert.equal(camera.angularSensitivity, 2000);
        assert.equal(camera.inertia, .9); assert.equal(camera.yaw, Math.PI); assert.equal(camera.pitch, 0);
    }
    assert.deepEqual(readPackedGltfAttribute(document, binary, plan.cameras[0]!.parentWorld),
        [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -1, 2, 3, 1]);
    assert.deepEqual(readPackedGltfAttribute(document, binary, plan.cameras[0]!.binding!.local),
        [-.5, -0, -0, 0, 0, .5, 0, 0, 0, 0, .5, 0, 0, 0, 0, 1]);
    assert.deepEqual(readPackedGltfAttribute(document, binary, plan.cameras[1]!.parentWorld).slice(12, 15), [-4, 5, 6]);
});

test("camera API reach and the actual feature predicate remain isolated between source executions", async () => {
    const {document, bin} = fixture();
    assert.deepEqual((await gltfMeshPlan(document, bin)).cameras, []);
    assert.equal((await gltfMeshPlan(document, bin, undefined, enabled)).cameras.length, 2);
    assert.deepEqual((await gltfMeshPlan(document, bin)).cameras, []);
    const disabled = doctoredContext(module, "!!json.cameras?.length", "json.cameras?.length > 2");
    assert.deepEqual((await gltfMeshPlan(document, bin, disabled, enabled)).cameras, []);
    assert.equal((await gltfMeshPlan(document, bin, undefined, enabled)).cameras.length, 2);
    const ignored = doctoredContext("src/loader-gltf/load-gltf.ts", "_appendEnabledGltfFeatures(json, features);", "features.length = 0;");
    assert.deepEqual((await gltfMeshPlan(document, bin, ignored, enabled)).cameras, []);
    const invalid = fixture({cameras: [{type: "unknown"}]});
    assert.deepEqual((await gltfMeshPlan(invalid.document, invalid.bin)).cameras, []);
    await assert.rejects(gltfMeshPlan(invalid.document, invalid.bin, undefined, enabled), /unsupported projection/);
});

test("source camera defaults, constructor changes, ordering and aliasing flow into the plan", async () => {
    const {document, bin} = fixture();
    const changed = async (needle: string, replacement: string) => gltfMeshPlan(document, bin, doctoredContext(module, needle, replacement), enabled);
    assert.equal((await changed("p.zfar ?? 1e6", "p.zfar ?? 2500")).cameras[0]!.farPlane, 2500);
    assert.equal((await changed("def.name ?? `camera${camIdx}`", "def.name ?? `imported${camIdx}`")).cameras[0]!.name, "imported0");
    const repeated = await changed("return cameras.length ? { cameras } : {};", "return cameras.length ? { cameras: [...cameras.reverse(), ...cameras] } : {};");
    assert.deepEqual(repeated.cameras.map(camera => camera.name), ["outside", "camera0"]);
    assert.deepEqual(repeated.containerCameras, [0, 1, 0, 1]);
    const constructor = await gltfMeshPlan(document, bin, doctoredContext("src/camera/free-camera.ts", "speed: 2.0", "speed: 3.5"), enabled);
    assert.equal(constructor.cameras[0]!.speed, 3.5);
    const stopped = await changed("if (!enabled)", "if (enabled)");
    assert.deepEqual(stopped.cameras, []);
});

test("source camera scale checks and changing-scale skip run before native packaging", async () => {
    for (const scale of [[0, 0, 0], [1, 2, 1]]) {
        const {document, bin} = fixture({nodes: [{camera: 0, scale}]});
        await assert.rejects(gltfMeshPlan(document, bin, undefined, enabled), /non-zero uniform scale/);
    }
    const {document, bin} = fixture({animations: [{channels: [{sampler: 0, target: {node: 1, path: "scale"}}], samplers: [{}]}]});
    const plan = await gltfMeshPlan(document, bin, undefined, enabled);
    assert.deepEqual(plan.cameras.map(camera => camera.name), ["outside"]);
    const ortho = fixture({cameras: [{type: "orthographic", orthographic: {xmag: 2, ymag: 1, znear: .1, zfar: 10}}]});
    await assert.rejects(gltfMeshPlan(ortho.document, ortho.bin, undefined, enabled), /explicit clip-plane storage/);
});

test("malformed packaged camera bindings and storage refuse", async () => {
    const {document, bin} = fixture();
    await packageGltfMeshPlan(document, bin, undefined, enabled);
    const plan = asObject(document[GLTF_MESH_PLAN])!;
    const cameras = packagedGltfMeshPlan(document).cameras;
    for (const change of [{cameras: undefined}, {containerCameras: [99]},
        ...[{parentWorld: 999}, {binding: {node: 99, local: 0}}, {binding: {}}, {position: [0]}, {fov: NaN}]
            .map(change => ({cameras: [{...cameras[0], ...change}]}))]) {
        assert.throws(() => packagedGltfMeshPlan({...document, [GLTF_MESH_PLAN]: {...plan, ...change}}), /Invalid|missing/);
    }
});

test("camera enabling affects only subsequent loads, including repeated shared calls", () => {
    for (const wrapper of [false, true]) {
        const result = compileSource(`import {createEngine, loadGltf, enableGltfCameras} from "@babylonjs/lite";
            async function main() { const engine = await createEngine({});
                ${wrapper ? 'async function load(url: string) { return await loadGltf(engine, url); }' : ''}
                ${wrapper ? 'await load("before.glb"); await load("mixed.glb");' : 'await loadGltf(engine, "before.glb"); await loadGltf(engine, "mixed.glb");'}
                enableGltfCameras(); enableGltfCameras();
                ${wrapper ? 'await load("mixed.glb"); await load("after.glb");' : 'await loadGltf(engine, "mixed.glb"); await loadGltf(engine, "after.glb");'}
            }`);
        assert.deepEqual(result.manifest.assets.map(asset => [asset.source, asset.containerCount, asset.gltfCameras === true]),
            [["before.glb", 1, false], ["mixed.glb", 2, true], ["after.glb", 1, true]]);
        assert.equal(result.cpp.match(/bbl::load_gltf\([^\n]+, true\)/g)?.length, 2);
        assert.equal(result.cpp.match(/bbl::load_gltf\(/g)?.length, 4);
    }
    assert.throws(() => compileSource(`import {createEngine, enableGltfCameras} from "@babylonjs/lite";
        async function main() { const engine = await createEngine({}); if (Math.random() > .5) enableGltfCameras(); }`), /definite setup call/);
});

test("native shared loader calls execute the camera mode at each source invocation", t => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) { t.skip("Native fixture compiler unavailable."); return; }
    const result = compileSource(`import {createEngine, loadGltf, enableGltfCameras} from "@babylonjs/lite";
        async function main() { const engine = await createEngine({});
            async function load() { return await loadGltf(engine, "same.glb"); }
            function enable() { enableGltfCameras(); }
            if (false) enable();
            await load(); await load(); enable(); await load();
            for (let i = 0; i < 3; ++i) { enable(); await load(); }
        }`);
    assert.equal(result.manifest.assets[0]!.containerCount, 6);
    const directory = resolve("artifacts/test-gltf-camera-order"); mkdirSync(directory, {recursive: true});
    const headers = resolve(directory, "bblite/upstream"); mkdirSync(headers, {recursive: true});
    writeFileSync(resolve(headers, "camera_math.hpp"), new CameraLowerer(new LoweringContext()).lowerArcRotateFactory().header);
    writeFileSync(resolve(directory, "program.hpp"), result.cpp);
    const file = resolve(directory, "check.cpp"), executable = resolve(directory, "check.exe");
    writeFileSync(file, `#define main generated_main
#include "program.hpp"
#undef main
#include <cassert>
unsigned loads = 0;
namespace bbl {
Engine create_engine(EngineOptions) { return {}; }
std::string asset_path(const std::string& path) { return path; }
AssetHandle load_gltf(Engine&, const std::string&, bool cameras) { assert(cameras == (loads >= 2)); return {loads++}; }
AssetHandle load_gltf(Engine& engine, const std::string& path) { return load_gltf(engine, path, false); }
}
int main() { assert(generated_main() == 0); assert(loads == 6); }
`);
    runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD", "/O2",
        `/Fo:${directory}/`, `/Fe:${executable}`, "/I", "native/include", "/I", directory, file]);
    assert.equal(execFileSync(executable, {cwd: directory, encoding: "utf8"}), "");
});

test("native camera transport preserves source matrices, scalars, aliases and per-load activation", async t => {
    const tools = optionalNativeFixtureTools();
    if (!tools) { t.skip("Native fixture compiler unavailable."); return; }
    const cases = [];
    for (const context of [new LoweringContext(),
        doctoredContext(module, "return cameras.length ? { cameras } : {};", "return cameras.length ? { cameras: [...cameras.reverse(), ...cameras] } : {};"),
        doctoredContext(module, "-inverseScale, inverseScale, inverseScale", "-inverseScale, inverseScale * 2, inverseScale"),
        doctoredContext("src/camera/free-camera.ts", "speed: 2.0", "speed: 3.5"),
    ]) {
        const {document, bin} = fixture();
        const binary = await packageGltfMeshPlan(document, bin, context, enabled);
        const plan = packagedGltfMeshPlan(document);
        const matrices = plan.cameras.flatMap(camera => [camera.parentWorld, ...(camera.binding ? [camera.binding.local] : [])])
            .map(accessor => ({accessor, bits: [...new Uint32Array(Float32Array.from(readPackedGltfAttribute(document, binary, accessor)).buffer)]}));
        cases.push({plan, matrices});
    }
    const directory = resolve("artifacts/test-gltf-camera-plan"); mkdirSync(directory, {recursive: true});
    writeFileSync(resolve(directory, "native-cases.json"), JSON.stringify(cases));
    const context = new LoweringContext();
    const loader = new GltfLowerer(context).lowerLoaderAdapter({gltfCameras: true}).source;
    const file = resolve(directory, "check.cpp"), executable = resolve(directory, "check.exe");
    writeFileSync(file, `#include <bblite/runtime.hpp>
#include <bblite/ts_runtime.hpp>
#include <bit>
#include <cassert>
#include <fstream>
namespace bbl {
using JsonObject = ts::JsonValue::Object;
using Matrix = std::array<float, 16>;
${["const ts::JsonValue& required(", "std::size_t unsigned_value(", "struct AnimatedCameraBinding {"].map(signature => cppFunction(loader, signature) + (signature.startsWith("struct") ? ";" : "")).join("\n")}
${cppFunction(new CameraLowerer(context).lowerFreeFactory().source, "CameraHandle create_free_camera(")}
struct WorldView { std::string type = "VEC4"; int component_type = 5126; std::size_t count = 4; Matrix matrix{}; };
void check(const nlohmann::json& input, bool load_cameras) {
    const auto document = ts::JsonValue::from_native(load_cameras ? input.at("plan") : nlohmann::json::object());
    const auto& mesh_plan = document.as_object();
    const std::array<int,4> node_json{};
    std::map<std::size_t, WorldView> accessors;
    for (const auto& stored : input.at("matrices")) {
        auto& matrix = accessors[stored.at("accessor").get<std::size_t>()].matrix;
        for (std::size_t i = 0; i < matrix.size(); ++i) matrix[i] = std::bit_cast<float>(stored.at("bits")[i].get<std::uint32_t>());
    }
    const auto read_matrix = [](const WorldView& world, std::size_t index) { assert(index == 0); return world.matrix; };
    Engine engine; engine.cameras.resize(2); AssetRecord asset;
    std::vector<AnimatedCameraBinding> camera_node_bindings;
${cppSection(loader, "    if (load_cameras) {", "    const auto animation_runtime =")}
    if (!load_cameras) { assert(engine.cameras.size() == 2 && asset.cameras.empty() && camera_node_bindings.empty()); return; }
    const auto& expected = input.at("plan");
    assert(engine.cameras.size() == expected.at("cameras").size() + 2);
    const auto same_matrix = [](const Matrix& first, const Matrix& second) {
        for (std::size_t i = 0; i < 16; ++i) assert(std::bit_cast<std::uint32_t>(first[i]) == std::bit_cast<std::uint32_t>(second[i]));
    };
    std::size_t binding_index = 0;
    for (std::size_t i = 0; i < expected.at("cameras").size(); ++i) {
        const auto& source = expected.at("cameras")[i]; const auto& camera = engine.cameras[i + 2];
        assert(camera.name == source.at("name").get<std::string>() && camera.kind == CameraKind::free);
        assert(camera.fov == source.at("fov").get<double>());
        assert(camera.near_plane == source.at("nearPlane").get<double>() && camera.far_plane == source.at("farPlane").get<double>());
        assert(camera.speed == source.at("speed").get<double>() && camera.angular_sensibility == source.at("angularSensitivity").get<double>());
        assert(camera.inertia == source.at("inertia").get<double>() && camera.free_yaw == source.at("yaw").get<double>() && camera.free_pitch == source.at("pitch").get<double>());
        const auto& position = source.at("position"); const auto& target = source.at("target");
        assert(camera.position.x == position[0].get<double>() && camera.position.y == position[1].get<double>() && camera.position.z == position[2].get<double>());
        assert(camera.target.x == target[0].get<double>() && camera.target.y == target[1].get<double>() && camera.target.z == target[2].get<double>());
        assert(camera.has_parent_world);
        same_matrix(camera.parent_world, accessors.at(source.at("parentWorld").get<std::size_t>()).matrix);
        if (!source.at("binding").is_null()) {
            const auto& binding = camera_node_bindings.at(binding_index++);
            assert(binding.camera.value == i + 2 && binding.node == source.at("binding").at("node").get<std::size_t>());
            same_matrix(binding.local, accessors.at(source.at("binding").at("local").get<std::size_t>()).matrix);
        }
    }
    assert(binding_index == camera_node_bindings.size());
    assert(asset.cameras.size() == expected.at("containerCameras").size());
    for (std::size_t i = 0; i < asset.cameras.size(); ++i) assert(asset.cameras[i].value == expected.at("containerCameras")[i].get<std::uint32_t>() + 2);
}
}
int main() { nlohmann::json cases; std::ifstream("native-cases.json") >> cases; for (const auto& input : cases) { bbl::check(input, false); bbl::check(input, true); } }
`);
    runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD", "/O2",
        `/Fo:${directory}/`, `/Fe:${executable}`, "/I", "native/include", "/I", resolve(nativeFixtureVcpkgRoot, "include"), file]);
    assert.equal(execFileSync(executable, {cwd: directory, encoding: "utf8"}), "");
});
