import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { moduleContainerReferenceFiles } from "../src/compiler/module-initializers.js";
import { createCompilerProgram } from "../src/compiler/program.js";
import { CompilerSymbols } from "../src/compiler/symbols.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("module reference candidates retain import aliases and exclude unrelated files", (t) => {
    const directory = mkdtempSync(join(tmpdir(), "bblite-module-references-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const files: Record<string, string> = {
        "values.ts": "export const values: number[] = []; values.push(1);",
        "named.ts":
            'import {values as rows} from "./values"; export function named():void { const alias=rows; alias.push(3); }',
        "namespace.ts":
            'import * as source from "./values"; export function namespace():void { const alias=source["values"]; alias.push(5); }',
        "barrel.ts": 'export {values as renamed} from "./values";',
        "forwarded.ts":
            'import * as source from "./barrel"; export function forwarded():void { const holder={rows:source.renamed}; holder.rows.push(9); }',
        "unrelated.ts":
            "export const values=[42]; export function change():void { values.push(8); }",
    };
    for (const [name, source] of Object.entries(files))
        writeFileSync(join(directory, name), source);
    const source = `
        import {values} from "./values";
        import {named} from "./named";
        import {namespace} from "./namespace";
        import {forwarded} from "./forwarded";
        import "./unrelated";
        if(values[0]!==1) throw new Error("initial value");
        named(); namespace(); forwarded();
        if(values[0]!==1 || values.length!==4 || values[1]!==3 || values[2]!==5 || values[3]!==9)
            throw new Error("cross-module mutation");
    `;
    const fileName = join(directory, "entry.ts");
    const { program, checker } = createCompilerProgram(source, fileName);
    const symbols = new CompilerSymbols(checker);
    const declaration = program.getSourceFile(join(directory, "values.ts"))!
        .statements[0]!;
    assert.ok(ts.isVariableStatement(declaration));
    const name = declaration.declarationList.declarations[0]!.name;
    assert.ok(ts.isIdentifier(name));
    const candidates = moduleContainerReferenceFiles(
        program,
        checker,
        symbols,
        symbols.valueSymbol(name)!,
    ).map((file) => basename(file.fileName));
    for (const expected of [
        "values.ts",
        "named.ts",
        "namespace.ts",
        "forwarded.ts",
        "entry.ts",
    ])
        assert.ok(candidates.includes(expected), expected);
    assert.ok(!candidates.includes("unrelated.ts"));
    const result = compileSource(source, { fileName });
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(tools, "module-reference-aliases", result.cpp);
});

test("module reference queries share one program scan across bindings and replays", (t) => {
    const directory = mkdtempSync(
        join(tmpdir(), "bblite-module-reference-reuse-"),
    );
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const count = 32;
    for (let index = 0; index < count; index++)
        writeFileSync(
            join(directory, `part${index}.ts`),
            `export const value${index} = [${index}];`,
        );
    const source = Array.from(
        { length: count },
        (_, index) =>
            `import {value${index}} from "./part${index}"; void value${index};`,
    ).join("\n");
    const { program, checker } = createCompilerProgram(
        source,
        join(directory, "entry.ts"),
    );
    const symbols = new CompilerSymbols(checker);
    const bindings = Array.from({ length: count }, (_, index) => {
        const declaration = program.getSourceFile(
            join(directory, `part${index}.ts`),
        )!.statements[0]!;
        assert.ok(ts.isVariableStatement(declaration));
        const name = declaration.declarationList.declarations[0]!.name;
        assert.ok(ts.isIdentifier(name));
        return symbols.valueSymbol(name)!;
    });
    const reads = t.mock.method(symbols, "valueSymbol");
    moduleContainerReferenceFiles(program, checker, symbols, bindings[0]!);
    const initialReads = reads.mock.callCount();
    assert.ok(initialReads > count);
    for (const binding of bindings)
        assert.equal(
            moduleContainerReferenceFiles(program, checker, symbols, binding)
                .length,
            2,
        );
    assert.equal(
        reads.mock.callCount(),
        initialReads,
        "later symbols must not scan source again",
    );
    const replaySymbols = new CompilerSymbols(checker);
    const replayReads = t.mock.method(replaySymbols, "valueSymbol");
    for (const binding of bindings)
        moduleContainerReferenceFiles(program, checker, replaySymbols, binding);
    assert.equal(
        replayReads.mock.callCount(),
        0,
        "a storage replay reuses immutable program facts",
    );
});
