import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { createCompilerProgram } from "../src/compiler/program.js";
import { parameterInput } from "../src/compiler/symbols.js";
import { forEachAnalysisNode } from "../src/compiler/analysis-walk.js";
import {
    argumentForParameter,
    isModuleScopeFunction,
    parameterForArgument,
    positionalParameter,
    requiredParameterCount,
} from "../src/compiler/syntax.js";

function program(source: string): {
    checker: ts.TypeChecker;
    fn: ts.FunctionDeclaration;
    calls: ts.CallExpression[];
} {
    const { checker, sourceFile } = createCompilerProgram(source, "input.ts");
    const fn = sourceFile.statements.find(ts.isFunctionDeclaration)!;
    const calls = sourceFile.statements.flatMap((statement) =>
        ts.isExpressionStatement(statement) &&
        ts.isCallExpression(statement.expression)
            ? [statement.expression]
            : [],
    );
    return { checker, fn, calls };
}

/** Each input as text: the argument, rest, default or unknown. */
function inputs(
    describe: (index: number) => ReturnType<typeof argumentForParameter>,
    count: number,
): string[] {
    return Array.from({ length: count }, (_, index) => {
        const input = describe(index);
        return input.kind === "argument"
            ? input.argument.getText()
            : input.kind === "rest"
              ? `rest(${input.arguments.map((node) => node.getText()).join(",")})`
              : input.kind === "default"
                ? `default(${input.initializer?.getText() ?? ""})`
                : "unknown";
    });
}

test("a required parameter after a default still needs its argument", () => {
    const { fn } = program(
        "function f(a = 1, b: number, c?: number, ...d: number[]) {}",
    );
    assert.equal(requiredParameterCount(fn.parameters), 2);
});

test("arguments bind parameters as JavaScript does", () => {
    const { checker, fn, calls } = program(`
        function f(a: number, b = 2, ...rest: number[]): void {}
        declare const pre: [number];
        f(1);
        f(1, undefined, 3, 4);
        f(...pre, 5);
    `);
    assert.deepEqual(
        inputs((index) => argumentForParameter(calls[0]!, fn, index), 3),
        ["1", "default(2)", "rest()"],
    );
    assert.deepEqual(
        inputs((index) => parameterInput(checker, calls[1]!, fn, index), 3),
        ["1", "default(2)", "rest(3,4)"],
    );
    assert.deepEqual(
        inputs((index) => argumentForParameter(calls[2]!, fn, index), 3),
        ["unknown", "unknown", "unknown"],
    );
    assert.equal(parameterForArgument(calls[2]!, fn, 1), "unknown");
    const rest = parameterForArgument(calls[1]!, fn, 3);
    assert.ok(rest !== "unknown" && rest?.rest);
    assert.equal(positionalParameter(calls[1]!, fn, 3), undefined);
    assert.equal(positionalParameter(calls[1]!, fn, 1)?.name.getText(), "b");
});

test("a module's own function is a statement or the literal its const holds", () => {
    const { sourceFile } = createCompilerProgram(
        `
        function statement(): void {
            function nested(): void {}
            const local = (): void => {};
            nested();
            local();
        }
        const arrow = (): number => 1;
        const asserted = (function (): number { return 2; }) as () => number;
        let rebindable = (): number => 3;
        const held = [(): number => 4];
    `,
        "input.ts",
    );
    const owned: string[] = [];
    forEachAnalysisNode(sourceFile, (node) => {
        if (!ts.isFunctionLike(node) || !isModuleScopeFunction(node)) return;
        const binding = ts.isFunctionDeclaration(node)
            ? node
            : ts.findAncestor(node, ts.isVariableDeclaration);
        owned.push(binding?.name?.getText() ?? "");
    });
    assert.deepEqual(owned, ["statement", "arrow", "asserted"]);
});
