import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { pinnedSharedVariantDecls } from "../src/pinned-pbr-variant-cpp.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { cppFunction, cppRecord, nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("PBR feature keys and both backend stream bindings agree with pinned instance colors", async t => {
    const tools = optionalNativeFixtureTools(), dawnInclude = resolve("artifacts/tools/dawn/include");
    if (!tools || !existsSync(join(dawnInclude, "webgpu/webgpu.h"))) { t.skip("Native compiler and GPU headers are required."); return; }
    const output = resolve("artifacts/instance-stream-binding");
    mkdirSync(output, { recursive: true });
    const shared = readFileSync("native/src/pal_gpu_shared.hpp", "utf8");
    const sdl = readFileSync("native/src/pal_sdl_gpu.cpp", "utf8"), dawn = readFileSync("native/src/pal_dawn.cpp", "utf8");
    const key = cppFunction(shared, "inline PinnedVariantKey pinned_variant_key(");
    const start = key.indexOf("if (draw.item.mesh.value < engine.meshes.size())");
    assert.ok(start >= 0);
    const sdlDraw = cppFunction(sdl, "void draw_pinned_variant(");
    const bindStart = sdlDraw.indexOf("const bool instanced_draw =");
    const bindEnd = sdlDraw.indexOf("const SDL_GPUBufferBinding pinned_index_binding", bindStart);
    assert.ok(bindStart >= 0 && bindEnd > bindStart);
    writeFileSync(join(output, "features.hpp"), pinnedSharedVariantDecls(new LoweringContext(), "Pinned instance feature constants"));
    writeFileSync(join(output, "bindings.hpp"), [
        cppFunction(shared, "inline bool pinned_record_instanced("), cppFunction(shared, "inline bool pinned_record_instance_colored("),
        cppFunction(shared, "inline constexpr std::uint32_t vertex_stream_slot("),
        `std::size_t features(const Engine& engine) { struct { struct { MeshHandle mesh{0}; } item; } draw;
            struct { std::size_t mesh_features = 0; unsigned material_view = 0; } key;
            ${cppFunction(key.slice(start), "if (")} return key.mesh_features; }`,
        cppFunction(sdl, "void bind_composed_mesh_vertex_buffers("),
        `void sdl_bind(const Engine& engine, const SdlMesh& mesh) {
            struct { MeshHandle mesh{0}; } item;
            const auto& pinned_record = engine.meshes[0];
            SDL_GPURenderPass* pass = nullptr; SDL_GPUBuffer* pinned_vertices = mesh.vertices;
            ${sdlDraw.slice(bindStart, bindEnd)} }`,
        cppRecord(dawn, "struct InstanceStreams {"),
        "enum class InstanceMatrixSource { standard, pinned };",
        cppFunction(dawn, "InstanceStreams instance_streams_for("), cppFunction(dawn, "void encode_variant_draw("),
    ].join("\n"));
    const { _computeMeshFeatures } = await importPinnedModule<{ _computeMeshFeatures(mesh: unknown): number }>("material/mesh-features.js");
    const expected = [false, true].flatMap(pool => [false, true].map(colors => _computeMeshFeatures({ _gpu: {},
        ...(pool ? { thinInstances: { ...(colors ? { colors: new Float32Array([.2, .3, .4, 1]) } : {}) } } : {}) })));
    writeFileSync(join(output, "expected.hpp"), `constexpr std::array<std::size_t, 4> expected_features{${expected.join(",")}};`);
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD", "/O2", "/DSDL_STATIC_LIB",
        `/Fo:${output}/`, `/Fe:${executable}`, "/I", "native/include", "/I", output,
        `/external:I${dawnInclude}`, `/external:I${join(nativeFixtureVcpkgRoot, "include")}`, "/external:W0",
        "test/fixtures/instance-stream-binding-check.cpp"]);
    assert.equal(execFileSync(executable, { encoding: "utf8" }), "");
});
