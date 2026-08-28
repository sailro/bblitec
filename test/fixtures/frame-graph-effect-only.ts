import {
    addTask,
    createEngine,
    createFrameGraphContext,
    createUniformEffectRenderTask,
    createUniformEffectWrapper,
    registerFrameGraphContext,
    setUniformEffectUniforms,
    startEngine,
} from "@babylonjs/lite";

const FRAGMENT = `
struct U { color: vec4f };
@group(0) @binding(0) var<uniform> u: U;
@fragment fn effectFragment() -> @location(0) vec4f { return u.color; }
`;

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas, { maxDevicePixelRatio: 1 });
    const effect = createUniformEffectWrapper(engine, {
        name: "effect-only",
        fragmentWGSL: FRAGMENT,
        uniformByteLength: 16,
    });
    const color = new Float32Array([0.25, 0.5, 0.75, 1]);
    const context = createFrameGraphContext(engine, {
        update: () => setUniformEffectUniforms(effect, color),
    });
    addTask(
        context.frameGraph,
        createUniformEffectRenderTask(
            { name: "effect-only", effect, target: engine.scRT },
            engine,
        ),
    );
    registerFrameGraphContext(context);
    await startEngine(engine);
}

void main();
