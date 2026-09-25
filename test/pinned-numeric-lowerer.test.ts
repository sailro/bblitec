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
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";
import ts from "typescript";
import {
    absentBinding,
    PinnedNumericLowerer,
    type PinnedBinding,
    type PinnedNumericScope,
    type PinnedRecordShape,
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
            | "recordTypes"
            | "expression"
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
        ...(extra.recordTypes ? { recordTypes: extra.recordTypes } : {}),
        ...(extra.expression ? { expression: extra.expression } : {}),
    });
    // The statement list, as a lowered body is: a statement after one that
    // definitely returns is not translated.
    return lowerer.statements(file.statements, "").join("\n");
}

test("record aliases retain optional-read adapters while rebinding ordinary members", () => {
    const output = lower(
        "const state = engine.record; const guarded = state?.count; const direct = state.count;",
        [
            ["engine.record", { cpp: "(*record)", type: "opaque" }],
            ["engine.record.count", { cpp: "record->count", type: "scalar" }],
            ["state.count", { cpp: "unbound.count", type: "scalar" }],
            [
                "state?.count",
                { cpp: "(record ? record->count : 0.0)", type: "scalar" },
            ],
        ],
    );
    assert.match(output, /guarded = \(record \? record->count : 0\.0\);/);
    assert.match(output, /direct = record->count;/);
    assert.doesNotMatch(output, /unbound/);
});

test("loop and branch locals preserve outer bindings and avoid native shadowing", () => {
    const cpp = lower(
        `let p = 7; let pi = 2; for (let p = 0; p < 3; p++) { pi += p; } if (pi > 0) { let p = 9; pi += p; } { let p = 4; pi += p; } p += pi;`,
    );
    assert.match(cpp, /double pi_1 = 2.0/);
    assert.match(cpp, /std::int64_t p_1 =/);
    assert.match(cpp, /pi_1 \+= p_1/);
    assert.match(cpp, /double p_1 = 9.0/);
    assert.match(cpp, /\{\n {4}double p_1 = 4.0;/);
    assert.match(cpp, /p \+= pi_1;$/);
});

test("logical conditions preserve grouping supplied by boolean adapters", () => {
    const cpp = lower("let result = 0; if (enabled || ready) result = 1;", [
        ["enabled", { cpp: "enabled", type: "bool" }],
        ["ready", { cpp: "(target && target->ready)", type: "bool" }],
    ]);
    assert.match(cpp, /\(enabled\) \|\| \(target && target->ready\)/);
});

test("conditional locals inherit the representations of adapted branches", () => {
    const cpp = lower(
        'const lane = axis === 0 ? "x" : "y";',
        [["axis", { cpp: "axis", type: "scalar" }]],
        {
            expression: (node, lowerer) => {
                if (!ts.isStringLiteral(node)) return undefined;
                const cpp = node.text === "x" ? "0.0" : "1.0";
                lowerer.bindLocal(node, { cpp, type: "scalar" });
                return cpp;
            },
        },
    );
    assert.match(cpp, /const double lane =/);
    assert.doesNotMatch(cpp, /std::string/);
});

test("a number declared from a counted loop index converts explicitly", () => {
    const cpp = lower(
        "let total = 0; for (let start = 0; start < 4; start++) { let left = start; total += left; }",
    );
    assert.match(cpp, /double left = static_cast<double>\(start\);/);
});

test("caller ports and helper captures keep declaration identity under shadowing", () => {
    const cpp = lower(
        `let x = 1; let total = 0;
        const add = (amount: number) => { total += x + amount; };
        { let x = 9; add(2); total += x; }
        add(3); total += x;`,
        [["x", { cpp: "outer_value", type: "scalar" }]],
    );
    assert.doesNotMatch(cpp, /double x = 1/);
    assert.match(cpp, /double x = 9\.0/);
    assert.equal(cpp.match(/outer_value \+/g)?.length, 2);
    assert.match(cpp, /total \+= x;/);
    assert.match(cpp, /total \+= outer_value;/);
});

test("member bindings use declaration paths across equivalent source spellings", () => {
    const cpp = lower(
        `let record: {value: number}; let total = 0;
        total += (record /* same owner */)["value"];
        total += values[0.0];
        { const record = {x: 1, y: 2, z: 3}; total += record.x; }
        total += record.value;`,
        [
            ["record", { cpp: "native_record", type: "opaque" }],
            ["record.value", { cpp: "native_value", type: "scalar" }],
            ["values[0]", { cpp: "native_first", type: "scalar" }],
        ],
        { vec3Literal: (x, y, z) => `Vec3d{${x}, ${y}, ${z}}` },
    );
    assert.equal(cpp.match(/total \+= native_value;/g)?.length, 2);
    assert.match(cpp, /total \+= native_first;/);
    assert.match(cpp, /total \+= record.x;/);
});

test("JavaScript class methods resolve parameter ports and shadowed locals", () => {
    const file = ts.createSourceFile(
        "wrapper.mjs",
        `export class Wrapper {
        update(value) { let total = value; { let value = 2; total += value; } return total + value; }
    }`,
        ts.ScriptTarget.Latest,
        true,
    );
    const declaration = file.statements[0];
    assert.ok(declaration && ts.isClassDeclaration(declaration));
    const method = declaration.members[0];
    assert.ok(method && ts.isMethodDeclaration(method) && method.body);
    const lowerer: PinnedNumericLowerer = new PinnedNumericLowerer(file, {
        bindings: new Map([["value", { cpp: "argument", type: "scalar" }]]),
        calls: new Map(),
        returnValue: (node) => lowerer.expression(node!),
    });
    const cpp = lowerer.statements(method.body.statements, "").join("\n");
    assert.match(cpp, /double total = argument;/);
    assert.match(cpp, /double value = 2.0;/);
    assert.match(cpp, /return \(total \+ argument\);/);
});

test("shared statement lowering handles continue and ordered scalar assignment chains", () => {
    const cpp = lower(
        "let a = 0; let b = 0; let c = 0; a = b = c = next(); for (let i = 0; i < 2; i++) { if (i === 1) continue; a += i; }",
        [],
        { calls: new Map([["next", () => "next_value()"]]) },
    );
    assert.match(cpp, /c = next_value\(\);\nb = c;\na = b;/);
    assert.equal(cpp.match(/next_value\(\)/g)?.length, 1);
    assert.match(cpp, /continue;/);
    assert.throws(
        () => lower("continue outer;"),
        /Unsupported pinned statement/,
    );
    assert.throws(
        () =>
            lower("values[0] = a = 1;", [
                ["values", { cpp: "values", type: "f32" }],
                ["a", { cpp: "a", type: "scalar" }],
            ]),
        /scalar chained assignment targets/,
    );
});

test("method dispatch receives binding identity through aliases and element access", () => {
    const values: PinnedBinding = {
        cpp: "renamed_native_carrier",
        type: "scalar",
        absentCpp: "false",
    };
    const functions = new Map([[values, "place_anchor"]]);
    const cpp = lower(
        "const alias = values; alias[0].place(1); values[1].place(2);",
        [["values", values]],
        {
            methods: new Map([
                [
                    "place",
                    (receiver, args, binding) => {
                        const fn = functions.get(binding);
                        assert.ok(
                            fn,
                            "dispatch must use the original binding, not a native-name prefix",
                        );
                        return `${fn}(${receiver}, ${args.join(", ")})`;
                    },
                ],
            ]),
        },
    );
    assert.match(
        cpp,
        /place_anchor\(renamed_native_carrier\[static_cast<std::size_t>\(0\.0\)\], 1\.0\)/,
    );
    assert.match(
        cpp,
        /place_anchor\(renamed_native_carrier\[static_cast<std::size_t>\(1\.0\)\], 2\.0\)/,
    );
});

test("indexed store adapters survive buffer aliases and refuse unsupported updates", () => {
    const values: PinnedBinding = {
        cpp: "native_view",
        type: "f32",
        mutable: true,
        indexedStore: (owner, index, value) =>
            `store(${owner}, ${index}, ${value})`,
    };
    assert.equal(
        lower("const alias = values; alias[-0.25] = 0.1;", [
            ["values", values],
        ]),
        "store(native_view, (-0.25), 0.1);",
    );
    assert.throws(
        () => lower("values[0] += 1;", [["values", values]]),
        /compound assignment through an indexed store adapter/,
    );
    assert.throws(
        () => lower("values[0]++;", [["values", values]]),
        /reference to an adapted indexed store/,
    );
});

test("a string set and a composed throw message lower as JavaScript's", (t) => {
    const strings: [string, PinnedBinding][] = [
        ["first", { cpp: "first", type: "string" }],
        ["second", { cpp: "second", type: "string" }],
    ];
    const body = lower(
        'const names = new Set<string>(); names.add(first); names.add(second); names.add(first); if (names.size) { throw new Error(`missing: ${Array.from(names).sort().join(", ")}. ` + "Register them."); }',
        strings,
    );
    assert.match(body, /bbl::js::Set<std::string> names;/);
    assert.match(body, /names\.add\(first\);/);
    assert.match(
        body,
        /if \(bbl::js::number_truthy\(static_cast<double>\(static_cast<double>\(names\.size\(\)\)\)\)\) \{/,
    );
    // A number inside a template would need JavaScript's own formatting.
    assert.throws(
        () =>
            lower("const n = 2; throw new Error(`count ${n}`);", [
                ["n", { cpp: "n", type: "scalar" }],
            ]),
        /string expression/,
    );
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const output = resolve("artifacts/pinned-numeric-strings");
    mkdirSync(output, { recursive: true });
    const file = join(output, "check.cpp"),
        executable = join(output, "check.exe");
    // JavaScript's default sort compares UTF-16 code units, so "Z" < "a".
    writeFileSync(
        file,
        `#include <bblite/js_data.hpp>
        #include <cstdio>
        #include <stdexcept>
        #include <string>
        static void run(const std::string& first, const std::string& second) {
            ${body}
        }
        int main() {
            try {
                run("text", "Zone");
            } catch (const std::runtime_error& error) {
                std::fputs(error.what(), stdout);
            }
        }`,
    );
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/permissive-",
        "/EHsc",
        "/MD",
        `/Fo:${output}/`,
        `/Fe:${executable}`,
        "/I",
        "native/include",
        file,
    ]);
    assert.equal(
        execFileSync(executable, { encoding: "utf8" }),
        `missing: ${Array.from(new Set(["text", "Zone", "text"]))
            .sort()
            .join(", ")}. Register them.`,
    );
});

test("native typed-array chains capture indices before writes and preserve unrounded assignment values", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const bindings: [string, PinnedBinding][] = [
        ["values", { cpp: "values", type: "f32" }],
        ["bytes", { cpp: "bytes", type: "u8" }],
        ["words", { cpp: "words", type: "u32" }],
    ];
    const body = lower(
        "values[values[0]] = values[0] = 1; values[2] = bytes[0] = 257.25; words[0] = words[1] = -1;",
        bindings,
    );
    const values = new Float32Array([3, 0, 0, 0]),
        bytes = new Uint8Array(1),
        words = new Uint32Array(2);
    values[values[0]!] = values[0] = 1;
    values[2] = bytes[0] = 257.25;
    words[0] = words[1] = -1;
    const output = resolve("artifacts/pinned-numeric-chains");
    mkdirSync(output, { recursive: true });
    const file = join(output, "check.cpp"),
        executable = join(output, "check.exe");
    writeFileSync(
        file,
        `#include <bblite/js_data.hpp>
        #include <cassert>
        int main() {
            std::vector<float> values{3, 0, 0, 0}; std::vector<std::uint8_t> bytes(1);
            std::vector<std::uint32_t> words(2);
            ${body}
            assert((values == std::vector<float>{${[...values].join(",")}}));
            assert(bytes[0] == ${bytes[0]});
            assert((words == std::vector<std::uint32_t>{${[...words].map((word) => `${word}u`).join(",")}}));
        }`,
    );
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/permissive-",
        "/EHsc",
        "/MD",
        "/O2",
        `/Fo:${output}/`,
        `/Fe:${executable}`,
        "/I",
        "native/include",
        file,
    ]);
    assert.equal(execFileSync(executable, { encoding: "utf8" }), "");
    for (const source of [
        "values[0] = values[1] = next();",
        "values[bytes[0]++] = values[0] = 1;",
    ])
        assert.throws(
            () => lower(source, bindings),
            /scalar chained assignment targets/,
        );
});

// The recast-navigation generators' `dtIlog2`/`dtNextPow2` shapes: compound
// bitwise stores on number locals, an array literal the body indexes and
// updates, and a `const` object whose members the body writes. Each is
// checked against JavaScript's own evaluation of the same statements.
test("compound bitwise stores, array literals and written const records run as JavaScript does", (t) => {
    const source =
        "let v = 4097; let r = 0; let shift = 0; " +
        "r = Number(v > 0xffff) << 4; v >>= r; " +
        "shift = Number(v > 0xff) << 3; v >>= shift; r |= shift; " +
        "shift = Number(v > 0xf) << 2; v >>= shift; r |= shift; " +
        "shift = Number(v > 0x3) << 1; v >>= shift; r |= shift; r |= v >> 1; " +
        "let w = -5; w >>>= 1; let a = 13; a &= 6; a ^= 3; a <<= 30; " +
        "const b = [1.5, 2, 3]; b[0] -= 0.25; b[2] += b[1]; " +
        "const p = { x: Infinity, y: 0, z: 0 }; p.x = Math.min(p.x, 3);";
    const body = lower(source, [], {
        calls: new Map([
            ["Number", (args) => `static_cast<double>(${args[0]})`],
        ]),
        vec3Literal: (x, y, z) => `Vec3d{${x}, ${y}, ${z}}`,
    });
    assert.match(
        body,
        /v = static_cast<double>\(bbl::js::shift_right\(v, r\)\);/,
    );
    assert.match(
        body,
        /r = static_cast<double>\(bbl::js::bitwise_or\(r, bbl::js::shift_right\(v, 1\.0\)\)\);/,
    );
    assert.match(body, /std::vector<double> b\{1\.5, 2\.0, 3\.0\};/);
    assert.match(body, /^Vec3d p = /m);
    // The same statements, run by JavaScript itself.
    const expected = ((): number[] => {
        let v = 4097;
        let r = Number(v > 0xffff) << 4;
        v >>= r;
        let shift = Number(v > 0xff) << 3;
        v >>= shift;
        r |= shift;
        shift = Number(v > 0xf) << 2;
        v >>= shift;
        r |= shift;
        shift = Number(v > 0x3) << 1;
        v >>= shift;
        r |= shift;
        r |= v >> 1;
        let w = -5;
        w >>>= 1;
        let a = 13;
        a &= 6;
        a ^= 3;
        a <<= 30;
        const b = [1.5, 2, 3];
        b[0]! -= 0.25;
        b[2]! += b[1]!;
        const p = { x: Infinity, y: 0, z: 0 };
        p.x = Math.min(p.x, 3);
        return [r, w, a, b[0]!, b[2]!, p.x];
    })();
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const output = resolve("artifacts/pinned-numeric-bitwise-stores");
    mkdirSync(output, { recursive: true });
    const file = join(output, "check.cpp"),
        executable = join(output, "check.exe");
    writeFileSync(
        file,
        `#include <bblite/js_data.hpp>
        #include <bblite/runtime.hpp>
        #include <cassert>
        struct Vec3d { double x; double y; double z; };
        int main() {
            ${body}
            const double seen[] = {r, w, a, b[0], b[2], p.x};
            const double expected[] = {${expected.join(", ")}};
            for (int index = 0; index < 6; ++index) assert(seen[index] == expected[index]);
        }`,
    );
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/permissive-",
        "/EHsc",
        "/MD",
        "/Od",
        `/Fo:${output}/`,
        `/Fe:${executable}`,
        "/I",
        "native/include",
        file,
    ]);
    assert.equal(execFileSync(executable, { encoding: "utf8" }), "");
    // An integer loop index would narrow the stored number again.
    assert.throws(
        () => lower("for (let i = 0; i < 4; i++) { i |= 1; }"),
        /compound bitwise assignment to a non-scalar/,
    );
});

test("caller substitutions can name later local declarations", () => {
    const cpp = lower(
        "const defaultOffset = 3; const offset = options.offset;",
        [["options.offset", { cpp: "defaultOffset", type: "scalar" }]],
    );
    assert.match(cpp, /const double defaultOffset = 3.0/);
    assert.match(cpp, /const double offset = defaultOffset/);
});

test("optional scalar aliases retain absence in strict equality in either order", () => {
    const cpp = lower(
        "let result = 0; const copy = option; if (copy === undefined) result = 1; if (undefined !== copy) result = 2; if (copy === false) result = 3;",
        [["option", { cpp: "value", type: "bool", absentCpp: "missing" }]],
    );
    assert.match(cpp, /if \(missing\)/);
    assert.match(cpp, /if \(!\(missing\)\)/);
    assert.match(cpp, /!\(missing\).*value == false/);
    assert.doesNotMatch(cpp, /double copy/);
});

test("a comparison against a statically absent value folds as JavaScript's", () => {
    const cpp = lower(
        "let result = 0; if (flags !== undefined) { result = flags; } if (flags == null) { result = 2; } const none = null; if (none === undefined) { result = none; } if (none === null) { result = 3; }",
        [["flags", absentBinding("undefined")]],
    );
    // `!== undefined` is false over an undefined; `== null` is true over
    // either; a null is not strictly undefined but is strictly null.
    assert.doesNotMatch(cpp, /result = flags|result = none/);
    assert.match(cpp, /result = 2\.0;/);
    assert.match(cpp, /result = 3\.0;/);
    // Strictly, an absence of unknown value is not decided.
    assert.throws(
        () =>
            lower("let result = 0; if (hook === null) { result = 1; }", [
                ["hook", absentBinding()],
            ]),
        /null|Unsupported/,
    );
});

test("typeof a statically absent value is its absence's, not its stand-in's", () => {
    const cpp = lower(
        'let result = 0; if (typeof flags === "undefined") { result = 1; } if (typeof flags === "boolean") { result = flags; } const none = null; if (typeof none === "object") { result = 2; } if (typeof none !== "undefined") { result = 3; } if (typeof hook === "function") { result = hook; }',
        [
            ["flags", absentBinding("undefined")],
            ["hook", absentBinding()],
        ],
    );
    // `undefined` is "undefined", `null` is "object", and an absence of
    // either kind is never "function", whatever the stand-in's type.
    assert.match(cpp, /result = 1\.0;/);
    assert.match(cpp, /result = 2\.0;/);
    assert.match(cpp, /result = 3\.0;/);
    assert.doesNotMatch(cpp, /result = flags|result = hook/);
    // Which absence it is decides "undefined"; unsaid, it is not decided.
    assert.throws(
        () =>
            lower(
                'let result = 0; if (typeof hook === "undefined") { result = 1; }',
                [["hook", absentBinding()]],
            ),
        /Unsupported pinned expression: typeof hook\./,
    );
});

test("typeof a value absent at run time tests its presence", () => {
    const cpp = lower(
        'let result = 0; if (typeof positions === "object") { result = 1; } if (typeof positions === "undefined") { result = 2; } if (typeof positions === "number") { result = 3; } if (typeof weight !== "number") { result = 4; } if (typeof root === "object") { result = 5; } if (typeof option === "boolean") { result = 6; }',
        [
            [
                "positions",
                { cpp: "positions", type: "f32", absentCpp: "!has_positions" },
            ],
            ["weight", { cpp: "*weight", type: "scalar", nullish: "!weight" }],
            [
                "root",
                {
                    cpp: "root",
                    type: "f32",
                    absentCpp: "!root",
                    absentValue: "null",
                },
            ],
            ["option", { cpp: "option", type: "bool" }],
        ],
    );
    // An `absentCpp` array is "object" when present and "undefined" when
    // absent; a number is never "object"'s absence test.
    assert.match(cpp, /if \(!\(!has_positions\)\) \{\s*result = 1\.0;/);
    assert.match(cpp, /if \(!has_positions\) \{\s*result = 2\.0;/);
    assert.doesNotMatch(cpp, /result = 3\.0/);
    assert.match(cpp, /if \(!weight\) \{\s*result = 4\.0;/);
    // A null absence is an "object" too, and a value never absent keeps
    // its own type's name.
    assert.match(cpp, /result = 5\.0;/);
    assert.doesNotMatch(cpp, /if \([^)]*root/);
    assert.match(cpp, /result = 6\.0;/);
    // A `nullish` value's absence may be either, so "undefined" is open.
    assert.throws(
        () =>
            lower(
                'let result = 0; if (typeof weight === "undefined") { result = 1; }',
                [
                    [
                        "weight",
                        { cpp: "*weight", type: "scalar", nullish: "!weight" },
                    ],
                ],
            ),
        /Unsupported pinned expression: typeof weight\./,
    );
});

test("a typeof test the binding leaves open lowers through the caller's spelling", () => {
    // `_resolveComputeStorageTextureSampleType`'s guard: `format` is a
    // native string the binding does not type, and the caller spells its
    // `typeof` itself.
    const cpp = lower(
        'let result = 0; if (typeof format !== "string") { result = 1; }',
        [["format", { cpp: "format", type: "opaque" }]],
        {
            expression: (node) =>
                ts.isStringLiteral(node)
                    ? `std::string_view{"${node.text}"}`
                    : ts.isTypeOfExpression(node) &&
                        node.expression.getText() === "format"
                      ? 'std::string_view{"string"}'
                      : undefined,
        },
    );
    assert.match(
        cpp,
        /if \(std::string_view\{"string"\} != std::string_view\{"string"\}\) \{\s*result = 1\.0;/,
    );
});

test("initialized Vec3 locals retain vector members through assignment", () => {
    const cpp = lower(
        `let delta: Vec3 = { x: 1, y: 2, z: 3 }; const projection = delta.x; delta = { x: projection, y: 0, z: 0 };`,
        [],
        {
            vec3Literal: (x, y, z) => `Vec3d{${x}, ${y}, ${z}}`,
        },
    );
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

test("nullable vector aliases retain presence in conditional expressions", () => {
    const cpp = lower(
        "const copy = axis; const projection = copy ? copy.x : 7;",
        [["axis", { cpp: "axis", type: "vec3", absentCpp: "!axis_mode" }]],
    );
    assert.match(cpp, /!\(!axis_mode\).*\? axis.x : 7.0/);
    assert.doesNotMatch(cpp, /axis \?/);
});

test("lowers a JavaScript numeric or-else to lazy value selection", () => {
    const emitted = lower("const length = value || 1;", [
        ["value", { cpp: "value", type: "scalar" }],
    ]);
    // Not `(value || 1.0)`: that is a bool in C++, so every non-zero input
    // would collapse to 1.
    assert.match(
        emitted,
        /number_truthy\(static_cast<double>\(pinned_0_\d+\)\) \? static_cast<double>/,
    );
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

test("keeps every bitwise operator on JavaScript's own int32 coercion", () => {
    // `x | 0` truncates through ToInt32 like any OR; the cluster tile
    // mask's `maskData[i] | bit` coerces BOTH sides before masking, which
    // makes bit 31 negative there and the `Uint32Array` store wrap it back;
    // a shift masks its count to five bits. None is a bare native cast.
    const value: [string, { cpp: string; type: "scalar" }] = [
        "value",
        { cpp: "value", type: "scalar" },
    ];
    for (const [source, spelling] of [
        ["value | 0", /bbl::js::bitwise_or\(value, 0/],
        ["value | 7", /bbl::js::bitwise_or\(value, 7/],
        ["1 << value", /bbl::js::shift_left\(1\.0, value\)/],
        ["value ^ 3", /bbl::js::bitwise_xor\(value, 3/],
    ] as const) {
        const emitted = lower(`const key = ${source};`, [value]);
        assert.match(emitted, spelling);
        assert.doesNotMatch(emitted, /static_cast<std::int32_t>/);
    }
});

test("numeric and selects a value and Math members resolve without caller maps", () => {
    assert.match(
        lower("const kept = value && fallback;", [
            ["value", { cpp: "value", type: "scalar" }],
            ["fallback", { cpp: "fallback", type: "scalar" }],
        ]),
        /number_truthy/,
    );
    assert.match(lower("const x = Math.tan(1);"), /std::tan\(1\.0\)/);
    assert.throws(
        () =>
            lower(
                "const Math = { tan: (x: number) => x }; const x = Math.tan(1);",
            ),
        /Unsupported pinned/,
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
        () => lower("with (value) {}"),
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
    assert.match(
        emitted,
        /const auto (pinned_\w+) = mode;\s*if \(\1 == 0\.0\) \{\s*value = 1\.0;\s*\} else if \(\1 == 4\.0\) \{\s*value = 2\.0;\s*\} else \{\s*value = 3\.0;\s*\}/,
    );
});

test("logical values and switch selectors preserve lazy, single evaluation natively", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const body = lower(
        `
        let left = 0;
        const a = left || next();
        const b = left && next();
        left = NaN;
        const c = left || next();
        left = -0;
        const d = left && next();
        const text = "" || "ok";
        const mixedCondition = (left && (left <= 0 || left > 1)) ? 1 : 2;
        const gated = gate && (choice ? false : true);
        let branch = 0;
        if (gate && (choice ? false : true)) branch = 1;
        let selected = 0;
        switch (next()) { case 0: selected = 10; break; case 3: selected = 20; break; default: selected = 30; }
    `,
        [
            ["gate", { cpp: "gate", type: "bool" }],
            ["choice", { cpp: "choice", type: "bool" }],
            [
                "NaN",
                {
                    cpp: "std::numeric_limits<double>::quiet_NaN()",
                    type: "scalar",
                },
            ],
        ],
        { calls: new Map([["next", () => "next()"]]) },
    );
    const output = resolve("artifacts/pinned-numeric-logical-values");
    mkdirSync(output, { recursive: true });
    const file = join(output, "check.cpp"),
        executable = join(output, "check.exe");
    writeFileSync(
        file,
        `#include <bblite/js_data.hpp>
        #include <cassert>
        #include <cmath>
        int main() {
            int calls = 0;
            bool gate = false, choice = true;
            auto next = [&]() { return static_cast<double>(++calls); };
            ${body}
            assert(a == 1 && b == 0 && c == 2 && d == 0 && std::signbit(d));
            assert(text == "ok" && selected == 20 && calls == 3 && mixedCondition == 2);
            assert(!gated && branch == 0);
        }`,
    );
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/permissive-",
        "/EHsc",
        "/MD",
        "/Od",
        `/Fo:${output}/`,
        `/Fe:${executable}`,
        "/I",
        "native/include",
        file,
    ]);
    assert.equal(execFileSync(executable, { encoding: "utf8" }), "");
    assert.throws(
        () => lower(`const value = 1 || "text";`),
        /incompatible representations/,
    );
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
    assert.match(emitted, /bbl::js::shift_right\(emission, 0\.0\)/);
});

// The three capabilities the Gaussian-splat transform bake's fold needed.
// Each is declared BY THE CALLER, so the refusals matter as much as the
// emissions: a pinned body reaching one the caller did not declare has to
// fail generation rather than emit a guess.

const tupleCall = new Map([["coord", 3]]);
const tupleCalls = {
    tupleCalls: tupleCall,
    calls: new Map([
        ["coord", (a: readonly string[]) => `coord(${a.join(", ")})`],
    ]),
};

test("binds a tuple destructuring through one temporary", () => {
    const emitted = lower(
        "const [x, y, z] = coord(m);",
        [["m", { cpp: "m", type: "f32" }]],
        tupleCalls,
    );
    // One call, indexed three times -- not three calls.
    assert.equal(emitted.match(/coord\(m\)/g)?.length, 1);
    assert.match(emitted, /const auto pinned_\d+_\d+ = coord\(m\);/);
});

test("refuses a tuple destructuring of the wrong length", () => {
    // The declared arity is what keeps this a generation error instead of an
    // index past the end of the std::array the call returns.
    assert.throws(
        () =>
            lower(
                "const [x, y, z, w] = coord(m);",
                [["m", { cpp: "m", type: "f32" }]],
                tupleCalls,
            ),
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
    const emitted = lower(
        "const q = basis();\nconst n = q.x + q.w;",
        [],
        recordCalls,
    );
    assert.match(emitted, /const auto pinned_\d+_\d+ = basis\(\);/);
    // The members read off the temporary rather than re-calling.
    assert.equal(emitted.match(/basis\(\)/g)?.length, 1);
    assert.match(emitted, /\.x \+ .*\.w/);
});

test("refuses a member read the caller did not list", () => {
    assert.throws(
        () =>
            lower("const q = basis();\nconst n = q.missing;", [], recordCalls),
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
    const emitted = lower("const f32 = new F32(rows);\nf32[0] = 1.5;", [
        [
            "rows",
            {
                cpp: "rows.data()",
                bytesCpp: "rows.size()",
                type: "u8-view",
                mutable: true,
            },
        ],
    ]);
    // The view is not const, and the store rounds where the pin's typed
    // array store rounds.
    assert.match(emitted, /float\* f32 = reinterpret_cast<float\*>/);
    assert.match(emitted, /static_cast<float>\(1\.5\)/);
});

test("refuses a store through a view the caller left read-only", () => {
    assert.throws(
        () =>
            lower("const f32 = new F32(rows);\nf32[0] = 1.5;", [
                [
                    "rows",
                    {
                        cpp: "rows.data()",
                        bytesCpp: "rows.size()",
                        type: "u8-view",
                    },
                ],
            ]),
        /store through a read-only view/,
    );
});

test("stores a byte through the spec's ToUint8 rather than a cast", () => {
    const emitted = lower("const u8 = new U8(rows);\nu8[0] = 300;", [
        [
            "rows",
            {
                cpp: "rows.data()",
                bytesCpp: "rows.size()",
                type: "u8-view",
                mutable: true,
            },
        ],
    ]);
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
            calls: new Map([["place", (args) => `place(${args.join(", ")})`]]),
            vec3Literal: (x, y, z) => `Vec3d{${x}, ${y}, ${z}}`,
        },
    );
    assert.match(emitted, /place\(Vec3d\{a, 0\.0, a\}\)/);
});

test("refuses a record literal whose lanes are not the pin's own order", () => {
    assert.throws(
        () =>
            lower(
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
        () =>
            lower("const p = place({ x: 1, y: 2, z: 3 });", [], {
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
    const emitted = lower("const sx = i & 4 ? 1 : -1;", [
        ["i", { cpp: "i", type: "scalar" }],
    ]);
    assert.match(emitted, /bbl::js::bitwise_and\(i, 4\.0\)/);
});

// The ribbon builder grows a record list from a record local and from a
// row of another record list. The push arm reads the record's C++ spelling
// off `recordValue`, which answers with a typed binding; the whole binding
// once reached the emitted text as `[object Object]`, which no unit test
// covered and every ribbon scene's native build found.
test("pushes a record onto a record list by its C++ spelling", () => {
    const emitted = lower("ar1.push(pt); ar1.push(path[i]);", [
        ["ar1", { cpp: "ar1", type: "vec3-list" }],
        ["pt", { cpp: "pt", type: "vec3" }],
        ["path", { cpp: "path", type: "vec3-list" }],
        ["i", { cpp: "i", type: "scalar" }],
    ]);
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
    assert.equal(emitted.match(/for \(std::int64_t y = /g)?.length, 2);
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
                ["copy", (receiver: string): string => `copy_of(${receiver})`],
            ]),
        },
    );
    assert.equal(copied.trim(), "indices = copy_of(indices);");
});

// The pin's own growable lists of object records (`_ClusteredActiveLight[]`):
// the shared translator owns JavaScript's array operations over them, so a
// caller names only the native struct each element is.
const itemShape: PinnedRecordShape = {
    cpp: "Item",
    members: [
        {
            name: "node",
            read: (owner) =>
                new Map<string, PinnedBinding>([
                    ["", { cpp: `(*${owner}.node)`, type: "opaque" }],
                    [
                        ".weight",
                        { cpp: `${owner}.node->weight`, type: "scalar" },
                    ],
                ]),
            store: (value) => `&${value}`,
        },
        {
            name: "depth",
            read: (owner) =>
                new Map<string, PinnedBinding>([
                    ["", { cpp: `${owner}.depth`, type: "scalar" }],
                ]),
            store: (value) => value,
        },
        {
            name: "extra",
            read: (owner) =>
                new Map<string, PinnedBinding>([
                    [
                        "",
                        {
                            cpp: `${owner}.extra`,
                            type: "opaque",
                            absentCpp: `${owner}.extra == nullptr`,
                        },
                    ],
                ]),
            store: (value) => `&${value}`,
            absent: "nullptr",
        },
    ],
};
const nodeShape: PinnedRecordShape = {
    cpp: "Node",
    members: [
        {
            name: "weight",
            read: (owner) =>
                new Map<string, PinnedBinding>([
                    ["", { cpp: `${owner}.weight`, type: "scalar" }],
                ]),
            store: (value) => value,
        },
    ],
};

test("lowers JavaScript's array operations over a record list", () => {
    const emitted = lower(
        "items.length = 0;\n" +
            "for (const node of nodes) { if (node.weight > 0) { items.push({ node, depth: node.weight * 2 }); } }\n" +
            "items.sort((a, b) => a.depth - b.depth);\n" +
            "for (let i = 0; i < items.length; i++) { const { node, depth } = items[i]!; total += node.weight + depth; }\n" +
            "const first = nodes[0]!; total += first.weight;",
        [
            ["items", { cpp: "items", type: "record-list", record: itemShape }],
            ["nodes", { cpp: "nodes", type: "record-list", record: nodeShape }],
            ["total", { cpp: "total", type: "scalar" }],
        ],
    );
    assert.match(emitted, /items\.clear\(\);/);
    assert.match(emitted, /for \(const auto& node : nodes\)/);
    // Members in the struct's order; the optional one left out is absent.
    assert.match(
        emitted,
        /items\.push_back\(Item\{&node, \(node\.weight \* 2\.0\), nullptr\}\);/,
    );
    // ES2019's stable sort, under the comparator's own `< 0`.
    assert.match(
        emitted,
        /std::stable_sort\(items\.begin\(\), items\.end\(\), \[&\]\(const Item& a, const Item& b\) \{ return \(\(a\.depth - b\.depth\)\) < 0\.0; \}\);/,
    );
    assert.match(emitted, /i < static_cast<double>\(items\.size\(\)\)/);
    assert.match(
        emitted,
        /const auto& (pinned_\d+_\d+) = items\[static_cast<std::size_t>\(i\)\];\n\s+total \+= \(\1\.node->weight \+ \1\.depth\);/,
    );
    assert.match(
        emitted,
        /const auto& first = nodes\[static_cast<std::size_t>\(0\.0\)\];\ntotal \+= first\.weight;/,
    );
});

test("refuses a record list store it cannot mean", () => {
    const items: [string, PinnedBinding] = [
        "items",
        { cpp: "items", type: "record-list", record: itemShape },
    ];
    assert.throws(
        () => lower("items.length = 2;", [items]),
        /list length store other than 0/,
    );
    assert.throws(
        () => lower("items.push({ depth: 1 });", [items]),
        /Item literal without 'node'/,
    );
    assert.throws(
        () =>
            lower("const sorted = items.sort((a, b) => a.depth - b.depth);", [
                items,
            ]),
        /record list sort/,
    );
});

test("keeps a truth-initialized local boolean through logical stores", () => {
    const emitted = lower(
        "let dirty = a !== b; let flags = 0; flags |= 2; dirty ||= (flags & 2) !== 0; const fresh = Number.NaN;",
        [
            ["a", { cpp: "a", type: "scalar" }],
            ["b", { cpp: "b", type: "scalar" }],
        ],
    );
    assert.match(emitted, /bool dirty = \(a != b\);/);
    assert.match(
        emitted,
        /flags = static_cast<double>\(bbl::js::bitwise_or\(flags, 2\.0\)\);/,
    );
    assert.match(
        emitted,
        /dirty = dirty \|\| \(\(bbl::js::bitwise_and\(flags, 2\.0\) != 0\.0\)\);/,
    );
    assert.match(
        emitted,
        /const double fresh = std::numeric_limits<double>::quiet_NaN\(\);/,
    );
    assert.throws(
        () => lower("let total = 1; total ||= 2;"),
        /'\|\|=' over a non-boolean/,
    );
    assert.throws(
        () => lower("let dirty = false; dirty = 3;"),
        /non-boolean store into a boolean local/,
    );
});

// The pin's factories resolve each optional option with its own `??`
// default. A nullable value the caller holds (a `std::optional` option)
// takes that default exactly where it is absent; read any other way it
// refuses, where a bare dereference would read an empty optional.
test("resolves a nullable value through the pin's own `??` default", () => {
    const range: [string, PinnedBinding] = [
        "options.range",
        {
            cpp: "(*options.range)",
            type: "scalar",
            nullish: "!options.range.has_value()",
        },
    ];
    assert.match(
        lower("const r = options.range ?? 1;", [range]),
        /const double r = \(!options\.range\.has_value\(\) \? 1\.0 : \(\*options\.range\)\);/,
    );
    assert.throws(
        () => lower("const r = options.range + 1;", [range]),
        /read of a nullable value outside '\?\?'/,
    );
});

// JavaScript's `===` over two objects compares identities. A caller that
// holds an object by its handle names the handle as the identity, so the
// comparison -- absent or present -- and a store between two such names
// carry the handle, never an address a record list's growth could move.
test("compares and stores an object by the identity its caller names", () => {
    const bindings: [string, PinnedBinding][] = [
        [
            "camera",
            {
                cpp: "camera",
                type: "opaque",
                identity: "cameraHandle.value",
                absentCpp: "camera == nullptr",
            },
        ],
        [
            "last",
            {
                cpp: "state.last",
                type: "opaque",
                identity: "state.last",
                absentCpp: "state.last == invalid_handle",
            },
        ],
        ["other", { cpp: "other", type: "opaque" }],
    ];
    const emitted = lower("if (camera !== last) { last = camera; }", bindings);
    assert.match(emitted, /\(cameraHandle\.value == state\.last\)/);
    assert.doesNotMatch(emitted, /\(camera == state\.last\)/);
    assert.match(emitted, /state\.last = cameraHandle\.value;/);
    assert.match(
        lower("const same = camera === other;", [
            bindings[0]!,
            ["other", { cpp: "other", type: "opaque", identity: "otherId" }],
        ]),
        /\(cameraHandle\.value == otherId\)/,
    );
    assert.throws(
        () => lower("last = other;", bindings),
        /store of a value without an identity/,
    );
});

// `const light: ClusteredPointLight = { ... }` -- an object literal under
// one of the pin's own type annotations is the native struct the caller
// names for that type, built member by member and read through it.
test("builds an annotated object literal as the struct its type names", () => {
    const emitted = lower(
        "const n: Node = { weight: w }; total += n.weight;",
        [
            ["w", { cpp: "w", type: "scalar" }],
            ["total", { cpp: "total", type: "scalar" }],
        ],
        { recordTypes: new Map([["Node", nodeShape]]) },
    );
    assert.match(emitted, /const Node n = Node\{w\};/);
    assert.match(emitted, /total \+= n\.weight;/);
    assert.throws(
        () =>
            lower(
                "const n: Node = { mass: w };",
                [["w", { cpp: "w", type: "scalar" }]],
                { recordTypes: new Map([["Node", nodeShape]]) },
            ),
        /Node literal without 'weight'|mass/,
    );
});
