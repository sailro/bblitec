// Project-owned differential gate: a crowd agent driven to a target.
//
// Corpus scenes 171 and 174 reach `agentGoto` and `updateNavCrowd`, but both
// register at their own `?freeze=1` pose, which folds the crowd away -- their
// step takes the FRAME DELTA, and no two engines share one, so an agent's
// drift is not a parity question. What is left measured there is the computed
// path and the navmesh overlay.
//
// This gate steps the crowd at a FIXED delta from a plain loop instead, which
// IS deterministic on both sides: the same pinned recastnavigation commit,
// the same floats, the same number of steps. It retires when a corpus scene
// drives a crowd without depending on wall-clock time.
//
// Two probes, each arranged so that ignoring the call moves the picture:
//
//   1. `computePath` draws the route the agent will take, and the navmesh
//      debug overlay is drawn under it, so the build is measured beside the
//      query.
//   2. The agent is told to go to the opposite corner and the crowd is
//      stepped 90 times at 1/60 s -- 1.5 s, which at `maxSpeed` 1.5 over the
//      ~8.5-unit diagonal leaves it MID-path. Its box is placed where it
//      ended. Drop `agentGoto` or `updateNavCrowd` and the box stays at its
//      spawn, diagonally across the ground.


import {
    addAgent,
    addToScene,
    agentGoto,
    createBox,
    createDebugNavMeshGeometry,
    createEngine,
    createFreeCamera,
    createGround,
    createHemisphericLight,
    createMeshFromData,
    createNavCrowd,
    createNavMesh,
    createNavigationPluginAsync,
    createSceneContext,
    createStandardMaterial,
    createTube,
    computePath,
    getAgentPosition,
    getClosestPoint,
    registerScene,
    startEngine,
    updateNavCrowd,
} from "babylon-lite";
async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.2, g: 0.2, b: 0.3, a: 1.0 };

    scene.camera = createFreeCamera({ x: 0, y: 9, z: -8 }, { x: 0, y: 0, z: 0 });

    const light = createHemisphericLight([0, 1, 0]);
    light.intensity = 0.9;
    addToScene(scene, light);

    const ground = createGround(engine, { width: 8, height: 8, subdivisions: 2 });
    ground.material = createStandardMaterial();
    addToScene(scene, ground);

    const nav = await createNavigationPluginAsync({ locateFile: () => "/recast-navigation.wasm" });
    createNavMesh(nav, [ground], {
        cs: 0.2,
        ch: 0.2,
        walkableSlopeAngle: 90,
        walkableHeight: 1,
        walkableClimb: 1,
        walkableRadius: 1,
    });

    const debugGeo = createDebugNavMeshGeometry(nav);
    const navDebug = createMeshFromData(engine, "navDebug", debugGeo.positions, debugGeo.normals, debugGeo.indices);
    const navDebugMat = createStandardMaterial();
    navDebugMat.diffuseColor = [0.1, 0.2, 1];
    navDebugMat.alpha = 0.25;
    navDebug.material = navDebugMat;
    navDebug.position.set(0, 0.01, 0);
    addToScene(scene, navDebug);

    // ── 1. The route, drawn ──────────────────────────────────────────────
    const pathStart = getClosestPoint(nav, { x: -3.0, y: 0.1, z: -3.0 });
    const pathEnd = getClosestPoint(nav, { x: 3.0, y: 0.1, z: 3.0 });
    const pathPoints = computePath(nav, pathStart, pathEnd);
    const pathDraw = pathPoints.map((p) => ({ x: p.x, y: p.y + 0.25, z: p.z }));
    const pathTube = createTube(engine, { path: pathDraw, radius: 0.08, tessellation: 10 });
    const pathMat = createStandardMaterial();
    pathMat.diffuseColor = [0, 0, 0];
    pathMat.emissiveColor = [1, 0, 0];
    pathTube.material = pathMat;
    addToScene(scene, pathTube);

    // ── 2. An agent driven to a target at a fixed step ───────────────────
    const crowd = createNavCrowd(nav, 4, 0.3);
    // The agent walks the drawn route, so it shares its endpoints.
    const agentSpawn = pathStart;
    const agentBox = createBox(engine, 0.5);
    const agentMat = createStandardMaterial();
    agentMat.diffuseColor = [0.9, 0.2, 0.85];
    agentMat.emissiveColor = [0.35, 0.05, 0.3];
    agentBox.material = agentMat;
    const agentIdx = addAgent(crowd, agentSpawn, {
        radius: 0.3,
        height: 0.5,
        maxAcceleration: 4,
        maxSpeed: 1.5,
        collisionQueryRange: 0.5,
        pathOptimizationRange: 0,
        separationWeight: 1,
    });

    const agentTarget = pathEnd;
    agentGoto(crowd, agentIdx, agentTarget);
    // A plain loop, not a frame callback: the delta is the gate's, so both
    // sides take the same 90 steps of the same length.
    for (let step = 0; step < 90; step++) {
        updateNavCrowd(crowd, 1 / 60);
    }
    const ended = getAgentPosition(crowd, agentIdx);
    agentBox.position.set(ended.x, ended.y + 0.25, ended.z);
    addToScene(scene, agentBox);

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
