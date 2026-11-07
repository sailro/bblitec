// Regression gate: mesh opacity written at run time, after registration.
//
// The top row crosses 1 in the scene's own pass: Standard and PBR planes go
// below 1 and back, and to 0 and back, from a frame callback. The bottom row
// shows two explicit render tasks drawing the same off-screen meshes: the
// left one keeps the bindings its record resolved; the right one follows its
// meshes with enableRenderTaskMeshRefresh, except an entry carrying a per-task
// material override. Below 1 a resolved transparent binding updates live in
// both, to 0 and back included.

import {
    addMeshToTask,
    addTaskAtStart,
    addToScene,
    createArcRotateCamera,
    createEngine,
    createFreeCamera,
    createHemisphericLight,
    createPbrMaterial,
    createPlane,
    createRenderTargetTexture,
    createRenderTask,
    createSceneContext,
    createStandardMaterial,
    enableRenderTaskMeshRefresh,
    onBeforeRender,
    registerScene,
    setMeshOpacity,
    startEngine,
} from "babylon-lite";
import type { Mesh } from "babylon-lite";
import { standard } from "./regression-mesh-opacity-planes.js";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.1, g: 0.11, b: 0.16, a: 1 };
    const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 16, { x: 0, y: 0, z: 0 });
    camera.nearPlane = 0.1;
    camera.farPlane = 400;
    scene.camera = camera;
    addToScene(scene, createHemisphericLight([0, 1, -1], 0.95));

    const plane = (x: number, y: number, z: number, width: number, height: number): Mesh => {
        const mesh = createPlane(engine, { width, height });
        mesh.position.set(x, y, z);
        return mesh;
    };

    // A backdrop behind the top row, so a fade blends over something.
    const backdrop = plane(0, 2.4, 1, 17, 3.2);
    backdrop.material = standard(0.75, 0.75, 0.72);
    addToScene(scene, backdrop);

    // The top row: [x, family, starting opacity, [frame, opacity] writes].
    const crossings: readonly (readonly [number, "standard" | "pbr", number, readonly (readonly [number, number])[]])[] = [
        [-6.25, "standard", 1, [[3, 0.5]]],
        [-3.75, "standard", 0.5, [[3, 1]]],
        [-1.25, "standard", 1, [[3, 0], [6, 0.6]]],
        [1.25, "pbr", 1, [[3, 0.4], [6, 1]]],
        [3.75, "pbr", 0.5, [[3, 0], [6, 0.7]]],
        [6.25, "pbr", 1, [[3, 0]]],
    ];
    const writes: { frame: number; mesh: Mesh; opacity: number }[] = [];
    for (const [x, family, opacity, steps] of crossings) {
        const mesh = plane(x, 2.4, 0, 2, 2.4);
        mesh.material =
            family === "standard"
                ? standard(0.85, 0.25, 0.12)
                : createPbrMaterial({ baseColorFactor: [0.15, 0.4, 0.9, 1], metallicFactor: 0, roughnessFactor: 0.8 });
        setMeshOpacity(mesh, opacity);
        addToScene(scene, mesh);
        for (const [frame, value] of steps) writes.push({ frame, mesh, opacity: value });
    }

    // The task meshes live far below the scene camera's view; each task's
    // own camera frames them.
    const taskBackdrop = plane(0, -100, 1, 8, 5);
    taskBackdrop.material = standard(0.7, 0.72, 0.75);
    addToScene(scene, taskBackdrop);
    const crossesBelow = plane(-2.2, -100, 0, 1.8, 3);
    crossesBelow.material = standard(0.9, 0.2, 0.15);
    addToScene(scene, crossesBelow);
    const fadesLive = plane(0, -100, 0, 1.8, 3);
    fadesLive.material = createPbrMaterial({ baseColorFactor: [0.15, 0.45, 0.95, 1], metallicFactor: 0, roughnessFactor: 0.8 });
    setMeshOpacity(fadesLive, 0.5);
    addToScene(scene, fadesLive);
    const overridden = plane(2.2, -100, 0, 1.8, 3);
    overridden.material = standard(0.2, 0.8, 0.3);
    addToScene(scene, overridden);
    writes.push(
        { frame: 3, mesh: crossesBelow, opacity: 0.5 },
        { frame: 3, mesh: fadesLive, opacity: 0 },
        { frame: 6, mesh: fadesLive, opacity: 0.8 },
        { frame: 3, mesh: overridden, opacity: 0.5 }
    );

    const taskCamera = createFreeCamera({ x: 0, y: -100, z: -7 }, { x: 0, y: -100, z: 0 });
    taskCamera.nearPlane = 0.1;
    taskCamera.farPlane = 100;
    const overrideMaterial = standard(0.95, 0.85, 0.2);
    const showTask = (name: string, x: number, refresh: boolean): void => {
        const { rt, texture } = createRenderTargetTexture(engine, {
            lbl: name,
            format: engine.format,
            dFormat: "depth24plus-stencil8",
            samples: 1,
            size: { width: 256, height: 256 },
        });
        const task = createRenderTask(
            { name, rt, clrColor: { r: 0.2, g: 0.15, b: 0.25, a: 1 }, cam: taskCamera, cs: true, autoMirror: false },
            engine,
            scene
        );
        if (refresh) enableRenderTaskMeshRefresh(task);
        addTaskAtStart(scene, task);
        addMeshToTask(task, taskBackdrop);
        addMeshToTask(task, crossesBelow);
        addMeshToTask(task, fadesLive);
        if (refresh) addMeshToTask(task, overridden, { material: overrideMaterial });
        else addMeshToTask(task, overridden);
        const screen = plane(x, -2.4, 0, 4, 4);
        const material = createStandardMaterial();
        material.diffuseTexture = texture;
        material.specularColor = [0, 0, 0];
        screen.material = material;
        addToScene(scene, screen);
    };
    showTask("retained", -3, false);
    showTask("refreshed", 3, true);

    let frame = 0;
    onBeforeRender(scene, () => {
        frame += 1;
        for (const write of writes) {
            if (write.frame === frame) setMeshOpacity(write.mesh, write.opacity);
        }
    });

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
