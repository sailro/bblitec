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

test("error property writes refuse without mutable error storage", () => {
    assert.throws(
        () =>
            compileSource(
                'const error = new Error("before"); error.message = "after";',
            ),
        /Mutation of represented Error properties/,
    );
});

test("cleanup error arrays retain conditional pushes, order, identity and causes", (t) => {
    const result = compileSource(`
        function run(): void {
        const flags:boolean[] = [false, true, true];
        const errors:unknown[] = [];
        const first = new RangeError("first");
        const second = new TypeError("second");
        let attempts = 0;
        for (const fail of flags) {
            try {
                attempts++;
                if (fail) {
                    if (attempts === 2) throw first;
                    throw second;
                }
            } catch (error) { errors.push(error); }
        }
        if (attempts !== 3 || errors.length !== 2 || errors[0] !== first || errors[1] !== second)
            throw new Error("cleanup error ownership");
        if (!(errors[0] instanceof RangeError) || errors[1] instanceof RangeError || !(errors[1] instanceof Error))
            throw new Error("error constructor identity");
        const wrapped = new Error("wrapped", {cause:first});
        throw new AggregateError(errors, "cleanup", {cause:wrapped});
        }
        run();
    `);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/error-values");
    mkdirSync(directory, { recursive: true });
    const cpp = join(directory, "check.cpp"),
        exe = join(directory, "check.exe");
    writeFileSync(
        cpp,
        `#define main generated_main\n${result.cpp}\n#undef main
        #include <cassert>
        int main() {
            const bbl::js::CollectOnExit collect_on_exit;
            try { bblscene::run(); return 1; }
            catch (const bbl::js::AggregateError& error) {
                assert(std::string(error.what()) == "cleanup");
                assert(error.errors.size() == 2);
                assert(bbl::js::error_message(error.errors[0]) == "first");
                assert(bbl::js::error_name(error.errors[1]) == "TypeError");
                try { std::rethrow_exception(error.cause); }
                catch (const bbl::js::NamedError& wrapped) {
                    assert(std::string(wrapped.what()) == "wrapped");
                    assert(bbl::js::Error(wrapped.cause) == bbl::js::Error(error.errors[0]));
                }
            }
            catch (const std::exception& error) { std::cerr << error.what(); return 2; }
        }
    `,
    );
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        "/I",
        "native/include",
        `/Fo:${directory}/`,
        `/Fe:${exe}`,
        cpp,
    ]);
    assert.equal(execFileSync(exe, { encoding: "utf8", timeout: 10000 }), "");
});
