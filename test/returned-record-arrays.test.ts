import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("returned nested mutable arrays preserve tuple and empty-array aliases", (t) => {
    const result = compileSource(`
        interface Particle { value: number; }
        interface Scratch { position: [number, number, number]; color?: [number, number, number, number]; }
        interface State { readonly particles: Particle[]; readonly scratch: Scratch; }
        function create(): State {
            return {particles: [], scratch: {position: [0, 0, 0], color: [0, 0, 0, 0]}};
        }
        function update(scratch: Scratch, amount: number): void {
            scratch.position[0] = amount;
            scratch.color![3] += amount;
        }
        function main(): void {
            const state = create();
            const alias = state.scratch.position;
            const particles = state.particles;
            particles.push({value: 5});
            for (const particle of particles) update(state.scratch, particle.value);
            if (alias[0] !== 5 || state.scratch.color![3] !== 5 || state.particles.length !== 1)
                throw new Error("returned arrays lost aliases");
            update(state.scratch, 2);
            if (alias[0] !== 2 || state.scratch.color![3] !== 7) throw new Error("tuple writes did not persist");
        }
        main();
    `);
    assert.match(result.cpp, /Tuple<3>/);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(tools, "returned-record-arrays", result.cpp);
});
