import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { emitUpstreamGenerated } from "../src/upstream-lower.js";
import { nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const tools = optionalNativeFixtureTools();

test("physics containers preserve pinned relative transforms, concavity, ownership and singular refusal", { skip: !tools }, () => {
    const output = resolve("artifacts/physics-container-check");
    mkdirSync(output, { recursive: true });
    emitUpstreamGenerated(output, ["core", "camera:free", "renderer:scene", "physics:world", "physics:container"]);
    const executable = join(output, "physics-container-check.exe");
    runNativeFixtureCompiler(tools!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD", "/O2", "/Gy",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/src", "/I", "native/include",
        "/I", join(output, "upstream/include"), "/I", join(output, "upstream/src"),
        `/external:I${join(nativeFixtureVcpkgRoot, "include/bullet")}`, "/external:W0",
        "test/fixtures/physics-container-check.cpp", join(output, "upstream/src/scene_core.cpp"),
        "/link", "/OPT:REF", `/LIBPATH:${join(nativeFixtureVcpkgRoot, "lib")}`,
        "BulletDynamics.lib", "BulletCollision.lib", "LinearMath.lib",
    ]);
    const result = execFileSync(executable, {
        encoding: "utf8",
        env: { ...tools!.environment, PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${tools!.environment.PATH ?? ""}` },
    });
    assert.match(result, /physics-container-check: ok/);
});
