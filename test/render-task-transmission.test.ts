import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";

const program = (options: string, body = ""): string => `
import {addTask,createEngine,createRenderTarget,createRenderTask,createSceneContext,createShaderMaterial,createSolidTexture2D,createTexture2DFromPixels,enableRenderTaskTransmission,onBeforeRender,setShaderTexture,type Texture2D} from "@babylonjs/lite";
async function main(){
    const engine=await createEngine({} as HTMLCanvasElement);
    const scene=createSceneContext(engine,{defaultRenderTask:false});
    const target=createRenderTarget({lbl:"scene",format:engine.format,dFormat:"depth24plus",samples:1,size:engine});
    const task=createRenderTask({name:"scene",rt:target,clr:true},engine,scene);
    addTask(scene,task);
    const grab=enableRenderTaskTransmission(task,engine${options});
    const material=createShaderMaterial({vertexSource:"struct VertexOutput{@builtin(position) position:vec4f};@vertex fn mainVertex(input:VertexInput)->VertexOutput{var out:VertexOutput;out.position=vec4f(input.position,1.0);return out;}",
        fragmentSource:"@fragment fn mainFragment()->@location(0) vec4f{return textureSample(picture,pictureSampler,vec2f(0.5));}",
        attributes:["position"],samplers:["picture"],transmissive:true,needAlphaBlending:true});
    const pixels=createTexture2DFromPixels(engine,new Uint8Array([0,0,0,255]),1,1);
    ${body}
}
main();`;

test("render-task transmission stores the pin's raw-mode options on the task", () => {
    const compiled = compileSource(
        program(
            `,{linear:false,copyCount:0,generateMipmaps:true,mipLevelCount:3,grabDepth:true}`,
        ),
    );
    // The backends' pass break and its grab modules compile only when reached.
    assert.ok(
        compiled.manifest.features.includes(
            "frame-graph:render-task-transmission",
        ),
    );
    const cpp = compiled.cpp;
    assert.match(
        cpp,
        /bbl::enable_render_task_transmission\(v_engine, v_task, bbl::RenderTaskTransmission\{\d+u, 0\.0, true, 3\.0, true\}\)/,
    );
    assert.match(
        cpp,
        /bbl::mark_shader_material_transmissive\(v_engine, bbl::create_shader_material\(/,
    );
    assert.match(
        compileSource(program(`,{linear:false}`)).cpp,
        /bbl::RenderTaskTransmission\{\d+u, std::nullopt, std::nullopt, std::nullopt, std::nullopt\}/,
    );
});

test("render-task transmission refuses the linear retarget", () => {
    for (const options of ["", `,{grabDepth:true}`, `,{linear:true}`])
        assert.throws(
            () => compileSource(program(options)),
            /requires linear: false/,
        );
});

test("grab textures are nullable Texture2D values beside ordinary textures", () => {
    const fallback = compileSource(
        program(
            `,{linear:false}`,
            `const solid=createSolidTexture2D(engine,1,0,0,1);onBeforeRender(scene,()=>{setShaderTexture(material,"picture",grab.texture ?? solid);});`,
        ),
    ).cpp;
    assert.match(
        fallback,
        /bbl::transmission_grab_texture\(v_engine, v_grab\)/,
    );
    assert.match(
        fallback,
        /: bbl::StoredTexture\{bbl::solid_texture_file\(v_solid\)\}\)\)/,
    );
    const local = compileSource(
        program(
            `,{linear:false,grabDepth:true}`,
            `let bound:Texture2D|null=null;onBeforeRender(scene,()=>{if(grab.depthTexture!==bound){bound=grab.depthTexture;setShaderTexture(material,"picture",bound ?? pixels);}});`,
        ),
    ).cpp;
    // The local holds the same nullable stored texture a grab read returns.
    assert.match(
        local,
        /bbl::js::Nullable<bbl::StoredTexture> v_bound = bbl::js::Nullable<bbl::StoredTexture>\{std::nullopt\}/,
    );
    assert.match(
        local,
        /v_bound = bbl::transmission_grab_depth_texture\(v_engine, v_grab\);/,
    );
    assert.match(
        local,
        /\? \(\*v_bblite_nullish_\d+\) : bbl::StoredTexture\{v_pixels\}\)\)/,
    );
});
