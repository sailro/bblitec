import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";

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

test("effect textures refuse a render target's depth", () => {
    assert.throws(
        () =>
            compileSource(
                program(
                    `const depth=createRenderTargetTexture(engine,{lbl:"depth",format:"rgba8unorm",dFormat:"depth24plus",samples:1,size:{width:4,height:4}});if(depth.depthTexture)setEffectTexture(effect,1,depth.depthTexture);`,
                ),
            ),
        /depth textures are not lowered/,
    );
});
