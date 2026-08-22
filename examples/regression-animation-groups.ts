// Project-owned gate: glTF animation groups addressed from scene code.
//
// MorphStressTest declares three named clips of different lengths
// (Individuals 9.37 s, TheWave 1.97 s, Pulse 6.37 s), and upstream starts only
// the first. This scene selects a different one by name, which exercises the
// whole axis in one frame: iterating `scene.animationGroups`, comparing a
// group's name as a runtime string, and the pinned stop/play operations.
//
// What remains uncovered is the *scene's* collection. Scenes 152 and 157 now
// select clips by name from corpus code, but they iterate the container's own
// `animationGroups` — they add their file entity by entity, so the scene's
// list stays empty by construction. Scene 243 writes the loop against
// `scene.animationGroups` inside a query-parameter branch that folds away
// natively, and scene 144 needs bloom besides. Delete this gate once a corpus
// scene reaches the scene-owned collection.

import { addToScene, startEngine, createEngine, createSceneContext, createArcRotateCamera, loadEnvironment, loadGltf, attachControl, registerScene, playAnimation, stopAnimation } from "babylon-lite";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    const root = await loadGltf(engine, "https://cdn.jsdelivr.net/gh/KhronosGroup/glTF-Sample-Assets@main/Models/MorphStressTest/glTF/MorphStressTest.gltf");
    addToScene(scene, root);

    scene.clearColor = { r: 0.2, g: 0.2, b: 0.3, a: 1.0 };
    await loadEnvironment(scene, "https://assets.babylonjs.com/environments/environmentSpecular.env", { skipSkybox: true, skipGround: true, brdfUrl: "/brdf-lut.png" });

    // Upstream auto-plays the first clip only. Selecting a later one by name
    // means the frame is wrong unless the stop, the play and the name
    // comparison all match the pin.
    for (const group of scene.animationGroups) {
        if (group.name === "TheWave") {
            playAnimation(group);
        } else {
            stopAnimation(group);
        }
    }

    const cam = createArcRotateCamera(1.5707963, 1.5707963, 6.25, { x: 0, y: 0.2, z: 0 });
    cam.fov = 0.8;
    cam.nearPlane = 6.25 * 0.01;
    cam.farPlane = 6.25 * 1000;
    scene.camera = cam;
    attachControl(cam, canvas, scene);

    scene.fixedDeltaMs = 16.0;

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
