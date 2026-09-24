import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { CompileError, compileSource } from "../src/compiler.js";
import {
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

// `JSON.parse(text) as T` stored where T is represented: the document is
// read into T member by member once the program's own guards have run.
const declarations = `
type Kind = "stone" | "dirt";
interface Point { x: number; y: number }
interface Saved {
    v: 1;
    name: string;
    kind: Kind;
    origin: Point;
    marks: number[];
    label?: string;
    extra: { on: boolean } | null;
}

function read(text: string): Saved | null {
    try {
        const data = JSON.parse(text) as Saved;
        if (data && data.v === 1 && typeof data.name === "string" && Array.isArray(data.marks)) {
            return data;
        }
    } catch {
        /* malformed */
    }
    return null;
}

const sample = '{"v":1,"name":"a","kind":"dirt","origin":{"x":1,"y":2},"marks":[3,4],"extra":{"on":true}}';
`;

const agreed = `
async function main(): Promise<void> {
    const good = read(sample);
    if (!good || good.name !== "a" || good.kind !== "dirt" || good.origin.y !== 2 ||
        good.marks.length !== 2 || good.marks[1] !== 4 || good.label !== undefined ||
        !good.extra || !good.extra.on) throw new Error("typed read");
    good.origin.x = 9;
    good.marks.push(5);
    const again = read(sample);
    if (!again || again.origin.x !== 1 || again.marks.length !== 2) throw new Error("independent reads");
    const labelled = read('{"v":1,"name":"b","kind":"stone","origin":{"x":0,"y":0},"marks":[],"label":"l","extra":null}');
    if (!labelled || labelled.label !== "l" || labelled.extra !== null || labelled.kind !== "stone") throw new Error("optional members");
    if (read('{"v":2,"name":"a","kind":"dirt","origin":{"x":1,"y":2},"marks":[],"extra":null}') !== null) throw new Error("guard");
    if (read("{") !== null) throw new Error("malformed");
    if (read("null") !== null) throw new Error("null document");
}
`;

// JavaScript keeps a member of another type; typed storage cannot, so the
// read throws a TypeError, which this program's own catch turns into null.
const mistyped = `
function nameOf(record: Saved): string {
    return record.name;
}

async function main(): Promise<void> {
    for (const text of [
        '{"v":1,"name":"a","kind":"dirt","origin":{"x":"1","y":2},"marks":[],"extra":null}',
        '{"v":1,"name":"a","kind":"clay","origin":{"x":1,"y":2},"marks":[],"extra":null}',
        '{"v":1,"name":"a","kind":"dirt","origin":{"x":1},"marks":[],"extra":null}',
        '{"v":1,"name":"a","kind":"dirt","origin":{"x":1,"y":2},"marks":["3"],"extra":null}',
    ]) {
        if (read(text) !== null) throw new Error("mistyped member stored: " + text);
    }
    let message = "";
    try {
        message = nameOf(JSON.parse('{"v":1,"name":"a","kind":"dirt","origin":[],"marks":[],"extra":null}') as Saved);
    } catch (error) {
        message = error instanceof Error ? error.name + ": " + error.message : "";
    }
    if (message !== "TypeError: Parsed JSON member 'origin' is not an object.") throw new Error(message);
}
`;

function nativeRun(
    t: TestContext,
    name: string,
    source: string,
): string | undefined {
    const directory = resolve(`artifacts/json-decode/${name}`);
    mkdirSync(directory, { recursive: true });
    const result = compileSource(`${source}\nvoid main();\n`, {
        fileName: join(directory, "entry.ts"),
    });
    const tools = optionalNativeFixtureTools();
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return undefined;
    }
    const cpp = join(directory, "check.cpp");
    const exe = join(directory, "check.exe");
    writeFileSync(cpp, result.cpp);
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        "/I",
        "native/include",
        "/I",
        join(nativeFixtureVcpkgRoot, "include"),
        `/Fo:${directory}/`,
        `/Fe:${exe}`,
        cpp,
    ]);
    const execution = spawnSync(exe, { encoding: "utf8", timeout: 10000 });
    assert.equal(execution.stderr, "");
    assert.equal(execution.status, 0);
    return result.cpp;
}

test("a parsed document stored as a record reads its members natively", async (t) => {
    let completed = false;
    await runInNewContext(
        ts.transpile(
            `${declarations}${agreed}\nmain().then(() => completed());`,
            { target: ts.ScriptTarget.ES2022 },
        ),
        {
            completed: () => {
                completed = true;
            },
        },
    );
    assert.equal(completed, true, "JavaScript oracle completed");
    const cpp = nativeRun(t, "agreed", `${declarations}${agreed}`);
    if (cpp) {
        assert.match(cpp, /bbl::js::json_decode<bblscene::Saved>/);
        assert.match(
            cpp,
            /inline void json_read\(const bbl::js::JsonValue& json, SavedData& value/,
        );
    }
});

test("a parsed member of another type throws a TypeError where it is stored", (t) => {
    nativeRun(t, "mistyped", `${declarations}${mistyped}`);
});

test("a parsed document refuses targets it cannot be read into", () => {
    assert.throws(
        () =>
            compileSource(
                `
                interface Holder { pair: [number, number] }
                function make(): Holder {
                    return JSON.parse("{}") as Holder;
                }
                async function main(): Promise<void> {
                    const holder = make();
                    holder.pair[0] = 1;
                }
                void main();
                `,
                { fileName: "examples/json-decode-refusal.ts" },
            ),
        (error: unknown) =>
            error instanceof CompileError &&
            /not read into a 'tuple' value/.test(error.message),
    );
});
