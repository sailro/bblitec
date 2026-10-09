import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { executeApplicationFunction } from "../src/compiler/executed-application-function.js";
import { createCompilerProgram } from "../src/compiler/program.js";
import { isReadOnlyRegExpCall } from "../src/compiler/regexp-call-effects.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const builders = `
    const names = /^[A-Za-z_][A-Za-z0-9_]*$/;
    const alias = names;
    function first(name: string): string {
        if (!alias.test(name)) throw new Error("invalid name");
        return "first:" + name;
    }
    function second(name: string): string {
        if (!names.exec(name)) throw new Error("invalid name");
        return "second:" + name;
    }
`;

function prepare(source: string, fileName = "test/regexp-generation-entry.ts") {
    const checked = createCompilerProgram(source, fileName);
    const execute = (name: string, argument: string): unknown => {
        const declaration = checked.sourceFile.statements.find(
            (statement): statement is ts.FunctionDeclaration =>
                ts.isFunctionDeclaration(statement) &&
                statement.name?.text === name,
        );
        assert.ok(declaration);
        return executeApplicationFunction(
            {
                checker: checked.checker,
                sourceFiles: checked.program.getSourceFiles(),
                fail: (_node, message) => {
                    throw new Error(message);
                },
                foldEnclosing: () => undefined,
            },
            declaration,
            [argument],
            `Builder '${name}'`,
        );
    };
    return { ...checked, execute };
}

test("generation and native calls share immutable RegExp literals across builders", async (t) => {
    const checked = prepare(builders);
    for (const name of ["first", "second"]) {
        for (const argument of ["a", "valid_2", "a"])
            assert.equal(
                checked.execute(name, argument),
                `${name}:${argument}`,
            );
        assert.throws(() => checked.execute(name, "bad-name"), /invalid name/);
    }
    const source = `${builders}
        if (first("a") !== "first:a" || second("valid_2") !== "second:valid_2" || first("a") !== "first:a")
            throw new Error("repeated builders");
        let rejected = 0;
        try { first("bad-name"); } catch { rejected++; }
        if (rejected !== 1) throw new Error("validation effect");
    `;
    runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
    );
    const result = compileSource(source);
    const native = optionalNativeFixtureTools(false);
    await t.test("native assertions", { skip: !native }, () => {
        runGeneratedProgram(
            native!,
            "regexp-generation-effects/builders",
            result.cpp,
        );
    });
});

test("imported immutable aliases are checked across all referencing modules", () => {
    const directory = resolve("artifacts/regexp-generation-effects/imported");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        resolve(directory, "pattern.ts"),
        "export const names = /^[a-z]+$/;",
    );
    const source = `import { names as imported } from './pattern';
        const alias = imported;
        function first(name: string): string { if (!alias.test(name)) throw new Error('invalid'); return name; }`;
    const entry = resolve(directory, "entry.ts");
    assert.equal(prepare(source, entry).execute("first", "word"), "word");
    for (const mutation of [
        "import {names} from './pattern'; names.exec = () => null;",
        "RegExp.prototype.exec = () => null;",
        "const prototype = Object.getPrototypeOf(/x/); prototype.exec = () => null;",
    ]) {
        writeFileSync(resolve(directory, "mutation.ts"), mutation);
        assert.throws(
            () =>
                prepare(`import './mutation'; ${source}`, entry).execute(
                    "first",
                    "word",
                ),
            /writes a module-scope binding/,
        );
    }
});

test("RegExp call effects refuse state, mutation, escaped methods and coercion", () => {
    for (const [declarations, argument] of [
        ["const names = /a/g;", "name"],
        ["const names = /a/y;", "name"],
        ["let names = /a/;", "name"],
        ["const names = /a/; names.lastIndex = 1;", "name"],
        ["const names = /a/; names.exec = () => null;", "name"],
        ["const names = /a/; names.test = () => true;", "name"],
        ["const names = /a/; const held = {names};", "name"],
        ["const names = {test(name: string) { return !!name; }};", "name"],
        [
            "const names = /a/; const text = {toString() { names.lastIndex++; return 'a'; }};",
            "text as unknown as string",
        ],
    ]) {
        const checked = prepare(`${declarations}
            function first(name: string): string { return names.test(${argument}) ? name : ''; }`);
        assert.throws(
            () => checked.execute("first", "a"),
            /writes a module-scope binding|module-scope 'let'/,
        );
    }
    const checked = prepare(
        "const names = /a/; function first(value: object) { return names.test(value as unknown as string); }",
    );
    const declaration = checked.sourceFile.statements.find(
        ts.isFunctionDeclaration,
    )!;
    const call = (declaration.body!.statements[0] as ts.ReturnStatement)
        .expression!;
    assert.equal(
        isReadOnlyRegExpCall(
            checked.checker,
            call,
            checked.program.getSourceFiles(),
        ),
        false,
    );
});
