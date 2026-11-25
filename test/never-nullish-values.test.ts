import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runSelfCheckingProgram } from "./self-checking-program.js";

// `doc.v ?? 0.2` is never null or undefined whatever the document holds:
// every test of it against either is constant, directly and through a
// const. A fallback that may itself be nullish leaves the test a run-time
// one.
const source = `
function read(text: string | null): string {
    const doc = JSON.parse(text ?? "{}") as { v?: number; w?: number; s?: string };
    const tone = doc.v ?? 0.2;
    const label = doc.s ?? "plain";
    const maybe = doc.v ?? doc.w;
    return [
        tone === undefined ? "u" : "d",
        tone !== null ? "n" : "N",
        tone == null ? "l" : "L",
        (doc.v ?? 0.2) != undefined ? "e" : "E",
        label === undefined ? "s" : label,
        maybe === undefined ? "absent" : String(maybe),
        String(tone),
    ].join(" ");
}
const absent = read(null);
const given = read('{"v":0.5,"s":"named"}');
const fallback = read('{"w":3}');
if (absent !== "d n L e plain absent 0.2") throw new Error(absent);
if (given !== "d n L e named 0.5 0.5") throw new Error(given);
if (fallback !== "d n L e plain 3 0.2") throw new Error(fallback);
`;

test("a parsed value coalesced with a known fallback is never nullish", (t) =>
    runSelfCheckingProgram(t, "never-nullish-values", source, {
        compile: { fileName: resolve("never-nullish-values.ts") },
        expectedOutput: "",
    }));

test("presence tests of a never-nullish value fold; a nullish fallback keeps its test", () => {
    const { cpp } = compileSource(source);
    assert.doesNotMatch(cpp, /v_fn\d+_tone\.is_(undefined|null)\(\)/);
    assert.doesNotMatch(cpp, /v_fn\d+_label\.is_(undefined|null)\(\)/);
    assert.match(cpp, /v_fn\d+_maybe\.is_undefined\(\)/);
});
