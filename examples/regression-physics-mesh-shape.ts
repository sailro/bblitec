// `PhysicsShapeType.MESH` builds the triangle soup, not the hull of it.
//
// Scene 102 is the corpus scene for the MESH shape and it cannot observe that.
// Its two MESH colliders are `createBox(engine, 2)` meshes, so the soup and the
// bounding box are the same surface for the scene's ray -- measured: the whole
// frame is byte-identical with a BOX of the same extents standing in, on the
// Havok reference as well as here. A green gate there is therefore consistent
// with a port that never built a triangle-mesh shape at all.
//
// This gate puts the two arms of `createPhysicsShape`'s mesh path on a mesh
// where they DISAGREE. The collider is an uncapped `createTube` along Y -- a
// ribbon, so a hollow cylinder with two open ends -- and a sphere is dropped
// down its axis:
//
//   MESH        the soup has no caps, so the sphere falls through the tube
//               and comes to rest on the ground.
//   CONVEX_HULL the hull of the same points is a solid capped cylinder, so
//               the sphere rests on its top face, four units higher.
//
// Measured with the two arms swapped and nothing else changed: the foreground
// box top edge sits at y = 257 with MESH and at y = 220 with the hull, and the
// MESH arm is byte-identical to the Havok golden of the same scene (full MAD
// 0.000, 100% of pixels exactly equal, both backends). A resting pose is what
// a substituted solver can be graded on, which is why the sphere is measured
// after it has landed rather than in flight
// (`docs/fidelity.md#physics-contract`).
import {
    addToScene,
    createArcRotateCamera,
    createEngine,
    createGround,
    createHavokWorld,
    createHemisphericLight,
    createPhysicsAggregate,
    createPhysicsBody,
    createPhysicsShape,
    createSceneContext,
    createSphere,
    createStandardMaterial,
    createTube,
    PhysicsMotionType,
    PhysicsShapeType,
    registerScene,
    setPhysicsBodyShape,
    startEngine,
} from "babylon-lite";
import HavokPhysics from "@babylonjs/havok";

const PHYSICS_FPS = 60;

function makeMaterial(color: [number, number, number]) {
    const material = createStandardMaterial();
    material.diffuseColor = color;
    material.specularColor = [0, 0, 0];
    return material;
}

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.fixedDeltaMs = 1000 / PHYSICS_FPS;

    scene.camera = createArcRotateCamera(-1.2, Math.PI / 2.6, 16, { x: 0, y: 2, z: 0 });
    addToScene(scene, createHemisphericLight([0, 1, 0]));

    const hknp = await HavokPhysics({ locateFile: () => "/HavokPhysics.wasm" });
    const world = createHavokWorld(scene, hknp, { x: 0, y: -10, z: 0 });

    const ground = createGround(engine, { width: 12, height: 12 });
    ground.material = makeMaterial([0.25, 0.25, 0.28]);
    addToScene(scene, ground);
    createPhysicsAggregate(world, ground, PhysicsShapeType.BOX, { mass: 0 });

    // The hollow collider: an open tube from y = 0 to y = 4, radius 1.
    const tube = createTube(engine, {
        path: [
            { x: 0, y: 0, z: 0 },
            { x: 0, y: 4, z: 0 },
        ],
        radius: 1,
        tessellation: 24,
    });
    tube.material = makeMaterial([0.35, 0.6, 0.85]);
    addToScene(scene, tube);

    const shape = createPhysicsShape(world, { type: PhysicsShapeType.MESH, mesh: tube });
    const tubeBody = createPhysicsBody(world, tube, PhysicsMotionType.STATIC);
    setPhysicsBodyShape(world, tubeBody, shape);

    // The falling sphere, on the tube's axis and small enough to clear it.
    const ball = createSphere(engine, { diameter: 0.6, segments: 24 });
    ball.material = makeMaterial([0.95, 0.75, 0.2]);
    ball.position.set(0, 7, 0);
    addToScene(scene, ball);
    createPhysicsAggregate(world, ball, PhysicsShapeType.SPHERE, { mass: 1, restitution: 0 });

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
