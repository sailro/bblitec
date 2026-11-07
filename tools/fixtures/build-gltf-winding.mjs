// Builds examples/assets/regression/gltf-winding.gltf.
//
// A project-owned fixture for the winding a glTF primitive keeps when a
// program replaces its material. Twelve closed unit cubes sharing one
// geometry, wound counter-clockwise from outside as glTF requires, with
// per-face normals: a row per material family the program assigns
// (Standard, Shader, Node) and, in each row,
//
//   SinglePlain     a back-culling material
//   SingleMirrored  the same, under a node scaled -1 in x
//   DoublePlain     a double-sided material
//   DoubleMirrored  the same, mirrored
//
// The loader marks a primitive whose world mirrors the root's handedness
// ("cw"), so every cube reaches its later material with or without the
// mark, in either build: left-handed the mirrored nodes carry it,
// right-handed the plain ones do.
//
// Run: node tools/fixtures/build-gltf-winding.mjs
import {
    createBinaryChunk,
    f32,
    u16,
    vec3Accessor,
    writeFixture,
} from "./glb.mjs";

/** @typedef {[number, number, number]} Point */

const chunk = createBinaryChunk();

// Each face: its outward normal and two in-plane axes whose cross product
// is that normal, so the corners below run counter-clockwise from outside.
/** @type {ReadonlyArray<readonly [Point, Point, Point]>} */
const faces = [
    [
        [1, 0, 0],
        [0, 0, -1],
        [0, 1, 0],
    ],
    [
        [-1, 0, 0],
        [0, 0, 1],
        [0, 1, 0],
    ],
    [
        [0, 1, 0],
        [1, 0, 0],
        [0, 0, -1],
    ],
    [
        [0, -1, 0],
        [1, 0, 0],
        [0, 0, 1],
    ],
    [
        [0, 0, 1],
        [1, 0, 0],
        [0, 1, 0],
    ],
    [
        [0, 0, -1],
        [-1, 0, 0],
        [0, 1, 0],
    ],
];
/** @type {Point[]} */
const positions = [];
/** @type {Point[]} */
const normals = [];
/** @type {number[]} */
const indices = [];
/** @type {ReadonlyArray<readonly [number, number]>} */
const corners = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
];
const AXES = /** @type {const} */ ([0, 1, 2]);
for (const [normal, u, v] of faces) {
    const base = positions.length;
    for (const [su, sv] of corners) {
        positions.push(
            /** @type {Point} */ (
                AXES.map(
                    (axis) =>
                        0.5 * (normal[axis] + su * u[axis] + sv * v[axis]),
                )
            ),
        );
        normals.push(normal);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

// Both cubes share one geometry; only their materials differ.
const attributes = {
    POSITION: vec3Accessor(chunk, positions),
    NORMAL: chunk.accessor({
        bufferView: chunk.view(f32(normals.flat())),
        componentType: 5126,
        count: normals.length,
        type: "VEC3",
    }),
};
const indexAccessor = chunk.accessor({
    bufferView: chunk.view(u16(indices)),
    componentType: 5123,
    count: indices.length,
    type: "SCALAR",
});
/** @param {number} material */
const primitive = (material) => ({
    mode: 4,
    attributes,
    indices: indexAccessor,
    material,
});

const families = ["Standard", "Shader", "Node"];
const cases = /** @type {const} */ ([
    ["SinglePlain", 0, 1],
    ["SingleMirrored", 0, -1],
    ["DoublePlain", 1, 1],
    ["DoubleMirrored", 1, -1],
]);
const nodes = families.flatMap((family, row) =>
    cases.map(([name, material, mirror], column) => ({
        name: `${family}${name}`,
        mesh: row * cases.length + column,
        translation: [(column - 1.5) * 1.4, (1 - row) * 1.4, 0],
        mirror,
        material,
    })),
);
writeFixture(
    "examples/assets/regression/gltf-winding.gltf",
    {
        asset: {
            version: "2.0",
            generator: "bblitec tools/fixtures/build-gltf-winding.mjs",
        },
        scene: 0,
        scenes: [{ nodes: nodes.map((_node, index) => index) }],
        nodes: nodes.map(({ name, mesh, translation, mirror }) => ({
            name,
            mesh,
            translation,
            ...(mirror < 0 ? { scale: [mirror, 1, 1] } : {}),
        })),
        meshes: nodes.map(({ name, material }) => ({
            name,
            primitives: [primitive(material)],
        })),
        materials: ["SingleSided", "DoubleSided"].map((name, index) => ({
            name: `${name}Material`,
            doubleSided: index === 1,
            pbrMetallicRoughness: {
                baseColorFactor: [1, 1, 1, 1],
                metallicFactor: 0,
                roughnessFactor: 0.6,
            },
        })),
        accessors: chunk.accessors,
        bufferViews: chunk.bufferViews,
    },
    chunk,
);
