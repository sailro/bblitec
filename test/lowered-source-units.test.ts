import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { renderLoweredSourceUnits } from "../src/compiler/lowered-source-units.js";
import { outlineLoweredBody } from "../src/compiler/lowered-body.js";
import {
    buildNativeFixture,
    optionalNativeFixtureTools,
} from "./native-fixture.js";

test("packed lowered modules share private records, globals, statics and default arguments", (t) => {
    const steps = "    state.value += advance();\n".repeat(3400);
    const first = outlineLoweredBody("first", "fixture", [
        "int delta = 0;\n",
        {
            code: `{\n${steps}++delta;\n}`,
            captures: [{ name: "delta", type: "int" }],
        },
        "\nreturn state.read() + delta - 1;",
    ]);
    assert.match(first.body, /first_segment_0\(delta\)/);
    const source = `#include <cstddef>
namespace fixture {
namespace {
template<class T> T identity(T value) { return value; }
struct State { State(); long long value; long long read() const; };
State::State() : value{0} {}
long long State::read() const { return value; }
}
[[maybe_unused]] static State state;
[[maybe_unused]] static int values[] = {1};
[[maybe_unused]] static int advance(int delta = identity((1 < 2) ? 1 : 0)) {
    static int calls = 0;
#if defined(__cplusplus)
    return delta * values[0] + ++calls;
#endif
}
namespace { ${first.definitions} }
long long first() {
${first.body}
}
namespace { long long current() { return state.read(); } }
long long second() {
${steps}
return current();
}
}
`;
    const files = renderLoweredSourceUnits("upstream/src/fixture.cpp", source);
    assert.ok(
        [...files.keys()].filter((path) => path.endsWith(".cpp")).length >= 2,
    );
    assert.deepEqual(
        [...renderLoweredSourceUnits("upstream/src/fixture.cpp", source)],
        [...files],
    );
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("A native compiler is required.");
        return;
    }
    const directory = resolve("artifacts/test-lowered-source-units");
    for (const [path, text] of files) {
        const full = resolve(directory, path);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, text);
    }
    const main = resolve(directory, "main.cpp");
    writeFileSync(
        main,
        `#include <cassert>
namespace fixture { long long first(); long long second(); }
int main() { assert(fixture::first() == 5785100); assert(fixture::second() == 23130200); }
`,
    );
    const executable = resolve(directory, "check.exe");
    buildNativeFixture(
        tools,
        [...files.keys()]
            .filter((path) => path.endsWith(".cpp"))
            .map((path) => resolve(directory, path))
            .concat(main),
        executable,
        [
            "/nologo",
            "/std:c++20",
            "/EHsc",
            "/W4",
            "/WX",
            `/I${resolve(directory, "upstream/include")}`,
        ],
    );
    execFileSync(executable, { timeout: 10000 });
});

test("small lowered modules retain their original unit and bytes", () => {
    const path = "upstream/src/small.cpp",
        source = "namespace bbl { int value() { return 4; } }";
    assert.deepEqual(
        [...renderLoweredSourceUnits(path, source)],
        [[path, source]],
    );
});

test("conditional namespace declarations retain their original module", () => {
    const path = "upstream/src/conditional.cpp";
    const source = `namespace fixture {
#if defined(__cplusplus)
void work() { ${"call();".repeat(13000)} }
#endif
}`;
    assert.deepEqual(
        [...renderLoweredSourceUnits(path, source)],
        [[path, source]],
    );
});
