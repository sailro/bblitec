// Regression gate: a shadow scene with no Standard material at all, casting
// from a PBR mesh.
//
// Every corpus shadow scene composes Standard variants and casts from a
// Standard mesh, so what this pins is that the shadow half belongs to the
// generator and not to one family: the generator-side state rides
// `BBLITE_SHADOW_RECEIVERS`, `pass_depth_compare` and `pass_depth_clear`
// answer standard-Z under it, and the caster draws through whichever family
// its own material belongs to — with that family's pipeline taking the
// shadow pass's compare, sample count and depth format.
//
// The caster pass is what the golden measures. Its map clears to the pin's
// own far value and compares `less-equal`, so a regression moves the shadow
// or removes it. Both meshes are PBR, which keeps `BBLITE_STANDARD_VARIANTS`
// at zero.
//
// Retire it when a corpus scene reaches a shadow generator with no Standard
// material.

import {
    addToScene,
    startEngine,
    createEngine,
    createSceneContext,
    createArcRotateCamera,
    createSpotLight,
    createSphere,
    createGround,
    createPbrMaterial,
    createSolidTexture2D,
    createPcfSpotlightShadowGenerator,
    setShadowTaskCasterMeshes,
    attachControl,
    registerSceneWithShadowSupport,
} from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    const cam = createArcRotateCamera(0.8, 0.95, 22, { x: 0, y: 0, z: 0 });
    cam.nearPlane = 0.1;
    cam.farPlane = 200;
    scene.camera = cam;
    attachControl(cam, canvas, scene);

    const spot = createSpotLight([0, 14, 6], [0, -14, -6], 1.1, 60);
    spot.intensity = 2.5;
    addToScene(scene, spot);

    // Both materials are PBR, so the scene composes no Standard variant and
    // `BBLITE_STANDARD_SHADOWS` is zero while `BBLITE_PBR_SHADOWS` is one.
    const sphere = createSphere(engine, { segments: 16, diameter: 4 });
    sphere.material = createPbrMaterial({
        baseColorTexture: createSolidTexture2D(engine, 0.8, 0.25, 0.2, 1),
        ormTexture: createSolidTexture2D(engine, 1.0, 0.5, 0.0, 1),
        usePhysicalLightFalloff: false,
    });
    sphere.position.set(0, 4, 0);
    addToScene(scene, sphere);

    const ground = createGround(engine, { width: 30, height: 30, subdivisions: 2 });
    ground.material = createPbrMaterial({
        baseColorTexture: createSolidTexture2D(engine, 0.55, 0.55, 0.6, 1),
        ormTexture: createSolidTexture2D(engine, 1.0, 0.9, 0.0, 1),
        usePhysicalLightFalloff: false,
    });
    ground.receiveShadows = true;
    addToScene(scene, ground);

    spot.shadowGenerator = createPcfSpotlightShadowGenerator(engine, spot, {
        mapSize: 512,
        near: cam.nearPlane,
        far: cam.farPlane,
    });
    setShadowTaskCasterMeshes(spot.shadowGenerator, [sphere]);

    await registerSceneWithShadowSupport(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
