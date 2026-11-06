// Regression gate: enableGeometryVelocity in a geometry renderer task.
//
// A PBR box slides and turns, a skinned beam bends and a morphed beam swells
// (the ambient-occlusion demo's own procedural glTF), beside a still sphere.
// The geometry task writes material-point velocity with the previous view
// depth in Z; a copy carries it into a sampled target, and an effect task
// shows it scaled: red and green are the X and Y velocity about mid-grey,
// blue the previous depth.

import {
    addTask,
    addToScene,
    createArcRotateCamera,
    createBox,
    createCopyToTextureTask,
    createEffectRenderTask,
    createEffectWrapper,
    createEngine,
    createGeometryRendererTask,
    createHemisphericLight,
    createPbrMaterial,
    createRenderTargetTexture,
    createSceneContext,
    createSphere,
    enableGeometryVelocity,
    GeometryTextureType,
    onBeforeRender,
    playAnimation,
    registerScene,
    setEffectTexture,
    startEngine,
} from "babylon-lite";
import { createAoDeformationExamples } from "../corpus/babylon-lite/lab/lite/src/demos/ambient-occlusion-deformation.js";

const VELOCITY_WGSL = `@group(0) @binding(0) var velocityTexture:texture_2d<f32>;
@group(0) @binding(1) var velocitySampler:sampler;
@fragment fn effectFragment(input:EffectVertexOutput)->@location(0) vec4<f32>{
    let size = vec2<f32>(textureDimensions(velocityTexture));
    let texel = vec2<i32>(clamp(input.uv * size, vec2<f32>(0.0), size - vec2<f32>(1.0)));
    let velocity = textureLoad(velocityTexture, texel, 0);
    return vec4<f32>(clamp(vec3<f32>(0.5 + velocity.x * 60.0, 0.5 + velocity.y * 60.0, velocity.z * 0.08), vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}`;

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas, { msaaSamples: 1 });
    const scene = createSceneContext(engine, { defaultRenderTask: false });
    scene.clearColor = { r: 0.1, g: 0.1, b: 0.12, a: 1 };
    const camera = createArcRotateCamera(-Math.PI / 2, 1.2, 8, { x: -0.4, y: 0.8, z: -0.3 });
    camera.nearPlane = 0.1;
    camera.farPlane = 40;
    scene.camera = camera;
    addToScene(scene, createHemisphericLight([0, 1, -0.4], 1));

    const box = createBox(engine, { size: 0.9 });
    box.position.y = 0.6;
    box.material = createPbrMaterial({ baseColorFactor: [0.8, 0.35, 0.1, 1], metallicFactor: 0, roughnessFactor: 0.7 });
    addToScene(scene, box);
    const sphere = createSphere(engine, { diameter: 1, segments: 24 });
    sphere.position.x = -2.2;
    sphere.position.y = 0.5;
    sphere.position.z = 1.2;
    sphere.material = createPbrMaterial({ baseColorFactor: [0.2, 0.4, 0.8, 1], metallicFactor: 0, roughnessFactor: 0.6 });
    addToScene(scene, sphere);

    const examples = await createAoDeformationExamples(engine);
    addToScene(scene, examples);
    for (const group of examples.animationGroups ?? []) {
        group.loopAnimation = true;
        playAnimation(group);
    }

    let frame = 0;
    onBeforeRender(scene, () => {
        frame += 1;
        box.position.x = 1.2 + Math.sin(frame * 0.07) * 1.4;
        box.rotation.y = frame * 0.05;
    });

    const geometry = createGeometryRendererTask(
        {
            name: "velocity-geometry",
            samples: 1,
            textureDescriptions: [{ type: GeometryTextureType.LINEAR_VELOCITY, format: "rgba16float" }],
        },
        engine,
        scene
    );
    enableGeometryVelocity(geometry, { previousDepth: true });
    addTask(scene, geometry);
    const effect = createEffectWrapper(engine, {
        name: "velocity-view",
        fragmentWGSL: VELOCITY_WGSL,
        bindings: [
            { name: "velocityTexture", binding: 0, kind: "texture" },
            { name: "velocitySampler", binding: 1, kind: "sampler", textureBinding: "velocityTexture" },
        ],
    });
    const velocity = createRenderTargetTexture(engine, {
        lbl: "velocity-copy",
        format: "rgba16float",
        samples: 1,
        // The capture extent: the copy is one texel per pixel.
        size: { width: 1280, height: 720 },
    });
    addTask(
        scene,
        createCopyToTextureTask(
            { name: "velocity-copy", sourceTexture: geometry.geometryLinearVelocityTexture!, targetTexture: velocity.rt },
            engine,
            scene
        )
    );
    setEffectTexture(effect, "velocityTexture", velocity.texture);
    addTask(scene, createEffectRenderTask({ name: "velocity-view", effect, target: engine.scRT, clear: true }, engine, scene));

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
