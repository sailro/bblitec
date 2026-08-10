import {
    addTask,
    addToScene,
    createArcRotateCamera,
    createCopyToTextureTask,
    createEngine,
    createPlane,
    createRenderTarget,
    createRenderTask,
    createSceneContext,
    createShaderMaterial,
    registerScene,
    setShaderFloat,
    setShaderUniform,
    setShaderVector3,
    startEngine,
} from "@babylonjs/lite";

const CARD_VERTEX = `struct VertexOutput{@builtin(position) position:vec4<f32>,};
@vertex fn mainVertex(input:VertexInput)->VertexOutput{let c=cos(shaderUniforms.angle);let s=sin(shaderUniforms.angle);let local=input.position.xy*1.65;let rotated=vec2<f32>(local.x*c-local.y*s,local.x*s+local.y*c);let world=shaderUniforms.center+rotated;var out:VertexOutput;out.position=vec4<f32>(world.x/3.3,world.y/2.2,shaderUniforms.depth,1.0);return out;}`;
const CARD_FRAGMENT = `@fragment fn mainFragment()->@location(0) vec4<f32>{return vec4<f32>(shaderUniforms.color,shaderUniforms.opacity);}`;
const CARD_UNIFORMS = [
    { name: "center", type: "vec2<f32>" },
    { name: "angle", type: "f32" },
    { name: "depth", type: "f32" },
    { name: "color", type: "vec3<f32>" },
    { name: "opacity", type: "f32" },
];

const CUTOUT_VERTEX = `struct VertexOutput{@builtin(position) position:vec4<f32>,@location(0) uv:vec2<f32>,};
@vertex fn mainVertex(input:VertexInput)->VertexOutput{var out:VertexOutput;out.position=shaderSystem.worldViewProjection*vec4<f32>(input.position,1.0);out.uv=input.uv;return out;}`;
const CUTOUT_FRAGMENT = `struct VertexOutput{@builtin(position) position:vec4<f32>,@location(0) uv:vec2<f32>,};
@fragment fn mainFragment(input:VertexOutput)->@location(0) vec4<f32>{if(distance(input.uv,vec2<f32>(0.5,0.5))<0.18){discard;}return vec4<f32>(1.0,0.25,0.05,0.55);}`;

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine, { defaultRenderTask: false });

    const camera = createArcRotateCamera(
        -Math.PI / 2,
        Math.PI / 2,
        4,
        { x: 0, y: 0, z: 0 },
    );
    scene.camera = camera;

    const cardMaterial = createShaderMaterial({
        name: "audit-card",
        vertexSource: CARD_VERTEX,
        fragmentSource: CARD_FRAGMENT,
        attributes: ["position"],
        uniforms: CARD_UNIFORMS,
        backFaceCulling: false,
        depthWrite: true,
    });
    setShaderUniform(cardMaterial, "center", [-1.4, 0]);
    setShaderFloat(cardMaterial, "angle", 0);
    setShaderFloat(cardMaterial, "depth", 0.6);
    setShaderVector3(cardMaterial, "color", [1.0, 0.25, 0.1]);
    setShaderFloat(cardMaterial, "opacity", 1);
    const card = createPlane(engine);
    card.material = cardMaterial;
    addToScene(scene, card);

    const cutoutMaterial = createShaderMaterial({
        name: "audit-cutout",
        vertexSource: CUTOUT_VERTEX,
        fragmentSource: CUTOUT_FRAGMENT,
        attributes: ["position", "uv"],
        uniforms: ["worldViewProjection"],
        needAlphaBlending: true,
        needAlphaTesting: true,
        backFaceCulling: false,
    });
    const cutout = createPlane(engine, { width: 1.5, height: 1.5 });
    cutout.position.set(1.0, 0, 0);
    cutout.material = cutoutMaterial;
    addToScene(scene, cutout);

    const target = createRenderTarget({
        lbl: "audit-shader-frame-graph-target",
        format: engine.format,
        samples: 1,
        size: engine,
    });
    addTask(
        scene,
        createRenderTask(
            {
                name: "audit-shader-frame-graph",
                rt: target,
                clrColor: { r: 0.035, g: 0.045, b: 0.07, a: 1 },
                clr: true,
            },
            engine,
            scene,
        ),
    );
    addTask(
        scene,
        createCopyToTextureTask(
            {
                name: "audit-shader-frame-graph-present",
                sourceTexture: target,
                targetTexture: engine.scRT,
            },
            engine,
            scene,
        ),
    );

    await registerScene(scene);
    await startEngine(engine);
}

main().catch(console.error);
