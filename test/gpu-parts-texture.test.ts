import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const program = (texture: string): string => `
    import { createEngine, createSceneContext, createShaderMaterial, createVatBakeResult, setShaderTexture, type PreparedVatBakeResult, type Texture2D } from "@babylonjs/lite";
    const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
    createSceneContext(engine);
    const prepared: PreparedVatBakeResult = { boneCount: 1, frameCount: 2, data: new Float32Array(32), clips: { idle: { fromRow: 0, frameCount: 2, fps: 30 } } };
    const baked = createVatBakeResult(engine, prepared);
    const tex = baked.texture;
    const device = (engine as unknown as { _device: GPUDevice })._device;
    const sampler = device.createSampler({ magFilter: "nearest", minFilter: "nearest" });
    const material = createShaderMaterial({
        name: "bones",
        vertexSource: "struct VertexOutput{@builtin(position) position:vec4<f32>,};\\n@vertex fn mainVertex(input:VertexInput)->VertexOutput{var out:VertexOutput;out.position=shaderSystem.worldViewProjection*vec4<f32>(input.position*textureLoad(bones,vec2<i32>(0,0),0).x,1.0);return out;}",
        fragmentSource: "struct VertexOutput{@builtin(position) position:vec4<f32>,};\\n@fragment fn mainFragment(input:VertexOutput)->@location(0) vec4<f32>{return textureLoad(bones,vec2<i32>(1,1),0);}",
        attributes: ["position"],
        uniforms: ["worldViewProjection"],
        samplers: [{ name: "bones", sampleType: "unfilterable-float" }],
    });
    setShaderTexture(material, "bones", ${texture});
`;

test("a Texture2D built from a bake's GPU parts binds the view's texels through the sampler", () => {
    const result = compileSource(
        program(
            "{ texture: tex, view: tex.createView(), sampler, width: tex.width, height: tex.height } as unknown as Texture2D",
        ),
    );
    assert.match(result.cpp, /\.vat_bakes, v_baked\)\.texture/);
    assert.match(
        result.cpp,
        /bbl::create_device_sampler\(v_device, bbl::TextureSamplerState\{bbl::TextureFilter::nearest, bbl::TextureFilter::nearest, bbl::TextureMipmapMode::nearest, bbl::TextureAddressMode::clamp, bbl::TextureAddressMode::clamp, 1\.0f, 32\.0f\}\)/,
    );
    assert.match(result.cpp, /bbl::create_texture_view\(v_engine, v_tex\)/);
    assert.match(result.cpp, /bbl::gpu_texture_texels\(v_tex\)\.width/);
    assert.match(
        result.cpp,
        /(v_bblite_shader_texture_\d+) = bbl::StoredTexture\{bbl::gpu_parts_texture\(v_engine, v_tex, v_bblite_resource_member_\d+, v_sampler, /,
    );
    assert.match(
        result.cpp,
        /bbl::set_shader_pixels_texture\(v_engine, v_material, 0u, v_bblite_shader_texture_\d+\)/,
    );
});

test("a Texture2D's GPU parts convert only as the interface's five required fields", () => {
    for (const texture of [
        // A field the native texture does not carry.
        "{ texture: tex, view: tex.createView(), sampler, width: tex.width, height: tex.height, uScale: 2 } as unknown as Texture2D",
        // A part missing.
        "{ texture: tex, view: tex.createView(), width: tex.width, height: tex.height } as unknown as Texture2D",
    ])
        assert.throws(() => compileSource(program(texture)), /texture/i);
    // A view with a descriptor is not the whole texture.
    assert.throws(
        () =>
            compileSource(
                program(
                    "{ texture: tex, view: tex.createView({ mipLevelCount: 1 }), sampler, width: tex.width, height: tex.height } as unknown as Texture2D",
                ),
            ),
        /argument/i,
    );
});

test("the regression scene's bone texture lowers through the GPU parts", () => {
    const result = compileSource(
        readFileSync("examples/regression-vat-bone-texture.ts", "utf8"),
    );
    assert.match(result.cpp, /bbl::gpu_parts_texture\(/);
    assert.match(result.cpp, /\.texture == bbl::handle_at\(/);
});

test("GPU texture views, device samplers and parts textures keep the pin's identities and checks", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler unavailable");
        return;
    }
    runGeneratedProgram(
        tools,
        "gpu-parts-texture/identities",
        `#include <bblite/runtime.hpp>
#include <iostream>
using namespace bbl;
int main() {
    Engine engine;
    auto texels = std::make_shared<GpuTextureTexels>();
    texels->width = 4;
    texels->height = 2;
    texels->rgba.assign(32, 0.5f);
    GpuTextureIdentity texture = publish_gpu_texture_identity(engine);
    texture.texels = texels;
    GpuTextureIdentity other = publish_gpu_texture_identity(engine);
    other.texels = texels;
    const TextureSamplerState nearest{TextureFilter::nearest, TextureFilter::nearest,
                                      TextureMipmapMode::nearest, TextureAddressMode::clamp,
                                      TextureAddressMode::clamp, 1.0f, 32.0f};
    const GpuDeviceIdentity device = gpu_device_identity(engine);
    // Each createSampler and createView call is an object of its own; a
    // pooled sampler is its key.
    std::cout << (create_device_sampler(device, nearest) == create_device_sampler(device, nearest))
              << (GpuSampler{device, nearest} == GpuSampler{device, nearest})
              << (create_texture_view(engine, texture) == create_texture_view(engine, texture));
    const GpuTextureView view = create_texture_view(engine, texture);
    const GpuSampler sampler = create_device_sampler(device, nearest);
    const FileTexture bound = gpu_parts_texture(engine, texture, view, sampler, 4.0, 2.0);
    std::cout << " " << (bound.data.float_texels == texels) << bound.width << "x" << bound.height
              << (bound.data.sampler == nearest) << bound.data.has_image();
    for (const auto& [texture_part, width] :
         {std::pair{other, 4.0}, std::pair{texture, 3.0}}) {
        try {
            static_cast<void>(gpu_parts_texture(engine, texture_part, view, sampler, width, 2.0));
            std::cout << " accepted";
        } catch (const std::runtime_error&) {
            std::cout << " refused";
        }
    }
    try {
        static_cast<void>(gpu_texture_texels(GpuTextureIdentity{}));
    } catch (const std::runtime_error&) {
        std::cout << " sizeless";
    }
}
`,
        {
            timeoutMs: 10000,
            expectedOutput: "010 14x211 refused refused sizeless",
        },
    );
});
