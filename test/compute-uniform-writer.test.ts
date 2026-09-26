import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { lowerComputeUniformWriter } from "../src/lowering/compute-uniform-writer-lowerer.js";
import { computeUniformLayout } from "../src/pinned-compute-uniform.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerComputeUniformArena } from "../src/lowering/compute-uniform-arena-lowerer.js";
import { lowerUniformBuffer } from "../src/lowering/uniform-buffer-lowerer.js";
import { lowerComputeTask } from "../src/lowering/compute-task-lowerer.js";
import { lowerManagedResources } from "../src/lowering/managed-resource-lowerer.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("typed uniform writers share staging views and preserve field validation", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/compute-uniform-writer-check");
    mkdirSync(directory, { recursive: true });
    const cpp = resolve(directory, "check.cpp"),
        exe = resolve(directory, "check.exe"),
        context = new LoweringContext();
    const result = computeUniformLayout([
        { name: "x", type: "f32" },
        { name: "count", type: "u32" },
        { name: "sign", type: "i32" },
        { name: "v", type: "vec3<f32>" },
        { name: "m", type: "mat3x3<f32>" },
    ]);
    assert.ok("layout" in result);
    const entries = result.layout.fields.map(
        ([name, field]) =>
            `{"${name}", {"${field.type}", ${[field.offset, field.byteLength, field.elementCount, field.rowCount, field.columnStride, field.scalar, field.kind].join(", ")}}}`,
    );
    writeFileSync(
        cpp,
        `${lowerManagedResources(context).source}
${lowerComputeTask(context).source}
${lowerUniformBuffer(context).source}
${lowerComputeUniformArena(context).source}
${lowerComputeUniformWriter(context).source}
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
 auto device=std::make_shared<Device>();auto engine=std::make_shared<bbl::Engine>();
 engine->offscreen_run=std::make_shared<bbl::pal::OffscreenRun>(std::make_shared<bbl::pal::OffscreenSurface>(1,1),device);
 auto task=bbl::create_compute_task(engine);auto arena=bbl::create_compute_uniform_arena(task,${result.layout.byteLength},2);
 auto layout=std::make_shared<const bbl::ComputeUniformLayout>(bbl::ComputeUniformLayout{${result.layout.byteLength},{${entries.join(",")}}});
 auto writer=bbl::create_compute_uniform_writer(arena,1,layout),alias=writer;
 auto another=bbl::create_compute_uniform_writer(arena,1,layout);assert(another!=writer&&alias==writer);
 bbl::set_compute_uniform_f32(writer,"x",1.23456789);bbl::set_compute_uniform_u32(writer,"count",-1);bbl::set_compute_uniform_i32(writer,"sign",4294967295.0);
 bbl::js::TypedArray<float> vector{2,3,4};bbl::set_compute_uniform_vector(writer,"v",bbl::UniformNumericView(vector));
 const std::array<double,9> matrix{1,2,3,4,5,6,7,8,9};bbl::set_compute_uniform_matrix(writer,"m",bbl::UniformNumericView(matrix));
 auto data=bbl::js::DataView(arena->buffer->data->buffer());
 assert(data.get_float32(256,true)==static_cast<float>(1.23456789)&&data.get_uint32(260,true)==0xffffffffu&&data.get_int32(264,true)==-1);
 assert(data.get_float32(272,true)==2&&data.get_float32(280,true)==4&&data.get_float32(284,true)==0);
 assert(data.get_float32(288,true)==1&&data.get_float32(304,true)==4&&data.get_float32(320,true)==7&&data.get_float32(328,true)==9&&data.get_float32(332,true)==0);
 assert(arena->dirty_start==256&&arena->dirty_end==336);
 task->flush_owned();assert(device->last->writes==1&&device->last->last_offset==256&&device->last->last_size==80);
 bbl::set_compute_uniform_f32(another,"x",8);assert(data.get_float32(256,true)==8);
 bool missing=false;try{bbl::set_compute_uniform_f32(writer,"missing",1);}catch(const std::exception& e){missing=std::string(e.what())=="#822";}assert(missing);
 bool kind=false;try{bbl::set_compute_uniform_f32(writer,"v",1);}catch(const std::exception& e){kind=std::string(e.what()).starts_with("#824");}assert(kind);
 bool size=false;try{bbl::set_compute_uniform_matrix(writer,"m",bbl::UniformNumericView(vector));}catch(const std::exception& e){size=std::string(e.what()).starts_with("#826");}assert(size);
 auto tooBig=std::make_shared<const bbl::ComputeUniformLayout>(bbl::ComputeUniformLayout{256,{}});bool large=false;try{bbl::create_compute_uniform_writer(arena,0,tooBig);}catch(const std::exception& e){large=std::string(e.what()).starts_with("#819");}assert(large);
 auto half=std::make_shared<const bbl::ComputeUniformLayout>(bbl::ComputeUniformLayout{16,{{"h",{"f16",0,2,1,1,2,3,0}}}});bool f16=false;try{bbl::create_compute_uniform_writer(arena,0,half);}catch(const std::exception& e){f16=std::string(e.what())=="#820";}assert(f16);
 task->dispose();bool dead=false;try{bbl::set_compute_uniform_f32(writer,"x",1);}catch(const std::exception& e){dead=std::string(e.what())=="#821";}assert(dead);
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

test("typed uniform writers retain aliases, field names and numeric views", () => {
    const result = compileSource(`
import {createEngine,createComputeTask,createComputeUniformLayout,createComputeUniformArena,createComputeUniformWriter,setComputeUniformF32,setComputeUniformVector} from "@babylonjs/lite";
async function main(){
 const engine=await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
 const task=createComputeTask(engine),layout=createComputeUniformLayout([{name:"x",type:"f32"},{name:"v",type:"vec3<f32>"}]);
 const arena=createComputeUniformArena(task,layout.byteLength,2),writer=createComputeUniformWriter(arena,1,layout),alias=writer;
 const write=(name:string,value:number)=>setComputeUniformF32(writer,name,value);
 write("x",4.5);setComputeUniformVector(writer,"v",new Float32Array([1,2,3]));
 if(writer!==alias||writer.layout!==layout||writer.arena!==arena||writer.slot!==1)throw new Error("writer identity");
 task.dispose();
}
void main();`);
    assert.ok(result.manifest.features.includes("compute:uniform-writer"));
    assert.match(result.cpp, /set_compute_uniform_vector/);
});
