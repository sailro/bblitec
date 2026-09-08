/**
 * The loop-control walks, pinned rule by rule: which control statements
 * leave the loop a statement sits in, where descent stops, and what a
 * return search sees. Each case is one shape a lowering distinguishes.
 */
import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import {
    enclosingLoopControl,
    firstReturn,
} from "../src/compiler/loop-control.js";

/** The body of the first `for (;;)` in the snippet. */
function loopBody(body: string): ts.Statement {
    const file = ts.createSourceFile(
        "loop.ts",
        `for (;;) { ${body} }`,
        ts.ScriptTarget.ES2022,
        true,
    );
    const loop = file.statements[0];
    assert.ok(loop && ts.isForStatement(loop));
    return loop.statement;
}

/** The statements of a function body in the snippet. */
function bodyStatements(body: string): readonly ts.Statement[] {
    const file = ts.createSourceFile(
        "body.ts",
        `function f() { ${body} }`,
        ts.ScriptTarget.ES2022,
        true,
    );
    const declaration = file.statements[0];
    assert.ok(declaration && ts.isFunctionDeclaration(declaration) && declaration.body);
    return declaration.body.statements;
}

test("a break or continue in the body is the enclosing loop's control", () => {
    const broken = enclosingLoopControl(loopBody("if (x) break;"));
    assert.ok(broken && ts.isBreakStatement(broken));
    const continued = enclosingLoopControl(loopBody("continue;"));
    assert.ok(continued && ts.isContinueStatement(continued));
});

test("descent stops at a nested loop and at a function-like", () => {
    assert.equal(
        enclosingLoopControl(loopBody("while (y) { break; }")),
        undefined,
    );
    assert.equal(
        enclosingLoopControl(loopBody("for (const a of b) continue;")),
        undefined,
    );
    assert.equal(
        enclosingLoopControl(loopBody("const f = () => { break; };")),
        undefined,
    );
});

test("a switch hides an unqualified break but not a continue", () => {
    assert.equal(
        enclosingLoopControl(loopBody("switch (x) { case 1: break; }")),
        undefined,
    );
    const continued = enclosingLoopControl(
        loopBody("switch (x) { case 1: continue; }"),
    );
    assert.ok(continued && ts.isContinueStatement(continued));
    // A labeled break inside a switch is not counted either.
    assert.equal(
        enclosingLoopControl(loopBody("switch (x) { case 1: break outer; }")),
        undefined,
    );
    // Starting inside a switch applies the same rule to the root.
    assert.equal(
        enclosingLoopControl(loopBody("break;"), { insideSwitch: true }),
        undefined,
    );
});

test("labeled forms count unless the query excludes them", () => {
    const body = loopBody("if (x) break outer;");
    assert.ok(enclosingLoopControl(body));
    assert.equal(enclosingLoopControl(body, { labeled: false }), undefined);
    const continued = loopBody("continue outer;");
    assert.ok(enclosingLoopControl(continued));
    assert.equal(
        enclosingLoopControl(continued, { labeled: false }),
        undefined,
    );
});

test("the query selects which statements count", () => {
    const continued = loopBody("continue;");
    assert.equal(
        enclosingLoopControl(continued, { continues: false }),
        undefined,
    );
    const broken = loopBody("break;");
    assert.equal(enclosingLoopControl(broken, { breaks: false }), undefined);
    const returned = loopBody("return 1;");
    assert.equal(enclosingLoopControl(returned), undefined);
    const control = enclosingLoopControl(returned, { returns: true });
    assert.ok(control && ts.isReturnStatement(control));
});

test("the first control statement in source order comes back", () => {
    const control = enclosingLoopControl(
        loopBody("if (x) { continue; } break;"),
    );
    assert.ok(control && ts.isContinueStatement(control));
});

test("a return search descends loops and switches but not functions", () => {
    const nested = bodyStatements("while (x) { switch (y) { case 1: return 2; } }");
    const found = firstReturn(nested);
    assert.ok(found && found.expression && ts.isNumericLiteral(found.expression));
    assert.equal(
        firstReturn(bodyStatements("const g = () => { return 1; };")),
        undefined,
    );
    assert.equal(
        firstReturn(bodyStatements("function inner() { return 1; }")),
        undefined,
    );
});

test("a valued return search skips a bare return", () => {
    const bare = bodyStatements("if (x) return;");
    assert.ok(firstReturn(bare));
    assert.equal(firstReturn(bare, { valued: true }), undefined);
    const valued = bodyStatements("if (x) return; return 3;");
    const found = firstReturn(valued, { valued: true });
    assert.ok(found?.expression && ts.isNumericLiteral(found.expression));
    assert.equal(found.expression.text, "3");
});

test("a return search over several roots reads them in order", () => {
    const statements = bodyStatements("a(); if (x) return 1; return 2;");
    const found = firstReturn(statements.slice(0, -1));
    assert.ok(found?.expression && ts.isNumericLiteral(found.expression));
    assert.equal(found.expression.text, "1");
    assert.equal(firstReturn(statements.slice(0, 1)), undefined);
});
