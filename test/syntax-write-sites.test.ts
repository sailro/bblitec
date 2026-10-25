import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { writeSiteOf, writeSites } from "../src/compiler/syntax.js";

function parse(source: string): ts.SourceFile {
    return ts.createSourceFile(
        "probe.ts",
        source,
        ts.ScriptTarget.Latest,
        true,
    );
}

/** Every write site in the source, as `kind target <- stored`. */
function sites(source: string): string[] {
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
        for (const site of writeSites(node))
            found.push(
                `${site.kind} ${site.target.getText()}` +
                    (site.stored ? ` <- ${site.stored.getText()}` : ""),
            );
        ts.forEachChild(node, visit);
    };
    visit(parse(source));
    return found;
}

test("every JavaScript write form is a write site", () => {
    assert.deepEqual(sites("a = f();"), ["assign a <- f()"]);
    assert.deepEqual(sites("(o.p as T) = 1;"), ["assign o.p <- 1"]);
    assert.deepEqual(sites("o[k] += 2;"), ["compound o[k]"]);
    assert.deepEqual(sites("a ??= make();"), ["logical a <- make()"]);
    assert.deepEqual(sites("a ||= b; a &&= c;"), [
        "logical a <- b",
        "logical a <- c",
    ]);
    assert.deepEqual(sites("++i; o.n--;"), ["update i", "update o.n"]);
    assert.deepEqual(sites("delete cache[key];"), ["delete cache[key]"]);
    assert.deepEqual(sites("for (o.k in table) {}"), ["loop o.k"]);
    assert.deepEqual(sites("for (const k in table) {}"), []);
});

test("destructuring writes each leaf with a part of the value", () => {
    assert.deepEqual(sites("[a, , b.c = 1, ...rest] = values;"), [
        "assign a",
        "assign b.c",
        "assign rest",
    ]);
    assert.deepEqual(sites("({ k: o.k, lod, ...others } = rec);"), [
        "assign o.k",
        "assign lod",
        "assign others",
    ]);
    assert.deepEqual(sites("for ([i, row] of rows.entries()) {}"), [
        "loop i",
        "loop row",
    ]);
    // A default nested in a pattern is not an assignment; one in a value is.
    assert.deepEqual(sites("[[x] = [], { k: y = 2 }] = v;"), [
        "assign x",
        "assign y",
    ]);
    assert.deepEqual(sites("use([x = 1]);"), ["assign x <- 1"]);
});

test("an expression knows the site that writes it", () => {
    const file = parse(
        "[(first), second = 0] = pair; ({ lod } = rec); total += step;" +
            " use(lod, first); out.x = v;",
    );
    const written: string[] = [];
    const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
            const site = writeSiteOf(node);
            if (site) written.push(`${node.getText()}:${site.kind}`);
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    // `use(lod, first)` only reads; `out` is the receiver `out.x` writes.
    assert.deepEqual(written, [
        "first:assign",
        "second:assign",
        "lod:assign",
        "total:compound",
        "out.x:assign",
    ]);
});
