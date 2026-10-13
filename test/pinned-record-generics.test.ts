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

const MODULE = "src/fixture/record-generics.ts";

/**
 * Generic records and generic functions, monomorphized per instantiation: a
 * signal interface (and its narrower view) built by a generic factory whose
 * closures share a generic entry list, used at a record type and at
 * `number`; a generic identity function called at both; and a generic
 * function calling another with its own type parameter. `run` prints what
 * it computed.
 */
const SOURCE = `export interface Signal<T> {
    add(callback: (value: T) => void): () => void;
    addOnce(callback: (value: T) => void): () => void;
}

export interface SignalImpl<T> extends Signal<T> {
    _notify(value: T): void;
    _clear(): void;
    _count(): number;
}

interface Entry<T> {
    cb: (value: T) => void;
    once: boolean;
}

export function createSignal<T>(): SignalImpl<T> {
    let entries: Entry<T>[] | null = null;
    const remove = (callback: (value: T) => void): void => {
        if (!entries) {
            return;
        }
        const i = entries.findIndex((e) => e.cb === callback);
        if (i !== -1) {
            entries.splice(i, 1);
        }
    };
    return {
        add(callback) {
            (entries ??= []).push({ cb: callback, once: false });
            return () => remove(callback);
        },
        addOnce(callback) {
            (entries ??= []).push({ cb: callback, once: true });
            return () => remove(callback);
        },
        _notify(value) {
            if (!entries || entries.length === 0) {
                return;
            }
            const snapshot = entries.slice();
            for (const entry of snapshot) {
                if (entry.once) {
                    remove(entry.cb);
                }
                entry.cb(value);
            }
        },
        _clear() {
            entries = null;
        },
        _count() {
            return entries ? entries.length : 0;
        },
    };
}

export interface Voice {
    readonly id: number;
    readonly ended: SignalImpl<Voice>;
}

export interface Track {
    readonly name: string;
    readonly changed: SignalImpl<number>;
    readonly voices: SignalImpl<Voice>;
}

function identity<T>(value: T): T {
    return value;
}

function relay<T>(value: T): SignalImpl<T> {
    const signal = createSignal<T>();
    signal.add((received) => {
        void identity(received);
    });
    signal._notify(identity(value));
    return signal;
}

export function run(): string {
    const log: string[] = [];
    const track: Track = { name: "track", changed: createSignal<number>(), voices: createSignal() };
    const voice: Voice = { id: 7, ended: createSignal() };
    const stop = track.changed.add((value) => {
        log.push("changed " + value);
    });
    track.changed.addOnce((value) => {
        log.push("once " + value);
    });
    track.voices.add((v) => {
        log.push("voice " + v.id);
    });
    voice.ended.addOnce((v) => {
        log.push("ended " + identity(v).id);
    });
    track.changed._notify(1);
    track.changed._notify(2);
    stop();
    track.changed._notify(3);
    track.voices._notify(voice);
    voice.ended._notify(voice);
    voice.ended._notify(voice);
    track.voices._clear();
    track.voices._notify(voice);
    const relayed = relay(voice);
    log.push(
        "counts " + track.changed._count() + " " + track.voices._count() + " " + voice.ended._count() +
            " " + relayed._count() + " " + identity(4) + " " + identity(track).name,
    );
    return log.join(";");
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
                {
                    pinned: ["SignalImpl", "Signal"],
                    cpp: "Signal",
                    reference: true,
                },
                { pinned: ["Entry"], cpp: "SignalEntry", reference: true },
                { pinned: ["Voice"], cpp: "Voice", reference: true },
                { pinned: ["Track"], cpp: "Track", reference: true },
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
${model.structs(["Voice", "Track", ...model.instantiatedRecords(), ...model.literalRecords()])}
${declarations}
${definitions}
} // namespace bbl
`;
}

test("generic records and functions lower once per instantiation as the pin runs them", async (t) => {
    const header = lowered(SOURCE);
    // One struct and one factory per element type.
    assert.match(header, /struct SignalOfVoice\b/);
    assert.match(header, /struct SignalOfNumber\b/);
    assert.match(header, /create_signal_of_voice\(/);
    assert.match(header, /create_signal_of_number\(/);
    assert.match(header, /identity_of_number\(/);
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
    const directory = resolve("artifacts/test-pinned-record-generics");
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, "generics.hpp"), header);
    writeFileSync(
        resolve(directory, "check.cpp"),
        `#include "generics.hpp"
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

test("generic forms the model cannot monomorphize refuse", () => {
    assert.throws(
        () =>
            lowered(
                SOURCE.replace(
                    "const relayed = relay(voice);",
                    "void createSignal;\n    const relayed = relay(voice);",
                ),
            ),
        /Pinned generic function 'createSignal' is referenced as a value/,
    );
});
