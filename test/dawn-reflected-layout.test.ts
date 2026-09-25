import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("Dawn lays a group out from its stages' reflected .slots lines and the site's binding model", (t) => {
    const tools = optionalNativeFixtureTools(false),
        dawnInclude = resolve("artifacts/tools/dawn/include");
    if (!tools || !existsSync(join(dawnInclude, "webgpu/webgpu.h"))) {
        t.skip("Native compiler and Dawn headers are required.");
        return;
    }
    const output = resolve("artifacts/dawn-reflected-layout");
    mkdirSync(output, { recursive: true });
    const source = readFileSync("native/src/pal_dawn_shared.hpp", "utf8");
    // The layout reader and builder, from the one-bit helper through the
    // group count, exactly as the backend declares them.
    const first = "/** One bit per binding index";
    const last = cppFunction(
        source,
        "inline std::uint32_t dawn_reflected_group_count(",
    );
    const start = source.indexOf(first);
    const end = source.indexOf(last);
    assert.ok(start >= 0 && end > start);
    // The sidecar line walk and index parser both backends share.
    const common = readFileSync("native/src/pal_gpu_common.hpp", "utf8");
    const sidecarHelpers = [
        cppFunction(
            common,
            "template <typename Visit> inline void for_each_sidecar_line(",
        ),
        cppFunction(
            common,
            "inline std::optional<std::uint32_t> parse_sidecar_index(",
        ),
    ].join("\n");
    writeFileSync(
        join(output, "reflected-layout.hpp"),
        [sidecarHelpers, source.slice(start, end + last.length)].join("\n"),
    );
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        "/O2",
        `/Fo:${output}/`,
        `/Fe:${executable}`,
        "/I",
        output,
        `/external:I${dawnInclude}`,
        "/external:W0",
        "test/fixtures/dawn-reflected-layout-check.cpp",
    ]);
    assert.equal(execFileSync(executable, { encoding: "utf8" }), "");
});
