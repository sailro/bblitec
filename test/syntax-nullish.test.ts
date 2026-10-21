import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { createCompilerProgram } from "../src/compiler/program.js";
import {
    isNullishLiteral,
    nullishComparison,
    nullishLiteral,
    typeMayHoldNullish,
} from "../src/compiler/symbols.js";
import { equalityOperator } from "../src/compiler/syntax.js";

function expressions(sourceFile: ts.SourceFile): readonly ts.Expression[] {
    return sourceFile.statements.flatMap((statement) =>
        ts.isExpressionStatement(statement) ? [statement.expression] : [],
    );
}

test("equality operators are strict or loose, plain or negated", () => {
    assert.deepEqual(
        [
            ts.SyntaxKind.EqualsEqualsEqualsToken,
            ts.SyntaxKind.ExclamationEqualsEqualsToken,
            ts.SyntaxKind.EqualsEqualsToken,
            ts.SyntaxKind.ExclamationEqualsToken,
            ts.SyntaxKind.LessThanToken,
        ].map(equalityOperator),
        [
            { loose: false, negated: false },
            { loose: false, negated: true },
            { loose: true, negated: false },
            { loose: true, negated: true },
            undefined,
        ],
    );
});

test("a nullish literal is null, the global undefined or a void", () => {
    const { checker, sourceFile } = createCompilerProgram(
        `
        declare function f(): number;
        null; undefined; void 0; void f(); (undefined as never);
        { const undefined = 5; undefined; }
    `,
        "input.ts",
    );
    const values = expressions(sourceFile);
    assert.deepEqual(
        values.map((value) => nullishLiteral(checker, value)),
        ["null", "undefined", "undefined", "undefined", "undefined"],
    );
    assert.deepEqual(
        values.map((value) => isNullishLiteral(checker, value)),
        [true, true, true, false, true],
    );
    const block = sourceFile.statements.find(ts.isBlock)!;
    const local = block.statements.find(ts.isExpressionStatement)!.expression;
    assert.equal(nullishLiteral(checker, local), undefined);
});

test("a nullish comparison names the tested side and its strictness", () => {
    const { checker, sourceFile } = createCompilerProgram(
        `
        declare const x: number | null;
        x === null; undefined != x; x == void 0; x === 1;
    `,
        "input.ts",
    );
    const comparisons = expressions(sourceFile).map((value) =>
        nullishComparison(checker, value),
    );
    assert.deepEqual(
        comparisons.map((comparison) =>
            comparison
                ? `${comparison.tested.getText()} ${comparison.literal} ${comparison.loose ? "loose" : "strict"} ${comparison.negated ? "negated" : "plain"}`
                : undefined,
        ),
        [
            "x null strict plain",
            "x undefined loose negated",
            "x undefined loose plain",
            undefined,
        ],
    );
    const tested = comparisons[0]!.tested;
    assert.ok(typeMayHoldNullish(checker, tested, "null"));
    assert.ok(!typeMayHoldNullish(checker, tested, "undefined"));
});
