import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerComputeUniformArena } from "../src/lowering/compute-uniform-arena-lowerer.js";
import { lowerUniformBuffer } from "../src/lowering/uniform-buffer-lowerer.js";
import { lowerComputeTask } from "../src/lowering/compute-task-lowerer.js";
import { lowerManagedResources } from "../src/lowering/managed-resource-lowerer.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("uniform arenas align slots, batch dirty ranges and dispose with their task", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/compute-uniform-arena-check");
    mkdirSync(directory, { recursive: true });
    const cpp = resolve(directory, "check.cpp"),
        exe = resolve(directory, "check.exe"),
        context = new LoweringContext();
    writeFileSync(
        cpp,
        `${lowerManagedResources(context).source}
${lowerComputeTask(context).source}
${lowerUniformBuffer(context).source}
${lowerComputeUniformArena(context).source}
#include <cassert>
struct Allocation final:bbl::pal::StorageBufferAllocation {
 std::vector<std::uint8_t> bytes;int writes=0,destroys=0;std::size_t last_offset=0,last_size=0;
 void destroy()override{++destroys;}
 void write_buffer_bytes(std::size_t offset,std::span<const std::uint8_t> data) override{++writes;last_offset=offset;last_size=data.size();std::copy(data.begin(),data.end(),bytes.begin()+static_cast<std::ptrdiff_t>(offset));}
};
struct Device final:bbl::pal::OffscreenDevice {
 std::shared_ptr<Allocation> last;
 double maximum_storage_buffer_size()const override{return 1024;}
 double minimum_uniform_buffer_offset_alignment()const override{return 256;}
 std::shared_ptr<bbl::pal::StorageBufferAllocation> create_storage_buffer(const bbl::pal::StorageBufferDescriptor&,std::optional<std::span<const std::uint8_t>> bytes)override{
  last=std::make_shared<Allocation>();last->bytes.assign(bytes->begin(),bytes->end());return last;
 }
};
int main(){
 const auto initial=bbl::js::managed_node_count();
 std::weak_ptr<bbl::ComputeUniformArena> observed;
 {
 auto device=std::make_shared<Device>();auto engine=std::make_shared<bbl::Engine>();
 engine->offscreen_run=std::make_shared<bbl::pal::OffscreenRun>(std::make_shared<bbl::pal::OffscreenSurface>(1,1),device);
 auto task=bbl::create_compute_task(engine);auto arena=bbl::create_compute_uniform_arena(task,16,3);auto allocation=device->last;observed=arena;
 assert(arena->slot_byte_length==16&&arena->slot_stride==256&&arena->buffer->byte_length==768&&bbl::compute_uniform_slot_offset(arena,2)==512);
 const std::vector<std::uint8_t> data{1,2,3,4};
 bbl::update_compute_uniform_slot(arena,0,data,0);bbl::update_compute_uniform_slot(arena,2,data,4);
 assert(allocation->writes==0&&arena->dirty_start==0&&arena->dirty_end==520);
 task->flush_owned();assert(allocation->writes==1&&allocation->last_offset==0&&allocation->last_size==520&&allocation->bytes[519]==4);
 task->flush_owned();assert(allocation->writes==1);
 bbl::update_compute_uniform_slot(arena,1,{},16);task->flush_owned();assert(allocation->writes==1);
 for(double slot:{-1.0,1.5,3.0}){bool failed=false;try{(void)bbl::compute_uniform_slot_offset(arena,slot);}catch(const std::exception& e){failed=std::string(e.what())=="#863";}assert(failed);}
 bool range=false;try{bbl::update_compute_uniform_slot(arena,1,data,16);}catch(const std::exception& e){range=std::string(e.what())=="#866";}assert(range);
 auto another=bbl::create_compute_uniform_arena(task,32,1);auto second=device->last;
 task->dispose();assert(task->disposed&&arena->destroyed&&another->destroyed&&allocation->destroys==1&&second->destroys==1&&engine->native_resource_owners.empty());
 bool dead=false;try{(void)bbl::compute_uniform_slot_offset(arena,0);}catch(const std::exception& e){dead=std::string(e.what())=="#862";}assert(dead);
 }
 bbl::js::collect_cycles();assert(observed.expired()&&bbl::js::managed_node_count()==initial);
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

test("uniform arena intrinsics retain task ownership and slot views", () => {
    const result = compileSource(`
import {createEngine,createComputeTask,createComputeUniformArena,getComputeUniformSlotOffset,updateComputeUniformSlot} from "@babylonjs/lite";
async function main(){
 const engine=await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
 const task=createComputeTask(engine,"slots");
 const create=(options?:Parameters<typeof createComputeUniformArena>[3])=>createComputeUniformArena(task,16,3,options);
 const arena=create({label:"slots"}),alias=arena;
 if(arena!==alias||arena.slotByteLength!==16||arena.slotCount!==3||arena.buffer.byteLength!==arena.slotStride*3)throw new Error("arena identity");
 if(getComputeUniformSlotOffset(arena,2)!==arena.slotStride*2)throw new Error("slot offset");
 updateComputeUniformSlot(arena,1,new DataView(new ArrayBuffer(8),4,4),4);
 task.dispose();if(!alias._destroyed||!arena.buffer._destroyed)throw new Error("arena disposal");
}
void main();`);
    assert.ok(result.manifest.features.includes("compute:uniform-arena"));
    assert.match(result.cpp, /create_compute_uniform_arena/);
});
