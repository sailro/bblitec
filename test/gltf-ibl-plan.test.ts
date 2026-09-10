import assert from "node:assert/strict";
import test from "node:test";
import {PNG} from "pngjs";
import {execFileSync} from "node:child_process";
import {mkdirSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";
import {asObject, asRecords, GLTF_MESH_PLAN, type JsonObject} from "../src/gltf-document.js";
import {gltfMeshPlan, packageGltfMeshPlan, packagedGltfMeshPlan} from "../src/gltf-mesh-plan.js";
import {doctoredContext} from "./doctored-store.js";
import {meshPlanFixture, readPackedGltfAttribute} from "./gltf-mesh-fixture.js";
import {LoweringContext} from "../src/lowering/context.js";
import {GltfLowerer} from "../src/lowering/gltf/loader.js";
import {gltfIblLoadingCpp} from "../src/lowering/gltf/ibl.js";
import {lowerGltfAssetSceneSetup} from "../src/lowering/gltf/asset-scene-setup.js";
import {cppFunction, nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler} from "./native-fixture.js";

const featureModule = "src/loader-gltf/gltf-ext-lights-image-based.ts";
const assemblyModule = "src/loader-gltf/ibl-env-assembly.ts";
const uploadModule = "src/loader-gltf/ibl-cubemap-upload.ts";

function fixture() {
    const source = meshPlanFixture({
        asset: {version: "2.0"}, extensionsUsed: ["EXT_lights_image_based"],
        meshes: [{primitives: [{}]}], nodes: [{mesh: 0}],
        scenes: [{nodes: [0], extensions: {EXT_lights_image_based: {light: 0}}}],
        extensions: {EXT_lights_image_based: {lights: [{
            specularImageSize: 4, specularImages: [[0, 1, 2, 3, 4, 5], [6, 7, 8, 9, 10, 11]],
            irradianceCoefficients: Array.from({length: 9}, (_, index) => [index + 0.25, index + 0.5, index + 0.75]),
        }]}},
    });
    const parts = [Buffer.from(source.bin.buffer)];
    const faceBytes: Buffer[] = [];
    let offset = parts[0]!.length;
    const views = asRecords(source.document.bufferViews);
    const images: JsonObject[] = [];
    for (let index = 0; index < 12; index++) {
        const width = index < 6 ? 4 : 2;
        const png = new PNG({width, height: width});
        for (let pixel = 0; pixel < width * width; pixel++) png.data.set([index + 20, index + 40, index + 60, 255], pixel * 4);
        const bytes = PNG.sync.write(png);
        images.push({bufferView: views.length, mimeType: "image/png"});
        views.push({buffer: 0, byteOffset: offset, byteLength: bytes.length});
        parts.push(bytes); faceBytes.push(bytes); offset += bytes.length;
    }
    const prefix = Buffer.alloc(12, 123), bin = Buffer.concat([prefix, ...parts]);
    source.document.bufferViews = views;
    source.document.buffers = [{byteLength: offset}];
    source.document.images = images;
    return {document: source.document, bin: new DataView(bin.buffer, bin.byteOffset + prefix.length, offset), faceBytes};
}

function faceData(document: JsonObject, binary: Buffer, view: number): Buffer {
    const record = asRecords(document.bufferViews)[view]!;
    assert.equal(typeof record.byteOffset, "number");
    assert.equal(typeof record.byteLength, "number");
    return binary.subarray(Number(record.byteOffset), Number(record.byteOffset) + Number(record.byteLength));
}

test("source IBL selection, image slices, compute copies, uniforms and deferred writes are packaged", async () => {
    const {document, bin, faceBytes} = fixture();
    const binary = await packageGltfMeshPlan(document, bin);
    const {ibl} = packagedGltfMeshPlan(document);
    assert.equal(ibl.textures.length, 1);
    const textures = ibl.textures[0]!;
    assert.deepEqual([textures.width, textures.mipCount, textures.lodScale, textures.brdfWidth], [4, 2, 0.5, 256]);
    assert.deepEqual(textures.faces.map(face => faceData(document, binary, face.bufferView)), faceBytes);
    const harmonics = readPackedGltfAttribute(document, binary, textures.harmonics);
    assert.equal(harmonics.length, 36);
    assert.ok(harmonics.every(Number.isFinite));
    assert.deepEqual(harmonics.filter((_, index) => index % 4 === 3), Array(9).fill(0));
    assert.deepEqual(ibl.setup, [{kind: "textures", index: 0}, {kind: "toneMappingEnabled", value: true},
        {kind: "exposure", value: 0.8}, {kind: "contrast", value: 1.2}]);
});

test("source IBL activation and selected-scene guards decide whether resources exist", async () => {
    const {document, bin} = fixture();
    assert.deepEqual((await gltfMeshPlan({...document, extensionsUsed: []}, bin)).ibl, {textures: [], setup: []});
    assert.deepEqual((await gltfMeshPlan({...document, scene: 1}, bin)).ibl, {textures: [], setup: []});
    const disabled = await gltfMeshPlan(document, bin, doctoredContext("src/loader-gltf/load-gltf.ts",
        "_appendEnabledGltfFeatures(json, features);", "features.length = 0;"));
    assert.deepEqual(disabled.ibl, {textures: [], setup: []});
    const without = structuredClone(document);
    const light = asRecords(asObject(asObject(without.extensions)?.EXT_lights_image_based)?.lights)[0]!;
    delete light.irradianceCoefficients;
    assert.deepEqual((await gltfMeshPlan(without, bin)).ibl, {textures: [], setup: []});
});

test("source image order and cube destination layers drive native face order", async () => {
    const first = fixture();
    const reversed = await packageGltfMeshPlan(first.document, first.bin, doctoredContext(featureModule,
        "light.specularImages.flat()", "light.specularImages.map(mip => [...mip].reverse()).flat()"));
    const plan = packagedGltfMeshPlan(first.document).ibl;
    assert.deepEqual(plan.textures[0]!.faces.map(face => faceData(first.document, reversed, face.bufferView)),
        [...first.faceBytes.slice(0, 6).reverse(), ...first.faceBytes.slice(6).reverse()]);
    const second = fixture();
    const reordered = await packageGltfMeshPlan(second.document, second.bin, doctoredContext(uploadModule,
        "z: face", "z: 5 - face"));
    assert.deepEqual(packagedGltfMeshPlan(second.document).ibl.textures[0]!.faces.map(face => faceData(second.document, reordered, face.bufferView)),
        [...second.faceBytes.slice(0, 6).reverse(), ...second.faceBytes.slice(6).reverse()]);
});

test("source numeric stores and ordered scene assignments replace old lighting defaults", async () => {
    const {document, bin} = fixture();
    const changed = await gltfMeshPlan(document, bin, doctoredContext(featureModule,
        "scene.imageProcessing.toneMappingEnabled = true;", "scene.imageProcessing.toneMappingEnabled = false;"));
    assert.deepEqual(changed.ibl.setup[1], {kind: "toneMappingEnabled", value: false});
    const rotated = await gltfMeshPlan(document, bin, doctoredContext(featureModule,
        "const envRotationY = light.rotation ? envYawFromQuaternion(light.rotation) : 0;", "const envRotationY = 0.75;"));
    assert.deepEqual(rotated.ibl.setup[1], {kind: "rotation", value: 0.75});
    const reordered = await gltfMeshPlan(document, bin, doctoredContext(featureModule,
        "scene.imageProcessing.exposure = 0.8;", "scene.imageProcessing.contrast = 2; scene.imageProcessing.exposure = 0.7;"));
    assert.deepEqual(reordered.ibl.setup.slice(2), [{kind: "contrast", value: 2}, {kind: "exposure", value: 0.7}, {kind: "contrast", value: 1.2}]);
    const baseline = fixture(), scaled = fixture();
    const before = await packageGltfMeshPlan(baseline.document, baseline.bin);
    const after = await packageGltfMeshPlan(scaled.document, scaled.bin, doctoredContext(featureModule, "light.intensity ?? 1", "light.intensity ?? 2"));
    const lanes = (doc: JsonObject, bytes: Buffer) => readPackedGltfAttribute(doc, bytes, packagedGltfMeshPlan(doc).ibl.textures[0]!.harmonics);
    assert.deepEqual(lanes(scaled.document, after), lanes(baseline.document, before).map(value => value * 2));
    const altered = fixture();
    const alteredBytes = await packageGltfMeshPlan(altered.document, altered.bin, doctoredContext(assemblyModule,
        "data.set(sh, 40);", "data.set(sh.map(value => value * 2), 40);"));
    assert.deepEqual(lanes(altered.document, alteredBytes), lanes(baseline.document, before).map(value => value * 2));
});

test("unrepresented IBL GPU and runtime-state dependencies refuse", async () => {
    const {document, bin} = fixture();
    for (const [module, needle, replacement, error] of [
        [uploadModule, "flipY: false", "flipY: true", /image upload/],
        [uploadModule, "[FLIP_Y_CONSTANT_ID]: 1", "[FLIP_Y_CONSTANT_ID]: 0", /RGBD decode contract/],
        [uploadModule, "vec3f(2.2)", "vec3f(2.4)", /compute pipeline/],
        [uploadModule, "device.queue.submit([encoder.finish()]);", "if (face === 5) device.queue.submit([encoder.finish()]);", /Incomplete glTF IBL cube faces/],
        [assemblyModule, "const size = 256;", "const size = 128;", /BRDF bake contract/],
        [assemblyModule, "scene._environmentRotation ?? 0", "(scene._environmentRotation ?? 0) * 2", /arithmetic on the runtime/],
        [featureModule, "scene.imageProcessing.exposure = 0.8;", "scene.imageProcessing.exposure *= 0.8;", /reads existing image processing/],
        [featureModule, "scene._envTextures = textures;", "scene._envTextures = scene._envTextures || textures;", /reads prior environment state/],
    ] as const) await assert.rejects(gltfMeshPlan(document, bin, doctoredContext(module, needle, replacement)), error);
});

test("native IBL attachment preserves unwritten scene state, source uniform bits and resource identity", async t => {
    const tools = optionalNativeFixtureTools();
    if (!tools) { t.skip("Native fixture compiler unavailable."); return; }
    const contexts = [new LoweringContext(),
        doctoredContext(featureModule, "const envRotationY = light.rotation ? envYawFromQuaternion(light.rotation) : 0;", "const envRotationY = 0.75;"),
        doctoredContext(featureModule, "scene.imageProcessing.toneMappingEnabled = true;", "scene.imageProcessing.toneMappingEnabled = false;"),
        doctoredContext(featureModule, "scene.imageProcessing.exposure = 0.8;", "scene.imageProcessing.exposure = 0.7;"),
    ];
    const cases = [];
    for (const context of contexts) {
        const {document, bin} = fixture();
        const binary = await packageGltfMeshPlan(document, bin, context);
        const plan = packagedGltfMeshPlan(document);
        cases.push({ibl: plan.ibl, harmonics: plan.ibl.textures.map(texture => ({index: texture.harmonics,
            bits: [...new Uint32Array(Float32Array.from(readPackedGltfAttribute(document, binary, texture.harmonics)).buffer)]}))});
    }
    const directory = resolve("artifacts/test-gltf-ibl-plan"); mkdirSync(directory, {recursive: true});
    writeFileSync(resolve(directory, "cases.json"), JSON.stringify(cases));
    const loader = new GltfLowerer(new LoweringContext()).lowerLoaderAdapter().source;
    const file = resolve(directory, "check.cpp"), executable = resolve(directory, "check.exe");
    writeFileSync(file, `#include <bblite/runtime.hpp>
#include <bblite/ts_runtime.hpp>
#include <bit>
#include <cassert>
#include <fstream>
namespace bbl {
using JsonObject = ts::JsonValue::Object;
${["const ts::JsonValue& required(", "std::size_t unsigned_value("].map(signature => cppFunction(loader, signature)).join("\n")}
namespace pal { std::vector<std::uint8_t> read_binary_file(const std::string& path) {
    assert(path == "gltf-ibl-brdf-lut.rgba16f"); return {17, 18};
} }
std::string asset_path(const std::string& path) { return path; }
struct Harmonics { std::string type = "VEC4"; std::size_t component_type = 5126, count = 9; std::array<float, 36> values{}; };
float read_component(int, int, int, const Harmonics& data, std::size_t element, std::size_t component) { return data.values.at(element * 4 + component); }
TextureData image_data(int, int, int, const ts::JsonValue::Array& faces, std::size_t index) {
    TextureData data; data.bytes = {static_cast<std::uint8_t>(unsigned_value(required(faces.at(index).as_object(), "bufferView")))}; return data;
}
${lowerGltfAssetSceneSetup(new LoweringContext())}
void check(const nlohmann::json& input, std::size_t variant) {
    const auto document = ts::JsonValue::from_native(input);
    const auto& mesh_plan = document.as_object();
    std::map<std::size_t, Harmonics> accessors;
    for (const auto& entry : input.at("harmonics")) {
        auto& target = accessors[entry.at("index").get<std::size_t>()].values;
        for (std::size_t i = 0; i < target.size(); ++i) target[i] = std::bit_cast<float>(entry.at("bits")[i].get<std::uint32_t>());
    }
    const int buffer = 0, container = 0, views = 0;
    AssetRecord asset;
    js::Callback<void(Scene&)> ibl_scene_setup;
${gltfIblLoadingCpp()}
    compose_gltf_scene_setup(asset, {ibl_scene_setup});
    assert(asset.scene_setup);
    Scene first; first.environment.rotation_y = 1.25f; first.environment.exposure = 4.0f;
    first.environment.has_ground = true; first.environment.has_skybox = true;
    first.environment.has_image_skybox = true; first.environment.image_skybox_size = 77.0f;
    first.environment.ground_texture.bytes = {1, 2, 3}; first.environment.skybox_texture.bytes = {4, 5};
    assert(first.environment.specular_faces.empty());
    asset.scene_setup(first);
    const auto identity = first.state->environment_identity;
    static std::uint64_t previous_identity = 0;
    assert(identity != 0 && identity != previous_identity);
    previous_identity = identity;
    Scene alias = first;
    asset.scene_setup(alias);
    assert(first.state->environment_identity == identity);
    const auto& environment = first.environment;
    assert(environment.rotation_y == (variant == 1 ? 0.75f : 1.25f));
    assert(environment.exposure == (variant == 3 ? 0.7f : 0.8f));
    assert(environment.contrast == 1.2f && environment.tone_mapping_enabled == (variant != 2));
    assert(environment.has_ground && environment.has_skybox && environment.has_image_skybox && environment.image_skybox_size == 77.0f);
    const auto bytes = [](const SharedTextureBytes& value) { return std::vector<std::uint8_t>(value.begin(), value.end()); };
    assert((bytes(environment.ground_texture.bytes) == std::vector<std::uint8_t>{1, 2, 3}));
    assert((bytes(environment.skybox_texture.bytes) == std::vector<std::uint8_t>{4, 5}));
    assert(environment.has_irradiance && environment.specular_width == 4 && environment.specular_mip_count == 2);
    assert(environment.lod_generation_scale == 0.5f && environment.brdf_lut_width == 256 && environment.brdf_lut_rgba16f);
    assert((bytes(environment.brdf_lut.bytes) == std::vector<std::uint8_t>{17, 18}));
    const auto& expected = input.at("ibl").at("textures")[0];
    assert(environment.specular_faces.size() == expected.at("faces").size());
    for (std::size_t i = 0; i < environment.specular_faces.size(); ++i)
        assert(environment.specular_faces[i].bytes[0] == expected.at("faces")[i].at("bufferView").get<std::uint8_t>());
    const auto& bits = input.at("harmonics")[0].at("bits");
    for (std::size_t i = 0; i < 9; ++i) {
        assert(std::bit_cast<std::uint32_t>(environment.spherical_harmonics[i].r) == bits[i * 4].get<std::uint32_t>());
        assert(std::bit_cast<std::uint32_t>(environment.spherical_harmonics[i].g) == bits[i * 4 + 1].get<std::uint32_t>());
        assert(std::bit_cast<std::uint32_t>(environment.spherical_harmonics[i].b) == bits[i * 4 + 2].get<std::uint32_t>());
    }
    Scene second; second.environment.rotation_y = -0.5f;
    asset.scene_setup(second);
    assert(second.environment.rotation_y == (variant == 1 ? 0.75f : -0.5f));
    assert(first.state->environment_identity != 0 && first.state->environment_identity == second.state->environment_identity);
    first.environment.exposure = 2; first.environment.contrast = 3; first.environment.rotation_y = 1;
    assert(first.state->environment_identity == identity && second.state->environment_identity == identity);
}
}
int main() { nlohmann::json cases; std::ifstream("cases.json") >> cases; for (std::size_t i = 0; i < cases.size(); ++i) bbl::check(cases[i], i); }
`);
    runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD", "/O2",
        `/Fo:${directory}/`, `/Fe:${executable}`, "/I", "native/include", "/I", resolve(nativeFixtureVcpkgRoot, "include"), file]);
    assert.equal(execFileSync(executable, {cwd: directory, encoding: "utf8"}), "");
});

test("packaged IBL storage refuses invalid indices, missing fields and unknown scene writes", async () => {
    const {document, bin} = fixture();
    await packageGltfMeshPlan(document, bin);
    const meshPlan = asObject(document[GLTF_MESH_PLAN])!;
    const ibl = packagedGltfMeshPlan(document).ibl;
    for (const value of [undefined, {...ibl, setup: [{kind: "unknown"}]}, {...ibl, setup: [{kind: "textures", index: 7}]},
        {...ibl, textures: [{...ibl.textures[0], harmonics: 9999}]}, {...ibl, textures: [{...ibl.textures[0], faces: []}]}])
        assert.throws(() => packagedGltfMeshPlan({...document, [GLTF_MESH_PLAN]: {...meshPlan, ibl: value}}), /Invalid|missing/);
});
