import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const native = optionalNativeFixtureTools(false);

function check(name: string, source: string): void {
    test(name, async (t) => {
        runInNewContext(
            ts.transpileModule(source, {
                compilerOptions: {
                    target: ts.ScriptTarget.ESNext,
                    module: ts.ModuleKind.None,
                },
            }).outputText,
        );
        const result = compileSource(source, { fileName: `${name}.ts` });
        await t.test(
            "generated C++ executes the same assertions",
            { skip: !native },
            () => {
                runGeneratedProgram(
                    native!,
                    `regexp-storage/${name}`,
                    result.cpp,
                );
            },
        );
    });
}

check(
    "record-and-generic-containers-retain-regexp-state",
    `
    interface Definition { name: string; pattern?: RegExp; }
    const pattern = /x/g;
    const definitions: Definition[] = ["first", "second"].map((name): Definition => ({name, pattern}));
    const alias = definitions[0]!.pattern!;
    if (alias !== pattern || alias !== definitions[1]!.pattern) throw new Error("record identity");
    if (!alias.test("xx") || definitions[1]!.pattern!.lastIndex !== 1) throw new Error("shared lastIndex");
    definitions[0]!.pattern!.lastIndex = 0;
    if (pattern.lastIndex !== 0) throw new Error("field lastIndex write");
    function retain<T>(value: T): T { return value; }
    const patterns: RegExp[] = definitions.map(def => retain(def.pattern!));
    const table = new Map<string, RegExp>([["pattern", patterns[0]!]]);
    if (table.get("pattern") !== pattern || patterns[1] !== pattern) throw new Error("container identity");
    const keys = new Map<RegExp, number>([[pattern, 1]]);
    keys.set(alias, 2);
    const members = new Set<RegExp>([pattern, alias, /x/g]);
    if (keys.size !== 1 || keys.get(pattern) !== 2 || members.size !== 2) throw new Error("key identity");
    table.get("pattern")!.lastIndex = 1;
    if (!patterns[1]!.test("xx") || pattern.lastIndex !== 2 || alias.test("xx") || pattern.lastIndex !== 0)
        throw new Error("container state");
    definitions[0]!.pattern = undefined;
    if (definitions[0]!.pattern !== undefined || !definitions[1]!.pattern) throw new Error("optional field");
`,
);

check(
    "stored-regexp-callbacks-and-unicode",
    `
    interface Matcher { pattern: RegExp; }
    const rows: Matcher[] = [{pattern: /(a)?(b)/g}, {pattern: /./gu}];
    function replace(pattern: RegExp): string {
        return "b ab".replace(pattern, (whole: string, a: string | undefined, b: string, offset: number, input: string): string => {
            if (input !== "b ab" || b !== "b" || (offset !== 0 && offset !== 2)) throw new Error("replacement packet");
            return (a ?? "-") + whole;
        });
    }
    if (replace(rows[0]!.pattern) !== "-b aab") throw new Error("stored captures");
    const unicode = rows[1]!.pattern;
    const first = unicode.exec("😀x");
    if (!first || first[0] !== "😀" || rows[1]!.pattern.lastIndex !== 2) throw new Error("stored unicode");
    if (!rows[1]!.pattern.test("😀x") || unicode.lastIndex !== 3) throw new Error("unicode continuation");
    const matches = "😀x".match(rows[1]!.pattern);
    if (!matches || matches.join("|") !== "😀|x" || unicode.lastIndex !== 0) throw new Error("stored match");
`,
);

check(
    "regexp-receivers-survive-argument-and-assignment-effects",
    `
    const original = /x/g;
    const replacement = /z/g;
    const record: {pattern: RegExp} = {pattern: original};
    function change(): string { record.pattern = replacement; return "xx"; }
    if (!record.pattern.test(change()) || original.lastIndex !== 1 || replacement.lastIndex !== 0)
        throw new Error("method receiver order");
    record.pattern = original;
    function position(): number { record.pattern = replacement; return 2; }
    record.pattern.lastIndex = position();
    if (original.lastIndex !== 2 || replacement.lastIndex !== 0) throw new Error("assignment receiver order");
`,
);

check(
    "rebound-regexp-callbacks-use-runtime-capture-layout",
    `
    let pattern = /x/g;
    function select(): void { pattern = /(x)/g; }
    select();
    const result = "xx".replace(pattern, (whole: string, capture: string, offset: number, input: string): string => {
        if (whole !== "x" || capture !== "x" || input !== "xx") throw new Error("rebound capture layout");
        return capture + offset;
    });
    if (result !== "x0x1") throw new Error("rebound replacement");
`,
);

test("stored-regexp-boundaries-refuse-unsupported-grammar-and-unknown-split-layout", () => {
    assert.throws(
        () =>
            compileSource(
                `const patterns: RegExp[] = [/x/y]; patterns[0]!.test("x");`,
            ),
        /support the g, i and u flags/,
    );
    assert.throws(
        () =>
            compileSource(
                `const patterns: RegExp[] = [/(a)/u]; "ab".split(patterns[0]!);`,
            ),
        /stored RegExp requires a known capture layout/,
    );
    assert.throws(
        () =>
            compileSource(
                `let pattern = /x/g; function select(): void { pattern = /(a)/u; } select(); "ab".split(pattern);`,
            ),
        /stored RegExp requires a known capture layout/,
    );
});
