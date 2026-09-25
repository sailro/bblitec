import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
    emitAssetSpecializations,
    gltfAssetDocuments,
    specializeGltf,
} from "../src/asset-specializer.js";
import { BinaryBuilder } from "../src/glb-binary-builder.js";
import { parseGlbJson } from "../src/gltf-document.js";
import { type JsonObject } from "../src/json-fields.js";
import { writeGlbFixture } from "./glb-fixture.js";
import { packageGltfMeshPlan } from "../src/gltf-mesh-plan.js";
import { packageGltfTransmissionPlan } from "../src/pinned-material-arms.js";

/** Specialize packaged assets the way generation does: parsed once. */
function specialize(
    directory: string,
    assets: Parameters<typeof emitAssetSpecializations>[1],
): ReturnType<typeof emitAssetSpecializations> {
    return emitAssetSpecializations(
        directory,
        assets,
        gltfAssetDocuments(directory, assets),
    );
}

function writeGlb(path: string, document: Record<string, unknown>): void {
    writeGlbFixture(path, document, Buffer.alloc(4));
}

test("specializes glTF dynamic feature imports without any-typed JSON", () => {
    const directory = mkdtempSync(join(tmpdir(), "bblitec-gltf-"));
    try {
        const path = join(directory, "asset.glb");
        writeGlb(path, {
            extensionsUsed: ["KHR_texture_transform"],
            animations: [{}],
            accessors: [{ count: 384 }],
            materials: [
                { name: "Glass", alphaMode: "BLEND", doubleSided: true },
            ],
            meshes: [
                {
                    name: "Lines",
                    primitives: [{ mode: 1, targets: [{}], material: 0 }],
                },
                {
                    name: "Mesh",
                    primitives: [{ attributes: { POSITION: 0 }, material: 0 }],
                },
            ],
            nodes: [
                { name: "LineNode", mesh: 0 },
                { name: "Node", mesh: 1 },
            ],
            skins: [{}],
        });
        const specialization = specializeGltf(parseGlbJson(path), "asset.glb");
        assert.deepEqual(specialization.extensionsUsed, [
            "KHR_texture_transform",
        ]);
        // Which loader features ran is packaging's record of the pin's own
        // run; an unpackaged document has none to read.
        assert.equal(specialization.loader, null);
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

test("accepts the pin-implemented material extensions and records the loader facts", async () => {
    const scratch = resolve("artifacts", "test", "asset-specializer");
    rmSync(scratch, { recursive: true, force: true });
    mkdirSync(join(scratch, "assets"), { recursive: true });
    const writePackaged = async (
        name: string,
        document: Record<string, unknown>,
    ): Promise<void> => {
        const binary = await packageGltfMeshPlan(
            document,
            new DataView(new ArrayBuffer(4)),
        );
        await packageGltfTransmissionPlan(document);
        writeGlbFixture(join(scratch, "assets", name), document, binary);
    };
    try {
        await writePackaged("extensions.glb", {
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
        const features = specialize(scratch, [
            {
                source: "https://example.invalid/extensions.glb",
                output: "extensions.glb",
                kind: "gltf",
            },
        ]);
        // The layered extensions are accepted; which arms they compose is
        // the composed variants' own answer, so the record carries only
        // the facts the loader lowering keys on.
        assert.equal(features.textureTransform, false);
        assert.equal(features.assetTransmission, false);

        await writePackaged("dispersive.glb", {
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
        const dispersive = specialize(scratch, [
            {
                source: "https://example.invalid/dispersive.glb",
                output: "dispersive.glb",
                kind: "gltf",
            },
        ]);
        // No source mesh uses this material, so it enables no scene transmission.
        assert.equal(dispersive.assetTransmission, false);

        // The workflow replacement: `specializeGltf` accepts it rather than
        // refusing. Whether a variant binds the spec-gloss pair is read off
        // the composition, where the pin sets PBR_HAS_SPEC_GLOSS only for a
        // material carrying the texture.
        await writePackaged("spec-gloss.glb", {
            extensionsUsed: ["KHR_materials_pbrSpecularGlossiness"],
            materials: [{ name: "SpecGloss" }],
            meshes: [],
            nodes: [],
        });
        assert.doesNotThrow(() =>
            specialize(scratch, [
                {
                    source: "https://example.invalid/spec-gloss.glb",
                    output: "spec-gloss.glb",
                    kind: "gltf",
                },
            ]),
        );

        await writePackaged("plain.glb", {
            materials: [{ name: "Plain" }],
            meshes: [],
            nodes: [],
        });
        const plain = specialize(scratch, [
            {
                source: "https://example.invalid/plain.glb",
                output: "plain.glb",
                kind: "gltf",
            },
        ]);
        assert.equal(plain.assetTransmission, false);
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
});

/**
 * A one-triangle document packaged the way generation packages every asset,
 * specialized from the record of the pin's own loader run.
 */
async function packagedLoader(options: {
    skinned?: boolean;
    skins?: boolean;
    morph?: boolean;
    mode?: number;
    scale?: number[];
}): Promise<NonNullable<ReturnType<typeof specializeGltf>["loader"]>> {
    const binary = new BinaryBuilder(Buffer.alloc(0));
    const accessors: JsonObject[] = [],
        bufferViews: JsonObject[] = [];
    const append = (
        data: Float32Array | Uint8Array,
        type: string,
        normalized = false,
    ): number => {
        bufferViews.push({
            buffer: 0,
            byteOffset: binary.append(data),
            byteLength: data.byteLength,
        });
        accessors.push({
            bufferView: bufferViews.length - 1,
            componentType: data instanceof Float32Array ? 5126 : 5121,
            count: data.length / (type === "VEC3" ? 3 : 4),
            type,
            normalized,
        });
        return accessors.length - 1;
    };
    const attributes: JsonObject = {
        POSITION: append(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), "VEC3"),
    };
    if (options.skinned) {
        attributes.JOINTS_0 = append(new Uint8Array(12), "VEC4");
        attributes.WEIGHTS_0 = append(
            new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0]),
            "VEC4",
            true,
        );
    }
    const primitive: JsonObject = {
        attributes,
        ...(options.mode !== undefined ? { mode: options.mode } : {}),
        ...(options.morph
            ? {
                  targets: [
                      {
                          POSITION: append(
                              new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
                              "VEC3",
                          ),
                      },
                  ],
              }
            : {}),
    };
    const document: JsonObject = {
        asset: { version: "2.0" },
        buffers: [{ byteLength: binary.byteLength }],
        bufferViews,
        accessors,
        ...(options.skins ? { skins: [{ joints: [1] }] } : {}),
        nodes: [
            {
                mesh: 0,
                ...(options.skins && options.skinned ? { skin: 0 } : {}),
                ...(options.scale ? { scale: options.scale } : {}),
            },
            {},
        ],
        meshes: [{ primitives: [primitive] }],
        scenes: [{ nodes: [0, 1] }],
    };
    const bytes = binary.build();
    await packageGltfMeshPlan(
        document,
        new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    );
    const { loader } = specializeGltf(document, "asset.glb");
    assert.ok(loader);
    return loader;
}

test("reads the features the pinned loader ran from the packaged record", async () => {
    const skinned = await packagedLoader({
        skins: true,
        skinned: true,
        morph: true,
    });
    assert.equal(skinned.skins, true);
    assert.equal(skinned.morphTargets, true);
    assert.equal(skinned.animations, false);
    assert.equal(skinned.nonTrianglePrimitives, false);
    // The registry's skeleton row needs both a skin and a JOINTS_0
    // primitive, so a skins array over unskinned geometry runs nothing.
    const unskinned = await packagedLoader({ skins: true });
    assert.equal(unskinned.skins, false);
    assert.equal(unskinned.morphTargets, false);
});

test("topology handling follows the topology the pin's primitive feature set", async () => {
    const lines = await packagedLoader({ mode: 1 });
    assert.equal(lines.nonTrianglePrimitives, true);
    assert.equal(lines.pointOrLinePrimitives, true);
    // A mirrored node runs the primitive feature too, for its winding
    // alone; the generated loader answers the winding inline, so a triangle
    // list keeps no topology handling.
    const mirrored = await packagedLoader({ scale: [-1, 1, 1] });
    assert.equal(mirrored.nonTrianglePrimitives, false);
    assert.equal(mirrored.pointOrLinePrimitives, false);
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
                        {
                            attributes: {
                                POSITION: 0,
                                JOINTS_0: 0,
                                WEIGHTS_0: 0,
                            },
                        },
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
        assert.equal(
            specializeGltf(parseGlbJson(path), "skinned.glb").features
                .maxSkinJoints,
            70,
        );
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
        assert.equal(
            specializeGltf(parseGlbJson(path), "static.glb").features
                .maxSkinJoints,
            0,
        );
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
            assert.throws(
                () => specializeGltf(parseGlbJson(path), "asset.glb"),
                pattern,
            );
        };

        // A pin-implemented extension composes a different fragment upstream,
        // so ignoring it renders silently wrong — the refusal names it.
        // `KHR_materials_pbrSpecularGlossiness` used to sit here and is
        // lowered now, which is what removing it from the list means.
        writeGlb(path, {
            extensionsUsed: [
                "KHR_materials_anisotropy",
                "KHR_materials_diffuse_transmission",
            ],
        });
        assert.deepEqual(
            specializeGltf(parseGlbJson(path), "asset.glb").extensionsUsed,
            ["KHR_materials_anisotropy", "KHR_materials_diffuse_transmission"],
        );

        // Metadata-only extensions have no rendering effect on either side.
        writeGlb(path, { extensionsUsed: ["KHR_xmp_json_ld", "KHR_xmp"] });
        assert.deepEqual(
            specializeGltf(parseGlbJson(path), "asset.glb").extensionsUsed,
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
            specializeGltf(parseGlbJson(path), "asset.glb").features
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
            specializeGltf(parseGlbJson(path), "asset.glb").features
                .eightInfluenceSkinning,
            false,
        );

        // Packaging materializes every sparse accessor through the pin's
        // own preParse, so one reaching the specializer means that pass did
        // not run over this document.
        throwsMatching(
            { accessors: [{ count: 3, sparse: {} }] },
            /sparse glTF accessor survived packaging/,
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
        // Occlusion on TEXCOORD_1 beside a metallic-roughness texture that
        // names the SAME texture object composes an occlusion binding the
        // pinned loader builds no texture for: assemblePbrPropsExt sets uv2
        // mask bit 32 from the texCoord while buildDefaultPbrTexturesExt
        // builds a carrier only for occlusionNeedsSplit. The browser fails
        // WebGPU validation and renders a black canvas, so this refuses.
        throwsMatching(
            {
                textures: [{ source: 0 }],
                materials: [
                    {
                        occlusionTexture: { index: 0, texCoord: 1 },
                        pbrMetallicRoughness: {
                            metallicRoughnessTexture: { index: 0 },
                        },
                    },
                ],
            },
            /names the same texture object as the metallic-roughness slot/,
        );
        // Through a SECOND texture object over the same image, the carrier
        // exists and the pair binds -- the arm the glTF UV-sets gate
        // measures byte-exact on both backends.
        writeGlb(path, {
            accessors: [{ count: 3 }],
            textures: [{ source: 0 }, { source: 0 }],
            materials: [
                {
                    occlusionTexture: { index: 1, texCoord: 1 },
                    pbrMetallicRoughness: {
                        metallicRoughnessTexture: { index: 0 },
                    },
                },
            ],
        });
        assert.doesNotThrow(() =>
            specializeGltf(parseGlbJson(path), "asset.glb"),
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
        specializeGltf(parseGlbJson(path), "asset.glb");
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
