// Raw node-geometry transport control: tight and strided source lanes,
// parent/child transforms, nonuniform scale and both determinant signs.
// Run from the repository root: node tools/fixtures/build-node-local-attributes.mjs
import { createBinaryChunk, f32, u16, vec3Accessor, writeFixture } from "./glb.mjs";

const chunk = createBinaryChunk();
const positions = [[-0.7, -0.5, 0], [0.7, -0.5, 0], [0.7, 0.5, 0], [-0.7, 0.5, 0]];
const normals = [[-0, 0.3, 2.75], [0.2, -0.4, 1.25], [0.4, 0.1, 3], [-0.3, 0.5, 2]];
const uv = [[0, 1], [1, 1], [1, 0], [0, 0]];
const position = vec3Accessor(chunk, positions);
const normal = vec3Accessor(chunk, normals);
const texcoord = chunk.accessor({ bufferView: chunk.view(f32(uv.flat())), componentType: 5126, count: 4, type: "VEC2" });
const indices = chunk.accessor({ bufferView: chunk.view(u16([0, 1, 2, 0, 2, 3])), componentType: 5123, count: 6, type: "SCALAR" });
const interleaved = chunk.view(f32(positions.flatMap((p, i) => [...p, ...normals[i], ...uv[i]])));
chunk.bufferViews[interleaved].byteStride = 32;
const stridedPosition = chunk.accessor({ ...chunk.accessors[position], bufferView: interleaved, byteOffset: 0 });
const stridedNormal = chunk.accessor({ ...chunk.accessors[normal], bufferView: interleaved, byteOffset: 12 });
const stridedUv = chunk.accessor({ ...chunk.accessors[texcoord], bufferView: interleaved, byteOffset: 24 });
const document = {
    asset: { version: "2.0", generator: "bblitec node local attributes control" },
    scene: 0, scenes: [{ nodes: [0, 2] }],
    nodes: [
        { name: "tight-parent", translation: [-1.4, -0.2, 0.1], rotation: [0, 0, Math.sin(0.13), Math.cos(0.13)], scale: [1.3, 0.7, 1.1], children: [1] },
        { name: "tight-child", mesh: 0, translation: [0.1, 0.2, 0.3], rotation: [0, Math.sin(0.2), 0, Math.cos(0.2)], scale: [0.8, 1.2, 1.4] },
        { name: "negative-parent", translation: [1.4, -0.2, 0.1], rotation: [Math.sin(0.1), 0, 0, Math.cos(0.1)], scale: [-1.1, 0.9, 1.3], children: [3] },
        { name: "negative-child", mesh: 1, translation: [-0.1, 0.1, 0.2], rotation: [0, Math.sin(-0.15), 0, Math.cos(-0.15)], scale: [0.8, 1.2, 1] },
    ],
    meshes: [
        { name: "tight-source", primitives: [{ attributes: { POSITION: position, NORMAL: normal, TEXCOORD_0: texcoord }, indices, material: 0 }] },
        { name: "negative-source", primitives: [{ attributes: { POSITION: position, NORMAL: normal, TEXCOORD_0: texcoord }, indices, material: 0 }] },
    ],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.8, 0.5, 0.2, 1] } }],
    bufferViews: chunk.bufferViews, accessors: chunk.accessors,
};
writeFixture("examples/assets/regression/node-local-attributes.gltf", document, chunk);
// Separate refusal control: NodeMaterial's pinned tight streams currently bind
// the whole interleaved buffer. Accessor de-striding is a different draw.
document.meshes[1].primitives[0].attributes = { POSITION: stridedPosition, NORMAL: stridedNormal, TEXCOORD_0: stridedUv };
writeFixture("examples/assets/regression/node-local-attributes-strided.gltf", document, chunk);
