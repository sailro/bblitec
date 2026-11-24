/**
 * An inlined call binds its arguments where it runs: a pinned argument the
 * callee writes through stays writable, and a closure capturing a parameter
 * read from a tagged slot holds the value read, not the slot.
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
    "a pinned argument the inlined callee writes through stays writable",
    { skip: !tools },
    () => {
        const { cpp } = compileSource(
            `
            interface World {
                readonly marks: Float32Array;
                readonly count: number;
            }
            const NONE = new Float32Array(0);
            function mark(marks: Float32Array, at: number, depth: number): void {
                marks[at] = depth;
                if (depth > 0) mark(marks, at + 1, depth - 1);
            }
            function visit(marks: Float32Array, start: number, extra: Float32Array = NONE): number {
                if (start >= 0) mark(marks, start, 2);
                return marks.length + extra.length;
            }
            function step(world: World): number {
                return visit(world.marks, world.count - 3) + visit(world.marks, 0);
            }
            const world: World = { marks: new Float32Array(4), count: 4 };
            const length = step(world);
            if (length !== 8 || world.marks[1] !== 1 || world.marks[3] !== 0) throw new Error("marks " + world.marks.join(","));
            `,
            { fileName: "written-argument.ts" },
        );
        assert.doesNotMatch(
            cpp,
            /const auto v_bblite_call_argument_\w+ = bbl::js::snapshot_value\(v_\w+->marks\)/,
        );
        runGeneratedProgram(tools!, "inlined-call-arguments-written", cpp);
    },
);

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

test(
    "an argument a looser signature omits binds undefined where the parameter's type admits it",
    { skip: !tools },
    () => {
        // `begin`'s `held` is optional only through its contextual type; the
        // clamp calls it through a port that declares one parameter.
        const { cpp } = compileSource(
            `
            interface Pose { y: number }
            interface HostController {
                begin(name: string, held?: Readonly<Pose> | null): number;
                count(): number;
            }
            interface HostPort { begin(name: string): unknown; count(): number }
            interface Clamp { follow(index: number): void }
            function createHostController(): HostController {
                const previews = new Map<string, number>();
                return {
                    begin(name, held) {
                        previews.set(name, held ? held.y : -1);
                        return previews.size;
                    },
                    count: () => previews.size,
                };
            }
            function createClamp(hosts: HostPort, names: readonly string[]): Clamp {
                const follow: Clamp["follow"] = (index) => {
                    const name = names[index];
                    if (name) hosts.begin(name);
                };
                return { follow };
            }
            const hosts = createHostController();
            const clamp = createClamp(hosts, ["a", "b"]);
            clamp.follow(1);
            const second = hosts.begin("c", { y: 3 });
            if (hosts.count() !== 2 || second !== 2) throw new Error("count " + hosts.count() + " " + second);
            `,
            { fileName: "omitted-argument.ts" },
        );
        runGeneratedProgram(tools!, "inlined-call-arguments-omitted", cpp);
    },
);
