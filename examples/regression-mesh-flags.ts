// Project-owned differential gate: the two optional booleans a SceneNode and a
// Mesh carry for "skip me", each measured where ignoring it changes the image.
//
//   * `visible` (scene-node.ts) — undefined or true draws, false skips the
//     render and the camera bounds. The pin reads it inside the renderable's
//     `draw`, which for an opaque mesh runs when the cached render bundle is
//     RECORDED; a bare field write does not bump the visibility epoch, so the
//     flag takes effect at the next re-record rather than on the next frame.
//     This port has no bundles and caches the render plan on the same rule
//     (`_renderableVersion` -> `mesh_membership_version`), so both arms below
//     answer the same way on both sides.
//   * `pickable` (mesh.ts) — false keeps a mesh out of the GPU pick pass, so
//     it can neither answer a pick nor occlude one behind it.
//
// Three probes, each arranged so that ignoring the flag paints a different
// picture rather than the same one:
//
//   1. (left)   A RED box covers a GREEN one and is hidden before
//               `registerScene`, i.e. before the plan is built. Green shows.
//               Ignore `visible` and the column is red.
//   2. (right)  A BLUE box covering an ORANGE one is hidden from a frame
//               callback two frames AFTER the scene's last membership change,
//               so nothing re-reads the plan afterwards. It stays drawn — the
//               pin's documented deferral, measured rather than assumed. Read
//               the flag per draw instead and the column turns orange.
//   3. (centre) A large non-pickable YELLOW box stands in front of a smaller
//               pickable WHITE one and covers it completely, pick pixel
//               included. The pair sits at the screen centre so that
//               perspective keeps the farther box concentric with the nearer
//               one rather than sliding it out from behind it, which is what
//               makes one pixel land inside both. The pick must return the
//               white box; a marker is
//               added to the scene only when it does. Ignore `pickable` and
//               the pick answers the blocker and the marker never appears.
//
// The camera looks down +z, so the NEARER box of each pair is the one at
// negative z. Putting the front box behind instead leaves every probe green,
// orange and hit — passing without measuring anything.
//
// Scene 43 writes both flags but measures neither: its hidden mesh is visible
// again at the captured frame, and it never picks. Corpus scenes 102, 103 and
// 118 reach the same pair behind physics and billboard picking.

import {
    addToScene,
    startEngine,
    createEngine,
    createSceneContext,
    createArcRotateCamera,
    createBox,
    createGpuPicker,
    createHemisphericLight,
    createStandardMaterial,
    disposePicker,
    onBeforeRender,
    pickAsync,
    registerScene,
} from "babylon-lite";
import type { Mesh } from "babylon-lite";

/** A box at `x` with a flat colour, so a swap between two of them is unmistakable. */
function colouredBox(
    engine: Parameters<typeof createBox>[0],
    size: number,
    x: number,
    z: number,
    colour: [number, number, number],
    name: string,
): Mesh {
    const box = createBox(engine, size);
    box.position.set(x, 0, z);
    box.name = name;
    const material = createStandardMaterial();
    material.diffuseColor = colour;
    material.emissiveColor = [colour[0] * 0.4, colour[1] * 0.4, colour[2] * 0.4];
    box.material = material;
    return box;
}

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.2, g: 0.2, b: 0.3, a: 1.0 };

    // Looking down +z from -z, so the box at negative z is the nearer one and
    // covers the one behind it.
    scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 16, { x: 0, y: 0, z: 0 });
    addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));

    // 1. Hidden before the plan is built.
    const hiddenRed = colouredBox(engine, 2.4, -5, -2, [0.9, 0.15, 0.15], "hiddenRed");
    addToScene(scene, hiddenRed);
    addToScene(scene, colouredBox(engine, 2.0, -5, 2, [0.15, 0.85, 0.25], "behindGreen"));
    hiddenRed.visible = false;

    // 2. Hidden after the engine started — the deferral arm.
    const lateBlue = colouredBox(engine, 2.4, 5, -2, [0.2, 0.3, 0.95], "lateBlue");
    addToScene(scene, lateBlue);
    addToScene(scene, colouredBox(engine, 2.0, 5, 2, [0.9, 0.6, 0.1], "behindOrange"));

    // 3. The pick pair. The yellow blocker is larger and nearer, so a pick that
    //    honours `pickable` has to reach past it to the white box behind.
    const blocker = colouredBox(engine, 3.0, 0, -2, [0.95, 0.85, 0.2], "blocker");
    blocker.pickable = false;
    addToScene(scene, blocker);
    addToScene(scene, colouredBox(engine, 2.2, 0, 2, [0.95, 0.95, 0.95], "target"));

    // The marker is built but held out of the scene: only a pick that returns
    // the box behind the blocker puts it on screen.
    const marker = colouredBox(engine, 0.8, 0, 0, [0.1, 0.9, 0.9], "marker");
    marker.position.set(0, 2.8, 0);
    // Diagnostic twin: a pick that answers the blocker paints magenta instead
    // of cyan, so one run distinguishes "the flag was ignored" from "the pick
    // pixel reached nothing".
    const wrongMarker = colouredBox(engine, 0.8, -2.4, 0, [0.95, 0.1, 0.8], "wrongMarker");
    wrongMarker.position.set(-2.4, 2.8, 0);

    // The late hide must land after the scene's last membership change has
    // already been taken up, or the two would arrive in the same frame and the
    // rebuild that change forces would read the hide with it.
    let frame = 0;
    let hideFrame = -1;
    onBeforeRender(scene, () => {
        if (hideFrame >= 0 && frame >= hideFrame) {
            lateBlue.visible = false;
        }
        frame++;
    });

    await registerScene(scene);
    await startEngine(engine);

    const picker = createGpuPicker(scene);
    const pick = await pickAsync(picker, canvas.clientWidth * 0.5, canvas.clientHeight * 0.5);
    disposePicker(picker);
    const pickedName = pick.hit ? (pick.pickedMesh?.name ?? "") : "miss";
    if (pickedName === "target") {
        addToScene(scene, marker);
    }
    if (pickedName === "blocker") {
        addToScene(scene, wrongMarker);
    }
    hideFrame = frame + 2;

    // Two frames for the marker's membership change, then the hide, then one
    // more so a renderer that re-read the flag would have shown it.
    await new Promise<void>((resolve) => {
        const wait = (): void => (frame > hideFrame + 2 ? resolve() : void requestAnimationFrame(wait));
        wait();
    });

    canvas.dataset.pickedHit = pickedName;
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
