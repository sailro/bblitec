import {
    addToScene,
    createArcRotateCamera,
    createEngine,
    createPlane,
    createSceneContext,
    createShaderMaterial,
    registerScene,
    setAlphaToCoverage,
    setShaderFloat,
    setShaderUniform,
    setShaderVector3,
    startEngine,
} from "@babylonjs/lite";

const VERTEX_SOURCE = `struct VertexOutput{@builtin(position) position:vec4<f32>,};
@vertex fn mainVertex(input:VertexInput)->VertexOutput{let c=cos(shaderUniforms.angle);let s=sin(shaderUniforms.angle);let local=input.position.xy*1.65;let rotated=vec2<f32>(local.x*c-local.y*s,local.x*s+local.y*c);let world=shaderUniforms.center+rotated;var out:VertexOutput;out.position=vec4<f32>(world.x/3.3,world.y/2.2,shaderUniforms.depth,1.0);return out;}`;
const FRAGMENT_SOURCE = `@fragment fn mainFragment()->@location(0) vec4<f32>{return vec4<f32>(shaderUniforms.color,shaderUniforms.opacity);}`;
const UNIFORMS = [
    { name: "center", type: "vec2<f32>" },
    { name: "angle", type: "f32" },
    { name: "depth", type: "f32" },
    { name: "color", type: "vec3<f32>" },
    { name: "opacity", type: "f32" },
];

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas, { msaaSamples: 4 });
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.035, g: 0.045, b: 0.07, a: 1 };

    const leftTopRed = createShaderMaterial({
        name: "a2c-card",
        vertexSource: VERTEX_SOURCE,
        fragmentSource: FRAGMENT_SOURCE,
        attributes: ["position"],
        uniforms: UNIFORMS,
        backFaceCulling: false,
        depthWrite: true,
    });
    setShaderUniform(leftTopRed, "center", [-1.73, 1.01]);
    setShaderFloat(leftTopRed, "angle", -0.08);
    setShaderFloat(leftTopRed, "depth", 0.6);
    setShaderVector3(leftTopRed, "color", [242 / 255, 31 / 255, 41 / 255]);
    setShaderFloat(leftTopRed, "opacity", 0.5);
    const leftTopRedCard = createPlane(engine);
    leftTopRedCard.material = leftTopRed;
    addToScene(scene, leftTopRedCard);

    const leftTopGreen = createShaderMaterial({
        name: "a2c-card", vertexSource: VERTEX_SOURCE, fragmentSource: FRAGMENT_SOURCE,
        attributes: ["position"], uniforms: UNIFORMS, backFaceCulling: false, depthWrite: true,
    });
    setShaderUniform(leftTopGreen, "center", [-1.57, 1.09]);
    setShaderFloat(leftTopGreen, "angle", 0.1);
    setShaderFloat(leftTopGreen, "depth", 0.4);
    setShaderVector3(leftTopGreen, "color", [26 / 255, 217 / 255, 83 / 255]);
    setShaderFloat(leftTopGreen, "opacity", 1);
    const leftTopGreenCard = createPlane(engine);
    leftTopGreenCard.material = leftTopGreen;
    addToScene(scene, leftTopGreenCard);

    const leftBottomRed = createShaderMaterial({
        name: "a2c-card", vertexSource: VERTEX_SOURCE, fragmentSource: FRAGMENT_SOURCE,
        attributes: ["position"], uniforms: UNIFORMS, backFaceCulling: false, depthWrite: true,
    });
    setShaderUniform(leftBottomRed, "center", [-1.73, -1.09]);
    setShaderFloat(leftBottomRed, "angle", 0.1);
    setShaderFloat(leftBottomRed, "depth", 0.4);
    setShaderVector3(leftBottomRed, "color", [242 / 255, 31 / 255, 41 / 255]);
    setShaderFloat(leftBottomRed, "opacity", 1);
    const leftBottomRedCard = createPlane(engine);
    leftBottomRedCard.material = leftBottomRed;
    addToScene(scene, leftBottomRedCard);

    const leftBottomGreen = createShaderMaterial({
        name: "a2c-card", vertexSource: VERTEX_SOURCE, fragmentSource: FRAGMENT_SOURCE,
        attributes: ["position"], uniforms: UNIFORMS, backFaceCulling: false, depthWrite: true,
    });
    setShaderUniform(leftBottomGreen, "center", [-1.57, -1.01]);
    setShaderFloat(leftBottomGreen, "angle", -0.07);
    setShaderFloat(leftBottomGreen, "depth", 0.6);
    setShaderVector3(leftBottomGreen, "color", [26 / 255, 217 / 255, 83 / 255]);
    setShaderFloat(leftBottomGreen, "opacity", 0.5);
    const leftBottomGreenCard = createPlane(engine);
    leftBottomGreenCard.material = leftBottomGreen;
    addToScene(scene, leftBottomGreenCard);

    const rightTopRed = createShaderMaterial({
        name: "a2c-card", vertexSource: VERTEX_SOURCE, fragmentSource: FRAGMENT_SOURCE,
        attributes: ["position"], uniforms: UNIFORMS, backFaceCulling: false, depthWrite: true,
    });
    setShaderUniform(rightTopRed, "center", [1.57, 1.01]);
    setShaderFloat(rightTopRed, "angle", -0.08);
    setShaderFloat(rightTopRed, "depth", 0.6);
    setShaderVector3(rightTopRed, "color", [242 / 255, 31 / 255, 41 / 255]);
    setShaderFloat(rightTopRed, "opacity", 0.5);
    setAlphaToCoverage(rightTopRed, true);
    const rightTopRedCard = createPlane(engine);
    rightTopRedCard.material = rightTopRed;
    addToScene(scene, rightTopRedCard);

    const rightTopGreen = createShaderMaterial({
        name: "a2c-card", vertexSource: VERTEX_SOURCE, fragmentSource: FRAGMENT_SOURCE,
        attributes: ["position"], uniforms: UNIFORMS, backFaceCulling: false, depthWrite: true,
    });
    setShaderUniform(rightTopGreen, "center", [1.73, 1.09]);
    setShaderFloat(rightTopGreen, "angle", 0.1);
    setShaderFloat(rightTopGreen, "depth", 0.4);
    setShaderVector3(rightTopGreen, "color", [26 / 255, 217 / 255, 83 / 255]);
    setShaderFloat(rightTopGreen, "opacity", 1);
    setAlphaToCoverage(rightTopGreen, true);
    const rightTopGreenCard = createPlane(engine);
    rightTopGreenCard.material = rightTopGreen;
    addToScene(scene, rightTopGreenCard);

    const rightBottomRed = createShaderMaterial({
        name: "a2c-card", vertexSource: VERTEX_SOURCE, fragmentSource: FRAGMENT_SOURCE,
        attributes: ["position"], uniforms: UNIFORMS, backFaceCulling: false, depthWrite: true,
    });
    setShaderUniform(rightBottomRed, "center", [1.57, -1.09]);
    setShaderFloat(rightBottomRed, "angle", 0.1);
    setShaderFloat(rightBottomRed, "depth", 0.4);
    setShaderVector3(rightBottomRed, "color", [242 / 255, 31 / 255, 41 / 255]);
    setShaderFloat(rightBottomRed, "opacity", 1);
    setAlphaToCoverage(rightBottomRed, true);
    const rightBottomRedCard = createPlane(engine);
    rightBottomRedCard.material = rightBottomRed;
    addToScene(scene, rightBottomRedCard);

    const rightBottomGreen = createShaderMaterial({
        name: "a2c-card", vertexSource: VERTEX_SOURCE, fragmentSource: FRAGMENT_SOURCE,
        attributes: ["position"], uniforms: UNIFORMS, backFaceCulling: false, depthWrite: true,
    });
    setShaderUniform(rightBottomGreen, "center", [1.73, -1.01]);
    setShaderFloat(rightBottomGreen, "angle", -0.07);
    setShaderFloat(rightBottomGreen, "depth", 0.6);
    setShaderVector3(rightBottomGreen, "color", [26 / 255, 217 / 255, 83 / 255]);
    setShaderFloat(rightBottomGreen, "opacity", 0.5);
    setAlphaToCoverage(rightBottomGreen, true);
    const rightBottomGreenCard = createPlane(engine);
    rightBottomGreenCard.material = rightBottomGreen;
    addToScene(scene, rightBottomGreenCard);

    scene.camera = createArcRotateCamera(0, Math.PI / 2, 1, { x: 0, y: 0, z: 0 });
    await registerScene(scene);
    await startEngine(engine);
}

main().catch(console.error);
