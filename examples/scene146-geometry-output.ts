import {
    addTask,
    addTaskAtStart,
    addToScene,
    attachControl,
    createArcRotateCamera,
    createCopyToTextureTask,
    createEngine,
    createGeometryRendererTask,
    createRenderTarget,
    createRenderTask,
    createSceneContext,
    GeometryTextureType,
    loadEnvironment,
    loadGltf,
    registerScene,
    startEngine,
} from "@babylonjs/lite";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas, {
        requiredLimits: { maxColorAttachmentBytesPerSample: 64 },
    });
    const scene = createSceneContext(engine, { defaultRenderTask: false });

    const camera = createArcRotateCamera(
        Math.PI,
        1.7681918866447774,
        Math.sqrt(26),
        { x: 0, y: 3, z: 0 },
    );
    scene.camera = camera;
    attachControl(camera, canvas, scene);

    addToScene(
        scene,
        await loadGltf(
            engine,
            "https://cdn.jsdelivr.net/gh/KhronosGroup/glTF-Sample-Assets@main/Models/Sponza/glTF/Sponza.gltf",
        ),
    );
    await loadEnvironment(
        scene,
        "https://assets.babylonjs.com/core/environments/environmentSpecular.env",
        { brdfUrl: "/brdf-lut.png" },
    );

    const intermediateTarget = createRenderTarget({
        lbl: "scene146-intermediate",
        format: engine.format,
        dFormat: "depth24plus-stencil8",
        samples: 4,
        size: engine,
    });
    const ssIntermediate = createRenderTarget({
        lbl: "scene146-ss-intermediate",
        format: engine.format,
        samples: 1,
        size: engine,
    });
    const scRT = engine.scRT;
    const realColorTarget = createRenderTarget({
        lbl: "scene146-real-color",
        format: engine.format,
        samples: 4,
        size: engine,
    });
    const sceneTask = createRenderTask(
        {
            name: "scene146-scene",
            rt: intermediateTarget,
            clrColor: { r: 0.2, g: 0.2, b: 0.3, a: 1 },
            clr: true,
        },
        engine,
        scene,
    );
    const geomTaskA = createGeometryRendererTask(
        {
            name: "scene146-geom-a",
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
            name: "scene146-geom-b",
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
        name: "scene146-impostor-normViewDepth",
        sourceTexture: geomTaskA.geometryNormalizedViewDepthTexture!,
        targetTexture: intermediateTarget,
        viewport: { x: 0 / 6, y: 0, width: 1 / 6, height: 0.15 },
    }, engine, scene));
    addTask(scene, createCopyToTextureTask({
        name: "scene146-impostor-viewNormal",
        sourceTexture: geomTaskA.geometryViewNormalTexture!,
        targetTexture: intermediateTarget,
        viewport: { x: 1 / 6, y: 0, width: 1 / 6, height: 0.15 },
    }, engine, scene));
    addTask(scene, createCopyToTextureTask({
        name: "scene146-impostor-worldNormal",
        sourceTexture: geomTaskA.geometryWorldNormalTexture!,
        targetTexture: intermediateTarget,
        viewport: { x: 2 / 6, y: 0, width: 1 / 6, height: 0.15 },
    }, engine, scene));
    addTask(scene, createCopyToTextureTask({
        name: "scene146-impostor-worldPosition",
        sourceTexture: geomTaskA.geometryWorldPositionTexture!,
        targetTexture: intermediateTarget,
        viewport: { x: 3 / 6, y: 0, width: 1 / 6, height: 0.15 },
    }, engine, scene));
    addTask(scene, createCopyToTextureTask({
        name: "scene146-impostor-reflectivity",
        sourceTexture: geomTaskA.geometryReflectivityTexture!,
        targetTexture: intermediateTarget,
        viewport: { x: 4 / 6, y: 0, width: 1 / 6, height: 0.15 },
    }, engine, scene));
    addTask(scene, createCopyToTextureTask({
        name: "scene146-impostor-albedo",
        sourceTexture: geomTaskA.geometryAlbedoTexture!,
        targetTexture: intermediateTarget,
        viewport: { x: 5 / 6, y: 0, width: 1 / 6, height: 0.15 },
    }, engine, scene));

    addTask(scene, createCopyToTextureTask({
        name: "scene146-impostor-irradiance",
        sourceTexture: geomTaskA.geometryIrradianceTexture!,
        targetTexture: intermediateTarget,
        viewport: { x: 0 / 6, y: 0.85, width: 1 / 6, height: 0.15 },
    }, engine, scene));
    addTask(scene, createCopyToTextureTask({
        name: "scene146-impostor-localPosition",
        sourceTexture: geomTaskB.geometryLocalPositionTexture!,
        targetTexture: intermediateTarget,
        viewport: { x: 1 / 6, y: 0.85, width: 1 / 6, height: 0.15 },
    }, engine, scene));
    addTask(scene, createCopyToTextureTask({
        name: "scene146-impostor-viewDepth",
        sourceTexture: geomTaskB.geometryViewDepthTexture!,
        targetTexture: intermediateTarget,
        viewport: { x: 2 / 6, y: 0.85, width: 1 / 6, height: 0.15 },
    }, engine, scene));
    addTask(scene, createCopyToTextureTask({
        name: "scene146-impostor-screenspaceDepth",
        sourceTexture: geomTaskB.geometryScreenspaceDepthTexture!,
        targetTexture: intermediateTarget,
        viewport: { x: 3 / 6, y: 0.85, width: 1 / 6, height: 0.15 },
    }, engine, scene));
    addTask(scene, createCopyToTextureTask({
        name: "scene146-impostor-linearVelocity",
        sourceTexture: geomTaskB.geometryLinearVelocityTexture!,
        targetTexture: intermediateTarget,
        viewport: { x: 4 / 6, y: 0.85, width: 1 / 6, height: 0.15 },
    }, engine, scene));
    addTask(scene, createCopyToTextureTask({
        name: "scene146-impostor-realColor",
        sourceTexture: geomTaskA.outputTexture!,
        targetTexture: intermediateTarget,
        viewport: { x: 5 / 6, y: 0.85, width: 1 / 6, height: 0.15 },
    }, engine, scene));

    addTask(scene, createCopyToTextureTask({
        name: "scene146-resolve",
        sourceTexture: intermediateTarget,
        resolveTexture: ssIntermediate,
    }, engine, scene));
    addTask(scene, createCopyToTextureTask({
        name: "scene146-to-swap",
        sourceTexture: ssIntermediate,
        targetTexture: scRT,
    }, engine, scene));

    await registerScene(scene);
    await startEngine(engine);
}

main().catch(console.error);
