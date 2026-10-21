import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import {
    choosesOperand,
    guardsOperands,
    isOperandSelection,
    outermostWrapper,
    valueClassOfString,
    valueOperands,
    yieldedOperands,
} from "../src/compiler/syntax.js";

function expression(source: string): ts.Expression {
    const file = ts.createSourceFile(
        "probe.ts",
        `const probe = ${source};`,
        ts.ScriptTarget.Latest,
        true,
    );
    const statement = file.statements[0];
    assert.ok(statement && ts.isVariableStatement(statement));
    const initializer = statement.declarationList.declarations[0]?.initializer;
    assert.ok(initializer);
    return initializer;
}

function yields(source: string): Record<string, string[]> {
    return Object.fromEntries(
        yieldedOperands(expression(source)).map(({ operand, classes }) => [
            operand.getText(),
            [...classes].sort(),
        ]),
    );
}

test("each operator yields the value classes JavaScript passes on", () => {
    assert.deepEqual(yields("c ? a : b"), {
        a: ["falsy", "nullish", "truthy"],
        b: ["falsy", "nullish", "truthy"],
    });
    assert.deepEqual(yields("a ?? b"), {
        a: ["falsy", "truthy"],
        b: ["falsy", "nullish", "truthy"],
    });
    assert.deepEqual(yields("a || b"), {
        a: ["truthy"],
        b: ["falsy", "nullish", "truthy"],
    });
    assert.deepEqual(yields("a && b"), {
        a: ["falsy", "nullish"],
        b: ["falsy", "nullish", "truthy"],
    });
    assert.deepEqual(yields("(f(), a)"), {
        a: ["falsy", "nullish", "truthy"],
    });
    assert.deepEqual(yields("(a as T)!"), {
        a: ["falsy", "nullish", "truthy"],
    });
});

test("nested selections intersect what each level passes on", () => {
    // `a` reaches `&&`'s left only truthy, which `&&` never yields.
    assert.deepEqual(yields("(a || b) && c"), {
        b: ["falsy", "nullish"],
        c: ["falsy", "nullish", "truthy"],
    });
    assert.deepEqual(yields("x ?? (c ? a : b)"), {
        x: ["falsy", "truthy"],
        a: ["falsy", "nullish", "truthy"],
        b: ["falsy", "nullish", "truthy"],
    });
});

test("objects come only from operands that yield truthy values", () => {
    const texts = (source: string): string[] =>
        valueOperands(expression(source)).map((operand) => operand.getText());
    assert.deepEqual(texts("ready && make()"), ["make()"]);
    assert.deepEqual(texts("cached ?? {}"), ["cached", "{}"]);
    assert.deepEqual(texts("plain"), ["plain"]);
});

test("selection, choice and guarded evaluation are distinct questions", () => {
    const node = (source: string): ts.Node => {
        const parsed = expression(source);
        return ts.isParenthesizedExpression(parsed)
            ? parsed.expression
            : parsed;
    };
    for (const source of ["c ? a : b", "a ?? b", "a || b", "a && b"]) {
        assert.ok(isOperandSelection(node(source)), source);
        assert.ok(choosesOperand(node(source)), source);
        assert.ok(guardsOperands(node(source)), source);
    }
    assert.ok(isOperandSelection(node("(f(), a)")));
    assert.ok(!choosesOperand(node("(f(), a)")));
    assert.ok(!isOperandSelection(node("a + b")));
    assert.ok(guardsOperands(node("o?.m(make())")));
    const logical = expression("x ??= make()");
    assert.ok(guardsOperands(logical));
    assert.ok(!isOperandSelection(logical));
});

test("climbing to the consumer passes objects only where an object can pass", () => {
    const file = ts.createSourceFile(
        "probe.ts",
        "use(ready && make()); use(cache ?? make()); use(make() && ready);",
        ts.ScriptTarget.Latest,
        true,
    );
    const makes: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
        if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === "make"
        )
            makes.push(node);
        ts.forEachChild(node, visit);
    };
    visit(file);
    const consumers = makes.map((call) => {
        const parent = outermostWrapper(call, { branches: "objects" }).parent;
        return ts.isCallExpression(parent) ? "argument" : "operand";
    });
    // `make() && ready` only tests the object it does not yield.
    assert.deepEqual(consumers, ["argument", "argument", "operand"]);
    const climbed = outermostWrapper(makes[2]!, { branches: true }).parent;
    assert.ok(ts.isCallExpression(climbed));
});

test("the empty string is the falsy string", () => {
    assert.equal(valueClassOfString(""), "falsy");
    assert.equal(valueClassOfString("0"), "truthy");
});
