import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { LoweringContext } from "../src/lowering/context.js";
import { PinnedRecordModel } from "../src/lowering/pinned-record-lowerer.js";
import { pinnedTypedProgram } from "../src/lowering/pinned-typed-program.js";
import { UpstreamSourceStore } from "../src/upstream-source.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const MODULE = "src/fixture/record-closures.ts";

/**
 * A pinned module over closures and classes: a class with private fields,
 * accessors and a method that writes through its own setter; a factory
 * whose locals its closures share (a nested function hoisted above the
 * constant it captures, an arrow, an object literal's accessor pair and
 * method); a parameter a type-only module erased (`Point`, whose module the
 * store does not carry); and the reference cycle a callback stored in the
 * object it closes over makes.
 */
const SOURCE = `import type { Point } from "./erased-types.js";

export class Counter {
    private _value: number;
    private readonly _onChange: () => void;
    private _changes = 0;
    constructor(value: number, onChange: () => void) {
        this._value = value;
        this._onChange = onChange;
    }
    get value(): number {
        return this._value;
    }
    set value(v: number) {
        if (this._value !== v) {
            this._value = v;
            this._changes++;
            this._onChange();
        }
    }
    get changes(): number {
        return this._changes;
    }
    add(delta: number): void {
        this.value = this._value + delta;
    }
}

export interface Probe {
    readonly counter: Counter;
    doubled: number;
    readonly log: number[];
    snapshot(): number;
    reset: () => void;
}

export function twice(point: Point): number {
    return point.value * 2;
}

export function createProbe(seed: number): Probe {
    let notifications = 0;
    const log: number[] = [];
    function note(): void {
        notifications++;
        log.push(counter.value);
    }
    const counter = new Counter(seed, note);
    const probe: Probe = {
        counter,
        get doubled() {
            return twice(counter) + notifications;
        },
        set doubled(v: number) {
            counter.value = v / 2;
        },
        log,
        snapshot() {
            return notifications * 1000 + counter.changes;
        },
        reset: () => {
            notifications = 0;
            log.length = 0;
        },
    };
    return probe;
}

export function run(): number[] {
    const probe = createProbe(3);
    const out: number[] = [];
    probe.counter.value = 4;
    probe.counter.value = 4;
    probe.counter.add(2);
    out.push(probe.doubled, probe.snapshot(), probe.log.length);
    probe.doubled = 20;
    out.push(probe.counter.value, probe.snapshot(), probe.log[2]!);
    probe.reset();
    out.push(probe.snapshot(), probe.log.length, probe.doubled);
    return out;
}
`;

/** The pinned store with one extra module; its type-only import stays unserved. */
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

function fixtureModel(source: string): PinnedRecordModel {
    const store = new FixtureStore(source);
    return new PinnedRecordModel(
        new LoweringContext(store),
        pinnedTypedProgram(store, [MODULE]),
        {
            records: [
                { pinned: ["Counter"], cpp: "Counter", reference: true },
                {
                    pinned: ["Probe"],
                    cpp: "Probe",
                    reference: true,
                    accessors: new Set(["doubled"]),
                },
            ],
            values: new Map(),
            adapters: new Map(),
            exported: new Set([`${MODULE}#run`, `${MODULE}#createProbe`]),
        },
    );
}

function lowered(source: string): string {
    const model = fixtureModel(source);
    const { declarations, definitions } = model.lower([
        model.functionDeclaration(MODULE, "run"),
        model.functionDeclaration(MODULE, "createProbe"),
    ]);
    return `#pragma once
#include <bblite/pinned_records.hpp>
namespace bbl {
${model.structs(["Counter", "Probe"])}
${declarations}
${definitions}
} // namespace bbl
`;
}

test("pinned closures share their frame's environment, classes lower their accessors, and the cycles they close are collected", async (t) => {
    const header = lowered(SOURCE);
    // A closure reads its frame's bindings through the environment it received.
    assert.match(header, /bbl::js::make_closure\(environment_\d+,/);
    // The erased parameter took the shape the call passes.
    assert.match(
        header,
        /twice\(std::shared_ptr<bbl::Counter> point\)[^]*counter_get_value\(point\)/,
    );
    // The environment and the class describe their edges.
    assert.match(header, /struct create_probe_environment_\d+ \{[^]*gc_trace/);
    const javascript = ts.transpileModule(SOURCE, {
        compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
        },
    }).outputText;
    const pinned = (await import(
        `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`
    )) as { run(this: void): number[] };
    const expected = pinned.run();
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/test-pinned-record-closures");
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, "closures.hpp"), header);
    writeFileSync(
        resolve(directory, "check.cpp"),
        `#include "closures.hpp"
#include <iostream>
int main() {
    const auto baseline = bbl::js::managed_node_count();
    const auto out = bbl::run();
    for (std::size_t index = 0; index < out.size(); ++index)
        std::cout << (index ? " " : "") << bbl::js::number_to_string(out[index]);
    std::cout << "\\n";
    // The probe is gone; its counter and the note closure still own each other.
    if (bbl::js::managed_node_count() <= baseline) return 2;
    bbl::js::collect_cycles();
    if (bbl::js::managed_node_count() != baseline) return 3;
    return 0;
}
`,
    );
    const exe = resolve(directory, "check.exe");
    runNativeFixtureCompiler(native, [
        "/nologo",
        "/std:c++20",
        "/EHsc",
        "/W4",
        "/WX",
        "/permissive-",
        `/I${resolve("native/include")}`,
        `/I${directory}`,
        resolve(directory, "check.cpp"),
        `/Fo${resolve(directory, "check.obj")}`,
        `/Fe${exe}`,
    ]);
    const printed = execFileSync(exe, [], { cwd: directory, encoding: "utf8" });
    assert.equal(printed.trim(), expected.join(" "));

    // A hoisted function called before the constant it captures is
    // declared reads it in its temporal dead zone: both sides throw.
    const early = SOURCE.replace(
        "    const counter = new Counter(seed, note);",
        "    note();\n    const counter = new Counter(seed, note);",
    );
    const earlyModule = (await import(
        `data:text/javascript;base64,${Buffer.from(
            ts.transpileModule(early, {
                compilerOptions: {
                    target: ts.ScriptTarget.ES2022,
                    module: ts.ModuleKind.ESNext,
                },
            }).outputText,
        ).toString("base64")}`
    )) as { createProbe(this: void, seed: number): unknown };
    assert.throws(() => earlyModule.createProbe(3), ReferenceError);
    writeFileSync(resolve(directory, "early.hpp"), lowered(early));
    writeFileSync(
        resolve(directory, "early.cpp"),
        `#include "early.hpp"
int main() {
    try {
        static_cast<void>(bbl::create_probe(3.0));
    } catch (const std::runtime_error&) {
        return 0;
    }
    return 1;
}
`,
    );
    const earlyExe = resolve(directory, "early.exe");
    runNativeFixtureCompiler(native, [
        "/nologo",
        "/std:c++20",
        "/EHsc",
        "/W4",
        "/WX",
        "/permissive-",
        `/I${resolve("native/include")}`,
        `/I${directory}`,
        resolve(directory, "early.cpp"),
        `/Fo${resolve(directory, "early.obj")}`,
        `/Fe${earlyExe}`,
    ]);
    execFileSync(earlyExe, [], { cwd: directory });
});

test("pinned closures refuse what their environment cannot represent", () => {
    // A closure over a binding declared inside a block would need an
    // environment per block execution.
    assert.throws(
        () =>
            lowered(
                SOURCE.replace(
                    "    const probe: Probe = {",
                    "    if (seed > 0) { const inner = seed; log.push((() => inner)()); }\n    const probe: Probe = {",
                ),
            ),
        /captures a block-scoped binding/,
    );
    // A closure declaring parameters its callers never pass.
    assert.throws(
        () =>
            lowered(
                SOURCE.replace(
                    "reset: () => {",
                    "reset: (extra?: number) => {",
                ),
            ),
        /takes more parameters than its callers pass/,
    );
    // A class that extends another is outside the member table.
    assert.throws(
        () =>
            lowered(
                SOURCE.replace(
                    "export class Counter {",
                    "class Base {}\nexport class Counter extends Base {",
                ).replace(
                    "        this._value = value;",
                    "        super();\n        this._value = value;",
                ),
            ),
        /class inheritance is not lowered/,
    );
});
