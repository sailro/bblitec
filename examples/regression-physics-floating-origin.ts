// Multi-region floating origin, gated where the mechanism is the only thing
// that can produce the pose.
//
// Corpus scene 209 compiles `enableHavokFloatingOrigin` and places two bodies
// in one region, and it measures 0.000 against its browser golden -- but it
// measures 0.000 with the call removed too. Its drop is precision-degenerate:
// both bodies sit at exactly x = z = 5e6, which is a multiple of the 0.5 the
// float32 solver quantizes to at that magnitude, and a purely vertical fall
// never leaves that grid. Nothing in it reaches `_reRegionBody` or
// `_gcRegions` either. So this scene exists for the three contracts no corpus
// scene exercises:
//
// 1. **Region-local storage is what keeps the pose.** The sphere is dropped at
//    `OFFSET + 0.3`, which float32 CANNOT represent at 5e6 -- the nearest
//    representable neighbours are `OFFSET` and `OFFSET + 0.5`. Simulated in
//    region-local coordinates the 0.3 is exact and the sphere rests under
//    where it was dropped; simulated at raw world coordinates it snaps to
//    `OFFSET + 0.5` and rests 0.2 units away in both x and z.
// 2. **A body migrates between regions with its velocity.** The capture radius
//    is 10, so the 20% hysteresis margin is 12: the sphere is dropped 14 units
//    above the ground, crosses that margin mid-fall, and joins the region the
//    ground already made. `HP_World_AddBody` does not carry velocity, so a
//    migration that dropped it would leave the sphere falling from rest and
//    land it late. The geometry also picks the SECOND of `_reRegionBody`'s
//    three lookups: at the crossing the body is falling at 15 m/s, so the
//    one-second look-ahead overshoots every region and it is the body's own
//    position that finds the ground's.
// 3. **An emptied region is reclaimed.** The sphere's own launch region holds
//    nothing once it has migrated, and `_gcRegions` releases it that step.
//
// Bodies in different regions do not collide -- they are different solver
// worlds -- so the radius has to be large enough that a falling body lands in
// the region its ground is in. It is not a free parameter: with a radius of 5
// this scene's sphere re-regions into a region of its own on every crossing
// and falls past the ground for ever. That is the pin's behaviour too (the
// browser reference does exactly the same), which is why the radius here is
// chosen against the drop rather than minimized.
//
// The pose is at rest, which is where a substituted rigid-body solver has no
// phase: a sphere of radius 1 on a ground plane rests at y = 1.0 whichever
// solver put it there, and the lateral rest position is the drop point.
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
    enableHavokFloatingOrigin,
    PhysicsShapeType,
    registerScene,
    startEngine,
} from "babylon-lite";
import HavokPhysics from "@babylonjs/havok";

const PHYSICS_FPS = 60;

// Far enough out that float32 spaces its representable values 0.5 apart.
const OFFSET = 5_000_000;
// The lateral placement that grid cannot hold.
const DROP = 0.3;
// Small enough that this fall crosses `radius * 1.2` and re-regions, large
// enough that the crossing lands the body in the region holding the ground.
const REGION_RADIUS = 10;
// Fourteen units above the ground, so the crossing happens in free fall and
// the ground is far enough from the drop point to seed a region of its own.
const DROP_HEIGHT = 15;

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas, {
        useHighPrecisionMatrix: true,
        useFloatingOrigin: true,
    });
    const scene = createSceneContext(engine);
    scene.fixedDeltaMs = 1000 / PHYSICS_FPS;

    // Close enough that the 0.2-unit lateral error a raw-world simulation
    // makes is tens of pixels rather than one.
    scene.camera = createFreeCamera(
        { x: OFFSET, y: 4, z: OFFSET - 7 },
        { x: OFFSET, y: 1, z: OFFSET },
    );

    const light = createHemisphericLight([0, 1, 0]);
    light.intensity = 0.9;
    addToScene(scene, light);

    const ground = createGround(engine, { width: 10, height: 10 });
    ground.material = createStandardMaterial();
    ground.position.set(OFFSET, 0, OFFSET);
    addToScene(scene, ground);

    const sphere = createSphere(engine, { diameter: 2, segments: 32 });
    const sphereMaterial = createStandardMaterial();
    sphereMaterial.diffuseColor = [0.85, 0.3, 0.3];
    sphere.material = sphereMaterial;
    sphere.position.set(OFFSET + DROP, DROP_HEIGHT, OFFSET + DROP);
    addToScene(scene, sphere);

    const hknp = await HavokPhysics({ locateFile: () => "/HavokPhysics.wasm" });
    const world = createHavokWorld(scene, hknp, { x: 0, y: -9.8, z: 0 });
    // Before any body: the pin builds each region as a body is placed, so a
    // world opted in after creation would already hold bodies in the base one.
    await enableHavokFloatingOrigin(world, REGION_RADIUS);

    // The sphere is placed first, so ITS position centres the first region and
    // the ground -- fifteen units below it, past the capture radius -- makes a
    // second. The sphere then migrates into the ground's on its way down.
    createPhysicsAggregate(world, sphere, PhysicsShapeType.SPHERE, {
        mass: 1,
        restitution: 0.2,
    });
    createPhysicsAggregate(world, ground, PhysicsShapeType.BOX, { mass: 0 });

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
