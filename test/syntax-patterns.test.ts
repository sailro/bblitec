import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import {
    arrayLiteralSlots,
    bindingElementKey,
    patternSlots,
    specifierSourceName,
    type PatternSlot,
} from "../src/compiler/syntax.js";

function parse(source: string): ts.SourceFile {
    return ts.createSourceFile(
        "probe.ts",
        source,
        ts.ScriptTarget.Latest,
        true,
    );
}

function first<T extends ts.Node>(
    root: ts.Node,
    is: (node: ts.Node) => node is T,
): T {
    let found: T | undefined;
    const visit = (node: ts.Node): void => {
        if (!found && is(node)) found = node;
        if (!found) ts.forEachChild(node, visit);
    };
    visit(root);
    assert.ok(found);
    return found;
}

/** Each slot as `target <- read [= fallback]`. */
function describe(slots: readonly PatternSlot[]): string[] {
    return slots.map(({ target, read, fallback }) => {
        const taken =
            read.kind === "member"
                ? `[${read.key ?? "?"}]`
                : read.kind === "rest"
                  ? `rest-${read.excluded?.join(",") ?? "?"}`
                  : `rest-from-${read.index}`;
        return `${target.getText()} <- ${taken}${fallback ? ` = ${fallback.getText()}` : ""}`;
    });
}

test("array literal slots lose their index from the first spread on", () => {
    const literal = first(
        parse("[1, , 3, ...xs, 5];"),
        ts.isArrayLiteralExpression,
    );
    assert.deepEqual(
        arrayLiteralSlots(literal).map((slot) => slot.index),
        [0, 1, 2, undefined, undefined],
    );
});

test("binding and assignment patterns read the same slots", () => {
    const binding = first(
        parse('const { a, b: c = 1, "d-e": f, [k]: g, ...rest } = o;'),
        ts.isObjectBindingPattern,
    );
    assert.deepEqual(describe(patternSlots(binding)), [
        "a <- [a]",
        "c <- [b] = 1",
        "f <- [d-e]",
        "g <- [?]",
        "rest <- rest-?",
    ]);
    const assignment = first(
        parse("({ a, b: o.c = 1, ...rest } = v);"),
        ts.isObjectLiteralExpression,
    );
    assert.deepEqual(describe(patternSlots(assignment)), [
        "a <- [a]",
        "o.c <- [b] = 1",
        "rest <- rest-a,b",
    ]);
    const array = first(
        parse("[x, , y = 2, ...tail] = v;"),
        ts.isArrayLiteralExpression,
    );
    assert.deepEqual(describe(patternSlots(array)), [
        "x <- [0]",
        "y <- [2] = 2",
        "tail <- rest-from-3",
    ]);
});

test("binding element keys and specifier source names", () => {
    const element = first(parse("const { 1: one } = o;"), ts.isBindingElement);
    assert.equal(bindingElementKey(element), "1");
    const source = parse(
        'import { a as b } from "m"; export { local as name }; export { c } from "n";',
    );
    const names: string[] = [];
    const visit = (node: ts.Node): void => {
        if (ts.isImportSpecifier(node) || ts.isExportSpecifier(node))
            names.push(specifierSourceName(node));
        ts.forEachChild(node, visit);
    };
    visit(source);
    assert.deepEqual(names, ["a", "local", "c"]);
});
