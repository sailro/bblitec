import {
    addTaskAtStart,
    addToScene,
    createArcRotateCamera,
    createEffectRenderTask,
    createEffectWrapper,
    createEngine,
    createPlane,
    createRenderTargetTexture,
    createSceneContext,
    createShaderMaterial,
    getOrCreateSampler,
    registerScene,
    setShaderTexture,
    startEngine,
} from "@babylonjs/lite";

// Two 4x4 checker targets magnified on two planes: the left one samples
// through its texture's own bilinear sampler, the right one through the
// nearest sampler written to its texture's `sampler` before the material
// binds it.
const CHECKER_WGSL = `@fragment fn effectFragment(input:EffectVertexOutput)->@location(0) vec4<f32>{
    let cell = vec2<i32>(floor(input.uv * 4.0));
    let odd = ((cell.x + cell.y) & 1) == 1;
    return select(vec4<f32>(0.95, 0.85, 0.2, 1.0), vec4<f32>(0.1, 0.2, 0.7, 1.0), odd);
}`;
const vertexSource = `struct VertexOutput{@builtin(position) position:vec4<f32>,@location(0) uv:vec2<f32>,};
@vertex fn mainVertex(input:VertexInput)->VertexOutput{var out:VertexOutput;out.position=shaderSystem.worldViewProjection*vec4<f32>(input.position,1.0);out.uv=input.uv;return out;}`;
const fragmentSource = `struct VertexOutput{@builtin(position) position:vec4<f32>,@location(0) uv:vec2<f32>,};
@fragment fn mainFragment(input:VertexOutput)->@location(0) vec4<f32>{return textureSample(picture,pictureSampler,input.uv);}`;

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const engine = await createEngine(canvas);
const scene = createSceneContext(engine);
scene.clearColor = { r: 0.1, g: 0.1, b: 0.15, a: 1 };

const checker = (name: string) => {
    const target = createRenderTargetTexture(engine, {
        lbl: name,
        format: "rgba8unorm",
        samples: 1,
        size: { width: 4, height: 4 },
    });
    const effect = createEffectWrapper(engine, { name, fragmentWGSL: CHECKER_WGSL });
    addTaskAtStart(
        scene,
        createEffectRenderTask({ name, effect, target: target.rt, clear: true }, engine, scene),
    );
    return target;
};
const bilinear = checker("sampler-bilinear");
const nearest = checker("sampler-nearest");
nearest.texture.sampler = getOrCreateSampler(engine, {
    magFilter: "nearest",
    minFilter: "nearest",
});

const plane = (name: string, texture: typeof bilinear.texture, x: number) => {
    const material = createShaderMaterial({
        name,
        vertexSource,
        fragmentSource,
        attributes: ["position", "uv"],
        uniforms: ["worldViewProjection"],
        samplers: ["picture"],
        backFaceCulling: false,
    });
    setShaderTexture(material, "picture", texture);
    const mesh = createPlane(engine, { width: 1.8, height: 1.8 });
    mesh.position.x = x;
    mesh.material = material;
    addToScene(scene, mesh);
};
plane("sampler-bilinear-plane", bilinear.texture, -1);
plane("sampler-nearest-plane", nearest.texture, 1);
scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 4, { x: 0, y: 0, z: 0 });
await registerScene(scene);
await startEngine(engine);
