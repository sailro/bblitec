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
 * empty string, a record whose member is an anonymous type literal, and a
 * union narrowed to fewer of its members (`typeof`, `in`, `Array.isArray`,
 * `instanceof` the language's or a platform class),
 * members of an `as const` object read as their literals, and a module
 * `RegExp | null` built once and matched (non-global and global), and a
 * string-keyed dictionary constant whose missing keys read `undefined`.
 * `run` prints what it computed.
 */
const SOURCE = `export interface Bus {
    readonly _graph: { readonly gain: number };
}

export interface MainBus {
    readonly _in: number;
}

export type PrimaryBus = Bus | MainBus;

export interface Holder {
    readonly _held: number;
}

export type Source = string | string[] | Holder | ArrayBuffer | Uint8Array;

function describe(source: Source): string {
    if (typeof source === "object" && source !== null && "_held" in source) {
        return "held " + source._held;
    }
    if (typeof source === "string") {
        return "url " + source;
    }
    if (source instanceof ArrayBuffer) {
        return "bytes " + source.byteLength;
    }
    if (typeof Uint8Array !== "undefined" && source instanceof Uint8Array) {
        return "view " + source.length;
    }
    if (Array.isArray(source)) {
        return "list " + source.length;
    }
    return "other";
}

export const Mode = { Idle: 0, Busy: 3, Label: "busy" } as const;

const Kinds: { [key: string]: string } = {
    wav: "audio/wav",
    mp3: 'audio/mpeg; codecs="mp3"',
};

function kindOf(key: string): string {
    const kind = Kinds[key];
    return kind === undefined ? "none" : kind;
}

let extension: RegExp | null = null;

function fileExtension(url: string): string | undefined {
    extension ??= new RegExp("\\\\.(\\\\w{3,4})($|\\\\?)");
    return url.match(extension)?.[1];
}

function digits(text: string): string {
    const found = text.match(new RegExp("\\\\d+", "g"));
    const first = text.match(/(\\d)(x)?/);
    return (found ? found.join("+") : "none") + "/" + (first ? first.length + ":" + first[0] : "none");
}

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
    const list: string[] = ["b.ogg", "c.mp3"];
    const holder: Holder = { _held: 3 };
    const bytes = new ArrayBuffer(4);
    const view = new Uint8Array(2);
    const sources: Source[] = ["a.wav", list, holder, bytes, view];
    const described = sources.map((source) => describe(source)).join(",");
    let mode: number = Mode.Idle;
    if (sounds.size > 1) mode = Mode.Busy;
    const modeName = mode === Mode.Busy ? Mode.Label : "idle";
    warnOnce("first");
    warnOnce("second");
    const flags = (plain ? "in " : "out ") + (warned ? "warned" : "quiet");
    const extensions = ["a.wav", "b.ogg?v=2", "c", "d.webm#t"].map((url) => fileExtension(url) ?? "-").join(",");
    const numbers = digits("a1b22c333") + " " + digits("none");
    const kinds = ["wav", "mp3", "aac"].map((key) => kindOf(key)).join("|");
    return \`\${snapshot.join(",")} \${sounds.size} \${offset} \${tail} \${mirrored.join(",")} \${input(main)} \${input(bus)} \${flags} \${warnings} \${lastWarning} \${described} \${mode} \${modeName} \${extensions} \${numbers} \${kinds}\`;
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
                { pinned: ["Holder"], cpp: "Holder", reference: true },
            ],
            values: new Map(),
            adapters: new Map(),
            platformClasses: new Map([
                ["Uint8Array", { kind: "typed", element: "u8" }],
            ]),
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
${model.structs(["Bus", "MainBus", "Holder", ...model.literalRecords()])}
${declarations}
${definitions}
} // namespace bbl
`;
}

test("the record model lowers set snapshots, structural tests, remainders, comma incrementors and zero module state", async (t) => {
    const header = lowered(SOURCE);
    assert.match(header, /std::holds_alternative<std::shared_ptr<bbl::Bus>>/);
    assert.match(header, /std::fmod\(/);
    // A frozen constant's members are their literals; the object is never built.
    assert.doesNotMatch(header, /->busy = /);
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
    assert.throws(
        () => lowered(SOURCE.replace('"g")', '"gu")')),
        /Pinned RegExp constructors support the g and i flags, not 'u'/,
    );
});
