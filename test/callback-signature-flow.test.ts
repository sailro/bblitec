import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { createCompilerProgram } from "../src/compiler/program.js";
import { EmissionTransaction } from "../src/compiler/emission-transaction.js";
import { FunctionStorageFlow } from "../src/compiler/function-storage-flow.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const source = `
    let score = 0;
    const close = (immediate = false): void => { score += immediate ? 10 : 1; };
    const callbacks: Array<() => void> = [close];
    callbacks[0]!(); close(true);
    const ignores: () => void = () => { score++; };
    const withArgument: Array<(value: number) => void> = [ignores];
    withArgument[0]!(5);
    if (score !== 12) throw new Error('independent callable contracts');

    function callWide(f: (a: number, b: number) => number): number { return f(1, 2); }
    const narrow: Array<(a: number) => number> = [(a) => a];
    const first = callWide(narrow[0]!);
    const later: Array<(a: number) => number> = [(a, b = 7) => a + b];
    if (first + later[0]!(1) !== 9) throw new Error('independent native signatures');

    let order = '';
    function value(label: string, n: number): number { order += label; return n; }
    const identity = (n: number): number => n;
    const declared: Array<(a: number) => number> = [identity];
    const widened: Array<(a: number, b: number) => number> = [declared[0]!];
    if (widened[0]!(value('a', 3), value('b', 4)) !== 3 || order !== 'ab')
        throw new Error('ignored argument evaluation');
`;

function checked(source: string): void {
    const { program } = createCompilerProgram(source, "entry.ts");
    assert.deepEqual(
        ts
            .getPreEmitDiagnostics(program)
            .map((diagnostic) =>
                ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
            ),
        [],
    );
}

test("unrelated callback contracts can share a native signature", () => {
    checked(source);
    runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
    );
    compileSource(source);
});

test(
    "native unrelated callbacks preserve defaults and extra argument effects",
    { skip: !optionalNativeFixtureTools() },
    () => {
        runGeneratedProgram(
            optionalNativeFixtureTools()!,
            "callback-signature-flow",
            compileSource(source).cpp,
        );
    },
);

const transports = [
    "const carried = narrow;",
    "const carried: Array<(a: number) => number> = narrow;",
    `const box: {values: Array<(a: number) => number>} = {values: narrow};
     const other: {values: Array<(a: number) => number>} = box;
     const carried = other.values;`,
    `function relay(value: (a: number) => number): (a: number) => number { return value; }
     const relays: Array<typeof relay> = [relay];
     const carried = [relays[0]!(narrow[0]!)];`,
    `const factories: Array<() => ((a: number) => number)> = [() => narrow[0]!];
     const carried = [factories[0]!()];`,
    `const records = new Map<string, (a: number) => number>([['entry', narrow[0]!]]);
     const carried = [records.get('entry')!];`,
];

test("callback flows refuse arguments lost across equal signatures and nested storage", () => {
    for (const transport of transports) {
        const input = `
            const narrow: Array<(a: number) => number> = [(a, b = 7) => a + b];
            ${transport}
            const wide: Array<(a: number, b: number) => number> = [carried[0]!];
            if (wide[0]!(1, 2) !== 3) throw new Error('lost argument');
        `;
        checked(input);
        assert.throws(
            () => compileSource(input),
            /reading arguments past its storage signature/,
        );
    }
    const late = `
        function widen(value: (a: number) => number): number {
            const held: Array<(a: number, b: number) => number> = [value];
            return held[0]!(1, 2);
        }
        const wideners: Array<typeof widen> = [widen];
        const source: Array<(a: number) => number> = [(a, b = 7) => a + b];
        if (wideners[0]!(source[0]!) !== 3) throw new Error('late connection');
    `;
    checked(late);
    assert.throws(
        () => compileSource(late),
        /reading arguments past its storage signature/,
    );
});

test("callback flow conflicts survive late links while declined probes leave no links or notes", () => {
    const flow = new FunctionStorageFlow();
    const left = { signatureSite: "left", abi: "narrow" };
    const right = { signatureSite: "right", abi: "narrow" };
    assert.equal(flow.note(left, "reads"), true);
    assert.equal(flow.note(right, "passes"), true);
    const probe = new EmissionTransaction();
    assert.equal(flow.connect(left, right), false);
    probe.finish(false);
    assert.equal(
        flow.connect(left, { signatureSite: "third", abi: "narrow" }),
        true,
    );
    const unknownProbe = new EmissionTransaction();
    assert.equal(flow.note({ abi: "narrow" }, "reads"), false);
    unknownProbe.finish(false);
    assert.equal(flow.note(right, "passes"), true);
    assert.equal(
        flow.note({ signatureSite: "left", abi: "wide" }, "passes"),
        true,
    );
    assert.equal(flow.connect(left, right), false);
    const conservative = new FunctionStorageFlow();
    assert.equal(conservative.note({ abi: "narrow" }, "reads"), true);
    assert.equal(conservative.note(right, "passes"), false);
});
