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

test("scene Standard materials compose for imported UV2 mesh features", async () => {
    const outputPath = resolve("artifacts/standard-imported-mesh-composition");
    mkdirSync(join(outputPath, "assets"), { recursive: true });
    writeGlbFixture(join(outputPath, "level.glb"), {
        asset: {version:"2.0"}, scene:0, scenes:[{nodes:[0]}], nodes:[{mesh:0}],
        materials:[{}], meshes:[{primitives:[{attributes:{POSITION:0,NORMAL:0,TEXCOORD_0:1,TEXCOORD_1:1},indices:2,material:0}]}],
        buffers:[{byteLength:80}],bufferViews:[{buffer:0,byteOffset:0,byteLength:80}],
        accessors:[{bufferView:0,componentType:5126,count:3,type:"VEC3",min:[0,0,0],max:[1,1,1]},
            {bufferView:0,componentType:5126,count:3,type:"VEC2"},{bufferView:0,componentType:5123,count:3,type:"SCALAR"}],
    }, Buffer.alloc(80));
    const result = compileSource(`import {createEngine, loadGltf, getContainerMeshes, createStandardMaterial} from "@babylonjs/lite";
        const engine=await createEngine({});const asset=await loadGltf(engine,"level.glb");
        for(const mesh of getContainerMeshes(asset)) mesh.material=createStandardMaterial();`, {fileName:join(outputPath,"input.ts")});
    copyFileSync(join(outputPath,"level.glb"),join(outputPath,"assets",result.manifest.assets[0]!.output));
    const composed = await composeScenePipeline({result,outputPath,tree:new GeneratedTree(outputPath),
        specializationFeatures:emitAssetSpecializations(outputPath,result.manifest.assets),
        emittedArms:{clearcoat:false,clearcoatF0Remap:false,sheen:false,sheenAlbedoScaling:false,iridescence:false,occlusionUv2:false,transmission:false,dispersion:false}});
    const {MSH_HAS_UV2} = await importPinnedModule<{MSH_HAS_UV2:number}>("material/mesh-features.js");
    assert(composed.standardComposition!.selectors.some(row => row.meshFeatures === MSH_HAS_UV2));
    assert.equal(composed.standardRenderableMeshFeatures![0], MSH_HAS_UV2);
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
