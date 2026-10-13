import {
    addTaskAtStart,
    addToScene,
    createArcRotateCamera,
    createEffectRenderTask,
    createEffectWrapper,
    createEngine,
    createRenderTargetTexture,
    createSceneContext,
    createSphere,
    createStandardMaterial,
    registerScene,
    setEffectTexture,
    setEffectUniforms,
    startEngine,
} from "@babylonjs/lite";

// One effect fills a render target; a second samples it through unnamed
// bindings set by number and by numeric string, into the target a sphere shows.
const FILL_WGSL = `@group(0) @binding(0) var<uniform> color:vec4<f32>;
@fragment fn effectFragment(input:EffectVertexOutput)->@location(0) vec4<f32>{return color;}`;
const SAMPLE_WGSL = `@group(0) @binding(0) var source:sampler;
@group(0) @binding(1) var picture:texture_2d<f32>;
@group(0) @binding(2) var tint:texture_2d<f32>;
@fragment fn effectFragment(input:EffectVertexOutput)->@location(0) vec4<f32>{let uv=clamp(input.uv,vec2<f32>(0.0),vec2<f32>(1.0));return vec4<f32>(textureSample(picture,source,uv).rgb*textureSample(tint,source,uv).rgb,1.0);}`;

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const engine = await createEngine(canvas);
const scene = createSceneContext(engine);
scene.clearColor = { r: 0.1, g: 0.1, b: 0.15, a: 1 };

const filled = createRenderTargetTexture(engine, {
    lbl: "effect-render-texture-filled",
    format: "rgba8unorm",
    samples: 1,
    size: { width: 128, height: 128 },
});
const sampled = createRenderTargetTexture(engine, {
    lbl: "effect-render-texture-sampled",
    format: "rgba8unorm",
    samples: 1,
    size: { width: 128, height: 128 },
});

const fill = createEffectWrapper(engine, {
    name: "effect-render-texture-fill",
    fragmentWGSL: FILL_WGSL,
    bindings: [{ binding: 0, kind: "uniform", uniformByteLength: 16 }],
});
setEffectUniforms(fill, new Float32Array([1, 0.5, 0, 1]));
const sample = createEffectWrapper(engine, {
    name: "effect-render-texture-sample",
    fragmentWGSL: SAMPLE_WGSL,
    bindings: [
        { binding: 0, kind: "sampler", textureBinding: 1 },
        { binding: 1, kind: "texture" },
        { binding: 2, kind: "texture" },
    ],
});
setEffectTexture(sample, 1, filled.texture);
setEffectTexture(sample, "2", filled.texture);

addTaskAtStart(
    scene,
    createEffectRenderTask({ name: "sample", effect: sample, target: sampled.rt, clear: true }, engine, scene),
);
addTaskAtStart(
    scene,
    createEffectRenderTask({ name: "fill", effect: fill, target: filled.rt, clear: true }, engine, scene),
);

const sphere = createSphere(engine, { diameter: 2, segments: 32 });
const material = createStandardMaterial();
material.disableLighting = true;
material.diffuseTexture = sampled.texture;
material.emissiveColor = [1, 1, 1];
sphere.material = material;
addToScene(scene, sphere);
scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 5.19616, { x: 0, y: 0, z: 0 });

await registerScene(scene);
await startEngine(engine);
