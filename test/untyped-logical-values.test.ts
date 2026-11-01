import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("auto-typed logical selection evaluates its lowered left once and its right lazily", (t) => {
    const result = compileSource(
        `
        var value = null;
        var leftCalls = 0;
        var rightCalls = 0;
        function left() { leftCalls++; return value; }
        function right() { rightCalls++; return "fallback"; }
        value = String("");
        var first = left() || right();
        var second = left() && right();
        value = String("present");
        var third = left() || right();
        var fourth = left() && right();
        if (first !== "fallback" || second !== "" ||
            third !== "present" || fourth !== "fallback" ||
            leftCalls !== 4 || rightCalls !== 2)
            throw new Error("logical evaluation count or selection");
    `,
        { fileName: "untyped-logical-values.js" },
    );
    assert.equal(result.cpp.match(/\bv_leftCalls\+\+/g)?.length, 4);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(tools, "untyped-logical-values", result.cpp);
});
