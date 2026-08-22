import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
    emitAssetSpecializations,
    specializeGltf,
} from "../src/asset-specializer.js";

function writeGlb(path: string, document: Record<string, unknown>): void {
    const json = Buffer.from(JSON.stringify(document));
    const paddedLength = Math.ceil(json.length / 4) * 4;
    const binaryLength = 4;
    const buffer = Buffer.alloc(12 + 8 + paddedLength + 8 + binaryLength, 0x20);
    buffer.writeUInt32LE(0x46546c67, 0);
    buffer.writeUInt32LE(2, 4);
    buffer.writeUInt32LE(buffer.length, 8);
    buffer.writeUInt32LE(paddedLength, 12);
    buffer.writeUInt32LE(0x4e4f534a, 16);
    json.copy(buffer, 20);
    const binaryHeader = 20 + paddedLength;
    buffer.writeUInt32LE(binaryLength, binaryHeader);
    buffer.writeUInt32LE(0x004e4942, binaryHeader + 4);
    writeFileSync(path, buffer);
}

test("specializes glTF dynamic feature imports without any-typed JSON", () => {
    const directory = mkdtempSync(join(tmpdir(), "bblitec-gltf-"));
    try {
        const path = join(directory, "asset.glb");
        writeGlb(path, {
            extensionsUsed: ["KHR_texture_transform"],
            animations: [{}],
            accessors: [{ count: 384 }],
            materials: [{ name: "Glass", alphaMode: "BLEND", doubleSided: true }],
            meshes: [
                { name: "Lines", primitives: [{ mode: 1, targets: [{}], material: 0 }] },
                { name: "Mesh", primitives: [{ attributes: { POSITION: 0 }, material: 0 }] },
            ],
            nodes: [
                { name: "LineNode", mesh: 0 },
                { name: "Node", mesh: 1 },
            ],
            skins: [{}],
        });
        const specialization = specializeGltf(path, "asset.glb");
        assert.deepEqual(specialization.extensionsUsed, ["KHR_texture_transform"]);
        assert.ok(specialization.staticModules.includes("./gltf-ext-uv-transform.js"));
        assert.ok(specialization.staticModules.includes("./gltf-feature-animations.js"));
        assert.ok(specialization.staticModules.includes("./gltf-feature-morph.js"));
        // The pinned skeleton predicate needs BOTH conjuncts —
        // `!!j.skins?.length && anyPrimitive(j, p.attributes?.JOINTS_0 !==
        // void 0)` (gltf-feature-registry.ts) — so a skins array with no
        // skinned primitive imports nothing upstream and records nothing.
        assert.ok(!specialization.staticModules.includes("./gltf-feature-skeleton.js"));
        assert.equal(specialization.features.skins, false);
        assert.ok(specialization.staticModules.includes("./gltf-feature-primitive.js"));
        assert.equal(specialization.features.animations, true);
        // The same predicate gates the generated loader's topology
        // handling, so a document that pulls upstream's primitive feature
        // must also report the flag the emitter reads.
        assert.equal(specialization.features.nonTrianglePrimitives, true);
        assert.deepEqual(specialization.renderItems, [
            {
                drawId: 1,
                nodeIndex: 0,
                nodeName: "LineNode",
                meshIndex: 0,
                meshName: "Lines",
                primitiveIndex: 0,
                triangleCount: 0,
                trianglesPerCluster: 128,
                clusterIdStart: 0,
                clusterCount: 0,
                materialIndex: 0,
                materialName: "Glass",
                shaderVariant: "pbr",
                alphaMode: "BLEND",
                doubleSided: true,
            },
            {
                drawId: 2,
                nodeIndex: 1,
                nodeName: "Node",
                meshIndex: 1,
                meshName: "Mesh",
                primitiveIndex: 0,
                triangleCount: 128,
                trianglesPerCluster: 128,
                clusterIdStart: 1,
                clusterCount: 1,
                materialIndex: 0,
                materialName: "Glass",
                shaderVariant: "pbr",
                alphaMode: "BLEND",
                doubleSided: true,
            },
        ]);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("selects PBR material-extension specializations from glTF metadata", () => {
    const scratch = resolve("artifacts", "test", "asset-specializer");
    rmSync(scratch, { recursive: true, force: true });
    mkdirSync(join(scratch, "assets"), { recursive: true });
    try {
        writeGlb(join(scratch, "assets", "extensions.glb"), {
            extensionsUsed: [
                "KHR_materials_clearcoat",
                "KHR_materials_sheen",
                "KHR_materials_iridescence",
                "KHR_materials_dispersion",
            ],
            materials: [{ name: "Layered" }],
            meshes: [],
            nodes: [],
        });
        const features = emitAssetSpecializations(scratch, [
            {
                source: "https://example.invalid/extensions.glb",
                output: "extensions.glb",
                kind: "gltf",
            },
        ]);
        assert.equal(features.clearcoat, true);
        assert.equal(features.sheen, true);
        assert.equal(features.iridescence, true);
        // Dispersion keys on the evaluated pinned predicate, not presence: a
        // declared extension with no factor, refraction, or volume reaches
        // nothing upstream (`needsDispersion` in gltf-ext-dielectric.ts).
        assert.equal(features.dispersion, false);
        assert.equal(features.textureTransform, false);
        assert.equal(features.punctualLights, false);

        writeGlb(join(scratch, "assets", "dispersive.glb"), {
            extensionsUsed: [
                "KHR_materials_dispersion",
                "KHR_materials_transmission",
                "KHR_materials_volume",
            ],
            materials: [
                {
                    name: "Prism",
                    extensions: {
                        KHR_materials_dispersion: { dispersion: 0.1 },
                        KHR_materials_transmission: { transmissionFactor: 1 },
                        KHR_materials_volume: { thicknessFactor: 0.5 },
                    },
                },
            ],
            meshes: [],
            nodes: [],
        });
        const dispersive = emitAssetSpecializations(scratch, [
            {
                source: "https://example.invalid/dispersive.glb",
                output: "dispersive.glb",
                kind: "gltf",
            },
        ]);
        assert.equal(dispersive.dispersion, true);

        // The workflow replacement: `specializeGltf` accepts it now rather
        // than refusing, and the declared extension is the whole activation
        // input — there is no scene half and no evaluated predicate.
        writeGlb(join(scratch, "assets", "spec-gloss.glb"), {
            extensionsUsed: ["KHR_materials_pbrSpecularGlossiness"],
            materials: [{ name: "SpecGloss" }],
            meshes: [],
            nodes: [],
        });
        const specGloss = emitAssetSpecializations(scratch, [
            {
                source: "https://example.invalid/spec-gloss.glb",
                output: "spec-gloss.glb",
                kind: "gltf",
            },
        ]);
        assert.equal(specGloss.specularGlossiness, true);

        writeGlb(join(scratch, "assets", "plain.glb"), {
            materials: [{ name: "Plain" }],
            meshes: [],
            nodes: [],
        });
        const plain = emitAssetSpecializations(scratch, [
            {
                source: "https://example.invalid/plain.glb",
                output: "plain.glb",
                kind: "gltf",
            },
        ]);
        assert.equal(plain.clearcoat, false);
        assert.equal(plain.sheen, false);
        assert.equal(plain.iridescence, false);
        assert.equal(plain.dispersion, false);
        assert.equal(plain.specularGlossiness, false);
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
});

test("the skeleton module needs skins and a JOINTS_0 primitive", () => {
    const directory = mkdtempSync(join(tmpdir(), "bblitec-gltf-"));
    try {
        const path = join(directory, "skinned.glb");
        writeGlb(path, {
            accessors: [{ count: 3 }],
            meshes: [
                {
                    primitives: [
                        { attributes: { POSITION: 0, JOINTS_0: 0, WEIGHTS_0: 0 } },
                    ],
                },
            ],
            nodes: [{ mesh: 0 }],
            skins: [{}],
        });
        const specialization = specializeGltf(path, "skinned.glb");
        assert.ok(
            specialization.staticModules.includes(
                "./gltf-feature-skeleton.js",
            ),
        );
        assert.equal(specialization.features.skins, true);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("records the largest skin, which bounds the palette transport", () => {
    // Deformation runs on the GPU or not at all, so which transport can
    // carry a skin is a generation-time question: the pin's own per-bone
    // palette texture caps nothing, while the transcribed vertex stage's
    // uniform array holds DEFORMATION_BONE_SLOTS matrices. The specializer
    // supplies the asset half of that comparison.
    const directory = mkdtempSync(join(tmpdir(), "bblitec-gltf-"));
    try {
        const path = join(directory, "skinned.glb");
        writeGlb(path, {
            accessors: [{ count: 3 }],
            meshes: [
                {
                    primitives: [
                        { attributes: { POSITION: 0, JOINTS_0: 0, WEIGHTS_0: 0 } },
                    ],
                },
            ],
            nodes: [{ mesh: 0 }],
            skins: [
                { joints: [0, 1, 2] },
                { joints: Array.from({ length: 70 }, (_, index) => index) },
            ],
        });
        // The largest skin, not the first and not the sum.
        assert.equal(specializeGltf(path, "skinned.glb").features.maxSkinJoints, 70);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("an asset with no skins bounds nothing", () => {
    const directory = mkdtempSync(join(tmpdir(), "bblitec-gltf-"));
    try {
        const path = join(directory, "static.glb");
        writeGlb(path, {
            accessors: [{ count: 3 }],
            meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
            nodes: [{ mesh: 0 }],
        });
        assert.equal(specializeGltf(path, "static.glb").features.maxSkinJoints, 0);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("refuses asset content the pinned loader implements and this port does not", () => {
    const directory = mkdtempSync(join(tmpdir(), "bblitec-gltf-"));
    try {
        const path = join(directory, "asset.glb");
        const throwsMatching = (
            document: Record<string, unknown>,
            pattern: RegExp,
        ): void => {
            writeGlb(path, document);
            assert.throws(() => specializeGltf(path, "asset.glb"), pattern);
        };

        // A pin-implemented extension composes a different fragment upstream,
        // so ignoring it renders silently wrong — the refusal names it.
        // `KHR_materials_pbrSpecularGlossiness` used to sit here and is
        // lowered now, which is what removing it from the list means.
        throwsMatching(
            { extensionsUsed: ["KHR_materials_anisotropy"] },
            /anisotropy/,
        );

        // Metadata-only extensions have no rendering effect on either side.
        writeGlb(path, { extensionsUsed: ["KHR_xmp_json_ld", "KHR_xmp"] });
        assert.deepEqual(
            specializeGltf(path, "asset.glb").extensionsUsed,
            ["KHR_xmp_json_ld", "KHR_xmp"],
        );

        // Eight-influence skinning: the pin reads JOINTS_1/WEIGHTS_1
        // (MSH_HAS_SKELETON_8); this port reads four influences and records
        // the truncation as a fidelity adaptation rather than refusing —
        // Scene 7's ChibiRex carries the second pair and gates it.
        writeGlb(path, {
            accessors: [{ count: 3 }],
            meshes: [
                {
                    primitives: [
                        {
                            attributes: {
                                POSITION: 0,
                                JOINTS_0: 0,
                                JOINTS_1: 0,
                            },
                        },
                    ],
                },
            ],
        });
        assert.equal(
            specializeGltf(path, "asset.glb").features
                .eightInfluenceSkinning,
            true,
        );

        // An attribute the pinned loader also ignores passes: `wrapTexCoord`
        // stamps only `_texCoord: 1`, so a TEXCOORD_2 nothing samples on
        // either side renders identically (Scene 176's asset carries one).
        writeGlb(path, {
            accessors: [{ count: 3 }],
            meshes: [
                {
                    primitives: [
                        { attributes: { POSITION: 0, TEXCOORD_2: 0 } },
                    ],
                },
            ],
        });
        assert.equal(
            specializeGltf(path, "asset.glb").features
                .eightInfluenceSkinning,
            false,
        );

        // Sparse accessors used to throw while the native loader parsed the
        // asset; generation now refuses first, naming the asset.
        throwsMatching(
            { accessors: [{ count: 3, sparse: {} }] },
            /sparse/i,
        );

        // The two ORM shapes the generated loader refuses at load fail at
        // generation with the same meaning.
        throwsMatching(
            {
                textures: [{ source: 0 }, { source: 1 }],
                materials: [
                    {
                        occlusionTexture: { index: 0 },
                        pbrMetallicRoughness: {
                            metallicRoughnessTexture: { index: 1 },
                        },
                    },
                ],
            },
            /distinct glTF occlusion and metallic-roughness images/,
        );
        throwsMatching(
            {
                textures: [{ source: 0 }, { source: 1 }],
                materials: [
                    {
                        occlusionTexture: { index: 0, texCoord: 1 },
                        pbrMetallicRoughness: {
                            metallicRoughnessTexture: { index: 1 },
                        },
                    },
                ],
            },
            /TEXCOORD_1 alongside a metallic-roughness texture/,
        );

        // One shared image through two texture objects stays the supported
        // orm-unpack shape and passes.
        writeGlb(path, {
            textures: [{ source: 0 }, { source: 0 }],
            materials: [
                {
                    occlusionTexture: { index: 0 },
                    pbrMetallicRoughness: {
                        metallicRoughnessTexture: { index: 1 },
                    },
                },
            ],
        });
        specializeGltf(path, "asset.glb");
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
