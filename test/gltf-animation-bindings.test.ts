import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";
import {BinaryBuilder} from "../src/glb-binary-builder.js";
import {asRecords, type JsonObject} from "../src/gltf-document.js";
import {gltfMeshPlan, packageGltfMeshPlan, packagedGltfMeshPlan} from "../src/gltf-mesh-plan.js";
import {readAnimationBindings} from "../src/gltf-animation-bindings.js";
import {LoweringContext} from "../src/lowering/context.js";
import {GltfLowerer} from "../src/lowering/gltf/loader.js";
import {gltfAnimationBindingsCpp} from "../src/lowering/gltf/animation-bindings.js";
import {gltfAnimationPoseStorageCpp} from "../src/lowering/gltf/animation-pose-storage.js";
import {doctoredContext} from "./doctored-store.js";
import {readPackedGltfAttribute} from "./gltf-mesh-fixture.js";
import {cppFunction, cppRecord, cppSection, nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler} from "./native-fixture.js";

const module = "src/loader-gltf/gltf-animation.ts";

function fixture(firstMorph = false, bothSkinned = false) {
    const binary = new BinaryBuilder(Buffer.alloc(0));
    const accessors: JsonObject[] = [], bufferViews: JsonObject[] = [];
    const append = (data: Float32Array | Uint8Array, type: string, components: number): number => {
        bufferViews.push({buffer: 0, byteOffset: binary.append(data), byteLength: data.byteLength});
        accessors.push({bufferView: bufferViews.length - 1, componentType: data instanceof Float32Array ? 5126 : 5121,
            count: data.length / components, type});
        return accessors.length - 1;
    };
    const position = append(new Float32Array([0,0,0, 1,0,0, 0,1,0]), "VEC3", 3);
    const joints = append(new Uint8Array(12), "VEC4", 4);
    const weights = append(new Float32Array([1,0,0,0, 1,0,0,0, 1,0,0,0]), "VEC4", 4);
    const delta = append(new Float32Array([0,0,1, 0,0,1, 0,0,1]), "VEC3", 3);
    const primitive = (skin: boolean, morph: boolean) => ({attributes: {POSITION: position,
        ...(skin ? {JOINTS_0: joints, WEIGHTS_0: weights} : {})}, ...(morph ? {targets: [{POSITION: delta}]} : {})});
    const document: JsonObject = {asset: {version: "2.0"}, buffers: [{byteLength: binary.byteLength}], accessors, bufferViews,
        meshes: [{primitives: [primitive(true, false)]},
            {primitives: bothSkinned ? [primitive(true, true)] : [primitive(false, firstMorph), primitive(false, true)], weights: [.375]}],
        nodes: [{children: [1, 3], translation: [1.123456789, 2, 3]}, {mesh: 0, skin: 0, translation: [4, 5, 6]}, {},
            {mesh: 1, ...(bothSkinned ? {skin: 0} : {}), translation: [7, 8, 9]}],
        skins: [{joints: [2]}], animations: [{channels: [], samplers: []}], scenes: [{nodes: [0, 2]}]};
    const bytes = binary.build();
    return {document, bin: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)};
}

test("source binding guards and ancestor exclusions follow actual constructed resources", async () => {
    const input = fixture();
    const plan = (await gltfMeshPlan(input.document, input.bin)).animationBindings!;
    assert.deepEqual(plan.nodeMeshes, [{node: 1, meshes: [0]}, {node: 3, meshes: [1, 2]}]);
    assert.deepEqual(plan.skeletons.map(binding => ({meshes: binding.meshes, joints: binding.joints})), [{meshes: [0], joints: [2]}]);
    assert.deepEqual(plan.morphs, [], "a later morphed primitive does not pass the source first-primitive guard");
    assert.deepEqual(plan.excludedNodes, [2, 1, 0]);
    assert.deepEqual(plan.nodeTargets, [0, 1, 2, 3]);
    const altered = (await gltfMeshPlan(input.document, input.bin, doctoredContext(module,
        "gltfMesh.primitives?.[0]?.targets?.length", "gltfMesh.primitives?.[1]?.targets?.length"))).animationBindings!;
    assert.deepEqual(altered.morphs, [{meshes: [2], node: 3, count: 1}]);
    const exclusions = (await gltfMeshPlan(input.document, input.bin, doctoredContext(module,
        "p = findParent(parentMap, p);", "p = -1;"))).animationBindings!;
    assert.deepEqual(exclusions.excludedNodes, [2, 1]);
    const absent = (await gltfMeshPlan({...input.document, animations: []}, input.bin)).animationBindings;
    assert.equal(absent, null, "feature discovery omits target construction for static assets");
});

test("source replay ordinals resolve runtime identities independently of their original glTF nodes", async () => {
    const input = fixture(true, true);
    const original = (await gltfMeshPlan(input.document, input.bin)).animationBindings!;
    const changed = (await gltfMeshPlan(input.document, input.bin, doctoredContext(module,
        "const mesh = meshes[mi];", "const mesh = meshes[meshes.length - 1 - mi];"))).animationBindings!;
    assert.deepEqual(changed.nodeMeshes, original.nodeMeshes);
    assert.deepEqual(original.skeletons.map(binding => binding.meshes), [[0], [1]]);
    assert.deepEqual(changed.skeletons.map(binding => binding.meshes), [[1], [0]]);
    for (const [needle, replacement, error] of [
        ["runtimeSkeleton: skeleton,", "runtimeSkeleton: {...skeleton},", /skeleton identity/],
        ["runtimeMorphTargets: morphTargets,", "runtimeMorphTargets: {...morphTargets},", /morph identity/],
        ["boneMatrices: skeleton.boneMatrices,", "boneMatrices: skeleton.boneMatrices.slice(),", /skeleton identity/],
        ["weights: morphTargets.weights,", "weights: morphTargets.weights.slice(),", /morph identity/],
    ] as const) await assert.rejects(gltfMeshPlan(input.document, input.bin, doctoredContext(module, needle, replacement)), error);
});

test("packaged binding matrices preserve source Float32 products and refuse invalid receipt references", async () => {
    const input = fixture(true, true);
    const bytes = await packageGltfMeshPlan(input.document, input.bin);
    const plan = packagedGltfMeshPlan(input.document).animationBindings!;
    assert.equal(plan.skeletons.length, 2);
    assert.deepEqual(readPackedGltfAttribute(input.document, bytes, plan.skeletons[0]!.inverseBindMatrices),
        [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
    const translated = readPackedGltfAttribute(input.document, bytes, plan.skeletons[0]!.invMeshWorld);
    assert.equal(translated[12], -Math.fround(Math.fround(1.123456789) + 4));
    const changed = fixture(true, true);
    const changedBytes = await packageGltfMeshPlan(changed.document, changed.bin, doctoredContext(module,
        "const invMeshWorld = mat4Invert(meshWorldMatrix) ?? mat4Identity();", "const invMeshWorld = mat4Identity();"));
    const changedPlan = packagedGltfMeshPlan(changed.document).animationBindings!;
    assert.equal(readPackedGltfAttribute(changed.document, changedBytes, changedPlan.skeletons[0]!.invMeshWorld)[12], 0);
    assert.throws(() => readAnimationBindings({...plan, nodeTargets: [99]}, 2, 4, 100), /animation targets/);
    assert.throws(() => readAnimationBindings({...plan, skeletons: [{...plan.skeletons[0], meshes: [99]}]}, 2, 4, 100), /skeleton binding/);
});

test("native binding transport keeps source targets, exclusions and matrix bits", async t => {
    const native = optionalNativeFixtureTools(); if (!native) return t.skip("Native fixture tools unavailable");
    const cases = [];
    for (const context of [new LoweringContext(), doctoredContext(module,
        "const mesh = meshes[mi];", "const mesh = meshes[meshes.length - 1 - mi];"),
        doctoredContext(module, "const skeleton = mesh?.skeleton;", "const skeleton = undefined;")]) {
        const input = fixture(true, true), bytes = await packageGltfMeshPlan(input.document, input.bin, context);
        const meshPlan = packagedGltfMeshPlan(input.document), plan = meshPlan.animationBindings!;
        const accessorBits: Record<number, number[]> = {};
        const palettes = meshPlan.meshes.flatMap(mesh => mesh.skin ? [mesh.skin.matrices] : []);
        for (const index of [...plan.skeletons.flatMap(binding => [binding.inverseBindMatrices, binding.invMeshWorld]), ...palettes]) {
            const floats = Float32Array.from(readPackedGltfAttribute(input.document, bytes, index));
            accessorBits[index] = [...new Uint32Array(floats.buffer)];
        }
        cases.push({plan, accessorBits, meshes: meshPlan.meshes, meshCount: meshPlan.meshes.length, nodeCount: asRecords(input.document.nodes).length});
    }
    const directory = resolve("artifacts/test-gltf-animation-bindings"); mkdirSync(directory, {recursive: true});
    writeFileSync(resolve(directory, "cases.json"), JSON.stringify(cases));
    const loader = new GltfLowerer(new LoweringContext()).lowerLoaderAdapter({pinnedSkeletonPalette: true}).source;
    const file = resolve(directory, "check.cpp"), executable = resolve(directory, "check.exe");
    const consume = cppSection(loader, "        for(std::size_t index=0;index<animation_bindings.skeletons.size();", "        for(const auto& value:required(source_animation.as_object(),\"nodeNames\")");
    writeFileSync(file, `#include <bblite/ts_runtime.hpp>
#include <array>
#include <bit>
#include <cassert>
#include <fstream>
#include <memory>
#include <bblite/js_callback.hpp>
namespace ts = bbl::ts;
namespace js = bbl::js;
using Matrix = std::array<float, 16>;
using JsonObject = ts::JsonValue::Object;
${["const ts::JsonValue& required(", "std::size_t unsigned_value("].map(signature => cppFunction(loader, signature)).join("\n")}
${gltfAnimationBindingsCpp()}
${gltfAnimationPoseStorageCpp().split("template<class ReadFloats,class BindPointer>")[0]}
${cppRecord(loader, "struct AnimatedMeshBinding {")}
void check(const nlohmann::json& input) {
    const auto document = ts::JsonValue::from_native(input.at("plan"));
    auto read_matrices = [&](std::size_t index, std::size_t count) {
        const auto& bits = input.at("accessorBits").at(std::to_string(index));
        assert(bits.size() == count * 16); std::vector<Matrix> matrices(count);
        for (std::size_t i = 0; i < bits.size(); ++i) matrices[i / 16][i % 16] = std::bit_cast<float>(bits[i].get<std::uint32_t>());
        return matrices;
    };
    struct Runtime { std::vector<AnimatedMeshBinding> meshes; GltfAnimationObjectRows<GltfAnimationPoseSkeleton> source_skeletons; GltfAnimationObjectRows<GltfAnimationPoseMorph> source_morphs; };
    auto animation_runtime = std::make_shared<Runtime>();
    const auto mesh_count = input.at("meshCount").get<std::size_t>();
    const auto animation_bindings = read_gltf_animation_bindings(document, mesh_count, input.at("nodeCount").get<std::size_t>(), read_matrices);
    const auto planned = ts::JsonValue::from_native(input.at("meshes"));
    const auto& planned_meshes = planned.as_array();
    const auto read_animation_floats = [&](std::size_t index) {
        GltfAnimationFloats values;
        for (const auto& bits : input.at("accessorBits").at(std::to_string(index)))
            values.push_back(std::bit_cast<float>(bits.get<std::uint32_t>()));
        return values;
    };
    std::vector<std::size_t> animation_mesh_indices;
    for (std::size_t i = 0; i < mesh_count; ++i) {
        animation_mesh_indices.push_back(i);
        AnimatedMeshBinding binding; binding.mesh = static_cast<std::uint32_t>(i); binding.skin = 0;
        if (i == 1) binding.morph_default_weights = {.375f};
        binding.initial_joint_matrices.emplace_back(); animation_runtime->meshes.push_back(binding);
    }
${consume}
    const auto& plan = input.at("plan");
    assert(animation_bindings.excluded_nodes == plan.at("excludedNodes").get<std::vector<std::size_t>>());
    assert(animation_bindings.node_targets == plan.at("nodeTargets").get<std::vector<std::size_t>>());
    for (std::size_t i = 0; i < plan.at("skeletons").size(); ++i) {
        const auto& expected = plan.at("skeletons")[i]; const auto& actual = animation_bindings.skeletons[i];
        const auto& resource = animation_runtime->source_skeletons.at(i);
        assert(resource.meshes == actual.meshes);
        assert(resource.boneCount == actual.joints.size());
        assert(actual.joints == expected.at("joints").get<std::vector<std::size_t>>());
        for (const auto mesh : actual.meshes) {
            assert(animation_runtime->meshes.at(mesh).skeleton_binding == i);
            assert(animation_runtime->meshes.at(mesh).initial_joint_matrices.size() == 1);
        }
        const auto& bits = input.at("accessorBits").at(std::to_string(expected.at("invMeshWorld").get<std::size_t>()));
        for (std::size_t lane = 0; lane < 16; ++lane) assert(std::bit_cast<std::uint32_t>(actual.inv_mesh_world[lane]) == bits[lane]);
        const auto palette = required(required(planned_meshes.at(actual.meshes.front()).as_object(), "skin").as_object(), "matrices").as_number();
        const auto expected_palette = read_animation_floats(static_cast<std::size_t>(palette));
        assert(resource.boneMatrices->size() == expected_palette.size());
        for (std::size_t lane = 0; lane < expected_palette.size(); ++lane)
            assert(std::bit_cast<std::uint32_t>(resource.boneMatrices->at(lane)) == std::bit_cast<std::uint32_t>(expected_palette[lane]));
    }
    assert(animation_runtime->meshes[0].morph_node == std::numeric_limits<std::size_t>::max());
    assert(animation_runtime->meshes[1].morph_node == 3);
    assert(animation_runtime->source_morphs.size() == 1);
    assert(animation_runtime->source_morphs.at(0).weights == GltfAnimationFloats{.375f});
    if (plan.at("skeletons").empty()) for (const auto& mesh : animation_runtime->meshes) {
        assert(mesh.skeleton_binding == std::numeric_limits<std::size_t>::max());
        assert(mesh.initial_joint_matrices.size() == 1);
    }
}
int main() { nlohmann::json cases; std::ifstream("cases.json") >> cases; for (const auto& input : cases) check(input); }
`);
    runNativeFixtureCompiler(native, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD", "/O2",
        `/Fo:${directory}/`, `/Fe:${executable}`, "/I", "native/include", "/I", resolve(nativeFixtureVcpkgRoot, "include"), file]);
    assert.equal(execFileSync(executable, {cwd: directory, encoding: "utf8"}), "");
});
