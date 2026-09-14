import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { planImportedModuleInitializers } from "../src/compiler/module-initializers.js";
import { createCompilerProgram } from "../src/compiler/program.js";
import { CompilerSymbols } from "../src/compiler/symbols.js";

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
        for (const [name, source] of Object.entries(files)) writeFileSync(join(directory, name), source);
        const { program, sourceFile, checker } = createCompilerProgram(`
            import "./register.js";
            import { values as first } from "./first.js";
            import { values as second } from "./second.js";
            import { values as unused } from "./unused.js";
            import { value } from "./scalar.js";
            const result = first[0] + second[0] + unused.length + value;
        `, join(directory, "entry.ts"));
        const planned = planImportedModuleInitializers(program, sourceFile, checker, new CompilerSymbols(checker));
        assert.deepEqual(planned.map(file => basename(file.fileName)), ["first.ts", "second.ts", "register.ts"]);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
