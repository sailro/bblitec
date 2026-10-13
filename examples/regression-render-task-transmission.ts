// Regression gate: per-task scene-colour transmission in its raw mode.
//
// Scene 30's volume/transmission glb, with `enableRenderTaskTransmission` on
// the scene task (`linear: false`, no mips, `grabDepth`) instead of the
// structural `_config.transmission` write. A transmissive ShaderMaterial quad
// in front of the model refracts the grab's colour and shades by its depth
// snapshot, re-binding both whenever their identity changes, as an
// application's water surface does.

import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createEngine,
    createPlane,
    createSceneContext,
    createShaderMaterial,
    createSolidTexture2D,
    enableRenderTaskTransmission,
    getFrameGraph,
    loadEnvironment,
    loadGltf,
    onBeforeRender,
    registerScene,
    setShaderTexture,
    setShaderUniform,
    startEngine,
    type RenderTask,
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
    const scene = createSceneContext(engine);
    const grab = enableRenderTaskTransmission(getFrameGraph(scene)._tasks[0] as RenderTask, engine, {
        linear: false,
        generateMipmaps: false,
        grabDepth: true,
    });

    // Exact camera values captured from the playground scene.
    const cam = createArcRotateCamera(Math.PI / 2, Math.PI / 2, 1.1856086997830126, { x: -0.2914360649171073, y: 0.4, z: 0.3975263311541397 });
    cam.fov = 0.8;
    cam.nearPlane = 0.0697417;
    cam.farPlane = 6974.17;
    scene.camera = cam;
    attachControl(cam, canvas, scene);

    const placeholder = createSolidTexture2D(engine, 0, 0, 0, 1);
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
    const quad = createPlane(engine, { width: 0.35, height: 0.35 });
    quad.position.x = -0.2914360649171073;
    quad.position.y = 0.4;
    quad.position.z = 0.1;
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

    await Promise.all([
        loadGltf(engine, "https://assets.babylonjs.com/meshes/KHR_materials_volume_testing.glb").then((asset) => addToScene(scene, asset)),
        loadEnvironment(scene, "https://assets.babylonjs.com/core/environments/environmentSpecular.env", {
            skipSkybox: true,
            skipGround: true,
            brdfUrl: "/brdf-lut.png",
        }),
    ]);

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
