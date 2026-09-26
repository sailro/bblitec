import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerStorageBuffer } from "../src/lowering/storage-buffer-lowerer.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("GPU storage buffers preserve source mirrors, updates and disposal ownership", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/gpu-storage-buffer-check");
    mkdirSync(directory, { recursive: true });
    const cpp = resolve(directory, "check.cpp"),
        exe = resolve(directory, "check.exe");
    writeFileSync(
        cpp,
        `${lowerStorageBuffer(new LoweringContext()).source}
#include <cassert>
struct Buffer final : bbl::pal::StorageBufferAllocation {
    std::vector<std::uint8_t> bytes;
    int destroys=0,writes=0;
    void destroy() override {++destroys;}
    void write_buffer_bytes(std::size_t offset,std::span<const std::uint8_t> source) override {
        ++writes;std::copy(source.begin(),source.end(),bytes.begin()+static_cast<std::ptrdiff_t>(offset));
    }
};
struct Device final : bbl::pal::OffscreenDevice {
    int creates=0;
    std::shared_ptr<Buffer> last;
    bbl::pal::StorageBufferDescriptor descriptor;
    double maximum_storage_buffer_size() const override {return 128;}
    std::shared_ptr<bbl::pal::StorageBufferAllocation> create_storage_buffer(const bbl::pal::StorageBufferDescriptor& value,std::optional<std::span<const std::uint8_t>> initial) override {
        ++creates;descriptor=value;last=std::make_shared<Buffer>();last->bytes.resize(value.byte_length);
        if(initial)std::copy(initial->begin(),initial->end(),last->bytes.begin());
        return last;
    }
};
int main() {
    bbl::js::ArrayBuffer backing(std::vector<std::uint8_t>(12));
    for(std::size_t index=0;index<12;++index) backing.data()[index]=static_cast<std::uint8_t>(index);
    const bbl::js::DataView view(backing,4,4);
    const std::variant<double,bbl::js::ArrayBufferView> forwarded{bbl::js::ArrayBufferView(view)};
    const auto source=bbl::storage_buffer_source(forwarded);
    assert(!source.numeric&&source.byte_length==4&&source.bytes[0]==4&&source.bytes[3]==7);
    const auto direct=bbl::storage_buffer_source(view);
    assert(direct.bytes.data()==source.bytes.data()&&direct.bytes.size()==source.bytes.size());
    assert(bbl::storage_buffer_source(bbl::js::DataView(bbl::js::ArrayBuffer{})).bytes.empty());
    auto device=std::make_shared<Device>();auto engine=std::make_shared<bbl::Engine>();
    engine->offscreen_run=std::make_shared<bbl::pal::OffscreenRun>(std::make_shared<bbl::pal::OffscreenSurface>(1,1),device);
    const std::vector<std::uint8_t> initial{1,2,3};
    const auto plain=bbl::create_gpu_storage_buffer(engine,bbl::storage_buffer_source(initial),{});
    auto first=device->last;
    assert(device->descriptor.byte_length==4&&first->bytes==std::vector<std::uint8_t>({1,2,3,0}));
    assert(engine->storage_buffers[plain.value].has_shadow&&engine->storage_buffers[plain.value].bytes==first->bytes);
    const std::vector<std::uint8_t> replacement{9,8,7,6};
    bbl::update_storage_buffer(*engine,plain,replacement,0);
    assert(first->writes==1&&first->bytes==replacement&&engine->storage_buffers[plain.value].bytes==replacement);
    bbl::StorageBufferOptions options;options.writable=true;options.vertex=true;options.label="gpu";
    const auto writable=bbl::create_gpu_storage_buffer(engine,bbl::storage_buffer_source(9.0),options);
    auto second=device->last;
    assert(device->descriptor.byte_length==12&&device->descriptor.roles==164&&device->descriptor.label=="gpu");
    assert(!engine->storage_buffers[writable.value].has_shadow&&engine->storage_buffers[writable.value].bytes.empty());
    bbl::update_storage_buffer(*engine,writable,replacement,4);
    assert(second->writes==1&&second->bytes[4]==9&&second->bytes[8]==0);
    for(double offset : {-4.0,1.0,12.0}) {
        bool failed=false;try{bbl::update_storage_buffer(*engine,writable,replacement,offset);}catch(const std::exception&){failed=true;}assert(failed);
    }
    bbl::dispose_storage_buffer(*engine,plain);bbl::dispose_storage_buffer(*engine,plain);
    assert(first->destroys==1&&engine->resource_epoch==1&&engine->storage_buffers[plain.value].bytes.empty());
    bool failed=false;try{bbl::update_storage_buffer(*engine,plain,replacement,0);}catch(const std::exception& error){failed=std::string(error.what())=="#587";}assert(failed);
    engine->dispose_storage_buffers(*engine);
    assert(second->destroys==1&&engine->resource_epoch==2&&!engine->dispose_storage_buffers);
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
