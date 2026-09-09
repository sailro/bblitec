import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { discoverDevelopmentTools, discoverWindowsBuildTools } from "../src/development-tools.js";

for (const compiler of ["msvc", "clangcl"] as const) {
    test(`${compiler} reuses native objects across build directories and invalidates changed headers`, (t) => {
        const tools = discoverDevelopmentTools();
        if (process.platform !== "win32" || !tools.cmake || !tools.ccache) {
            t.skip("Windows, CMake and ccache are required."); return;
        }
        const windows = discoverWindowsBuildTools(compiler);
        const artifacts = resolve("artifacts/test-native-cache");
        mkdirSync(artifacts, { recursive: true });
        const root = mkdtempSync(join(artifacts, `${compiler}-`));
        const source = join(root, "source");
        mkdirSync(join(source, "src"), { recursive: true });
        const native = resolve("native").replaceAll("\\", "/");
        writeFileSync(join(source, "CMakeLists.txt"), `cmake_minimum_required(VERSION 3.24)
project(cache_fixture LANGUAGES CXX)
set(BBLITE_NATIVE_ROOT "${source.replaceAll("\\", "/")}")
include("${native}/compiler-cache.cmake")
include("${native}/native-header-cache.cmake")
bblite_cached_headers(shared_headers)
add_executable(check src/main.cpp)
target_include_directories(check PRIVATE "\${shared_headers}")
target_compile_features(check PRIVATE cxx_std_20)
`);
        const firstGenerated = join(root, "generated-first"), secondGenerated = join(root, "generated-second");
        const header = (generated: string): string => join(generated, "upstream/include/bblite/upstream/constants.hpp");
        for (const generated of [firstGenerated, secondGenerated]) {
            mkdirSync(join(generated, "upstream/include/bblite/upstream"), { recursive: true });
            writeFileSync(join(generated, "upstream/include/bblite/value.hpp"), "#include <bblite/upstream/constants.hpp>\n");
            writeFileSync(header(generated), "#define FIXTURE_VALUE 2\n");
        }
        writeFileSync(join(source, "src/main.cpp"), '#include <bblite/value.hpp>\n#include <cstdio>\nint main() { std::printf("%d", FIXTURE_VALUE); }\n');
        const log = join(root, "cache.log");
        writeFileSync(log, "");
        const env = { ...windows.environment, CCACHE_LOGFILE: log };
        const run = (args: string[]): void => { execFileSync(tools.cmake!, args, { env, stdio: "pipe" }); };
        const configure = (build: string, generated: string): void => run(["-S", source, "-B", build, "-G", "Ninja",
            `-DCMAKE_MAKE_PROGRAM=${windows.ninja}`, `-DCMAKE_CXX_COMPILER=${windows.compiler}`,
            `-DBBLITE_GENERATED_DIR=${generated}`,
            `-DBBLITE_CCACHE=${tools.ccache}`, `-DBBLITE_NATIVE_CACHE_DIR=${join(root, "cache")}`,
            "-DCMAKE_BUILD_TYPE=Release"]);
        const first = join(root, "first"), second = join(root, "second");
        configure(first, firstGenerated); run(["--build", first]);
        writeFileSync(log, "");
        configure(second, secondGenerated); run(["--build", second]);
        const executable = join(second, "check.exe");
        assert.equal(execFileSync(executable, { encoding: "utf8" }), "2");
        assert.ok(/Result: (?:direct|preprocessed)_cache_hit/.test(readFileSync(log, "utf8")), "the second build must reuse a cached object");
        writeFileSync(header(secondGenerated), "#define FIXTURE_VALUE 7\n");
        run(["--build", second]);
        assert.equal(execFileSync(executable, { encoding: "utf8" }), "7");
    });
}
