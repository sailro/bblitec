import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { SpriteLowerer } from "../src/lowering/sprite-lowerer.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("guarded Map and WeakMap numbers reach native numeric sinks while dictionary misses remain visible", async (t) => {
    const source = `
        import {createEngine,createTexture2DFromPixels,createSprite2DLayer,addSprite2DIndex,type SpriteAtlas} from '@babylonjs/lite';
        async function main(){
            const engine=await createEngine({});
            const texture=createTexture2DFromPixels(engine,new Uint8Array([1,2,3,255]),1,1);
            const atlas:SpriteAtlas={texture,textureSizePx:[1,1],premultipliedAlpha:true,frames:[{uvMin:[0,0],uvMax:[1,1],sourceSizePx:[1,1],pivot:[0,0]}]};
            const layer=createSprite2DLayer(atlas,{capacity:4});
            const frames=new Map<string,number>();frames.set('present',7);frames.set('zero',0);
            function visit(fn:(key:string)=>void):void{for(const key of ['present','zero','missing'])fn(key);}
            visit(key=>{const frame=frames.get(key);if(frame===undefined)return;addSprite2DIndex(layer,{positionPx:[0,0],frame});});
            interface Key {name:string;}
            const first:Key={name:'present'},zero:Key={name:'zero'},missing:Key={name:'missing'};
            const weak=new WeakMap<Key,number|null>();weak.set(first,11);weak.set(zero,0);
            for(const key of [first,zero,missing]){
                const frame=weak.get(key);
                if(frame===undefined||frame===null)continue;
                addSprite2DIndex(layer,{positionPx:[0,0],frame});
            }
            weak.set(first,null);
            if(weak.get(first)!==null||weak.get(missing)!==undefined)throw new Error('nullable map values');
            const dictionary:Record<string,number>={present:21,zero:0};
            visit(key=>{
                const frame=dictionary[key];
                if(key==='missing'&&frame!==undefined)throw new Error('dictionary miss');
                if(key!=='missing'&&frame!==(key==='zero'?0:21))throw new Error('dictionary value');
            });
        }
    `;
    const observed: number[] = [];
    await runInNewContext(
        ts.transpileModule(`${source}\nmain();`, {
            compilerOptions: {
                target: ts.ScriptTarget.ES2022,
                module: ts.ModuleKind.CommonJS,
            },
        }).outputText,
        {
            exports: {},
            require: () => ({
                createEngine: () => ({}),
                createTexture2DFromPixels: () => ({}),
                createSprite2DLayer: () => ({}),
                addSprite2DIndex: (_layer: object, props: { frame: number }) =>
                    observed.push(props.frame) - 1,
            }),
        },
    );
    assert.deepEqual(observed, [7, 0, 11, 0]);
    const result = compileSource(source);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("The native fixture compiler is unavailable.");
    const directory = resolve("artifacts/map-lookup-narrowing");
    const headers = join(directory, "bblite/upstream");
    mkdirSync(headers, { recursive: true });
    writeFileSync(
        join(headers, "sprite_layer.hpp"),
        new SpriteLowerer(new LoweringContext()).lowerCore().header,
    );
    const cpp = join(directory, "check.cpp");
    const executable = join(directory, "check.exe");
    writeFileSync(
        cpp,
        `
#define main generated_main
${result.cpp}
#undef main
#include <cassert>
namespace { std::vector<float> observed; }
namespace bbl {
Engine create_engine(EngineOptions){return {};}
PixelsTexture create_texture_2d_from_pixels(Engine&,const js::U8Array&,double width,double height,PixelsTextureOptions){
    assert(width==1&&height==1);
    return {};
}
Sprite2DLayerHandle create_sprite_2d_layer(Engine& engine,SpriteAtlasHandle atlas,Sprite2DLayerOptions){
    assert(atlas.value==0&&engine.sprite_atlases.size()==1);
    return {0u};
}
double add_sprite_2d_index(Engine&,Sprite2DLayerHandle layer,Sprite2DProps props){
    assert(layer.value==0&&props.has_frame);
    observed.push_back(props.frame);
    return static_cast<double>(observed.size()-1);
}
}
int main(){
    assert(generated_main()==0);
    assert((observed==std::vector<float>{7,0,11,0}));
}
`,
    );
    runNativeFixtureCompiler(tools, [
        "/I",
        directory,
        `/Fo:${directory}/`,
        `/Fe:${executable}`,
        cpp,
    ]);
    execFileSync(executable, {
        stdio: "pipe",
        windowsHide: true,
        timeout: 10000,
    });
});
