import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { writeKtx1 } from "../src/basis-transcode.js";
import { compressedTextureFormat } from "../src/compressed-texture-format.js";
import { packageKtx1 } from "../src/compressed-texture-package.js";
import { discoverDevelopmentTools } from "../src/development-tools.js";
import { CompressedTextureLowerer } from "../src/lowering/compressed-texture-lowerer.js";
import { LoweringContext } from "../src/lowering/context.js";
import { UpstreamSourceStore } from "../src/upstream-source.js";
import {
    cppFunction,
    cppRecord,
    cppSection,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
    runGeneratedProgram,
    sceneBackendSource,
    sharedGpuSource,
} from "./native-fixture.js";

const native = optionalNativeFixtureTools();

test(
    "compressed copy plans lower pinned arithmetic and preserve checked GPU sizes",
    { skip: !native },
    async () => {
        const store = new UpstreamSourceStore();
        const module = "src/texture/ktx-loader.ts";
        class ChangedContext extends LoweringContext {
            public constructor(
                private readonly before: string,
                private readonly after: string,
            ) {
                super(store);
            }
            public override sourceFile(path: string): ts.SourceFile {
                if (path !== module) return super.sourceFile(path);
                const source = store.getSource(path);
                assert.ok(source.includes(this.before));
                return ts.createSourceFile(
                    path,
                    source.replace(this.before, this.after),
                    ts.ScriptTarget.Latest,
                    true,
                );
            }
        }
        const base = new CompressedTextureLowerer(new LoweringContext(store));
        const bytes = await packageKtx1(
            writeKtx1(
                {
                    gpuFormat: "bc7-rgba-unorm",
                    width: 5,
                    height: 3,
                    mips: [{ width: 5, height: 3, bytes: new Uint8Array(32) }],
                },
                base.magicBytes(),
                base.glInternalFormat("bc7-rgba-unorm"),
                base.headerLayout(),
            ),
        );
        const astcBytes = await packageKtx1(
            writeKtx1(
                {
                    gpuFormat: "astc-5x4-unorm",
                    width: 6,
                    height: 5,
                    mips: [{ width: 6, height: 5, bytes: new Uint8Array(64) }],
                },
                base.magicBytes(),
                base.glInternalFormat("astc-5x4-unorm"),
                base.headerLayout(),
            ),
        );
        const variants = [
            {
                before: "Math.ceil(mip.width / fmt.blockW)",
                after: "Math.ceil(mip.width / fmt.blockW)",
                row: 32,
                width: 8,
            },
            {
                before: "Math.ceil(mip.width / fmt.blockW)",
                after: "Math.ceil(/* width */ ((mip.width) / (fmt.blockW)))",
                row: 32,
                width: 8,
            },
            {
                before: "Math.ceil(mip.width / fmt.blockW)",
                after: "Math.ceil(mip.width / fmt.blockW) + 1",
                row: 48,
                width: 12,
            },
            {
                before: "{ bytesPerRow: rowBytes }",
                after: "{ bytesPerRow: rowBytes + 16 }",
                row: 48,
                width: 8,
            },
        ];
        const bodies = variants.map((variant, index) => {
            const lowered = new CompressedTextureLowerer(
                new ChangedContext(variant.before, variant.after),
            ).lower();
            return `${cppSection(
                lowered.source,
                "namespace bbl::upstream {",
                "} // namespace bbl::upstream",
            ).replace(
                "namespace bbl::upstream {",
                `namespace case${index} { using namespace bbl; using namespace bbl::upstream;`,
            )}\n}`;
        });
        const directory = resolve("artifacts/compressed-copy-plans");
        const headers = join(directory, "bblite/upstream");
        mkdirSync(headers, { recursive: true });
        writeFileSync(
            join(headers, "compressed_texture.hpp"),
            base.lower().header,
        );
        runGeneratedProgram(
            native!,
            "compressed-copy-plans",
            `
#include <bblite/upstream/compressed_texture.hpp>
#include <cassert>
${bodies.join("\n")}
int main() {
    const std::vector<std::uint8_t> bytes{${[...bytes].join(",")}};
    const auto astc = case0::read_compressed_texture({${[...astcBytes].join(",")}});
    assert((astc.mips.at(0).copy == bbl::CompressedMipCopy{32, 10, 8}));
${variants
    .map(
        (variant, index) => `{
    const auto texture = case${index}::read_compressed_texture(bytes);
    const auto& mip = texture.mips.at(0);
    assert(mip.copy.row_bytes == ${variant.row} && mip.copy.width == ${variant.width} && mip.copy.height == 4);
}`,
    )
    .join("\n")}
    auto overflowing = bytes;
    for (unsigned i = 0; i < 4; ++i) overflowing[${compressedTextureFormat.headerBytes + compressedTextureFormat.mipWidth} + i] = 255;
    bool refused = false;
    try { case0::read_compressed_texture(overflowing); }
    catch (const std::runtime_error&) { refused = true; }
    assert(refused);
    auto tail = bytes;
    tail[${compressedTextureFormat.headerBytes + compressedTextureFormat.mipWidth}] = 1;
    tail[${compressedTextureFormat.headerBytes + compressedTextureFormat.mipHeight}] = 1;
    const auto texture = case0::read_compressed_texture(tail);
    assert((texture.mips[0].copy == bbl::CompressedMipCopy{16, 4, 4}));
}
`,
            { flags: [`/I${directory}`], expectedOutput: "" },
        );
        assert.throws(
            () =>
                new CompressedTextureLowerer(
                    new ChangedContext(
                        "{ bytesPerRow: rowBytes }",
                        "{ bytesPerRow: rowBytes, rowsPerImage: 4 }",
                    ),
                ).lower(),
            /unrepresented upload options/,
        );
    },
);

test(
    "compressed texture candidates use device support in source order and both API tables agree",
    { skip: !native },
    () => {
        const shared = sharedGpuSource();
        const sdl = cppFunction(
            sceneBackendSource("sdl"),
            "SDL_GPUTextureFormat compressed_texture_format(",
        );
        const dawnSource = sceneBackendSource("dawn");
        const dawn = cppFunction(
            dawnSource,
            "WGPUTextureFormat compressed_texture_format(",
        );
        const upload = cppFunction(
            dawnSource,
            "WGPUTexture upload_material_texture(",
        );
        const uploadCompressed = cppFunction(
            dawnSource,
            "WGPUTexture upload_compressed_texture(",
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
#include "pal_dawn_resources.hpp"
#include "pal_compressed_formats.hpp"
#include <cassert>
static WGPUFeatureName supported = WGPUFeatureName_TextureCompressionBC;
static WGPUTextureFormat uploaded_format = WGPUTextureFormat_Undefined;
static unsigned texture_writes = 0;
extern "C" WGPUBool wgpuDeviceHasFeature(WGPUDevice, WGPUFeatureName feature) {
    return feature == supported;
}
extern "C" WGPUBool wgpuAdapterHasFeature(WGPUAdapter, WGPUFeatureName) { return false; }
extern "C" WGPUTexture wgpuDeviceCreateTexture(WGPUDevice, const WGPUTextureDescriptor* descriptor) {
    uploaded_format = descriptor->format;
    return reinterpret_cast<WGPUTexture>(1);
}
extern "C" void wgpuTextureRelease(WGPUTexture) {}
extern "C" void wgpuQueueWriteTexture(WGPUQueue, const WGPUTexelCopyTextureInfo*, const void*, size_t,
    const WGPUTexelCopyBufferLayout* layout, const WGPUExtent3D* extent) {
    assert(layout->bytesPerRow == 16);
    assert(layout->rowsPerImage == WGPU_COPY_STRIDE_UNDEFINED);
    assert(extent->width == 8 && extent->height == 8);
    ++texture_writes;
}
namespace bbl::pal {
${cppRecord(shared, "enum class CompressedBlockFormat")}
${cppFunction(shared, "CompressedBlockFormat compressed_block_format(")}
template <typename Supports>
${cppFunction(shared, "const CompressedTexture& select_compressed_texture(")}
}
namespace sdl { using namespace bbl::pal; ${sdl} }
namespace dawn {
using namespace bbl::pal;
using namespace bbl;
${dawn}
struct DawnState {
    WGPUDevice device = reinterpret_cast<WGPUDevice>(1);
    WGPUQueue queue = reinterpret_cast<WGPUQueue>(1);
    WGPUAdapter adapter = nullptr;
};
void dawn_error(const char* error) { throw std::runtime_error(error); }
${uploadCompressed}
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
    for (auto& mip : source.compressed.mips) mip.copy = {16, 8, 8};
    bbl::CompressedTexture bc;
    bc.format = "bc1-rgba-unorm";
    bc.mips.resize(2);
    for (auto& mip : bc.mips) mip.copy = {16, 8, 8};
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
    assert(uploaded_format == WGPUTextureFormat_BC1RGBAUnorm && texture_writes == 2);
    supported = WGPUFeatureName_TextureCompressionASTC;
    dawn::upload_selected(state, source, mip_count);
    assert(mip_count == 3);
    assert(uploaded_format == WGPUTextureFormat_ASTC8x8Unorm && texture_writes == 5);
    supported = WGPUFeatureName_TimestampQuery;
    bool device_refused = false;
    try { dawn::upload_selected(state, source, mip_count); }
    catch (const std::runtime_error&) { device_refused = true; }
    assert(device_refused && texture_writes == 5);
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
            "/I",
            "native/src",
            `/external:I${dawnInclude}`,
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
