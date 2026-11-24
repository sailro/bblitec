import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("a fresh dictionary reads as a record of a key union and spreads its entries", (t) => {
    const { cpp } = compileSource(`
        function record<K extends string>(names: Readonly<Record<K, string>>, read: (name: string) => number | undefined): Record<K, number> | undefined {
            const entries = (Object.keys(names) as K[]).map((key) => [key, read(names[key])] as const);
            const omitted = entries.filter(([, value]) => value === undefined).length;
            if (omitted === entries.length) return undefined;
            if (omitted > 0) throw new Error("split");
            return Object.fromEntries(entries) as Record<K, number>;
        }
        const settings = record({ walk: "w", run: "r" }, (name) => (name === "w" ? 1 : 2));
        if (!settings || settings.walk + settings.run !== 3) throw new Error("entries");
        interface Merged { extra: number; walk: number; run: number }
        const merged: Merged | undefined = settings && { extra: 5, ...settings, run: 7 };
        if (!merged || merged.walk !== 1 || merged.run !== 7 || merged.extra !== 5) throw new Error("spread");
    `);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(tools, "enum-record-entries/run", cpp, {
        expectedOutput: "",
    });
});

test("a key-union record stored as the struct of its keys is that struct", (t) => {
    const { cpp } = compileSource(`
        function record<K extends string>(names: Readonly<Record<K, string>>, read: (name: string) => number | undefined): Record<K, number> | undefined {
            const entries = (Object.keys(names) as K[]).map((key) => [key, read(names[key])] as const);
            const omitted = entries.filter(([, value]) => value === undefined).length;
            if (omitted === entries.length) return undefined;
            if (omitted > 0) throw new Error("split");
            return Object.fromEntries(entries) as Record<K, number>;
        }
        interface Pair { first: number; second: number }
        interface Settings { pair: Pair | undefined; scale: number }
        function settings(scale: number): Settings {
            return { pair: record({ first: "t", second: "r" }, (name) => (name === "t" ? 4 : 5)), scale };
        }
        const state: { settings: Settings | null } = { settings: null };
        state.settings = settings(2);
        const pair = state.settings.pair;
        if (!pair || pair.first + pair.second !== 9) throw new Error("pair");
    `);
    assert.match(cpp, /bblscene::PairData\{bbl::js::present\(/);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(tools, "enum-record-entries/struct", cpp, {
        expectedOutput: "",
    });
});
