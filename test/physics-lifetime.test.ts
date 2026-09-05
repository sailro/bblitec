import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { emitUpstreamGenerated } from "../src/upstream-lower.js";
import { nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const tools = optionalNativeFixtureTools();

test("generated physics follows engine ownership across teardown and retained callbacks", { skip: !tools }, () => {
    const output = resolve("artifacts/physics-lifetime-check");
    mkdirSync(output, { recursive: true });
    emitUpstreamGenerated(output, ["core", "camera:free", "renderer:scene", "physics:world"]);
    const executable = join(output, "physics-lifetime-check.exe");
    runNativeFixtureCompiler(tools!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD", "/O2", "/Gy",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/src", "/I", "native/include",
        "/I", join(output, "upstream/include"), "/I", join(output, "upstream/src"),
        `/external:I${join(nativeFixtureVcpkgRoot, "include/bullet")}`, "/external:W0",
        "test/fixtures/physics-lifetime-check.cpp", join(output, "upstream/src/scene_core.cpp"),
        "/link", "/OPT:REF", `/LIBPATH:${join(nativeFixtureVcpkgRoot, "lib")}`,
        "BulletDynamics.lib", "BulletCollision.lib", "LinearMath.lib",
    ]);
    const result = execFileSync(executable, {
        encoding: "utf8",
        env: { ...tools!.environment, PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${tools!.environment.PATH ?? ""}` },
    });
    assert.match(result, /physics-lifetime-check: ok/);
});
