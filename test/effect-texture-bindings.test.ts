import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerPixelsTexture3DFactory } from "../src/lowering/pixels-texture-volume.js";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const program = (body: string): string => `
import {createEngine,createEffectWrapper,createRenderTargetTexture,createSolidTexture2D,setEffectTexture} from "@babylonjs/lite";
async function main(){
    const engine=await createEngine({});
    const effect=createEffectWrapper(engine,{name:"bindings",fragmentWGSL:"@group(0) @binding(0) var s:sampler;@group(0) @binding(1) var a:texture_2d<f32>;@fragment fn effectFragment(input:EffectVertexOutput)->@location(0) vec4<f32>{return textureSample(a,s,input.uv);}",
        bindings:[{binding:0,kind:"sampler",textureBinding:1},{name:"named",binding:1,kind:"texture"}]});
    const target=createRenderTargetTexture(engine,{lbl:"source",format:"rgba8unorm",samples:1,size:{width:4,height:4}});
    const solid=createSolidTexture2D(engine,1,0,0,1);
    ${body}
}
main();`;

test("effect textures take render targets and bindings by number or name", () => {
    const compiled = compileSource(
        program(
            `setEffectTexture(effect,1,target.texture);setEffectTexture(effect,"1",solid);setEffectTexture(effect,"named",target.texture);const key=Math.round(Math.random())+1;setEffectTexture(effect,key,solid);`,
        ),
    );
    assert.match(
        compiled.cpp,
        /bbl::set_effect_texture\(v_engine, v_effect, bbl::EffectBindingKey\{static_cast<double>\(1\.0\)\}, v_target\.texture\)/,
    );
    assert.match(
        compiled.cpp,
        /bbl::EffectBindingKey\{std::string\("1"\)\}, v_solid\)/,
    );
    assert.match(
        compiled.cpp,
        /bbl::EffectBindingKey\{std::string\("named"\)\}, v_target\.texture\)/,
    );
    assert.match(
        compiled.cpp,
        /bbl::EffectBindingKey\{static_cast<double>\(v_key\)\}, v_solid\)/,
    );
});

test("effect textures take a binding a table holds as a name or a number", () => {
    // The key is one of either kind, known only at run time.
    const compiled = compileSource(
        program(
            `const sources:readonly (readonly [string|number,()=>number])[]=[["named",()=>1],[1,()=>2]];const [binding,source]=sources[Math.round(Math.random())]!;if(source()>0)setEffectTexture(effect,binding,solid);`,
        ),
    );
    // The pair's lane is projected to the name-or-number union where the
    // pattern reads it; the call visits that.
    assert.match(
        compiled.cpp,
        /auto v_binding = \(\[&\]\(\) -> std::variant<double, std::string> \{ const auto \w+ = bbl::js::snapshot_value\(\(\*bbl::js::array_relative_at</,
    );
    assert.match(
        compiled.cpp,
        /bbl::set_effect_texture\(v_engine, v_effect, std::visit\(\[\]\(const auto& member\) \{ return bbl::EffectBindingKey\{member\}; \}, v_binding\), v_solid\)/,
    );
});

test("effect textures bind a render target's depth with a depth layout", () => {
    const compiled = compileSource(
        program(
            `const depth=createRenderTargetTexture(engine,{lbl:"depth",format:"rgba8unorm",dFormat:"depth24plus",samples:1,size:{width:4,height:4}});if(depth.depthTexture)setEffectTexture(effect,1,depth.depthTexture);`,
        )
            .replace(
                '{binding:0,kind:"sampler",textureBinding:1},{name:"named",binding:1,kind:"texture"}',
                '{name:"named",binding:1,kind:"texture",textureSampleType:"depth",viewDimension:"2d"}',
            )
            .replace(
                "@group(0) @binding(0) var s:sampler;@group(0) @binding(1) var a:texture_2d<f32>;",
                "@group(0) @binding(1) var a:texture_depth_2d;",
            )
            .replace(
                "textureSample(a,s,input.uv)",
                "vec4f(textureLoad(a,vec2i(0),0))",
            ),
    );
    assert.match(
        compiled.cpp,
        /bbl::set_effect_texture\(v_engine, v_effect, bbl::EffectBindingKey\{static_cast<double>\(1\.0\)\}, .*depth/,
    );
});

test("shader materials bind render-target colour and depth textures", () => {
    const source = (texture: string): string => `
import {createEngine,createRenderTargetTexture,createShaderMaterial,setShaderTexture} from "@babylonjs/lite";
async function main(){
    const engine=await createEngine({});
    const target=createRenderTargetTexture(engine,{lbl:"source",format:"rgba8unorm",dFormat:"depth24plus",samples:1,size:{width:4,height:4}});
    const material=createShaderMaterial({vertexSource:"struct VertexOutput{@builtin(position) position:vec4f};@vertex fn mainVertex(input:VertexInput)->VertexOutput{var out:VertexOutput;out.position=vec4f(input.position,1.0);return out;}",
        fragmentSource:"@fragment fn mainFragment()->@location(0) vec4f{return textureSample(picture,pictureSampler,vec2f(0.5));}",
        attributes:["position"],samplers:["picture"]});
    ${texture}
}
main();`;
    assert.match(
        compileSource(
            source(`setShaderTexture(material,"picture",target.texture);`),
        ).cpp,
        /bbl::set_shader_render_texture\(v_engine, v_material, 0u, v_target\.texture\)/,
    );
    assert.match(
        compileSource(
            source(
                `if(target.depthTexture)setShaderTexture(material,"picture",target.depthTexture);`,
            )
                .replace(
                    'samplers:["picture"]',
                    'samplers:[{name:"picture",sampleType:"depth"}]',
                )
                .replace(
                    "textureSample(picture,pictureSampler,vec2f(0.5))",
                    "vec4f(textureLoad(picture,vec2i(0),0))",
                ),
        ).cpp,
        /bbl::set_shader_render_texture\(v_engine, v_material, 0u, .*depth/,
    );
});

test("an effect wrapper's blend state records its factors and refuses another equation", () => {
    const wrapper = (blend: string): string => `
import {createEngine,createEffectWrapper} from "@babylonjs/lite";
async function main(){
    const engine=await createEngine({});
    createEffectWrapper(engine,{name:"halo",fragmentWGSL:"@fragment fn effectFragment(input:EffectVertexOutput)->@location(0) vec4<f32>{return vec4<f32>(1.0);}",bindings:[],blend:${blend}});
}
main();`;
    // A component's omitted operation is add; the alpha factors are its own.
    const compiled = compileSource(
        wrapper(
            `{color:{srcFactor:"src-alpha",dstFactor:"one-minus-src-alpha",operation:"add"},alpha:{srcFactor:"one",dstFactor:"one-minus-src-alpha"}}`,
        ),
    );
    assert.deepEqual(compiled.manifest.effects[0]?.blend, [
        "src-alpha",
        "one-minus-src-alpha",
        "one",
        "one-minus-src-alpha",
    ]);
    assert.throws(
        () =>
            compileSource(
                wrapper(
                    `{color:{srcFactor:"one",dstFactor:"one",operation:"max"},alpha:{}}`,
                ),
            ),
        /A blend state supports the add operation only/,
    );
});

const texture3DFixture = "test/fixtures/effect-texture-3d.ts";

test("effect textures take Texture3D values through 3d view bindings", () => {
    const compiled = compileSource(readFileSync(texture3DFixture, "utf8"), {
        fileName: texture3DFixture,
    });
    const bindings = compiled.manifest.effects[0]?.bindings ?? [];
    assert.deepEqual(
        bindings
            .filter((binding) => binding.kind === "texture")
            .map((binding) => [binding.binding, binding.viewDimension]),
        [
            [1, "3d"],
            [2, "3d"],
            [4, "3d"],
        ],
    );
    // Each sampler pairs with the texture its textureBinding names.
    assert.deepEqual(
        bindings
            .filter((binding) => binding.kind === "sampler")
            .map((binding) => [binding.binding, binding.texture]),
        [
            [0, 0],
            [3, 1],
        ],
    );
    assert.ok(compiled.manifest.features.includes("texture:pixels-3d"));
    // The default sampler rides the factory; a named filter travels as named.
    assert.match(
        compiled.cpp,
        /bbl::create_texture_3d_from_pixels\(v_\w+, v_\w+, 2\.0, 2\.0, 2\.0\)/,
    );
    assert.match(
        compiled.cpp,
        /bbl::create_texture_3d_from_pixels\(v_\w+, v_\w+, 3\.0, 2\.0, 4\.0, bbl::PixelsTexture3DOptions\{bbl::TextureFilter::nearest, true, \{\}, false, false\}\)/,
    );
    assert.match(
        compiled.cpp,
        /bbl::set_effect_texture\(v_engine, v_effect, bbl::EffectBindingKey\{std::string\("cube"\)\}, v_cube\)/,
    );
});

test("effect texture view dimensions and 3D texture options refuse what is not lowered", () => {
    const fixture = readFileSync(texture3DFixture, "utf8");
    const refused = (from: string, to: string, message: RegExp): void => {
        assert.ok(fixture.includes(from), from);
        assert.throws(
            () =>
                compileSource(fixture.replace(from, to), {
                    fileName: texture3DFixture,
                }),
            message,
        );
    };
    refused(
        '{ binding: 4, kind: "texture", viewDimension: "3d" }',
        '{ binding: 4, kind: "texture", viewDimension: "cube" }',
        /Effect textures take a 2d or a 3d view\./,
    );
    refused(
        '{ binding: 4, kind: "texture", viewDimension: "3d" }',
        '{ binding: 4, kind: "texture", textureSampleType: "depth", viewDimension: "3d" }',
        /A depth effect texture takes a 2d view\./,
    );
    refused(
        '{ filter: "nearest" }',
        '{ addressModeU: "repeat" }',
        /createTexture3DFromPixels 'addressModeU' is not lowered/,
    );
    refused(
        '{ filter: "nearest" }',
        '{ filter: "cubic" as GPUFilterMode }',
        /createTexture3DFromPixels filter 'cubic' is not one of the pinned literals/,
    );
});

test("createTexture3DFromPixels keeps the volume with the pin's sampler and refusals", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler unavailable");
        return;
    }
    const factory = lowerPixelsTexture3DFactory(new LoweringContext());
    const lifted = [
        "PixelsTexture create_texture_3d_from_bytes(",
        "PixelsTexture create_texture_3d_from_pixels( Engine& engine, const js::U8Array& pixels,",
    ]
        .map((signature) => cppFunction(factory, signature))
        .join("\n");
    runGeneratedProgram(
        tools,
        "test-texture-3d-factory",
        `#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <cstdio>
#include <stdexcept>
#include <string>
namespace bbl {
${lifted}
} // namespace bbl
static bbl::js::U8Array bytes(std::size_t count) {
    return bbl::js::U8Array(bbl::js::ArrayBuffer(std::vector<std::uint8_t>(count, 7)));
}
static void refuses(const std::string& expected, double w, double h, double d, std::size_t count) {
    bbl::Engine engine;
    try {
        bbl::create_texture_3d_from_pixels(engine, bytes(count), w, h, d);
    } catch (const std::runtime_error& error) {
        if (error.what() == expected) return;
        std::printf("%s\\n", error.what());
    }
    throw std::runtime_error("expected: " + expected);
}
int main() {
    using namespace bbl;
    Engine engine;
    const PixelsTexture lut = create_texture_3d_from_pixels(engine, bytes(4 * 2 * 3 * 4), 4, 2, 3);
    if (lut.width != 4 || lut.height != 2 || lut.depth != std::optional<std::uint32_t>{3} ||
        lut.srgb || lut.rgba.size() != 96)
        throw std::runtime_error("volume extent");
    // The pin's defaults: linear on both filters, clamp-to-edge on U, V and W, one level.
    const TextureSamplerState& sampler = lut.sampler;
    if (sampler.min_filter != TextureFilter::linear || sampler.mag_filter != TextureFilter::linear ||
        sampler.address_u != TextureAddressMode::clamp ||
        sampler.address_v != TextureAddressMode::clamp ||
        sampler.address_w != TextureAddressMode::clamp ||
        sampler.mipmap_mode != TextureMipmapMode::nearest || sampler.max_lod != 0.0f)
        throw std::runtime_error("default sampler");
    const PixelsTexture named = create_texture_3d_from_pixels(
        engine, bytes(8 * 4), 2, 2, 2,
        PixelsTexture3DOptions{TextureFilter::nearest, true, TextureAddressMode::repeat, true, true});
    if (named.sampler.min_filter != TextureFilter::nearest ||
        named.sampler.mag_filter != TextureFilter::nearest ||
        named.sampler.address_u != TextureAddressMode::repeat ||
        named.sampler.address_w != TextureAddressMode::repeat || !named.srgb ||
        named.identity == lut.identity)
        throw std::runtime_error("named options");
    // A 3D texture never binds where a 2D texture is read.
    try {
        static_cast<void>(pixels_texture_data(lut));
        throw std::logic_error("bound a 3D texture as 2D");
    } catch (const std::runtime_error&) {
    }
    refuses("createTexture3DFromPixels: width/height/depth must be >= 1 (got 2x0x2)", 2, 0, 2, 64);
    refuses("createTexture3DFromPixels: data too short \u2014 need 64 bytes for 2x2x4 RGBA, got 63",
            2, 2, 4, 63);
}
`,
        { expectedOutput: "", timeoutMs: 10000 },
    );
});
