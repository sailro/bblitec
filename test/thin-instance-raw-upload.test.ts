import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { lowerThinInstanceUploadBody } from "../src/compiler/thin-instance-upload.js";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runGeneratedProgram,
    sharedGpuSource,
} from "./native-fixture.js";

function uploadSource(type: string, values: string): string {
    return `
import {createEngine,createBox,setThinInstances,type Mesh,type EngineContext} from "@babylonjs/lite";
async function build(engine:EngineContext):Promise<void>{
 const device=engine._device;
 function upload(mesh:Mesh,buf:${type},count:number):void {
   const ti=mesh.thinInstances!;
   if(ti._gpuBuffer){device.queue.writeBuffer(ti._gpuBuffer,0,buf.buffer,buf.byteOffset,count*64);return;}
   ti._version++;ti._dirtyMin=0;ti._dirtyMax=count;
 }
 const mesh=createBox(engine);
 const narrow=new Float32Array(32),wide=new Float64Array(32);
 setThinInstances(mesh,wide,2);
 ${values}
 upload(mesh,values,1);
}
async function main(){const engine=await createEngine(document.createElement("canvas"));await build(engine);}
`;
}

test("raw thin GPU upload preserves an existing F32 subview over an F64 pool", () => {
    const result = compileSource(
        uploadSource("Float32Array", "const values=narrow.subarray(8,24);"),
    );
    assert.match(result.cpp, /upload_thin_instance_matrices/);
    assert.match(result.cpp, /if \([^\n]*gpu_buffer/);
    assert.match(result.cpp, /\.version\+\+/);
    assert.match(result.cpp, /\.dirty_max = .*thin_upload_count/);
    assert.doesNotMatch(result.cpp, /typed_array_from_values/);
});

test("raw thin uploads preserve the source fallback before GPU allocation and its early return afterward", (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    const source = ts.createSourceFile(
        "upload.ts",
        `function upload(mesh,buf,count) {
            const ti=mesh.thinInstances!;
            if(ti._gpuBuffer) { device.queue.writeBuffer(ti._gpuBuffer,0,buf.buffer,buf.byteOffset,count*64); return; }
            ti._version++; ti._dirtyMin=0; ti._dirtyMax=count;
        }`,
        ts.ScriptTarget.Latest,
        true,
    );
    const declaration = source.statements.find(ts.isFunctionDeclaration)!;
    const lowered = lowerThinInstanceUploadBody(
        declaration,
        ["mesh", "buf", "count"],
        "engine",
        "mesh",
        "matrices",
        "count",
        "pool",
    );
    const changedSource = ts.createSourceFile(
        "changed.ts",
        source.text
            .replace("ti._version++", "ti._version += 3")
            .replace("ti._dirtyMin=0", "ti._dirtyMin=count-1"),
        ts.ScriptTarget.Latest,
        true,
    );
    const changed = lowerThinInstanceUploadBody(
        changedSource.statements.find(ts.isFunctionDeclaration)!,
        ["mesh", "buf", "count"],
        "engine",
        "mesh",
        "matrices",
        "count",
        "pool",
    );
    runGeneratedProgram(
        native,
        "thin-instance-raw-upload",
        `
#include <bblite/gpu.hpp>
#include <bblite/thin_instance.hpp>
#include <cassert>
#include <cstring>
struct RecordingBuffer final : bbl::GpuObject {
    std::array<float,16> lanes{};
    int writes=0;
    void write_buffer_bytes(std::size_t offset, std::span<const std::uint8_t> data) override {
        assert(offset==0 && data.size()==sizeof(lanes));
        std::memcpy(lanes.data(),data.data(),data.size()); ++writes;
    }
};
bbl::GpuDevice upload_device;
namespace bbl::pal { GpuDevice& source_gpu_device(Engine&) { return upload_device; } }
namespace bbl { ${cppFunction(sharedGpuSource(), "void upload_thin_instance_matrices(")} }
void upload(bbl::Engine& engine,bbl::MeshHandle mesh,const bbl::js::F32Array& matrices,double count) { ${lowered}; }
void changed_upload(bbl::Engine& engine,bbl::MeshHandle mesh,const bbl::js::F32Array& matrices,double count) { ${changed}; }
int main() {
    using namespace bbl;
    Engine engine; engine.meshes.resize(1); MeshHandle mesh{0};
    auto pool=std::make_shared<ThinInstancePoolData>(); engine.meshes[0].thin_instances=pool;
    pool->matrices=js::F64Array(32); pool->count=2; pool->version=5; pool->dirty_min=8; pool->dirty_max=9;
    js::F32Array allocation(32); for(std::size_t i=0;i<32;++i) allocation[i]=static_cast<float>(i+10);
    auto matrices=js::typed_array_subarray(allocation,8.0,24.0);
    upload(engine,mesh,matrices,1);
    assert(!pool->gpu_buffer && pool->version==6 && pool->dirty_min==0 && pool->dirty_max==1);
    changed_upload(engine,mesh,matrices,2);
    assert(!pool->gpu_buffer && pool->version==9 && pool->dirty_min==1 && pool->dirty_max==2);
    auto buffer=std::make_shared<RecordingBuffer>(); pool->gpu_buffer=buffer;
    upload(engine,mesh,matrices,1);
    assert(buffer->writes==1 && pool->version==9 && pool->dirty_min==1 && pool->dirty_max==2);
    for(std::size_t i=0;i<16;++i) assert(buffer->lanes[i]==static_cast<float>(i+18));
    assert(std::holds_alternative<js::F64Array>(pool->matrices));
}
`,
    );
});

test("raw thin GPU upload refuses F64 bytes and unselected numeric unions", () => {
    for (const [type, values] of [
        ["Float64Array", "const values=wide.subarray(8,24);"],
        ["Float32Array|Float64Array", "const values=narrow[0]?narrow:wide;"],
    ])
        assert.throws(
            () => compileSource(uploadSource(type!, values!)),
            /Direct thin-instance GPU uploads require a Float32Array byte view/,
        );
});
