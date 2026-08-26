// Builds examples/assets/regression/gltf-step-animation.gltf.
//
// A project-owned fixture for glTF STEP animation channels, which the corpus
// reaches only through a KHR_animation_pointer visibility track (scene 34's
// CubeVisibility) -- never on a transform or a morph-weight channel, the two
// the pinned `evaluateSampler` branches over.
//
// Four quads, one per channel the loader carries, each animated by its own
// STEP sampler with keys at 0, 0.5 and 1.0 seconds:
//
//   0 translation   three discrete positions
//   1 rotation      three discrete orientations
//   2 scale         three discrete sizes
//   3 weights       a morph target held at 0, 1 and 0
//
// The seek lands at 0.75s -- inside the second span -- so a LINEAR reading of
// any of them is a different image, which is the difference the gate sees.
// The scene beside it also sets a group's `speedRatio`, so the pose the seek
// resolves is the ratio's as well as the sampler's.
//
// Run: node tools/fixtures/build-gltf-step-animation.mjs
import {
    createBinaryChunk,
    f32,
    u16,
    vec3Accessor as sharedVec3Accessor,
    writeFixture,
} from "./glb.mjs";

const chunk = createBinaryChunk();
const vec3Accessor = (triples) => sharedVec3Accessor(chunk, triples);
function vec4Accessor(quads) {
    return chunk.accessor({
        bufferView: chunk.view(f32(quads.flat())),
        componentType: 5126,
        count: quads.length,
        type: "VEC4",
    });
}
function scalarAccessor(values) {
    return chunk.accessor({
        bufferView: chunk.view(f32(values)),
        componentType: 5126,
        count: values.length,
        type: "SCALAR",
    });
}

// One shared unit quad, plus a morph target that folds its top edge in.
const HALF = 0.4;
const quad = [
    [-HALF, -HALF, 0],
    [HALF, -HALF, 0],
    [HALF, HALF, 0],
    [-HALF, HALF, 0],
];
const POSITION = vec3Accessor(quad);
const NORMAL = vec3Accessor([
    [0, 0, 1],
    [0, 0, 1],
    [0, 0, 1],
    [0, 0, 1],
]);
const MORPH_POSITION = vec3Accessor([
    [0, 0, 0],
    [0, 0, 0],
    [-0.55, 0, 0],
    [0.55, 0, 0],
]);
const INDICES = chunk.accessor({
    bufferView: chunk.view(u16([0, 1, 2, 0, 2, 3])),
    componentType: 5123,
    count: 6,
    type: "SCALAR",
});

// Every sampler shares one key-time accessor; only the outputs differ.
const KEY_TIMES = scalarAccessor([0, 0.5, 1]);
const TRANSLATION_KEYS = vec3Accessor([
    [-1.8, -0.35, 0],
    [-1.8, 0.35, 0],
    [-1.8, 0, 0],
]);
const half = Math.SQRT1_2;
const ROTATION_KEYS = vec4Accessor([
    [0, 0, 0, 1],
    [0, 0, half, half],
    [0, 0, 1, 0],
]);
const SCALE_KEYS = vec3Accessor([
    [1, 1, 1],
    [0.45, 0.45, 1],
    [1.4, 1.4, 1],
]);
const WEIGHT_KEYS = scalarAccessor([0, 1, 0]);

const names = ["StepTranslation", "StepRotation", "StepScale", "StepWeights"];
const paths = ["translation", "rotation", "scale", "weights"];
const outputs = [
    TRANSLATION_KEYS,
    ROTATION_KEYS,
    SCALE_KEYS,
    WEIGHT_KEYS,
];
const SPACING = 1.2;
const materials = names.map((name, index) => ({
    name: `${name}Material`,
    doubleSided: true,
    pbrMetallicRoughness: {
        baseColorFactor: [
            0.25 + index * 0.2,
            0.85 - index * 0.18,
            0.35 + index * 0.15,
            1,
        ],
        metallicFactor: 0,
        roughnessFactor: 0.6,
    },
}));
const meshes = names.map((name, index) => ({
    name,
    primitives: [
        {
            attributes: { POSITION, NORMAL },
            indices: INDICES,
            material: index,
            ...(paths[index] === "weights"
                ? { targets: [{ POSITION: MORPH_POSITION }] }
                : {}),
        },
    ],
    ...(paths[index] === "weights" ? { weights: [0] } : {}),
}));
const nodes = names.map((name, index) => ({
    name,
    mesh: index,
    translation: [
        (index - (names.length - 1) / 2) * SPACING,
        0,
        0,
    ],
}));

writeFixture(
    "examples/assets/regression/gltf-step-animation.gltf",
    {
        asset: {
            version: "2.0",
            generator:
                "bblitec tools/fixtures/build-gltf-step-animation.mjs",
        },
        scene: 0,
        scenes: [{ nodes: nodes.map((_node, index) => index) }],
        nodes,
        meshes,
        materials,
        animations: [
            {
                name: "step",
                samplers: paths.map((_path, index) => ({
                    input: KEY_TIMES,
                    output: outputs[index],
                    interpolation: "STEP",
                })),
                channels: paths.map((path, index) => ({
                    sampler: index,
                    target: { node: index, path },
                })),
            },
        ],
        accessors: chunk.accessors,
        bufferViews: chunk.bufferViews,
    },
    chunk,
);
