import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { discoverDevelopmentTools } from "../src/development-tools.js";
import {
    cppFunction,
    cppSection,
    nativePosixFixtureOptions,
    optionalNativeFixtureTools,
    runFixtureExecutable,
    runGeneratedProgram,
} from "./native-fixture.js";
import { runFixtureCompiler } from "./native-fixture-cache.js";

const parser = (): string =>
    cppFunction(
        readFileSync("native/src/pal_sdl_gpu_compute_pipeline.hpp", "utf8"),
        "inline void read_sdl_metal_workgroup_memory(",
    );

test("Metal fixture excludes only the exact expected synchronous error and retains unexpected errors", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("Native fixture compiler unavailable");
    const source = readFileSync(
        "test/fixtures/sdl-metal-workgroup-memory/check.cpp",
        "utf8",
    );
    runGeneratedProgram(
        tools,
        "test-sdl-metal-expected-errors",
        `#include <atomic>
#include <cassert>
#include <cstdio>
#include <string_view>
#include <thread>
#define SDLCALL
enum SDL_LogPriority { SDL_LOG_PRIORITY_WARN, SDL_LOG_PRIORITY_ERROR, SDL_LOG_PRIORITY_CRITICAL };
${cppSection(source, "std::atomic<unsigned> validation_errors", "void require(")}
int main() {
    const char* expected = "expected allocation refusal";
    log_message(nullptr, 0, SDL_LOG_PRIORITY_WARN, expected);
    assert(validation_errors == 0 && expected_error_count == 0);
    log_message(nullptr, 0, SDL_LOG_PRIORITY_ERROR, expected);
    assert(validation_errors == 1 && expected_error_count == 0);
    expected_error = expected;
    log_message(nullptr, 0, SDL_LOG_PRIORITY_ERROR, expected);
    assert(validation_errors == 1 && expected_error_count == 1);
    log_message(nullptr, 0, SDL_LOG_PRIORITY_ERROR, "expected allocation refusal extra");
    log_message(nullptr, 0, SDL_LOG_PRIORITY_CRITICAL, expected);
    std::thread other([&] { log_message(nullptr, 0, SDL_LOG_PRIORITY_ERROR, expected); });
    other.join();
    assert(validation_errors == 4 && expected_error_count == 1);
    log_message(nullptr, 0, SDL_LOG_PRIORITY_ERROR, expected);
    assert(expected_error_count == 2); // The caller's exactly-one assertion detects duplicates.
    expected_error = nullptr;
    log_message(nullptr, 0, SDL_LOG_PRIORITY_ERROR, expected);
    assert(validation_errors == 5 && expected_error_count == 2);
}
`,
        { expectedOutput: "" },
    );
});

test("Metal workgroup metadata accepts typed lengths and refuses malformed or duplicate records", (t) => {
    const tools =
        process.platform === "win32" ? undefined : discoverDevelopmentTools();
    const windows =
        process.platform === "win32"
            ? optionalNativeFixtureTools(false)
            : undefined;
    if (process.platform === "win32" ? !windows : !tools?.cxx)
        return t.skip("C++ compiler unavailable");
    const cpp = `#include <cassert>
#include <charconv>
#include <cstdint>
#include <limits>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>
using Uint32 = std::uint32_t;
#define SDL_GPU_METAL_MAX_THREADGROUP_MEMORY_SLOTS 31
${parser()}
int main() {
    for (const auto text : {"0", "1 12", "2 0 17", "1 4294967280"}) {
        std::optional<std::vector<Uint32>> sizes;
        std::istringstream row(text);
        read_sdl_metal_workgroup_memory(row, sizes);
        assert(sizes.has_value());
    }
    for (const auto text : {"", "-1", "+1 4", "32", "1", "1 -1", "1 -18446744073709551615", "1 4294967281", "1 4294967296", "1 3x", "1 1.5", "1 0x10", "0 extra"}) {
        std::optional<std::vector<Uint32>> sizes;
        std::istringstream row(text);
        bool refused = false;
        try { read_sdl_metal_workgroup_memory(row, sizes); }
        catch (const std::runtime_error&) { refused = true; }
        assert(refused);
    }
    std::optional<std::vector<Uint32>> sizes;
    std::istringstream first("0"), duplicate("0");
    read_sdl_metal_workgroup_memory(first, sizes);
    bool refused = false;
    try { read_sdl_metal_workgroup_memory(duplicate, sizes); }
    catch (const std::runtime_error&) { refused = true; }
    assert(refused);
}
`;
    if (windows) {
        runGeneratedProgram(windows, "test-sdl-metal-workgroup-parser", cpp);
        return;
    }
    const output = resolve("artifacts/test-sdl-metal-workgroup-parser");
    mkdirSync(output, { recursive: true });
    const file = join(output, "check.cpp");
    const exe = join(output, "check.exe");
    writeFileSync(file, cpp);
    runFixtureCompiler(
        tools!.cxx!,
        process.env,
        [...nativePosixFixtureOptions(), file, "-o", exe],
        resolve("."),
    );
    runFixtureExecutable(exe);
});

test(
    "MSL typed allocation metadata drives direct and indirect Metal workgroup storage",
    {
        skip:
            process.platform !== "darwin" ||
            process.env.BBLITE_TEST_METAL !== "1",
    },
    () => {
        const tools = discoverDevelopmentTools();
        assert.ok(tools.cmake && tools.cxx && tools.bbliteTint);
        const sdl = process.env.BBLITE_TEST_SDL_DIR;
        assert.ok(
            sdl && existsSync(join(sdl, "SDL3Config.cmake")),
            "Select the rebuilt SDL package",
        );
        const output = resolve("artifacts/test-sdl-metal-workgroup-memory");
        mkdirSync(output, { recursive: true });
        writeFileSync(
            join(output, "workgroup_parser.hpp"),
            `#pragma once
#include <SDL3/SDL.h>
#include <charconv>
#include <cstdint>
#include <limits>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>
${parser()}`,
        );
        const shaders = {
            plain: "@group(0) @binding(0) var<storage,read_write> result:array<u32>; @compute @workgroup_size(1) fn main(){result[0]=19u;}",
            scalar: `@group(0) @binding(0) var<storage,read_write> result:array<u32>;
var<workgroup> a:u32; var<workgroup> b:u32; var<workgroup> c:u32;
@compute @workgroup_size(1) fn main(){let initial=a+b+c; a=3u; b=4u; c=5u; workgroupBarrier(); result[0]=initial+a+b+c;}`,
            matrix: `override count:u32=8u;
@group(0) @binding(0) var<storage,read_write> result:array<u32>;
var<workgroup> values:array<u32,count>; var<workgroup> matrix:mat3x3f;
@compute @workgroup_size(4) fn main(@builtin(local_invocation_index) i:u32) {
if(i==0u){matrix=mat3x3f(1,0,0,0,1,0,0,0,1);}
values[i]=i+7u; workgroupBarrier();
result[i]=values[(i+1u)%4u]+u32(matrix[0][0])+values[count-1u];
}`,
        };
        const run = (command: string, args: string[]): string => {
            const result = spawnSync(command, args, {
                encoding: "utf8",
                maxBuffer: 32 * 1024 * 1024,
            });
            assert.equal(
                result.status,
                0,
                result.error?.message ?? result.stdout + result.stderr,
            );
            return result.stdout;
        };
        for (const [name, source, overrides] of [
            ["plain", shaders.plain, ""],
            ["scalar", shaders.scalar, ""],
            ["matrix8", shaders.matrix, "count=8"],
            ["matrix12", shaders.matrix, "count=12"],
        ] as const) {
            const input = join(output, `${name}.wgsl`);
            writeFileSync(input, source);
            run(tools.bbliteTint, [
                input,
                "--entry-point",
                "main",
                "--stage",
                "compute",
                "--msl",
                join(output, `${name}.msl`),
                "--slots",
                join(output, `${name}.slots`),
                ...(overrides ? ["--overrides", overrides] : []),
            ]);
        }
        const allocations = (name: string): number[] => {
            const row = readFileSync(join(output, `${name}.slots`), "utf8")
                .split(/\r?\n/)
                .find((line) => line.startsWith("@msl-workgroup-memory "));
            assert.ok(
                row,
                "MSL allocation metadata is mandatory even for no workgroup variables",
            );
            const values = row.split(/\s+/).slice(1).map(Number);
            assert.equal(values[0], values.length - 1);
            return values.slice(1);
        };
        assert.deepEqual(allocations("plain"), []);
        assert.deepEqual(allocations("scalar"), [12]);
        assert.ok(allocations("matrix12")[0]! > allocations("matrix8")[0]!);
        assert.match(
            readFileSync(join(output, "matrix8.msl"), "utf8"),
            /\[\[threadgroup\(0\)\]\]/,
        );
        // A non-Metal compilation must not claim a Metal-specific allocation record.
        run(tools.bbliteTint, [
            join(output, "scalar.wgsl"),
            "--entry-point",
            "main",
            "--stage",
            "compute",
            "--spirv",
            join(output, "scalar.spv"),
            "--slots",
            join(output, "scalar.spirv.slots"),
        ]);
        assert.doesNotMatch(
            readFileSync(join(output, "scalar.spirv.slots"), "utf8"),
            /@msl-workgroup-memory/,
        );
        writeFileSync(
            join(output, "configure.log"),
            run(tools.cmake, [
                "-S",
                "test/fixtures/sdl-metal-workgroup-memory",
                "-B",
                join(output, "build"),
                "-G",
                "Ninja",
                `-DCMAKE_CXX_COMPILER=${tools.cxx}`,
                "-DCMAKE_BUILD_TYPE=Release",
                `-DSDL3_DIR=${sdl}`,
                `-DBBLITE_TEST_GENERATED_DIR=${output}`,
                `-DBBLITE_TEST_COMPILE_OPTIONS=${nativePosixFixtureOptions().join(";")}`,
            ]),
        );
        writeFileSync(
            join(output, "build.log"),
            run(tools.cmake, [
                "--build",
                join(output, "build"),
                "--parallel",
                "2",
            ]),
        );
        const executed = spawnSync(
            join(output, "build/sdl_metal_workgroup_check"),
            [output],
            {
                encoding: "utf8",
                timeout: 60000,
                maxBuffer: 32 * 1024 * 1024,
                env: {
                    ...process.env,
                    MTL_DEBUG_LAYER: "1",
                    SDL_GPU_DRIVER: "metal",
                    SDL_ASSERT: "abort",
                },
            },
        );
        const log = executed.stdout + executed.stderr;
        writeFileSync(join(output, "run.log"), log);
        assert.equal(executed.status, 0, executed.error?.message ?? log);
        assert.match(log, /Metal API Validation Enabled/);
        assert.doesNotMatch(log, /failed assertion|MTLDebug.*error/i);
        assert.match(
            log,
            /sdl-metal-workgroup-check: direct, indirect, initialization, matrix, switching and validation passed/,
        );
    },
);
