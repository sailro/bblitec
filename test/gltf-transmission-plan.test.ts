import assert from "node:assert/strict";
import {mkdirSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";
import {emitAssetSpecializations, specializeGltf} from "../src/asset-specializer.js";
import {GLTF_TRANSMISSION_PLAN, type JsonObject} from "../src/gltf-document.js";
import {packageGltfMeshPlan} from "../src/gltf-mesh-plan.js";
import {packagedGltfTransmissionPlan} from "../src/gltf-transmission-plan.js";
import {gltfLinearImageProcessing, gltfTransmissionPlan, materialSubjects, packageGltfTransmissionPlan} from "../src/pinned-material-arms.js";
import {recordingTransmissionSetter, transmissionRegistrationMarker} from "../src/pinned-pbr-transmission.js";
import {doctoredContext} from "./doctored-store.js";
import {writeGlbFixture} from "./glb-fixture.js";
import {meshPlanFixture} from "./gltf-mesh-fixture.js";

const transmission = (factor: number): JsonObject => ({extensions: {KHR_materials_transmission: {transmissionFactor: factor}}});

async function prepare(materials: JsonObject[], primitive: JsonObject = {material: 0}, extra: JsonObject = {}) {
    const {document, bin} = meshPlanFixture({asset: {version: "2.0"},
        extensionsUsed: ["KHR_materials_transmission", "KHR_materials_volume", "KHR_materials_ior", "KHR_materials_dispersion"],
        materials, nodes: [{mesh: 0}], meshes: [{primitives: [primitive]}], scenes: [{nodes: [0]}], ...extra});
    const binary = await packageGltfMeshPlan(document, bin);
    return {document, binary};
}

test("source construction and hook predicate select used materials, including empty and dispersion-only setters", async () => {
    const cases: Array<{materials: JsonObject[]; registered: boolean; initial: boolean}> = [
        {materials: [{}, transmission(1)], registered: false, initial: false},
        {materials: [transmission(1)], registered: true, initial: true},
        {materials: [transmission(1e-100)], registered: true, initial: true},
        {materials: [transmission(0)], registered: false, initial: false},
        {materials: [{extensions: {KHR_materials_ior: {ior: 1.4}, KHR_materials_volume: {thicknessFactor: 1},
            KHR_materials_dispersion: {dispersion: .5}}}], registered: true, initial: false},
    ];
    for (const row of cases) {
        const {document} = await prepare(row.materials);
        assert.deepEqual(await gltfTransmissionPlan(document), {registered: row.registered, initial: row.initial, variants: {}});
        assert.equal(await gltfLinearImageProcessing(document), row.initial);
    }
    const {document} = await prepare([{extensions: {KHR_materials_transmission: {transmissionFactor: 0, transmissionTexture: {index: 0}}}}],
        {material: 0}, {textures: [{source: 0}], images: [{}]});
    assert.equal((await materialSubjects(document))[0]!.transmissionRegistered, true);
    assert.equal(await gltfLinearImageProcessing(document), false);
    const changed = doctoredContext("src/material/pbr/pbr-transmission-ext.ts", "?? 0) > 0", "?? 0) >= 0");
    assert.equal((await gltfTransmissionPlan(document, changed)).initial, true);
});

test("variant transmission receipts follow source-selected scene mesh slots", async () => {
    const {document} = await prepare([{}, transmission(.8)], {material: 0, extensions: {KHR_materials_variants: {
        mappings: [{material: 1, variants: [0]}, {material: 0, variants: [1]}]}}},
    {extensions: {KHR_materials_variants: {variants: [{name: "Glass"}, {name: "Opaque"}]}}});
    await packageGltfTransmissionPlan(document);
    assert.deepEqual(packagedGltfTransmissionPlan(document), {registered: true, initial: false, variants: {Glass: true, Opaque: false}});
    assert.equal(await gltfLinearImageProcessing(document), false);
    assert.equal(await gltfLinearImageProcessing(document, "Glass"), true);
    assert.equal(await gltfLinearImageProcessing(document, "Opaque"), false);
    await assert.rejects(gltfLinearImageProcessing(document, "missing"), /Missing glTF transmission selection/);
    await assert.rejects(packageGltfTransmissionPlan(document), /already carries/);
    assert.throws(() => packagedGltfTransmissionPlan({...document, [GLTF_TRANSMISSION_PLAN]: {registered: true, initial: false, variants: {Glass: true}}}), /Invalid packaged/);
});

test("specialization reports unknown before source construction and requires its receipt for emission", async () => {
    const directory = resolve("artifacts/test-gltf-transmission-specialization");
    mkdirSync(resolve(directory, "assets"), {recursive: true});
    const {document, binary} = await prepare([transmission(.5)]);
    const path = resolve(directory, "assets/asset.glb");
    const assets = [{source: "https://example.invalid/asset.glb", output: "asset.glb", kind: "gltf" as const}];
    writeGlbFixture(path, document, binary);
    assert.equal(specializeGltf(path, "asset.glb").features.transmissiveMaterial, null);
    assert.throws(() => emitAssetSpecializations(directory, assets), /requires packaged source transmission selection/);
    await packageGltfTransmissionPlan(document);
    writeGlbFixture(path, document, binary);
    assert.equal(specializeGltf(path, "asset.glb").features.transmissiveMaterial, true);
    assert.equal(emitAssetSpecializations(directory, assets).assetTransmission, true);
});

test("recorded transmission registration follows the actual source call", async () => {
    type Setter = {setPbrTransmission(material: JsonObject, options: JsonObject): void};
    const contexts = [undefined, doctoredContext("src/material/pbr/set-transmission.ts",
        "_registerPbrSceneHook(registerPbrTransmission);", "if (refraction.intensity > 0) _registerPbrSceneHook(registerPbrTransmission);")];
    for (const [index, context] of contexts.entries()) {
        const setter = await import(recordingTransmissionSetter("transmission", context)) as Setter;
        const material: JsonObject = {};
        setter.setPbrTransmission(material, {intensity: 0});
        assert.equal(material[transmissionRegistrationMarker] === true, index === 0);
        assert.equal(material._transmissive, true);
        assert.equal(Object.keys(material).includes(transmissionRegistrationMarker), false);
    }
});
