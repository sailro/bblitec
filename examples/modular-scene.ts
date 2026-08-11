import {
    createEngine,
    registerScene,
    startEngine,
} from "@babylonjs/lite";
import {
    buildModularScene,
    setExposure,
} from "./modules/modular-scene.js";

async function main(): Promise<void> {
    const canvas = document.getElementById(
        "renderCanvas",
    ) as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = buildModularScene(engine);
    setExposure(scene);
    registerScene(scene);
    await startEngine(engine);
}
