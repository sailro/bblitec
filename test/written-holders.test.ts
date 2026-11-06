import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { createCompilerProgram } from "../src/compiler/program.js";
import { programObservations } from "../src/compiler/program-observations.js";
import { runSelfCheckingProgram } from "./self-checking-program.js";

// Generic setters and reflective writers reach a record only through the
// calls that hand it over.
const helpers = `
interface Store { alive(): boolean; count: number }
interface Row { a?: number; b?: string }
const setOptional = <T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void => {
    if (value === undefined) delete target[key];
    else target[key] = value;
};
function restore(source: object, row: object): void {
    Object.assign(source, row);
}
function grabber<D extends object>(rows: () => D): () => void {
    const source = rows();
    const row = { ...source };
    return () => restore(source, row);
}
const kept: Row = {};
setOptional(kept, "a", 1);
grabber(() => kept)();
export const store: Store = { alive: () => true, count: 0 };
`;

/** The written holder types and properties of the writes at each `marker` line. */
function writesOf(source: string): Map<string, string[]> {
    const fileName = resolve("written-holders.ts");
    const { program } = createCompilerProgram(source, fileName);
    assert.deepEqual(
        ts
            .getPreEmitDiagnostics(program)
            .map((diagnostic) =>
                ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
            ),
        [],
    );
    const checker = program.getTypeChecker();
    const entry = program.getSourceFile(fileName);
    const found = new Map<string, string[]>();
    for (const [type, writes] of programObservations(program).writes)
        for (const write of writes) {
            if (write.node.getSourceFile() !== entry) continue;
            const text = write.node.getText();
            const list = found.get(text) ?? [];
            list.push(
                `${checker.typeToString(type)}${write.property === undefined ? "" : `.${write.property}`}`,
            );
            found.set(text, list);
        }
    return found;
}

test("a write through a directly called function's parameter lands on what its calls pass", () => {
    const writes = writesOf(helpers);
    // `T` and `K` are what the one call instantiates; `source: object`
    // holds the `D` the generic factory's one call instantiates.
    assert.deepEqual(writes.get("target[key]"), ["Row.a", "Row.a"]);
    assert.deepEqual(writes.get("Object.assign(source, row)"), ["Row"]);
});

test("a write through a parameter of an escaping function stays open", () => {
    const writes = writesOf(`${helpers}\nexport const escaped = restore;\n`);
    assert.deepEqual(writes.get("Object.assign(source, row)"), ["object"]);
    assert.deepEqual(writes.get("target[key]"), ["Row.a", "Row.a"]);
});

test("a class instance viewed through its own members stays one object beside a generic setter", (t) => {
    // The setter writes only the record its call hands it, so the store's
    // view is the store: a handle added after the frame took it is alive.
    const source = `
class Store {
    private readonly live = new Set<number>();
    add(handle: number): void { this.live.add(handle); }
    isAlive(handle: number): boolean { return this.live.has(handle); }
}
type Liveness = Pick<Store, "isAlive">;
class Frame {
    constructor(private readonly core: Liveness) {}
    publish(handle: number): boolean { return this.core.isAlive(handle); }
}
interface Row { a?: number; b?: string }
const setOptional = <T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void => {
    if (value === undefined) delete target[key];
    else target[key] = value;
};
const store = new Store();
const frame = new Frame(store);
store.add(3);
const row: Row = {};
setOptional(row, "a", 2);
if (!frame.publish(3) || frame.publish(4)) throw new Error("live view");
if (row.a !== 2) throw new Error("setter");
`;
    return runSelfCheckingProgram(t, "written-holders-view", source, {
        compile: { fileName: resolve("written-holders-view.ts") },
        expectedOutput: "",
    });
});
