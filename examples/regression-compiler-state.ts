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

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const engine = await createEngine(canvas);
const scene = createSceneContext(engine);
scene.clearColor = { r: 0.035, g: 0.045, b: 0.07, a: 1 };

const camera = createArcRotateCamera(
    -Math.PI / 2,
    Math.PI / 2,
    5,
    { x: 1, y: 0, z: 0 },
);
scene.camera = camera;
addToScene(
    scene,
    createHemisphericLight([0, 1, 0], 1),
);

const material = createStandardMaterial();
material.diffuseColor = [1, 0.3, 0.1];
const box = createBox(engine, {
    width: 2,
    height: 1,
    depth: 0.5,
});
box.material = material;
addToScene(scene, box);

let offset = 0;
offset++;
box.position.x = offset;
box.rotation.y += 0.3;

await registerScene(scene);
await startEngine(engine);
