import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { ClassHierarchy } from "../src/compiler/class-members.js";
import {
    EvaluationOrder,
    footprintsConflict,
    touchesNoState,
} from "../src/compiler/evaluation-order.js";
import { createCompilerProgram } from "../src/compiler/program.js";

// What code reads and writes, one model for two questions: the operands of
// one expression (`operandsToPin`) and the order JavaScript defers code in
// (`footprint`).

function analysis(source: string) {
    const frontend = createCompilerProgram(
        source,
        resolve("evaluation-order.ts"),
    );
    const order = new EvaluationOrder(
        frontend.checker,
        new ClassHierarchy(frontend.checker, frontend.program),
    );
    const functions = new Map(
        frontend.sourceFile.statements.flatMap((statement) =>
            ts.isFunctionDeclaration(statement) && statement.name
                ? [[statement.name.text, statement] as const]
                : [],
        ),
    );
    const footprint = (name: string) => {
        const declaration = functions.get(name);
        assert.ok(declaration, name);
        return order.footprint([{ node: declaration }]);
    };
    const initializer = (name: string): ts.Expression => {
        for (const statement of frontend.sourceFile.statements)
            if (ts.isVariableStatement(statement))
                for (const declaration of statement.declarationList
                    .declarations)
                    if (
                        ts.isIdentifier(declaration.name) &&
                        declaration.name.text === name &&
                        declaration.initializer
                    )
                        return declaration.initializer;
        assert.fail(name);
    };
    return { order, footprint, initializer };
}

test("objects of two families never meet; any object meets every family", () => {
    const { footprint } = analysis(`
const canvas = document.getElementById("view") as HTMLCanvasElement;
const panel = document.getElementById("panel") as HTMLDivElement;
const values: number[] = [];
const state = { x: 0 };
export function writesCanvas(): void { canvas.width = 2; }
export function readsCanvas(): number { return canvas.width; }
export function writesPanel(): void { panel.textContent = "x"; }
export function readsPage(): number { return document.body.childElementCount; }
export function writesValues(): void { values.push(1); }
export function writesState(): void { state.x = 1; }`);
    const conflict = (a: string, b: string): boolean =>
        footprintsConflict(footprint(a), footprint(b));
    assert.ok(conflict("writesCanvas", "readsCanvas"));
    assert.ok(!conflict("writesCanvas", "writesPanel"));
    assert.ok(conflict("writesPanel", "readsPage"));
    assert.ok(!conflict("writesValues", "writesCanvas"));
    assert.ok(conflict("writesState", "writesCanvas"));
    assert.ok(conflict("writesState", "writesValues"));
});

test("an object only one run reaches is its own until it is handed on", () => {
    const { footprint } = analysis(`
const kept: { n: number }[] = [];
export function local(): () => number {
    const box = { n: 0 };
    box.n = 1;
    return (): number => box.n;
}
export function handedOn(): void {
    const box = { n: 0 };
    kept.push(box);
    box.n = 1;
}`);
    assert.ok(touchesNoState(footprint("local")));
    const handed = footprint("handedOn");
    assert.ok(handed.writes.objects.has("data"));
    assert.ok(handed.writes.objects.has("objects"));
});

test("the clock is state no code writes; the random sequence is written by each draw", () => {
    const { footprint } = analysis(`
export function now(): number { return Date.now(); }
export function draw(): number { return Math.random(); }`);
    assert.ok(!touchesNoState(footprint("now")));
    assert.ok(!footprintsConflict(footprint("now"), footprint("now")));
    assert.ok(footprintsConflict(footprint("draw"), footprint("draw")));
    assert.ok(!footprintsConflict(footprint("now"), footprint("draw")));
});

test("waiting and a library operation's own work are the operand question's alone", () => {
    const { order, footprint, initializer } = analysis(`
export async function waits(): Promise<void> { await null; }
export function fetches(): Promise<Response> { return fetch("data.json"); }
const fetched = fetch("data.json");
const waited = (async () => await null)();`);
    assert.ok(touchesNoState(footprint("waits")));
    assert.ok(touchesNoState(footprint("fetches")));
    assert.ok(order.touchesStorage(initializer("fetched")));
    const wait = ts.forEachChild(initializer("waited"), function find(node):
        ts.AwaitExpression | undefined {
        return ts.isAwaitExpression(node) ? node : ts.forEachChild(node, find);
    });
    assert.ok(wait && order.touchesStorage(wait));
});

test("a library call writes the object it fills; a namespace is no state; a page function changes the page", () => {
    const { order, footprint, initializer } = analysis(`
const target = { a: 1 };
export function assigns(): void { Object.assign(target, { a: 2 }); }
export function largest(a: number, b: number): number { return Math.max(a, b); }
export function logs(): void { console.log("x"); }
const pair = [target.a, Object.assign(target, { a: 2 }).a];`);
    assert.ok(footprint("assigns").writes.objects.has("objects"));
    assert.ok(touchesNoState(footprint("largest")));
    assert.ok(footprint("logs").writes.objects.has("page"));
    const pair = initializer("pair");
    assert.ok(ts.isArrayLiteralExpression(pair));
    assert.deepEqual(order.operandsToPin(pair.elements), [true, false]);
});
