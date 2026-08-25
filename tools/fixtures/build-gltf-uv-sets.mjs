// Builds examples/assets/regression/gltf-uv-sets.gltf.
//
// A project-owned fixture for glTF texture-coordinate selection, which the
// corpus reaches only for occlusion: across all 48 corpus model URLs the one
// non-occlusion `texCoord: 1` is a normal map in scene 144's dragon, and
// `KHR_texture_transform.texCoord` has no usage at all. Every quad here
// carries both UV sets -- TEXCOORD_0 spans the whole image, TEXCOORD_1 spans
// one quadrant of it -- so a slot on the wrong set renders four blocks where
// the other renders one flat colour, which is a difference a gate can see.
//
// The seven materials are the arms `buildDefaultPbrTexturesExt` and
// `assemblePbrPropsExt` fork on:
//
//   0 base colour on TEXCOORD_1                      (_uv2Mask bit 1)
//   1 metallic-roughness on TEXCOORD_1               (_uv2Mask bit 2)
//   2 normal on TEXCOORD_1                           (_uv2Mask bit 4)
//   3 emissive on TEXCOORD_1                         (_uv2Mask bit 8)
//   4 base colour selected by KHR_texture_transform.texCoord, which the spec
//     says overrides textureInfo.texCoord -- and with no scale, offset or
//     rotation beside it, so the transform patches nothing and composes none
//     (`_hasTx` stays unset)
//   5 the orm-unpack split: occlusion shares the metallic-roughness image
//     through a second texture object carrying its own KHR_texture_transform,
//     so the fragment samples ormTexture a second time at occlUV
//   6 occlusion on TEXCOORD_1 beside a metallic-roughness texture that shares
//     its image through a second texture object: the dedicated uv2 occlusion
//     pair over the ORM image, while the ORM slot keeps the
//     metallic-roughness transform
//
// Run: node tools/fixtures/build-gltf-uv-sets.mjs
import { createBinaryChunk, f32, u16, writeFixture } from "./glb.mjs";
import { quadrantPng } from "./png.mjs";

const chunk = createBinaryChunk();
const view = (bytes) => chunk.view(bytes);

// One shared unit quad in the XY plane, placed by node translation. The
// vertices are the same for every material, so the two UV sets and the
// indices are shared bufferViews rather than seven copies.
const HALF = 0.5;
const positions = view(
    f32([-HALF, -HALF, 0, HALF, -HALF, 0, HALF, HALF, 0, -HALF, HALF, 0]),
);
const normals = view(f32([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]));
const tangents = view(f32([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]));
// TEXCOORD_0 spans the whole image; TEXCOORD_1 spans its upper-right
// quadrant. glTF puts the UV origin at the image's top-left corner.
const uv0 = view(f32([0, 1, 1, 1, 1, 0, 0, 0]));
const uv1 = view(f32([0.5, 0.5, 1, 0.5, 1, 0, 0.5, 0]));
const indices = view(u16([0, 1, 2, 0, 2, 3]));

const accessors = [
    {
        bufferView: positions,
        componentType: 5126,
        count: 4,
        type: "VEC3",
        min: [-HALF, -HALF, 0],
        max: [HALF, HALF, 0],
    },
    { bufferView: normals, componentType: 5126, count: 4, type: "VEC3" },
    { bufferView: tangents, componentType: 5126, count: 4, type: "VEC4" },
    { bufferView: uv0, componentType: 5126, count: 4, type: "VEC2" },
    { bufferView: uv1, componentType: 5126, count: 4, type: "VEC2" },
    { bufferView: indices, componentType: 5123, count: 6, type: "SCALAR" },
];
const POSITION = 0;
const NORMAL = 1;
const TANGENT = 2;
const TEXCOORD_0 = 3;
const TEXCOORD_1 = 4;
const INDICES = 5;

// Base colour: four saturated quadrants, so a UV set is readable off a pixel.
const baseColorPng = quadrantPng(8, [
    [220, 60, 60, 255],
    [60, 200, 90, 255],
    [70, 110, 230, 255],
    [230, 200, 70, 255],
]);
// Normal map: four different tangent-space normals, so a slot sampling the
// wrong set shades a different way under the scene's directional light.
const normalPng = quadrantPng(8, [
    [128, 128, 255, 255],
    [220, 128, 190, 255],
    [36, 128, 190, 255],
    [128, 220, 190, 255],
]);
// ORM: red is occlusion, green roughness, blue metallic -- all three vary per
// quadrant, so the metallic-roughness slot and the split occlusion sample are
// each visible.
const ormPng = quadrantPng(8, [
    [255, 40, 0, 255],
    [255, 230, 0, 255],
    [90, 40, 0, 255],
    [90, 230, 0, 255],
]);

const images = [baseColorPng, normalPng, ormPng].map((png) => ({
    bufferView: view(png),
    mimeType: "image/png",
}));
// One nearest-filtered sampler, so each quadrant reads as a flat block and a
// UV difference cannot hide inside bilinear blending.
const samplers = [
    { magFilter: 9728, minFilter: 9728, wrapS: 33071, wrapT: 33071 },
];
const textures = [
    { sampler: 0, source: 0 },
    { sampler: 0, source: 1 },
    { sampler: 0, source: 2 },
    // The same ORM image through a second texture object, which is one of the
    // two things `occlusionNeedsSplit` accepts.
    { sampler: 0, source: 2 },
];
const BASE_COLOR_TEX = 0;
const NORMAL_TEX = 1;
const ORM_TEX = 2;
const ORM_TEX_ALIAS = 3;

const materials = [
    {
        name: "BaseColorUv1",
        doubleSided: true,
        pbrMetallicRoughness: {
            baseColorTexture: { index: BASE_COLOR_TEX, texCoord: 1 },
            metallicFactor: 0,
            roughnessFactor: 0.7,
        },
    },
    {
        name: "MetallicRoughnessUv1",
        doubleSided: true,
        pbrMetallicRoughness: {
            baseColorTexture: { index: BASE_COLOR_TEX },
            metallicRoughnessTexture: { index: ORM_TEX, texCoord: 1 },
            metallicFactor: 1,
            roughnessFactor: 1,
        },
    },
    {
        name: "NormalUv1",
        doubleSided: true,
        normalTexture: { index: NORMAL_TEX, texCoord: 1 },
        pbrMetallicRoughness: {
            baseColorTexture: { index: BASE_COLOR_TEX },
            metallicFactor: 0,
            roughnessFactor: 0.4,
        },
    },
    {
        name: "EmissiveUv1",
        doubleSided: true,
        emissiveFactor: [1, 1, 1],
        emissiveTexture: { index: BASE_COLOR_TEX, texCoord: 1 },
        pbrMetallicRoughness: {
            baseColorFactor: [0.02, 0.02, 0.02, 1],
            metallicFactor: 0,
            roughnessFactor: 0.9,
        },
    },
    {
        name: "BaseColorTransformTexCoord",
        doubleSided: true,
        pbrMetallicRoughness: {
            baseColorTexture: {
                index: BASE_COLOR_TEX,
                texCoord: 0,
                extensions: { KHR_texture_transform: { texCoord: 1 } },
            },
            metallicFactor: 0,
            roughnessFactor: 0.7,
        },
    },
    {
        name: "OcclusionUvSplit",
        doubleSided: true,
        occlusionTexture: {
            index: ORM_TEX_ALIAS,
            extensions: {
                KHR_texture_transform: { offset: [0.5, 0], scale: [0.5, 0.5] },
            },
        },
        pbrMetallicRoughness: {
            baseColorTexture: { index: BASE_COLOR_TEX },
            metallicRoughnessTexture: {
                index: ORM_TEX,
                extensions: { KHR_texture_transform: { scale: [1, 1] } },
            },
            metallicFactor: 1,
            roughnessFactor: 1,
        },
    },
    {
        name: "OcclusionUv2WithMetallicRoughness",
        doubleSided: true,
        // Through the ALIAS texture object rather than the metallic-roughness
        // one: buildDefaultPbrTexturesExt builds an occlusion carrier here
        // only for occlusionNeedsSplit, while assemblePbrPropsExt sets uv2
        // mask bit 32 from the texCoord alone. Naming the same texture object
        // would therefore have the composed fragment declare an occlusion
        // binding with no texture behind it -- which is a WebGPU validation
        // failure, and renders the browser's whole canvas black.
        occlusionTexture: { index: ORM_TEX_ALIAS, texCoord: 1 },
        pbrMetallicRoughness: {
            baseColorTexture: { index: BASE_COLOR_TEX },
            metallicRoughnessTexture: { index: ORM_TEX },
            metallicFactor: 1,
            roughnessFactor: 1,
        },
    },
];

// A 4x2 grid, the eighth cell left empty.
const COLUMNS = 4;
const SPACING = 1.25;
const nodes = materials.map((material, index) => {
    const column = index % COLUMNS;
    const row = Math.floor(index / COLUMNS);
    return {
        name: material.name,
        mesh: index,
        translation: [
            (column - (COLUMNS - 1) / 2) * SPACING,
            (0.5 - row) * SPACING,
            0,
        ],
    };
});
const meshes = materials.map((material, index) => ({
    name: material.name,
    primitives: [
        {
            attributes: {
                POSITION,
                NORMAL,
                TANGENT,
                TEXCOORD_0,
                TEXCOORD_1,
            },
            indices: INDICES,
            material: index,
        },
    ],
}));

writeFixture(
    "examples/assets/regression/gltf-uv-sets.gltf",
    {
        asset: {
            version: "2.0",
            generator: "bblitec tools/fixtures/build-gltf-uv-sets.mjs",
        },
        extensionsUsed: ["KHR_texture_transform"],
        scene: 0,
        scenes: [{ nodes: nodes.map((_node, index) => index) }],
        nodes,
        meshes,
        materials,
        accessors,
        bufferViews: chunk.bufferViews,
        images,
        samplers,
        textures,
    },
    chunk,
);
