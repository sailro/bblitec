import {
    addTask,
    addTaskAtStart,
    addToScene,
    attachFreeControl,
    createCopyToTextureTask,
    createEngine,
    createFreeCamera,
    createGeometryRendererTask,
    createRenderTarget,
    createRenderTask,
    createSceneContext,
    GeometryTextureType,
    loadBabylon,
    registerScene,
    startEngine,
} from "@babylonjs/lite";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas, {
        requiredLimits: { maxColorAttachmentBytesPerSample: 64 },
    });
    const scene = createSceneContext(engine, { defaultRenderTask: false });

    addToScene(
        scene,
        await loadBabylon(
            engine,
            "https://www.babylonjs.com/Scenes/hillvalley/HillValley.babylon",
        ),
    );

    const camera = createFreeCamera(
        {
            x: -26.695675321687403,
            y: 2.7769661153192278,
            z: 21.145217983348115,
        },
        {
            x: -27.038161178180832,
            y: 2.7243780642457263,
            z: 20.20716786084526,
        },
    );
    camera.fov = 0.8985202;
    camera.nearPlane = 0.1;
    camera.farPlane = 1000;
    scene.camera = camera;
    attachFreeControl(camera, canvas, scene);

    const intermediateTarget = createRenderTarget({
        lbl: "scene145-intermediate",
        format: engine.format,
        dFormat: "depth24plus-stencil8",
        samples: 4,
        size: engine,
    });
    const ssIntermediate = createRenderTarget({
        lbl: "scene145-ss-intermediate",
        format: engine.format,
        samples: 1,
        size: engine,
    });
    const scRT = engine.scRT;
    const realColorTarget = createRenderTarget({
        lbl: "scene145-real-color",
        format: engine.format,
        samples: 4,
        size: engine,
    });
    const sceneTask = createRenderTask(
        {
            name: "scene145-scene",
            rt: intermediateTarget,
            clrColor: { r: 1, g: 1, b: 1, a: 1 },
            clr: true,
        },
        engine,
        scene,
    );
    const geomTaskA = createGeometryRendererTask(
        {
            name: "scene145-geom-a",
            samples: 4,
            textureDescriptions: [
                { type: GeometryTextureType.IRRADIANCE },
                { type: GeometryTextureType.WORLD_POSITION },
                { type: GeometryTextureType.NORMALIZED_VIEW_DEPTH },
                { type: GeometryTextureType.VIEW_NORMAL },
                { type: GeometryTextureType.WORLD_NORMAL },
                { type: GeometryTextureType.REFLECTIVITY },
                { type: GeometryTextureType.ALBEDO },
            ],
            targetTexture: realColorTarget,
            targetTextureClearColor: { r: 0, g: 0, b: 0, a: 1 },
        },
        engine,
        scene,
    );
    const geomTaskB = createGeometryRendererTask(
        {
            name: "scene145-geom-b",
            samples: 4,
            textureDescriptions: [
                { type: GeometryTextureType.LOCAL_POSITION },
                { type: GeometryTextureType.VIEW_DEPTH, format: "r16float" },
                { type: GeometryTextureType.SCREENSPACE_DEPTH },
                { type: GeometryTextureType.LINEAR_VELOCITY },
            ],
        },
        engine,
        scene,
    );

    addTaskAtStart(scene, sceneTask);
    addTask(scene, geomTaskA);
    addTask(scene, geomTaskB);

    addTask(scene, createCopyToTextureTask({
        name: "scene145-impostor-normViewDepth",
        sourceTexture: geomTaskA.geometryNormalizedViewDepthTexture!,
        targetTexture: intermediateTarget,
        viewport: { x: 0 / 6, y: 0, width: 1 / 6, height: 0.15 },
    }, engine, scene));
    addTask(scene, createCopyToTextureTask({
        name: "scene145-impostor-viewNormal",
        sourceTexture: geomTaskA.geometryViewNormalTexture!,
        targetTexture: intermediateTarget,
        viewport: { x: 1 / 6, y: 0, width: 1 / 6, height: 0.15 },
    }, engine, scene));
    addTask(scene, createCopyToTextureTask({
        name: "scene145-impostor-worldNormal",
        sourceTexture: geomTaskA.geometryWorldNormalTexture!,
        targetTexture: intermediateTarget,
        viewport: { x: 2 / 6, y: 0, width: 1 / 6, height: 0.15 },
    }, engine, scene));
    addTask(scene, createCopyToTextureTask({
        name: "scene145-impostor-worldPosition",
        sourceTexture: geomTaskA.geometryWorldPositionTexture!,
        targetTexture: intermediateTarget,
        viewport: { x: 3 / 6, y: 0, width: 1 / 6, height: 0.15 },
    }, engine, scene));
    addTask(scene, createCopyToTextureTask({
        name: "scene145-impostor-reflectivity",
        sourceTexture: geomTaskA.geometryReflectivityTexture!,
        targetTexture: intermediateTarget,
        viewport: { x: 4 / 6, y: 0, width: 1 / 6, height: 0.15 },
    }, engine, scene));
    addTask(scene, createCopyToTextureTask({
        name: "scene145-impostor-albedo",
        sourceTexture: geomTaskA.geometryAlbedoTexture!,
        targetTexture: intermediateTarget,
        viewport: { x: 5 / 6, y: 0, width: 1 / 6, height: 0.15 },
    }, engine, scene));

    addTask(scene, createCopyToTextureTask({
        name: "scene145-impostor-irradiance",
        sourceTexture: geomTaskA.geometryIrradianceTexture!,
        targetTexture: intermediateTarget,
        viewport: { x: 0 / 6, y: 0.85, width: 1 / 6, height: 0.15 },
    }, engine, scene));
    addTask(scene, createCopyToTextureTask({
        name: "scene145-impostor-localPosition",
        sourceTexture: geomTaskB.geometryLocalPositionTexture!,
        targetTexture: intermediateTarget,
        viewport: { x: 1 / 6, y: 0.85, width: 1 / 6, height: 0.15 },
    }, engine, scene));
    addTask(scene, createCopyToTextureTask({
        name: "scene145-impostor-viewDepth",
        sourceTexture: geomTaskB.geometryViewDepthTexture!,
        targetTexture: intermediateTarget,
        viewport: { x: 2 / 6, y: 0.85, width: 1 / 6, height: 0.15 },
    }, engine, scene));
    addTask(scene, createCopyToTextureTask({
        name: "scene145-impostor-screenspaceDepth",
        sourceTexture: geomTaskB.geometryScreenspaceDepthTexture!,
        targetTexture: intermediateTarget,
        viewport: { x: 3 / 6, y: 0.85, width: 1 / 6, height: 0.15 },
    }, engine, scene));
    addTask(scene, createCopyToTextureTask({
        name: "scene145-impostor-linearVelocity",
        sourceTexture: geomTaskB.geometryLinearVelocityTexture!,
        targetTexture: intermediateTarget,
        viewport: { x: 4 / 6, y: 0.85, width: 1 / 6, height: 0.15 },
    }, engine, scene));
    addTask(scene, createCopyToTextureTask({
        name: "scene145-impostor-realColor",
        sourceTexture: geomTaskA.outputTexture!,
        targetTexture: intermediateTarget,
        viewport: { x: 5 / 6, y: 0.85, width: 1 / 6, height: 0.15 },
    }, engine, scene));

    addTask(scene, createCopyToTextureTask({
        name: "scene145-resolve",
        sourceTexture: intermediateTarget,
        resolveTexture: ssIntermediate,
    }, engine, scene));
    addTask(scene, createCopyToTextureTask({
        name: "scene145-to-swap",
        sourceTexture: ssIntermediate,
        targetTexture: scRT,
    }, engine, scene));

    await registerScene(scene);
    await startEngine(engine);
}

main().catch(console.error);
