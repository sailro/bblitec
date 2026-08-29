// Regression gate: a light's properties written after creation.
//
// A light vector upstream is an `ObservableVec3`, so `set(x, y, z)` moves the
// field and marks the light's local matrix dirty; the next read rebuilds it.
// The spot here is created at the origin shining straight up — away from the
// ground entirely — and only the setters put it over the plane, so the cone in
// the golden is the whole proof that both writes landed.
//
// The cone's own three scalars are written the same way. `range` and
// `exponent` are plain number fields on the pinned spot; `angle` is the one
// accessor in the light family, and its setter recomputes the cone cosine the
// UBO writer packs. Each is created at a value that renders nothing usable —
// a cone so wide it is a flood light, an exponent that flattens the falloff,
// an unbounded range — so the shaded ellipse in the golden is what the three
// writes produced. Scenes 202 and 203 corpus-measure the `range` write; the
// other two have no corpus scene, since none writes a cone after creation.
//
// What the golden measures is the field write: the pinned per-frame light
// writers rebuild a light's world matrix from `position` and `direction`
// themselves. The eager `LightRecord::local_matrix` rebuild each setter also
// performs is what the CPU raster path reads, and `test/upstream.test.ts` is
// what holds the setters to it.
//
// Scenes 4 and 22 now ship and both write `light.position.set` at scene
// scope, so the position half is corpus-measured. The DIRECTION half is not:
// scene 4's `spot.direction.set` sits inside an `onBeforeRender` behind an
// `orbitingSpot` toggle a button turns on, so the shipped golden compiles
// that write without ever running it. This gate retires when a corpus scene
// renders a cone the direction setter moved -- 141, 207 and 223 each reach
// one, and each is blocked on another contract.

import {
    addToScene,
    startEngine,
    createEngine,
    createSceneContext,
    createArcRotateCamera,
    createDirectionalLight,
    createSpotLight,
    createGround,
    createStandardMaterial,
    attachControl,
    registerScene,
} from "babylon-lite";
import type { ArcRotateCamera } from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 4, 5, { x: 0, y: 0, z: 0 });
    scene.camera.nearPlane = 1;
    scene.camera.farPlane = 10000;
    attachControl(scene.camera as ArcRotateCamera, canvas, scene);

    const spot = createSpotLight([0, 0, 0], [0, 1, 0], Math.PI / 2, 10);
    spot.position.set(-1, 1, -1);
    spot.direction.set(0, -1, 0);
    spot.diffuse = [1, 0, 0];
    spot.specular = [0, 1, 0];
    spot.angle = Math.PI / 5;
    spot.exponent = 2;
    spot.range = 6;
    addToScene(scene, spot);

    // A directional light packs its world matrix column 2, so its position
    // reaches no pixel — every corpus scene that writes one is aiming a shadow
    // camera. The gate carries it so the entry point is compiled and linked.
    const sun = createDirectionalLight([0, -1, 0], 0.3);
    sun.position.set(30, 40, 30);
    addToScene(scene, sun);

    const ground = createGround(engine, { width: 4, height: 4 });
    ground.material = createStandardMaterial();
    addToScene(scene, ground);

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
