// The translator's own cases, in the shape `pinned-ubo-writer-lowerer.test.ts`
// uses: a pinned body in, C++ out, and a refusal for everything the
// translator does not recognise.
//
// Two of these pin semantics that a plain operator mapping gets WRONG, and
// both were wrong here once:
//
//   * JavaScript's `a || b` selects a VALUE; C++'s is boolean. Emitting the
//     C++ operator turned the splat loader's `Math.hypot(...) || 1` into the
//     constant 1 and stopped normalising the quaternion.
//   * A `Float32Array` store ROUNDS. `sortSplatsBackToFront` depends on it by
//     name, tracking its min/max from the value round-tripped through
//     `depths` rather than from the f64 it computed.
import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import {
    PinnedNumericLowerer,
    type PinnedBinding,
} from "../src/lowering/pinned-numeric-lowerer.js";

function lower(
    source: string,
    bindings: Iterable<[string, PinnedBinding]> = [],
    extra: Partial<{
        calls: ReadonlyMap<string, (args: readonly string[]) => string>;
    }> = {},
): string {
    const file = ts.createSourceFile(
        "pinned.ts",
        source,
        ts.ScriptTarget.Latest,
        true,
    );
    const lowerer = new PinnedNumericLowerer(file, {
        bindings: new Map(bindings),
        calls: extra.calls ?? new Map(),
    });
    return file.statements
        .flatMap((statement) => lowerer.statement(statement, ""))
        .join("\n");
}

test("lowers a JavaScript numeric or-else to the value-selecting helper", () => {
    const emitted = lower("const length = value || 1;", [
        ["value", { cpp: "value", type: "scalar" }],
    ]);
    // Not `(value || 1.0)`: that is a bool in C++, so every non-zero input
    // would collapse to 1.
    assert.match(emitted, /bbl::js::or_number\(value, 1\.0\)/);
    assert.doesNotMatch(emitted, /value \|\| /);
});

test("rounds a store to the width of the array it stores into", () => {
    const emitted = lower("depths[0] = a * b;", [
        ["depths", { cpp: "depths", type: "f32" }],
        ["a", { cpp: "a", type: "scalar" }],
        ["b", { cpp: "b", type: "scalar" }],
    ]);
    assert.match(emitted, /static_cast<float>/);
});

test("reads a stored value back as the double a JavaScript number is", () => {
    const emitted = lower("const seen = depths[0];", [
        ["depths", { cpp: "depths", type: "f32" }],
    ]);
    assert.match(emitted, /const double seen = static_cast<double>\(/);
});

test("keeps every numeric local at f64, so an intermediate does not narrow", () => {
    const emitted = lower("const half = value / 2;", [
        ["value", { cpp: "value", type: "scalar" }],
    ]);
    assert.match(emitted, /const double half/);
});

test("lowers a boolean local as a bool rather than a number", () => {
    const emitted = lower("let dirty = false;");
    assert.match(emitted, /bool dirty = false;/);
});

test("copies a scalar named by another local instead of aliasing it", () => {
    // `let rz = fx; rz /= rlen;` -- the light-matrix shape. Aliasing rz to
    // fx would leak the mutation into fx; only a BUFFER binding aliases.
    const emitted = lower("let rz = fx;\nrz /= rlen;", [
        ["fx", { cpp: "fx", type: "scalar" }],
        ["rlen", { cpp: "rlen", type: "scalar" }],
    ]);
    assert.match(emitted, /double rz = fx;/);
    assert.match(emitted, /rz \/= rlen;/);
    assert.doesNotMatch(emitted, /fx \/=/);
});

test("still aliases a buffer bound under the initializer's own text", () => {
    const emitted = lower("const depths = scratch[0];\ndepths[0] = 1;", [
        ["scratch[0]", { cpp: "scratch.depths", type: "f32" }],
    ]);
    assert.doesNotMatch(emitted, /double depths/);
    assert.match(
        emitted,
        /scratch\.depths\[static_cast<std::size_t>\(0\.0\)\] = /,
    );
});

test("lowers exponentiation to the pow the Math table already maps", () => {
    // `c = c ** 2.2` -- the pinned inverse image processing's gamma decode.
    // JS `**` over numbers is Number::exponentiate, the same algorithm
    // ECMA-262 gives Math.pow.
    const emitted = lower("c = c ** 2.2;", [
        ["c", { cpp: "c", type: "scalar" }],
    ]);
    assert.match(emitted, /c = std::pow\(c, 2\.2\);/);
});

test("lowers the truncating bitwise-or the pin uses as a cast", () => {
    const emitted = lower("const key = value | 0;", [
        ["value", { cpp: "value", type: "scalar" }],
    ]);
    assert.match(emitted, /static_cast<std::int32_t>/);
});

test("refuses a bitwise-or that is not the pin's truncation", () => {
    assert.throws(
        () =>
            lower("const key = value | 7;", [
                ["value", { cpp: "value", type: "scalar" }],
            ]),
        /Unsupported pinned bitwise expression/,
    );
});

test("refuses a value-selecting and, rather than guessing its meaning", () => {
    assert.throws(
        () =>
            lower("const kept = value && fallback;", [
                ["value", { cpp: "value", type: "scalar" }],
                ["fallback", { cpp: "fallback", type: "scalar" }],
            ]),
        /Unsupported pinned value-selecting/,
    );
});

test("refuses a call the caller did not declare", () => {
    assert.throws(
        () => lower("const x = Math.tan(1);"),
        /Unsupported pinned call 'Math\.tan'/,
    );
});

test("refuses an identifier with no binding", () => {
    assert.throws(
        () => lower("const x = mystery;"),
        /Unsupported pinned identifier: mystery/,
    );
});

test("refuses a statement kind it does not translate", () => {
    assert.throws(
        () => lower("switch (1) { default: break; }"),
        /Unsupported pinned statement/,
    );
});
