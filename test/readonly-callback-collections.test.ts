import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("readonly callback collections retain dynamic selection, aliases and factory state", (t) => {
    const result = compileSource(`
        let calls = 0;
        const callbacks: readonly ((delta: number) => number)[] = [
            delta => { calls += delta; return calls; },
            delta => { calls += delta * 10; return calls; },
        ];
        const alias = callbacks;
        const first = callbacks[0]!;
        for (let index = 0; index < callbacks.length; index++) {
            const selected = callbacks[index]!;
            if (selected !== alias[index]) throw new Error("selected identity");
            if (selected(1) !== (index === 0 ? 1 : 11))
                throw new Error("selected capture");
        }
        if (first !== callbacks[0] || first(1) !== 12)
            throw new Error("alias before selection");
        let evaluations = 0;
        function make(step: number): () => number {
            evaluations++;
            let value = 0;
            return () => { value += step; return value; };
        }
        function select(step: number, index: number): () => number {
            const rows: readonly { run: () => number }[] = [
                {run: make(step)}, {run: make(step + 1)},
            ];
            const selected = rows[index]!;
            return selected.run;
        }
        const left = select(3, 1), right = select(3, 1);
        if (evaluations !== 4 || left === right || left() !== 4 || left() !== 8 || right() !== 4)
            throw new Error("factory lifetime and evaluations");
    `);
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(native, "readonly-callback-collections", result.cpp);
});
