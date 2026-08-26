// Regression gate: a scene whose only shadow filter is the ESM directional.
//
// The two filters are siblings and every corpus shadow scene reaches BOTH —
// scene 4 and scene 22 pair an ESM directional with a PCF spot, and scene 18
// is PCF alone. So `shadow:esm` without `shadow:pcf` is a configuration the
// corpus never generates, and two predicates drifted inside it unnoticed:
// `generated-sources.ts` declared `upstream/src/shadow.cpp` for `shadow:pcf`
// where the emitter writes it for either, and `output-projection.ts` decided
// `main.cpp`'s include of the pinned generator defaults the same way. Both
// refused generation for exactly this scene and for nothing else measured.
//
// What the golden measures is ordinary: the ESM caster pass writing its
// exponential depth, the separable blur, and the Standard receiver sampling
// the blurred map. The point of the gate is the CELL, not the picture — it
// compiles and builds a feature combination no corpus scene reaches.
//
// Retire it when a corpus scene reaches an ESM generator with no PCF light.

import {
    addToScene,
    startEngine,
    createEngine,
    createSceneContext,
    createArcRotateCamera,
    createDirectionalLight,
    createTorus,
    createGround,
    createStandardMaterial,
    createEsmDirectionalShadowGenerator,
    setShadowTaskCasterMeshes,
    attachControl,
    registerSceneWithShadowSupport,
} from "babylon-lite";
import type { ArcRotateCamera } from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    const cam = createArcRotateCamera(0.9, 0.9, 26, { x: 0, y: 0, z: 0 });
    cam.nearPlane = 0.1;
    cam.farPlane = 200;
    scene.camera = cam;
    attachControl(cam, canvas, scene);

    // The scene's only light, and the only generator: no spot anywhere, so
    // `shadow:pcf` is never reached.
    const light = createDirectionalLight([-1, -2, -1]);
    light.position.set(8, 16, 8);
    addToScene(scene, light);

    const torus = createTorus(engine, { diameter: 5, thickness: 1.6, tessellation: 24 });
    torus.material = createStandardMaterial();
    torus.position.set(0, 5, 0);
    addToScene(scene, torus);

    const ground = createGround(engine, { width: 40, height: 40, subdivisions: 2 });
    const groundMat = createStandardMaterial();
    ground.material = groundMat;
    groundMat.specularColor = [0, 0, 0];
    ground.receiveShadows = true;
    addToScene(scene, ground);

    light.shadowGenerator = createEsmDirectionalShadowGenerator(engine, light, {
        mapSize: 1024,
        depthScale: 50,
        bias: 0.00005,
        blurKernel: 64,
        blurScale: 2,
        darkness: 0,
        frustumEdgeFalloff: 0,
        orthoMinZ: cam.nearPlane,
        orthoMaxZ: cam.farPlane,
    });
    setShadowTaskCasterMeshes(light.shadowGenerator, [torus]);

    await registerSceneWithShadowSupport(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
