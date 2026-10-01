// A scene presenting through a canvas the page lays out: the page background,
// a banner overlapping the canvas and the canvas's own background precede the
// canvas and stay beneath the scene; the label follows it and draws over it.
import {
    addToScene,
    createArcRotateCamera,
    createBox,
    createEngine,
    createHemisphericLight,
    createSceneContext,
    createStandardMaterial,
    registerScene,
    startEngine,
} from "@babylonjs/lite";

const canvas = document.getElementById("sceneCanvas") as HTMLCanvasElement;
const engine = await createEngine(canvas);
const scene = createSceneContext(engine);
scene.clearColor = { r: 0.12, g: 0.16, b: 0.3, a: 1 };
scene.camera = createArcRotateCamera(-1.1, 1.1, 5, { x: 0, y: 0, z: 0 });
addToScene(scene, createHemisphericLight([0, 1, 0], 1));
const box = createBox(engine, 1);
const material = createStandardMaterial();
material.diffuseColor = [0.85, 0.55, 0.2];
box.material = material;
addToScene(scene, box);
await registerScene(scene);
await startEngine(engine);
