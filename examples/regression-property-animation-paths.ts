// Project-owned differential gate: the component paths a property clip can
// name, beside the whole-lane paths the corpus already measures.
//
// A path is any dotted string upstream. `resolvePropertyBinding` walks it and
// `createPropertyWriter` then stores either the whole value -- through the
// value's own `set` -- or the one number a trailing component named, so which
// paths exist follows from which properties the bound object has rather than
// from a list. This port resolves the same two forms against the lanes its own
// records hold, and the corpus reaches only `position`, `position.x`,
// `scaling`, `rotationQuaternion` and the camera's `alpha`.
//
// What this gate adds is the rest of that surface, one box per lane:
//
//   * `position.y` and `position.z` on one box -- two component tracks on one
//     lane, which upstream are two buckets on the position vector while the
//     whole-lane path is one bucket on the mesh;
//   * `scaling.x` and `scaling.z`, a lane whose whole form the corpus gates
//     and whose components it does not;
//   * `rotationQuaternion.w` and `.y`, which the pin deliberately does NOT
//     slerp: `evaluateSampler` takes its rotation flag from the track, and
//     `createPropertyAnimationClip` sets that flag only for the path that
//     names the quaternion itself. A component of it lerps like any number,
//     and the result is written unnormalized on both sides.
//
// The pose is pinned by the same `?seekTime=` query the corpus scenes use, so
// both sides read the frame rather than a wall clock.

import {
    addToScene,
    attachControl,
    createAnimationManager,
    createArcRotateCamera,
    createBox,
    createDirectionalLight,
    createEngine,
    createHemisphericLight,
    createPropertyAnimationClip,
    createPropertyAnimationGroup,
    createSceneContext,
    createStandardMaterial,
    goToFrame,
    registerScene,
    startAnimationManager,
    startEngine,
} from "babylon-lite";
import type { ArcRotateCamera } from "babylon-lite";

const FRAME_RATE = 10;
const END_FRAME = 2 * FRAME_RATE;

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.2, g: 0.2, b: 0.3, a: 1.0 };

    scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 3, 12, { x: 0, y: 0, z: 0 });
    scene.camera.nearPlane = 1;
    scene.camera.farPlane = 10000;
    attachControl(scene.camera as ArcRotateCamera, canvas, scene);

    addToScene(scene, createDirectionalLight([0, -1, 1], 0.75));
    addToScene(scene, createHemisphericLight([0, 1, 0], 0.5));

    const manager = createAnimationManager();

    const mover = createBox(engine);
    mover.material = createStandardMaterial();
    mover.position.set(-3.5, 0, 0);
    addToScene(scene, mover);
    const drift = createPropertyAnimationClip("drift", [
        {
            path: "position.y",
            frameRate: FRAME_RATE,
            keys: [
                { frame: 0, value: -1.5 },
                { frame: FRAME_RATE, value: 1.5 },
                { frame: END_FRAME, value: -1.5 },
            ],
        },
        {
            path: "position.z",
            frameRate: FRAME_RATE,
            keys: [
                { frame: 0, value: -1 },
                { frame: END_FRAME, value: 2 },
            ],
        },
    ]);
    const drifting = createPropertyAnimationGroup(manager, mover, drift, {
        fromFrame: 0,
        toFrame: END_FRAME,
        loop: true,
    });

    const stretcher = createBox(engine);
    stretcher.material = createStandardMaterial();
    addToScene(scene, stretcher);
    const stretch = createPropertyAnimationClip("stretch", [
        {
            path: "scaling.x",
            frameRate: FRAME_RATE,
            keys: [
                { frame: 0, value: 0.4 },
                { frame: END_FRAME, value: 2.2 },
            ],
        },
        {
            path: "scaling.z",
            frameRate: FRAME_RATE,
            keys: [
                { frame: 0, value: 2.2 },
                { frame: END_FRAME, value: 0.4 },
            ],
        },
    ]);
    const stretching = createPropertyAnimationGroup(manager, stretcher, stretch, {
        fromFrame: 0,
        toFrame: END_FRAME,
        loop: true,
    });

    const turner = createBox(engine);
    turner.material = createStandardMaterial();
    turner.position.set(3.5, 0, 0);
    addToScene(scene, turner);
    const turn = createPropertyAnimationClip("turn", [
        {
            path: "rotationQuaternion.y",
            frameRate: FRAME_RATE,
            keys: [
                { frame: 0, value: 0 },
                { frame: END_FRAME, value: 0.7 },
            ],
        },
        {
            path: "rotationQuaternion.w",
            frameRate: FRAME_RATE,
            keys: [
                { frame: 0, value: 1 },
                { frame: END_FRAME, value: 0.4 },
            ],
        },
    ]);
    const turning = createPropertyAnimationGroup(manager, turner, turn, {
        fromFrame: 0,
        toFrame: END_FRAME,
        loop: true,
    });

    const seekTime = parseFloat(new URLSearchParams(window.location.search).get("seekTime") || "");
    if (Number.isFinite(seekTime)) {
        goToFrame(drifting, seekTime * FRAME_RATE);
        goToFrame(stretching, seekTime * FRAME_RATE);
        goToFrame(turning, seekTime * FRAME_RATE);
        canvas.dataset.animationFrozen = "true";
    } else {
        startAnimationManager(manager);
    }

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
