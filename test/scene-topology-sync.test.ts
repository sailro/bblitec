import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { emitUpstreamGenerated } from "../src/upstream-lower.js";
import {
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("both renderers synchronize a scene in one order, keep surviving uploads, and render a camera-less pass as the pin does", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("A native fixture compiler is required.");
        return;
    }
    const output = resolve("artifacts/scene-topology-sync");
    mkdirSync(output, { recursive: true });
    // The shared units link against the upstream units a scene generates,
    // not against stubs of them; the engine factory's unit needs the
    // platform layer and is the one left out.
    emitUpstreamGenerated(output, ["camera:free", "renderer:scene"]);
    const upstreamSources = join(output, "upstream/src");
    const units = readdirSync(upstreamSources)
        .filter((name) => name.endsWith(".cpp") && name !== "engine.cpp")
        .map((name) => join(upstreamSources, name));
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        "/O2",
        "/Gy",
        "/permissive-",
        "/DSDL_STATIC_LIB",
        "/DBBLITE_HAS_PBR_RENDERER=1",
        "/DBBLITE_MESH_POSITION_UPDATE=1",
        `/Fo:${output}\\`,
        `/Fe:${executable}`,
        "/I",
        "native/include",
        "/I",
        "native/src",
        "/I",
        join(output, "upstream/include"),
        "/I",
        upstreamSources,
        "/I",
        join(nativeFixtureVcpkgRoot, "include"),
        "test/fixtures/scene-topology-sync-check.cpp",
        ...units,
        "/link",
        "/OPT:REF",
    ]);
    assert.match(
        execFileSync(executable, { encoding: "utf8" }),
        /scene-topology-sync-check: ok/,
    );
});
