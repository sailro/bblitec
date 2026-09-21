import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { getFileInfo } from "prettier";
import {
    nativeCompilationFiles,
    nativeFormatFiles,
} from "../src/code-quality.js";
import { createJavaScriptFunction } from "../src/typescript-transpile.js";
import {
    jsonArray,
    jsonNumbers,
    jsonObject,
    jsonRecords,
    jsonString,
} from "./json.js";
import { cppFunction } from "./native-fixture.js";

test("native fixture extraction preserves formatted function bodies", () => {
    const source =
        "inline void\nwrite_values(int count,\n             int step) {\n    for (int i = 0; i < count; ++i) { use(i * step); }\n}\nvoid other() {}";
    assert.equal(
        cppFunction(source, "inline void write_values("),
        source.slice(0, source.indexOf("\nvoid other")),
    );
    assert.throws(() => cppFunction(source, "inline void missing("));
    const compact =
        "inline void write_values(int count, int step) { use(count + step); }";
    assert.equal(
        cppFunction(
            compact,
            "inline void write_values(\n    int count,\n    int step",
        ),
        compact,
    );
    const declared = `inline void write_values(int, int);\nvoid unrelated() {}\n${compact}`;
    assert.equal(cppFunction(declared, "inline void write_values("), compact);
});

test("JavaScript lint and formatting scopes protect source evidence and generated output", async () => {
    const eslint = new ESLint();
    for (const path of [
        "corpus/scene.ts",
        "examples/scene.ts",
        "generated/scene/main.js",
        "artifacts/capture.js",
        "reference/state.json",
        "upstream/babylon-lite.json",
        "test/fixtures/query-step-math.ts",
        "native/src/pal.cpp",
    ]) {
        assert.equal(await eslint.isPathIgnored(path), true, path);
        assert.equal(
            (await getFileInfo(path, { ignorePath: ".prettierignore" }))
                .ignored,
            true,
            path,
        );
    }
    for (const path of [
        "src/compiler.ts",
        "test/code-quality.test.ts",
        "tools/build-if-stale.mjs",
    ]) {
        assert.equal(await eslint.isPathIgnored(path), false, path);
        assert.equal(
            (await getFileInfo(path, { ignorePath: ".prettierignore" }))
                .ignored,
            false,
            path,
        );
    }
    for (const [filePath, text] of [
        ["tools/quality-runtime-probe.mjs", "window.location.reload();"],
        ["checks/plugins/quality-runtime-probe.init.js", "process.exit(1);"],
    ] as const) {
        const [result] = await eslint.lintText(text, { filePath });
        assert.ok(
            result?.messages.some((message) => message.ruleId === "no-undef"),
            filePath,
        );
    }
});

test("dynamic execution preserves arguments, return values, receiver and syntax errors", () => {
    const execute = createJavaScriptFunction(
        "value",
        "return this.factor * value;",
    );
    assert.equal(execute.call({ factor: 3 }, 7), 21);
    assert.throws(() => createJavaScriptFunction("return ("), SyntaxError);
});

test("JSON fixture readers reject invalid shapes instead of coercing or dropping values", () => {
    assert.deepEqual(jsonObject({ value: 1 }), { value: 1 });
    assert.deepEqual(jsonArray([null, 1]), [null, 1]);
    assert.deepEqual(jsonRecords([{ value: 1 }]), [{ value: 1 }]);
    assert.deepEqual(jsonNumbers([0, -0, 1]), [0, -0, 1]);
    const numbers = [1, 2, 3];
    assert.equal(jsonNumbers(numbers), numbers);
    assert.equal(jsonString(""), "");
    assert.throws(() => jsonObject([]), /JSON object/);
    assert.throws(() => jsonArray({}), /JSON array/);
    assert.throws(() => jsonRecords([{}, null]), /JSON object/);
    assert.throws(() => jsonNumbers([1, "2"]), /numeric JSON array/);
    assert.throws(() => jsonString(1), /JSON string/);
});

test("native quality commands keep their flag grammars separate", () => {
    const command = fileURLToPath(
        new URL("../src/code-quality.js", import.meta.url),
    );
    for (const mode of ["format", "lint"]) {
        const result = spawnSync(process.execPath, [command, mode, "--help"], {
            encoding: "utf8",
            windowsHide: true,
        });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, new RegExp(`^code-quality ${mode} `));
    }
    for (const args of [
        ["format", "--generated"],
        ["lint", "--write"],
    ]) {
        const result = spawnSync(process.execPath, [command, ...args], {
            encoding: "utf8",
            windowsHide: true,
        });
        assert.ifError(result.error);
        assert.equal(result.status, 1);
        assert.match(
            result.stderr,
            /^Unknown code-quality (?:format|lint) argument /,
        );
    }
});

test("native formatting owns only maintained sources and C++ test fixtures", () => {
    assert.deepEqual(
        nativeFormatFiles([
            "native/src/pal.cpp",
            "native/include/bblite/pal.hpp",
            "native/src/pal_file_ios.mm",
            "test/fixtures/ui-color-font/check.cpp",
            "native/src/pal.cpp",
            "native/build-scene1-release/CMakeFiles/cmake_pch.hxx.cxx",
            "native/vcpkg-overlay-ports/freetype/ftmodule.h",
            "corpus/babylon-lite/main.cpp",
            "generated/scene1/main.cpp",
            "examples/scene1.ts",
            "test/fixtures/query-step-math.ts",
            "native/patches/sdl.patch",
        ]),
        [
            "native/include/bblite/pal.hpp",
            "native/src/pal.cpp",
            "native/src/pal_file_ios.mm",
            "test/fixtures/ui-color-font/check.cpp",
        ],
    );
});

test("native lint selects owned translation units from the actual compilation database", () => {
    const root = resolve("artifacts", "quality-test");
    const build = resolve(root, "native", "build-test");
    const pal = resolve(root, "native", "src", "pal.cpp");
    const database = [
        { directory: build, file: pal, command: "clang++ -c pal.cpp" },
        {
            directory: build,
            file: "../src/pal.cpp",
            arguments: ["clang++", "-c", pal],
        },
        {
            directory: build,
            file: "../../generated/scene1/main.cpp",
            command: "clang++ -c main.cpp",
        },
        {
            directory: build,
            file: "../../generated/scene1/upstream/src/engine.cpp",
            command: "clang++ -c engine.cpp",
        },
        {
            directory: build,
            file: "../../generated/scene1-other/main.cpp",
            command: "clang++ -c main.cpp",
        },
        {
            directory: build,
            file: "../../artifacts/vendor/third-party.cpp",
            command: "clang++ -c third-party.cpp",
        },
        {
            directory: build,
            file: "CMakeFiles/cmake_pch.hxx.cxx",
            command: "clang++ -c cmake_pch.hxx.cxx",
        },
    ];
    assert.deepEqual(
        nativeCompilationFiles(database, build, root, [
            "native/src/pal.cpp",
            "native/src/not-reached.cpp",
            "native/include/bblite/pal.hpp",
        ]),
        [pal],
    );
    assert.deepEqual(
        nativeCompilationFiles(
            database,
            build,
            root,
            ["native/src/pal.cpp"],
            resolve(root, "generated", "scene1"),
        ),
        [
            resolve(root, "generated", "scene1", "main.cpp"),
            resolve(
                root,
                "generated",
                "scene1",
                "upstream",
                "src",
                "engine.cpp",
            ),
            pal,
        ].sort(),
    );
});

test("native lint refuses malformed compilation databases rather than skipping entries", () => {
    const root = process.cwd();
    for (const database of [
        null,
        {},
        [null],
        [{ file: "pal.cpp" }],
        [{ file: "pal.cpp", directory: root, arguments: ["clang++", 7] }],
        [{ file: "", directory: root, command: "clang++" }],
    ]) {
        assert.throws(
            () =>
                nativeCompilationFiles(database, root, root, [
                    "native/src/pal.cpp",
                ]),
            /compilation database entry|must contain an array/,
        );
    }
});
