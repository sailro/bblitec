import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { cppFunction, cppRecord, nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("standalone renderers synchronize live contexts, batch uploads and capture frame targets", t => {
    const tools = optionalNativeFixtureTools();
    const dawnInclude = resolve("artifacts/tools/dawn/include");
    if (!tools || !existsSync(join(dawnInclude, "webgpu/webgpu.h"))) {
        t.skip("A native fixture compiler and the pinned GPU headers are required."); return;
    }
    const directory = resolve("artifacts/test-standalone-capture");
    mkdirSync(directory, { recursive: true });
    const shared = readFileSync("native/src/pal_gpu_shared.hpp", "utf8");
    writeFileSync(join(directory, "capture-options.hpp"), [
        cppFunction(shared, "inline long benchmark_warmup_frames("),
        cppRecord(shared, "struct FrameOptions {"), cppRecord(shared, "class CaptureGate {"),
        cppFunction(shared, "inline void refuse_disposed_sprite_render_texture_in_use("),
        ...["inline bool sprite_passes_match_registered(", "inline std::size_t sprite_pass_target_run_end("].map(signature =>
            "template <typename SpritePassList>\n" + cppFunction(shared, signature)),
    ].join("\n"));
    writeFileSync(join(directory, "buffer-batch.hpp"), cppRecord(
        readFileSync("native/src/pal_sdl_gpu_shared.hpp", "utf8"), "class GpuBufferUploadBatch {"));
    for (const [name, file, signatures] of [
        ["SdlEffect", "pal_sdl_gpu_effect.cpp", ["bool acquire()", "void synchronize()", "void encode()", "void present()"]],
        ["SdlSprite", "pal_sdl_gpu_sprite.cpp", ["void sync_render_textures()", "void sync_renderer_passes()", "void synchronize()", "bool acquire()", "void encode()", "void present()"]],
        ["DawnEffect", "pal_dawn_effect.cpp", ["bool acquire()", "void encode()", "void present()"]],
        ["DawnSprite", "pal_dawn_sprite.cpp", ["void sync_render_textures()", "void sync_renderer_passes()", "bool acquire()", "void encode()", "void present()"]],
    ] as const) {
        const source = readFileSync(`native/src/${file}`, "utf8");
        const backend = name.startsWith("Sdl") ? "Sdl" : "Dawn";
        writeFileSync(join(directory, `${name}.hpp`), `struct ${name} : ${backend}Context {\n` +
            signatures.map(signature => cppFunction(source, signature)).join("\n") + "\n};\n");
    }
    const executable = join(directory, "check.exe");
    runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD", "/DSDL_STATIC_LIB",
        "/I", "native/include", "/I", "native/src", "/I", directory, "/I", dawnInclude,
        `/external:I${join(nativeFixtureVcpkgRoot, "include")}`, "/external:W0",
        `/Fo:${directory}/`, `/Fe:${executable}`, "test/fixtures/standalone-capture-check.cpp"]);
    assert.equal(execFileSync(executable, { encoding: "utf8" }), "");
});
