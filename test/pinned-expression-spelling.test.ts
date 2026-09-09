import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { PinnedNumericLowerer } from "../src/lowering/pinned-numeric-lowerer.js";
import type { PinnedExpressionSpelling } from "../src/lowering/pinned-numeric-expression.js";
import { pinnedNumericMathCalls } from "../src/lowering/pinned-operators.js";
import { renderCppExpression } from "../src/lowering/gltf/animation-interpolation.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

function render(source: string, spelling: PinnedExpressionSpelling = {}): string {
    const file = ts.createSourceFile("expression.ts", source + ";", ts.ScriptTarget.Latest, true);
    const statement = file.statements[0];
    assert.ok(statement && ts.isExpressionStatement(statement));
    return new PinnedNumericLowerer(file, {
        bindings: new Map(["a", "b", "c", "index"].map(name => [name, { cpp: name, type: "scalar" }])),
        calls: pinnedNumericMathCalls("deduced"), expressionSpelling: spelling, booleanAnd: true, booleanOr: true,
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

test("source spelling preserves parentheses through non-null assertions and prints float literals", () => {
    const source: PinnedExpressionSpelling = {
        parentheses: "source", numeric: node => /[.e]/i.test(node.text) ? `${node.text}f` : `${node.text}.0f`,
    };
    assert.equal(render("(a * (b + 1))!", source), "(a * (b + 1.0f))");
    assert.equal(render("a ? Math.max(b, 1e-6) : 2", source), "(a ? std::max(b, 0.000001f) : 2.0f)");
    assert.equal(render("a % b", source), "std::fmod(a, b)");
    assert.equal(render("index % 3", { parentheses: "minimal", remainder: "integral", numeric: node => node.text }), "index % 3");
});

const nativeTools = optionalNativeFixtureTools();
test("glTF expression scopes carry arithmetic, comparisons and Math calls through the numeric renderer", () => {
    for (const [source, expected] of [
        ["(a + b) * c", "(a + b) * c"],
        ["a <= b && b !== c", "a <= b && b != c"],
        ["a <= b ? Math.max(a, b) : c", "a <= b ? std::max(a, b) : c"],
        ["a % 3", "a % 3"],
    ]) {
        const file = ts.createSourceFile("gltf-expression.ts", source! + ";", ts.ScriptTarget.Latest, true);
        const statement = file.statements[0];
        assert.ok(statement && ts.isExpressionStatement(statement));
        const scope = { file, symbol: "interpolate", names: new Map(["a", "b", "c"].map(name => [name, name])), numeric: (node: ts.NumericLiteral) => node.text };
        assert.equal(renderCppExpression(scope, statement.expression).text, expected);
    }
});

test("minimal native expressions preserve floating-point association and unary values", { skip: !nativeTools }, () => {
    const directory = resolve("artifacts/pinned-expression-spelling");
    mkdirSync(directory, { recursive: true });
    const source = resolve(directory, "check.cpp"), executable = resolve(directory, "check.exe");
    const minimal = { parentheses: "minimal" } as const;
    writeFileSync(source, `#include <cassert>\n#include <cmath>\nint main() {
        double a = 1e308, b = 1e-308, c = 1e-308;
        assert((${render("a * (b * c)", minimal)}) == 0.0);
        a = 1e308; b = 1e308; c = 1e308;
        assert((${render("a / (b / c)", minimal)}) == 1e308);
        a = 2.0;
        assert((${render("-(-a)", minimal)}) == 2.0);
        assert(a == 2.0);
        assert((${render("-3.5 % 2", minimal)}) == -1.5);
    }\n`);
    runNativeFixtureCompiler(nativeTools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc",
        `/Fo:${directory}\\`, `/Fe:${executable}`, source]);
    execFileSync(executable, { stdio: "pipe" });
});
