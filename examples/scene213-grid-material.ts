import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createBox,
    createEngine,
    createGridMaterial,
    createGround,
    createSceneContext,
    createSphere,
    registerScene,
    startEngine,
} from "@babylonjs/lite";

// Pinned Babylon Lite lab/lite/src/lite/scene213.ts.
async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.08, g: 0.08, b: 0.11, a: 1 };

    const camera = createArcRotateCamera(
        -Math.PI / 2.3,
        Math.PI / 3.0,
        16,
        { x: 0, y: 1.2, z: 0 },
    );
    camera.nearPlane = 0.1;
    camera.farPlane = 200;
    attachControl(camera, canvas, scene);
    scene.camera = camera;

    const ground = createGround(engine, { width: 14, height: 14 });
    ground.material = createGridMaterial({
        name: "groundGrid",
        mainColor: [0.06, 0.07, 0.1],
        lineColor: [0, 0.5, 0.5],
        gridRatio: 1,
        majorUnitFrequency: 10,
        minorUnitVisibility: 0.45,
        antialias: true,
    });
    addToScene(scene, ground);

    const sphere = createSphere(engine, { segments: 48, diameter: 3 });
    sphere.position.set(-3.6, 1.6, 0);
    sphere.material = createGridMaterial({
        name: "sphereGrid",
        mainColor: [0.1, 0.05, 0.05],
        lineColor: [1.0, 0.55, 0.1],
        gridRatio: 0.5,
        majorUnitFrequency: 5,
        minorUnitVisibility: 0.5,
        useMaxLine: true,
        antialias: true,
    });
    addToScene(scene, sphere);

    const box = createBox(engine, 2.4);
    box.position.set(3.6, 1.2, 0);
    box.material = createGridMaterial({
        name: "boxGrid",
        mainColor: [0.05, 0.08, 0.12],
        lineColor: [0.2, 0.9, 1.0],
        gridRatio: 0.5,
        majorUnitFrequency: 4,
        minorUnitVisibility: 0.4,
        opacity: 0.6,
        antialias: true,
    });
    addToScene(scene, box);

    const hardBox = createBox(engine, 1.6);
    hardBox.position.set(0, 0.8, 3.4);
    hardBox.material = createGridMaterial({
        name: "hardGrid",
        mainColor: [0.08, 0.05, 0.1],
        lineColor: [0.9, 0.2, 0.6],
        gridRatio: 0.3,
        majorUnitFrequency: 3,
        minorUnitVisibility: 0.6,
        antialias: false,
    });
    addToScene(scene, hardBox);

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
