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
