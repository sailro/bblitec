import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { sameSource } from "../src/compiler/syntax.js";

function declaration(source: string): ts.VariableDeclaration {
    const statement = ts.createSourceFile(
        "probe.ts",
        source,
        ts.ScriptTarget.Latest,
        true,
    ).statements[0];
    assert.ok(statement && ts.isVariableStatement(statement));
    const found = statement.declarationList.declarations[0];
    assert.ok(found);
    return found;
}

test("sameSource reads an expression through wrappers and layout", () => {
    const value = declaration(
        "const probe = (engine! . _dlr /* note */)?.m(1, `x`);",
    ).initializer!;
    assert.ok(sameSource(value, "engine._dlr?.m(1, `x`)"));
    assert.ok(sameSource(value, "(engine._dlr)?.m(1.0, `x`)"));
    assert.ok(sameSource(value, "engine._dlr?.m(1, 'x')"));
    assert.ok(!sameSource(value, "engine._dlr.m(1, `x`)"));
    assert.ok(!sameSource(value, "engine._dlr?.m(2, `x`)"));
    assert.ok(!sameSource(value, "engine._dlr?.n(1, `x`)"));
});

test("sameSource tells operators, names, types and patterns apart", () => {
    assert.ok(
        sameSource(declaration("const probe = -a + b;").initializer, "-a + b"),
    );
    assert.ok(
        !sameSource(declaration("const probe = -a + b;").initializer, "+a + b"),
    );
    assert.ok(
        !sameSource(declaration("const probe = a - b;").initializer, "a + b"),
    );
    const typed = declaration("let probe: any | null;");
    assert.ok(sameSource(typed.type, "any | null"));
    assert.ok(!sameSource(typed.type, "any | undefined"));
    assert.ok(sameSource(typed.name, "probe"));
    const pattern = declaration("const [w, h] = size;");
    assert.ok(sameSource(pattern.name, "[w, h]"));
    assert.ok(!sameSource(pattern.name, "[h, w]"));
    assert.ok(!sameSource(undefined, "x"));
});
