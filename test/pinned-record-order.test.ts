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

const MODULE = "src/fixture/record-order.ts";

/**
 * A pinned module whose every multi-operand form has operands that observe
 * each other's order: a counter closure (`next`) that writes a binding the
 * other operands read, as template substitutions, call arguments, a
 * receiver spelled as an argument, constructions, object and array
 * literals, binary operands, an assignment's target and value, and each of
 * these again with awaited operands. JavaScript evaluates left to right;
 * C++ leaves argument and operand order unspecified (MSVC goes right to
 * left), so equal logs prove the lowering sequenced them.
 */
const SOURCE = `export class Pair {
    constructor(
        readonly first: number,
        readonly second: number
    ) {}
}

export interface Holder {
    items: number[];
    label: string;
}

function later(log: string[], value: number): Promise<number> {
    return new Promise<number>((resolve) => {
        log.push(\`later \${value}\`);
        resolve(value);
    });
}

function join3(a: number, b: number, c: number): string {
    return \`\${a},\${b},\${c}\`;
}

function guarded(log: string[], limit: number): number {
    if (limit < 0) return -1;
    const twice = (): number => limit * 2;
    log.push(\`guarded \${limit}\`);
    return twice();
}

export async function run(): Promise<string> {
    const log: string[] = [];
    let n = 0;
    const next = (): number => {
        n += 1;
        log.push(\`next \${n}\`);
        return n;
    };
    const holder: Holder = { items: [0, 0, 0, 0, 0, 0, 0, 0], label: "h" };
    const relabel = (): string => {
        holder.label = \`h\${n}\`;
        return holder.label;
    };
    log.push(\`guard \${guarded(log, -1)} \${guarded(log, 3)}\`);
    log.push(\`template \${next()}|\${n}|\${next()}|\${n}\`);
    log.push(\`call \${join3(next(), n, next())}\`);
    log.push(\`slice \${"abcdefghijklmnopqrstuvwxyz".slice(next(), next())}\`);
    log.push(\`index \${holder.items.indexOf(0, next() - n)}\`);
    const pair = new Pair(next(), next());
    log.push(\`pair \${pair.first} \${pair.second}\`);
    const literal = { a: next(), b: n, c: next() };
    log.push(\`object \${literal.a} \${literal.b} \${literal.c}\`);
    const list = [next(), n, next()];
    log.push(\`array \${list.join(",")}\`);
    log.push(\`binary \${next() - next()} \${n + next()} \${next() < n} \${"s" + next() + n}\`);
    holder.items[next() % 8] = next();
    log.push(\`assign \${holder.items.join("")}\`);
    log.push(\`label \${holder.label + relabel() + holder.label}\`);
    log.push(\`await \${await later(log, next())}|\${n}|\${await later(log, next())}\`);
    log.push(\`await call \${join3(next(), await later(log, n), next())}\`);
    const awaitedList = [next(), await later(log, n), next()];
    log.push(\`await array \${awaitedList.join(",")}\`);
    const awaitedObject = { a: next(), b: await later(log, n), c: next() };
    log.push(\`await object \${awaitedObject.a} \${awaitedObject.b} \${awaitedObject.c}\`);
    const awaitedPair = new Pair(await later(log, next()), next());
    log.push(\`await pair \${awaitedPair.first} \${awaitedPair.second}\`);
    log.push(\`await binary \${(await later(log, n)) - next()} \${n + (await later(log, next()))}\`);
    return log.join("\\n");
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
                { pinned: ["Holder"], cpp: "Holder", reference: true },
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
${model.structs(["Pair", "Holder", ...model.literalRecords()])}
${declarations}
${definitions}
} // namespace bbl
`;
}

test("the record model evaluates every multi-operand form left to right, awaited operands included", async (t) => {
    const header = lowered(SOURCE);
    // Operands that observe each other run first, into temporaries; an
    // awaited one is declared ahead and assigned in order.
    assert.match(header, /\[&\] \{ auto ordered_\d+ = /);
    assert.match(header, /static_cast<void>\(ordered_\d+ = \(co_await /);
    // A leading guard returns before the frame allocates its environment.
    assert.match(
        header,
        /inline double guarded\([^)]*\) \{\s*if \([^\n]*\) \{\s*return \(-1\.0\);\s*\}\s*auto environment_\d+ = bbl::js::make_gc_shared/,
    );
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
    const directory = resolve("artifacts/test-pinned-record-order");
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, "order.hpp"), header);
    writeFileSync(
        resolve(directory, "check.cpp"),
        `#include "order.hpp"
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

test("the record model refuses orders it cannot keep: a compound assignment's target, an await inside a lambda", () => {
    const refuses = (from: string, to: string, message: RegExp): void => {
        assert.ok(SOURCE.includes(from), from);
        assert.throws(() => lowered(SOURCE.replace(from, to)), message);
    };
    // The value writes what the target reads (`next` increments `n`), and
    // C++ evaluates it first.
    refuses(
        "    const pair = new Pair(",
        "    n += next();\n    const pair = new Pair(",
        /compound assignment whose value's effects may change its target/,
    );
    // A `??` fallback is a lambda, which cannot hold a `co_await`.
    refuses(
        "    return log.join(",
        "    log.push(`nullish ${(n > 1000 ? 7 : undefined) ?? (await later(log, 1))}`);\n    return log.join(",
        /await inside an expression lowered as a lambda/,
    );
});
