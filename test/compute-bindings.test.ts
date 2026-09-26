import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerComputeBindings } from "../src/lowering/compute-bindings-lowerer.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("compute binding sets preserve dynamic slots, cached groups and volatile invalidation", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/compute-bindings-check");
    mkdirSync(directory, { recursive: true });
    const cpp = resolve(directory, "check.cpp"),
        exe = resolve(directory, "check.exe");
    writeFileSync(
        cpp,
        `${lowerComputeBindings(new LoweringContext()).source}
#include <cassert>
int resolves=0,gets=0,validations=0;bool invalidate=false;
namespace bbl {
void assert_compute_shader_live(const std::shared_ptr<ComputeShader>& shader){if(shader->destroyed)throw std::runtime_error("dead shader");}
std::shared_ptr<pal::ComputeGroupLayouts> get_compute_group_layouts(const std::shared_ptr<ComputeShader>& shader){return shader->layouts;}
std::shared_ptr<const ComputeBindingResolver> get_compute_binding_resolver(double){
 static auto resolver=std::make_shared<ComputeBindingResolver>();
 resolver->resolve=[](const std::shared_ptr<Engine>&,const ComputeBindingDeclPtr&,const ComputeBindingInput& input){++resolves;auto range=std::get<ComputeBufferRange>(input);return ComputeResolvedBinding{ComputeBufferBindingState{range.buffer,0,16},ComputeDynamicBindingInfo{256,768}};};
 resolver->get=[](const std::shared_ptr<Engine>&,const ComputeBindingState& state)->pal::ComputeBindingResource{++gets;const auto& value=std::get<ComputeBufferBindingState>(state);return pal::ComputeBufferResource{value.buffer->allocation(),0,16};};
 resolver->validate=[](const std::shared_ptr<Engine>& engine,const ComputeBindingState&){++validations;if(invalidate){engine->resource_epoch+=1;invalidate=false;}};
 return resolver;
}
}
struct Allocation final:bbl::pal::StorageBufferAllocation{void destroy()override{}void write_buffer_bytes(std::size_t,std::span<const std::uint8_t>) override{}};
struct Device final:bbl::pal::OffscreenDevice{
 std::vector<bbl::pal::ComputeBindGroupDescriptor> groups;
 std::shared_ptr<bbl::pal::ComputeBindGroup> create_compute_bind_group(const bbl::pal::ComputeBindGroupDescriptor& descriptor)override{groups.push_back(descriptor);return std::make_shared<bbl::pal::ComputeBindGroup>();}
};
int main(){
 auto engine=std::make_shared<bbl::Engine>();auto device=std::make_shared<Device>();
 engine->offscreen_run=std::make_shared<bbl::pal::OffscreenRun>(std::make_shared<bbl::pal::OffscreenSurface>(1,1),device);
 auto shader=std::make_shared<bbl::ComputeShader>();shader->engine=engine;shader->name="test";
 auto decl=std::make_shared<bbl::ComputeBindingDecl>();decl->name="params";decl->group=2;decl->binding=4;
 shader->decls={decl};shader->slots.emplace("params",bbl::ComputeBindingSlot{decl,0});shader->dynamic_counts={0,0,1};
 shader->layouts=std::make_shared<bbl::pal::ComputeGroupLayouts>(3);for(auto& layout:*shader->layouts)layout=std::make_shared<bbl::pal::ComputeGroupLayout>();
 auto uniform=std::make_shared<bbl::UniformBuffer>();uniform->engine=engine;uniform->allocation=std::make_shared<Allocation>();
 auto buffer=bbl::compute_buffer_reference(uniform);
 bbl::ComputeBindingResources resources{{"params",bbl::ComputeBufferRange{buffer,{},{}}}};
 auto binding=bbl::create_compute_binding_set(shader,resources);assert(resolves==1&&gets==1&&validations==0);
 assert(binding->shader==shader&&binding->entries.size()==1&&binding->volatile_entries->size()==1);
 assert(device->groups.size()==3&&device->groups[0].entries.empty()&&device->groups[1].entries.empty()&&device->groups[2].entries[0].binding==4&&device->groups[2].label=="test-bindings2");
 const auto& slot=binding->dynamic_slots->at("params");assert(slot.group==2&&slot.index==0&&slot.alignment==256&&slot.max_offset==768);
 assert(binding->zero_dynamic_offsets->size()==3&&binding->zero_dynamic_offsets->at(0).empty()&&binding->zero_dynamic_offsets->at(2)==std::vector<double>{0});
 auto groups=binding->groups;assert(bbl::ensure_compute_binding_groups(binding)==groups&&validations==1&&gets==1);
 invalidate=true;assert(bbl::ensure_compute_binding_groups(binding)!=groups&&validations==2&&gets==2&&device->groups.size()==6);
 assert(binding->resource_epoch==1);bbl::ensure_compute_binding_groups(binding,false);assert(validations==2&&gets==2);
 engine->resource_epoch=2;bbl::ensure_compute_binding_groups(binding,false);assert(gets==3&&device->groups.size()==9);
 for(const bool extra:{false,true}){auto bad=resources;if(extra)bad.emplace("unknown",std::monostate{});else bad.clear();bool failed=false;try{(void)bbl::create_compute_binding_set(shader,bad);}catch(const std::exception& e){failed=std::string(e.what())==(extra?"#776":"#777");}assert(failed);}
 bbl::dispose_compute_binding_set(binding);bbl::dispose_compute_binding_set(binding);assert(binding->destroyed&&!binding->groups&&!binding->device&&uniform->allocation);
 bool disposed=false;try{(void)bbl::ensure_compute_binding_groups(binding);}catch(const std::exception& e){disposed=std::string(e.what())=="#778";}assert(disposed);
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
        cpp,
        `/Fo${directory}/`,
        `/Fe${exe}`,
    ]);
    assert.equal(execFileSync(exe, { encoding: "utf8", timeout: 10000 }), "");
});
