import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";
import {emitAssetSpecializations} from "../src/asset-specializer.js";
import {BinaryBuilder} from "../src/glb-binary-builder.js";
import type {JsonObject} from "../src/gltf-document.js";
import {packageGltfMeshPlan, packagedGltfMeshPlan} from "../src/gltf-mesh-plan.js";
import {packageGltfTransmissionPlan} from "../src/pinned-material-arms.js";
import {LoweringContext} from "../src/lowering/context.js";
import {GltfLowerer} from "../src/lowering/gltf/loader.js";
import {pinnedMatrixHeader} from "../src/lowering/pinned-matrix.js";
import {pinnedWorldTransformHeader} from "../src/lowering/pinned-world-transform.js";
import {importPinnedModule, pinnedModuleTextUrl} from "../src/pinned-shader-composer.js";
import {transpileForBrowser} from "../src/typescript-transpile.js";
import {doctoredContext} from "./doctored-store.js";
import {writeGlbFixture} from "./glb-fixture.js";
import {readPackedGltfAttribute} from "./gltf-mesh-fixture.js";
import {cppFunction, cppSection, nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler} from "./native-fixture.js";

const animationModule = "src/loader-gltf/gltf-animation.ts";

function fixture(skinned: boolean, morphed: boolean, animated = false, singular = false) {
    const binary = new BinaryBuilder(Buffer.alloc(0));
    const accessors: JsonObject[] = [], bufferViews: JsonObject[] = [];
    const append = (data: Float32Array | Uint8Array, type: string, components: number): number => {
        bufferViews.push({buffer: 0, byteOffset: binary.append(data), byteLength: data.byteLength});
        accessors.push({bufferView: bufferViews.length - 1, componentType: data instanceof Float32Array ? 5126 : 5121,
            count: data.length / components, type});
        return accessors.length - 1;
    };
    const positions = append(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), "VEC3", 3);
    const normals = append(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), "VEC3", 3);
    const joints = append(new Uint8Array([0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0]), "VEC4", 4);
    const weights = append(new Float32Array([.25, .75, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0]), "VEC4", 4);
    const deltas = append(new Float32Array([0, 0, 1, .125, 0, 2, 0, -.25, 3]), "VEC3", 3);
    const ibms = append(new Float32Array([
        1,0,0,0, 0,.5,0,0, 0,0,2,0, -.123456789,3.125,-7.2,1,
        .75,0,0,0, 0,1.5,0,0, 0,0,.25,0, 8.33333,-2.71,4.1234567,1,
    ]), "MAT4", 16);
    const document: JsonObject = {
        asset: {version: "2.0"}, buffers: [{byteLength: binary.byteLength}], accessors, bufferViews,
        meshes: [{primitives: [{attributes: {POSITION: positions, NORMAL: normals,
            ...(skinned ? {JOINTS_0: joints, WEIGHTS_0: weights} : {})}, ...(morphed ? {targets: [{POSITION: deltas}]} : {})}],
            ...(morphed ? {weights: [.375]} : {})}],
        nodes: [{mesh: 0, ...(skinned ? {skin: 0} : {}), translation: [3.23456789, -.1, 8.3333333],
            rotation: [0, .382683432365, 0, .923879532511], scale: singular ? [0, 0, 0] : [2.3, 3.1, .4]},
            {translation: [.123456789, 4.56789, -2.3456], children: [2]}, {translation: [7.3333333, -.2, 6.1234567]}],
        ...(skinned ? {skins: [{joints: [1, 2], inverseBindMatrices: ibms}]} : {}),
        ...(animated ? {animations: [{channels: [], samplers: []}]} : {}), scenes: [{nodes: [0, 1]}],
    };
    const bytes = binary.build();
    return {document, bin: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)};
}

interface SourceSkin {
    jointNodes: number[]; inverseBindMatrices: Float32Array; jointWorldMatrices: Float32Array[]; meshWorldMatrix: Float32Array;
}
async function sourcePalette(context: LoweringContext, document: JsonObject, bin: DataView): Promise<Float32Array> {
    const parser = await importPinnedModule<{
        buildParentMap(json: JsonObject): Map<number, number>;
        computeNodeWorldMatrix(json: JsonObject, index: number, parents: Map<number, number>, worlds: Map<number, Float32Array>): Float32Array;
    }>("loader-gltf/gltf-parser.js");
    const source = await import(pinnedModuleTextUrl("loader-gltf/gltf-animation.js",
        transpileForBrowser(context.sourceFile(animationModule).text, animationModule))) as {
        extractSkin(json: JsonObject, bin: DataView, index: number, world: Float32Array, parents: Map<number, number>, worlds: Map<number, Float32Array>): SourceSkin;
        computeBoneTextureData(skin: SourceSkin): Float32Array;
    };
    const parents = parser.buildParentMap(document), worlds = new Map<number, Float32Array>();
    return source.computeBoneTextureData(source.extractSkin(document, bin, 0,
        parser.computeNodeWorldMatrix(document, 0, parents, worlds), parents, worlds));
}

test("initial palettes come from source construction, independent of clips and including singular mesh worlds", async () => {
    const contexts = [new LoweringContext(), doctoredContext(animationModule,
        "mat4MultiplyInto(data, i * 16, tmp, 0, skin.inverseBindMatrices, i * 16);",
        "mat4MultiplyInto(data, i * 16, skin.inverseBindMatrices, i * 16, tmp, 0);")];
    for (const context of contexts) for (const animated of [false, true]) for (const singular of [false, true]) {
        const {document, bin} = fixture(true, true, animated, singular);
        const expected = await sourcePalette(context, document, bin);
        const bytes = await packageGltfMeshPlan(document, bin, context);
        const mesh = packagedGltfMeshPlan(document).meshes[0]!;
        assert.deepEqual(readPackedGltfAttribute(document, bytes, mesh.skin!.matrices), [...expected]);
        assert.deepEqual(readPackedGltfAttribute(document, bytes, mesh.morph!.weights), [.375]);
    }
    const mismatched = fixture(true, false);
    await assert.rejects(packageGltfMeshPlan(mismatched.document, mismatched.bin, doctoredContext("src/skeleton/create-skeleton.ts",
        "boneMatrices: boneData,", "boneMatrices: boneData.map(value => value + 1),")), /CPU\/GPU initial matrices disagree/);
});

test("static skin and morph assets activate native deformation and world bounds", async () => {
    const directory = resolve("artifacts/test-gltf-initial-deformation-features");
    mkdirSync(resolve(directory, "assets"), {recursive: true});
    for (const skinned of [false, true]) for (const morphed of [false, true]) {
        const {document, bin} = fixture(skinned, morphed);
        const binary = await packageGltfMeshPlan(document, bin);
        await packageGltfTransmissionPlan(document);
        writeGlbFixture(resolve(directory, "assets/asset.glb"), document, binary);
        const features = emitAssetSpecializations(directory,
            [{source: "https://example.invalid/asset.glb", output: "asset.glb", kind: "gltf"}]);
        assert.equal(features.gpuDeformation, skinned || morphed);
        assert.equal(features.animatedWorldBounds, skinned || morphed);
        assert.equal(features.morphStorage, morphed);
    }
});

test("native initial deformation carries source palette products and static morph weights in native coordinates", async t => {
    const native = optionalNativeFixtureTools();
    if (!native) { t.skip("Native fixture compiler unavailable."); return; }
    const context = new LoweringContext();
    const {mat4MultiplyInto} = await importPinnedModule<{
        mat4MultiplyInto(out: Float32Array, offset: number, left: Float32Array, leftOffset: number, right: Float32Array, rightOffset: number): void;
    }>("math/mat4-multiply-into.js");
    const cases: object[] = [];
    for (const [skinned, morphed, animated] of [[true, false, false], [false, true, false], [true, true, false], [true, true, true], [false, false, true]]) {
        const {document, bin} = fixture(skinned!, morphed!, animated!);
        const bytes = await packageGltfMeshPlan(document, bin);
        const mesh = packagedGltfMeshPlan(document).meshes[0]!;
        const sourceWorld = Float32Array.from(readPackedGltfAttribute(document, bytes, mesh.setup.world));
        const world = sourceWorld.map((value, index) => index % 4 === 0 ? -value : value);
        const palette = mesh.skin ? Float32Array.from(readPackedGltfAttribute(document, bytes, mesh.skin.matrices)) : new Float32Array();
        const matrices = [];
        for (let bone = 0; bone < (mesh.skin?.boneCount ?? 1); ++bone) {
            const result = new Float32Array(16);
            if (mesh.skin) mat4MultiplyInto(result, 0, world, 0, palette, bone * 16);
            else result.set(world);
            for (let column = 0; column < 4; ++column) for (let row = 0; row < 4; ++row)
                result[column * 4 + row] = result[column * 4 + row]! * (row === 0 ? -1 : 1) * (column === 0 ? -1 : 1);
            matrices.push([...new Uint32Array(result.buffer)]);
        }
        // JSON numbers erase -0; transport matrix lanes as bits, as the GLB does.
        cases.push({animated, mesh, worldBits: [...new Uint32Array(world.buffer)],
            paletteBits: [...new Uint32Array(palette.buffer)], expected: matrices,
            weights: mesh.morph ? readPackedGltfAttribute(document, bytes, mesh.morph.weights) : []});
    }
    const directory = resolve("artifacts/test-gltf-initial-deformation"); mkdirSync(directory, {recursive: true});
    writeFileSync(resolve(directory, "cases.json"), JSON.stringify(cases));
    writeFileSync(resolve(directory, "pinned_matrix.hpp"), pinnedMatrixHeader(context));
    writeFileSync(resolve(directory, "pinned_world_transform.hpp"), pinnedWorldTransformHeader(context));
    const loader = new GltfLowerer(context).lowerLoaderAdapter({deformPicking: true, pinnedSkeletonPalette: true}).source;
    const file = resolve(directory, "check.cpp"), executable = resolve(directory, "check.exe");
    const initialize = cppSection(loader, "                engine.meshes[mesh_record_index]\n                    .gpu_deformation = true;", "                // mesh.skeleton upstream:");
    writeFileSync(file, `#define BBLITE_GPU_MORPH_STORAGE 1
#include <bblite/runtime.hpp>
#include <bblite/ts_runtime.hpp>
#include "pinned_matrix.hpp"
#include "pinned_world_transform.hpp"
#include <bit>
#include <cassert>
#include <fstream>
namespace bbl {
using Matrix = std::array<float, 16>;
using JsonObject = ts::JsonValue::Object;
${["const ts::JsonValue& required(", "const ts::JsonValue* optional(", "std::size_t unsigned_value(", "Matrix native_matrix(", "void publish_gltf_deformation("].map(signature => cppFunction(loader, signature)).join("\n")}
void check(const nlohmann::json& input) {
    const auto doc = ts::JsonValue::from_native(input.at("mesh")); const auto& planned = doc.as_object();
    const auto* planned_skin = optional(planned, "skin"); const auto* planned_morph = optional(planned, "morph");
    const bool animated = input.at("animated").get<bool>();
    ${loader.match(/const bool deformed_geometry =[^;]+;/)![0]}
    assert(deformed_geometry);
    Matrix mesh_world{}; for (std::size_t i = 0; i < 16; ++i)
        mesh_world[i] = std::bit_cast<float>(input.at("worldBits")[i].get<std::uint32_t>());
    struct Accessor { std::string type = "VEC4"; int component_type = 5126; std::size_t count = 0; std::vector<float> values; };
    std::map<std::size_t, Accessor> accessors;
    if (planned_skin) { auto& view = accessors[unsigned_value(required(planned_skin->as_object(), "matrices"))];
        for (const auto& bits : input.at("paletteBits")) view.values.push_back(std::bit_cast<float>(bits.get<std::uint32_t>()));
        view.count = view.values.size() / 4; }
    const auto read_matrix = [](const Accessor& view, std::size_t bone) { Matrix result{};
        std::copy_n(view.values.begin() + bone * 16, 16, result.begin()); return result; };
    Engine engine; engine.geometries.emplace_back(); engine.meshes.emplace_back();
    engine.meshes[0].geometry = 0; const std::uint32_t mesh_record_index = 0;
    const auto morph_default_weights = input.at("weights").get<std::vector<float>>();
    if (deformed_geometry) {
${initialize}
    }
    const auto& result = engine.meshes[0]; assert(result.gpu_deformation);
    assert(result.bone_matrices.size() == input.at("expected").size());
    for (std::size_t bone = 0; bone < result.bone_matrices.size(); ++bone) for (std::size_t lane = 0; lane < 16; ++lane)
        assert(std::bit_cast<std::uint32_t>(result.bone_matrices[bone][lane]) == input.at("expected")[bone][lane].get<std::uint32_t>());
    assert(result.morph_storage_weights == morph_default_weights);
    for (std::size_t target = 0; target < result.morph_weights.size(); ++target)
        assert(result.morph_weights[target] == (target < morph_default_weights.size() ? morph_default_weights[target] : 0.0f));
    assert(result.bone_matrices_version == 1 && result.transform_version == 1);
    const auto expected_world = native_matrix(mesh_world);
    assert(result.deform_node_world == expected_world);
}
}
int main() { nlohmann::json cases; std::ifstream("cases.json") >> cases; for (const auto& row : cases) bbl::check(row); }
`);
    runNativeFixtureCompiler(native, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD", "/O2",
        `/Fo:${directory}/`, `/Fe:${executable}`, "/I", "native/include", "/I", resolve(nativeFixtureVcpkgRoot, "include"), file]);
    assert.equal(execFileSync(executable, {cwd: directory, encoding: "utf8"}), "");
});
