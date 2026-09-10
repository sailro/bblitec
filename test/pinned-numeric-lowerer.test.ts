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
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";
import ts from "typescript";
import {
    PinnedNumericLowerer,
    type PinnedBinding,
    type PinnedNumericScope,
} from "../src/lowering/pinned-numeric-lowerer.js";

function lower(
    source: string,
    bindings: Iterable<[string, PinnedBinding]> = [],
    extra: Partial<
        Pick<
            PinnedNumericScope,
            | "calls"
            | "tupleCalls"
            | "recordCalls"
            | "methods"
            | "receiverReturningMethods"
            | "vec3Literal"
            | "returnValue"
        >
    > = {},
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
        ...(extra.tupleCalls ? { tupleCalls: extra.tupleCalls } : {}),
        ...(extra.recordCalls ? { recordCalls: extra.recordCalls } : {}),
        ...(extra.methods ? { methods: extra.methods } : {}),
        ...(extra.receiverReturningMethods
            ? { receiverReturningMethods: extra.receiverReturningMethods }
            : {}),
        ...(extra.vec3Literal ? { vec3Literal: extra.vec3Literal } : {}),
        ...(extra.returnValue ? { returnValue: extra.returnValue } : {}),
    });
    // The statement list, as a lowered body is: a statement after one that
    // definitely returns is not translated.
    return lowerer.statements(file.statements, "").join("\n");
}

test("loop and branch locals preserve outer bindings and avoid native shadowing", () => {
    const cpp = lower(`let p = 7; let pi = 2; for (let p = 0; p < 3; p++) { pi += p; } if (pi > 0) { let p = 9; pi += p; } { let p = 4; pi += p; } p += pi;`);
    assert.match(cpp, /double pi_1 = 2.0/);
    assert.match(cpp, /std::int64_t p_1 =/);
    assert.match(cpp, /pi_1 \+= p_1/);
    assert.match(cpp, /double p_1 = 9.0/);
    assert.match(cpp, /\{\n    double p_1 = 4.0;/);
    assert.match(cpp, /p \+= pi_1;$/);
});

test("shared statement lowering handles continue and ordered scalar assignment chains", () => {
    const cpp = lower("let a = 0; let b = 0; let c = 0; a = b = c = next(); for (let i = 0; i < 2; i++) { if (i === 1) continue; a += i; }",
        [], { calls: new Map([["next", () => "next_value()"]]) });
    assert.match(cpp, /c = next_value\(\);\nb = c;\na = b;/);
    assert.equal(cpp.match(/next_value\(\)/g)?.length, 1);
    assert.match(cpp, /continue;/);
    assert.throws(() => lower("continue outer;"), /Unsupported pinned statement/);
    assert.throws(() => lower("values[0] = a = 1;", [
        ["values", { cpp: "values", type: "f32" }], ["a", { cpp: "a", type: "scalar" }],
    ]), /scalar chained assignment targets/);
});

test("method dispatch receives binding identity through aliases and element access", () => {
    const values: PinnedBinding = { cpp: "renamed_native_carrier", type: "scalar", absentCpp: "false" };
    const functions = new Map([[values, "place_anchor"]]);
    const cpp = lower("const alias = values; alias[0].place(1); values[1].place(2);", [["values", values]], {
        methods: new Map([["place", (receiver, args, binding) => {
            const fn = functions.get(binding);
            assert.ok(fn, "dispatch must use the original binding, not a native-name prefix");
            return `${fn}(${receiver}, ${args.join(", ")})`;
        }]]),
    });
    assert.match(cpp, /place_anchor\(renamed_native_carrier\[static_cast<std::size_t>\(0\.0\)\], 1\.0\)/);
    assert.match(cpp, /place_anchor\(renamed_native_carrier\[static_cast<std::size_t>\(1\.0\)\], 2\.0\)/);
});

test("native typed-array chains capture indices before writes and preserve unrounded assignment values", t => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) { t.skip("Native fixture compiler unavailable."); return; }
    const bindings: [string, PinnedBinding][] = [
        ["values", { cpp: "values", type: "f32" }], ["bytes", { cpp: "bytes", type: "u8" }],
    ];
    const body = lower("values[values[0]] = values[0] = 1; values[2] = bytes[0] = 257.25;", bindings);
    const values = new Float32Array([3, 0, 0, 0]), bytes = new Uint8Array(1);
    values[values[0]!] = values[0] = 1;
    values[2] = bytes[0] = 257.25;
    const output = resolve("artifacts/pinned-numeric-chains"); mkdirSync(output, { recursive: true });
    const file = join(output, "check.cpp"), executable = join(output, "check.exe");
    writeFileSync(file, `#include <bblite/js_data.hpp>
        #include <cassert>
        int main() {
            std::vector<float> values{3, 0, 0, 0}; std::vector<std::uint8_t> bytes(1);
            ${body}
            assert((values == std::vector<float>{${[...values]}}));
            assert(bytes[0] == ${bytes[0]});
        }`);
    runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD", "/O2",
        `/Fo:${output}/`, `/Fe:${executable}`, "/I", "native/include", file]);
    assert.equal(execFileSync(executable, { encoding: "utf8" }), "");
    for (const source of ["values[0] = values[1] = next();", "values[bytes[0]++] = values[0] = 1;"])
        assert.throws(() => lower(source, bindings), /scalar chained assignment targets/);
    assert.throws(() => lower("values[0] = values[1] = -1;", [["values", { cpp: "values", type: "u32" }]]), /scalar chained assignment targets/);
});

test("caller substitutions can name later local declarations", () => {
    const cpp = lower("const defaultOffset = 3; const offset = options.offset;", [
        ["options.offset", { cpp: "defaultOffset", type: "scalar" }],
    ]);
    assert.match(cpp, /const double defaultOffset = 3.0/);
    assert.match(cpp, /const double offset = defaultOffset/);
});

test("optional scalar aliases retain absence in strict equality in either order", () => {
    const cpp = lower("let result = 0; const copy = option; if (copy === undefined) result = 1; if (undefined !== copy) result = 2; if (copy === false) result = 3;", [
        ["option", { cpp: "value", type: "bool", absentCpp: "missing" }],
    ]);
    assert.match(cpp, /if \(missing\)/);
    assert.match(cpp, /if \(!\(missing\)\)/);
    assert.match(cpp, /!\(missing\).*value == false/);
    assert.doesNotMatch(cpp, /double copy/);
});

test("initialized Vec3 locals retain vector members through assignment", () => {
    const cpp = lower(`let delta: Vec3 = { x: 1, y: 2, z: 3 }; const projection = delta.x; delta = { x: projection, y: 0, z: 0 };`, [], {
        vec3Literal: (x, y, z) => `Vec3d{${x}, ${y}, ${z}}`,
    });
    assert.match(cpp, /Vec3d delta = Vec3d\{1.0, 2.0, 3.0\}/);
    assert.match(cpp, /const double projection = delta.x/);
    assert.match(cpp, /delta = Vec3d\{projection, 0.0, 0.0\}/);
});

test("nullable vector guard tests presence without coercing its value", () => {
    const cpp = lower("if (axis) { const projection = axis.x; }", [
        ["axis", { cpp: "axis", type: "vec3", absentCpp: "!axis_mode" }],
    ]);
    assert.match(cpp, /if \(!\(!axis_mode\)\)/);
    assert.match(cpp, /projection = axis.x/);
});

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

test("keeps a bitwise-or on JavaScript's own int32 coercion", () => {
    // `x | 0` stays the pin's one-term truncation, and a real OR -- the
    // cluster tile mask's `maskData[i] | bit` -- coerces BOTH sides through
    // ToInt32 before masking, which is what makes bit 31 negative there and
    // the `Uint32Array` store wrap it back.
    assert.match(
        lower("const key = value | 0;", [
            ["value", { cpp: "value", type: "scalar" }],
        ]),
        /static_cast<double>\(static_cast<std::int32_t>\(value\)\)/,
    );
    assert.match(
        lower("const key = value | 7;", [
            ["value", { cpp: "value", type: "scalar" }],
        ]),
        /bbl::js::bitwise_or\(value, 7/,
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
        () => lower("do { } while (1);"),
        /Unsupported pinned statement/,
    );
});

test("folds a switch over a static discriminant to its selected clause", () => {
    const emitted = lower(
        "switch (mode) { case 0: value = 1; break; case 1: case 2: value = 2; break; default: value = 3; }",
        [
            ["mode", { cpp: "2.0", type: "scalar", staticNumber: 2 }],
            ["value", { cpp: "value", type: "scalar" }],
        ],
    );
    assert.match(emitted, /value = 2\.0;/);
    assert.doesNotMatch(emitted, /value = 1\.0|value = 3\.0|switch|if \(/);
});

test("lowers a switch over a run-time discriminant to strict-equality arms", () => {
    const emitted = lower(
        "switch (mode) { case 0: value = 1; break; case 4: value = 2; break; default: value = 3; }",
        [
            ["mode", { cpp: "mode", type: "scalar" }],
            ["value", { cpp: "value", type: "scalar" }],
        ],
    );
    assert.match(emitted, /if \(mode == 0\.0\) \{\s*value = 1\.0;\s*\} else if \(mode == 4\.0\) \{\s*value = 2\.0;\s*\} else \{\s*value = 3\.0;\s*\}/);
});

test("folds a shape test over a record the caller fixed", () => {
    const emitted = lower(
        'if (typeof v === "number") { out = v; } else if ("z" in v) { out = v.z; } else { out = v.x; }',
        [
            ["v", { cpp: "v", type: "vec3" }],
            ["out", { cpp: "out", type: "scalar" }],
        ],
    );
    assert.match(emitted, /out = v\.z;/);
    assert.doesNotMatch(emitted, /out = v;|out = v\.x;|typeof|if \(/);
});

test("stops a block at a statically selected returning arm", () => {
    const emitted = lower(
        'if (typeof v === "number") { return v; } const w = v.r; return w;',
        [["v", { cpp: "v", type: "scalar" }]],
        { returnValue: (expression) => (expression ? "value" : "") },
    );
    assert.match(emitted, /return value;/);
    assert.doesNotMatch(emitted, /v\.r/);
});

test("lowers the pin's signed shift as ToInt32 arithmetic", () => {
    const emitted = lower("const count = emission >> 0;", [
        ["emission", { cpp: "emission", type: "scalar" }],
    ]);
    assert.match(
        emitted,
        /bbl::js::shift_right\(emission, 0\.0\)/,
    );
});

// The three capabilities the Gaussian-splat transform bake's fold needed.
// Each is declared BY THE CALLER, so the refusals matter as much as the
// emissions: a pinned body reaching one the caller did not declare has to
// fail generation rather than emit a guess.

const tupleCall = new Map([["coord", 3]]);
const tupleCalls = { tupleCalls: tupleCall, calls: new Map([
    ["coord", (a: readonly string[]) => `coord(${a.join(", ")})`],
]) };

test("binds a tuple destructuring through one temporary", () => {
    const emitted = lower("const [x, y, z] = coord(m);", [
        ["m", { cpp: "m", type: "f32" }],
    ], tupleCalls);
    // One call, indexed three times -- not three calls.
    assert.equal(emitted.match(/coord\(m\)/g)?.length, 1);
    assert.match(emitted, /const auto pinned_\d+_\d+ = coord\(m\);/);
});

test("refuses a tuple destructuring of the wrong length", () => {
    // The declared arity is what keeps this a generation error instead of an
    // index past the end of the std::array the call returns.
    assert.throws(
        () => lower("const [x, y, z, w] = coord(m);", [
            ["m", { cpp: "m", type: "f32" }],
        ], tupleCalls),
        /tuple binding of 4 from a 3-element call/,
    );
});

test("refuses a tuple destructuring of a call the caller did not declare", () => {
    assert.throws(
        () => lower("const [x, y] = mystery(1);"),
        /tuple binding pattern/,
    );
});

const recordCalls = {
    recordCalls: new Map([["basis", ["x", "y", "z", "w"]]]),
    calls: new Map([["basis", () => "basis()"]]),
};

test("binds a record call's members by their own dotted text", () => {
    const emitted = lower("const q = basis();\nconst n = q.x + q.w;", [], recordCalls);
    assert.match(emitted, /const auto pinned_\d+_\d+ = basis\(\);/);
    // The members read off the temporary rather than re-calling.
    assert.equal(emitted.match(/basis\(\)/g)?.length, 1);
    assert.match(emitted, /\.x \+ .*\.w/);
});

test("refuses a member read the caller did not list", () => {
    assert.throws(
        () => lower("const q = basis();\nconst n = q.missing;", [], recordCalls),
        /Unsupported pinned/,
    );
});

test("refuses binding one member of a record call", () => {
    // The caller declares the record's members, not each member's own shape,
    // so a name bound to `f(...).member` would have nothing readable off it.
    assert.throws(
        () => lower("const r = basis().x;", [], recordCalls),
        /record member binding/,
    );
});

test("stores through a mutable view at the view's own element width", () => {
    const emitted = lower(
        "const f32 = new F32(rows);\nf32[0] = 1.5;",
        [["rows", {
            cpp: "rows.data()",
            bytesCpp: "rows.size()",
            type: "u8-view",
            mutable: true,
        }]],
    );
    // The view is not const, and the store rounds where the pin's typed
    // array store rounds.
    assert.match(emitted, /float\* f32 = reinterpret_cast<float\*>/);
    assert.match(emitted, /static_cast<float>\(1\.5\)/);
});

test("refuses a store through a view the caller left read-only", () => {
    assert.throws(
        () => lower(
            "const f32 = new F32(rows);\nf32[0] = 1.5;",
            [["rows", {
                cpp: "rows.data()",
                bytesCpp: "rows.size()",
                type: "u8-view",
            }]],
        ),
        /store through a read-only view/,
    );
});

test("stores a byte through the spec's ToUint8 rather than a cast", () => {
    const emitted = lower(
        "const u8 = new U8(rows);\nu8[0] = 300;",
        [["rows", {
            cpp: "rows.data()",
            bytesCpp: "rows.size()",
            type: "u8-view",
            mutable: true,
        }]],
    );
    assert.match(emitted, /bbl::js::to_uint8\(300\.0\)/);
});

// The pin passes small positional records around by value -- a point handed
// to a placement callback -- and the translator has no types, so which
// native struct one becomes is the caller's to name. Absent, it refuses,
// which is what it did before the option existed.
test("spells a positional record literal the way the caller names it", () => {
    const emitted = lower(
        "const p = place({ x: a, y: 0, z: a });",
        [["a", { cpp: "a", type: "scalar" }]],
        {
            calls: new Map([
                ["place", (args) => `place(${args.join(", ")})`],
            ]),
            vec3Literal: (x, y, z) => `Vec3d{${x}, ${y}, ${z}}`,
        },
    );
    assert.match(emitted, /place\(Vec3d\{a, 0\.0, a\}\)/);
});

test("refuses a record literal whose lanes are not the pin's own order", () => {
    assert.throws(
        () => lower(
            "const p = place({ x: a, z: a, y: a });",
            [["a", { cpp: "a", type: "scalar" }]],
            {
                calls: new Map([
                    ["place", (args) => `place(${args.join(", ")})`],
                ]),
                vec3Literal: (x, y, z) => `Vec3d{${x}, ${y}, ${z}}`,
            },
        ),
        /record lane 'y'/,
    );
});

test("refuses a record literal when the caller named no spelling", () => {
    assert.throws(
        () => lower("const p = place({ x: 1, y: 2, z: 3 });", [], {
            calls: new Map([
                ["place", (args) => `place(${args.join(", ")})`],
            ]),
        }),
        /Unsupported pinned expression/,
    );
});

// A method called on an ELEMENT of a bound list, which is how the pinned
// bounding-box layout reaches each handle's placement callback.
test("reaches a method on an element of a bound list", () => {
    const emitted = lower(
        "edges[0]!.place(a);",
        [
            ["edges", { cpp: "record.edges", type: "scalar" }],
            ["a", { cpp: "a", type: "scalar" }],
        ],
        {
            methods: new Map([
                [
                    "place",
                    (receiver, args) =>
                        `place_edge(${receiver}, ${args.join(", ")})`,
                ],
            ]),
        },
    );
    assert.match(
        emitted,
        /place_edge\(record\.edges\[static_cast<std::size_t>\(0\.0\)\], a\)/,
    );
});

// JavaScript's `&` is ToInt32 on both sides and this translator's scalars
// are doubles, so the narrowing goes through the same runtime helper the
// `|` arm uses rather than through a bare cast, which is not ToInt32 for a
// double outside int32 range. Ungated: every caller of `&` wants ToInt32.
test("narrows both sides of a bit test the way ToInt32 does", () => {
    const emitted = lower(
        "const sx = i & 4 ? 1 : -1;",
        [["i", { cpp: "i", type: "scalar" }]],
    );
    assert.match(emitted, /bbl::js::bitwise_and\(i, 4\.0\)/);
});

// The ribbon builder grows a record list from a record local and from a
// row of another record list. The push arm reads the record's C++ spelling
// off `recordValue`, which answers with a typed binding; the whole binding
// once reached the emitted text as `[object Object]`, which no unit test
// covered and every ribbon scene's native build found.
test("pushes a record onto a record list by its C++ spelling", () => {
    const emitted = lower(
        "ar1.push(pt); ar1.push(path[i]);",
        [
            ["ar1", { cpp: "ar1", type: "vec3-list" }],
            ["pt", { cpp: "pt", type: "vec3" }],
            ["path", { cpp: "path", type: "vec3-list" }],
            ["i", { cpp: "i", type: "scalar" }],
        ],
    );
    assert.match(emitted, /ar1\.push_back\(pt\);/);
    assert.match(emitted, /ar1\.push_back\(path\[[^\]]*i[^\]]*\]\);/);
    assert.doesNotMatch(emitted, /object Object/);
});

// `createCapsuleData` declares `let x: number; let y: number;` once and
// then writes `for (y = 0; ...)` four times -- the loop variable the rest
// of the builder family spells inline, hoisted because two of its loops
// sit at the same level. Where every reference lies inside a `for` that
// assigns the name, the hoisted declaration owns no storage that outlives
// a loop, so each loop declares its own index and the emitted C++ is the
// one the inline spelling produces.
test("a hoisted loop variable is declared by the loops that assign it", () => {
    const emitted = lower(
        "let y: number; for (y = 0; y < 3; y++) { n += y; } " +
            "for (y = 1; y < 4; y++) { n += y; }",
        [["n", { cpp: "n", type: "scalar" }]],
    );
    assert.doesNotMatch(emitted, /double y = 0\.0;/);
    assert.equal(
        emitted.match(/for \(std::int64_t y = /g)?.length,
        2,
    );
});

// The same declaration where the name is ALSO written outside a loop keeps
// its zeroed local: there the hoisting is what the body means, and the two
// `for`s would otherwise each start from a fresh index.
test("a hoisted local read outside its loops keeps its own storage", () => {
    const emitted = lower(
        "let y: number; y = 2; for (y = 0; y < 3; y++) { n += y; } n += y;",
        [["n", { cpp: "n", type: "scalar" }]],
    );
    assert.match(emitted, /double y = 0\.0;/);
});

// `indices = indices.reverse()`: `Array.prototype.reverse` reverses in
// place and returns the same array, so the store around it is the identity
// and only the mutation is emitted. A method the caller has NOT declared
// receiver-returning keeps the ordinary store, which is what stops a
// copying method from silently losing its result.
test("stores an in-place method back over its own receiver as the mutation", () => {
    const methods = new Map([
        [
            "reverse",
            (receiver: string): string =>
                `std::reverse(${receiver}.begin(), ${receiver}.end())`,
        ],
    ]);
    const emitted = lower(
        "indices = indices.reverse();",
        [["indices", { cpp: "indices", type: "f64-list" }]],
        { methods, receiverReturningMethods: new Set(["reverse"]) },
    );
    assert.equal(
        emitted.trim(),
        "std::reverse(indices.begin(), indices.end());",
    );
    // A method the caller has NOT declared receiver-returning keeps the
    // ordinary store, so a COPYING method's result still lands somewhere.
    const copied = lower(
        "indices = indices.copy();",
        [["indices", { cpp: "indices", type: "f64-list" }]],
        {
            methods: new Map([
                [
                    "copy",
                    (receiver: string): string => `copy_of(${receiver})`,
                ],
            ]),
        },
    );
    assert.equal(copied.trim(), "indices = copy_of(indices);");
});
