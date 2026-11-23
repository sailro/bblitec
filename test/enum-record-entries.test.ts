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
