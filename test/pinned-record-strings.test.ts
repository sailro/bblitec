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

const MODULE = "src/fixture/record-strings.ts";
const IMPORT = 'import { Tally, tallyInto } from "tally-kit";';

/**
 * A pinned module over strings and a bundled package: regular-expression
 * and string replacement, repeat, split, trim of JavaScript white space,
 * charCodeAt and length over a const local, an Int32Array scratch, and a
 * package class (`Tally`, whose types the program cannot see) created
 * lazily into module state and filled by the package's one call.
 */
const SOURCE = `${IMPORT}

let scratch: Tally | null = null;
let marks: Int32Array | null = null;

export function summarize(text: string, tabSize: number): number[] {
    const collapsed = text.replace(/\\t/g, " ".repeat(tabSize)).replace(/ +/g, " ");
    const lines = collapsed.split("\\n");
    const tally = (scratch ??= new Tally());
    const ends = (marks ??= new Int32Array(4));
    const out: number[] = [collapsed.length, lines.length];
    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i]!.trim();
        out.push(trimmed.length, trimmed.length > 0 ? trimmed.charCodeAt(trimmed.length - 1) : -1);
        if (i < ends.length) {
            ends[i] = trimmed.length;
        }
    }
    tallyInto(tally, collapsed.replace("-", "--"));
    out.push(tally.total, ends[0]! + ends[1]!);
    return out;
}

export function run(): number[] {
    const out = summarize("a\\tb  c\\n  x-y \\n\\u00a0z\\u3000\\n\\u{1F600}", 2);
    const again = summarize("q-", 4);
    for (let i = 0; i < again.length; i++) {
        out.push(again[i]!);
    }
    return out;
}
`;

/** The package the pin bundles, as JavaScript runs it. */
const PACKAGE = `class Tally { total = 0; }
function tallyInto(tally: Tally, text: string): void { tally.total += text.length; }`;

/** The package's native side: its class and its one call. */
const NATIVE_PACKAGE = `#pragma once
#include <bblite/pinned_records.hpp>
namespace bbl {
struct Tally {
    double total = 0;
};
inline void tally_into(Tally& tally, const std::string& text) { tally.total += js::string_length(text); }
} // namespace bbl
`;

/** The pinned store with one extra module; its package import stays unserved. */
class FixtureStore extends UpstreamSourceStore {
    public override getSource(modulePath: string): string {
        return modulePath.replaceAll("\\", "/") === MODULE
            ? SOURCE
            : super.getSource(modulePath);
    }
    public override hasSource(modulePath: string): boolean {
        return (
            modulePath.replaceAll("\\", "/") === MODULE ||
            super.hasSource(modulePath)
        );
    }
}

function lowered(): string {
    const store = new FixtureStore();
    const model = new PinnedRecordModel(
        new LoweringContext(store),
        pinnedTypedProgram(store, [MODULE]),
        {
            records: [
                {
                    pinned: ["Tally"],
                    cpp: "Tally",
                    reference: true,
                    native: true,
                    members: new Map([
                        ["total", { shape: { kind: "number" } }],
                    ]),
                },
            ],
            values: new Map(),
            adapters: new Map([
                [
                    "tally-kit#tallyInto",
                    {
                        cpp: (argument) =>
                            `bbl::tally_into(*${argument(0)}, ${argument(1)})`,
                    },
                ],
            ]),
            unresolved: new Map([["Tally", { kind: "record", name: "Tally" }]]),
            exported: new Set([`${MODULE}#run`]),
        },
    );
    const { declarations, definitions } = model.lower([
        model.functionDeclaration(MODULE, "run"),
    ]);
    return `#pragma once
#include "tally.hpp"
namespace bbl {
${declarations}
${definitions}
} // namespace bbl
`;
}

test("pinned string methods, regular expressions and a bundled package's class and call lower as the pin runs them", async (t) => {
    const header = lowered();
    // The package's class is created natively; its call is the adapter.
    assert.match(header, /bbl::js::make_gc_shared<bbl::Tally>\(\)/);
    assert.match(header, /bbl::tally_into\(\*/);
    // Regular expression literals are runtime regular expressions.
    assert.match(header, /bbl::js::RegExp\(" \+", true, false\)/);
    const javascript = ts.transpileModule(SOURCE.replace(IMPORT, PACKAGE), {
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
    const directory = resolve("artifacts/test-pinned-record-strings");
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, "tally.hpp"), NATIVE_PACKAGE);
    writeFileSync(resolve(directory, "strings.hpp"), header);
    writeFileSync(
        resolve(directory, "check.cpp"),
        `#include "strings.hpp"
#include <iostream>
int main() {
    const auto out = bbl::run();
    for (std::size_t index = 0; index < out.size(); ++index)
        std::cout << (index ? " " : "") << bbl::js::number_to_string(out[index]);
    std::cout << "\\n";
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
});
