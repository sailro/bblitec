import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";

// Outside the application realm an activation runs to its end where it
// starts and a reaction runs at once. A program keeps that model only where
// JavaScript's later run cannot be observed: nothing runs before it, or what
// runs touches state the deferred code does not.

function inRealm(source: string): boolean {
    return compileSource(source, {
        fileName: "examples/order.ts",
    }).cpp.includes("bblite/pal_worker.hpp");
}

const logging = `
const log: string[] = [];
async function a(): Promise<void> { log.push("a1"); await null; log.push("a2"); }`;

const page = (listeners: string): string => `
import { createBox, createEngine, startEngine } from "@babylonjs/lite";
const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
let pending = 0;
async function main(): Promise<void> {
    const engine = await createEngine(canvas);
    createBox(engine);
    canvas.addEventListener("pointerdown", async () => { await null; pending = 1; });
    ${listeners}
    await startEngine(engine);
}
void main();`;

test("an activation whose continuation code after it observes needs the realm", () => {
    assert.ok(inRealm(`${logging}\nvoid a();\nlog.push("after");`));
    assert.ok(
        inRealm(`${logging}
async function b(): Promise<void> { log.push("b1"); await null; log.push("b2"); }
async function main(): Promise<void> { await Promise.all([a(), b()]); }
void main();`),
    );
    assert.ok(
        inRealm(
            `${logging}\nfor (let index = 0; index < 2; index++) void a();`,
        ),
    );
    assert.ok(
        inRealm(
            page(
                `canvas.addEventListener("pointerdown", () => { pending = 2; });`,
            ),
        ),
    );
});

test("an activation nothing observes ahead of its continuation runs where it starts", () => {
    assert.ok(!inRealm(`${logging}\nvoid a();`));
    assert.ok(
        !inRealm(`${logging}\nif (log.length === 0) {\n    void a();\n}`),
    );
    assert.ok(
        !inRealm(`
async function make(level: number): Promise<{ level: number }> {
    const made = { level: 0 };
    await null;
    made.level = level;
    return made;
}
async function main(): Promise<void> {
    const [first, second] = await Promise.all([make(1), make(2)]);
    if (first.level + second.level !== 3) throw new Error("levels");
}
void main();`),
    );
    assert.ok(
        !inRealm(
            page(
                `canvas.addEventListener("pointerup", () => { pending = 2; });`,
            ),
        ),
    );
});

test("a run's own objects stay its own while closures or literals it returns keep them", () => {
    const loads = (before: string): string => `
const all: Map<string, number>[] = [];
async function load(count: number): Promise<{ size: number; frame: (key: string) => number | undefined; frames: number[] }> {
    const index = new Map<string, number>();
    ${before}
    await null;
    const frames: number[] = [];
    for (let i = 0; i < count; i++) {
        index.set(String(i), i);
        frames.push(i * 2);
    }
    const sheet = { frames };
    const frame = (key: string): number | undefined => index.get(key);
    return { size: index.size, frame, frames: sheet.frames };
}
async function main(): Promise<void> {
    const [a, b] = await Promise.all([load(2), load(3)]);
    if (a.size + b.size !== 5 || a.frame("1") !== 1) throw new Error("sheets");
}
void main();`;
    assert.ok(!inRealm(loads("")));
    // Handed to shared state before the run suspends, another run can see it.
    assert.ok(inRealm(loads("all.push(index);")));
});

test("a reaction runs at once only when the code after it cannot tell", () => {
    const value = `async function v(): Promise<number> { return 1; }\nlet seen = 0;`;
    assert.ok(
        inRealm(`${value}\nvoid v().then(() => { seen++; });\nseen = 5;`),
    );
    assert.ok(
        !inRealm(
            `${value}\nvoid v().then((n) => { const box = { n }; box.n++; });\nseen = 5;`,
        ),
    );
});
