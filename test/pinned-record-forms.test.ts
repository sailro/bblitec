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

const MODULE = "src/fixture/record-forms.ts";

/**
 * The forms the pinned sound family uses beyond plain records: a Set
 * snapshotted with `Array.from`, a structural `"member" in value` over a
 * union of records and over one record, a remainder assignment, a loop
 * with two incrementors, module state starting from `false`, `0` and an
 * empty string, and a record whose member is an anonymous type literal.
 * `run` prints what it computed.
 */
const SOURCE = `export interface Bus {
    readonly _graph: { readonly gain: number };
}

export interface MainBus {
    readonly _in: number;
}

export type PrimaryBus = Bus | MainBus;

let warned = false;
let warnings = 0;
let lastWarning = "";

function warnOnce(message: string): void {
    if (!warned) {
        warned = true;
        warnings++;
        lastWarning = message;
    }
}

function input(bus: PrimaryBus): number {
    return "_graph" in bus ? bus._graph.gain : bus._in;
}

export function run(): string {
    const sounds = new Set<number>([3, 1, 2]);
    sounds.add(1);
    const snapshot = Array.from(sounds);
    sounds.delete(3);
    let offset = 7.5;
    offset %= 2;
    let tail = -7.25;
    tail %= 2;
    const mirrored: number[] = [];
    for (let i = 0, j = 4; i < 5; i++, j--) mirrored.push(i * 10 + j);
    const main: MainBus = { _in: 4 };
    const bus: Bus = { _graph: { gain: 0.5 } };
    const plain = "_in" in main;
    warnOnce("first");
    warnOnce("second");
    const flags = (plain ? "in " : "out ") + (warned ? "warned" : "quiet");
    return \`\${snapshot.join(",")} \${sounds.size} \${offset} \${tail} \${mirrored.join(",")} \${input(main)} \${input(bus)} \${flags} \${warnings} \${lastWarning}\`;
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
                { pinned: ["Bus"], cpp: "Bus", reference: true },
                { pinned: ["MainBus"], cpp: "MainBus", reference: true },
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
${model.structs(["Bus", "MainBus", ...model.literalRecords()])}
${declarations}
${definitions}
} // namespace bbl
`;
}

test("the record model lowers set snapshots, structural tests, remainders, comma incrementors and zero module state", async (t) => {
    const header = lowered(SOURCE);
    assert.match(header, /std::holds_alternative<std::shared_ptr<bbl::Bus>>/);
    assert.match(header, /std::fmod\(/);
    const javascript = ts.transpileModule(SOURCE, {
        compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
        },
    }).outputText;
    const pinned = (await import(
        `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`
    )) as { run(this: void): string };
    const expected = pinned.run();
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/test-pinned-record-forms");
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, "forms.hpp"), header);
    writeFileSync(
        resolve(directory, "check.cpp"),
        `#include "forms.hpp"
#include <iostream>
int main() {
    std::cout << bbl::run();
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
    assert.equal(printed, expected);
});

test("the record model refuses structural tests it cannot decide", () => {
    assert.throws(
        () =>
            lowered(
                SOURCE.replace(
                    'const plain = "_in" in main;',
                    'const key = "_in";\n    const plain = key in main;',
                ),
            ),
        /Pinned `in` with a computed key/,
    );
    assert.throws(
        () => lowered(SOURCE.replace("let warnings = 0;", "let warnings = 1;")),
        /Pinned module state starts from null, undefined, false, 0 or an empty string only/,
    );
});
