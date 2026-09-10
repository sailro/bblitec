import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { cppFunction, cppRecord, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("Dawn mesh teardown releases bindings before resources and shared layouts", t => {
    const tools = optionalNativeFixtureTools(false), dawnInclude = resolve("artifacts/tools/dawn/include");
    if (!tools || !existsSync(join(dawnInclude, "webgpu/webgpu.h"))) {
        t.skip("Native compiler and Dawn headers are required."); return;
    }
    const output = resolve("artifacts/dawn-mesh-lifetime");
    mkdirSync(output, { recursive: true });
    const source = readFileSync("native/src/pal_dawn.cpp", "utf8");
    const shared = readFileSync("native/src/pal_gpu_shared.hpp", "utf8");
    writeFileSync(join(output, "records.hpp"), [
        ...["DawnMeshBindings", "DawnShaderBindings", "DawnShaderBindingKey", "DawnDrawResources"].map(name => cppRecord(source, `struct ${name} {`)),
        "struct DawnState; using DawnDrawState = OwnedGpuRecord<DawnDrawResources, DawnState>;",
        cppRecord(source, "struct DawnMeshResources {"),
        "using DawnMesh = OwnedGpuRecord<DawnMeshResources, DawnState>;",
    ].join("\n"));
    writeFileSync(join(output, "release-helpers.hpp"), [
        "template <typename Shared>\n" + cppFunction(shared, "inline void release_shared_user("),
        ...["prune_unused_shared", "release_all_shared"].map(name => "template <typename Cache, typename Release>\n" + cppFunction(shared, `inline void ${name}(`)),
        cppFunction(source, "void release_dawn_composed_material_textures("),
        cppFunction(source, "void release_dawn_shader_bindings("),
        cppFunction(source, "void release_variant_family("),
        cppFunction(readFileSync("native/src/pal_dawn_shared.hpp", "utf8"), "inline void release_dawn_extra_textures("),
    ].join("\n"));
    writeFileSync(join(output, "release-methods.hpp"), ["void release_gpu_resources(DawnDrawResources&", "void release_gpu_resources(DawnMeshResources&",
        "void release_meshes(", "void prune_shared_shader_geometries(", "void prune_shared_shader_material_textures(",
        "void prune_shared_composed_material_textures(", "~DawnState("].map(signature => cppFunction(source, signature)).join("\n"));
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD", "/O2",
        `/Fo:${output}/`, `/Fe:${executable}`, "/I", "native/include", "/I", "native/src", "/I", output,
        `/external:I${dawnInclude}`, "/external:W0", "test/fixtures/dawn-mesh-lifetime-check.cpp"]);
    assert.equal(execFileSync(executable, { encoding: "utf8" }), "");
});
