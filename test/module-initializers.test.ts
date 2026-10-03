import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { planImportedModuleInitializers } from "../src/compiler/module-initializers.js";
import { createCompilerProgram } from "../src/compiler/program.js";
import { CompilerSymbols } from "../src/compiler/symbols.js";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("imported scratch records retain writes through call arguments and aliases", (t) => {
    const directory = resolve("artifacts/module-call-mutations");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        join(directory, "dependency.ts"),
        `
        type Hit = { point: [number, number, number]; distance: number };
        const scratch: Hit = { point: [0, 0, 0], distance: 0 };
        const alias = scratch;
        const indirect: Hit = { point: [0, 0, 0], distance: 0 };
        const firstAlias = indirect;
        const secondAlias = firstAlias;
        function write(out: Hit, value: number): void {
            out.point[0] = value;
            out.distance += value;
        }
        function writeWrapped(wrapper: { out: Hit }, value: number): void {
            wrapper.out.point[1] = value;
        }
        export function viaAliases(value: number): number {
            write(secondAlias, value);
            return indirect.point[0] + indirect.distance;
        }
        export function sample(value: number): number {
            write(alias, value);
            writeWrapped({out: scratch}, value + 1);
            Object.assign(scratch, {distance: scratch.distance + 1});
            return scratch.point[0] + scratch.point[1] + scratch.distance;
        }
    `,
    );
    const result = compileSource(
        `
        import {sample, viaAliases} from "./dependency.js";
        if (sample(2) !== 8 || sample(5) !== 20) throw new Error("module call mutation lost");
        if (viaAliases(2) !== 4 || viaAliases(5) !== 12) throw new Error("module alias mutation lost");
    `,
        { fileName: join(directory, "entry.ts") },
    );
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(tools, "module-call-mutations", result.cpp, {
        timeoutMs: 5000,
    });
});

test("read-only call arguments leave immutable imported records on the static path", () => {
    const directory = resolve("artifacts/module-read-only-call");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        join(directory, "dependency.ts"),
        `
        const source = { value: 7 };
        function read(input: { value: number }): number { return input.value; }
        export function sample(): number { return read(source) + Object.keys(source).length; }
    `,
    );
    const { program, sourceFile, checker } = createCompilerProgram(
        'import {sample} from "./dependency.js"; if (sample() !== 8) throw new Error("read");',
        join(directory, "entry.ts"),
    );
    assert.deepEqual(
        planImportedModuleInitializers(
            program,
            sourceFile,
            checker,
            new CompilerSymbols(checker),
        ),
        [],
    );
});

test("initializer planning preserves throwing container and accessor operations", () => {
    const directory = resolve("artifacts/module-abrupt-initializers");
    mkdirSync(directory, { recursive: true });
    for (const source of [
        "const ignored = new Array(-1);",
        "const ignored = new Float32Array(-1);",
        "const ignored = new Map(1 as unknown as []);",
        "const ignored = new Set(1 as unknown as []);",
        "const ignored = new WeakMap([[1 as unknown as object, 2]]);",
        "const ignored = new WeakSet([1 as unknown as object]);",
        "const values = new WeakMap<object,number>(); values.set(1 as unknown as object,2);",
        "const ignored = ([] as number[]).reduce((a,b)=>a+b);",
        "const target={set value(value:number) {throw new Error(String(value));}}; Object.assign(target,{value:7});",
        "const source={get value():number {throw new Error('getter');return 0;}}; Object.assign({},source);",
    ]) {
        writeFileSync(join(directory, "dependency.ts"), source);
        const { program, sourceFile, checker } = createCompilerProgram(
            'import "./dependency.js";',
            join(directory, "entry.ts"),
        );
        assert.deepEqual(
            planImportedModuleInitializers(
                program,
                sourceFile,
                checker,
                new CompilerSymbols(checker),
            ).map((file) => basename(file.fileName)),
            ["dependency.ts"],
            source,
        );
    }
});

test("host initialization retains effects beside immutable data definitions", (t) => {
    const directory = resolve("artifacts/module-definition-effects");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        join(directory, "dependency.ts"),
        `
        export enum Direction { Left = 3, Right = 7 }
        export const table = [{key:"left", value:-Direction.Left}, {key:"right", value:Direction.Right}] as const;
        let calls = 0;
        const probe = { get value():number { calls++; return Date.now() >= 0 ? 5 : 0; } };
        const first = probe.value;
        const second = [2].map((value) => { calls += value; return first + value; });
        export function verify(): void {
            if (calls !== 3 || first !== 5 || second[0] !== 7)
                throw new Error("initializer lifetime");
        }
        const label = "definition"; export default label;
    `,
    );
    const result = compileSource(
        `
        import label, {table,verify} from "./dependency.js";
        verify(); verify();
        if (label !== "definition" || table[0].key !== "left" || table[0].value !== -3 || table[1].value !== 7)
            throw new Error("static sibling definition");
    `,
        { fileName: join(directory, "entry.ts") },
    );
    assert.doesNotMatch(result.cpp, /v_module\d+_table/);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(tools, "module-definition-effects", result.cpp);
});

for (const [label, work] of [
    [
        "source throw",
        'function effect():number { throw new Error("dependency executed"); } const ignored=effect();',
    ],
    [
        "getter",
        'const source={get value():number { if(Date.now()>=0) throw new Error("dependency executed"); return 0; }}; const ignored=source.value;',
    ],
    [
        "callback",
        'const ignored=[1].map(() => { throw new Error("dependency executed"); return 0; });',
    ],
] as const)
    test(`ignored module ${label} cannot disappear`, (t) => {
        const directory = resolve(
            `artifacts/module-ignored-${label.replaceAll(" ", "-")}`,
        );
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, "dependency.ts"), work);
        const result = compileSource(
            'import "./dependency.js"; if(Date.now()>=0) throw new Error("entry executed");',
            { fileName: join(directory, "entry.ts") },
        );
        const tools = optionalNativeFixtureTools(false);
        if (!tools) {
            t.skip("Native fixture compiler unavailable.");
            return;
        }
        assert.throws(
            () =>
                runGeneratedProgram(
                    tools,
                    `module-ignored-${label.replaceAll(" ", "-")}`,
                    result.cpp,
                ),
            /dependency executed/,
        );
    });

for (const declaration of [false, true])
    test(`side-effect-only dependencies retain ${declaration ? "ignored initializers" : "statements"} without observed bindings`, (t) => {
        const directory = resolve("artifacts/module-host-side-effects");
        mkdirSync(directory, { recursive: true });
        writeFileSync(
            join(directory, "dependency.ts"),
            declaration
                ? 'function effect():number { if(Date.now()>=0) throw new Error("dependency executed"); return 1; } const ignored=effect();'
                : 'if(Date.now()>=0) throw new Error("dependency executed");',
        );
        const result = compileSource(
            'import "./dependency.js"; if(Date.now()>=0) throw new Error("entry executed");',
            { fileName: join(directory, "entry.ts") },
        );
        const tools = optionalNativeFixtureTools(false);
        if (!tools) {
            t.skip("Native fixture compiler unavailable.");
            return;
        }
        assert.throws(
            () =>
                runGeneratedProgram(
                    tools,
                    "module-host-side-effects",
                    result.cpp,
                ),
            /dependency executed/,
        );
    });

for (const [entry, invocation] of [
    ["implicit", ""],
    ["terminal", "main();"],
    ["module", "const invoke = main; invoke();"],
] as const) {
    test(`constant enums retain their values with ${entry} startup`, (t) => {
        const result = compileSource(`
            enum Base { First = 3, Second, Last = Second + 2 }
            enum Scale { Small = Base.Last, Large = Small << 1 }
            enum Tone { Soft = "soft", Bold = "bold" }
            function main(): void {
                const numbers: Base[] = [Base.First, Base.Second, Base.Last];
                const label = {tone: Tone.Bold};
                if (numbers.join(",") !== "3,4,6" || Scale.Large !== 12 ||
                    label.tone !== "bold" || Tone["Soft"] !== "soft")
                    throw new Error("enum startup values");
            }
            ${invocation}
        `);
        const tools = optionalNativeFixtureTools(false);
        if (!tools) {
            t.skip("Native fixture compiler unavailable.");
            return;
        }
        runGeneratedProgram(tools, `module-enum-${entry}`, result.cpp);
    });

    test(`runtime enum initializers refuse with ${entry} startup`, () => {
        for (const initializer of [
            "initialize()",
            "Math.random()",
            "Math.abs(-3)",
        ]) {
            assert.throws(
                () =>
                    compileSource(`
                    let calls = 0;
                    function initialize(): number { calls++; return 7; }
                    enum Mode { Value = ${initializer} }
                    function main(): void {
                        if (Mode.Value < 0 || calls < 0) throw new Error("runtime enum");
                    }
                    ${invocation}
                `),
                /Enum declarations with runtime initializers require runtime enum storage/,
            );
        }
    });
}

test("authored entry preserves destructured module bindings across rebinding", (t) => {
    const result = compileSource(`
        let initializations = 0;
        function initial(): [number] { initializations++; return [3]; }
        let [slot] = initial();
        function read(): number { return slot; }
        function main(): void {
            if (initializations !== 1 || read() !== 3)
                throw new Error("module destructuring initialization");
            slot = 7;
            if (read() !== 7) throw new Error("module binding replacement");
        }
        main();
    `);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(tools, "module-destructured-entry", result.cpp);
});

test("initializer planning retains every alias origin across eager calls and recursive helpers", () => {
    const directory = mkdtempSync(join(tmpdir(), "bbl-module-plan-"));
    try {
        const files = {
            "first.ts": "export const values: number[] = [];",
            "second.ts": "export const values: number[] = [];",
            "unused.ts": "export const values: number[] = [];",
            "scalar.ts": "export const value = 7;",
            "register.ts": `
                import { values as first } from "./first.js";
                import { values as second } from "./second.js";
                import { values as unused } from "./unused.js";
                import { value } from "./scalar.js";
                const alias = first;
                function append() {
                    const nested = alias;
                    nested.push(1);
                    follow();
                }
                function follow() {
                    const nested = second;
                    nested.push(2);
                    if (false) append();
                }
                function dormant() { const hidden = unused; hidden.push(3); }
                function read(input: number) { return input; }
                append();
                read(value);
            `,
        };
        for (const [name, source] of Object.entries(files))
            writeFileSync(join(directory, name), source);
        const { program, sourceFile, checker } = createCompilerProgram(
            `
            import "./register.js";
            import { values as first } from "./first.js";
            import { values as second } from "./second.js";
            import { values as unused } from "./unused.js";
            import { value } from "./scalar.js";
            const result = first[0] + second[0] + unused.length + value;
        `,
            join(directory, "entry.ts"),
        );
        const planned = planImportedModuleInitializers(
            program,
            sourceFile,
            checker,
            new CompilerSymbols(checker),
        );
        assert.deepEqual(
            planned.map((file) => basename(file.fileName)),
            ["first.ts", "second.ts", "register.ts"],
        );
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("initializer planning resolves mutable contents through namespace and re-export bindings", () => {
    const directory = resolve("artifacts/module-namespace-mutation-plan");
    mkdirSync(directory, { recursive: true });
    for (const name of [
        "named",
        "namespace",
        "computed",
        "reexport",
        "nested",
        "readonly",
        "slot",
    ])
        writeFileSync(
            join(directory, `${name}.ts`),
            "export const item={value:1};",
        );
    writeFileSync(
        join(directory, "list.ts"),
        "export const values:number[]=[];",
    );
    writeFileSync(
        join(directory, "barrel.ts"),
        'export {item as renamed} from "./reexport"; export * as nested from "./nested";',
    );
    const { program, sourceFile, checker } = createCompilerProgram(
        `
        import {item} from "./named";
        import * as namespace from "./namespace";
        import * as computed from "./computed";
        import * as barrel from "./barrel";
        import * as list from "./list";
        import * as readonly from "./readonly";
        import * as slot from "./slot";
        item.value=2;
        namespace.item.value++;
        computed["item"]["value"]=4;
        barrel.renamed.value=5;
        barrel.nested.item.value=6;
        list["values"].push(7);
        const read=readonly.item.value;
        slot.item={value:8};
    `,
        join(directory, "entry.ts"),
    );
    const planned = planImportedModuleInitializers(
        program,
        sourceFile,
        checker,
        new CompilerSymbols(checker),
    );
    assert.deepEqual(
        planned.map((file) => basename(file.fileName)),
        [
            "named.ts",
            "namespace.ts",
            "computed.ts",
            "reexport.ts",
            "nested.ts",
            "list.ts",
        ],
    );
});

test("imported readonly array spreads retain their snapshot and element identities", (t) => {
    const directory = resolve("artifacts/module-spread-initializer");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        join(directory, "layout.ts"),
        `
        interface Row {name: string; points: readonly number[];}
        const row = (name: string): Row => ({name, points: [1, 2]});
        const rows: Row[] = [row("first"), row("second")];
        export const layout: readonly Row[] = [...rows, ...[3, 4].map((n): Row => ({name: String(n), points: [n]}))];
        export function get() { return layout; }
    `,
    );
    const result = compileSource(
        `
        import {layout, get} from "./layout.js";
        function main() {
            if (layout !== get() || get() !== get()) throw new Error("array snapshot identity");
            let names = "";
            for (const row of layout) names += row.name + ":";
            if (names !== "first:second:3:4:" || layout.length !== 4) throw new Error("spread evaluation order");
            get()[0]!.name = "changed";
            if (layout[0]!.name !== "changed") throw new Error("copied element identity");
        }
        main();
    `,
        { fileName: join(directory, "entry.ts") },
    );
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(tools, "module-spread-initializer", result.cpp);
});

test("runtime iteration reuses named module records instead of rebuilding each visit", (t) => {
    const directory = resolve("artifacts/module-array-reuse");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        join(directory, "rules.ts"),
        `
        export interface Rule { readonly label: string; readonly limit: number; readonly tags: readonly string[]; }
        let limit = 3;
        const rules: readonly Rule[] = [
            {label: "hard", limit, tags: ["wood", "block"]},
            {label: "soft", limit, tags: ["cloth"]},
        ];
        export function choose(label: string): Rule | undefined {
            for (const rule of rules) if (rule.label === label) return rule;
            return undefined;
        }
        export function advance(): void { limit++; }
    `,
    );
    const result = compileSource(
        `
        import {choose, advance} from "./rules.js";
        const first = choose("hard");
        if (!first) throw new Error("missing rule");
        for (let i = 0; i < 5000; i++) {
            advance();
            const current = choose("hard");
            if (current !== first || current.limit !== 3 || current.tags[0] !== "wood")
                throw new Error("module array lost its snapshot or element identity");
        }
    `,
        { fileName: join(directory, "entry.ts") },
    );
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(
        tools,
        "module-array-reuse",
        `
        #include "../../test/fixtures/allocation-tracker.hpp"
        #define main generated_main
        ${result.cpp}
        #undef main
        #include <cassert>
        int main() {
            const auto before = allocation_count;
            assert(generated_main() == 0);
            assert(allocation_count - before < 256);
        }
    `,
    );
});
