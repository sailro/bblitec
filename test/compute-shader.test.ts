import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerComputeBindingDecl } from "../src/lowering/compute-binding-decl-lowerer.js";
import { lowerComputeShader } from "../src/lowering/compute-shader-lowerer.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("compute shader descriptors preserve sorting, dynamic slots, limits and disposal", async (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const pin = await importPinnedModule<{
        createComputeShader(
            engine: { _device: { limits: Record<string, number> } },
            options: { computeSource: string; bindings: unknown[] },
        ): {
            name: string;
            _entryPoint: string;
            _decls: { name: string }[];
            _dynamicCounts: number[];
            _slots: Map<string, { _dynamicIndex: number }>;
        };
    }>("compute/compute-shader.js");
    const uniform = await importPinnedModule<{
        computeUniformBufferBinding(
            name: string,
            options: {
                group: number;
                binding: number;
                dynamicOffset: boolean;
                minBindingSize: number;
            },
        ): unknown;
    }>("compute/compute-uniform-buffer-binding.js");
    const engine = {
        _device: {
            limits: {
                maxBindGroups: 4,
                maxBindingsPerBindGroup: 8,
                maxUniformBuffersPerShaderStage: 4,
                maxDynamicUniformBuffersPerPipelineLayout: 4,
            },
        },
    };
    const decls = [
        uniform.computeUniformBufferBinding("last", {
            group: 2,
            binding: 3,
            dynamicOffset: true,
            minBindingSize: 16,
        }),
        uniform.computeUniformBufferBinding("first", {
            group: 2,
            binding: 1,
            dynamicOffset: true,
            minBindingSize: 16,
        }),
        uniform.computeUniformBufferBinding("base", {
            group: 0,
            binding: 0,
            dynamicOffset: false,
            minBindingSize: 16,
        }),
    ];
    const expected = pin.createComputeShader(engine, {
        computeSource: "@compute @workgroup_size(1) fn main() {}",
        bindings: decls,
    });
    assert.deepEqual(
        expected._decls.map((decl) => decl.name),
        ["base", "first", "last"],
    );
    assert.deepEqual(expected._dynamicCounts, [0, 0, 2]);
    assert.equal(expected._slots.get("first")!._dynamicIndex, 0);
    assert.equal(expected._slots.get("last")!._dynamicIndex, 1);
    const directory = resolve("artifacts/compute-shader-check");
    mkdirSync(directory, { recursive: true });
    const file = resolve(directory, "check.cpp"),
        exe = resolve(directory, "check.exe"),
        context = new LoweringContext();
    writeFileSync(
        file,
        `${lowerComputeBindingDecl(context).source}\n${lowerComputeShader(context).source}
#include <cassert>
struct Device final:bbl::pal::OffscreenDevice {
 bbl::pal::ComputeShaderLimits limits;
 std::vector<bbl::pal::ComputeGroupLayoutDescriptor> groups;
 std::vector<bbl::pal::ComputePipelineDescriptor> pipelines;
 int modules=0; bool fail=false;
 bbl::pal::ComputeShaderLimits compute_shader_limits()const override{return limits;}
 std::shared_ptr<bbl::pal::ComputeGroupLayout> create_compute_group_layout(const bbl::pal::ComputeGroupLayoutDescriptor& value)override{groups.push_back(value);return std::make_shared<bbl::pal::ComputeGroupLayout>();}
 std::shared_ptr<bbl::pal::ComputePipelineLayout> create_compute_pipeline_layout(const bbl::pal::ComputePipelineLayoutDescriptor& value)override{assert(value.groups->size()==3&&value.label=="compute-layout");return std::make_shared<bbl::pal::ComputePipelineLayout>();}
 std::shared_ptr<bbl::pal::ComputeShaderModule> create_compute_shader_module(const bbl::pal::ComputeShaderModuleDescriptor& value,const std::string& artifact)override{assert(value.label=="compute-module"&&value.source=="@compute @workgroup_size(1) fn main() {}"&&artifact=="fixture.comp");++modules;return std::make_shared<bbl::pal::ComputeShaderModule>();}
 std::shared_ptr<bbl::pal::ComputePipeline> create_compute_pipeline(const bbl::pal::ComputePipelineDescriptor& value)override{pipelines.push_back(value);if(fail)throw std::runtime_error("pipeline failure");return std::make_shared<bbl::pal::ComputePipeline>();}
};
bbl::js::Promise<bbl::js::PromiseVoid> prepare_checks(bbl::pal::EventLoop& loop,std::shared_ptr<bbl::Engine> engine,std::shared_ptr<Device> device,bbl::ComputeShaderOptions options,bool& completed){
 const auto shader=bbl::create_compute_shader(engine,options);shader->artifact="fixture.comp";
 const auto before=device->pipelines.size();const auto first=bbl::prepare_compute_shader(shader),second=bbl::prepare_compute_shader(shader);
 assert(!(first==second)&&shader->pending&&!shader->pipeline&&device->pipelines.size()==before+1);
 (void)co_await first;(void)co_await second;assert(shader->pipeline&&!shader->pending);
 (void)co_await bbl::prepare_compute_shader(shader);assert(device->pipelines.size()==before+1);
 auto dead=bbl::create_compute_shader(engine,options);dead->artifact="fixture.comp";auto pending=bbl::prepare_compute_shader(dead);bbl::dispose_compute_shader(dead);
 bool rejected=false;try{(void)co_await pending;}catch(const std::exception& error){rejected=std::string(error.what())=="#823";}assert(rejected&&!dead->pipeline);
 auto retry=bbl::create_compute_shader(engine,options);retry->artifact="fixture.comp";device->fail=true;
 rejected=false;try{(void)co_await bbl::prepare_compute_shader(retry);}catch(const std::exception& error){rejected=std::string(error.what())=="pipeline failure";}assert(rejected&&!retry->pending&&!retry->pipeline);
 device->fail=false;(void)co_await bbl::prepare_compute_shader(retry);assert(retry->pipeline);
 auto stale=bbl::create_compute_shader(engine,options);stale->artifact="fixture.comp";pending=bbl::prepare_compute_shader(stale);
 auto previous=engine->offscreen_run;engine->offscreen_run=std::make_shared<bbl::pal::OffscreenRun>(std::make_shared<bbl::pal::OffscreenSurface>(1,1),std::make_shared<Device>());
 rejected=false;try{(void)co_await pending;}catch(const std::exception& error){rejected=std::string(error.what())=="#824";}assert(rejected&&!stale->pipeline);engine->offscreen_run=previous;
 completed=true;loop.close();co_return bbl::js::PromiseVoid{};
}
int main(){
 bbl::js::RealmScope realm;
 auto device=std::make_shared<Device>();device->limits.max_bind_groups=4;device->limits.max_bindings_per_bind_group=8;device->limits.max_uniform_buffers_per_shader_stage=4;device->limits.max_dynamic_uniform_buffers_per_pipeline_layout=4;
 auto engine=std::make_shared<bbl::Engine>();engine->offscreen_run=std::make_shared<bbl::pal::OffscreenRun>(std::make_shared<bbl::pal::OffscreenSurface>(1,1),device);
 bbl::ComputeBindingOptions binding;binding.group=2;binding.binding=3;binding.dynamic_offset=true;binding.min_binding_size=16;
 auto last=bbl::compute_uniform_buffer_binding("last",binding);binding.binding=1;auto first=bbl::compute_uniform_buffer_binding("first",binding);
 binding.group=0;binding.binding=0;binding.dynamic_offset=false;auto base=bbl::compute_uniform_buffer_binding("base",binding);
 bbl::ComputeShaderOptions options;options.source="@compute @workgroup_size(1) fn main() {}";options.bindings={last,first,base};
 auto shader=bbl::create_compute_shader(engine,options),alias=shader,other=bbl::create_compute_shader(engine,options);
 assert(shader!=other&&shader==alias&&shader->name==${JSON.stringify(expected.name)}&&shader->entry_point==${JSON.stringify(expected._entryPoint)});
 assert(shader->decls[0]==base&&shader->decls[1]==first&&shader->decls[2]==last&&options.bindings[0]==last);
 assert((shader->dynamic_counts==std::vector<double>{0,0,2})&&shader->slots.at("first").dynamic_index==0&&shader->slots.at("last").dynamic_index==1&&shader->slots.at("base").dynamic_index==-1);
 shader->artifact="fixture.comp";auto pipeline=bbl::get_compute_pipeline(shader);assert(pipeline==bbl::get_compute_pipeline(alias)&&device->pipelines.size()==1&&device->modules==1);
 assert(device->groups.size()==3&&device->groups[1].entries.empty()&&device->groups[2].entries.size()==2);
 assert(device->groups[2].label=="compute-group2"&&device->groups[2].entries[0].binding==1&&device->groups[2].entries[0].visibility==4&&device->groups[2].entries[0].buffer->has_dynamic_offset);
 assert(device->pipelines[0].compute.entry_point==shader->entry_point&&device->pipelines[0].compute.module==shader->module&&device->pipelines[0].layout==shader->pipeline_layout);
 bbl::assert_compute_shader_live(shader);bbl::dispose_compute_shader(shader);bbl::dispose_compute_shader(shader);assert(alias->destroyed&&alias->device==nullptr&&alias->decls[0]==base);
 bool dead=false;try{bbl::assert_compute_shader_live(alias);}catch(const std::exception& e){dead=std::string(e.what())=="#823";}assert(dead);
 const auto rejects=[&](const bbl::ComputeShaderOptions& value,const std::string& code){bool rejected=false;try{(void)bbl::create_compute_shader(engine,value);}catch(const std::exception& e){rejected=e.what()==code;}assert(rejected);};
 auto invalid=options;invalid.entry_point="";rejects(invalid,"#813");invalid=options;invalid.source="";rejects(invalid,"#815");
 invalid=options;invalid.bindings.push_back(first);rejects(invalid,"#818");
 binding.group=2;binding.binding=1;invalid=options;invalid.bindings.push_back(bbl::compute_uniform_buffer_binding("duplicate",binding));rejects(invalid,"#819");
 binding.group=-1;invalid=options;invalid.bindings={bbl::compute_uniform_buffer_binding("bad",binding)};rejects(invalid,"#814");
 binding.group=4;invalid.bindings={bbl::compute_uniform_buffer_binding("bad",binding)};rejects(invalid,"#816");
 binding.group=0;binding.binding=8;invalid.bindings={bbl::compute_uniform_buffer_binding("bad",binding)};rejects(invalid,"#817");
 binding.binding=0;binding.min_binding_size=3;invalid.bindings={bbl::compute_uniform_buffer_binding("bad",binding)};rejects(invalid,"#820");
 device->limits.max_uniform_buffers_per_shader_stage=2;rejects(options,"#822");device->limits.max_uniform_buffers_per_shader_stage=4;
 bbl::pal::EventLoop loop;bool completed=false;loop.run([&]{prepare_checks(loop,engine,device,options,completed);});assert(completed);
 auto changed=std::make_shared<Device>();engine->offscreen_run=std::make_shared<bbl::pal::OffscreenRun>(std::make_shared<bbl::pal::OffscreenSurface>(1,1),changed);
 bool stale=false;try{bbl::assert_compute_shader_live(other);}catch(const std::exception& e){stale=std::string(e.what())=="#824";}assert(stale);
}
`,
    );
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        "/DBBLITE_WORKERS=1",
        "/DBBLITE_OFFSCREEN_SURFACES=1",
        `/I${resolve("native/include")}`,
        file,
        `/Fo${directory}/`,
        `/Fe${exe}`,
    ]);
    assert.equal(execFileSync(exe, { encoding: "utf8", timeout: 10000 }), "");
});

test("compute shader calls retain closed WGSL through wrapper functions", () => {
    const source = "@compute @workgroup_size(1) fn custom() {}";
    const result = compileSource(`
import {createEngine,createComputeShader,computeUniformBufferBinding,disposeComputeShader,prepareComputeShader} from "@babylonjs/lite";
async function main(){
 const engine=await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
 const create=(options:Parameters<typeof createComputeShader>[1])=>createComputeShader(engine,options);
 const source=${JSON.stringify(source)};
 const shader=create({name:"custom",entryPoint:"custom",computeSource:source,bindings:[computeUniformBufferBinding("params",{group:0,binding:0})]});
 const alias=shader;const other=create({entryPoint:"custom",computeSource:source});
 if(shader!==alias||shader===other||shader.name!=="custom")throw new Error("shader identity");
 await prepareComputeShader(shader);
 disposeComputeShader(shader);disposeComputeShader(alias);if(!alias._destroyed)throw new Error("shader disposal");
}
void main();`);
    assert.ok(result.manifest.features.includes("compute:shader"));
    assert.equal(result.manifest.computePrograms?.length, 1);
    assert.equal(result.manifest.computePrograms?.[0]?.source, source);
    assert.equal(result.manifest.computePrograms?.[0]?.entryPoint, "custom");
});

test("empty compute shader inputs reach source errors without offline shader compilation", () => {
    const result = compileSource(`
import {createEngine,createComputeShader} from "@babylonjs/lite";
async function main(){
 const engine=await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
 try {createComputeShader(engine,{computeSource:""});}catch(error){if(!(error instanceof Error)||error.message!=="#815")throw error;}
 try {createComputeShader(engine,{computeSource:"@compute @workgroup_size(1) fn main() {}",entryPoint:""});}catch(error){if(!(error instanceof Error)||error.message!=="#813")throw error;}
}
void main();`);
    assert.equal(result.manifest.computePrograms?.length ?? 0, 0);
    assert.match(result.cpp, /bbl::create_compute_shader/);
});
