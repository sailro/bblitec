// Regression gate: mesh opacity beside scene-texture transmission.
//
// The Khronos volume/transmission testing asset draws through the scene's
// transmission pass; faded Standard and PBR planes in front of it join that
// pass's transparent list, sorted with the transmissive draws, and a plane at
// opacity 0 is skipped there. One plane crosses back to 1 after registration.

import {
    addToScene,
    createArcRotateCamera,
    createEngine,
    createPbrMaterial,
    createPlane,
    createSceneContext,
    createStandardMaterial,
    getFrameGraph,
    loadEnvironment,
    loadGltf,
    onBeforeRender,
    registerScene,
    setMeshOpacity,
    startEngine,
    type RenderTask,
} from "babylon-lite";
import type { Mesh } from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    (getFrameGraph(scene)._tasks[0] as RenderTask)._config.transmission = { copyCount: 1 };

    const camera = createArcRotateCamera(Math.PI / 2, Math.PI / 2, 1.1856086997830126, {
        x: -0.2914360649171073,
        y: 0.4,
        z: 0.3975263311541397,
    });
    camera.fov = 0.8;
    camera.nearPlane = 0.0697417;
    camera.farPlane = 6974.17;
    scene.camera = camera;

    await Promise.all([
        loadGltf(engine, "https://assets.babylonjs.com/meshes/KHR_materials_volume_testing.glb").then((asset) => addToScene(scene, asset)),
        loadEnvironment(scene, "https://assets.babylonjs.com/core/environments/environmentSpecular.env", {
            skipSkybox: true,
            skipGround: true,
            brdfUrl: "/brdf-lut.png",
        }),
    ]);

    // The camera looks down -z from +z: the planes stand between it and the
    // asset, double-sided so their facing does not matter.
    const faded = (x: number, y: number, opacity: number, pbr: boolean): Mesh => {
        const mesh = createPlane(engine, { width: 0.14, height: 0.1 });
        mesh.position.set(x, y, 0.8);
        if (pbr) {
            mesh.material = createPbrMaterial({
                baseColorFactor: [0.15, 0.4, 0.9, 1],
                metallicFactor: 0,
                roughnessFactor: 0.6,
                doubleSided: true,
            });
        } else {
            const material = createStandardMaterial();
            material.diffuseColor = [0.9, 0.3, 0.15];
            material.specularColor = [0, 0, 0];
            material.backFaceCulling = false;
            mesh.material = material;
        }
        setMeshOpacity(mesh, opacity);
        addToScene(scene, mesh);
        return mesh;
    };
    faded(-0.48, 0.48, 0.5, false);
    faded(-0.3, 0.48, 0.5, true);
    faded(-0.12, 0.48, 0, false);
    const restored = faded(-0.3, 0.34, 0.5, true);
    let frame = 0;
    onBeforeRender(scene, () => {
        frame += 1;
        if (frame === 3) setMeshOpacity(restored, 1);
    });

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
