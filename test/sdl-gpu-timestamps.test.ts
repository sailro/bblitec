import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import {
    cppRecord,
    cppSection,
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("SDL D3D12 timestamps retain readbacks and command reuse with validation enabled or disabled", (t) => {
    const tools = optionalNativeFixtureTools();
    if (!tools) {
        t.skip("The Windows native compiler and patched SDL are required.");
        return;
    }
    const directory = resolve("artifacts/sdl-gpu-timestamps-check");
    mkdirSync(directory, { recursive: true });
    const resources = readFileSync(
        "native/src/pal_sdl_gpu_resources.hpp",
        "utf8",
    );
    const timestamps = readFileSync(
        "native/src/pal_sdl_gpu_timestamp.hpp",
        "utf8",
    );
    const max = (1n << 64n) - 1n;
    const pairs = [
        [0n, 1n],
        [1n, 3n],
        [123456789012345n, 10000000n],
        [max - 1n, max],
        [max, max],
        [max, 1000000001n],
        [(1n << 63n) + 9n, (1n << 63n) + 19n],
    ];
    let seed = 7n;
    for (let index = 0; index < 64; index++) {
        seed = (seed * 6364136223846793005n + 1442695040888963407n) & max;
        pairs.push([seed, 1000000000n + (seed >> 1n)]);
    }
    const conversionChecks = pairs
        .map(
            ([ticks, frequency]) =>
                `assert(sdl_timestamp_nanoseconds(${ticks}ULL, ${frequency}ULL) == ${(ticks! * 1000000000n) / frequency!}ULL);`,
        )
        .join("\n");
    const cpp = join(directory, "check.cpp");
    const executable = join(directory, "check.exe");
    writeFileSync(
        cpp,
        `
        #include <SDL3/SDL.h>
        #include <bblite/pal_gpu_timestamp.hpp>
        #include "pal_sdl_gpu_commands.hpp"
        #include <algorithm>
        #include <cassert>
        #include <chrono>
        #include <cstring>
        #include <iostream>
        #include <limits>
        #include <stdexcept>
        #include <thread>
        #include <unordered_set>
        namespace bbl::pal {
        [[noreturn]] void gpu_error(const char* message) { throw std::runtime_error(std::string(message)+": "+SDL_GetError()); }
        ${cppRecord(resources, "template <typename Resource, auto Release> struct SdlGpuDeleter")}
        ${cppSection(resources, "using OwnedSdlBuffer =", "inline bool wait_sdl_gpu_fence")}
        }
        ${cppSection(timestamps, "namespace bbl::pal {", "} // namespace bbl::pal")}
        }
        int main() {
            using namespace bbl::pal;
            try {
                ${conversionChecks}
                std::vector<std::uint64_t> backward{100,90,120,140};
                normalize_sdl_gpu_timestamps(backward,1000000);
                assert((backward==std::vector<std::uint64_t>{10000,0,30000,50000}));
                bool rejected=false;
                try { (void)sdl_timestamp_nanoseconds(1,0); } catch(const std::runtime_error&) { rejected=true; }
                assert(rejected);
                rejected=false;
                try { (void)sdl_timestamp_nanoseconds(UINT64_MAX,1); } catch(const std::runtime_error&) { rejected=true; }
                assert(rejected);
                SDL_SetAssertionHandler([](const SDL_AssertData* data,void*) {
                    std::cerr<<data->condition<<" at "<<data->filename<<":"<<data->linenum;
                    return SDL_ASSERTION_ABORT;
                },nullptr);
                if(!SDL_Init(SDL_INIT_VIDEO)) gpu_error("SDL_Init");
                for(const bool debug:{false,true}) {
                auto* device=SDL_CreateGPUDevice(SDL_GPU_SHADERFORMAT_DXIL,debug,"direct3d12");
                if(!device) gpu_error("SDL_CreateGPUDevice");
                assert(SDL_BBLiteGetGPUTimestampFrequency(device)>0);
                {
                    auto queries=std::make_shared<SdlGpuTimestampQuerySet>(device,4);
                    SDL_GPUBufferCreateInfo info{};
                    info.size=1024*1024;
                    info.usage=SDL_GPU_BUFFERUSAGE_VERTEX;
                    OwnedSdlBuffer source{SDL_CreateGPUBuffer(device,&info),{device}};
                    OwnedSdlBuffer target{SDL_CreateGPUBuffer(device,&info),{device}};
                    if(!source||!target) gpu_error("GPU buffer allocation");
                    std::unordered_set<SDL_GPUCommandBuffer*> commands;
                    bool reused_command=false;
                    const auto capture=[&](int repeats) {
                        SdlGpuCommand command{SDL_AcquireGPUCommandBuffer(device)};
                        if(!command) gpu_error("GPU command allocation");
                        if(!commands.insert(command.get()).second) reused_command=true;
                        for(Uint32 pair=0;pair<2;pair++) {
                            encode_sdl_gpu_timestamp(command,{queries,pair*2,true});
                            SdlCopyPass pass{SDL_BeginGPUCopyPass(command)};
                            if(!pass.get()) gpu_error("GPU copy pass");
                            SDL_GPUBufferLocation from{source.get(),0}, to{target.get(),0};
                            for(int copy=0;copy<repeats;copy++)
                                SDL_CopyGPUBufferToBuffer(pass,&from,&to,info.size,false);
                            pass.end();
                            encode_sdl_gpu_timestamp(command,{queries,pair*2+1,false});
                        }
                        if(!command.submit()) gpu_error("GPU submit");
                        return std::make_shared<SdlGpuTimestampReadback>(queries,4);
                    };
                    auto first=capture(256);
                    auto second=capture(1);
                    const auto await_readback=[](const auto& readback) {
                        const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(10);
                        for(;;) {
                            if(auto result=readback->poll()) return *result;
                            if(std::chrono::steady_clock::now()>=deadline) throw std::runtime_error("Timestamp fence timeout");
                            std::this_thread::sleep_for(std::chrono::milliseconds(1));
                        }
                    };
                    const auto first_values=await_readback(first);
                    const auto second_values=await_readback(second);
                    assert(first_values.size()==4&&second_values.size()==4);
                    assert(first_values[0]==0&&second_values[0]==0);
                    assert(first_values[1]>0&&second_values[1]>0);
                    assert(first_values[2]>=first_values[1]&&first_values[3]>first_values[2]);
                    assert(second_values[2]>=second_values[1]&&second_values[3]>second_values[2]);
                    assert(first_values[1]>second_values[1]);
                    assert(first->poll().value()==first_values);
                    assert(queries->transfers.size()==2);
                    first.reset();
                    second.reset();
                    // Complete each frame so SDL recycles submitted command buffers.
                    for(int frame=0;frame<16;frame++) {
                        const auto readback=capture(1);
                        (void)await_readback(readback);
                        assert(queries->transfers.size()==2);
                    }
                    assert(reused_command);
                }
                SDL_DestroyGPUDevice(device);
                }
                SDL_Quit();
            } catch(const std::exception& error) { std::cerr<<error.what(); return 1; }
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
        "/I",
        "native/include",
        "/I",
        "native/src",
        `/external:I${join(nativeFixtureVcpkgRoot, "include")}`,
        "/external:W0",
        `/Fo${directory}/`,
        `/Fe${executable}`,
        cpp,
        "/link",
        join(nativeFixtureVcpkgRoot, "lib/SDL3.lib"),
    ]);
    assert.equal(
        execFileSync(executable, {
            encoding: "utf8",
            timeout: 30000,
            windowsHide: true,
            env: {
                ...tools.environment,
                PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${tools.environment.PATH ?? ""}`,
            },
        }),
        "",
    );
});
