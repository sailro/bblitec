// @ts-nocheck -- compiled against the pinned Babylon Lite declarations by bblitec.
import HavokPhysics from "@babylonjs/havok";
import { createEngine, createSceneContext, createArcRotateCamera, createBox, createHavokWorld,
    createPhysicsAggregate, createPhysicsViewer, showPhysicsBody, PhysicsShapeType, registerScene, startEngine } from "babylon-lite";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const engine = await createEngine(canvas);
const scene = createSceneContext(engine);
scene.camera = createArcRotateCamera(-1.5, 1.2, 8, { x: 0, y: 0, z: 0 });
const world = createHavokWorld(scene, await HavokPhysics());
const mesh = createBox(engine, { size: 2 });
const aggregate = createPhysicsAggregate(world, mesh, PhysicsShapeType.BOX, { mass: 0 });
const viewer = createPhysicsViewer(scene, world);
showPhysicsBody(viewer, aggregate.body);
registerScene(scene);
startEngine(engine);
canvas.dataset.ready = "true";
