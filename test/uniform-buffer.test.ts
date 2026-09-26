import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerUniformBuffer } from "../src/lowering/uniform-buffer-lowerer.js";
import { lowerManagedResources } from "../src/lowering/managed-resource-lowerer.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("uniform buffer intrinsics retain forwarded options and byte views", () => {
    const result = compileSource(`
import {createEngine,createUniformBuffer,updateUniformBuffer,disposeUniformBuffer} from "@babylonjs/lite";
async function main(){
 const engine=await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
 const create=(source:Parameters<typeof createUniformBuffer>[1],options?:Parameters<typeof createUniformBuffer>[2])=>createUniformBuffer(engine,source,options);
 const data=new Uint8Array([1,2,3]);
 const buffer=create(data,{label:"view"}),alias=buffer;
 if(buffer.byteLength!==16||buffer!==alias)throw new Error("uniform identity");
 const words=new Uint32Array([9]);updateUniformBuffer(engine,buffer,words,4);
 disposeUniformBuffer(buffer);disposeUniformBuffer(alias);
 if(!alias._destroyed)throw new Error("uniform disposal");
 const padded=create(17);if(padded.byteLength!==32)throw new Error("uniform padding");
}
void main();`);
    assert.ok(result.manifest.features.includes("compute:uniform-buffer"));
    assert.match(result.cpp, /create_uniform_buffer/);
});

test("uniform buffers retain padded staging, device ownership and registered teardown", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/uniform-buffer-check");
    mkdirSync(directory, { recursive: true });
    const cpp = resolve(directory, "check.cpp"),
        exe = resolve(directory, "check.exe");
    const context = new LoweringContext();
    writeFileSync(
        cpp,
        `${lowerManagedResources(context).source}
${lowerUniformBuffer(context).source}
#include <cassert>
struct Allocation final:bbl::pal::StorageBufferAllocation {
 std::vector<std::uint8_t> bytes;int writes=0,destroys=0;
 void destroy()override{++destroys;}
 void write_buffer_bytes(std::size_t offset,std::span<const std::uint8_t> data) override{++writes;std::copy(data.begin(),data.end(),bytes.begin()+static_cast<std::ptrdiff_t>(offset));}
};
struct Device final:bbl::pal::OffscreenDevice {
 std::shared_ptr<Allocation> last;int calls=0;bbl::pal::StorageBufferDescriptor descriptor;
 double maximum_storage_buffer_size()const override{return 256;}
 std::shared_ptr<bbl::pal::StorageBufferAllocation> create_storage_buffer(const bbl::pal::StorageBufferDescriptor& value,std::optional<std::span<const std::uint8_t>> bytes)override{
  ++calls;descriptor=value;last=std::make_shared<Allocation>();last->bytes.assign(bytes->begin(),bytes->end());return last;
 }
};
int main(){
 auto device=std::make_shared<Device>();auto engine=std::make_shared<bbl::Engine>();
 engine->offscreen_run=std::make_shared<bbl::pal::OffscreenRun>(std::make_shared<bbl::pal::OffscreenSurface>(1,1),device);
 const std::vector<std::uint8_t> initial{1,2,3};
 auto buffer=bbl::create_uniform_buffer(engine,bbl::storage_buffer_source(initial),"uniform");auto allocation=device->last;
 assert(buffer->byte_length==16&&buffer->data->size()==16&&allocation->bytes.size()==16&&allocation->bytes[2]==3&&allocation->bytes[3]==0);
 assert(device->descriptor.roles==64&&device->descriptor.label=="uniform");
 const std::vector<std::uint8_t> data{8,7,6,5};bbl::update_uniform_buffer(engine,buffer,data,4);
 assert(allocation->writes==1&&allocation->bytes[4]==8&&(*buffer->data)[7]==5);
 for(double offset:{-4.0,1.0,16.0}){bool failed=false;try{bbl::update_uniform_buffer(engine,buffer,data,offset);}catch(const std::exception&){failed=true;}assert(failed);}
 bbl::update_uniform_buffer(engine,buffer,{},16);assert(allocation->writes==1);
 bool foreign=false;try{(void)bbl::get_uniform_buffer_handle(std::make_shared<bbl::Engine>(),buffer);}catch(const std::exception& error){foreign=std::string(error.what())=="#808";}assert(foreign);
 for(double size:{-1.0,1.5,257.0}){bool failed=false;try{(void)bbl::create_uniform_buffer(engine,bbl::storage_buffer_source(size));}catch(const std::exception&){failed=true;}assert(failed);}
 assert(device->calls==1);
 auto second=bbl::create_uniform_buffer(engine,bbl::storage_buffer_source(17.0));auto secondAllocation=device->last;
 assert(second->byte_length==32&&secondAllocation->bytes==std::vector<std::uint8_t>(32,0));
 bbl::dispose_uniform_buffer(buffer);bbl::dispose_uniform_buffer(buffer);assert(buffer->destroyed&&!buffer->data&&!buffer->allocation&&allocation->destroys==1&&engine->resource_epoch==1);
 bool dead=false;try{bbl::update_uniform_buffer(engine,buffer,data,0);}catch(const std::exception& error){dead=std::string(error.what())=="#807";}assert(dead);
 engine->dispose_managed_resources();assert(second->destroyed&&secondAllocation->destroys==1&&engine->resource_epoch==2&&engine->native_resource_owners.empty());
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
