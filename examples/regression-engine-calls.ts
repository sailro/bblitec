// Project-owned differential gate: engine calls and source shapes a scene
// computes, and the native paths they reach.
//
//   * `invalidateRenderBundles` after a material write and from a frame
//     callback: the pinned body moves the visibility epoch and every
//     registered scene's renderable version.
//   * ArcRotate `panningSensibility` and `angularSensibility` written from
//     run-time values the attached controls read.
//   * A shader stage composed from a module constant generation runs: a
//     lane-table sum and a builder taking a callback.
//   * A glTF loaded from a packaged fetch carrying a cache mode.

import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createBox,
    createEngine,
    createHemisphericLight,
    createSceneContext,
    createShaderMaterial,
    createSphere,
    createStandardMaterial,
    invalidateRenderBundles,
    loadGltf,
    onBeforeRender,
    registerScene,
    startEngine,
    wgsl,
} from "babylon-lite";

const LANES = { tint: 2 } as const;

function laneWgsl(name: string, read: (lane: string) => string, base: number): string {
    return `fn ${name}() -> f32 { return ${read("lane")} * ${base}.0; }`;
}

// `LANES.tint + 1` lowers to a run-time sum, so this constant is run-time
// data at generation; the shader source reads its text by running it.
const TINT_WGSL = `
fn tintLane() -> f32 { return f32(${LANES.tint + 1}) * 0.25; }
${laneWgsl("tintScale", (lane) => `f32(${lane.length}) * 0.05`, LANES.tint)}`;

const OUTPUT = `struct TintOutput { @builtin(position) position: vec4<f32>, @location(0) normal: vec3<f32>, };`;
const VERTEX = `
@vertex fn mainVertex(input: VertexInput) -> TintOutput {
  var out: TintOutput;
  out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position, 1.0);
  out.normal = input.normal;
  return out;
}`;
const FRAGMENT = `
@fragment fn mainFragment(input: TintOutput) -> @location(0) vec4<f32> {
  let light = max(dot(normalize(input.normal), vec3<f32>(0.3, 0.8, -0.5)), 0.0);
  return vec4<f32>(vec3<f32>(tintLane(), tintScale(), 0.3) * (0.35 + 0.65 * light), 1.0);
}`;

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.06, g: 0.07, b: 0.1, a: 1 };
    const camera = createArcRotateCamera(-Math.PI / 2, 1.15, 6, { x: 0, y: -0.2, z: 0 });
    scene.camera = camera;
    camera.panningSensibility = Math.max(10, canvas.width / 64);
    camera.angularSensibility = 800 + canvas.height / 10;
    attachControl(camera, canvas, scene);
    addToScene(scene, createHemisphericLight([0, 1, 0], 0.9));

    const tint = createShaderMaterial({
        name: "module-constant-tint",
        vertexSource: wgsl`${`${OUTPUT}\n${VERTEX}`}`,
        fragmentSource: wgsl`${`${TINT_WGSL}\n${OUTPUT}\n${FRAGMENT}`}`,
        attributes: ["position", "normal"],
        uniforms: ["worldViewProjection"],
    });
    const box = createBox(engine, 1.1);
    box.material = tint;
    box.position.set(-1.2, -0.4, 0);
    addToScene(scene, box);

    const sphere = createSphere(engine, { diameter: 1.2, segments: 32 });
    const first = createStandardMaterial();
    first.diffuseColor = [0.2, 0.2, 0.9];
    sphere.material = first;
    sphere.position.set(1.2, -0.4, 0);
    addToScene(scene, sphere);

    const response = await fetch("../examples/assets/regression/gltf-uv-sets.gltf", { cache: "no-store" });
    if (!response.ok) throw new Error("The packaged glTF is missing.");
    addToScene(scene, await loadGltf(engine, await response.arrayBuffer()));

    registerScene(scene);
    const second = createStandardMaterial();
    second.diffuseColor = [0.85, 0.55, 0.2];
    sphere.material = second;
    invalidateRenderBundles(engine);
    let frames = 0;
    onBeforeRender(scene, () => {
        frames++;
        if (frames === 2) invalidateRenderBundles(engine);
    });
    await startEngine(engine);
}

main().catch(console.error);
