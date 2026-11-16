// Regression gate: an effect wrapper's blend state blends its pass over the target.
//
// A render target an opaque blue effect pass clears takes a second pass of red
// whose alpha ramps across the target, drawn with `clear: false` and the blend
// a selection halo uses (colour `src-alpha` / `one-minus-src-alpha`, alpha
// `one` / `one-minus-src-alpha`): the sphere the target textures shows the ramp
// from blue to red. Without the blend the second pass writes red over all of it.

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
    startEngine,
} from "babylon-lite";

const BASE_WGSL = `@fragment fn effectFragment(input:EffectVertexOutput)->@location(0) vec4<f32>{return vec4<f32>(0.0,0.0,1.0,1.0);}`;
const HALO_WGSL = `@fragment fn effectFragment(input:EffectVertexOutput)->@location(0) vec4<f32>{return vec4<f32>(1.0,0.0,0.0,input.uv.x);}`;

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 51 / 255, g: 51 / 255, b: 76 / 255, a: 1 };

    const { rt, texture } = createRenderTargetTexture(engine, {
        lbl: "effect-blend-rtt",
        format: "rgba8unorm",
        samples: 1,
        size: { width: 256, height: 256 },
    });
    const base = createEffectWrapper(engine, { name: "effect-blend-base", fragmentWGSL: BASE_WGSL, bindings: [] });
    const halo = createEffectWrapper(engine, {
        name: "effect-blend-halo",
        fragmentWGSL: HALO_WGSL,
        bindings: [],
        blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
        },
    });
    // Each task added at the start runs before the ones already there: the
    // base pass clears the target, then the halo pass blends over it.
    addTaskAtStart(
        scene,
        createEffectRenderTask({ name: "effect-blend-halo", effect: halo, target: rt, clear: false }, engine, scene)
    );
    addTaskAtStart(
        scene,
        createEffectRenderTask(
            { name: "effect-blend-base", effect: base, target: rt, clear: true, clearColor: { r: 0, g: 0, b: 0, a: 1 } },
            engine,
            scene
        )
    );

    const sphere = createSphere(engine, { diameter: 2, segments: 32 });
    const material = createStandardMaterial();
    material.disableLighting = true;
    material.diffuseTexture = texture;
    material.emissiveColor = [1, 1, 1];
    sphere.material = material;
    addToScene(scene, sphere);

    scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 5.19616, { x: 0, y: 0, z: 0 });

    await registerScene(scene);
    await startEngine(engine);

    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
}

main().catch((err) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(err);
    }
});
