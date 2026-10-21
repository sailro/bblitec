import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import {
    declarationNamed,
    isValueReference,
    namesMember,
    referenceSite,
} from "../src/compiler/syntax.js";

/** The texts of the identifiers a test picks, in source order. */
function names(
    source: string,
    pick: (identifier: ts.Identifier) => boolean,
): string[] {
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && pick(node)) found.push(node.text);
        ts.forEachChild(node, visit);
    };
    visit(
        ts.createSourceFile("probe.ts", source, ts.ScriptTarget.Latest, true),
    );
    return found;
}

/** The identifier texts the source reads or writes at run time, in order. */
function references(source: string): string[] {
    return names(source, isValueReference);
}

test("declarations, members and keys name; they do not read", () => {
    assert.deepEqual(
        references("const a = b; function f(p: T) { return p.x; }"),
        ["b", "p"],
    );
    assert.deepEqual(references("const { k: local, other } = source;"), [
        "source",
    ]);
    assert.deepEqual(references("({ k: v, shorthand } = o);"), [
        "v",
        "shorthand",
        "o",
    ]);
    assert.deepEqual(references("const o = { key: value, short };"), [
        "value",
        "short",
    ]);
    assert.deepEqual(
        references(
            "class C extends Base<Arg> implements I { m() { return this.f; } }",
        ),
        ["Base"],
    );
    assert.deepEqual(references("enum E { A = start, B }"), ["start"]);
});

test("labels, meta properties and types are not reads", () => {
    assert.deepEqual(
        references("outer: for (const x of xs) { if (x) break outer; }"),
        ["xs", "x"],
    );
    assert.deepEqual(
        references("function f() { return new.target ?? import.meta; }"),
        [],
    );
    assert.deepEqual(
        references("let n: typeof count = count as Num satisfies Shape;"),
        ["count"],
    );
});

test("imports declare names; local exports read them", () => {
    assert.deepEqual(
        references(
            'import def, { a as b, c } from "m"; import * as ns from "n"; export { local as name, other }; export { re } from "r";',
        ),
        ["local", "other"],
    );
});

test("a name declares, names a member, or reads", () => {
    const source =
        "class C { f = 1; m() {} } const { k: local } = o; const v = { key: a.b, short }; enum E { A }";
    assert.deepEqual(
        names(
            source,
            (identifier) => declarationNamed(identifier) !== undefined,
        ),
        ["C", "f", "m", "local", "v", "key", "E", "A"],
    );
    assert.deepEqual(names(source, namesMember), ["f", "m", "k", "key", "b"]);
    assert.deepEqual(
        names(source, (identifier) => {
            const site = referenceSite(identifier);
            return site !== undefined && site !== identifier;
        }),
        ["b"],
    );
});
