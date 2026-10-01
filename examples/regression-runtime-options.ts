// Project-owned differential gate: option values a scene computes or fetches
// at run time, and the native paths they reach.
//
//   * A created PBR material's `normalTexture` and `normalTextureScale`: the
//     ground quad carries authored tangents (the tangent-frame normal arm),
//     the sphere none (the cotangent-frame arm), both sampling one loaded map.
//   * A PCF directional generator whose `mapSize` is a run-time value, so the
//     native factory sizes its target from the record, and whose
//     `normalBias` the pinned factory declares and never reads.
//   * A shader material whose uniforms come from a function returning a
//     literal list, whose tint is written from a `Float32Array`, and whose
//     options carry a spread generation settles.
//   * A glTF loaded from the `arrayBuffer()` of a packaged fetch.
//   * `performance.timeOrigin` read as a fixed epoch time.

import {
    addToScene,
    createArcRotateCamera,
    createBox,
    createDirectionalLight,
    createEngine,
    createHemisphericLight,
    createMeshFromData,
    createPbrMaterial,
    createPcfDirectionalShadowGenerator,
    createSceneContext,
    createShaderMaterial,
    createSphere,
    loadGltf,
    loadTexture2D,
    registerSceneWithShadowSupport,
    setShaderUniform,
    setShadowTaskCasterMeshes,
    startEngine,
    wgsl,
} from "babylon-lite";

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
  return vec4<f32>(shaderUniforms.uTint.rgb * (0.35 + 0.65 * light), 1.0);
}`;

const CULL_BACK = true;

function tintUniforms() {
    return [
        "worldViewProjection",
        { name: "uTint", type: "vec4<f32>" as const, defaultValue: [1, 1, 1, 1] },
    ] as const;
}

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.05, g: 0.06, b: 0.09, a: 1 };
    scene.camera = createArcRotateCamera(-Math.PI / 2, 1.2, 7, { x: 0, y: -0.3, z: -0.8 });
    addToScene(scene, createHemisphericLight([0, 1, 0], 0.4));
    const sun = createDirectionalLight([0.3, -0.8, 0.5], 2.5);
    sun.position.set(-1.8, 4.8, -3);
    addToScene(scene, sun);

    const normalMap = await loadTexture2D(engine, "/playroom/textures/woodGrain_normal.png", {
        srgb: false,
        addressModeU: "repeat",
        addressModeV: "repeat",
    });
    const wood = createPbrMaterial({
        baseColorFactor: [0.72, 0.52, 0.34, 1],
        normalTexture: normalMap,
        normalTextureScale: 1.5,
        metallicFactor: 0,
        roughnessFactor: 0.55,
    });

    const positions = new Float32Array([-3.5, -1.2, -3.5, 3.5, -1.2, -3.5, -3.5, -1.2, 0.5, 3.5, -1.2, 0.5]);
    const normals = new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]);
    const uvs = new Float32Array([0, 0, 2, 0, 0, 2, 2, 2]);
    const tangents = new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]);
    const ground = createMeshFromData(
        engine,
        "ground",
        positions,
        normals,
        new Uint32Array([0, 1, 2, 1, 3, 2]),
        uvs,
        undefined,
        tangents,
    );
    ground.material = wood;
    addToScene(scene, ground);

    const sphere = createSphere(engine, { diameter: 1.4, segments: 32 });
    sphere.material = wood;
    sphere.position.set(-1.2, -0.5, -1.5);
    addToScene(scene, sphere);

    const tint = createShaderMaterial({
        name: "runtime-tint",
        vertexSource: wgsl`${`${OUTPUT}\n${VERTEX}`}`,
        fragmentSource: wgsl`${`${OUTPUT}\n${FRAGMENT}`}`,
        attributes: ["position", "normal"],
        uniforms: tintUniforms(),
        ...(CULL_BACK ? { backFaceCulling: true } : {}),
    });
    setShaderUniform(tint, "uTint", new Float32Array([0.9, 0.35, 0.2, 1]));
    const box = createBox(engine, 0.9);
    box.material = tint;
    box.position.set(1.3, -0.75, -1.5);
    addToScene(scene, box);

    const response = await fetch("../examples/assets/regression/gltf-uv-sets.gltf");
    if (!response.ok) throw new Error("The packaged glTF is missing.");
    const asset = await loadGltf(engine, await response.arrayBuffer());
    addToScene(scene, asset);

    const shadow = createPcfDirectionalShadowGenerator(engine, sun, {
        mapSize: Math.min(1024, Math.max(512, canvas.width)),
        bias: 0.0005,
        normalBias: canvas.height / 36000,
        darkness: 0.3,
        orthoMinZ: 1,
        orthoMaxZ: 12,
    });
    sun.shadowGenerator = shadow;
    setShadowTaskCasterMeshes(shadow, [sphere]);
    ground.receiveShadows = true;

    // `performance.timeOrigin` is a fixed epoch time (the capture harness
    // pins `performance.now()`, so the sum is not compared to the clock).
    const timeOrigin = performance.timeOrigin;
    if (!(timeOrigin > 1.6e12) || performance.timeOrigin !== timeOrigin) {
        throw new Error("performance.timeOrigin is not a fixed epoch time.");
    }

    await registerSceneWithShadowSupport(scene);
    await startEngine(engine);
}

main().catch(console.error);
