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

const MODULE = "src/fixture/record-async.ts";

/**
 * A pinned module over the asynchronous language the record model lowers:
 * async functions and arrows as coroutines, `await` inside `try`, `catch`
 * and template arguments, `new Promise` executors, `then`/`catch`/`finally`
 * chains, `Promise.resolve`/`reject`, `try`/`catch`/`finally` with and
 * without a binding, Error subclasses (a parameter property, a `name`),
 * `new Error(message, { cause })`, `RangeError`, `instanceof` over authored
 * and built-in classes, a generic arrow called at two types, and closures
 * over per-iteration and block bindings. `run` logs the order everything
 * happened in, so equal logs are equal microtask ordering.
 */
const SOURCE = `export class PoolError extends Error {
    constructor(
        readonly code: number,
        message: string
    ) {
        super(\`pool \${message}\`);
        this.name = "PoolError";
    }
}

class Retry extends Error {}

function settle(log: string[], label: string, value: number, fail: boolean): Promise<number> {
    return new Promise<number>((resolve, reject) => {
        log.push(\`executor \${label}\`);
        if (fail) {
            reject(new PoolError(value, label));
            return;
        }
        resolve(value);
    });
}

async function guarded(log: string[], label: string, fail: boolean): Promise<number> {
    try {
        const value = await settle(log, label, 2, fail);
        log.push(\`resolved \${label} \${value}\`);
        return value * 10;
    } catch (error) {
        if (error instanceof PoolError) {
            log.push(\`caught \${label} \${error.name} \${error.message} \${error.code}\`);
            return await settle(log, \`\${label} retry\`, 3, false);
        }
        throw error;
    } finally {
        log.push(\`finally \${label}\`);
    }
}

async function wrapped(fail: boolean): Promise<string> {
    try {
        if (fail) {
            throw new RangeError("out of range");
        }
        return "fine";
    } catch (error) {
        throw new Error(error instanceof RangeError ? "wrapped range" : "wrapped", { cause: error });
    }
}

function parsed(text: string): string {
    try {
        JSON.parse(text);
        return "valid";
    } catch {
        return "invalid";
    }
}

async function parkedAsync(empty: boolean): Promise<unknown> {
    if (empty) return null;
    return undefined;
}

export async function run(): Promise<string> {
    const log: string[] = [];
    const limited = <T>(label: string, operation: () => Promise<T>): Promise<T> =>
        new Promise<T>((resolve, reject) => {
            log.push(\`limit \${label}\`);
            void operation()
                .then(resolve, reject)
                .finally(() => {
                    log.push(\`limit done \${label}\`);
                });
        });
    const first = guarded(log, "a", false);
    const second = guarded(log, "b", true);
    void Promise.resolve(1).then((value) => {
        log.push(\`then \${value}\`);
    });
    log.push("sync end");
    log.push(\`results \${await first} \${await second}\`);
    try {
        await wrapped(true);
    } catch (error) {
        log.push(\`wrapped \${error instanceof Error ? error.message : "?"} \${error instanceof RangeError}\`);
    }
    log.push(\`fine \${await wrapped(false)}\`);
    const count = await limited("count", async () => 4);
    const text = await limited("text", () => Promise.resolve("t"));
    log.push(\`limited \${count} \${text}\`);
    await Promise.reject(new Retry("again")).catch((error: unknown) => {
        log.push(\`retry \${error instanceof Retry} \${error instanceof PoolError}\`);
    });
    const kept = await Promise.resolve(5).finally(() => {
        log.push("finally callback");
    });
    const readers: (() => number)[] = [];
    for (let index = 0; index < 3; index++) {
        readers.push(() => index * 2);
    }
    for (const value of [7, 8]) {
        const doubled = value * 2;
        readers.push(() => doubled);
    }
    const parkedNull = await parkedAsync(true);
    const parkedUndefined = await parkedAsync(false);
    log.push(\`parked \${parkedNull === null} \${parkedUndefined === undefined}\`);
    log.push(\`kept \${kept} readers \${readers.map((read) => read()).join(",")} \${parsed("[1]")} \${parsed("{")}\`);
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
                { pinned: ["PoolError"], cpp: "PoolError", reference: true },
                { pinned: ["Retry"], cpp: "Retry", reference: true },
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
${model.structs(["PoolError", "Retry", ...model.literalRecords()])}
${declarations}
${definitions}
} // namespace bbl
`;
}

test("the record model lowers async functions, promises, errors and block closures in the pin's order", async (t) => {
    const header = lowered(SOURCE);
    // Async functions are coroutines; an await in a catch handler runs
    // after the handler captured its exception.
    assert.match(header, /co_await bbl::/);
    assert.match(header, /std::exception_ptr caught_/);
    assert.match(header, /bbl::pinned::next_iteration\(/);
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
    const directory = resolve("artifacts/test-pinned-record-async");
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, "async.hpp"), header);
    writeFileSync(
        resolve(directory, "check.cpp"),
        `#include "async.hpp"
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

test("the record model refuses async and error forms it cannot order or represent", () => {
    const refuses = (from: string, to: string, message: RegExp): void => {
        assert.ok(SOURCE.includes(from), from);
        assert.throws(() => lowered(SOURCE.replace(from, to)), message);
    };
    // An await inside a finally block.
    refuses(
        "log.push(`finally ${label}`);",
        "await settle(log, label, 1, false);",
        /finally block awaits/,
    );
    // A finally block that leaves its statement.
    refuses(
        "log.push(`finally ${label}`);",
        "return 0;",
        /finally block leaves its statement/,
    );
    // instanceof of a class chosen at run time.
    refuses(
        "if (error instanceof PoolError) {",
        "if (error instanceof (fail ? PoolError : Retry)) {",
        /instanceof of a computed class/,
    );
    // A generic closure read as a value.
    refuses(
        'const count = await limited("count", async () => 4);',
        'const alias = limited;\n    const count = await alias("count", async () => 4);',
        /generic closure is only called/,
    );
    // A promise built from an executor that is not a literal.
    refuses(
        "const kept = await Promise.resolve(5).finally(",
        "const executor = (resolve: (value: number) => void): void => resolve(5);\n    const kept = await new Promise<number>(executor).finally(",
        /new Promise takes one executor literal/,
    );
    // A destructured catch binding.
    refuses(
        "} catch (error) {\n        throw new Error(",
        "} catch ({ message }) {\n        const error = message;\n        throw new Error(",
        /catch binding pattern/,
    );
});
