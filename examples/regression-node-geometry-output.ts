// Regression gate: a node material drawn by the frame-graph geometry renderer.
//
// Every shipped node-material scene draws its graph through the COLOUR view,
// and every shipped geometry-renderer scene (145, 146) draws Standard and PBR
// materials. Nothing in the corpus makes a geometry task draw a node graph, so
// nothing exercises `material/node/node-geometry-view.ts` — the third module a
// graph composes, emitted from its own `GeometryTextureOutputBlock` terminal
// rather than from `FragmentOutputBlock`.
//
// What the picture measures, in the bottom strip:
//   task A (three attachments, and the graph leaves normalizedViewDepth to the
//     pin's own world-position fallback, so this view declares `NmeGeomParams`
//     and reads the task's camera near/far out of it)
//       worldNormal, normalizedViewDepth, worldPosition
//   task B (two attachments, no depth lane, so this view declares no
//     `NmeGeomParams` at all)
//       albedo, reflectivity
//
// So the strip moves if either view's own vertex inputs, texture pair, uniform
// block or geometry-params binding is bound from the colour view's rows, if
// the MRT pipeline is built with one colour target instead of the task's, or if
// the two views share a slot.
//
// LOCAL_POSITION is deliberately absent. `geomWrite` writes that lane from the
// graph's own input -- the pin's LOCAL position attribute -- and this port
// bakes each mesh's world into its vertices, so the lane would carry the world
// position instead. Composition refuses it by name, exactly as
// `standard_draw_world` refuses the Standard family's own LOCAL_POSITION arm
// over a transformed mesh.
//
// `reflectivity` rides the graph's own uniform block and `albedo` its own
// texture pair, and BOTH are numbered by the geometry emit rather than by the
// colour one — the colour view of this graph declares `[uv, position]` where
// the geometry view declares `[position, normal, uv]` — which is what makes the
// reflectivity and worldNormal tiles the sharp end of the gate.
//
// Retire it when scene 149 registers: that scene is this contract on the
// PowerPlant model, with a delegating blockLoader and live node-material input
// handles beside it.

import {
    addTask,
    addTaskAtStart,
    addToScene,
    attachControl,
    createArcRotateCamera,
    createBox,
    createCopyToTextureTask,
    createEngine,
    createGeometryRendererTask,
    createRenderTarget,
    createRenderTask,
    createSceneContext,
    createSolidTexture2D,
    createSphere,
    createTorus,
    GeometryTextureType,
    parseNodeMaterialFromSnippet,
    registerScene,
    startEngine,
} from "babylon-lite";
import type { BlockEmitter } from "babylon-lite";

/** The geometry terminal lives outside the always-loaded block registry, so a
 *  scene that reaches it names the pinned emitter module itself. */
async function loadGeometryBlockEmitter(className: string): Promise<BlockEmitter> {
    switch (className) {
        case "GeometryTextureOutputBlock":
            return (await import("babylon-lite/material/node/blocks/geometry-texture-output.js")).emitter;
        case "InputBlock":
            return (await import("babylon-lite/material/node/blocks/input-block.js")).emitter;
        case "TransformBlock":
            return (await import("babylon-lite/material/node/blocks/transform-block.js")).emitter;
        case "TextureBlock":
            return (await import("babylon-lite/material/node/blocks/texture-block.js")).emitter;
        case "VertexOutputBlock":
            return (await import("babylon-lite/material/node/blocks/vertex-output.js")).emitter;
        case "FragmentOutputBlock":
            return (await import("babylon-lite/material/node/blocks/fragment-output.js")).emitter;
        default:
            throw new Error(`Unsupported node block ${className}.`);
    }
}

// One graph with BOTH fragment terminals: `FragmentOutputBlock` for the colour
// pass and `GeometryTextureOutputBlock` for the geometry tasks. The two emits
// walk different sub-graphs, which is the whole point of the gate.
const NODE_GEOMETRY_GRAPH = {
    tags: null,
    ignoreAlpha: false,
    maxSimultaneousLights: 4,
    mode: 0,
    forceAlphaBlending: false,
    id: "nodegeom",
    name: "NodeGeometryOutput",
    customType: "BABYLON.NodeMaterial",
    checkReadyOnEveryCall: false,
    checkReadyOnlyOnce: false,
    state: "",
    alpha: 1,
    backFaceCulling: true,
    sideOrientation: 1,
    alphaMode: 2,
    _needAlphaBlending: false,
    _needAlphaTesting: false,
    forceDepthWrite: false,
    separateCullingPass: false,
    fogEnabled: false,
    pointSize: 1,
    zOffset: 0,
    zOffsetUnits: 0,
    pointsCloud: false,
    fillMode: 0,
    editorData: null,
    customBlocks: [],
    blocks: [
        // id=1 position attribute (vec3, attr)
        {
            customType: "BABYLON.InputBlock",
            id: 1,
            name: "position",
            target: 1,
            inputs: [],
            outputs: [{ name: "output" }],
            type: 8,
            mode: 1,
            systemValue: null,
            isConstant: false,
        },
        // id=2 normal attribute (vec3, attr)
        {
            customType: "BABYLON.InputBlock",
            id: 2,
            name: "normal",
            target: 1,
            inputs: [],
            outputs: [{ name: "output" }],
            type: 8,
            mode: 1,
            systemValue: null,
            isConstant: false,
        },
        // id=3 uv attribute (vec2, attr)
        {
            customType: "BABYLON.InputBlock",
            id: 3,
            name: "uv",
            target: 1,
            inputs: [],
            outputs: [{ name: "output" }],
            type: 4,
            mode: 1,
            systemValue: null,
            isConstant: false,
        },
        // id=4 WorldViewProjection (mat4 system value 6)
        {
            customType: "BABYLON.InputBlock",
            id: 4,
            name: "worldViewProjection",
            target: 1,
            inputs: [],
            outputs: [{ name: "output" }],
            type: 128,
            mode: 0,
            systemValue: 6,
            isConstant: false,
        },
        // id=5 World (mat4 system value 1)
        {
            customType: "BABYLON.InputBlock",
            id: 5,
            name: "world",
            target: 1,
            inputs: [],
            outputs: [{ name: "output" }],
            type: 128,
            mode: 0,
            systemValue: 1,
            isConstant: false,
        },
        // id=6 reflectivity uniform (Color3 constant, the graph's own UBO)
        {
            customType: "BABYLON.InputBlock",
            id: 6,
            name: "reflectivity",
            target: 2,
            inputs: [],
            outputs: [{ name: "output" }],
            type: 32,
            mode: 0,
            systemValue: null,
            valueType: "BABYLON.Color3",
            value: [0.85, 0.35, 0.1],
            isConstant: false,
        },
        // id=7 Transform position x WVP -> VertexOutput
        {
            customType: "BABYLON.TransformBlock",
            id: 7,
            name: "TransformWVP",
            target: 1,
            inputs: [
                { name: "vector", inputName: "vector", targetBlockId: 1, targetConnectionName: "output" },
                { name: "transform", inputName: "transform", targetBlockId: 4, targetConnectionName: "output" },
            ],
            outputs: [{ name: "output" }, { name: "xyz" }],
            complementZ: 0,
            complementW: 1,
        },
        // id=8 Transform position x World -> worldPos
        {
            customType: "BABYLON.TransformBlock",
            id: 8,
            name: "TransformWorldPos",
            target: 1,
            inputs: [
                { name: "vector", inputName: "vector", targetBlockId: 1, targetConnectionName: "output" },
                { name: "transform", inputName: "transform", targetBlockId: 5, targetConnectionName: "output" },
            ],
            outputs: [{ name: "output" }, { name: "xyz" }],
            complementZ: 0,
            complementW: 1,
        },
        // id=9 Transform normal x World (W=0) -> worldNormal
        {
            customType: "BABYLON.TransformBlock",
            id: 9,
            name: "TransformWorldNormal",
            target: 1,
            inputs: [
                { name: "vector", inputName: "vector", targetBlockId: 2, targetConnectionName: "output" },
                { name: "transform", inputName: "transform", targetBlockId: 5, targetConnectionName: "output" },
            ],
            outputs: [{ name: "output" }, { name: "xyz" }],
            complementZ: 0,
            complementW: 0,
        },
        // id=10 albedo TextureBlock (uv from the uv attribute)
        {
            customType: "BABYLON.TextureBlock",
            id: 10,
            name: "albedo",
            target: 3,
            inputs: [{ name: "uv", inputName: "uv", targetBlockId: 3, targetConnectionName: "output" }],
            outputs: [
                { name: "rgba" },
                { name: "rgb" },
                { name: "r" },
                { name: "g" },
                { name: "b" },
                { name: "a" },
                { name: "level" },
            ],
            convertToGammaSpace: false,
            convertToLinearSpace: false,
            fragmentOnly: false,
            disableLevelMultiplication: false,
        },
        // id=11 VertexOutput
        {
            customType: "BABYLON.VertexOutputBlock",
            id: 11,
            name: "VertexOutput",
            target: 1,
            inputs: [{ name: "vector", inputName: "vector", targetBlockId: 7, targetConnectionName: "output" }],
            outputs: [],
        },
        // id=12 FragmentOutput (the colour pass: flat albedo)
        {
            customType: "BABYLON.FragmentOutputBlock",
            id: 12,
            name: "FragmentOutput",
            target: 2,
            inputs: [
                { name: "rgba", inputName: "rgba" },
                { name: "rgb", inputName: "rgb", targetBlockId: 10, targetConnectionName: "rgb" },
                { name: "a", inputName: "a" },
            ],
            outputs: [],
            convertToGammaSpace: false,
            convertToLinearSpace: false,
            useLogarithmicDepth: false,
        },
        // id=13 GeometryTextureOutput (the geometry-renderer terminal).
        // viewDepth / normalizedViewDepth / screenspaceDepth are deliberately
        // left unconnected: the pin derives them from worldPosition, and the
        // normalized lane is what makes task A declare `NmeGeomParams`.
        {
            customType: "BABYLON.GeometryTextureOutputBlock",
            id: 13,
            name: "GeometryTextureOutput",
            target: 2,
            inputs: [
                { name: "worldPosition", inputName: "worldPosition", targetBlockId: 8, targetConnectionName: "output" },
                { name: "worldNormal", inputName: "worldNormal", targetBlockId: 9, targetConnectionName: "output" },
                { name: "reflectivity", inputName: "reflectivity", targetBlockId: 6, targetConnectionName: "output" },
                { name: "albedo", inputName: "albedo", targetBlockId: 10, targetConnectionName: "rgb" },
            ],
            outputs: [],
        },
    ],
    outputNodes: [11, 12, 13],
};

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine, { defaultRenderTask: false });

    const camera = createArcRotateCamera(0.9, 1.05, 14, { x: 0, y: 0, z: 0 });
    camera.nearPlane = 0.5;
    camera.farPlane = 40;
    scene.camera = camera;
    attachControl(camera, canvas, scene);

    const material = await parseNodeMaterialFromSnippet(engine, "", {
        json: NODE_GEOMETRY_GRAPH,
        textures: { albedo: createSolidTexture2D(engine, 0.15, 0.55, 0.85, 1) },
        blockLoader: loadGeometryBlockEmitter,
    });

    // Three shapes at three transforms, so a world-normal, world-position or
    // depth tile that came from the wrong view or the wrong buffer is visible
    // rather than flat.
    const sphere = createSphere(engine, { segments: 24, diameter: 4 });
    sphere.position.set(-3.4, 0, 0);
    sphere.material = material;
    addToScene(scene, sphere);

    const box = createBox(engine, { width: 3, height: 3, depth: 3 });
    box.position.set(1.6, 0.4, 1.2);
    box.rotation.set(0.4, 0.7, 0);
    box.material = material;
    addToScene(scene, box);

    const torus = createTorus(engine, { diameter: 3.4, thickness: 1, tessellation: 24 });
    torus.position.set(1.4, -1.6, -2.6);
    torus.rotation.set(1.1, 0, 0);
    torus.material = material;
    addToScene(scene, torus);

    const samples = engine.msaaSamples as 1 | 4;

    const intermediateTarget = createRenderTarget({
        lbl: "nodegeom-intermediate",
        format: engine.format,
        dFormat: "depth24plus-stencil8",
        samples: samples,
        size: engine,
    });
    const ssIntermediate = createRenderTarget({
        lbl: "nodegeom-ss-intermediate",
        format: engine.format,
        samples: 1,
        size: engine,
    });
    const sceneTask = createRenderTask(
        {
            name: "nodegeom-scene",
            rt: intermediateTarget,
            clrColor: scene.clearColor,
            clr: true,
        },
        engine,
        scene
    );

    // Two tasks over ONE graph: the composed view is keyed by (graph, task),
    // so these are two modules with different attachment counts and different
    // group-1 runs.
    const geomA = createGeometryRendererTask(
        {
            name: "nodegeom-a",
            samples,
            textureDescriptions: [
                { type: GeometryTextureType.WORLD_NORMAL },
                { type: GeometryTextureType.NORMALIZED_VIEW_DEPTH },
                { type: GeometryTextureType.WORLD_POSITION },
            ],
        },
        engine,
        scene
    );
    const geomB = createGeometryRendererTask(
        {
            name: "nodegeom-b",
            samples,
            textureDescriptions: [
                { type: GeometryTextureType.ALBEDO },
                { type: GeometryTextureType.REFLECTIVITY },
            ],
        },
        engine,
        scene
    );

    addTaskAtStart(scene, sceneTask);
    addTask(scene, geomA);
    addTask(scene, geomB);

    const impostors = [
        { name: "worldNormal", source: geomA.geometryWorldNormalTexture! },
        { name: "normalizedViewDepth", source: geomA.geometryNormalizedViewDepthTexture! },
        { name: "worldPosition", source: geomA.geometryWorldPositionTexture! },
        { name: "albedo", source: geomB.geometryAlbedoTexture! },
        { name: "reflectivity", source: geomB.geometryReflectivityTexture! },
    ];
    const tileWidth = 1 / impostors.length;
    for (let index = 0; index < impostors.length; index++) {
        const entry = impostors[index]!;
        addTask(
            scene,
            createCopyToTextureTask(
                {
                    name: `nodegeom-impostor-${entry.name}`,
                    sourceTexture: entry.source,
                    targetTexture: intermediateTarget,
                    viewport: { x: index * tileWidth, y: 0, width: tileWidth, height: 0.28 },
                },
                engine,
                scene
            )
        );
    }

    if (samples > 1) {
        addTask(
            scene,
            createCopyToTextureTask(
                {
                    name: "nodegeom-resolve",
                    sourceTexture: intermediateTarget,
                    resolveTexture: ssIntermediate,
                },
                engine,
                scene
            )
        );
    }
    addTask(
        scene,
        createCopyToTextureTask(
            {
                name: "nodegeom-to-swap",
                sourceTexture: samples > 1 ? ssIntermediate : intermediateTarget,
                targetTexture: engine.scRT,
            },
            engine,
            scene
        )
    );

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch((err) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(err);
    }
});
