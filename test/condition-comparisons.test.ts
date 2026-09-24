/**
 * A condition's comparison is spelled and folded by the shared operator
 * layer. A loose equality between operands of one primitive type is the
 * strict one; across types it coerces, and the condition refuses it.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const looseEqualities = `
    let n = 0;
    if (Math.random() > 2) n = 1;
    let hits = 0;
    if (n == 0) hits += 1;
    if (n != 1) hits += 1;
    let s = "a";
    if (Math.random() > 2) s = "b";
    if (s == "a") hits += 1;
    let b = false;
    if (Math.random() > 2) b = true;
    if (b != true) hits += 1;
    const two = 2;
    if (two == 2) hits += 1;
    if (hits !== 5) throw new Error("loose equality");
`;

test("a loose equality between one primitive type lowers as the strict one", () => {
    const { cpp } = compileSource(looseEqualities, { fileName: "loose.ts" });
    assert.match(cpp, /if \(v_n == 0\.0\)/);
    assert.match(cpp, /if \(v_n != 1\.0\)/);
    assert.match(cpp, /if \(std::string\(v_s\) == std::string\("a"\)\)/);
    assert.match(cpp, /if \(v_b != true\)/);
    // Two settled numbers fold through the shared numeric fold.
    assert.doesNotMatch(cpp, /v_two == 2\.0/);
});

test("a loose equality across types refuses", () => {
    assert.throws(
        () =>
            compileSource(
                `
                let s = "1";
                if (Math.random() > 2) s = "b";
                const n: unknown = 1;
                if (s == n) console.log("coerced");
                `,
                { fileName: "coercing.ts" },
            ),
        /Loose equality between operands of different types coerces them/,
    );
});

const tools = optionalNativeFixtureTools(false);
test(
    "a loose equality between one primitive type runs as JavaScript does",
    { skip: !tools },
    () => {
        const { cpp } = compileSource(looseEqualities, {
            fileName: "loose.ts",
        });
        const output = resolve("artifacts/condition-comparisons");
        mkdirSync(output, { recursive: true });
        const source = join(output, "check.cpp");
        const executable = join(output, "check.exe");
        writeFileSync(source, cpp);
        runNativeFixtureCompiler(tools!, [
            "/nologo",
            "/std:c++20",
            "/W4",
            "/WX",
            "/permissive-",
            "/EHsc",
            `/Fo:${output}\\`,
            `/Fe:${executable}`,
            "/I",
            "native/include",
            source,
        ]);
        execFileSync(executable, { stdio: "pipe" });
    },
);
