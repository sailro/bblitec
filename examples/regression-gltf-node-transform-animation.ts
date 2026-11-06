// An animated glTF whose loaded nodes the scene also moves: the root is
// recentered and the animated nodes' parent is scaled and turned, while the
// clip moves, turns and scales three children and drives the fourth's morph
// weights. Both compose through the pin's node hierarchy.
import {
    addToScene,
    createArcRotateCamera,
    createEngine,
    createHemisphericLight,
    createSceneContext,
    loadGltf,
    registerScene,
    startEngine,
    type TransformNode,
} from "@babylonjs/lite";

function findNode(node: TransformNode, name: string): TransformNode | null {
    if (node.name === name) return node;
    for (const child of (node.children ?? []) as TransformNode[]) {
        const found = findNode(child, name);
        if (found) return found;
    }
    return null;
}

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.04, g: 0.05, b: 0.08, a: 1 };
    scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2.3, 5.4, {
        x: 0,
        y: 0,
        z: 0,
    });
    addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));

    const container = await loadGltf(
        engine,
        "../examples/assets/regression/gltf-node-transform-animation.gltf",
    );
    addToScene(scene, container);
    const root = container.entities[0] as TransformNode;
    root.position.set(0.1, -0.35, 0);
    const group = findNode(root, "Group");
    if (!group) throw new Error("The asset has no Group node.");
    group.scaling.set(1.15, 1.15, 1.15);
    group.rotation.z = 0.2;

    await registerScene(scene);
    await startEngine(engine);
}

main().catch(console.error);
