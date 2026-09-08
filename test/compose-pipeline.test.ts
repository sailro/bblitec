import assert from "node:assert/strict";
import test from "node:test";
import { copyFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { compileSource } from "../src/compiler.js";
import { composeScenePipeline } from "../src/compose-pipeline.js";
import { emitAssetSpecializations } from "../src/asset-specializer.js";
import { GeneratedTree } from "../src/generated-tree.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { writeGlbFixture } from "./glb-fixture.js";
import {
    dynamicCasterFeatureSets,
    runtimePbrAssetFeatureSets,
    scenePbrMeshFeatureSets,
    staticSceneLightArms,
    uniformRuntimeMeshAttributes,
} from "../src/compose-pipeline.js";

function writeImportedMeshFixture(outputPath: string, skinned = false): void {
    mkdirSync(join(outputPath, "assets"), { recursive: true });
    writeGlbFixture(join(outputPath, "level.glb"), {
        asset: {version:"2.0"}, scene:0, scenes:[{nodes:skinned?[0,1]:[0]}],
        nodes:skinned?[{mesh:0,skin:0},{}]:[{mesh:0}],
        ...(skinned?{skins:[{joints:[1]}]}:{}),
        materials:[{}], meshes:[{primitives:[{attributes:{POSITION:0,NORMAL:0,TEXCOORD_0:1,TEXCOORD_1:1,
            ...(skinned?{JOINTS_0:3,WEIGHTS_0:4}:{})},indices:2,material:0}]}],
        buffers:[{byteLength:256}],bufferViews:[{buffer:0,byteOffset:0,byteLength:256}],
        accessors:[{bufferView:0,componentType:5126,count:3,type:"VEC3",min:[0,0,0],max:[1,1,1]},
            {bufferView:0,componentType:5126,count:3,type:"VEC2"},{bufferView:0,componentType:5123,count:3,type:"SCALAR"},
            {bufferView:0,componentType:5123,count:3,type:"VEC4"},{bufferView:0,componentType:5126,count:3,type:"VEC4"}],
    }, Buffer.alloc(256));
}

async function composeImportedMesh(outputPath: string, source: string) {
    const result = compileSource(source, {fileName:join(outputPath,"input.ts")});
    copyFileSync(join(outputPath,"level.glb"),join(outputPath,"assets",result.manifest.assets[0]!.output));
    return {result, composed: await composeScenePipeline({result,outputPath,tree:new GeneratedTree(outputPath),
        specializationFeatures:emitAssetSpecializations(outputPath,result.manifest.assets)})};
}

test("scene Standard materials compose for imported UV2 mesh features", async () => {
    const outputPath = resolve("artifacts/standard-imported-mesh-composition");
    writeImportedMeshFixture(outputPath);
    const {result,composed} = await composeImportedMesh(outputPath, `import {createEngine, loadGltf, getContainerMeshes, createStandardMaterial} from "@babylonjs/lite";
        const engine=await createEngine({});const asset=await loadGltf(engine,"level.glb");
        for(const mesh of getContainerMeshes(asset)) mesh.material=createStandardMaterial();`);
    assert.equal(result.manifest.standardMaterialUnknownMesh, true);
    const {MSH_HAS_UV2} = await importPinnedModule<{MSH_HAS_UV2:number}>("material/mesh-features.js");
    assert(composed.standardComposition!.selectors.some(row => row.meshFeatures === MSH_HAS_UV2));
    assert.equal(composed.standardRenderableMeshFeatures![0], MSH_HAS_UV2);
});

test("scene Standard markers do not compose for unrelated imported skeletons", async () => {
    const outputPath = resolve("artifacts/standard-imported-skeleton-composition");
    writeImportedMeshFixture(outputPath, true);
    const {result,composed} = await composeImportedMesh(outputPath, `import {createEngine, loadGltf, createBox, createStandardMaterial} from "@babylonjs/lite";
        const engine=await createEngine({});await loadGltf(engine,"level.glb");
        const marker=createBox(engine,1);marker.material=createStandardMaterial();`);
    const {MSH_HAS_SKELETON} = await importPinnedModule<{MSH_HAS_SKELETON:number}>("material/mesh-features.js");
    assert.equal(result.manifest.standardMaterialUnknownMesh, undefined);
    assert(composed.renderableMeshFeatures.some(value => (value & MSH_HAS_SKELETON) !== 0));
    assert(composed.standardComposition!.selectors.every(row => (row.meshFeatures & MSH_HAS_SKELETON) === 0));
    await assert.rejects(composeImportedMesh(outputPath, `import {createEngine, loadGltf, getContainerMeshes, createStandardMaterial} from "@babylonjs/lite";
        const engine=await createEngine({});const asset=await loadGltf(engine,"level.glb");
        for(const mesh of getContainerMeshes(asset)) mesh.material=createStandardMaterial();`),
        /Standard skeleton composition requires enableStandardSkeleton/);
});

test("dynamic caster views retain imported and scene mesh feature arms", () => {
    assert.deepEqual(
        dynamicCasterFeatureSets([1], [0], [16]),
        [0, 1, 16, 17],
    );
});

test("runtime Standard attributes ignore live shadow receiving but retain attribute ambiguity", () => {
    assert.equal(uniformRuntimeMeshAttributes([0, 256, 0], 256), 0);
    assert.equal(uniformRuntimeMeshAttributes([1, 257], 256), 1);
    assert.equal(uniformRuntimeMeshAttributes([0, 257], 256), undefined);
    assert.equal(uniformRuntimeMeshAttributes([], 256), undefined);
});

test("runtime PBR features combine thin instances with shadow receiving", () => {
    assert.deepEqual(
        runtimePbrAssetFeatureSets([1], [16], [256]),
        [1, 17, 257, 273],
    );
});

test("an always-present pool retains its conditional colour arm", () => {
    assert.deepEqual(
        scenePbrMeshFeatureSets(4, "always", true, 16, 32),
        [20, 52],
    );
    assert.deepEqual(
        scenePbrMeshFeatureSets(4, "possible", true, 16, 32),
        [4, 20, 52],
    );
    assert.deepEqual(
        scenePbrMeshFeatureSets(4, "always", false, 16, 32),
        [20],
    );
});

test("static scene light arms retain the shadow-receiver multi-light path", () => {
    assert.deepEqual(staticSceneLightArms([], false), {
        lightKinds: [],
        multiLight: false,
        noLight: true,
    });
    assert.deepEqual(staticSceneLightArms(["spot"], false), {
        lightKinds: ["spot"],
        multiLight: false,
        noLight: false,
    });
    assert.deepEqual(staticSceneLightArms(["spot"], true), {
        lightKinds: ["spot"],
        multiLight: true,
        noLight: false,
    });
    assert.deepEqual(
        staticSceneLightArms(["point", "directional"], true),
        {
            lightKinds: [],
            multiLight: true,
            noLight: false,
        },
    );
});
