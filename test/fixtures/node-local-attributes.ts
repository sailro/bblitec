// The same graph in color and two independently composed geometry tasks.
// Imported raw NORMAL lanes include nonunit values and signed zero; the
// source asset carries nonidentity hierarchies with both determinant signs.
import {
    addTask, addTaskAtStart, addToScene, attachControl, createArcRotateCamera,
    createCopyToTextureTask, createEngine, createGeometryRendererTask,
    createMeshFromData, createRenderTarget, createRenderTask, createSceneContext,
    createSolidTexture2D, createTransformNode, GeometryTextureType, loadGltf,
    loadNodeBlockEmitterWithGeometry, parseNodeMaterialFromSnippet, registerScene, startEngine,
} from "@babylonjs/lite";
import type { Mesh, SceneNode } from "@babylonjs/lite";
import { SCENE149_NME_JSON } from "../../corpus/babylon-lite/lab/lite/src/shared/scene149-nme.js";

function isMeshNode(node: unknown): node is Mesh {
    return typeof node === "object" && node !== null && "_gpu" in node;
}
function hasChildren(node: unknown): node is { children: SceneNode[] } {
    return typeof node === "object" && node !== null && "children" in node && Array.isArray((node as { children?: unknown }).children);
}
function collectMeshes(node: unknown, meshes: Mesh[]): void {
    if (isMeshNode(node)) meshes.push(node);
    if (hasChildren(node)) {
        for (const child of node.children) collectMeshes(child, meshes);
    }
}

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas, { msaaSamples: 1 });
    const scene = createSceneContext(engine, { defaultRenderTask: false });
    scene.clearColor = { r: 0.07, g: 0.09, b: 0.13, a: 1 };
    const camera = createArcRotateCamera(-Math.PI / 2, 1.35, 7, { x: 0, y: 0.1, z: 0 });
    scene.camera = camera;
    attachControl(camera, canvas, scene);
    const albedo = createSolidTexture2D(engine, 0.7, 0.35, 0.15, 1);
    const material = await parseNodeMaterialFromSnippet(engine, "", {
        json: SCENE149_NME_JSON, blockLoader: loadNodeBlockEmitterWithGeometry,
        textures: { albedo },
    });
    const container = await loadGltf(engine, "../../examples/assets/regression/node-local-attributes.gltf");
    const meshes: Mesh[] = [];
    for (const entity of container.entities) collectMeshes(entity, meshes);
    for (const mesh of meshes) mesh.material = material;
    addToScene(scene, container);
    const local = createMeshFromData(engine, "scene-local",
        new Float32Array([-0.6,-0.4,0,0.6,-0.4,0,0.6,0.4,0,-0.6,0.4,0]),
        new Float32Array([0.2,0.4,2,0.2,0.4,2,0.2,0.4,2,0.2,0.4,2]),
        new Uint32Array([0,1,2,0,2,3]), new Float32Array([0,1,1,1,1,0,0,0]));
    local.material = material;
    const parent = createTransformNode("scene-parent");
    parent.position.y = 1.25;
    parent.rotation.z = -0.2;
    parent.scaling.x = 1.3;
    local.parent = parent;
    local.rotation.y = 0.3;
    local.scaling.y = 0.8;
    addToScene(scene, local);
    const color = createRenderTarget({ lbl: "node-local-color", format: engine.format,
        dFormat: "depth24plus-stencil8", samples: 1, size: engine });
    const colorTask = createRenderTask({ name: "node-local-color", rt: color, clrColor: scene.clearColor, clr: true }, engine, scene);
    const geometryA = createGeometryRendererTask({ name: "node-local-a", samples: 1,
        textureDescriptions: [{ type: GeometryTextureType.WORLD_POSITION }, { type: GeometryTextureType.WORLD_NORMAL }] }, engine, scene);
    const geometryB = createGeometryRendererTask({ name: "node-local-b", samples: 1,
        textureDescriptions: [{ type: GeometryTextureType.LOCAL_POSITION }, { type: GeometryTextureType.VIEW_NORMAL }] }, engine, scene);
    addTaskAtStart(scene, colorTask);
    addTask(scene, geometryA);
    addTask(scene, geometryB);
    const tiles = [geometryA.geometryWorldPositionTexture!, geometryA.geometryWorldNormalTexture!,
        geometryB.geometryLocalPositionTexture!, geometryB.geometryViewNormalTexture!];
    for (let i = 0; i < tiles.length; ++i) {
        addTask(scene, createCopyToTextureTask({ name: `node-local-tile-${i}`, sourceTexture: tiles[i]!,
            targetTexture: color, viewport: { x: i / 4, y: 0, width: 0.25, height: 0.3 } }, engine, scene));
    }
    addTask(scene, createCopyToTextureTask({ name: "node-local-present", sourceTexture: color, targetTexture: engine.scRT }, engine, scene));
    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.ready = "true";
}
void main();
