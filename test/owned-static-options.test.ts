import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { SpriteLowerer } from "../src/lowering/sprite-lowerer.js";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const imports = `import {createEngine,createComputeShader,computeUniformBufferBinding,createSpriteRenderer} from '@babylonjs/lite';`;
const engine = `const engine=await createEngine(document.getElementById('renderCanvas') as HTMLCanvasElement);`;
const wgsl = "@compute @workgroup_size(1) fn custom() {}";

test("owned compute options retain shader facts and read the live binding collection", () => {
    const result = compileSource(`${imports}
async function main(){
 ${engine}
 const bindings:ReturnType<typeof computeUniformBufferBinding>[]=[];
 const options:Parameters<typeof createComputeShader>[1]={computeSource:${JSON.stringify(wgsl)},entryPoint:'custom',bindings};
 bindings.push(computeUniformBufferBinding('params',{group:0,binding:0}));
 createComputeShader(engine,options);
}void main();`);
    assert.deepEqual(
        result.manifest.computePrograms?.map(({ source, entryPoint }) => ({
            source,
            entryPoint,
        })),
        [{ source: wgsl, entryPoint: "custom" }],
    );
    // The stored bindings are read after the append, not reconstructed from
    // the empty initializer whose scalar facts accompany the owned record.
    assert.match(result.cpp, /\.bindings\.assign\(/);
    assert.ok(
        result.cpp.indexOf("array_push") <
            result.cpp.indexOf(".bindings.assign("),
    );
});

test("owned shader inputs with invalidated or runtime facts refuse generation", () => {
    for (const update of [
        `options.computeSource=String(Date.now());`,
        `const alias=options;alias.entryPoint=String(Date.now());`,
        `delete options.entryPoint;`,
    ]) {
        assert.throws(
            () =>
                compileSource(`${imports}
async function main(){
 ${engine}
 const options:{computeSource:string;entryPoint?:string}={computeSource:${JSON.stringify(wgsl)},entryPoint:'custom'};
 ${update}
 createComputeShader(engine,options);
}void main();`),
            /generation-known WGSL and entry points/,
        );
    }
});

test("owned shader options preserve absent defaults", () => {
    const result = compileSource(`${imports}
async function main(){${engine}
const options:Parameters<typeof createComputeShader>[1]={computeSource:'@compute @workgroup_size(1) fn main() {}'};
createComputeShader(engine,options);}void main();`);
    assert.equal(result.manifest.computePrograms?.[0]?.entryPoint, "main");
});

test("sprite clear readers retain their original owner through alias writes and dispose", (t) => {
    const result = compileSource(`${imports}
import {disposeSpriteRenderer} from '@babylonjs/lite';
async function main(){${engine}
let color:{r:number;g:number;b:number;a:number}={r:.2,g:.3,b:.4,a:1};
const alias=color;
const renderer=createSpriteRenderer(engine,{layers:[],clearValue:color});
color={r:.9,g:.9,b:.9,a:1};
alias.r=.8; alias.g=.7;
disposeSpriteRenderer(renderer);
const raw={r:.2,g:.3,b:.4,a:1};
const next=createSpriteRenderer(engine,{layers:[],clearValue:raw});
raw.r=.8;raw.g=.7;disposeSpriteRenderer(next);
}void main();`);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    const directory = resolve("artifacts/owned-sprite-clear");
    const include = join(directory, "bblite/upstream");
    mkdirSync(include, { recursive: true });
    const lowered = new SpriteLowerer(new LoweringContext()).lowerCore();
    writeFileSync(join(include, "sprite_layer.hpp"), lowered.header);
    writeFileSync(join(directory, "program.hpp"), result.cpp);
    writeFileSync(
        join(directory, "check.cpp"),
        `
#define main generated_main
#include "program.hpp"
#undef main
#include <cassert>
namespace bbl {
Engine create_engine(EngineOptions){return {};}
${cppFunction(lowered.source, "SpriteRendererHandle create_sprite_renderer(").replace("create_sprite_renderer(", "fixture_create_sprite_renderer(")}
${cppFunction(lowered.source, "void unregister_sprite_renderer(")}
${cppFunction(lowered.source, "void dispose_sprite_renderer(").replace("dispose_sprite_renderer(", "fixture_dispose_sprite_renderer(")}
SpriteRendererHandle create_sprite_renderer(Engine& engine,SpriteRendererOptions options){
 const auto handle=fixture_create_sprite_renderer(engine,std::move(options));
 const auto& record=handle_at(engine.sprite_renderers,handle);
 assert(record.clear_value_reader);
 const auto before=sprite_renderer_clear_value(record);
 assert(before.r==0.2f&&before.g==0.3f&&before.b==0.4f&&before.a==1.0f);
 return handle;
}
void dispose_sprite_renderer(Engine& engine,SpriteRendererHandle handle){
 auto& record=handle_at(engine.sprite_renderers,handle);
 const auto current=sprite_renderer_clear_value(record);
 assert(current.r==0.8f&&current.g==0.7f&&current.b==0.4f&&current.a==1.0f);
 // Moving the renderer record, as native storage growth/recovery permits,
 // retains the same source owner and reads it again.
 auto relocated=std::move(record);record=std::move(relocated);
 assert(sprite_renderer_clear_value(record).r==0.8f);
 fixture_dispose_sprite_renderer(engine,handle);
 assert(record.disposed&&!record.clear_value_reader);
}
}
int main(){const auto before=bbl::js::managed_node_count();assert(generated_main()==0);bbl::js::collect_cycles();assert(bbl::js::managed_node_count()==before);}
`,
    );
    const executable = join(directory, "check.exe");
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        "/I",
        "native/include",
        "/I",
        directory,
        join(directory, "check.cpp"),
        `/Fo${directory}/`,
        `/Fe${executable}`,
    ]);
    execFileSync(executable, {
        stdio: "pipe",
        windowsHide: true,
        timeout: 10000,
    });
});

test("owned options do not hide newly assigned fields or accessor color reads", () => {
    assert.throws(
        () =>
            compileSource(`${imports}
async function main(){${engine}
const options:{computeSource:string;entryPoint:string;automaticLayout?:boolean}={computeSource:${JSON.stringify(wgsl)},entryPoint:'custom'};
options.automaticLayout=true;createComputeShader(engine,options);}void main();`),
        /Unrepresented compute shader option automaticLayout/,
    );
    assert.throws(
        () =>
            compileSource(`${imports}
async function main(){${engine}
const color:{r:number;g:number;b:number;a:number}={get r(){return .2;},g:.3,b:.4,a:1};
createSpriteRenderer(engine,{layers:[],clearValue:color});}void main();`),
        /Property 'r' is an accessor/,
    );
});
