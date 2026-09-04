// The aggregate's explicit geometry options, gated where a substituted
// solver has no phase: at rest.
//
// `_buildShapeParams` sizes a primitive from the node's own bounds and lets
// `options.center`, `radius`, `pointA`, `pointB` and `extents` override each
// derived term through the pin's own `??`. Every body below is given an
// override that DIFFERS from what its mesh would derive, so a port that
// accepted the option and dropped it puts the body at a different resting
// height -- which is the one physics property a rigid-body substitution
// cannot move (a resting pose has no phase, and a shape rests at its own
// geometric height). The mesh is only the picture here; the collider the
// options size is what each body rests on.
//
// Derived (what the mesh gives) versus written, per body:
//
//   sphere    centre (0, 0, 0)                  -> (0, 0.5, 0)     rests 1.0 -> 0.5
//   cylinder  radius 1, segment -1 .. 1         -> 0.5, -0.5 .. 0.5  rests 1.0 -> 0.5
//   capsule   radius 1, segment 0 .. 0          -> 0.25, -0.5 .. 0.5 rests 1.0 -> 0.75
//   box       extents (2, 2, 2), centre (0,0,0) -> (1, 1, 1), (0, 0.75, 0)
//                                                                  rests 1.0 -> -0.25
//
// The sixth body carries `setPhysicsBodyPrestepType`: the pin turns pre-step
// syncing ON for any type but DISABLED, so naming TELEPORT is what makes the
// node writes below reach the body at all. Without that arm the body ignores
// them and rests where it was created, four units away.
import {
    addToScene,
    createBox,
    createCylinder,
    createEngine,
    createFreeCamera,
    createGround,
    createHavokWorld,
    createHemisphericLight,
    createPhysicsAggregate,
    createSceneContext,
    createSphere,
    createStandardMaterial,
    onPhysicsAfterStep,
    PhysicsPrestepType,
    PhysicsShapeType,
    registerScene,
    setPhysicsBodyPrestepType,
    startEngine,
} from "babylon-lite";
import HavokPhysics from "@babylonjs/havok";

const PHYSICS_FPS = 60;
// How long the prestep body is driven from its node before it is let go.
const TELEPORT_STEPS = 30;

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.fixedDeltaMs = 1000 / PHYSICS_FPS;

    scene.camera = createFreeCamera({ x: 3, y: 7, z: -18 }, { x: 3, y: 0, z: 0 });

    const light = createHemisphericLight([0, 1, 0]);
    light.intensity = 0.9;
    addToScene(scene, light);

    const ground = createGround(engine, { width: 30, height: 30 });
    ground.material = createStandardMaterial();
    addToScene(scene, ground);

    const sphere = createSphere(engine, { diameter: 2, segments: 24 });
    const sphereMaterial = createStandardMaterial();
    sphereMaterial.diffuseColor = [0.85, 0.3, 0.3];
    sphere.material = sphereMaterial;
    sphere.position.set(-7, 0.9, 0);
    addToScene(scene, sphere);

    const cylinder = createCylinder(engine, { diameter: 2, height: 2 });
    const cylinderMaterial = createStandardMaterial();
    cylinderMaterial.diffuseColor = [0.3, 0.75, 0.35];
    cylinder.material = cylinderMaterial;
    cylinder.position.set(-3, 0.9, 0);
    addToScene(scene, cylinder);

    const capsule = createCylinder(engine, { diameter: 2, height: 2 });
    const capsuleMaterial = createStandardMaterial();
    capsuleMaterial.diffuseColor = [0.3, 0.45, 0.85];
    capsule.material = capsuleMaterial;
    capsule.position.set(1, 1.15, 0);
    addToScene(scene, capsule);

    const box = createBox(engine, 1);
    box.scaling.set(2, 2, 2);
    const boxMaterial = createStandardMaterial();
    boxMaterial.diffuseColor = [0.9, 0.8, 0.3];
    box.material = boxMaterial;
    box.position.set(5, 0.15, 0);
    addToScene(scene, box);

    const driven = createBox(engine, 1);
    const drivenMaterial = createStandardMaterial();
    drivenMaterial.diffuseColor = [0.8, 0.35, 0.8];
    driven.material = drivenMaterial;
    driven.position.set(9, 0.9, 0);
    addToScene(scene, driven);

    const hknp = await HavokPhysics({ locateFile: () => "/HavokPhysics.wasm" });
    const world = createHavokWorld(scene, hknp, { x: 0, y: -9.8, z: 0 });

    createPhysicsAggregate(world, ground, PhysicsShapeType.BOX, { mass: 0 });

    createPhysicsAggregate(world, sphere, PhysicsShapeType.SPHERE, {
        mass: 1,
        center: { x: 0, y: 0.5, z: 0 },
    });
    createPhysicsAggregate(world, cylinder, PhysicsShapeType.CYLINDER, {
        mass: 1,
        radius: 0.5,
        pointA: { x: 0, y: -0.5, z: 0 },
        pointB: { x: 0, y: 0.5, z: 0 },
    });
    createPhysicsAggregate(world, capsule, PhysicsShapeType.CAPSULE, {
        mass: 1,
        radius: 0.25,
        pointA: { x: 0, y: -0.5, z: 0 },
        pointB: { x: 0, y: 0.5, z: 0 },
    });
    createPhysicsAggregate(world, box, PhysicsShapeType.BOX, {
        mass: 1,
        extents: { x: 1, y: 1, z: 1 },
        center: { x: 0, y: 0.75, z: 0 },
    });

    const drivenAggregate = createPhysicsAggregate(world, driven, PhysicsShapeType.BOX, {
        mass: 1,
    });
    setPhysicsBodyPrestepType(drivenAggregate.body, PhysicsPrestepType.TELEPORT);

    let steps = 0;
    onPhysicsAfterStep(world, () => {
        steps++;
        if (steps <= TELEPORT_STEPS) {
            // Moved four units across, which is somewhere the body's own fall
            // would never have taken it, and then let go to settle there.
            driven.position.set(13, 0.9, 0);
        }
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
