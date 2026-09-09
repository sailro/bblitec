import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { findAnalysisNode, forEachAnalysisNode, someAnalysisNode } from "../src/compiler/analysis-walk.js";
import { isNeverResized } from "../src/compiler/data-lowering.js";
import { enclosingLoopControl, firstReturn, forEachReturn } from "../src/compiler/loop-control.js";
import { createCompilerProgram } from "../src/compiler/program.js";
import { parameterIsMutated, parameterIsReadOnly } from "../src/compiler/user-functions.js";

function parse(source: string): ts.SourceFile {
    return ts.createSourceFile("analysis.ts", source, ts.ScriptTarget.Latest, true);
}

test("analysis boundaries distinguish nested returns, loop exits and switch exits", () => {
    const source = parse(`function owner() {
        const nested = () => { return 1; };
        switch (kind) { case 0: break; case 1: continue; }
        for (;;) { if (done) return 2; break; }
        if (ready) return 3;
    }`);
    const owner = source.statements[0];
    assert.ok(owner && ts.isFunctionDeclaration(owner) && owner.body);
    const control = enclosingLoopControl(owner.body);
    assert.ok(control && ts.isContinueStatement(control));
    assert.equal(enclosingLoopControl(owner.body, { continues: false }), undefined);
    assert.equal(firstReturn([owner.body])?.expression?.getText(source), "2");
    const returns: Array<[string | undefined, boolean]> = [];
    forEachReturn([owner.body], (node, inside) => returns.push([node.expression?.getText(source), inside]));
    assert.deepEqual(returns, [["2", true], ["3", false]]);
});

test("value scans skip type annotations and member names, and stop at the first match", () => {
    const source = parse("const value: Hidden = owner.Hidden; visible(); later();");
    const identifier = (name: string) => (node: ts.Node) => ts.isIdentifier(node) && node.text === name;
    assert.equal(someAnalysisNode(source, identifier("Hidden")), true);
    assert.equal(someAnalysisNode(source, identifier("Hidden"), { types: "skip", memberNames: "skip" }), false);
    let calls = 0;
    const first = findAnalysisNode(source, node => {
        if (!ts.isCallExpression(node)) return false;
        calls += 1;
        return true;
    });
    assert.equal(first?.getText(source), "visible()");
    assert.equal(calls, 1);
});

test("length facts use binding symbols across shadowed names, writes and escaping arguments", () => {
    const { checker, sourceFile } = createCompilerProgram(`
        function first() { const values = [1, 2]; values[0] = 3; return values.length; }
        function second() { const values = [1, 2]; values.push(3); return values.length; }
        function third() { const values = [1, 2]; values.length = 0; return values.length; }
        function fourth() { const values = [1, 2]; consume({ values }); return values.length; }
        declare function consume(input: { values: number[] }): void;
    `, "test/analysis-length.ts");
    const facts: boolean[] = [];
    forEachAnalysisNode(sourceFile, node => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "values") {
            facts.push(isNeverResized(checker, node.name));
        }
    });
    assert.deepEqual(facts, [true, false, false, false]);
});

test("mutation analysis follows aliases and callees without confusing shadowed parameters", () => {
    const { checker, sourceFile } = createCompilerProgram(`
        function quiet(value: number[]) {
            function local(value: number[]) { value.push(9); }
            local([]);
            return value[0];
        }
        function write(value: number[]) {
            const alias = value;
            function append(target: number[]) { target.push(9); }
            append(alias);
        }
    `, "test/analysis-mutation.ts");
    const functions = sourceFile.statements.filter(ts.isFunctionDeclaration);
    const facts = functions.map(fn => {
        const parameter = fn.parameters[0]?.name;
        assert.ok(parameter && ts.isIdentifier(parameter));
        return [parameterIsReadOnly(checker, fn, parameter), parameterIsMutated(checker, fn, parameter)];
    });
    assert.deepEqual(facts, [[true, false], [false, true]]);
});

test("an unused catch binding stays erased when a nested function shadows its name", () => {
    assert.doesNotThrow(() => compileSource(`
        import { createEngine } from "@babylonjs/lite";
        const engine = await createEngine({});
        try { console.log("ready"); } catch (error) {
            function add(error: number) { return error + 1; }
            const result = add(2);
        }
    `));
});
