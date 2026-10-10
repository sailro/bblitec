import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import type { WindowsBuildTools } from "../src/development-tools.js";
import {
    nativeFixtureArguments,
    nativeFixtureVcpkgRoot,
} from "./native-fixture.js";

const msvc = { compiler: "cl.exe" } as WindowsBuildTools;
const clang = { compiler: "clang-cl.exe" } as WindowsBuildTools;

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
