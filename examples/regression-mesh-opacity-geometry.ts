// Regression gate: mesh opacity in a geometry renderer task.
//
// A faded Standard plane and a faded PBR plane cross an opaque bar in front
// of a backdrop; a third plane is at opacity 0 and a fourth crossed back to 1
// after registration. The scene's own pass fills the top of the frame and the
// geometry task's colour output and albedo fill the bottom half: a faded mesh
// is a blended participant there (its policy runs before the 0.4 discard),
// and one at 0 draws nothing.

import {
    addTask,
    addTaskAtStart,
    addToScene,
    createArcRotateCamera,
    createBox,
    createCopyToTextureTask,
    createEngine,
    createGeometryRendererTask,
    createHemisphericLight,
    createPbrMaterial,
    createPlane,
    createRenderTarget,
    createRenderTask,
    createSceneContext,
    GeometryTextureType,
    registerScene,
    startEngine,
} from "babylon-lite";
import type { Mesh } from "babylon-lite";
import { fadedPlane, restoreOnThirdFrame, standard } from "./regression-mesh-opacity-planes.js";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine, { defaultRenderTask: false });
    scene.clearColor = { r: 0.12, g: 0.12, b: 0.18, a: 1 };
    const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 9, { x: 0, y: 0, z: 0 });
    camera.nearPlane = 0.1;
    camera.farPlane = 100;
    scene.camera = camera;
    addToScene(scene, createHemisphericLight([0, 1, -1], 1));

    const backdrop = createPlane(engine, { width: 12, height: 6 });
    backdrop.position.z = 2;
    backdrop.material = standard(0.7, 0.7, 0.68);
    addToScene(scene, backdrop);
    const bar = createBox(engine, { width: 10, height: 0.8, depth: 0.4 });
    bar.position.z = 1;
    bar.material = standard(0.15, 0.6, 0.3);
    addToScene(scene, bar);

    const faded = (x: number, opacity: number, pbr: boolean): Mesh =>
        fadedPlane(
            engine,
            scene,
            1.8,
            3,
            x,
            0,
            0,
            pbr
                ? createPbrMaterial({ baseColorFactor: [0.15, 0.4, 0.9, 1], metallicFactor: 0, roughnessFactor: 0.8 })
                : standard(0.9, 0.3, 0.15),
            opacity
        );
    faded(-3.3, 0.5, false);
    faded(-1.1, 0.5, true);
    faded(1.1, 0, false);
    restoreOnThirdFrame(scene, faded(3.3, 0.4, true));

    const intermediate = createRenderTarget({
        lbl: "regression-mesh-opacity-geometry",
        format: engine.format,
        dFormat: "depth24plus-stencil8",
        samples: 1,
        size: engine,
    });
    const color = createRenderTarget({
        lbl: "regression-mesh-opacity-geometry-color",
        format: engine.format,
        samples: 1,
        size: engine,
    });
    addTaskAtStart(
        scene,
        createRenderTask({ name: "scene", rt: intermediate, clrColor: scene.clearColor, clr: true }, engine, scene)
    );
    const geometry = createGeometryRendererTask(
        {
            name: "geometry",
            samples: 1,
            textureDescriptions: [{ type: GeometryTextureType.ALBEDO }],
            targetTexture: color,
            targetTextureClearColor: { r: 0, g: 0, b: 0, a: 1 },
        },
        engine,
        scene
    );
    addTask(scene, geometry);
    const tiles = [
        { name: "color", source: geometry.outputTexture! },
        { name: "albedo", source: geometry.geometryAlbedoTexture! },
    ];
    for (let i = 0; i < tiles.length; i++) {
        const tile = tiles[i]!;
        addTask(
            scene,
            createCopyToTextureTask(
                {
                    name: `tile-${tile.name}`,
                    sourceTexture: tile.source,
                    targetTexture: intermediate,
                    viewport: { x: i * 0.5, y: 0, width: 0.5, height: 0.5 },
                },
                engine,
                scene
            )
        );
    }
    addTask(
        scene,
        createCopyToTextureTask({ name: "present", sourceTexture: intermediate, targetTexture: engine.scRT }, engine, scene)
    );

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
