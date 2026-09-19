import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { discoverDevelopmentTools } from "../src/development-tools.js";
import {
    cppFunction,
    cppRecord,
    cppSection,
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const native = optionalNativeFixtureTools();

test(
    "compressed texture candidates use device support in source order and both API tables agree",
    { skip: !native },
    () => {
        const shared = readFileSync("native/src/pal_gpu_shared.hpp", "utf8");
        const sdl = cppFunction(
            readFileSync("native/src/pal_sdl_gpu.cpp", "utf8"),
            "SDL_GPUTextureFormat compressed_texture_format(",
        );
        const dawnSource = readFileSync("native/src/pal_dawn.cpp", "utf8");
        const dawn = cppFunction(
            dawnSource,
            "WGPUTextureFormat compressed_texture_format(",
        );
        const upload = cppFunction(
            dawnSource,
            "WGPUTexture upload_material_texture(",
        );
        const directory = resolve("artifacts/compressed-texture-selection");
        mkdirSync(directory, { recursive: true });
        const source = join(directory, "check.cpp"),
            executable = join(directory, "check.exe");
        writeFileSync(
            source,
            `#include <bblite/runtime.hpp>
#include <SDL3/SDL.h>
#include <dawn/webgpu.h>
#include "pal_compressed_formats.hpp"
#include <cassert>
namespace bbl::pal {
${cppRecord(shared, "enum class CompressedBlockFormat")}
${cppFunction(shared, "inline CompressedBlockFormat compressed_block_format(")}
template <typename Supports>
${cppFunction(shared, "const CompressedTexture& select_compressed_texture(")}
}
namespace sdl { using namespace bbl::pal; ${sdl} }
extern "C" WGPUBool wgpuDeviceHasFeature(WGPUDevice, WGPUFeatureName feature) {
    return feature == WGPUFeatureName_TextureCompressionBC;
}
namespace dawn {
using namespace bbl::pal;
${dawn}
struct DawnState { WGPUDevice device = nullptr; };
WGPUTexture upload_compressed_texture(DawnState&, const bbl::CompressedTexture&) { return nullptr; }
WGPUTexture upload_selected(DawnState& state, const bbl::TextureData& texture_data, std::uint32_t& out_mip_count) {
${cppSection(upload, "    if (!texture_data.compressed.mips.empty()) {", "    const DecodedImage image")}
    throw std::runtime_error("Expected a compressed texture.");
}
}
int main() {
#define CHECK_FORMAT(id, text, sdl_name, dawn_name) \\
    assert(sdl::compressed_texture_format(text) == SDL_GPU_TEXTUREFORMAT_##sdl_name); \\
    assert(dawn::compressed_texture_format(text) == WGPUTextureFormat_##dawn_name);
    BBLITE_COMPRESSED_FORMATS(CHECK_FORMAT)
#undef CHECK_FORMAT
    bbl::TextureData source;
    source.compressed.format = "astc-8x8-unorm";
    source.compressed.mips.resize(3);
    bbl::CompressedTexture bc;
    bc.format = "bc1-rgba-unorm";
    bc.mips.resize(2);
    source.compressed_alternatives = std::make_shared<const std::vector<bbl::CompressedTexture>>(
        std::vector<bbl::CompressedTexture>{bc});
    const auto& desktop = bbl::pal::select_compressed_texture(source, [](std::string_view format) { return format == "bc1-rgba-unorm"; });
    assert(&desktop == &source.compressed_alternatives->front());
    const auto& mobile = bbl::pal::select_compressed_texture(source, [](std::string_view) { return true; });
    assert(&mobile == &source.compressed);
    dawn::DawnState state;
    std::uint32_t mip_count = 0;
    dawn::upload_selected(state, source, mip_count);
    assert(mip_count == 2);
    bool refused = false;
    try { bbl::pal::select_compressed_texture(source, [](std::string_view) { return false; }); }
    catch (const std::runtime_error&) { refused = true; }
    assert(refused);
}
`,
        );
        const dawnInclude = join(
            discoverDevelopmentTools().dawnDirectory,
            "include",
        );
        runNativeFixtureCompiler(native!, [
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
            `/external:I${dawnInclude}`,
            "/external:W0",
            source,
            `/Fo:${directory}/`,
            `/Fe:${executable}`,
        ]);
        assert.equal(
            execFileSync(executable, { encoding: "utf8", windowsHide: true }),
            "",
        );
    },
);
