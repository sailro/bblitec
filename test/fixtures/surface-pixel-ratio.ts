import {
    addToScene,
    createBox,
    createEngine,
    createFreeCamera,
    createSceneContext,
    createStandardMaterial,
    registerScene,
    resizeEngine,
    startEngine,
} from "@babylonjs/lite";

// `maxDevicePixelRatio` as a createEngine option, a write followed by
// `resizeEngine`, and a listener-style write the next frame head applies.
const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const engine = await createEngine(canvas, { maxDevicePixelRatio: 0.75 });
const scene = createSceneContext(engine);
scene.camera = createFreeCamera({ x: 0, y: 0, z: -4 }, { x: 0, y: 0, z: 0 });
const box = createBox(engine, 1);
box.material = createStandardMaterial();
addToScene(scene, box);
await registerScene(scene);

const frame = (): Promise<void> =>
    new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const expect = (label: string, scale: number): void => {
    const width = Math.trunc(canvas.clientWidth * scale);
    const height = Math.trunc(canvas.clientHeight * scale);
    if (canvas.width !== width || canvas.height !== height)
        throw new Error(
            `${label}: backing ${canvas.width}x${canvas.height}, expected ${width}x${height}`,
        );
};

let renderScale = 0.5;
const resolvedRenderScale = (): number =>
    Math.min(window.devicePixelRatio || 1, renderScale);

if (engine.maxDevicePixelRatio !== 0.75) throw new Error("option cap");
expect("option", Math.min(window.devicePixelRatio || 1, 0.75));
await startEngine(engine);
await frame();
expect("option frame", Math.min(window.devicePixelRatio || 1, 0.75));
engine.maxDevicePixelRatio = resolvedRenderScale();
resizeEngine(engine);
expect("resize", resolvedRenderScale());
await frame();
expect("frame", resolvedRenderScale());

const reapply = (): void => {
    engine.maxDevicePixelRatio = resolvedRenderScale();
};
window.addEventListener("resize", reapply);
renderScale = 0.25;
reapply();
expect("pending", 0.5);
await frame();
await frame();
expect("applied", resolvedRenderScale());
globalThis.close();
