import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("render texture facades retain pinned engine owners across suspended and stored calls", (t) => {
    const result = compileSource(`
        import {createEngine,createRenderTargetTexture,withSampledDepthTexture,type Texture2D} from "@babylonjs/lite";
        async function pack(texture:Texture2D):Promise<void> {
            await Promise.resolve();
            const values:Texture2D[]=[texture,texture];
            if(values.length!==2||values[0]!==values[1])throw new Error("suspended texture identity");
        }
        function retain(texture:Texture2D):()=>number {return ()=>{const values:Texture2D[]=[texture,texture];if(values[0]!==values[1])throw new Error("stored texture identity");return values.length;};}
        const engine=await createEngine(new OffscreenCanvas(1,1));
        const target=createRenderTargetTexture(engine,{format:"rgba8unorm",dFormat:"depth32float",samples:1,size:{width:7,height:9}},withSampledDepthTexture);
        const saved=retain(target.texture);
        await pack(target.depthTexture!);
        const first=saved(),second=saved();
        if(first!==2||second!==2)throw new Error("stored calls");
        globalThis.close();
    `);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Requires the Windows native fixture compiler.");
        return;
    }
    assert.ok(result.cpp.includes("bbl::retained_render_texture("));
    runGeneratedProgram(
        tools,
        "render-texture-captures",
        `
#include <bblite/pal_async_engine.hpp>
#include <cassert>
namespace { std::shared_ptr<bbl::Engine> original; }
namespace bbl::pal {
std::shared_ptr<Engine> create_realm_engine(EngineOptions, const std::shared_ptr<OffscreenCanvas>&) {
    original=std::make_shared<Engine>();
    return original;
}
}
#define main generated_main
${result.cpp}
#undef main
namespace bbl {
std::uint32_t render_target_dimension(double value){return static_cast<std::uint32_t>(value);}
RenderTargetTexture create_render_target_texture(Engine& engine,RenderTargetOptions options,bool surface_sized){
    assert(&engine==original.get()&&!surface_sized&&options.sampled_depth);
    RenderTargetRecord record;
    record.width=options.width;record.height=options.height;
    record.has_depth=true;record.sampled_depth=true;
    const RenderTargetHandle target{static_cast<std::uint32_t>(engine.render_targets.size())};
    engine.render_targets.push_back(record);
    RenderTextureRef color;color.target=target;
    RenderTextureRef depth=color;depth.depth_only=true;
    return {target,color,depth};
}
}
int main(){
    assert(generated_main()==0);
    assert(original&&original->render_targets.size()==1&&original->render_texture_facades.size()==2);
    for(const auto& facade:original->render_texture_facades){
        assert(facade.width==7&&facade.height==9);
        assert(facade.data.render_source->engine==original.get());
    }
    original.reset();
}
`,
        {
            defines: ["BBLITE_WORKERS=1", "BBLITE_OFFSCREEN_SURFACES=1"],
            timeoutMs: 10000,
            expectedOutput: "",
        },
    );
});
