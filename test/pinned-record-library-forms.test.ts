import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { LoweringContext } from "../src/lowering/context.js";
import { PinnedRecordModel } from "../src/lowering/pinned-record-lowerer.js";
import { UpstreamSourceStore } from "../src/upstream-source.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const MODULE = "src/fixture/record-library-forms.ts";

/**
 * A pinned module over the forms the library lowerings speak: a function
 * declaring its receiver stored over a method and forwarding with
 * `f.call`, logical expressions run for their effects, rest parameters
 * read by index and spread, `push(...parts)`, a Map's and a Set's
 * `forEach`, a typed array's `every`/`some`/`forEach`, unions and arrays
 * in template parts, a union compared with a literal, `+flag`, a
 * defaulted parameter omitted through a function value, a callback taking
 * more parameters than its caller passes, an anonymous record where a
 * declared one is expected, an evolving array, a void callback returning a
 * value, a member every union arm declares, a union parameter given one
 * member (and its branches for the other members), a reaction returning
 * a promise, and a promise in a union's arm.
 * `run` prints what it computed.
 */
const SOURCE = `export interface Queue {
    readonly items: number[];
    queue(value: number): void;
}

export interface Circle {
    readonly name: string;
    readonly radius: number;
}

export interface Square {
    readonly name: string;
    readonly side: number;
}

export type Figure = Circle | Square;

export interface Sized {
    readonly width: number;
    readonly height: number;
}

export interface Holder {
    readonly mode: "auto" | number;
}

export interface Slot {
    value?: number;
}

export interface Pairing {
    combine(left: number, right: number): number;
}

function makeQueue(): Queue {
    return {
        items: [],
        queue(value) {
            this.items.push(value);
        },
    };
}

function doubled(): number[] {
    const target = makeQueue();
    const original = target.queue;
    const replacement = function (this: Queue, value: number): void {
        original.call(this, value * 2);
    };
    target.queue = replacement;
    target.queue(3);
    target.queue(4);
    return target.items;
}

function effects(flag: boolean, slot: Slot): number[] {
    const out: number[] = [];
    flag && out.push(1);
    flag || out.push(2);
    slot.value ?? out.push(3);
    return out;
}

function invoke(callback: (left: number, right: number) => number): number {
    return callback(1, 2);
}

function forward(): number {
    const pairing: Pairing = { combine: (left, right) => left * 10 + right };
    return invoke((...args) => pairing.combine(...args) + args[0]);
}

function appended(): number[] {
    const all = [0];
    const parts = [1, 2];
    all.push(...parts);
    return all;
}

function iterated(): string {
    let text = "";
    const map = new Map<string, number>([
        ["a", 1],
        ["b", 2],
    ]);
    map.forEach((value, key) => {
        text += \`\${key}\${value}\`;
    });
    const set = new Set<number>([3, 4]);
    set.forEach((value) => {
        text += \`\${value}\`;
    });
    const floats = new Float32Array([1, 2, 3]);
    let sum = 0;
    floats.forEach((value) => {
        sum += value;
    });
    return \`\${text} \${floats.every((value) => value > 0)} \${floats.some((value) => value > 2)} \${sum}\`;
}

function modes(holder: Holder, flag: boolean): string {
    const list = [1, 2];
    return \`\${holder.mode}|\${list}|\${holder.mode === "auto"}|\${+flag + 1}\`;
}

function scaled(value: number, factor = 2): number {
    return value * factor;
}

function defaults(): number {
    const call = scaled;
    return call(3) + call(3, 5);
}

function apply(callback: (value: number) => number): number {
    return callback(5);
}

function plus(value: number, extra?: number): number {
    return value + (extra ?? 100);
}

function area(size: Sized): number {
    return size.width * size.height;
}

function widened(): number {
    const base = { width: 2, height: 3 };
    return area(base);
}

function evolving(): number[] {
    const levels = [];
    levels.push(1);
    levels.push(2);
    return levels;
}

function each(values: number[], visit: (value: number) => void): void {
    for (const value of values) visit(value);
}

function visited(): number[] {
    const out: number[] = [];
    each([1, 2], (value) => out.push(value * 3));
    return out;
}

function nameOf(figure: Figure): string {
    return figure.name;
}

function resolved(ref: Circle | number, figures: Circle[]): Circle {
    if (typeof ref === "number") return figures[ref]!;
    return ref;
}

async function settled(value: number): Promise<number> {
    return value;
}

function chained(): Promise<number> {
    return settled(1).then((value) => settled(value + 1));
}

function maybe(flag: boolean): Promise<number> | number {
    return flag ? settled(5) : 6;
}

async function arms(): Promise<string> {
    const held = maybe(true);
    const plain = maybe(false);
    return \`\${held instanceof Promise ? await held : held} \${plain instanceof Promise ? "promise" : plain}\`;
}

export async function run(): Promise<string> {
    const circle: Circle = { name: "circle", radius: 2 };
    const square: Square = { name: "square", side: 3 };
    const figures: Figure[] = [circle, square];
    const lines = [
        doubled().join(","),
        effects(true, {}).join(","),
        effects(false, { value: 1 }).join(","),
        \`\${forward()}\`,
        appended().join(","),
        iterated(),
        modes({ mode: "auto" }, true),
        modes({ mode: 3 }, false),
        \`\${defaults()} \${apply(plus)} \${widened()} \${evolving()}\`,
        \`\${nameOf(circle)} \${nameOf(figures[1]!)} \${resolved(0, [circle]).radius} \${resolved(circle, []).name}\`,
        visited().join(","),
        \`\${await chained()}\`,
        await arms(),
    ];
    return lines.join("\\n");
}
`;

const RECORDS = [
    "Queue",
    "Circle",
    "Square",
    "Sized",
    "Holder",
    "Slot",
    "Pairing",
];

/** The pinned store with one extra module. */
class FixtureStore extends UpstreamSourceStore {
    public constructor(private readonly source: string) {
        super();
    }
    public override getSource(modulePath: string): string {
        return modulePath.replaceAll("\\", "/") === MODULE
            ? this.source
            : super.getSource(modulePath);
    }
    public override hasSource(modulePath: string): boolean {
        return (
            modulePath.replaceAll("\\", "/") === MODULE ||
            super.hasSource(modulePath)
        );
    }
}

function lowered(source: string): string {
    const store = new FixtureStore(source);
    const model = new PinnedRecordModel(
        new LoweringContext(store),
        store.program.modules([MODULE]),
        {
            records: RECORDS.map((name) => ({
                pinned: [name],
                cpp: name,
                reference: true,
            })),
            values: new Map(),
            adapters: new Map(),
            exported: new Set([`${MODULE}#run`]),
        },
    );
    const { declarations, definitions } = model.lower([
        model.functionDeclaration(MODULE, "run"),
    ]);
    return `#pragma once
#include <bblite/pinned_records.hpp>
${[...model.includes].map((header) => `#include <${header}>`).join("\n")}
namespace bbl {
${model.structs([...RECORDS, ...model.literalRecords()])}
${declarations}
${definitions}
} // namespace bbl
`;
}

test("the record model lowers the library forms as the pin runs them", async (t) => {
    const header = lowered(SOURCE);
    // `push(...parts)` appends the spread; a Map's, a Set's and a typed
    // array's iteration run in place.
    assert.match(header, /bbl::js::array_append\(/);
    assert.match(header, /bbl::pinned::collection_for_each\(/);
    assert.match(header, /bbl::pinned::array_every\(/);
    // A union against a literal compares the arm held.
    assert.match(header, /bbl::pinned::variant_equals\(/);
    // A module function is a callback of its signature, its defaulted
    // parameter optional, adapted where the caller passes fewer.
    assert.match(
        header,
        /bbl::js::adapt_callback<bbl::js::Callback<double\(double\)>>\(bbl::js::Callback<double\(double, bbl::js::Nullable<double>\)>\(/,
    );
    // A union parameter given one member: the callee lowered for it, whose
    // branch for another member no call reaches.
    assert.match(header, /#nameOf\(std::shared_ptr<bbl::Circle>\)/);
    assert.match(header, /bbl::pinned::unreachable<double>\(\)/);
    const javascript = ts.transpileModule(SOURCE, {
        compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
        },
    }).outputText;
    const pinned = (await import(
        `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`
    )) as { run(this: void): Promise<string> };
    const expected = await pinned.run();
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/test-pinned-record-library-forms");
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, "forms.hpp"), header);
    writeFileSync(
        resolve(directory, "check.cpp"),
        `#include "forms.hpp"
#include <bblite/pal_event_loop.hpp>
#include <iostream>
int main() {
    std::string printed = "unsettled";
    {
        const bbl::js::RealmScope realm;
        bbl::pal::EventLoop loop;
        loop.run([&] {
            static_cast<void>(bbl::run().then(
                bbl::js::Callback<void(std::string)>([&](std::string text) { printed = text; }),
                bbl::js::Callback<void(bbl::js::Error)>([&](bbl::js::Error error) {
                    printed = "rejected " + bbl::js::error_message(error);
                })));
            loop.post([&] { loop.close(); });
        });
    }
    std::cout << printed;
    return 0;
}
`,
    );
    const exe = resolve(directory, "check.exe");
    runNativeFixtureCompiler(native, [
        `/I${directory}`,
        resolve(directory, "check.cpp"),
        `/Fo${resolve(directory, "check.obj")}`,
        `/Fe${exe}`,
    ]);
    const printed = execFileSync(exe, { cwd: directory, encoding: "utf8" });
    assert.equal(printed.replaceAll("\r\n", "\n"), expected);
});
