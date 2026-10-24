import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import {
    isExpressionWrapper,
    isTypeAssertion,
    isTypeOnlyWrapper,
    isTypePreservingWrapper,
    outermostWrapper,
    unwrapExpression,
    unwrapTypePreserving,
    wrappersAround,
    wrappersUnder,
} from "../src/compiler/syntax.js";

function parse(source: string): ts.SourceFile {
    return ts.createSourceFile(
        "probe.ts",
        source,
        ts.ScriptTarget.Latest,
        true,
    );
}

function initializer(source: string): ts.Expression {
    const statement = parse(`const probe = ${source};`).statements[0];
    assert.ok(statement && ts.isVariableStatement(statement));
    const value = statement.declarationList.declarations[0]?.initializer;
    assert.ok(value);
    return value;
}

function identifier(file: ts.SourceFile, name: string): ts.Identifier {
    let found: ts.Identifier | undefined;
    const visit = (node: ts.Node): void => {
        if (!found && ts.isIdentifier(node) && node.text === name) found = node;
        ts.forEachChild(node, visit);
    };
    visit(file);
    assert.ok(found, name);
    return found;
}

const kind = (node: ts.Node): string => ts.SyntaxKind[node.kind];

test("the five wrappers keep the value; await only when asked", () => {
    for (const source of ["(x)", "x as T", "<T>x", "x!", "x satisfies T"])
        assert.ok(isExpressionWrapper(initializer(source)), source);
    assert.ok(!isExpressionWrapper(initializer("await x")));
    assert.ok(isExpressionWrapper(initializer("await x"), { await: true }));
    assert.equal(
        unwrapExpression(initializer("((x as T)! satisfies U)")).getText(),
        "x",
    );
});

test("assertions retype, satisfies and parentheses keep the type", () => {
    assert.ok(isTypeAssertion(initializer("x as T")));
    assert.ok(isTypeAssertion(initializer("<T>x")));
    assert.ok(!isTypeAssertion(initializer("x satisfies T")));
    assert.ok(isTypePreservingWrapper(initializer("(x)")));
    assert.ok(isTypePreservingWrapper(initializer("x satisfies T")));
    assert.ok(!isTypePreservingWrapper(initializer("x!")));
    assert.equal(
        unwrapTypePreserving(initializer("((x as T) satisfies U)")).getText(),
        "x as T",
    );
    assert.ok(isTypeOnlyWrapper(initializer("x!")));
    assert.ok(!isTypeOnlyWrapper(initializer("(x)")));
});

test("wrapper chains list what lies under and around an expression", () => {
    assert.deepEqual(wrappersUnder(initializer("((x as T)!)")).map(kind), [
        "ParenthesizedExpression",
        "NonNullExpression",
        "ParenthesizedExpression",
        "AsExpression",
    ]);
    const file = parse("use(((x satisfies T) as U)!);");
    assert.deepEqual(wrappersAround(identifier(file, "x")).map(kind), [
        "SatisfiesExpression",
        "ParenthesizedExpression",
        "AsExpression",
        "ParenthesizedExpression",
        "NonNullExpression",
    ]);
    // The outermost assertion is the type the value is read as.
    assert.equal(
        wrappersAround(identifier(file, "x"))
            .filter(isTypeAssertion)
            .at(-1)
            ?.getText(),
        "(x satisfies T) as U",
    );
});

test("climbing reaches the consumer, past await only when asked", () => {
    const file = parse("async function f() { use(await (load() as P)); }");
    const call = identifier(file, "load").parent;
    assert.ok(ts.isAwaitExpression(outermostWrapper(call).parent));
    assert.ok(
        ts.isCallExpression(outermostWrapper(call, { await: true }).parent),
    );
});
