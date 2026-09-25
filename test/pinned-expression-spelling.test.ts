import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import {
    PinnedNumericLowerer,
    type PinnedBinding,
} from "../src/lowering/pinned-numeric-lowerer.js";
import type { PinnedExpressionSpelling } from "../src/lowering/pinned-numeric-expression.js";
import { pinnedNumericMathCalls } from "../src/lowering/pinned-operators.js";
import { renderCppExpression } from "../src/lowering/gltf/cpp-expression.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

function render(
    source: string,
    spelling: PinnedExpressionSpelling = {},
): string {
    const file = ts.createSourceFile(
        "expression.ts",
        source + ";",
        ts.ScriptTarget.Latest,
        true,
    );
    const statement = file.statements[0];
    assert.ok(statement && ts.isExpressionStatement(statement));
    return new PinnedNumericLowerer(file, {
        bindings: new Map(
            ["a", "b", "c", "index"].map((name) => [
                name,
                { cpp: name, type: "scalar" },
            ]),
        ),
        calls: pinnedNumericMathCalls(),
        expressionSpelling: spelling,

        foldConditions: false,
    }).expression(statement.expression);
}

test("minimal spelling retains grouping and separates adjacent unary operators", () => {
    const minimal = { parentheses: "minimal" } as const;
    assert.equal(render("a * (b * c)", minimal), "a * (b * c)");
    assert.equal(render("a / (b / c)", minimal), "a / (b / c)");
    assert.equal(render("(a + b) * c", minimal), "(a + b) * c");
    assert.equal(render("-(-a)", minimal), "-(-a)");
    assert.equal(render("+(+a)", minimal), "+(+a)");
    assert.equal(render("(a ? b : c) ? a : c", minimal), "(a ? b : c) ? a : c");
});

test("source spelling preserves parentheses through non-null assertions and prints double literals", () => {
    const source: PinnedExpressionSpelling = { parentheses: "source" };
    assert.equal(render("(a * (b + 1))!", source), "(a * (b + 1.0))");
    assert.equal(
        render("a ? Math.max(b, 1e-6) : 2", source),
        "(a ? bbl::js::math_extreme<true>({b, 0.000001}) : 2.0)",
    );
    assert.equal(render("a % b", source), "std::fmod(a, b)");
    assert.equal(
        render("index % 3", {
            parentheses: "minimal",
            remainder: "integral",
            numeric: (node) => node.text,
        }),
        "index % 3",
    );
});

const nativeTools = optionalNativeFixtureTools();
test("glTF expression scopes carry arithmetic, comparisons and Math calls through the numeric renderer", () => {
    for (const [source, expected] of [
        ["(a + b) * c", "(a + b) * c"],
        ["a <= b && b !== c", "a <= b && b != c"],
        [
            "a <= b ? Math.max(a, b) : c",
            "a <= b ? bbl::js::math_extreme<true>({a, b}) : c",
        ],
        ["a % 3", "a % 3"],
    ]) {
        const file = ts.createSourceFile(
            "gltf-expression.ts",
            source! + ";",
            ts.ScriptTarget.Latest,
            true,
        );
        const statement = file.statements[0];
        assert.ok(statement && ts.isExpressionStatement(statement));
        const scope = {
            file,
            symbol: "interpolate",
            names: new Map(["a", "b", "c"].map((name) => [name, name])),
            numeric: (node: ts.NumericLiteral) => node.text,
        };
        assert.equal(
            renderCppExpression(scope, statement.expression).text,
            expected,
        );
    }
});

test(
    "minimal native expressions preserve floating-point association and unary values",
    { skip: !nativeTools },
    () => {
        const directory = resolve("artifacts/pinned-expression-spelling");
        mkdirSync(directory, { recursive: true });
        const source = resolve(directory, "check.cpp"),
            executable = resolve(directory, "check.exe");
        const minimal = { parentheses: "minimal" } as const;
        writeFileSync(
            source,
            `#include <cassert>\n#include <cmath>\nint main() {
        double a = 1e308, b = 1e-308, c = 1e-308;
        assert((${render("a * (b * c)", minimal)}) == 0.0);
        a = 1e308; b = 1e308; c = 1e308;
        assert((${render("a / (b / c)", minimal)}) == 1e308);
        a = 2.0;
        assert((${render("-(-a)", minimal)}) == 2.0);
        assert(a == 2.0);
        assert((${render("-3.5 % 2", minimal)}) == -1.5);
    }\n`,
        );
        runNativeFixtureCompiler(nativeTools!, [
            "/nologo",
            "/std:c++20",
            "/W4",
            "/WX",
            "/permissive-",
            "/EHsc",
            `/Fo:${directory}\\`,
            `/Fe:${executable}`,
            source,
        ]);
        execFileSync(executable, { stdio: "pipe" });
    },
);

/**
 * Statements lowered in a JavaScript-width scope over three scalars and a
 * `Uint32Array` named `mask`, one C++ statement per line.
 */
function lowerStatements(source: string): string {
    const file = ts.createSourceFile(
        "statements.ts",
        source,
        ts.ScriptTarget.Latest,
        true,
    );
    return new PinnedNumericLowerer(file, {
        bindings: new Map<string, PinnedBinding>([
            ...["a", "b", "c"].map((name): [string, PinnedBinding] => [
                name,
                { cpp: name, type: "scalar" },
            ]),
            ["mask", { cpp: "mask", type: "u32" }],
        ]),
        calls: pinnedNumericMathCalls(),
    })
        .statements(file.statements, "        ")
        .join("\n");
}

test("Math.max and Math.min lower to one JavaScript call over every argument", () => {
    assert.equal(
        lowerStatements("a = Math.max(a, b, c);"),
        "        a = bbl::js::math_extreme<true>({a, b, c});",
    );
    assert.equal(
        lowerStatements("a = Math.min(b, c);"),
        "        a = bbl::js::math_extreme<false>({b, c});",
    );
});

test("a Uint32Array store converts with ToUint32", () => {
    const store = lowerStatements("mask[0] = -1;");
    assert.match(store, /= bbl::js::to_uint32\(/);
    assert.doesNotMatch(store, /static_cast<std::uint32_t>/);
    assert.throws(
        () => lowerStatements("mask[0] += a;"),
        /compound assignment into a typed-array element/,
    );
});

const headerTools = optionalNativeFixtureTools(false);
test(
    "lowered Math.max, Math.min and Uint32Array stores keep JavaScript's results natively",
    { skip: !headerTools },
    () => {
        const directory = resolve("artifacts/pinned-math-extreme");
        mkdirSync(directory, { recursive: true });
        const source = resolve(directory, "check.cpp"),
            executable = resolve(directory, "check.exe");
        writeFileSync(
            source,
            `#include <bblite/js_data.hpp>
#include <array>
#include <cassert>
#include <cmath>
#include <cstdint>
#include <limits>
int main() {
    std::array<std::uint32_t, 1> mask{};
    double a = 1.0, b = std::numeric_limits<double>::quiet_NaN(), c = 3.0;
${lowerStatements("a = Math.max(a, b, c);")}
    assert(std::isnan(a));
    a = -0.0; b = 0.0; c = -1.0;
${lowerStatements("a = Math.max(a, b, c);")}
    assert(a == 0.0 && !std::signbit(a));
    a = 0.0; b = -0.0;
${lowerStatements("a = Math.min(a, b);")}
    assert(a == 0.0 && std::signbit(a));
    a = 1.0; b = 7.0; c = 2.0;
${lowerStatements("a = Math.max(a, b, c);")}
    assert(a == 7.0);
${lowerStatements("mask[0] = -1;")}
    assert(mask[0] == 4294967295u);
${lowerStatements("mask[0] = 1 << 31;")}
    assert(mask[0] == 0x80000000u);
${lowerStatements("mask[0] = 4294967296.5;")}
    assert(mask[0] == 0u);
}
`,
        );
        runNativeFixtureCompiler(headerTools!, [
            "/nologo",
            "/std:c++20",
            "/W4",
            "/WX",
            "/permissive-",
            "/EHsc",
            "/MD",
            `/I${resolve("native/include")}`,
            `/Fo:${directory}\\`,
            `/Fe:${executable}`,
            source,
        ]);
        execFileSync(executable, { stdio: "pipe" });
    },
);
