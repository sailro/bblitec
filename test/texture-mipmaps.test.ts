import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { cppFunction, nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const native = optionalNativeFixtureTools();

test("Metal mip and UNORM clear transport preserves other backend and floating-format paths", { skip: !native }, () => {
    const directory = resolve("artifacts/texture-mipmaps");
    mkdirSync(directory, { recursive: true });
    const source = join(directory, "check.cpp"), executable = join(directory, "check.exe");
    const implementation = cppFunction(readFileSync("native/src/pal_sdl_gpu_shared.hpp", "utf8"), "inline void generate_texture_mipmaps(");
    const clear = cppFunction(readFileSync("native/src/pal_sdl_gpu_shared.hpp", "utf8"), "inline SDL_FColor gpu_clear_color(");
    writeFileSync(source, `#define SDL_STATIC_LIB
#include <SDL3/SDL.h>
#include <algorithm>
#include <cassert>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <vector>
struct SDL_GPUDevice { const char* driver; };
struct SDL_GPUCommandBuffer {};
struct SDL_GPUTexture {};
static int generated = 0;
static std::vector<SDL_GPUBlitInfo> blits;
extern "C" const char* SDLCALL SDL_GetGPUDeviceDriver(SDL_GPUDevice* device) { return device->driver; }
extern "C" void SDLCALL SDL_GenerateMipmapsForGPUTexture(SDL_GPUCommandBuffer*, SDL_GPUTexture*) { ++generated; }
extern "C" void SDLCALL SDL_BlitGPUTexture(SDL_GPUCommandBuffer*, const SDL_GPUBlitInfo* info) { blits.push_back(*info); }
${implementation}
${clear}
int main() {
    SDL_GPUDevice device{"metal"};
    SDL_GPUCommandBuffer command;
    SDL_GPUTexture texture;
    const SDL_FColor fractional{0.1f, 0.25f, -0.5f, 1.5f};
    for (const auto format : {SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM, SDL_GPU_TEXTUREFORMAT_B8G8R8A8_UNORM}) {
        const auto color = gpu_clear_color(&device, format, fractional);
        assert(color.r == 26.0f / 255.0f && color.g == 64.0f / 255.0f && color.b == 0 && color.a == 1);
    }
    for (const auto format : {SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT, SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM_SRGB}) {
        const auto color = gpu_clear_color(&device, format, fractional);
        assert(color.r == fractional.r && color.g == fractional.g && color.b == fractional.b && color.a == fractional.a);
    }
    generate_texture_mipmaps(&device, &command, &texture, 5, 3, 1);
    assert(generated == 0 && blits.empty());
    generate_texture_mipmaps(&device, &command, &texture, 5, 3, 3, 2);
    assert(generated == 0 && blits.size() == 4);
    for (std::uint32_t layer = 0; layer < 2; ++layer) {
        for (std::uint32_t mip = 1; mip < 3; ++mip) {
            const auto& blit = blits[layer * 2 + mip - 1];
            assert(blit.source.texture == &texture && blit.destination.texture == &texture);
            assert(blit.source.mip_level == mip - 1 && blit.destination.mip_level == mip);
            assert(blit.source.layer_or_depth_plane == layer && blit.destination.layer_or_depth_plane == layer);
            assert(blit.source.w == (mip == 1 ? 5u : 2u));
            assert(blit.source.h == (mip == 1 ? 3u : 1u));
            assert(blit.destination.w == (mip == 1 ? 2u : 1u));
            assert(blit.destination.h == 1);
            assert(blit.source.x == 0 && blit.source.y == 0);
            assert(blit.destination.x == 0 && blit.destination.y == 0);
            assert(blit.filter == SDL_GPU_FILTER_LINEAR && blit.flip_mode == SDL_FLIP_NONE);
            assert(blit.load_op == SDL_GPU_LOADOP_DONT_CARE && !blit.cycle);
        }
    }
    device.driver = "direct3d12";
    const auto color = gpu_clear_color(&device, SDL_GPU_TEXTUREFORMAT_B8G8R8A8_UNORM, fractional);
    assert(color.r == fractional.r && color.g == fractional.g && color.b == fractional.b && color.a == fractional.a);
    generate_texture_mipmaps(&device, &command, &texture, 5, 3, 3);
    device.driver = "vulkan";
    generate_texture_mipmaps(&device, &command, &texture, 5, 3, 3);
    assert(generated == 2 && blits.size() == 4);
}
`);
    runNativeFixtureCompiler(native!, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD",
        `/Fo:${directory}/`, `/Fe:${executable}`, `/external:I${join(nativeFixtureVcpkgRoot, "include")}`,
        "/external:W0", source]);
    assert.equal(execFileSync(executable, { encoding: "utf8", windowsHide: true }), "");
});
