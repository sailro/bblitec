import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { cppFunction, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("both renderers retain surviving uploads and refresh task lists when topology or visibility changes", t => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) { t.skip("A native fixture compiler is required."); return; }
    const output = resolve("artifacts/scene-topology-sync");
    mkdirSync(output, { recursive: true });
    const shared = readFileSync("native/src/pal_gpu_shared.hpp", "utf8");
    writeFileSync(join(output, "rematch.hpp"), "template <typename GpuMesh, typename ReleaseMesh, typename UploadItem>\n" +
        cppFunction(shared, "inline std::vector<GpuMesh> rematch_render_meshes("));
    for (const [backend, file] of [["Sdl", "pal_sdl_gpu.cpp"], ["Dawn", "pal_dawn.cpp"]] as const) {
        const source = cppFunction(readFileSync(`native/src/${file}`, "utf8"), "void synchronize()");
        const condition = source.indexOf("scene.render_topology_version !=");
        const start = source.lastIndexOf("if (", condition);
        const assignment = "synced_draw_list_epoch = engine.draw_list_epoch;";
        const end = source.indexOf(assignment, start) + assignment.length;
        assert.ok(condition >= 0 && start >= 0 && end > start);
        writeFileSync(join(output, `${backend}Sync.hpp`), `void synchronize() {\n${source.slice(start, end)}\n}`);
    }
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD", "/O2",
        `/Fo:${output}/`, `/Fe:${executable}`, "/I", "native/include", "/I", output,
        "test/fixtures/scene-topology-sync-check.cpp"]);
    assert.equal(execFileSync(executable, { encoding: "utf8" }), "");
});
