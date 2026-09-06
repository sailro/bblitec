/**
 * Regression gate: a `let` written from a callback the runtime retains
 * through a timer must be one cell shared with the frame callback.
 *
 * The box sits left until the imported countdown's fourth tick flips `go`
 * from inside a `setTimeout`-re-armed closure, and it rises once an
 * interval callback has counted three periods. Both flips land well before
 * the fixed capture frame, so the golden shows the box up and to the right;
 * a closure that wrote a private copy would leave it down and to the left.
 */
import {
    addToScene,
    createArcRotateCamera,
    createBox,
    createEngine,
    createHemisphericLight,
    createSceneContext,
    createStandardMaterial,
    onBeforeRender,
    registerScene,
    startEngine,
} from "@babylonjs/lite";
import { startCountdown } from "./regression-timer-callback-cells-countdown.js";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.035, g: 0.045, b: 0.07, a: 1 };

    const camera = createArcRotateCamera(
        -Math.PI / 2,
        Math.PI / 2,
        7,
        { x: 0, y: 0.5, z: 0 },
    );
    scene.camera = camera;
    addToScene(scene, createHemisphericLight([0, 1, 0], 1));

    const material = createStandardMaterial();
    material.diffuseColor = [1, 0.3, 0.1];
    const box = createBox(engine, { size: 1 });
    box.material = material;
    addToScene(scene, box);

    let go = false;
    let periods = 0;
    onBeforeRender(scene, () => {
        box.position.x = go ? 2 : -2;
        box.position.y = periods >= 3 ? 1 : 0;
    });

    await registerScene(scene);
    await startEngine(engine);

    // Both timers start after the engine, where the capture harness runs
    // them on its fixed frame clock; a timer armed earlier follows the
    // browser's wall clock and is not a pose.
    setInterval(() => {
        periods += 1;
    }, 400);
    startCountdown(() => {
        go = true;
    });
}

main().catch(console.error);
