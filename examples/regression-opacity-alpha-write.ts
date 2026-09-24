// Regression gate: an `alpha` write on an opacity-textured Standard material
// keeps it blended.
//
// The pin buckets a Standard renderable as transparent from
// `!shadowOutput && ((features & HAS_OPACITY_TEXTURE) !== 0 || mat.alpha < 1
// || colorAlphaBlend)`, so the opacity texture alone keeps a material in the
// blended pass whatever its alpha. Sponza's .babylon materials carry opacity
// textures on the foliage and fabric; writing `alpha = 1` on every material
// before registration leaves those blended.

import {
    addToScene,
    startEngine,
    createEngine,
    createSceneContext,
    createArcRotateCamera,
    loadBabylon,
    registerScene,
} from "babylon-lite";
import type { StandardMaterialProps } from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    addToScene(scene, await loadBabylon(engine, "https://www.babylonjs.com/Scenes/Sponza/Sponza.babylon", { loadCamera: false }));

    for (const mesh of scene.meshes) {
        const mat = mesh.material as StandardMaterialProps | undefined;
        if (mat) {
            mat.alpha = 1;
        }
    }

    scene.camera = createArcRotateCamera(0, Math.PI / 2.2, 0.01, { x: 5.0855, y: 2.492, z: 0.1654 });
    scene.camera.nearPlane = 0.1;
    scene.camera.farPlane = 10000;

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
