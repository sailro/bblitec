import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { ClassHierarchy } from "../src/compiler/class-members.js";
import { EvaluationOrder } from "../src/compiler/evaluation-order.js";
import { createCompilerProgram } from "../src/compiler/program.js";

function analysis(source: string) {
    const frontend = createCompilerProgram(
        source,
        resolve("module-effect-analysis.ts"),
    );
    const order = new EvaluationOrder(
        frontend.checker,
        new ClassHierarchy(frontend.checker, frontend.program),
    );
    const initializers = frontend.sourceFile.statements.flatMap((statement) =>
        ts.isVariableStatement(statement)
            ? statement.declarationList.declarations.flatMap((declaration) =>
                  declaration.initializer ? [declaration.initializer] : [],
              )
            : [],
    );
    return { ...frontend, order, initializers };
}

test("module effects retain source callbacks, defaults, accessors and conservative cycles across roots", () => {
    const cases = [
        ["local(2)", false],
        ["new Local()", false],
        ["defaulted()", true],
        ["new Host()", true],
        ["observed()", true],
        ["failing()", true],
        ["recursive(2)", true],
        ["mutualLeft(2)", true],
        ["mutualRight(2)", true],
        ["unknown(() => 1)", true],
        ["callback()", true],
        ["bounded()", true],
    ] as const;
    const source = `
        function scalar(value:number):number { return value + 1; }
        function local(value:number):number {
            const values = [value];
            values.push(2);
            return values.map(scalar).reduce((sum, item) => sum + item, 0);
        }
        class Local { value = local(3); }
        function defaulted(value = Date.now()):number { return value; }
        class Host { value = defaulted(); }
        function observed():number {
            const owner = {get value():number { return 1; }};
            return owner.value;
        }
        function failing():number { throw new Error('reached'); }
        function recursive(n:number):number { return n ? recursive(n-1) : 0; }
        function mutualLeft(n:number):number { return n ? mutualRight(n-1) : 0; }
        function mutualRight(n:number):number { return n ? mutualLeft(n-1) : 0; }
        function unknown(callback:()=>number):number { return callback(); }
        function callback():number[] { return [1].map(() => failing()); }
        function bounded():number { let n=1; while(n>0) n--; return n; }
        ${[...cases, ...[...cases].reverse()]
            .map(
                ([expression], index) =>
                    `const result${index} = ${expression};`,
            )
            .join("\n")}
    `;
    const { order, initializers } = analysis(source);
    assert.deepEqual(
        initializers.map((node) => order.hasModuleEffects(node)),
        [...cases, ...[...cases].reverse()].map(([, expected]) => expected),
    );
});

test("module effect roots share callee checker work and existing direct access summaries", (t) => {
    const source = `
        function leaf(value:number):number { return Math.abs(value); }
        function middle(value:number):number { return leaf(value) + leaf(value + 1); }
        function shared(value:number):number {
            const values = [middle(value)];
            values.push(2);
            return values.map(leaf).reduce((sum, item) => sum + item, 0);
        }
        ${Array.from({ length: 32 }, (_, index) => `const result${index} = shared(${index});`).join("\n")}
    `;
    const { order, checker, initializers } = analysis(source);
    const reads = t.mock.method(checker, "getResolvedSignature");
    // Other evaluation-order clients may already have filled directAccess.
    order.touchesStorage(initializers[0]!);
    assert.equal(order.hasModuleEffects(initializers[0]!), false);
    const bodyCalls = () =>
        reads.mock.calls.filter(
            ({ arguments: [node] }) => node.end < initializers[0]!.pos,
        ).length;
    const first = bodyCalls();
    assert.ok(first > 0);
    for (const initializer of initializers)
        assert.equal(order.hasModuleEffects(initializer), false);
    assert.equal(
        bodyCalls(),
        first,
        "distinct initializers must not repeat shared callee analysis",
    );
});
