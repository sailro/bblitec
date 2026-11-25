import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runSelfCheckingProgram } from "./self-checking-program.js";

// A body testing its defaulted parameter for `undefined` is shared and
// specialized on an argument that binds it present. A parsed value
// coalesced with a fallback is one: the shared body takes the document as
// its parameter and skips the default; one that may be absent keeps the
// run-time default; an omitted one takes it.
const source = `
function defaulted(tone: number = 7): number { return tone === undefined ? -1 : tone; }
function scaled(tone: number = 7, by = 2): number { return tone === undefined ? -1 : tone * by; }
function read(text: string | null): string {
    const doc = JSON.parse(text ?? "{}") as { v?: number; w?: number };
    const tone = doc.v ?? 0.2;
    return [
        defaulted(tone),
        defaulted(doc.w),
        defaulted(),
        scaled(tone),
        scaled(doc.w, doc.v ?? 3),
    ].join(" ");
}
const absent = read(null);
const given = read('{"v":0.5,"w":4}');
if (absent !== "0.2 7 7 0.4 21") throw new Error(absent);
if (given !== "0.5 4 7 1 2") throw new Error(given);
`;

test("a document argument of a defaulted parameter is the shared body's own argument", (t) =>
    runSelfCheckingProgram(t, "defaulted-shared-arguments", source, {
        compile: { fileName: resolve("defaulted-shared-arguments.ts") },
        expectedOutput: "",
    }));

test("a never-nullish argument skips the default; a maybe-absent one keeps its test", () => {
    const { cpp } = compileSource(source);
    const local = /JsonValue (v_fn\d+_tone) = /.exec(cpp)?.[1];
    assert.ok(local);
    const bodies = [
        ...cpp.matchAll(
            /^double bbl_recursive_fn\d+_group\(([^)]*JsonValue[^)]*)\) \{\n([\s\S]*?)\n\}/gm,
        ),
    ];
    assert.ok(bodies.length > 0);
    // No body names the caller's local.
    assert.ok(bodies.every(([, , body]) => !body!.includes(local)));
    // The bodies `tone` binds present take no default; `doc.w` keeps its test.
    assert.ok(bodies.every(([, , body]) => !/is_undefined\(\)/.test(body!)));
    assert.match(cpp, /default_argument_\d+\.is_undefined\(\)/);
});
