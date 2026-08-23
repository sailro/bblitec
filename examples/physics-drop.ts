// A rigid-body drop: scene 40's physics, with its pose pinned the way this
// repository pins every other animated pose.
//
// The corpus scene reads `?captureFrame=` off its own URL to decide when the
// browser harness stops; native has no harness to stop and pins a measured
// frame with `BBLITE_MAX_FRAMES` / `BBLITE_SCREENSHOT_FRAME` instead. The
// scene is otherwise scene 40 term for term: the same camera, light, meshes,
// materials, gravity, shapes, mass and restitution, and the same
// `fixedDeltaMs` that makes one render frame exactly one physics step.
import {
    addToScene,
    createEngine,
    createFreeCamera,
    createGround,
    createHavokWorld,
    createHemisphericLight,
    createPhysicsAggregate,
    createSceneContext,
    createSphere,
    createStandardMaterial,
    PhysicsShapeType,
    registerScene,
    startEngine,
} from "babylon-lite";
import HavokPhysics from "@babylonjs/havok";

const PHYSICS_FPS = 60;

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    // One physics step per render frame, which is what makes a frame count a
    // step count on both sides.
    scene.fixedDeltaMs = 1000 / PHYSICS_FPS;

    scene.camera = createFreeCamera({ x: 0, y: 5, z: -10 }, { x: 0, y: 0, z: 0 });

    const light = createHemisphericLight([0, 1, 0]);
    light.intensity = 0.7;
    addToScene(scene, light);

    const sphere = createSphere(engine, { diameter: 2, segments: 32 });
    sphere.material = createStandardMaterial();
    sphere.position.set(0, 4, 0);
    addToScene(scene, sphere);

    const ground = createGround(engine, { width: 10, height: 10 });
    ground.material = createStandardMaterial();
    addToScene(scene, ground);

    const hknp = await HavokPhysics({ locateFile: () => "/HavokPhysics.wasm" });
    const world = createHavokWorld(scene, hknp, { x: 0, y: -9.8, z: 0 });

    createPhysicsAggregate(world, sphere, PhysicsShapeType.SPHERE, {
        mass: 1,
        restitution: 0.75,
    });
    createPhysicsAggregate(world, ground, PhysicsShapeType.BOX, {
        mass: 0,
    });

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.ready = "true";
}

main().catch((err) => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = err instanceof Error ? err.message : String(err);
    }
    console.error(err);
});
