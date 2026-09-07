import {
    addTextRenderable, createDefaultTextData, createEngine, createFreeCamera,
    createSceneContext, createTextRenderable, loadFont, registerScene,
    setAlphaToCoverage, startEngine,
} from "@babylonjs/lite";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas, { msaaSamples: 4 });
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.035, g: 0.045, b: 0.07, a: 1 };
    scene.camera = createFreeCamera({ x: 0, y: 0, z: -10 }, { x: 0, y: 0, z: 0 });
    const font = await loadFont("/fonts/Roboto-Regular.ttf");
    const frontData = createDefaultTextData(font, 180, "A2C", [242 / 255, 31 / 255, 41 / 255, 1]);
    const rearData = frontData;
    const front = createTextRenderable(frontData, {
        position: { x: -2.5, y: 1.3, z: 0 },
        scaling: { x: 0.009, y: 0.009, z: 0.009 },
        opacity: 0.5, order: 100,
    });
    const rear = createTextRenderable(rearData, {
        position: { x: 0.5, y: -0.2, z: 0.2 },
        scaling: { x: 0.006, y: 0.006, z: 0.006 },
        opacity: 0.875, order: 101,
    });
    setAlphaToCoverage(front, true);
    setAlphaToCoverage(rear, true);
    addTextRenderable(scene, front);
    addTextRenderable(scene, rear);
    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.ready = "true";
}

void main();
