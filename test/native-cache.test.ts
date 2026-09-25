import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
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

test("clangcl shares the precompiled header and lowered modules between the build trees of a checkout", (t) => {
    const tools = discoverDevelopmentTools();
    if (process.platform !== "win32" || !tools.cmake || !tools.ccache) {
        t.skip("Windows, CMake and ccache are required.");
        return;
    }
    const windows = discoverWindowsBuildTools("clangcl");
    const artifacts = resolve("artifacts/test-native-cache");
    mkdirSync(artifacts, { recursive: true });
    const root = mkdtempSync(join(artifacts, "shared-pch-"));
    const repository = resolve("native").replaceAll("\\", "/");
    const log = join(root, "cache.log");
    const env = { ...windows.environment, CCACHE_LOGFILE: log };
    const run = (args: string[]): string =>
        execFileSync(tools.cmake!, args, {
            env,
            encoding: "utf8",
            stdio: "pipe",
        });
    const checkout = (name: string): string => {
        const native = join(root, name, "native");
        mkdirSync(join(native, "src"), { recursive: true });
        mkdirSync(join(native, "include/bblite"), { recursive: true });
        writeFileSync(
            join(native, "CMakeLists.txt"),
            `cmake_minimum_required(VERSION 3.24)
project(pch_fixture LANGUAGES CXX)
set(BBLITE_NATIVE_ROOT "${native.replaceAll("\\", "/")}")
include("${repository}/compiler-cache.cmake")
include("${repository}/native-header-cache.cmake")
add_library(bblite_features INTERFACE)
add_library(bblite_core INTERFACE)
target_link_libraries(bblite_features INTERFACE bblite_core)
target_compile_features(bblite_core INTERFACE cxx_std_20)
target_include_directories(bblite_core INTERFACE "\${BBLITE_NATIVE_ROOT}/include")
target_compile_options(bblite_core INTERFACE "SHELL:-Xclang -fno-pch-timestamp")
bblite_content_addressed_sources(modules "\${BBLITE_GENERATED_DIR}/upstream/src/module.cpp")
add_executable(check src/main.cpp \${modules})
target_link_libraries(check PRIVATE bblite_features)
bblite_cache_unit_headers(TARGETS check)
bblite_shared_pch(NAME check_pch TARGETS check HEADERS <bblite/shared.hpp> <vector>)
`,
        );
        // Records and the PCH are invariant; only the entry reads activation.
        writeFileSync(
            join(native, "include/bblite/shared.hpp"),
            "#pragma once\n#include <vector>\ninline int shared_value() { return 4; }\n",
        );
        writeFileSync(
            join(native, "src/main.cpp"),
            '#include <bblite/shared.hpp>\n#include <bblite/features/has_value.hpp>\n#include <cstdio>\nint module_value();\nint main() { std::printf("%d%d", HAS_VALUE ? shared_value() : 0, module_value()); }\n',
        );
        return native;
    };
    // Two scene trees generating the same activation macro and module.
    const tree = (native: string, name: string): string => {
        const generated = join(native, "..", "generated", name);
        mkdirSync(join(generated, "upstream/include/bblite/features"), {
            recursive: true,
        });
        mkdirSync(join(generated, "upstream/src"), { recursive: true });
        writeFileSync(
            join(generated, "upstream/include/bblite/features/has_value.hpp"),
            `#pragma once\n#define HAS_VALUE ${name === "disabled" ? 0 : 1}\n`,
        );
        writeFileSync(
            join(generated, "upstream/src/module.cpp"),
            "#include <bblite/shared.hpp>\nint module_value() { return shared_value() + 1; }\n",
        );
        return generated;
    };
    const build = (
        native: string,
        name: string,
    ): { build: string; log: string } => {
        writeFileSync(log, "");
        const directory = join(native, `build-${name}`);
        run([
            "-S",
            native,
            "-B",
            directory,
            "-G",
            "Ninja",
            `-DCMAKE_MAKE_PROGRAM=${windows.ninja}`,
            `-DCMAKE_CXX_COMPILER=${windows.compiler}`,
            `-DBBLITE_GENERATED_DIR=${tree(native, name)}`,
            `-DBBLITE_CCACHE=${tools.ccache}`,
            `-DBBLITE_NATIVE_CACHE_DIR=${join(root, "cache")}`,
            "-DCMAKE_BUILD_TYPE=Release",
        ]);
        run(["--build", directory]);
        assert.equal(
            execFileSync(join(directory, "check.exe"), { encoding: "utf8" }),
            name === "disabled" ? "05" : "45",
        );
        return { build: directory, log: readFileSync(log, "utf8") };
    };
    const compiles = (text: string): string[] =>
        [
            ...text.matchAll(
                /Result: (direct_cache_hit|preprocessed_cache_hit|cache_miss|preprocessor_error)\b/g,
            ),
        ].map((match) => match[1]!);

    const checkoutA = checkout("checkout-a");
    const first = build(checkoutA, "first");
    assert.deepEqual(compiles(first.log), [
        "cache_miss",
        "cache_miss",
        "cache_miss",
    ]);
    // The PCH, a unit using it and the module are each one entry.
    const second = build(checkoutA, "second");
    assert.deepEqual(compiles(second.log), [
        "direct_cache_hit",
        "direct_cache_hit",
        "direct_cache_hit",
    ]);
    const disabled = build(checkoutA, "disabled");
    assert.deepEqual(compiles(disabled.log).sort(), [
        "cache_miss",
        "direct_cache_hit",
        "direct_cache_hit",
    ]);
    // A header the PCH holds changes: the PCH is rebuilt and every unit
    // compiles against it, none from an entry keyed on the old PCH.
    writeFileSync(
        join(checkoutA, "include/bblite/shared.hpp"),
        "#pragma once\n#include <vector>\ninline int shared_value() { return 3; }\n",
    );
    run(["--build", second.build]);
    assert.equal(
        execFileSync(join(second.build, "check.exe"), { encoding: "utf8" }),
        "34",
    );

    // The PCH records the absolute paths it was built from, so another
    // checkout builds its own rather than one naming the first's files.
    const other = build(checkout("checkout-b"), "first");
    assert.ok(compiles(other.log).includes("cache_miss"));
    const pch = readdirSync(join(other.build, "CMakeFiles/check_pch.dir"), {
        recursive: true,
        encoding: "utf8",
    }).find((path) => /bblite_pch-[0-9a-f]{16}\.cxx\.obj$/.test(path));
    assert.ok(pch, "the precompiled header is the PCH target's object");
    const bytes = readFileSync(
        join(other.build, "CMakeFiles/check_pch.dir", pch),
        "latin1",
    );
    assert.ok(bytes.includes("checkout-b"));
    assert.ok(!bytes.includes("checkout-a"));
});
