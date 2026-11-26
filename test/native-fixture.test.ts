import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import type { WindowsBuildTools } from "../src/development-tools.js";
import {
    nativeFixtureArguments,
    nativeFixtureVcpkgRoot,
    nativePosixFixtureOptions,
    optionalNativeFixtureTools,
    runGeneratedProgram,
    writeFixtureHeaders,
} from "./native-fixture.js";

const msvc = { compiler: "cl.exe" } as WindowsBuildTools;
const clang = { compiler: "clang-cl.exe" } as WindowsBuildTools;

/** Runs `body` with the fixture cache off, so that every program compiles. */
function compiling(body: () => void): void {
    const cache = process.env.BBLITE_FIXTURE_CACHE;
    process.env.BBLITE_FIXTURE_CACHE = "0";
    try {
        body();
    } finally {
        if (cache === undefined) delete process.env.BBLITE_FIXTURE_CACHE;
        else process.env.BBLITE_FIXTURE_CACHE = cache;
    }
}

// Clang refuses a precompiled header whose header moved since.
test("a generated program's precompiled preamble follows the headers it includes", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    const name = "native-fixture/preamble-headers";
    compiling(() => {
        for (const value of [1, 22]) {
            const directory = writeFixtureHeaders(name, {
                "preamble_probe.hpp": `#pragma once\ninline int probe() { return ${value}; }\n`,
            });
            runGeneratedProgram(
                tools,
                `${name}/${value}`,
                `// A probe.\n#include <preamble_probe.hpp>\n\nint main() { return probe() == ${value} ? 0 : 1; }\n`,
                { flags: [`/I${directory}`] },
            );
        }
    });
});

// The unit's include notes do not name what the precompiled header read.
test("a stored generated program is restored only while its precompiled preamble's headers keep their bytes", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    const name = "native-fixture/preamble-cache";
    const cpp =
        "// A probe.\n#include <cached_probe.hpp>\n\nint main() { return probe() == 7 ? 0 : 1; }\n";
    for (const value of [7, 8, 7]) {
        const directory = writeFixtureHeaders(name, {
            "cached_probe.hpp": `#pragma once\ninline int probe() { return ${value}; }\n`,
        });
        const run = () =>
            runGeneratedProgram(tools, `${name}/program`, cpp, {
                flags: [`/I${directory}`],
            });
        if (value === 7) run();
        else assert.throws(run, /check\.exe failed: exit 1/);
    }
});

// A class the preamble throws keeps its copy constructor (exceptionRecord);
// the program's own class compiles beside it.
test("exceptions a generated program copies through its precompiled preamble keep their copy semantics", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    const name = "native-fixture/preamble-exceptions";
    const directory = writeFixtureHeaders(name, {
        "thrown_probe.hpp": `#pragma once
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
`,
    });
    compiling(() =>
        runGeneratedProgram(
            tools,
            `${name}/program`,
            `// A probe.
#include <thrown_probe.hpp>

namespace probe {
struct Own {
    std::shared_ptr<Payload> payload;
};
}  // namespace probe

int main() {
    const auto payload = std::make_shared<Payload>();
    for (int round = 0; round < 3; ++round) {
        const std::exception_ptr error = captured(payload);
        try {
            std::rethrow_exception(error);
        } catch (const Thrown& thrown) {
            if (thrown.payload != payload) return 2;
        }
        try {
            throw probe::Own{payload};
        } catch (...) {
            const std::exception_ptr own = std::current_exception();
        }
    }
    return payload.use_count() == 1 ? 0 : 3;
}
`,
            { flags: [`/I${directory}`] },
        ),
    );
});

test("POSIX fixtures read the product's standard and warning options", () => {
    assert.deepEqual(nativePosixFixtureOptions(), [
        "-std=c++20",
        "-Wall",
        "-Wextra",
        "-Wpedantic",
        "-Werror",
        "-Wundef",
    ]);
});

test("a fixture compile gets the product's options from CMake and its folders before the product's", () => {
    const fixtureFolder = resolve("artifacts/check/include");
    const compile = nativeFixtureArguments(msvc, [
        "/O2",
        "/I",
        fixtureFolder,
        "/Fe:artifacts/check/check.exe",
        "artifacts/check/check.cpp",
        "/link",
        "/OPT:NOREF",
    ]);
    for (const option of [
        "/std:c++20",
        "/W4",
        "/WX",
        "/permissive-",
        "/EHsc",
        "/bigobj",
        "/MD",
        "/we4668",
        "/external:env:INCLUDE",
        "/external:W0",
        "/utf-8",
    ])
        assert.ok(compile.includes(option), option);
    const own = compile.indexOf(fixtureFolder);
    const product = compile.indexOf(`/I${resolve("native/include")}`);
    const dependencies = compile.indexOf(
        `/external:I${join(nativeFixtureVcpkgRoot, "include")}`,
    );
    assert.ok(own >= 0 && own < product && product < dependencies);
    assert.deepEqual(compile.slice(dependencies + 1), ["/link", "/OPT:NOREF"]);

    const clangCompile = nativeFixtureArguments(clang, [
        "artifacts/check/check.cxx",
    ]);
    assert.ok(clangCompile.includes("-Werror=undef"));
    assert.ok(!clangCompile.includes("/we4668"));
    assert.ok(!clangCompile.includes("/utf-8"));
});

test("a link-only command passes through", () => {
    const link = ["artifacts/check/a.obj", "/Fe:artifacts/check/check.exe"];
    assert.deepEqual(nativeFixtureArguments(msvc, link), link);
});

test("a fixture cannot restate or override what the harness owns", () => {
    for (const argument of [
        ["/W3"],
        ["/wd4668"],
        ["/WX-"],
        ["/std:c++17"],
        ["/MT"],
        ["/EHa"],
        ["/Zc:twoPhase-"],
        ["/fp:fast"],
        ["/utf-8"],
        ["/external:W4"],
        ["/clang:-Wno-undef"],
        ["/I", "native/include"],
        [`/external:I${join(nativeFixtureVcpkgRoot, "include")}`],
    ])
        assert.throws(
            () =>
                nativeFixtureArguments(msvc, [
                    ...argument,
                    "artifacts/check/check.cpp",
                ]),
            /The fixture harness owns/,
            argument.join(" "),
        );
});
