import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

/**
 * Engine resources a post-process chain hands around: render targets of one
 * engine reached through different spellings, a render-target texture result
 * passed through a generic helper, and a shader material's depth-write state.
 */
const program = (body: string): string => `
import { addTask, createEffectRenderTask, createEffectWrapper, createEngine, createRenderTarget, createRenderTargetTexture, createSceneContext, createShaderMaterial, createSurfaceRenderTargetTexture, disposeRenderTargetTexture, getOrCreateSampler, onSceneDispose, registerScene, setEffectTexture, startEngine, withSampledDepthTexture, type Material, type RenderTarget, type RenderTargetTextureResult, type SceneContext, type ShaderMaterial, type Texture2D } from "@babylonjs/lite";
interface RenderTargetInternals { _colorView: GPUTextureView | null }
const live = (rt: ReturnType<typeof createRenderTarget>, sampler: GPUSampler): Texture2D => {
    const internals = rt as unknown as RenderTargetInternals;
    return { get view(): GPUTextureView { return internals._colorView!; }, sampler, _sampleType: "float" } as unknown as Texture2D;
};
async function main(): Promise<void> {
    const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
    const scene = createSceneContext(engine);
    ${body}
    await registerScene(scene);
    await startEngine(engine);
}
void main();
`;

test("render targets of one engine spelled apart select with the engine each arm names", () => {
    const compiled = compileSource(
        program(`
    const mode = Math.random() > 0.5 ? "halton" : "smaa";
    const sceneTarget = createSurfaceRenderTargetTexture(engine, { lbl: "scene", format: "rgba8unorm", dFormat: "depth24plus-stencil8", samples: 1, size: scene.surface }, withSampledDepthTexture);
    const halton = mode === "halton" ? createRenderTarget({ lbl: "halton", format: "rgba8unorm", samples: 1, size: engine }) : null;
    const color = halton ?? sceneTarget.rt;
    const copy = createEffectWrapper(engine, { name: "copy", fragmentWGSL: "@group(0) @binding(0) var s:sampler;@group(0) @binding(1) var a:texture_2d<f32>;@fragment fn effectFragment(input:EffectVertexOutput)->@location(0) vec4<f32>{return textureSample(a,s,input.uv);}",
        bindings: [{ binding: 0, kind: "sampler", samplerType: "filtering", textureBinding: 1 }, { binding: 1, kind: "texture", textureSampleType: "float" }] });
    setEffectTexture(copy, 1, live(color, getOrCreateSampler(engine, { magFilter: "linear", minFilter: "linear" })));
    addTask(scene, createEffectRenderTask({ name: "copy", effect: copy, target: createRenderTarget({ lbl: "out", format: "rgba8unorm", samples: 1, size: engine }) }, engine, scene));`),
    ).cpp;
    assert.match(
        compiled,
        /\(v_fn\d+_halton\.has_value\(\) \? std::pair<bbl::StoredEngine, bbl::RenderTargetHandle>\{bbl::StoredEngine\{v_\w+\}, \(\*v_fn\d+_halton\)\} : std::pair<bbl::StoredEngine, bbl::RenderTargetHandle>\{bbl::StoredEngine\{v_\w+\}, v_fn\d+_sceneTarget\.rt\}\)/,
    );
    assert.match(
        compiled,
        /bbl::render_target_color_view\(\(\*\(v_\w+\)\.first\), \(v_\w+\)\.second, /,
    );
});

test("a render-target texture result passes through a generic helper as itself", () => {
    const compiled = compileSource(
        program(`
    interface TrackedEntry { kind: "rt"; rt: RenderTarget }
    const entries = new Set<TrackedEntry>();
    function track<T extends RenderTargetTextureResult>(owner: SceneContext, rtt: T): T {
        const entry: TrackedEntry = { kind: "rt", rt: rtt.rt };
        entries.add(entry);
        onSceneDispose(owner, () => { entries.delete(entry); disposeRenderTargetTexture(rtt); });
        return rtt;
    }
    const samples = Math.random() > 0.5 ? 4 : 1;
    const resolved = samples > 1 ? track(scene, createSurfaceRenderTargetTexture(engine, { lbl: "resolve", dFormat: "depth24plus", samples: 1, size: scene.surface }, withSampledDepthTexture)) : null;
    const placeholder = track(scene, createRenderTargetTexture(engine, { lbl: "ph", format: "r8unorm", samples: 1, size: { width: 1, height: 1 } }));
    void resolved;
    void placeholder;`),
    ).cpp;
    assert.match(
        compiled,
        /std::pair<bbl::StoredEngine, bbl::RenderTargetTexture>\{bbl::StoredEngine\{v_\w+\}, /,
    );
});

test("a shader material's depthWrite reads its creation state", () => {
    const compiled = compileSource(
        program(`
    const material: Material = createShaderMaterial({ name: "veil", vertexSource: "struct VertexOutput{@builtin(position) position:vec4f};@vertex fn mainVertex(input:VertexInput)->VertexOutput{var out:VertexOutput;out.position=vec4f(input.position,1.0);return out;}",
        fragmentSource: "@fragment fn mainFragment()->@location(0) vec4f{return vec4f(1.0);}", attributes: ["position"], needAlphaBlending: true });
    const source = material as ShaderMaterial;
    if (source.depthWrite && !source.needAlphaBlending) throw new Error("depth");`),
    ).cpp;
    assert.match(
        compiled,
        /bbl::shader_material_depth_write\(v_engine, v_source\)\) && !\(\(\*bbl::shader_material_alpha_blending\(v_engine, v_source\)\)\)/,
    );
});

test("a shader material's depth-write state and a render-target texture's identity natively", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler unavailable");
        return;
    }
    runGeneratedProgram(
        tools,
        "post-chain-engines",
        `#include <bblite/runtime.hpp>
#include <iostream>
using namespace bbl;
int main() {
    Engine engine;
    MaterialRecord shader;
    shader.shader_material = true;
    shader.shader_depth_write = false;
    engine.materials.push_back(shader);
    engine.materials.push_back(MaterialRecord{});
    const auto depth = shader_material_depth_write(engine, MaterialHandle{0});
    const auto other = shader_material_depth_write(engine, MaterialHandle{1});
    RenderTargetTexture first;
    first.rt = RenderTargetHandle{3};
    RenderTargetTexture copy = first;
    RenderTargetTexture second;
    second.rt = RenderTargetHandle{4};
    std::cout << depth.has_value() << (depth.has_value() && *depth) << other.has_value() << " "
              << (first == copy) << (first == second);
}
`,
        { timeoutMs: 20000, expectedOutput: "100 10" },
    );
});
