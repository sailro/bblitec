// Regression gate: an `alpha` write on a glTF BLEND material keeps it blended.
//
// The pin buckets a PBR renderable as transparent from
// `_computePbrMaterialFeatures`'s blend term, `mat.alphaBlend === true ||
// ((mat._alphaCutOff ?? 0) <= 0 && mat.alpha < 1)`. The glTF loader sets
// `alphaBlend: true` for a BLEND material, so writing `alpha = 1` afterwards
// leaves it blended: `Partial_Coating` below keeps its textured alpha over
// the base sphere. Every material is written, so an opaque-authored one that
// took the write as a blend decision would show as well.

import {
    addToScene,
    startEngine,
    createEngine,
    createSceneContext,
    createDefaultCamera,
    createHemisphericLight,
    loadGltf,
    registerScene,
} from "babylon-lite";
import type { PbrMaterialProps } from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    addToScene(scene, await loadGltf(engine, "https://assets.babylonjs.com/meshes/ClearCoatTest/ClearCoatTest.gltf"));
    addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));

    for (const mesh of scene.meshes) {
        const mat = mesh.material as PbrMaterialProps | undefined;
        if (mat) {
            mat.alpha = 1;
        }
    }

    const cam = createDefaultCamera(scene);
    cam.alpha += Math.PI;

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
