import {
    addToScene,
    createArcRotateCamera,
    createCsmDirectionalShadowGenerator,
    createDirectionalLight,
    createEngine,
    createGround,
    createSceneContext,
    createStandardMaterial,
    enableCsmStaticCache,
    getCsmReceiverTexture,
    registerSceneWithShadowSupport,
    setShadowTaskCasterMeshes,
    startEngine,
} from "@babylonjs/lite";

// getCsmReceiverTexture marks its generator where the call runs: a read in
// an untaken branch leaves enableCsmStaticCache free, a taken one refuses
// it. A green clear marks a run that passed both.
const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
const scene = createSceneContext(engine);
scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 3, 50, { x: 0, y: 0, z: 0 });
const light = createDirectionalLight([0, -1, -1], 0.8);
addToScene(scene, light);
const ground = createGround(engine, { width: 20, height: 20 });
ground.material = createStandardMaterial();
ground.receiveShadows = true;
addToScene(scene, ground);
const unread = createCsmDirectionalShadowGenerator(engine, light, { mapSize: 256, numCascades: 2 });
const read = createCsmDirectionalShadowGenerator(engine, light, { mapSize: 256, numCascades: 2 });
if (performance.now() < 0) getCsmReceiverTexture(unread);
getCsmReceiverTexture(read);
await enableCsmStaticCache(engine, unread, { refitAngle: 0.01 });
let refused = "";
try {
    await enableCsmStaticCache(engine, read, { refitAngle: 0.01 });
} catch (error) {
    refused = (error as Error).name;
}
if (refused !== "Error") throw new Error("receiver read: " + refused);
scene.clearColor = { r: 0, g: 1, b: 0, a: 1 };
light.shadowGenerator = unread;
setShadowTaskCasterMeshes(unread, [ground]);
await registerSceneWithShadowSupport(scene);
await startEngine(engine);
