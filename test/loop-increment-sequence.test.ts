import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const source = `
    let steps = 0;
    let order = 0;
    let sum = 0;
    for (let lo = 0, hi = 5; lo < hi; lo++, hi--, steps++) {
        if (lo === 0) continue;
        sum += lo * 10 + hi;
    }
    if (steps !== 3 || sum !== 37) throw new Error("continue or paired index order");
    let index = 0;
    for (; index < 4; index++, order = order * 10 + index) {
        if (index === 2) break;
    }
    if (index !== 2 || order !== 12) throw new Error("break or left-to-right order");
    let before = 0;
    let after = 0;
    try {
        for (let i = 0; i < 4; before++, i++, after++) {
            if (i === 1) throw new Error("leave");
        }
    } catch (_error) {}
    if (before !== 1 || after !== 1) throw new Error("throw must bypass incrementor");
    let touched = 0;
    function stop(): never { throw new Error("stop"); }
    try { (stop(), touched++); } catch (_error) {}
    if (touched !== 0) throw new Error("comma must stop at an abrupt left operand");
`;

test("for increment sequences remain in the header and preserve ordinary iteration", () => {
    const result = compileSource(source);
    assert.match(result.cpp, /for \(;[^\n]+, [^\n]+\)/);
});

const native = optionalNativeFixtureTools();
test(
    "native increment sequences preserve continue, break, throw and evaluation order",
    { skip: !native },
    () => {
        runGeneratedProgram(
            native!,
            "loop-increment-sequence",
            compileSource(source).cpp,
            { timeoutMs: 5000 },
        );
    },
);
