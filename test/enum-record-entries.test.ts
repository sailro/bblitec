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
        const tuning = record({ walk: "w", run: "r" }, (name) => (name === "w" ? 1 : 2));
        if (!tuning || tuning.walk + tuning.run !== 3) throw new Error("entries");
        interface Round { pickupArrive: number; walk: number; run: number }
        const round: Round | undefined = tuning && { pickupArrive: 5, ...tuning, run: 7 };
        if (!round || round.walk !== 1 || round.run !== 7 || round.pickupArrive !== 5) throw new Error("spread");
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
        interface Amenity { timeoutSeconds: number; rejectSeconds: number }
        interface Tuning { amenity: Amenity | undefined; scale: number }
        function tuning(scale: number): Tuning {
            return { amenity: record({ timeoutSeconds: "t", rejectSeconds: "r" }, (name) => (name === "t" ? 4 : 5)), scale };
        }
        const state: { tuning: Tuning | null } = { tuning: null };
        state.tuning = tuning(2);
        const amenity = state.tuning.amenity;
        if (!amenity || amenity.timeoutSeconds + amenity.rejectSeconds !== 9) throw new Error("amenity");
    `);
    assert.match(cpp, /bblscene::AmenityData\{bbl::js::present\(/);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(tools, "enum-record-entries/struct", cpp, {
        expectedOutput: "",
    });
});
