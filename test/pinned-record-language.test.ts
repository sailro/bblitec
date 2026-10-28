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

const MODULE = "src/fixture/record-language.ts";

/**
 * A pinned module over the language the record model lowers beyond plain
 * records: a dynamic JSON document walked with `typeof`/`Array.isArray`/
 * `Object.keys`/`Object.entries`/`hasOwnProperty`, typed views aliasing one
 * buffer and a DataView, spreads (call, array, object and conditional),
 * swap destructuring, value-selecting `||`/`&&`, a `const enum`, defaults,
 * destructured callback parameters, the array iteration methods, a Map's
 * key and entry iteration, an object literal's methods and getter over
 * `this`, `Object.is`, and a dynamic slot holding `null` apart from
 * `undefined`. `run` prints what it computed.
 */
const SOURCE = `export const enum Kind {
    Small = 1,
    Large = 2,
}

export interface Pair {
    readonly left: number;
    readonly right: number;
}

export interface Options {
    readonly scale?: number;
    readonly label?: string;
    readonly flag?: boolean;
}

export interface Slot {
    held: unknown;
}

export interface Batch {
    readonly retired: number[];
    count: number;
    queue(value: number): void;
    flush(): number;
    readonly size: number;
}

function makeBatch(): Batch {
    return {
        retired: [],
        count: 0,
        queue(value) {
            this.retired.push(value);
            this.count++;
        },
        flush() {
            const total = this.retired.reduce((sum, value) => sum + value, 0);
            this.retired.length = 0;
            return total;
        },
        get size() {
            return this.retired.length;
        },
    };
}

function describe(value: unknown, depth: number): string {
    if (typeof value === "number") return \`n\${value}\`;
    if (typeof value === "string") return \`s\${value}\`;
    if (typeof value === "boolean") return value ? "t" : "f";
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    if (Array.isArray(value)) {
        const parts = value.map((element, index) => \`\${index}:\${describe(element, depth + 1)}\`);
        return \`[\${parts.join(",")}]\`;
    }
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).join("+");
    let entries = "";
    for (const [key, entry] of Object.entries(object)) entries += \`\${key}=\${describe(entry, depth + 1)};\`;
    const owns = Object.prototype.hasOwnProperty.call(object, "b") ? "has-b" : "no-b";
    return \`{\${keys}|\${entries}|\${owns}}\`;
}

function words(): number[] {
    const buffer = new ArrayBuffer(16);
    const bytes = new Uint8Array(buffer);
    const words = new Uint32Array(buffer);
    const floats = new Float32Array(buffer, 8, 2);
    words[0] = 0x04030201;
    floats[0] = 1.5;
    bytes[15] = 255;
    const view = new DataView(buffer);
    const copy = new Float64Array(floats);
    copy[1] = 0.1;
    return [view.getUint32(0, true), view.getUint32(0, false), bytes[1]!, view.getFloat32(8, true), words[3]!, view.getUint8(15), copy[0]!, copy[1]!, floats.length];
}

function swaps(): number[] {
    let a = 1;
    let b = 2;
    [a, b] = [b, a];
    const pair = [5, 6];
    [pair[0], pair[1]] = [pair[1]!, pair[0]!];
    return [a, b, pair[0]!, pair[1]!];
}

function spreads(flag: boolean): Options {
    const base: Options = { scale: 2, label: "base" };
    return { ...base, label: "x", ...(flag ? { flag: true } : {}) };
}

function pick(scale = Kind.Small * 10): number {
    return scale;
}

function maps(): string {
    const map = new Map<string, number>([
        ["b", 2],
        ["a", 1],
    ]);
    map.set("c", 3);
    const out: string[] = [];
    for (const key of map.keys()) out.push(key);
    for (const [key, value] of map) out.push(\`\${key}=\${value}\`);
    for (const value of map.values()) out.push(\`\${value}\`);
    const set = new Set([3, 1]);
    set.add(3);
    const list = [...map.values(), ...set, 9];
    out.push(list.join("/"));
    return out.join(" ");
}

function callbacks(): number[] {
    const pairs: Pair[] = [
        { left: 1, right: 2 },
        { left: 3, right: 1 },
    ];
    const sums = pairs.map(({ left, right }) => left + right);
    const big = pairs.filter((pair) => pair.left > 1).length;
    const index = pairs.findIndex((pair) => pair.right === 1);
    const found = pairs.find((pair) => pair.left === 5);
    const all = pairs.every((pair) => pair.left > 0);
    const some = pairs.some((pair) => pair.right > 1);
    let visited = 0;
    pairs.forEach((pair, position) => {
        visited += pair.left * (position + 1);
    });
    const sorted = [3, 1, 2].sort((x, y) => x - y);
    const best = pairs.reduce((winner, pair) => (pair.left > winner.left ? pair : winner));
    return [...sums, big, index, found ? 1 : 0, all ? 1 : 0, some ? 1 : 0, visited, ...sorted, [1, 2, 3].includes(2) ? 1 : 0, best.left];
}

let parked: unknown = null;

function hold(slot: Slot, value: number | null): void {
    slot.held = value;
}

function fallback(value: unknown = 0): string {
    return state({ held: value });
}

function state(slot: Slot): string {
    return slot.held === null ? "null" : slot.held === undefined ? "undefined" : "set";
}

function clear(slot: Slot): void {
    slot.held = null;
}

function slots(): string {
    const slot: Slot = { held: null };
    const states = [state(slot)];
    slot.held = 3;
    states.push(state(slot));
    clear(slot);
    states.push(state(slot));
    slot.held = undefined;
    states.push(state(slot));
    hold(slot, null);
    states.push(state(slot));
    hold(slot, 2);
    states.push(state(slot), state({ held: parked }), fallback(null), fallback());
    return states.join(",");
}

export function run(document: string): string {
    const parsed: unknown = JSON.parse(document);
    const bytes = new Uint8Array([82, 73, 70, 70, 0, 87]);
    const delta: [number, number, number] = [3, 4, 12];
    const empty: number[] = [];
    const options = spreads(true);
    const plain = spreads(false);
    const batch = makeBatch();
    batch.queue(2);
    batch.queue(5);
    const size = batch.size;
    const total = batch.flush();
    const lines = [
        describe(parsed, 0),
        words().join(","),
        String.fromCharCode(...bytes.subarray(0, 4)) + String.fromCharCode(65, 66),
        [Math.hypot(...delta), Math.hypot(1e200, 1e200, 3), Math.max(...delta), Math.min(...delta, -1), Object.is(-0, 0) ? 1 : 0, Object.is(NaN, NaN) ? 1 : 0].join(","),
        swaps().join(","),
        \`\${options.scale}|\${options.label}|\${options.flag}|\${plain.flag === undefined ? "none" : "set"}\`,
        [empty[0] || 7, empty.length && 4, delta.length && 5, Kind.Large, pick(), pick(3)].join(","),
        maps(),
        callbacks().join(","),
        [size, total, batch.size, batch.count].join(","),
        slots(),
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

function lowered(source: string): string {
    const store = new FixtureStore(source);
    const model = new PinnedRecordModel(
        new LoweringContext(store),
        store.program.modules([MODULE]),
        {
            records: [
                { pinned: ["Pair"], cpp: "Pair", reference: true },
                { pinned: ["Options"], cpp: "Options", reference: true },
                { pinned: ["Slot"], cpp: "Slot", reference: true },
                {
                    pinned: ["Batch"],
                    cpp: "Batch",
                    reference: true,
                    accessors: new Set(["size"]),
                },
            ],
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
${model.structs(["Pair", "Options", "Slot", "Batch", ...model.literalRecords()])}
${declarations}
${definitions}
} // namespace bbl
`;
}

const DOCUMENT = JSON.stringify({
    a: [1, "two", true, null, { b: -0.5 }],
    b: { 2: "index", z: false, 1: 0 },
    c: "",
});

test("the record model lowers dynamic values, views, spreads, iteration and literal methods as the pin runs them", async (t) => {
    const header = lowered(SOURCE);
    // Callbacks are inline lambdas; a literal's method closes over `this`.
    assert.match(header, /bbl::pinned::array_map<double>\([^]*\[&\]\(/);
    assert.match(header, /->self->retired/);
    const javascript = ts.transpileModule(SOURCE, {
        compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
        },
    }).outputText;
    const pinned = (await import(
        `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`
    )) as { run(this: void, document: string): string };
    const expected = pinned.run(DOCUMENT);
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/test-pinned-record-language");
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, "language.hpp"), header);
    writeFileSync(resolve(directory, "document.json"), DOCUMENT);
    writeFileSync(
        resolve(directory, "check.cpp"),
        `#include "language.hpp"
#include <fstream>
#include <iostream>
#include <sstream>
int main(int, char** argv) {
    std::ifstream file(argv[1], std::ios::binary);
    std::stringstream text;
    text << file.rdbuf();
    std::cout << bbl::run(text.str());
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
    const printed = execFileSync(exe, [resolve(directory, "document.json")], {
        cwd: directory,
        encoding: "utf8",
    });
    assert.equal(printed.replaceAll("\r\n", "\n"), expected);
});

test("the record model refuses what its dynamic values, spreads and keys cannot represent", () => {
    const refuses = (from: string, to: string, message: RegExp): void =>
        assert.throws(() => lowered(SOURCE.replace(from, to)), message);
    // A loose comparison of a dynamic value with anything but null.
    refuses(
        'if (value === null) return "null";',
        'if (value == 0) return "null";',
        /loose comparison of a dynamic value/,
    );
    // Object.entries over a typed record.
    refuses(
        "for (const [key, entry] of Object.entries(object))",
        "for (const [key, entry] of Object.entries({ a: 1 }))",
        /Object\.entries of a non-dynamic value/,
    );
    // A spread of a number into a record literal.
    refuses(
        "...(flag ? { flag: true } : {}) };",
        "...(flag ? { flag: true } : {}), ...(Kind.Large as unknown as object) };",
        /spread of/,
    );
    // A tuple of two element types.
    refuses(
        "const delta: [number, number, number] = [3, 4, 12];",
        'const delta: [number, number, number] = [3, 4, 12];\n    const mixed: [number, string] = [1, "a"];\n    void mixed;',
        /tuples are admitted over numbers or one element type/,
    );
});
