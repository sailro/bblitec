// Device-loss recovery with two registered scenes, one per half of the
// canvas, the right an overlay of the left: the loss is forced once the
// reference frame is captured, and both scenes must render again from their
// retained CPU owners.
import {
    addToScene,
    createArcRotateCamera,
    createBox,
    createEngine,
    createHemisphericLight,
    createOverlayScene,
    createPbrMaterial,
    createSceneContext,
    createSphere,
    enableDeviceLostSceneRecovery,
    forceWebGpuDeviceLossForTesting,
    onBeforeRender,
    registerScene,
    startEngine,
    type EngineContext,
    type SceneContext,
} from "@babylonjs/lite";

const SETTLE_FRAMES = 12;
const POST_RECOVERY_FRAMES = 20;
const CAPTURE_TIMEOUT_MS = 3000;

function waitFor(predicate: () => boolean, timeoutMs = 30_000): Promise<void> {
    return new Promise<void>((resolve) => {
        const start = performance.now();
        const poll = (): void => {
            if (predicate() || performance.now() - start >= timeoutMs) {
                resolve();
                return;
            }
            requestAnimationFrame(poll);
        };
        poll();
    });
}

function half(
    engine: EngineContext,
    scene: SceneContext,
    x: number,
    color: [number, number, number],
    sphere: boolean,
): void {
    scene.camera = createArcRotateCamera(-Math.PI / 2, 1.1, 4, { x: 0, y: 0, z: 0 });
    scene.camera.viewport = { x, y: 0, width: 0.5, height: 1 };
    addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));
    const mesh = sphere ? createSphere(engine, { diameter: 1.6 }) : createBox(engine, { size: 1.3 });
    mesh.rotation.y = 0.5;
    const material = createPbrMaterial({ baseColorFactor: [color[0], color[1], color[2], 1], roughnessFactor: 0.6, metallicFactor: 0 });
    mesh.material = material;
    addToScene(scene, mesh);
}

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    enableDeviceLostSceneRecovery(engine, {
        onLost() {
            canvas.dataset.deviceLost = "true";
        },
        onRecovered() {
            canvas.dataset.deviceRecovered = "true";
        },
        onRecoveryFailed(error) {
            const message = error instanceof Error ? error.message : String(error);
            canvas.dataset.recoveryFailed = message;
            canvas.dataset.error = message;
        },
    });

    const left = createSceneContext(engine);
    // The right half composites over the left scene; a second ordinary scene would clear the whole canvas.
    const right = createOverlayScene(left);
    left.clearColor = { r: 0.08, g: 0.09, b: 0.14, a: 1 };
    half(engine, left, 0, [0.85, 0.3, 0.2], false);
    half(engine, right, 0.5, [0.2, 0.7, 0.35], true);

    let frames = 0;
    let recoveredFrames = 0;
    onBeforeRender(right, () => {
        frames++;
        if (canvas.dataset.deviceRecovered === "true") {
            recoveredFrames++;
            if (recoveredFrames >= POST_RECOVERY_FRAMES) canvas.dataset.ready = "true";
            return;
        }
        if (frames === SETTLE_FRAMES) canvas.dataset.preLossReady = "true";
    });

    await registerScene(left);
    await registerScene(right);
    await startEngine(engine);

    await waitFor(() => canvas.dataset.preLossReady === "true");
    await waitFor(() => canvas.dataset.captured === "true", CAPTURE_TIMEOUT_MS);
    forceWebGpuDeviceLossForTesting(engine);
}

main().catch((error) => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    canvas.dataset.error = error instanceof Error ? error.message : String(error);
    console.error(error);
});
