import assert from "node:assert/strict";
import test from "node:test";
import { commonResourceValue, nativeDataMetadata, valueForKind, withNativeMetadata, type Value } from "../src/compiler/types.js";

test("value kinds reject unrelated payloads and narrow their own metadata", () => {
    // @ts-expect-error Texture metadata cannot describe a camera.
    const invalid: Value = { kind: "camera", cpp: "camera", textureWidth: 16 };
    assert.equal(invalid.kind, "camera");
    const material: Value = { kind: "material", cpp: "material", materialUboArrayFields: new Map() };
    // @ts-expect-error A material cannot acquire callback payloads.
    material.callbackRecordOwner = material;
    assert.ok(material.materialUboArrayFields instanceof Map);
});

test("native metadata round trips preserve shared resource identity", () => {
    const texture: Value = {
        kind: "texture", cpp: "texture", textureStorage: "file",
        textureFile: { srgb: true, source: "texture.png" }, textureWidth: 32,
        sharedStorageCpp: "storage", engineCpp: "engine",
    };
    const transported: Value = { ...nativeDataMetadata(texture), kind: "data", cpp: "slot" };
    const restored = withNativeMetadata({ kind: "texture", cpp: "(*slot)" }, transported);
    assert.equal(restored.kind, "texture");
    assert.equal(restored.cpp, "(*slot)");
    assert.equal(restored.textureFile, texture.textureFile);
    assert.equal(restored.textureWidth, 32);
    assert.equal(restored.sharedStorageCpp, "storage");
    const camera = valueForKind("camera", transported);
    assert.equal(camera.engineCpp, "engine");
    assert.equal(Object.hasOwn(camera, "textureFile"), false);
    assert.equal(Object.hasOwn(camera, "textureWidth"), false);
});

test("materialization favors leaf metadata and strips generation payloads", () => {
    const source: Value = {
        kind: "data", cpp: "optional", animationGroupSource: "property",
        sceneEnvironmentState: { rotationSet: false, hasTexturedSkybox: false },
    };
    const group = withNativeMetadata({ kind: "animation-group", cpp: "group" }, source);
    assert.equal(group.animationGroupSource, "property");
    assert.equal(Object.hasOwn(group, "sceneEnvironmentState"), false);
    const scene = withNativeMetadata({
        kind: "scene", cpp: "scene",
        sceneEnvironmentState: { rotationSet: true, hasTexturedSkybox: true },
    }, source);
    assert.equal(scene.sceneEnvironmentState?.rotationSet, true);
    assert.equal(Object.hasOwn(scene, "animationGroupSource"), false);
    const promise: Value = { kind: "promise", cpp: "promise", promiseResult: group, promiseType: "Group" };
    assert.equal(Object.hasOwn(nativeDataMetadata(promise), "promiseResult"), false);
    assert.equal(Object.hasOwn(valueForKind("data", promise), "promiseType"), false);
});

test("runtime choices retain only common resource metadata", () => {
    const first: Value = { kind: "light", cpp: "first", lightIdentity: {}, lightKind: "point" };
    const other: Value = { ...first, cpp: "other", lightIdentity: {} };
    const selected = commonResourceValue(first, [first, other]);
    assert.equal(selected.lightIdentity, undefined);
    assert.equal(selected.lightKind, "point");
    const mesh: Value = { kind: "mesh", cpp: "mesh", sceneMeshIndex: 1, directMorphCompatible: true };
    const dynamic: Value = { kind: "mesh", cpp: "dynamic", runtimeMeshStreams: true };
    const meshes = commonResourceValue(mesh, [mesh, dynamic]);
    assert.equal(meshes.sceneMeshIndex, undefined);
    assert.equal(meshes.directMorphCompatible, undefined);
    assert.equal(meshes.runtimeMeshStreams, true);
    const loaded: Value = { kind: "asset", cpp: "first", asset: { kind: "gltf", source: "first.glb", output: "first.glb" } };
    const otherAsset: Value = { kind: "asset", cpp: "second", asset: { kind: "gltf", source: "second.glb", output: "second.glb" } };
    const assets = commonResourceValue(loaded, [loaded, otherAsset]);
    assert.equal(assets.asset, undefined);
    assert.equal(assets.assetKind, "gltf");
    const mixed = commonResourceValue(assets, [assets, { kind: "asset", cpp: "third", assetKind: "babylon" }]);
    assert.equal(mixed.assetKind, undefined);
});
