// A text scene on an engine canvas ../page.html authors inside its layout:
// the canvas is a 640x360 box beside the page's own chrome, not the window.
// What the page paints before the canvas (the body and frame backgrounds,
// panels with drop shadows, one at a negative offset, and a blur partly under it) is
// covered by the canvas's opaque content, while their filter spread outside
// the canvas stays; the label painted after it stays on top. The scene registers through the
// default render task graph that presents into the canvas pane, and its
// text draws in that graph's scene pass.

import {
    addTextRenderable,
    attachControl,
    createArcRotateCamera,
    createDefaultTextData,
    createEngine,
    createSceneContext,
    createTextRenderable,
    loadFont,
    registerScene,
    startEngine,
} from "babylon-lite";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

async function run(): Promise<void> {
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    const camera = (scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 12, { x: 0, y: 0, z: 0 }));
    attachControl(camera, canvas, scene);

    const font = await loadFont("/fonts/Inter.ttf");
    const data = createDefaultTextData(font, 64, "Page canvas\ntext scene", [1, 0.85, 0.4, 1], {
        maxWidth: 1200,
        align: "center",
    });
    const text = createTextRenderable(data, { opacity: 1 });
    const scale = 0.01;
    text.position.set(-data.width * scale * 0.5, data.height * scale * 0.5, 0);
    text.scaling.set(scale, scale, scale);
    addTextRenderable(scene, text);

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.ready = "true";
}

void run();
