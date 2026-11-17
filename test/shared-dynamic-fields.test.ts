import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runSelfCheckingProgram } from "./self-checking-program.js";

test("a record field holding a parsed array shares it with the record type it is stored as", (t) => {
    // The returned literal keeps the parsed config's array; stored as `Snap`
    // it stays that one array, so a later push and an identity test agree.
    const source = `
interface Snap { n: number; stops: readonly number[] }
interface Config { stops: number[] }
const config = JSON.parse('{"stops":[1,2,3]}') as Config;
const listeners = new Set<(s: Snap) => void>();
let seen = 0;
let same = false;
listeners.add((s) => { seen = s.n + s.stops.length; same = s.stops === config.stops; });
const snapshot = (): Snap => ({ n: 1, stops: config.stops });
const snap = snapshot();
config.stops.push(4);
for (const listener of listeners) listener(snap);
if (seen !== 5 || !same) throw new Error("shared stops " + seen);
`;
    return runSelfCheckingProgram(t, "shared-dynamic-fields", source, {
        compile: { fileName: resolve("shared-dynamic-fields.ts") },
        expectedOutput: "",
    });
});

test("a local copied from a field holding a document writes the field's object", (t) => {
    // A parsed value reaches `Box`, so the field is a document. A `const` or
    // `let` local read from it names the same object: chained writes through
    // the local are what later reads of the field see, on every instance.
    const source = `
interface Box { minX: number; maxX: number }
function emptyBox(): Box { return { minX: Infinity, maxX: -Infinity }; }
function parsed(text: string): Box { return JSON.parse(text) as Box; }
class Bounds {
    private readonly union = emptyBox();
    private dirty = true;
    publish(value: number): boolean {
        const changed = this.dirty;
        if (changed) {
            const bounds = this.union;
            bounds.minX = bounds.maxX = value;
            this.dirty = false;
        }
        return changed;
    }
    widen(value: number): void {
        let bounds = this.union;
        bounds.maxX = bounds.minX = value;
    }
    min(): number { return this.union.minX; }
    max(): number { return this.union.maxX; }
}
const all: Bounds[] = [new Bounds(), new Bounds()];
let next = parsed('{"minX":2,"maxX":3}').minX;
for (const one of all) if (!one.publish(next++) || one.publish(9)) throw new Error("publish");
all[1]!.widen(7);
const seen = all.map((one) => one.min() + ":" + one.max()).join(" ");
if (seen !== "2:2 7:7") throw new Error(seen);
`;
    return runSelfCheckingProgram(t, "shared-dynamic-field-copies", source, {
        compile: { fileName: resolve("shared-dynamic-field-copies.ts") },
        expectedOutput: "",
    });
});

test("a document converted from a native array refuses writes through its local", () => {
    // The local holds the document the array is converted into, not the
    // array: a write through it does not reach the array JavaScript writes.
    assert.throws(
        () =>
            compileSource(
                `
const nums: number[] = [1, 2];
let view: unknown = nums;
(view as number[])[0] = (view as number[])[1] = 5;
if (nums[0] !== 5) throw new Error("converted");
view = "done";
`,
                { fileName: resolve("converted-document-write.ts") },
            ),
        /'view' is a value copy of a data path/,
    );
});
