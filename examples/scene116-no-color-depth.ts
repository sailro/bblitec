import {
    addTask,
    addTaskAtStart,
    addToScene,
    attachControl,
    createArcRotateCamera,
    createCopyToTextureTask,
    createEngine,
    createFreeCamera,
    createHemisphericLight,
    createPbrMaterial,
    createPbrNoColorMaterialView,
    createPlane,
    createRenderTarget,
    createRenderTargetTexture,
    createRenderTask,
    createSceneContext,
    createSolidTexture2D,
    createSphere,
    createStandardMaterial,
    createStandardNoColorMaterialView,
    createTorus,
    markMaterialUboDirty,
    registerScene,
    startEngine,
} from "@babylonjs/lite";

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine, { defaultRenderTask: false });

    const mainCamera = createArcRotateCamera(
        -Math.PI / 2,
        Math.PI / 2.35,
        8.5,
        { x: 0, y: -0.25, z: 0 },
    );
    mainCamera.nearPlane = 0.1;
    mainCamera.farPlane = 100;
    scene.camera = mainCamera;
    attachControl(mainCamera, canvas, scene);

    addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));

    const standardDepthTarget = createRenderTargetTexture(engine, {
        lbl: "standard-shadow-depth",
        dFormat: "depth24plus-stencil8",
        samples: 1,
        size: { width: 512, height: 512 },
    });
    const standardDepthRT = standardDepthTarget.rt;
    const standardDepthTexture = standardDepthTarget.texture;
    const pbrDepthTarget = createRenderTargetTexture(engine, {
        lbl: "pbr-shadow-depth",
        dFormat: "depth24plus-stencil8",
        samples: 1,
        size: { width: 512, height: 512 },
    });
    const pbrDepthRT = pbrDepthTarget.rt;
    const pbrDepthTexture = pbrDepthTarget.texture;

    const standardMesh = createTorus(engine, {
        diameter: 1.6,
        thickness: 0.45,
        tessellation: 48,
    });
    standardMesh.position.x = -2.25;
    standardMesh.position.y = 1.0;
    const standardMaterial = createStandardMaterial();
    standardMaterial.diffuseColor = [0.25, 0.45, 1.0];
    standardMaterial.alpha = 1.0;
    standardMaterial.specularColor = [1.0, 1.0, 1.0];
    standardMaterial.specularPower = 96;
    standardMesh.material = standardMaterial;
    addToScene(scene, standardMesh);
    const standardDepthView =
        createStandardNoColorMaterialView(standardMaterial);
    markMaterialUboDirty(standardMaterial);

    const baseColorTexture = createSolidTexture2D(engine, 1.0, 0.72, 0.22);
    const ormTexture = createSolidTexture2D(engine, 1.0, 0.35, 0.0);
    const pbrMesh = createSphere(engine, { segments: 32, diameter: 1.8 });
    pbrMesh.position.x = 2.25;
    pbrMesh.position.y = 1.0;
    const pbrMaterial = createPbrMaterial({
        baseColorTexture,
        ormTexture,
        metallicFactor: 0,
        roughnessFactor: 0.7,
        directIntensity: 1.0,
        environmentIntensity: 0.0,
        unlit: true,
    });
    pbrMesh.material = pbrMaterial;
    addToScene(scene, pbrMesh);
    const pbrDepthView = createPbrNoColorMaterialView(pbrMaterial);
    markMaterialUboDirty(pbrMaterial);

    const standardDepthDisplay = createPlane(engine, {
        width: 2.2,
        height: 2.2,
    });
    standardDepthDisplay.position.x = -2.25;
    standardDepthDisplay.position.y = -1.6;
    const standardDepthDisplayMaterial = createStandardMaterial();
    standardDepthDisplayMaterial.disableLighting = true;
    standardDepthDisplayMaterial.diffuseColor = [1, 1, 1];
    standardDepthDisplayMaterial.emissiveColor = [0, 0, 0];
    standardDepthDisplayMaterial.emissiveTexture = standardDepthTexture;
    standardDepthDisplay.material = standardDepthDisplayMaterial;
    addToScene(scene, standardDepthDisplay);

    const pbrDepthDisplay = createPlane(engine, {
        width: 2.2,
        height: 2.2,
    });
    pbrDepthDisplay.position.x = 2.25;
    pbrDepthDisplay.position.y = -1.6;
    const pbrDepthDisplayMaterial = createStandardMaterial();
    pbrDepthDisplayMaterial.disableLighting = true;
    pbrDepthDisplayMaterial.diffuseColor = [1, 1, 1];
    pbrDepthDisplayMaterial.emissiveColor = [0, 0, 0];
    pbrDepthDisplayMaterial.emissiveTexture = pbrDepthTexture;
    pbrDepthDisplay.material = pbrDepthDisplayMaterial;
    addToScene(scene, pbrDepthDisplay);

    const standardDepthCamera = createFreeCamera(
        { x: -2.25, y: 1.0, z: -4.0 },
        { x: -2.25, y: 1.0, z: 0 },
    );
    standardDepthCamera.nearPlane = 2;
    standardDepthCamera.farPlane = 8;
    const standardDepthTask = createRenderTask(
        {
            name: "standard-shadow-depth",
            rt: standardDepthRT,
            clrColor: { r: 0.02, g: 0.02, b: 0.02, a: 1 },
            cam: standardDepthCamera,
            cs: true,
        },
        engine,
        scene,
    );
    standardDepthTask.addMesh(standardMesh, { material: standardDepthView });
    addTaskAtStart(scene, standardDepthTask);

    const pbrDepthCamera = createFreeCamera(
        { x: 2.25, y: 1.0, z: -4.0 },
        { x: 2.25, y: 1.0, z: 0 },
    );
    pbrDepthCamera.nearPlane = 2;
    pbrDepthCamera.farPlane = 8;
    const pbrDepthTask = createRenderTask(
        {
            name: "pbr-shadow-depth",
            rt: pbrDepthRT,
            clrColor: { r: 0.02, g: 0.02, b: 0.02, a: 1 },
            cam: pbrDepthCamera,
            cs: true,
        },
        engine,
        scene,
    );
    pbrDepthTask.addMesh(pbrMesh, { material: pbrDepthView });
    addTaskAtStart(scene, pbrDepthTask);

    const mainTarget = createRenderTarget({
        lbl: "scene116-main",
        format: engine.format,
        dFormat: "depth24plus-stencil8",
        samples: 4,
        size: engine,
    });
    const mainResolve = createRenderTarget({
        lbl: "scene116-main-resolve",
        format: engine.format,
        samples: 1,
        size: engine,
    });
    const mainTask = createRenderTask(
        {
            name: "scene116-main",
            rt: mainTarget,
            clrColor: { r: 0.2, g: 0.2, b: 0.3, a: 1 },
            clr: true,
        },
        engine,
        scene,
    );
    addTask(scene, mainTask);
    addTask(
        scene,
        createCopyToTextureTask(
            {
                name: "scene116-resolve",
                sourceTexture: mainTarget,
                resolveTexture: mainResolve,
            },
            engine,
            scene,
        ),
    );
    addTask(
        scene,
        createCopyToTextureTask(
            {
                name: "scene116-present",
                sourceTexture: mainResolve,
                targetTexture: engine.scRT,
            },
            engine,
            scene,
        ),
    );

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
