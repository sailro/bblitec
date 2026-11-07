// The geometry velocity regressions' shared view: a geometry task writing
// velocity, copied into a sampled target and shown scaled by an effect task.
// Red and green are the X and Y velocity about mid-grey, blue the previous
// view depth a task under enableGeometryVelocity's previousDepth writes.
import {
    addTask,
    createCopyToTextureTask,
    createEffectRenderTask,
    createEffectWrapper,
    createGeometryRendererTask,
    createRenderTargetTexture,
    GeometryTextureType,
    setEffectTexture,
    type EngineContext,
    type GeometryRendererTask,
    type SceneContext,
} from "babylon-lite";

const VELOCITY_WGSL = `@group(0) @binding(0) var velocityTexture:texture_2d<f32>;
@group(0) @binding(1) var velocitySampler:sampler;
@fragment fn effectFragment(input:EffectVertexOutput)->@location(0) vec4<f32>{
    let size = vec2<f32>(textureDimensions(velocityTexture));
    let texel = vec2<i32>(clamp(input.uv * size, vec2<f32>(0.0), size - vec2<f32>(1.0)));
    let velocity = textureLoad(velocityTexture, texel, 0);
    return vec4<f32>(clamp(vec3<f32>(0.5 + velocity.x * 60.0, 0.5 + velocity.y * 60.0, velocity.z * 0.08), vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}`;

/** The velocity task, before it is added to its scene. */
export function createVelocityTask(engine: EngineContext, scene: SceneContext): GeometryRendererTask {
    return createGeometryRendererTask(
        {
            name: "velocity-geometry",
            samples: 1,
            textureDescriptions: [{ type: GeometryTextureType.LINEAR_VELOCITY, format: "rgba16float" }],
        },
        engine,
        scene
    );
}

/** The task and its view, added to `scene` before registration. */
export function addVelocityView(engine: EngineContext, scene: SceneContext, geometry: GeometryRendererTask): void {
    addTask(scene, geometry);
    const effect = createEffectWrapper(engine, {
        name: "velocity-view",
        fragmentWGSL: VELOCITY_WGSL,
        bindings: [
            { name: "velocityTexture", binding: 0, kind: "texture" },
            { name: "velocitySampler", binding: 1, kind: "sampler", textureBinding: "velocityTexture" },
        ],
    });
    const velocity = createRenderTargetTexture(engine, {
        lbl: "velocity-copy",
        format: "rgba16float",
        samples: 1,
        // The capture extent: the copy is one texel per pixel.
        size: { width: 1280, height: 720 },
    });
    addTask(
        scene,
        createCopyToTextureTask(
            { name: "velocity-copy", sourceTexture: geometry.geometryLinearVelocityTexture!, targetTexture: velocity.rt },
            engine,
            scene
        )
    );
    setEffectTexture(effect, "velocityTexture", velocity.texture);
    addTask(scene, createEffectRenderTask({ name: "velocity-view", effect, target: engine.scRT, clear: true }, engine, scene));
}
