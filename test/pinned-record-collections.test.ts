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

const MODULE = "src/fixture/record-collections.ts";

/**
 * A pinned module over the collection forms the splat-stream library uses:
 * `Array.from` of arrays, typed arrays, tuples, map and set views and
 * `{ length }` with a mapper (into arrays, tuples and spreads), typed
 * `.from`/`.set`/`.slice` across element kinds, `ArrayLike<number>` and
 * `Iterable<T>` parameters (with a default), a record intersected with an
 * optional view of its own member, destructuring `for...of` over records
 * and map entries, an effectful optional-chain head evaluated once, a Map
 * seeded from a mapped list, a closure default reading an earlier
 * parameter, unread callback parameters, optional array elements and a
 * `Promise<void>` taken as `Promise<unknown>`. `run` prints what it
 * computed.
 */
const SOURCE = `export interface Level {
    readonly count: number;
    readonly blocks: number;
}

export interface Plan {
    readonly id: number;
    readonly weight: number;
    readonly tag?: string;
}

export interface Ledger {
    used: number;
}

export interface Budget {
    limit: number;
    ledger?: Ledger;
}

export interface Box {
    readonly id: number;
    readonly items: number[];
}

function sum(values: ArrayLike<number>): number {
    let total = 0;
    for (let index = 0; index < values.length; index++) total += values[index]!;
    return total;
}

function defaultPlans(): Plan[] {
    return Array.from({ length: 3 }, (_, index) => ({ id: index, weight: index * 2 + 1 }));
}

function weights(plans: Iterable<Plan> = defaultPlans()): number[] {
    const out: number[] = [];
    for (const plan of plans) out.push(plan.weight);
    return out;
}

function charge(budget: Budget & { ledger?: Ledger }, amount: number): number {
    if (budget.ledger) budget.ledger.used += amount;
    return budget.limit - amount;
}

function levels(list: readonly Level[]): string {
    const out: string[] = [];
    for (const { count, blocks: size } of list) out.push(\`\${count}x\${size}\`);
    return out.join(",");
}

function froms(): string {
    const floats = new Float32Array([1.5, 2.25, 3]);
    const fromTyped = Array.from(floats);
    const tuple: [number, number, number] = [4, 5, 6];
    const fromTuple = Array.from(tuple, (value) => value * 2);
    const map = new Map<string, number>([
        ["a", 1],
        ["b", 2],
    ]);
    const keys = Array.from(map.keys());
    const values = Array.from(map.values(), (value, index) => value + index * 10);
    const set = new Set([7, 8, 7]);
    const fromSet = Array.from(set.values());
    const squares = Array.from({ length: 4 }, (_, index) => index * index);
    const position = Array.from(floats) as [number, number, number];
    const list = [1, 2, 3];
    const spread = [...Array.from(tuple, (value) => value + 1), ...list.map((value) => value - 1), 9];
    const copy = Float64Array.from(fromTuple);
    return [
        fromTyped.join("/"),
        fromTuple.join("/"),
        keys.join("/"),
        values.join("/"),
        fromSet.join("/"),
        squares.join("/"),
        String(position[2]),
        spread.join("/"),
        String(copy[2]),
        String(sum(floats)),
        String(sum(tuple)),
        String(sum([10, 20])),
        String(sum(list)),
    ].join(" ");
}

function views(): string {
    const words = new Uint32Array(6);
    words.set([1, 2], 1);
    words.set(new Float32Array([7.5, -1.5]), 4);
    const part = words.slice(1, 3);
    const tail = words.slice(4);
    let overflow = "fits";
    try {
        words.set([1, 2, 3], 5);
    } catch (error) {
        overflow = error instanceof RangeError ? "range" : "other";
    }
    return \`\${Array.from(words).join(",")}|\${Array.from(part).join(",")}|\${tail.length}|\${overflow}\`;
}

function lookups(plans: Plan[], boxes: Box[]): string {
    let calls = 0;
    const find = (id: number): Plan | undefined => {
        calls++;
        return plans.find((plan) => plan.id === id);
    };
    const hit = find(1)?.weight;
    const miss = find(9)?.weight;
    const tag = plans.find((plan) => plan.id === 2)?.tag ?? "none";
    let seen = 0;
    boxes.find((box) => box.id === 2)?.items.forEach((item) => {
        seen += item;
    });
    boxes.find((box) => box.id === 5)?.items.forEach((item) => {
        seen += item * 100;
    });
    return \`\${hit}|\${miss}|\${tag}|\${calls}|\${seen}\`;
}

function entries(plans: Plan[]): string {
    const byId = new Map<number, number>(plans.map((plan) => [plan.id * 10, plan.weight]));
    const keys: number[] = [];
    for (const [key] of byId) keys.push(key);
    let total = 0;
    for (const [, value] of byId) total += value;
    return \`\${keys.join("+")}=\${total}|\${byId.get(20)}\`;
}

function scaled(values: number[], factor: number, apply = (value: number) => value * factor): number[] {
    const out: number[] = [];
    for (const value of values) out.push(apply(value));
    return out;
}

function slots(plans: Plan[]): string {
    const list: (Plan | undefined)[] = [plans[0], undefined];
    return [list[0]?.id ?? -1, list[1]?.id ?? -1, list[5]?.id ?? -1].join(",");
}

async function idle(): Promise<void> {}

async function settled(): Promise<string> {
    const pending: Promise<unknown> = idle();
    const value = await pending;
    return value === undefined ? "undefined" : "defined";
}

export async function run(): Promise<string> {
    const plans = defaultPlans();
    const boxes: Box[] = [
        { id: 1, items: [1] },
        { id: 2, items: [2, 3] },
    ];
    const ledger: Ledger = { used: 1 };
    const budget: Budget = { limit: 10, ledger };
    const bare: Budget = { limit: 4 };
    const ignore = (value: number, unused: string): number => value;
    const settledText = await settled();
    const charged = \`\${charge(budget, 3)}|\${charge(bare, 1)}\`;
    const lines = [
        weights().join(","),
        weights(plans.slice(1)).join(","),
        \`\${charged}|\${ledger.used}\`,
        levels([
            { count: 2, blocks: 8 },
            { count: 1, blocks: 4 },
        ]),
        froms(),
        views(),
        lookups(plans, boxes),
        entries(plans),
        \`\${scaled([1, 2], 3).join(",")}|\${scaled([1, 2], 3, (value) => value - 1).join(",")}\`,
        slots(plans),
        String(ignore(5, "x")),
        settledText,
    ];
    return lines.join("\\n");
}
`;

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

const RECORDS = ["Level", "Plan", "Ledger", "Budget", "Box"];

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

test("the record model lowers the splat stream's collection forms as the pin runs them", async (t) => {
    const header = lowered(SOURCE);
    assert.match(header, /bbl::pinned::array_from_length<double>\(/);
    assert.match(header, /bbl::pinned::array_tuple<3>\(/);
    assert.match(header, /bbl::pinned::typed_set\(/);
    assert.match(header, /\[\[maybe_unused\]\] std::string unused/);
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
    const directory = resolve("artifacts/test-pinned-record-collections");
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, "collections.hpp"), header);
    writeFileSync(
        resolve(directory, "check.cpp"),
        `#include "collections.hpp"
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

test("the record model refuses collection forms it cannot order or represent", () => {
    const refuses = (from: string, to: string, message: RegExp): void => {
        assert.ok(SOURCE.includes(from), from);
        assert.throws(() => lowered(SOURCE.replace(from, to)), message);
    };
    // A third Array.from argument (thisArg).
    refuses(
        "Array.from(floats);",
        "Array.from(floats, (value) => value, undefined);",
        /Array\.from takes a source and a mapper/,
    );
    // An array-like without a mapper.
    refuses(
        "Array.from({ length: 4 }, (_, index) => index * index);",
        "Array.from({ length: 4 }) as number[];",
        /Array\.from of an array-like is `\{ length \}` with a mapper/,
    );
    // A Map seeded from a list it does not map to entries.
    refuses(
        "new Map<number, number>(plans.map((plan) => [plan.id * 10, plan.weight]));",
        "new Map<number, number>(plans.map((plan) => [plan.id, plan.weight] as [number, number]).reverse());",
        /Map seed must be a literal or a list mapped to entries/,
    );
    // A destructuring iteration with a default.
    refuses(
        "for (const { count, blocks: size } of list)",
        "for (const { count = 1, blocks: size } of list)",
        /destructuring iteration binds plain member names/,
    );
    // A closure capturing a defaulted parameter beside a closure default.
    refuses(
        "for (const value of values) out.push(apply(value));\n    return out;",
        "const later = (): number => apply(1);\n    out.push(later());\n    return out;",
        /captures a defaulted parameter beside a closure default/,
    );
});
