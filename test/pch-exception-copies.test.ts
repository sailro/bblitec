import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { discoverWindowsBuildTools } from "../src/development-tools.js";
import { runNativeFixtureCompiler } from "./native-fixture.js";

/**
 * Clang on the Microsoft C++ ABI names a thrown class's copy constructor in
 * the class's CatchableType (`_CT??_R0?AV<class>@8??0<copy constructor><size>`,
 * or `_CT??_R0?AV<class>@8<size>` for a bitwise copy). It records that
 * constructor only while Sema checks a `throw` or `__GetExceptionInfo` in the
 * unit itself: a precompiled header does not carry the record, so a unit
 * reading one emits the bitwise form for every class a PCH header throws, and
 * std::current_exception, std::make_exception_ptr and std::rethrow_exception
 * copy those exceptions without their copy constructors (double-freed strings,
 * shared pointers released twice). native/CMakeLists.txt therefore gives that
 * compiler a PCH of C headers only.
 */

const HEADER = `#pragma once
#include <exception>
#include <memory>
struct Payload {
    int value = 1;
};
class Thrown final : public std::exception {
public:
    explicit Thrown(std::shared_ptr<Payload> held) : payload(std::move(held)) {}
    std::shared_ptr<Payload> payload;
};
inline std::exception_ptr captured(const std::shared_ptr<Payload>& payload) {
    try {
        throw Thrown(payload);
    } catch (...) {
        return std::current_exception();
    }
}
`;
const UNIT = `#include <cstdio>
int main() {
    const auto payload = std::make_shared<Payload>();
    const auto error = captured(payload);
    std::printf("%ld", payload.use_count());
    return 0;
}
`;
/** The catchable type of `Thrown` with its copy constructor, and without one. */
const COPIED = "_CT??_R0?AVThrown@@@8??0Thrown@@QEAA@AEBV0@@Z40";
const BITWISE = "_CT??_R0?AVThrown@@@840";

function clangTools():
    ReturnType<typeof discoverWindowsBuildTools> | undefined {
    if (process.platform !== "win32") return undefined;
    try {
        return discoverWindowsBuildTools("clangcl");
    } catch {
        return undefined;
    }
}

/** The CatchableType symbols an object defines. */
function catchableTypes(compiler: string, object: string): string[] {
    const listing = execFileSync(
        join(dirname(compiler), "llvm-nm.exe"),
        [object],
        {
            encoding: "utf8",
        },
    );
    return listing
        .split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/).pop() ?? "")
        .filter((symbol) => symbol.startsWith("_CT??_R0?"));
}

/** As the native cache builds and reads the shared PCH: without a timestamp
 * (a cached PCH outlives its source's rewrite), instantiating its templates. */
const NO_TIMESTAMP = ["-Xclang", "-fno-pch-timestamp"];
const EMIT_PCH = [
    ...NO_TIMESTAMP,
    "-Xclang",
    "-emit-pch",
    "-Xclang",
    "-fpch-instantiate-templates",
];

test("clang-cl records a thrown class's copy constructor only when the unit itself checks the throw", (t) => {
    const tools = clangTools();
    if (!tools) return t.skip("clang-cl is unavailable.");
    const directory = resolve("artifacts/test-pch-exception-copies/minimal");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "thrown.hpp"), HEADER);
    writeFileSync(join(directory, "pch.cxx"), '#include "thrown.hpp"\n');
    writeFileSync(join(directory, "main.cpp"), UNIT);
    const pch = join(directory, "thrown.pch");
    runNativeFixtureCompiler(tools, [
        ...EMIT_PCH,
        "/c",
        join(directory, "pch.cxx"),
        `/Fo${pch}`,
    ]);
    const build = (name: string, include: string[]): string => {
        const object = join(directory, `${name}.obj`);
        runNativeFixtureCompiler(tools, [
            ...include,
            "/c",
            join(directory, "main.cpp"),
            `/Fo${object}`,
        ]);
        return object;
    };
    // Parsed in the unit: the copy constructor is named.
    const text = build("text", [`/FI${join(directory, "thrown.hpp")}`]);
    assert.deepEqual(
        catchableTypes(tools.compiler, text).filter((s) =>
            s.includes("Thrown"),
        ),
        [COPIED],
    );
    // Through the PCH: the bitwise form. If this starts naming the
    // constructor, clang carries the record and the clang-cl PCH may hold
    // C++ headers again (native/CMakeLists.txt).
    const precompiled = build("pch", [
        ...NO_TIMESTAMP,
        "-Xclang",
        "-include-pch",
        "-Xclang",
        pch,
    ]);
    assert.deepEqual(
        catchableTypes(tools.compiler, precompiled).filter((s) =>
            s.includes("Thrown"),
        ),
        [BITWISE],
    );
});

test("the clang-cl precompiled header holds C headers only, and errors keep their copy semantics through it", (t) => {
    const tools = clangTools();
    if (!tools) return t.skip("clang-cl is unavailable.");
    const cmake = readFileSync("native/CMakeLists.txt", "utf8");
    const list =
        /if\(CMAKE_CXX_COMPILER_ID STREQUAL "Clang" AND CMAKE_CXX_SIMULATE_ID STREQUAL "MSVC"\)\s*set\(BBLITE_PCH_HEADERS ([^)]*)\)/.exec(
            cmake,
        );
    assert.ok(
        list,
        "native/CMakeLists.txt spells the clang-cl PCH headers as this test reads them",
    );
    const backendHeaders = [
        ...cmake.matchAll(/list\(APPEND BBLITE_PCH_HEADERS (<[^>]+>)\)/g),
    ].map((match) => match[1]!);
    const headers = [...list[1]!.trim().split(/\s+/), ...backendHeaders];
    // C headers throw nothing: SDL's and WebGPU's.
    for (const header of headers)
        assert.match(
            header,
            /^<(?:SDL3|webgpu)\/[\w.]+\.h>$/,
            `${header} is a C header`,
        );
    const directory = resolve("artifacts/test-pch-exception-copies/product");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        join(directory, "pch.cxx"),
        headers.map((header) => `#include ${header}\n`).join(""),
    );
    writeFileSync(
        join(directory, "main.cpp"),
        `#include <bblite/js_error.hpp>
#include <bblite/js_realm_state.hpp>
#include <cstdio>
#include <memory>
#include <string>

namespace {
struct Payload {
    std::string name = "Payload";
    std::string message = "payload";
};
} // namespace

// The copies the Microsoft ABI makes through a CatchableType: make_exception_ptr,
// current_exception and rethrow_exception, of a typed error object and of a named error.
int main() {
    const bbl::js::RealmScope realm;
    auto payload = std::make_shared<Payload>();
    {
        const bbl::js::Error error = bbl::js::make_object_error(payload, "Error");
        const std::exception_ptr thrown = error;
        for (int round = 0; round < 3; ++round) {
            try {
                std::rethrow_exception(thrown);
            } catch (...) {
                const bbl::js::Error caught = std::current_exception();
                if (bbl::js::error_object<std::shared_ptr<Payload>>(caught) != payload)
                    return 2;
            }
        }
    }
    if (payload.use_count() != 1)
        return 3;
    std::exception_ptr named = bbl::js::make_error("RangeError", std::string(64, 'x'));
    for (int round = 0; round < 3; ++round) {
        try {
            std::rethrow_exception(named);
        } catch (const bbl::js::NamedError& error) {
            if (error.name != "RangeError" || std::string(error.what()) != std::string(64, 'x'))
                return 4;
            named = std::current_exception();
        }
    }
    std::printf("ok");
    return 0;
}
`,
    );
    const pch = join(directory, "product.pch");
    // SDL comes from the harness's dependency headers; WebGPU from the pinned Dawn.
    const external = [`/external:I${resolve("artifacts/tools/dawn/include")}`];
    runNativeFixtureCompiler(tools, [
        ...EMIT_PCH,
        ...external,
        "/c",
        join(directory, "pch.cxx"),
        `/Fo${pch}`,
    ]);
    const object = join(directory, "main.obj");
    const executable = join(directory, "check.exe");
    runNativeFixtureCompiler(tools, [
        ...NO_TIMESTAMP,
        "-Xclang",
        "-include-pch",
        "-Xclang",
        pch,
        ...external,
        "/c",
        join(directory, "main.cpp"),
        `/Fo${object}`,
    ]);
    const types = catchableTypes(tools.compiler, object);
    for (const error of ["NamedError@js@bbl", "ObjectError@js@bbl"])
        assert.ok(
            types.some((symbol) =>
                symbol.startsWith(`_CT??_R0?AV${error}@@@8??0`),
            ),
            `${error}'s catchable type names its copy constructor`,
        );
    runNativeFixtureCompiler(tools, [object, `/Fe${executable}`]);
    assert.equal(execFileSync(executable, { encoding: "utf8" }), "ok");
});
