// Project-owned differential gate: a VAT bake's texture bound by hand.
//
// Two prepared payloads with the same floats share one baked texture, as
// the pin's upload shares them, and the background says whether they do.
// A shader material reads that texture through a Texture2D the program
// builds from its GPU parts -- the texture, a view of it, a nearest sampler
// from the device and its size -- in both stages: the vertex stage scales
// the plane by one texel, the fragment stage draws every texel of the bake
// as one cell.

import {
    addToScene,
    createArcRotateCamera,
    createEngine,
    createPlane,
    createSceneContext,
    createShaderMaterial,
    createVatBakeResults,
    registerScene,
    setShaderTexture,
    startEngine,
} from "@babylonjs/lite";
import type {
    EngineContext,
    PreparedVatBakeResult,
    ShaderSamplerOption,
    Texture2D,
} from "@babylonjs/lite";

const BONES = 4;
const FRAMES = 8;
const WIDTH = BONES * 4;

/** A bake whose texel (x, y) is (x / 15, y / 7, a three-step stripe, 1). */
function payload(): PreparedVatBakeResult {
    const data = new Float32Array(WIDTH * FRAMES * 4);
    for (let texel = 0; texel < WIDTH * FRAMES; texel++) {
        const x = texel % WIDTH;
        const y = Math.floor(texel / WIDTH);
        data[texel * 4] = x / (WIDTH - 1);
        data[texel * 4 + 1] = y / (FRAMES - 1);
        data[texel * 4 + 2] = ((x + y) % 3) / 2;
        data[texel * 4 + 3] = 1;
    }
    return {
        boneCount: BONES,
        frameCount: FRAMES,
        data,
        clips: { idle: { fromRow: 0, frameCount: FRAMES, fps: 30 } },
    };
}

/** The bake's texture as a Texture2D: nearest and unfiltered, read by textureLoad. */
function boneTexture(engine: EngineContext, texture: GPUTexture): Texture2D {
    const device = (engine as unknown as { _device: GPUDevice })._device;
    const sampler = device.createSampler({
        magFilter: "nearest",
        minFilter: "nearest",
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
    });
    return {
        texture,
        view: texture.createView(),
        sampler,
        width: texture.width,
        height: texture.height,
    } as unknown as Texture2D;
}

const BONE_SAMPLER = {
    name: "vatBoneTex",
    sampleType: "unfilterable-float",
    viewDimension: "2d",
} as unknown as ShaderSamplerOption;
const vertexSource = `struct VertexOutput{@builtin(position) position:vec4<f32>,@location(0) uv:vec2<f32>,};
@vertex fn mainVertex(input:VertexInput)->VertexOutput{
    var out:VertexOutput;
    let scale = textureLoad(vatBoneTex, vec2<i32>(${WIDTH - 1}, ${FRAMES - 1}), 0).y;
    out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position * scale, 1.0);
    out.uv = input.uv;
    return out;
}`;
const fragmentSource = `struct VertexOutput{@builtin(position) position:vec4<f32>,@location(0) uv:vec2<f32>,};
@fragment fn mainFragment(input:VertexOutput)->@location(0) vec4<f32>{
    let size = vec2<i32>(textureDimensions(vatBoneTex));
    let texel = min(vec2<i32>(input.uv * vec2<f32>(size)), size - vec2<i32>(1, 1));
    return textureLoad(vatBoneTex, texel, 0);
}`;

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const engine = await createEngine(canvas);
const scene = createSceneContext(engine);
const [first, second] = createVatBakeResults(engine, [payload(), payload()]);
if (!first || !second) throw new Error("The upload returned no bakes.");
const shared = first.texture === second.texture ? 1 : 0;
scene.clearColor = { r: 0.4 - 0.3 * shared, g: 0.05 + 0.1 * shared, b: 0.05 + 0.05 * shared, a: 1 };

const material = createShaderMaterial({
    name: "vat-bone-texture",
    vertexSource,
    fragmentSource,
    attributes: ["position", "uv"],
    uniforms: ["worldViewProjection"],
    samplers: [BONE_SAMPLER],
    backFaceCulling: false,
});
setShaderTexture(material, "vatBoneTex", boneTexture(engine, second.texture));
const plane = createPlane(engine, { width: 3, height: 1.5 });
plane.material = material;
addToScene(scene, plane);
scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 4, { x: 0, y: 0, z: 0 });
await registerScene(scene);
await startEngine(engine);
