import {
    addTask,
    createBlackAndWhitePostProcessTask,
    createEngine,
    createFrameGraphContext,
    createRenderTarget,
    registerFrameGraphContext,
    startEngine,
} from "@babylonjs/lite";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas, { maxDevicePixelRatio: 1 });
    const source = createRenderTarget({
        lbl: "post-process-only-source",
        format: engine.format,
        samples: 1,
        size: engine,
    });
    const context = createFrameGraphContext(engine);
    addTask(
        context.frameGraph,
        createBlackAndWhitePostProcessTask(
            {
                name: "post-process-only",
                sourceTexture: source,
                targetTexture: engine.scRT,
                degree: 1,
            },
            engine,
        ),
    );
    registerFrameGraphContext(context);
    await startEngine(engine);
}

void main();
