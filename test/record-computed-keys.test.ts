import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("computed Record keys evaluate before values and retain the last assigned object", (t) => {
    const source = `
        const enum Slot { FIRST = 0, SECOND = 1 }
        interface Entry { value: number }
        const fixed: Record<Slot, Entry> = {
            [Slot.FIRST]: { value: 2 },
            [Slot.SECOND]: { value: 3 },
        };
        let trace = "";
        function key(label: string, value: number): number {
            trace += label;
            return value;
        }
        const retained = { value: 7 };
        function item(label: string, value: Entry): Entry {
            trace += label;
            return value;
        }
        const values: Record<number, Entry> = {
            [key("a", 4)]: item("b", fixed[Slot.FIRST]),
            [key("c", 4)]: item("d", retained),
            [key("e", 5)]: item("f", fixed[Slot.SECOND]),
        };
        if (trace !== "abcdef") throw new Error("key/value evaluation order");
        if (values[4] !== retained || values[5] !== fixed[Slot.SECOND])
            throw new Error("last-write identity");
        retained.value = 11;
        if (values[4]!.value !== 11 || values[5]!.value !== 3)
            throw new Error("computed-key alias");
        const named: Record<string, Entry> = { retained };
        if (named.retained !== retained) throw new Error("shorthand identity");
    `;
    runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
    );
    const compiled = compileSource(source);
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(native, "record-computed-keys", compiled.cpp);
});
