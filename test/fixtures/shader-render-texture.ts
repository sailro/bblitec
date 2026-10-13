import {
    addTaskAtStart,
    addToScene,
    createArcRotateCamera,
    createEffectRenderTask,
    createEffectWrapper,
    createEngine,
    createPlane,
    createRenderTargetTexture,
    createSceneContext,
    createShaderMaterial,
    onBeforeRender,
    registerScene,
    setEffectUniforms,
    setShaderTexture,
    startEngine,
} from "@babylonjs/lite";

// A shader material samples a render target an effect fills, then switches to
// a second target after a few frames: each draw binds the live texture.
const FILL_WGSL = `@group(0) @binding(0) var<uniform> color:vec4<f32>;
@fragment fn effectFragment(input:EffectVertexOutput)->@location(0) vec4<f32>{return color;}`;
const vertexSource = `struct VertexOutput{@builtin(position) position:vec4<f32>,@location(0) uv:vec2<f32>,};
@vertex fn mainVertex(input:VertexInput)->VertexOutput{var out:VertexOutput;out.position=shaderSystem.worldViewProjection*vec4<f32>(input.position,1.0);out.uv=input.uv;return out;}`;
const fragmentSource = `struct VertexOutput{@builtin(position) position:vec4<f32>,@location(0) uv:vec2<f32>,};
@fragment fn mainFragment(input:VertexOutput)->@location(0) vec4<f32>{return textureSample(picture,pictureSampler,input.uv);}`;

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const engine = await createEngine(canvas);
const scene = createSceneContext(engine);
scene.clearColor = { r: 0.1, g: 0.1, b: 0.15, a: 1 };

const fillTarget = (name: string, color: readonly number[]) => {
    const target = createRenderTargetTexture(engine, {
        lbl: name,
        format: "rgba8unorm",
        samples: 1,
        size: { width: 64, height: 64 },
    });
    const effect = createEffectWrapper(engine, {
        name,
        fragmentWGSL: FILL_WGSL,
        bindings: [{ binding: 0, kind: "uniform", uniformByteLength: 16 }],
    });
    setEffectUniforms(effect, new Float32Array(color));
    addTaskAtStart(
        scene,
        createEffectRenderTask({ name, effect, target: target.rt, clear: true }, engine, scene),
    );
    return target;
};
const orange = fillTarget("shader-render-texture-orange", [1, 0.5, 0, 1]);
const blue = fillTarget("shader-render-texture-blue", [0, 0.25, 1, 1]);

const material = createShaderMaterial({
    name: "shader-render-texture",
    vertexSource,
    fragmentSource,
    attributes: ["position", "uv"],
    uniforms: ["worldViewProjection"],
    samplers: ["picture"],
    backFaceCulling: false,
});
setShaderTexture(material, "picture", orange.texture);
const plane = createPlane(engine, { width: 3, height: 3 });
plane.material = material;
addToScene(scene, plane);
scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 4, { x: 0, y: 0, z: 0 });

let frames = 0;
onBeforeRender(scene, () => {
    if (++frames === 4) setShaderTexture(material, "picture", blue.texture);
});
await registerScene(scene);
await startEngine(engine);
