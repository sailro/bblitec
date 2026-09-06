// Unregistered A16 interaction probe. L switches coordinates; R resets the
// pointer target; M moves the bounded group; S changes its nonuniform scale.
import {
    addToScene,
    attachBoundingBoxGizmoToNode,
    attachControl,
    attachPositionGizmoToNode,
    createArcRotateCamera,
    createBoundingBoxGizmo,
    createBox,
    createEngine,
    createHemisphericLight,
    createPositionGizmo,
    createSceneContext,
    createStandardMaterial,
    createTransformNode,
    createUtilityLayer,
    isGizmoDragging,
    isGizmoInteracting,
    isGizmoPickPending,
    registerPointerDrag,
    registerScene,
    registerUtilityLayer,
    setPositionGizmoLocalCoordinates,
    startEngine,
} from "babylon-lite";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.035, g: 0.045, b: 0.065, a: 1 };
    const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 12, { x: 0, y: 0, z: 0 });
    camera.nearPlane = 0.1;
    camera.farPlane = 100;
    scene.camera = camera;
    attachControl(camera, canvas, scene, {
        shouldHandlePointerDown: () => !isGizmoInteracting(canvas),
        isExternalDragActive: () => isGizmoDragging(canvas),
        isExternalPickPending: () => isGizmoPickPending(canvas),
    });
    const light = createHemisphericLight([0, 1, -1]);
    light.intensity = 1;
    addToScene(scene, light);

    const pointerParent = createTransformNode(
        "audit-pointer-parent", -3, 0, 0,
        0, 0, 0.3826834323650898, 0.9238795325112867,
    );
    const pointerTarget = createBox(engine, 0.7);
    pointerTarget.name = "audit-pointer-target";
    pointerTarget.parent = pointerParent;
    const pointerMaterial = createStandardMaterial();
    pointerMaterial.diffuseColor = [0.2, 0.65, 0.9];
    pointerMaterial.specularColor = [0, 0, 0];
    pointerTarget.material = pointerMaterial;
    addToScene(scene, pointerTarget);

    const boundsTarget = createTransformNode("audit-bounds-target", 2.8, 0, 0, 0, 0, 0, 1);
    const boundsMaterial = createStandardMaterial();
    boundsMaterial.diffuseColor = [0.5, 0.35, 0.75];
    boundsMaterial.specularColor = [0, 0, 0];
    const left = createBox(engine, 0.8);
    left.name = "audit-bounds-left";
    left.parent = boundsTarget;
    left.position.set(-0.6, 0, 0);
    left.material = boundsMaterial;
    addToScene(scene, left);
    const right = createBox(engine, 0.8);
    right.name = "audit-bounds-right";
    right.parent = boundsTarget;
    right.position.set(0.6, 0, 0);
    right.material = boundsMaterial;
    addToScene(scene, right);

    await registerScene(scene);
    const layer = createUtilityLayer(engine, scene);
    const position = createPositionGizmo(engine, layer, { planarEnabled: false });
    attachPositionGizmoToNode(position, pointerTarget);
    setPositionGizmoLocalCoordinates(position, true);
    // Explicit public registration reaches the native pointer dispatcher.
    // Remove the additional registration immediately: the widget's original
    // registration remains live in both the pin and the native adapter.
    const unregisterExtra = registerPointerDrag(layer, canvas, position.xGizmo.drag);
    unregisterExtra();
    const boundingBox = createBoundingBoxGizmo(engine, layer, { color: [1, 0.9, 0.15] });
    attachBoundingBoxGizmoToNode(boundingBox, boundsTarget);
    await registerUtilityLayer(layer);

    let local = true;
    window.addEventListener("keydown", (event) => {
        if (event.code === "KeyL") {
            local = !local;
            setPositionGizmoLocalCoordinates(position, local);
        }
        if (event.code === "KeyR") pointerTarget.position.set(0, 0, 0);
        if (event.code === "KeyM") boundsTarget.position.set(2.4, 0.8, 0.2);
        if (event.code === "KeyS") boundsTarget.scaling.set(1.7, 1.25, 0.75);
    });
    await startEngine(engine);
}

main();
