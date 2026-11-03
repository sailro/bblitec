import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    isProtoSetter,
    lastWriter,
    literalDataKeys,
    literalPropertyValues,
    objectLiteralMembers,
    objectProperty,
    plainDataMembers,
} from "../src/compiler/syntax.js";

function literal(source: string): ts.ObjectLiteralExpression {
    let found: ts.ObjectLiteralExpression | undefined;
    const visit = (node: ts.Node): void => {
        if (!found && ts.isObjectLiteralExpression(node)) found = node;
        if (!found) ts.forEachChild(node, visit);
    };
    visit(
        ts.createSourceFile("probe.ts", source, ts.ScriptTarget.Latest, true),
    );
    assert.ok(found);
    return found;
}

/** What decides `key`: the writer's text, "unknown" or "absent". */
function decides(source: string, key: string): string {
    const writer = lastWriter(objectLiteralMembers(literal(source)), key);
    return writer === "unknown"
        ? "unknown"
        : writer === undefined
          ? "absent"
          : writer.node.getText();
}

test("the last writer decides a key; a later spread or run-time key may", () => {
    assert.equal(decides("({ a: 1, a: 2 })", "a"), "a: 2");
    assert.equal(decides("({ ...base, a: 1 })", "a"), "a: 1");
    assert.equal(decides("({ a: 1, ...dyn })", "a"), "unknown");
    assert.equal(decides("({ a: 1, [k]: 2 })", "a"), "unknown");
    assert.equal(decides('({ a: 1, ["a"]: 2 })', "a"), '["a"]: 2');
    assert.equal(decides("({ b: 1 })", "a"), "absent");
    assert.equal(decides("({ a() { return 1; } })", "a"), "a() { return 1; }");
    assert.equal(objectProperty(literal("({ a: 1, ...dyn })"), "a"), undefined);
});

/** The texts a key can take through literal spreads, and whether one is always written. */
function values(source: string, key: string): string {
    const found = literalPropertyValues(literal(source), key);
    return found === undefined
        ? "unknown"
        : `${found.values.map((value) => value.getText()).join(" | ")}${found.definite ? "" : " (maybe)"}`;
}

test("a key's values follow spreads of literals and their conditional arms", () => {
    assert.equal(values("({ a: 1, ...(c ? { a: 2 } : {}) })", "a"), "1 | 2");
    assert.equal(
        values("({ ...(c ? { a: { x: 1 } } : null) })", "a"),
        "{ x: 1 } (maybe)",
    );
    assert.equal(
        values("({ a: 1, ...(c ? { a: 2 } : { a: 3 }) })", "a"),
        "2 | 3",
    );
    assert.equal(values("({ ...{ a: 1 }, a: 4 })", "a"), "4");
    // A falsy operand spreads nothing.
    assert.equal(values("({ a: 1, ...(c && { a: 2 }) })", "a"), "1 | 2");
    assert.equal(values("({ ...(c || { a: 2 }) })", "a"), "unknown");
    assert.equal(values("({ ...(c ? { b: 1 } : null) })", "a"), " (maybe)");
    // Anything else a spread or member could write stays unknown.
    assert.equal(values("({ a: 1, ...(c ? base : {}) })", "a"), "unknown");
    assert.equal(values("({ a: 1, get b() { return 2; } })", "a"), "unknown");
    assert.deepEqual(
        literalDataKeys(literal("({ a: 1, ...(c ? { b: 2 } : {}), d })")),
        ["a", "b", "d"],
    );
    assert.equal(literalDataKeys(literal("({ a: 1, [k]: 2 })")), undefined);
});

test("__proto__: v sets the prototype; other spellings are own keys", () => {
    const members = objectLiteralMembers(
        literal(
            '({ __proto__: p, "__proto__": q, ["__proto__"]: r, __proto__ })',
        ),
    );
    assert.deepEqual(
        members.map((member) => member.kind),
        ["proto", "proto", "property", "shorthand"],
    );
    assert.ok(!isProtoSetter(members[2]!.node));
    assert.equal(
        plainDataMembers(literal("({ __proto__: p, a: 1 })")),
        undefined,
    );
    assert.deepEqual(
        plainDataMembers(literal("({ a: 1, b })"))?.map((member) => member.key),
        ["a", "b"],
    );
});

test("a literal that sets its prototype is refused, not read as own data", () => {
    assert.throws(
        () =>
            compileSource(`
                const proto = { shared: 3 };
                const o: { shared?: number; own: number } = { __proto__: proto, own: 1 } as never;
                if (o.shared !== 3) throw new Error("inherited");
            `),
        /Setting a literal's prototype/,
    );
});
