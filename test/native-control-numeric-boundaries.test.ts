import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

function checkNative(t: test.TestContext, name: string, source: string): void {
    runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
    );
    const result = compileSource(source);
    const native = optionalNativeFixtureTools(
        result.manifest.features.includes("data:json"),
    );
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(native, `native-control-numeric/${name}`, result.cpp, {
        timeoutMs: 10000,
    });
}

test("specialized runtime iterations stop at unconditional control transfers", (t) =>
    checkNative(
        t,
        "iteration",
        `
    function count(values: readonly unknown[]): number {
        let total = 0;
        for (const value of values) {
            if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
                total += value.byteLength;
                continue;
            }
            total += 100;
        }
        return total;
    }
    const rows: Uint8Array[] = [new Uint8Array(2), new Uint8Array(3)];
    if (count(rows) !== 5) throw new Error("specialized continue");
    if (count([1, 2]) !== 200) throw new Error("reachable fallback");
    `,
    ));

test("shared calls evaluate omitted numeric defaults in the callee", (t) =>
    checkNative(
        t,
        "defaults",
        `
    let defaults = 0;
    function fallback(value: number): number { defaults++; return value + 1; }
    function sum(value: number, rounds = fallback(value)): number {
        let result = 0;
        for (let pass = 0; pass <= rounds; pass++) result += value;
        return result;
    }
    const calls: Array<(value: number) => number> = [value => sum(value), value => sum(value, undefined), value => sum(value, 1)];
    if (calls[0]!(2) !== 8 || calls[0]!(3) !== 15 || calls[1]!(2) !== 8 || calls[2]!(2) !== 4 || defaults !== 3) throw new Error("default evaluation order");
    function mutable(value = 2): number { value++; return value; }
    if (mutable() !== 3 || mutable(undefined) !== 3) throw new Error("writable default");
    function accumulate(sample: (index: number) => number, rounds = 2): number {
        let result = 0;
        for (let pass = 0; pass <= rounds; pass++) result += sample(pass);
        return result;
    }
    const sampled: Array<(sample: (index: number) => number) => number> = [sample => accumulate(sample)];
    if (sampled[0]!(index => index + 1) !== 6) throw new Error("shared callback default");
    `,
    ));

test("guarded optional numeric comparisons preserve narrowing and operand effects", (t) =>
    checkNative(
        t,
        "optional-comparison",
        `
    interface Row { phase?: number; }
    function invalid(row: Row): boolean {
        return row.phase !== undefined && (!Number.isFinite(row.phase) || row["phase"] < 0 || row["phase"] > 1);
    }
    const checks: Array<(row: Row) => boolean> = [invalid];
    if (checks[0]!({}) || checks[0]!({phase: 0.5}) || !checks[0]!({phase: -1}) || !checks[0]!({phase: 2})) throw new Error("optional range");
    let effects = 0;
    function right(row: Row): number { effects++; row.phase = 0; return 0.4; }
    function ordered(row: Row): boolean { return row.phase !== undefined && row["phase"] > right(row); }
    const orders: Array<typeof ordered> = [ordered];
    const row: Row = {phase: 0.5};
    if (orders[0]!({}) || !orders[0]!(row) || effects !== 1) throw new Error("comparison effects");
    `,
    ));

test("stored value callbacks define native fallthrough after exhaustive switches", (t) =>
    checkNative(
        t,
        "switch",
        `
    type Mode = "first" | "second";
    function read(mode: Mode): number {
        switch (mode) {
            case "first": return 3;
            case "second": return 7;
        }
    }
    const callbacks: Array<(mode: Mode) => number> = [read];
    if (callbacks[0]!("first") !== 3 || callbacks[0]!("second") !== 7) throw new Error("exhaustive callback");
    `,
    ));
