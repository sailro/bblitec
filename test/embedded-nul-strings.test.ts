/**
 * A JavaScript string may hold U+0000. Native string sinks read a bare C++
 * literal through `const char*`, which stops at the first NUL, so such a
 * string is spelled as a `std::string` sized by its literal.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { stringLiteral } from "../src/cpp-literals.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("a string holding NUL is spelled with its full length", () => {
    assert.equal(stringLiteral("ab"), '"ab"');
    assert.equal(
        stringLiteral("a\u0000b"),
        'std::string("a\\000b", sizeof("a\\000b") - 1)',
    );
    // An escaped backslash before `u0000` text is not a NUL.
    assert.equal(stringLiteral("\\u0000"), '"\\\\u0000"');
    // A digit after the NUL stays its own character.
    assert.equal(
        stringLiteral("\u00001"),
        'std::string("\\0001", sizeof("\\0001") - 1)',
    );
});

test("every native string sink receives the whole string", () => {
    const result = compileSource(
        `
        const tag = "a\\u0000b";
        let joined = "x";
        joined += tag;
        const parts: string[] = [tag, "c\\u0000d"];
        console.log(joined, parts.join("|"));
        `,
        { fileName: "embedded-nul.ts" },
    );
    assert.doesNotMatch(result.cpp, /"a\\u0000b"/);
    assert.match(
        result.cpp,
        /std::string\("a\\000b", sizeof\("a\\000b"\) - 1\)/,
    );
});

const tools = optionalNativeFixtureTools(false);
test(
    "the native spelling keeps the bytes after a NUL",
    { skip: !tools },
    () => {
        const output = resolve("artifacts/embedded-nul-check");
        mkdirSync(output, { recursive: true });
        const tag = stringLiteral("a\u0000b");
        const statements = [
            `std::string tag = ${tag};`,
            `assert(tag.size() == 3 && tag[1] == '\\0' && tag[2] == 'b');`,
            `assert(bbl::js::string_length(tag) == 3.0);`,
            `std::string joined = ${stringLiteral("x")};`,
            `bbl::js::concat_append(joined, ${tag});`,
            `assert(joined.size() == 4 && joined[3] == 'b');`,
            `bbl::js::Array<std::string> parts{${tag}, ${stringLiteral("c\u0000d")}};`,
            `assert(bbl::js::array_join(parts, ${stringLiteral("|")}).size() == 7);`,
        ].join("\n");
        const source = join(output, "check.cpp");
        const executable = join(output, "check.exe");
        writeFileSync(
            source,
            `#include <bblite/js_data.hpp>\n#include <cassert>\nint main() {\n${statements}\n}\n`,
        );
        runNativeFixtureCompiler(tools!, [
            "/nologo",
            "/std:c++20",
            "/W4",
            "/WX",
            "/EHsc",
            `/Fo:${output}\\`,
            `/Fe:${executable}`,
            "/I",
            "native/include",
            source,
        ]);
        execFileSync(executable, { env: tools!.environment });
    },
);
