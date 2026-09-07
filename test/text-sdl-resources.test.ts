import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { pinnedDepthStateHeader } from "../src/lowering/pinned-depth-state.js";
import { nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("SDL text uniform writes preserve captured group identity and untouched lanes", (t) => {
    const tools = optionalNativeFixtureTools();
    if (!tools) { t.skip("A native fixture compiler and installed SDL headers are required."); return; }
    const output = resolve("artifacts/test-text-sdl-resources");
    const includes = join(output, "include");
    mkdirSync(join(includes, "bblite/upstream"), { recursive: true });
    writeFileSync(join(includes, "bblite/upstream/pinned_depth_state.hpp"), pinnedDepthStateHeader(new LoweringContext()));
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/EHsc", "/W4", "/WX", "/DBBLITE_VISUAL_CAPTURE=0",
        `/I${resolve("native/include")}`, `/I${resolve("native/src")}`, `/I${includes}`,
        `/I${join(nativeFixtureVcpkgRoot, "include")}`, resolve("test/fixtures/text-sdl-resources-check.cpp"),
        `/Fe:${executable}`, `/Fo:${join(output, "check.obj")}`, "/link",
        `/LIBPATH:${join(nativeFixtureVcpkgRoot, "lib")}`, "SDL3.lib"]);
    assert.equal(execFileSync(executable, { encoding: "utf8", env: {
        ...process.env, PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${process.env.PATH ?? ""}`,
    } }), "");
});
