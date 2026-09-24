import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import {
    discoverDevelopmentTools,
    discoverWindowsBuildTools,
} from "../src/development-tools.js";

for (const compiler of ["msvc", "clangcl"] as const) {
    test(`${compiler} reuses native objects across build directories and invalidates changed headers`, (t) => {
        const tools = discoverDevelopmentTools();
        if (process.platform !== "win32" || !tools.cmake || !tools.ccache) {
            t.skip("Windows, CMake and ccache are required.");
            return;
        }
        const windows = discoverWindowsBuildTools(compiler);
        const artifacts = resolve("artifacts/test-native-cache");
        mkdirSync(artifacts, { recursive: true });
        const root = mkdtempSync(join(artifacts, `${compiler}-`));
        const source = join(root, "source");
        mkdirSync(join(source, "src"), { recursive: true });
        const native = resolve("native").replaceAll("\\", "/");
        writeFileSync(
            join(source, "CMakeLists.txt"),
            `cmake_minimum_required(VERSION 3.24)
project(cache_fixture LANGUAGES CXX)
set(BBLITE_NATIVE_ROOT "${source.replaceAll("\\", "/")}")
include("${native}/compiler-cache.cmake")
include("${native}/native-header-cache.cmake")
add_executable(check src/main.cpp src/other.cpp)
target_compile_features(check PRIVATE cxx_std_20)
if(FIXTURE_SCENE_INVARIANT)
    bblite_cache_unit_headers(TARGETS check SCENE_INVARIANT check)
else()
    bblite_cache_unit_headers(TARGETS check)
endif()
`,
        );
        const firstGenerated = join(root, "generated-first"),
            secondGenerated = join(root, "generated-second");
        const header = (generated: string): string =>
            join(generated, "upstream/include/bblite/upstream/constants.hpp");
        for (const generated of [firstGenerated, secondGenerated]) {
            mkdirSync(join(generated, "upstream/include/bblite/upstream"), {
                recursive: true,
            });
            writeFileSync(
                join(generated, "upstream/include/bblite/value.hpp"),
                "#include <bblite/upstream/constants.hpp>\n",
            );
            writeFileSync(header(generated), "#define FIXTURE_VALUE 2\n");
            writeFileSync(
                join(generated, "upstream/include/bblite/other.hpp"),
                "#define OTHER_VALUE 5\n",
            );
        }
        // Each unit reads its own generated header, so a change to one is on
        // neither the other's compile line nor its dependencies.
        writeFileSync(
            join(source, "src/main.cpp"),
            '#include <bblite/value.hpp>\n#include <cstdio>\nint other();\nint main() { std::printf("%d%d", FIXTURE_VALUE, other()); }\n',
        );
        writeFileSync(
            join(source, "src/other.cpp"),
            "#include <bblite/other.hpp>\nint other() { return OTHER_VALUE; }\n",
        );
        const log = join(root, "cache.log");
        writeFileSync(log, "");
        const env = { ...windows.environment, CCACHE_LOGFILE: log };
        const run = (args: string[]): string =>
            execFileSync(tools.cmake!, args, {
                env,
                encoding: "utf8",
                stdio: "pipe",
            });
        const configure = (
            build: string,
            generated: string,
            extra: string[] = [],
        ): string =>
            run([
                ...extra,
                "-S",
                source,
                "-B",
                build,
                "-G",
                "Ninja",
                `-DCMAKE_MAKE_PROGRAM=${windows.ninja}`,
                `-DCMAKE_CXX_COMPILER=${windows.compiler}`,
                `-DBBLITE_GENERATED_DIR=${generated}`,
                `-DBBLITE_CCACHE=${tools.ccache}`,
                `-DBBLITE_NATIVE_CACHE_DIR=${join(root, "cache")}`,
                "-DCMAKE_BUILD_TYPE=Release",
            ]);
        const first = join(root, "first"),
            second = join(root, "second");
        configure(first, firstGenerated);
        run(["--build", first]);
        writeFileSync(log, "");
        configure(second, secondGenerated);
        run(["--build", second]);
        const executable = join(second, "check.exe");
        assert.equal(execFileSync(executable, { encoding: "utf8" }), "25");
        assert.ok(
            /Result: (?:direct|preprocessed)_cache_hit/.test(
                readFileSync(log, "utf8"),
            ),
            "the second build must reuse a cached object",
        );
        writeFileSync(header(secondGenerated), "#define FIXTURE_VALUE 7\n");
        const rebuilt = run(["--build", second]);
        assert.equal(execFileSync(executable, { encoding: "utf8" }), "75");
        assert.match(rebuilt, /main\.cpp\.obj/);
        assert.doesNotMatch(rebuilt, /other\.cpp\.obj/);

        // A scene-invariant target admits only activation macros.
        assert.throws(
            () =>
                configure(join(root, "invariant"), firstGenerated, [
                    "-DFIXTURE_SCENE_INVARIANT=ON",
                ]),
            /reads\s+only\s+bblite\/features\/\s+macros/,
        );

        // Two checkouts of the same sources (worktrees), each building inside
        // its own native/ tree, share the cache: paths under a checkout enter
        // the key relative to it.
        const checkoutBuild = (
            name: string,
        ): { build: string; log: string } => {
            const native = join(root, name, "native");
            mkdirSync(join(native, "src"), { recursive: true });
            writeFileSync(
                join(native, "CMakeLists.txt"),
                readFileSync(join(source, "CMakeLists.txt"), "utf8").replace(
                    source.replaceAll("\\", "/"),
                    native.replaceAll("\\", "/"),
                ),
            );
            for (const unit of ["main.cpp", "other.cpp"])
                writeFileSync(
                    join(native, "src", unit),
                    readFileSync(join(source, "src", unit), "utf8"),
                );
            writeFileSync(log, "");
            const build = join(native, "build");
            run([
                "-S",
                native,
                "-B",
                build,
                "-G",
                "Ninja",
                `-DCMAKE_MAKE_PROGRAM=${windows.ninja}`,
                `-DCMAKE_CXX_COMPILER=${windows.compiler}`,
                `-DBBLITE_GENERATED_DIR=${firstGenerated}`,
                `-DBBLITE_CCACHE=${tools.ccache}`,
                `-DBBLITE_NATIVE_CACHE_DIR=${join(root, "cache")}`,
                "-DCMAKE_BUILD_TYPE=Release",
            ]);
            run(["--build", build]);
            return { build, log: readFileSync(log, "utf8") };
        };
        checkoutBuild("checkout-a");
        const worktree = checkoutBuild("checkout-b");
        assert.equal(
            execFileSync(join(worktree.build, "check.exe"), {
                encoding: "utf8",
            }),
            "25",
        );
        assert.ok(
            /Result: (?:direct|preprocessed)_cache_hit/.test(worktree.log),
            "another checkout of the same sources must reuse the cached object",
        );
    });
}
