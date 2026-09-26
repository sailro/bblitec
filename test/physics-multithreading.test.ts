import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { discoverWindowsBuildTools } from "../src/development-tools.js";
import {
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("parallel physics preserves bounded contacts, worker ownership, sums and failures", (t) => {
    const tools = optionalNativeFixtureTools();
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/physics-multithreading");
    mkdirSync(directory, { recursive: true });
    const executable = join(directory, "check.exe");
    const arguments_ = [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        "/O2",
        "/I",
        "native/src",
        "/I",
        "native/include",
        `/external:I${join(nativeFixtureVcpkgRoot, "include/bullet")}`,
        "/external:W0",
        `/Fo:${directory}\\`,
        `/Fe:${executable}`,
        "test/fixtures/physics-multithreading-check.cpp",
        "/link",
        `/LIBPATH:${join(nativeFixtureVcpkgRoot, "lib")}`,
        "BulletDynamics.lib",
        "BulletCollision.lib",
        "LinearMath.lib",
    ];
    for (const compiler of [tools, discoverWindowsBuildTools("clangcl")]) {
        runNativeFixtureCompiler(compiler, arguments_);
        for (const threads of ["1", "4"]) {
            const output = execFileSync(executable, {
                env: {
                    ...compiler.environment,
                    BBLITE_PHYSICS_THREADS: threads,
                },
                encoding: "utf8",
                timeout: 60000,
            });
            assert.match(output, /physics-multithreading: ok/);
        }
    }
    assert.throws(
        () =>
            execFileSync(executable, {
                env: { ...tools.environment, BBLITE_PHYSICS_THREADS: "0" },
                encoding: "utf8",
                timeout: 10000,
                stdio: "pipe",
            }),
        /BBLITE_PHYSICS_THREADS must be an integer/,
    );
});
