import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import {
    cppRecord,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("Dawn readback mappings unmap on success, decode failure, and map failure", (t) => {
    const native = optionalNativeFixtureTools();
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/dawn-readback-check");
    mkdirSync(directory, { recursive: true });
    const source = join(directory, "check.cpp"),
        executable = join(directory, "check.exe");
    const record = cppRecord(
        readFileSync("native/src/pal_dawn_shared.hpp", "utf8"),
        "class DawnReadbackMap {",
    );
    writeFileSync(
        source,
        `#include <webgpu/webgpu.h>
#include <cassert>
#include <cstdint>
#include <span>
#include <stdexcept>
#include <string>
struct DawnDevice { WGPUInstance instance{}; std::string uncaptured_error; };
std::uint8_t pixels[4]{1,2,3,4};
unsigned unmapped = 0, accessed = 0;
bool fail_map = false, missing_range = false;
WGPUBufferMapCallbackInfo pending{};
WGPUFuture wgpuBufferMapAsync(WGPUBuffer, WGPUMapMode, size_t offset, size_t size, WGPUBufferMapCallbackInfo callback) {
    assert(offset == 0 && size == 4); pending = callback; return {};
}
const void* wgpuBufferGetConstMappedRange(WGPUBuffer, size_t, size_t) {
    ++accessed; return missing_range ? nullptr : pixels;
}
void wgpuBufferUnmap(WGPUBuffer) { ++unmapped; }
void wait_for(WGPUInstance, WGPUFuture) {
    const WGPUStringView message{"test failure", 12};
    pending.callback(fail_map ? WGPUMapAsyncStatus_Error : WGPUMapAsyncStatus_Success, message, pending.userdata1, nullptr);
}
std::string view_text(WGPUStringView value) { return std::string(value.data, value.length); }
[[noreturn]] void dawn_error(const std::string& message) { throw std::runtime_error(message); }
${record}
int main() {
    DawnDevice state;
    { DawnReadbackMap mapping(state, nullptr, 4); assert(mapping.bytes().size() == 4 && mapping.bytes()[2] == 3); assert(unmapped == 0); }
    assert(unmapped == 1 && accessed == 1);
    try { DawnReadbackMap mapping(state, nullptr, 4); throw std::runtime_error("decode failed"); } catch(const std::runtime_error&) {}
    assert(unmapped == 2);
    fail_map = true;
    bool failed = false;
    try { DawnReadbackMap mapping(state, nullptr, 4); } catch(const std::runtime_error&) { failed = true; }
    assert(failed && unmapped == 3 && accessed == 2 && !state.uncaptured_error.empty());
    fail_map = false; missing_range = true; state.uncaptured_error.clear(); failed = false;
    try { DawnReadbackMap mapping(state, nullptr, 4); } catch(const std::runtime_error&) { failed = true; }
    assert(failed && unmapped == 4 && accessed == 3);
}
`,
    );
    runNativeFixtureCompiler(native, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        "/Iartifacts/tools/dawn/include",
        `/Fo:${directory}/`,
        `/Fe:${executable}`,
        source,
    ]);
    execFileSync(executable);
});
