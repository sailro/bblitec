// The recursive-visitor spelling of a container flatten, measured.
//
// Corpus scenes 41, 47, 104 and 105 write the flatten this way -- two type
// guards over an `unknown` node, a visitor that pushes the renderable ones
// and recurses through `children`, and a driver seeded from the container's
// entities -- where scenes 149 and 229 write the worklist arrangement the
// lowering already proved. Native loading resolves the hierarchy away into
// `AssetRecord::meshes`, so the walk is answered with that list rather than
// lowered node by node.
//
// The picture depends on the walk having reached every renderable: each mesh
// the walk collects is given the same scene-created PBR material, so a mesh
// the walk missed would keep its own glTF material and render differently.
// The asset is the UV-sets fixture, whose seven quads carry seven distinct
// textured materials -- the widest disagreement available between "walked"
// and "not walked".
import {
    addToScene,
    createArcRotateCamera,
    createDirectionalLight,
    createEngine,
    createHemisphericLight,
    createPbrMaterial,
    createSceneContext,
    loadGltf,
    registerScene,
    startEngine,
} from "@babylonjs/lite";
import type { Mesh, SceneNode } from "@babylonjs/lite";

function isMeshNode(node: unknown): node is Mesh {
    return typeof node === "object" && node !== null && "_gpu" in node;
}

function hasChildren(node: unknown): node is { children: SceneNode[] } {
    return typeof node === "object" && node !== null && "children" in node && Array.isArray((node as { children?: unknown }).children);
}

function collectMeshes(node: unknown, meshes: Mesh[]): void {
    if (isMeshNode(node)) {
        meshes.push(node);
    }
    if (hasChildren(node)) {
        for (const child of node.children) {
            collectMeshes(child, meshes);
        }
    }
}

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.05, g: 0.06, b: 0.09, a: 1 };

    scene.camera = createArcRotateCamera(
        -Math.PI / 2,
        Math.PI / 2,
        4.6,
        { x: 0, y: 0, z: 0 },
    );

    addToScene(scene, createHemisphericLight([0, 1, 0], 0.55));
    addToScene(scene, createDirectionalLight([-0.4, -0.6, -1], 1.1));

    const container = await loadGltf(
        engine,
        "../examples/assets/regression/gltf-uv-sets.gltf",
    );

    const walked: Mesh[] = [];
    for (const entity of container.entities) {
        collectMeshes(entity, walked);
    }

    const painted = createPbrMaterial({
        baseColorFactor: [0.82, 0.36, 0.14, 1],
        metallicFactor: 0,
        roughnessFactor: 0.45,
        doubleSided: true,
    });
    for (const mesh of walked) {
        mesh.material = painted;
    }

    addToScene(scene, container);

    await registerScene(scene);
    await startEngine(engine);
}

main().catch(console.error);
