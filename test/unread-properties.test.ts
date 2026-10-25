import assert from "node:assert/strict";
import test from "node:test";
import { createCompilerProgram } from "../src/compiler/program.js";
import { propertyNeverObserved } from "../src/compiler/unread-properties.js";

const observed = (source: string, name: string): boolean => {
    const { program, checker } = createCompilerProgram(
        source,
        "unread-properties.ts",
    );
    return !propertyNeverObserved(program, checker, name);
};

test("a destructuring observes the keys it names, declared or assigned", () => {
    const record = "const obj = { secret: 1, other: 2 };";
    assert.ok(!observed(`${record} console.log(obj.other);`, "secret"));
    assert.ok(observed(`${record} const { secret } = obj;`, "secret"));
    assert.ok(
        observed(`${record} let s = 0; ({ secret: s } = obj);`, "secret"),
    );
    assert.ok(
        observed(`${record} let s = 0; [{ secret: s }] = [obj];`, "secret"),
    );
    assert.ok(
        observed(
            `${record} let s = 0; for ({ secret: s } of [obj]);`,
            "secret",
        ),
    );
    // A rest takes every key the pattern does not name.
    assert.ok(observed(`${record} let r = {}; ({ ...r } = obj);`, "secret"));
});
