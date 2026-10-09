import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { createCompilerProgram } from "../src/compiler/program.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const files: Record<string, string> = {
    lexical: `
        const api = (() => {
            const offset = 3;
            let issue!: (value: number) => number;
            issue = value => value + offset;
            return {issue};
        })();
        export function increment(value: number): number { return api.issue(value); }
        export function callback(): (value: number) => number { return api.issue; }
    `,
    static: `
        const api = (() => {
            let issue!: (value: number) => number;
            class Binder { static { issue = value => value * 2; } }
            void Binder;
            return {issue};
        })();
        export function double(value: number): number { return api.issue(value); }
    `,
    tokens: `
        declare const brand: unique symbol;
        type Token = Readonly<{ readonly [brand]: true }>;
        const api = (() => {
            const secret = {};
            let issue!: (value: number) => Token;
            let read!: (value: Token) => number;
            class Box {
                #value: number;
                constructor(key: object, value: number) {
                    if (key !== secret) throw new TypeError('constructor');
                    this.#value = value;
                    Object.freeze(this);
                }
                static {
                    issue = value => new Box(secret, value) as unknown as Token;
                    read = value => (value as unknown as Box).#value;
                }
            }
            void Box;
            return {issue, read};
        })();
        export function make(value: number): Token { return api.issue(value); }
        export function read(value: unknown): number | null {
            if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return null;
            try { return api.read(value as Token); } catch { return null; }
        }
    `,
    second: `export { callback } from './lexical.js'; export { read } from './tokens.js';`,
    entry: `
        import { increment, callback } from './lexical.js';
        import { double } from './static.js';
        import { make, read } from './tokens.js';
        import { callback as secondCallback, read as secondRead } from './second.js';
        const functions: Array<(value: number) => number> = [increment, double];
        if (functions[0]!(4) !== 7 || functions[1]!(4) !== 8) throw new Error('initialized callable');
        if (callback() !== secondCallback()) throw new Error('one imported callable owner');
        const first = make(4), second = make(8);
        if (first === second || read(first) !== 4 || secondRead(second) !== 8)
            throw new Error('shared private capability');
    `,
};

function oracle(): void {
    const modules = new Map<string, { exports: unknown }>();
    const load = (name: string): unknown => {
        const found = modules.get(name);
        if (found) return found.exports;
        const module = { exports: {} };
        modules.set(name, module);
        runInNewContext(
            ts.transpileModule(files[name]!, {
                compilerOptions: {
                    target: ts.ScriptTarget.ES2022,
                    module: ts.ModuleKind.CommonJS,
                },
            }).outputText,
            {
                module,
                exports: module.exports,
                require: (specifier: string) =>
                    load(specifier.replace(/^\.\//, "").replace(/\.js$/, "")),
            },
        );
        return module.exports;
    };
    load("entry");
}

function generate(entry = files.entry!): string {
    const directory = resolve("artifacts/module-callable-initialization");
    mkdirSync(directory, { recursive: true });
    for (const [name, source] of Object.entries(files))
        writeFileSync(
            resolve(directory, name + ".ts"),
            name === "entry" ? entry : source,
        );
    const fileName = resolve(directory, "entry.ts");
    const { program } = createCompilerProgram(entry, fileName);
    assert.deepEqual(
        ts
            .getPreEmitDiagnostics(program)
            .map((diagnostic) =>
                ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
            ),
        [],
    );
    return compileSource(entry, { fileName }).cpp;
}

test("imported callable factories retain evaluated bindings and shared private capabilities", () => {
    oracle();
    generate();
});

test("a forged object cannot enter a stored private-class callback parameter", () => {
    assert.throws(
        () =>
            generate(
                files.entry +
                    "\nif (read({}) !== null) throw new Error('forged brand');",
            ),
        /storing it here would mint a second object/,
    );
});

test(
    "native imported callable factories retain evaluated bindings and shared private capabilities",
    { skip: !optionalNativeFixtureTools() },
    () => {
        runGeneratedProgram(
            optionalNativeFixtureTools()!,
            "module-callable-initialization",
            generate(),
        );
    },
);
