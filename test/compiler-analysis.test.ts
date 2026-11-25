import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    findAnalysisNode,
    forEachAnalysisNode,
    someAnalysisNode,
} from "../src/compiler/analysis-walk.js";
import { isNeverResized } from "../src/compiler/data-lowering.js";
import { foldMathCall, MATH_MEMBERS } from "../src/compiler/math-intrinsics.js";
import {
    enclosingLoopControl,
    firstReturn,
    forEachReturn,
} from "../src/compiler/loop-control.js";
import { createCompilerProgram } from "../src/compiler/program.js";
import {
    oneObjectObservation,
    rebuiltObjectObservation,
} from "../src/compiler/record-observations.js";
import {
    bindingSubtreeIntact,
    parameterIsMutated,
    parameterIsReadOnly,
} from "../src/compiler/parameter-effects.js";

function parse(source: string): ts.SourceFile {
    return ts.createSourceFile(
        "analysis.ts",
        source,
        ts.ScriptTarget.Latest,
        true,
    );
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
    assert.equal(
        enclosingLoopControl(owner.body, { continues: false }),
        undefined,
    );
    assert.equal(firstReturn([owner.body])?.expression?.getText(source), "2");
    const returns: Array<[string | undefined, boolean]> = [];
    forEachReturn([owner.body], (node, inside) =>
        returns.push([node.expression?.getText(source), inside]),
    );
    assert.deepEqual(returns, [
        ["2", true],
        ["3", false],
    ]);
});

test("value scans skip type annotations and member names, and stop at the first match", () => {
    const source = parse(
        "const value: Hidden = owner.Hidden; visible(); later();",
    );
    const identifier = (name: string) => (node: ts.Node) =>
        ts.isIdentifier(node) && node.text === name;
    assert.equal(someAnalysisNode(source, identifier("Hidden")), true);
    assert.equal(
        someAnalysisNode(source, identifier("Hidden"), {
            types: "skip",
            names: "references",
        }),
        false,
    );
    // Only references: neither the declared name nor a key is one.
    assert.equal(
        someAnalysisNode(
            parse("const value = { value: 1 }; use({ value: other });"),
            identifier("value"),
            { names: "references" },
        ),
        false,
    );
    // A declared name handed in as the root is the walk's subject.
    const declared = parse("const later = 1;").statements[0]!;
    assert.ok(ts.isVariableStatement(declared));
    const name = declared.declarationList.declarations[0]!.name;
    assert.equal(
        someAnalysisNode(name, identifier("later"), { names: "references" }),
        true,
    );
    let calls = 0;
    const first = findAnalysisNode(source, (node) => {
        if (!ts.isCallExpression(node)) return false;
        calls += 1;
        return true;
    });
    assert.equal(first?.getText(source), "visible()");
    assert.equal(calls, 1);
});

test("length facts use binding symbols across shadowed names, writes, aliases and escapes", () => {
    const { checker, sourceFile } = createCompilerProgram(
        `
        function first() { const values = [1, 2]; values[0] = 3; return values.length; }
        function second() { const values = [1, 2]; values.push(3); return values.length; }
        function third() { const values = [1, 2]; values.length = 0; return values.length; }
        function fourth() { const values = [1, 2]; consume({ values }); return values.length; }
        function fifth() { const values = [1, 2]; const alias = values; alias.push(3); return values.length; }
        function sixth() { const values = [1, 2]; const sorted = (values.sort() as number[]); const view = sorted; view.pop(); return values.length; }
        function seventh() { const values = [1, 2]; values[2] = 3; return values.length; }
        function eighth(index: number) { const values = [1, 2]; values[index] = 3; return values.length; }
        function ninth() { const values = [1, 2]; const holder = { values }; holder.values.push(3); return values.length; }
        function tenth() { const values = [1, 2]; return values; }
        function eleventh() { const values = [1, 2]; let alias: number[] = []; const grow = () => alias.push(3); alias = values; grow(); return values.length; }
        function twelfth() { const values = [1, 2]; const alias = values; for (const value of alias) void value; return values.length + alias.length; }
        declare function consume(input: { values: number[] }): void;
    `,
        "test/analysis-length.ts",
    );
    const facts: boolean[] = [];
    forEachAnalysisNode(sourceFile, (node) => {
        if (
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.name.text === "values"
        ) {
            facts.push(isNeverResized(checker, node.name, 2));
        }
    });
    assert.deepEqual(facts, [
        true,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        true,
    ]);
});

test("a call of a record's member reaches that member unless it can reach the record as `this`", () => {
    const { checker, sourceFile } = createCompilerProgram(
        `
        function count(n: number): number { return n; }
        function arrow() { return { fragment: "a", box: (n: number) => n, fade: { bind: (n: number) => n } }; }
        function named() { return { fragment: "a", box: count }; }
        function writer() { return { fragment: "a", box(n: number) { this.fragment = "b"; return n; } }; }
        function first() { const s = arrow(); s.box(1); s.fade.bind(2); return s.fragment; }
        function second() { const s = named(); s.box(1); return s.fragment; }
        function third() { const s = writer(); s.box(1); return s.fragment; }
        function fourth() { const s = arrow(); const other = writer(); s.box = other.box; s.box(1); return s.fragment; }
        function fifth() { const s = arrow(); replace(s); s.box(1); return s.fragment; }
        declare function replace(record: { box: (n: number) => number }): void;
    `,
        "test/analysis-member-calls.ts",
    );
    const intact: Array<[string, boolean, boolean]> = [];
    forEachAnalysisNode(sourceFile, (node) => {
        if (
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.name.text === "s"
        ) {
            const owner = ts.findAncestor(node, ts.isFunctionDeclaration);
            intact.push([
                owner?.name?.text ?? "",
                bindingSubtreeIntact(checker, node, ["fragment"]),
                bindingSubtreeIntact(checker, node, ["box"]),
            ]);
        }
    });
    // A this-free member call reaches its member, not `fragment`; a method
    // writing `this`, or a member something may replace, reaches the record.
    assert.deepEqual(intact, [
        ["first", true, false],
        ["second", true, false],
        ["third", false, false],
        ["fourth", false, false],
        ["fifth", false, false],
    ]);
});

test("mutation analysis follows aliases and callees without confusing shadowed parameters", () => {
    const { checker, sourceFile } = createCompilerProgram(
        `
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
    `,
        "test/analysis-mutation.ts",
    );
    const functions = sourceFile.statements.filter(ts.isFunctionDeclaration);
    const facts = functions.map((fn) => {
        const parameter = fn.parameters[0]?.name;
        assert.ok(parameter && ts.isIdentifier(parameter));
        return [
            parameterIsReadOnly(checker, fn, parameter),
            parameterIsMutated(checker, fn, parameter),
        ];
    });
    assert.deepEqual(facts, [
        [true, false],
        [false, true],
    ]);
});

test("a listing of a parameter's members and a promise's reactions do not write the parameter", () => {
    const { checker, sourceFile } = createCompilerProgram(
        `
        interface Texture { url: string }
        function sortedEntries(map: Record<string, Texture>) {
            return Object.entries(map).sort(([a], [b]) => (a < b ? -1 : 1));
        }
        function sortedKeys(map: Record<string, Texture>) { return Object.keys(map).sort(); }
        function listedValues(map: Record<string, Texture>) { const list = Object.values(map); list.push({ url: "x" }); return list.length; }
        function entryWrite(map: Record<string, Texture>) { for (const [, texture] of Object.entries(map)) texture.url = "changed"; }
        function valueWrite(map: Record<string, Texture>) { Object.values(map)[0]!.url = "changed"; }
        async function load(map: Record<string, Texture>): Promise<Record<string, Texture>> { return map; }
        function reacted(map: Record<string, Texture>) { const loading = load(map); loading.catch(() => undefined); return loading; }
        `,
        "test/analysis-listed-members.ts",
    );
    const mutated = sourceFile.statements
        .filter(ts.isFunctionDeclaration)
        .filter((fn) => fn.name?.text !== "load")
        .map((fn) => {
            const parameter = fn.parameters[0]?.name;
            assert.ok(parameter && ts.isIdentifier(parameter));
            return parameterIsMutated(checker, fn, parameter);
        });
    // Sorting or growing the new list writes nothing of the record; a write
    // to an entry's or a listed value's object writes the record's member.
    assert.deepEqual(mutated, [false, false, false, true, true, false]);
});

test("an unused catch binding stays erased when a nested function shadows its name", () => {
    assert.doesNotThrow(() =>
        compileSource(`
        import { createEngine } from "@babylonjs/lite";
        const engine = await createEngine({});
        try { console.log("ready"); } catch (error) {
            function add(error: number) { return error + 1; }
            const result = add(2);
        }
    `),
    );
});

test("opaque calls do not prove parameter field writes or scalar rebinding", () => {
    const { checker, sourceFile } = createCompilerProgram(
        `
        interface Options { enabled: boolean; }
        declare function opaque(options: Options): void;
        declare function scalar(value: number): void;
        function possible(value: Options) { opaque(value); }
        function written(value: Options) { const alias = value; alias.enabled = true; }
        function copied(value: number) { scalar(value); }
        function primitiveFields(value: { text: string; count: number; enabled: boolean }) {
            return value.text.startsWith("a") && value.count.toFixed(1) !== "" && value.enabled.valueOf();
        }
        function customReceiver(value: { text: { startsWith(search: string): boolean } }) {
            return value.text.startsWith("a");
        }
        function callbackWrite(value: { text: string }) {
            return value.text.replace("a", () => { value.text = "changed"; return "b"; });
        }
        `,
        "test/analysis-parameter-writes.ts",
    );
    const facts = sourceFile.statements
        .filter(ts.isFunctionDeclaration)
        .filter((fn) => fn.body)
        .map((fn) => {
            const parameter = fn.parameters[0]?.name;
            assert.ok(parameter && ts.isIdentifier(parameter));
            return [
                parameterIsReadOnly(checker, fn, parameter),
                parameterIsMutated(checker, fn, parameter),
            ];
        });
    assert.deepEqual(facts, [
        [false, false],
        [false, true],
        [true, false],
        [true, false],
        [false, true],
        [false, true],
    ]);
});

test("a Math call folds only where every engine agrees", () => {
    // Exact members and max / min fold; random never does, and an
    // approximated member folds only into generation-time source text.
    assert.equal(foldMathCall("floor", [-1.5]), -2);
    assert.equal(foldMathCall("imul", [0xffffffff, 5]), -5);
    assert.ok(Object.is(foldMathCall("sign", [-0]), -0));
    assert.ok(Object.is(foldMathCall("max", [-0, 0]), 0));
    assert.ok(Number.isNaN(foldMathCall("min", [1, Number.NaN])));
    assert.equal(foldMathCall("random", []), undefined);
    assert.equal(foldMathCall("sin", [1]), undefined);
    assert.equal(foldMathCall("pow", [2, 3]), undefined);
    assert.equal(foldMathCall("sin", [0], true), 0);
    assert.equal(foldMathCall("floor", [1, 2]), undefined);
    // Into source text every pure member folds as JavaScript computes it.
    for (const [name, member] of MATH_MEMBERS) {
        const values = [0.3, 0.7].slice(0, Math.max(member.arity, 1));
        const own: unknown = Reflect.get(Math, name);
        assert.ok(typeof own === "function", name);
        assert.equal(
            foldMathCall(name, values, true),
            member.impure ? undefined : Reflect.apply(own, Math, values),
            name,
        );
    }
});

test("an object a literal rebuilds at each read is told apart only by a read that does more than read it", () => {
    const { program, checker, sourceFile } = createCompilerProgram(
        `
        import { createEngine, createRenderTarget } from "@babylonjs/lite";
        type Size = Parameters<typeof createRenderTarget>[0]["size"];
        declare function external(size: Size): void;
        const engine = await createEngine({});
        const wide = engine.drawCallCount > 0;
        function measure(opts: { size: Size }): number {
            const size = opts.size;
            return "scale" in size ? size.scale : 1;
        }
        function grow(opts: { size: Size }): void { if ("scale" in opts.size) opts.size.scale = 2; }
        function same(a: Size, b: Size): boolean { return a === b; }
        function run(this: unknown): void {}
        const read = wide ? { surface: engine, scale: 0.5 } : engine;
        createRenderTarget({ format: "rgba8unorm", samples: 1, size: read });
        if (read !== undefined) console.log(measure({ size: read }), typeof read, \`\${measure({ size: read })}\`);
        const written = wide ? { surface: engine, scale: 0.5 } : engine;
        grow({ size: written });
        const compared = wide ? { surface: engine, scale: 0.5 } : engine;
        console.log(same(compared, compared));
        const kept = wide ? { surface: engine, scale: 0.5 } : engine;
        const all: Size[] = [kept];
        const foreign = wide ? { surface: engine, scale: 0.5 } : engine;
        external(foreign);
        const called = wide ? { surface: engine, scale: 0.5, run } : engine;
        if ("run" in called) called.run();
        const nested = wide ? { surface: engine, scale: 0.5, inner: { depth: 1 } } : engine;
        console.log(all.length, measure({ size: nested }));
    `,
        "test/analysis-rebuilt-object.ts",
    );
    const reasons: Record<string, string> = {};
    forEachAnalysisNode(sourceFile, (node) => {
        if (
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.initializer &&
            ts.isConditionalExpression(node.initializer)
        )
            reasons[node.name.text] =
                rebuiltObjectObservation(
                    {
                        program,
                        checker,
                        evaluationOrder: undefined as never,
                    },
                    node,
                ) ?? "none";
    });
    assert.deepEqual(reasons, {
        read: "none",
        written: "the program writes through it",
        compared: "the program compares it by identity",
        kept: "the program keeps it",
        foreign: "the program hands it to code it does not hold",
        called: "the program calls a method of it",
        nested: "a literal it creates holds another",
    });
});

test("a tuple keeps its identity where its consumer can retain or write it", () => {
    // The program compares number arrays by identity elsewhere; the callee
    // that keeps the options object whole may let its member reach that.
    const { program, checker, sourceFile } = createCompilerProgram(
        `
        type Vec3 = [number, number, number];
        const kept: number[][] = [[1], [2]];
        export function same(a: number[], b: number[]): boolean { return a === b; }
        function shade(opts: { dir: Vec3; k: number }): number { return opts.dir[0] * opts.k; }
        function keep(opts: { dir: Vec3; k: number }): { dir: Vec3; k: number } { return opts; }
        export const read = (): number => { const d: Vec3 = [0, 1, 0]; return shade({ dir: d, k: 2 }); };
        export const held = (): Vec3 => { const e: Vec3 = [0, 1, 0]; return keep({ dir: e, k: 2 }).dir; };
        function tag(_strings: TemplateStringsArray, arg: Vec3): Vec3 { return arg; }
        const text: Vec3 = [1, 2, 3];
        const tagged: Vec3 = [2, 3, 4]; tag\`\${tagged}\`;
        declare const numericArray: number & number[];
        let updated = numericArray; ++updated;
        const tested = numericArray; +tested;
        console.log(kept.length, same(kept[0]!, kept[1]!), read(), held(), \`\${text}\`);
    `,
        "test/analysis-one-object-member.ts",
    );
    const identities: Record<string, string> = {};
    forEachAnalysisNode(sourceFile, (node) => {
        if (
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            ["d", "e", "text", "tagged", "updated", "tested"].includes(
                node.name.text,
            )
        )
            identities[node.name.text] =
                oneObjectObservation(
                    {
                        program,
                        checker,
                        evaluationOrder: undefined as never,
                    },
                    node,
                ).identity ?? "none";
    });
    assert.deepEqual(identities, {
        d: "none",
        e: "the program compares such arrays by identity",
        text: "none",
        tagged: "the program compares such arrays by identity",
        updated: "the program compares such arrays by identity",
        tested: "none",
    });
});
