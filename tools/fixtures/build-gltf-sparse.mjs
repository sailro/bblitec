// Builds examples/assets/regression/gltf-sparse.gltf.
//
// A project-owned fixture for glTF's core sparse-accessor feature, which no
// corpus asset carries. Every drawable quantity of the quad it describes is
// sparse: POSITION over a degenerate base bufferView, COLOR_0 with no base
// bufferView at all (the all-zero arm), and the index accessor over a base of
// zeros. Dropping any one of the three substitutions therefore changes the
// image rather than nudging it, which is what makes the gate worth its run.
//
// The three `sparse.indices.componentType` widths glTF allows are used once
// each (UNSIGNED_BYTE, UNSIGNED_SHORT, UNSIGNED_INT), so the pinned reader's
// three index arms are all exercised.
//
// Run: node tools/fixtures/build-gltf-sparse.mjs
import { createBinaryChunk, f32, u8, u16, u32, writeFixture } from "./glb.mjs";

const chunk = createBinaryChunk();

// POSITION: a degenerate base (every vertex at the origin) that the sparse
// substitution opens into the quad.
const positionBase = chunk.view(f32(new Array(12).fill(0)));
const positionSparseIndices = chunk.view(u8([0, 1, 2, 3]));
const positionSparseValues = chunk.view(
    f32([-0.8, -0.8, 0, 0.8, -0.8, 0, 0.8, 0.8, 0, -0.8, 0.8, 0]),
);
const normals = chunk.view(f32([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]));
// COLOR_0: no base bufferView at all, so the base is the all-zero array the
// spec calls for and the substitution supplies every texel.
const colorSparseIndices = chunk.view(u16([0, 1, 2, 3]));
const colorSparseValues = chunk.view(
    u8([220, 40, 40, 255, 40, 200, 60, 255, 50, 90, 230, 255, 230, 200, 40, 255]),
);
// Indices: a base run of zeros (three degenerate triangles) the substitution
// rewrites into the quad's two.
const indexBase = chunk.view(u16([0, 0, 0, 0, 0, 0]));
const indexSparseIndices = chunk.view(u32([0, 1, 2, 3, 4, 5]));
const indexSparseValues = chunk.view(u16([0, 1, 2, 0, 2, 3]));

const POSITION = chunk.accessor({
    name: "positionSparse",
    bufferView: positionBase,
    componentType: 5126,
    count: 4,
    type: "VEC3",
    min: [-0.8, -0.8, 0],
    max: [0.8, 0.8, 0],
    sparse: {
        count: 4,
        indices: { bufferView: positionSparseIndices, componentType: 5121 },
        values: { bufferView: positionSparseValues },
    },
});
const NORMAL = chunk.accessor({
    name: "normal",
    bufferView: normals,
    componentType: 5126,
    count: 4,
    type: "VEC3",
});
const COLOR_0 = chunk.accessor({
    name: "colorSparseNoBase",
    componentType: 5121,
    normalized: true,
    count: 4,
    type: "VEC4",
    sparse: {
        count: 4,
        indices: { bufferView: colorSparseIndices, componentType: 5123 },
        values: { bufferView: colorSparseValues },
    },
});
const INDICES = chunk.accessor({
    name: "indexSparse",
    bufferView: indexBase,
    componentType: 5123,
    count: 6,
    type: "SCALAR",
    sparse: {
        count: 6,
        indices: { bufferView: indexSparseIndices, componentType: 5125 },
        values: { bufferView: indexSparseValues },
    },
});

writeFixture(
    "examples/assets/regression/gltf-sparse.gltf",
    {
        asset: {
            version: "2.0",
            generator: "bblitec tools/fixtures/build-gltf-sparse.mjs",
        },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0, name: "SparseQuad" }],
        meshes: [
            {
                name: "SparseQuad",
                primitives: [
                    {
                        attributes: { POSITION, NORMAL, COLOR_0 },
                        indices: INDICES,
                        material: 0,
                    },
                ],
            },
        ],
        materials: [
            {
                name: "SparseVertexColor",
                doubleSided: true,
                pbrMetallicRoughness: {
                    baseColorFactor: [1, 1, 1, 1],
                    metallicFactor: 0,
                    roughnessFactor: 0.6,
                },
            },
        ],
        accessors: chunk.accessors,
        bufferViews: chunk.bufferViews,
    },
    chunk,
);
