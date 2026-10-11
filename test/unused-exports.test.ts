import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { scanUnusedExports } from "../src/unused-exports.js";

test("export scan follows inferred types, import types and satisfies declarations without losing unused names", (t) => {
    const root = mkdtempSync(join(tmpdir(), "bblite-exports-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const files: Record<string, string> = {
        "tsconfig.json": JSON.stringify({
            compilerOptions: {
                rootDir: ".",
                outDir: "dist",
                allowJs: true,
                strict: true,
                module: "NodeNext",
                moduleResolution: "NodeNext",
            },
            include: ["*.ts", "*.mjs"],
        }),
        "package.json": '{"type":"module"}',
        "model.ts": `
export interface Inferred { value: string; nested?: Inferred; }
export const create = (): Inferred => ({ value: "ok" });
export interface Unreached { unused: number; }
export const shape = { label: "shape" } as const satisfies { label: string };
export const unusedShape = { label: "unused" } as const satisfies { label: string };
export const queried = 42;
export const unqueried = 43;
export const qualified = 44;
export const namespaceUnused = 45;
export const localOnly = 46;
export function dynamicallyUsed(): void {}
export function dynamicallyRenamed(): void {}
export function dynamicallyNested(): void {}
export function dynamicallyUnused(): void {}
export interface PluginContext { value: string; }
export function unusedFunction(): void {}
export interface Recursive<T> { value: T; next?: Recursive<T[]>; }
export function recursive(): Recursive<Inferred> { return { value: { value: "ok" } }; }
console.log(localOnly);
`,
        "whole.ts":
            "export const wholeValue = 1; export interface WholeType { value: number; }",
        "barrel.ts":
            'export { create as make, queried as unusedAlias } from "./model.js";',
        "entry.ts": `
import { make } from "./barrel.js";
import { shape } from "./model.js";
import { recursive } from "./model.js";
import * as model from "./model.js";
const value = make(); console.log(value.value, shape, model.qualified);
console.log(recursive().value);
type Query = typeof import("./model.js").queried;
type Whole = typeof import("./whole.js");
const queried: Query = 42;
const whole: Whole = { wholeValue: 1 };
console.log(queried, whole);
const { dynamicallyUsed } = await import("./model.js");
const { dynamicallyRenamed: renamed } = await import("./model.js");
const [{ dynamicallyNested }] = await Promise.all([import("./model.js")]);
dynamicallyUsed(); renamed(); dynamicallyNested();
`,
        "dist/model.d.ts": "export interface PluginContext { value: string; }",
        "plugin.mjs":
            '/** @param {import("./dist/model.js").PluginContext} context */\nexport function plugin(context) { console.log(context.value); }',
    };
    for (const [name, contents] of Object.entries(files)) {
        const path = join(root, name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, contents);
    }
    const unused = scanUnusedExports(join(root, "tsconfig.json"));
    assert.deepEqual(
        unused.map((item) => item.name).sort(),
        [
            "Unreached",
            "WholeType",
            "localOnly",
            "namespaceUnused",
            "unqueried",
            "unusedAlias",
            "unusedShape",
            "unusedFunction",
            "dynamicallyUnused",
        ].sort(),
    );
    assert.equal(
        unused.find((item) => item.name === "localOnly")?.usedInModule,
        true,
    );
    assert.equal(
        unused.find((item) => item.name === "unusedShape")?.usedInModule,
        false,
    );
    assert.equal(
        unused.find((item) => item.name === "unusedFunction")?.usedInModule,
        false,
    );
    assert.ok(unused.every((item) => item.line > 0));
});

test("export scan rejects malformed project configuration", (t) => {
    const root = mkdtempSync(join(tmpdir(), "bblite-exports-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, "tsconfig.json"), "{invalid");
    assert.throws(
        () => scanUnusedExports(join(root, "tsconfig.json")),
        /expected|read|inputs/i,
    );
});
