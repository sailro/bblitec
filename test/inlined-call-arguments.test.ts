/**
 * An inlined call binds its arguments where it runs: a closure capturing a
 * parameter read from a tagged slot holds the value read, not the slot.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const tools = optionalNativeFixtureTools(false);

test(
    "a closure captures a parameter read from a tagged slot as its value",
    { skip: !tools },
    () => {
        const { cpp } = compileSource(
            `
            class Planner {
                constructor(readonly limit: number) {}
                blocked(x: number): boolean {
                    return x > this.limit;
                }
                sight(a: number, b: number): boolean {
                    return a <= b;
                }
            }
            interface Params {
                planner?: Planner | null;
                px: number;
            }
            const NONE = new Float32Array(0);
            function count(n: number, accept: (x: number) => boolean): number {
                let c = 0;
                for (let i = 0; i < n; i++) if (accept(i)) c++;
                return c;
            }
            function update(planner: Planner | null | undefined, px: number, extra: Float32Array = NONE): number {
                if (!planner) return -1;
                return count(10, (x) => !planner.blocked(x) && planner.sight(px, x)) + extra.length;
            }
            function step(p: Params): number {
                if (p.planner === undefined) return -2;
                return update(p.planner, p.px);
            }
            const params: Params[] = [{ planner: new Planner(6), px: 3 }, { planner: null, px: 3 }, { px: 1 }];
            let got = "";
            for (const p of params) got += step(p) + ",";
            if (got !== "4,-1,-2,") throw new Error("got " + got);
            `,
            { fileName: "tagged-argument.ts" },
        );
        assert.doesNotMatch(cpp, /Tagged<bblscene::Planner>>&? capture/);
        runGeneratedProgram(tools!, "inlined-call-arguments-tagged", cpp);
    },
);
