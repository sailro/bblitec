import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerShadowEnabled } from "../src/lowering/shadow-enabled.js";
import {
    createJavaScriptFunction,
    transpileCommonJs,
} from "../src/typescript-transpile.js";
import {
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const source = new LoweringContext();
const module = "src/shadow/shadow-enabled.ts";

test("shadow enable transitions and receiver lanes match pinned execution", (t) => {
    const native = optionalNativeFixtureTools();
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const functions = [
        "setShadowGeneratorEnabled",
        "syncShadowGeneratorEnabled",
    ]
        .map((name) =>
            source
                .functionDeclaration(module, name)
                .declaration.getText()
                .replace("export ", ""),
        )
        .join("\n");
    const expected: unknown = createJavaScriptFunction(
        transpileCommonJs(
            `
const F32=Float32Array;
function ThrowLiteError(code){throw new Error(String(code));}
${functions}
const result=[];
for(const type of ['pcf','csm']){
 let uploaded=0;
 const generator={_renderShadowMap:()=>7,_shadowType:type,_shadowsInfo:[0.35],_shadowUBO:{},_version:0};
 const engine={_device:{queue:{writeBuffer(_buffer,offset,data){uploaded=data[0];if(offset!==(type==='csm'?72:20)*4)throw new Error('offset');}}}};
 for(const enabled of [true,false,false,true,true,false]){
  setShadowGeneratorEnabled(generator,enabled);
  generator._renderShadowMap(engine,{});
  result.push([generator._version,generator._runtimeEnabledState.enabled,uploaded]);
 }
}
return result;`,
            module,
        ),
    )();
    const directory = resolve("artifacts/test-shadow-enabled");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        resolve(directory, "expected.json"),
        JSON.stringify(expected),
    );
    const cpp = resolve(directory, "check.cpp"),
        exe = resolve(directory, "check.exe");
    writeFileSync(
        cpp,
        `#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <nlohmann/json.hpp>
#include <cassert>
#include <cstring>
#include <fstream>
namespace bbl::upstream {
struct ShadowReceiverBlock {std::array<std::byte,320> bytes{};std::size_t size=320;};
${lowerShadowEnabled(source)}
}
int main(){
 bbl::Engine engine;engine.shadow_generators.resize(1);
 nlohmann::json actual=nlohmann::json::array();
 for(const bool csm:{false,true}){
  auto& generator=engine.shadow_generators[0];generator=bbl::ShadowGeneratorRecord{};
  generator.filter=csm?bbl::ShadowFilter::csm_directional:bbl::ShadowFilter::pcf_spot;generator.darkness=0.35;
  bbl::upstream::ShadowEnabledUploadState state;
  for(const bool enabled:{true,false,false,true,true,false}){
   bbl::upstream::set_shadow_generator_enabled(engine,bbl::ShadowGeneratorHandle{0},enabled);
   bbl::upstream::ShadowReceiverBlock block;block.size=csm?320:96;
   const auto callbacks=std::make_shared<bbl::PlatformEventListeners<void(const bbl::js::F32Array&)>>();
   (void)bbl::upstream::synchronize_shadow_enabled(generator,state,1,
    []{return std::optional<bbl::js::F32Array>{};},[&]{return callbacks;},
    [&](std::uint64_t,double offset,const auto& data){std::memcpy(block.bytes.data()+static_cast<std::size_t>(offset),data.data(),sizeof(float));});
   float darkness=0;const std::size_t offset=(csm?72u:20u)*sizeof(float);
   darkness=state.upload_data[0];
   for(std::size_t index=0;index<block.bytes.size();++index) if(index<offset||index>=offset+sizeof(float))assert(block.bytes[index]==std::byte{});
   actual.push_back({generator.runtime_enabled_version,*generator.runtime_enabled,darkness});
  }
 }
 nlohmann::json expected;std::ifstream("expected.json")>>expected;assert(actual==expected);
}`,
    );
    runNativeFixtureCompiler(native, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/permissive-",
        "/EHsc",
        "/MD",
        "/DBBLITE_SHADOWS_CSM=1",
        `/Fo:${directory}/`,
        `/Fe:${exe}`,
        "/I",
        resolve("native/include"),
        "/I",
        resolve(nativeFixtureVcpkgRoot, "include"),
        cpp,
    ]);
    assert.equal(execFileSync(exe, { cwd: directory, encoding: "utf8" }), "");
});

test("runtime shadow enable intrinsic keeps the owning generator", () => {
    const result =
        compileSource(`import {createEngine,createSceneContext,createDirectionalLight,addToScene,createCsmDirectionalShadowGenerator,setShadowGeneratorEnabled} from '@babylonjs/lite';
async function main(){const engine=await createEngine(document.createElement('canvas'));const scene=createSceneContext(engine);const light=createDirectionalLight({x:0,y:-1,z:0});addToScene(scene,light);const shadows=createCsmDirectionalShadowGenerator(engine,light);setShadowGeneratorEnabled(shadows,false);}void main();`);
    assert.match(result.cpp, /set_shadow_generator_enabled\([^\n]*false\)/);
});

test("source shadow synchronization preserves uploads, allocation identity and reentrant callback order", (t) => {
    const native = optionalNativeFixtureTools();
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const functions = [
        "setShadowGeneratorEnabled",
        "syncShadowGeneratorEnabled",
    ]
        .map((name) =>
            source
                .functionDeclaration(module, name)
                .declaration.getText()
                .replace("export ", ""),
        )
        .join("\n");
    const expected: unknown = createJavaScriptFunction(
        transpileCommonJs(
            `
const F32=Float32Array;function ThrowLiteError(code){throw new Error(String(code));}
${functions}
const result=[];
for(const type of ['pcf','csm'])for(const hasData of [false,true])for(const reentrant of [false,true]){
 const history=[];const task=hasData?{_uboData:new F32(80)}:{};let rendered=0,notified=0;
 const generator={_shadowType:type,_shadowsInfo:[0.35],_shadowUBO:{id:1},_version:0,
  _renderShadowMap(){history.push(['render',++rendered]);if(type==='csm'&&task._uboData){task._uboData[0]=rendered;task._uboData[72]=generator._shadowsInfo[0];for(const callback of generator._onReceiverData)callback(task._uboData);}return 1;},
  _onReceiverData:[data=>{history.push(['callback',data[0],data[72]]);if(reentrant&&++notified===1)setShadowGeneratorEnabled(generator,false);}]
 };
 const engine={_device:{queue:{writeBuffer(ubo,offset,data){history.push(['upload',ubo.id,offset,data[0]]);}}}};
 for(const [index,enabled] of [true,true,false,false,true,true].entries()){
  if(index===5)generator._shadowUBO={id:2};
  setShadowGeneratorEnabled(generator,enabled);generator._renderShadowMap(engine,task);
  const state=generator._runtimeEnabledState;
  history.push(['state',generator._version,state.enabled,state.uploadedEnabled,state.uploadedUbo.id]);
 }
 result.push({history,rendered});
}return result;`,
            module,
        ),
    )();
    const directory = resolve("artifacts/test-shadow-enabled-callbacks");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        resolve(directory, "expected.json"),
        JSON.stringify(expected),
    );
    const cpp = resolve(directory, "check.cpp"),
        exe = resolve(directory, "check.exe");
    writeFileSync(
        cpp,
        `#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <nlohmann/json.hpp>
#include <cassert>
#include <cstring>
#include <fstream>
namespace bbl::upstream {
struct ShadowReceiverBlock {std::array<std::byte,320> bytes{};std::uint32_t size=320;};
inline ShadowReceiverBlock shadow_receiver_block(const ShadowGeneratorRecord&) {return {};}
${lowerShadowEnabled(source)}
}
int main(){
 nlohmann::json actual=nlohmann::json::array();
 for(const bool csm:{false,true})for(const bool has_data:{false,true})for(const bool reentrant:{false,true}){
  bbl::Engine engine;engine.shadow_generators.resize(1);auto& generator=engine.shadow_generators[0];
  generator.filter=csm?bbl::ShadowFilter::csm_directional:bbl::ShadowFilter::pcf_spot;generator.darkness=0.35;
  nlohmann::json history=nlohmann::json::array();unsigned rendered=0,notified=0;
  bbl::upstream::ShadowEnabledUploadState state;std::uint64_t receiver_identity=1;
  std::optional<bbl::js::F32Array> receiver_data;if(has_data)receiver_data.emplace(80);
  const auto callbacks=std::make_shared<bbl::PlatformEventListeners<void(const bbl::js::F32Array&)>>();
  callbacks->add(1,[&](const bbl::js::F32Array& data){
   history.push_back({"callback",data[0],data[72]});if(reentrant&&++notified==1)bbl::upstream::set_shadow_generator_enabled(engine,bbl::ShadowGeneratorHandle{0},false);
  });
  unsigned index=0;
  for(const bool enabled:{true,true,false,false,true,true}){
   if(index++==5)receiver_identity=2;
   bbl::upstream::set_shadow_generator_enabled(engine,bbl::ShadowGeneratorHandle{0},enabled);
   const bool due=bbl::upstream::synchronize_shadow_enabled(generator,state,receiver_identity,[&]{return receiver_data;},[&]{return callbacks;},
    [&](std::uint64_t identity,double offset,const auto& data){history.push_back({"upload",identity,offset,data[0]});});
   if(due){history.push_back({"render",++rendered});if(csm&&receiver_data){(*receiver_data)[0]=static_cast<float>(rendered);(*receiver_data)[72]=static_cast<float>(generator.darkness);callbacks->dispatch(*receiver_data);}}
   history.push_back({"state",generator.runtime_enabled_version,*generator.runtime_enabled,*state.uploaded_enabled,*state.uploaded_ubo});
  }
  actual.push_back({{"history",history},{"rendered",rendered}});
 }
 nlohmann::json expected;std::ifstream("expected.json")>>expected;assert(actual==expected);
}`,
    );
    runNativeFixtureCompiler(native, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/permissive-",
        "/EHsc",
        "/MD",
        `/Fo:${directory}/`,
        `/Fe:${exe}`,
        "/I",
        resolve("native/include"),
        "/I",
        resolve(nativeFixtureVcpkgRoot, "include"),
        cpp,
    ]);
    assert.equal(execFileSync(exe, { cwd: directory, encoding: "utf8" }), "");
});

class ChangedShadowEnabledContext extends LoweringContext {
    private changed: ts.SourceFile | undefined;
    constructor(private readonly change: (text: string) => string) {
        super(source.store);
    }
    override sourceFile(path: string): ts.SourceFile {
        const file = super.sourceFile(path);
        if (path !== module) return file;
        return (this.changed ??= ts.createSourceFile(
            path,
            this.change(file.text),
            ts.ScriptTarget.Latest,
            true,
        ));
    }
}

test("shadow synchronization lowers source guards and publication statements and refuses changed callback transport", () => {
    const changed = lowerShadowEnabled(
        new ChangedShadowEnabledContext((text) =>
            text
                .replace("state.uploadedUbo === generator._shadowUBO", "false")
                .replace(
                    "state.uploadedEnabled = state.enabled;",
                    "state.uploadedEnabled = state.enabled; generator._version++;",
                ),
        ),
    );
    const sync = changed.slice(
        changed.indexOf("inline bool synchronize_shadow_enabled"),
    );
    assert.match(sync, /state\.uploaded_enabled[^\n]+&& \(false\)/);
    assert.match(
        sync,
        /state\.uploaded_enabled = [^;]+;\s*generator\.runtime_enabled_version\+\+/,
    );
    assert.throws(
        () =>
            lowerShadowEnabled(
                new ChangedShadowEnabledContext((text) =>
                    text.replace(
                        "index < callbacks.length",
                        "index + 1 < callbacks.length",
                    ),
                ),
            ),
        /CSM receiver callback traversal/,
    );
});
