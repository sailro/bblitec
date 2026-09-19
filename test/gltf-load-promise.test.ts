import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { gltfLoadPromise } from "../src/lowering/gltf/load-promise.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("settled glTF promises allocate no wrapper storage and retain values and rejection identities", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    const directory = resolve("artifacts", "gltf-load-promise");
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, "load-promise.hpp"), gltfLoadPromise);
    const executable = resolve(directory, "check.exe");
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/permissive-",
        "/EHsc",
        "/MD",
        `/I${directory}`,
        `/Fo${directory}\\`,
        `/Fe${executable}`,
        resolve("test", "fixtures", "gltf-load-promise-check.cpp"),
    ]);
    assert.equal(execFileSync(executable, { encoding: "utf8" }), "");
});
