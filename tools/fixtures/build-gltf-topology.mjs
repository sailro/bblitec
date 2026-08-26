// Builds examples/assets/regression/gltf-topology.gltf.
//
// A project-owned fixture for glTF's non-triangle primitive modes. The corpus
// carries exactly one asset with a mode other than TRIANGLES that reaches the
// PBR pipeline -- scene 260's TRIANGLE_STRIP, which the loader expands into a
// triangle list -- so points, lines and line strips have no measured asset at
// all. (Halo_Believe.glb is POINTS, but its primitives are consumed by the
// Gaussian-splatting feature and never reach a PBR pipeline, which is why the
// pinned registry's own trigger excludes them.)
//
// Four primitives, one per mode, each with its own material so the draws are
// separable in a capture:
//
//   0 POINTS (mode 0)      a grid of points
//   1 LINES (mode 1)       disjoint segments
//   2 LINE_STRIP (mode 3)  one connected run, which is also the mode that
//                          needs WebGPU's `stripIndexFormat`
//   3 TRIANGLES (mode 4)   the reference quad beside them
//
// Every primitive carries COLOR_0 as normalized UNSIGNED_BYTE and NORMAL, so
// the gate also measures glTF vertex colours on a non-triangle topology and on
// a non-indexed primitive -- the two combinations the corpus's six
// vertex-coloured assets never reach, all of which are indexed triangles.
// NORMAL is required rather than optional: a point or a line gives the pinned
// flat-normal path no fragment quad to differentiate over, and the loader
// refuses one that omits it.
//
// Run: node tools/fixtures/build-gltf-topology.mjs
import {
    createBinaryChunk,
    f32,
    u8,
    u16,
    vec3Accessor,
    writeFixture,
} from "./glb.mjs";

const chunk = createBinaryChunk();
const positionAccessor = (points) => vec3Accessor(chunk, points);
function normalAccessor(count) {
    return chunk.accessor({
        bufferView: chunk.view(f32(new Array(count).fill([0, 0, 1]).flat())),
        componentType: 5126,
        count,
        type: "VEC3",
    });
}
// A saturated hue wheel, so a point or a segment that lands in the wrong place
// is visible as a colour rather than only as a gap.
function colorAccessor(count) {
    const bytes = [];
    for (let index = 0; index < count; index++) {
        const turn = (index / count) * 6;
        const stage = Math.floor(turn) % 6;
        const ramp = Math.round((turn - Math.floor(turn)) * 255);
        const wheel = [
            [255, ramp, 0],
            [255 - ramp, 255, 0],
            [0, 255, ramp],
            [0, 255 - ramp, 255],
            [ramp, 0, 255],
            [255, 0, 255 - ramp],
        ][stage];
        bytes.push(wheel[0], wheel[1], wheel[2], 255);
    }
    return chunk.accessor({
        bufferView: chunk.view(u8(bytes)),
        componentType: 5121,
        normalized: true,
        count,
        type: "VEC4",
    });
}
function indexAccessor(indices) {
    return chunk.accessor({
        bufferView: chunk.view(u16(indices)),
        componentType: 5123,
        count: indices.length,
        type: "SCALAR",
    });
}

// POINTS: an 8x8 grid, drawn non-indexed so the fixture also measures the
// loader's sequential-index synthesis on a non-triangle mode.
const gridPoints = [];
for (let row = 0; row < 8; row++) {
    for (let column = 0; column < 8; column++) {
        gridPoints.push([-0.45 + column * 0.128, -0.45 + row * 0.128, 0]);
    }
}
const pointsPrimitive = {
    mode: 0,
    attributes: {
        POSITION: positionAccessor(gridPoints),
        NORMAL: normalAccessor(gridPoints.length),
        COLOR_0: colorAccessor(gridPoints.length),
    },
    material: 0,
};

// LINES: twelve disjoint radial spokes, indexed in pairs.
const spokePoints = [];
const spokeIndices = [];
for (let spoke = 0; spoke < 12; spoke++) {
    const angle = (spoke / 12) * Math.PI * 2;
    spokePoints.push([Math.cos(angle) * 0.12, Math.sin(angle) * 0.12, 0]);
    spokePoints.push([Math.cos(angle) * 0.5, Math.sin(angle) * 0.5, 0]);
    spokeIndices.push(spoke * 2, spoke * 2 + 1);
}
const linesPrimitive = {
    mode: 1,
    attributes: {
        POSITION: positionAccessor(spokePoints),
        NORMAL: normalAccessor(spokePoints.length),
        COLOR_0: colorAccessor(spokePoints.length),
    },
    indices: indexAccessor(spokeIndices),
    material: 1,
};

// LINE_STRIP: one connected zig-zag, indexed so WebGPU needs the strip index
// format the pipeline now declares.
const stripPoints = [];
const stripIndices = [];
for (let step = 0; step < 17; step++) {
    stripPoints.push([
        -0.5 + step * 0.0625,
        step % 2 === 0 ? -0.45 : 0.45,
        0,
    ]);
    stripIndices.push(step);
}
const lineStripPrimitive = {
    mode: 3,
    attributes: {
        POSITION: positionAccessor(stripPoints),
        NORMAL: normalAccessor(stripPoints.length),
        COLOR_0: colorAccessor(stripPoints.length),
    },
    indices: indexAccessor(stripIndices),
    material: 2,
};

// TRIANGLES: the reference quad, so the gate shows the three new topologies
// beside the one that already worked.
const quadPoints = [
    [-0.5, -0.5, 0],
    [0.5, -0.5, 0],
    [0.5, 0.5, 0],
    [-0.5, 0.5, 0],
];
const trianglesPrimitive = {
    mode: 4,
    attributes: {
        POSITION: positionAccessor(quadPoints),
        NORMAL: normalAccessor(quadPoints.length),
        COLOR_0: colorAccessor(quadPoints.length),
    },
    indices: indexAccessor([0, 1, 2, 0, 2, 3]),
    material: 3,
};

const primitives = [
    pointsPrimitive,
    linesPrimitive,
    lineStripPrimitive,
    trianglesPrimitive,
];
const names = ["Points", "Lines", "LineStrip", "Triangles"];
const materials = names.map((name) => ({
    name: `${name}Material`,
    doubleSided: true,
    pbrMetallicRoughness: {
        baseColorFactor: [1, 1, 1, 1],
        metallicFactor: 0,
        roughnessFactor: 0.6,
    },
}));
const SPACING = 1.2;
const nodes = names.map((name, index) => ({
    name,
    mesh: index,
    translation: [(index - (names.length - 1) / 2) * SPACING, 0, 0],
}));
const meshes = names.map((name, index) => ({
    name,
    primitives: [primitives[index]],
}));

writeFixture(
    "examples/assets/regression/gltf-topology.gltf",
    {
        asset: {
            version: "2.0",
            generator: "bblitec tools/fixtures/build-gltf-topology.mjs",
        },
        scene: 0,
        scenes: [{ nodes: nodes.map((_node, index) => index) }],
        nodes,
        meshes,
        materials,
        accessors: chunk.accessors,
        bufferViews: chunk.bufferViews,
    },
    chunk,
);
