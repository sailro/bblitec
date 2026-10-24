import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { createCompilerProgram } from "../src/compiler/program.js";
import { staticAccessKey, staticPropertyKey } from "../src/compiler/symbols.js";
import {
    accessKey,
    aliasKey,
    ANY_KEY,
    keyIndex,
    keysMayMatch,
    propertyKey,
} from "../src/compiler/syntax.js";

function parse(source: string): ts.SourceFile {
    return ts.createSourceFile(
        "probe.ts",
        source,
        ts.ScriptTarget.Latest,
        true,
    );
}

function find<T extends ts.Node>(
    root: ts.Node,
    is: (node: ts.Node) => node is T,
): T[] {
    const found: T[] = [];
    const visit = (node: ts.Node): void => {
        if (is(node)) found.push(node);
        ts.forEachChild(node, visit);
    };
    visit(root);
    return found;
}

test("a property name declares its ToPropertyKey text", () => {
    const keys = find(
        parse(
            'const o = { a: 0, "b-c": 0, 0x10: 0, 1e21: 0, 1n: 0, [`t`]: 0, ["s"]: 0, [-1]: 0, [true]: 0, [k]: 0 }; class C { #p = 0; }',
        ),
        (node): node is ts.PropertyAssignment | ts.PropertyDeclaration =>
            ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node),
    ).map((member) => propertyKey(member.name));
    assert.deepEqual(keys, [
        "a",
        "b-c",
        "16",
        "1e+21",
        "1",
        "t",
        "s",
        "-1",
        "true",
        undefined,
        "#p",
    ]);
});

test("an access reads its literal key, private names keep their sigil", () => {
    const keys = find(
        parse('o.x; o.#y; o["z"]; o[(2)]; o[-0]; o[i];'),
        (
            node,
        ): node is ts.PropertyAccessExpression | ts.ElementAccessExpression =>
            ts.isPropertyAccessExpression(node) ||
            ts.isElementAccessExpression(node),
    ).map(accessKey);
    assert.deepEqual(keys, ["x", "#y", "z", "2", "0", undefined]);
});

test("an unknown key matches every key; index keys are canonical", () => {
    assert.equal(aliasKey(undefined), ANY_KEY);
    assert.ok(keysMayMatch(ANY_KEY, "x") && !keysMayMatch("x", "y"));
    assert.deepEqual(["2", "02", "-1", "1.5", "", undefined].map(keyIndex), [
        2,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
    ]);
});

test("the checker fixes computed keys a literal type or symbol names", () => {
    const { checker, sourceFile } = createCompilerProgram(
        `
        const KEY = "a";
        const NUM = 3;
        const SYM: unique symbol = Symbol("s");
        declare const any: string;
        const o = { [KEY]: 0, [NUM]: 0, [SYM]: 0, [any]: 0 };
        o[KEY]; o[any];
    `,
        "input.ts",
    );
    const names = find(sourceFile, ts.isComputedPropertyName).map((name) =>
        staticPropertyKey(checker, name),
    );
    assert.deepEqual(names.slice(0, 2), ["a", "3"]);
    assert.ok(names[2]?.startsWith("__@"));
    assert.equal(names[3], undefined);
    const reads = find(sourceFile, ts.isElementAccessExpression).map((access) =>
        staticAccessKey(checker, access),
    );
    assert.deepEqual(reads, ["a", undefined]);
});
