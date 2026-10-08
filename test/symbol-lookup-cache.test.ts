import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { createCompilerProgram } from "../src/compiler/program.js";
import {
    aliasTarget,
    CompilerSymbols,
    declaredSymbol,
    resolvedSymbol,
} from "../src/compiler/symbols.js";

function nodes(root: ts.Node): ts.Node[] {
    const result: ts.Node[] = [];
    const visit = (node: ts.Node): void => {
        result.push(node);
        ts.forEachChild(node, visit);
    };
    visit(root);
    return result;
}

function checked(source: string) {
    const fileName = resolve("artifacts/symbol-lookup-cache.ts");
    const { program } = createCompilerProgram(source, fileName);
    return {
        checker: program.getTypeChecker(),
        source: program.getSourceFile(fileName)!,
    };
}

test("cached declared symbols preserve lexical, shorthand, member and alias identity", () => {
    const { checker, source } = checked(`
        import { createEngine as boot } from '@babylonjs/lite';
        import * as api from '@babylonjs/lite';
        const value = 1;
        const record = { value, own: 2 };
        function read(value: number) { return value + record.own; }
        namespace M { export const member = 3; }
        namespace M { export const other = member; }
        import renamed = M.member;
        class Box { constructor(public value: number) { value++; this.value = value; } }
        Math.floor(value); read(value); api.createEngine; boot; renamed;
        typeof missing;
    `);
    const all = nodes(source);
    const expected = all.map((node) =>
        node.parent &&
        ts.isShorthandPropertyAssignment(node.parent) &&
        node.parent.name === node
            ? checker.getShorthandAssignmentValueSymbol(node.parent)
            : checker.getSymbolAtLocation(node),
    );
    for (let pass = 0; pass < 3; pass++) {
        all.forEach((node, index) => {
            assert.equal(declaredSymbol(checker, node), expected[index]);
        });
    }
    const shorthand = all.find(ts.isShorthandPropertyAssignment)!;
    const declaration = all.find(
        (node): node is ts.VariableDeclaration =>
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.name.text === "value",
    )!;
    assert.equal(
        declaredSymbol(checker, shorthand.name),
        declaredSymbol(checker, declaration.name),
    );
    const imported = all.find((node): node is ts.ImportSpecifier =>
        ts.isImportSpecifier(node),
    )!;
    const alias = declaredSymbol(checker, imported.name)!;
    assert.ok(alias.flags & ts.SymbolFlags.Alias);
    assert.notEqual(alias, resolvedSymbol(checker, imported.name));
    assert.equal(
        aliasTarget(checker, alias),
        resolvedSymbol(checker, imported.name),
    );
    const parameter = all.find(
        (node): node is ts.ParameterDeclaration =>
            ts.isParameter(node) &&
            ts.isParameterPropertyDeclaration(node, node.parent),
    )!;
    const symbols = new CompilerSymbols(checker);
    for (const node of nodes(parameter.parent)) {
        if (ts.isIdentifier(node) && node.text === "value") {
            assert.equal(
                symbols.valueSymbol(node),
                declaredSymbol(checker, parameter.name),
            );
        }
    }
});

test("parsed symbol misses are reused and factory nodes with copied ranges are not", () => {
    const { checker, source } = checked(
        "const present = 1; present; typeof missing;",
    );
    const missing = nodes(source).find(
        (node): node is ts.Identifier =>
            ts.isIdentifier(node) && node.text === "missing",
    )!;
    const original = checker.getSymbolAtLocation.bind(checker);
    let calls = 0;
    checker.getSymbolAtLocation = (node) => {
        calls++;
        return original(node);
    };
    try {
        assert.equal(declaredSymbol(checker, missing), undefined);
        assert.equal(declaredSymbol(checker, missing), undefined);
        assert.equal(calls, 1);
        const clone = ts.setOriginalNode(
            ts.setTextRange(ts.factory.createIdentifier("missing"), missing),
            missing,
        );
        assert.equal(declaredSymbol(checker, clone), original(clone));
        assert.equal(declaredSymbol(checker, clone), original(clone));
        assert.equal(calls, 3);
    } finally {
        checker.getSymbolAtLocation = original;
    }
});

test("symbol reuse never crosses checker ownership", () => {
    const first = checked("const value = 1; value;");
    const second = checked("const value = 1; value;");
    const firstName = nodes(first.source).find(ts.isIdentifier)!;
    const secondName = nodes(second.source).find(ts.isIdentifier)!;
    const firstExpected = first.checker.getSymbolAtLocation(firstName);
    const secondExpected = second.checker.getSymbolAtLocation(secondName);
    assert.ok(firstExpected);
    assert.ok(secondExpected);
    assert.notEqual(firstExpected, secondExpected);
    assert.equal(declaredSymbol(first.checker, firstName), firstExpected);
    assert.equal(declaredSymbol(second.checker, secondName), secondExpected);
    // Use the same node with a second reader to prove the cache is checker-scoped.
    let calls = 0;
    const original = second.checker.getSymbolAtLocation.bind(second.checker);
    second.checker.getSymbolAtLocation = (node) => {
        calls++;
        return original(node);
    };
    try {
        const expected = original(firstName);
        assert.equal(declaredSymbol(second.checker, firstName), expected);
        assert.equal(declaredSymbol(second.checker, firstName), expected);
        assert.equal(calls, 1);
    } finally {
        second.checker.getSymbolAtLocation = original;
    }
});
