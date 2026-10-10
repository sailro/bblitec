import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import {
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const tools = optionalNativeFixtureTools();

test(
    "dynamic triangle meshes collide while shared static users retain geometry and lifetime",
    { skip: !tools },
    () => {
        const output = resolve("artifacts/physics-dynamic-mesh-check");
        mkdirSync(output, { recursive: true });
        const executable = join(output, "physics-dynamic-mesh-check.exe");
        runNativeFixtureCompiler(tools!, [
            "/O2",
            `/Fo:${output}\\`,
            `/Fe:${executable}`,
            "/I",
            "native/src",
            `/external:I${join(nativeFixtureVcpkgRoot, "include/bullet")}`,
            "test/fixtures/physics-dynamic-mesh-check.cpp",
            "/link",
            `/LIBPATH:${join(nativeFixtureVcpkgRoot, "lib")}`,
            "BulletDynamics.lib",
            "BulletCollision.lib",
            "LinearMath.lib",
        ]);
        const result = execFileSync(executable, {
            encoding: "utf8",
            env: {
                ...tools!.environment,
                PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${tools!.environment.PATH ?? ""}`,
            },
        });
        assert.match(result, /physics-dynamic-mesh-check: ok/);
    },
);
