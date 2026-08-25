import {
    addToScene,
    createArcRotateCamera,
    createEngine,
    createHemisphericLight,
    createSceneContext,
    loadGltf,
    registerScene,
    startEngine,
} from "@babylonjs/lite";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.04, g: 0.05, b: 0.08, a: 1 };

    scene.camera = createArcRotateCamera(
        -Math.PI / 2,
        Math.PI / 2,
        3.6,
        { x: 0, y: 0, z: 0 },
    );

    addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));

    const stepped = await loadGltf(
        engine,
        "../examples/assets/regression/gltf-step-animation.gltf",
    );
    addToScene(scene, stepped);

    // Half speed, so the pose the seek resolves is the ratio's as much as
    // the sampler's: at 1.5s of scene time the clip stands at 0.75s, inside
    // the second STEP span.
    const groups = stepped.animationGroups ?? [];
    for (const group of groups) {
        group.speedRatio = 0.5;
    }

    await registerScene(scene);
    await startEngine(engine);
}

main().catch(console.error);
