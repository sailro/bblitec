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
        tupleCalls: ReadonlyMap<string, number>;
        recordCalls: ReadonlyMap<string, readonly string[]>;
        methods: ReadonlyMap<
            string,
            (receiver: string, args: readonly string[]) => string
        >;
        vec3Literal: (x: string, y: string, z: string) => string;
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
        ...(extra.tupleCalls ? { tupleCalls: extra.tupleCalls } : {}),
        ...(extra.recordCalls ? { recordCalls: extra.recordCalls } : {}),
        ...(extra.methods ? { methods: extra.methods } : {}),
        ...(extra.vec3Literal ? { vec3Literal: extra.vec3Literal } : {}),
    });
    return file.statements
        .flatMap((statement) => lowerer.statement(statement, ""))
        .join("\n");
}

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
        () => lower("switch (1) { default: break; }"),
        /Unsupported pinned statement/,
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
