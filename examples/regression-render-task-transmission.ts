// Regression gate: per-task scene-colour transmission in its raw mode.
//
// An explicit render task draws three opaque spheres with
// `enableRenderTaskTransmission` (`linear: false`, no mips, `grabDepth`),
// then a copy task presents it. A transmissive ShaderMaterial quad in front
// refracts the grab's colour and shades by its depth snapshot, re-binding
// both whenever their identity changes, as an application's water surface
// does. No material is a PBR transmission one: that would also enable the
// pin's linear scene transmission on every task.

import {
    addTask,
    addToScene,
    attachControl,
    createArcRotateCamera,
    createCopyToTextureTask,
    createEngine,
    createHemisphericLight,
    createPlane,
    createRenderTarget,
    createRenderTask,
    createSceneContext,
    createShaderMaterial,
    createSphere,
    createStandardMaterial,
    createTexture2DFromPixels,
    enableRenderTaskTransmission,
    onBeforeRender,
    registerScene,
    setShaderTexture,
    setShaderUniform,
    startEngine,
    type Texture2D,
} from "babylon-lite";

const vertexSource = `struct VertexOutput{@builtin(position) position:vec4<f32>,};
@vertex fn mainVertex(input:VertexInput)->VertexOutput{var out:VertexOutput;out.position=shaderSystem.worldViewProjection*vec4<f32>(input.position,1.0);return out;}`;
const fragmentSource = `struct VertexOutput{@builtin(position) position:vec4<f32>,};
@fragment fn mainFragment(input:VertexOutput)->@location(0) vec4<f32>{
let uv=input.position.xy/shaderUniforms.uResolution;
let bend=vec2<f32>(sin(uv.y*48.0),cos(uv.x*48.0))*0.012;
let scene=textureSample(uScene,uSceneSampler,clamp(uv+bend,vec2<f32>(0.0),vec2<f32>(1.0))).rgb;
let size=vec2<f32>(textureDimensions(uDepth));
let depth=textureLoad(uDepth,vec2<i32>(clamp(uv*size,vec2<f32>(0.0),size-vec2<f32>(1.0))),0).r;
return vec4<f32>(mix(scene,vec3<f32>(0.2,0.5,1.0),0.25)*(0.7+0.3*depth),1.0);}`;

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine, { defaultRenderTask: false });
    const target = createRenderTarget({
        lbl: "regression-render-task-transmission",
        format: engine.format,
        dFormat: "depth24plus-stencil8",
        samples: 1,
        size: engine,
    });
    const task = createRenderTask({ name: "scene", rt: target, clr: true, clrColor: { r: 0.2, g: 0.2, b: 0.3, a: 1 } }, engine, scene);
    addTask(scene, task);
    addTask(scene, createCopyToTextureTask({ name: "present", sourceTexture: target, targetTexture: engine.scRT }, engine, scene));
    const grab = enableRenderTaskTransmission(task, engine, {
        linear: false,
        generateMipmaps: false,
        grabDepth: true,
    });

    const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2.4, 5, { x: 0, y: 0, z: 0 });
    scene.camera = camera;
    attachControl(camera, canvas, scene);
    addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));

    const addSphere = (x: number, z: number, r: number, g: number, b: number): void => {
        const sphere = createSphere(engine, { diameter: 1.2 });
        sphere.position.x = x;
        sphere.position.z = z;
        const material = createStandardMaterial();
        material.diffuseColor = [r, g, b];
        sphere.material = material;
        addToScene(scene, sphere);
    };
    addSphere(-1.4, 0, 0.9, 0.2, 0.2);
    addSphere(0, 0.8, 0.2, 0.9, 0.3);
    addSphere(1.4, 1.6, 0.2, 0.4, 0.9);

    const placeholder = createTexture2DFromPixels(engine, new Uint8Array([0, 0, 0, 255]), 1, 1);
    const surface = createShaderMaterial({
        name: "regression-render-task-transmission",
        vertexSource,
        fragmentSource,
        attributes: ["position"],
        uniforms: ["worldViewProjection", { name: "uResolution", type: "vec2<f32>", defaultValue: [1, 1] }],
        samplers: ["uScene", { name: "uDepth", sampleType: "unfilterable-float" }],
        needAlphaBlending: true,
        transmissive: true,
        backFaceCulling: false,
    });
    setShaderTexture(surface, "uScene", placeholder);
    setShaderTexture(surface, "uDepth", placeholder);
    const quad = createPlane(engine, { width: 2.4, height: 1.2 });
    quad.position.z = -1.2;
    quad.material = surface;
    addToScene(scene, quad);

    let boundScene: Texture2D | null = null;
    let boundDepth: Texture2D | null = null;
    onBeforeRender(scene, () => {
        setShaderUniform(surface, "uResolution", [canvas.width, canvas.height]);
        if (grab.texture !== boundScene) {
            boundScene = grab.texture;
            setShaderTexture(surface, "uScene", boundScene ?? placeholder);
        }
        if (grab.depthTexture !== boundDepth) {
            boundDepth = grab.depthTexture;
            setShaderTexture(surface, "uDepth", boundDepth ?? placeholder);
        }
    });

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
