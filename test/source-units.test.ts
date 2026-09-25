import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    renderSourceUnits,
    unitMaximumWeight,
} from "../src/compiler/source-units.js";
import {
    buildNativeFixture,
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
} from "./native-fixture.js";

test("source units link shared types, tables and calls across equal module basenames", (t) => {
    const directory = resolve("artifacts/test-source-units");
    const files = {
        "left/shared.ts": `
            import { weights } from "../weights.js";
            export interface State { value: number; }
            export function create(): State { return { value: 3 }; }
            export function step(state: State, index: number): number {
                state.value += weights[index][0];
                return state.value;
            }
        `,
        "right/shared.ts": `
            import { step, type State } from "../left/shared.js";
            export function twice(state: State): number { step(state, 0); return step(state, 1); }
        `,
        "weights.ts": "export const weights = [[2, 4], [5, 6]] as const;",
        "unused.ts": "export interface Unused { hidden: number; }",
    };
    for (const [path, source] of Object.entries(files)) {
        const full = resolve(directory, path);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, source);
    }
    const source = `
        import { create } from "../left/shared.js";
        import { twice } from "../right/shared.js";
        import type { Unused } from "../unused.js";
        const state = create();
        if (twice(state) !== 10 || state.value !== 10) throw new Error("Shared state or tables changed");
    `;
    const options = { fileName: resolve(directory, "app/entry.ts") };
    mkdirSync(dirname(options.fileName), { recursive: true });
    const result = compileSource(source, options);
    const units = result.manifest.sourceUnits;
    assert.deepEqual(units.map(({ path }) => path).sort(), [
        "main.cpp",
        "sources/left/shared.cpp",
        "sources/right/shared.cpp",
        "sources/weights.cpp",
    ]);
    assert.equal(
        units.filter(({ source }) => basename(source) === "shared.ts").length,
        2,
    );
    assert.ok(units.every(({ source }) => !source.endsWith("unused.ts")));
    // Each unit declares only what its code reaches.
    assert.match(
        result.cppFiles.get("sources/left/shared.cpp")!,
        /const .*& weights\(\);/,
    );
    assert.doesNotMatch(
        result.cppFiles.get("sources/application.hpp")!,
        /weights|step/,
    );
    assert.doesNotMatch(
        result.cppFiles.get("main.cpp")!,
        /weights|double step\(/,
    );
    assert.deepEqual(
        [...compileSource(source, options).cppFiles],
        [...result.cppFiles],
    );
    for (const [path, cpp] of result.cppFiles) {
        const full = resolve(directory, path);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, cpp);
    }
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("A native compiler is required.");
        return;
    }
    const executable = resolve(directory, "check.exe");
    buildNativeFixture(
        tools,
        units.map(({ path }) => resolve(directory, path)),
        executable,
        [
            "/nologo",
            "/std:c++20",
            "/EHsc",
            "/W4",
            "/WX",
            `/I${resolve("native/include")}`,
        ],
    );
    assert.equal(
        execFileSync(executable, { encoding: "utf8", timeout: 10000 }),
        "",
    );
});

test("a single source keeps its standalone entry without an application header", () => {
    const result = compileSource(
        "const values = [1, 2]; if (values.length !== 2) throw new Error('length');",
    );
    assert.deepEqual([...result.cppFiles], [["main.cpp", result.cpp]]);
    assert.deepEqual(
        result.manifest.sourceUnits.map(({ path }) => path),
        ["main.cpp"],
    );
});

test("repeated factories share callback bodies while native loops retain independent captures", (t) => {
    const directory = resolve("artifacts/test-source-unit-closures");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        resolve(directory, "factory.ts"),
        `
        export function make(seed: number): () => number {
            let value = seed;
            return () => {
                let delta = 0;
                for (let i = 0; i < 3; i++) delta += i;
                value += delta;
                return value;
            };
        }
    `,
    );
    const result = compileSource(
        `
        import { make } from "./factory.js";
        const first = make(10);
        const second = make(20);
        const third = make(30);
        if (first() !== 13 || second() !== 23 || first() !== 16 || third() !== 33)
            throw new Error("Factory captures are not independent");
        const captures: (() => number)[] = [];
        for (let i = 0; i < 3; i++) {
            const snapshot = i;
            captures.push(() => snapshot);
        }
        let total = 0;
        for (let i = 0; i < 3; i++) {
            if (i === 1) continue;
            total += captures[i]!();
        }
        if (total !== 2 || captures[1]!() !== 1) throw new Error("Iteration captures changed");
        interface Sector { floorHeight: number; tag: number; }
        function step(target: { floorHeight: number }): void { target.floorHeight -= 1; }
        const sectors: Sector[] = [{ floorHeight: 8, tag: 1 }];
        step(sectors[0]!);
        if (sectors[0]!.floorHeight !== 7) throw new Error("Structural narrowing copied mutable state");
        interface State { value: number; }
        function add(state: State, amount: number): number { state.value += amount; return state.value; }
        const original: State = {value: 1};
        let current = original;
        function rebind(): number { current = {value: 10}; return 3; }
        if (add(current, rebind()) !== 4 || original.value !== 4 || current.value !== 10)
            throw new Error("Argument order or parameter identity changed");
        function valid(value: unknown): boolean {
            return Array.isArray(value) && value.every(item => typeof item === "number" && Number.isFinite(item));
        }
        if (!valid([1, 2, 3]) || valid([1, Infinity])) throw new Error("Shared predicate changed");
        function apply(count: number, producer: (index: number) => number): number {
            let sum = 0;
            for (let index = 0; index < count; index++) sum += producer(index);
            return sum;
        }
        if (apply(3, index => index * 2) !== 6 || apply(2, index => index + 5) !== 11)
            throw new Error("Native loop callback changed");
        const recorded: number[] = [];
        function record(value: number): void { if (value < 0) return; recorded.push(value); }
        record(-1); record(2);
        if (recorded.length !== 1 || recorded[0] !== 2) throw new Error("Early return escaped its call");
        let offset = 1;
        function accumulate(count: number): number {
            for (let index = 0; index < count; index++) offset += index;
            return offset;
        }
        if (accumulate(3) !== 4 || accumulate(4) !== 10)
            throw new Error("Shared loop bounds changed");
        interface Tree { values: number[]; total: number; }
        let traversals = 0;
        function totalTree(tree: Tree): number {
            const alias = tree;
            traversals++;
            function visit(index: number): void {
                tree.total += alias.values[index]!;
                if (index > 0) visit(index - 1);
            }
            visit(tree.values.length - 1);
            return tree.total;
        }
        const tree: Tree = {values: [1, 2, 4], total: 0};
        if (totalTree(tree) !== 7 || tree.total !== 7 || traversals !== 1)
            throw new Error("Recursive callback lost its borrowed record");
        function label(value: number): string {return "value-" + value;}
        function copyLabel(value: number): string {
            const color = label(value);
            return color + color;
        }
        if(copyLabel(traversals)!=="value-1value-1")throw new Error("shared string result");
    `,
        { fileName: resolve(directory, "entry.ts") },
    );
    const factory = result.cppFiles.get("sources/factory.cpp");
    assert.ok(factory, "factory callback belongs to its source unit");
    assert.equal(factory.match(/\(\*\w+_value\) \+=/g)?.length, 1);
    assert.equal(factory.match(/for \(;/g)?.length, 1);
    assert.equal(result.cpp.match(/offset\)? \+=/g)?.length, 1);
    assert.doesNotMatch(
        result.cppFiles.get("sources/application.hpp")!,
        /for \(;/,
    );
    for (const [path, cpp] of result.cppFiles) {
        const full = resolve(directory, path);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, cpp);
    }
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("A native compiler is required.");
        return;
    }
    const executable = resolve(directory, "check.exe");
    buildNativeFixture(
        tools,
        result.manifest.sourceUnits.map(({ path }) => resolve(directory, path)),
        executable,
        [
            "/nologo",
            "/std:c++20",
            "/EHsc",
            "/W4",
            "/WX",
            `/I${resolve("native/include")}`,
            `/I${resolve(nativeFixtureVcpkgRoot, "include")}`,
        ],
    );
    assert.equal(
        execFileSync(executable, { encoding: "utf8", timeout: 10000 }),
        "",
    );
});

test("template placement follows transitive code references and ignores literals", () => {
    const output = renderSourceUnits({
        source: "entry.ts",
        realm: undefined,
        includes: "",
        declarations: [
            { scene: true, text: "double first();" },
            { scene: true, text: "double second();" },
        ],
        definitions: [
            {
                source: "first.ts",
                definition: "double first() { return outer(4.0); }",
            },
            {
                source: "second.ts",
                definition: "double second() { return 4.0; }",
            },
        ],
        templates: [
            {
                name: "inner",
                definition:
                    "template<typename T> T inner(T v) { return v + 1; }",
            },
            {
                name: "outer",
                definition:
                    "template<typename T> T outer(T v) { return inner(v) + 1; }",
            },
            {
                name: "unused",
                definition: "template<typename T> T unused(T v) { return v; }",
            },
        ],
        entry: "int main() { const char* label = \"outer\"; return bblscene::first() == 6 && bblscene::second() == 4 && label[0] == 'o' ? 0 : 1; }",
        cpp: "standalone",
    });
    const first = output.sourceUnits.find(
        ({ source }) => source === "first.ts",
    )!;
    assert.match(output.files.get(first.path)!, /T inner\(T v\)/);
    assert.match(output.files.get(first.path)!, /T outer\(T v\)/);
    for (const [path, code] of output.files) {
        assert.doesNotMatch(code, /T unused/);
        if (path !== first.path)
            assert.doesNotMatch(code, /template<typename T>/);
    }
});

test("a source over the unit budget compiles as parts while literal tables stay whole", () => {
    const sum = (name: string) =>
        `double ${name}(double a) { return ${"a + ".repeat(Math.ceil(unitMaximumWeight * 0.6))}a; }`;
    const output = renderSourceUnits({
        source: "entry.ts",
        realm: undefined,
        includes: "",
        declarations: [
            { scene: true, text: "double first(double a);" },
            { scene: true, text: "double second(double a);" },
            {
                scene: true,
                text: "extern const std::array<double, 30001> TABLE;",
            },
        ],
        definitions: [
            { source: "code.ts", definition: sum("first") },
            { source: "code.ts", definition: sum("second") },
            {
                source: "data.ts",
                definition: `const std::array<double, 30001> TABLE{${"1.0, ".repeat(30_000)}1.0};`,
            },
        ],
        templates: [],
        entry: "int main() { return bblscene::first(1.0) + bblscene::second(1.0) > bblscene::TABLE[0] ? 0 : 1; }",
        cpp: "standalone",
    });
    assert.deepEqual(output.sourceUnits.map(({ path }) => path).sort(), [
        "main.cpp",
        "sources/code.cpp",
        "sources/code.part1.cpp",
        "sources/data.cpp",
    ]);
    assert.match(
        output.files.get("sources/code.part1.cpp")!,
        /double second\(double a\) \{/,
    );
    assert.doesNotMatch(
        output.files.get("sources/code.part1.cpp")!,
        /double first\(double a\) \{/,
    );
});

test("a source's parts group the definitions that name the same things", () => {
    const names = (prefix: string) =>
        Array.from(
            { length: Math.ceil(unitMaximumWeight * 0.45) },
            (_, index) => `${prefix}${index}`,
        ).join(" + ");
    const piece = (name: string, prefix: string) =>
        `double ${name}() { return ${names(prefix)}; }`;
    const output = renderSourceUnits({
        source: "entry.ts",
        realm: undefined,
        includes: "",
        declarations: [],
        definitions: [
            { source: "code.ts", definition: piece("firstA", "alpha") },
            { source: "code.ts", definition: piece("firstB", "beta") },
            { source: "code.ts", definition: piece("secondA", "alpha") },
            { source: "code.ts", definition: piece("secondB", "beta") },
        ],
        templates: [],
        entry: "int main() { return 0; }",
        cpp: "standalone",
    });
    const unit = (path: string) => output.files.get(path) ?? "";
    assert.match(
        unit("sources/code.cpp"),
        /double firstA\(\)[^]*double secondA\(\)/,
    );
    assert.doesNotMatch(unit("sources/code.cpp"), /beta/);
    assert.match(
        unit("sources/code.part1.cpp"),
        /double firstB\(\)[^]*double secondB\(\)/,
    );
    assert.doesNotMatch(unit("sources/code.part1.cpp"), /alpha/);
});
