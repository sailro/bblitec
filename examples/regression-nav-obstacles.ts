// Project-owned differential gate: an obstacle removed from a tile cache.
//
// Corpus scenes 172 and 173 reach the tile-cache build and both obstacle
// factories, but the one call that takes an obstacle BACK -- `removeObstacle`
// -- sits inside scene 173's `if (!freeze)` branch, and both scenes register
// at their own `?freeze=1` pose because their crowd steps on the frame delta.
// So the removal, and the nullable handle a scene holds it in, compile away
// there and nothing measures them.
//
// This gate removes an obstacle from a plain statement instead, which is
// deterministic on both sides: the same pinned recastnavigation commit, the
// same tiles, the same re-mesh. It retires when a corpus scene removes an
// obstacle without depending on wall-clock time.
//
// Three probes, each arranged so that ignoring the call moves the picture:
//
//   1. Two obstacles are added, and the path drawn AROUND them: a red tube
//      from one corner to the other, bending twice. Drop either add and the
//      tube straightens.
//   2. The box obstacle is then removed and the path recomputed, drawn in
//      green. The two routes differ exactly where the box was, so a
//      `removeObstacle` that did nothing would put the green tube under the
//      red one and hide it.
//   3. The navmesh debug overlay is rebuilt AFTER the removal and its mesh
//      name re-pointed at the new geometry, so the blue overlay shows the
//      re-meshed tiles rather than the ones the box carved. The handle is
//      held in a name the gate clears to null and guards, which is the shape
//      upstream's own `ObstacleHandle | null` has.

import {
    addBoxObstacle,
    addCylinderObstacle,
    addToScene,
    computePath,
    createDebugNavMeshGeometry,
    createEngine,
    createFreeCamera,
    createGround,
    createHemisphericLight,
    createMeshFromData,
    createNavMesh,
    createNavigationPluginAsync,
    createSceneContext,
    createStandardMaterial,
    createTube,
    getClosestPoint,
    registerScene,
    removeFromScene,
    removeObstacle,
    startEngine,
    updateNavMeshObstacles,
} from "babylon-lite";
import type { ObstacleHandle } from "babylon-lite";

const BOX_POS = { x: -1.5, y: 0.5, z: 0.5 };
const BOX_HALF = { x: 0.9, y: 0.9, z: 0.9 };
const CYL_POS = { x: 1.6, y: 0, z: -1.4 };

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
    // `maxObstacles > 0` is what selects the tile-cache build; the tile size
    // is the gate's own, so the grid is a fixed 4x4 over this ground.
    createNavMesh(nav, [ground], {
        cs: 0.1,
        ch: 0.05,
        tileSize: 24,
        maxObstacles: 8,
    });

    // ── 1. Two obstacles, and the route that bends around them ──────────
    addCylinderObstacle(nav, CYL_POS, 0.9, 0.5);
    let boxObstacle: ObstacleHandle | null = addBoxObstacle(nav, BOX_POS, BOX_HALF, 0.3);
    updateNavMeshObstacles(nav);

    const routeStart = getClosestPoint(nav, { x: -3.2, y: 0, z: 3.2 });
    const routeEnd = getClosestPoint(nav, { x: 3.2, y: 0, z: -3.2 });

    const blockedPath = computePath(nav, routeStart, routeEnd);
    const blockedTube = createTube(engine, {
        path: blockedPath.map((p) => ({ x: p.x, y: p.y + 0.3, z: p.z })),
        radius: 0.06,
        tessellation: 10,
    });
    const blockedMat = createStandardMaterial();
    blockedMat.diffuseColor = [0, 0, 0];
    blockedMat.emissiveColor = [1, 0, 0];
    blockedTube.material = blockedMat;
    addToScene(scene, blockedTube);

    // ── 3. The overlay of the navmesh the box carved ────────────────────
    const carvedGeo = createDebugNavMeshGeometry(nav);
    let navDebug = createMeshFromData(engine, "navDebug", carvedGeo.positions, carvedGeo.normals, carvedGeo.indices);
    const navDebugMat = createStandardMaterial();
    navDebugMat.diffuseColor = [0.1, 0.2, 1];
    navDebugMat.alpha = 0.25;
    navDebug.material = navDebugMat;
    navDebug.position.set(0, 0.01, 0);
    addToScene(scene, navDebug);

    // ── 2. Drop the box, re-mesh its tiles, and take the route again ────
    if (boxObstacle) {
        removeObstacle(nav, boxObstacle);
        boxObstacle = null;

        // The overlay belongs to the navmesh, so it is rebuilt with it and
        // the name re-pointed at the mesh that replaced it.
        removeFromScene(scene, navDebug);
        const clearedGeo = createDebugNavMeshGeometry(nav);
        navDebug = createMeshFromData(engine, "navDebug", clearedGeo.positions, clearedGeo.normals, clearedGeo.indices);
        navDebug.material = navDebugMat;
        navDebug.position.set(0, 0.01, 0);
        addToScene(scene, navDebug);
    }

    const clearedPath = computePath(nav, routeStart, routeEnd);
    const clearedTube = createTube(engine, {
        path: clearedPath.map((p) => ({ x: p.x, y: p.y + 0.5, z: p.z })),
        radius: 0.06,
        tessellation: 10,
    });
    const clearedMat = createStandardMaterial();
    clearedMat.diffuseColor = [0, 0, 0];
    clearedMat.emissiveColor = [0.1, 1, 0.2];
    clearedTube.material = clearedMat;
    addToScene(scene, clearedTube);

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
