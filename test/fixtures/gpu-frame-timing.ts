import {
    addToScene,
    createBox,
    createEngine,
    createFreeCamera,
    createSceneContext,
    createStandardMaterial,
    isGpuTimingSupported,
    registerScene,
    startEngine,
} from "@babylonjs/lite";

// Frame GPU timing toggled through a dynamic import, as a debug hook does.
const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const engine = await createEngine(canvas);
const scene = createSceneContext(engine);
scene.camera = createFreeCamera({ x: 0, y: 0, z: -4 }, { x: 0, y: 0, z: 0 });
const box = createBox(engine, 1);
box.material = createStandardMaterial();
addToScene(scene, box);
await registerScene(scene);
await startEngine(engine);

const frame = (): Promise<void> =>
    new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const setGpuTiming = async (enabled: boolean): Promise<void> => {
    const { setGpuTimingEnabled } = await import("@babylonjs/lite");
    setGpuTimingEnabled(engine, enabled);
};

if (!isGpuTimingSupported(engine)) throw new Error("No timestamp queries.");
await setGpuTiming(true);
let frames = 0;
while (engine.gpuFrameTimeMs === 0 && frames < 60) {
    await frame();
    frames++;
}
const measured = engine.gpuFrameTimeMs;
if (!(measured > 0 && measured < 5000))
    throw new Error(`GPU frame time ${measured} after ${frames} frames.`);
await setGpuTiming(false);
if (engine.gpuFrameTimeMs !== 0) throw new Error("Disabled timing kept a sample.");
await frame();
if (engine.gpuFrameTimeMs !== 0) throw new Error("Disabled timing sampled.");
globalThis.close();
