// Project-owned differential gate: a material read back off a mesh, guarded
// by its own optional presence, and written after creation.
//
// Two contracts, both of which a scene walking `scene.meshes` needs and
// neither of which any measured corpus scene reaches:
//
//   * `mesh.material` is `Material | undefined` upstream, so the walk guards
//     on it before writing. The native handle says the same thing by holding
//     `invalid_handle` for a mesh nothing assigned, which is what the
//     truthiness test reads.
//   * `usePhysicalLightFalloff` is the pin's default-true punctual switch.
//     `_writeMaterialData` reads it as `=== false ? 0 : 1` into the material
//     UBO's falloff-mode lane, and every composed punctual arm carries both
//     falloffs and selects on that lane -- so the property composes nothing
//     and the write is one store into the lane `createPbrMaterial`'s own
//     option fills.
//
// The material is created at the pinned default and only the write turns it
// off, so the shading in the golden is the write: with the write removed the
// same scene measures 0.334 full MAD against it, peaking at 134.
//
// The corpus scenes that write it this way are 166 and 179, both of which
// build a clustered light container this port does not reach. This gate
// retires when one of them compiles.

import {
    addToScene,
    startEngine,
    createEngine,
    createSceneContext,
    createArcRotateCamera,
    createPointLight,
    createSphere,
    createPbrMaterial,
    createSolidTexture2D,
    registerScene,
} from "babylon-lite";
import type { PbrMaterialProps } from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2.4, 5, { x: 0, y: 0, z: 0 });

    // A punctual light, because the falloff lane the write moves is the
    // punctual one: a directional light reads neither arm.
    const point = createPointLight([2, 2, 2], 1.0);
    point.range = 8;
    addToScene(scene, point);

    const baseColorTex = createSolidTexture2D(engine, 0.8, 0.8, 0.82);
    const ormTex = createSolidTexture2D(engine, 1.0, 0.4, 0.0);
    const sphere = createSphere(engine, { segments: 32, diameter: 2 });
    sphere.material = createPbrMaterial({
        baseColorTexture: baseColorTex,
        ormTexture: ormTex,
    });
    addToScene(scene, sphere);

    for (const mesh of scene.meshes) {
        const mat = mesh.material as PbrMaterialProps | undefined;
        if (mat) {
            mat.usePhysicalLightFalloff = false;
        }
    }

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
