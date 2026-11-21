import {
    addTask,
    addToScene,
    createArcRotateCamera,
    createCsmDirectionalShadowGenerator,
    createDirectionalLight,
    createEffectRenderTask,
    createEffectWrapper,
    createEngine,
    createGround,
    createRenderTargetTexture,
    createSceneContext,
    createSphere,
    createStandardMaterial,
    getCsmReceiverTexture,
    registerSceneWithShadowSupport,
    setEffectTexture,
    setEffectUniforms,
    setShadowTaskCasterMeshes,
    startEngine,
} from "@babylonjs/lite";

// A fullscreen effect reads a cascaded shadow map the way a custom receiver
// does: the generator's depth array through `getCsmReceiverTexture`, compared
// through the comparison sampler that texture carries. Each half of the
// target shows one cascade's comparison against the reference depth the
// uniform holds; a plane shows the target.
const SHADOW_WGSL = `@group(0) @binding(0) var shadowSampler:sampler_comparison;
@group(0) @binding(1) var shadowMap:texture_depth_2d_array;
@group(0) @binding(2) var<uniform> reference:vec4<f32>;
@fragment fn effectFragment(input:EffectVertexOutput)->@location(0) vec4<f32>{
    let uv=clamp(input.uv,vec2<f32>(0.0),vec2<f32>(1.0));
    let cascade=select(0,1,uv.x>0.5);
    let lit=textureSampleCompare(shadowMap,shadowSampler,uv,cascade,reference.x);
    return vec4<f32>(vec3<f32>(lit),1.0);
}`;

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const engine = await createEngine(canvas);
const scene = createSceneContext(engine);
scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 3, 30, { x: 0, y: 0, z: 0 });
const light = createDirectionalLight([0, -1, -1], 0.8);
addToScene(scene, light);
const ground = createGround(engine, { width: 20, height: 20 });
ground.material = createStandardMaterial();
ground.receiveShadows = true;
addToScene(scene, ground);
const caster = createSphere(engine, { diameter: 4, segments: 16 });
caster.position.y = 3;
addToScene(scene, caster);
const generator = createCsmDirectionalShadowGenerator(engine, light, {
    mapSize: 256,
    numCascades: 2,
});
light.shadowGenerator = generator;
setShadowTaskCasterMeshes(generator, [caster]);

const mask = createRenderTargetTexture(engine, {
    lbl: "effect-csm-receiver-mask",
    format: "rgba8unorm",
    samples: 1,
    size: { width: 128, height: 64 },
});
const effect = createEffectWrapper(engine, {
    name: "effect-csm-receiver",
    fragmentWGSL: SHADOW_WGSL,
    bindings: [
        { binding: 0, kind: "sampler", samplerType: "comparison", textureBinding: 1 },
        { binding: 1, kind: "texture", textureSampleType: "depth", viewDimension: "2d-array" },
        { binding: 2, kind: "uniform", uniformByteLength: 16 },
    ],
});
setEffectTexture(effect, 1, getCsmReceiverTexture(generator));
setEffectUniforms(effect, new Float32Array([0.5, 0, 0, 0]));
addTask(
    scene,
    createEffectRenderTask({ name: "mask", effect, target: mask.rt, clear: true }, engine, scene),
);

const screen = createGround(engine, { width: 4, height: 2 });
screen.position.y = 6;
const screenMaterial = createStandardMaterial();
screenMaterial.disableLighting = true;
screenMaterial.diffuseTexture = mask.texture;
screenMaterial.emissiveColor = [1, 1, 1];
screen.material = screenMaterial;
addToScene(scene, screen);

await registerSceneWithShadowSupport(scene);
await startEngine(engine);
